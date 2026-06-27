package transport

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
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
	"github.com/vita/agent/internal/storagehealth"
	"github.com/vita/agent/status"
	"github.com/vita/agent/transaction"
)

var (
	transportStartedAt = time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	transportSHA256SRI = "sha256-" + base64.StdEncoding.EncodeToString(make([]byte, 32))
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
	if health.Healthy {
		t.Fatal("health Healthy = true, want false without live health sources")
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

func TestReadReturnsRegisteredCapabilityHandleResponse(t *testing.T) {
	events := []string{}
	registry := mustRegistry(t, &mockReadCapability{
		name:     "test.read",
		response: mockReadResponse{Value: "stored-state", Count: 2},
		events:   &events,
	})
	handler := mustHandler(t, handlerConfig{
		registry: registry,
		readRequests: map[string]ReadRequestFactory{
			"test.read": func() capabilities.TypedRequest { return mockReadRequest{} },
		},
	})

	response := perform(handler, http.MethodGet, "/read/test.read", "")

	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	if contentType := response.Header().Get("Content-Type"); contentType != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", contentType)
	}
	var got mockReadResponse
	decodeResponse(t, response, &got)
	want := mockReadResponse{Value: "stored-state", Count: 2}
	if got != want {
		t.Fatalf("read response = %#v, want %#v", got, want)
	}
	if !reflect.DeepEqual(events, []string{"handle:test.read"}) {
		t.Fatalf("events = %v, want [handle:test.read]", events)
	}
}

func TestReadUnknownCapabilityReturns404(t *testing.T) {
	handler := mustHandler(t, handlerConfig{registry: mustRegistry(t, &mockReadCapability{name: "test.read"})})

	response := perform(handler, http.MethodGet, "/read/missing", "")

	if response.Code != http.StatusNotFound {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusNotFound, response.Body.String())
	}
	var errorResponse ErrorResponse
	decodeResponse(t, response, &errorResponse)
	if errorResponse.Error.Code != "unknown_capability" {
		t.Fatalf("error code = %q, want unknown_capability", errorResponse.Error.Code)
	}
}

func TestReadHandleErrorReturnsTypedError(t *testing.T) {
	events := []string{}
	registry := mustRegistry(t, &mockReadCapability{
		name:   "test.read",
		err:    errors.New("read failed"),
		events: &events,
	})
	handler := mustHandler(t, handlerConfig{
		registry: registry,
		readRequests: map[string]ReadRequestFactory{
			"test.read": func() capabilities.TypedRequest { return mockReadRequest{} },
		},
	})

	defer func() {
		if recovered := recover(); recovered != nil {
			t.Fatalf("handler panicked: %v", recovered)
		}
	}()

	response := perform(handler, http.MethodGet, "/read/test.read", "")

	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusInternalServerError, response.Body.String())
	}
	var errorResponse ErrorResponse
	decodeResponse(t, response, &errorResponse)
	if errorResponse.Error.Code != "capability_read_failed" {
		t.Fatalf("error code = %q, want capability_read_failed", errorResponse.Error.Code)
	}
	if !strings.Contains(errorResponse.Error.Message, "read failed") {
		t.Fatalf("error message = %q, want read failure detail", errorResponse.Error.Message)
	}
	if !reflect.DeepEqual(events, []string{"handle:test.read"}) {
		t.Fatalf("events = %v, want [handle:test.read]", events)
	}
}

func TestStateReturnsAllRegisteredCapabilitiesSortedAndReadIdentical(t *testing.T) {
	registrations := []struct {
		name    string
		ordinal int
	}{
		{name: update.Name, ordinal: 16},
		{name: timesync.Name, ordinal: 15},
		{name: nodetime.Name, ordinal: 14},
		{name: storage.Name, ordinal: 13},
		{name: services.Name, ordinal: 12},
		{name: pdssync.Name, ordinal: 11},
		{name: nodeconfig.Name, ordinal: 10},
		{name: network.Name, ordinal: 9},
		{name: identity.Name, ordinal: 8},
		{name: hostname.Name, ordinal: 7},
		{name: capsule.Name, ordinal: 6},
		{name: capsule.LifecycleName, ordinal: 5},
		{name: capsule.FetchName, ordinal: 4},
		{name: capsule.ExecuteName, ordinal: 3},
		{name: backup.Name, ordinal: 2},
		{name: accounts.Name, ordinal: 1},
	}
	registered := make([]capabilities.Capability, 0, len(registrations))
	for _, registration := range registrations {
		registered = append(registered, &stateReadCapability{
			name: registration.name,
			response: stateReadResponse{
				Name:    registration.name,
				Ordinal: registration.ordinal,
			},
		})
	}
	handler := mustHandler(t, handlerConfig{registry: mustRegistry(t, registered...)})

	response := perform(handler, http.MethodGet, "/state", "")

	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	if contentType := response.Header().Get("Content-Type"); contentType != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", contentType)
	}

	wantNames := registeredCapabilityNames()
	assertCapabilityKeyOrder(t, response.Body.String(), wantNames)

	var got stateResponse
	decodeResponse(t, response, &got)
	if len(got.Capabilities) != len(wantNames) {
		t.Fatalf("capabilities count = %d, want %d; capabilities=%v", len(got.Capabilities), len(wantNames), got.Capabilities)
	}

	for _, name := range wantNames {
		gotRaw, ok := got.Capabilities[name]
		if !ok {
			t.Fatalf("state missing capability %q", name)
		}

		readResponse := perform(handler, http.MethodGet, "/read/"+name, "")
		if readResponse.Code != http.StatusOK {
			t.Fatalf("%s read status code = %d, want %d; body=%s", name, readResponse.Code, http.StatusOK, readResponse.Body.String())
		}
		wantRaw := bytes.TrimSuffix(readResponse.Body.Bytes(), []byte("\n"))
		if !bytes.Equal(gotRaw, wantRaw) {
			t.Fatalf("%s state raw = %s, want read raw = %s", name, gotRaw, wantRaw)
		}
	}
}

func TestStateIsolatesReadErrorWithoutLeakingInternals(t *testing.T) {
	events := []string{}
	registry := mustRegistry(t,
		&stateReadCapability{
			name:     "test.good",
			response: stateReadResponse{Name: "test.good", Ordinal: 1},
			events:   &events,
		},
		&stateReadCapability{
			name:   "test.bad",
			err:    errors.New("open /secret/private.json: token denied"),
			events: &events,
		},
	)
	handler := mustHandler(t, handlerConfig{
		registry: registry,
		readRequests: map[string]ReadRequestFactory{
			"test.bad":  func() capabilities.TypedRequest { return mockReadRequest{} },
			"test.good": func() capabilities.TypedRequest { return mockReadRequest{} },
		},
	})

	response := perform(handler, http.MethodGet, "/state", "")

	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	var got stateResponse
	decodeResponse(t, response, &got)

	goodRead := perform(handler, http.MethodGet, "/read/test.good", "")
	if goodRead.Code != http.StatusOK {
		t.Fatalf("good read status code = %d, want %d; body=%s", goodRead.Code, http.StatusOK, goodRead.Body.String())
	}
	if !bytes.Equal(got.Capabilities["test.good"], bytes.TrimSuffix(goodRead.Body.Bytes(), []byte("\n"))) {
		t.Fatalf("good state raw = %s, want read raw = %s", got.Capabilities["test.good"], bytes.TrimSuffix(goodRead.Body.Bytes(), []byte("\n")))
	}

	var bad stateCapabilityError
	if err := json.Unmarshal(got.Capabilities["test.bad"], &bad); err != nil {
		t.Fatalf("bad capability entry is not typed error JSON: %v; raw=%s", err, got.Capabilities["test.bad"])
	}
	if bad.Error != "capability_read_failed" {
		t.Fatalf("bad error = %q, want capability_read_failed", bad.Error)
	}
	for _, disallowed := range []string{"secret", "token", "private"} {
		if strings.Contains(strings.ToLower(response.Body.String()), disallowed) {
			t.Fatalf("state response leaked %q: %s", disallowed, response.Body.String())
		}
	}
	wantEvents := []string{"handle:test.bad", "handle:test.good", "handle:test.good"}
	if !reflect.DeepEqual(events, wantEvents) {
		t.Fatalf("events = %v, want %v", events, wantEvents)
	}
}

func TestStateIncludesCapsuleWorkloads(t *testing.T) {
	workloads := []capsuleruntime.WorkloadStatus{
		{
			ID:       "local.zed.capsule",
			Unit:     "vita-capsule-zed.service",
			Status:   capsuleruntime.StatusDown,
			Health:   capsuleruntime.StatusDown,
			Restarts: 4,
		},
		{
			ID:       "local.test.capsule",
			Unit:     "vita-capsule-test.service",
			Status:   capsuleruntime.StatusOK,
			Health:   capsuleruntime.StatusOK,
			Restarts: 2,
		},
	}
	registry := mustRegistry(t, &stateReadCapability{
		name:     "test.good",
		response: stateReadResponse{Name: "test.good", Ordinal: 1},
	})
	handler := mustHandler(t, handlerConfig{
		registry: registry,
		readRequests: map[string]ReadRequestFactory{
			"test.good": func() capabilities.TypedRequest { return mockReadRequest{} },
		},
		capsuleWorkloads: func() []capsuleruntime.WorkloadStatus {
			return workloads
		},
	})

	response := perform(handler, http.MethodGet, "/state", "")

	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	var got stateResponse
	decodeResponse(t, response, &got)
	if _, ok := got.Capabilities["test.good"]; !ok {
		t.Fatalf("state missing capability test.good; body=%s", response.Body.String())
	}
	want := []capsuleruntime.WorkloadStatus{
		{
			ID:       "local.test.capsule",
			Unit:     "vita-capsule-test.service",
			Status:   capsuleruntime.StatusOK,
			Health:   capsuleruntime.StatusOK,
			Restarts: 2,
		},
		{
			ID:       "local.zed.capsule",
			Unit:     "vita-capsule-zed.service",
			Status:   capsuleruntime.StatusDown,
			Health:   capsuleruntime.StatusDown,
			Restarts: 4,
		},
	}
	if !reflect.DeepEqual(got.CapsuleWorkloads, want) {
		t.Fatalf("capsuleWorkloads = %#v, want %#v; body=%s", got.CapsuleWorkloads, want, response.Body.String())
	}
}

func TestStateIncludesCapsuleWorkloadsFromRegistryDefaultPath(t *testing.T) {
	unit := "vita-capsule-test.service"
	supervisor := capsuleruntime.NewSupervisor(capsuleruntime.Options{
		Prober: capsuleruntime.ProbeFunc(func(context.Context, capsuleruntime.Check) (capsuleruntime.Status, error) {
			return capsuleruntime.StatusOK, nil
		}),
		Jitter: func(capsuleruntime.WorkloadSpec, capsuleruntime.Check) time.Duration {
			return 0
		},
	})
	supervisor.StartWorkload(capsuleruntime.WorkloadSpec{
		ID:   "local.test.capsule",
		Unit: unit,
		Checks: []capsuleruntime.Check{
			{
				Name:            "lifecycle",
				Type:            capsuleruntime.CheckTypeLifecycle,
				Target:          "self",
				IntervalSeconds: 60,
				TimeoutSeconds:  1,
			},
		},
	})
	t.Cleanup(func() {
		supervisor.StopWorkload(unit)
	})

	registry := mustRegistry(t, capsule.NewExecuteCapabilityWithSupervisor(supervisor))
	handler := mustHandler(t, handlerConfig{registry: registry})

	response := perform(handler, http.MethodGet, "/state", "")

	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	var got stateResponse
	decodeResponse(t, response, &got)
	want := []capsuleruntime.WorkloadStatus{
		{
			ID:       "local.test.capsule",
			Unit:     unit,
			Status:   capsuleruntime.StatusOK,
			Health:   capsuleruntime.StatusOK,
			Restarts: 0,
		},
	}
	if !reflect.DeepEqual(got.CapsuleWorkloads, want) {
		t.Fatalf("capsuleWorkloads = %#v, want registry-fed %#v; body=%s", got.CapsuleWorkloads, want, response.Body.String())
	}
	if _, ok := got.Capabilities[capsule.ExecuteName]; !ok {
		t.Fatalf("state missing %q capability entry; body=%s", capsule.ExecuteName, response.Body.String())
	}
}

