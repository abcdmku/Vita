package status

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHealthzReturnsStatus(t *testing.T) {
	startedAt := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	now := func() time.Time {
		return startedAt.Add(90 * time.Second)
	}
	handler := newHandler("test-version", startedAt, []string{"test.write", "test.read"}, now)

	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d", response.Code, http.StatusOK)
	}
	if contentType := response.Header().Get("Content-Type"); contentType != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", contentType)
	}

	body := response.Body.String()
	for _, disallowed := range []string{"secret", "token", "password"} {
		if strings.Contains(strings.ToLower(body), disallowed) {
			t.Fatalf("health response contains disallowed %q: %s", disallowed, body)
		}
	}

	var status Status
	if err := json.Unmarshal([]byte(body), &status); err != nil {
		t.Fatalf("health response is not JSON status: %v", err)
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
