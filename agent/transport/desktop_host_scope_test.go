package transport

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/capabilities/capsule"
	filecap "github.com/vita/agent/capabilities/files"
	"github.com/vita/agent/capabilities/identity"
	"github.com/vita/agent/capabilities/nodeconfig"
	identityroles "github.com/vita/agent/identity/roles"
	"github.com/vita/agent/internal/auditlog"
	"github.com/vita/agent/transaction"
)

const (
	desktopHostPeerUID = uint32(7001)
	desktopHostPeerGID = uint32(4242)
)

func TestDesktopHostPeerAllowsAllowlistedCapabilities(t *testing.T) {
	events := []string{}
	store := newAuditStore(t)
	handler := mustDesktopHostScopeHandler(t, desktopHostScopeHandlerConfig{
		auditStore: store,
		registry: mustRegistry(t,
			&routedTxCapability{name: capsule.ExecuteName, events: &events},
			&routedTxCapability{name: nodeconfig.Name, events: &events},
		),
		filesStateRoot: newDesktopHostFilesStateRoot(t),
		filesGrants: []filecap.Grant{
			{Name: "desktop", Root: "desktop", Access: filecap.AccessReadWrite},
		},
	})
	client, shutdown := serveDesktopHostScopeHandler(t, handler, store, desktopPeerInfo)
	defer shutdown()

	data := []byte("desktop file data")
	filesBody := fmt.Sprintf(
		`{"op":"write","grant":"desktop","path":"note.txt","data":%q}`,
		base64.StdEncoding.EncodeToString(data),
	)
	filesStatus, filesResponse := desktopHostRequest(t, client, http.MethodPost, "/files", filesBody)
	assertFilesWriteServedByHandler(t, filesStatus, filesResponse, int64(len(data)))

	readFileStatus, readFileResponse := desktopHostRequest(t, client, http.MethodPost, "/files", `{"op":"read","grant":"desktop","path":"note.txt"}`)
	assertFilesReadServedByHandler(t, readFileStatus, readFileResponse, data)

	readStatus, readResponse := desktopHostRequest(t, client, http.MethodGet, "/read/"+capsule.ExecuteName, "")
	if readStatus != http.StatusOK {
		t.Fatalf("capsule execute read status = %d, want %d; body=%s", readStatus, http.StatusOK, readResponse)
	}

	capsuleBody := `{"operations":[{"capability":"capsule.execute","request":{"desired":{"id":"local.test.capsule","version":"1.0.0","integrity":"` + transportSHA256SRI + `"}}}]}`
	capsuleStatus, capsuleResponse := desktopHostRequest(t, client, http.MethodPost, "/apply", capsuleBody)
	if capsuleStatus != http.StatusOK {
		t.Fatalf("capsule execute apply status = %d, want %d; body=%s", capsuleStatus, http.StatusOK, capsuleResponse)
	}

	nodeConfigBody := `{"operations":[{"capability":"node.config","request":{"desired":{"mode":"maintenance","remoteAccess":"enabled"}}}]}`
	nodeConfigStatus, nodeConfigResponse := desktopHostRequest(t, client, http.MethodPost, "/apply", nodeConfigBody)
	if nodeConfigStatus != http.StatusOK {
		t.Fatalf("node config apply status = %d, want %d; body=%s", nodeConfigStatus, http.StatusOK, nodeConfigResponse)
	}

	wantEvents := []string{capsule.ExecuteName, nodeconfig.Name}
	if !reflect.DeepEqual(events, wantEvents) {
		t.Fatalf("events = %v, want %v", events, wantEvents)
	}
}

