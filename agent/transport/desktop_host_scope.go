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

// DesktopHostUnixPeerInstall is the explicit, production desktop-host scope
// install for one pinned desktop-host uid. It returns BOTH the desktop principal
// key (so the connecting peer is classified as the desktop host) AND its
// RoleService binding (so the classified peer actually passes the fail-closed
// allowlist gate). Callers MUST feed both into Config — using them together is
// what makes the desktop-host scope INSTALLED rather than an optional zero-value:
// declaring the principal without this binding would (correctly) fail closed and
// deny the host on every capability.
//
// The desktop host is pinned by its own uid (not by the shared vita-agent group,
// which the runtime also holds) so the scope confines ONLY the desktop host and
// never the runtime. This keeps desktop-host identity EXPLICIT — a peer is the
// desktop host only when it presents this uid, never merely because it carries
// the generic service role.
func DesktopHostUnixPeerInstall(uid uint32) ([]string, UnixPeerRoleBinding) {
	principalKey := UnixPeerUserPrincipalKey(uid)
	return []string{principalKey}, UnixPeerRoleBinding{
		PrincipalKey: principalKey,
		Role:         identityroles.RoleService,
	}
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

	// A declared desktop principal bound to any NON-service role is a
	// misconfiguration and is rejected at construction. A declared desktop principal
	// with NO binding is allowed to build but is denied at request time
	// (isDesktopHostPeer returns an empty role -> desktopHostAllowed is false): an
	// identified desktop host that is not actually bound to the service role fails
	// closed rather than silently reaching the allowlist.
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

// isDesktopHostPeer reports whether the connection's kernel-authenticated peer
// principal keys identify the explicit desktop host. Classification is keyed off
// the SO_PEERCRED-derived principal keys only — never request content — and is
// EXPLICIT: a key counts as the desktop host only when it appears in
// Config.DesktopHostPrincipalKeys. A peer that merely holds RoleService (the
// generic service role) is NOT the desktop host.
//
// The returned bool is the gate; the role is reported for the fail-closed check
// below. When the matching desktop principal carries no service binding the role
// is empty AND ok is true, so the caller DENIES — an identified desktop host with
// no allowlist binding is forbidden, not allowed. (newDesktopHostScope already
// rejects a desktop principal bound to any non-service role at construction, so a
// present binding is always RoleService; the empty-role case is the unbound one.)
func (s desktopHostScope) isDesktopHostPeer(ctx context.Context) (identityroles.Role, bool) {
	principalKeys, ok := unixPeerPrincipalKeysFromContext(ctx)
	if !ok {
		return "", false
	}

	for _, key := range principalKeys {
		if _, ok := s.desktopPrincipals[key]; !ok {
			continue
		}
		role := s.roles[key]
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

// desktopHostAllowed reports whether an IDENTIFIED desktop host peer (already
// classified by isDesktopHostPeer) may reach capability name. It is fail-closed:
// the peer must carry the explicit service binding AND the capability must be on
// the default-deny allowlist. An empty role (identified desktop host with no
// matching service binding) is denied.
func (s desktopHostScope) desktopHostAllowed(role identityroles.Role, name string) bool {
	return role == identityroles.RoleService && s.allowsCapability(name)
}

func (h *handler) authorizeDesktopHostCapability(ctx context.Context, name string, operation auditlog.Operation) *requestError {
	role, isDesktopHost := h.desktopHostScope.isDesktopHostPeer(ctx)
	if !isDesktopHost {
		return nil
	}
	if h.desktopHostScope.desktopHostAllowed(role, name) {
		return nil
	}

	h.recordDesktopHostScopeForbidden(ctx, operation)
	return desktopHostScopeForbidden()
}

func (h *handler) authorizeDesktopHostApply(ctx context.Context, operations []rawOperation) *requestError {
	role, isDesktopHost := h.desktopHostScope.isDesktopHostPeer(ctx)
	if !isDesktopHost {
		return nil
	}

	for _, operation := range operations {
		if !h.desktopHostScope.desktopHostAllowed(role, operation.Capability) {
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
