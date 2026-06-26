package owner

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

const (
	testRPID   = "owner.example.com"
	testAction = "vita.owner.test-action"
)

var (
	errSimulatedWrite = errors.New("simulated write failure")
)

func TestEnrollValidES256CredentialPersistsAndRoundTripsPublicOnly(t *testing.T) {
	ctx := context.Background()
	fixture := newES256Fixture(t, 1)
	fs := newMemoryFileSystem(nil)
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: fixture.credential})
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo")
	}

	response, err := capability.Handle(ctx, ReadRequest{})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	readResponse, ok := response.(ReadResponse)
	if !ok {
		t.Fatalf("Handle returned %T, want ReadResponse", response)
	}
	if !readResponse.Exists || !readResponse.Enrolled {
		t.Fatalf("ReadResponse exists/enrolled = %v/%v, want true/true", readResponse.Exists, readResponse.Enrolled)
	}
	if !reflect.DeepEqual(readResponse.Credential, fixture.credential) {
		t.Fatalf("credential round-trip = %#v, want %#v", readResponse.Credential, fixture.credential)
	}
	assertNoPrivateMaterial(t, fs.mustLiveBytes(t))
	assertNoPrivateMaterial(t, renderCredential(readResponse.Credential))
}

func TestEnrollValidEdDSACredentialPersistsAndRoundTrips(t *testing.T) {
	ctx := context.Background()
	fixture := newEd25519Fixture(t, 0)
	fs := newMemoryFileSystem(nil)
	capability := newCapability(fs)

	if _, err := capability.Apply(ctx, ApplyRequest{Desired: fixture.credential}); err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}

	got := mustReadCredential(t, fs)
	if !reflect.DeepEqual(got, fixture.credential) {
		t.Fatalf("credential round-trip = %#v, want %#v", got, fixture.credential)
	}
}

func TestEnrollUndoRestoresPriorCredentialExactly(t *testing.T) {
	ctx := context.Background()
	priorCredential := newES256Fixture(t, 1).credential
	nextCredential := newEd25519Fixture(t, 0).credential
	prior := renderCredential(priorCredential)
	fs := newMemoryFileSystem(prior)
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: nextCredential})
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}

	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, renderCredential(nextCredential)) {
		t.Fatalf("live credential after Apply = %q, want next credential", got)
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live credential after Undo = %q, want exact prior bytes %q", got, prior)
	}
}

func TestEnrollUndoRestoresAbsentPriorCredential(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(nil)
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: newES256Fixture(t, 1).credential})
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if !fs.exists {
		t.Fatal("Apply did not create live owner credential")
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if fs.exists {
		t.Fatalf("Undo left live credential %q, want absent", fs.live)
	}
}

func TestAtomicWriteFailureLeavesLiveCredentialUnchanged(t *testing.T) {
	ctx := context.Background()
	prior := renderCredential(newES256Fixture(t, 1).credential)
	fs := newMemoryFileSystem(prior)
	fs.failNextAtomicWriteBeforeCommit = true
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: newEd25519Fixture(t, 0).credential})
	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil on failed write", undo)
	}
	if !errors.Is(err, errSimulatedWrite) {
		t.Fatalf("Apply error = %v, want simulated write failure", err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live credential after failed atomic write = %q, want unchanged %q", got, prior)
	}
	if fs.temp == nil {
		t.Fatal("simulated atomic write did not stage a temp file")
	}
	if reflect.DeepEqual(fs.temp, fs.live) {
		t.Fatal("test did not simulate a partial temp distinct from the live file")
	}
}

func TestCommitPointReportedFailureRestoresPriorWithoutUndo(t *testing.T) {
	ctx := context.Background()
	prior := renderCredential(newES256Fixture(t, 1).credential)
	fs := newMemoryFileSystem(prior)
	fs.failNextAtomicWriteAtCommitPoint = true
	capability := newCapability(fs)

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: newEd25519Fixture(t, 0).credential})

	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil on reported commit-point failure", undo)
	}
	if !errors.Is(err, errSimulatedWrite) {
		t.Fatalf("Apply error = %v, want simulated write failure", err)
	}
	if !fs.observedCommitPointMutation {
		t.Fatal("test did not inject a mutation at the atomic commit point")
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live credential after reported commit-point failure = %q, want exact prior bytes %q", got, prior)
	}
}

