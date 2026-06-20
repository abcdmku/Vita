package pdssync

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/transaction"
)

const (
	validRepoDID            = "did:plc:ewvi7nxzyoun6zhxrhs64oiz"
	validWebRepoDID         = "did:web:alice.example.com"
	validCID                = "bafybeigdyrzt5sfp7udm7hu76ekfya5f45mcm6qzdv6woc4f3gj3sidfwy"
	alternateCID            = "bafkreigh2akiscaildcvwcuzjdfu7kdc32gndn2r2hkoqefj7yppz364gu"
	nonCanonicalTrailingCID = "bafybeigdyrzt5sfp7udm7hu76ekfya5f45mcm6qzdv6woc4f3gj3sidfwz"
)

var (
	errSimulatedWrite = errors.New("simulated write failure")
	errSimulatedApply = errors.New("simulated apply failure")
)

func TestHandleReadsCurrentStateAndReturnsCanonicalRaw(t *testing.T) {
	ctx := context.Background()
	raw := []byte("{\n  \"repoHead\":\"" + validCID + "\",\n  \"cursor\":42,\n  \"repo\":\"" + validRepoDID + "\"\n}\n")
	fs := newMemoryFileSystem(raw)
	capability := newCapability(fs)

	response, err := capability.Handle(ctx, ReadRequest{})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}

	readResponse, ok := response.(ReadResponse)
	if !ok {
		t.Fatalf("Handle returned %T, want ReadResponse", response)
	}
	if !readResponse.Exists {
		t.Fatal("ReadResponse.Exists = false, want true")
	}
	if readResponse.State != syncState(42) {
		t.Fatalf("ReadResponse.State = %#v, want %#v", readResponse.State, syncState(42))
	}

	canonical := renderSyncState(syncState(42))
	if !reflect.DeepEqual(readResponse.Raw, canonical) {
		t.Fatalf("ReadResponse.Raw = %q, want canonical %q", readResponse.Raw, canonical)
	}
	if reflect.DeepEqual(readResponse.Raw, raw) {
		t.Fatal("Handle returned original raw JSON, want canonical validated JSON")
	}
}

func TestApplyWritesAndUndoRestoresExactPriorBytes(t *testing.T) {
	ctx := context.Background()
	prior := renderSyncState(syncState(42))
	fs := newMemoryFileSystem(prior)
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, applyState(alternateState(43)))
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo")
	}

	wantApplied := renderSyncState(alternateState(43))
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, wantApplied) {
		t.Fatalf("live PDS sync state after Apply = %q, want %q", got, wantApplied)
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live PDS sync state after Undo = %q, want exact prior bytes %q", got, prior)
	}
}

func TestApplyUndoRestoresAbsentPriorState(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(nil)
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, applyState(syncState(0)))
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if !fs.exists {
		t.Fatal("Apply did not create live PDS sync state")
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if fs.exists {
		t.Fatalf("Undo left live PDS sync state %q, want absent", fs.live)
	}
}

func TestTransactionApplyCommitsSyncStateWhenHealthPasses(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(renderSyncState(syncState(42)))
	syncCapability := newCapability(fs)
	registry := mustRegistry(t, syncCapability)

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: applyState(alternateState(43))},
	}, func(context.Context) error {
		return nil
	})

	if !result.Committed() {
		t.Fatalf("Outcome = %q, want committed; err=%v", result.Outcome, result.Err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, renderSyncState(alternateState(43))) {
		t.Fatalf("live PDS sync state = %q, want desired state", got)
	}
	if len(result.RolledBack) != 0 {
		t.Fatalf("RolledBack = %v, want none", result.RolledBack)
	}
}

