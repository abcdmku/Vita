package timesync

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
	disabledConfig      = NewConfig(false, []string{})
	enabledConfig       = NewConfig(true, []string{"time.cloudflare.com", "2001:db8::1"})
	errSimulatedWrite   = errors.New("simulated write failure")
	errSimulatedApply   = errors.New("simulated apply failure")
	errSimulatedHealth  = errors.New("simulated health failure")
	canonicalDisabled   = []byte("{\"enabled\":false,\"servers\":[]}\n")
	canonicalEnabled    = []byte("{\"enabled\":true,\"servers\":[\"time.cloudflare.com\",\"2001:db8::1\"]}\n")
	nonCanonicalEnabled = []byte("{\"servers\":[\"Time.Cloudflare.Com\",\"2001:0db8::1\"],\"enabled\":true}\n")
)

func TestHandleReadsCurrentConfigAsCanonicalBytes(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(nonCanonicalEnabled)
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
	if !reflect.DeepEqual(readResponse.Config, enabledConfig) {
		t.Fatalf("ReadResponse.Config = %#v, want %#v", readResponse.Config, enabledConfig)
	}
	if !reflect.DeepEqual(readResponse.Raw, canonicalEnabled) {
		t.Fatalf("ReadResponse.Raw = %q, want canonical %q", readResponse.Raw, canonicalEnabled)
	}
}

func TestApplyWritesCanonicalConfigAndUndoRestoresExactPriorBytes(t *testing.T) {
	ctx := context.Background()
	prior := []byte("{\"servers\":[],\"enabled\":false}\n")
	fs := newMemoryFileSystem(prior)
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: &enabledConfig})
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo")
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, canonicalEnabled) {
		t.Fatalf("live config after Apply = %q, want %q", got, canonicalEnabled)
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

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: &enabledConfig})
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

func TestTransactionApplyCommitsTimeSyncConfigWhenHealthPasses(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(canonicalDisabled)
	timeSyncCapability := newCapability(fs)
	registry := mustRegistry(t, timeSyncCapability)

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: ApplyRequest{Desired: &enabledConfig}},
	}, func(context.Context) error {
		return nil
	})

	if !result.Committed() {
		t.Fatalf("Outcome = %q, want committed; err=%v", result.Outcome, result.Err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, canonicalEnabled) {
		t.Fatalf("live config = %q, want desired config %q", got, canonicalEnabled)
	}
	if len(result.RolledBack) != 0 {
		t.Fatalf("RolledBack = %v, want none", result.RolledBack)
	}
}

func TestTransactionApplyRollsBackTimeSyncConfigWhenLaterOperationFails(t *testing.T) {
	ctx := context.Background()
	prior := []byte("{\"servers\":[],\"enabled\":false}\n")
	fs := newMemoryFileSystem(prior)
	timeSyncCapability := newCapability(fs)
	registry := mustRegistry(t, timeSyncCapability, failingTxCapability{name: "test.later"})

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: ApplyRequest{Desired: &enabledConfig}},
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

func TestTransactionApplyRollsBackTimeSyncConfigWhenHealthFails(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(canonicalDisabled)
	timeSyncCapability := newCapability(fs)
	registry := mustRegistry(t, timeSyncCapability)

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: ApplyRequest{Desired: &enabledConfig}},
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
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, canonicalDisabled) {
		t.Fatalf("live config after health rollback = %q, want %q", got, canonicalDisabled)
	}
}

func TestApplyRejectsInvalidRequestWithoutWriting(t *testing.T) {
	ctx := context.Background()
	tooManyServers := NewConfig(true, []string{
		"0.pool.ntp.org",
		"1.pool.ntp.org",
		"2.pool.ntp.org",
		"3.pool.ntp.org",
		"4.pool.ntp.org",
		"5.pool.ntp.org",
		"6.pool.ntp.org",
		"7.pool.ntp.org",
		"8.pool.ntp.org",
	})

	tests := []struct {
		name string
		req  capabilities.TypedRequest
	}{
		{
			name: "wrong request type cannot smuggle path",
			req:  pathSmugglingRequest{Path: "/tmp/attacker", Desired: enabledConfig},
		},
		{
			name: "malformed URL server",
			req:  ApplyRequest{Desired: configPointer(NewConfig(true, []string{"https://pool.ntp.org"}))},
		},
		{
			name: "scheme server",
			req:  ApplyRequest{Desired: configPointer(NewConfig(true, []string{"ntp:pool.ntp.org"}))},
		},
		{
			name: "bad hostname",
			req:  ApplyRequest{Desired: configPointer(NewConfig(true, []string{"bad_host"}))},
		},
		{
			name: "inline content server",
			req:  ApplyRequest{Desired: configPointer(NewConfig(true, []string{"-----BEGIN PRIVATE KEY-----"}))},
		},
		{
			name: "enabled with zero servers",
			req:  ApplyRequest{Desired: configPointer(NewConfig(true, nil))},
		},
		{
			name: "enabled with too many servers",
			req:  ApplyRequest{Desired: &tooManyServers},
		},
		{
			name: "disabled with servers",
			req:  ApplyRequest{Desired: configPointer(NewConfig(false, []string{"pool.ntp.org"}))},
		},
		{
			name: "duplicate servers after hostname normalization",
			req:  ApplyRequest{Desired: configPointer(NewConfig(true, []string{"Pool.NTP.Org", "pool.ntp.org"}))},
		},
		{
			name: "absent enabled in typed config",
			req:  ApplyRequest{Desired: &Config{Servers: []string{"pool.ntp.org"}}},
		},
		{
			name: "missing desired",
			req:  ApplyRequest{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fs := newMemoryFileSystem(canonicalDisabled)
			capability := newCapability(fs)

			undo, err := capability.Apply(ctx, tt.req)
			if undo != nil {
				t.Fatalf("Apply returned undo %v, want nil", undo)
			}
			var invalid *InvalidRequestError
			if !errors.As(err, &invalid) {
				t.Fatalf("Apply error = %T %v, want InvalidRequestError", err, err)
			}
			if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, canonicalDisabled) {
				t.Fatalf("live config = %q, want unchanged %q", got, canonicalDisabled)
			}
		})
	}
}

