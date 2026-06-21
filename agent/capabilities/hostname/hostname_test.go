package hostname

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

var (
	initialHostname     = "vita-node"
	desiredHostname     = "vita-node-2"
	errSimulatedSet     = errors.New("simulated hostname set failure")
	errSimulatedApply   = errors.New("simulated apply failure")
	errSimulatedHealth  = errors.New("simulated health failure")
	errSimulatedCurrent = errors.New("simulated hostname read failure")
)

func TestHandleReadsCurrentHostname(t *testing.T) {
	ctx := context.Background()
	host := newMemoryHost(initialHostname)
	capability := newCapability(host)

	response, err := capability.Handle(ctx, ReadRequest{})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}

	readResponse, ok := response.(ReadResponse)
	if !ok {
		t.Fatalf("Handle returned %T, want ReadResponse", response)
	}
	if readResponse.Current != initialHostname {
		t.Fatalf("ReadResponse.Current = %q, want %q", readResponse.Current, initialHostname)
	}
}

func TestApplySetsHostnameAndUndoRestoresPriorHostname(t *testing.T) {
	ctx := context.Background()
	host := newMemoryHost(initialHostname)
	capability := newCapability(host)

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: desiredHostname})
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo")
	}
	if host.current != desiredHostname {
		t.Fatalf("hostname after Apply = %q, want %q", host.current, desiredHostname)
	}
	if !reflect.DeepEqual(host.sets, []string{desiredHostname}) {
		t.Fatalf("sets after Apply = %v, want [%q]", host.sets, desiredHostname)
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if host.current != initialHostname {
		t.Fatalf("hostname after Undo = %q, want %q", host.current, initialHostname)
	}
	wantSets := []string{desiredHostname, initialHostname}
	if !reflect.DeepEqual(host.sets, wantSets) {
		t.Fatalf("sets after Undo = %v, want %v", host.sets, wantSets)
	}
}

func TestTransactionApplyCommitsHostnameWhenHealthPasses(t *testing.T) {
	ctx := context.Background()
	host := newMemoryHost(initialHostname)
	hostnameCapability := newCapability(host)
	registry := mustRegistry(t, hostnameCapability)

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: ApplyRequest{Desired: desiredHostname}},
	}, func(context.Context) error {
		return nil
	})

	if !result.Committed() {
		t.Fatalf("Outcome = %q, want committed; err=%v", result.Outcome, result.Err)
	}
	if host.current != desiredHostname {
		t.Fatalf("hostname after transaction = %q, want %q", host.current, desiredHostname)
	}
	if len(result.RolledBack) != 0 {
		t.Fatalf("RolledBack = %v, want none", result.RolledBack)
	}
}

func TestTransactionApplyRollsBackHostnameWhenLaterOperationFails(t *testing.T) {
	ctx := context.Background()
	host := newMemoryHost(initialHostname)
	hostnameCapability := newCapability(host)
	registry := mustRegistry(t, hostnameCapability, failingTxCapability{name: "test.later"})

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: ApplyRequest{Desired: desiredHostname}},
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
	if host.current != initialHostname {
		t.Fatalf("hostname after rollback = %q, want %q", host.current, initialHostname)
	}
	wantSets := []string{desiredHostname, initialHostname}
	if !reflect.DeepEqual(host.sets, wantSets) {
		t.Fatalf("sets after rollback = %v, want %v", host.sets, wantSets)
	}
	wantRolledBack := []transaction.RolledBackOperation{{Index: 0, Capability: Name}}
	if !reflect.DeepEqual(result.RolledBack, wantRolledBack) {
		t.Fatalf("RolledBack = %v, want %v", result.RolledBack, wantRolledBack)
	}
	if len(result.RollbackErrors) != 0 {
		t.Fatalf("RollbackErrors = %v, want none", result.RollbackErrors)
	}
}

func TestTransactionApplyRollsBackHostnameWhenHealthFails(t *testing.T) {
	ctx := context.Background()
	host := newMemoryHost(initialHostname)
	hostnameCapability := newCapability(host)
	registry := mustRegistry(t, hostnameCapability)

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: ApplyRequest{Desired: desiredHostname}},
	}, func(context.Context) error {
		return errSimulatedHealth
	})

	if !result.WasRolledBack() {
		t.Fatalf("Outcome = %q, want rolledBack", result.Outcome)
	}
	var healthErr *transaction.HealthCheckError
	if !errors.As(result.Err, &healthErr) {
		t.Fatalf("Err = %T %v, want HealthCheckError", result.Err, result.Err)
	}
	if !errors.Is(result.Err, errSimulatedHealth) {
		t.Fatalf("Err = %v, want simulated health failure", result.Err)
	}
	if host.current != initialHostname {
		t.Fatalf("hostname after health rollback = %q, want %q", host.current, initialHostname)
	}
}

