package status

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"time"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/capabilities/capsule"
	capsuleruntime "github.com/vita/agent/internal/capsule-runtime"
	"github.com/vita/agent/internal/storagehealth"
)

type Status struct {
	Version       string    `json:"version"`
	StartedAt     time.Time `json:"startedAt"`
	UptimeSeconds int64     `json:"uptimeSeconds"`
	Capabilities  []string  `json:"capabilities"`
	Healthy       bool      `json:"healthy"`
}

type clock func() time.Time

type ReadinessSource func(context.Context) bool

type StorageHealthSource func(context.Context) (storagehealth.Report, error)

type CapsuleSupervisor interface {
	Snapshot() []capsuleruntime.WorkloadStatus
}

type HealthConfig struct {
	CapsuleSupervisor CapsuleSupervisor
	CapsuleWorkloads  func() []capsuleruntime.WorkloadStatus
	Registry          *capabilities.Registry
	RegistryReady     ReadinessSource
	TransportReady    ReadinessSource
	StorageHealth     StorageHealthSource
	StorageRoots      storagehealth.Roots
}

type healthSource func(context.Context) healthSnapshot

type healthSnapshot struct {
	CapsuleKnown     bool
	CapsuleWorkloads []capsuleruntime.WorkloadStatus
	RegistryReady    *bool
	TransportReady   *bool
	StorageKnown     bool
	StorageHealth    []storagehealth.MountHealth
}

type capsuleWorkloadSource interface {
	Workloads() []capsuleruntime.WorkloadStatus
}

type handler struct {
	version      string
	startedAt    time.Time
	capabilities []string
	now          clock
	health       healthSource
}

func NewHandler(version string, startedAt time.Time, capabilities []string, healthConfig HealthConfig) http.Handler {
	return NewHandlerWithClock(version, startedAt, capabilities, time.Now, healthConfig)
}

func NewHandlerWithClock(version string, startedAt time.Time, capabilities []string, now func() time.Time, healthConfig HealthConfig) http.Handler {
	if now == nil {
		now = time.Now
	}
	return newHandler(version, startedAt, capabilities, clock(now), defaultHealthSource(healthConfig))
}

func newHandler(version string, startedAt time.Time, capabilities []string, now clock, health healthSource) http.Handler {
	names := make([]string, len(capabilities))
	copy(names, capabilities)
	sort.Strings(names)

	return &handler{
		version:      version,
		startedAt:    startedAt.UTC(),
		capabilities: names,
		now:          now,
		health:       health,
	}
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/healthz" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	status := h.status(r.Context())
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(status)
}

func (h *handler) status(ctx context.Context) Status {
	names := make([]string, len(h.capabilities))
	copy(names, h.capabilities)

	uptime := h.now().UTC().Sub(h.startedAt)
	if uptime < 0 {
		uptime = 0
	}

	return Status{
		Version:       h.version,
		StartedAt:     h.startedAt,
		UptimeSeconds: int64(uptime.Seconds()),
		Capabilities:  names,
		Healthy:       h.healthy(ctx),
	}
}

func (h *handler) healthy(ctx context.Context) bool {
	if h.health == nil {
		return false
	}
	return aggregateHealthy(h.health(ctx))
}

func aggregateHealthy(snapshot healthSnapshot) bool {
	if !snapshot.CapsuleKnown || len(snapshot.CapsuleWorkloads) == 0 {
		return false
	}
	for _, workload := range snapshot.CapsuleWorkloads {
		if workload.Health != capsuleruntime.StatusOK {
			return false
		}
	}

	if snapshot.RegistryReady == nil || !*snapshot.RegistryReady {
		return false
	}

	if snapshot.TransportReady == nil || !*snapshot.TransportReady {
		return false
	}

	if !snapshot.StorageKnown || len(snapshot.StorageHealth) == 0 {
		return false
	}
	for _, mount := range snapshot.StorageHealth {
		if mount.Status != storagehealth.StatusOK {
			return false
		}
	}

	return true
}

func defaultHealthSource(config HealthConfig) healthSource {
	capsuleWorkloads, capsuleKnown := capsuleWorkloadsFromConfig(config)
	storageHealth := config.StorageHealth
	if storageHealth == nil && capsuleKnown && config.RegistryReady != nil && config.TransportReady != nil {
		roots := config.StorageRoots
		storageHealth = func(ctx context.Context) (storagehealth.Report, error) {
			return storagehealth.Collect(ctx, roots)
		}
	}

	return func(ctx context.Context) healthSnapshot {
		snapshot := healthSnapshot{}

		if capsuleKnown {
			snapshot.CapsuleKnown = true
			if capsuleWorkloads != nil {
				snapshot.CapsuleWorkloads = cloneWorkloads(capsuleWorkloads())
			}
		}

		if config.RegistryReady != nil {
			registryReady := config.RegistryReady(ctx)
			snapshot.RegistryReady = &registryReady
		}

		if config.TransportReady != nil {
			transportReady := config.TransportReady(ctx)
			snapshot.TransportReady = &transportReady
		}

		if storageHealth == nil {
			return snapshot
		}
		report, err := storageHealth(ctx)
		if err != nil {
			snapshot.StorageKnown = true
			return snapshot
		}
		snapshot.StorageKnown = true
		snapshot.StorageHealth = report.StorageHealth
		return snapshot
	}
}

func capsuleWorkloadsFromConfig(config HealthConfig) (func() []capsuleruntime.WorkloadStatus, bool) {
	if config.CapsuleWorkloads != nil {
		return config.CapsuleWorkloads, true
	}
	if config.CapsuleSupervisor != nil {
		return config.CapsuleSupervisor.Snapshot, true
	}
	if config.Registry == nil {
		return nil, false
	}

	capability, ok := config.Registry.Lookup(capsule.ExecuteName)
	if !ok {
		return nil, false
	}
	source, ok := capability.(capsuleWorkloadSource)
	if !ok {
		return nil, true
	}
	return source.Workloads, true
}

func cloneWorkloads(in []capsuleruntime.WorkloadStatus) []capsuleruntime.WorkloadStatus {
	out := make([]capsuleruntime.WorkloadStatus, len(in))
	copy(out, in)
	return out
}
