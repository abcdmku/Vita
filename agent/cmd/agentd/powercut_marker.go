package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/vita/agent/capabilities/pdsrepo"
	"github.com/vita/agent/capabilities/pdssync"
	"github.com/vita/agent/internal/atomicfile"
	"github.com/vita/agent/internal/auditlog"
	"github.com/vita/agent/internal/jsonsafe"
)

const (
	powercutStateRootEnv = "VITA_POWERCUT_STATE_ROOT"
	powercutSentinelEnv  = "VITA_POWERCUT_SENTINEL"

	powercutSentinelFilename = "powercut-marker.json"
	powercutAuditFilename    = "audit-log.json"
	powercutCapability       = "powercut.marker"

	// powercutRepoDID is a fixed, code-controlled test repo identity for the
	// power-cut PDS writer drive. The identifier is a valid did:plc base32
	// string ([a-z2-7]{24}); it is NEVER derived from runtime input.
	powercutRepoDID         = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa"
	powercutRepoCollection  = "vita.powercut.record"
	powercutRepoValueDigest = "0000000000000000000000000000000000000000000000000000000000000001"
)

type powercutMarkerState struct {
	PendingCounter   uint64 `json:"pendingCounter"`
	ConfirmedCounter uint64 `json:"confirmedCounter"`
}

func runPowercutMarker(args []string, out io.Writer) error {
	if len(args) != 0 {
		return fmt.Errorf("unexpected args: %v", args)
	}

	paths := powercutMarkerPaths()
	state, exists, err := readPowercutMarkerState(paths.sentinelPath)
	if err != nil {
		return fmt.Errorf("read marker state: %w", err)
	}
	if err := appendPowercutAudit(paths.auditPath, state); err != nil {
		return fmt.Errorf("append audit marker: %w", err)
	}

	if !exists {
		// First boot: drive the SECOND authoritative writer (pdsrepo) through
		// its durable AtomicWrite at cursor 1, then verify it reloads, so the
		// PDS store is exercised across the very first cut as well.
		if err := drivePowercutRepo(paths.stateRoot, 1); err != nil {
			return fmt.Errorf("drive pds repo (first boot): %w", err)
		}
		if err := verifyPowercutRepo(paths.stateRoot, 0); err != nil {
			return fmt.Errorf("verify pds repo (first boot): %w", err)
		}
		next := powercutMarkerState{PendingCounter: 1}
		if err := writePowercutMarkerState(paths.sentinelPath, next); err != nil {
			return fmt.Errorf("write first marker state: %w", err)
		}
		fmt.Fprintln(out, "VITA-POWERCUT-PENDING: cycles=0 pending=1 status=PENDING")
		return nil
	}

	if state.PendingCounter <= state.ConfirmedCounter {
		return fmt.Errorf("marker counter did not advance: pending=%d confirmed=%d", state.PendingCounter, state.ConfirmedCounter)
	}

	// Reload the pdsrepo store written before the (orchestrator) hard reset and
	// confirm it recovered to the last fully-committed cursor OR a prior one —
	// never a torn/partial/unparseable file (Handle/parseRepoState fails closed
	// on corruption). This is MEASURED from a real reload, never synthesized.
	if err := verifyPowercutRepo(paths.stateRoot, state.ConfirmedCounter); err != nil {
		return fmt.Errorf("verify pds repo: %w", err)
	}

	confirmed := state.PendingCounter
	// Advance the SAME pdsrepo durable writer for this confirmed cycle so the
	// next boot has fresh committed PDS state to reload-verify across its cut.
	if err := drivePowercutRepo(paths.stateRoot, confirmed); err != nil {
		return fmt.Errorf("drive pds repo: %w", err)
	}
	next := powercutMarkerState{
		PendingCounter:   confirmed + 1,
		ConfirmedCounter: confirmed,
	}
	if err := writePowercutMarkerState(paths.sentinelPath, next); err != nil {
		return fmt.Errorf("write next marker state: %w", err)
	}
	fmt.Fprintf(out, "VITA-POWERCUT: cycles=%d intact=OK status=OK\n", confirmed)
	return nil
}

// drivePowercutRepo writes one record through the REAL pdsrepo durable writer
// (pdsrepo.Apply -> AtomicWrite, the same temp+fsync+rename+dir-fsync path the
// audit log uses) at the given commit cursor. The cursor is the marker counter,
// so cursors strictly advance across boots; re-applying an already-committed
// cursor is an idempotent no-op (pdsrepo rejects regression and treats an
// existing record as unchanged), which keeps the drive crash-safe on retry.
func drivePowercutRepo(stateRoot string, cursor uint64) error {
	if cursor == 0 || cursor > uint64(pdssync.MaxCursor) {
		return fmt.Errorf("invalid pds repo cursor %d", cursor)
	}
	capability := pdsrepo.NewCapabilityAt(stateRoot)
	req := pdsrepo.ApplyRequest{
		Desired: &pdsrepo.DesiredState{
			Repo:   powercutRepoDID,
			Commit: pdsrepo.Commit{Cursor: int64(cursor)},
			Records: []pdsrepo.RepoRecord{
				{
					Collection:  powercutRepoCollection,
					RKey:        fmt.Sprintf("powercut-%d", cursor),
					ValueDigest: powercutRepoValueDigest,
				},
			},
		},
	}
	if _, err := capability.Apply(context.Background(), req); err != nil {
		return err
	}
	return nil
}