func TestVerifyAssertionAcceptsSignedES256AndAdvancesSignCount(t *testing.T) {
	ctx := context.Background()
	fixture := newES256Fixture(t, 1)
	fs := newMemoryFileSystem(renderCredential(fixture.credential))
	capability := newCapability(fs)
	ticket := mustChallenge(t, capability, testAction)
	assertion := fixture.assertion(t, ticket, assertionOptions{counter: 2})

	response := mustVerify(t, capability, ctx, assertion)
	if !response.Verified || response.Action != testAction {
		t.Fatalf("VerifyResponse = %#v, want verified action %q", response, testAction)
	}

	updated := mustReadCredential(t, fs)
	if updated.SignCount != 2 {
		t.Fatalf("stored signCount = %d, want 2", updated.SignCount)
	}
}

func TestVerifyAssertionAcceptsSignedEdDSA(t *testing.T) {
	ctx := context.Background()
	fixture := newEd25519Fixture(t, 0)
	fs := newMemoryFileSystem(renderCredential(fixture.credential))
	capability := newCapability(fs)
	ticket := mustChallenge(t, capability, testAction)
	assertion := fixture.assertion(t, ticket, assertionOptions{counter: 0})

	response := mustVerify(t, capability, ctx, assertion)
	if !response.Verified || response.Action != testAction {
		t.Fatalf("VerifyResponse = %#v, want verified action %q", response, testAction)
	}

	updated := mustReadCredential(t, fs)
	if updated.SignCount != 0 {
		t.Fatalf("stored signCount = %d, want zero-counter authenticator to remain zero", updated.SignCount)
	}
}

func TestChallengeMintsFreshRandomServerSideChallenges(t *testing.T) {
	capability := newCapability(newMemoryFileSystem(nil))

	first := mustChallenge(t, capability, testAction)
	second := mustChallenge(t, capability, testAction)

	if first.Action != testAction || second.Action != testAction {
		t.Fatalf("Challenge actions = %q/%q, want %q", first.Action, second.Action, testAction)
	}
	if first.Ceremony != challengeCeremonyGet || second.Ceremony != challengeCeremonyGet {
		t.Fatalf("Challenge ceremonies = %q/%q, want %q", first.Ceremony, second.Ceremony, challengeCeremonyGet)
	}
	if first.Challenge == second.Challenge {
		t.Fatalf("Challenge minted duplicate nonce %q", first.Challenge)
	}
	for _, ticket := range []ChallengeTicket{first, second} {
		decoded, err := base64.RawURLEncoding.DecodeString(ticket.Challenge)
		if err != nil {
			t.Fatalf("Challenge %q is not base64url: %v", ticket.Challenge, err)
		}
		if len(decoded) != ownerChallengeBytes {
			t.Fatalf("Challenge decoded to %d bytes, want %d", len(decoded), ownerChallengeBytes)
		}
		if !ticket.ExpiresAt.After(time.Now().UTC()) {
			t.Fatalf("Challenge ExpiresAt = %s, want future expiry", ticket.ExpiresAt)
		}
	}
}

func TestRegistrationCeremonyChallengeIsActionBound(t *testing.T) {
	capability := newCapability(newMemoryFileSystem(nil))

	ticket := mustRegistrationChallenge(t, capability)
	if ticket.Action != ownerEnrollAction {
		t.Fatalf("registration challenge action = %q, want %q", ticket.Action, ownerEnrollAction)
	}
	if ticket.Ceremony != challengeCeremonyCreate {
		t.Fatalf("registration challenge ceremony = %q, want %q", ticket.Ceremony, challengeCeremonyCreate)
	}
	assertDenyError(t, capability.ConsumeRegistrationChallenge(ticket.Challenge, testAction), denyActionMismatch)

	ticket = mustRegistrationChallenge(t, capability)
	assertDenyError(t, capability.Consume(ticket.Challenge, ownerEnrollAction), denyActionMismatch)
}

func TestRegistrationCeremonyChallengeIsSingleUse(t *testing.T) {
	capability := newCapability(newMemoryFileSystem(nil))
	ticket := mustRegistrationChallenge(t, capability)

	if err := capability.ConsumeRegistrationChallenge(ticket.Challenge, ownerEnrollAction); err != nil {
		t.Fatalf("ConsumeRegistrationChallenge returned error: %v", err)
	}
	assertDenyError(t, capability.ConsumeRegistrationChallenge(ticket.Challenge, ownerEnrollAction), denyChallengeReplayed)
}

