package status

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"time"

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

type healthSource func(context.Context) healthSnapshot

type healthSnapshot struct {
	CapsuleKnown     bool
	CapsuleWorkloads []capsuleruntime.WorkloadStatus
	TransportReady   *bool
	StorageKnown     bool
	StorageHealth    []storagehealth.MountHealth
}

type handler struct {
	version      string
	startedAt    time.Time
	capabilities []string
	now          clock
	health       healthSource
}

func NewHandler(version string, startedAt time.Time, capabilities []string) http.Handler {
	return newHandler(version, startedAt, capabilities, time.Now, defaultHealthSource())
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
	consulted := false

	if snapshot.CapsuleKnown || len(snapshot.CapsuleWorkloads) > 0 {
		consulted = true
		if len(snapshot.CapsuleWorkloads) == 0 {
			return false
		}
		for _, workload := range snapshot.CapsuleWorkloads {
			if workload.Health != capsuleruntime.StatusOK {
				return false
			}
		}
	}

	if snapshot.TransportReady != nil {
		consulted = true
		if !*snapshot.TransportReady {
			return false
		}
	}

	if snapshot.StorageKnown || len(snapshot.StorageHealth) > 0 {
		consulted = true
		if len(snapshot.StorageHealth) == 0 {
			return false
		}
		for _, mount := range snapshot.StorageHealth {
			if mount.Status != storagehealth.StatusOK {
				return false
			}
		}
	}

	return consulted
}

func defaultHealthSource() healthSource {
	return func(ctx context.Context) healthSnapshot {
		report, err := storagehealth.Collect(ctx, storagehealth.Roots{})
		if err != nil {
			return healthSnapshot{StorageKnown: true}
		}
		return healthSnapshot{
			StorageKnown:  true,
			StorageHealth: report.StorageHealth,
		}
	}
}
