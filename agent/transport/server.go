package transport

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/user"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/capabilities/accounts"
	"github.com/vita/agent/capabilities/backup"
	"github.com/vita/agent/capabilities/capsule"
	exportcap "github.com/vita/agent/capabilities/export"
	filecap "github.com/vita/agent/capabilities/files"
	"github.com/vita/agent/capabilities/hostname"
	"github.com/vita/agent/capabilities/identity"
	"github.com/vita/agent/capabilities/network"
	"github.com/vita/agent/capabilities/nodeconfig"
	"github.com/vita/agent/capabilities/owner"
	"github.com/vita/agent/capabilities/pdsrepo"
	"github.com/vita/agent/capabilities/pdssync"
	"github.com/vita/agent/capabilities/services"
	"github.com/vita/agent/capabilities/storage"
	nodetime "github.com/vita/agent/capabilities/time"
	"github.com/vita/agent/capabilities/timesync"
	"github.com/vita/agent/capabilities/update"
	"github.com/vita/agent/hardware"
	identityroles "github.com/vita/agent/identity/roles"
	"github.com/vita/agent/internal/auditlog"
	capsuleruntime "github.com/vita/agent/internal/capsule-runtime"
	"github.com/vita/agent/internal/jsonsafe"
	"github.com/vita/agent/internal/storagehealth"
	"github.com/vita/agent/status"
	"github.com/vita/agent/transaction"
)

const (
	defaultMaxBodyBytes int64 = 1 << 20

	DefaultUnixSocketPath                = "/run/vita-agent/agentd.sock"
	DefaultUnixSocketMode    fs.FileMode = 0o660
	DefaultUnixPeerGroupName             = "vita-agent"

	unixPeerAuthCapability = "transport.unix"
	peerUnauthorizedReason = "peer_unauthorized"
)

type RequestDecoder func(json.RawMessage) (capabilities.TypedRequest, error)

type ReadRequestFactory func() capabilities.TypedRequest

// AuditStore is the narrow, append-only view of the audit log the transport
// depends on. *auditlog.Store satisfies it. The store assigns the sequence;
// the transport never supplies one. The dependency is OPTIONAL: when it is nil
// the control surface still serves /apply, and /audit reports that the trail is
// unavailable rather than panicking.
type AuditStore interface {
	Append(auditlog.Event) (auditlog.Event, error)
	Read() ([]auditlog.Event, error)
}

type Config struct {
	Version         string
	StartedAt       time.Time
	Registry        *capabilities.Registry
	Discoverer      hardware.Discoverer
	RequestDecoders map[string]RequestDecoder
	ReadRequests    map[string]ReadRequestFactory
	HealthCheck     transaction.HealthCheck
	MaxBodyBytes    int64
	Now             func() time.Time
	FilesStateRoot  string
	FilesGrants     []filecap.Grant
	FilesPrincipals []filecap.Principal
	// AuditStore records one event per /apply and backs the read-only /audit
	// route. Optional: nil ⇒ /apply still works, /audit reports unavailable.
	AuditStore       AuditStore
	CapsuleWorkloads func() []capsuleruntime.WorkloadStatus
	TransportReady   status.ReadinessSource
	StorageHealth    func(context.Context) (storagehealth.Report, error)
	// ExecOpener powers the streaming /pty endpoint (the on-device Terminal's hardened, PTY-backed
	// capsule.exec session). Optional: nil ⇒ /pty is NOT mounted (404) — default-deny by omission.
	// *capsule.ExecCapability satisfies it. Only reachable over the SO_PEERCRED-authenticated unix socket.
	ExecOpener ExecSessionOpener
}

type ErrorResponse struct {
	Error ErrorDetail `json:"error"`
}

type ErrorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type ApplyResult struct {
	Outcome        transaction.Outcome `json:"outcome"`
	Applied        []OperationResult   `json:"applied"`
	RolledBack     []OperationResult   `json:"rolledBack"`
	Error          *ResultError        `json:"error,omitempty"`
	RollbackErrors []ResultError       `json:"rollbackErrors"`
	// AuditUnrecorded is true when the post-commit audit append failed (or no
	// store is configured) so the transaction's outcome was NOT persisted to the
	// audit trail. The transaction result itself is unaffected — a record-keeping
	// failure never rolls back a real change — but the gap is surfaced here.
	AuditUnrecorded bool `json:"auditUnrecorded,omitempty"`
}

type OperationResult struct {
	Index      int    `json:"index"`
	Capability string `json:"capability"`
}

type ResultError struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	Index      *int   `json:"index,omitempty"`
	Capability string `json:"capability,omitempty"`
}

type OperationsResponse struct {
	Operations []string `json:"operations"`
}

type RolesResponse struct {
	Roles []identityroles.Role `json:"roles"`
}

// AuditResponse is the read-only shape returned by GET /audit. It mirrors the
// canonical event shape the store persists (a flat list with a nested actor).
type AuditResponse struct {
	Events []AuditEvent `json:"events"`
}

type AuditEvent struct {
	Sequence        uint64     `json:"sequence"`
	TimestampMillis int64      `json:"timestampMillis"`
	Actor           AuditActor `json:"actor"`
	Capability      string     `json:"capability"`
	Operation       string     `json:"operation"`
	Outcome         string     `json:"outcome"`
	Reason          string     `json:"reason,omitempty"`
}

type AuditActor struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

type stateCapabilityError struct {
	Error string `json:"error"`
}

type capsuleWorkloadSource interface {
	Workloads() []capsuleruntime.WorkloadStatus
}

type handler struct {
	version          string
	startedAt        time.Time
	capabilityNames  []string
	registry         *capabilities.Registry
	discoverer       hardware.Discoverer
	requestDecoders  map[string]RequestDecoder
	readRequests     map[string]ReadRequestFactory
	healthCheck      transaction.HealthCheck
	maxBodyBytes     int64
	now              func() time.Time
	files            *filecap.Handler
	auditStore       AuditStore
	statusHandler    http.Handler
	capsuleWorkloads func() []capsuleruntime.WorkloadStatus
	storageHealth    func(context.Context) (storagehealth.Report, error)
	execOpener       ExecSessionOpener
}

type TransportReadiness struct {
	active atomic.Int64
}

func NewTransportReadiness() *TransportReadiness {
	return &TransportReadiness{}
}

func (r *TransportReadiness) Ready(ctx context.Context) bool {
	return r != nil && ctx.Err() == nil && r.active.Load() > 0
}

func (r *TransportReadiness) MarkAccepting() func() {
	if r == nil {
		return func() {}
	}

	r.active.Add(1)
	var once sync.Once
	return func() {
		once.Do(func() {
			r.active.Add(-1)
		})
	}
}