func TestTransactionApplyRollsBackSyncStateWhenLaterOperationFails(t *testing.T) {
	ctx := context.Background()
	prior := renderSyncState(syncState(42))
	fs := newMemoryFileSystem(prior)
	syncCapability := newCapability(fs)
	registry := mustRegistry(t, syncCapability, failingTxCapability{name: "test.later"})

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: applyState(alternateState(43))},
		{Capability: "test.later", Request: testRequest{}},
	}, func(context.Context) error {
		return nil
	})

	if !result.WasRolledBack() {
		t.Fatalf("Outcome = %q, want rolledBack", result.Outcome)
	}
	var applyErr *transaction.ApplyError
	if !errors.As(result.Err, &applyErr) {
		t.Fatalf("Err = %T %v, want ApplyError", result.Err, result.Err)
	}
	if !errors.Is(result.Err, errSimulatedApply) {
		t.Fatalf("Err = %v, want simulated apply failure", result.Err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live PDS sync state after rollback = %q, want exact prior bytes %q", got, prior)
	}
	wantRolledBack := []transaction.RolledBackOperation{{Index: 0, Capability: Name}}
	if !reflect.DeepEqual(result.RolledBack, wantRolledBack) {
		t.Fatalf("RolledBack = %v, want %v", result.RolledBack, wantRolledBack)
	}
	if len(result.RollbackErrors) != 0 {
		t.Fatalf("RollbackErrors = %v, want none", result.RollbackErrors)
	}
}

func TestRollbackRestoresNonCanonicalPriorBytesExactly(t *testing.T) {
	ctx := context.Background()
	prior := []byte("{\n  \"repoHead\":\"" + validCID + "\",\n  \"cursor\":42,\n  \"repo\":\"" + validRepoDID + "\"\n}\n")
	fs := newMemoryFileSystem(prior)
	syncCapability := newCapability(fs)
	registry := mustRegistry(t, syncCapability, failingTxCapability{name: "test.later"})

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: applyState(alternateState(43))},
		{Capability: "test.later", Request: testRequest{}},
	}, func(context.Context) error {
		return nil
	})

	if !result.WasRolledBack() {
		t.Fatalf("Outcome = %q, want rolledBack; err=%v", result.Outcome, result.Err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live PDS sync state after rollback = %q, want exact non-canonical prior bytes %q", got, prior)
	}
	if reflect.DeepEqual(fs.mustLiveBytes(t), renderSyncState(syncState(42))) {
		t.Fatal("rollback restored canonicalized bytes, want original prior bytes")
	}
}

func TestAtomicWriteFailureLeavesLiveStateUnchanged(t *testing.T) {
	ctx := context.Background()
	prior := renderSyncState(syncState(42))
	fs := newMemoryFileSystem(prior)
	fs.failNextAtomicWriteBeforeCommit = true
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, applyState(alternateState(43)))
	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil on failed write", undo)
	}
	if !errors.Is(err, errSimulatedWrite) {
		t.Fatalf("Apply error = %v, want simulated write failure", err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live PDS sync state after failed atomic write = %q, want unchanged %q", got, prior)
	}
	if fs.temp == nil {
		t.Fatal("simulated atomic write did not stage a temp file")
	}
	if reflect.DeepEqual(fs.temp, fs.live) {
		t.Fatal("test did not simulate a partial temp distinct from the live file")
	}
}

func TestCommitPointMutationIsTrackedWithUndo(t *testing.T) {
	ctx := context.Background()
	prior := renderSyncState(syncState(42))
	fs := newMemoryFileSystem(prior)
	fs.observeNextAtomicCommit = true
	syncCapability := newCapability(fs)
	registry := mustRegistry(t, syncCapability, failingTxCapability{name: "test.later"})

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: applyState(alternateState(43))},
		{Capability: "test.later", Request: testRequest{}},
	}, func(context.Context) error {
		return nil
	})

	if !fs.observedCommitPointMutation {
		t.Fatal("test did not observe the atomic commit point mutation")
	}
	if !result.WasRolledBack() {
		t.Fatalf("Outcome = %q, want rolledBack; err=%v", result.Outcome, result.Err)
	}
	wantApplied := []transaction.AppliedOperation{{Index: 0, Capability: Name}}
	if !reflect.DeepEqual(result.Applied, wantApplied) {
		t.Fatalf("Applied = %v, want %v", result.Applied, wantApplied)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live PDS sync state after rollback = %q, want exact prior bytes %q", got, prior)
	}
	wantRolledBack := []transaction.RolledBackOperation{{Index: 0, Capability: Name}}
	if !reflect.DeepEqual(result.RolledBack, wantRolledBack) {
		t.Fatalf("RolledBack = %v, want %v", result.RolledBack, wantRolledBack)
	}
	if len(result.RollbackErrors) != 0 {
		t.Fatalf("RollbackErrors = %v, want none", result.RollbackErrors)
	}
}

