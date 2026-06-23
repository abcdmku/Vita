package capsule

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/vita/agent/capabilities"
	capsulestorage "github.com/vita/agent/storage/capsules"
	"github.com/vita/agent/transaction"
)

var (
	validSHA256SRI    = "sha256-" + base64.StdEncoding.EncodeToString(make([]byte, 32))
	errSimulatedWrite = errors.New("simulated write failure")
	errSimulatedApply = errors.New("simulated apply failure")
)

func TestHandleReadsCurrentRegistryAndReturnsCanonicalRaw(t *testing.T) {
	ctx := context.Background()
	raw := []byte(`{
  "capsules": [
    {"state":"installed","integrity":"` + validSHA256SRI + `","version":"1.0.0","id":"dev.vita.notes"}
  ]
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
	if !reflect.DeepEqual(readResponse.Registry, validRegistry()) {
		t.Fatalf("ReadResponse.Registry = %#v, want %#v", readResponse.Registry, validRegistry())
	}

	canonical := mustRenderRegistry(t, validRegistry())
	if !reflect.DeepEqual(readResponse.Raw, canonical) {
		t.Fatalf("ReadResponse.Raw = %q, want canonical %q", readResponse.Raw, canonical)
	}
	if reflect.DeepEqual(readResponse.Raw, raw) {
		t.Fatal("Handle returned original raw JSON, want canonical validated JSON")
	}
}

func TestApplyReturnsUndoRestoringExactPriorBytes(t *testing.T) {
	ctx := context.Background()
	prior := []byte(`{ "capsules" : [ { "state" : "installed", "integrity" : "` + validSHA256SRI + `", "version" : "1.0.0", "id" : "dev.vita.notes" } ] }`)
	fs := newMemoryFileSystem(prior)
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, applyRegistry(alternateRegistry()))
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo")
	}

	wantApplied := mustRenderRegistry(t, alternateRegistry())
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, wantApplied) {
		t.Fatalf("live capsule registry after Apply = %q, want %q", got, wantApplied)
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live capsule registry after Undo = %q, want exact prior bytes %q", got, prior)
	}
}

func TestApplyUndoRestoresAbsentPriorRegistry(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(nil)
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, applyRegistry(validRegistry()))
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if !fs.exists {
		t.Fatal("Apply did not create live capsule registry")
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if fs.exists {
		t.Fatalf("Undo left live capsule registry %q, want absent", fs.live)
	}
}

func TestApplyPersistsCanonicalRegistryNotDecodedRaw(t *testing.T) {
	ctx := context.Background()
	prior := mustRenderRegistry(t, validRegistry())
	raw := []byte(`{
  "desired": {
    "capsules": [
      {"state":"installed","integrity":"` + validSHA256SRI + `","version":"1.0.0","id":"dev.vita.notes"}
    ]
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
	if got, want := fs.mustLiveBytes(t), mustRenderRegistry(t, validRegistry()); !reflect.DeepEqual(got, want) {
		t.Fatalf("live capsule registry = %q, want canonical %q", got, want)
	}
	if reflect.DeepEqual(fs.mustLiveBytes(t), raw) {
		t.Fatal("Apply persisted decoded request raw bytes, want canonical registry only")
	}
}

func TestTransactionApplyCommitsRegistryWhenHealthPasses(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(mustRenderRegistry(t, validRegistry()))
	capsuleCapability := newCapability(fs)
	registry := mustCapabilityRegistry(t, capsuleCapability)

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: applyRegistry(alternateRegistry())},
	}, func(context.Context) error {
		return nil
	})

	if !result.Committed() {
		t.Fatalf("Outcome = %q, want committed; err=%v", result.Outcome, result.Err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, mustRenderRegistry(t, alternateRegistry())) {
		t.Fatalf("live capsule registry = %q, want desired registry", got)
	}
	if len(result.RolledBack) != 0 {
		t.Fatalf("RolledBack = %v, want none", result.RolledBack)
	}
}

func TestTransactionApplyRollsBackRegistryWhenLaterOperationFails(t *testing.T) {
	ctx := context.Background()
	prior := mustRenderRegistry(t, validRegistry())
	fs := newMemoryFileSystem(prior)
	capsuleCapability := newCapability(fs)
	registry := mustCapabilityRegistry(t, capsuleCapability, failingTxCapability{name: "test.later"})

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: applyRegistry(alternateRegistry())},
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
		t.Fatalf("live capsule registry after rollback = %q, want exact prior bytes %q", got, prior)
	}
	wantRolledBack := []transaction.RolledBackOperation{{Index: 0, Capability: Name}}
	if !reflect.DeepEqual(result.RolledBack, wantRolledBack) {
		t.Fatalf("RolledBack = %v, want %v", result.RolledBack, wantRolledBack)
	}
	if len(result.RollbackErrors) != 0 {
		t.Fatalf("RollbackErrors = %v, want none", result.RollbackErrors)
	}
}

