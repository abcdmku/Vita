package owner

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// identity.go surfaces the node's PUBLIC owner identity for the LIVE owner-auth path.
//
// §16 boundary: the owner HOLDS the private key (the WebAuthn authenticator's signing
// key never leaves the owner's device). The node only ever persists + consults the
// owner's PUBLIC enrolled credential (owner-credential.json: credentialId, the COSE
// PUBLIC key, rpId, userHandle — no private material). This file derives, from that
// public record, a small stable identity (a uuid-like stable id + a display username +
// an emailConfirmed flag) that the owner-auth path uses so a session is bound to the
// REAL enrolled owner rather than only to an opaque bearer token. It NEVER reads,
// returns, or derives anything from private key material — it only reads the public
// enrolled credential the node already stores.
//
// This is the Go counterpart of the platform server's resolveOwnerIdentity
// (ui_kits/desktop/runtime/puter/server/server-entry.ts): the on-device provisioning
// projects THIS identity into the platform's owner-identity record so the TS owner-auth
// path (/whoami, minted sessions) and the Go agentd owner-auth path agree on one owner.

// OwnerIdentity is the node's PUBLIC owner identity. It carries NO key material: only a
// stable identifier derived from the enrolled credential's public fields, a display
// username, and the email-confirmed flag. Shape mirrors the platform's PuterOwner so the
// two owner-auth paths describe one owner.
type OwnerIdentity struct {
	// UUID is a stable, opaque owner identifier derived ONLY from the enrolled
	// credential's public userHandle (the WebAuthn user.id the owner enrolled with). It
	// is deterministic for a given enrollment and reveals no key material.
	UUID string `json:"uuid"`
	// Username is the display handle for the owner. Derived from the credential's rpId
	// (the relying-party host the owner enrolled against). Public, non-secret.
	Username string `json:"username"`
	// EmailConfirmed is the single-owner trust flag; always true for the enrolled owner.
	EmailConfirmed bool `json:"emailConfirmed"`
}

// OwnerIdentityResult is the resolved identity plus whether an owner is enrolled. When
// Enrolled is false the node has no owner credential yet (first boot); the owner-auth
// path then falls back to the trust-on-host default rather than inventing an owner.
type OwnerIdentityResult struct {
	Enrolled bool
	Identity OwnerIdentity
}