func TestApplyRejectsInvalidStateWithoutWriting(t *testing.T) {
	ctx := context.Background()
	prior := renderSyncState(syncState(100))
	tooHigh := syncState(maxCursor + 1)

	tests := []struct {
		name string
		req  capabilities.TypedRequest
	}{
		{
			name: "wrong request type cannot smuggle path",
			req:  pathSmugglingRequest{Path: "/tmp/attacker", Desired: alternateState(101)},
		},
		{
			name: "missing desired",
			req:  ApplyRequest{},
		},
		{
			name: "malformed DID",
			req:  applyState(withRepo(alternateState(101), "did:key:z6mnot-supported")),
		},
		{
			name: "malformed CID",
			req:  applyState(withRepoHead(alternateState(101), "not-a-cid")),
		},
		{
			name: "CIDv0 rejects",
			req:  applyState(withRepoHead(alternateState(101), "QmYwAPJzv5CZsnAzt8auVZRnPbR4E5zE7nZyZkJQF6x1vM")),
		},
		{
			name: "non-canonical base32 trailing bits reject",
			req:  applyState(withRepoHead(alternateState(101), nonCanonicalTrailingCID)),
		},
		{
			name: "negative cursor",
			req:  applyState(withCursor(alternateState(101), -1)),
		},
		{
			name: "cursor above max safe integer",
			req:  applyState(tooHigh),
		},
		{
			name: "regressing cursor",
			req:  applyState(alternateState(99)),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fs := newMemoryFileSystem(prior)
			capability := newCapability(fs)

			undo, err := capability.Apply(ctx, tt.req)
			if undo != nil {
				t.Fatalf("Apply returned undo %v, want nil", undo)
			}
			var invalid *InvalidRequestError
			if !errors.As(err, &invalid) {
				t.Fatalf("Apply error = %T %v, want InvalidRequestError", err, err)
			}
			if fs.atomicWrites != 0 {
				t.Fatalf("AtomicWrite count = %d, want 0", fs.atomicWrites)
			}
			if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
				t.Fatalf("live PDS sync state = %q, want unchanged %q", got, prior)
			}
		})
	}
}

func TestApplyAcceptsZeroAndEqualCursor(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(renderSyncState(syncState(0)))
	capability := newCapability(fs)

	if _, err := capability.Apply(ctx, applyState(alternateState(0))); err != nil {
		t.Fatalf("Apply with equal zero cursor returned error: %v", err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, renderSyncState(alternateState(0))) {
		t.Fatalf("live PDS sync state = %q, want equal-cursor desired state", got)
	}
}

func TestAbsentRequiredFieldsRejectFailClosed(t *testing.T) {
	tests := []struct {
		name string
		raw  string
	}{
		{
			name: "missing desired",
			raw:  `{"unexpected":true}`,
		},
		{
			name: "missing repo",
			raw:  `{"desired":{"cursor":42,"repoHead":"` + validCID + `"}}`,
		},
		{
			name: "missing cursor",
			raw:  `{"desired":{"repo":"` + validRepoDID + `","repoHead":"` + validCID + `"}}`,
		},
		{
			name: "missing repoHead",
			raw:  `{"desired":{"repo":"` + validRepoDID + `","cursor":42}}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var req ApplyRequest
			err := json.Unmarshal([]byte(tt.raw), &req)
			if err == nil {
				err = req.Validate()
			}
			if err == nil {
				t.Fatal("decode/Validate returned nil, want fail-closed rejection")
			}
		})
	}
}

func TestDuplicateJSONKeysAreRejectedBeforeDecode(t *testing.T) {
	tests := []struct {
		name string
		raw  string
	}{
		{
			name: "duplicate top-level desired",
			raw:  `{"desired":{"repo":"` + validRepoDID + `","cursor":42,"repoHead":"` + validCID + `"},"desired":{"repo":"` + validRepoDID + `","cursor":43,"repoHead":"` + alternateCID + `"}}`,
		},
		{
			name: "duplicate repo smuggles PEM",
			raw:  `{"desired":{"repo":"-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----","repo":"` + validRepoDID + `","cursor":42,"repoHead":"` + validCID + `"}}`,
		},
		{
			name: "duplicate cursor smuggles regression",
			raw:  `{"desired":{"repo":"` + validRepoDID + `","cursor":1,"cursor":42,"repoHead":"` + validCID + `"}}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var req ApplyRequest
			err := json.Unmarshal([]byte(tt.raw), &req)
			if err == nil {
				t.Fatal("Unmarshal returned nil, want duplicate-key rejection")
			}
			if !strings.Contains(err.Error(), "duplicate JSON object key") {
				t.Fatalf("Unmarshal error = %v, want duplicate-key rejection", err)
			}
		})
	}
}