func TestAtomicWriteFailureLeavesLiveRegistryUnchanged(t *testing.T) {
	ctx := context.Background()
	prior := mustRenderRegistry(t, validRegistry())
	fs := newMemoryFileSystem(prior)
	fs.failNextAtomicWriteBeforeCommit = true
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, applyRegistry(alternateRegistry()))
	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil on failed write", undo)
	}
	if !errors.Is(err, errSimulatedWrite) {
		t.Fatalf("Apply error = %v, want simulated write failure", err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live capsule registry after failed atomic write = %q, want unchanged %q", got, prior)
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
	prior := mustRenderRegistry(t, validRegistry())
	fs := newMemoryFileSystem(prior)
	fs.observeNextAtomicCommit = true
	capsuleCapability := newCapability(fs)
	registry := mustCapabilityRegistry(t, capsuleCapability, failingTxCapability{name: "test.later"})

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: applyRegistry(alternateRegistry())},
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
		t.Fatalf("live capsule registry after rollback = %q, want exact prior bytes %q", got, prior)
	}
	wantRolledBack := []transaction.RolledBackOperation{{Index: 0, Capability: Name}}
	if !reflect.DeepEqual(result.RolledBack, wantRolledBack) {
		t.Fatalf("RolledBack = %v, want %v", result.RolledBack, wantRolledBack)
	}
	if len(result.RollbackErrors) != 0 {
		t.Fatalf("RollbackErrors = %v, want none", result.RollbackErrors)
	}
}

func TestApplyRejectsInvalidRegistryWithoutWriting(t *testing.T) {
	ctx := context.Background()
	prior := mustRenderRegistry(t, validRegistry())
	longBase64Version := strings.Repeat("A", 48)

	tests := []struct {
		name string
		req  capabilities.TypedRequest
	}{
		{
			name: "wrong request type cannot smuggle path",
			req:  pathSmugglingRequest{Path: "/tmp/attacker", Desired: alternateRegistry()},
		},
		{
			name: "missing desired",
			req:  ApplyRequest{},
		},
		{
			name: "typed nil capsules rejects",
			req:  ApplyRequest{Desired: &Registry{}},
		},
		{
			name: "malformed id",
			req:  applyRegistry(registryWithCapsules([]CapsuleEntry{withID(validEntry(), "not an id")})),
		},
		{
			name: "embedded id via inline scheme",
			req:  applyRegistry(registryWithCapsules([]CapsuleEntry{withID(validEntry(), "data:QUJD")})),
		},
		{
			name: "missing version",
			req:  applyRegistry(registryWithCapsules([]CapsuleEntry{withVersion(validEntry(), "")})),
		},
		{
			name: "version inline scheme",
			req:  applyRegistry(registryWithCapsules([]CapsuleEntry{withVersion(validEntry(), "data:QUJD")})),
		},
		{
			name: "version long base64 blob",
			req:  applyRegistry(registryWithCapsules([]CapsuleEntry{withVersion(validEntry(), longBase64Version)})),
		},
		{
			name: "malformed sri",
			req:  applyRegistry(registryWithCapsules([]CapsuleEntry{withIntegrity(validEntry(), "not-an-sri")})),
		},
		{
			name: "wrong sri digest length",
			req:  applyRegistry(registryWithCapsules([]CapsuleEntry{withIntegrity(validEntry(), "sha256-AAAAAAAAAAAAAAAAAAAA")})),
		},
		{
			name: "invalid state",
			req:  applyRegistry(registryWithCapsules([]CapsuleEntry{withState(validEntry(), "enabled")})),
		},
		{
			name: "duplicate capsule ids",
			req: applyRegistry(registryWithCapsules([]CapsuleEntry{
				validEntry(),
				withVersion(validEntry(), "1.0.1"),
			})),
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
				t.Fatalf("live capsule registry = %q, want unchanged %q", got, prior)
			}
		})
	}
}

func TestApplyAcceptsExplicitEmptyRegistry(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(mustRenderRegistry(t, validRegistry()))
	capability := newCapability(fs)
	emptyCapsules := []CapsuleEntry{}
	req := ApplyRequest{Desired: &Registry{Capsules: &emptyCapsules}}

	if err := req.Validate(); err != nil {
		t.Fatalf("Validate returned error: %v", err)
	}
	if _, err := capability.Apply(ctx, req); err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if got, want := fs.mustLiveBytes(t), []byte("{\"capsules\":[]}\n"); !reflect.DeepEqual(got, want) {
		t.Fatalf("live capsule registry = %q, want empty registry %q", got, want)
	}
}

