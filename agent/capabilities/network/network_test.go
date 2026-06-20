package network

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
	policyHTTP        = policyWith(Rule{Proto: ProtoTCP, Port: 443, SourceCIDR: "10.0.0.0/8", Interface: "eth0"})
	policyAdmin       = policyWith(Rule{Proto: ProtoTCP, Port: 22, SourceCIDR: "192.168.1.0/24", Interface: "eth0"})
	errSimulatedWrite = errors.New("simulated write failure")
	errSimulatedApply = errors.New("simulated apply failure")
)

func TestApplyReturnsUndoRestoringExactPriorBytes(t *testing.T) {
	ctx := context.Background()
	prior := renderPolicy(policyAdmin)
	fs := newMemoryFileSystem(prior)
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, applyPolicy(policyHTTP))
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo")
	}

	wantApplied := renderPolicy(policyHTTP)
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, wantApplied) {
		t.Fatalf("live policy after Apply = %q, want %q", got, wantApplied)
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live policy after Undo = %q, want exact prior bytes %q", got, prior)
	}
}

func TestApplyUndoRestoresAbsentPriorPolicy(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(nil)
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, applyPolicy(policyHTTP))
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if !fs.exists {
		t.Fatal("Apply did not create live policy")
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if fs.exists {
		t.Fatalf("Undo left live policy %q, want absent", fs.live)
	}
}

func TestHandleReadsCurrentPolicy(t *testing.T) {
	ctx := context.Background()
	raw := renderPolicy(policyHTTP)
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
	if !reflect.DeepEqual(readResponse.Policy, policyHTTP) {
		t.Fatalf("ReadResponse.Policy = %#v, want %#v", readResponse.Policy, policyHTTP)
	}
	if !reflect.DeepEqual(readResponse.Raw, raw) {
		t.Fatalf("ReadResponse.Raw = %q, want %q", readResponse.Raw, raw)
	}
}

func TestTransactionApplyCommitsNetworkPolicyWhenHealthPasses(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(renderPolicy(policyAdmin))
	networkCapability := newCapability(fs)
	registry := mustRegistry(t, networkCapability)

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: applyPolicy(policyHTTP)},
	}, func(context.Context) error {
		return nil
	})

	if !result.Committed() {
		t.Fatalf("Outcome = %q, want committed; err=%v", result.Outcome, result.Err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, renderPolicy(policyHTTP)) {
		t.Fatalf("live policy = %q, want desired policy", got)
	}
	if len(result.RolledBack) != 0 {
		t.Fatalf("RolledBack = %v, want none", result.RolledBack)
	}
}

func TestTransactionApplyRollsBackNetworkPolicyWhenLaterOperationFails(t *testing.T) {
	ctx := context.Background()
	prior := renderPolicy(policyAdmin)
	fs := newMemoryFileSystem(prior)
	networkCapability := newCapability(fs)
	registry := mustRegistry(t, networkCapability, failingTxCapability{name: "test.later"})

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: applyPolicy(policyHTTP)},
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
		t.Fatalf("live policy after rollback = %q, want exact prior bytes %q", got, prior)
	}
	wantRolledBack := []transaction.RolledBackOperation{{Index: 0, Capability: Name}}
	if !reflect.DeepEqual(result.RolledBack, wantRolledBack) {
		t.Fatalf("RolledBack = %v, want %v", result.RolledBack, wantRolledBack)
	}
	if len(result.RollbackErrors) != 0 {
		t.Fatalf("RollbackErrors = %v, want none", result.RollbackErrors)
	}
}

func TestAtomicWriteFailureLeavesLivePolicyUnchanged(t *testing.T) {
	ctx := context.Background()
	prior := renderPolicy(policyAdmin)
	fs := newMemoryFileSystem(prior)
	fs.failNextAtomicWriteBeforeCommit = true
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, applyPolicy(policyHTTP))
	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil on failed write", undo)
	}
	if !errors.Is(err, errSimulatedWrite) {
		t.Fatalf("Apply error = %v, want simulated write failure", err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live policy after failed atomic write = %q, want unchanged %q", got, prior)
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
	prior := renderPolicy(policyAdmin)
	fs := newMemoryFileSystem(prior)
	fs.tryErrorAfterCommit = true
	networkCapability := newCapability(fs)
	registry := mustRegistry(t, networkCapability, failingTxCapability{name: "test.later"})

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: applyPolicy(policyHTTP)},
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
		t.Fatalf("live policy after rollback = %q, want exact prior bytes %q", got, prior)
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
	prior := renderPolicy(policyAdmin)
	fs := newMemoryFileSystem(prior)
	fs.tryErrorAfterCommit = true
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, applyPolicy(policyHTTP))
	if err != nil {
		t.Fatalf("Apply returned error after commit attempt: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo after commit attempt")
	}
	if !fs.observedErrorAfterCommitAttempt {
		t.Fatal("test did not exercise the after-commit failure injection")
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, renderPolicy(policyHTTP)) {
		t.Fatalf("live policy after commit = %q, want desired policy", got)
	}
	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live policy after Undo = %q, want exact prior bytes %q", got, prior)
	}
}