type applyRequest struct {
	Operations []rawOperation `json:"operations"`
}

type rawOperation struct {
	Capability string          `json:"capability"`
	Request    json.RawMessage `json:"request"`
}

type requestError struct {
	status  int
	code    string
	message string
}

type codedApplyError interface {
	ApplyErrorCode() string
}

type validatableRequest interface {
	capabilities.TypedRequest
	Validate() error
}

type unixSocketListener struct {
	net.Listener
	path string
	once sync.Once
}

type UnixPeerAuthConfig struct {
	GroupName  string
	GroupID    *uint32
	AuditStore AuditStore
	Now        func() time.Time

	readPeerInfo func(net.Conn) (unixPeerInfo, error)
}

type authenticatedUnixListener struct {
	net.Listener
	groupID uint32
	// groupPrincipalKey is the stable key for the group a peer is authorized
	// through. It is the LEAST-specific per-connection candidate (used after the
	// peer's own uid key) so a deployment that cannot pin a transient/DynamicUser
	// uid can still bind a role to the authorizing group.
	groupPrincipalKey string
	auditStore        AuditStore
	now               func() time.Time
	readPeerInfo      func(net.Conn) (unixPeerInfo, error)
}

type peerCredentials struct {
	PID int
	UID uint32
	GID uint32
}

type unixPeerInfo struct {
	Credentials peerCredentials
	Groups      []uint32
	GroupSource string
}

type unixPeerPrincipalConn struct {
	net.Conn
	principalKeys []string
}

type unixPeerPrincipalProvider interface {
	// UnixPeerPrincipalKeys returns the ordered principal-key candidates derived
	// from THIS connection's authenticated peer credentials (most specific
	// first: the peer's own uid, then the group it was authorized through).
	// agentd resolves the effective role from the first bound key, so each
	// authorized peer is attributed to its actual calling identity rather than a
	// single listener-wide role.
	UnixPeerPrincipalKeys() []string
}

type unixPeerPrincipalContextKey struct{}

func ListenUnixSocket(path string) (net.Listener, error) {
	return ListenUnixSocketMode(path, DefaultUnixSocketMode)
}

func ListenUnixSocketMode(path string, mode fs.FileMode) (net.Listener, error) {
	if path == "" {
		return nil, errors.New("unix socket path is required")
	}
	if mode == 0 {
		mode = DefaultUnixSocketMode
	}

	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("remove stale unix socket %q: %w", path, err)
	}

	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, fmt.Errorf("listen unix socket %q: %w", path, err)
	}

	if err := os.Chmod(path, mode); err != nil {
		closeErr := listener.Close()
		removeErr := os.Remove(path)
		return nil, errors.Join(fmt.Errorf("chmod unix socket %q: %w", path, err), closeErr, removeErr)
	}

	return &unixSocketListener{Listener: listener, path: path}, nil
}

func ListenAuthenticatedUnixSocket(path string, config UnixPeerAuthConfig) (net.Listener, error) {
	return ListenAuthenticatedUnixSocketMode(path, DefaultUnixSocketMode, config)
}

func ListenAuthenticatedUnixSocketMode(path string, mode fs.FileMode, config UnixPeerAuthConfig) (net.Listener, error) {
	listener, err := ListenUnixSocketMode(path, mode)
	if err != nil {
		return nil, err
	}

	authenticated, err := AuthenticateUnixSocketListener(listener, config)
	if err != nil {
		closeErr := listener.Close()
		return nil, errors.Join(err, closeErr)
	}
	return authenticated, nil
}

func AuthenticateUnixSocketListener(listener net.Listener, config UnixPeerAuthConfig) (net.Listener, error) {
	if listener == nil {
		return nil, errors.New("unix socket listener is required")
	}

	groupID, err := unixPeerAuthGroupID(config)
	if err != nil {
		return nil, err
	}

	now := config.Now
	if now == nil {
		now = time.Now
	}

	readPeerInfo := config.readPeerInfo
	if readPeerInfo == nil {
		readPeerInfo = readUnixPeerInfo
	}

	return &authenticatedUnixListener{
		Listener:          listener,
		groupID:           groupID,
		groupPrincipalKey: unixPeerAuthPrincipalKey(config, groupID),
		auditStore:        config.AuditStore,
		now:               now,
		readPeerInfo:      readPeerInfo,
	}, nil
}

func (l *unixSocketListener) Close() error {
	var closeErr error
	var removeErr error
	l.once.Do(func() {
		closeErr = l.Listener.Close()
		removeErr = os.Remove(l.path)
		if errors.Is(removeErr, os.ErrNotExist) {
			removeErr = nil
		}
	})
	return errors.Join(closeErr, removeErr)
}

func (l *authenticatedUnixListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}

		peer, authErr := l.readPeerInfo(conn)
		if authErr == nil && peerAuthorizedForGroup(peer, l.groupID) {
			return &unixPeerPrincipalConn{Conn: conn, principalKeys: l.peerPrincipalKeys(peer)}, nil
		}

		l.recordPeerUnauthorized(peer)
		_ = conn.Close()
	}
}

// peerPrincipalKeys derives the ordered principal-key candidates for an
// authorized connection from the peer's OWN authenticated credentials, never
// from the listener-wide configuration alone. The peer's uid (the most specific
// identity proven over SO_PEERCRED) comes first so distinct calling principals
// are not collapsed into one role; the authorizing group key follows as the
// least-specific fallback. The keys derive solely from kernel-supplied creds, so
// they are not spoofable by request content.
func (l *authenticatedUnixListener) peerPrincipalKeys(peer unixPeerInfo) []string {
	keys := make([]string, 0, 2)
	keys = append(keys, UnixPeerUserPrincipalKey(peer.Credentials.UID))
	if l.groupPrincipalKey != "" {
		keys = append(keys, l.groupPrincipalKey)
	}
	return keys
}

func (c *unixPeerPrincipalConn) UnixPeerPrincipalKeys() []string {
	return c.principalKeys
}

func UnixPeerConnContext(ctx context.Context, conn net.Conn) context.Context {
	provider, ok := conn.(unixPeerPrincipalProvider)
	if !ok {
		return ctx
	}
	return contextWithUnixPeerPrincipalKeys(ctx, provider.UnixPeerPrincipalKeys())
}

func (l *authenticatedUnixListener) recordPeerUnauthorized(peer unixPeerInfo) {
	if l.auditStore == nil {
		return
	}

	if _, err := l.auditStore.Append(auditlog.Event{
		TimestampMillis: l.now().UTC().UnixMilli(),
		ActorKind:       auditlog.ActorKindSystem,
		ActorID:         peerAuditActorID(peer),
		Capability:      unixPeerAuthCapability,
		Operation:       auditlog.OperationRead,
		Outcome:         auditlog.OutcomeRejected,
		Reason:          peerUnauthorizedReason,
	}); err != nil {
		return
	}
}

