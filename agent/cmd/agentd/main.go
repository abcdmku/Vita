package main

import (
	"log"
	"net/http"
	"time"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/status"
)

const (
	agentVersion = "dev"
	listenAddr   = "127.0.0.1:8786"
)

func main() {
	startedAt := time.Now().UTC()

	registry, err := capabilities.NewRegistry()
	if err != nil {
		log.Fatalf("build capability registry: %v", err)
	}

	handler := status.NewHandler(agentVersion, startedAt, registry.Names())
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
