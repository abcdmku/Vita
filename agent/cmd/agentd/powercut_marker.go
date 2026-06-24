package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"time"

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

	confirmed := state.PendingCounter
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