func unixPeerAuthGroupID(config UnixPeerAuthConfig) (uint32, error) {
	if config.GroupID != nil {
		return *config.GroupID, nil
	}

	groupName := config.GroupName
	if groupName == "" {
		groupName = DefaultUnixPeerGroupName
	}

	group, err := user.LookupGroup(groupName)
	if err != nil {
		return 0, fmt.Errorf("lookup unix peer auth group %q: %w", groupName, err)
	}

	gid, err := strconv.ParseUint(group.Gid, 10, 32)
	if err != nil {
		return 0, fmt.Errorf("parse unix peer auth group %q gid %q: %w", groupName, group.Gid, err)
	}
	return uint32(gid), nil
}

func UnixPeerGroupPrincipalKey(groupName string) string {
	if groupName == "" {
		groupName = DefaultUnixPeerGroupName
	}
	return "unix:group:" + groupName
}

// UnixPeerUserPrincipalKey is the per-connection principal key for a peer's
// authenticated uid. It is the most specific identity derived from SO_PEERCRED
// and is preferred over the authorizing-group key, so a deployment that can pin
// a peer's uid binds that exact principal rather than a whole group.
func UnixPeerUserPrincipalKey(uid uint32) string {
	return fmt.Sprintf("unix:uid:%d", uid)
}

func unixPeerGroupIDPrincipalKey(groupID uint32) string {
	return fmt.Sprintf("unix:gid:%d", groupID)
}

func unixPeerAuthPrincipalKey(config UnixPeerAuthConfig, groupID uint32) string {
	if config.GroupID != nil && config.GroupName == "" {
		return unixPeerGroupIDPrincipalKey(groupID)
	}
	return UnixPeerGroupPrincipalKey(config.GroupName)
}

func contextWithUnixPeerPrincipalKeys(ctx context.Context, principalKeys []string) context.Context {
	cleaned := make([]string, 0, len(principalKeys))
	for _, key := range principalKeys {
		if key != "" {
			cleaned = append(cleaned, key)
		}
	}
	if len(cleaned) == 0 {
		return ctx
	}
	return context.WithValue(ctx, unixPeerPrincipalContextKey{}, cleaned)
}

func unixPeerPrincipalKeysFromContext(ctx context.Context) ([]string, bool) {
	principalKeys, ok := ctx.Value(unixPeerPrincipalContextKey{}).([]string)
	if !ok || len(principalKeys) == 0 {
		return nil, false
	}
	return principalKeys, true
}

func peerAuthorizedForGroup(peer unixPeerInfo, groupID uint32) bool {
	if peer.Credentials.GID == groupID {
		return true
	}
	for _, gid := range peer.Groups {
		if gid == groupID {
			return true
		}
	}
	return false
}

func peerAuditActorID(peer unixPeerInfo) string {
	if peer.Credentials.PID <= 0 {
		return "peer:unknown"
	}
	return fmt.Sprintf("peer:pid:%d", peer.Credentials.PID)
}

func parseProcStatusGroups(data []byte) ([]uint32, error) {
	for _, line := range strings.Split(string(data), "\n") {
		key, value, ok := strings.Cut(line, ":")
		if !ok || key != "Groups" {
			continue
		}

		fields := strings.Fields(value)
		groups := make([]uint32, 0, len(fields))
		for _, field := range fields {
			gid, err := strconv.ParseUint(field, 10, 32)
			if err != nil {
				return nil, fmt.Errorf("parse proc status group %q: %w", field, err)
			}
			groups = append(groups, uint32(gid))
		}
		return groups, nil
	}

	return nil, errors.New("proc status missing Groups line")
}

func NewHandler(config Config) (http.Handler, error) {
	registry := config.Registry
	if registry == nil {
		var err error
		registry, err = capabilities.NewRegistry()
		if err != nil {
			return nil, err
		}
	}

	discoverer := config.Discoverer
	if discoverer == nil {
		discoverer = hardware.NewDiscoverer()
	}

	startedAt := config.StartedAt
	if startedAt.IsZero() {
		startedAt = time.Now().UTC()
	}

	now := config.Now
	if now == nil {
		now = time.Now
	}

	maxBodyBytes := config.MaxBodyBytes
	if maxBodyBytes <= 0 {
		maxBodyBytes = defaultMaxBodyBytes
	}

	decoders := DefaultRequestDecoders()
	for name, decoder := range config.RequestDecoders {
		if decoder == nil {
			return nil, fmt.Errorf("request decoder %q is nil", name)
		}
		decoders[name] = decoder
	}

	readRequests := DefaultReadRequests()
	for name, factory := range config.ReadRequests {
		if factory == nil {
			return nil, fmt.Errorf("read request %q is nil", name)
		}
		readRequests[name] = factory
	}

	capsuleWorkloads := config.CapsuleWorkloads
	if capsuleWorkloads == nil {
		var err error
		capsuleWorkloads, err = capsuleWorkloadSnapshotFunc(registry)
		if err != nil {
			return nil, err
		}
	}

	storageHealthSnapshot := config.StorageHealth
	if storageHealthSnapshot == nil {
		storageHealthSnapshot = func(ctx context.Context) (storagehealth.Report, error) {
			return storagehealth.Collect(ctx, storagehealth.Roots{Discoverer: discoverer})
		}
	}
	transportReady := config.TransportReady

	filesHandler, err := filecap.NewHandler(filecap.Options{
		StateRoot:  config.FilesStateRoot,
		Grants:     config.FilesGrants,
		Principals: config.FilesPrincipals,
	})
	if err != nil {
		return nil, fmt.Errorf("build files handler: %w", err)
	}

	names := registry.Names()
	sort.Strings(names)

	statusHandler := status.NewHandlerWithClock(config.Version, startedAt, names, now, status.HealthConfig{
		CapsuleWorkloads: capsuleWorkloads,
		RegistryReady:    registryReadinessSource(registry),
		TransportReady:   transportReady,
		StorageHealth:    storageHealthSnapshot,
	})

	return &handler{
		version:          config.Version,
		startedAt:        startedAt.UTC(),
		capabilityNames:  names,
		registry:         registry,
		discoverer:       discoverer,
		requestDecoders:  decoders,
		readRequests:     readRequests,
		healthCheck:      config.HealthCheck,
		maxBodyBytes:     maxBodyBytes,
		now:              now,
		files:            filesHandler,
		auditStore:       config.AuditStore,
		statusHandler:    statusHandler,
		capsuleWorkloads: capsuleWorkloads,
		storageHealth:    storageHealthSnapshot,
		execOpener:       config.ExecOpener,
	}, nil
}

