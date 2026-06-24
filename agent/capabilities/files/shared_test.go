package files

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestSharedGrantDecodeValidate(t *testing.T) {
	// A shared grant over an arbitrary SUBSET of the six roles parses; absent
	// roles simply have no access (least-privilege), not a misconfiguration.
	shared := decodeGrant(t, `{"name":"shared","root":"scope","shared":true,"roles":{"owner":"read-write","member":"read-only"}}`)
	if _, err := NewHandler(Options{StateRoot: t.TempDir(), Grants: []Grant{shared}}); err != nil {
		t.Fatalf("NewHandler valid shared grant returned error: %v", err)
	}

	// A shared grant listing ALL six roles parses.
	allSix := decodeGrant(t, `{"name":"all","root":"scope","shared":true,"roles":{"owner":"read-write","administrator":"read-write","member":"read-only","restricted-member":"read-only","guest":"forbidden","service":"read-only"}}`)
	if _, err := NewHandler(Options{StateRoot: t.TempDir(), Grants: []Grant{allSix}}); err != nil {
		t.Fatalf("NewHandler six-role shared grant returned error: %v", err)
	}

	flat := decodeGrant(t, `{"name":"flat","root":"scope","access":"read-only"}`)
	handler, err := NewHandler(Options{StateRoot: t.TempDir(), Grants: []Grant{flat}})
	if err != nil {
		t.Fatalf("NewHandler flat grant returned error: %v", err)
	}
	access, ok := EffectiveAccess(handler.grants["flat"], RoleOwner)
	if !ok || access != AccessReadOnly {
		t.Fatalf("flat effective access = %q, %v; want read-only true", access, ok)
	}

	tests := []struct {
		name string
		raw  string
		want string
	}{
		{
			name: "access and roles",
			raw:  `{"name":"shared","root":"scope","access":"read-write","roles":{"owner":"read-write","member":"read-only"}}`,
			want: "both access and roles",
		},
		{
			name: "shared missing roles",
			raw:  `{"name":"shared","root":"scope","shared":true}`,
			want: "shared grant must declare roles",
		},
		{
			name: "empty roles map",
			raw:  `{"name":"shared","root":"scope","shared":true,"roles":{}}`,
			want: "shared grant roles must not be empty",
		},
		{
			name: "unknown role (prior household-member name)",
			raw:  `{"name":"shared","root":"scope","shared":true,"roles":{"owner":"read-write","household-member":"read-only"}}`,
			want: "unknown role",
		},
		{
			name: "unknown role (root)",
			raw:  `{"name":"shared","root":"scope","shared":true,"roles":{"owner":"read-write","root":"read-only"}}`,
			want: "unknown role",
		},
		{
			name: "unknown role (7th value)",
			raw:  `{"name":"shared","root":"scope","shared":true,"roles":{"owner":"read-write","superuser":"read-only"}}`,
			want: "unknown role",
		},
		{
			name: "bad role value",
			raw:  `{"name":"shared","root":"scope","shared":true,"roles":{"owner":"admin","member":"read-only"}}`,
			want: "access must be read-only or read-write",
		},
		{
			name: "shared false",
			raw:  `{"name":"shared","root":"scope","shared":false,"roles":{"owner":"read-write","member":"read-only"}}`,
			want: "shared must be true",
		},
		{
			name: "roles null",
			raw:  `{"name":"shared","root":"scope","shared":true,"roles":null}`,
			want: "shared grant roles must not be empty",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			grant := decodeGrant(t, tt.raw)
			_, err := NewHandler(Options{StateRoot: t.TempDir(), Grants: []Grant{grant}})
			if err == nil {
				t.Fatal("NewHandler returned nil error, want rejection")
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("NewHandler error = %q, want %q", err.Error(), tt.want)
			}
		})
	}
}

func TestSharedGrantDecodeRejectsDuplicateKeys(t *testing.T) {
	var grant Grant
	err := json.Unmarshal([]byte(`{"name":"bad","name":"shared","root":"scope","access":"read-write"}`), &grant)
	if err == nil {
		t.Fatal("json.Unmarshal accepted duplicate grant key")
	}
	if !strings.Contains(err.Error(), "duplicate JSON object key") {
		t.Fatalf("duplicate-key error = %q, want duplicate key rejection", err.Error())
	}

	// Duplicate keys inside the roles map are likewise rejected by the strict
	// decoder.
	var dupRole Grant
	err = json.Unmarshal([]byte(`{"name":"shared","root":"scope","shared":true,"roles":{"owner":"read-write","owner":"read-only"}}`), &dupRole)
	if err == nil {
		t.Fatal("json.Unmarshal accepted duplicate role key")
	}
	if !strings.Contains(err.Error(), "duplicate JSON object key") {
		t.Fatalf("duplicate role-key error = %q, want duplicate key rejection", err.Error())
	}
}

