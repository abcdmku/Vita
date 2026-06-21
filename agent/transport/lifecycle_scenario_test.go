package transport

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/capabilities/nodeconfig"
	"github.com/vita/agent/capabilities/services"
	"github.com/vita/agent/capabilities/timesync"
	"github.com/vita/agent/internal/auditlog"
	"github.com/vita/agent/transaction"
)

const (
	lifecycleCapA = nodeconfig.Name
	lifecycleCapB = services.Name
	lifecycleCapC = timesync.Name

	lifecycleNodeConfigApply         = `{"desired":{"mode":"maintenance","remoteAccess":"enabled"}}`
	lifecycleNodeConfigRollbackApply = `{"desired":{"mode":"normal","remoteAccess":"disabled"}}`
	lifecycleInvalidNodeConfigApply  = `{"desired":{"mode":"","remoteAccess":"enabled"}}`
	lifecycleServicesApply           = `{"desired":{"services":[{"name":"ssh.service","enabled":true}]}}`
	lifecycleTimesyncRollbackApply   = `{"desired":{"enabled":true,"servers":["rollback.example.com"]}}`

	lifecycleNodeConfigValue       = "mode=maintenance;remoteAccess=enabled"
	lifecycleServicesValue         = "services=ssh.service:true"
	lifecycleTimesyncRollbackValue = "enabled=true;servers=rollback.example.com"
)

func TestLifecycleScenarioApplyReadStateAuditFailClosed(t *testing.T) {
	capA := newLifecycleCapability(lifecycleCapA, lifecycleNodeConfigReadRequest, lifecycleNodeConfigConfigValue)
	capB := newLifecycleCapability(lifecycleCapB, lifecycleServicesReadRequest, lifecycleServicesConfigValue)
	capC := newLifecycleCapability(lifecycleCapC, lifecycleTimesyncReadRequest, lifecycleTimesyncConfigValue)
	capC.failValues[lifecycleTimesyncRollbackValue] = errors.New("forced lifecycle rollback")

	handler := mustHandler(t, handlerConfig{
		registry:   mustRegistry(t, capA, capB, capC),
		auditStore: newAuditStore(t),
	})

	absentState := map[string]string{
		lifecycleCapA: `{"configured":false}`,
		lifecycleCapB: `{"configured":false}`,
		lifecycleCapC: `{"configured":false}`,
	}
	assertLifecycleOperations(t, handler, []string{lifecycleCapA, lifecycleCapB, lifecycleCapC})
	assertLifecycleState(t, handler, absentState)
	assertLifecycleAudit(t, handler, nil)

	assertLifecycleCommittedApply(t, handler, lifecycleCapA, lifecycleNodeConfigApply)
	assertLifecycleRead(t, handler, lifecycleCapA, `{"configured":true,"value":"`+lifecycleNodeConfigValue+`"}`)
	afterA := map[string]string{
		lifecycleCapA: `{"configured":true,"value":"` + lifecycleNodeConfigValue + `"}`,
		lifecycleCapB: `{"configured":false}`,
		lifecycleCapC: `{"configured":false}`,
	}
	assertLifecycleState(t, handler, afterA)
	assertLifecycleAudit(t, handler, []lifecycleAuditWant{
		{capability: lifecycleCapA, outcome: auditlog.OutcomeCommitted},
	})

	assertLifecycleCommittedApply(t, handler, lifecycleCapB, lifecycleServicesApply)
	afterB := map[string]string{
		lifecycleCapA: `{"configured":true,"value":"` + lifecycleNodeConfigValue + `"}`,
		lifecycleCapB: `{"configured":true,"value":"` + lifecycleServicesValue + `"}`,
		lifecycleCapC: `{"configured":false}`,
	}
	stateAfterB := assertLifecycleState(t, handler, afterB)
	assertLifecycleAudit(t, handler, []lifecycleAuditWant{
		{capability: lifecycleCapA, outcome: auditlog.OutcomeCommitted},
		{capability: lifecycleCapB, outcome: auditlog.OutcomeCommitted},
	})

	assertLifecycleRolledBackApply(t, handler, lifecycleCapA, lifecycleNodeConfigRollbackApply, lifecycleCapC, lifecycleTimesyncRollbackApply)
	stateAfterRollback := assertLifecycleState(t, handler, afterB)
	if stateAfterRollback != stateAfterB {
		t.Fatalf("state changed after rollback:\n got: %s\nwant: %s", stateAfterRollback, stateAfterB)
	}
	assertLifecycleAudit(t, handler, []lifecycleAuditWant{
		{capability: lifecycleCapA, outcome: auditlog.OutcomeCommitted},
		{capability: lifecycleCapB, outcome: auditlog.OutcomeCommitted},
		{capability: lifecycleCapC, outcome: auditlog.OutcomeRolledBack},
	})

	assertLifecycleRejectedApply(t, handler, lifecycleCapA, lifecycleInvalidNodeConfigApply)
	stateAfterReject := assertLifecycleState(t, handler, afterB)
	if stateAfterReject != stateAfterB {
		t.Fatalf("state changed after pre-transaction rejection:\n got: %s\nwant: %s", stateAfterReject, stateAfterB)
	}
	assertLifecycleAudit(t, handler, []lifecycleAuditWant{
		{capability: lifecycleCapA, outcome: auditlog.OutcomeCommitted},
		{capability: lifecycleCapB, outcome: auditlog.OutcomeCommitted},
		{capability: lifecycleCapC, outcome: auditlog.OutcomeRolledBack},
	})
}