func DefaultRequestDecoders() map[string]RequestDecoder {
	return map[string]RequestDecoder{
		accounts.Name:         DecodeJSONRequest[accounts.ApplyRequest],
		backup.ArchiveName:    DecodeJSONRequest[backup.ArchiveApplyRequest],
		backup.Name:           DecodeJSONRequest[backup.ApplyRequest],
		capsule.ExecuteName:   DecodeJSONRequest[capsule.ExecuteApplyRequest],
		capsule.FetchName:     DecodeJSONRequest[capsule.FetchApplyRequest],
		capsule.LifecycleName: DecodeJSONRequest[capsule.LifecycleApplyRequest],
		capsule.Name:          DecodeJSONRequest[capsule.ApplyRequest],
		nodeconfig.Name:       DecodeJSONRequest[nodeconfig.ApplyRequest],
		nodetime.Name:         DecodeJSONRequest[nodetime.ApplyRequest],
		hostname.Name:         DecodeJSONRequest[hostname.ApplyRequest],
		identity.Name:         DecodeJSONRequest[identity.ApplyRequest],
		network.Name:          DecodeJSONRequest[network.ApplyRequest],
		owner.Name:            owner.DecodeRequest,
		pdsrepo.Name:          DecodeJSONRequest[pdsrepo.ApplyRequest],
		pdssync.Name:          DecodeJSONRequest[pdssync.ApplyRequest],
		services.Name:         DecodeJSONRequest[services.ApplyRequest],
		storage.Name:          DecodeJSONRequest[storage.ApplyRequest],
		timesync.Name:         DecodeJSONRequest[timesync.ApplyRequest],
		update.Name:           DecodeJSONRequest[update.ApplyRequest],
	}
}

func DefaultReadRequests() map[string]ReadRequestFactory {
	return map[string]ReadRequestFactory{
		accounts.Name:         func() capabilities.TypedRequest { return accounts.ReadRequest{} },
		backup.ArchiveName:    func() capabilities.TypedRequest { return backup.ArchiveReadRequest{} },
		backup.Name:           func() capabilities.TypedRequest { return backup.ReadRequest{} },
		capsule.ExecuteName:   func() capabilities.TypedRequest { return capsule.ExecuteReadRequest{} },
		capsule.ExecName:      func() capabilities.TypedRequest { return capsule.ExecReadRequest{} },
		capsule.FetchName:     func() capabilities.TypedRequest { return capsule.FetchReadRequest{} },
		capsule.LifecycleName: func() capabilities.TypedRequest { return capsule.LifecycleReadRequest{} },
		// capsule.logs is a QUERY-parameterized read (?id=&limit=): the bare factory
		// returns a default-limit request with no id, which the capability rejects as
		// invalid. The real request is built from the query in readCapsuleLogsQuery
		// (handleRead routes capsule.logs there when id/limit are present), mirroring
		// the pdsrepo query-read special case.
		capsule.LogsName: func() capabilities.TypedRequest { return capsule.LogsReadRequest{} },
		capsule.Name:     func() capabilities.TypedRequest { return capsule.ReadRequest{} },
		nodeconfig.Name:  func() capabilities.TypedRequest { return nodeconfig.ReadRequest{} },
		nodetime.Name:    func() capabilities.TypedRequest { return nodetime.ReadRequest{} },
		hostname.Name:    func() capabilities.TypedRequest { return hostname.ReadRequest{} },
		identity.Name:    func() capabilities.TypedRequest { return identity.ReadRequest{} },
		network.Name:     func() capabilities.TypedRequest { return network.ReadRequest{} },
		owner.Name:       func() capabilities.TypedRequest { return owner.ReadRequest{} },
		pdsrepo.Name:     func() capabilities.TypedRequest { return pdsrepo.ReadRequest{} },
		pdssync.Name:     func() capabilities.TypedRequest { return pdssync.ReadRequest{} },
		services.Name:    func() capabilities.TypedRequest { return services.ReadRequest{} },
		storage.Name:     func() capabilities.TypedRequest { return storage.ReadRequest{} },
		timesync.Name:    func() capabilities.TypedRequest { return timesync.ReadRequest{} },
		update.Name:      func() capabilities.TypedRequest { return update.ReadRequest{} },
	}
}

func DecodeJSONRequest[T capabilities.TypedRequest](raw json.RawMessage) (capabilities.TypedRequest, error) {
	var request T
	if err := decodeStrictJSON(bytes.NewReader(raw), &request); err != nil {
		return nil, err
	}
	return request, nil
}

func IsLoopbackTCPAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}

	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/healthz":
		h.handleHealth(w, r)
	case "/capabilities":
		h.handleCapabilities(w, r)
	case "/operations":
		h.handleOperations(w, r)
	case "/roles":
		h.handleRoles(w, r)
	case "/state":
		h.handleState(w, r)
	case "/apply":
		h.handleApply(w, r)
	case "/pty":
		h.handlePTY(w, r)
	case "/files":
		h.handleFiles(w, r)
	case "/export":
		h.handleExport(w, r)
	case "/audit":
		h.handleAudit(w, r)
	case "/challenge/owner.identity":
		h.handleOwnerChallenge(w, r)
	case "/read":
		h.handleRead(w, r, "")
	default:
		if strings.HasPrefix(r.URL.Path, "/read/") {
			h.handleRead(w, r, strings.TrimPrefix(r.URL.Path, "/read/"))
			return
		}
		writeError(w, http.StatusNotFound, "not_found", "not found")
	}
}

func (h *handler) handleHealth(w http.ResponseWriter, r *http.Request) {
	if h.statusHandler == nil {
		writeError(w, http.StatusServiceUnavailable, "health_unavailable", "health source is not configured")
		return
	}

	h.statusHandler.ServeHTTP(w, r)
}

func (h *handler) handleCapabilities(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}

	capabilities, err := h.discoverer.Discover(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "capability_discovery_failed", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, capabilities)
}

func (h *handler) handleOperations(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}

	names := h.registry.Names()
	sort.Strings(names)
	writeJSON(w, http.StatusOK, OperationsResponse{Operations: names})
}

func (h *handler) handleRoles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}

	writeJSON(w, http.StatusOK, RolesResponse{Roles: identityroles.AllRoles()})
}