func TestEffectiveAccess(t *testing.T) {
	// Flat grant: every role gets the flat access (no roles map).
	flat := resolvedGrant{name: "flat", access: AccessReadOnly}
	for _, role := range []Role{RoleOwner, RoleMember, RoleGuest, RoleService, Role("nonexistent")} {
		access, ok := EffectiveAccess(flat, role)
		if !ok || access != AccessReadOnly {
			t.Fatalf("flat role %q access = %q, %v; want read-only true", role, access, ok)
		}
	}

	// Shared grant over a subset of the six. Listed roles get exactly their
	// entry; UNLISTED roles (guest/restricted-member/service here) get NO access.
	shared := resolvedGrant{
		name: "shared",
		roles: RoleAccessMap{
			RoleOwner:         AccessReadWrite,
			RoleAdministrator: AccessReadOnly,
			RoleMember:        AccessReadOnly,
		},
	}
	access, ok := EffectiveAccess(shared, RoleOwner)
	if !ok || access != AccessReadWrite {
		t.Fatalf("owner access = %q, %v; want read-write true", access, ok)
	}
	access, ok = EffectiveAccess(shared, RoleMember)
	if !ok || access != AccessReadOnly {
		t.Fatalf("member access = %q, %v; want read-only true", access, ok)
	}

	// NO implicit hierarchy: administrator is listed read-only and does NOT
	// inherit member's (or owner's) access.
	access, ok = EffectiveAccess(shared, RoleAdministrator)
	if !ok || access != AccessReadOnly {
		t.Fatalf("administrator access = %q, %v; want read-only true (no hierarchy inheritance)", access, ok)
	}

	// Unlisted roles -> no access (fail closed) for every op.
	for _, role := range []Role{RoleGuest, RoleRestrictedMember, RoleService} {
		access, ok := EffectiveAccess(shared, role)
		if ok || access != "" {
			t.Fatalf("unlisted role %q access = %q, %v; want empty false", role, access, ok)
		}
	}

	// An explicit forbidden entry is also no-access.
	forbidden := resolvedGrant{
		name: "forbidden",
		roles: RoleAccessMap{
			RoleOwner: AccessReadWrite,
			RoleGuest: AccessForbidden,
		},
	}
	access, ok = EffectiveAccess(forbidden, RoleGuest)
	if ok || access != "" {
		t.Fatalf("forbidden role access = %q, %v; want empty false (no access)", access, ok)
	}
	access, ok = EffectiveAccess(forbidden, RoleOwner)
	if !ok || access != AccessReadWrite {
		t.Fatalf("owner access on guest-forbidden grant = %q, %v; want read-write true", access, ok)
	}
}

func TestSharedGrantForbiddenRoleValidatesAndAflatForbiddenRejects(t *testing.T) {
	// A shared grant may declare a role forbidden (denied even read).
	forbidden := decodeGrant(t, `{"name":"shared","root":"scope","shared":true,"roles":{"owner":"read-write","guest":"forbidden"}}`)
	if _, err := NewHandler(Options{StateRoot: t.TempDir(), Grants: []Grant{forbidden}}); err != nil {
		t.Fatalf("NewHandler guest-forbidden shared grant returned error: %v", err)
	}

	// "forbidden" is NOT a valid flat grant access.
	flat := decodeGrant(t, `{"name":"flat","root":"scope","access":"forbidden"}`)
	if _, err := NewHandler(Options{StateRoot: t.TempDir(), Grants: []Grant{flat}}); err == nil {
		t.Fatal("NewHandler accepted flat access=forbidden, want rejection")
	}
}

func decodeGrant(t *testing.T, raw string) Grant {
	t.Helper()

	var grant Grant
	if err := json.Unmarshal([]byte(raw), &grant); err != nil {
		t.Fatalf("json.Unmarshal(%s) returned error: %v", raw, err)
	}
	return grant
}
