package identity

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/transaction"
)

var (
	attestationAlice = Attestation{
		DID:    "did:plc:ewvi7nxzyoun6zhxrhs64oiz",
		Handle: "alice.example.com",
		SigningKeyRef: SigningKeyRef{
			ID:     "key:identity-signing-primary",
			Handle: "identity-signing-primary",
		},
	}
	attestationBob = Attestation{
		DID:    "did:web:bob.example.com",
		Handle: "bob.example.com",
		SigningKeyRef: SigningKeyRef{
			ID:     "vault://identity/signing/bob",
			Handle: "identity-signing-bob",
		},
	}
	errSimulatedWrite = errors.New("simulated write failure")
	errSimulatedApply = errors.New("simulated apply failure")
)

func TestHandleReadsCurrentAttestation(t *testing.T) {
	ctx := context.Background()
	raw := renderAttestation(attestationAlice)
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
	if readResponse.Attestation != attestationAlice {
		t.Fatalf("ReadResponse.Attestation = %#v, want %#v", readResponse.Attestation, attestationAlice)
	}
	if !reflect.DeepEqual(readResponse.Raw, raw) {
		t.Fatalf("ReadResponse.Raw = %q, want %q", readResponse.Raw, raw)
	}
}

func TestApplyReturnsUndoRestoringExactPriorBytes(t *testing.T) {
	ctx := context.Background()
	prior := renderAttestation(attestationAlice)
	fs := newMemoryFileSystem(prior)
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: attestationBob})
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo")
	}

	wantApplied := renderAttestation(attestationBob)
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, wantApplied) {
		t.Fatalf("live attestation after Apply = %q, want %q", got, wantApplied)
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live attestation after Undo = %q, want exact prior bytes %q", got, prior)
	}
}

func TestApplyUndoRestoresAbsentPriorAttestation(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(nil)
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: attestationAlice})
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if !fs.exists {
		t.Fatal("Apply did not create live attestation")
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if fs.exists {
		t.Fatalf("Undo left live attestation %q, want absent", fs.live)
	}
}

func TestTransactionApplyCommitsIdentityWhenHealthPasses(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(renderAttestation(attestationAlice))
	identityCapability := newCapability(fs)
	registry := mustRegistry(t, identityCapability)

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: ApplyRequest{Desired: attestationBob}},
	}, func(context.Context) error {
		return nil
	})

	if !result.Committed() {
		t.Fatalf("Outcome = %q, want committed; err=%v", result.Outcome, result.Err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, renderAttestation(attestationBob)) {
		t.Fatalf("live attestation = %q, want desired attestation", got)
	}
	if len(result.RolledBack) != 0 {
		t.Fatalf("RolledBack = %v, want none", result.RolledBack)
	}
}

func TestTransactionApplyRollsBackIdentityWhenLaterOperationFails(t *testing.T) {
	ctx := context.Background()
	prior := renderAttestation(attestationAlice)
	fs := newMemoryFileSystem(prior)
	identityCapability := newCapability(fs)
	registry := mustRegistry(t, identityCapability, failingTxCapability{name: "test.later"})

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: ApplyRequest{Desired: attestationBob}},
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
		t.Fatalf("live attestation after rollback = %q, want exact prior bytes %q", got, prior)
	}
	wantRolledBack := []transaction.RolledBackOperation{{Index: 0, Capability: Name}}
	if !reflect.DeepEqual(result.RolledBack, wantRolledBack) {
		t.Fatalf("RolledBack = %v, want %v", result.RolledBack, wantRolledBack)
	}
	if len(result.RollbackErrors) != 0 {
		t.Fatalf("RollbackErrors = %v, want none", result.RollbackErrors)
	}
}

func TestApplyRejectsMalformedDIDAndHandleWithoutWriting(t *testing.T) {
	ctx := context.Background()
	prior := renderAttestation(attestationAlice)
	tests := []struct {
		name string
		req  capabilities.TypedRequest
	}{
		{
			name: "wrong request type cannot smuggle path",
			req:  pathSmugglingRequest{Path: "/tmp/attacker", Desired: attestationBob},
		},
		{
			name: "unsupported did method",
			req:  ApplyRequest{Desired: withDID(attestationBob, "did:key:z6mnot-supported")},
		},
		{
			name: "malformed plc did",
			req:  ApplyRequest{Desired: withDID(attestationBob, "did:plc:BAD")},
		},
		{
			name: "url handle",
			req:  ApplyRequest{Desired: withHandle(attestationBob, "https://bob.example.com/profile")},
		},
		{
			name: "single label handle",
			req:  ApplyRequest{Desired: withHandle(attestationBob, "localhost")},
		},
		{
			name: "partial signing key ref",
			req: ApplyRequest{Desired: Attestation{
				DID:    attestationBob.DID,
				Handle: attestationBob.Handle,
				SigningKeyRef: SigningKeyRef{
					Handle: "identity-signing-bob",
				},
			}},
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
				t.Fatalf("live attestation = %q, want unchanged %q", got, prior)
			}
		})
	}
}

