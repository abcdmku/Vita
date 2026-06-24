package files

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/vita/agent/internal/jsonsafe"
)

type Role string

const (
	RoleOwner           Role = "owner"
	RoleHouseholdMember Role = "household-member"

	DefaultRole = RoleHouseholdMember
)

type Principal struct {
	PrincipalKey string `json:"principalKey"`
	Role         Role   `json:"role"`
}

type RoleAccessMap map[Role]Access

type principalKeyContextKey struct{}

func ContextWithPrincipalKey(ctx context.Context, principalKey string) context.Context {
	if principalKey == "" {
		return ctx
	}
	return context.WithValue(ctx, principalKeyContextKey{}, principalKey)
}

func PrincipalKeyFromContext(ctx context.Context) (string, bool) {
	principalKey, ok := ctx.Value(principalKeyContextKey{}).(string)
	if !ok || principalKey == "" {
		return "", false
	}
	return principalKey, true
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
		return errors.New("role must be owner or household-member")
	}
	return nil
}

func validateRoleAccessMap(roles RoleAccessMap) (RoleAccessMap, error) {
	if roles == nil {
		return nil, errors.New("roles must include owner and household-member")
	}
	for role, access := range roles {
		if !validRole(role) {
			return nil, fmt.Errorf("unknown role %q", role)
		}
		if !validAccess(access) {
			return nil, fmt.Errorf("role %q access must be read-only or read-write", role)
		}
	}
	for _, role := range []Role{RoleOwner, RoleHouseholdMember} {
		if _, ok := roles[role]; !ok {
			return nil, fmt.Errorf("roles must include %s", role)
		}
	}

	copied := make(RoleAccessMap, len(roles))
	for role, access := range roles {
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

func validRole(role Role) bool {
	switch role {
	case RoleOwner, RoleHouseholdMember:
		return true
	default:
		return false
	}
}

func validAccess(access Access) bool {
	switch access {
	case AccessReadOnly, AccessReadWrite:
		return true
	default:
		return false
	}
}

func isJSONNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}
