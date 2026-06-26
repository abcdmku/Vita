package status

import (
	"context"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/capabilities/capsule"
	capsuleruntime "github.com/vita/agent/internal/capsule-runtime"
	"github.com/vita/agent/internal/storagehealth"
)

func TestHealthzReturnsStatus(t *testing.T) {
	startedAt := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	now := func() time.Time {
		return startedAt.Add(90 * time.Second)
	}
	handler := newHandler("test-version", startedAt, []string{"test.write", "test.read"}, now, healthyHealthSource())

	status, body, response := requestHealthz(t, handler)

	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d", response.Code, http.StatusOK)
	}
	if contentType := response.Header().Get("Content-Type"); contentType != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", contentType)
	}

	for _, disallowed := range []string{"secret", "token", "password"} {
		if strings.Contains(strings.ToLower(body), disallowed) {
			t.Fatalf("health response contains disallowed %q: %s", disallowed, body)
		}
	}

	if status.Version != "test-version" {
		t.Fatalf("Version = %q, want %q", status.Version, "test-version")
	}
	if !status.StartedAt.Equal(startedAt) {
		t.Fatalf("StartedAt = %s, want %s", status.StartedAt, startedAt)
	}
	if status.UptimeSeconds != 90 {
		t.Fatalf("UptimeSeconds = %d, want 90", status.UptimeSeconds)
	}
	if !status.Healthy {
		t.Fatal("Healthy = false, want true")
	}

	wantCapabilities := []string{"test.read", "test.write"}
	if len(status.Capabilities) != len(wantCapabilities) {
		t.Fatalf("Capabilities = %v, want %v", status.Capabilities, wantCapabilities)
	}
	for i, want := range wantCapabilities {
		if status.Capabilities[i] != want {
			t.Fatalf("Capabilities[%d] = %q, want %q", i, status.Capabilities[i], want)
		}
	}
}

func TestHealthzReportsUnhealthySubsystem(t *testing.T) {
	tests := []struct {
		name     string
		snapshot healthSnapshot
	}{
		{
			name:     "capsule down",
			snapshot: unhealthySnapshot(func(snapshot *healthSnapshot) { snapshot.CapsuleWorkloads[0].Health = capsuleruntime.StatusDown }),
		},
		{
			name:     "capsule unhealthy",
			snapshot: unhealthySnapshot(func(snapshot *healthSnapshot) { snapshot.CapsuleWorkloads[0].Health = capsuleruntime.StatusUnhealthy }),
		},
		{
			name:     "capsule unknown",
			snapshot: unhealthySnapshot(func(snapshot *healthSnapshot) { snapshot.CapsuleWorkloads[0].Health = capsuleruntime.StatusUnknown }),
		},
		{
			name:     "registry unready",
			snapshot: unhealthySnapshot(func(snapshot *healthSnapshot) { snapshot.RegistryReady = boolPointer(false) }),
		},
		{
			name:     "transport unready",
			snapshot: unhealthySnapshot(func(snapshot *healthSnapshot) { snapshot.TransportReady = boolPointer(false) }),
		},
		{
			name:     "storage degraded",
			snapshot: unhealthySnapshot(func(snapshot *healthSnapshot) { snapshot.StorageHealth[0].Status = storagehealth.StatusDegraded }),
		},
		{
			name:     "storage unknown",
			snapshot: unhealthySnapshot(func(snapshot *healthSnapshot) { snapshot.StorageHealth[0].Status = storagehealth.StatusUnknown }),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			handler := testHandler(staticHealthSource(tt.snapshot))
			status, _, _ := requestHealthz(t, handler)
			if status.Healthy {
				t.Fatalf("Healthy = true, want false for %#v", tt.snapshot)
			}
		})
	}
}

func TestHealthzFailClosedWorstOf(t *testing.T) {
	tests := []struct {
		name     string
		snapshot healthSnapshot
	}{
		{
			name:     "no information",
			snapshot: healthSnapshot{},
		},
		{
			name: "known empty capsule snapshot",
			snapshot: unhealthySnapshot(func(snapshot *healthSnapshot) {
				snapshot.CapsuleKnown = true
				snapshot.CapsuleWorkloads = nil
			}),
		},
		{
			name: "known empty storage snapshot",
			snapshot: unhealthySnapshot(func(snapshot *healthSnapshot) {
				snapshot.StorageKnown = true
				snapshot.StorageHealth = nil
			}),
		},
		{
			name: "missing registry readiness",
			snapshot: unhealthySnapshot(func(snapshot *healthSnapshot) {
				snapshot.RegistryReady = nil
			}),
		},
		{
			name: "missing transport readiness",
			snapshot: unhealthySnapshot(func(snapshot *healthSnapshot) {
				snapshot.TransportReady = nil
			}),
		},
		{
			name: "one degraded input dominates healthy inputs",
			snapshot: healthSnapshot{
				CapsuleKnown: true,
				CapsuleWorkloads: []capsuleruntime.WorkloadStatus{{
					Health: capsuleruntime.StatusOK,
				}},
				RegistryReady:  boolPointer(true),
				TransportReady: boolPointer(true),
				StorageKnown:   true,
				StorageHealth: []storagehealth.MountHealth{{
					Status: storagehealth.StatusOK,
				}, {
					Status: storagehealth.StatusDegraded,
				}},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			handler := testHandler(staticHealthSource(tt.snapshot))
			status, _, _ := requestHealthz(t, handler)
			if status.Healthy {
				t.Fatalf("Healthy = true, want false for %#v", tt.snapshot)
			}
		})
	}
}

