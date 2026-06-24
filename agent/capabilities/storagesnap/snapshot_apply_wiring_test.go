package storagesnap_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/capabilities/storagesnap"
	"github.com/vita/agent/transaction"
	"github.com/vita/agent/transport"
)

var errSnapshotBeforeApply = errors.New("snapshot before apply failed")

func TestAgentApplyPathTakesSnapshotBeforeRepresentativeMutation(t *testing.T) {
	state := &representativeState{value: "before"}
	snapshotter := &agentPathSnapshotCapability{state: state}
	mutator := &representativeMutationCapability{state: state}
	handler := newApplyPathHandler(t, snapshotter, mutator)

	response := performApply(handler, `{"operations":[{"capability":"test.mutate","request":{"value":"after"}}]}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}

	var result transport.ApplyResult
	decodeResponse(t, response, &result)
	if result.Outcome != transaction.OutcomeCommitted {
		t.Fatalf("outcome = %q, want committed; error=%#v", result.Outcome, result.Error)
	}
	if state.value != "after" {
		t.Fatalf("state after apply = %q, want after", state.value)
	}
	if !reflect.DeepEqual(state.events, []string{"snapshot:apply:before", "apply:after"}) {
		t.Fatalf("events = %v, want snapshot before apply", state.events)
	}
	if len(snapshotter.snapshots) != 1 {
		t.Fatalf("snapshots = %d, want 1", len(snapshotter.snapshots))
	}
	snapshot := snapshotter.snapshots[0]
	if !snapshot.info.ReadOnly {
		t.Fatal("snapshot-before-apply target is not read-only")
	}
	if snapshot.value != "before" {
		t.Fatalf("snapshot captured %q, want pre-apply state before", snapshot.value)
	}
}

func TestAgentApplyPathSnapshotFailureBlocksMutation(t *testing.T) {
	state := &representativeState{value: "before"}
	snapshotter := &agentPathSnapshotCapability{state: state, err: errSnapshotBeforeApply}
	mutator := &representativeMutationCapability{state: state}
	handler := newApplyPathHandler(t, snapshotter, mutator)

	response := performApply(handler, `{"operations":[{"capability":"test.mutate","request":{"value":"after"}}]}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}

	var result transport.ApplyResult
	decodeResponse(t, response, &result)
	if result.Outcome != transaction.OutcomeRolledBack {
		t.Fatalf("outcome = %q, want rolledBack", result.Outcome)
	}
	if result.Error == nil {
		t.Fatal("error = nil, want storage.snapshot apply failure")
	}
	if result.Error.Capability != storagesnap.Name {
		t.Fatalf("error capability = %q, want %q", result.Error.Capability, storagesnap.Name)
	}
	if state.value != "before" {
		t.Fatalf("state after failed snapshot = %q, want unchanged before", state.value)
	}
	if !reflect.DeepEqual(state.events, []string{"snapshot:apply:before"}) {
		t.Fatalf("events = %v, want only snapshot attempt", state.events)
	}
}

type representativeState struct {
	value  string
	events []string
}

type capturedSnapshot struct {
	info  storagesnap.SnapshotInfo
	value string
}

type agentPathSnapshotCapability struct {
	state     *representativeState
	err       error
	nextID    uint64
	snapshots []capturedSnapshot
}

func (c *agentPathSnapshotCapability) Name() string {
	return storagesnap.Name
}

func (c *agentPathSnapshotCapability) Handle(context.Context, capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	out := make([]storagesnap.SnapshotInfo, len(c.snapshots))
	for i, snapshot := range c.snapshots {
		out[i] = snapshot.info
	}
	return storagesnap.ListResponse{Snapshots: out}, nil
}

func (c *agentPathSnapshotCapability) Apply(context.Context, capabilities.TypedRequest) (transaction.Undo, error) {
	return noopUndo{}, nil
}

func (c *agentPathSnapshotCapability) SnapshotBeforeApply(_ context.Context, tag string) (storagesnap.SnapshotInfo, error) {
	c.state.events = append(c.state.events, fmt.Sprintf("snapshot:%s:%s", tag, c.state.value))
	if c.err != nil {
		return storagesnap.SnapshotInfo{}, c.err
	}
	c.nextID++
	info := storagesnap.SnapshotInfo{
		Name:      fmt.Sprintf("vita-20260624T120000Z-%06d-%s", c.nextID, tag),
		ID:        c.nextID,
		CreatedAt: time.Date(2026, 6, 24, 12, 0, 0, 0, time.UTC),
		ReadOnly:  true,
	}
	c.snapshots = append(c.snapshots, capturedSnapshot{info: info, value: c.state.value})
	return info, nil
}

type representativeMutationCapability struct {
	state *representativeState
}

func (c *representativeMutationCapability) Name() string {
	return "test.mutate"
}

func (c *representativeMutationCapability) Handle(context.Context, capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	return emptyResponse{}, nil
}

func (c *representativeMutationCapability) Apply(_ context.Context, req capabilities.TypedRequest) (transaction.Undo, error) {
	typed, ok := req.(representativeMutationRequest)
	if !ok {
		return nil, fmt.Errorf("request = %T, want representativeMutationRequest", req)
	}
	prior := c.state.value
	c.state.events = append(c.state.events, "apply:"+typed.Value)
	c.state.value = typed.Value
	return representativeUndo{state: c.state, prior: prior}, nil
}

type representativeMutationRequest struct {
	Value string `json:"value"`
}

func (representativeMutationRequest) CapabilityRequest() {}

func (r representativeMutationRequest) Validate() error {
	if r.Value == "" {
		return errors.New("value is required")
	}
	return nil
}

type representativeUndo struct {
	state *representativeState
	prior string
}

func (u representativeUndo) Undo(context.Context) error {
	u.state.value = u.prior
	u.state.events = append(u.state.events, "undo:"+u.prior)
	return nil
}

type noopUndo struct{}

func (noopUndo) Undo(context.Context) error { return nil }

type emptyResponse struct{}

func (emptyResponse) CapabilityResponse() {}

func newApplyPathHandler(t *testing.T, snapshotter *agentPathSnapshotCapability, mutator *representativeMutationCapability) http.Handler {
	t.Helper()

	registry, err := capabilities.NewRegistry(snapshotter, mutator)
	if err != nil {
		t.Fatalf("NewRegistry returned error: %v", err)
	}
	handler, err := transport.NewHandler(transport.Config{
		Version:   "test",
		Registry:  registry,
		StartedAt: time.Date(2026, 6, 24, 12, 0, 0, 0, time.UTC),
		RequestDecoders: map[string]transport.RequestDecoder{
			"test.mutate": decodeRepresentativeMutationRequest,
		},
	})
	if err != nil {
		t.Fatalf("NewHandler returned error: %v", err)
	}
	return handler
}

func decodeRepresentativeMutationRequest(raw json.RawMessage) (capabilities.TypedRequest, error) {
	var request representativeMutationRequest
	if err := json.Unmarshal(raw, &request); err != nil {
		return nil, err
	}
	return request, nil
}

func performApply(handler http.Handler, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/apply", strings.NewReader(body))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func decodeResponse(t *testing.T, response *httptest.ResponseRecorder, target interface{}) {
	t.Helper()
	if err := json.Unmarshal(response.Body.Bytes(), target); err != nil {
		t.Fatalf("response body is not JSON: %v; body=%s", err, response.Body.String())
	}
}