func assertLifecycleOperations(t *testing.T, handler http.Handler, want []string) {
	t.Helper()

	response := perform(handler, http.MethodGet, "/operations", "")
	if response.Code != http.StatusOK {
		t.Fatalf("operations status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	var got OperationsResponse
	decodeResponse(t, response, &got)
	if !reflect.DeepEqual(got.Operations, want) {
		t.Fatalf("operations = %v, want %v", got.Operations, want)
	}
}

func assertLifecycleCommittedApply(t *testing.T, handler http.Handler, capability string, requestJSON string) {
	t.Helper()

	body := fmt.Sprintf(`{"operations":[{"capability":%q,"request":%s}]}`, capability, requestJSON)
	response := perform(handler, http.MethodPost, "/apply", body)
	if response.Code != http.StatusOK {
		t.Fatalf("apply %s status code = %d, want %d; body=%s", capability, response.Code, http.StatusOK, response.Body.String())
	}
	var result ApplyResult
	decodeResponse(t, response, &result)
	if result.Outcome != transaction.OutcomeCommitted {
		t.Fatalf("apply %s outcome = %q, want %q", capability, result.Outcome, transaction.OutcomeCommitted)
	}
	wantApplied := []OperationResult{{Index: 0, Capability: capability}}
	if !reflect.DeepEqual(result.Applied, wantApplied) {
		t.Fatalf("apply %s applied = %v, want %v", capability, result.Applied, wantApplied)
	}
	if len(result.RolledBack) != 0 {
		t.Fatalf("apply %s rolledBack = %v, want none", capability, result.RolledBack)
	}
	if result.Error != nil {
		t.Fatalf("apply %s error = %#v, want nil", capability, result.Error)
	}
	if len(result.RollbackErrors) != 0 {
		t.Fatalf("apply %s rollbackErrors = %v, want none", capability, result.RollbackErrors)
	}
	if result.AuditUnrecorded {
		t.Fatalf("apply %s auditUnrecorded = true, want false", capability)
	}
}

func assertLifecycleRolledBackApply(t *testing.T, handler http.Handler, firstCapability string, firstRequestJSON string, failingCapability string, failingRequestJSON string) {
	t.Helper()

	body := fmt.Sprintf(
		`{"operations":[{"capability":%q,"request":%s},{"capability":%q,"request":%s}]}`,
		firstCapability,
		firstRequestJSON,
		failingCapability,
		failingRequestJSON,
	)
	response := perform(handler, http.MethodPost, "/apply", body)
	if response.Code != http.StatusOK {
		t.Fatalf("rollback apply status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	var result ApplyResult
	decodeResponse(t, response, &result)
	if result.Outcome != transaction.OutcomeRolledBack {
		t.Fatalf("rollback apply outcome = %q, want %q", result.Outcome, transaction.OutcomeRolledBack)
	}
	wantApplied := []OperationResult{{Index: 0, Capability: firstCapability}}
	if !reflect.DeepEqual(result.Applied, wantApplied) {
		t.Fatalf("rollback apply applied = %v, want %v", result.Applied, wantApplied)
	}
	wantRolledBack := []OperationResult{{Index: 0, Capability: firstCapability}}
	if !reflect.DeepEqual(result.RolledBack, wantRolledBack) {
		t.Fatalf("rollback apply rolledBack = %v, want %v", result.RolledBack, wantRolledBack)
	}
	if result.Error == nil {
		t.Fatal("rollback apply error = nil, want apply_failed")
	}
	if result.Error.Code != "apply_failed" || result.Error.Capability != failingCapability {
		t.Fatalf("rollback apply error = %#v, want apply_failed for %s", result.Error, failingCapability)
	}
	if result.Error.Index == nil || *result.Error.Index != 1 {
		t.Fatalf("rollback apply error index = %v, want 1", result.Error.Index)
	}
	if len(result.RollbackErrors) != 0 {
		t.Fatalf("rollback apply rollbackErrors = %v, want none", result.RollbackErrors)
	}
	if result.AuditUnrecorded {
		t.Fatal("rollback apply auditUnrecorded = true, want false")
	}
}

func assertLifecycleRejectedApply(t *testing.T, handler http.Handler, capability string, requestJSON string) {
	t.Helper()

	body := fmt.Sprintf(`{"operations":[{"capability":%q,"request":%s}]}`, capability, requestJSON)
	response := perform(handler, http.MethodPost, "/apply", body)
	if response.Code < http.StatusBadRequest || response.Code >= http.StatusInternalServerError {
		t.Fatalf("rejected apply status code = %d, want 4xx; body=%s", response.Code, response.Body.String())
	}
	var errorResponse ErrorResponse
	decodeResponse(t, response, &errorResponse)
	if errorResponse.Error.Code != "invalid_request" {
		t.Fatalf("rejected apply error code = %q, want invalid_request", errorResponse.Error.Code)
	}
}

func assertLifecycleRead(t *testing.T, handler http.Handler, capability string, want string) {
	t.Helper()

	if got := lifecycleReadRaw(t, handler, capability); got != want {
		t.Fatalf("read %s = %s, want %s", capability, got, want)
	}
}

func assertLifecycleState(t *testing.T, handler http.Handler, want map[string]string) string {
	t.Helper()

	first := perform(handler, http.MethodGet, "/state", "")
	if first.Code != http.StatusOK {
		t.Fatalf("state status code = %d, want %d; body=%s", first.Code, http.StatusOK, first.Body.String())
	}
	second := perform(handler, http.MethodGet, "/state", "")
	if second.Code != http.StatusOK {
		t.Fatalf("second state status code = %d, want %d; body=%s", second.Code, http.StatusOK, second.Body.String())
	}
	if first.Body.String() != second.Body.String() {
		t.Fatalf("state is not byte-stable:\n first: %s\nsecond: %s", first.Body.String(), second.Body.String())
	}

	var got stateResponse
	decodeResponse(t, first, &got)
	if len(got.Capabilities) != len(want) {
		t.Fatalf("state capability count = %d, want %d; body=%s", len(got.Capabilities), len(want), first.Body.String())
	}
	for capability := range got.Capabilities {
		if _, ok := want[capability]; !ok {
			t.Fatalf("state included unexpected capability %q; body=%s", capability, first.Body.String())
		}
	}
	for capability, wantRaw := range want {
		gotRaw, ok := got.Capabilities[capability]
		if !ok {
			t.Fatalf("state missing capability %q; body=%s", capability, first.Body.String())
		}
		if string(gotRaw) != wantRaw {
			t.Fatalf("state %s = %s, want %s", capability, gotRaw, wantRaw)
		}
		if readRaw := lifecycleReadRaw(t, handler, capability); readRaw != wantRaw {
			t.Fatalf("state %s raw = %s, want read raw %s", capability, gotRaw, readRaw)
		}
	}

	return first.Body.String()
}

type lifecycleAuditWant struct {
	capability string
	outcome    auditlog.Outcome
}

func assertLifecycleAudit(t *testing.T, handler http.Handler, want []lifecycleAuditWant) {
	t.Helper()

	first := perform(handler, http.MethodGet, "/audit", "")
	if first.Code != http.StatusOK {
		t.Fatalf("audit status code = %d, want %d; body=%s", first.Code, http.StatusOK, first.Body.String())
	}
	second := perform(handler, http.MethodGet, "/audit", "")
	if second.Code != http.StatusOK {
		t.Fatalf("second audit status code = %d, want %d; body=%s", second.Code, http.StatusOK, second.Body.String())
	}
	if first.Body.String() != second.Body.String() {
		t.Fatalf("audit order is not byte-stable:\n first: %s\nsecond: %s", first.Body.String(), second.Body.String())
	}

	var got AuditResponse
	decodeResponse(t, first, &got)
	if len(got.Events) != len(want) {
		t.Fatalf("audit event count = %d, want %d; events=%#v", len(got.Events), len(want), got.Events)
	}

	wantMillis := transportStartedAt.Add(90 * time.Second).UnixMilli()
	var previousSequence uint64
	for i, event := range got.Events {
		if event.Sequence <= previousSequence {
			t.Fatalf("audit event %d sequence = %d, want > %d", i, event.Sequence, previousSequence)
		}
		previousSequence = event.Sequence
		wantSequence := uint64(i + 1)
		if event.Sequence != wantSequence {
			t.Fatalf("audit event %d sequence = %d, want %d", i, event.Sequence, wantSequence)
		}
		if event.TimestampMillis != wantMillis {
			t.Fatalf("audit event %d timestampMillis = %d, want %d", i, event.TimestampMillis, wantMillis)
		}
		if event.Actor.Kind != string(auditlog.ActorKindSystem) || event.Actor.ID != "agentd" {
			t.Fatalf("audit event %d actor = %#v, want system:agentd", i, event.Actor)
		}
		if event.Operation != string(auditlog.OperationApply) {
			t.Fatalf("audit event %d operation = %q, want %q", i, event.Operation, auditlog.OperationApply)
		}
		if event.Capability != want[i].capability || event.Outcome != string(want[i].outcome) {
			t.Fatalf("audit event %d = %s/%s, want %s/%s", i, event.Capability, event.Outcome, want[i].capability, want[i].outcome)
		}
	}
}

func lifecycleReadRaw(t *testing.T, handler http.Handler, capability string) string {
	t.Helper()

	response := perform(handler, http.MethodGet, "/read/"+capability, "")
	if response.Code != http.StatusOK {
		t.Fatalf("read %s status code = %d, want %d; body=%s", capability, response.Code, http.StatusOK, response.Body.String())
	}
	return strings.TrimSuffix(response.Body.String(), "\n")
}

type lifecycleCapability struct {
	name        string
	readRequest lifecycleReadRequest
	configValue lifecycleConfigValue
	configured  bool
	value       string
	failValues  map[string]error
}

type lifecycleReadRequest func(capabilities.TypedRequest) error

type lifecycleConfigValue func(capabilities.TypedRequest) (string, error)

func newLifecycleCapability(name string, readRequest lifecycleReadRequest, configValue lifecycleConfigValue) *lifecycleCapability {
	return &lifecycleCapability{
		name:        name,
		readRequest: readRequest,
		configValue: configValue,
		failValues:  map[string]error{},
	}
}

func (c *lifecycleCapability) Name() string {
	return c.name
}

func (c *lifecycleCapability) Handle(_ context.Context, request capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	if err := c.readRequest(request); err != nil {
		return nil, err
	}
	if !c.configured {
		return lifecycleReadResponse{Configured: false}, nil
	}
	return lifecycleReadResponse{Configured: true, Value: c.value}, nil
}

func (c *lifecycleCapability) Apply(_ context.Context, request capabilities.TypedRequest) (transaction.Undo, error) {
	value, err := c.configValue(request)
	if err != nil {
		return nil, err
	}
	if err, ok := c.failValues[value]; ok {
		return nil, err
	}

	undo := lifecycleUndo{
		capability: c,
		configured: c.configured,
		value:      c.value,
	}
	c.configured = true
	c.value = value
	return undo, nil
}

type lifecycleUndo struct {
	capability *lifecycleCapability
	configured bool
	value      string
}

func (u lifecycleUndo) Undo(context.Context) error {
	u.capability.configured = u.configured
	u.capability.value = u.value
	return nil
}

type lifecycleReadResponse struct {
	Configured bool   `json:"configured"`
	Value      string `json:"value,omitempty"`
}

func (lifecycleReadResponse) CapabilityResponse() {}

func lifecycleNodeConfigReadRequest(request capabilities.TypedRequest) error {
	if _, ok := request.(nodeconfig.ReadRequest); !ok {
		return fmt.Errorf("%s read request = %T, want nodeconfig.ReadRequest", lifecycleCapA, request)
	}
	return nil
}

func lifecycleServicesReadRequest(request capabilities.TypedRequest) error {
	if _, ok := request.(services.ReadRequest); !ok {
		return fmt.Errorf("%s read request = %T, want services.ReadRequest", lifecycleCapB, request)
	}
	return nil
}

func lifecycleTimesyncReadRequest(request capabilities.TypedRequest) error {
	if _, ok := request.(timesync.ReadRequest); !ok {
		return fmt.Errorf("%s read request = %T, want timesync.ReadRequest", lifecycleCapC, request)
	}
	return nil
}

func lifecycleNodeConfigConfigValue(request capabilities.TypedRequest) (string, error) {
	typedRequest, ok := request.(nodeconfig.ApplyRequest)
	if !ok {
		return "", fmt.Errorf("%s apply request = %T, want nodeconfig.ApplyRequest", lifecycleCapA, request)
	}
	return fmt.Sprintf("mode=%s;remoteAccess=%s", typedRequest.Desired.Mode, typedRequest.Desired.RemoteAccess), nil
}

func lifecycleServicesConfigValue(request capabilities.TypedRequest) (string, error) {
	typedRequest, ok := request.(services.ApplyRequest)
	if !ok {
		return "", fmt.Errorf("%s apply request = %T, want services.ApplyRequest", lifecycleCapB, request)
	}
	if typedRequest.Desired == nil || typedRequest.Desired.Services == nil {
		return "", errors.New("services desired services missing after validation")
	}
	entries := *typedRequest.Desired.Services
	parts := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.Enabled == nil {
			return "", errors.New("services entry enabled missing after validation")
		}
		parts = append(parts, fmt.Sprintf("%s:%t", entry.Name, *entry.Enabled))
	}
	return "services=" + strings.Join(parts, ","), nil
}

func lifecycleTimesyncConfigValue(request capabilities.TypedRequest) (string, error) {
	typedRequest, ok := request.(timesync.ApplyRequest)
	if !ok {
		return "", fmt.Errorf("%s apply request = %T, want timesync.ApplyRequest", lifecycleCapC, request)
	}
	if typedRequest.Desired == nil || typedRequest.Desired.Enabled == nil {
		return "", errors.New("timesync desired enabled missing after validation")
	}
	return fmt.Sprintf("enabled=%t;servers=%s", *typedRequest.Desired.Enabled, strings.Join(typedRequest.Desired.Servers, ",")), nil
}
