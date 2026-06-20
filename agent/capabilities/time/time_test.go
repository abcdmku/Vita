package nodetime

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/transaction"
)

var (
	initialTime        = time.Unix(1_700_000_000, 123_000_000).UTC()
	desiredTime        = initialTime.Add(90 * time.Second)
	errSimulatedSet    = errors.New("simulated set failure")
	errSimulatedApply  = errors.New("simulated apply failure")
	errSimulatedHealth = errors.New("simulated health failure")
)

func TestHandleReadsCurrentTime(t *testing.T) {
	ctx := context.Background()
	clock := newMemoryClock(initialTime)
	capability := newCapability(clock)

	response, err := capability.Handle(ctx, ReadRequest{})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}

	readResponse, ok := response.(ReadResponse)
	if !ok {
		t.Fatalf("Handle returned %T, want ReadResponse", response)
	}
	if !readResponse.Current.Equal(initialTime) {
		t.Fatalf("ReadResponse.Current = %v, want %v", readResponse.Current, initialTime)
	}
}

func TestApplySetsTimeAndUndoRestoresPriorTime(t *testing.T) {
	ctx := context.Background()
	clock := newMemoryClock(initialTime)
	capability := newCapability(clock)

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: desiredTime})
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo")
	}
	if !clock.current.Equal(desiredTime) {
		t.Fatalf("clock after Apply = %v, want %v", clock.current, desiredTime)
	}
	if !reflect.DeepEqual(clock.sets, []time.Time{desiredTime}) {
		t.Fatalf("sets after Apply = %v, want [%v]", clock.sets, desiredTime)
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if !clock.current.Equal(initialTime) {
		t.Fatalf("clock after Undo = %v, want %v", clock.current, initialTime)
	}
	wantSets := []time.Time{desiredTime, initialTime}
	if !reflect.DeepEqual(clock.sets, wantSets) {
		t.Fatalf("sets after Undo = %v, want %v", clock.sets, wantSets)
	}
}

func TestTransactionApplyCommitsTimeWhenHealthPasses(t *testing.T) {
	ctx := context.Background()
	clock := newMemoryClock(initialTime)
	timeCapability := newCapability(clock)
	registry := mustRegistry(t, timeCapability)

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: ApplyRequest{Desired: desiredTime}},
	}, func(context.Context) error {
		return nil
	})

	if !result.Committed() {
		t.Fatalf("Outcome = %q, want committed; err=%v", result.Outcome, result.Err)
	}
	if !clock.current.Equal(desiredTime) {
		t.Fatalf("clock after transaction = %v, want %v", clock.current, desiredTime)
	}
	if len(result.RolledBack) != 0 {
		t.Fatalf("RolledBack = %v, want none", result.RolledBack)
	}
}

func TestTransactionApplyRollsBackTimeWhenLaterOperationFails(t *testing.T) {
	ctx := context.Background()
	clock := newMemoryClock(initialTime)
	timeCapability := newCapability(clock)
	registry := mustRegistry(t, timeCapability, failingTxCapability{name: "test.later"})

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: ApplyRequest{Desired: desiredTime}},
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
	if !clock.current.Equal(initialTime) {
		t.Fatalf("clock after rollback = %v, want %v", clock.current, initialTime)
	}
	wantSets := []time.Time{desiredTime, initialTime}
	if !reflect.DeepEqual(clock.sets, wantSets) {
		t.Fatalf("sets after rollback = %v, want %v", clock.sets, wantSets)
	}
	wantRolledBack := []transaction.RolledBackOperation{{Index: 0, Capability: Name}}
	if !reflect.DeepEqual(result.RolledBack, wantRolledBack) {
		t.Fatalf("RolledBack = %v, want %v", result.RolledBack, wantRolledBack)
	}
	if len(result.RollbackErrors) != 0 {
		t.Fatalf("RollbackErrors = %v, want none", result.RollbackErrors)
	}
}

func TestTransactionApplyRollsBackTimeWhenHealthFails(t *testing.T) {
	ctx := context.Background()
	clock := newMemoryClock(initialTime)
	timeCapability := newCapability(clock)
	registry := mustRegistry(t, timeCapability)

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: ApplyRequest{Desired: desiredTime}},
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
	if !clock.current.Equal(initialTime) {
		t.Fatalf("clock after health rollback = %v, want %v", clock.current, initialTime)
	}
}

