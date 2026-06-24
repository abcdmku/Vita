package roles

import "testing"

func TestAllRolesIsExactlyTheSixSpecRolesDeterministicNoDups(t *testing.T) {
	got := AllRoles()
	if len(got) != 6 {
		t.Fatalf("AllRoles length = %d, want 6", len(got))
	}

	// Deterministic spec §11 order (owner first, service last).
	want := []Role{
		RoleOwner,
		RoleAdministrator,
		RoleMember,
		RoleRestrictedMember,
		RoleGuest,
		RoleService,
	}
	for i, role := range want {
		if got[i] != role {
			t.Fatalf("AllRoles()[%d] = %q, want %q", i, got[i], role)
		}
	}

	// No duplicates.
	seen := make(map[Role]bool, len(got))
	for _, role := range got {
		if seen[role] {
			t.Fatalf("AllRoles contains duplicate role %q", role)
		}
		seen[role] = true
	}

	// The exact string values, pinned (guards a silent rename).
	wantStrings := map[Role]string{
		RoleOwner:            "owner",
		RoleAdministrator:    "administrator",
		RoleMember:           "member",
		RoleRestrictedMember: "restricted-member",
		RoleGuest:            "guest",
		RoleService:          "service",
	}
	for role, str := range wantStrings {
		if string(role) != str {
			t.Fatalf("role %q has string %q, want %q", role, string(role), str)
		}
	}
}

func TestAllRolesReturnsACopy(t *testing.T) {
	first := AllRoles()
	first[0] = Role("tampered")
	second := AllRoles()
	if second[0] != RoleOwner {
		t.Fatalf("AllRoles()[0] after mutation of a prior copy = %q, want %q (must return a fresh copy)", second[0], RoleOwner)
	}
}

func TestValidAcceptsTheSixAndRejectsEverythingElse(t *testing.T) {
	for _, role := range AllRoles() {
		if !Valid(role) {
			t.Fatalf("Valid(%q) = false, want true", role)
		}
	}

	for _, bad := range []Role{
		"household-member", // the prior P1-073 name is NOT valid (renamed to member)
		"",
		"Owner",
		"OWNER",
		"root",
		"admin",
		"superuser",
		"members",
		"guest ", // trailing space
		" guest",
	} {
		if Valid(bad) {
			t.Fatalf("Valid(%q) = true, want false", bad)
		}
	}
}

func TestParseRoleParsesTheSixAndRejectsEverythingElse(t *testing.T) {
	for _, role := range AllRoles() {
		got, ok := ParseRole(string(role))
		if !ok || got != role {
			t.Fatalf("ParseRole(%q) = %q, %v; want %q, true", role, got, ok, role)
		}
	}

	for _, bad := range []string{
		"household-member",
		"",
		"Owner",
		"GUEST",
		"root",
		"admin",
		"member ",
		"7th-role",
	} {
		got, ok := ParseRole(bad)
		if ok || got != "" {
			t.Fatalf("ParseRole(%q) = %q, %v; want \"\", false (no aliasing/case-fold/empty-default)", bad, got, ok)
		}
	}
}

func TestDefaultRoleIsLeastPrivilegedGuest(t *testing.T) {
	if DefaultRole != RoleGuest {
		t.Fatalf("DefaultRole = %q, want %q (least-privilege; an unbound stranger is a guest, never owner/member)", DefaultRole, RoleGuest)
	}
	// Explicit negative assertions: the unconfigured default must NOT be a
	// household-standing role.
	if DefaultRole == RoleOwner {
		t.Fatal("DefaultRole must not be owner (no owner-by-absence)")
	}
	if DefaultRole == RoleMember || DefaultRole == RoleAdministrator {
		t.Fatal("DefaultRole must not be a household role (least-privilege default is guest)")
	}
	if !Valid(DefaultRole) {
		t.Fatalf("DefaultRole %q is not a valid role", DefaultRole)
	}
}
