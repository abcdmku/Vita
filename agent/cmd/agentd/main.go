package main

import (
	"log"
	"net/http"
	"time"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/capabilities/backup"
	"github.com/vita/agent/capabilities/hostname"
	"github.com/vita/agent/capabilities/identity"
	"github.com/vita/agent/capabilities/network"
	"github.com/vita/agent/capabilities/nodeconfig"
	"github.com/vita/agent/capabilities/pdssync"
	"github.com/vita/agent/capabilities/storage"
	nodetime "github.com/vita/agent/capabilities/time"
	"github.com/vita/agent/capabilities/update"
	"github.com/vita/agent/hardware"
	"github.com/vita/agent/transport"
)

const (
	agentVersion = "dev"
	listenAddr   = "127.0.0.1:8786"
)

func main() {
	startedAt := time.Now().UTC()

	registry, err := capabilities.NewRegistry(
		backup.NewCapability(),
		hostname.NewCapability(),
		identity.NewCapability(),
		network.NewCapability(),
		nodeconfig.NewCapability(),
		pdssync.NewCapability(),
		storage.NewCapability(),
		nodetime.NewCapability(),
		update.NewCapability(),
	)
	if err != nil {
		log.Fatalf("build capability registry: %v", err)
	}

	if !transport.IsLoopbackTCPAddr(listenAddr) {
		log.Fatalf("refusing to bind agent control surface to non-loopback address %s", listenAddr)
	}

	// No auth is wired yet; the control surface is intentionally loopback-only.
	handler, err := transport.NewHandler(transport.Config{
		Version:    agentVersion,
		StartedAt:  startedAt,
		Registry:   registry,
		Discoverer: hardware.NewDiscoverer(),
	})
	if err != nil {
		log.Fatalf("build control transport: %v", err)
	}
	server := &http.Server{
		Addr:              listenAddr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("vita agent listening on %s", listenAddr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("serve agent: %v", err)
	}
}
