package files

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/vita/agent/identity/roles"
	"github.com/vita/agent/internal/jsonsafe"
)

// Role is the household role a principal is bound to. The closed six-role set
// (spec §11) lives in the identity/roles package — the single source of truth —
// and the files capability simply re-uses it; there is no files-local role enum.
// member is the spec §11 name for the role P1-073 shipped as "household-member".
type Role = roles.Role

const (
	RoleOwner            = roles.RoleOwner
	RoleAdministrator    = roles.RoleAdministrator
	RoleMember           = roles.RoleMember
	RoleRestrictedMember = roles.RoleRestrictedMember
	RoleGuest            = roles.RoleGuest
	RoleService          = roles.RoleService

	// DefaultRole is the role agentd assigns a principal with NO configured
	// binding: the strictly least-privileged guest (a stranger, no household
	// access) — never owner, never a household role by absence. This is the
	// deliberate six-role tightening vs P1-073 (which defaulted household-member).
	DefaultRole = roles.DefaultRole
)

type Principal struct {
	PrincipalKey string `json:"principalKey"`
	Role         Role   `json:"role"`
}

type RoleAccessMap map[Role]Access

type principalKeyContextKey struct{}

// ContextWithPrincipalKey binds a single agentd-resolved principal key for the
// request. It is shorthand for ContextWithPrincipalKeys with one candidate.
func ContextWithPrincipalKey(ctx context.Context, principalKey string) context.Context {
	return ContextWithPrincipalKeys(ctx, []string{principalKey})
}

// ContextWithPrincipalKeys binds the ordered set of principal-key candidates the
// transport derived from the authenticated peer (most specific first). The role
// is resolved from the FIRST candidate with a configured binding; an unbound
// peer falls through to the least-privileged DefaultRole. The keys come only
// from agentd-side connection context, never from request content.
func ContextWithPrincipalKeys(ctx context.Context, principalKeys []string) context.Context {
	cleaned := make([]string, 0, len(principalKeys))
	for _, key := range principalKeys {
		if key != "" {
			cleaned = append(cleaned, key)
		}
	}
	if len(cleaned) == 0 {
		return ctx
	}
	return context.WithValue(ctx, principalKeyContextKey{}, cleaned)
}

// PrincipalKeyFromContext returns the most specific bound principal-key
// candidate, if any. Retained for the single-key callers; role resolution uses
// the full ordered set via PrincipalKeysFromContext.
func PrincipalKeyFromContext(ctx context.Context) (string, bool) {
	keys, ok := PrincipalKeysFromContext(ctx)
	if !ok {
		return "", false
	}
	return keys[0], true
}

func PrincipalKeysFromContext(ctx context.Context) ([]string, bool) {
	principalKeys, ok := ctx.Value(principalKeyContextKey{}).([]string)
	if !ok || len(principalKeys) == 0 {
		return nil, false
	}
	return principalKeys, true
}

func (g *Grant) UnmarshalJSON(raw []byte) error {
	var decoded struct {
		Name   string          `json:"name"`
		Root   string          `json:"root"`
		Access json.RawMessage `json:"access,omitempty"`
		Shared json.RawMessage `json:"shared,omitempty"`
		Roles  json.RawMessage `json:"roles,omitempty"`
	}
	if err := jsonsafe.DecodeStrict(raw, &decoded); err != nil {
		return err
	}

	grant := Grant{
		Name:      decoded.Name,
		Root:      decoded.Root,
		accessSet: decoded.Access != nil,
		sharedSet: decoded.Shared != nil,
		rolesSet:  decoded.Roles != nil,
	}
	if decoded.Access != nil && !isJSONNull(decoded.Access) {
		var access Access
		if err := jsonsafe.DecodeStrict(decoded.Access, &access); err != nil {
			return err
		}
		grant.Access = access
	}
	if decoded.Shared != nil && !isJSONNull(decoded.Shared) {
		var shared bool
		if err := jsonsafe.DecodeStrict(decoded.Shared, &shared); err != nil {
			return err
		}
		grant.Shared = &shared
	}
	if decoded.Roles != nil && !isJSONNull(decoded.Roles) {
		var roles RoleAccessMap
		if err := jsonsafe.DecodeStrict(decoded.Roles, &roles); err != nil {
			return err
		}
		grant.Roles = roles
	}

	*g = grant
	return nil
}