func TestParseRejectsDuplicateKeysInStoredState(t *testing.T) {
	raw := []byte(`{"repo":"-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----","repo":"` + validRepoDID + `","cursor":42,"repoHead":"` + validCID + `"}`)

	if _, err := parseSyncState(raw); err == nil {
		t.Fatal("parseSyncState returned nil error, want duplicate-key rejection")
	} else if !strings.Contains(err.Error(), "duplicate JSON object key") {
		t.Fatalf("parseSyncState error = %v, want duplicate-key rejection", err)
	}
}

func TestDuplicateRepoPEMCannotBePersistedOrReturned(t *testing.T) {
	ctx := context.Background()
	raw := []byte(`{"desired":{"repo":"-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----","repo":"` + validRepoDID + `","cursor":42,"repoHead":"` + validCID + `"}}`)
	var req ApplyRequest
	if err := json.Unmarshal(raw, &req); err == nil {
		t.Fatal("Unmarshal accepted duplicate repo PEM smuggling request")
	}

	fs := newMemoryFileSystem(nil)
	capability := newCapability(fs)
	if _, err := capability.Apply(ctx, applyState(syncState(42))); err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if bytes.Contains(fs.mustLiveBytes(t), []byte("PRIVATE KEY")) {
		t.Fatalf("live PDS sync state contains smuggled PEM: %q", fs.mustLiveBytes(t))
	}

	response, err := capability.Handle(ctx, ReadRequest{})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	readResponse := response.(ReadResponse)
	if bytes.Contains(readResponse.Raw, []byte("PRIVATE KEY")) {
		t.Fatalf("ReadResponse.Raw contains smuggled PEM: %q", readResponse.Raw)
	}
}

func TestConcurrentAppliesCannotCommitRegressingCursor(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(renderSyncState(syncState(100)))
	fs.pauseBeforeCommitCursor = 200
	fs.pausedBeforeCommit = make(chan struct{})
	fs.releaseCommit = make(chan struct{})
	capability := newCapability(fs)

	highDone := make(chan error, 1)
	go func() {
		_, err := capability.Apply(ctx, applyState(alternateState(200)))
		highDone <- err
	}()

	select {
	case <-fs.pausedBeforeCommit:
	case <-time.After(time.Second):
		t.Fatal("high-cursor Apply did not pause before the commit point")
	}

	lowDone := make(chan error, 1)
	go func() {
		_, err := capability.Apply(ctx, applyState(alternateState(150)))
		lowDone <- err
	}()

	select {
	case err := <-lowDone:
		t.Fatalf("regressing Apply completed while newer write was paused; err=%v", err)
	case <-time.After(50 * time.Millisecond):
	}

	close(fs.releaseCommit)

	if err := <-highDone; err != nil {
		t.Fatalf("high-cursor Apply returned error: %v", err)
	}
	err := <-lowDone
	var invalid *InvalidRequestError
	if !errors.As(err, &invalid) {
		t.Fatalf("low-cursor Apply error = %T %v, want InvalidRequestError", err, err)
	}

	got := mustParseLiveState(t, fs)
	if got.Cursor != 200 {
		t.Fatalf("final cursor = %d, want non-regressed cursor 200", got.Cursor)
	}
}

type memoryFileSystem struct {
	exists                          bool
	live                            []byte
	temp                            []byte
	atomicWrites                    int
	failNextAtomicWriteBeforeCommit bool
	observeNextAtomicCommit         bool
	observedCommitPointMutation     bool
	pauseBeforeCommitCursor         int64
	pausedBeforeCommit              chan struct{}
	releaseCommit                   chan struct{}
}

