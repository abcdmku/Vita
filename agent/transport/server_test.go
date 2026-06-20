package transport

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
	"github.com/vita/agent/capabilities/hostname"
	"github.com/vita/agent/capabilities/nodeconfig"
	nodetime "github.com/vita/agent/capabilities/time"
	"github.com/vita/agent/hardware"
	"github.com/vita/agent/status"
	"github.com/vita/agent/transaction"
)

var (
	transportStartedAt = time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	errMockApply       = errors.New("mock apply failed")
)

func TestReadRoutesReturnExpectedJSON(t *testing.T) {
	registry := mustRegistry(t, &mockTxCapability{name: "test.apply"})
	discovered := hardware.Capabilities{
		CPU: hardware.CPUCapabilities{
			Arch:  "x86_64",
			Cores: 8,
			Model: "fixture cpu",
		},
		Memory: hardware.MemoryCapabilities{TotalMiB: 16_384},
		Storage: []hardware.StorageDevice{
			{Name: "nvme0n1", SizeMiB: 512_000, NVMe: true},
		},
		Networking: hardware.NetworkingCapabilities{
			Interfaces: []hardware.NetworkInterface{{Name: "lo", Kind: "loopback"}},
		},
		TPM:            hardware.TPMCapabilities{Present: true, Version: "2.0"},
		Virtualization: hardware.VirtualizationCapabilities{Hardware: true},
		Accelerators: []hardware.AcceleratorCapability{
			{Kind: hardware.AcceleratorCPU, Architecture: "x86_64"},
		},
	}
	handler := mustHandler(t, handlerConfig{
		registry:   registry,
		discoverer: stubDiscoverer{capabilities: discovered},
	})

	healthResponse := perform(handler, http.MethodGet, "/healthz", "")
	if healthResponse.Code != http.StatusOK {
		t.Fatalf("health status code = %d, want %d", healthResponse.Code, http.StatusOK)
	}
	if contentType := healthResponse.Header().Get("Content-Type"); contentType != "application/json" {
		t.Fatalf("health Content-Type = %q, want application/json", contentType)
	}
	for _, disallowed := range []string{"secret", "token", "password"} {
		if strings.Contains(strings.ToLower(healthResponse.Body.String()), disallowed) {
			t.Fatalf("health response contains disallowed %q: %s", disallowed, healthResponse.Body.String())
		}
	}

	var health status.Status
	decodeResponse(t, healthResponse, &health)
	if health.Version != "test-version" {
		t.Fatalf("health Version = %q, want test-version", health.Version)
	}
	if !health.StartedAt.Equal(transportStartedAt) {
		t.Fatalf("health StartedAt = %s, want %s", health.StartedAt, transportStartedAt)
	}
	if health.UptimeSeconds != 90 {
		t.Fatalf("health UptimeSeconds = %d, want 90", health.UptimeSeconds)
	}
	if !health.Healthy {
		t.Fatal("health Healthy = false, want true")
	}
	if !reflect.DeepEqual(health.Capabilities, []string{"test.apply"}) {
		t.Fatalf("health Capabilities = %v, want [test.apply]", health.Capabilities)
	}

	capabilitiesResponse := perform(handler, http.MethodGet, "/capabilities", "")
	if capabilitiesResponse.Code != http.StatusOK {
		t.Fatalf("capabilities status code = %d, want %d", capabilitiesResponse.Code, http.StatusOK)
	}
	var got hardware.Capabilities
	decodeResponse(t, capabilitiesResponse, &got)
	if !reflect.DeepEqual(got, discovered) {
		t.Fatalf("capabilities response = %#v, want %#v", got, discovered)
	}
}

