package storage

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/transaction"
)

var (
	errSimulatedWrite = errors.New("simulated write failure")
	errSimulatedApply = errors.New("simulated apply failure")
)

func TestApplyReturnsUndoRestoringExactPriorBytes(t *testing.T) {
	ctx := context.Background()
	prior := renderLayout(validLayout())
	fs := newMemoryFileSystem(prior)
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, applyLayout(alternateLayout()))
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo")
	}

	wantApplied := renderLayout(alternateLayout())
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, wantApplied) {
		t.Fatalf("live storage layout after Apply = %q, want %q", got, wantApplied)
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live storage layout after Undo = %q, want exact prior bytes %q", got, prior)
	}
}

func TestApplyUndoRestoresAbsentPriorLayout(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(nil)
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, applyLayout(validLayout()))
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if !fs.exists {
		t.Fatal("Apply did not create live storage layout")
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if fs.exists {
		t.Fatalf("Undo left live storage layout %q, want absent", fs.live)
	}
}

func TestHandleReadsCurrentLayout(t *testing.T) {
	ctx := context.Background()
	layout := validLayout()
	raw := renderLayout(layout)
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
	if !reflect.DeepEqual(readResponse.Layout, layout) {
		t.Fatalf("ReadResponse.Layout = %#v, want %#v", readResponse.Layout, layout)
	}
	if !reflect.DeepEqual(readResponse.Raw, raw) {
		t.Fatalf("ReadResponse.Raw = %q, want %q", readResponse.Raw, raw)
	}
}

func TestTransactionApplyCommitsStorageLayoutWhenHealthPasses(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(renderLayout(validLayout()))
	storageCapability := newCapability(fs)
	registry := mustRegistry(t, storageCapability)

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: applyLayout(alternateLayout())},
	}, func(context.Context) error {
		return nil
	})

	if !result.Committed() {
		t.Fatalf("Outcome = %q, want committed; err=%v", result.Outcome, result.Err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, renderLayout(alternateLayout())) {
		t.Fatalf("live storage layout = %q, want desired layout", got)
	}
	if len(result.RolledBack) != 0 {
		t.Fatalf("RolledBack = %v, want none", result.RolledBack)
	}
}

func TestTransactionApplyRollsBackStorageLayoutWhenLaterOperationFails(t *testing.T) {
	ctx := context.Background()
	prior := renderLayout(validLayout())
	fs := newMemoryFileSystem(prior)
	storageCapability := newCapability(fs)
	registry := mustRegistry(t, storageCapability, failingTxCapability{name: "test.later"})

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: applyLayout(alternateLayout())},
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
		t.Fatalf("live storage layout after rollback = %q, want exact prior bytes %q", got, prior)
	}
	wantRolledBack := []transaction.RolledBackOperation{{Index: 0, Capability: Name}}
	if !reflect.DeepEqual(result.RolledBack, wantRolledBack) {
		t.Fatalf("RolledBack = %v, want %v", result.RolledBack, wantRolledBack)
	}
	if len(result.RollbackErrors) != 0 {
		t.Fatalf("RollbackErrors = %v, want none", result.RollbackErrors)
	}
}

func TestAtomicWriteFailureLeavesLiveLayoutUnchanged(t *testing.T) {
	ctx := context.Background()
	prior := renderLayout(validLayout())
	fs := newMemoryFileSystem(prior)
	fs.failNextAtomicWriteBeforeCommit = true
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, applyLayout(alternateLayout()))
	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil on failed write", undo)
	}
	if !errors.Is(err, errSimulatedWrite) {
		t.Fatalf("Apply error = %v, want simulated write failure", err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live storage layout after failed atomic write = %q, want unchanged %q", got, prior)
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
	prior := renderLayout(validLayout())
	fs := newMemoryFileSystem(prior)
	fs.tryErrorAfterCommit = true
	storageCapability := newCapability(fs)
	registry := mustRegistry(t, storageCapability, failingTxCapability{name: "test.later"})

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: applyLayout(alternateLayout())},
		{Capability: "test.later", Request: testRequest{}},
	}, func(context.Context) error {
		return nil
	})

	if !fs.observedErrorAfterCommitAttempt {
		t.Fatal("test did not exercise the after-commit failure injection")
	}
	if !result.WasRolledBack() {
		t.Fatalf("Outcome = %q, want rolledBack; err=%v", result.Outcome, result.Err)
	}
	wantApplied := []transaction.AppliedOperation{{Index: 0, Capability: Name}}
	if !reflect.DeepEqual(result.Applied, wantApplied) {
		t.Fatalf("Applied = %v, want %v", result.Applied, wantApplied)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live storage layout after rollback = %q, want exact prior bytes %q", got, prior)
	}
	wantRolledBack := []transaction.RolledBackOperation{{Index: 0, Capability: Name}}
	if !reflect.DeepEqual(result.RolledBack, wantRolledBack) {
		t.Fatalf("RolledBack = %v, want %v", result.RolledBack, wantRolledBack)
	}
	if len(result.RollbackErrors) != 0 {
		t.Fatalf("RollbackErrors = %v, want none", result.RollbackErrors)
	}
}

