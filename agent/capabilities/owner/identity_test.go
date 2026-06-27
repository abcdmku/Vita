package owner

import (
	"context"
	"encoding/base64"
	"strings"
	"testing"
)

// TestResolveOwnerIdentityFromEnrolledCredential proves the live owner-auth path resolves
// the node's PUBLIC owner identity from the enrolled credential — a stable id derived from
// the public userHandle, a display username from the public rpId — with NO key material.
func TestResolveOwnerIdentityFromEnrolledCredential(t *testing.T) {
	ctx := context.Background()
	fixture := newES256Fixture(t, 1)
	fs := newMemoryFileSystem(renderCredential(fixture.credential))
	capability := newCapability(fs)

	result, err := capability.ResolveOwnerIdentity(ctx)
	if err != nil {
		t.Fatalf("ResolveOwnerIdentity returned error: %v", err)
	}
	if !result.Enrolled {
		t.Fatal("expected Enrolled=true for a node with an owner credential")
	}

	// rpId is "owner.example.com" → username "owner" (leftmost public label).
	if result.Identity.Username != "owner" {
		t.Fatalf("username = %q, want %q", result.Identity.Username, "owner")
	}
	// userHandle is base64url("owner") → stable "owner:<userHandle>" id.
	wantUUID := "owner:" + base64.RawURLEncoding.EncodeToString([]byte("owner"))
	if result.Identity.UUID != wantUUID {
		t.Fatalf("uuid = %q, want %q", result.Identity.UUID, wantUUID)
	}
	if !result.Identity.EmailConfirmed {
		t.Fatal("EmailConfirmed = false, want true for the enrolled owner")
	}

	// §16: the resolved identity must NOT leak the public key bytes or any credential
	// secret material — only the public userHandle + rpId-derived fields.
	if strings.Contains(result.Identity.UUID, fixture.credential.PublicKeyCOSE) ||
		strings.Contains(result.Identity.Username, fixture.credential.PublicKeyCOSE) {
		t.Fatal("resolved owner identity leaked public-key material")
	}
}

// TestResolveOwnerIdentityNotEnrolled proves a node with no owner credential resolves to
// Enrolled=false (the owner-auth path then falls back to the default, never inventing one).
func TestResolveOwnerIdentityNotEnrolled(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(nil)
	capability := newCapability(fs)

	result, err := capability.ResolveOwnerIdentity(ctx)
	if err != nil {
		t.Fatalf("ResolveOwnerIdentity returned error: %v", err)
	}
	if result.Enrolled {
		t.Fatal("expected Enrolled=false for a node with no owner credential")
	}
	if result.Identity != (OwnerIdentity{}) {
		t.Fatalf("expected zero identity when unenrolled, got %#v", result.Identity)
	}
}

// TestResolveOwnerIdentityFailsClosedOnCorruptCredential proves a present-but-unreadable
// credential is an error (fail-closed) — the auth path must not invent an owner from junk.
func TestResolveOwnerIdentityFailsClosedOnCorruptCredential(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem([]byte("{ not a valid credential"))
	capability := newCapability(fs)

	if _, err := capability.ResolveOwnerIdentity(ctx); err == nil {
		t.Fatal("ResolveOwnerIdentity accepted a corrupt credential (must fail closed)")
	}
}

// TestOwnerIdentityFromCredentialDeterministicAndPublicOnly proves the derivation is pure
// and uses only public fields (different userHandle/rpId → different identity).
func TestOwnerIdentityFromCredentialDeterministicAndPublicOnly(t *testing.T) {
	cred := baseCredential(0)
	cred.RPID = "lewis.vita.local"
	cred.UserHandle = base64URL([]byte("lewis-handle"))

	a := ownerIdentityFromCredential(cred)
	b := ownerIdentityFromCredential(cred)
	if a != b {
		t.Fatalf("ownerIdentityFromCredential not deterministic: %#v vs %#v", a, b)
	}
	if a.Username != "lewis" {
		t.Fatalf("username = %q, want %q (leftmost rpId label)", a.Username, "lewis")
	}
	wantUUID := "owner:" + base64.RawURLEncoding.EncodeToString([]byte("lewis-handle"))
	if a.UUID != wantUUID {
		t.Fatalf("uuid = %q, want %q", a.UUID, wantUUID)
	}
}