func TestFetchCapabilityStagesAndUndoRemovesNewCacheEntry(t *testing.T) {
	ctx := context.Background()
	target := filepath.Join(t.TempDir(), "local.test.capsule", "1.0.0")
	store := &recordingFetchStore{target: target}
	capability := newFetchCapability(store)
	req := fetchApply("local.test.capsule", "1.0.0", "file:///staging/local.test.capsule.tar.zst", validSHA256SRI)

	undo, err := capability.Apply(ctx, req)
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo")
	}
	if store.fetches != 1 {
		t.Fatalf("FetchCapsuleFor calls = %d, want 1", store.fetches)
	}
	if store.ref != req.Desired.Ref || store.integrity != req.Desired.Integrity || store.id != req.Desired.ID || store.version != req.Desired.Version {
		t.Fatalf("fetch call = ref=%q integrity=%q id=%q version=%q, want request fields", store.ref, store.integrity, store.id, store.version)
	}

	response, err := capability.Handle(ctx, FetchReadRequest{})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	readResponse, ok := response.(FetchReadResponse)
	if !ok {
		t.Fatalf("Handle returned %T, want FetchReadResponse", response)
	}
	if readResponse.Last == nil || readResponse.Last.LocalPath != target || readResponse.Last.Status != "OK" {
		t.Fatalf("FetchReadResponse.Last = %#v, want staged OK status", readResponse.Last)
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if !reflect.DeepEqual(store.removed, []string{target}) {
		t.Fatalf("removed = %v, want [%s]", store.removed, target)
	}
	response, err = capability.Handle(ctx, FetchReadRequest{})
	if err != nil {
		t.Fatalf("Handle after undo returned error: %v", err)
	}
	readResponse = response.(FetchReadResponse)
	if readResponse.Last != nil {
		t.Fatalf("Last after undo = %#v, want nil", readResponse.Last)
	}
}

func TestFetchCapabilityStagesOCIImageWhenImageDigestPresent(t *testing.T) {
	ctx := context.Background()
	target := filepath.Join(t.TempDir(), "local.test.oci", "1.0.0")
	imageDigest := "sha256:" + strings.Repeat("a", 64)
	store := &recordingFetchStore{
		target: target,
		ociResult: capsulestorage.OCIFetchResult{
			CapsulePath: target,
			RootFSPath:  filepath.Join(target, "rootfs"),
			ImageDigest: imageDigest,
			Layers:      2,
			Entrypoint:  []string{"/bin/vita-oci-test", "--serve"},
			Env:         []string{"VITA_TEST=1"},
		},
	}
	capability := newFetchCapability(store)
	req := fetchOCIApply("local.test.oci", "1.0.0", "file:///staging/local.test.oci.tar.zst", validSHA256SRI, imageDigest)

	undo, err := capability.Apply(ctx, req)
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo")
	}
	if store.ociFetches != 1 || store.fetches != 0 {
		t.Fatalf("fetch calls = oci:%d legacy:%d, want oci only", store.ociFetches, store.fetches)
	}
	if store.imageDigest != imageDigest {
		t.Fatalf("imageDigest = %q, want %q", store.imageDigest, imageDigest)
	}

	response, err := capability.Handle(ctx, FetchReadRequest{})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	readResponse := response.(FetchReadResponse)
	if readResponse.Last == nil {
		t.Fatal("FetchReadResponse.Last = nil, want OCI status")
	}
	if readResponse.Last.RootFSPath != filepath.Join(target, "rootfs") ||
		readResponse.Last.ImageDigest != imageDigest ||
		readResponse.Last.Layers != 2 ||
		!reflect.DeepEqual(readResponse.Last.Entrypoint, []string{"/bin/vita-oci-test", "--serve"}) ||
		!reflect.DeepEqual(readResponse.Last.Env, []string{"VITA_TEST=1"}) {
		t.Fatalf("FetchReadResponse.Last = %#v, want OCI metadata", readResponse.Last)
	}
}

