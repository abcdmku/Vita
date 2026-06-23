//go:build unix

package transport

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vita/agent/internal/auditlog"
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

func TestAuthenticatedUnixSocketListenerRejectsUnauthorizedAndServesAuthorizedPeer(t *testing.T) {
	socketPath := filepath.Join(t.TempDir(), "agentd.sock")
	targetGID := uint32(4242)
	store := newAuditStore(t)
	peerInfos := make(chan unixPeerInfo, 2)
	peerInfos <- unixPeerInfo{
		Credentials: peerCredentials{PID: 111, UID: 1000, GID: 61000},
		Groups:      []uint32{1000, 1001},
		GroupSource: "SO_PEERGROUPS",
	}
	peerInfos <- unixPeerInfo{
		Credentials: peerCredentials{PID: 222, UID: 1001, GID: 61001},
		Groups:      []uint32{1000, targetGID},
		GroupSource: "SO_PEERGROUPS",
	}
	close(peerInfos)

	listener, err := ListenAuthenticatedUnixSocket(socketPath, UnixPeerAuthConfig{
		GroupID:    &targetGID,
		AuditStore: store,
		Now: func() time.Time {
			return transportStartedAt
		},
		readPeerInfo: func(net.Conn) (unixPeerInfo, error) {
			info, ok := <-peerInfos
			if !ok {
				return unixPeerInfo{}, errors.New("unexpected peer auth check")
			}
			return info, nil
		},
	})
	if err != nil {
		t.Fatalf("ListenAuthenticatedUnixSocket returned error: %v", err)
	}
	defer listener.Close()

	var served atomic.Int32
	server := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			served.Add(1)
			writeJSON(w, http.StatusOK, status.Status{Version: "test-version", Healthy: true})
		}),
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

	unauthorized, err := net.Dial("unix", socketPath)
	if err != nil {
		t.Fatalf("dial unauthorized unix socket peer: %v", err)
	}
	_, _ = unauthorized.Write([]byte("GET /healthz HTTP/1.1\r\nHost: agentd\r\n\r\n"))
	if err := unauthorized.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("set unauthorized read deadline: %v", err)
	}
	buf := make([]byte, 1)
	n, readErr := unauthorized.Read(buf)
	if readErr == nil {
		t.Fatalf("unauthorized read returned n=%d, want closed connection error", n)
	}
	if !errors.Is(readErr, io.EOF) && !errors.Is(readErr, net.ErrClosed) {
		var netErr net.Error
		if !errors.As(readErr, &netErr) || netErr.Timeout() {
			t.Fatalf("unauthorized read error = %v, want connection closed", readErr)
		}
	}
	if err := unauthorized.Close(); err != nil {
		t.Fatalf("close unauthorized conn: %v", err)
	}
	if got := served.Load(); got != 0 {
		t.Fatalf("served requests after unauthorized peer = %d, want 0", got)
	}

	events, err := store.Read()
	if err != nil {
		t.Fatalf("audit Read returned error: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("audit events = %d, want 1: %#v", len(events), events)
	}
	gotEvent := events[0]
	if gotEvent.Capability != unixPeerAuthCapability ||
		gotEvent.Operation != auditlog.OperationRead ||
		gotEvent.Outcome != auditlog.OutcomeRejected ||
		gotEvent.Reason != peerUnauthorizedReason ||
		gotEvent.ActorID != "peer:pid:111" {
		t.Fatalf("unauthorized audit event = %#v, want rejected peer_unauthorized transport event", gotEvent)
	}

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
		t.Fatalf("authorized GET /healthz over unix socket returned error: %v", err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("authorized status code = %d, want %d", response.StatusCode, http.StatusOK)
	}
	if err := response.Body.Close(); err != nil {
		t.Fatalf("close authorized response body: %v", err)
	}
	client.CloseIdleConnections()
	if got := served.Load(); got != 1 {
		t.Fatalf("served requests after authorized peer = %d, want 1", got)
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
}