func (h *handler) handleFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}

	var request filecap.Request
	if err := decodeBody(w, r, &request, filecap.MaxRequestBodyBytes); err != nil {
		writeRequestError(w, err)
		return
	}

	ctx := r.Context()
	if principalKeys, ok := unixPeerPrincipalKeysFromContext(ctx); ok {
		ctx = filecap.ContextWithPrincipalKeys(ctx, principalKeys)
	}

	response, err := h.files.Handle(ctx, request)
	if err != nil {
		writeFilesError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (h *handler) handleExport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}

	var request exportcap.VerifyRequest
	if err := decodeBody(w, r, &request, exportcap.MaxManifestBytes); err != nil {
		writeRequestError(w, err)
		return
	}
	if err := request.Validate(); err != nil {
		writeExportError(w, err)
		return
	}

	manifestBytes, err := h.readExportFile(r.Context(), request.Grant, request.ManifestPath)
	if err != nil {
		writeFilesError(w, err)
		return
	}

	result, err := exportcap.VerifyBundle(manifestBytes, func(path string) ([]byte, error) {
		return h.readExportFile(r.Context(), request.Grant, path)
	})
	if err != nil {
		writeExportError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *handler) readExportFile(ctx context.Context, grant string, path string) ([]byte, error) {
	response, err := h.files.Handle(ctx, filecap.Request{
		Op:    filecap.OperationRead,
		Grant: grant,
		Path:  path,
	})
	if err != nil {
		return nil, err
	}
	if response.Data == nil {
		return nil, &exportcap.BundleError{Code: "integrity_mismatch", Message: "export content read returned no data"}
	}
	content, err := base64.StdEncoding.Strict().DecodeString(*response.Data)
	if err != nil {
		return nil, &exportcap.BundleError{Code: "integrity_mismatch", Message: "export content read returned malformed data"}
	}
	return content, nil
}

func (h *handler) handleOwnerChallenge(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}

	action := r.URL.Query().Get("action")
	if action == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "action is required")
		return
	}

	capability, ok := h.registry.Lookup(owner.Name)
	if !ok {
		writeError(w, http.StatusNotFound, "unknown_capability", fmt.Sprintf("unknown capability %q", owner.Name))
		return
	}
	challenger, ok := capability.(interface {
		Challenge(string) (owner.ChallengeTicket, error)
	})
	if !ok {
		writeError(w, http.StatusInternalServerError, "unsupported_request_type", fmt.Sprintf("capability %q cannot issue challenges", owner.Name))
		return
	}

	challenge, err := challenger.Challenge(action)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, challenge)
}

func (h *handler) handleRead(w http.ResponseWriter, r *http.Request, name string) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	if name == "" || strings.Contains(name, "/") {
		writeError(w, http.StatusNotFound, "unknown_capability", "unknown capability")
		return
	}

	var response capabilities.TypedResponse
	var readErr *requestError
	switch {
	case name == pdsrepo.Name && hasPDSRepoQuery(r.URL.Query()):
		response, readErr = h.readPDSRepoQuery(r.Context(), r.URL.Query())
	case name == capsule.LogsName:
		response, readErr = h.readCapsuleLogsQuery(r.Context(), r.URL.Query())
	default:
		response, readErr = h.readCapability(r.Context(), name)
	}
	if readErr != nil {
		writeRequestError(w, readErr)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (h *handler) readCapability(ctx context.Context, name string) (capabilities.TypedResponse, *requestError) {
	capability, ok := h.registry.Lookup(name)
	if !ok {
		return nil, &requestError{
			status:  http.StatusNotFound,
			code:    "unknown_capability",
			message: fmt.Sprintf("unknown capability %q", name),
		}
	}

	readRequest, ok := h.readRequest(name)
	if !ok {
		return nil, &requestError{
			status:  http.StatusInternalServerError,
			code:    "unsupported_read_request",
			message: fmt.Sprintf("capability %q has no registered read request", name),
		}
	}

	response, err := capability.Handle(ctx, readRequest)
	if err != nil {
		return nil, &requestError{
			status:  http.StatusInternalServerError,
			code:    "capability_read_failed",
			message: err.Error(),
		}
	}
	return response, nil
}

func (h *handler) readPDSRepoQuery(ctx context.Context, values url.Values) (capabilities.TypedResponse, *requestError) {
	capability, ok := h.registry.Lookup(pdsrepo.Name)
	if !ok {
		return nil, &requestError{
			status:  http.StatusNotFound,
			code:    "unknown_capability",
			message: fmt.Sprintf("unknown capability %q", pdsrepo.Name),
		}
	}

	readRequest, requestErr := pdsRepoQueryReadRequest(values)
	if requestErr != nil {
		return nil, requestErr
	}

	response, err := capability.Handle(ctx, readRequest)
	if err != nil {
		return nil, &requestError{
			status:  http.StatusBadRequest,
			code:    "invalid_request",
			message: err.Error(),
		}
	}
	return response, nil
}

// readCapsuleLogsQuery backs GET /read/capsule.logs?id=&limit=. It builds the
// LogsReadRequest from the query parameters (id required; limit optional, defaults
// applied by the capability) and dispatches to the registered capsule.logs
// capability. This mirrors readPDSRepoQuery: a read whose request is carried in the
// query string rather than a JSON body. Owner gating is already enforced by the
// transport's peer-credential auth before this point.
func (h *handler) readCapsuleLogsQuery(ctx context.Context, values url.Values) (capabilities.TypedResponse, *requestError) {
	capability, ok := h.registry.Lookup(capsule.LogsName)
	if !ok {
		return nil, &requestError{
			status:  http.StatusNotFound,
			code:    "unknown_capability",
			message: fmt.Sprintf("unknown capability %q", capsule.LogsName),
		}
	}

	readRequest, requestErr := capsuleLogsQueryReadRequest(values)
	if requestErr != nil {
		return nil, requestErr
	}

	response, err := capability.Handle(ctx, readRequest)
	if err != nil {
		return nil, &requestError{
			status:  http.StatusBadRequest,
			code:    "invalid_request",
			message: err.Error(),
		}
	}
	return response, nil
}

func capsuleLogsQueryReadRequest(values url.Values) (capsule.LogsReadRequest, *requestError) {
	for key := range values {
		switch key {
		case "id", "limit":
		default:
			return capsule.LogsReadRequest{}, badRequest("unknown_field", fmt.Sprintf("unknown query parameter %q", key))
		}
	}

	id, requestErr := requiredSingleQueryValue(values, "id")
	if requestErr != nil {
		return capsule.LogsReadRequest{}, requestErr
	}

	limit := 0
	if values.Has("limit") {
		limitText, requestErr := requiredSingleQueryValue(values, "limit")
		if requestErr != nil {
			return capsule.LogsReadRequest{}, requestErr
		}
		parsed, requestErr := parseQueryInt(limitText, "limit")
		if requestErr != nil {
			return capsule.LogsReadRequest{}, requestErr
		}
		if parsed < 0 {
			return capsule.LogsReadRequest{}, badRequest("invalid_request", "query parameter \"limit\" must be non-negative")
		}
		limit = int(parsed)
	}

	request := capsule.LogsReadRequest{ID: id, Limit: limit}
	if err := request.Validate(); err != nil {
		return capsule.LogsReadRequest{}, badRequest("invalid_request", err.Error())
	}
	return request, nil
}

func (h *handler) handleState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}

	var body bytes.Buffer
	body.WriteString(`{"capabilities":{`)
	for i, name := range h.capabilityNames {
		if i > 0 {
			body.WriteByte(',')
		}
		key, err := json.Marshal(name)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "state_encode_failed", "state response could not be encoded")
			return
		}
		body.Write(key)
		body.WriteByte(':')

		raw, readErr := h.readCapabilityJSON(r.Context(), name)
		if readErr != nil {
			raw, err = encodeJSONValue(stateCapabilityError{Error: readErr.code})
			if err != nil {
				writeError(w, http.StatusInternalServerError, "state_encode_failed", "state response could not be encoded")
				return
			}
		}
		body.Write(raw)
	}
	body.WriteString("},\"capsuleWorkloads\":")
	workloads, err := encodeJSONValue(h.capsuleWorkloadSnapshot())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "state_encode_failed", "state response could not be encoded")
		return
	}
	body.Write(workloads)
	report, storageErr := h.storageHealthSnapshot(r.Context())
	body.WriteString(",\"storageHealth\":")
	if storageErr != nil {
		raw, err := encodeJSONValue(stateCapabilityError{Error: "storage_health_unavailable"})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "state_encode_failed", "state response could not be encoded")
			return
		}
		body.Write(raw)
	} else {
		raw, err := encodeJSONValue(report.StorageHealth)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "state_encode_failed", "state response could not be encoded")
			return
		}
		body.Write(raw)
	}
	body.WriteString(",\"hardwareInventory\":")
	if storageErr != nil {
		raw, err := encodeJSONValue(stateCapabilityError{Error: "storage_health_unavailable"})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "state_encode_failed", "state response could not be encoded")
			return
		}
		body.Write(raw)
	} else {
		raw, err := encodeJSONValue(report.HardwareInventory)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "state_encode_failed", "state response could not be encoded")
			return
		}
		body.Write(raw)
	}
	body.WriteString("}\n")

	writeRawJSON(w, http.StatusOK, body.Bytes())
}