func TestDesktopHostPeerRejectsForbiddenApplyBeforeRegistryAndAudits(t *testing.T) {
	events := []string{}
	store := newAuditStore(t)
	handler := mustDesktopHostScopeHandler(t, desktopHostScopeHandlerConfig{
		auditStore: store,
		registry: mustRegistry(t,
			&routedTxCapability{
				name:   capsule.ExecuteName,
				events: &events,
				apply: func(capabilities.TypedRequest) error {
					t.Fatal("allowlisted apply ran before later forbidden operation was rejected")
					return nil
				},
			},
			&routedTxCapability{
				name:   identity.Name,
				events: &events,
				apply: func(capabilities.TypedRequest) error {
					t.Fatal("forbidden apply reached registry transaction")
					return nil
				},
			},
		),
	})
	client, shutdown := serveDesktopHostScopeHandler(t, handler, store, desktopPeerInfo)
	defer shutdown()

	status, body := desktopHostRequest(t, client, http.MethodPost, "/apply", `{"operations":[{"capability":"capsule.execute","request":{"desired":{"id":"local.test.capsule","version":"1.0.0","integrity":"`+transportSHA256SRI+`"}}},{"capability":"identity.attestation","request":{"value":"must-not-decode"}}]}`)
	if status != http.StatusForbidden {
		t.Fatalf("status = %d, want %d; body=%s", status, http.StatusForbidden, body)
	}
	assertCapabilityForbidden(t, body)
	if len(events) != 0 {
		t.Fatalf("events = %v, want no registry/transaction effect", events)
	}
	assertDesktopScopeAuditEvents(t, store, []auditlog.Operation{auditlog.OperationApply})
}

func TestDesktopHostPeerDefaultDeniesExplicitDesktopWithoutServiceBinding(t *testing.T) {
	events := []string{}
	store := newAuditStore(t)
	handler := mustDesktopHostScopeHandler(t, desktopHostScopeHandlerConfig{
		auditStore: store,
		registry: mustRegistry(t, &routedTxCapability{
			name:   capsule.ExecuteName,
			events: &events,
			apply: func(capabilities.TypedRequest) error {
				t.Fatal("allowlisted apply reached registry without the explicit desktop service binding")
				return nil
			},
		}),
		unixPeerRoles: []UnixPeerRoleBinding{},
	})
	client, shutdown := serveDesktopHostScopeHandler(t, handler, store, desktopPeerInfo)
	defer shutdown()

	status, body := desktopHostRequest(t, client, http.MethodPost, "/apply", `{"operations":[{"capability":"capsule.execute","request":{"desired":{"id":"local.test.capsule","version":"1.0.0","integrity":"`+transportSHA256SRI+`"}}}]}`)
	if status != http.StatusForbidden {
		t.Fatalf("status = %d, want %d; body=%s", status, http.StatusForbidden, body)
	}
	assertCapabilityForbidden(t, body)
	if len(events) != 0 {
		t.Fatalf("events = %v, want no registry/transaction effect", events)
	}
	assertDesktopScopeAuditEvents(t, store, []auditlog.Operation{auditlog.OperationApply})
}

func TestDesktopHostPeerRejectsForbiddenReadAndStateBeforeRegistry(t *testing.T) {
	events := []string{}
	store := newAuditStore(t)
	handler := mustDesktopHostScopeHandler(t, desktopHostScopeHandlerConfig{
		auditStore: store,
		registry: mustRegistry(t, &stateReadCapability{
			name:     identity.Name,
			response: stateReadResponse{Name: identity.Name, Ordinal: 1},
			events:   &events,
		}),
	})
	client, shutdown := serveDesktopHostScopeHandler(t, handler, store, desktopPeerInfo)
	defer shutdown()

	readStatus, readBody := desktopHostRequest(t, client, http.MethodGet, "/read/"+identity.Name, "")
	if readStatus != http.StatusForbidden {
		t.Fatalf("read status = %d, want %d; body=%s", readStatus, http.StatusForbidden, readBody)
	}
	assertCapabilityForbidden(t, readBody)

	stateStatus, stateBody := desktopHostRequest(t, client, http.MethodGet, "/state", "")
	if stateStatus != http.StatusForbidden {
		t.Fatalf("state status = %d, want %d; body=%s", stateStatus, http.StatusForbidden, stateBody)
	}
	assertCapabilityForbidden(t, stateBody)

	if len(events) != 0 {
		t.Fatalf("events = %v, want no forbidden read/state dispatch", events)
	}
	assertDesktopScopeAuditEvents(t, store, []auditlog.Operation{auditlog.OperationRead, auditlog.OperationRead})
}

