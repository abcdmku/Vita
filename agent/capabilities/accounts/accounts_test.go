package accounts

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
	aliceAccount              = NewAccount("alice", 1000, "users", []string{"video"}, "/bin/bash", true)
	bobAccount                = NewAccount("bob", 1001, "users", []string{"audio"}, "/usr/bin/zsh", false)
	singleAccountConfig       = NewConfig([]Account{aliceAccount})
	mixedAccountsConfig       = NewConfig([]Account{aliceAccount, bobAccount})
	emptyAccountsConfig       = NewConfig([]Account{})
	errSimulatedWrite         = errors.New("simulated write failure")
	errSimulatedApply         = errors.New("simulated apply failure")
	canonicalSingleAccount    = []byte("{\"accounts\":[{\"name\":\"alice\",\"uid\":1000,\"primaryGroup\":\"users\",\"groups\":[\"video\"],\"shell\":\"/bin/bash\",\"enabled\":true}]}\n")
	canonicalMixedAccounts    = []byte("{\"accounts\":[{\"name\":\"alice\",\"uid\":1000,\"primaryGroup\":\"users\",\"groups\":[\"video\"],\"shell\":\"/bin/bash\",\"enabled\":true},{\"name\":\"bob\",\"uid\":1001,\"primaryGroup\":\"users\",\"groups\":[\"audio\"],\"shell\":\"/usr/bin/zsh\",\"enabled\":false}]}\n")
	canonicalEmptyAccounts    = []byte("{\"accounts\":[]}\n")
	nonCanonicalSingleAccount = []byte("{\"accounts\":[{\"enabled\":true,\"shell\":\"/bin/bash\",\"groups\":[\"video\",\"video\"],\"primaryGroup\":\"users\",\"uid\":1000,\"name\":\"alice\"}]}\n")
	predictableTempContents   = []byte("attacker-controlled temp target\n")
)

func TestHandleReadsCurrentConfigAsCanonicalBytes(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(nonCanonicalSingleAccount)
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
	if !reflect.DeepEqual(readResponse.Config, singleAccountConfig) {
		t.Fatalf("ReadResponse.Config = %#v, want %#v", readResponse.Config, singleAccountConfig)
	}
	if !reflect.DeepEqual(readResponse.Raw, canonicalSingleAccount) {
		t.Fatalf("ReadResponse.Raw = %q, want canonical %q", readResponse.Raw, canonicalSingleAccount)
	}
}

func TestApplyWritesCanonicalConfigAndUndoRestoresExactPriorBytes(t *testing.T) {
	ctx := context.Background()
	prior := nonCanonicalSingleAccount
	fs := newMemoryFileSystem(prior)
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: &mixedAccountsConfig})
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo")
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, canonicalMixedAccounts) {
		t.Fatalf("live config after Apply = %q, want %q", got, canonicalMixedAccounts)
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

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: &mixedAccountsConfig})
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

func TestTransactionApplyCommitsAccountsConfigWhenHealthPasses(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(canonicalSingleAccount)
	accountsCapability := newCapability(fs)
	registry := mustRegistry(t, accountsCapability)

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: ApplyRequest{Desired: &mixedAccountsConfig}},
	}, func(context.Context) error {
		return nil
	})

	if !result.Committed() {
		t.Fatalf("Outcome = %q, want committed; err=%v", result.Outcome, result.Err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, canonicalMixedAccounts) {
		t.Fatalf("live config = %q, want desired config %q", got, canonicalMixedAccounts)
	}
	if len(result.RolledBack) != 0 {
		t.Fatalf("RolledBack = %v, want none", result.RolledBack)
	}
}

