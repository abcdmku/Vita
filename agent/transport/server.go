package transport

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/capabilities/accounts"
	"github.com/vita/agent/capabilities/backup"
	"github.com/vita/agent/capabilities/capsule"
	"github.com/vita/agent/capabilities/hostname"
	"github.com/vita/agent/capabilities/identity"
	"github.com/vita/agent/capabilities/network"
	"github.com/vita/agent/capabilities/nodeconfig"
	"github.com/vita/agent/capabilities/pdssync"
	"github.com/vita/agent/capabilities/services"
	"github.com/vita/agent/capabilities/storage"
	nodetime "github.com/vita/agent/capabilities/time"
	"github.com/vita/agent/capabilities/timesync"
	"github.com/vita/agent/capabilities/update"
	"github.com/vita/agent/hardware"
	"github.com/vita/agent/internal/auditlog"
	"github.com/vita/agent/status"
	"github.com/vita/agent/transaction"
)

const (
	defaultMaxBodyBytes int64 = 1 << 20

	DefaultUnixSocketPath             = "/run/vita-agent/agentd.sock"
	DefaultUnixSocketMode fs.FileMode = 0o660
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
	// AuditStore records one event per /apply and backs the read-only /audit
	// route. Optional: nil ⇒ /apply still works, /audit reports unavailable.
	AuditStore AuditStore
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

type handler struct {
	version         string
	startedAt       time.Time
	capabilityNames []string
	registry        *capabilities.Registry
	discoverer      hardware.Discoverer
	requestDecoders map[string]RequestDecoder
	readRequests    map[string]ReadRequestFactory
	healthCheck     transaction.HealthCheck
	maxBodyBytes    int64
	now             func() time.Time
	auditStore      AuditStore
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

type validatableRequest interface {
	capabilities.TypedRequest
	Validate() error
}

type unixSocketListener struct {
	net.Listener
	path string
	once sync.Once
}

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

	names := registry.Names()
	sort.Strings(names)

	return &handler{
		version:         config.Version,
		startedAt:       startedAt.UTC(),
		capabilityNames: names,
		registry:        registry,
		discoverer:      discoverer,
		requestDecoders: decoders,
		readRequests:    readRequests,
		healthCheck:     config.HealthCheck,
		maxBodyBytes:    maxBodyBytes,
		now:             now,
		auditStore:      config.AuditStore,
	}, nil
}

func DefaultRequestDecoders() map[string]RequestDecoder {
	return map[string]RequestDecoder{
		accounts.Name:       DecodeJSONRequest[accounts.ApplyRequest],
		backup.Name:         DecodeJSONRequest[backup.ApplyRequest],
		capsule.ExecuteName: DecodeJSONRequest[capsule.ExecuteApplyRequest],
		capsule.FetchName:   DecodeJSONRequest[capsule.FetchApplyRequest],
		capsule.Name:        DecodeJSONRequest[capsule.ApplyRequest],
		nodeconfig.Name:     DecodeJSONRequest[nodeconfig.ApplyRequest],
		nodetime.Name:       DecodeJSONRequest[nodetime.ApplyRequest],
		hostname.Name:       DecodeJSONRequest[hostname.ApplyRequest],
		identity.Name:       DecodeJSONRequest[identity.ApplyRequest],
		network.Name:        DecodeJSONRequest[network.ApplyRequest],
		pdssync.Name:        DecodeJSONRequest[pdssync.ApplyRequest],
		services.Name:       DecodeJSONRequest[services.ApplyRequest],
		storage.Name:        DecodeJSONRequest[storage.ApplyRequest],
		timesync.Name:       DecodeJSONRequest[timesync.ApplyRequest],
		update.Name:         DecodeJSONRequest[update.ApplyRequest],
	}
}

func DefaultReadRequests() map[string]ReadRequestFactory {
	return map[string]ReadRequestFactory{
		accounts.Name:       func() capabilities.TypedRequest { return accounts.ReadRequest{} },
		backup.Name:         func() capabilities.TypedRequest { return backup.ReadRequest{} },
		capsule.ExecuteName: func() capabilities.TypedRequest { return capsule.ExecuteReadRequest{} },
		capsule.FetchName:   func() capabilities.TypedRequest { return capsule.FetchReadRequest{} },
		capsule.Name:        func() capabilities.TypedRequest { return capsule.ReadRequest{} },
		nodeconfig.Name:     func() capabilities.TypedRequest { return nodeconfig.ReadRequest{} },
		nodetime.Name:       func() capabilities.TypedRequest { return nodetime.ReadRequest{} },
		hostname.Name:       func() capabilities.TypedRequest { return hostname.ReadRequest{} },
		identity.Name:       func() capabilities.TypedRequest { return identity.ReadRequest{} },
		network.Name:        func() capabilities.TypedRequest { return network.ReadRequest{} },
		pdssync.Name:        func() capabilities.TypedRequest { return pdssync.ReadRequest{} },
		services.Name:       func() capabilities.TypedRequest { return services.ReadRequest{} },
		storage.Name:        func() capabilities.TypedRequest { return storage.ReadRequest{} },
		timesync.Name:       func() capabilities.TypedRequest { return timesync.ReadRequest{} },
		update.Name:         func() capabilities.TypedRequest { return update.ReadRequest{} },
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
	case "/state":
		h.handleState(w, r)
	case "/apply":
		h.handleApply(w, r)
	case "/audit":
		h.handleAudit(w, r)
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
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}

	capabilityNames := cloneStrings(h.capabilityNames)
	now := h.now().UTC()
	uptime := now.Sub(h.startedAt)
	if uptime < 0 {
		uptime = 0
	}

	writeJSON(w, http.StatusOK, status.Status{
		Version:       h.version,
		StartedAt:     h.startedAt,
		UptimeSeconds: int64(uptime.Seconds()),
		Capabilities:  capabilityNames,
		Healthy:       true,
	})
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

func (h *handler) handleRead(w http.ResponseWriter, r *http.Request, name string) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	if name == "" || strings.Contains(name, "/") {
		writeError(w, http.StatusNotFound, "unknown_capability", "unknown capability")
		return
	}

	response, readErr := h.readCapability(r.Context(), name)
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
	body.WriteString("}}\n")

	writeRawJSON(w, http.StatusOK, body.Bytes())
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
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()

	if err := decoder.Decode(target); err != nil {
		return err
	}

	var extra struct{}
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return errTrailingJSON
		}
		return err
	}

	return nil
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
		return ResultError{
			Code:       "apply_failed",
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

func cloneStrings(in []string) []string {
	out := make([]string, len(in))
	copy(out, in)
	return out
}
