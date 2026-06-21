package services

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/transaction"
)

var (
	disabledSSHConfig       = NewConfig([]ServiceEntry{NewServiceEntry("ssh.service", false)})
	enabledMixedConfig      = NewConfig([]ServiceEntry{NewServiceEntry("ssh.service", true), NewServiceEntry("dbus.socket", false)})
	emptyServicesConfig     = NewConfig([]ServiceEntry{})
	errSimulatedWrite       = errors.New("simulated write failure")
	errSimulatedApply       = errors.New("simulated apply failure")
	canonicalDisabledSSH    = []byte("{\"services\":[{\"name\":\"ssh.service\",\"enabled\":false}]}\n")
	canonicalEnabledMixed   = []byte("{\"services\":[{\"name\":\"ssh.service\",\"enabled\":true},{\"name\":\"dbus.socket\",\"enabled\":false}]}\n")
	canonicalEmptyServices  = []byte("{\"services\":[]}\n")
	nonCanonicalEnabledRaw  = []byte("{\"services\":[{\"enabled\":true,\"name\":\"ssh.service\"},{\"enabled\":false,\"name\":\"dbus.socket\"}]}\n")
	predictableTempContents = []byte("attacker-controlled temp target\n")
)

func TestHandleReadsCurrentConfigAsCanonicalBytes(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(nonCanonicalEnabledRaw)
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
	if !reflect.DeepEqual(readResponse.Config, enabledMixedConfig) {
		t.Fatalf("ReadResponse.Config = %#v, want %#v", readResponse.Config, enabledMixedConfig)
	}
	if !reflect.DeepEqual(readResponse.Raw, canonicalEnabledMixed) {
		t.Fatalf("ReadResponse.Raw = %q, want canonical %q", readResponse.Raw, canonicalEnabledMixed)
	}
}

func TestApplyWritesCanonicalConfigAndUndoRestoresExactPriorBytes(t *testing.T) {
	ctx := context.Background()
	prior := []byte("{\"services\":[{\"enabled\":false,\"name\":\"ssh.service\"}]}\n")
	fs := newMemoryFileSystem(prior)
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: &enabledMixedConfig})
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo")
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, canonicalEnabledMixed) {
		t.Fatalf("live config after Apply = %q, want %q", got, canonicalEnabledMixed)
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

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: &enabledMixedConfig})
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

func TestTransactionApplyCommitsServicesConfigWhenHealthPasses(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(canonicalDisabledSSH)
	servicesCapability := newCapability(fs)
	registry := mustRegistry(t, servicesCapability)

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: ApplyRequest{Desired: &enabledMixedConfig}},
	}, func(context.Context) error {
		return nil
	})

	if !result.Committed() {
		t.Fatalf("Outcome = %q, want committed; err=%v", result.Outcome, result.Err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, canonicalEnabledMixed) {
		t.Fatalf("live config = %q, want desired config %q", got, canonicalEnabledMixed)
	}
	if len(result.RolledBack) != 0 {
		t.Fatalf("RolledBack = %v, want none", result.RolledBack)
	}
}

func TestTransactionApplyRollsBackServicesConfigWhenLaterOperationFails(t *testing.T) {
	ctx := context.Background()
	prior := []byte("{\"services\":[{\"enabled\":false,\"name\":\"ssh.service\"}]}\n")
	fs := newMemoryFileSystem(prior)
	servicesCapability := newCapability(fs)
	registry := mustRegistry(t, servicesCapability, failingTxCapability{name: "test.later"})

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: ApplyRequest{Desired: &enabledMixedConfig}},
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