func TestRegistrationCeremonyChallengeExpires(t *testing.T) {
	capability := newCapability(newMemoryFileSystem(nil))
	now := time.Date(2026, 6, 24, 12, 0, 0, 0, time.UTC)
	capability.now = func() time.Time { return now }
	ticket := mustRegistrationChallenge(t, capability)

	capability.now = func() time.Time { return now.Add(defaultChallengeTTL + time.Second) }
	assertDenyError(t, capability.ConsumeRegistrationChallenge(ticket.Challenge, ownerEnrollAction), denyChallengeExpired)
}

func TestRegistrationCeremonyCrossCeremonyReplayRejected(t *testing.T) {
	ctx := context.Background()
	fixture := newES256Fixture(t, 0)
	fs := newMemoryFileSystem(renderCredential(fixture.credential))
	capability := newCapability(fs)

	createTicket := mustRegistrationChallenge(t, capability)
	createAssertion := fixture.assertion(t, createTicket, assertionOptions{action: ownerEnrollAction, counter: 1})
	response := mustVerify(t, capability, ctx, createAssertion)
	if response.Verified {
		t.Fatal("VerifyResponse.Verified = true for create ceremony challenge on get path")
	}
	if response.Reason != denyActionMismatch {
		t.Fatalf("VerifyResponse.Reason = %q, want %q", response.Reason, denyActionMismatch)
	}

	getTicket := mustChallenge(t, capability, ownerEnrollAction)
	assertDenyError(t, capability.ConsumeRegistrationChallenge(getTicket.Challenge, ownerEnrollAction), denyActionMismatch)
}

func TestRegistrationCeremonyHTTPSelectorMintsDistinctCreateAndDefaultGet(t *testing.T) {
	capability := newCapability(newMemoryFileSystem(nil))

	getTicket, err := capability.ChallengeForCeremony("", ownerEnrollAction)
	if err != nil {
		t.Fatalf("ChallengeForCeremony default get returned error: %v", err)
	}
	createTicket, err := capability.ChallengeForCeremony(challengeCeremonyCreate, "")
	if err != nil {
		t.Fatalf("ChallengeForCeremony create returned error: %v", err)
	}

	if getTicket.Ceremony != challengeCeremonyGet {
		t.Fatalf("default challenge ceremony = %q, want %q", getTicket.Ceremony, challengeCeremonyGet)
	}
	if createTicket.Ceremony != challengeCeremonyCreate {
		t.Fatalf("create challenge ceremony = %q, want %q", createTicket.Ceremony, challengeCeremonyCreate)
	}
	if createTicket.Action != ownerEnrollAction {
		t.Fatalf("create challenge action = %q, want %q", createTicket.Action, ownerEnrollAction)
	}
	if createTicket.Challenge == getTicket.Challenge {
		t.Fatalf("create/default get challenges both minted nonce %q", createTicket.Challenge)
	}

	assertDenyError(t, capability.Consume(createTicket.Challenge, createTicket.Action), denyActionMismatch)
	assertDenyError(t, capability.ConsumeRegistrationChallenge(getTicket.Challenge, getTicket.Action), denyActionMismatch)
}

func TestVerifyAssertionRejectsCallerSuppliedUnmintedChallenge(t *testing.T) {
	ctx := context.Background()
	fixture := newES256Fixture(t, 0)
	fs := newMemoryFileSystem(renderCredential(fixture.credential))
	capability := newCapability(fs)
	challenge := base64URL(bytes.Repeat([]byte{0x42}, ownerChallengeBytes))
	assertion := fixture.assertion(t, ChallengeTicket{Challenge: challenge, Action: testAction}, assertionOptions{counter: 1})

	response := mustVerify(t, capability, ctx, assertion)
	if response.Verified {
		t.Fatalf("VerifyResponse.Verified = true for unminted caller challenge")
	}
	if response.Reason != denyChallengeReplayed {
		t.Fatalf("VerifyResponse.Reason = %q, want %q", response.Reason, denyChallengeReplayed)
	}
	if got := mustReadCredential(t, fs).SignCount; got != 0 {
		t.Fatalf("stored signCount = %d after denied unminted challenge, want 0", got)
	}
}

