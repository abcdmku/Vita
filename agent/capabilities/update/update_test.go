package update

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/transaction"
)

const validSHA256SRI = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

var (
	updatePlanA = Plan{
		TargetSlot: SlotA,
		Bundle: BundleRef{
			Ref:       "vita-os@1.2.0",
			Integrity: validSHA256SRI,
			Version:   "1.2.0",
		},
	}
	updatePlanB = Plan{
		TargetSlot: SlotB,
		Bundle: BundleRef{
			Ref:       "https://updates.example.invalid/vita-os-1.3.0.raucb",
			Integrity: validSHA256SRI,
			Version:   "1.3.0",
		},
	}
	errSimulatedWrite = errors.New("simulated write failure")
	errSimulatedApply = errors.New("simulated apply failure")
)

func TestHandleReadsCurrentUpdateState(t *testing.T) {
	ctx := context.Background()
	raw := renderPlan(updatePlanA)
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
	if readResponse.Plan != updatePlanA {
		t.Fatalf("ReadResponse.Plan = %#v, want %#v", readResponse.Plan, updatePlanA)
	}
	if !reflect.DeepEqual(readResponse.Raw, raw) {
		t.Fatalf("ReadResponse.Raw = %q, want %q", readResponse.Raw, raw)
	}
}

func TestApplyReturnsUndoRestoringExactPriorBytes(t *testing.T) {
	ctx := context.Background()
	prior := renderPlan(updatePlanA)
	fs := newMemoryFileSystem(prior)
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: updatePlanB})
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo")
	}

	wantApplied := renderPlan(updatePlanB)
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, wantApplied) {
		t.Fatalf("live update state after Apply = %q, want %q", got, wantApplied)
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live update state after Undo = %q, want exact prior bytes %q", got, prior)
	}
}

func TestApplyUndoRestoresAbsentPriorUpdateState(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(nil)
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: updatePlanB})
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if !fs.exists {
		t.Fatal("Apply did not create live update state")
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if fs.exists {
		t.Fatalf("Undo left live update state %q, want absent", fs.live)
	}
}

func TestTransactionApplyCommitsUpdatePlanWhenHealthPasses(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(renderPlan(updatePlanA))
	updateCapability := newCapability(fs)
	registry := mustRegistry(t, updateCapability)

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: ApplyRequest{Desired: updatePlanB}},
	}, func(context.Context) error {
		return nil
	})

	if !result.Committed() {
		t.Fatalf("Outcome = %q, want committed; err=%v", result.Outcome, result.Err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, renderPlan(updatePlanB)) {
		t.Fatalf("live update state = %q, want desired plan", got)
	}
	if len(result.RolledBack) != 0 {
		t.Fatalf("RolledBack = %v, want none", result.RolledBack)
	}
}

func TestTransactionApplyRollsBackUpdatePlanWhenLaterOperationFails(t *testing.T) {
	ctx := context.Background()
	prior := renderPlan(updatePlanA)
	fs := newMemoryFileSystem(prior)
	updateCapability := newCapability(fs)
	registry := mustRegistry(t, updateCapability, failingTxCapability{name: "test.later"})

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: ApplyRequest{Desired: updatePlanB}},
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
		t.Fatalf("live update state after rollback = %q, want exact prior bytes %q", got, prior)
	}
	wantRolledBack := []transaction.RolledBackOperation{{Index: 0, Capability: Name}}
	if !reflect.DeepEqual(result.RolledBack, wantRolledBack) {
		t.Fatalf("RolledBack = %v, want %v", result.RolledBack, wantRolledBack)
	}
	if len(result.RollbackErrors) != 0 {
		t.Fatalf("RollbackErrors = %v, want none", result.RollbackErrors)
	}
}

func TestApplyRejectsInvalidRequestWithoutWriting(t *testing.T) {
	ctx := context.Background()
	prior := renderPlan(updatePlanA)
	tests := []struct {
		name string
		req  capabilities.TypedRequest
	}{
		{
			name: "wrong request type cannot smuggle path",
			req:  pathSmugglingRequest{Path: "/tmp/attacker", Desired: updatePlanB},
		},
		{
			name: "invalid slot",
			req:  ApplyRequest{Desired: withSlot(updatePlanB, "c")},
		},
		{
			name: "missing target slot",
			req:  ApplyRequest{Desired: withSlot(updatePlanB, "")},
		},
		{
			name: "missing bundle ref",
			req:  ApplyRequest{Desired: withBundle(updatePlanB, BundleRef{Integrity: validSHA256SRI, Version: "1.3.0"})},
		},
		{
			name: "malformed sri",
			req:  ApplyRequest{Desired: withIntegrity(updatePlanB, "not-an-sri")},
		},
		{
			name: "wrong sri digest length",
			req:  ApplyRequest{Desired: withIntegrity(updatePlanB, "sha256-AAAAAAAAAAAAAAAAAAAA")},
		},
		{
			name: "empty version",
			req:  ApplyRequest{Desired: withVersion(updatePlanB, "")},
		},
		{
			name: "embedded bundle bytes via inline ref",
			req:  ApplyRequest{Desired: withRef(updatePlanB, "data:AAAA")},
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
			if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
				t.Fatalf("live update state = %q, want unchanged %q", got, prior)
			}
		})
	}
}