func TestDesktopHostPeerUnauthorizedPeerStillRejectedByPeerCredGate(t *testing.T) {
	store := newAuditStore(t)
	handler := mustDesktopHostScopeHandler(t, desktopHostScopeHandlerConfig{
		auditStore: store,
		registry:   mustRegistry(t),
	})
	listener := newDesktopHostPipeListener()
	authenticated, err := AuthenticateUnixSocketListener(listener, UnixPeerAuthConfig{
		GroupID:    ptrUint32(desktopHostPeerGID),
		AuditStore: store,
		Now: func() time.Time {
			return transportStartedAt
		},
		readPeerInfo: func(net.Conn) (unixPeerInfo, error) {
			return unixPeerInfo{
				Credentials: peerCredentials{PID: 3001, UID: 9001, GID: 61000},
				Groups:      []uint32{61000, 61001},
				GroupSource: "SO_PEERGROUPS",
			}, nil
		},
	})
	if err != nil {
		t.Fatalf("AuthenticateUnixSocketListener returned error: %v", err)
	}
	server, wait := serveHTTPOnListener(t, authenticated, handler)
	defer shutdownHTTPServer(t, server, wait)

	conn, err := listener.DialContext(context.Background())
	if err != nil {
		t.Fatalf("dial unauthorized peer: %v", err)
	}
	_, writeErr := io.WriteString(conn, "GET /healthz HTTP/1.1\r\nHost: agentd\r\n\r\n")
	if writeErr == nil {
		if err := conn.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
			t.Fatalf("set read deadline: %v", err)
		}
		buf := make([]byte, 1)
		n, readErr := conn.Read(buf)
		if readErr == nil {
			t.Fatalf("unauthorized read returned n=%d, want closed connection error", n)
		}
		if !errors.Is(readErr, io.EOF) && !errors.Is(readErr, net.ErrClosed) {
			var netErr net.Error
			if !errors.As(readErr, &netErr) || netErr.Timeout() {
				t.Fatalf("unauthorized read error = %v, want connection closed", readErr)
			}
		}
	} else if !errors.Is(writeErr, io.ErrClosedPipe) && !errors.Is(writeErr, net.ErrClosed) {
		var netErr net.Error
		if !errors.As(writeErr, &netErr) || netErr.Timeout() {
			t.Fatalf("write unauthorized request error = %v, want connection closed", writeErr)
		}
	}
	if err := conn.Close(); err != nil {
		t.Fatalf("close unauthorized conn: %v", err)
	}

	events, err := store.Read()
	if err != nil {
		t.Fatalf("audit Read returned error: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("audit events = %d, want 1: %#v", len(events), events)
	}
	event := events[0]
	if event.Capability != unixPeerAuthCapability ||
		event.Operation != auditlog.OperationRead ||
		event.Outcome != auditlog.OutcomeRejected ||
		event.Reason != peerUnauthorizedReason ||
		event.ActorID != "peer:pid:3001" {
		t.Fatalf("unauthorized audit event = %#v, want peer_unauthorized transport rejection", event)
	}
}

func TestDesktopHostPeerScopeUsesPeerPrincipalKeysNotRequestBody(t *testing.T) {
	const forbiddenCapability = "test.forbidden"
	body := `{"operations":[{"capability":"test.forbidden","request":{"value":"spoof","capability":"capsule.execute"}}]}`

	t.Run("non desktop peer is not classified by request body", func(t *testing.T) {
		events := []string{}
		store := newAuditStore(t)
		handler := mustDesktopHostScopeHandler(t, desktopHostScopeHandlerConfig{
			auditStore: store,
			registry: mustRegistry(t, &spoofAwareTxCapability{
				name:   forbiddenCapability,
				events: &events,
			}),
			requestDecoders: map[string]RequestDecoder{
				forbiddenCapability: decodeSpoofAwareRequest,
			},
		})
		client, shutdown := serveDesktopHostScopeHandler(t, handler, store, nonDesktopPeerInfo)
		defer shutdown()

		status, responseBody := desktopHostRequest(t, client, http.MethodPost, "/apply", body)
		if status != http.StatusOK {
			t.Fatalf("status = %d, want %d; body=%s", status, http.StatusOK, responseBody)
		}
		if !reflect.DeepEqual(events, []string{"apply:spoof"}) {
			t.Fatalf("events = %v, want normal non-desktop apply path", events)
		}

		auditEvents, err := store.Read()
		if err != nil {
			t.Fatalf("audit Read returned error: %v", err)
		}
		if len(auditEvents) != 1 || auditEvents[0].Outcome != auditlog.OutcomeCommitted || auditEvents[0].Reason != "" {
			t.Fatalf("audit events = %#v, want one committed non-scope apply event", auditEvents)
		}
	})

	t.Run("desktop peer cannot bypass scope with request body", func(t *testing.T) {
		events := []string{}
		store := newAuditStore(t)
		handler := mustDesktopHostScopeHandler(t, desktopHostScopeHandlerConfig{
			auditStore: store,
			registry: mustRegistry(t, &spoofAwareTxCapability{
				name:   forbiddenCapability,
				events: &events,
			}),
			requestDecoders: map[string]RequestDecoder{
				forbiddenCapability: decodeSpoofAwareRequest,
			},
		})
		client, shutdown := serveDesktopHostScopeHandler(t, handler, store, desktopPeerInfo)
		defer shutdown()

		status, responseBody := desktopHostRequest(t, client, http.MethodPost, "/apply", body)
		if status != http.StatusForbidden {
			t.Fatalf("status = %d, want %d; body=%s", status, http.StatusForbidden, responseBody)
		}
		assertCapabilityForbidden(t, responseBody)
		if len(events) != 0 {
			t.Fatalf("events = %v, want body-named allowlisted capability not to bypass peer-key scope", events)
		}
		assertDesktopScopeAuditEvents(t, store, []auditlog.Operation{auditlog.OperationApply})
	})
}