func TestApplyRejectsEmbeddedKeyMaterialWithoutWriting(t *testing.T) {
	ctx := context.Background()
	prior := renderAttestation(attestationAlice)
	tests := []struct {
		name string
		ref  SigningKeyRef
	}{
		{
			name: "pem block",
			ref: SigningKeyRef{
				ID:     "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----",
				Handle: "identity-signing-bob",
			},
		},
		{
			name: "seed phrase",
			ref: SigningKeyRef{
				ID:     "key:identity-signing-bob",
				Handle: "seed phrase abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
			},
		},
		{
			name: "long hex blob",
			ref: SigningKeyRef{
				ID:     "0x0123456789abcdef0123456789abcdef",
				Handle: "identity-signing-bob",
			},
		},
		{
			name: "inline reference scheme",
			ref: SigningKeyRef{
				ID:     "inline://identity-signing-bob",
				Handle: "identity-signing-bob",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fs := newMemoryFileSystem(prior)
			capability := newCapability(fs)
			desired := attestationBob
			desired.SigningKeyRef = tt.ref

			undo, err := capability.Apply(ctx, ApplyRequest{Desired: desired})
			if undo != nil {
				t.Fatalf("Apply returned undo %v, want nil", undo)
			}
			var invalid *InvalidRequestError
			if !errors.As(err, &invalid) {
				t.Fatalf("Apply error = %T %v, want InvalidRequestError", err, err)
			}
			if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
				t.Fatalf("live attestation = %q, want unchanged %q", got, prior)
			}
		})
	}
}

func TestAtomicWriteFailureLeavesLiveFileUnchanged(t *testing.T) {
	ctx := context.Background()
	prior := renderAttestation(attestationAlice)
	fs := newMemoryFileSystem(prior)
	fs.failNextAtomicWriteBeforeCommit = true
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: attestationBob})
	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil on failed write", undo)
	}
	if !errors.Is(err, errSimulatedWrite) {
		t.Fatalf("Apply error = %v, want simulated write failure", err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live attestation after failed atomic write = %q, want unchanged %q", got, prior)
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
	prior := renderAttestation(attestationAlice)
	fs := newMemoryFileSystem(prior)
	fs.failNextAtomicWriteAtCommitPoint = true
	identityCapability := newCapability(fs)
	registry := mustRegistry(t, identityCapability, failingTxCapability{name: "test.later"})

	result := transaction.Apply(ctx, registry, transaction.Plan{
		{Capability: Name, Request: ApplyRequest{Desired: attestationBob}},
		{Capability: "test.later", Request: testRequest{}},
	}, func(context.Context) error {
		return nil
	})

	if !fs.observedCommitPointMutation {
		t.Fatal("test did not inject a mutation at the atomic commit point")
	}
	if !result.WasRolledBack() {
		t.Fatalf("Outcome = %q, want rolledBack; err=%v", result.Outcome, result.Err)
	}
	wantApplied := []transaction.AppliedOperation{{Index: 0, Capability: Name}}
	if !reflect.DeepEqual(result.Applied, wantApplied) {
		t.Fatalf("Applied = %v, want %v", result.Applied, wantApplied)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live attestation after rollback = %q, want exact prior bytes %q", got, prior)
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
	observedCommitPointMutation      bool
}

func newMemoryFileSystem(initial []byte) *memoryFileSystem {
	if initial == nil {
		return &memoryFileSystem{}
	}
	return &memoryFileSystem{exists: true, live: cloneBytes(initial)}
}

func (fs *memoryFileSystem) Read(ctx context.Context) (attestationSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return attestationSnapshot{}, err
	}
	return attestationSnapshot{exists: fs.exists, bytes: cloneBytes(fs.live)}, nil
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
		fs.observedCommitPointMutation = true
	}
	return nil
}

func (fs *memoryFileSystem) Replace(ctx context.Context, snapshot attestationSnapshot) error {
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
		t.Fatal("live attestation does not exist")
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
	Desired Attestation
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

func withDID(attestation Attestation, did string) Attestation {
	attestation.DID = did
	return attestation
}

func withHandle(attestation Attestation, handle string) Attestation {
	attestation.Handle = handle
	return attestation
}