func newMemoryFileSystem(initial []byte) *memoryFileSystem {
	if initial == nil {
		return &memoryFileSystem{}
	}
	return &memoryFileSystem{exists: true, live: cloneBytes(initial)}
}

func (fs *memoryFileSystem) Read(ctx context.Context) (syncStateSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return syncStateSnapshot{}, err
	}
	return syncStateSnapshot{exists: fs.exists, bytes: cloneBytes(fs.live)}, nil
}

func (fs *memoryFileSystem) AtomicWrite(ctx context.Context, content []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	fs.atomicWrites++
	fs.temp = cloneBytes(content)
	if len(fs.temp) > 1 {
		fs.temp = cloneBytes(fs.temp[:len(fs.temp)/2])
	}
	if fs.failNextAtomicWriteBeforeCommit {
		fs.failNextAtomicWriteBeforeCommit = false
		return errSimulatedWrite
	}

	if fs.pauseBeforeCommitCursor != 0 {
		state, err := parseSyncState(content)
		if err != nil {
			return err
		}
		if state.Cursor == fs.pauseBeforeCommitCursor {
			fs.pauseBeforeCommitCursor = 0
			close(fs.pausedBeforeCommit)
			<-fs.releaseCommit
		}
	}

	fs.live = cloneBytes(content)
	fs.exists = true
	fs.temp = nil
	if fs.observeNextAtomicCommit {
		fs.observeNextAtomicCommit = false
		fs.observedCommitPointMutation = true
	}
	return nil
}

func (fs *memoryFileSystem) Replace(ctx context.Context, snapshot syncStateSnapshot) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !snapshot.exists {
		fs.exists = false
		fs.live = nil
		return nil
	}
	return fs.AtomicWrite(ctx, snapshot.bytes)
}

func (fs *memoryFileSystem) mustLiveBytes(t *testing.T) []byte {
	t.Helper()
	if !fs.exists {
		t.Fatal("live PDS sync state does not exist")
	}
	return cloneBytes(fs.live)
}

type testRequest struct{}

func (testRequest) CapabilityRequest() {}

type testResponse struct{}

func (testResponse) CapabilityResponse() {}

type failingTxCapability struct {
	name string
}

func (c failingTxCapability) Name() string {
	return c.name
}

func (c failingTxCapability) Handle(context.Context, capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	return testResponse{}, nil
}

func (c failingTxCapability) Apply(context.Context, capabilities.TypedRequest) (transaction.Undo, error) {
	return nil, errSimulatedApply
}

type pathSmugglingRequest struct {
	Path    string
	Desired SyncState
}

func (pathSmugglingRequest) CapabilityRequest() {}

func syncState(cursor int64) SyncState {
	return SyncState{
		Repo:     validRepoDID,
		Cursor:   cursor,
		RepoHead: validCID,
	}
}

func alternateState(cursor int64) SyncState {
	return SyncState{
		Repo:     validWebRepoDID,
		Cursor:   cursor,
		RepoHead: alternateCID,
	}
}

func withRepo(state SyncState, repo string) SyncState {
	state.Repo = repo
	return state
}

func withRepoHead(state SyncState, repoHead string) SyncState {
	state.RepoHead = repoHead
	return state
}

func withCursor(state SyncState, cursor int64) SyncState {
	state.Cursor = cursor
	return state
}

func applyState(state SyncState) ApplyRequest {
	desired := cloneSyncState(state)
	return ApplyRequest{Desired: &desired}
}

func mustParseLiveState(t *testing.T, fs *memoryFileSystem) SyncState {
	t.Helper()
	state, err := parseSyncState(fs.mustLiveBytes(t))
	if err != nil {
		t.Fatalf("parseSyncState returned error: %v", err)
	}
	return state
}

func mustRegistry(t *testing.T, registered ...capabilities.Capability) *capabilities.Registry {
	t.Helper()

	registry, err := capabilities.NewRegistry(registered...)
	if err != nil {
		t.Fatalf("NewRegistry returned error: %v", err)
	}
	return registry
}