func TestDesktopHostPeerGenericServiceRoleDoesNotIdentifyDesktopHost(t *testing.T) {
	const forbiddenCapability = "test.forbidden"
	events := []string{}
	store := newAuditStore(t)
	handler := mustDesktopHostScopeHandler(t, desktopHostScopeHandlerConfig{
		auditStore: store,
		registry: mustRegistry(t, &spoofAwareTxCapability{
			name:   forbiddenCapability,
			events: &events,
		}),
		requestDecoders: map[string]RequestDecoder{
			forbiddenCapability: decodeSpoofAwareRequest,
		},
		desktopHostPrincipalKeys: []string{},
		unixPeerRoles: []UnixPeerRoleBinding{
			{
				PrincipalKey: UnixPeerUserPrincipalKey(desktopHostPeerUID),
				Role:         identityroles.RoleService,
			},
		},
	})
	client, shutdown := serveDesktopHostScopeHandler(t, handler, store, desktopPeerInfo)
	defer shutdown()

	status, responseBody := desktopHostRequest(t, client, http.MethodPost, "/apply", `{"operations":[{"capability":"test.forbidden","request":{"value":"service","capability":"capsule.execute"}}]}`)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", status, http.StatusOK, responseBody)
	}
	if !reflect.DeepEqual(events, []string{"apply:service"}) {
		t.Fatalf("events = %v, want normal unscoped service-role apply path", events)
	}

	auditEvents, err := store.Read()
	if err != nil {
		t.Fatalf("audit Read returned error: %v", err)
	}
	if len(auditEvents) != 1 || auditEvents[0].Outcome != auditlog.OutcomeCommitted || auditEvents[0].Reason != "" {
		t.Fatalf("audit events = %#v, want one committed non-scope apply event", auditEvents)
	}
}