func TestVerifyAssertionDenyCasesAreFailClosed(t *testing.T) {
	tests := []struct {
		name       string
		stored     uint32
		counter    uint32
		build      func(*testing.T, *Capability, testFixture) OwnerAssertion
		wantReason string
	}{
		{
			name:   "unknown credential",
			stored: 1,
			build: func(t *testing.T, capability *Capability, fixture testFixture) OwnerAssertion {
				assertion := fixture.assertion(t, mustChallenge(t, capability, testAction), assertionOptions{counter: 2})
				assertion.CredentialID = base64URL([]byte("unknown credential id"))
				return assertion
			},
			wantReason: denyUnknownCredential,
		},
		{
			name:   "replayed challenge",
			stored: 1,
			build: func(t *testing.T, capability *Capability, fixture testFixture) OwnerAssertion {
				ticket := mustChallenge(t, capability, testAction)
				assertion := fixture.assertion(t, ticket, assertionOptions{counter: 2})
				response := mustVerify(t, capability, context.Background(), assertion)
				if !response.Verified {
					t.Fatalf("setup verify denied: %#v", response)
				}
				return assertion
			},
			wantReason: denyChallengeReplayed,
		},
		{
			name:   "expired challenge",
			stored: 1,
			build: func(t *testing.T, capability *Capability, fixture testFixture) OwnerAssertion {
				now := time.Date(2026, 6, 24, 12, 0, 0, 0, time.UTC)
				capability.now = func() time.Time { return now }
				ticket := mustChallenge(t, capability, testAction)
				capability.now = func() time.Time { return now.Add(defaultChallengeTTL + time.Second) }
				return fixture.assertion(t, ticket, assertionOptions{counter: 2})
			},
			wantReason: denyChallengeExpired,
		},
		{
			name:   "different action",
			stored: 1,
			build: func(t *testing.T, capability *Capability, fixture testFixture) OwnerAssertion {
				ticket := mustChallenge(t, capability, "vita.owner.other-action")
				return fixture.assertion(t, ticket, assertionOptions{action: testAction, counter: 2})
			},
			wantReason: denyActionMismatch,
		},
		{
			name:   "bad signature",
			stored: 1,
			build: func(t *testing.T, capability *Capability, fixture testFixture) OwnerAssertion {
				return fixture.assertion(t, mustChallenge(t, capability, testAction), assertionOptions{counter: 2, tamperSignature: true})
			},
			wantReason: denyInvalidSignature,
		},
		{
			name:   "type mismatch",
			stored: 1,
			build: func(t *testing.T, capability *Capability, fixture testFixture) OwnerAssertion {
				return fixture.assertion(t, mustChallenge(t, capability, testAction), assertionOptions{counter: 2, clientType: "webauthn.create"})
			},
			wantReason: denyInvalidType,
		},
		{
			name:   "origin mismatch",
			stored: 1,
			build: func(t *testing.T, capability *Capability, fixture testFixture) OwnerAssertion {
				return fixture.assertion(t, mustChallenge(t, capability, testAction), assertionOptions{counter: 2, origin: "https://evil.example.com"})
			},
			wantReason: denyOriginMismatch,
		},
		{
			name:   "rpId hash mismatch",
			stored: 1,
			build: func(t *testing.T, capability *Capability, fixture testFixture) OwnerAssertion {
				return fixture.assertion(t, mustChallenge(t, capability, testAction), assertionOptions{counter: 2, rpIDForHash: "evil.example.com"})
			},
			wantReason: denyRPIDHashMismatch,
		},
		{
			name:   "UP flag clear",
			stored: 1,
			build: func(t *testing.T, capability *Capability, fixture testFixture) OwnerAssertion {
				return fixture.assertion(t, mustChallenge(t, capability, testAction), assertionOptions{counter: 2, flags: 0, useFlags: true})
			},
			wantReason: denyUserPresenceRequired,
		},
		{
			name:   "signCount regression",
			stored: 5,
			build: func(t *testing.T, capability *Capability, fixture testFixture) OwnerAssertion {
				return fixture.assertion(t, mustChallenge(t, capability, testAction), assertionOptions{counter: 5})
			},
			wantReason: denySignCountRegression,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fixture := newES256Fixture(t, tt.stored)
			fs := newMemoryFileSystem(renderCredential(fixture.credential))
			capability := newCapability(fs)
			assertion := tt.build(t, capability, fixture)
			prior := cloneBytes(fs.mustLiveBytes(t))

			response := mustVerify(t, capability, context.Background(), assertion)
			if response.Verified {
				t.Fatalf("VerifyResponse.Verified = true, want denial")
			}
			if response.Reason != tt.wantReason {
				t.Fatalf("VerifyResponse.Reason = %q, want %q", response.Reason, tt.wantReason)
			}
			assertSanitizedReason(t, response, assertion)
			if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
				t.Fatalf("denied assertion changed live credential: got %q want %q", got, prior)
			}
		})
	}
}