func EffectiveAccess(grant resolvedGrant, role Role) (Access, bool) {
	if grant.roles == nil {
		return grant.access, true
	}
	access, ok := grant.roles[role]
	if !ok || access == AccessForbidden {
		// No entry, or an explicit forbidden entry: the role has NO access at
		// all. Fail closed for every op (role_forbidden), distinct from a
		// read-only role (which may read) and from a flat read-only grant.
		return "", false
	}
	return access, ok
}

func validateGrantAccess(grant Grant) (Access, RoleAccessMap, error) {
	hasFlatAccess := grantHasFlatAccess(grant)
	hasShared := grantHasShared(grant)
	hasRoles := grantHasRoles(grant)

	if hasShared {
		if grant.Shared == nil || !*grant.Shared {
			return "", nil, errors.New("shared must be true when present")
		}
		if !hasRoles {
			return "", nil, errors.New("shared grant must declare roles")
		}
	}
	if hasFlatAccess && hasRoles {
		return "", nil, errors.New("grant must not set both access and roles")
	}
	if hasRoles {
		roles, err := validateRoleAccessMap(grant.Roles)
		if err != nil {
			return "", nil, err
		}
		return "", roles, nil
	}

	switch grant.Access {
	case AccessReadOnly, AccessReadWrite:
		return grant.Access, nil, nil
	default:
		return "", nil, errors.New("access must be read-only or read-write")
	}
}

func buildPrincipalRoles(principals []Principal) (map[string]Role, error) {
	roles := make(map[string]Role, len(principals))
	for i, principal := range principals {
		if err := validatePrincipal(principal); err != nil {
			return nil, fmt.Errorf("principal %d: %w", i, err)
		}
		if _, exists := roles[principal.PrincipalKey]; exists {
			return nil, fmt.Errorf("principal %d: duplicate principal key %q", i, principal.PrincipalKey)
		}
		roles[principal.PrincipalKey] = principal.Role
	}
	return roles, nil
}

func validatePrincipal(principal Principal) error {
	if principal.PrincipalKey == "" || strings.ContainsRune(principal.PrincipalKey, '\x00') {
		return errors.New("principalKey must be non-empty and contain no NUL")
	}
	if !validRole(principal.Role) {
		return errors.New("role must be one of the six household roles")
	}
	return nil
}

// validateRoleAccessMap validates a shared grant's roles map over the CLOSED
// six-role set (spec §11). It is fail-closed and least-privilege:
//   - an empty/nil roles map is rejected (a shared grant must admit at least one
//     role; an empty map could otherwise be read as "open to all" — it is not);
//   - an UNKNOWN role key (anything outside the six, e.g. "household-member",
//     "root", a 7th value) is rejected;
//   - a role VALUE that is not read-only/read-write/forbidden is rejected.
//
// There is NO "must include owner and member" requirement: a role simply ABSENT
// from the map has NO access (role_forbidden for every op) — exclusion by
// omission is the least-privilege default, not a misconfiguration. There is NO
// implicit hierarchy — each role's access is exactly what the map lists for it.
func validateRoleAccessMap(grantRoles RoleAccessMap) (RoleAccessMap, error) {
	if len(grantRoles) == 0 {
		return nil, errors.New("shared grant roles must not be empty")
	}
	for role, access := range grantRoles {
		if !validRole(role) {
			return nil, fmt.Errorf("unknown role %q", role)
		}
		if !validRoleAccess(access) {
			return nil, fmt.Errorf("role %q access must be read-only or read-write", role)
		}
	}

	copied := make(RoleAccessMap, len(grantRoles))
	for role, access := range grantRoles {
		copied[role] = access
	}
	return copied, nil
}

func grantHasFlatAccess(grant Grant) bool {
	return grant.accessSet || grant.Access != ""
}

func grantHasShared(grant Grant) bool {
	return grant.sharedSet || grant.Shared != nil
}

func grantHasRoles(grant Grant) bool {
	return grant.rolesSet || grant.Roles != nil
}

// validRole reports whether role is one of the closed six spec §11 roles. It is
// the single membership gate for both principal bindings and shared-grant role
// keys, delegating to the identity/roles source of truth.
func validRole(role Role) bool {
	return roles.Valid(role)
}

func validAccess(access Access) bool {
	switch access {
	case AccessReadOnly, AccessReadWrite:
		return true
	default:
		return false
	}
}

// validRoleAccess accepts the values a per-role grant entry may hold: read-only,
// read-write, or forbidden (no access). Forbidden is valid ONLY inside a shared
// grant's roles map, never as a flat grant access (validateGrantAccess keeps the
// flat access restricted to read-only/read-write).
func validRoleAccess(access Access) bool {
	return access == AccessForbidden || validAccess(access)
}

func isJSONNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}