// TestDesktopHostPeerProductionInstallScopesViaHelper proves the production
// install path: DesktopHostUnixPeerInstall(uid) yields the principal key + service
// binding that, fed into the handler config, make the desktop-host scope INSTALLED
// (not zero-value/allow-all). The same install both SERVES an allowlisted
// capability and DENIES a non-allowlisted one for the pinned desktop-host peer.
func TestDesktopHostPeerProductionInstallScopesViaHelper(t *testing.T) {
	desktopPrincipalKeys, binding := DesktopHostUnixPeerInstall(desktopHostPeerUID)
	if want := UnixPeerUserPrincipalKey(desktopHostPeerUID); len(desktopPrincipalKeys) != 1 || desktopPrincipalKeys[0] != want {
		t.Fatalf("install principal keys = %v, want [%q]", desktopPrincipalKeys, want)
	}
	if binding.PrincipalKey != UnixPeerUserPrincipalKey(desktopHostPeerUID) || binding.Role != identityroles.RoleService {
		t.Fatalf("install binding = %#v, want pinned uid bound to service", binding)
	}

	t.Run("allowlisted capability served under the installed scope", func(t *testing.T) {
		events := []string{}
		store := newAuditStore(t)
		handler := mustDesktopHostScopeHandler(t, desktopHostScopeHandlerConfig{
			auditStore: store,
			registry: mustRegistry(t,
				&routedTxCapability{name: capsule.ExecuteName, events: &events},
			),
			desktopHostPrincipalKeys: desktopPrincipalKeys,
			unixPeerRoles:            []UnixPeerRoleBinding{binding},
		})
		client, shutdown := serveDesktopHostScopeHandler(t, handler, store, desktopPeerInfo)
		defer shutdown()

		capsuleBody := `{"operations":[{"capability":"capsule.execute","request":{"desired":{"id":"local.test.capsule","version":"1.0.0","integrity":"` + transportSHA256SRI + `"}}}]}`
		status, body := desktopHostRequest(t, client, http.MethodPost, "/apply", capsuleBody)
		if status != http.StatusOK {
			t.Fatalf("allowlisted apply status = %d, want %d; body=%s", status, http.StatusOK, body)
		}
		if !reflect.DeepEqual(events, []string{capsule.ExecuteName}) {
			t.Fatalf("events = %v, want allowlisted capsule.execute served", events)
		}
	})

	t.Run("non-allowlisted capability denied under the installed scope", func(t *testing.T) {
		events := []string{}
		store := newAuditStore(t)
		handler := mustDesktopHostScopeHandler(t, desktopHostScopeHandlerConfig{
			auditStore: store,
			registry: mustRegistry(t, &routedTxCapability{
				name:   identity.Name,
				events: &events,
				apply: func(capabilities.TypedRequest) error {
					t.Fatal("non-allowlisted apply reached registry under installed desktop scope")
					return nil
				},
			}),
			desktopHostPrincipalKeys: desktopPrincipalKeys,
			unixPeerRoles:            []UnixPeerRoleBinding{binding},
		})
		client, shutdown := serveDesktopHostScopeHandler(t, handler, store, desktopPeerInfo)
		defer shutdown()

		status, body := desktopHostRequest(t, client, http.MethodPost, "/apply", `{"operations":[{"capability":"identity.attestation","request":{"value":"must-not-decode"}}]}`)
		if status != http.StatusForbidden {
			t.Fatalf("non-allowlisted apply status = %d, want %d; body=%s", status, http.StatusForbidden, body)
		}
		assertCapabilityForbidden(t, body)
		if len(events) != 0 {
			t.Fatalf("events = %v, want no registry effect for denied non-allowlisted capability", events)
		}
		assertDesktopScopeAuditEvents(t, store, []auditlog.Operation{auditlog.OperationApply})
	})
}

type desktopHostScopeHandlerConfig struct {
	auditStore               AuditStore
	registry                 *capabilities.Registry
	requestDecoders          map[string]RequestDecoder
	filesStateRoot           string
	filesGrants              []filecap.Grant
	desktopHostPrincipalKeys []string
	unixPeerRoles            []UnixPeerRoleBinding
}

func mustDesktopHostScopeHandler(t *testing.T, config desktopHostScopeHandlerConfig) http.Handler {
	t.Helper()

	desktopHostPrincipalKeys := config.desktopHostPrincipalKeys
	if desktopHostPrincipalKeys == nil {
		desktopHostPrincipalKeys = []string{UnixPeerUserPrincipalKey(desktopHostPeerUID)}
	}
	unixPeerRoles := config.unixPeerRoles
	if unixPeerRoles == nil {
		unixPeerRoles = []UnixPeerRoleBinding{
			{
				PrincipalKey: UnixPeerUserPrincipalKey(desktopHostPeerUID),
				Role:         identityroles.RoleService,
			},
		}
	}

	handler, err := NewHandler(Config{
		Version:                  "test-version",
		StartedAt:                transportStartedAt,
		Registry:                 config.registry,
		RequestDecoders:          config.requestDecoders,
		FilesStateRoot:           config.filesStateRoot,
		FilesGrants:              config.filesGrants,
		UnixPeerRoles:            unixPeerRoles,
		DesktopHostPrincipalKeys: desktopHostPrincipalKeys,
		AuditStore:               config.auditStore,
		Now: func() time.Time {
			return transportStartedAt.Add(90 * time.Second)
		},
	})
	if err != nil {
		t.Fatalf("NewHandler returned error: %v", err)
	}
	return handler
}