func TestTransactionApplyRollsBackAccountsConfigWhenLaterOperationFails(t *testing.T) {
	ctx := context.Background()
	prior := canonicalSingleAccount
	fs := newMemoryFileSystem(prior)
	accountsCapability := newCapability(fs)
	registry := mustRegistry(t, accountsCapability, failingTxCapability{name: "test.later"})

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: ApplyRequest{Desired: &mixedAccountsConfig}},
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
			req:  pathSmugglingRequest{Path: "/tmp/attacker", Desired: mixedAccountsConfig},
		},
		{
			name: "missing desired",
			req:  ApplyRequest{},
		},
		{
			name: "missing accounts",
			req:  ApplyRequest{Desired: &Config{}},
		},
		{
			name: "nil accounts",
			req:  ApplyRequest{Desired: configWithNilAccounts()},
		},
		{
			name: "uid zero",
			req:  applyConfig(configWithAccount(NewAccount("zero", 0, "users", []string{}, "/bin/bash", true))),
		},
		{
			name: "uid below managed range",
			req:  applyConfig(configWithAccount(NewAccount("system", 999, "users", []string{}, "/bin/bash", true))),
		},
		{
			name: "uid above managed range",
			req:  applyConfig(configWithAccount(NewAccount("toohigh", 60001, "users", []string{}, "/bin/bash", true))),
		},
		{
			name: "malformed username",
			req:  applyConfig(configWithAccount(NewAccount("Alice", 1002, "users", []string{}, "/bin/bash", true))),
		},
		{
			name: "malformed primary group",
			req:  applyConfig(configWithAccount(NewAccount("carol", 1002, "Bad", []string{}, "/bin/bash", true))),
		},
		{
			name: "malformed supplemental group",
			req:  applyConfig(configWithAccount(NewAccount("carol", 1002, "users", []string{"bad.group"}, "/bin/bash", true))),
		},
		{
			name: "root primary group",
			req:  applyConfig(configWithAccount(NewAccount("carol", 1002, "root", []string{}, "/bin/bash", true))),
		},
		{
			name: "sudo group membership",
			req:  applyConfig(configWithAccount(NewAccount("carol", 1002, "users", []string{"sudo"}, "/bin/bash", true))),
		},
		{
			name: "wheel group membership",
			req:  applyConfig(configWithAccount(NewAccount("carol", 1002, "users", []string{"wheel"}, "/bin/bash", true))),
		},
		{
			name: "admin group membership",
			req:  applyConfig(configWithAccount(NewAccount("carol", 1002, "users", []string{"admin"}, "/bin/bash", true))),
		},
		{
			name: "root group membership",
			req:  applyConfig(configWithAccount(NewAccount("carol", 1002, "users", []string{"root"}, "/bin/bash", true))),
		},
		{
			name: "non allowlisted shell",
			req:  applyConfig(configWithAccount(NewAccount("carol", 1002, "users", []string{}, "/bin/fish", true))),
		},
		{
			name: "absent enabled in typed config",
			req:  applyConfig(configWithAccount(Account{Name: "carol", UID: 1002, PrimaryGroup: "users", Groups: []string{}, Shell: "/bin/bash"})),
		},
		{
			name: "nil groups in typed config",
			req:  applyConfig(configWithAccount(Account{Name: "carol", UID: 1002, PrimaryGroup: "users", Shell: "/bin/bash", Enabled: boolPointer(true)})),
		},
		{
			name: "duplicate account name",
			req: NewConfig([]Account{
				NewAccount("carol", 1002, "users", []string{}, "/bin/bash", true),
				NewAccount("carol", 1003, "users", []string{}, "/bin/sh", true),
			}).applyRequest(),
		},
		{
			name: "duplicate account uid",
			req: NewConfig([]Account{
				NewAccount("carol", 1002, "users", []string{}, "/bin/bash", true),
				NewAccount("dave", 1002, "users", []string{}, "/bin/sh", true),
			}).applyRequest(),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fs := newMemoryFileSystem(canonicalSingleAccount)
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
			if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, canonicalSingleAccount) {
				t.Fatalf("live config = %q, want unchanged %q", got, canonicalSingleAccount)
			}
		})
	}
}