func TestAfterCommitFailureAttemptStillReturnsTrackedUndo(t *testing.T) {
	ctx := context.Background()
	prior := renderLayout(validLayout())
	fs := newMemoryFileSystem(prior)
	fs.tryErrorAfterCommit = true
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, applyLayout(alternateLayout()))
	if err != nil {
		t.Fatalf("Apply returned error after commit attempt: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo after commit attempt")
	}
	if !fs.observedErrorAfterCommitAttempt {
		t.Fatal("test did not exercise the after-commit failure injection")
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, renderLayout(alternateLayout())) {
		t.Fatalf("live storage layout after commit = %q, want desired layout", got)
	}
	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live storage layout after Undo = %q, want exact prior bytes %q", got, prior)
	}
}

func TestApplyRejectsInvalidLayoutWithoutWriting(t *testing.T) {
	ctx := context.Background()
	prior := renderLayout(validLayout())
	tests := []struct {
		name string
		req  capabilities.TypedRequest
	}{
		{
			name: "wrong request type cannot smuggle path",
			req:  pathSmugglingRequest{Path: "/tmp/attacker", Desired: alternateLayout()},
		},
		{
			name: "missing desired",
			req:  ApplyRequest{},
		},
		{
			name: "missing subvolumes",
			req:  ApplyRequest{Desired: &Layout{}},
		},
		{
			name: "nil subvolumes",
			req:  ApplyRequest{Desired: layoutWithNilSubvolumes()},
		},
		{
			name: "missing required role",
			req:  applyLayout(layoutWithoutRole(RoleSnapshots)),
		},
		{
			name: "app-state without appId",
			req:  applyLayout(layoutWithSubvolume(2, Subvolume{Role: RoleAppState, Path: "/data/app-state/local-search"})),
		},
		{
			name: "non-app with appId",
			req:  applyLayout(layoutWithSubvolume(0, Subvolume{Role: RoleSystemState, Path: "/data/system-state", AppID: stringPtr("platform")})),
		},
		{
			name: "non-canonical path",
			req:  applyLayout(layoutWithSubvolume(1, Subvolume{Role: RoleUserData, Path: "/data/../user-data"})),
		},
		{
			name: "zero quota",
			req:  applyLayout(layoutWithSubvolume(1, Subvolume{Role: RoleUserData, Path: "/data/user-data", QuotaGiB: int64Ptr(0)})),
		},
		{
			name: "negative quota",
			req:  applyLayout(layoutWithSubvolume(1, Subvolume{Role: RoleUserData, Path: "/data/user-data", QuotaGiB: int64Ptr(-1)})),
		},
		{
			name: "duplicate singleton role",
			req:  applyLayout(layoutWithSubvolume(1, Subvolume{Role: RoleSystemState, Path: "/data/other-system-state"})),
		},
		{
			name: "unknown role",
			req:  applyLayout(layoutWithSubvolume(1, Subvolume{Role: "scratch", Path: "/data/scratch"})),
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
				t.Fatalf("live storage layout = %q, want unchanged %q", got, prior)
			}
		})
	}
}

func TestValidateDistinguishesQuotaPresence(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		wantErr bool
	}{
		{
			name:    "missing subvolumes",
			raw:     `{"desired":{}}`,
			wantErr: true,
		},
		{
			name:    "absent quota is optional",
			raw:     `{"desired":{"subvolumes":[{"role":"system-state","path":"/data/system-state"},{"role":"user-data","path":"/data/user-data"},{"role":"app-state","path":"/data/app-state/local-search","appId":"local-search"},{"role":"snapshots","path":"/data/snapshots"},{"role":"local-backup-cache","path":"/data/local-backup-cache"}]}}`,
			wantErr: false,
		},
		{
			name:    "positive quota is valid",
			raw:     `{"desired":{"subvolumes":[{"role":"system-state","path":"/data/system-state","quotaGiB":16},{"role":"user-data","path":"/data/user-data","quotaGiB":512},{"role":"app-state","path":"/data/app-state/local-search","appId":"local-search","quotaGiB":64},{"role":"snapshots","path":"/data/snapshots","quotaGiB":256},{"role":"local-backup-cache","path":"/data/local-backup-cache","quotaGiB":256}]}}`,
			wantErr: false,
		},
		{
			name:    "explicit zero quota rejects",
			raw:     `{"desired":{"subvolumes":[{"role":"system-state","path":"/data/system-state","quotaGiB":0},{"role":"user-data","path":"/data/user-data"},{"role":"app-state","path":"/data/app-state/local-search","appId":"local-search"},{"role":"snapshots","path":"/data/snapshots"},{"role":"local-backup-cache","path":"/data/local-backup-cache"}]}}`,
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var req ApplyRequest
			if err := json.Unmarshal([]byte(tt.raw), &req); err != nil {
				t.Fatalf("Unmarshal returned error: %v", err)
			}

			err := req.Validate()
			if tt.wantErr && err == nil {
				t.Fatal("Validate returned nil, want error")
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("Validate returned error: %v", err)
			}
		})
	}
}

