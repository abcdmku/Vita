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
	"github.com/vita/agent/capabilities/files"
	"github.com/vita/agent/capabilities/hostname"
	"github.com/vita/agent/capabilities/identity"
	"github.com/vita/agent/capabilities/network"
	"github.com/vita/agent/capabilities/nodeconfig"
	"github.com/vita/agent/capabilities/owner"
	"github.com/vita/agent/capabilities/pdsrepo"
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
	devTCPEnv    = "VITA_AGENT_DEV_TCP"

	// stateRoot mirrors the per-capability state root convention so the audit
	// trail lives alongside the capabilities' persisted state.
	stateRoot = "/var/lib/vita-agent"
	// auditLogFilename is the fixed audit-log path under the agent state root.
	auditLogFilename = "audit-log.json"
	// auditLogMaxEvents bounds the append-only log before rotation is required.
	auditLogMaxEvents = 1_000_000
)

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "powercut-marker":
			if err := runPowercutMarker(os.Args[2:], os.Stdout); err != nil {
				fmt.Fprintf(os.Stderr, "powercut-marker: %v\n", err)
				os.Exit(1)
			}
			return
		case "powercut-writer":
			if err := runPowercutWriter(os.Args[2:]); err != nil {
				fmt.Fprintf(os.Stderr, "powercut-writer: %v\n", err)
				os.Exit(1)
			}
			return
		default:
			fmt.Fprintf(os.Stderr, "unknown agentd subcommand %q\n", os.Args[1])
			os.Exit(2)
		}
	}

	startedAt := time.Now().UTC()
	archiveCapability := backup.NewArchiveCapability()
	executeCapability := capsule.NewExecuteCapability()
	lifecycleCapability := capsule.NewLifecycleCapability(executeCapability, archiveCapability)

	registry, err := capabilities.NewRegistry(
		accounts.NewCapability(),
		backup.NewCapability(),
		archiveCapability,
		executeCapability,
		lifecycleCapability,
		capsule.NewFetchCapability(),
		capsule.NewCapability(),
		hostname.NewCapability(),
		identity.NewCapability(),
		network.NewCapability(),
		nodeconfig.NewCapability(),
		owner.NewCapability(),
		pdsrepo.NewCapability(),
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

	auditStore, err := auditlog.NewStore(auditlog.OSFileSystem{}, filepath.Join(stateRoot, auditLogFilename), auditLogMaxEvents)
	if err != nil {
		log.Fatalf("build audit log store: %v", err)
	}

	handler, err := transport.NewHandler(transport.Config{
		Version:         agentVersion,
		StartedAt:       startedAt,
		Registry:        registry,
		Discoverer:      hardware.NewDiscoverer(),
		FilesGrants:     runtimeFilesGrants(),
		FilesPrincipals: runtimeFilesPrincipals(),
		AuditStore:      auditStore,
	})
	if err != nil {
		log.Fatalf("build control transport: %v", err)
	}
	tcpServer, transports, err := devTCPServerFromEnv(listenAddr, handler)
	if err != nil {
		log.Fatalf("build dev tcp control transport: %v", err)
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
		ConnContext:       transport.UnixPeerConnContext,
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("vita agent startup transports=%s", transports)

	if err := serveUntilStopped(tcpServer, unixServer, unixListener); err != nil {
		log.Fatalf("serve agent: %v", err)
	}
}

// memberPrincipalUID is the authenticated uid agentd binds to the spec §11
// member role (the role P1-073 shipped as "household-member"). It is a fixed TEST
// principal (no such OS account is provisioned this slice) that makes the member
// role gate a REAL, configured binding rather than an unreachable code path: a
// peer authenticating with this uid resolves to member and is genuinely
// role-forbidden on the member-forbidden grant below. agentd derives this
// identity only from the peer's SO_PEERCRED uid, never from request content.
const memberPrincipalUID uint32 = 65540

func runtimeFilesGrants() []files.Grant {
	shared := true
	grants := files.DefaultGrants()
	return append(grants,
		// Owner-writable shared folder over the six-role model: owner (the runtime
		// peer's bound role) proves a real write -> list -> read-back -> stat
		// round-trip; member/restricted-member are limited to read-only; guest and
		// service are ABSENT and therefore have NO access (role_forbidden every op,
		// the least-privilege default). administrator is RW but does NOT implicitly
		// inherit any other role — its access is exactly what is listed here.
		files.Grant{
			Name:   "runtime-files-shared-rw",
			Root:   "shared-owner",
			Shared: &shared,
			Roles: files.RoleAccessMap{
				files.RoleOwner:            files.AccessReadWrite,
				files.RoleAdministrator:    files.AccessReadWrite,
				files.RoleMember:           files.AccessReadOnly,
				files.RoleRestrictedMember: files.AccessReadOnly,
			},
		},
		// Owner-only shared folder: the member role is GENUINELY forbidden (no
		// access at all, denied even read) — a true role_forbidden distinct from a
		// read-only denial. The owner role retains read-write. guest/service/
		// restricted-member are likewise absent (forbidden by omission).
		files.Grant{
			Name:   "runtime-files-shared-member-forbidden",
			Root:   "shared-owner-only",
			Shared: &shared,
			Roles:  files.RoleAccessMap{files.RoleOwner: files.AccessReadWrite},
		},
		// Member-only shared folder: the OWNER role is ABSENT (no entry), so the
		// runtime's own bound role (owner, via the vita-agent group) is GENUINELY
		// role_forbidden on every op here. This makes the VITA-ROLES-REJECT a REAL,
		// measured per-principal denial from the runtime's OWN authenticated peer —
		// no second OS uid required — proving least-privilege fail-closed for a role
		// with no grant entry. (member is read-write only to keep the grant
		// non-empty and to show the absence of owner is deliberate, not an oversight.)
		files.Grant{
			Name:   "runtime-files-shared-owner-forbidden",
			Root:   "shared-member-only",
			Shared: &shared,
			Roles: files.RoleAccessMap{
				files.RoleMember: files.AccessReadWrite,
			},
		},
	)
}

func runtimeFilesPrincipals() []files.Principal {
	return []files.Principal{
		// The runtime authenticates through the stable vita-agent supplementary
		// group (its DynamicUser uid is transient and unbindable); agentd binds
		// that authenticated group identity to the owner role. This is the
		// privileged role that yields the boot write round-trip.
		{
			PrincipalKey: transport.UnixPeerGroupPrincipalKey(transport.DefaultUnixPeerGroupName),
			Role:         files.RoleOwner,
		},
		// A real member principal keyed off an authenticated uid, so the member
		// role gate (and its role_forbidden denial on the member-forbidden grant)
		// is a configured, exercisable binding rather than an unreachable default.
		{
			PrincipalKey: transport.UnixPeerUserPrincipalKey(memberPrincipalUID),
			Role:         files.RoleMember,
		},
	}
}

func devTCPServerFromEnv(addr string, handler http.Handler) (*http.Server, string, error) {
	if os.Getenv(devTCPEnv) != "1" {
		return nil, "unix", nil
	}

	server, err := newDevTCPServer(addr, handler)
	if err != nil {
		return nil, "", err
	}
	return server, "unix+tcp(dev)", nil
}

func newDevTCPServer(addr string, handler http.Handler) (*http.Server, error) {
	if !transport.IsLoopbackTCPAddr(addr) {
		return nil, fmt.Errorf("refusing to bind agent control surface to non-loopback address %s", addr)
	}

	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}, nil
}

func serveUntilStopped(tcpServer *http.Server, unixServer *http.Server, unixListener net.Listener) error {
	errCh := make(chan error, 2)
	if tcpServer != nil {
		go serveHTTP(errCh, "tcp "+tcpServer.Addr, func() error {
			log.Printf("vita agent listening on %s", tcpServer.Addr)
			return tcpServer.ListenAndServe()
		})
	}
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

	var shutdownErrs []error
	if tcpServer != nil {
		shutdownErrs = append(shutdownErrs, tcpServer.Shutdown(ctx))
	}
	if unixServer != nil {
		shutdownErrs = append(shutdownErrs, unixServer.Shutdown(ctx))
	}
	return errors.Join(shutdownErrs...)
}