func TestFetchCapabilityRejectsInvalidRequestWithoutFetching(t *testing.T) {
	ctx := context.Background()
	store := &recordingFetchStore{target: filepath.Join(t.TempDir(), "target")}
	capability := newFetchCapability(store)

	undo, err := capability.Apply(ctx, fetchApply("local.test.capsule", "1.0.0", "https://registry.example.invalid/capsule.tar.zst", validSHA256SRI))

	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil", undo)
	}
	var invalid *FetchInvalidRequestError
	if !errors.As(err, &invalid) {
		t.Fatalf("Apply error = %T %v, want FetchInvalidRequestError", err, err)
	}
	if store.fetches != 0 {
		t.Fatalf("FetchCapsuleFor calls = %d, want 0", store.fetches)
	}
}

func TestAbsentRequiredFieldsRejectFailClosed(t *testing.T) {
	tests := []struct {
		name string
		raw  string
	}{
		{
			name: "missing desired",
			raw:  `{"notDesired":{"capsules":[]}}`,
		},
		{
			name: "missing capsules",
			raw:  `{"desired":{}}`,
		},
		{
			name: "entry missing id",
			raw:  `{"desired":{"capsules":[{"version":"1.0.0","integrity":"` + validSHA256SRI + `","state":"installed"}]}}`,
		},
		{
			name: "entry missing version",
			raw:  `{"desired":{"capsules":[{"id":"dev.vita.notes","integrity":"` + validSHA256SRI + `","state":"installed"}]}}`,
		},
		{
			name: "entry missing integrity",
			raw:  `{"desired":{"capsules":[{"id":"dev.vita.notes","version":"1.0.0","state":"installed"}]}}`,
		},
		{
			name: "entry missing state",
			raw:  `{"desired":{"capsules":[{"id":"dev.vita.notes","version":"1.0.0","integrity":"` + validSHA256SRI + `"}]}}`,
		},
		{
			name: "capsules null",
			raw:  `{"desired":{"capsules":null}}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var req ApplyRequest
			if err := json.Unmarshal([]byte(tt.raw), &req); err == nil {
				if err := req.Validate(); err == nil {
					t.Fatal("Decode and Validate returned nil, want required-field rejection")
				}
			}
		})
	}

	req := ApplyRequest{Desired: &Registry{}}
	if err := req.Validate(); err == nil {
		t.Fatal("typed nil capsules Validate returned nil, want required-field rejection")
	}
}

func TestDecodeRejectsEmbeddedCapsuleBytes(t *testing.T) {
	raw := `{"desired":{"capsules":[{"id":"dev.vita.notes","version":"1.0.0","integrity":"` + validSHA256SRI + `","state":"installed","bytes":"QUJD"}]}}`

	var req ApplyRequest
	err := json.Unmarshal([]byte(raw), &req)
	if err == nil {
		t.Fatal("Unmarshal accepted embedded capsule bytes, want rejection")
	}
	if !strings.Contains(err.Error(), "bytes") {
		t.Fatalf("Unmarshal error = %v, want bytes rejection", err)
	}
}

func TestDuplicateJSONKeysAreRejectedBeforeDecode(t *testing.T) {
	tests := []struct {
		name string
		raw  string
	}{
		{
			name: "duplicate top-level desired",
			raw:  `{"desired":{"capsules":[]},"desired":{"capsules":[{"id":"dev.vita.notes","version":"1.0.0","integrity":"` + validSHA256SRI + `","state":"installed"}]}}`,
		},
		{
			name: "duplicate capsules smuggles empty registry",
			raw:  `{"desired":{"capsules":[],"capsules":[{"id":"dev.vita.notes","version":"1.0.0","integrity":"` + validSHA256SRI + `","state":"installed"}]}}`,
		},
		{
			name: "duplicate id smuggles inline bytes",
			raw:  `{"desired":{"capsules":[{"id":"data:QUJD","id":"dev.vita.notes","version":"1.0.0","integrity":"` + validSHA256SRI + `","state":"installed"}]}}`,
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

func TestParseRejectsDuplicateKeysInStoredRegistry(t *testing.T) {
	raw := []byte(`{"capsules":[{"id":"data:QUJD","id":"dev.vita.notes","version":"1.0.0","integrity":"` + validSHA256SRI + `","state":"installed"}]}`)

	if _, err := parseRegistry(raw); err == nil {
		t.Fatal("parseRegistry returned nil error, want duplicate-key rejection")
	} else if !strings.Contains(err.Error(), "duplicate JSON object key") {
		t.Fatalf("parseRegistry error = %v, want duplicate-key rejection", err)
	}
}

type memoryFileSystem struct {
	exists                          bool
	live                            []byte
	temp                            []byte
	atomicWrites                    int
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

func (fs *memoryFileSystem) Read(ctx context.Context) (registrySnapshot, error) {
	if err := ctx.Err(); err != nil {
		return registrySnapshot{}, err
	}
	return registrySnapshot{exists: fs.exists, bytes: cloneBytes(fs.live)}, nil
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
	if fs.observeNextAtomicCommit {
		fs.observeNextAtomicCommit = false
		fs.observedCommitPointMutation = true
	}
	return nil
}

func (fs *memoryFileSystem) Replace(ctx context.Context, snapshot registrySnapshot) error {
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
		t.Fatal("live capsule registry does not exist")
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
	Desired Registry
}

func (pathSmugglingRequest) CapabilityRequest() {}

type recordingFetchStore struct {
	target      string
	fetches     int
	ociFetches  int
	ref         string
	integrity   string
	id          string
	version     string
	imageDigest string
	ociResult   capsulestorage.OCIFetchResult
	removed     []string
	err         error
}

func (s *recordingFetchStore) FetchCapsuleFor(ctx context.Context, ref string, integrity string, id string, version string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	s.fetches++
	s.ref = ref
	s.integrity = integrity
	s.id = id
	s.version = version
	if s.err != nil {
		return "", s.err
	}
	return s.target, nil
}

func (s *recordingFetchStore) FetchOCIImageFor(ctx context.Context, ref string, integrity string, id string, version string, imageDigest string) (capsulestorage.OCIFetchResult, error) {
	if err := ctx.Err(); err != nil {
		return capsulestorage.OCIFetchResult{}, err
	}
	s.ociFetches++
	s.ref = ref
	s.integrity = integrity
	s.id = id
	s.version = version
	s.imageDigest = imageDigest
	if s.err != nil {
		return capsulestorage.OCIFetchResult{}, s.err
	}
	if s.ociResult.CapsulePath == "" {
		s.ociResult.CapsulePath = s.target
	}
	return s.ociResult, nil
}

func (s *recordingFetchStore) CachePath(string, string) (string, error) {
	return s.target, nil
}

func (s *recordingFetchStore) RemoveStagedCapsule(ctx context.Context, localPath string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.removed = append(s.removed, localPath)
	return nil
}

func validEntry() CapsuleEntry {
	return CapsuleEntry{
		ID:        "dev.vita.notes",
		Version:   "1.0.0",
		Integrity: validSHA256SRI,
		State:     StateInstalled,
	}
}

func alternateEntry() CapsuleEntry {
	return CapsuleEntry{
		ID:        "capsule:local-backup",
		Version:   "2.0.0+build.7",
		Integrity: validSHA256SRI,
		State:     StateDisabled,
	}
}

func validRegistry() Registry {
	return registryWithCapsules([]CapsuleEntry{validEntry()})
}

func alternateRegistry() Registry {
	return registryWithCapsules([]CapsuleEntry{alternateEntry()})
}

func registryWithCapsules(capsules []CapsuleEntry) Registry {
	copied := cloneCapsules(capsules)
	return Registry{Capsules: &copied}
}

func applyRegistry(registry Registry) ApplyRequest {
	cloned := cloneRegistry(registry)
	return ApplyRequest{Desired: &cloned}
}

func fetchApply(id string, version string, ref string, integrity string) FetchApplyRequest {
	desired := FetchDesired{
		ID:        id,
		Version:   version,
		Ref:       ref,
		Integrity: integrity,
	}
	return FetchApplyRequest{Desired: &desired}
}

func fetchOCIApply(id string, version string, ref string, integrity string, imageDigest string) FetchApplyRequest {
	desired := FetchDesired{
		ID:          id,
		Version:     version,
		Ref:         ref,
		Integrity:   integrity,
		ImageDigest: &imageDigest,
	}
	return FetchApplyRequest{Desired: &desired}
}

func withID(entry CapsuleEntry, id string) CapsuleEntry {
	entry.ID = id
	return entry
}

func withVersion(entry CapsuleEntry, version string) CapsuleEntry {
	entry.Version = version
	return entry
}

func withIntegrity(entry CapsuleEntry, integrity string) CapsuleEntry {
	entry.Integrity = integrity
	return entry
}

func withState(entry CapsuleEntry, state State) CapsuleEntry {
	entry.State = state
	return entry
}

func mustRenderRegistry(t *testing.T, registry Registry) []byte {
	t.Helper()
	rendered, err := renderRegistry(registry)
	if err != nil {
		t.Fatalf("renderRegistry returned error: %v", err)
	}
	return rendered
}

func mustCapabilityRegistry(t *testing.T, registered ...capabilities.Capability) *capabilities.Registry {
	t.Helper()

	registry, err := capabilities.NewRegistry(registered...)
	if err != nil {
		t.Fatalf("NewRegistry returned error: %v", err)
	}
	return registry
}
