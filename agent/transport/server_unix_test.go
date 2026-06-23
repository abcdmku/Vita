//go:build unix

package transport

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/vita/agent/status"
)

func TestUnixSocketListenerServesHealthzReplacesStaleSocketAndUnlinks(t *testing.T) {
	socketPath := filepath.Join(t.TempDir(), "agentd.sock")
	stale, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatalf("create stale unix socket: %v", err)
	}
	if err := stale.Close(); err != nil {
		t.Fatalf("close stale unix socket: %v", err)
	}
	if _, err := os.Stat(socketPath); err != nil {
		t.Fatalf("stale socket was not left on disk: %v", err)
	}

	listener, err := ListenUnixSocket(socketPath)
	if err != nil {
		t.Fatalf("ListenUnixSocket returned error: %v", err)
	}
	defer listener.Close()

	info, err := os.Stat(socketPath)
	if err != nil {
		t.Fatalf("stat unix socket: %v", err)
	}
	if info.Mode()&os.ModeSocket == 0 {
		t.Fatalf("socket path mode = %s, want socket", info.Mode())
	}
	if got := info.Mode().Perm(); got != DefaultUnixSocketMode {
		t.Fatalf("socket mode = %o, want %o", got, DefaultUnixSocketMode)
	}

	handler := mustHandler(t, handlerConfig{
		registry: mustRegistry(t, &mockTxCapability{name: "test.apply"}),
	})
	server := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}
	serveErr := make(chan error, 1)
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
			return
		}
		serveErr <- nil
	}()

	client := &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var dialer net.Dialer
				return dialer.DialContext(ctx, "unix", socketPath)
			},
		},
	}

	response, err := client.Get("http://agentd/healthz")
	if err != nil {
		t.Fatalf("GET /healthz over unix socket returned error: %v", err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status code = %d, want %d", response.StatusCode, http.StatusOK)
	}
	if contentType := response.Header.Get("Content-Type"); contentType != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", contentType)
	}
	var health status.Status
	if err := json.NewDecoder(response.Body).Decode(&health); err != nil {
		t.Fatalf("decode health response: %v", err)
	}
	if err := response.Body.Close(); err != nil {
		t.Fatalf("close health response body: %v", err)
	}
	client.CloseIdleConnections()

	if health.Version != "test-version" {
		t.Fatalf("health Version = %q, want test-version", health.Version)
	}
	if !health.Healthy {
		t.Fatal("health Healthy = false, want true")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		t.Fatalf("server shutdown returned error: %v", err)
	}
	select {
	case err := <-serveErr:
		if err != nil {
			t.Fatalf("server.Serve returned error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("server.Serve did not return after shutdown")
	}

	if _, err := os.Stat(socketPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket path after shutdown error = %v, want not exist", err)
	}
}