type memoryFileSystem struct {
	exists                          bool
	live                            []byte
	temp                            []byte
	atomicWrites                    int
	failNextAtomicWriteBeforeCommit bool
	tryErrorAfterCommit             bool
	observedErrorAfterCommitAttempt bool
}

func newMemoryFileSystem(initial []byte) *memoryFileSystem {
	if initial == nil {
		return &memoryFileSystem{}
	}
	return &memoryFileSystem{exists: true, live: cloneBytes(initial)}
}

func (fs *memoryFileSystem) Read(ctx context.Context) (layoutSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return layoutSnapshot{}, err
	}
	return layoutSnapshot{exists: fs.exists, bytes: cloneBytes(fs.live)}, nil
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

	fs.live = cloneBytes(content)
	fs.exists = true
	fs.temp = nil
	if fs.tryErrorAfterCommit {
		fs.tryErrorAfterCommit = false
		fs.observedErrorAfterCommitAttempt = true
	}
	return nil
}

func (fs *memoryFileSystem) Replace(ctx context.Context, snapshot layoutSnapshot) error {
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
		t.Fatal("live storage layout does not exist")
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
	Desired Layout
}

func (pathSmugglingRequest) CapabilityRequest() {}

func validLayout() Layout {
	return layoutWith(
		Subvolume{Role: RoleSystemState, Path: "/data/system-state", QuotaGiB: int64Ptr(16)},
		Subvolume{Role: RoleUserData, Path: "/data/user-data", QuotaGiB: int64Ptr(512)},
		Subvolume{Role: RoleAppState, Path: "/data/app-state/local-search", AppID: stringPtr("local-search"), QuotaGiB: int64Ptr(64)},
		Subvolume{Role: RoleSnapshots, Path: "/data/snapshots", QuotaGiB: int64Ptr(256)},
		Subvolume{Role: RoleLocalBackupCache, Path: "/data/local-backup-cache", QuotaGiB: int64Ptr(256)},
	)
}

func alternateLayout() Layout {
	return layoutWith(
		Subvolume{Role: RoleSystemState, Path: "/data/system-state", QuotaGiB: int64Ptr(32)},
		Subvolume{Role: RoleUserData, Path: "/data/user-data", QuotaGiB: int64Ptr(768)},
		Subvolume{Role: RoleAppState, Path: "/data/app-state/local-search", AppID: stringPtr("local-search"), QuotaGiB: int64Ptr(96)},
		Subvolume{Role: RoleSnapshots, Path: "/data/snapshots", QuotaGiB: int64Ptr(384)},
		Subvolume{Role: RoleLocalBackupCache, Path: "/data/local-backup-cache", QuotaGiB: int64Ptr(128)},
	)
}

func layoutWith(subvolumes ...Subvolume) Layout {
	copySubvolumes := make([]Subvolume, len(subvolumes))
	for i, subvolume := range subvolumes {
		copySubvolumes[i] = cloneSubvolume(subvolume)
	}
	return Layout{Subvolumes: &copySubvolumes}
}

func layoutWithNilSubvolumes() *Layout {
	var nilSubvolumes []Subvolume
	return &Layout{Subvolumes: &nilSubvolumes}
}

func layoutWithoutRole(role Role) Layout {
	base := validLayout()
	subvolumes := *base.Subvolumes
	filtered := make([]Subvolume, 0, len(subvolumes))
	for _, subvolume := range subvolumes {
		if subvolume.Role != role {
			filtered = append(filtered, cloneSubvolume(subvolume))
		}
	}
	return Layout{Subvolumes: &filtered}
}

func layoutWithSubvolume(index int, subvolume Subvolume) Layout {
	base := validLayout()
	subvolumes := *base.Subvolumes
	subvolumes[index] = cloneSubvolume(subvolume)
	return Layout{Subvolumes: &subvolumes}
}

func applyLayout(layout Layout) ApplyRequest {
	desired := cloneLayout(layout)
	return ApplyRequest{Desired: &desired}
}

func stringPtr(value string) *string {
	return &value
}

func int64Ptr(value int64) *int64 {
	return &value
}

func mustRegistry(t *testing.T, registered ...capabilities.Capability) *capabilities.Registry {
	t.Helper()

	registry, err := capabilities.NewRegistry(registered...)
	if err != nil {
		t.Fatalf("NewRegistry returned error: %v", err)
	}
	return registry
}