func TestApplyCommitsValidPlan(t *testing.T) {
	events := []string{}
	registry := mustRegistry(t, &mockTxCapability{name: "test.apply", events: &events})
	handler := mustHandler(t, handlerConfig{registry: registry})

	response := perform(handler, http.MethodPost, "/apply", `{"operations":[{"capability":"test.apply","request":{"value":"one"}}]}`)

	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	var result ApplyResult
	decodeResponse(t, response, &result)
	if result.Outcome != transaction.OutcomeCommitted {
		t.Fatalf("Outcome = %q, want %q", result.Outcome, transaction.OutcomeCommitted)
	}
	wantApplied := []OperationResult{{Index: 0, Capability: "test.apply"}}
	if !reflect.DeepEqual(result.Applied, wantApplied) {
		t.Fatalf("Applied = %v, want %v", result.Applied, wantApplied)
	}
	if len(result.RolledBack) != 0 {
		t.Fatalf("RolledBack = %v, want none", result.RolledBack)
	}
	if result.Error != nil {
		t.Fatalf("Error = %#v, want nil", result.Error)
	}
	if len(result.RollbackErrors) != 0 {
		t.Fatalf("RollbackErrors = %v, want none", result.RollbackErrors)
	}
	if !reflect.DeepEqual(events, []string{"apply:one"}) {
		t.Fatalf("events = %v, want [apply:one]", events)
	}
}