func TestDecodeRejectsEmbeddedBundleBytes(t *testing.T) {
	raw := `{"desired":{"targetSlot":"b","bundle":{"ref":"vita-os@1.3.0","integrity":"` + validSHA256SRI + `","version":"1.3.0","bytes":"QUJD"}}}`
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()

	var request ApplyRequest
	if err := decoder.Decode(&request); err == nil {
		t.Fatal("Decode accepted embedded bundle bytes, want rejection")
	} else if !strings.Contains(err.Error(), "bytes") {
		t.Fatalf("Decode error = %v, want bytes rejection", err)
	}
}

func TestAtomicWriteFailureLeavesLiveFileUnchanged(t *testing.T) {
	ctx := context.Background()
	prior := renderPlan(updatePlanA)
	fs := newMemoryFileSystem(prior)
	fs.failNextAtomicWriteBeforeCommit = true
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: updatePlanB})
	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil on failed write", undo)
	}
	if !errors.Is(err, errSimulatedWrite) {
		t.Fatalf("Apply error = %v, want simulated write failure", err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live update state after failed atomic write = %q, want unchanged %q", got, prior)
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
	prior := renderPlan(updatePlanA)
	fs := newMemoryFileSystem(prior)
	fs.observeNextAtomicCommit = true
	updateCapability := newCapability(fs)
	registry := mustRegistry(t, updateCapability, failingTxCapability{name: "test.later"})

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: ApplyRequest{Desired: updatePlanB}},
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
		t.Fatalf("live update state after rollback = %q, want exact prior bytes %q", got, prior)
	}
	wantRolledBack := []transaction.RolledBackOperation{{Index: 0, Capability: Name}}
	if !reflect.DeepEqual(result.RolledBack, wantRolledBack) {
		t.Fatalf("RolledBack = %v, want %v", result.RolledBack, wantRolledBack)
	}
	if len(result.RollbackErrors) != 0 {
		t.Fatalf("RollbackErrors = %v, want none", result.RollbackErrors)
	}
}

type memoryFileSystem struct {
	exists                          bool
	live                            []byte
	temp                            []byte
	failNextAtomicWriteBeforeCommit bool
	observeNextAtomicCommit         bool
	observedCommitPointMutation     bool
}

func newMemoryFileSystem(initial []byte) *memoryFileSystem {
	if initial == nil {
		return &memoryFileSystem{}
	}
	return &memoryFileSystem{exists: true, live: cloneBytes(initial)}
}

func (fs *memoryFileSystem) Read(ctx context.Context) (stateSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return stateSnapshot{}, err
	}
	return stateSnapshot{exists: fs.exists, bytes: cloneBytes(fs.live)}, nil
}

func (fs *memoryFileSystem) AtomicWrite(ctx context.Context, content []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
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
	if fs.observeNextAtomicCommit {
		fs.observeNextAtomicCommit = false
		fs.observedCommitPointMutation = true
	}
	return nil
}

func (fs *memoryFileSystem) Replace(ctx context.Context, snapshot stateSnapshot) error {
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
		t.Fatal("live update state does not exist")
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
	Desired Plan
}

func (pathSmugglingRequest) CapabilityRequest() {}

func mustRegistry(t *testing.T, registered ...capabilities.Capability) *capabilities.Registry {
	t.Helper()

	registry, err := capabilities.NewRegistry(registered...)
	if err != nil {
		t.Fatalf("NewRegistry returned error: %v", err)
	}
	return registry
}

func withSlot(plan Plan, slot Slot) Plan {
	plan.TargetSlot = slot
	return plan
}

func withBundle(plan Plan, bundle BundleRef) Plan {
	plan.Bundle = bundle
	return plan
}

func withRef(plan Plan, ref string) Plan {
	plan.Bundle.Ref = ref
	return plan
}

func withIntegrity(plan Plan, integrity string) Plan {
	plan.Bundle.Integrity = integrity
	return plan
}

func withVersion(plan Plan, version string) Plan {
	plan.Bundle.Version = version
	return plan
}
