package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"time"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/capabilities/accounts"
	"github.com/vita/agent/capabilities/backup"
	"github.com/vita/agent/capabilities/capsule"
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
	"github.com/vita/agent/internal/auditlog"
	"github.com/vita/agent/transport"
)

const (
	agentVersion = "dev"
	listenAddr   = "127.0.0.1:8786"

	// stateRoot mirrors the per-capability state root convention so the audit
	// trail lives alongside the capabilities' persisted state.
	stateRoot = "/var/lib/vita-agent"
	// auditLogFilename is the fixed audit-log path under the agent state root.
	auditLogFilename = "audit-log.json"
	// auditLogMaxEvents bounds the append-only log before rotation is required.
	auditLogMaxEvents = 1_000_000
)

func main() {
	startedAt := time.Now().UTC()

	registry, err := capabilities.NewRegistry(
		accounts.NewCapability(),
		backup.NewCapability(),
		capsule.NewExecuteCapability(),
		capsule.NewFetchCapability(),
		capsule.NewCapability(),
		hostname.NewCapability(),
		identity.NewCapability(),
		network.NewCapability(),
		nodeconfig.NewCapability(),
		pdssync.NewCapability(),
		services.NewCapability(),
		storage.NewCapability(),
		nodetime.NewCapability(),
		timesync.NewCapability(),
		update.NewCapability(),
	)
	if err != nil {
		log.Fatalf("build capability registry: %v", err)
	}

	if !transport.IsLoopbackTCPAddr(listenAddr) {
		log.Fatalf("refusing to bind agent control surface to non-loopback address %s", listenAddr)
	}

	auditStore, err := auditlog.NewStore(auditlog.OSFileSystem{}, filepath.Join(stateRoot, auditLogFilename), auditLogMaxEvents)
	if err != nil {
		log.Fatalf("build audit log store: %v", err)
	}

	handler, err := transport.NewHandler(transport.Config{
		Version:    agentVersion,
		StartedAt:  startedAt,
		Registry:   registry,
		Discoverer: hardware.NewDiscoverer(),
		AuditStore: auditStore,
	})
	if err != nil {
		log.Fatalf("build control transport: %v", err)
	}
	server := &http.Server{
		Addr:              listenAddr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}

	unixListener, err := transport.ListenAuthenticatedUnixSocket(transport.DefaultUnixSocketPath, transport.UnixPeerAuthConfig{
		AuditStore: auditStore,
	})
	if err != nil {
		log.Fatalf("listen unix socket: %v", err)
	}
	defer func() {
		if err := unixListener.Close(); err != nil {
			log.Printf("close unix socket: %v", err)
		}
	}()
	unixServer := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}

	if err := serveUntilStopped(server, unixServer, unixListener); err != nil {
		log.Fatalf("serve agent: %v", err)
	}
}

func serveUntilStopped(tcpServer *http.Server, unixServer *http.Server, unixListener net.Listener) error {
	errCh := make(chan error, 2)
	go serveHTTP(errCh, "tcp "+tcpServer.Addr, func() error {
		log.Printf("vita agent listening on %s", tcpServer.Addr)
		return tcpServer.ListenAndServe()
	})
	go serveHTTP(errCh, "unix "+transport.DefaultUnixSocketPath, func() error {
		log.Printf("vita agent listening on unix socket %s", transport.DefaultUnixSocketPath)
		return unixServer.Serve(unixListener)
	})

	signalCh := make(chan os.Signal, 1)
	signal.Notify(signalCh, shutdownSignals()...)
	defer signal.Stop(signalCh)

	for {
		select {
		case sig := <-signalCh:
			log.Printf("vita agent received %s; shutting down", sig)
			return shutdownServers(tcpServer, unixServer)
		case err := <-errCh:
			if err == nil {
				continue
			}
			return errors.Join(err, shutdownServers(tcpServer, unixServer))
		}
	}
}

func serveHTTP(errCh chan<- error, name string, serve func() error) {
	if err := serve(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		errCh <- fmt.Errorf("%s: %w", name, err)
		return
	}
	errCh <- nil
}

func shutdownServers(tcpServer *http.Server, unixServer *http.Server) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	return errors.Join(tcpServer.Shutdown(ctx), unixServer.Shutdown(ctx))
}
