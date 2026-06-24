package files

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestSharedGrantDecodeValidate(t *testing.T) {
	shared := decodeGrant(t, `{"name":"shared","root":"scope","shared":true,"roles":{"owner":"read-write","household-member":"read-only"}}`)
	if _, err := NewHandler(Options{StateRoot: t.TempDir(), Grants: []Grant{shared}}); err != nil {
		t.Fatalf("NewHandler valid shared grant returned error: %v", err)
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
			raw:  `{"name":"shared","root":"scope","access":"read-write","roles":{"owner":"read-write","household-member":"read-only"}}`,
			want: "both access and roles",
		},
		{
			name: "shared missing roles",
			raw:  `{"name":"shared","root":"scope","shared":true}`,
			want: "shared grant must declare roles",
		},
		{
			name: "unknown role",
			raw:  `{"name":"shared","root":"scope","shared":true,"roles":{"owner":"read-write","household-member":"read-only","guest":"read-only"}}`,
			want: "unknown role",
		},
		{
			name: "bad role value",
			raw:  `{"name":"shared","root":"scope","shared":true,"roles":{"owner":"admin","household-member":"read-only"}}`,
			want: "access must be read-only or read-write",
		},
		{
			name: "missing required role",
			raw:  `{"name":"shared","root":"scope","shared":true,"roles":{"owner":"read-write"}}`,
			want: "roles must include household-member",
		},
		{
			name: "shared false",
			raw:  `{"name":"shared","root":"scope","shared":false,"roles":{"owner":"read-write","household-member":"read-only"}}`,
			want: "shared must be true",
		},
		{
			name: "roles null",
			raw:  `{"name":"shared","root":"scope","shared":true,"roles":null}`,
			want: "roles must include owner and household-member",
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
}

func TestEffectiveAccess(t *testing.T) {
	flat := resolvedGrant{name: "flat", access: AccessReadOnly}
	for _, role := range []Role{RoleOwner, RoleHouseholdMember, Role("guest")} {
		access, ok := EffectiveAccess(flat, role)
		if !ok || access != AccessReadOnly {
			t.Fatalf("flat role %q access = %q, %v; want read-only true", role, access, ok)
		}
	}

	shared := resolvedGrant{
		name: "shared",
		roles: RoleAccessMap{
			RoleOwner:           AccessReadWrite,
			RoleHouseholdMember: AccessReadOnly,
		},
	}
	access, ok := EffectiveAccess(shared, RoleOwner)
	if !ok || access != AccessReadWrite {
		t.Fatalf("owner access = %q, %v; want read-write true", access, ok)
	}
	access, ok = EffectiveAccess(shared, RoleHouseholdMember)
	if !ok || access != AccessReadOnly {
		t.Fatalf("household-member access = %q, %v; want read-only true", access, ok)
	}

	missing := resolvedGrant{
		name:  "missing",
		roles: RoleAccessMap{RoleOwner: AccessReadWrite},
	}
	access, ok = EffectiveAccess(missing, RoleHouseholdMember)
	if ok || access != "" {
		t.Fatalf("missing role access = %q, %v; want empty false", access, ok)
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
