package backup

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
	errSimulatedWrite = errors.New("simulated write failure")
	errSimulatedApply = errors.New("simulated apply failure")
)

func TestApplyReturnsUndoRestoringExactPriorBytes(t *testing.T) {
	ctx := context.Background()
	prior := mustRenderPolicy(t, validPolicy())
	fs := newMemoryFileSystem(prior)
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, applyPolicy(alternatePolicy()))
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo")
	}

	wantApplied := mustRenderPolicy(t, alternatePolicy())
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, wantApplied) {
		t.Fatalf("live backup policy after Apply = %q, want %q", got, wantApplied)
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live backup policy after Undo = %q, want exact prior bytes %q", got, prior)
	}
}

func TestApplyUndoRestoresAbsentPriorPolicy(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(nil)
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, applyPolicy(validPolicy()))
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if !fs.exists {
		t.Fatal("Apply did not create live backup policy")
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if fs.exists {
		t.Fatalf("Undo left live backup policy %q, want absent", fs.live)
	}
}

func TestHandleReadsCurrentPolicyAndReturnsCanonicalRaw(t *testing.T) {
	ctx := context.Background()
	raw := []byte(`{
  "recoveryKeyRef": {"keyStoreRef":"keystore:local-tpm","handle":"rk_handle_owner_primary","id":"rk:owner-primary"},
  "retention": {"maxAgeDays":30,"count":7},
  "targets": [{"id":"target:system-state"},{"id":"target:user-data"}],
  "schedule": {"cron":"0 2 * * *"}
}`)
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
	if !reflect.DeepEqual(readResponse.Policy, validPolicy()) {
		t.Fatalf("ReadResponse.Policy = %#v, want %#v", readResponse.Policy, validPolicy())
	}
	canonical := mustRenderPolicy(t, validPolicy())
	if !reflect.DeepEqual(readResponse.Raw, canonical) {
		t.Fatalf("ReadResponse.Raw = %q, want canonical %q", readResponse.Raw, canonical)
	}
	if reflect.DeepEqual(readResponse.Raw, raw) {
		t.Fatal("Handle returned original raw JSON, want canonical validated JSON")
	}
}

func TestApplyPersistsCanonicalPolicyNotDecodedRaw(t *testing.T) {
	ctx := context.Background()
	prior := mustRenderPolicy(t, validPolicy())
	raw := []byte(`{
  "desired": {
    "recoveryKeyRef": {"handle":"rk_handle_owner_primary","id":"rk:owner-primary","keyStoreRef":"keystore:local-tpm"},
    "retention": {"maxAgeDays":30,"count":7},
    "targets": [{"id":"target:system-state"},{"id":"target:user-data"}],
    "schedule": {"cron":"0 2 * * *"}
  }
}`)

	var req ApplyRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		t.Fatalf("Unmarshal returned error: %v", err)
	}
	fs := newMemoryFileSystem(prior)
	capability := newCapability(fs)

	if _, err := capability.Apply(ctx, req); err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if got, want := fs.mustLiveBytes(t), mustRenderPolicy(t, validPolicy()); !reflect.DeepEqual(got, want) {
		t.Fatalf("live backup policy = %q, want canonical %q", got, want)
	}
	if reflect.DeepEqual(fs.mustLiveBytes(t), raw) {
		t.Fatal("Apply persisted decoded request raw bytes, want canonical policy only")
	}
}

func TestTransactionApplyCommitsBackupPolicyWhenHealthPasses(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(mustRenderPolicy(t, validPolicy()))
	backupCapability := newCapability(fs)
	registry := mustRegistry(t, backupCapability)

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: applyPolicy(alternatePolicy())},
	}, func(context.Context) error {
		return nil
	})

	if !result.Committed() {
		t.Fatalf("Outcome = %q, want committed; err=%v", result.Outcome, result.Err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, mustRenderPolicy(t, alternatePolicy())) {
		t.Fatalf("live backup policy = %q, want desired policy", got)
	}
	if len(result.RolledBack) != 0 {
		t.Fatalf("RolledBack = %v, want none", result.RolledBack)
	}
}

