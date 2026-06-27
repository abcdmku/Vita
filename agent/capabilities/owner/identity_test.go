package owner

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
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

// platformOwnerIdentity mirrors the JSON shape the platform server reads
// (server-entry.ts::readOwnerIdentity): uuid + username + emailConfirmed.
type platformOwnerIdentity struct {
	UUID           string `json:"uuid"`
	Username       string `json:"username"`
	EmailConfirmed bool   `json:"emailConfirmed"`
}

// TestWriteOwnerIdentityFileBridgesEnrolledOwner proves the IDENTITY BRIDGE: a resolved,
// enrolled owner identity is written to the platform identity file with exactly the public
// fields the platform reads (uuid/username/emailConfirmed) — and nothing else (no key
// material). This is finding #6's proving test.
func TestWriteOwnerIdentityFileBridgesEnrolledOwner(t *testing.T) {
	ctx := context.Background()
	fixture := newES256Fixture(t, 1)
	fs := newMemoryFileSystem(renderCredential(fixture.credential))
	capability := newCapability(fs)

	path := filepath.Join(t.TempDir(), "owner", "owner-identity.json")
	wrote, err := capability.ResolveAndWriteOwnerIdentity(ctx, path)
	if err != nil {
		t.Fatalf("ResolveAndWriteOwnerIdentity: %v", err)
	}
	if !wrote {
		t.Fatal("expected the identity bridge to write a file for an enrolled owner")
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read written identity: %v", err)
	}

	var got platformOwnerIdentity
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("written identity is not valid JSON the platform can read: %v", err)
	}

	// rpId "owner.example.com" → username "owner"; userHandle base64url("owner") → stable id.
	if got.Username != "owner" {
		t.Fatalf("username = %q, want %q", got.Username, "owner")
	}
	wantUUID := "owner:" + base64.RawURLEncoding.EncodeToString([]byte("owner"))
	if got.UUID != wantUUID {
		t.Fatalf("uuid = %q, want %q", got.UUID, wantUUID)
	}
	if !got.EmailConfirmed {
		t.Fatal("emailConfirmed = false, want true")
	}

	// §16: the bridged file must NOT contain any public-key/credential material.
	if strings.Contains(string(raw), fixture.credential.PublicKeyCOSE) ||
		strings.Contains(string(raw), fixture.credential.CredentialID) {
		t.Fatal("bridged owner identity file leaked credential material")
	}

	// The file is mode 0640 (or tighter) — never world-writable/readable. Unix perms are not
	// meaningful on Windows (NTFS does not honor chmod bits), so the perm assertion only runs on
	// the production GOOS (linux). The bridge always calls Chmod(0640); this confirms it on linux.
	if runtime.GOOS == "linux" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stat written identity: %v", err)
		}
		if perm := info.Mode().Perm(); perm&0o007 != 0 {
			t.Fatalf("identity file is world-accessible (perm %o)", perm)
		}
	}
}

// TestWriteOwnerIdentityFileSkipsUnenrolled proves a node with NO owner credential writes
// NO identity file — the platform then keeps its trust-on-host default rather than being
// handed a fabricated owner (fail-closed against inventing an owner).
func TestWriteOwnerIdentityFileSkipsUnenrolled(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(nil)
	capability := newCapability(fs)

	path := filepath.Join(t.TempDir(), "owner", "owner-identity.json")
	wrote, err := capability.ResolveAndWriteOwnerIdentity(ctx, path)
	if err != nil {
		t.Fatalf("ResolveAndWriteOwnerIdentity: %v", err)
	}
	if wrote {
		t.Fatal("expected NO file written for an unenrolled node")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("identity file should not exist for an unenrolled node, stat err = %v", err)
	}
}

// TestWriteOwnerIdentityFileAtomicOverwrite proves a re-provision atomically replaces an
// existing identity file (no torn write) and the result is the freshly resolved identity.
func TestWriteOwnerIdentityFileAtomicOverwrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "owner-identity.json")
	if err := os.WriteFile(path, []byte("STALE GARBAGE NOT JSON"), 0o600); err != nil {
		t.Fatalf("seed stale file: %v", err)
	}

	result := OwnerIdentityResult{
		Enrolled: true,
		Identity: OwnerIdentity{UUID: "owner:abc", Username: "lewis", EmailConfirmed: true},
	}
	wrote, err := WriteOwnerIdentityFile(path, result)
	if err != nil {
		t.Fatalf("WriteOwnerIdentityFile: %v", err)
	}
	if !wrote {
		t.Fatal("expected the file to be written")
	}

	var got platformOwnerIdentity
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("overwritten file is not valid JSON (torn write?): %v", err)
	}
	if got.UUID != "owner:abc" || got.Username != "lewis" || !got.EmailConfirmed {
		t.Fatalf("overwritten identity = %#v, want owner:abc/lewis/true", got)
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
