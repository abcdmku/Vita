package nodeconfig

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/transaction"
)

var (
	configNormalDisabled = Config{Mode: ModeNormal, RemoteAccess: RemoteAccessDisabled}
	configMaintEnabled   = Config{Mode: ModeMaintenance, RemoteAccess: RemoteAccessEnabled}
	errSimulatedWrite    = errors.New("simulated write failure")
	errSimulatedApply    = errors.New("simulated apply failure")
)

func TestApplyReturnsUndoRestoringExactPriorBytes(t *testing.T) {
	ctx := context.Background()
	prior := []byte("mode=normal\nremote_access=disabled\n")
	fs := newMemoryFileSystem(prior)
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: configMaintEnabled})
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo")
	}

	wantApplied := []byte("mode=maintenance\nremote_access=enabled\n")
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, wantApplied) {
		t.Fatalf("live config after Apply = %q, want %q", got, wantApplied)
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live config after Undo = %q, want exact prior bytes %q", got, prior)
	}
}

func TestApplyUndoRestoresAbsentPriorConfig(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(nil)
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: configMaintEnabled})
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if !fs.exists {
		t.Fatal("Apply did not create live config")
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if fs.exists {
		t.Fatalf("Undo left live config %q, want absent", fs.live)
	}
}

func TestHandleReadsCurrentConfig(t *testing.T) {
	ctx := context.Background()
	raw := []byte("mode=normal\nremote_access=disabled\n")
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
	if readResponse.Config != configNormalDisabled {
		t.Fatalf("ReadResponse.Config = %#v, want %#v", readResponse.Config, configNormalDisabled)
	}
	if !reflect.DeepEqual(readResponse.Raw, raw) {
		t.Fatalf("ReadResponse.Raw = %q, want %q", readResponse.Raw, raw)
	}
}

func TestTransactionApplyCommitsNodeConfigWhenHealthPasses(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem([]byte("mode=normal\nremote_access=disabled\n"))
	nodeCapability := newCapability(fs)
	registry := mustRegistry(t, nodeCapability)

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: ApplyRequest{Desired: configMaintEnabled}},
	}, func(context.Context) error {
		return nil
	})

	if !result.Committed() {
		t.Fatalf("Outcome = %q, want committed; err=%v", result.Outcome, result.Err)
	}
	if got := fs.mustLiveBytes(t); string(got) != "mode=maintenance\nremote_access=enabled\n" {
		t.Fatalf("live config = %q, want desired config", got)
	}
	if len(result.RolledBack) != 0 {
		t.Fatalf("RolledBack = %v, want none", result.RolledBack)
	}
}

func TestTransactionApplyRollsBackNodeConfigWhenLaterOperationFails(t *testing.T) {
	ctx := context.Background()
	prior := []byte("mode=normal\nremote_access=disabled\n")
	fs := newMemoryFileSystem(prior)
	nodeCapability := newCapability(fs)
	registry := mustRegistry(t, nodeCapability, failingTxCapability{name: "test.later"})

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: ApplyRequest{Desired: configMaintEnabled}},
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
		t.Fatalf("live config after rollback = %q, want exact prior bytes %q", got, prior)
	}
	wantRolledBack := []transaction.RolledBackOperation{{Index: 0, Capability: Name}}
	if !reflect.DeepEqual(result.RolledBack, wantRolledBack) {
		t.Fatalf("RolledBack = %v, want %v", result.RolledBack, wantRolledBack)
	}
	if len(result.RollbackErrors) != 0 {
		t.Fatalf("RollbackErrors = %v, want none", result.RollbackErrors)
	}
}

func TestAtomicWriteFailureLeavesLiveFileUnchanged(t *testing.T) {
	ctx := context.Background()
	prior := []byte("mode=normal\nremote_access=disabled\n")
	fs := newMemoryFileSystem(prior)
	fs.failNextAtomicWrite = true
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: configMaintEnabled})
	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil on failed write", undo)
	}
	if !errors.Is(err, errSimulatedWrite) {
		t.Fatalf("Apply error = %v, want simulated write failure", err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live config after failed atomic write = %q, want unchanged %q", got, prior)
	}
	if fs.temp == nil {
		t.Fatal("simulated atomic write did not stage a temp file")
	}
	if reflect.DeepEqual(fs.temp, fs.live) {
		t.Fatal("test did not simulate a partial temp distinct from the live file")
	}
}

func TestApplyRejectsInvalidRequestWithoutWriting(t *testing.T) {
	ctx := context.Background()
	prior := []byte("mode=normal\nremote_access=disabled\n")
	tests := []struct {
		name string
		req  capabilities.TypedRequest
	}{
		{
			name: "wrong request type cannot smuggle path",
			req:  pathSmugglingRequest{Path: "/tmp/attacker", Desired: configMaintEnabled},
		},
		{
			name: "missing required enum",
			req:  ApplyRequest{Desired: Config{Mode: ModeMaintenance}},
		},
		{
			name: "unknown enum value",
			req:  ApplyRequest{Desired: Config{Mode: "reboot", RemoteAccess: RemoteAccessEnabled}},
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
				t.Fatalf("live config = %q, want unchanged %q", got, prior)
			}
		})
	}
}

type memoryFileSystem struct {
	exists              bool
	live                []byte
	temp                []byte
	failNextAtomicWrite bool
}

func newMemoryFileSystem(initial []byte) *memoryFileSystem {
	if initial == nil {
		return &memoryFileSystem{}
	}
	return &memoryFileSystem{exists: true, live: cloneBytes(initial)}
}

func (fs *memoryFileSystem) Read(ctx context.Context) (configSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return configSnapshot{}, err
	}
	return configSnapshot{exists: fs.exists, bytes: cloneBytes(fs.live)}, nil
}

func (fs *memoryFileSystem) AtomicWrite(ctx context.Context, content []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	fs.temp = cloneBytes(content)
	if len(fs.temp) > 1 {
		fs.temp = cloneBytes(fs.temp[:len(fs.temp)/2])
	}
	if fs.failNextAtomicWrite {
		fs.failNextAtomicWrite = false
		return errSimulatedWrite
	}
	fs.live = cloneBytes(content)
	fs.exists = true
	fs.temp = nil
	return nil
}

func (fs *memoryFileSystem) Replace(ctx context.Context, snapshot configSnapshot) error {
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
		t.Fatal("live config does not exist")
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
	Desired Config
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
