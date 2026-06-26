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
// one closed spec section 11 role. The desktop host is represented by the existing
// service role; there is no transport-local role value or inheritance.
type UnixPeerRoleBinding struct {
	PrincipalKey string
	Role         identityroles.Role
}

type desktopHostScope struct {
	roles map[string]identityroles.Role
}

func newDesktopHostScope(bindings []UnixPeerRoleBinding) (desktopHostScope, error) {
	if len(bindings) == 0 {
		return desktopHostScope{}, nil
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

	return desktopHostScope{roles: roles}, nil
}

func (s desktopHostScope) isDesktopHostPeer(ctx context.Context) bool {
	principalKeys, ok := unixPeerPrincipalKeysFromContext(ctx)
	if !ok {
		return false
	}

	role, ok := s.resolveRole(principalKeys)
	return ok && role == identityroles.RoleService
}

func (s desktopHostScope) resolveRole(principalKeys []string) (identityroles.Role, bool) {
	if len(s.roles) == 0 {
		return "", false
	}
	for _, key := range principalKeys {
		if role, ok := s.roles[key]; ok {
			return role, true
		}
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
	if !h.desktopHostScope.isDesktopHostPeer(ctx) || h.desktopHostScope.allowsCapability(name) {
		return nil
	}

	h.recordDesktopHostScopeForbidden(ctx, operation)
	return desktopHostScopeForbidden()
}

func (h *handler) authorizeDesktopHostApply(ctx context.Context, operations []rawOperation) *requestError {
	if !h.desktopHostScope.isDesktopHostPeer(ctx) {
		return nil
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