func TestApplyRejectsInvalidRequestWithoutWriting(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name string
		req  capabilities.TypedRequest
	}{
		{
			name: "wrong request type cannot smuggle path",
			req:  pathSmugglingRequest{Path: "/tmp/attacker", Desired: enabledMixedConfig},
		},
		{
			name: "missing desired",
			req:  ApplyRequest{},
		},
		{
			name: "missing services",
			req:  ApplyRequest{Desired: &Config{}},
		},
		{
			name: "nil services",
			req:  ApplyRequest{Desired: configWithNilServices()},
		},
		{
			name: "path separator",
			req:  applyConfig(configWithEntry(NewServiceEntry("ssh/service.service", true))),
		},
		{
			name: "windows path separator",
			req:  applyConfig(configWithEntry(NewServiceEntry(`ssh\service.service`, true))),
		},
		{
			name: "dot dot",
			req:  applyConfig(configWithEntry(NewServiceEntry("ssh..service", true))),
		},
		{
			name: "whitespace",
			req:  applyConfig(configWithEntry(NewServiceEntry("ssh service.service", true))),
		},
		{
			name: "bad charset",
			req:  applyConfig(configWithEntry(NewServiceEntry("ssh%.service", true))),
		},
		{
			name: "inline reference",
			req:  applyConfig(configWithEntry(NewServiceEntry("data:secret.service", true))),
		},
		{
			name: "inline material",
			req:  applyConfig(configWithEntry(NewServiceEntry("private-key.service", true))),
		},
		{
			name: "bare dot",
			req:  applyConfig(configWithEntry(NewServiceEntry(".", true))),
		},
		{
			name: "empty prefix",
			req:  applyConfig(configWithEntry(NewServiceEntry(".service", true))),
		},
		{
			name: "missing suffix",
			req:  applyConfig(configWithEntry(NewServiceEntry("ssh", true))),
		},
		{
			name: "absent enabled in typed config",
			req:  applyConfig(configWithEntry(ServiceEntry{Name: "ssh.service"})),
		},
		{
			name: "duplicate service name",
			req: NewConfig([]ServiceEntry{
				NewServiceEntry("ssh.service", true),
				NewServiceEntry("ssh.service", false),
			}).applyRequest(),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fs := newMemoryFileSystem(canonicalDisabledSSH)
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
			if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, canonicalDisabledSSH) {
				t.Fatalf("live config = %q, want unchanged %q", got, canonicalDisabledSSH)
			}
		})
	}
}

func TestValidateAcceptsRecognizedSystemdUnitSuffix(t *testing.T) {
	if err := NewConfig([]ServiceEntry{NewServiceEntry("ssh.service", true)}).Validate(); err != nil {
		t.Fatalf("Validate returned error for ssh.service: %v", err)
	}
}

func TestJSONRejectsAbsentEnabledAbsentServicesAndDuplicateKeys(t *testing.T) {
	tests := []struct {
		name string
		raw  string
	}{
		{
			name: "absent enabled",
			raw:  `{"desired":{"services":[{"name":"ssh.service"}]}}`,
		},
		{
			name: "absent services",
			raw:  `{"desired":{}}`,
		},
		{
			name: "null services",
			raw:  `{"desired":{"services":null}}`,
		},
		{
			name: "duplicate top-level desired",
			raw:  `{"desired":{"services":[]},"desired":{"services":[{"name":"ssh.service","enabled":true}]}}`,
		},
		{
			name: "duplicate nested services",
			raw:  `{"desired":{"services":[],"services":[{"name":"ssh.service","enabled":true}]}}`,
		},
		{
			name: "duplicate service entry name",
			raw:  `{"desired":{"services":[{"name":"dbus.socket","name":"ssh.service","enabled":true}]}}`,
		},
		{
			name: "duplicate service entry enabled",
			raw:  `{"desired":{"services":[{"name":"ssh.service","enabled":false,"enabled":true}]}}`,
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
				!strings.Contains(err.Error(), "services is required") &&
				!strings.Contains(err.Error(), "services must be a list") &&
				!strings.Contains(err.Error(), "duplicate JSON object key") {
				t.Fatalf("Unmarshal error = %v, want absent-field or duplicate-key rejection", err)
			}
		})
	}
}

func TestApplyAcceptsExplicitEmptyServicesList(t *testing.T) {
	ctx := context.Background()
	var req ApplyRequest
	if err := json.Unmarshal([]byte(`{"desired":{"services":[]}}`), &req); err != nil {
		t.Fatalf("Unmarshal returned error for explicit empty services: %v", err)
	}
	if err := req.Validate(); err != nil {
		t.Fatalf("Validate returned error for explicit empty services: %v", err)
	}

	fs := newMemoryFileSystem(canonicalDisabledSSH)
	capability := newCapability(fs)
	undo, err := capability.Apply(ctx, ApplyRequest{Desired: &emptyServicesConfig})
	if err != nil {
		t.Fatalf("Apply returned error for explicit empty services: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo")
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, canonicalEmptyServices) {
		t.Fatalf("live config after Apply = %q, want %q", got, canonicalEmptyServices)
	}
}