func TestApplyRejectsInvalidHostnameWithoutSetting(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name string
		req  capabilities.TypedRequest
	}{
		{
			name: "wrong request type cannot smuggle command",
			req:  commandSmugglingRequest{Command: "set-hostname unsafe", Desired: desiredHostname},
		},
		{
			name: "empty",
			req:  ApplyRequest{Desired: ""},
		},
		{
			name: "too long",
			req:  ApplyRequest{Desired: strings.Repeat("a", maxHostnameLen+1)},
		},
		{
			name: "uppercase",
			req:  ApplyRequest{Desired: "Vita-node"},
		},
		{
			name: "leading dash",
			req:  ApplyRequest{Desired: "-vita-node"},
		},
		{
			name: "trailing dash",
			req:  ApplyRequest{Desired: "vita-node-"},
		},
		{
			name: "all numeric",
			req:  ApplyRequest{Desired: "12345"},
		},
		{
			name: "control char",
			req:  ApplyRequest{Desired: "vita\nnode"},
		},
		{
			name: "underscore",
			req:  ApplyRequest{Desired: "vita_node"},
		},
		{
			name: "fqdn",
			req:  ApplyRequest{Desired: "vita.node"},
		},
		{
			name: "non ascii",
			req:  ApplyRequest{Desired: "vit\u00e1-node"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			host := newMemoryHost(initialHostname)
			capability := newCapability(host)

			undo, err := capability.Apply(ctx, tt.req)
			if undo != nil {
				t.Fatalf("Apply returned undo %v, want nil", undo)
			}
			var invalid *InvalidRequestError
			if !errors.As(err, &invalid) {
				t.Fatalf("Apply error = %T %v, want InvalidRequestError", err, err)
			}
			if host.current != initialHostname {
				t.Fatalf("hostname after rejected request = %q, want %q", host.current, initialHostname)
			}
			if len(host.sets) != 0 {
				t.Fatalf("sets = %v, want none", host.sets)
			}
		})
	}
}

func TestApplyAcceptsValidDNSLabelBoundaries(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name    string
		desired string
	}{
		{name: "single letter", desired: "a"},
		{name: "max length", desired: strings.Repeat("a", maxHostnameLen)},
		{name: "mixed lowercase digits hyphen", desired: "vita-node-7"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			host := newMemoryHost(initialHostname)
			capability := newCapability(host)

			undo, err := capability.Apply(ctx, ApplyRequest{Desired: tt.desired})
			if err != nil {
				t.Fatalf("Apply returned error: %v", err)
			}
			if undo == nil {
				t.Fatal("Apply returned nil undo")
			}
			if host.current != tt.desired {
				t.Fatalf("hostname after Apply = %q, want %q", host.current, tt.desired)
			}
		})
	}
}

func TestApplyRequestJSONRejectsDuplicateDesiredWithValidFinalValue(t *testing.T) {
	var request ApplyRequest
	err := json.Unmarshal([]byte(`{"desired":"bad_host","desired":"vita-node"}`), &request)
	if err == nil {
		t.Fatal("Unmarshal returned nil, want duplicate-key rejection")
	}
	if !strings.Contains(err.Error(), "duplicate JSON object key") {
		t.Fatalf("Unmarshal error = %v, want duplicate-key rejection", err)
	}
}

func TestSetFailureLeavesHostnameUnchangedAndNoUndo(t *testing.T) {
	ctx := context.Background()
	host := newMemoryHost(initialHostname)
	host.failNextSetBeforeCommit = true
	capability := newCapability(host)

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: desiredHostname})
	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil", undo)
	}
	if !errors.Is(err, errSimulatedSet) {
		t.Fatalf("Apply error = %v, want simulated set failure", err)
	}
	if host.current != initialHostname {
		t.Fatalf("hostname after failed set = %q, want %q", host.current, initialHostname)
	}
	if len(host.sets) != 0 {
		t.Fatalf("sets = %v, want none", host.sets)
	}
}

func TestCurrentFailureLeavesHostnameUnchangedAndNoUndo(t *testing.T) {
	ctx := context.Background()
	host := newMemoryHost(initialHostname)
	host.failCurrent = true
	capability := newCapability(host)

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: desiredHostname})
	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil", undo)
	}
	if !errors.Is(err, errSimulatedCurrent) {
		t.Fatalf("Apply error = %v, want simulated current failure", err)
	}
	if host.current != initialHostname {
		t.Fatalf("hostname after failed read = %q, want %q", host.current, initialHostname)
	}
	if len(host.sets) != 0 {
		t.Fatalf("sets = %v, want none", host.sets)
	}
}

func TestUnsupportedHostReturnsUnsupported(t *testing.T) {
	host := newUnsupportedHost("testos")
	capability := newCapability(host)

	response, err := capability.Handle(context.Background(), ReadRequest{})
	if response != nil {
		t.Fatalf("Handle returned response %v, want nil", response)
	}
	var unsupported *UnsupportedPlatformError
	if !errors.As(err, &unsupported) {
		t.Fatalf("Handle error = %T %v, want UnsupportedPlatformError", err, err)
	}
	if unsupported.GOOS != "testos" {
		t.Fatalf("UnsupportedPlatformError.GOOS = %q, want testos", unsupported.GOOS)
	}

	undo, err := capability.Apply(context.Background(), ApplyRequest{Desired: desiredHostname})
	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil", undo)
	}
	if !errors.As(err, &unsupported) {
		t.Fatalf("Apply error = %T %v, want UnsupportedPlatformError", err, err)
	}
}

type memoryHost struct {
	current                 string
	sets                    []string
	failCurrent             bool
	failNextSetBeforeCommit bool
}

func newMemoryHost(current string) *memoryHost {
	return &memoryHost{current: current}
}

func (h *memoryHost) Current(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if h.failCurrent {
		return "", errSimulatedCurrent
	}
	return h.current, nil
}

func (h *memoryHost) Set(ctx context.Context, desired string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if h.failNextSetBeforeCommit {
		h.failNextSetBeforeCommit = false
		return errSimulatedSet
	}
	h.current = desired
	h.sets = append(h.sets, desired)
	return nil
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

type commandSmugglingRequest struct {
	Command string
	Desired string
}

func (commandSmugglingRequest) CapabilityRequest() {}

func mustRegistry(t *testing.T, registered ...capabilities.Capability) *capabilities.Registry {
	t.Helper()

	registry, err := capabilities.NewRegistry(registered...)
	if err != nil {
		t.Fatalf("NewRegistry returned error: %v", err)
	}
	return registry
}