func TestApplyRejectsInvalidOrOutOfRangeRequestWithoutSetting(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name string
		req  capabilities.TypedRequest
	}{
		{
			name: "wrong request type cannot smuggle command",
			req:  commandSmugglingRequest{Command: "set-clock --unsafe", Desired: desiredTime},
		},
		{
			name: "zero desired time",
			req:  ApplyRequest{Desired: time.Time{}},
		},
		{
			name: "too far future",
			req:  ApplyRequest{Desired: initialTime.Add(maxClockSkew + time.Nanosecond)},
		},
		{
			name: "too far past",
			req:  ApplyRequest{Desired: initialTime.Add(-maxClockSkew - time.Nanosecond)},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clock := newMemoryClock(initialTime)
			capability := newCapability(clock)

			undo, err := capability.Apply(ctx, tt.req)
			if undo != nil {
				t.Fatalf("Apply returned undo %v, want nil", undo)
			}
			var invalid *InvalidRequestError
			if !errors.As(err, &invalid) {
				t.Fatalf("Apply error = %T %v, want InvalidRequestError", err, err)
			}
			if !clock.current.Equal(initialTime) {
				t.Fatalf("clock after rejected request = %v, want %v", clock.current, initialTime)
			}
			if len(clock.sets) != 0 {
				t.Fatalf("sets = %v, want none", clock.sets)
			}
		})
	}
}

func TestApplyAcceptsBoundarySkew(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name    string
		desired time.Time
	}{
		{name: "future boundary", desired: initialTime.Add(maxClockSkew)},
		{name: "past boundary", desired: initialTime.Add(-maxClockSkew)},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clock := newMemoryClock(initialTime)
			capability := newCapability(clock)

			undo, err := capability.Apply(ctx, ApplyRequest{Desired: tt.desired})
			if err != nil {
				t.Fatalf("Apply returned error: %v", err)
			}
			if undo == nil {
				t.Fatal("Apply returned nil undo")
			}
			if !clock.current.Equal(tt.desired) {
				t.Fatalf("clock after Apply = %v, want %v", clock.current, tt.desired)
			}
		})
	}
}

func TestSetFailureLeavesClockUnchanged(t *testing.T) {
	ctx := context.Background()
	clock := newMemoryClock(initialTime)
	clock.failNextSetBeforeCommit = true
	capability := newCapability(clock)

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: desiredTime})
	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil", undo)
	}
	if !errors.Is(err, errSimulatedSet) {
		t.Fatalf("Apply error = %v, want simulated set failure", err)
	}
	if !clock.current.Equal(initialTime) {
		t.Fatalf("clock after failed set = %v, want %v", clock.current, initialTime)
	}
	if len(clock.sets) != 0 {
		t.Fatalf("sets = %v, want none", clock.sets)
	}
}

func TestUnsupportedClockReturnsUnsupported(t *testing.T) {
	clock := newUnsupportedClock("testos")
	capability := newCapability(clock)

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

	undo, err := capability.Apply(context.Background(), ApplyRequest{Desired: desiredTime})
	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil", undo)
	}
	if !errors.As(err, &unsupported) {
		t.Fatalf("Apply error = %T %v, want UnsupportedPlatformError", err, err)
	}
}

type memoryClock struct {
	current                 time.Time
	sets                    []time.Time
	failNextSetBeforeCommit bool
}

func newMemoryClock(current time.Time) *memoryClock {
	return &memoryClock{current: current}
}

func (c *memoryClock) Now(ctx context.Context) (time.Time, error) {
	if err := ctx.Err(); err != nil {
		return time.Time{}, err
	}
	return c.current, nil
}

func (c *memoryClock) Set(ctx context.Context, desired time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if c.failNextSetBeforeCommit {
		c.failNextSetBeforeCommit = false
		return errSimulatedSet
	}
	c.current = desired
	c.sets = append(c.sets, desired)
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
	Desired time.Time
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
