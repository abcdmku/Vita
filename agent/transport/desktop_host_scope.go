package transport

import (
	"context"
	"fmt"
	"net/http"

	"github.com/vita/agent/capabilities/capsule"
	"github.com/vita/agent/capabilities/nodeconfig"
	identityroles "github.com/vita/agent/identity/roles"
	"github.com/vita/agent/internal/auditlog"
)

const (
	desktopHostFilesCapability    = "files"
	desktopHostSettingsCapability = "settings"
	desktopHostStateCapability    = "state"
	desktopHostExportCapability   = "export"
	desktopHostAuditCapability    = "audit"

	desktopHostScopeForbiddenCode    = "capability_forbidden"
	desktopHostScopeForbiddenMessage = "capability is not allowed for desktop host"
	desktopHostScopeForbiddenReason  = "desktop_scope_forbidden"
)

// UnixPeerRoleBinding binds a kernel-authenticated unix peer principal key to
// one closed spec section 11 role. It does not by itself identify the desktop
// host; desktop scope is keyed by Config.DesktopHostPrincipalKeys, and the
// matching explicit desktop principal must be bound to the existing service
// role. There is no transport-local role value or inheritance.
type UnixPeerRoleBinding struct {
	PrincipalKey string
	Role         identityroles.Role
}

type desktopHostScope struct {
	desktopPrincipals map[string]struct{}
	roles             map[string]identityroles.Role
}

func newDesktopHostScope(desktopPrincipalKeys []string, bindings []UnixPeerRoleBinding) (desktopHostScope, error) {
	desktopPrincipals := make(map[string]struct{}, len(desktopPrincipalKeys))
	for i, key := range desktopPrincipalKeys {
		if key == "" {
			return desktopHostScope{}, fmt.Errorf("desktop host principal %d: principal key is required", i)
		}
		if _, exists := desktopPrincipals[key]; exists {
			return desktopHostScope{}, fmt.Errorf("desktop host principal %d: duplicate principal key %q", i, key)
		}
		desktopPrincipals[key] = struct{}{}
	}

	roles := make(map[string]identityroles.Role, len(bindings))
	for i, binding := range bindings {
		if binding.PrincipalKey == "" {
			return desktopHostScope{}, fmt.Errorf("unix peer role %d: principal key is required", i)
		}
		if !identityroles.Valid(binding.Role) {
			return desktopHostScope{}, fmt.Errorf("unix peer role %d: role must be one of the six household roles", i)
		}
		if _, exists := roles[binding.PrincipalKey]; exists {
			return desktopHostScope{}, fmt.Errorf("unix peer role %d: duplicate principal key %q", i, binding.PrincipalKey)
		}
		roles[binding.PrincipalKey] = binding.Role
	}

	for principalKey := range desktopPrincipals {
		if role, ok := roles[principalKey]; ok && role != identityroles.RoleService {
			return desktopHostScope{}, fmt.Errorf("desktop host principal %q role must be %q", principalKey, identityroles.RoleService)
		}
	}

	return desktopHostScope{
		desktopPrincipals: desktopPrincipals,
		roles:             roles,
	}, nil
}

func (s desktopHostScope) desktopHostPeerRole(ctx context.Context) (identityroles.Role, bool) {
	principalKeys, ok := unixPeerPrincipalKeysFromContext(ctx)
	if !ok {
		return "", false
	}

	for _, key := range principalKeys {
		if _, ok := s.desktopPrincipals[key]; !ok {
			continue
		}
		role, ok := s.roles[key]
		if !ok {
			return "", true
		}
		return role, true
	}
	return "", false
}

func (s desktopHostScope) allowsCapability(name string) bool {
	switch name {
	case desktopHostFilesCapability, capsule.ExecuteName, nodeconfig.Name, desktopHostSettingsCapability:
		return true
	default:
		return false
	}
}

func (h *handler) authorizeDesktopHostCapability(ctx context.Context, name string, operation auditlog.Operation) *requestError {
	role, ok := h.desktopHostScope.desktopHostPeerRole(ctx)
	if !ok {
		return nil
	}
	if role == identityroles.RoleService && h.desktopHostScope.allowsCapability(name) {
		return nil
	}

	h.recordDesktopHostScopeForbidden(ctx, operation)
	return desktopHostScopeForbidden()
}

func (h *handler) authorizeDesktopHostApply(ctx context.Context, operations []rawOperation) *requestError {
	role, ok := h.desktopHostScope.desktopHostPeerRole(ctx)
	if !ok {
		return nil
	}
	if role != identityroles.RoleService {
		h.recordDesktopHostScopeForbidden(ctx, auditlog.OperationApply)
		return desktopHostScopeForbidden()
	}

	for _, operation := range operations {
		if !h.desktopHostScope.allowsCapability(operation.Capability) {
			h.recordDesktopHostScopeForbidden(ctx, auditlog.OperationApply)
			return desktopHostScopeForbidden()
		}
	}
	return nil
}

func desktopHostScopeForbidden() *requestError {
	return &requestError{
		status:  http.StatusForbidden,
		code:    desktopHostScopeForbiddenCode,
		message: desktopHostScopeForbiddenMessage,
	}
}

func (h *handler) recordDesktopHostScopeForbidden(ctx context.Context, operation auditlog.Operation) {
	if h.auditStore == nil {
		return
	}

	actorID, ok := unixPeerAuditActorIDFromContext(ctx)
	if !ok {
		actorID = desktopHostScopeFallbackActorID(ctx)
	}

	_, _ = h.auditStore.Append(auditlog.Event{
		TimestampMillis: h.now().UTC().UnixMilli(),
		ActorKind:       auditlog.ActorKindSystem,
		ActorID:         actorID,
		Capability:      unixPeerAuthCapability,
		Operation:       operation,
		Outcome:         auditlog.OutcomeRejected,
		Reason:          desktopHostScopeForbiddenReason,
	})
}

func desktopHostScopeFallbackActorID(ctx context.Context) string {
	if principalKeys, ok := unixPeerPrincipalKeysFromContext(ctx); ok {
		return "peer:" + principalKeys[0]
	}
	return "peer:unknown"
}