func (h *handler) capsuleWorkloadSnapshot() []capsuleruntime.WorkloadStatus {
	if h.capsuleWorkloads == nil {
		return []capsuleruntime.WorkloadStatus{}
	}
	return normalizeCapsuleWorkloads(h.capsuleWorkloads())
}

func (h *handler) storageHealthSnapshot(ctx context.Context) (storagehealth.Report, error) {
	if h.storageHealth == nil {
		return storagehealth.Report{}, errors.New("storage health snapshot unavailable")
	}
	return h.storageHealth(ctx)
}

func (h *handler) readCapabilityJSON(ctx context.Context, name string) ([]byte, *requestError) {
	response, readErr := h.readCapability(ctx, name)
	if readErr != nil {
		return nil, readErr
	}
	raw, err := encodeJSONValue(response)
	if err != nil {
		return nil, &requestError{
			status:  http.StatusInternalServerError,
			code:    "capability_read_failed",
			message: "capability response could not be encoded",
		}
	}
	return raw, nil
}

func (h *handler) readRequest(name string) (capabilities.TypedRequest, bool) {
	factory, ok := h.readRequests[name]
	if !ok {
		return nil, false
	}

	request := factory()
	return request, request != nil
}

func hasPDSRepoQuery(values url.Values) bool {
	return values.Has("collection") || values.Has("cursor") || values.Has("limit")
}

func pdsRepoQueryReadRequest(values url.Values) (pdsrepo.ReadRequest, *requestError) {
	for key := range values {
		switch key {
		case "collection", "cursor", "limit":
		default:
			return pdsrepo.ReadRequest{}, badRequest("unknown_field", fmt.Sprintf("unknown query parameter %q", key))
		}
	}

	collection, requestErr := requiredSingleQueryValue(values, "collection")
	if requestErr != nil {
		return pdsrepo.ReadRequest{}, requestErr
	}
	limitText, requestErr := requiredSingleQueryValue(values, "limit")
	if requestErr != nil {
		return pdsrepo.ReadRequest{}, requestErr
	}
	limit, requestErr := parseQueryInt(limitText, "limit")
	if requestErr != nil {
		return pdsrepo.ReadRequest{}, requestErr
	}

	var cursor *int64
	if values.Has("cursor") {
		cursorText, requestErr := requiredSingleQueryValue(values, "cursor")
		if requestErr != nil {
			return pdsrepo.ReadRequest{}, requestErr
		}
		parsed, requestErr := parseQueryInt(cursorText, "cursor")
		if requestErr != nil {
			return pdsrepo.ReadRequest{}, requestErr
		}
		cursor = &parsed
	}

	request := pdsrepo.ReadRequest{Query: &pdsrepo.QueryRequest{
		Collection: collection,
		Cursor:     cursor,
		Limit:      limit,
	}}
	if err := request.Validate(); err != nil {
		return pdsrepo.ReadRequest{}, badRequest("invalid_request", err.Error())
	}
	return request, nil
}

func requiredSingleQueryValue(values url.Values, key string) (string, *requestError) {
	items, ok := values[key]
	if !ok || len(items) == 0 {
		return "", badRequest("invalid_request", fmt.Sprintf("query parameter %q is required", key))
	}
	if len(items) != 1 {
		return "", badRequest("invalid_request", fmt.Sprintf("query parameter %q must appear exactly once", key))
	}
	if items[0] == "" {
		return "", badRequest("invalid_request", fmt.Sprintf("query parameter %q is required", key))
	}
	return items[0], nil
}

func parseQueryInt(value string, field string) (int64, *requestError) {
	if strings.ContainsAny(value, ".eE") {
		return 0, badRequest("invalid_request", fmt.Sprintf("query parameter %q must be an integer", field))
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, badRequest("invalid_request", fmt.Sprintf("query parameter %q must be an integer", field))
	}
	return parsed, nil
}

func capsuleWorkloadSnapshotFunc(registry *capabilities.Registry) (func() []capsuleruntime.WorkloadStatus, error) {
	if registry == nil {
		return nil, nil
	}

	capability, ok := registry.Lookup(capsule.ExecuteName)
	if !ok {
		return nil, nil
	}
	source, ok := capability.(capsuleWorkloadSource)
	if !ok {
		return nil, fmt.Errorf("%s capability does not expose capsule workloads", capsule.ExecuteName)
	}
	return source.Workloads, nil
}

func registryReadinessSource(registry *capabilities.Registry) status.ReadinessSource {
	return func(ctx context.Context) bool {
		if ctx.Err() != nil || registry == nil {
			return false
		}

		names := registry.Names()
		if len(names) == 0 {
			return false
		}
		for _, name := range names {
			if _, ok := registry.Lookup(name); !ok {
				return false
			}
		}
		return len(names) > 0
	}
}