func TestNewHandlerProductionHealthSourceAggregatesLiveSubsystemState(t *testing.T) {
	tests := []struct {
		name           string
		capsuleHealth  capsuleruntime.Status
		registryReady  bool
		transportReady bool
		wantHealthy    bool
	}{
		{
			name:           "all production sources ready",
			capsuleHealth:  capsuleruntime.StatusOK,
			registryReady:  true,
			transportReady: true,
			wantHealthy:    true,
		},
		{
			name:           "registry backed capsule supervisor down",
			capsuleHealth:  capsuleruntime.StatusDown,
			registryReady:  true,
			transportReady: true,
			wantHealthy:    false,
		},
		{
			name:           "registry unready",
			capsuleHealth:  capsuleruntime.StatusOK,
			registryReady:  false,
			transportReady: true,
			wantHealthy:    false,
		},
		{
			name:           "transport unready",
			capsuleHealth:  capsuleruntime.StatusOK,
			registryReady:  true,
			transportReady: false,
			wantHealthy:    false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			supervisor := supervisorWithStatus(t, tt.capsuleHealth)
			registry, err := capabilities.NewRegistry(capsule.NewExecuteCapabilityWithSupervisor(supervisor))
			if err != nil {
				t.Fatalf("NewRegistry returned error: %v", err)
			}

			startedAt := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
			handler := NewHandler(
				"test-version",
				startedAt,
				[]string{"capsule.execute"},
				HealthConfig{
					Registry:       registry,
					RegistryReady:  readinessSource(tt.registryReady),
					TransportReady: readinessSource(tt.transportReady),
					StorageHealth:  healthyStorageSnapshot,
				},
			)

			status, _, _ := requestHealthz(t, handler)
			if status.Healthy != tt.wantHealthy {
				t.Fatalf("Healthy = %v, want %v", status.Healthy, tt.wantHealthy)
			}
		})
	}
}

func TestNewHandlerZeroHealthConfigFailsClosed(t *testing.T) {
	startedAt := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	handler := NewHandler("test-version", startedAt, []string{"test.read"})

	status, _, _ := requestHealthz(t, handler)
	if status.Healthy {
		t.Fatal("Healthy = true, want false for zero HealthConfig")
	}
}

func TestNewHandlerUnwiredTransportFailsClosed(t *testing.T) {
	supervisor := supervisorWithStatus(t, capsuleruntime.StatusOK)
	registry, err := capabilities.NewRegistry(capsule.NewExecuteCapabilityWithSupervisor(supervisor))
	if err != nil {
		t.Fatalf("NewRegistry returned error: %v", err)
	}

	startedAt := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	handler := NewHandler(
		"test-version",
		startedAt,
		[]string{"capsule.execute"},
		HealthConfig{
			Registry:      registry,
			RegistryReady: readinessSource(true),
			StorageHealth: healthyStorageSnapshot,
		},
	)

	status, _, _ := requestHealthz(t, handler)
	if status.Healthy {
		t.Fatal("Healthy = true, want false when transport readiness is unwired")
	}
}

func TestStatusDoesNotAssignLiteralHealthyTrue(t *testing.T) {
	fileSet := token.NewFileSet()
	file, err := parser.ParseFile(fileSet, "status.go", nil, 0)
	if err != nil {
		t.Fatalf("parse status.go: %v", err)
	}

	ast.Inspect(file, func(node ast.Node) bool {
		keyValue, ok := node.(*ast.KeyValueExpr)
		if !ok {
			return true
		}
		key, ok := keyValue.Key.(*ast.Ident)
		if !ok || key.Name != "Healthy" {
			return true
		}
		value, ok := keyValue.Value.(*ast.Ident)
		if ok && value.Name == "true" {
			position := fileSet.Position(keyValue.Pos())
			t.Fatalf("Status.Healthy assigned literal true at %s", position)
		}
		return true
	})
}