func TestJSONRejectsAbsentEnabledAndDuplicateKeys(t *testing.T) {
	tests := []struct {
		name string
		raw  string
	}{
		{
			name: "absent enabled",
			raw:  `{"desired":{"servers":["pool.ntp.org"]}}`,
		},
		{
			name: "absent servers",
			raw:  `{"desired":{"enabled":false}}`,
		},
		{
			name: "duplicate top-level desired",
			raw:  `{"desired":{"enabled":false,"servers":[]},"desired":{"enabled":true,"servers":["pool.ntp.org"]}}`,
		},
		{
			name: "duplicate nested enabled",
			raw:  `{"desired":{"enabled":false,"enabled":true,"servers":["pool.ntp.org"]}}`,
		},
		{
			name: "duplicate nested servers",
			raw:  `{"desired":{"enabled":true,"servers":[],"servers":["pool.ntp.org"]}}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var req ApplyRequest
			err := json.Unmarshal([]byte(tt.raw), &req)
			if err == nil {
				t.Fatal("Unmarshal returned nil, want rejection")
			}
			if !strings.Contains(err.Error(), "enabled is required") &&
				!strings.Contains(err.Error(), "servers is required") &&
				!strings.Contains(err.Error(), "duplicate JSON object key") {
				t.Fatalf("Unmarshal error = %v, want absent-field or duplicate-key rejection", err)
			}
		})
	}
}

func TestParseConfigRejectsDuplicateJSONKeys(t *testing.T) {
	raw := []byte(`{"enabled":false,"enabled":true,"servers":["pool.ntp.org"]}`)

	_, err := parseConfig(raw)
	if err == nil {
		t.Fatal("parseConfig returned nil error, want duplicate-key rejection")
	}
	if !strings.Contains(err.Error(), "duplicate JSON object key") {
		t.Fatalf("parseConfig error = %v, want duplicate-key rejection", err)
	}
}

func TestAtomicWriteFailureLeavesLiveFileUnchanged(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(canonicalDisabled)
	fs.failNextAtomicWriteBeforeCommit = true
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: &enabledConfig})
	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil on failed write", undo)
	}
	if !errors.Is(err, errSimulatedWrite) {
		t.Fatalf("Apply error = %v, want simulated write failure", err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, canonicalDisabled) {
		t.Fatalf("live config after failed atomic write = %q, want unchanged %q", got, canonicalDisabled)
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
	fs := newMemoryFileSystem(canonicalDisabled)
	fs.failNextAtomicWriteAtCommitPoint = true
	timeSyncCapability := newCapability(fs)
	registry := mustRegistry(t, timeSyncCapability, failingTxCapability{name: "test.later"})

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: ApplyRequest{Desired: &enabledConfig}},
		{Capability: "test.later", Request: testRequest{}},
	}, func(context.Context) error {
		return nil
	})

	if !fs.observedCommitPointFailure {
		t.Fatal("test did not inject an observation at the atomic commit point")
	}
	if !result.WasRolledBack() {
		t.Fatalf("Outcome = %q, want rolledBack; err=%v", result.Outcome, result.Err)
	}
	wantApplied := []transaction.AppliedOperation{{Index: 0, Capability: Name}}
	if !reflect.DeepEqual(result.Applied, wantApplied) {
		t.Fatalf("Applied = %v, want %v", result.Applied, wantApplied)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, canonicalDisabled) {
		t.Fatalf("live config after rollback = %q, want %q", got, canonicalDisabled)
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
	exists                           bool
	live                             []byte
	temp                             []byte
	failNextAtomicWriteBeforeCommit  bool
	failNextAtomicWriteAtCommitPoint bool
	observedCommitPointFailure       bool
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
	if fs.failNextAtomicWriteBeforeCommit {
		fs.failNextAtomicWriteBeforeCommit = false
		return errSimulatedWrite
	}

	fs.live = cloneBytes(content)
	fs.exists = true
	fs.temp = nil
	if fs.failNextAtomicWriteAtCommitPoint {
		fs.failNextAtomicWriteAtCommitPoint = false
		fs.observedCommitPointFailure = true
	}
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

func configPointer(config Config) *Config {
	return &config
}