func normalizeCapsuleWorkloads(workloads []capsuleruntime.WorkloadStatus) []capsuleruntime.WorkloadStatus {
	if len(workloads) == 0 {
		return []capsuleruntime.WorkloadStatus{}
	}

	out := make([]capsuleruntime.WorkloadStatus, len(workloads))
	copy(out, workloads)
	sort.Slice(out, func(i, j int) bool {
		if out[i].ID != out[j].ID {
			return out[i].ID < out[j].ID
		}
		return out[i].Unit < out[j].Unit
	})
	return out
}

func (h *handler) handleApply(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}

	var request applyRequest
	if err := decodeBody(w, r, &request, h.maxBodyBytes); err != nil {
		writeRequestError(w, err)
		return
	}

	plan, requestErr := h.buildPlan(request)
	if requestErr != nil {
		writeRequestError(w, requestErr)
		return
	}

	result := transaction.Apply(r.Context(), h.registry, plan, h.healthCheck)
	if result.Rejected() {
		writeTransactionRejection(w, result.Err)
		return
	}

	// The transaction has reached its single commit point: it either committed
	// (with a working Undo) or rolled back cleanly. Recording the outcome happens
	// strictly AFTER that point and is best-effort: an audit-append failure must
	// never change the transaction's result, only surface a gap via
	// audit_unrecorded so the missing trail entry is visible.
	response := applyResultFromTransaction(result)
	response.AuditUnrecorded = !h.recordApply(plan, result)

	writeJSON(w, http.StatusOK, response)
}

// recordApply appends one audit event describing the resolved transaction. It
// returns true iff the event was durably recorded. It never mutates the
// transaction result and never panics on a nil store; any failure (no store,
// nothing to name, or an append error) is reported as a not-recorded gap by the
// caller. The store assigns the sequence — the transport never supplies one.
func (h *handler) recordApply(plan transaction.Plan, result transaction.Result) bool {
	if h.auditStore == nil {
		return false
	}

	capability, ok := appliedCapabilityName(plan, result)
	if !ok {
		// No operation to attribute the event to (e.g. an empty plan): there is
		// no privileged effect to record, so there is no gap either.
		return true
	}

	event := auditlog.Event{
		TimestampMillis: h.now().UnixMilli(),
		ActorKind:       auditlog.ActorKindSystem,
		ActorID:         "agentd",
		Capability:      capability,
		Operation:       auditlog.OperationApply,
		Outcome:         auditOutcome(result.Outcome),
	}
	if _, err := h.auditStore.Append(event); err != nil {
		return false
	}
	return true
}

func (h *handler) handleAudit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	if h.auditStore == nil {
		writeError(w, http.StatusServiceUnavailable, "audit_unavailable", "audit log is not configured")
		return
	}

	events, err := h.auditStore.Read()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "audit_read_failed", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, auditResponse(events))
}

// appliedCapabilityName picks the single capability name to attribute the apply
// event to. For a committed transaction that is the first applied operation; for
// a rolled_back/failed transaction it is the operation whose failure determined
// the outcome (falling back to the first planned operation). The boolean is
// false only when there is no operation to name (an empty plan).
func appliedCapabilityName(plan transaction.Plan, result transaction.Result) (string, bool) {
	if name, ok := failingCapabilityName(result.Err); ok {
		return name, true
	}
	if len(result.Applied) > 0 {
		return result.Applied[0].Capability, true
	}
	if len(plan) > 0 {
		return plan[0].Capability, true
	}
	return "", false
}

func failingCapabilityName(err error) (string, bool) {
	var applyErr *transaction.ApplyError
	if errors.As(err, &applyErr) && applyErr.Capability != "" {
		return applyErr.Capability, true
	}
	var precondition *transaction.PreconditionError
	if errors.As(err, &precondition) && precondition.Capability != "" {
		return precondition.Capability, true
	}
	return "", false
}

// auditOutcome maps a resolved transaction outcome to the closed audit-log
// outcome set. A rejected transaction is handled before this point (it never
// reaches the commit path), so only committed/rolled_back are expected here;
// any other value is recorded as "failed" rather than dropped.
func auditOutcome(outcome transaction.Outcome) auditlog.Outcome {
	switch outcome {
	case transaction.OutcomeCommitted:
		return auditlog.OutcomeCommitted
	case transaction.OutcomeRolledBack:
		return auditlog.OutcomeRolledBack
	case transaction.OutcomeRejected:
		return auditlog.OutcomeRejected
	default:
		return auditlog.OutcomeFailed
	}
}

func auditResponse(events []auditlog.Event) AuditResponse {
	out := make([]AuditEvent, 0, len(events))
	for _, event := range events {
		out = append(out, AuditEvent{
			Sequence:        event.Sequence,
			TimestampMillis: event.TimestampMillis,
			Actor: AuditActor{
				Kind: string(event.ActorKind),
				ID:   event.ActorID,
			},
			Capability: event.Capability,
			Operation:  string(event.Operation),
			Outcome:    string(event.Outcome),
			Reason:     event.Reason,
		})
	}
	return AuditResponse{Events: out}
}

func (h *handler) buildPlan(request applyRequest) (transaction.Plan, *requestError) {
	if request.Operations == nil {
		return nil, badRequest("invalid_plan", "operations is required")
	}

	plan := make(transaction.Plan, 0, len(request.Operations))
	for i, operation := range request.Operations {
		if operation.Capability == "" {
			return nil, badRequest("invalid_plan", fmt.Sprintf("operation %d capability is required", i))
		}
		if len(bytes.TrimSpace(operation.Request)) == 0 {
			return nil, badRequest("invalid_plan", fmt.Sprintf("operation %d request is required", i))
		}
		if bytes.Equal(bytes.TrimSpace(operation.Request), []byte("null")) {
			return nil, badRequest("invalid_plan", fmt.Sprintf("operation %d request must be an object", i))
		}

		capability, ok := h.registry.Lookup(operation.Capability)
		if !ok {
			return nil, badRequest("unknown_capability", fmt.Sprintf("operation %d names unknown capability %q", i, operation.Capability))
		}
		if _, ok := capability.(transaction.TxCapability); !ok {
			return nil, badRequest("non_transactional_capability", fmt.Sprintf("operation %d capability %q is not transactional", i, operation.Capability))
		}

		decoder, ok := h.requestDecoders[operation.Capability]
		if !ok {
			return nil, badRequest("unsupported_request_type", fmt.Sprintf("operation %d capability %q has no registered request decoder", i, operation.Capability))
		}

		typedRequest, err := decoder(operation.Request)
		if err != nil {
			return nil, decodeRequestError(err)
		}
		if typedRequest == nil {
			return nil, badRequest("invalid_request", fmt.Sprintf("operation %d capability %q decoded nil request", i, operation.Capability))
		}

		validator, ok := typedRequest.(validatableRequest)
		if !ok {
			return nil, badRequest("invalid_request", fmt.Sprintf("operation %d capability %q request cannot be validated", i, operation.Capability))
		}
		if err := validator.Validate(); err != nil {
			return nil, badRequest("invalid_request", fmt.Sprintf("operation %d capability %q request is invalid: %v", i, operation.Capability, err))
		}

		plan = append(plan, transaction.Operation{
			Capability: operation.Capability,
			Request:    typedRequest,
		})
	}

	return plan, nil
}

