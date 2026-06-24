// Package roles defines the CLOSED household role set (spec §11) as a
// first-class identity concept, independent of any single capability. Roles bind
// AUTHENTICATED peer identities (SO_PEERCRED, P1-048/P1-073) to one of the six
// values; agentd alone resolves principal -> role from its own validated config
// keyed off the per-connection authenticated peer. The unprivileged runtime can
// never name, request, or widen its own role.
//
// The set is the spec §11 vocabulary exactly — no more, no fewer:
//
//	owner, administrator, member, restricted-member, guest, service
//
// member IS the role P1-073 shipped as "household-member"; this package renames
// it to the spec §11 name and is the single source of truth. There is NO role
// hierarchy or privilege ordering: a higher-sounding role does NOT implicitly
// inherit a lower role's grants and a lower role never silently inherits a
// higher one's. Every access is explicit per grant (see the files capability's
// roles map); this package only defines the closed set, validation, and the
// least-privilege default.
//
// DefaultRole is the role for a principal agentd has NO configured binding for.
// It is the strictly least-privileged role — guest, a stranger with no household
// access — never owner-by-absence. (P1-073 defaulted an unbound principal to
// household-member; the six-role model deliberately tightens the
// unconfigured-stranger default to the lower guest.)
package roles

// Role is one of the closed spec §11 household roles. A value outside AllRoles
// is invalid and is rejected (never aliased, case-folded, or defaulted) by
// ParseRole/Valid.
type Role string

const (
	// RoleOwner is the node owner (spec §11). Highest household standing, but it
	// inherits NOTHING implicitly — its access is whatever each grant lists for it.
	RoleOwner Role = "owner"
	// RoleAdministrator is a household administrator (spec §11). NOT an implicit
	// superset of member: its access is exactly what each grant lists for it.
	RoleAdministrator Role = "administrator"
	// RoleMember is an ordinary household member (spec §11). This is the spec name
	// for the role P1-073 shipped as "household-member"; the rename is the single
	// source of truth.
	RoleMember Role = "member"
	// RoleRestrictedMember is a restricted household member (spec §11).
	RoleRestrictedMember Role = "restricted-member"
	// RoleGuest is a guest / stranger (spec §11). It is the least-privileged role
	// and the default for any principal with no configured binding.
	RoleGuest Role = "guest"
	// RoleService is a machine / service principal (spec §11).
	RoleService Role = "service"

	// DefaultRole is the role for a principal with NO configured binding. It is
	// the strictly LEAST-privileged role (guest) so an unbound stranger has no
	// household access — never owner, never a household role by absence.
	DefaultRole = RoleGuest
)

// allRoles is the canonical ordered set. The order is deterministic and is the
// spec §11 listing order (owner first, service last); callers that need a stable
// listing rely on it.
var allRoles = [6]Role{
	RoleOwner,
	RoleAdministrator,
	RoleMember,
	RoleRestrictedMember,
	RoleGuest,
	RoleService,
}

// AllRoles returns the six spec §11 roles in a deterministic order (a fresh copy
// each call so callers cannot mutate the canonical set). Length is always 6 with
// no duplicates.
func AllRoles() []Role {
	out := make([]Role, len(allRoles))
	copy(out, allRoles[:])
	return out
}

// Valid reports whether r is exactly one of the six spec §11 roles. It is the
// closed-set membership test: "household-member", "", "Owner", "root", "admin",
// or any 7th value is NOT valid.
func Valid(r Role) bool {
	for _, role := range allRoles {
		if role == r {
			return true
		}
	}
	return false
}

// ParseRole maps a string to a Role, returning ok=false for any value outside
// the six. It performs NO aliasing, NO case-folding, and NO empty-string
// defaulting — an unknown or empty string is rejected (the DefaultRole is applied
// by the binding layer for an UNBOUND principal, never synthesized here).
func ParseRole(value string) (Role, bool) {
	role := Role(value)
	if Valid(role) {
		return role, true
	}
	return "", false
}