func TestTransactionApplyRollsBackBackupPolicyWhenLaterOperationFails(t *testing.T) {
	ctx := context.Background()
	prior := mustRenderPolicy(t, validPolicy())
	fs := newMemoryFileSystem(prior)
	backupCapability := newCapability(fs)
	registry := mustRegistry(t, backupCapability, failingTxCapability{name: "test.later"})

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: applyPolicy(alternatePolicy())},
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
		t.Fatalf("live backup policy after rollback = %q, want exact prior bytes %q", got, prior)
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
	prior := mustRenderPolicy(t, validPolicy())
	fs := newMemoryFileSystem(prior)
	fs.failNextAtomicWriteBeforeCommit = true
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, applyPolicy(alternatePolicy()))
	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil on failed write", undo)
	}
	if !errors.Is(err, errSimulatedWrite) {
		t.Fatalf("Apply error = %v, want simulated write failure", err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live backup policy after failed atomic write = %q, want unchanged %q", got, prior)
	}
	if fs.temp == nil {
		t.Fatal("simulated atomic write did not stage a temp file")
	}
	if reflect.DeepEqual(fs.temp, fs.live) {
		t.Fatal("test did not simulate a partial temp distinct from the live file")
	}
}

func TestAfterCommitFailureAttemptStillReturnsTrackedUndo(t *testing.T) {
	ctx := context.Background()
	prior := mustRenderPolicy(t, validPolicy())
	fs := newMemoryFileSystem(prior)
	fs.tryErrorAfterCommit = true
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, applyPolicy(alternatePolicy()))
	if err != nil {
		t.Fatalf("Apply returned error after commit attempt: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo after commit attempt")
	}
	if !fs.observedErrorAfterCommitAttempt {
		t.Fatal("test did not exercise the after-commit failure injection")
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, mustRenderPolicy(t, alternatePolicy())) {
		t.Fatalf("live backup policy after commit = %q, want desired policy", got)
	}
	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live backup policy after Undo = %q, want exact prior bytes %q", got, prior)
	}
}

func TestApplyRejectsInvalidPolicyWithoutWriting(t *testing.T) {
	ctx := context.Background()
	prior := mustRenderPolicy(t, validPolicy())
	zero := int64(0)
	tooMany := int64(1001)
	tooOld := int64(3651)
	one := int64(1)
	pemBlock := "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----"

	tests := []struct {
		name string
		req  capabilities.TypedRequest
	}{
		{
			name: "wrong request type cannot smuggle path",
			req:  pathSmugglingRequest{Path: "/tmp/attacker", Desired: alternatePolicy()},
		},
		{
			name: "missing desired",
			req:  ApplyRequest{},
		},
		{
			name: "missing schedule",
			req:  applyPolicy(policyWithSchedule(Schedule{})),
		},
		{
			name: "malformed cron schedule",
			req:  applyPolicy(policyWithSchedule(Schedule{Cron: stringPtr("not cron")})),
		},
		{
			name: "zero interval schedule",
			req:  applyPolicy(policyWithSchedule(Schedule{IntervalSeconds: &zero})),
		},
		{
			name: "empty targets",
			req:  applyPolicy(policyWithTargets([]TargetRef{})),
		},
		{
			name: "missing target id",
			req:  applyPolicy(policyWithTargets([]TargetRef{{ID: ""}})),
		},
		{
			name: "missing retention count",
			req:  applyPolicy(policyWithRetention(Retention{MaxAgeDays: &one})),
		},
		{
			name: "zero retention count",
			req:  applyPolicy(policyWithRetention(Retention{Count: &zero, MaxAgeDays: &one})),
		},
		{
			name: "retention count too high",
			req:  applyPolicy(policyWithRetention(Retention{Count: &tooMany, MaxAgeDays: &one})),
		},
		{
			name: "missing retention max age",
			req:  applyPolicy(policyWithRetention(Retention{Count: &one})),
		},
		{
			name: "zero retention max age",
			req:  applyPolicy(policyWithRetention(Retention{Count: &one, MaxAgeDays: &zero})),
		},
		{
			name: "retention max age too high",
			req:  applyPolicy(policyWithRetention(Retention{Count: &one, MaxAgeDays: &tooOld})),
		},
		{
			name: "missing recovery key id",
			req:  applyPolicy(policyWithRecoveryKeyRef(RecoveryKeyRef{Handle: "rk_handle_owner_primary"})),
		},
		{
			name: "missing recovery key handle",
			req:  applyPolicy(policyWithRecoveryKeyRef(RecoveryKeyRef{ID: "rk:owner-primary"})),
		},
		{
			name: "inline recovery key material",
			req:  applyPolicy(policyWithRecoveryKeyRef(RecoveryKeyRef{ID: "rk:owner-primary", Handle: pemBlock})),
		},
		{
			name: "inline recovery key reference scheme",
			req:  applyPolicy(policyWithRecoveryKeyRef(RecoveryKeyRef{ID: "data:owner-primary", Handle: "rk_handle_owner_primary"})),
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
				t.Fatalf("live backup policy = %q, want unchanged %q", got, prior)
			}
		})
	}
}