func TestParseConfigRejectsDuplicateJSONKeys(t *testing.T) {
	raw := []byte(`{"services":[{"name":"ssh.service","enabled":false,"enabled":true}]}`)

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
	fs := newMemoryFileSystem(canonicalDisabledSSH)
	fs.failNextAtomicWriteBeforeCommit = true
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: &enabledMixedConfig})
	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil on failed write", undo)
	}
	if !errors.Is(err, errSimulatedWrite) {
		t.Fatalf("Apply error = %v, want simulated write failure", err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, canonicalDisabledSSH) {
		t.Fatalf("live config after failed atomic write = %q, want unchanged %q", got, canonicalDisabledSSH)
	}
}

func TestAtomicWriteErrorAfterEffectRestoresPriorState(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(canonicalDisabledSSH)
	fs.failNextAtomicWriteAfterEffect = true
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: &enabledMixedConfig})
	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil on reported write failure", undo)
	}
	if !errors.Is(err, errSimulatedWrite) {
		t.Fatalf("Apply error = %v, want simulated write failure", err)
	}
	if !fs.observedAfterEffectFailure {
		t.Fatal("test did not inject a failure after the atomic write effect")
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, canonicalDisabledSSH) {
		t.Fatalf("live config after after-effect failure = %q, want unchanged %q", got, canonicalDisabledSSH)
	}
}

func TestDefaultAtomicWriteDoesNotFollowPredictableTempSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink regression is exercised in the Linux acceptance container")
	}

	ctx := context.Background()
	dir := t.TempDir()
	fs := defaultFileSystem{
		stateRoot: dir,
		path:      filepath.Join(dir, defaultConfigFilename),
	}

	if err := os.WriteFile(fs.path, canonicalDisabledSSH, configFileMode); err != nil {
		t.Fatalf("seed live config: %v", err)
	}
	attackerPath := filepath.Join(dir, "attacker-target")
	if err := os.WriteFile(attackerPath, predictableTempContents, configFileMode); err != nil {
		t.Fatalf("seed attacker target: %v", err)
	}
	predictableTemp := fs.path + ".tmp"
	if err := os.Symlink(attackerPath, predictableTemp); err != nil {
		t.Fatalf("create predictable temp symlink: %v", err)
	}

	if err := fs.AtomicWrite(ctx, canonicalEnabledMixed); err != nil {
		t.Fatalf("AtomicWrite returned error: %v", err)
	}
	if got, err := os.ReadFile(fs.path); err != nil {
		t.Fatalf("read live config: %v", err)
	} else if !reflect.DeepEqual(got, canonicalEnabledMixed) {
		t.Fatalf("live config = %q, want %q", got, canonicalEnabledMixed)
	}
	if got, err := os.ReadFile(attackerPath); err != nil {
		t.Fatalf("read attacker target: %v", err)
	} else if !reflect.DeepEqual(got, predictableTempContents) {
		t.Fatalf("attacker target = %q, want unchanged %q", got, predictableTempContents)
	}
	if info, err := os.Lstat(predictableTemp); err != nil {
		t.Fatalf("lstat predictable temp symlink: %v", err)
	} else if info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("predictable temp path mode = %v, want symlink still present", info.Mode())
	}
}

type memoryFileSystem struct {
	exists                          bool
	live                            []byte
	temp                            []byte
	atomicWrites                    int
	failNextAtomicWriteBeforeCommit bool
	failNextAtomicWriteAfterEffect  bool
	observedAfterEffectFailure      bool
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
	if fs.failNextAtomicWriteAfterEffect {
		fs.failNextAtomicWriteAfterEffect = false
		fs.observedAfterEffectFailure = true
		return errSimulatedWrite
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
	fs.exists = true
	fs.live = cloneBytes(snapshot.bytes)
	return nil
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

func configWithEntry(entry ServiceEntry) Config {
	return NewConfig([]ServiceEntry{entry})
}

func configWithNilServices() *Config {
	var nilServices []ServiceEntry
	return &Config{Services: &nilServices}
}

func applyConfig(config Config) ApplyRequest {
	desired := cloneConfig(config)
	return ApplyRequest{Desired: &desired}
}

func (c Config) applyRequest() ApplyRequest {
	return applyConfig(c)
}