func TestApplyVerifyDeniedAssertionDoesNotAuthorizeTransaction(t *testing.T) {
	ctx := context.Background()
	fixture := newES256Fixture(t, 1)
	fs := newMemoryFileSystem(renderCredential(fixture.credential))
	capability := newCapability(fs)
	assertion := fixture.assertion(t, mustChallenge(t, capability, testAction), assertionOptions{counter: 2, tamperSignature: true})

	undo, err := capability.Apply(ctx, VerifyRequest{Assertion: assertion})
	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil for denied assertion", undo)
	}
	var denied *DenyError
	if !errors.As(err, &denied) {
		t.Fatalf("Apply error = %T %v, want DenyError", err, err)
	}
	if denied.Reason != denyInvalidSignature {
		t.Fatalf("DenyError.Reason = %q, want %q", denied.Reason, denyInvalidSignature)
	}
}

func TestApplyVerifyAcceptedAssertionReturnsUndoRestoringPriorSignCount(t *testing.T) {
	ctx := context.Background()
	fixture := newES256Fixture(t, 1)
	prior := renderCredential(fixture.credential)
	fs := newMemoryFileSystem(prior)
	capability := newCapability(fs)
	assertion := fixture.assertion(t, mustChallenge(t, capability, testAction), assertionOptions{counter: 2})

	undo, err := capability.Apply(ctx, VerifyRequest{Assertion: assertion})
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo")
	}
	if got := mustReadCredential(t, fs).SignCount; got != 2 {
		t.Fatalf("stored signCount after verify Apply = %d, want 2", got)
	}
	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
		t.Fatalf("live credential after Undo = %q, want exact prior bytes %q", got, prior)
	}
}

func TestEnrollRejectsInvalidCOSEAndInlinePrivateMaterialWithoutWriting(t *testing.T) {
	ctx := context.Background()
	priorCredential := newES256Fixture(t, 1).credential
	prior := renderCredential(priorCredential)
	valid := newES256Fixture(t, 0).credential
	tests := []struct {
		name      string
		mutate    func(OwnerCredential) OwnerCredential
		wantError string
	}{
		{
			name: "unparseable cose",
			mutate: func(credential OwnerCredential) OwnerCredential {
				credential.PublicKeyCOSE = base64URL([]byte("not a cose key"))
				return credential
			},
			wantError: "publicKeyCose",
		},
		{
			name: "wrong cose alg",
			mutate: func(credential OwnerCredential) OwnerCredential {
				credential.PublicKeyCOSE = base64URL(coseEC2PublicKey(t, coseAlgEdDSA, []byte{1}, []byte{2}))
				return credential
			},
			wantError: "publicKeyCose",
		},
		{
			name: "inline private key material",
			mutate: func(credential OwnerCredential) OwnerCredential {
				credential.AAGUID = "-----BEGIN PRIVATE KEY-----"
				return credential
			},
			wantError: "aaguid",
		},
		{
			name: "secret transport token",
			mutate: func(credential OwnerCredential) OwnerCredential {
				credential.Transports = []string{"usb", "private_key:abc"}
				return credential
			},
			wantError: "transports",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fs := newMemoryFileSystem(prior)
			capability := newCapability(fs)

			undo, err := capability.Apply(ctx, ApplyRequest{Desired: tt.mutate(valid)})
			if undo != nil {
				t.Fatalf("Apply returned undo %v, want nil", undo)
			}
			var invalid *InvalidRequestError
			if !errors.As(err, &invalid) {
				t.Fatalf("Apply error = %T %v, want InvalidRequestError", err, err)
			}
			if !strings.Contains(invalid.Reason, tt.wantError) {
				t.Fatalf("InvalidRequestError.Reason = %q, want to mention %q", invalid.Reason, tt.wantError)
			}
			if got := fs.mustLiveBytes(t); !reflect.DeepEqual(got, prior) {
				t.Fatalf("live credential = %q, want unchanged %q", got, prior)
			}
		})
	}
}

