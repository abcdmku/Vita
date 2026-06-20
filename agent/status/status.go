package status

import (
	"encoding/json"
	"net/http"
	"sort"
	"time"
)

type Status struct {
	Version       string    `json:"version"`
	StartedAt     time.Time `json:"startedAt"`
	UptimeSeconds int64     `json:"uptimeSeconds"`
	Capabilities  []string  `json:"capabilities"`
	Healthy       bool      `json:"healthy"`
}

type clock func() time.Time

type handler struct {
	version      string
	startedAt    time.Time
	capabilities []string
	now          clock
}

func NewHandler(version string, startedAt time.Time, capabilities []string) http.Handler {
	return newHandler(version, startedAt, capabilities, time.Now)
}

func newHandler(version string, startedAt time.Time, capabilities []string, now clock) http.Handler {
	names := make([]string, len(capabilities))
	copy(names, capabilities)
	sort.Strings(names)

	return &handler{
		version:      version,
		startedAt:    startedAt.UTC(),
		capabilities: names,
		now:          now,
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

	status := h.status()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(status)
}

func (h *handler) status() Status {
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
		Healthy:       true,
	}
}