func TestHealthzUsesServedProductionHealthSources(t *testing.T) {
	tests := []struct {
		name          string
		capsuleHealth capsuleruntime.Status
		cancelContext bool
		wantHealthy   bool
	}{
		{
			name:          "all live sources healthy",
			capsuleHealth: capsuleruntime.StatusOK,
			wantHealthy:   true,
		},
		{
			name:          "capsule down fails closed",
			capsuleHealth: capsuleruntime.StatusDown,
			wantHealthy:   false,
		},
		{
			name:          "transport context canceled fails closed",
			capsuleHealth: capsuleruntime.StatusOK,
			cancelContext: true,
			wantHealthy:   false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			unit := "vita-capsule-healthz.service"
			supervisor := capsuleruntime.NewSupervisor(capsuleruntime.Options{
				Prober: capsuleruntime.ProbeFunc(func(context.Context, capsuleruntime.Check) (capsuleruntime.Status, error) {
					return tt.capsuleHealth, nil
				}),
				Jitter: func(capsuleruntime.WorkloadSpec, capsuleruntime.Check) time.Duration {
					return 0
				},
			})
			supervisor.StartWorkload(capsuleruntime.WorkloadSpec{
				ID:   "local.healthz.capsule",
				Unit: unit,
				Checks: []capsuleruntime.Check{
					{
						Name:            "lifecycle",
						Type:            capsuleruntime.CheckTypeLifecycle,
						Target:          "self",
						IntervalSeconds: 60,
						TimeoutSeconds:  1,
					},
				},
			})
			t.Cleanup(func() {
				supervisor.StopWorkload(unit)
			})

			handler := mustHandler(t, handlerConfig{
				registry: mustRegistry(t, capsule.NewExecuteCapabilityWithSupervisor(supervisor)),
				storageHealth: func(context.Context) (storagehealth.Report, error) {
					return storagehealth.Report{
						StorageHealth: []storagehealth.MountHealth{{Status: storagehealth.StatusOK}},
					}, nil
				},
			})

			ctx := context.Background()
			if tt.cancelContext {
				canceled, cancel := context.WithCancel(ctx)
				cancel()
				ctx = canceled
			}
			response := performWithContext(handler, ctx, http.MethodGet, "/healthz", "")
			if response.Code != http.StatusOK {
				t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
			}
			var health status.Status
			decodeResponse(t, response, &health)
			if health.Healthy != tt.wantHealthy {
				t.Fatalf("Healthy = %v, want %v; body=%s", health.Healthy, tt.wantHealthy, response.Body.String())
			}
		})
	}
}

func TestStateCapsuleWorkloadsEmptyWhenNoSource(t *testing.T) {
	handler := mustHandler(t, handlerConfig{registry: mustRegistry(t)})

	response := perform(handler, http.MethodGet, "/state", "")

	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	var got stateResponse
	decodeResponse(t, response, &got)
	if got.CapsuleWorkloads == nil {
		t.Fatalf("capsuleWorkloads = nil, want empty array; body=%s", response.Body.String())
	}
	if len(got.CapsuleWorkloads) != 0 {
		t.Fatalf("capsuleWorkloads = %#v, want empty", got.CapsuleWorkloads)
	}
}

func TestStateIncludesStorageHealthAndHardwareInventory(t *testing.T) {
	report := storagehealth.Report{
		StorageHealth: []storagehealth.MountHealth{
			{
				Device:         "/dev/nvme0n1p2",
				MountPoint:     "/",
				FSType:         "ext4",
				TotalBytes:     4096000,
				UsedBytes:      1228800,
				AvailableBytes: 2662400,
				UsedPercent:    30,
				NVMe:           true,
				Status:         storagehealth.StatusOK,
			},
		},
		HardwareInventory: storagehealth.HardwareInventory{
			Arch:          "x86_64",
			CPUCores:      8,
			CPUModel:      "fixture cpu",
			MemTotalBytes: 34359738368,
			Disks: []storagehealth.DiskInventory{
				{Name: "nvme0n1", SizeBytes: 4294967296, NVMe: true},
			},
		},
	}
	handler := mustHandler(t, handlerConfig{
		registry: mustRegistry(t),
		storageHealth: func(context.Context) (storagehealth.Report, error) {
			return report, nil
		},
	})

	response := perform(handler, http.MethodGet, "/state", "")

	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	var got stateResponse
	decodeResponse(t, response, &got)
	if !reflect.DeepEqual(got.StorageHealth, report.StorageHealth) {
		t.Fatalf("storageHealth = %#v, want %#v; body=%s", got.StorageHealth, report.StorageHealth, response.Body.String())
	}
	if !reflect.DeepEqual(got.HardwareInventory, report.HardwareInventory) {
		t.Fatalf("hardwareInventory = %#v, want %#v; body=%s", got.HardwareInventory, report.HardwareInventory, response.Body.String())
	}
}

func TestStateStorageHealthErrorIsInlineAndFailSoft(t *testing.T) {
	registry := mustRegistry(t, &stateReadCapability{
		name:     "test.good",
		response: stateReadResponse{Name: "test.good", Ordinal: 1},
	})
	handler := mustHandler(t, handlerConfig{
		registry: registry,
		readRequests: map[string]ReadRequestFactory{
			"test.good": func() capabilities.TypedRequest { return mockReadRequest{} },
		},
		storageHealth: func(context.Context) (storagehealth.Report, error) {
			return storagehealth.Report{}, errors.New("open /secret/private.json: token denied")
		},
	})

	response := perform(handler, http.MethodGet, "/state", "")

	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	var got struct {
		Capabilities      map[string]json.RawMessage `json:"capabilities"`
		CapsuleWorkloads  json.RawMessage            `json:"capsuleWorkloads"`
		StorageHealth     stateCapabilityError       `json:"storageHealth"`
		HardwareInventory stateCapabilityError       `json:"hardwareInventory"`
	}
	decodeResponse(t, response, &got)
	if _, ok := got.Capabilities["test.good"]; !ok {
		t.Fatalf("state missing good capability; body=%s", response.Body.String())
	}
	if got.StorageHealth.Error != "storage_health_unavailable" {
		t.Fatalf("storageHealth error = %q, want storage_health_unavailable", got.StorageHealth.Error)
	}
	if got.HardwareInventory.Error != "storage_health_unavailable" {
		t.Fatalf("hardwareInventory error = %q, want storage_health_unavailable", got.HardwareInventory.Error)
	}
	for _, disallowed := range []string{"secret", "token", "private"} {
		if strings.Contains(strings.ToLower(response.Body.String()), disallowed) {
			t.Fatalf("state response leaked %q: %s", disallowed, response.Body.String())
		}
	}
}

func TestNewHandlerRejectsCapsuleExecuteWithoutWorkloadSource(t *testing.T) {
	registry := mustRegistry(t, brokenCapsuleExecuteCapability{})

	_, err := NewHandler(Config{
		Version:   "test-version",
		StartedAt: transportStartedAt,
		Registry:  registry,
		Now: func() time.Time {
			return transportStartedAt.Add(90 * time.Second)
		},
	})

	if err == nil {
		t.Fatal("NewHandler accepted capsule.execute without a workload source")
	}
	if !strings.Contains(err.Error(), capsule.ExecuteName) {
		t.Fatalf("NewHandler error = %q, want capsule.execute detail", err.Error())
	}
}

func TestStateDoesNotApplyOrMutateRegisteredTxCapabilities(t *testing.T) {
	events := []string{}
	registry := mustRegistry(t, &mockTxCapability{name: "test.apply", events: &events})
	handler := mustHandler(t, handlerConfig{
		registry: registry,
		readRequests: map[string]ReadRequestFactory{
			"test.apply": func() capabilities.TypedRequest { return mockReadRequest{} },
		},
	})

	response := perform(handler, http.MethodGet, "/state", "")

	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	if len(events) != 0 {
		t.Fatalf("events = %v, want no Apply calls", events)
	}
}

func TestOperationsListsRegisteredNamesSorted(t *testing.T) {
	registry := mustRegistry(t,
		&mockTxCapability{name: accounts.Name},
		&mockTxCapability{name: backup.Name},
		&mockTxCapability{name: capsule.ExecuteName},
		&mockTxCapability{name: capsule.FetchName},
		&mockTxCapability{name: capsule.LifecycleName},
		&mockTxCapability{name: capsule.Name},
		&mockTxCapability{name: nodetime.Name},
		&mockTxCapability{name: network.Name},
		&mockTxCapability{name: identity.Name},
		&mockTxCapability{name: hostname.Name},
		&mockTxCapability{name: nodeconfig.Name},
		&mockTxCapability{name: pdssync.Name},
		&mockTxCapability{name: update.Name},
		&mockTxCapability{name: storage.Name},
		&mockTxCapability{name: services.Name},
		&mockTxCapability{name: timesync.Name},
	)
	handler := mustHandler(t, handlerConfig{registry: registry})

	response := perform(handler, http.MethodGet, "/operations", "")

	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	var got OperationsResponse
	decodeResponse(t, response, &got)
	want := []string{accounts.Name, backup.Name, capsule.ExecuteName, capsule.FetchName, capsule.LifecycleName, capsule.Name, hostname.Name, identity.Name, network.Name, nodeconfig.Name, pdssync.Name, services.Name, storage.Name, nodetime.Name, timesync.Name, update.Name}
	if !reflect.DeepEqual(got.Operations, want) {
		t.Fatalf("operations = %v, want %v", got.Operations, want)
	}
}

func TestOperationsEmptyRegistryReturnsEmptyArray(t *testing.T) {
	handler := mustHandler(t, handlerConfig{registry: mustRegistry(t)})

	response := perform(handler, http.MethodGet, "/operations", "")

	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	var got OperationsResponse
	decodeResponse(t, response, &got)
	if got.Operations == nil {
		t.Fatalf("operations = nil, want empty array; body=%s", response.Body.String())
	}
	if len(got.Operations) != 0 {
		t.Fatalf("operations = %v, want empty", got.Operations)
	}
}