func TestValidateDistinguishesExplicitZeroRetentionFromAbsent(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		wantErr bool
	}{
		{
			name:    "valid retention",
			raw:     `{"desired":{"schedule":{"cron":"0 2 * * *"},"targets":[{"id":"target:system-state"}],"retention":{"count":7,"maxAgeDays":30},"recoveryKeyRef":{"id":"rk:owner-primary","handle":"rk_handle_owner_primary"}}}`,
			wantErr: false,
		},
		{
			name:    "explicit zero count rejects",
			raw:     `{"desired":{"schedule":{"cron":"0 2 * * *"},"targets":[{"id":"target:system-state"}],"retention":{"count":0,"maxAgeDays":30},"recoveryKeyRef":{"id":"rk:owner-primary","handle":"rk_handle_owner_primary"}}}`,
			wantErr: true,
		},
		{
			name:    "explicit zero max age rejects",
			raw:     `{"desired":{"schedule":{"cron":"0 2 * * *"},"targets":[{"id":"target:system-state"}],"retention":{"count":7,"maxAgeDays":0},"recoveryKeyRef":{"id":"rk:owner-primary","handle":"rk_handle_owner_primary"}}}`,
			wantErr: true,
		},
		{
			name:    "absent count rejects",
			raw:     `{"desired":{"schedule":{"cron":"0 2 * * *"},"targets":[{"id":"target:system-state"}],"retention":{"maxAgeDays":30},"recoveryKeyRef":{"id":"rk:owner-primary","handle":"rk_handle_owner_primary"}}}`,
			wantErr: true,
		},
		{
			name:    "absent max age rejects",
			raw:     `{"desired":{"schedule":{"cron":"0 2 * * *"},"targets":[{"id":"target:system-state"}],"retention":{"count":7},"recoveryKeyRef":{"id":"rk:owner-primary","handle":"rk_handle_owner_primary"}}}`,
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

func TestDuplicateJSONKeysAreRejectedBeforeDecode(t *testing.T) {
	tests := []struct {
		name string
		raw  string
	}{
		{
			name: "duplicate top-level desired",
			raw:  `{"desired":{"schedule":{"cron":"0 2 * * *"},"targets":[{"id":"target:system-state"}],"retention":{"count":7,"maxAgeDays":30},"recoveryKeyRef":{"id":"rk:owner-primary","handle":"rk_handle_owner_primary"}},"desired":{"schedule":{"cron":"0 3 * * *"},"targets":[{"id":"target:user-data"}],"retention":{"count":8,"maxAgeDays":31},"recoveryKeyRef":{"id":"rk:owner-secondary","handle":"rk_handle_owner_secondary"}}}`,
		},
		{
			name: "duplicate retention smuggles explicit zero",
			raw:  `{"desired":{"schedule":{"cron":"0 2 * * *"},"targets":[{"id":"target:system-state"}],"retention":{"count":0,"count":7,"maxAgeDays":30},"recoveryKeyRef":{"id":"rk:owner-primary","handle":"rk_handle_owner_primary"}}}`,
		},
		{
			name: "duplicate recovery id smuggles PEM",
			raw:  `{"desired":{"schedule":{"cron":"0 2 * * *"},"targets":[{"id":"target:system-state"}],"retention":{"count":7,"maxAgeDays":30},"recoveryKeyRef":{"id":"-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----","id":"rk:owner-primary","handle":"rk_handle_owner_primary"}}}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var req ApplyRequest
			err := json.Unmarshal([]byte(tt.raw), &req)
			if err == nil {
				t.Fatal("Unmarshal returned nil, want duplicate-key error")
			}
			if !strings.Contains(err.Error(), "duplicate JSON object key") {
				t.Fatalf("Unmarshal error = %v, want duplicate-key rejection", err)
			}
		})
	}
}

func TestParseRejectsDuplicateKeysInStoredPolicy(t *testing.T) {
	raw := []byte(`{"schedule":{"cron":"0 2 * * *"},"targets":[{"id":"target:system-state"}],"retention":{"count":7,"maxAgeDays":30},"recoveryKeyRef":{"id":"-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----","id":"rk:owner-primary","handle":"rk_handle_owner_primary"}}`)

	if _, err := parsePolicy(raw); err == nil {
		t.Fatal("parsePolicy returned nil error, want duplicate-key rejection")
	} else if !strings.Contains(err.Error(), "duplicate JSON object key") {
		t.Fatalf("parsePolicy error = %v, want duplicate-key rejection", err)
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
		t.Fatal("live backup policy does not exist")
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

func validPolicy() Policy {
	return Policy{
		Schedule: Schedule{Cron: stringPtr("0 2 * * *")},
		Targets: []TargetRef{
			{ID: "target:system-state"},
			{ID: "target:user-data"},
		},
		Retention: Retention{
			Count:      int64Ptr(7),
			MaxAgeDays: int64Ptr(30),
		},
		RecoveryKeyRef: RecoveryKeyRef{
			ID:          "rk:owner-primary",
			Handle:      "rk_handle_owner_primary",
			KeyStoreRef: stringPtr("keystore:local-tpm"),
		},
	}
}

func alternatePolicy() Policy {
	return Policy{
		Schedule: Schedule{IntervalSeconds: int64Ptr(3600)},
		Targets: []TargetRef{
			{ID: "target:user-data"},
		},
		Retention: Retention{
			Count:      int64Ptr(14),
			MaxAgeDays: int64Ptr(90),
		},
		RecoveryKeyRef: RecoveryKeyRef{
			ID:     "rk:owner-secondary",
			Handle: "rk_handle_owner_secondary",
		},
	}
}

func policyWithSchedule(schedule Schedule) Policy {
	policy := validPolicy()
	policy.Schedule = schedule
	return policy
}

func policyWithTargets(targets []TargetRef) Policy {
	policy := validPolicy()
	policy.Targets = targets
	return policy
}

func policyWithRetention(retention Retention) Policy {
	policy := validPolicy()
	policy.Retention = retention
	return policy
}

func policyWithRecoveryKeyRef(ref RecoveryKeyRef) Policy {
	policy := validPolicy()
	policy.RecoveryKeyRef = ref
	return policy
}

func applyPolicy(policy Policy) ApplyRequest {
	desired := clonePolicy(policy)
	return ApplyRequest{Desired: &desired}
}

func stringPtr(value string) *string {
	return &value
}

func int64Ptr(value int64) *int64 {
	return &value
}

func mustRenderPolicy(t *testing.T, policy Policy) []byte {
	t.Helper()
	rendered, err := renderPolicy(policy)
	if err != nil {
		t.Fatalf("renderPolicy returned error: %v", err)
	}
	return rendered
}

func mustRegistry(t *testing.T, registered ...capabilities.Capability) *capabilities.Registry {
	t.Helper()

	registry, err := capabilities.NewRegistry(registered...)
	if err != nil {
		t.Fatalf("NewRegistry returned error: %v", err)
	}
	return registry
}