func TestRegisteredAgentCapabilitiesAreDiscoverableAndApplicable(t *testing.T) {
	events := []string{}
	desiredConfig := nodeconfig.Config{Mode: nodeconfig.ModeMaintenance, RemoteAccess: nodeconfig.RemoteAccessEnabled}
	desiredTime := time.Date(2026, 6, 20, 12, 1, 0, 0, time.UTC)
	desiredHostname := "vita-node-2"
	registry := mustRegistry(t,
		&routedTxCapability{
			name:   nodeconfig.Name,
			events: &events,
			apply: func(request capabilities.TypedRequest) error {
				typedRequest, ok := request.(nodeconfig.ApplyRequest)
				if !ok {
					return fmt.Errorf("nodeconfig request = %T, want nodeconfig.ApplyRequest", request)
				}
				if typedRequest.Desired != desiredConfig {
					return fmt.Errorf("nodeconfig desired = %#v, want %#v", typedRequest.Desired, desiredConfig)
				}
				return nil
			},
		},
		&routedTxCapability{
			name:   nodetime.Name,
			events: &events,
			apply: func(request capabilities.TypedRequest) error {
				typedRequest, ok := request.(nodetime.ApplyRequest)
				if !ok {
					return fmt.Errorf("time request = %T, want nodetime.ApplyRequest", request)
				}
				if !typedRequest.Desired.Equal(desiredTime) {
					return fmt.Errorf("time desired = %s, want %s", typedRequest.Desired, desiredTime)
				}
				return nil
			},
		},
		&routedTxCapability{
			name:   hostname.Name,
			events: &events,
			apply: func(request capabilities.TypedRequest) error {
				typedRequest, ok := request.(hostname.ApplyRequest)
				if !ok {
					return fmt.Errorf("hostname request = %T, want hostname.ApplyRequest", request)
				}
				if typedRequest.Desired != desiredHostname {
					return fmt.Errorf("hostname desired = %q, want %q", typedRequest.Desired, desiredHostname)
				}
				return nil
			},
		},
	)
	handler := mustHandler(t, handlerConfig{registry: registry})

	capabilitiesResponse := perform(handler, http.MethodGet, "/capabilities", "")
	if capabilitiesResponse.Code != http.StatusOK {
		t.Fatalf("capabilities status code = %d, want %d; body=%s", capabilitiesResponse.Code, http.StatusOK, capabilitiesResponse.Body.String())
	}
	var discovered struct {
		Capabilities []string `json:"capabilities"`
	}
	decodeResponse(t, capabilitiesResponse, &discovered)
	wantCapabilities := []string{hostname.Name, nodeconfig.Name, nodetime.Name}
	if !reflect.DeepEqual(discovered.Capabilities, wantCapabilities) {
		t.Fatalf("capabilities = %v, want %v", discovered.Capabilities, wantCapabilities)
	}

	response := perform(handler, http.MethodPost, "/apply", `{"operations":[{"capability":"node.config","request":{"desired":{"mode":"maintenance","remoteAccess":"enabled"}}},{"capability":"time.set","request":{"desired":"2026-06-20T12:01:00Z"}},{"capability":"hostname.set","request":{"desired":"vita-node-2"}}]}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	var result ApplyResult
	decodeResponse(t, response, &result)
	if result.Outcome != transaction.OutcomeCommitted {
		t.Fatalf("Outcome = %q, want %q; error=%#v", result.Outcome, transaction.OutcomeCommitted, result.Error)
	}
	wantApplied := []OperationResult{
		{Index: 0, Capability: nodeconfig.Name},
		{Index: 1, Capability: nodetime.Name},
		{Index: 2, Capability: hostname.Name},
	}
	if !reflect.DeepEqual(result.Applied, wantApplied) {
		t.Fatalf("Applied = %v, want %v", result.Applied, wantApplied)
	}
	if result.Error != nil {
		t.Fatalf("Error = %#v, want nil", result.Error)
	}
	wantEvents := []string{nodeconfig.Name, nodetime.Name, hostname.Name}
	if !reflect.DeepEqual(events, wantEvents) {
		t.Fatalf("events = %v, want %v", events, wantEvents)
	}
}

func TestApplySurfacesRolledBackResult(t *testing.T) {
	events := []string{}
	registry := mustRegistry(t,
		&mockTxCapability{name: "test.first", events: &events},
		&mockTxCapability{name: "test.second", applyErr: errMockApply, events: &events},
	)
	handler := mustHandler(t, handlerConfig{registry: registry})

	response := perform(handler, http.MethodPost, "/apply", `{"operations":[{"capability":"test.first","request":{"value":"one"}},{"capability":"test.second","request":{"value":"two"}}]}`)

	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	var result ApplyResult
	decodeResponse(t, response, &result)
	if result.Outcome != transaction.OutcomeRolledBack {
		t.Fatalf("Outcome = %q, want %q", result.Outcome, transaction.OutcomeRolledBack)
	}
	if result.Error == nil {
		t.Fatal("Error = nil, want apply failure")
	}
	if result.Error.Code != "apply_failed" || result.Error.Capability != "test.second" || result.Error.Index == nil || *result.Error.Index != 1 {
		t.Fatalf("Error = %#v, want apply_failed for operation 1 test.second", result.Error)
	}
	wantRolledBack := []OperationResult{{Index: 0, Capability: "test.first"}}
	if !reflect.DeepEqual(result.RolledBack, wantRolledBack) {
		t.Fatalf("RolledBack = %v, want %v", result.RolledBack, wantRolledBack)
	}
	wantEvents := []string{"apply:one", "apply:two", "undo:one"}
	if !reflect.DeepEqual(events, wantEvents) {
		t.Fatalf("events = %v, want %v", events, wantEvents)
	}
}

func TestApplyFailClosedBodyHandlingAppliesNothing(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		maxBytes   int64
		wantStatus int
	}{
		{
			name:       "malformed JSON",
			body:       `{"operations":[`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "unknown top-level field",
			body:       `{"operations":[],"extra":true}`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "unknown request field",
			body:       `{"operations":[{"capability":"test.apply","request":{"value":"one","extra":true}}]}`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "oversized body",
			body:       `{"operations":[{"capability":"test.apply","request":{"value":"one"}}]}`,
			maxBytes:   16,
			wantStatus: http.StatusRequestEntityTooLarge,
		},
		{
			name:       "unknown capability",
			body:       `{"operations":[{"capability":"test.missing","request":{"value":"one"}}]}`,
			wantStatus: http.StatusBadRequest,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			events := []string{}
			registry := mustRegistry(t, &mockTxCapability{name: "test.apply", events: &events})
			handler := mustHandler(t, handlerConfig{registry: registry, maxBodyBytes: tt.maxBytes})

			defer func() {
				if recovered := recover(); recovered != nil {
					t.Fatalf("handler panicked: %v", recovered)
				}
			}()

			response := perform(handler, http.MethodPost, "/apply", tt.body)
			if response.Code != tt.wantStatus {
				t.Fatalf("status code = %d, want %d; body=%s", response.Code, tt.wantStatus, response.Body.String())
			}
			var errorResponse ErrorResponse
			decodeResponse(t, response, &errorResponse)
			if errorResponse.Error.Code == "" {
				t.Fatalf("error response missing typed code: %#v", errorResponse)
			}
			if len(events) != 0 {
				t.Fatalf("events = %v, want no apply calls", events)
			}
		})
	}
}

func TestApplyRejectsIncompleteNodeConfigBeforeTransaction(t *testing.T) {
	registry := mustRegistry(t, nodeconfig.NewCapability())
	handler := mustHandler(t, handlerConfig{registry: registry})

	response := perform(handler, http.MethodPost, "/apply", `{"operations":[{"capability":"node.config","request":{"desired":{"mode":"normal"}}}]}`)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusBadRequest, response.Body.String())
	}
	var errorResponse ErrorResponse
	decodeResponse(t, response, &errorResponse)
	if errorResponse.Error.Code != "invalid_request" {
		t.Fatalf("error code = %q, want invalid_request", errorResponse.Error.Code)
	}
	if !strings.Contains(errorResponse.Error.Message, "remoteAccess") {
		t.Fatalf("error message = %q, want remoteAccess validation", errorResponse.Error.Message)
	}
}

func TestApplyRejectsValidOpBeforeIncompleteOpWithoutApplying(t *testing.T) {
	events := []string{}
	registry := mustRegistry(t,
		&mockTxCapability{name: "test.apply", events: &events},
		nodeconfig.NewCapability(),
	)
	handler := mustHandler(t, handlerConfig{registry: registry})

	response := perform(handler, http.MethodPost, "/apply", `{"operations":[{"capability":"test.apply","request":{"value":"one"}},{"capability":"node.config","request":{"desired":{"mode":"normal"}}}]}`)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusBadRequest, response.Body.String())
	}
	if len(events) != 0 {
		t.Fatalf("events = %v, want no apply calls before incomplete op rejection", events)
	}
}

func TestMethodAndPathGuards(t *testing.T) {
	handler := mustHandler(t, handlerConfig{registry: mustRegistry(t, &mockTxCapability{name: "test.apply"})})
	tests := []struct {
		name        string
		method      string
		path        string
		wantStatus  int
		wantAllowed string
	}{
		{name: "health rejects non GET", method: http.MethodPost, path: "/healthz", wantStatus: http.StatusMethodNotAllowed, wantAllowed: http.MethodGet},
		{name: "capabilities rejects non GET", method: http.MethodPost, path: "/capabilities", wantStatus: http.StatusMethodNotAllowed, wantAllowed: http.MethodGet},
		{name: "apply rejects non POST", method: http.MethodGet, path: "/apply", wantStatus: http.StatusMethodNotAllowed, wantAllowed: http.MethodPost},
		{name: "unknown path", method: http.MethodGet, path: "/missing", wantStatus: http.StatusNotFound},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			response := perform(handler, tt.method, tt.path, "")
			if response.Code != tt.wantStatus {
				t.Fatalf("status code = %d, want %d; body=%s", response.Code, tt.wantStatus, response.Body.String())
			}
			if tt.wantAllowed != "" && response.Header().Get("Allow") != tt.wantAllowed {
				t.Fatalf("Allow = %q, want %q", response.Header().Get("Allow"), tt.wantAllowed)
			}
		})
	}
}

func TestLoopbackTCPAddrGuard(t *testing.T) {
	if !IsLoopbackTCPAddr("127.0.0.1:8786") {
		t.Fatal("127.0.0.1:8786 was not accepted as loopback")
	}
	if !IsLoopbackTCPAddr("[::1]:8786") {
		t.Fatal("[::1]:8786 was not accepted as loopback")
	}
	for _, addr := range []string{":8786", "0.0.0.0:8786", "192.0.2.10:8786", "localhost:8786", "not-a-socket"} {
		if IsLoopbackTCPAddr(addr) {
			t.Fatalf("%q was accepted, want rejected", addr)
		}
	}
}

type handlerConfig struct {
	registry     *capabilities.Registry
	discoverer   hardware.Discoverer
	maxBodyBytes int64
}

func mustHandler(t *testing.T, config handlerConfig) http.Handler {
	t.Helper()

	discoverer := config.discoverer
	if discoverer == nil {
		discoverer = stubDiscoverer{capabilities: hardware.Capabilities{
			CPU: hardware.CPUCapabilities{Arch: "x86_64", Cores: 1, Model: "fixture"},
			Accelerators: []hardware.AcceleratorCapability{
				{Kind: hardware.AcceleratorCPU, Architecture: "x86_64"},
			},
		}}
	}

	handler, err := NewHandler(Config{
		Version:         "test-version",
		StartedAt:       transportStartedAt,
		Registry:        config.registry,
		Discoverer:      discoverer,
		RequestDecoders: map[string]RequestDecoder{"test.apply": decodeMockRequest, "test.first": decodeMockRequest, "test.second": decodeMockRequest},
		MaxBodyBytes:    config.maxBodyBytes,
		Now: func() time.Time {
			return transportStartedAt.Add(90 * time.Second)
		},
	})
	if err != nil {
		t.Fatalf("NewHandler returned error: %v", err)
	}
	return handler
}

func perform(handler http.Handler, method string, path string, body string) *httptest.ResponseRecorder {
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}

	request := httptest.NewRequest(method, path, reader)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func decodeResponse(t *testing.T, response *httptest.ResponseRecorder, target interface{}) {
	t.Helper()

	if err := json.Unmarshal(response.Body.Bytes(), target); err != nil {
		t.Fatalf("response body is not expected JSON: %v; body=%s", err, response.Body.String())
	}
}

type stubDiscoverer struct {
	capabilities hardware.Capabilities
	err          error
}

func (d stubDiscoverer) Discover(context.Context) (hardware.Capabilities, error) {
	if d.err != nil {
		return hardware.Capabilities{}, d.err
	}
	return d.capabilities, nil
}

type mockRequest struct {
	Value string `json:"value"`
}

func (mockRequest) CapabilityRequest() {}

func (r mockRequest) Validate() error {
	if r.Value == "" {
		return errors.New("value is required")
	}
	return nil
}

func decodeMockRequest(raw json.RawMessage) (capabilities.TypedRequest, error) {
	return DecodeJSONRequest[mockRequest](raw)
}

type mockResponse struct{}

func (mockResponse) CapabilityResponse() {}

type mockTxCapability struct {
	name     string
	applyErr error
	events   *[]string
}

func (c *mockTxCapability) Name() string {
	return c.name
}

func (c *mockTxCapability) Handle(context.Context, capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	return mockResponse{}, nil
}

func (c *mockTxCapability) Apply(_ context.Context, request capabilities.TypedRequest) (transaction.Undo, error) {
	typedRequest, ok := request.(mockRequest)
	if !ok {
		return nil, errors.New("unexpected mock request")
	}
	if c.events != nil {
		*c.events = append(*c.events, "apply:"+typedRequest.Value)
	}
	if c.applyErr != nil {
		return nil, c.applyErr
	}
	return mockUndo{value: typedRequest.Value, events: c.events}, nil
}

type routedTxCapability struct {
	name   string
	apply  func(capabilities.TypedRequest) error
	events *[]string
}

func (c *routedTxCapability) Name() string {
	return c.name
}

func (c *routedTxCapability) Handle(context.Context, capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	return mockResponse{}, nil
}

func (c *routedTxCapability) Apply(_ context.Context, request capabilities.TypedRequest) (transaction.Undo, error) {
	if c.apply != nil {
		if err := c.apply(request); err != nil {
			return nil, err
		}
	}
	if c.events != nil {
		*c.events = append(*c.events, c.name)
	}
	return noopUndo{}, nil
}

type noopUndo struct{}

func (noopUndo) Undo(context.Context) error {
	return nil
}

type mockUndo struct {
	value  string
	events *[]string
}

func (u mockUndo) Undo(context.Context) error {
	if u.events != nil {
		*u.events = append(*u.events, "undo:"+u.value)
	}
	return nil
}

func mustRegistry(t *testing.T, registered ...capabilities.Capability) *capabilities.Registry {
	t.Helper()

	registry, err := capabilities.NewRegistry(registered...)
	if err != nil {
		t.Fatalf("NewRegistry returned error: %v", err)
	}
	return registry
}
