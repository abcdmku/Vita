package transaction

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/vita/agent/capabilities"
)

type testRequest struct {
	Value string
}

func (testRequest) CapabilityRequest() {}

type testResponse struct{}

func (testResponse) CapabilityResponse() {}

type testTxCapability struct {
	name      string
	applyErr  error
	undoErr   error
	events    *[]string
	committed *map[string]bool
}

func (c *testTxCapability) Name() string {
	return c.name
}

func (c *testTxCapability) Handle(context.Context, capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	return testResponse{}, nil
}

func (c *testTxCapability) Apply(_ context.Context, req capabilities.TypedRequest) (Undo, error) {
	typedReq, ok := req.(testRequest)
	if !ok {
		return nil, errors.New("unexpected request")
	}
	if c.events != nil {
		*c.events = append(*c.events, "apply:"+typedReq.Value)
	}
	if c.applyErr != nil {
		return nil, c.applyErr
	}
	if c.committed != nil {
		(*c.committed)[typedReq.Value] = true
	}
	return testUndo{
		value:     typedReq.Value,
		err:       c.undoErr,
		events:    c.events,
		committed: c.committed,
	}, nil
}

type testUndo struct {
	value     string
	err       error
	events    *[]string
	committed *map[string]bool
}

func (u testUndo) Undo(context.Context) error {
	if u.events != nil {
		*u.events = append(*u.events, "undo:"+u.value)
	}
	if u.err != nil {
		return u.err
	}
	if u.committed != nil {
		delete(*u.committed, u.value)
	}
	return nil
}

type nonTransactionalCapability struct {
	name   string
	called bool
}

func (c *nonTransactionalCapability) Name() string {
	return c.name
}

func (c *nonTransactionalCapability) Handle(context.Context, capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	c.called = true
	return testResponse{}, nil
}

func TestApplyCommitsWhenOperationsAndHealthSucceed(t *testing.T) {
	events := []string{}
	committed := map[string]bool{}
	first := &testTxCapability{name: "test.first", events: &events, committed: &committed}
	second := &testTxCapability{name: "test.second", events: &events, committed: &committed}
	registry := mustRegistry(t, first, second)

	result := Apply(context.Background(), registry, Plan{
		{Capability: "test.first", Request: testRequest{Value: "one"}},
		{Capability: "test.second", Request: testRequest{Value: "two"}},
	}, func(context.Context) error {
		events = append(events, "health")
		return nil
	})

	if !result.Committed() {
		t.Fatalf("Outcome = %q, want committed; err=%v", result.Outcome, result.Err)
	}
	if len(result.RollbackErrors) != 0 {
		t.Fatalf("RollbackErrors = %v, want none", result.RollbackErrors)
	}
	wantEvents := []string{"apply:one", "apply:two", "health"}
	if !reflect.DeepEqual(events, wantEvents) {
		t.Fatalf("events = %v, want %v", events, wantEvents)
	}
	wantApplied := []AppliedOperation{
		{Index: 0, Capability: "test.first"},
		{Index: 1, Capability: "test.second"},
	}
	if !reflect.DeepEqual(result.Applied, wantApplied) {
		t.Fatalf("Applied = %v, want %v", result.Applied, wantApplied)
	}
	if len(result.RolledBack) != 0 {
		t.Fatalf("RolledBack = %v, want none", result.RolledBack)
	}
	if !committed["one"] || !committed["two"] {
		t.Fatalf("committed = %v, want one and two", committed)
	}
}

func TestApplyFailureRollsBackPreviousOperationsInReverseOrder(t *testing.T) {
	events := []string{}
	committed := map[string]bool{}
	applyErr := errors.New("apply failed")
	first := &testTxCapability{name: "test.first", events: &events, committed: &committed}
	second := &testTxCapability{name: "test.second", events: &events, committed: &committed}
	third := &testTxCapability{name: "test.third", applyErr: applyErr, events: &events, committed: &committed}
	registry := mustRegistry(t, first, second, third)

	result := Apply(context.Background(), registry, Plan{
		{Capability: "test.first", Request: testRequest{Value: "one"}},
		{Capability: "test.second", Request: testRequest{Value: "two"}},
		{Capability: "test.third", Request: testRequest{Value: "three"}},
	}, passingHealth)

	if !result.WasRolledBack() {
		t.Fatalf("Outcome = %q, want rolledBack", result.Outcome)
	}
	var applyFailure *ApplyError
	if !errors.As(result.Err, &applyFailure) {
		t.Fatalf("Err = %T %v, want ApplyError", result.Err, result.Err)
	}
	if !errors.Is(result.Err, applyErr) {
		t.Fatalf("Err = %v, want to wrap apply failure", result.Err)
	}
	wantEvents := []string{"apply:one", "apply:two", "apply:three", "undo:two", "undo:one"}
	if !reflect.DeepEqual(events, wantEvents) {
		t.Fatalf("events = %v, want %v", events, wantEvents)
	}
	wantRolledBack := []RolledBackOperation{
		{Index: 1, Capability: "test.second"},
		{Index: 0, Capability: "test.first"},
	}
	if !reflect.DeepEqual(result.RolledBack, wantRolledBack) {
		t.Fatalf("RolledBack = %v, want %v", result.RolledBack, wantRolledBack)
	}
	if len(result.RollbackErrors) != 0 {
		t.Fatalf("RollbackErrors = %v, want none", result.RollbackErrors)
	}
	if len(committed) != 0 {
		t.Fatalf("committed = %v, want empty after rollback", committed)
	}
}