func serveDesktopHostScopeHandler(t *testing.T, handler http.Handler, store AuditStore, peer func() unixPeerInfo) (*http.Client, func()) {
	t.Helper()

	listener := newDesktopHostPipeListener()
	authenticated, err := AuthenticateUnixSocketListener(listener, UnixPeerAuthConfig{
		GroupID:    ptrUint32(desktopHostPeerGID),
		AuditStore: store,
		Now: func() time.Time {
			return transportStartedAt
		},
		readPeerInfo: func(net.Conn) (unixPeerInfo, error) {
			return peer(), nil
		},
	})
	if err != nil {
		t.Fatalf("AuthenticateUnixSocketListener returned error: %v", err)
	}

	server, wait := serveHTTPOnListener(t, authenticated, handler)
	client := &http.Client{
		Transport: &http.Transport{
			DisableKeepAlives: true,
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return listener.DialContext(ctx)
			},
		},
	}

	return client, func() {
		client.CloseIdleConnections()
		shutdownHTTPServer(t, server, wait)
	}
}

func serveHTTPOnListener(t *testing.T, listener net.Listener, handler http.Handler) (*http.Server, <-chan error) {
	t.Helper()

	server := &http.Server{
		Handler:           handler,
		ConnContext:       UnixPeerConnContext,
		ReadHeaderTimeout: 5 * time.Second,
	}
	serveErr := make(chan error, 1)
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) && !errors.Is(err, net.ErrClosed) {
			serveErr <- err
			return
		}
		serveErr <- nil
	}()
	return server, serveErr
}

func shutdownHTTPServer(t *testing.T, server *http.Server, wait <-chan error) {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		t.Fatalf("server shutdown returned error: %v", err)
	}
	select {
	case err := <-wait:
		if err != nil {
			t.Fatalf("server.Serve returned error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("server.Serve did not return after shutdown")
	}
}

func desktopHostRequest(t *testing.T, client *http.Client, method string, path string, body string) (int, string) {
	t.Helper()

	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request, err := http.NewRequest(method, "http://agentd"+path, reader)
	if err != nil {
		t.Fatalf("NewRequest returned error: %v", err)
	}
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}

	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("%s %s returned error: %v", method, path, err)
	}
	defer response.Body.Close()

	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read response body: %v", err)
	}
	return response.StatusCode, string(raw)
}

func assertCapabilityForbidden(t *testing.T, body string) {
	t.Helper()

	var response ErrorResponse
	if err := json.Unmarshal([]byte(body), &response); err != nil {
		t.Fatalf("body is not error JSON: %v; body=%s", err, body)
	}
	if response.Error.Code != desktopHostScopeForbiddenCode {
		t.Fatalf("error code = %q, want %q; body=%s", response.Error.Code, desktopHostScopeForbiddenCode, body)
	}
	if response.Error.Message != desktopHostScopeForbiddenMessage {
		t.Fatalf("error message = %q, want %q", response.Error.Message, desktopHostScopeForbiddenMessage)
	}
}

func assertFilesWriteServedByHandler(t *testing.T, status int, body string, wantSize int64) {
	t.Helper()

	if status != http.StatusOK {
		t.Fatalf("files write status = %d, want %d; body=%s", status, http.StatusOK, body)
	}
	var response filecap.Response
	if err := json.Unmarshal([]byte(body), &response); err != nil {
		t.Fatalf("files write body is not JSON: %v; body=%s", err, body)
	}
	if response.Kind == nil || *response.Kind != filecap.KindFile {
		t.Fatalf("files write response kind = %#v, want %q", response.Kind, filecap.KindFile)
	}
	if response.Size == nil || *response.Size != wantSize {
		t.Fatalf("files write response size = %#v, want %d", response.Size, wantSize)
	}
}