func TestJSONRejectsAbsentEnabledAbsentAccountsDuplicateKeysAndInlineSecrets(t *testing.T) {
	tests := []struct {
		name string
		raw  string
	}{
		{
			name: "absent enabled",
			raw:  `{"desired":{"accounts":[{"name":"alice","uid":1000,"primaryGroup":"users","groups":[],"shell":"/bin/bash"}]}}`,
		},
		{
			name: "null enabled",
			raw:  `{"desired":{"accounts":[{"name":"alice","uid":1000,"primaryGroup":"users","groups":[],"shell":"/bin/bash","enabled":null}]}}`,
		},
		{
			name: "absent accounts",
			raw:  `{"desired":{}}`,
		},
		{
			name: "null accounts",
			raw:  `{"desired":{"accounts":null}}`,
		},
		{
			name: "absent groups",
			raw:  `{"desired":{"accounts":[{"name":"alice","uid":1000,"primaryGroup":"users","shell":"/bin/bash","enabled":true}]}}`,
		},
		{
			name: "unknown password field",
			raw:  `{"desired":{"accounts":[{"name":"alice","uid":1000,"primaryGroup":"users","groups":[],"shell":"/bin/bash","enabled":true,"password":"secret"}]}}`,
		},
		{
			name: "duplicate top-level desired smuggles PEM",
			raw:  `{"desired":{"accounts":[{"name":"-----BEGIN PRIVATE KEY-----","uid":1000,"primaryGroup":"users","groups":[],"shell":"/bin/bash","enabled":true}]},"desired":{"accounts":[]}}`,
		},
		{
			name: "duplicate nested accounts",
			raw:  `{"desired":{"accounts":[],"accounts":[{"name":"alice","uid":1000,"primaryGroup":"users","groups":[],"shell":"/bin/bash","enabled":true}]}}`,
		},
		{
			name: "duplicate account name field",
			raw:  `{"desired":{"accounts":[{"name":"alice","name":"bob","uid":1000,"primaryGroup":"users","groups":[],"shell":"/bin/bash","enabled":true}]}}`,
		},
		{
			name: "duplicate account uid field",
			raw:  `{"desired":{"accounts":[{"name":"alice","uid":0,"uid":1000,"primaryGroup":"users","groups":[],"shell":"/bin/bash","enabled":true}]}}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var req ApplyRequest
			err := json.Unmarshal([]byte(tt.raw), &req)
			if err == nil {
				t.Fatal("Unmarshal returned nil, want rejection")
			}
		})
	}
}

func TestApplyAcceptsExplicitEmptyAccountsList(t *testing.T) {
	ctx := context.Background()
	var req ApplyRequest
	if err := json.Unmarshal([]byte(`{"desired":{"accounts":[]}}`), &req); err != nil {
		t.Fatalf("Unmarshal returned error for explicit empty accounts: %v", err)
	}
	if err := req.Validate(); err != nil {
		t.Fatalf("Validate returned error for explicit empty accounts: %v", err)
	}

	fs := newMemoryFileSystem(canonicalSingleAccount)
	capability := newCapability(fs)
	undo, err := capability.Apply(ctx, ApplyRequest{Desired: &emptyAccountsConfig})
	if err != nil {
		t.Fatalf("Apply returned error for explicit empty accounts: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo")
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, canonicalEmptyAccounts) {
		t.Fatalf("live config after Apply = %q, want %q", got, canonicalEmptyAccounts)
	}
}

func TestParseConfigRejectsDuplicateJSONKeys(t *testing.T) {
	raw := []byte(`{"accounts":[{"name":"alice","uid":0,"uid":1000,"primaryGroup":"users","groups":[],"shell":"/bin/bash","enabled":true}]}`)

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
	fs := newMemoryFileSystem(canonicalSingleAccount)
	fs.failNextAtomicWriteBeforeCommit = true
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: &mixedAccountsConfig})
	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil on failed write", undo)
	}
	if !errors.Is(err, errSimulatedWrite) {
		t.Fatalf("Apply error = %v, want simulated write failure", err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, canonicalSingleAccount) {
		t.Fatalf("live config after failed atomic write = %q, want unchanged %q", got, canonicalSingleAccount)
	}
	if fs.temp == nil {
		t.Fatal("simulated atomic write did not stage a temp file")
	}
	if reflect.DeepEqual(fs.temp, fs.live) {
		t.Fatal("test did not simulate a partial temp distinct from the live file")
	}
}

func TestAtomicWriteErrorAfterEffectRestoresPriorState(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(canonicalSingleAccount)
	fs.failNextAtomicWriteAfterEffect = true
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: &mixedAccountsConfig})
	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil on reported write failure", undo)
	}
	if !errors.Is(err, errSimulatedWrite) {
		t.Fatalf("Apply error = %v, want simulated write failure", err)
	}
	if !fs.observedAfterEffectFailure {
		t.Fatal("test did not inject a failure after the atomic write effect")
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, canonicalSingleAccount) {
		t.Fatalf("live config after after-effect failure = %q, want unchanged %q", got, canonicalSingleAccount)
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

	if err := os.WriteFile(fs.path, canonicalSingleAccount, configFileMode); err != nil {
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

	if err := fs.AtomicWrite(ctx, canonicalMixedAccounts); err != nil {
		t.Fatalf("AtomicWrite returned error: %v", err)
	}
	if got, err := os.ReadFile(fs.path); err != nil {
		t.Fatalf("read live config: %v", err)
	} else if !reflect.DeepEqual(got, canonicalMixedAccounts) {
		t.Fatalf("live config = %q, want %q", got, canonicalMixedAccounts)
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

func TestDefaultAtomicWriteFailureLeavesLiveFileUnchanged(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	stateRootFile := filepath.Join(dir, "not-a-directory")
	livePath := filepath.Join(dir, defaultConfigFilename)
	fs := defaultFileSystem{
		stateRoot: stateRootFile,
		path:      livePath,
	}

	if err := os.WriteFile(livePath, canonicalSingleAccount, configFileMode); err != nil {
		t.Fatalf("seed live config: %v", err)
	}
	if err := os.WriteFile(stateRootFile, []byte("not a directory"), configFileMode); err != nil {
		t.Fatalf("seed state root file: %v", err)
	}

	err := fs.AtomicWrite(ctx, canonicalMixedAccounts)
	if err == nil {
		t.Fatal("AtomicWrite returned nil, want failure")
	}
	if got, err := os.ReadFile(livePath); err != nil {
		t.Fatalf("read live config: %v", err)
	} else if !reflect.DeepEqual(got, canonicalSingleAccount) {
		t.Fatalf("live config after failed AtomicWrite = %q, want unchanged %q", got, canonicalSingleAccount)
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

func configWithAccount(account Account) Config {
	return NewConfig([]Account{account})
}

func configWithNilAccounts() *Config {
	var nilAccounts []Account
	return &Config{Accounts: &nilAccounts}
}

func applyConfig(config Config) ApplyRequest {
	desired := cloneConfig(config)
	return ApplyRequest{Desired: &desired}
}

func (c Config) applyRequest() ApplyRequest {
	return applyConfig(c)
}