func TestRolesRouteReturnsClosedSixRoleVocabulary(t *testing.T) {
	handler := mustHandler(t, handlerConfig{registry: mustRegistry(t)})

	response := perform(handler, http.MethodGet, "/roles", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}

	var got RolesResponse
	decodeResponse(t, response, &got)
	want := []identityroles.Role{
		identityroles.RoleOwner,
		identityroles.RoleAdministrator,
		identityroles.RoleMember,
		identityroles.RoleRestrictedMember,
		identityroles.RoleGuest,
		identityroles.RoleService,
	}
	if !reflect.DeepEqual(got.Roles, want) {
		t.Fatalf("roles = %v, want %v", got.Roles, want)
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

func TestRegisteredAgentCapabilitiesAreApplicable(t *testing.T) {
	events := []string{}
	desiredConfig := nodeconfig.Config{Mode: nodeconfig.ModeMaintenance, RemoteAccess: nodeconfig.RemoteAccessEnabled}
	desiredTime := time.Date(2026, 6, 20, 12, 1, 0, 0, time.UTC)
	desiredTimesync := timesync.NewConfig(true, []string{"time.cloudflare.com", "2001:db8::1"})
	timesyncReadRaw := []byte(`{"enabled":true,"servers":["time.cloudflare.com","2001:db8::1"]}` + "\n")
	desiredHostname := "vita-node-2"
	desiredIdentity := identity.Attestation{
		DID:    "did:plc:ewvi7nxzyoun6zhxrhs64oiz",
		Handle: "alice.example.com",
		SigningKeyRef: identity.SigningKeyRef{
			ID:     "key:identity-signing-primary",
			Handle: "identity-signing-primary",
		},
	}
	networkAllow := []network.Rule{
		{Proto: network.ProtoTCP, Port: 443, SourceCIDR: "10.0.0.0/8", Interface: "eth0"},
	}
	desiredNetwork := network.Policy{Allow: &networkAllow}
	storageQuotaSystem := int64(32)
	storageQuotaUser := int64(768)
	storageQuotaApp := int64(96)
	storageQuotaSnapshots := int64(384)
	storageQuotaBackup := int64(128)
	storageAppID := "local-search"
	storageSubvolumes := []storage.Subvolume{
		{Role: storage.RoleSystemState, Path: "/data/system-state", QuotaGiB: &storageQuotaSystem},
		{Role: storage.RoleUserData, Path: "/data/user-data", QuotaGiB: &storageQuotaUser},
		{Role: storage.RoleAppState, Path: "/data/app-state/local-search", AppID: &storageAppID, QuotaGiB: &storageQuotaApp},
		{Role: storage.RoleSnapshots, Path: "/data/snapshots", QuotaGiB: &storageQuotaSnapshots},
		{Role: storage.RoleLocalBackupCache, Path: "/data/local-backup-cache", QuotaGiB: &storageQuotaBackup},
	}
	desiredStorage := storage.Layout{Subvolumes: &storageSubvolumes}
	desiredUpdate := update.Plan{
		TargetSlot: update.SlotB,
		Bundle: update.BundleRef{
			Ref:       "https://updates.example.invalid/vita-os-1.3.0.raucb",
			Integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
			Version:   "1.3.0",
		},
	}
	backupRetentionCount := int64(7)
	backupRetentionMaxAgeDays := int64(30)
	backupSchedule := "0 2 * * *"
	backupKeyStoreRef := "keystore:local-tpm"
	desiredBackup := backup.Policy{
		Schedule: backup.Schedule{Cron: &backupSchedule},
		Targets: []backup.TargetRef{
			{ID: "target:system-state"},
			{ID: "target:user-data"},
		},
		Retention: backup.Retention{
			Count:      &backupRetentionCount,
			MaxAgeDays: &backupRetentionMaxAgeDays,
		},
		RecoveryKeyRef: backup.RecoveryKeyRef{
			ID:          "rk:owner-primary",
			Handle:      "rk_handle_owner_primary",
			KeyStoreRef: &backupKeyStoreRef,
		},
	}
	desiredPDSSync := pdssync.SyncState{
		Repo:     "did:plc:ewvi7nxzyoun6zhxrhs64oiz",
		Cursor:   42,
		RepoHead: "bafybeigdyrzt5sfp7udm7hu76ekfya5f45mcm6qzdv6woc4f3gj3sidfwy",
	}
	desiredServices := services.NewConfig([]services.ServiceEntry{
		services.NewServiceEntry("ssh.service", true),
		services.NewServiceEntry("dbus.socket", false),
	})
	servicesReadRaw := []byte(`{"services":[{"name":"ssh.service","enabled":true},{"name":"dbus.socket","enabled":false}]}` + "\n")
	desiredAccounts := accounts.NewConfig([]accounts.Account{
		accounts.NewAccount("alice", 1001, "users", []string{"audio", "video"}, "/bin/bash", true),
		accounts.NewAccount("backup", 1002, "users", []string{}, "/usr/sbin/nologin", false),
	})
	accountsReadRaw := []byte(`{"accounts":[{"name":"alice","uid":1001,"primaryGroup":"users","groups":["audio","video"],"shell":"/bin/bash","enabled":true},{"name":"backup","uid":1002,"primaryGroup":"users","groups":[],"shell":"/usr/sbin/nologin","enabled":false}]}` + "\n")
	desiredCapsule := capsuleRegistry([]capsule.CapsuleEntry{
		{
			ID:        "dev.vita.notes",
			Version:   "1.0.0",
			Integrity: transportSHA256SRI,
			State:     capsule.StateInstalled,
		},
	})
	capsuleReadRaw := []byte(`{"capsules":[{"id":"dev.vita.notes","version":"1.0.0","integrity":"` + transportSHA256SRI + `","state":"installed"}]}` + "\n")
	desiredExecute := capsule.ExecuteDesired{
		ID:        "local.test.capsule",
		Version:   "1.0.0",
		Integrity: transportSHA256SRI,
	}
	desiredFetch := capsule.FetchDesired{
		ID:        "local.test.capsule",
		Version:   "1.0.0",
		Ref:       "file:///usr/lib/vita/capsule-bundles/local.test.capsule.tar.zst",
		Integrity: transportSHA256SRI,
	}
	desiredLifecycle := capsule.LifecycleDesired{
		Op: "stop",
		ID: "local.test.capsule",
	}
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
			name:   timesync.Name,
			events: &events,
			handle: func(request capabilities.TypedRequest) (capabilities.TypedResponse, error) {
				if _, ok := request.(timesync.ReadRequest); !ok {
					return nil, fmt.Errorf("timesync read request = %T, want timesync.ReadRequest", request)
				}
				return timesync.ReadResponse{
					Exists: true,
					Config: desiredTimesync,
					Raw:    timesyncReadRaw,
				}, nil
			},
			apply: func(request capabilities.TypedRequest) error {
				typedRequest, ok := request.(timesync.ApplyRequest)
				if !ok {
					return fmt.Errorf("timesync request = %T, want timesync.ApplyRequest", request)
				}
				if typedRequest.Desired == nil {
					return errors.New("timesync desired = nil")
				}
				if !reflect.DeepEqual(*typedRequest.Desired, desiredTimesync) {
					return fmt.Errorf("timesync desired = %#v, want %#v", *typedRequest.Desired, desiredTimesync)
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
		&routedTxCapability{
			name:   identity.Name,
			events: &events,
			apply: func(request capabilities.TypedRequest) error {
				typedRequest, ok := request.(identity.ApplyRequest)
				if !ok {
					return fmt.Errorf("identity request = %T, want identity.ApplyRequest", request)
				}
				if typedRequest.Desired != desiredIdentity {
					return fmt.Errorf("identity desired = %#v, want %#v", typedRequest.Desired, desiredIdentity)
				}
				return nil
			},
		},
		&routedTxCapability{
			name:   network.Name,
			events: &events,
			apply: func(request capabilities.TypedRequest) error {
				typedRequest, ok := request.(network.ApplyRequest)
				if !ok {
					return fmt.Errorf("network request = %T, want network.ApplyRequest", request)
				}
				if typedRequest.Desired == nil {
					return errors.New("network desired = nil")
				}
				if !reflect.DeepEqual(*typedRequest.Desired, desiredNetwork) {
					return fmt.Errorf("network desired = %#v, want %#v", *typedRequest.Desired, desiredNetwork)
				}
				return nil
			},
		},
		&routedTxCapability{
			name:   storage.Name,
			events: &events,
			apply: func(request capabilities.TypedRequest) error {
				typedRequest, ok := request.(storage.ApplyRequest)
				if !ok {
					return fmt.Errorf("storage request = %T, want storage.ApplyRequest", request)
				}
				if typedRequest.Desired == nil {
					return errors.New("storage desired = nil")
				}
				if !reflect.DeepEqual(*typedRequest.Desired, desiredStorage) {
					return fmt.Errorf("storage desired = %#v, want %#v", *typedRequest.Desired, desiredStorage)
				}
				return nil
			},
		},
		&routedTxCapability{
			name:   update.Name,
			events: &events,
			apply: func(request capabilities.TypedRequest) error {
				typedRequest, ok := request.(update.ApplyRequest)
				if !ok {
					return fmt.Errorf("update request = %T, want update.ApplyRequest", request)
				}
				if typedRequest.Desired != desiredUpdate {
					return fmt.Errorf("update desired = %#v, want %#v", typedRequest.Desired, desiredUpdate)
				}
				return nil
			},
		},
		&routedTxCapability{
			name:   backup.Name,
			events: &events,
			apply: func(request capabilities.TypedRequest) error {
				typedRequest, ok := request.(backup.ApplyRequest)
				if !ok {
					return fmt.Errorf("backup request = %T, want backup.ApplyRequest", request)
				}
				if typedRequest.Desired == nil {
					return errors.New("backup desired = nil")
				}
				if !reflect.DeepEqual(*typedRequest.Desired, desiredBackup) {
					return fmt.Errorf("backup desired = %#v, want %#v", *typedRequest.Desired, desiredBackup)
				}
				return nil
			},
		},
		&routedTxCapability{
			name:   pdssync.Name,
			events: &events,
			apply: func(request capabilities.TypedRequest) error {
				typedRequest, ok := request.(pdssync.ApplyRequest)
				if !ok {
					return fmt.Errorf("pdssync request = %T, want pdssync.ApplyRequest", request)
				}
				if typedRequest.Desired == nil {
					return errors.New("pdssync desired = nil")
				}
				if *typedRequest.Desired != desiredPDSSync {
					return fmt.Errorf("pdssync desired = %#v, want %#v", *typedRequest.Desired, desiredPDSSync)
				}
				return nil
			},
		},
		&routedTxCapability{
			name:   services.Name,
			events: &events,
			handle: func(request capabilities.TypedRequest) (capabilities.TypedResponse, error) {
				if _, ok := request.(services.ReadRequest); !ok {
					return nil, fmt.Errorf("services read request = %T, want services.ReadRequest", request)
				}
				return services.ReadResponse{
					Exists: true,
					Config: desiredServices,
					Raw:    servicesReadRaw,
				}, nil
			},
			apply: func(request capabilities.TypedRequest) error {
				typedRequest, ok := request.(services.ApplyRequest)
				if !ok {
					return fmt.Errorf("services request = %T, want services.ApplyRequest", request)
				}
				if typedRequest.Desired == nil {
					return errors.New("services desired = nil")
				}
				if !reflect.DeepEqual(*typedRequest.Desired, desiredServices) {
					return fmt.Errorf("services desired = %#v, want %#v", *typedRequest.Desired, desiredServices)
				}
				return nil
			},
		},
		&routedTxCapability{
			name:   accounts.Name,
			events: &events,
			handle: func(request capabilities.TypedRequest) (capabilities.TypedResponse, error) {
				if _, ok := request.(accounts.ReadRequest); !ok {
					return nil, fmt.Errorf("accounts read request = %T, want accounts.ReadRequest", request)
				}
				return accounts.ReadResponse{
					Exists: true,
					Config: desiredAccounts,
					Raw:    accountsReadRaw,
				}, nil
			},
			apply: func(request capabilities.TypedRequest) error {
				typedRequest, ok := request.(accounts.ApplyRequest)
				if !ok {
					return fmt.Errorf("accounts request = %T, want accounts.ApplyRequest", request)
				}
				if typedRequest.Desired == nil {
					return errors.New("accounts desired = nil")
				}
				if !reflect.DeepEqual(*typedRequest.Desired, desiredAccounts) {
					return fmt.Errorf("accounts desired = %#v, want %#v", *typedRequest.Desired, desiredAccounts)
				}
				return nil
			},
		},
		&routedTxCapability{
			name:   capsule.ExecuteName,
			events: &events,
			handle: func(request capabilities.TypedRequest) (capabilities.TypedResponse, error) {
				if _, ok := request.(capsule.ExecuteReadRequest); !ok {
					return nil, fmt.Errorf("capsule execute read request = %T, want capsule.ExecuteReadRequest", request)
				}
				return capsule.ExecuteReadResponse{
					Last: &capsule.ExecuteStatus{
						ID:         desiredExecute.ID,
						Unit:       "vita-capsule-local.test.capsule.service",
						DynamicUID: "61408",
						Health:     "OK",
						Status:     "OK",
					},
				}, nil
			},
			apply: func(request capabilities.TypedRequest) error {
				typedRequest, ok := request.(capsule.ExecuteApplyRequest)
				if !ok {
					return fmt.Errorf("capsule execute request = %T, want capsule.ExecuteApplyRequest", request)
				}
				if typedRequest.Desired == nil {
					return errors.New("capsule execute desired = nil")
				}
				if *typedRequest.Desired != desiredExecute {
					return fmt.Errorf("capsule execute desired = %#v, want %#v", *typedRequest.Desired, desiredExecute)
				}
				return nil
			},
		},
		&routedTxCapability{
			name:   capsule.FetchName,
			events: &events,
			handle: func(request capabilities.TypedRequest) (capabilities.TypedResponse, error) {
				if _, ok := request.(capsule.FetchReadRequest); !ok {
					return nil, fmt.Errorf("capsule fetch read request = %T, want capsule.FetchReadRequest", request)
				}
				return capsule.FetchReadResponse{
					Last: &capsule.FetchStatus{
						ID:        desiredFetch.ID,
						Version:   desiredFetch.Version,
						Ref:       desiredFetch.Ref,
						Integrity: desiredFetch.Integrity,
						LocalPath: "/var/lib/vita-agent/capsule-storage/local.test.capsule/1.0.0",
						Status:    "OK",
					},
				}, nil
			},
			apply: func(request capabilities.TypedRequest) error {
				typedRequest, ok := request.(capsule.FetchApplyRequest)
				if !ok {
					return fmt.Errorf("capsule fetch request = %T, want capsule.FetchApplyRequest", request)
				}
				if typedRequest.Desired == nil {
					return errors.New("capsule fetch desired = nil")
				}
				if *typedRequest.Desired != desiredFetch {
					return fmt.Errorf("capsule fetch desired = %#v, want %#v", *typedRequest.Desired, desiredFetch)
				}
				return nil
			},
		},
		&routedTxCapability{
			name:   capsule.LifecycleName,
			events: &events,
			handle: func(request capabilities.TypedRequest) (capabilities.TypedResponse, error) {
				if _, ok := request.(capsule.LifecycleReadRequest); !ok {
					return nil, fmt.Errorf("capsule lifecycle read request = %T, want capsule.LifecycleReadRequest", request)
				}
				return capsule.LifecycleReadResponse{
					Last: &capsule.LifecycleStatus{
						Op:      desiredLifecycle.Op,
						ID:      desiredLifecycle.ID,
						Stopped: true,
						Status:  "OK",
					},
				}, nil
			},
			apply: func(request capabilities.TypedRequest) error {
				typedRequest, ok := request.(capsule.LifecycleApplyRequest)
				if !ok {
					return fmt.Errorf("capsule lifecycle request = %T, want capsule.LifecycleApplyRequest", request)
				}
				if typedRequest.Desired == nil {
					return errors.New("capsule lifecycle desired = nil")
				}
				if *typedRequest.Desired != desiredLifecycle {
					return fmt.Errorf("capsule lifecycle desired = %#v, want %#v", *typedRequest.Desired, desiredLifecycle)
				}
				return nil
			},
		},
		&routedTxCapability{
			name:   capsule.Name,
			events: &events,
			handle: func(request capabilities.TypedRequest) (capabilities.TypedResponse, error) {
				if _, ok := request.(capsule.ReadRequest); !ok {
					return nil, fmt.Errorf("capsule read request = %T, want capsule.ReadRequest", request)
				}
				return capsule.ReadResponse{
					Exists:   true,
					Registry: desiredCapsule,
					Raw:      capsuleReadRaw,
				}, nil
			},
			apply: func(request capabilities.TypedRequest) error {
				typedRequest, ok := request.(capsule.ApplyRequest)
				if !ok {
					return fmt.Errorf("capsule request = %T, want capsule.ApplyRequest", request)
				}
				if typedRequest.Desired == nil {
					return errors.New("capsule desired = nil")
				}
				if !reflect.DeepEqual(*typedRequest.Desired, desiredCapsule) {
					return fmt.Errorf("capsule desired = %#v, want %#v", *typedRequest.Desired, desiredCapsule)
				}
				return nil
			},
		},
	)
	handler := mustHandler(t, handlerConfig{registry: registry})

	// GET /capabilities reports HARDWARE discovery (P1-005/P1-008), not registered operation
	// names. Registration is proven below: /operations lists and /apply routes all sixteen registered
	// capabilities and commits them in order.
	operationsResponse := perform(handler, http.MethodGet, "/operations", "")
	if operationsResponse.Code != http.StatusOK {
		t.Fatalf("operations status code = %d, want %d; body=%s", operationsResponse.Code, http.StatusOK, operationsResponse.Body.String())
	}
	var operations OperationsResponse
	decodeResponse(t, operationsResponse, &operations)
	wantOperations := []string{accounts.Name, backup.Name, capsule.ExecuteName, capsule.FetchName, capsule.LifecycleName, capsule.Name, hostname.Name, identity.Name, network.Name, nodeconfig.Name, pdssync.Name, services.Name, storage.Name, nodetime.Name, timesync.Name, update.Name}
	if !reflect.DeepEqual(operations.Operations, wantOperations) {
		t.Fatalf("operations = %v, want %v", operations.Operations, wantOperations)
	}
	defaultDecoders := DefaultRequestDecoders()
	for _, name := range wantOperations {
		if defaultDecoders[name] == nil {
			t.Fatalf("DefaultRequestDecoders()[%q] is nil or missing", name)
		}
	}

	timesyncReadResponse := perform(handler, http.MethodGet, "/read/"+timesync.Name, "")
	if timesyncReadResponse.Code != http.StatusOK {
		t.Fatalf("timesync read status code = %d, want %d; body=%s", timesyncReadResponse.Code, http.StatusOK, timesyncReadResponse.Body.String())
	}
	var timesyncRead timesync.ReadResponse
	decodeResponse(t, timesyncReadResponse, &timesyncRead)
	if !timesyncRead.Exists {
		t.Fatal("timesync read Exists = false, want true")
	}
	if !reflect.DeepEqual(timesyncRead.Config, desiredTimesync) {
		t.Fatalf("timesync read Config = %#v, want %#v", timesyncRead.Config, desiredTimesync)
	}
	if !reflect.DeepEqual(timesyncRead.Raw, timesyncReadRaw) {
		t.Fatalf("timesync read Raw = %q, want %q", timesyncRead.Raw, timesyncReadRaw)
	}

	servicesReadResponse := perform(handler, http.MethodGet, "/read/"+services.Name, "")
	if servicesReadResponse.Code != http.StatusOK {
		t.Fatalf("services read status code = %d, want %d; body=%s", servicesReadResponse.Code, http.StatusOK, servicesReadResponse.Body.String())
	}
	var servicesRead services.ReadResponse
	decodeResponse(t, servicesReadResponse, &servicesRead)
	if !servicesRead.Exists {
		t.Fatal("services read Exists = false, want true")
	}
	if !reflect.DeepEqual(servicesRead.Config, desiredServices) {
		t.Fatalf("services read Config = %#v, want %#v", servicesRead.Config, desiredServices)
	}
	if !reflect.DeepEqual(servicesRead.Raw, servicesReadRaw) {
		t.Fatalf("services read Raw = %q, want %q", servicesRead.Raw, servicesReadRaw)
	}

	accountsReadResponse := perform(handler, http.MethodGet, "/read/"+accounts.Name, "")
	if accountsReadResponse.Code != http.StatusOK {
		t.Fatalf("accounts read status code = %d, want %d; body=%s", accountsReadResponse.Code, http.StatusOK, accountsReadResponse.Body.String())
	}
	var accountsRead accounts.ReadResponse
	decodeResponse(t, accountsReadResponse, &accountsRead)
	if !accountsRead.Exists {
		t.Fatal("accounts read Exists = false, want true")
	}
	if !reflect.DeepEqual(accountsRead.Config, desiredAccounts) {
		t.Fatalf("accounts read Config = %#v, want %#v", accountsRead.Config, desiredAccounts)
	}
	if !reflect.DeepEqual(accountsRead.Raw, accountsReadRaw) {
		t.Fatalf("accounts read Raw = %q, want %q", accountsRead.Raw, accountsReadRaw)
	}

	readResponse := perform(handler, http.MethodGet, "/read/capsule.registry", "")
	if readResponse.Code != http.StatusOK {
		t.Fatalf("read status code = %d, want %d; body=%s", readResponse.Code, http.StatusOK, readResponse.Body.String())
	}
	var capsuleRead capsule.ReadResponse
	decodeResponse(t, readResponse, &capsuleRead)
	if !capsuleRead.Exists {
		t.Fatal("capsule read Exists = false, want true")
	}
	if !reflect.DeepEqual(capsuleRead.Registry, desiredCapsule) {
		t.Fatalf("capsule read Registry = %#v, want %#v", capsuleRead.Registry, desiredCapsule)
	}
	if !reflect.DeepEqual(capsuleRead.Raw, capsuleReadRaw) {
		t.Fatalf("capsule read Raw = %q, want %q", capsuleRead.Raw, capsuleReadRaw)
	}

	stateHTTPResponse := perform(handler, http.MethodGet, "/state", "")
	if stateHTTPResponse.Code != http.StatusOK {
		t.Fatalf("state status code = %d, want %d; body=%s", stateHTTPResponse.Code, http.StatusOK, stateHTTPResponse.Body.String())
	}
	var state stateResponse
	decodeResponse(t, stateHTTPResponse, &state)
	servicesStateRaw, ok := state.Capabilities[services.Name]
	if !ok {
		t.Fatalf("state missing capability %q", services.Name)
	}
	if !bytes.Equal(servicesStateRaw, bytes.TrimSuffix(servicesReadResponse.Body.Bytes(), []byte("\n"))) {
		t.Fatalf("services state raw = %s, want read raw = %s", servicesStateRaw, bytes.TrimSuffix(servicesReadResponse.Body.Bytes(), []byte("\n")))
	}
	accountsStateRaw, ok := state.Capabilities[accounts.Name]
	if !ok {
		t.Fatalf("state missing capability %q", accounts.Name)
	}
	if !bytes.Equal(accountsStateRaw, bytes.TrimSuffix(accountsReadResponse.Body.Bytes(), []byte("\n"))) {
		t.Fatalf("accounts state raw = %s, want read raw = %s", accountsStateRaw, bytes.TrimSuffix(accountsReadResponse.Body.Bytes(), []byte("\n")))
	}

	response := perform(handler, http.MethodPost, "/apply", `{"operations":[{"capability":"node.config","request":{"desired":{"mode":"maintenance","remoteAccess":"enabled"}}},{"capability":"time.set","request":{"desired":"2026-06-20T12:01:00Z"}},{"capability":"time.sync","request":{"desired":{"enabled":true,"servers":["time.cloudflare.com","2001:db8::1"]}}},{"capability":"hostname.set","request":{"desired":"vita-node-2"}},{"capability":"identity.attestation","request":{"desired":{"did":"did:plc:ewvi7nxzyoun6zhxrhs64oiz","handle":"alice.example.com","signingKeyRef":{"id":"key:identity-signing-primary","handle":"identity-signing-primary"}}}},{"capability":"network.policy","request":{"desired":{"allow":[{"proto":"tcp","port":443,"sourceCidr":"10.0.0.0/8","interface":"eth0"}]}}},{"capability":"storage.layout","request":{"desired":{"subvolumes":[{"role":"system-state","path":"/data/system-state","quotaGiB":32},{"role":"user-data","path":"/data/user-data","quotaGiB":768},{"role":"app-state","path":"/data/app-state/local-search","appId":"local-search","quotaGiB":96},{"role":"snapshots","path":"/data/snapshots","quotaGiB":384},{"role":"local-backup-cache","path":"/data/local-backup-cache","quotaGiB":128}]}}},{"capability":"update.plan","request":{"desired":{"targetSlot":"b","bundle":{"ref":"https://updates.example.invalid/vita-os-1.3.0.raucb","integrity":"sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","version":"1.3.0"}}}},{"capability":"backup.policy","request":{"desired":{"schedule":{"cron":"0 2 * * *"},"targets":[{"id":"target:system-state"},{"id":"target:user-data"}],"retention":{"count":7,"maxAgeDays":30},"recoveryKeyRef":{"id":"rk:owner-primary","handle":"rk_handle_owner_primary","keyStoreRef":"keystore:local-tpm"}}}},{"capability":"pds.sync-state","request":{"desired":{"repo":"did:plc:ewvi7nxzyoun6zhxrhs64oiz","cursor":42,"repoHead":"bafybeigdyrzt5sfp7udm7hu76ekfya5f45mcm6qzdv6woc4f3gj3sidfwy"}}},{"capability":"services.config","request":{"desired":{"services":[{"name":"ssh.service","enabled":true},{"name":"dbus.socket","enabled":false}]}}},{"capability":"accounts.config","request":{"desired":{"accounts":[{"name":"alice","uid":1001,"primaryGroup":"users","groups":["audio","video"],"shell":"/bin/bash","enabled":true},{"name":"backup","uid":1002,"primaryGroup":"users","groups":[],"shell":"/usr/sbin/nologin","enabled":false}]}}},{"capability":"capsule.execute","request":{"desired":{"id":"local.test.capsule","version":"1.0.0","integrity":"`+transportSHA256SRI+`"}}},{"capability":"capsule.fetch","request":{"desired":{"id":"local.test.capsule","version":"1.0.0","ref":"file:///usr/lib/vita/capsule-bundles/local.test.capsule.tar.zst","integrity":"`+transportSHA256SRI+`"}}},{"capability":"capsule.lifecycle","request":{"desired":{"op":"stop","id":"local.test.capsule"}}},{"capability":"capsule.registry","request":{"desired":{"capsules":[{"id":"dev.vita.notes","version":"1.0.0","integrity":"`+transportSHA256SRI+`","state":"installed"}]}}}]}`)
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
		{Index: 2, Capability: timesync.Name},
		{Index: 3, Capability: hostname.Name},
		{Index: 4, Capability: identity.Name},
		{Index: 5, Capability: network.Name},
		{Index: 6, Capability: storage.Name},
		{Index: 7, Capability: update.Name},
		{Index: 8, Capability: backup.Name},
		{Index: 9, Capability: pdssync.Name},
		{Index: 10, Capability: services.Name},
		{Index: 11, Capability: accounts.Name},
		{Index: 12, Capability: capsule.ExecuteName},
		{Index: 13, Capability: capsule.FetchName},
		{Index: 14, Capability: capsule.LifecycleName},
		{Index: 15, Capability: capsule.Name},
	}
	if !reflect.DeepEqual(result.Applied, wantApplied) {
		t.Fatalf("Applied = %v, want %v", result.Applied, wantApplied)
	}
	if result.Error != nil {
		t.Fatalf("Error = %#v, want nil", result.Error)
	}
	wantEvents := []string{nodeconfig.Name, nodetime.Name, timesync.Name, hostname.Name, identity.Name, network.Name, storage.Name, update.Name, backup.Name, pdssync.Name, services.Name, accounts.Name, capsule.ExecuteName, capsule.FetchName, capsule.LifecycleName, capsule.Name}
	if !reflect.DeepEqual(events, wantEvents) {
		t.Fatalf("events = %v, want %v", events, wantEvents)
	}
}

func TestApplyRejectsRegisteredCapabilityWithoutDecoder(t *testing.T) {
	events := []string{}
	registry := mustRegistry(t, &mockTxCapability{name: "test.no-decoder", events: &events})
	handler := mustHandler(t, handlerConfig{registry: registry})

	response := perform(handler, http.MethodPost, "/apply", `{"operations":[{"capability":"test.no-decoder","request":{"value":"one"}}]}`)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusBadRequest, response.Body.String())
	}
	var errorResponse ErrorResponse
	decodeResponse(t, response, &errorResponse)
	if errorResponse.Error.Code != "unsupported_request_type" {
		t.Fatalf("error code = %q, want unsupported_request_type", errorResponse.Error.Code)
	}
	if !strings.Contains(errorResponse.Error.Message, "no registered request decoder") {
		t.Fatalf("error message = %q, want missing decoder detail", errorResponse.Error.Message)
	}
	if len(events) != 0 {
		t.Fatalf("events = %v, want no apply calls", events)
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

func TestFilesRouteDispatchesToHandler(t *testing.T) {
	stateRoot := t.TempDir()
	handler := mustHandler(t, handlerConfig{
		registry:       mustRegistry(t),
		filesStateRoot: stateRoot,
		filesGrants: []filecap.Grant{
			{Name: "rw", Root: "scope", Access: filecap.AccessReadWrite},
		},
	})
	data := []byte("files route data")
	writeBody := fmt.Sprintf(
		`{"op":"write","grant":"rw","path":"note.txt","data":%q}`,
		base64.StdEncoding.EncodeToString(data),
	)

	writeResponse := perform(handler, http.MethodPost, "/files", writeBody)
	if writeResponse.Code != http.StatusOK {
		t.Fatalf("write status code = %d, want %d; body=%s", writeResponse.Code, http.StatusOK, writeResponse.Body.String())
	}
	var writeResult filecap.Response
	decodeResponse(t, writeResponse, &writeResult)
	if writeResult.Kind == nil || *writeResult.Kind != filecap.KindFile || writeResult.Size == nil || *writeResult.Size != int64(len(data)) {
		t.Fatalf("write result = %#v, want file size %d", writeResult, len(data))
	}

	readResponse := perform(handler, http.MethodPost, "/files", `{"op":"read","grant":"rw","path":"note.txt"}`)
	if readResponse.Code != http.StatusOK {
		t.Fatalf("read status code = %d, want %d; body=%s", readResponse.Code, http.StatusOK, readResponse.Body.String())
	}
	var readResult filecap.Response
	decodeResponse(t, readResponse, &readResult)
	if readResult.Data == nil {
		t.Fatalf("read result = %#v, want data", readResult)
	}
	got, err := base64.StdEncoding.DecodeString(*readResult.Data)
	if err != nil {
		t.Fatalf("read result data is not base64: %v", err)
	}
	if !bytes.Equal(got, data) {
		t.Fatalf("read data = %q, want %q", got, data)
	}
}

func TestFilesRouteUsesPeerPrincipalFromContext(t *testing.T) {
	stateRoot := t.TempDir()
	shared := true
	handler := mustHandler(t, handlerConfig{
		registry:       mustRegistry(t),
		filesStateRoot: stateRoot,
		filesGrants: []filecap.Grant{
			{
				Name:   "shared",
				Root:   "scope",
				Shared: &shared,
				Roles: filecap.RoleAccessMap{
					filecap.RoleOwner:  filecap.AccessReadWrite,
					filecap.RoleMember: filecap.AccessReadOnly,
				},
			},
		},
		filesPrincipals: []filecap.Principal{
			{PrincipalKey: "peer-owner", Role: filecap.RoleOwner},
		},
	})

	data := []byte("context principal data")
	body := fmt.Sprintf(
		`{"op":"write","grant":"shared","path":"note.txt","data":%q}`,
		base64.StdEncoding.EncodeToString(data),
	)

	// No peer principal in context -> least-privileged guest default -> no entry
	// on this grant -> role_forbidden (never owner-by-absence).
	defaultResponse := perform(handler, http.MethodPost, "/files", body)
	if defaultResponse.Code != http.StatusForbidden {
		t.Fatalf("default status code = %d, want %d; body=%s", defaultResponse.Code, http.StatusForbidden, defaultResponse.Body.String())
	}
	var defaultError ErrorResponse
	decodeResponse(t, defaultResponse, &defaultError)
	if defaultError.Error.Code != "role_forbidden" {
		t.Fatalf("default error code = %q, want role_forbidden", defaultError.Error.Code)
	}

	ownerCtx := contextWithUnixPeerPrincipalKeys(context.Background(), []string{"peer-owner"})
	writeResponse := performWithContext(handler, ownerCtx, http.MethodPost, "/files", body)
	if writeResponse.Code != http.StatusOK {
		t.Fatalf("owner write status code = %d, want %d; body=%s", writeResponse.Code, http.StatusOK, writeResponse.Body.String())
	}

	readResponse := performWithContext(handler, ownerCtx, http.MethodPost, "/files", `{"op":"read","grant":"shared","path":"note.txt"}`)
	if readResponse.Code != http.StatusOK {
		t.Fatalf("owner read status code = %d, want %d; body=%s", readResponse.Code, http.StatusOK, readResponse.Body.String())
	}
	var readResult filecap.Response
	decodeResponse(t, readResponse, &readResult)
	if readResult.Data == nil {
		t.Fatalf("read result = %#v, want data", readResult)
	}
	got, err := base64.StdEncoding.DecodeString(*readResult.Data)
	if err != nil {
		t.Fatalf("read data is not base64: %v", err)
	}
	if !bytes.Equal(got, data) {
		t.Fatalf("read data = %q, want %q", got, data)
	}
}

// TestFilesRouteRoleTracksPerConnectionPeer proves the /files route resolves the
// principal from THIS connection's authenticated peer keys (not a listener-global
// value and not the body): two different peers bound to two different roles get
// two different effective accesses on the same grant. Guards the P1-073
// REVISION-2 per-connection binding.
func TestFilesRouteRoleTracksPerConnectionPeer(t *testing.T) {
	stateRoot := t.TempDir()
	shared := true
	handler := mustHandler(t, handlerConfig{
		registry:       mustRegistry(t),
		filesStateRoot: stateRoot,
		filesGrants: []filecap.Grant{
			{
				Name:   "shared",
				Root:   "scope",
				Shared: &shared,
				Roles: filecap.RoleAccessMap{
					filecap.RoleOwner:  filecap.AccessReadWrite,
					filecap.RoleMember: filecap.AccessReadOnly,
				},
			},
		},
		filesPrincipals: []filecap.Principal{
			{PrincipalKey: "unix:uid:1000", Role: filecap.RoleOwner},
			{PrincipalKey: "unix:uid:1001", Role: filecap.RoleMember},
		},
	})

	data := []byte("per-connection data")
	writeBody := fmt.Sprintf(
		`{"op":"write","grant":"shared","path":"note.txt","data":%q}`,
		base64.StdEncoding.EncodeToString(data),
	)

	// Peer A (uid 1000 -> owner) writes.
	ownerCtx := contextWithUnixPeerPrincipalKeys(context.Background(), []string{"unix:uid:1000"})
	ownerWrite := performWithContext(handler, ownerCtx, http.MethodPost, "/files", writeBody)
	if ownerWrite.Code != http.StatusOK {
		t.Fatalf("owner write status code = %d, want %d; body=%s", ownerWrite.Code, http.StatusOK, ownerWrite.Body.String())
	}

	// Peer B (uid 1001 -> member) reads OK but write is role_forbidden — a
	// different effective access on the identical grant + path.
	memberCtx := contextWithUnixPeerPrincipalKeys(context.Background(), []string{"unix:uid:1001"})
	memberRead := performWithContext(handler, memberCtx, http.MethodPost, "/files", `{"op":"read","grant":"shared","path":"note.txt"}`)
	if memberRead.Code != http.StatusOK {
		t.Fatalf("member read status code = %d, want %d; body=%s", memberRead.Code, http.StatusOK, memberRead.Body.String())
	}
	memberWrite := performWithContext(handler, memberCtx, http.MethodPost, "/files", writeBody)
	if memberWrite.Code != http.StatusForbidden {
		t.Fatalf("member write status code = %d, want %d; body=%s", memberWrite.Code, http.StatusForbidden, memberWrite.Body.String())
	}
	var memberErr ErrorResponse
	decodeResponse(t, memberWrite, &memberErr)
	if memberErr.Error.Code != "role_forbidden" {
		t.Fatalf("member write error code = %q, want role_forbidden", memberErr.Error.Code)
	}
}

func TestFilesRouteReturnsTypedErrors(t *testing.T) {
	handler := mustHandler(t, handlerConfig{
		registry:       mustRegistry(t),
		filesStateRoot: t.TempDir(),
		filesGrants: []filecap.Grant{
			{Name: "rw", Root: "scope", Access: filecap.AccessReadWrite},
		},
	})
	tests := []struct {
		name       string
		method     string
		body       string
		wantStatus int
		wantCode   string
	}{
		{name: "method", method: http.MethodGet, wantStatus: http.StatusMethodNotAllowed, wantCode: "method_not_allowed"},
		{name: "shape", method: http.MethodPost, body: `{}`, wantStatus: http.StatusBadRequest, wantCode: "invalid_request"},
		{name: "unknown op", method: http.MethodPost, body: `{"op":"remove","grant":"rw","path":"note.txt"}`, wantStatus: http.StatusBadRequest, wantCode: "unknown_op"},
		{name: "role field", method: http.MethodPost, body: `{"op":"read","grant":"rw","path":"note.txt","role":"owner"}`, wantStatus: http.StatusBadRequest, wantCode: "unknown_field"},
		{name: "principal field", method: http.MethodPost, body: `{"op":"read","grant":"rw","path":"note.txt","principal":"peer-owner"}`, wantStatus: http.StatusBadRequest, wantCode: "unknown_field"},
		{name: "as field", method: http.MethodPost, body: `{"op":"read","grant":"rw","path":"note.txt","as":"owner"}`, wantStatus: http.StatusBadRequest, wantCode: "unknown_field"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			response := perform(handler, tt.method, "/files", tt.body)
			if response.Code != tt.wantStatus {
				t.Fatalf("status code = %d, want %d; body=%s", response.Code, tt.wantStatus, response.Body.String())
			}
			var errorResponse ErrorResponse
			decodeResponse(t, response, &errorResponse)
			if errorResponse.Error.Code != tt.wantCode {
				t.Fatalf("error code = %q, want %q", errorResponse.Error.Code, tt.wantCode)
			}
		})
	}
}

func TestExportRouteDispatchesToVerifier(t *testing.T) {
	handler := mustHandler(t, handlerConfig{
		registry:       mustRegistry(t),
		filesStateRoot: t.TempDir(),
		filesGrants: []filecap.Grant{
			{Name: "rw", Root: "scope", Access: filecap.AccessReadWrite},
		},
	})
	contents := map[string][]byte{
		"note.txt":   []byte("owner file\n"),
		"state.json": []byte(`{"hostname":"vita-node-7"}` + "\n"),
	}
	manifest := exportcap.Manifest{
		FormatVersion: exportcap.ManifestFormatVersion,
		Entries: []exportcap.Entry{
			{
				Path:      "note.txt",
				Kind:      exportcap.EntryKindFile,
				Bytes:     int64(len(contents["note.txt"])),
				Integrity: exportcap.SHA256Integrity(contents["note.txt"]),
			},
			{
				Path:      "state.json",
				Kind:      exportcap.EntryKindConfig,
				Bytes:     int64(len(contents["state.json"])),
				Integrity: exportcap.SHA256Integrity(contents["state.json"]),
			},
		},
	}
	root, err := exportcap.RootDigest(manifest.Entries)
	if err != nil {
		t.Fatalf("RootDigest returned error: %v", err)
	}
	manifest.RootDigest = root
	manifestBytes, err := exportcap.RenderManifest(manifest)
	if err != nil {
		t.Fatalf("RenderManifest returned error: %v", err)
	}

	writeFilesBlob(t, handler, "rw", "note.txt", contents["note.txt"])
	writeFilesBlob(t, handler, "rw", "state.json", contents["state.json"])
	writeFilesBlob(t, handler, "rw", exportcap.ManifestFilename, manifestBytes)

	response := perform(handler, http.MethodPost, "/export", `{"op":"verify","grant":"rw","manifestPath":"export-manifest.json"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	var result exportcap.VerifyResult
	decodeResponse(t, response, &result)
	if !result.Verified || result.Entries != 2 || result.Bytes != int64(len(contents["note.txt"])+len(contents["state.json"])) || result.RootDigest != root {
		t.Fatalf("verify result = %#v, want verified export root %q", result, root)
	}
}

func TestExportRouteReturnsTypedErrors(t *testing.T) {
	handler := mustHandler(t, handlerConfig{
		registry:       mustRegistry(t),
		filesStateRoot: t.TempDir(),
		filesGrants: []filecap.Grant{
			{Name: "rw", Root: "scope", Access: filecap.AccessReadWrite},
		},
	})
	manifest := exportcap.Manifest{
		FormatVersion: exportcap.ManifestFormatVersion,
		Entries: []exportcap.Entry{{
			Path:      "note.txt",
			Kind:      exportcap.EntryKindFile,
			Bytes:     int64(len("untampered")),
			Integrity: exportcap.SHA256Integrity([]byte("untampered")),
		}},
	}
	root, err := exportcap.RootDigest(manifest.Entries)
	if err != nil {
		t.Fatalf("RootDigest returned error: %v", err)
	}
	manifest.RootDigest = root
	manifestBytes, err := exportcap.RenderManifest(manifest)
	if err != nil {
		t.Fatalf("RenderManifest returned error: %v", err)
	}
	writeFilesBlob(t, handler, "rw", "note.txt", []byte("tampered"))
	writeFilesBlob(t, handler, "rw", exportcap.ManifestFilename, manifestBytes)

	tests := []struct {
		name       string
		method     string
		body       string
		wantStatus int
		wantCode   string
	}{
		{name: "method", method: http.MethodGet, wantStatus: http.StatusMethodNotAllowed, wantCode: "method_not_allowed"},
		{name: "shape", method: http.MethodPost, body: `{}`, wantStatus: http.StatusBadRequest, wantCode: "invalid_request"},
		{name: "unknown op", method: http.MethodPost, body: `{"op":"remove","grant":"rw","manifestPath":"export-manifest.json"}`, wantStatus: http.StatusBadRequest, wantCode: "unknown_op"},
		{name: "unknown grant", method: http.MethodPost, body: `{"op":"verify","grant":"missing","manifestPath":"export-manifest.json"}`, wantStatus: http.StatusNotFound, wantCode: "unknown_grant"},
		{name: "path traversal", method: http.MethodPost, body: `{"op":"verify","grant":"rw","manifestPath":"../export-manifest.json"}`, wantStatus: http.StatusBadRequest, wantCode: "path_traversal"},
		{name: "integrity mismatch", method: http.MethodPost, body: `{"op":"verify","grant":"rw","manifestPath":"export-manifest.json"}`, wantStatus: http.StatusBadRequest, wantCode: "integrity_mismatch"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			response := perform(handler, tt.method, "/export", tt.body)
			if response.Code != tt.wantStatus {
				t.Fatalf("status code = %d, want %d; body=%s", response.Code, tt.wantStatus, response.Body.String())
			}
			var errorResponse ErrorResponse
			decodeResponse(t, response, &errorResponse)
			if errorResponse.Error.Code != tt.wantCode {
				t.Fatalf("error code = %q, want %q", errorResponse.Error.Code, tt.wantCode)
			}
		})
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
		{name: "operations rejects non GET", method: http.MethodPost, path: "/operations", wantStatus: http.StatusMethodNotAllowed, wantAllowed: http.MethodGet},
		{name: "roles rejects non GET", method: http.MethodPost, path: "/roles", wantStatus: http.StatusMethodNotAllowed, wantAllowed: http.MethodGet},
		{name: "state rejects non GET", method: http.MethodPost, path: "/state", wantStatus: http.StatusMethodNotAllowed, wantAllowed: http.MethodGet},
		{name: "apply rejects non POST", method: http.MethodGet, path: "/apply", wantStatus: http.StatusMethodNotAllowed, wantAllowed: http.MethodPost},
		{name: "files rejects non POST", method: http.MethodGet, path: "/files", wantStatus: http.StatusMethodNotAllowed, wantAllowed: http.MethodPost},
		{name: "export rejects non POST", method: http.MethodGet, path: "/export", wantStatus: http.StatusMethodNotAllowed, wantAllowed: http.MethodPost},
		{name: "read rejects non GET", method: http.MethodPost, path: "/read/test.apply", wantStatus: http.StatusMethodNotAllowed, wantAllowed: http.MethodGet},
		{name: "read base rejects non GET", method: http.MethodPost, path: "/read", wantStatus: http.StatusMethodNotAllowed, wantAllowed: http.MethodGet},
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

func TestUnixPeerGroupAuthAcceptsSupplementaryGroup(t *testing.T) {
	const targetGID uint32 = 4242
	peer := unixPeerInfo{
		Credentials: peerCredentials{PID: 123, UID: 1000, GID: 61000},
		Groups:      []uint32{1000, targetGID},
		GroupSource: "SO_PEERGROUPS",
	}

	if !peerAuthorizedForGroup(peer, targetGID) {
		t.Fatal("peer with DynamicUser-like primary gid and vita-agent supplementary group was rejected")
	}
}

func TestUnixPeerGroupAuthRejectsPeerOutsideGroup(t *testing.T) {
	const targetGID uint32 = 4242
	peer := unixPeerInfo{
		Credentials: peerCredentials{PID: 123, UID: 1000, GID: 61000},
		Groups:      []uint32{1000, 1001},
		GroupSource: "SO_PEERGROUPS",
	}

	if peerAuthorizedForGroup(peer, targetGID) {
		t.Fatal("peer outside vita-agent group was authorized")
	}
}

func TestParseProcStatusGroups(t *testing.T) {
	groups, err := parseProcStatusGroups([]byte("Name:\tdeno\nPid:\t123\nGroups:\t1000 4242 65535\n"))
	if err != nil {
		t.Fatalf("parseProcStatusGroups returned error: %v", err)
	}

	want := []uint32{1000, 4242, 65535}
	if !reflect.DeepEqual(groups, want) {
		t.Fatalf("groups = %v, want %v", groups, want)
	}
}

type handlerConfig struct {
	registry         *capabilities.Registry
	discoverer       hardware.Discoverer
	readRequests     map[string]ReadRequestFactory
	maxBodyBytes     int64
	filesStateRoot   string
	filesGrants      []filecap.Grant
	filesPrincipals  []filecap.Principal
	auditStore       AuditStore
	capsuleWorkloads func() []capsuleruntime.WorkloadStatus
	transportReady   status.ReadinessSource
	storageHealth    func(context.Context) (storagehealth.Report, error)
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
	storageHealthSnapshot := config.storageHealth
	if storageHealthSnapshot == nil {
		storageHealthSnapshot = func(context.Context) (storagehealth.Report, error) {
			return storagehealth.Report{
				StorageHealth: []storagehealth.MountHealth{},
				HardwareInventory: storagehealth.HardwareInventory{
					Disks: []storagehealth.DiskInventory{},
				},
			}, nil
		}
	}
	transportReady := config.transportReady
	if transportReady == nil {
		transportReady = func(ctx context.Context) bool {
			return ctx.Err() == nil
		}
	}

	handler, err := NewHandler(Config{
		Version:          "test-version",
		StartedAt:        transportStartedAt,
		Registry:         config.registry,
		Discoverer:       discoverer,
		RequestDecoders:  map[string]RequestDecoder{"test.apply": decodeMockRequest, "test.first": decodeMockRequest, "test.second": decodeMockRequest},
		ReadRequests:     config.readRequests,
		MaxBodyBytes:     config.maxBodyBytes,
		FilesStateRoot:   config.filesStateRoot,
		FilesGrants:      config.filesGrants,
		FilesPrincipals:  config.filesPrincipals,
		AuditStore:       config.auditStore,
		CapsuleWorkloads: config.capsuleWorkloads,
		TransportReady:   transportReady,
		StorageHealth:    storageHealthSnapshot,
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
	return performWithContext(handler, context.Background(), method, path, body)
}

func performWithContext(handler http.Handler, ctx context.Context, method string, path string, body string) *httptest.ResponseRecorder {
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}

	request := httptest.NewRequest(method, path, reader)
	request = request.WithContext(ctx)
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

func writeFilesBlob(t *testing.T, handler http.Handler, grant string, path string, data []byte) {
	t.Helper()

	body := fmt.Sprintf(
		`{"op":"write","grant":%q,"path":%q,"data":%q}`,
		grant,
		path,
		base64.StdEncoding.EncodeToString(data),
	)
	response := perform(handler, http.MethodPost, "/files", body)
	if response.Code != http.StatusOK {
		t.Fatalf("files write %q status code = %d, want %d; body=%s", path, response.Code, http.StatusOK, response.Body.String())
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

type mockReadRequest struct{}

func (mockReadRequest) CapabilityRequest() {}

type stateResponse struct {
	Capabilities      map[string]json.RawMessage      `json:"capabilities"`
	CapsuleWorkloads  []capsuleruntime.WorkloadStatus `json:"capsuleWorkloads"`
	StorageHealth     []storagehealth.MountHealth     `json:"storageHealth"`
	HardwareInventory storagehealth.HardwareInventory `json:"hardwareInventory"`
}

type stateReadResponse struct {
	Name    string `json:"name"`
	Ordinal int    `json:"ordinal"`
}

func (stateReadResponse) CapabilityResponse() {}

type stateReadCapability struct {
	name     string
	response capabilities.TypedResponse
	err      error
	events   *[]string
}

func (c *stateReadCapability) Name() string {
	return c.name
}

func (c *stateReadCapability) Handle(context.Context, capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	if c.events != nil {
		*c.events = append(*c.events, "handle:"+c.name)
	}
	if c.err != nil {
		return nil, c.err
	}
	return c.response, nil
}

func (c *stateReadCapability) Workloads() []capsuleruntime.WorkloadStatus {
	return []capsuleruntime.WorkloadStatus{}
}

type mockReadResponse struct {
	Value string `json:"value"`
	Count int    `json:"count"`
}

func (mockReadResponse) CapabilityResponse() {}

type mockResponse struct{}

func (mockResponse) CapabilityResponse() {}

type mockReadCapability struct {
	name     string
	response capabilities.TypedResponse
	err      error
	events   *[]string
}

func (c *mockReadCapability) Name() string {
	return c.name
}

func (c *mockReadCapability) Handle(_ context.Context, request capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	if _, ok := request.(mockReadRequest); !ok {
		return nil, fmt.Errorf("read request = %T, want mockReadRequest", request)
	}
	if c.events != nil {
		*c.events = append(*c.events, "handle:"+c.name)
	}
	if c.err != nil {
		return nil, c.err
	}
	return c.response, nil
}

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

func (c *mockTxCapability) Workloads() []capsuleruntime.WorkloadStatus {
	return []capsuleruntime.WorkloadStatus{}
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
	name      string
	handle    func(capabilities.TypedRequest) (capabilities.TypedResponse, error)
	apply     func(capabilities.TypedRequest) error
	workloads func() []capsuleruntime.WorkloadStatus
	events    *[]string
}

func (c *routedTxCapability) Name() string {
	return c.name
}

func (c *routedTxCapability) Handle(_ context.Context, request capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	if c.handle != nil {
		return c.handle(request)
	}
	return mockResponse{}, nil
}

func (c *routedTxCapability) Workloads() []capsuleruntime.WorkloadStatus {
	if c.workloads == nil {
		return []capsuleruntime.WorkloadStatus{}
	}
	return c.workloads()
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

type brokenCapsuleExecuteCapability struct{}

func (brokenCapsuleExecuteCapability) Name() string {
	return capsule.ExecuteName
}

func (brokenCapsuleExecuteCapability) Handle(context.Context, capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	return mockResponse{}, nil
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

func registeredCapabilityNames() []string {
	return []string{accounts.Name, backup.Name, capsule.ExecuteName, capsule.FetchName, capsule.LifecycleName, capsule.Name, hostname.Name, identity.Name, network.Name, nodeconfig.Name, pdssync.Name, services.Name, storage.Name, nodetime.Name, timesync.Name, update.Name}
}

func assertCapabilityKeyOrder(t *testing.T, body string, names []string) {
	t.Helper()

	lastIndex := -1
	for _, name := range names {
		key, err := json.Marshal(name)
		if err != nil {
			t.Fatalf("failed to marshal capability name %q: %v", name, err)
		}
		index := strings.Index(body, string(key)+":")
		if index < 0 {
			t.Fatalf("response missing capability key %q: %s", name, body)
		}
		if index <= lastIndex {
			t.Fatalf("capability key %q index = %d, want after %d; body=%s", name, index, lastIndex, body)
		}
		lastIndex = index
	}
}

func capsuleRegistry(capsules []capsule.CapsuleEntry) capsule.Registry {
	copied := make([]capsule.CapsuleEntry, len(capsules))
	copy(copied, capsules)
	return capsule.Registry{Capsules: &copied}
}

// fakeJournalReader is a transport-test JournalReader: it returns a canned set of
// raw journald JSON lines so GET /read/capsule.logs is exercised end-to-end through
// the handler without a live journald.
type fakeJournalReader struct {
	lines []string
}

func (f fakeJournalReader) Tail(_ context.Context, _ string, _ int) ([]string, error) {
	return f.lines, nil
}

func newCapsuleLogsHandler(t *testing.T, reader capsule.JournalReader) http.Handler {
	t.Helper()

	registry := mustRegistry(t, capsule.NewLogsCapabilityWithReader(reader))
	handler, err := NewHandler(Config{
		Version:   "test",
		StartedAt: time.Now().UTC(),
		Registry:  registry,
	})
	if err != nil {
		t.Fatalf("NewHandler returned error: %v", err)
	}
	return handler
}

func TestReadCapsuleLogsQueryReturnsProjectedTail(t *testing.T) {
	reader := fakeJournalReader{lines: []string{
		`{"__REALTIME_TIMESTAMP":"1718000000000000","PRIORITY":"6","MESSAGE":"capsule started"}`,
		`{"__REALTIME_TIMESTAMP":"1718000001000000","PRIORITY":"3","MESSAGE":"boom"}`,
	}}
	handler := newCapsuleLogsHandler(t, reader)

	response := perform(handler, http.MethodGet, "/read/capsule.logs?id=dev.vita.notes&limit=50", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", response.Code, response.Body.String())
	}

	var decoded capsule.LogsReadResponse
	decodeResponse(t, response, &decoded)
	if len(decoded.Lines) != 2 {
		t.Fatalf("lines = %d, want 2; body=%s", len(decoded.Lines), response.Body.String())
	}
	if decoded.Lines[0].Message != "capsule started" || decoded.Lines[0].Level != capsule.LogLevelInfo {
		t.Errorf("line 0 = %+v, want info/capsule started", decoded.Lines[0])
	}
	if decoded.Lines[1].Level != capsule.LogLevelError {
		t.Errorf("line 1 level = %q, want error", decoded.Lines[1].Level)
	}
}

func TestReadCapsuleLogsQueryDefaultsLimitWhenOmitted(t *testing.T) {
	handler := newCapsuleLogsHandler(t, fakeJournalReader{})

	response := perform(handler, http.MethodGet, "/read/capsule.logs?id=dev.vita.notes", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", response.Code, response.Body.String())
	}
}

func TestReadCapsuleLogsQueryRejectsMissingID(t *testing.T) {
	handler := newCapsuleLogsHandler(t, fakeJournalReader{})

	response := perform(handler, http.MethodGet, "/read/capsule.logs?limit=10", "")
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", response.Code, response.Body.String())
	}
}

func TestReadCapsuleLogsQueryRejectsUnknownParam(t *testing.T) {
	handler := newCapsuleLogsHandler(t, fakeJournalReader{})

	response := perform(handler, http.MethodGet, "/read/capsule.logs?id=x&bogus=1", "")
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", response.Code, response.Body.String())
	}
}

func TestReadCapsuleLogsQueryRejectsNonInteger(t *testing.T) {
	handler := newCapsuleLogsHandler(t, fakeJournalReader{})

	response := perform(handler, http.MethodGet, "/read/capsule.logs?id=x&limit=abc", "")
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", response.Code, response.Body.String())
	}
}

// auditMemoryFS is a minimal in-memory auditlog.FileSystem so transport tests
// can back a real *auditlog.Store without touching disk. It emulates the
// fresh-exclusive-temp + rename commit the store relies on.
type auditMemoryFS struct {
	mu      sync.Mutex
	files   map[string][]byte
	tempSeq int
}

func newAuditMemoryFS() *auditMemoryFS {
	return &auditMemoryFS{files: map[string][]byte{}}
}

func (m *auditMemoryFS) ReadFile(name string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	data, ok := m.files[name]
	if !ok {
		return nil, &fs.PathError{Op: "read", Path: name, Err: fs.ErrNotExist}
	}
	out := make([]byte, len(data))
	copy(out, data)
	return out, nil
}

func (m *auditMemoryFS) MkdirAll(string, fs.FileMode) error { return nil }

func (m *auditMemoryFS) CreateTemp(dir, pattern string) (auditlog.TempFile, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	prefix, suffix, _ := strings.Cut(pattern, "*")
	m.tempSeq++
	name := filepath.Join(dir, fmt.Sprintf("%s%d%s", prefix, m.tempSeq, suffix))
	if _, exists := m.files[name]; exists {
		return nil, &fs.PathError{Op: "createtemp", Path: name, Err: fs.ErrExist}
	}
	m.files[name] = []byte{}
	return &auditMemTempFile{fsys: m, name: name}, nil
}

func (m *auditMemoryFS) Rename(oldPath, newPath string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	data, ok := m.files[oldPath]
	if !ok {
		return &fs.PathError{Op: "rename", Path: oldPath, Err: fs.ErrNotExist}
	}
	m.files[newPath] = data
	delete(m.files, oldPath)
	return nil
}

func (m *auditMemoryFS) Remove(name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.files, name)
	return nil
}

func (m *auditMemoryFS) SyncDir(string) error { return nil }

type auditMemTempFile struct {
	fsys *auditMemoryFS
	name string
	buf  []byte
}

func (f *auditMemTempFile) Name() string { return f.name }

func (f *auditMemTempFile) Chmod(fs.FileMode) error { return nil }

func (f *auditMemTempFile) Write(data []byte) (int, error) {
	f.buf = append(f.buf, data...)
	return len(data), nil
}

func (f *auditMemTempFile) Sync() error { return nil }

func (f *auditMemTempFile) Close() error {
	f.fsys.mu.Lock()
	defer f.fsys.mu.Unlock()
	f.fsys.files[f.name] = f.buf
	return nil
}

func newAuditStore(t *testing.T) *auditlog.Store {
	t.Helper()
	store, err := auditlog.NewStore(newAuditMemoryFS(), "/var/lib/vita-agent/audit-log.json", 1024)
	if err != nil {
		t.Fatalf("NewStore returned error: %v", err)
	}
	return store
}

// failingAuditStore is an AuditStore whose Append always fails, used to prove a
// record-keeping failure never changes a committed apply's result.
type failingAuditStore struct {
	appendErr error
	appends   int
}

func (s *failingAuditStore) Append(auditlog.Event) (auditlog.Event, error) {
	s.appends++
	return auditlog.Event{}, s.appendErr
}

func (s *failingAuditStore) Read() ([]auditlog.Event, error) {
	return nil, nil
}

func TestApplyAppendsSingleCommittedAuditEvent(t *testing.T) {
	store := newAuditStore(t)
	registry := mustRegistry(t, &mockTxCapability{name: "test.apply"})
	handler := mustHandler(t, handlerConfig{registry: registry, auditStore: store})

	response := perform(handler, http.MethodPost, "/apply", `{"operations":[{"capability":"test.apply","request":{"value":"one"}}]}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	var result ApplyResult
	decodeResponse(t, response, &result)
	if result.Outcome != transaction.OutcomeCommitted {
		t.Fatalf("Outcome = %q, want committed", result.Outcome)
	}
	if result.AuditUnrecorded {
		t.Fatalf("AuditUnrecorded = true, want false on a recorded commit")
	}

	events, err := store.Read()
	if err != nil {
		t.Fatalf("store.Read returned error: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("recorded %d events, want exactly 1: %#v", len(events), events)
	}
	got := events[0]
	wantMillis := transportStartedAt.Add(90 * time.Second).UnixMilli()
	want := auditlog.Event{
		Sequence:        1,
		TimestampMillis: wantMillis,
		ActorKind:       auditlog.ActorKindSystem,
		ActorID:         "agentd",
		Capability:      "test.apply",
		Operation:       auditlog.OperationApply,
		Outcome:         auditlog.OutcomeCommitted,
	}
	if got != want {
		t.Fatalf("audit event = %#v, want %#v", got, want)
	}
}

func TestApplyRolledBackRecordsRolledBackAuditEvent(t *testing.T) {
	store := newAuditStore(t)
	registry := mustRegistry(t,
		&mockTxCapability{name: "test.first"},
		&mockTxCapability{name: "test.second", applyErr: errMockApply},
	)
	handler := mustHandler(t, handlerConfig{registry: registry, auditStore: store})

	response := perform(handler, http.MethodPost, "/apply", `{"operations":[{"capability":"test.first","request":{"value":"one"}},{"capability":"test.second","request":{"value":"two"}}]}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	var result ApplyResult
	decodeResponse(t, response, &result)
	if result.Outcome != transaction.OutcomeRolledBack {
		t.Fatalf("Outcome = %q, want rolledBack", result.Outcome)
	}
	if result.AuditUnrecorded {
		t.Fatalf("AuditUnrecorded = true, want false on a recorded rollback")
	}

	events, err := store.Read()
	if err != nil {
		t.Fatalf("store.Read returned error: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("recorded %d events, want exactly 1: %#v", len(events), events)
	}
	got := events[0]
	if got.Outcome != auditlog.OutcomeRolledBack {
		t.Fatalf("audit outcome = %q, want rolled_back", got.Outcome)
	}
	if got.Capability != "test.second" {
		t.Fatalf("audit capability = %q, want test.second (the failing op)", got.Capability)
	}
	if got.Sequence != 1 {
		t.Fatalf("audit sequence = %d, want 1", got.Sequence)
	}
	if got.ActorKind != auditlog.ActorKindSystem || got.ActorID != "agentd" || got.Operation != auditlog.OperationApply {
		t.Fatalf("audit actor/operation = %#v, want system:agentd apply", got)
	}
}

func TestAuditReturnsEventsInOrder(t *testing.T) {
	store := newAuditStore(t)
	registry := mustRegistry(t, &mockTxCapability{name: "test.apply"})
	handler := mustHandler(t, handlerConfig{registry: registry, auditStore: store})

	for _, value := range []string{"one", "two", "three"} {
		response := perform(handler, http.MethodPost, "/apply", fmt.Sprintf(`{"operations":[{"capability":"test.apply","request":{"value":%q}}]}`, value))
		if response.Code != http.StatusOK {
			t.Fatalf("apply %q status code = %d, want %d; body=%s", value, response.Code, http.StatusOK, response.Body.String())
		}
	}

	response := perform(handler, http.MethodGet, "/audit", "")
	if response.Code != http.StatusOK {
		t.Fatalf("audit status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	if contentType := response.Header().Get("Content-Type"); contentType != "application/json" {
		t.Fatalf("audit Content-Type = %q, want application/json", contentType)
	}
	var got AuditResponse
	decodeResponse(t, response, &got)
	if len(got.Events) != 3 {
		t.Fatalf("audit returned %d events, want 3: %#v", len(got.Events), got.Events)
	}
	for i, event := range got.Events {
		wantSeq := uint64(i + 1)
		if event.Sequence != wantSeq {
			t.Fatalf("event %d sequence = %d, want %d", i, event.Sequence, wantSeq)
		}
		if event.Actor.Kind != string(auditlog.ActorKindSystem) || event.Actor.ID != "agentd" {
			t.Fatalf("event %d actor = %#v, want system:agentd", i, event.Actor)
		}
		if event.Operation != string(auditlog.OperationApply) || event.Outcome != string(auditlog.OutcomeCommitted) {
			t.Fatalf("event %d operation/outcome = %q/%q, want apply/committed", i, event.Operation, event.Outcome)
		}
		if event.Capability != "test.apply" {
			t.Fatalf("event %d capability = %q, want test.apply", i, event.Capability)
		}
	}
}

func TestApplyAuditAppendFailureKeepsCommitButFlagsUnrecorded(t *testing.T) {
	store := &failingAuditStore{appendErr: errors.New("disk full")}
	registry := mustRegistry(t, &mockTxCapability{name: "test.apply"})
	handler := mustHandler(t, handlerConfig{registry: registry, auditStore: store})

	defer func() {
		if recovered := recover(); recovered != nil {
			t.Fatalf("handler panicked: %v", recovered)
		}
	}()

	response := perform(handler, http.MethodPost, "/apply", `{"operations":[{"capability":"test.apply","request":{"value":"one"}}]}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	var result ApplyResult
	decodeResponse(t, response, &result)
	if result.Outcome != transaction.OutcomeCommitted {
		t.Fatalf("Outcome = %q, want committed (audit failure must not roll back)", result.Outcome)
	}
	if result.Error != nil {
		t.Fatalf("Error = %#v, want nil; an audit failure must not surface as a transaction error", result.Error)
	}
	if !result.AuditUnrecorded {
		t.Fatal("AuditUnrecorded = false, want true after an audit-append failure")
	}
	if store.appends != 1 {
		t.Fatalf("audit Append called %d times, want exactly 1", store.appends)
	}
}

func TestApplyWithoutAuditStoreWorksAndAuditReportsUnavailable(t *testing.T) {
	registry := mustRegistry(t, &mockTxCapability{name: "test.apply"})
	handler := mustHandler(t, handlerConfig{registry: registry})

	defer func() {
		if recovered := recover(); recovered != nil {
			t.Fatalf("handler panicked with nil audit store: %v", recovered)
		}
	}()

	applyResponse := perform(handler, http.MethodPost, "/apply", `{"operations":[{"capability":"test.apply","request":{"value":"one"}}]}`)
	if applyResponse.Code != http.StatusOK {
		t.Fatalf("apply status code = %d, want %d; body=%s", applyResponse.Code, http.StatusOK, applyResponse.Body.String())
	}
	var result ApplyResult
	decodeResponse(t, applyResponse, &result)
	if result.Outcome != transaction.OutcomeCommitted {
		t.Fatalf("Outcome = %q, want committed", result.Outcome)
	}
	if !result.AuditUnrecorded {
		t.Fatal("AuditUnrecorded = false, want true when no audit store is configured")
	}

	auditResponse := perform(handler, http.MethodGet, "/audit", "")
	if auditResponse.Code != http.StatusServiceUnavailable {
		t.Fatalf("audit status code = %d, want %d; body=%s", auditResponse.Code, http.StatusServiceUnavailable, auditResponse.Body.String())
	}
	var errorResponse ErrorResponse
	decodeResponse(t, auditResponse, &errorResponse)
	if errorResponse.Error.Code != "audit_unavailable" {
		t.Fatalf("audit error code = %q, want audit_unavailable", errorResponse.Error.Code)
	}
}

func TestAuditRejectsNonGET(t *testing.T) {
	store := newAuditStore(t)
	registry := mustRegistry(t, &mockTxCapability{name: "test.apply"})
	handler := mustHandler(t, handlerConfig{registry: registry, auditStore: store})

	response := perform(handler, http.MethodPost, "/audit", "")
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusMethodNotAllowed, response.Body.String())
	}
	if allow := response.Header().Get("Allow"); allow != http.MethodGet {
		t.Fatalf("Allow = %q, want %q", allow, http.MethodGet)
	}
}