func assertFilesReadServedByHandler(t *testing.T, status int, body string, want []byte) {
	t.Helper()

	if status != http.StatusOK {
		t.Fatalf("files read status = %d, want %d; body=%s", status, http.StatusOK, body)
	}
	var response filecap.Response
	if err := json.Unmarshal([]byte(body), &response); err != nil {
		t.Fatalf("files read body is not JSON: %v; body=%s", err, body)
	}
	if response.Data == nil {
		t.Fatalf("files read response = %#v, want data", response)
	}
	got, err := base64.StdEncoding.DecodeString(*response.Data)
	if err != nil {
		t.Fatalf("files read data is not base64: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("files read data = %q, want %q", got, want)
	}
}

func assertDesktopScopeAuditEvents(t *testing.T, store *auditlog.Store, operations []auditlog.Operation) {
	t.Helper()

	events, err := store.Read()
	if err != nil {
		t.Fatalf("audit Read returned error: %v", err)
	}
	if len(events) != len(operations) {
		t.Fatalf("audit events = %d, want %d: %#v", len(events), len(operations), events)
	}
	for i, event := range events {
		if event.Capability != unixPeerAuthCapability ||
			event.Operation != operations[i] ||
			event.Outcome != auditlog.OutcomeRejected ||
			event.Reason != desktopHostScopeForbiddenReason ||
			event.ActorID != "peer:pid:3520" {
			t.Fatalf("audit event %d = %#v, want desktop scope rejection", i, event)
		}
	}
}

func desktopPeerInfo() unixPeerInfo {
	return unixPeerInfo{
		Credentials: peerCredentials{PID: 3520, UID: desktopHostPeerUID, GID: 61000},
		Groups:      []uint32{61000, desktopHostPeerGID},
		GroupSource: "SO_PEERGROUPS",
	}
}

func nonDesktopPeerInfo() unixPeerInfo {
	return unixPeerInfo{
		Credentials: peerCredentials{PID: 3521, UID: 8001, GID: 61000},
		Groups:      []uint32{61000, desktopHostPeerGID},
		GroupSource: "SO_PEERGROUPS",
	}
}

func ptrUint32(value uint32) *uint32 {
	return &value
}

func newDesktopHostFilesStateRoot(t *testing.T) string {
	t.Helper()

	root, err := os.MkdirTemp(".", ".desktop-host-files-")
	if err != nil {
		t.Fatalf("MkdirTemp desktop files root: %v", err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(root); err != nil {
			t.Fatalf("RemoveAll desktop files root: %v", err)
		}
	})
	return root
}

type desktopHostPipeListener struct {
	conns chan net.Conn
	done  chan struct{}
	once  sync.Once
}

func newDesktopHostPipeListener() *desktopHostPipeListener {
	return &desktopHostPipeListener{
		conns: make(chan net.Conn),
		done:  make(chan struct{}),
	}
}

func (l *desktopHostPipeListener) Accept() (net.Conn, error) {
	select {
	case conn := <-l.conns:
		return conn, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}

func (l *desktopHostPipeListener) Close() error {
	l.once.Do(func() {
		close(l.done)
	})
	return nil
}

func (l *desktopHostPipeListener) Addr() net.Addr {
	return desktopHostPipeAddr("agentd")
}

func (l *desktopHostPipeListener) DialContext(ctx context.Context) (net.Conn, error) {
	server, client := net.Pipe()
	select {
	case l.conns <- server:
		return client, nil
	case <-ctx.Done():
		_ = server.Close()
		_ = client.Close()
		return nil, ctx.Err()
	case <-l.done:
		_ = server.Close()
		_ = client.Close()
		return nil, net.ErrClosed
	}
}

type desktopHostPipeAddr string

func (a desktopHostPipeAddr) Network() string { return "pipe" }

func (a desktopHostPipeAddr) String() string { return string(a) }

type spoofAwareRequest struct {
	Value      string `json:"value"`
	Capability string `json:"capability"`
}

func (spoofAwareRequest) CapabilityRequest() {}

func (r spoofAwareRequest) Validate() error {
	if r.Value == "" {
		return errors.New("value is required")
	}
	return nil
}

func decodeSpoofAwareRequest(raw json.RawMessage) (capabilities.TypedRequest, error) {
	return DecodeJSONRequest[spoofAwareRequest](raw)
}

type spoofAwareTxCapability struct {
	name   string
	events *[]string
}

func (c *spoofAwareTxCapability) Name() string {
	return c.name
}

func (c *spoofAwareTxCapability) Handle(context.Context, capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	return mockResponse{}, nil
}

func (c *spoofAwareTxCapability) Apply(_ context.Context, request capabilities.TypedRequest) (transaction.Undo, error) {
	typed, ok := request.(spoofAwareRequest)
	if !ok {
		return nil, fmt.Errorf("request = %T, want spoofAwareRequest", request)
	}
	if typed.Capability != capsule.ExecuteName {
		return nil, fmt.Errorf("body capability = %q, want %q", typed.Capability, capsule.ExecuteName)
	}
	if c.events != nil {
		*c.events = append(*c.events, "apply:"+typed.Value)
	}
	return noopUndo{}, nil
}