func TestStatusDoesNotHardcodeReadinessTrue(t *testing.T) {
	fileSet := token.NewFileSet()
	file, err := parser.ParseFile(fileSet, "status.go", nil, 0)
	if err != nil {
		t.Fatalf("parse status.go: %v", err)
	}

	ast.Inspect(file, func(node ast.Node) bool {
		switch typed := node.(type) {
		case *ast.AssignStmt:
			for i, lhs := range typed.Lhs {
				if !readinessIdentifier(lhs) {
					continue
				}
				rhs := typed.Rhs[len(typed.Rhs)-1]
				if i < len(typed.Rhs) {
					rhs = typed.Rhs[i]
				}
				if isTrueLiteral(rhs) {
					position := fileSet.Position(typed.Pos())
					t.Fatalf("readiness assigned literal true at %s", position)
				}
			}
		case *ast.ValueSpec:
			for i, name := range typed.Names {
				if !readinessName(name.Name) || len(typed.Values) == 0 {
					continue
				}
				value := typed.Values[len(typed.Values)-1]
				if i < len(typed.Values) {
					value = typed.Values[i]
				}
				if isTrueLiteral(value) {
					position := fileSet.Position(typed.Pos())
					t.Fatalf("readiness value assigned literal true at %s", position)
				}
			}
		}
		return true
	})
}

func testHandler(health healthSource) http.Handler {
	startedAt := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	now := func() time.Time {
		return startedAt.Add(90 * time.Second)
	}
	return newHandler("test-version", startedAt, []string{"test.write", "test.read"}, now, health)
}

func healthyHealthSource() healthSource {
	return staticHealthSource(healthyHealthSnapshot())
}

func healthyHealthSnapshot() healthSnapshot {
	return healthSnapshot{
		CapsuleKnown: true,
		CapsuleWorkloads: []capsuleruntime.WorkloadStatus{{
			Health: capsuleruntime.StatusOK,
		}},
		RegistryReady:  boolPointer(true),
		TransportReady: boolPointer(true),
		StorageKnown:   true,
		StorageHealth: []storagehealth.MountHealth{{
			Status: storagehealth.StatusOK,
		}},
	}
}

func unhealthySnapshot(mutate func(*healthSnapshot)) healthSnapshot {
	snapshot := healthyHealthSnapshot()
	mutate(&snapshot)
	return snapshot
}

func staticHealthSource(snapshot healthSnapshot) healthSource {
	return func(context.Context) healthSnapshot {
		return snapshot
	}
}

func readinessSource(value bool) ReadinessSource {
	return func(context.Context) bool {
		return value
	}
}

func healthyStorageSnapshot(context.Context) (storagehealth.Report, error) {
	return storagehealth.Report{
		StorageHealth: []storagehealth.MountHealth{{
			Status: storagehealth.StatusOK,
		}},
	}, nil
}

func supervisorWithStatus(t *testing.T, status capsuleruntime.Status) *capsuleruntime.Supervisor {
	t.Helper()

	const unit = "test-capsule.service"
	supervisor := capsuleruntime.NewSupervisor(capsuleruntime.Options{
		Prober: staticCapsuleProber{status: status},
	})
	supervisor.StartWorkload(capsuleruntime.WorkloadSpec{
		ID:   "dev.vita.test",
		Unit: unit,
		Checks: []capsuleruntime.Check{{
			Name:            "ready",
			Type:            capsuleruntime.CheckTypeHTTP,
			Target:          "http://127.0.0.1/healthz",
			IntervalSeconds: 3600,
			TimeoutSeconds:  1,
		}},
	})
	t.Cleanup(func() {
		supervisor.StopWorkload(unit)
	})
	return supervisor
}

type staticCapsuleProber struct {
	status capsuleruntime.Status
}

func (p staticCapsuleProber) PollHealth(context.Context, capsuleruntime.Check) (capsuleruntime.Status, error) {
	return p.status, nil
}

func (p staticCapsuleProber) Restarts(context.Context, string) (int, error) {
	return 0, nil
}

func requestHealthz(t *testing.T, handler http.Handler) (Status, string, *httptest.ResponseRecorder) {
	t.Helper()

	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	body := response.Body.String()
	var status Status
	if err := json.Unmarshal([]byte(body), &status); err != nil {
		t.Fatalf("health response is not JSON status: %v", err)
	}
	return status, body, response
}

func boolPointer(value bool) *bool {
	return &value
}

func readinessIdentifier(expr ast.Expr) bool {
	identifier, ok := expr.(*ast.Ident)
	return ok && readinessName(identifier.Name)
}

func readinessName(name string) bool {
	return strings.Contains(strings.ToLower(name), "ready")
}

func isTrueLiteral(expr ast.Expr) bool {
	identifier, ok := expr.(*ast.Ident)
	return ok && identifier.Name == "true"
}