func TestStrictDecodeRejectsDuplicateAndUnknownFields(t *testing.T) {
	valid := newES256Fixture(t, 1).credential
	validJSON := string(bytes.TrimSpace(renderCredential(valid)))
	tests := []struct {
		name string
		raw  string
	}{
		{
			name: "duplicate desired",
			raw:  `{"desired":` + validJSON + `,"desired":` + validJSON + `}`,
		},
		{
			name: "unknown request field",
			raw:  `{"desired":` + validJSON + `,"privateKey":"nope"}`,
		},
		{
			name: "unknown credential field",
			raw:  `{"desired":` + strings.TrimSuffix(validJSON, "}") + `,"privateKey":"nope"}}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := DecodeRequest(json.RawMessage(tt.raw))
			if err == nil {
				t.Fatal("DecodeRequest returned nil error, want rejection")
			}
		})
	}
}

func TestValidatorsRejectPartialMalformedInputsWithoutPanic(t *testing.T) {
	tests := []struct {
		name string
		run  func() error
	}{
		{
			name: "zero apply request",
			run:  func() error { return (ApplyRequest{}).Validate() },
		},
		{
			name: "zero verify request",
			run:  func() error { return (VerifyRequest{}).Validate() },
		},
		{
			name: "malformed request envelope",
			run: func() error {
				_, err := DecodeRequest(json.RawMessage(`{"assertion":{"credentialId":null}}`))
				return err
			},
		},
		{
			name: "deep duplicate scanner rejection",
			run: func() error {
				_, err := DecodeRequest(json.RawMessage(`{"desired":{"credentialId":"a","credentialId":"b"}}`))
				return err
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			defer func() {
				if recovered := recover(); recovered != nil {
					t.Fatalf("validator panicked: %v", recovered)
				}
			}()
			if err := tt.run(); err == nil {
				t.Fatal("validator returned nil error, want rejection")
			}
		})
	}
}

func TestTestdataContainsNoPrivateKeyMaterial(t *testing.T) {
	root := filepath.Join("testdata")
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("ReadDir(%q) returned error: %v", root, err)
	}
	if len(entries) == 0 {
		t.Fatalf("%s must contain at least a no-key-material marker", root)
	}

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		content, err := os.ReadFile(filepath.Join(root, entry.Name()))
		if err != nil {
			t.Fatalf("ReadFile(%q) returned error: %v", entry.Name(), err)
		}
		assertNoPrivateMaterial(t, content)
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

func (fs *memoryFileSystem) Read(ctx context.Context) (ownerSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return ownerSnapshot{}, err
	}
	return ownerSnapshot{exists: fs.exists, bytes: cloneBytes(fs.live)}, nil
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
		return errSimulatedWrite
	}
	return nil
}

func (fs *memoryFileSystem) Replace(ctx context.Context, snapshot ownerSnapshot) error {
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
		t.Fatal("live credential does not exist")
	}
	return cloneBytes(fs.live)
}

type testFixture struct {
	credential OwnerCredential
	sign       func(*testing.T, []byte, []byte) []byte
}

type assertionOptions struct {
	action          string
	clientType      string
	counter         uint32
	flags           byte
	useFlags        bool
	origin          string
	rpIDForHash     string
	tamperSignature bool
}

func newES256Fixture(t *testing.T, signCount uint32) testFixture {
	t.Helper()

	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey returned error: %v", err)
	}
	x := paddedBytes(privateKey.X, 32)
	y := paddedBytes(privateKey.Y, 32)
	credential := baseCredential(signCount)
	credential.PublicKeyCOSE = base64URL(coseEC2PublicKey(t, coseAlgES256, x, y))
	credential.Transports = []string{"internal", "usb"}

	return testFixture{
		credential: credential,
		sign: func(t *testing.T, authenticatorData, clientDataJSON []byte) []byte {
			t.Helper()
			message := signatureBase(authenticatorData, clientDataJSON)
			digest := sha256.Sum256(message)
			signature, err := ecdsa.SignASN1(rand.Reader, privateKey, digest[:])
			if err != nil {
				t.Fatalf("SignASN1 returned error: %v", err)
			}
			return signature
		},
	}
}

func newEd25519Fixture(t *testing.T, signCount uint32) testFixture {
	t.Helper()

	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey returned error: %v", err)
	}
	credential := baseCredential(signCount)
	credential.PublicKeyCOSE = base64URL(coseOKPPublicKey(t, publicKey))
	credential.Transports = []string{"internal"}

	return testFixture{
		credential: credential,
		sign: func(t *testing.T, authenticatorData, clientDataJSON []byte) []byte {
			t.Helper()
			return ed25519.Sign(privateKey, signatureBase(authenticatorData, clientDataJSON))
		},
	}
}

func baseCredential(signCount uint32) OwnerCredential {
	return OwnerCredential{
		CredentialID: base64URL([]byte("test credential id 0123456789")),
		SignCount:    signCount,
		AAGUID:       "00000000-0000-0000-0000-000000000000",
		RPID:         testRPID,
		UserHandle:   base64URL([]byte("owner")),
	}
}

func (f testFixture) assertion(t *testing.T, ticket ChallengeTicket, options assertionOptions) OwnerAssertion {
	t.Helper()

	action := options.action
	if action == "" {
		action = ticket.Action
	}
	clientType := options.clientType
	if clientType == "" {
		clientType = webauthnGetType
	}
	origin := options.origin
	if origin == "" {
		origin = "https://" + f.credential.RPID
	}
	rpIDForHash := options.rpIDForHash
	if rpIDForHash == "" {
		rpIDForHash = f.credential.RPID
	}
	flags := byte(authenticatorFlagUP)
	if options.useFlags {
		flags = options.flags
	}

	authenticatorData := makeAuthenticatorData(rpIDForHash, flags, options.counter)
	clientDataJSON := mustJSON(t, map[string]string{
		"type":      clientType,
		"challenge": ticket.Challenge,
		"origin":    origin,
	})
	signature := f.sign(t, authenticatorData, clientDataJSON)
	if options.tamperSignature {
		signature = cloneBytes(signature)
		signature[len(signature)-1] ^= 0x01
	}

	return OwnerAssertion{
		CredentialID:      f.credential.CredentialID,
		AuthenticatorData: base64URL(authenticatorData),
		ClientDataJSON:    base64URL(clientDataJSON),
		Signature:         base64URL(signature),
		Action:            action,
	}
}

func makeAuthenticatorData(rpID string, flags byte, counter uint32) []byte {
	rpIDHash := sha256.Sum256([]byte(rpID))
	out := make([]byte, 37)
	copy(out[:32], rpIDHash[:])
	out[32] = flags
	binary.BigEndian.PutUint32(out[33:37], counter)
	return out
}

func signatureBase(authenticatorData, clientDataJSON []byte) []byte {
	clientHash := sha256.Sum256(clientDataJSON)
	signed := make([]byte, 0, len(authenticatorData)+len(clientHash))
	signed = append(signed, authenticatorData...)
	signed = append(signed, clientHash[:]...)
	return signed
}

func coseEC2PublicKey(t *testing.T, alg int64, x, y []byte) []byte {
	t.Helper()
	out := cborMapHeader(5)
	out = append(out, cborInt(1)...)
	out = append(out, cborInt(coseKeyTypeEC2)...)
	out = append(out, cborInt(3)...)
	out = append(out, cborInt(alg)...)
	out = append(out, cborInt(-1)...)
	out = append(out, cborInt(coseCrvP256)...)
	out = append(out, cborInt(-2)...)
	out = append(out, cborBytes(x)...)
	out = append(out, cborInt(-3)...)
	out = append(out, cborBytes(y)...)
	return out
}

func coseOKPPublicKey(t *testing.T, publicKey ed25519.PublicKey) []byte {
	t.Helper()
	out := cborMapHeader(4)
	out = append(out, cborInt(1)...)
	out = append(out, cborInt(coseKeyTypeOKP)...)
	out = append(out, cborInt(3)...)
	out = append(out, cborInt(coseAlgEdDSA)...)
	out = append(out, cborInt(-1)...)
	out = append(out, cborInt(coseCrvEd25519)...)
	out = append(out, cborInt(-2)...)
	out = append(out, cborBytes(publicKey)...)
	return out
}

func cborMapHeader(length uint64) []byte {
	return cborHeader(5, length)
}

func cborInt(value int64) []byte {
	if value >= 0 {
		return cborHeader(0, uint64(value))
	}
	return cborHeader(1, uint64(-1-value))
}

func cborBytes(value []byte) []byte {
	out := cborHeader(2, uint64(len(value)))
	out = append(out, value...)
	return out
}

func cborHeader(major byte, value uint64) []byte {
	prefix := major << 5
	switch {
	case value < 24:
		return []byte{prefix | byte(value)}
	case value <= 0xff:
		return []byte{prefix | 24, byte(value)}
	case value <= 0xffff:
		out := []byte{prefix | 25, 0, 0}
		binary.BigEndian.PutUint16(out[1:3], uint16(value))
		return out
	case value <= 0xffffffff:
		out := []byte{prefix | 26, 0, 0, 0, 0}
		binary.BigEndian.PutUint32(out[1:5], uint32(value))
		return out
	default:
		out := []byte{prefix | 27, 0, 0, 0, 0, 0, 0, 0, 0}
		binary.BigEndian.PutUint64(out[1:9], value)
		return out
	}
}

func paddedBytes(value *big.Int, size int) []byte {
	raw := value.Bytes()
	out := make([]byte, size)
	copy(out[size-len(raw):], raw)
	return out
}

func base64URL(value []byte) string {
	return base64.RawURLEncoding.EncodeToString(value)
}

func mustJSON(t *testing.T, value interface{}) []byte {
	t.Helper()
	out, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("Marshal returned error: %v", err)
	}
	return out
}

func mustChallenge(t *testing.T, capability *Capability, action string) ChallengeTicket {
	t.Helper()
	ticket, err := capability.Challenge(action)
	if err != nil {
		t.Fatalf("Challenge returned error: %v", err)
	}
	return ticket
}

func mustRegistrationChallenge(t *testing.T, capability *Capability) ChallengeTicket {
	t.Helper()
	ticket, err := capability.RegistrationChallenge()
	if err != nil {
		t.Fatalf("RegistrationChallenge returned error: %v", err)
	}
	return ticket
}

func mustVerify(t *testing.T, capability *Capability, ctx context.Context, assertion OwnerAssertion) VerifyResponse {
	t.Helper()
	response, err := capability.Handle(ctx, VerifyRequest{Assertion: assertion})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	verifyResponse, ok := response.(VerifyResponse)
	if !ok {
		t.Fatalf("Handle returned %T, want VerifyResponse", response)
	}
	return verifyResponse
}

func mustReadCredential(t *testing.T, fs *memoryFileSystem) OwnerCredential {
	t.Helper()
	credential, err := parseCredential(fs.mustLiveBytes(t))
	if err != nil {
		t.Fatalf("parseCredential returned error: %v", err)
	}
	return credential
}

func assertDenyError(t *testing.T, err error, wantReason string) {
	t.Helper()
	var denied *DenyError
	if !errors.As(err, &denied) {
		t.Fatalf("error = %T %v, want DenyError", err, err)
	}
	if denied.Reason != wantReason {
		t.Fatalf("DenyError.Reason = %q, want %q", denied.Reason, wantReason)
	}
}

func assertNoPrivateMaterial(t *testing.T, content []byte) {
	t.Helper()
	text := strings.ToLower(string(content))
	for _, forbidden := range []string{
		"-----begin private key-----",
		"openssh private key",
		"age-secret-key",
		"private_key",
		"privatekey",
		"seed phrase",
		"mnemonic",
	} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("content contains private material marker %q", forbidden)
		}
	}
}

func assertSanitizedReason(t *testing.T, response VerifyResponse, assertion OwnerAssertion) {
	t.Helper()
	for _, secret := range []string{
		assertion.CredentialID,
		assertion.AuthenticatorData,
		assertion.ClientDataJSON,
		assertion.Signature,
	} {
		if secret != "" && strings.Contains(response.Reason, secret) {
			t.Fatalf("deny reason %q echoed assertion material", response.Reason)
		}
	}
}