// verifyPowercutRepo reloads the pdsrepo store via the read path (which parses
// the on-disk state canonically and FAILS CLOSED on any torn/non-canonical
// file) and asserts the recovered commit cursor is at least the last confirmed
// value — i.e. the last fully-committed state OR a prior committed state, never
// a torn/partial/regressed record. minCursor==0 (first boot) tolerates a not-
// yet-existing store; otherwise the store MUST exist and parse.
func verifyPowercutRepo(stateRoot string, minCursor uint64) error {
	capability := pdsrepo.NewCapabilityAt(stateRoot)
	resp, err := capability.Handle(context.Background(), pdsrepo.ReadRequest{})
	if err != nil {
		return err
	}
	read, ok := resp.(pdsrepo.ReadResponse)
	if !ok {
		return fmt.Errorf("unexpected pds repo response %T", resp)
	}
	if !read.Exists {
		if minCursor == 0 {
			return nil
		}
		return fmt.Errorf("pds repo state missing after cut (expected cursor >= %d)", minCursor)
	}
	if read.Repo != powercutRepoDID {
		return fmt.Errorf("pds repo identity mismatch: got %q", read.Repo)
	}
	if read.CommitCursor < 0 || uint64(read.CommitCursor) < minCursor {
		return fmt.Errorf("pds repo cursor regressed below last commit: got %d want >= %d", read.CommitCursor, minCursor)
	}
	return nil
}

func runPowercutWriter(args []string) error {
	if len(args) != 0 {
		return fmt.Errorf("unexpected args: %v", args)
	}
	for {
		if err := runPowercutMarker(nil, io.Discard); err != nil {
			return err
		}
	}
}

type powercutPaths struct {
	stateRoot    string
	sentinelPath string
	auditPath    string
}

func powercutMarkerPaths() powercutPaths {
	root := os.Getenv(powercutStateRootEnv)
	if root == "" {
		root = stateRoot
	}
	sentinelPath := os.Getenv(powercutSentinelEnv)
	if sentinelPath == "" {
		sentinelPath = filepath.Join(root, powercutSentinelFilename)
	}
	return powercutPaths{
		stateRoot:    root,
		sentinelPath: sentinelPath,
		auditPath:    filepath.Join(root, powercutAuditFilename),
	}
}

func readPowercutMarkerState(path string) (powercutMarkerState, bool, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return powercutMarkerState{}, false, nil
		}
		return powercutMarkerState{}, false, err
	}

	var state powercutMarkerState
	if err := jsonsafe.DecodeStrict(raw, &state); err != nil {
		return powercutMarkerState{}, false, err
	}
	if state.PendingCounter == 0 {
		return powercutMarkerState{}, false, errors.New("pending counter must be positive")
	}
	if state.ConfirmedCounter > state.PendingCounter {
		return powercutMarkerState{}, false, errors.New("confirmed counter exceeds pending counter")
	}
	canonical, err := renderPowercutMarkerState(state)
	if err != nil {
		return powercutMarkerState{}, false, err
	}
	if !bytes.Equal(raw, canonical) {
		return powercutMarkerState{}, false, errors.New("non-canonical marker state")
	}
	return state, true, nil
}

func writePowercutMarkerState(path string, state powercutMarkerState) error {
	data, err := renderPowercutMarkerState(state)
	if err != nil {
		return err
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}
	return atomicfile.WriteWithPattern(atomicfile.OSFileSystem{}, path, data, 0o600, ".powercut-marker-*.tmp")
}

func renderPowercutMarkerState(state powercutMarkerState) ([]byte, error) {
	data, err := json.Marshal(state)
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

func appendPowercutAudit(path string, marker powercutMarkerState) error {
	store, err := auditlog.NewStore(auditlog.OSFileSystem{}, path, auditLogMaxEvents)
	if err != nil {
		return err
	}
	if _, err := store.Read(); err != nil {
		return err
	}
	_, err = store.Append(auditlog.Event{
		TimestampMillis: time.Now().UTC().UnixMilli(),
		ActorKind:       auditlog.ActorKindSystem,
		ActorID:         "agentd",
		Capability:      powercutCapability,
		Operation:       auditlog.OperationApply,
		Outcome:         auditlog.OutcomeCommitted,
		Reason:          fmt.Sprintf("pending=%d confirmed=%d", marker.PendingCounter, marker.ConfirmedCounter),
	})
	return err
}