func decodeBody(w http.ResponseWriter, r *http.Request, target interface{}, maxBodyBytes int64) *requestError {
	body := http.MaxBytesReader(w, r.Body, maxBodyBytes)
	defer body.Close()

	if err := decodeStrictJSON(body, target); err != nil {
		return decodeRequestError(err)
	}
	return nil
}

func decodeStrictJSON(reader io.Reader, target interface{}) error {
	raw, err := io.ReadAll(reader)
	if err != nil {
		return err
	}
	return jsonsafe.DecodeStrict(raw, target)
}

var errTrailingJSON = errors.New("body must contain exactly one JSON value")

func decodeRequestError(err error) *requestError {
	var maxBytesErr *http.MaxBytesError
	if errors.As(err, &maxBytesErr) {
		return &requestError{
			status:  http.StatusRequestEntityTooLarge,
			code:    "request_too_large",
			message: "request body exceeds maximum size",
		}
	}
	if errors.Is(err, io.EOF) {
		return badRequest("invalid_json", "request body must contain one JSON object")
	}
	if errors.Is(err, errTrailingJSON) {
		return badRequest("invalid_json", errTrailingJSON.Error())
	}
	if strings.HasPrefix(err.Error(), "json: unknown field ") {
		return badRequest("unknown_field", err.Error())
	}

	return badRequest("invalid_json", err.Error())
}

func writeTransactionRejection(w http.ResponseWriter, err error) {
	code := "transaction_rejected"
	var precondition *transaction.PreconditionError
	if errors.As(err, &precondition) {
		switch precondition.Reason {
		case transaction.PreconditionUnknownCapability:
			code = "unknown_capability"
		case transaction.PreconditionNonTransactionalCapability:
			code = "non_transactional_capability"
		case transaction.PreconditionNilRequest:
			code = "invalid_request"
		}
	}
	writeError(w, http.StatusBadRequest, code, err.Error())
}

func applyResultFromTransaction(result transaction.Result) ApplyResult {
	response := ApplyResult{
		Outcome:        result.Outcome,
		Applied:        appliedOperations(result.Applied),
		RolledBack:     rolledBackOperations(result.RolledBack),
		RollbackErrors: rollbackErrors(result.RollbackErrors),
	}
	if result.Err != nil {
		err := resultError(result.Err)
		response.Error = &err
	}
	return response
}

func appliedOperations(operations []transaction.AppliedOperation) []OperationResult {
	results := make([]OperationResult, 0, len(operations))
	for _, operation := range operations {
		results = append(results, OperationResult{
			Index:      operation.Index,
			Capability: operation.Capability,
		})
	}
	return results
}

func rolledBackOperations(operations []transaction.RolledBackOperation) []OperationResult {
	results := make([]OperationResult, 0, len(operations))
	for _, operation := range operations {
		results = append(results, OperationResult{
			Index:      operation.Index,
			Capability: operation.Capability,
		})
	}
	return results
}

func rollbackErrors(errors []transaction.RollbackError) []ResultError {
	results := make([]ResultError, 0, len(errors))
	for _, err := range errors {
		index := err.Index
		results = append(results, ResultError{
			Code:       "rollback_failed",
			Message:    err.Error(),
			Index:      &index,
			Capability: err.Capability,
		})
	}
	return results
}

func resultError(err error) ResultError {
	var applyErr *transaction.ApplyError
	if errors.As(err, &applyErr) {
		index := applyErr.Index
		code := "apply_failed"
		var coded codedApplyError
		if errors.As(applyErr.Err, &coded) {
			if value := coded.ApplyErrorCode(); value != "" {
				code = value
			}
		}
		return ResultError{
			Code:       code,
			Message:    applyErr.Error(),
			Index:      &index,
			Capability: applyErr.Capability,
		}
	}

	var healthErr *transaction.HealthCheckError
	if errors.As(err, &healthErr) {
		return ResultError{
			Code:    "health_check_failed",
			Message: healthErr.Error(),
		}
	}

	var precondition *transaction.PreconditionError
	if errors.As(err, &precondition) {
		index := precondition.Index
		return ResultError{
			Code:       string(precondition.Reason),
			Message:    precondition.Error(),
			Index:      &index,
			Capability: precondition.Capability,
		}
	}

	return ResultError{
		Code:    "transaction_failed",
		Message: err.Error(),
	}
}

func writeRequestError(w http.ResponseWriter, err *requestError) {
	writeError(w, err.status, err.code, err.message)
}

func writeFilesError(w http.ResponseWriter, err error) {
	var requestErr *filecap.RequestError
	if errors.As(err, &requestErr) {
		writeError(w, requestErr.Status, requestErr.Code, requestErr.Message)
		return
	}
	writeError(w, http.StatusInternalServerError, "files_failed", "files request failed")
}

func writeExportError(w http.ResponseWriter, err error) {
	var bundleErr *exportcap.BundleError
	if errors.As(err, &bundleErr) {
		writeError(w, bundleErr.HTTPStatus(), bundleErr.Code, bundleErr.Message)
		return
	}
	writeError(w, http.StatusInternalServerError, "export_failed", "export request failed")
}

func badRequest(code string, message string) *requestError {
	return &requestError{status: http.StatusBadRequest, code: code, message: message}
}

func methodNotAllowed(w http.ResponseWriter, allowed string) {
	w.Header().Set("Allow", allowed)
	writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
}

func writeError(w http.ResponseWriter, statusCode int, code string, message string) {
	writeJSON(w, statusCode, ErrorResponse{
		Error: ErrorDetail{
			Code:    code,
			Message: message,
		},
	})
}

func writeJSON(w http.ResponseWriter, statusCode int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeRawJSON(w http.ResponseWriter, statusCode int, payload []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_, _ = w.Write(payload)
}

func encodeJSONValue(payload interface{}) ([]byte, error) {
	var body bytes.Buffer
	if err := json.NewEncoder(&body).Encode(payload); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(body.Bytes(), []byte("\n")), nil
}