// ResolveOwnerIdentity reads the node's persisted PUBLIC owner credential and projects
// the public owner identity the live owner-auth path consults. It NEVER touches private
// key material (the credential file holds only the public COSE key + public identifiers).
// On no enrollment it returns {Enrolled:false}; on a present-but-unreadable/invalid
// credential it returns an error (fail-closed — the caller must not invent an owner).
func (c *Capability) ResolveOwnerIdentity(ctx context.Context) (OwnerIdentityResult, error) {
	if c == nil || c.fs == nil {
		return OwnerIdentityResult{}, &InvalidRequestError{Reason: "missing owner filesystem"}
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	snapshot, err := c.fs.Read(ctx)
	if err != nil {
		return OwnerIdentityResult{}, err
	}
	if !snapshot.exists {
		return OwnerIdentityResult{Enrolled: false}, nil
	}

	credential, err := parseCredential(snapshot.bytes)
	if err != nil {
		return OwnerIdentityResult{}, err
	}

	return OwnerIdentityResult{
		Enrolled: true,
		Identity: ownerIdentityFromCredential(credential),
	}, nil
}

// DefaultOwnerIdentityFile is the conventional path the platform server reads the public
// owner identity from (VITA_OWNER_IDENTITY_FILE in server-entry.ts). The identity bridge
// writes the resolved public identity here so the TS owner-auth path (/whoami, minted
// sessions) and the Go agentd owner-auth path agree on ONE owner. Lives on the persistent
// /var partition; carries NO key material (only the public uuid/username/emailConfirmed).
const DefaultOwnerIdentityFile = "/var/lib/vita/owner/owner-identity.json"

// ownerIdentityFileMode is 0640: owner-readable, group-readable (the platform DynamicUser
// reads it via the shared group), world-unreadable. The file holds only the PUBLIC owner
// identity, but we keep it tight regardless.
const ownerIdentityFileMode = 0o640

// WriteOwnerIdentityFile is the IDENTITY BRIDGE: it projects a resolved OwnerIdentityResult
// into the platform's owner-identity record (the JSON server-entry.ts::readOwnerIdentity
// consumes). This is what makes the live owner-auth path use the REAL enrolled owner rather
// than the trust-on-host default. It writes ONLY the public identity (uuid, username,
// emailConfirmed) — never any key material.
//
// Fail-closed semantics:
//   - When the result is NOT enrolled (first boot, no owner credential), the bridge writes
//     NOTHING and returns (false, nil): the platform then keeps its trust-on-host default
//     rather than being handed a fabricated owner.
//   - When enrolled, the file is written ATOMICALLY (temp + rename) under `path` (its parent
//     dir is created 0700). A partial/torn file can never be read by the platform.
//
// Returns (wrote, err): wrote is true iff an identity file was written.
func WriteOwnerIdentityFile(path string, result OwnerIdentityResult) (bool, error) {
	if !result.Enrolled {
		return false, nil
	}
	if strings.TrimSpace(path) == "" {
		path = DefaultOwnerIdentityFile
	}

	// Marshal ONLY the public identity (the OwnerIdentity JSON tags are uuid/username/
	// emailConfirmed — exactly the fields the platform reads).
	payload, err := json.MarshalIndent(result.Identity, "", "  ")
	if err != nil {
		return false, fmt.Errorf("marshal owner identity: %w", err)
	}
	payload = append(payload, '\n')

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, stateRootMode); err != nil {
		return false, fmt.Errorf("create owner identity dir: %w", err)
	}

	// Atomic write: a temp file in the same dir, then rename over the target so a reader never
	// sees a half-written identity.
	tmp, err := os.CreateTemp(dir, ".owner-identity-*.tmp")
	if err != nil {
		return false, fmt.Errorf("create owner identity temp: %w", err)
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }

	if _, err := tmp.Write(payload); err != nil {
		_ = tmp.Close()
		cleanup()
		return false, fmt.Errorf("write owner identity temp: %w", err)
	}
	if err := tmp.Chmod(ownerIdentityFileMode); err != nil {
		_ = tmp.Close()
		cleanup()
		return false, fmt.Errorf("chmod owner identity temp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return false, fmt.Errorf("close owner identity temp: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		cleanup()
		return false, fmt.Errorf("rename owner identity: %w", err)
	}
	return true, nil
}

// ResolveAndWriteOwnerIdentity is the convenience the boot path calls: resolve the public
// owner identity from the enrolled credential, then write the platform identity file. It
// returns (wrote, err) so the caller can emit a boot witness reflecting whether the live
// owner-auth identity was provisioned.
func (c *Capability) ResolveAndWriteOwnerIdentity(ctx context.Context, path string) (bool, error) {
	result, err := c.ResolveOwnerIdentity(ctx)
	if err != nil {
		return false, err
	}
	return WriteOwnerIdentityFile(path, result)
}

// ownerIdentityFromCredential derives the PUBLIC owner identity from the enrolled
// credential's public fields. Pure + deterministic. Uses ONLY userHandle (the public
// WebAuthn user.id) and rpId (the public relying-party host) — never the public key
// bytes and never any private material.
func ownerIdentityFromCredential(credential OwnerCredential) OwnerIdentity {
	return OwnerIdentity{
		UUID:           ownerUUIDFromUserHandle(credential.UserHandle),
		Username:       ownerUsernameFromRPID(credential.RPID),
		EmailConfirmed: true,
	}
}

// ownerUUIDFromUserHandle maps the public, base64url userHandle to a stable owner id.
// The userHandle IS the WebAuthn user.id the owner enrolled — a public, opaque handle —
// so a stable "owner:<userHandle>" identifier reveals nothing secret while remaining
// deterministic per enrollment. Falls back to a fixed sentinel if the handle is empty.
func ownerUUIDFromUserHandle(userHandle string) string {
	handle := strings.TrimSpace(userHandle)
	if handle == "" {
		return "owner:unknown"
	}
	// Defensive: confirm it decodes as base64url (it is validated on enrollment, but a
	// resolver must not propagate a malformed handle). On decode failure, still produce a
	// stable id from the raw handle bytes so the owner-auth path has a deterministic id.
	if _, err := base64.RawURLEncoding.DecodeString(handle); err != nil {
		return "owner:" + sanitizePublicToken(handle)
	}
	return "owner:" + handle
}

// ownerUsernameFromRPID derives a display username from the enrolled relying-party host.
// The rpId is the public domain the owner enrolled against (e.g. "owner.example.com");
// its leftmost label is a reasonable, non-secret display handle. Public only.
func ownerUsernameFromRPID(rpID string) string {
	host := strings.TrimSpace(rpID)
	if host == "" {
		return "owner"
	}
	label := host
	if dot := strings.IndexByte(host, '.'); dot > 0 {
		label = host[:dot]
	}
	label = sanitizePublicToken(label)
	if label == "" {
		return "owner"
	}
	return label
}

// sanitizePublicToken keeps only safe display characters from a public token, so a
// derived id/username never carries control characters or unexpected punctuation.
func sanitizePublicToken(value string) string {
	var b strings.Builder
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9',
			r == '-', r == '_', r == '.':
			b.WriteRune(r)
		}
	}
	return b.String()
}