func TestApplyRejectsInvalidPolicyWithoutWriting(t *testing.T) {
	ctx := context.Background()
	prior := renderPolicy(policyAdmin)
	wideOpen := Rule{Proto: ProtoTCP, Port: PortAll, SourceCIDR: "0.0.0.0/0", Interface: "eth0"}
	nilAllow := []Rule(nil)
	tests := []struct {
		name string
		req  capabilities.TypedRequest
	}{
		{
			name: "wrong request type cannot smuggle path",
			req:  pathSmugglingRequest{Path: "/tmp/attacker", Desired: policyHTTP},
		},
		{
			name: "missing desired",
			req:  ApplyRequest{},
		},
		{
			name: "missing allow",
			req:  ApplyRequest{Desired: &Policy{}},
		},
		{
			name: "nil allow list",
			req:  ApplyRequest{Desired: &Policy{Allow: &nilAllow}},
		},
		{
			name: "bad proto",
			req:  applyPolicy(policyWith(Rule{Proto: "icmp", Port: 8, SourceCIDR: "10.0.0.0/8", Interface: "eth0"})),
		},
		{
			name: "zero port",
			req:  applyPolicy(policyWith(Rule{Proto: ProtoTCP, Port: 0, SourceCIDR: "10.0.0.0/8", Interface: "eth0"})),
		},
		{
			name: "port too high",
			req:  applyPolicy(policyWith(Rule{Proto: ProtoTCP, Port: 65536, SourceCIDR: "10.0.0.0/8", Interface: "eth0"})),
		},
		{
			name: "bad cidr",
			req:  applyPolicy(policyWith(Rule{Proto: ProtoTCP, Port: 443, SourceCIDR: "0.0.0.0", Interface: "eth0"})),
		},
		{
			name: "missing interface",
			req:  applyPolicy(policyWith(Rule{Proto: ProtoTCP, Port: 443, SourceCIDR: "10.0.0.0/8"})),
		},
		{
			name: "wide open without explicit unsafe flag",
			req:  applyPolicy(policyWith(wideOpen)),
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
				t.Fatalf("live policy = %q, want unchanged %q", got, prior)
			}
		})
	}
}

func TestWideOpenRuleRequiresExplicitUnsafeFlag(t *testing.T) {
	ctx := context.Background()
	wideOpen := policyWith(Rule{
		Proto:          ProtoTCP,
		Port:           PortAll,
		SourceCIDR:     "0.0.0.0/0",
		Interface:      "eth0",
		UnsafeWideOpen: true,
	})
	fs := newMemoryFileSystem(renderPolicy(policyAdmin))
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, applyPolicy(wideOpen))
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo")
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, renderPolicy(wideOpen)) {
		t.Fatalf("live policy = %q, want wide-open policy %q", got, renderPolicy(wideOpen))
	}
}

func TestApplyAcceptsExplicitEmptyAllowList(t *testing.T) {
	ctx := context.Background()
	denyAll := policyWith()
	fs := newMemoryFileSystem(renderPolicy(policyAdmin))
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, applyPolicy(denyAll))
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo")
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, []byte("{\"allow\":[]}\n")) {
		t.Fatalf("live policy = %q, want explicit deny-all", got)
	}
}

func TestValidateDistinguishesMissingFromExplicitEmptyAllow(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		wantErr bool
	}{
		{name: "missing desired", raw: `{}`, wantErr: true},
		{name: "missing allow", raw: `{"desired":{}}`, wantErr: true},
		{name: "explicit empty allow", raw: `{"desired":{"allow":[]}}`, wantErr: false},
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

func (fs *memoryFileSystem) Read(ctx context.Context) (policySnapshot, error) {
	if err := ctx.Err(); err != nil {
		return policySnapshot{}, err
	}
	return policySnapshot{exists: fs.exists, bytes: cloneBytes(fs.live)}, nil
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

func (fs *memoryFileSystem) Replace(ctx context.Context, snapshot policySnapshot) error {
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
		t.Fatal("live policy does not exist")
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
	Desired Policy
}

func (pathSmugglingRequest) CapabilityRequest() {}

func policyWith(rules ...Rule) Policy {
	allow := make([]Rule, len(rules))
	copy(allow, rules)
	return Policy{Allow: &allow}
}

func applyPolicy(policy Policy) ApplyRequest {
	desired := clonePolicy(policy)
	return ApplyRequest{Desired: &desired}
}

func mustRegistry(t *testing.T, registered ...capabilities.Capability) *capabilities.Registry {
	t.Helper()

	registry, err := capabilities.NewRegistry(registered...)
	if err != nil {
		t.Fatalf("NewRegistry returned error: %v", err)
	}
	return registry
}