func TestHealthFailureRollsBackEverything(t *testing.T) {
	events := []string{}
	committed := map[string]bool{}
	healthErr := errors.New("unhealthy")
	first := &testTxCapability{name: "test.first", events: &events, committed: &committed}
	second := &testTxCapability{name: "test.second", events: &events, committed: &committed}
	registry := mustRegistry(t, first, second)

	result := Apply(context.Background(), registry, Plan{
		{Capability: "test.first", Request: testRequest{Value: "one"}},
		{Capability: "test.second", Request: testRequest{Value: "two"}},
	}, func(context.Context) error {
		events = append(events, "health")
		return healthErr
	})

	if !result.WasRolledBack() {
		t.Fatalf("Outcome = %q, want rolledBack", result.Outcome)
	}
	var healthFailure *HealthCheckError
	if !errors.As(result.Err, &healthFailure) {
		t.Fatalf("Err = %T %v, want HealthCheckError", result.Err, result.Err)
	}
	if !errors.Is(result.Err, healthErr) {
		t.Fatalf("Err = %v, want to wrap health failure", result.Err)
	}
	wantEvents := []string{"apply:one", "apply:two", "health", "undo:two", "undo:one"}
	if !reflect.DeepEqual(events, wantEvents) {
		t.Fatalf("events = %v, want %v", events, wantEvents)
	}
	if len(committed) != 0 {
		t.Fatalf("committed = %v, want empty after rollback", committed)
	}
}

func TestPreconditionRejectsUnknownOrNonTransactionalCapabilitiesBeforeApply(t *testing.T) {
	tests := []struct {
		name       string
		plan       Plan
		wantReason PreconditionReason
	}{
		{
			name: "unknown",
			plan: Plan{
				{Capability: "test.known", Request: testRequest{Value: "known"}},
				{Capability: "test.missing", Request: testRequest{Value: "missing"}},
			},
			wantReason: PreconditionUnknownCapability,
		},
		{
			name: "non transactional",
			plan: Plan{
				{Capability: "test.known", Request: testRequest{Value: "known"}},
				{Capability: "test.base", Request: testRequest{Value: "base"}},
			},
			wantReason: PreconditionNonTransactionalCapability,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			events := []string{}
			committed := map[string]bool{}
			known := &testTxCapability{name: "test.known", events: &events, committed: &committed}
			base := &nonTransactionalCapability{name: "test.base"}
			registry := mustRegistry(t, known, base)

			result := Apply(context.Background(), registry, tt.plan, passingHealth)

			if !result.Rejected() {
				t.Fatalf("Outcome = %q, want rejected", result.Outcome)
			}
			var precondition *PreconditionError
			if !errors.As(result.Err, &precondition) {
				t.Fatalf("Err = %T %v, want PreconditionError", result.Err, result.Err)
			}
			if precondition.Reason != tt.wantReason {
				t.Fatalf("PreconditionError.Reason = %q, want %q", precondition.Reason, tt.wantReason)
			}
			if len(result.Applied) != 0 {
				t.Fatalf("Applied = %v, want none", result.Applied)
			}
			if len(result.RolledBack) != 0 {
				t.Fatalf("RolledBack = %v, want none", result.RolledBack)
			}
			if len(events) != 0 {
				t.Fatalf("events = %v, want no apply calls", events)
			}
			if len(committed) != 0 {
				t.Fatalf("committed = %v, want empty", committed)
			}
			if base.called {
				t.Fatal("non-transactional capability Handle was called")
			}
		})
	}
}

func TestRollbackErrorIsReported(t *testing.T) {
	events := []string{}
	committed := map[string]bool{}
	undoErr := errors.New("undo failed")
	applyErr := errors.New("apply failed")
	first := &testTxCapability{name: "test.first", undoErr: undoErr, events: &events, committed: &committed}
	second := &testTxCapability{name: "test.second", applyErr: applyErr, events: &events, committed: &committed}
	registry := mustRegistry(t, first, second)

	result := Apply(context.Background(), registry, Plan{
		{Capability: "test.first", Request: testRequest{Value: "one"}},
		{Capability: "test.second", Request: testRequest{Value: "two"}},
	}, passingHealth)

	if !result.WasRolledBack() {
		t.Fatalf("Outcome = %q, want rolledBack", result.Outcome)
	}
	if len(result.RollbackErrors) != 1 {
		t.Fatalf("RollbackErrors = %v, want one", result.RollbackErrors)
	}
	rollbackErr := result.RollbackErrors[0]
	if rollbackErr.Index != 0 || rollbackErr.Capability != "test.first" {
		t.Fatalf("RollbackErrors[0] = %#v, want first operation", rollbackErr)
	}
	if !errors.Is(rollbackErr, undoErr) {
		t.Fatalf("RollbackErrors[0] = %v, want to wrap undo error", rollbackErr)
	}
	if len(result.RolledBack) != 0 {
		t.Fatalf("RolledBack = %v, want none when undo fails", result.RolledBack)
	}
	wantEvents := []string{"apply:one", "apply:two", "undo:one"}
	if !reflect.DeepEqual(events, wantEvents) {
		t.Fatalf("events = %v, want %v", events, wantEvents)
	}
	if !committed["one"] {
		t.Fatalf("committed = %v, want failed undo to leave evidence for reviewer", committed)
	}
}

func mustRegistry(t *testing.T, registered ...capabilities.Capability) *capabilities.Registry {
	t.Helper()

	registry, err := capabilities.NewRegistry(registered...)
	if err != nil {
		t.Fatalf("NewRegistry returned error: %v", err)
	}
	return registry
}

func passingHealth(context.Context) error {
	return nil
}
