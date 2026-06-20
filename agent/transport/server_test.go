package transport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
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
	"github.com/vita/agent/status"
	"github.com/vita/agent/transaction"
)

var (
	transportStartedAt = time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	errMockApply       = errors.New("mock apply failed")
)

func TestReadRoutesReturnExpectedJSON(t *testing.T) {
	registry := mustRegistry(t, &mockTxCapability{name: "test.apply"})
	discovered := hardware.Capabilities{
		CPU: hardware.CPUCapabilities{
			Arch:  "x86_64",
			Cores: 8,
			Model: "fixture cpu",
		},
		Memory: hardware.MemoryCapabilities{TotalMiB: 16_384},
		Storage: []hardware.StorageDevice{
			{Name: "nvme0n1", SizeMiB: 512_000, NVMe: true},
		},
		Networking: hardware.NetworkingCapabilities{
			Interfaces: []hardware.NetworkInterface{{Name: "lo", Kind: "loopback"}},
		},
		TPM:            hardware.TPMCapabilities{Present: true, Version: "2.0"},
		Virtualization: hardware.VirtualizationCapabilities{Hardware: true},
		Accelerators: []hardware.AcceleratorCapability{
			{Kind: hardware.AcceleratorCPU, Architecture: "x86_64"},
		},
	}
	handler := mustHandler(t, handlerConfig{
		registry:   registry,
		discoverer: stubDiscoverer{capabilities: discovered},
	})

	healthResponse := perform(handler, http.MethodGet, "/healthz", "")
	if healthResponse.Code != http.StatusOK {
		t.Fatalf("health status code = %d, want %d", healthResponse.Code, http.StatusOK)
	}
	if contentType := healthResponse.Header().Get("Content-Type"); contentType != "application/json" {
		t.Fatalf("health Content-Type = %q, want application/json", contentType)
	}
	for _, disallowed := range []string{"secret", "token", "password"} {
		if strings.Contains(strings.ToLower(healthResponse.Body.String()), disallowed) {
			t.Fatalf("health response contains disallowed %q: %s", disallowed, healthResponse.Body.String())
		}
	}

	var health status.Status
	decodeResponse(t, healthResponse, &health)
	if health.Version != "test-version" {
		t.Fatalf("health Version = %q, want test-version", health.Version)
	}
	if !health.StartedAt.Equal(transportStartedAt) {
		t.Fatalf("health StartedAt = %s, want %s", health.StartedAt, transportStartedAt)
	}
	if health.UptimeSeconds != 90 {
		t.Fatalf("health UptimeSeconds = %d, want 90", health.UptimeSeconds)
	}
	if !health.Healthy {
		t.Fatal("health Healthy = false, want true")
	}
	if !reflect.DeepEqual(health.Capabilities, []string{"test.apply"}) {
		t.Fatalf("health Capabilities = %v, want [test.apply]", health.Capabilities)
	}

	capabilitiesResponse := perform(handler, http.MethodGet, "/capabilities", "")
	if capabilitiesResponse.Code != http.StatusOK {
		t.Fatalf("capabilities status code = %d, want %d", capabilitiesResponse.Code, http.StatusOK)
	}
	var got hardware.Capabilities
	decodeResponse(t, capabilitiesResponse, &got)
	if !reflect.DeepEqual(got, discovered) {
		t.Fatalf("capabilities response = %#v, want %#v", got, discovered)
	}
}

func TestOperationsListsRegisteredNamesSorted(t *testing.T) {
	registry := mustRegistry(t,
		&mockTxCapability{name: backup.Name},
		&mockTxCapability{name: nodetime.Name},
		&mockTxCapability{name: network.Name},
		&mockTxCapability{name: identity.Name},
		&mockTxCapability{name: hostname.Name},
		&mockTxCapability{name: nodeconfig.Name},
		&mockTxCapability{name: pdssync.Name},
		&mockTxCapability{name: update.Name},
		&mockTxCapability{name: storage.Name},
	)
	handler := mustHandler(t, handlerConfig{registry: registry})

	response := perform(handler, http.MethodGet, "/operations", "")

	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	var got OperationsResponse
	decodeResponse(t, response, &got)
	want := []string{backup.Name, hostname.Name, identity.Name, network.Name, nodeconfig.Name, pdssync.Name, storage.Name, nodetime.Name, update.Name}
	if !reflect.DeepEqual(got.Operations, want) {
		t.Fatalf("operations = %v, want %v", got.Operations, want)
	}
}

func TestOperationsEmptyRegistryReturnsEmptyArray(t *testing.T) {
	handler := mustHandler(t, handlerConfig{registry: mustRegistry(t)})

	response := perform(handler, http.MethodGet, "/operations", "")

	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	var got OperationsResponse
	decodeResponse(t, response, &got)
	if got.Operations == nil {
		t.Fatalf("operations = nil, want empty array; body=%s", response.Body.String())
	}
	if len(got.Operations) != 0 {
		t.Fatalf("operations = %v, want empty", got.Operations)
	}
}

func TestApplyCommitsValidPlan(t *testing.T) {
	events := []string{}
	registry := mustRegistry(t, &mockTxCapability{name: "test.apply", events: &events})
	handler := mustHandler(t, handlerConfig{registry: registry})

	response := perform(handler, http.MethodPost, "/apply", `{"operations":[{"capability":"test.apply","request":{"value":"one"}}]}`)

	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	var result ApplyResult
	decodeResponse(t, response, &result)
	if result.Outcome != transaction.OutcomeCommitted {
		t.Fatalf("Outcome = %q, want %q", result.Outcome, transaction.OutcomeCommitted)
	}
	wantApplied := []OperationResult{{Index: 0, Capability: "test.apply"}}
	if !reflect.DeepEqual(result.Applied, wantApplied) {
		t.Fatalf("Applied = %v, want %v", result.Applied, wantApplied)
	}
	if len(result.RolledBack) != 0 {
		t.Fatalf("RolledBack = %v, want none", result.RolledBack)
	}
	if result.Error != nil {
		t.Fatalf("Error = %#v, want nil", result.Error)
	}
	if len(result.RollbackErrors) != 0 {
		t.Fatalf("RollbackErrors = %v, want none", result.RollbackErrors)
	}
	if !reflect.DeepEqual(events, []string{"apply:one"}) {
		t.Fatalf("events = %v, want [apply:one]", events)
	}
}

func TestRegisteredAgentCapabilitiesAreApplicable(t *testing.T) {
	events := []string{}
	desiredConfig := nodeconfig.Config{Mode: nodeconfig.ModeMaintenance, RemoteAccess: nodeconfig.RemoteAccessEnabled}
	desiredTime := time.Date(2026, 6, 20, 12, 1, 0, 0, time.UTC)
	desiredHostname := "vita-node-2"
	desiredIdentity := identity.Attestation{
		DID:    "did:plc:ewvi7nxzyoun6zhxrhs64oiz",
		Handle: "alice.example.com",
		SigningKeyRef: identity.SigningKeyRef{
			ID:     "key:identity-signing-primary",
			Handle: "identity-signing-primary",
		},
	}
	networkAllow := []network.Rule{
		{Proto: network.ProtoTCP, Port: 443, SourceCIDR: "10.0.0.0/8", Interface: "eth0"},
	}
	desiredNetwork := network.Policy{Allow: &networkAllow}
	storageQuotaSystem := int64(32)
	storageQuotaUser := int64(768)
	storageQuotaApp := int64(96)
	storageQuotaSnapshots := int64(384)
	storageQuotaBackup := int64(128)
	storageAppID := "local-search"
	storageSubvolumes := []storage.Subvolume{
		{Role: storage.RoleSystemState, Path: "/data/system-state", QuotaGiB: &storageQuotaSystem},
		{Role: storage.RoleUserData, Path: "/data/user-data", QuotaGiB: &storageQuotaUser},
		{Role: storage.RoleAppState, Path: "/data/app-state/local-search", AppID: &storageAppID, QuotaGiB: &storageQuotaApp},
		{Role: storage.RoleSnapshots, Path: "/data/snapshots", QuotaGiB: &storageQuotaSnapshots},
		{Role: storage.RoleLocalBackupCache, Path: "/data/local-backup-cache", QuotaGiB: &storageQuotaBackup},
	}
	desiredStorage := storage.Layout{Subvolumes: &storageSubvolumes}
	desiredUpdate := update.Plan{
		TargetSlot: update.SlotB,
		Bundle: update.BundleRef{
			Ref:       "https://updates.example.invalid/vita-os-1.3.0.raucb",
			Integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
			Version:   "1.3.0",
		},
	}
	backupRetentionCount := int64(7)
	backupRetentionMaxAgeDays := int64(30)
	backupSchedule := "0 2 * * *"
	backupKeyStoreRef := "keystore:local-tpm"
	desiredBackup := backup.Policy{
		Schedule: backup.Schedule{Cron: &backupSchedule},
		Targets: []backup.TargetRef{
			{ID: "target:system-state"},
			{ID: "target:user-data"},
		},
		Retention: backup.Retention{
			Count:      &backupRetentionCount,
			MaxAgeDays: &backupRetentionMaxAgeDays,
		},
		RecoveryKeyRef: backup.RecoveryKeyRef{
			ID:          "rk:owner-primary",
			Handle:      "rk_handle_owner_primary",
			KeyStoreRef: &backupKeyStoreRef,
		},
	}
	desiredPDSSync := pdssync.SyncState{
		Repo:     "did:plc:ewvi7nxzyoun6zhxrhs64oiz",
		Cursor:   42,
		RepoHead: "bafybeigdyrzt5sfp7udm7hu76ekfya5f45mcm6qzdv6woc4f3gj3sidfwy",
	}
	registry := mustRegistry(t,
		&routedTxCapability{
			name:   nodeconfig.Name,
			events: &events,
			apply: func(request capabilities.TypedRequest) error {
				typedRequest, ok := request.(nodeconfig.ApplyRequest)
				if !ok {
					return fmt.Errorf("nodeconfig request = %T, want nodeconfig.ApplyRequest", request)
				}
				if typedRequest.Desired != desiredConfig {
					return fmt.Errorf("nodeconfig desired = %#v, want %#v", typedRequest.Desired, desiredConfig)
				}
				return nil
			},
		},
		&routedTxCapability{
			name:   nodetime.Name,
			events: &events,
			apply: func(request capabilities.TypedRequest) error {
				typedRequest, ok := request.(nodetime.ApplyRequest)
				if !ok {
					return fmt.Errorf("time request = %T, want nodetime.ApplyRequest", request)
				}
				if !typedRequest.Desired.Equal(desiredTime) {
					return fmt.Errorf("time desired = %s, want %s", typedRequest.Desired, desiredTime)
				}
				return nil
			},
		},
		&routedTxCapability{
			name:   hostname.Name,
			events: &events,
			apply: func(request capabilities.TypedRequest) error {
				typedRequest, ok := request.(hostname.ApplyRequest)
				if !ok {
					return fmt.Errorf("hostname request = %T, want hostname.ApplyRequest", request)
				}
				if typedRequest.Desired != desiredHostname {
					return fmt.Errorf("hostname desired = %q, want %q", typedRequest.Desired, desiredHostname)
				}
				return nil
			},
		},
		&routedTxCapability{
			name:   identity.Name,
			events: &events,
			apply: func(request capabilities.TypedRequest) error {
				typedRequest, ok := request.(identity.ApplyRequest)
				if !ok {
					return fmt.Errorf("identity request = %T, want identity.ApplyRequest", request)
				}
				if typedRequest.Desired != desiredIdentity {
					return fmt.Errorf("identity desired = %#v, want %#v", typedRequest.Desired, desiredIdentity)
				}
				return nil
			},
		},
		&routedTxCapability{
			name:   network.Name,
			events: &events,
			apply: func(request capabilities.TypedRequest) error {
				typedRequest, ok := request.(network.ApplyRequest)
				if !ok {
					return fmt.Errorf("network request = %T, want network.ApplyRequest", request)
				}
				if typedRequest.Desired == nil {
					return errors.New("network desired = nil")
				}
				if !reflect.DeepEqual(*typedRequest.Desired, desiredNetwork) {
					return fmt.Errorf("network desired = %#v, want %#v", *typedRequest.Desired, desiredNetwork)
				}
				return nil
			},
		},
		&routedTxCapability{
			name:   storage.Name,
			events: &events,
			apply: func(request capabilities.TypedRequest) error {
				typedRequest, ok := request.(storage.ApplyRequest)
				if !ok {
					return fmt.Errorf("storage request = %T, want storage.ApplyRequest", request)
				}
				if typedRequest.Desired == nil {
					return errors.New("storage desired = nil")
				}
				if !reflect.DeepEqual(*typedRequest.Desired, desiredStorage) {
					return fmt.Errorf("storage desired = %#v, want %#v", *typedRequest.Desired, desiredStorage)
				}
				return nil
			},
		},
		&routedTxCapability{
			name:   update.Name,
			events: &events,
			apply: func(request capabilities.TypedRequest) error {
				typedRequest, ok := request.(update.ApplyRequest)
				if !ok {
					return fmt.Errorf("update request = %T, want update.ApplyRequest", request)
				}
				if typedRequest.Desired != desiredUpdate {
					return fmt.Errorf("update desired = %#v, want %#v", typedRequest.Desired, desiredUpdate)
				}
				return nil
			},
		},
		&routedTxCapability{
			name:   backup.Name,
			events: &events,
			apply: func(request capabilities.TypedRequest) error {
				typedRequest, ok := request.(backup.ApplyRequest)
				if !ok {
					return fmt.Errorf("backup request = %T, want backup.ApplyRequest", request)
				}
				if typedRequest.Desired == nil {
					return errors.New("backup desired = nil")
				}
				if !reflect.DeepEqual(*typedRequest.Desired, desiredBackup) {
					return fmt.Errorf("backup desired = %#v, want %#v", *typedRequest.Desired, desiredBackup)
				}
				return nil
			},
		},
		&routedTxCapability{
			name:   pdssync.Name,
			events: &events,
			apply: func(request capabilities.TypedRequest) error {
				typedRequest, ok := request.(pdssync.ApplyRequest)
				if !ok {
					return fmt.Errorf("pdssync request = %T, want pdssync.ApplyRequest", request)
				}
				if typedRequest.Desired == nil {
					return errors.New("pdssync desired = nil")
				}
				if *typedRequest.Desired != desiredPDSSync {
					return fmt.Errorf("pdssync desired = %#v, want %#v", *typedRequest.Desired, desiredPDSSync)
				}
				return nil
			},
		},
	)
	handler := mustHandler(t, handlerConfig{registry: registry})

	// GET /capabilities reports HARDWARE discovery (P1-005/P1-008), not registered operation
	// names. Registration is proven below: /apply routes a plan to all nine registered
	// capabilities and commits them in order.
	response := perform(handler, http.MethodPost, "/apply", `{"operations":[{"capability":"node.config","request":{"desired":{"mode":"maintenance","remoteAccess":"enabled"}}},{"capability":"time.set","request":{"desired":"2026-06-20T12:01:00Z"}},{"capability":"hostname.set","request":{"desired":"vita-node-2"}},{"capability":"identity.attestation","request":{"desired":{"did":"did:plc:ewvi7nxzyoun6zhxrhs64oiz","handle":"alice.example.com","signingKeyRef":{"id":"key:identity-signing-primary","handle":"identity-signing-primary"}}}},{"capability":"network.policy","request":{"desired":{"allow":[{"proto":"tcp","port":443,"sourceCidr":"10.0.0.0/8","interface":"eth0"}]}}},{"capability":"storage.layout","request":{"desired":{"subvolumes":[{"role":"system-state","path":"/data/system-state","quotaGiB":32},{"role":"user-data","path":"/data/user-data","quotaGiB":768},{"role":"app-state","path":"/data/app-state/local-search","appId":"local-search","quotaGiB":96},{"role":"snapshots","path":"/data/snapshots","quotaGiB":384},{"role":"local-backup-cache","path":"/data/local-backup-cache","quotaGiB":128}]}}},{"capability":"update.plan","request":{"desired":{"targetSlot":"b","bundle":{"ref":"https://updates.example.invalid/vita-os-1.3.0.raucb","integrity":"sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","version":"1.3.0"}}}},{"capability":"backup.policy","request":{"desired":{"schedule":{"cron":"0 2 * * *"},"targets":[{"id":"target:system-state"},{"id":"target:user-data"}],"retention":{"count":7,"maxAgeDays":30},"recoveryKeyRef":{"id":"rk:owner-primary","handle":"rk_handle_owner_primary","keyStoreRef":"keystore:local-tpm"}}}},{"capability":"pds.sync-state","request":{"desired":{"repo":"did:plc:ewvi7nxzyoun6zhxrhs64oiz","cursor":42,"repoHead":"bafybeigdyrzt5sfp7udm7hu76ekfya5f45mcm6qzdv6woc4f3gj3sidfwy"}}}]}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	var result ApplyResult
	decodeResponse(t, response, &result)
	if result.Outcome != transaction.OutcomeCommitted {
		t.Fatalf("Outcome = %q, want %q; error=%#v", result.Outcome, transaction.OutcomeCommitted, result.Error)
	}
	wantApplied := []OperationResult{
		{Index: 0, Capability: nodeconfig.Name},
		{Index: 1, Capability: nodetime.Name},
		{Index: 2, Capability: hostname.Name},
		{Index: 3, Capability: identity.Name},
		{Index: 4, Capability: network.Name},
		{Index: 5, Capability: storage.Name},
		{Index: 6, Capability: update.Name},
		{Index: 7, Capability: backup.Name},
		{Index: 8, Capability: pdssync.Name},
	}
	if !reflect.DeepEqual(result.Applied, wantApplied) {
		t.Fatalf("Applied = %v, want %v", result.Applied, wantApplied)
	}
	if result.Error != nil {
		t.Fatalf("Error = %#v, want nil", result.Error)
	}
	wantEvents := []string{nodeconfig.Name, nodetime.Name, hostname.Name, identity.Name, network.Name, storage.Name, update.Name, backup.Name, pdssync.Name}
	if !reflect.DeepEqual(events, wantEvents) {
		t.Fatalf("events = %v, want %v", events, wantEvents)
	}
}

func TestApplyRejectsRegisteredCapabilityWithoutDecoder(t *testing.T) {
	events := []string{}
	registry := mustRegistry(t, &mockTxCapability{name: "test.no-decoder", events: &events})
	handler := mustHandler(t, handlerConfig{registry: registry})

	response := perform(handler, http.MethodPost, "/apply", `{"operations":[{"capability":"test.no-decoder","request":{"value":"one"}}]}`)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusBadRequest, response.Body.String())
	}
	var errorResponse ErrorResponse
	decodeResponse(t, response, &errorResponse)
	if errorResponse.Error.Code != "unsupported_request_type" {
		t.Fatalf("error code = %q, want unsupported_request_type", errorResponse.Error.Code)
	}
	if !strings.Contains(errorResponse.Error.Message, "no registered request decoder") {
		t.Fatalf("error message = %q, want missing decoder detail", errorResponse.Error.Message)
	}
	if len(events) != 0 {
		t.Fatalf("events = %v, want no apply calls", events)
	}
}

func TestApplySurfacesRolledBackResult(t *testing.T) {
	events := []string{}
	registry := mustRegistry(t,
		&mockTxCapability{name: "test.first", events: &events},
		&mockTxCapability{name: "test.second", applyErr: errMockApply, events: &events},
	)
	handler := mustHandler(t, handlerConfig{registry: registry})

	response := perform(handler, http.MethodPost, "/apply", `{"operations":[{"capability":"test.first","request":{"value":"one"}},{"capability":"test.second","request":{"value":"two"}}]}`)

	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body.String())
	}
	var result ApplyResult
	decodeResponse(t, response, &result)
	if result.Outcome != transaction.OutcomeRolledBack {
		t.Fatalf("Outcome = %q, want %q", result.Outcome, transaction.OutcomeRolledBack)
	}
	if result.Error == nil {
		t.Fatal("Error = nil, want apply failure")
	}
	if result.Error.Code != "apply_failed" || result.Error.Capability != "test.second" || result.Error.Index == nil || *result.Error.Index != 1 {
		t.Fatalf("Error = %#v, want apply_failed for operation 1 test.second", result.Error)
	}
	wantRolledBack := []OperationResult{{Index: 0, Capability: "test.first"}}
	if !reflect.DeepEqual(result.RolledBack, wantRolledBack) {
		t.Fatalf("RolledBack = %v, want %v", result.RolledBack, wantRolledBack)
	}
	wantEvents := []string{"apply:one", "apply:two", "undo:one"}
	if !reflect.DeepEqual(events, wantEvents) {
		t.Fatalf("events = %v, want %v", events, wantEvents)
	}
}

func TestApplyFailClosedBodyHandlingAppliesNothing(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		maxBytes   int64
		wantStatus int
	}{
		{
			name:       "malformed JSON",
			body:       `{"operations":[`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "unknown top-level field",
			body:       `{"operations":[],"extra":true}`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "unknown request field",
			body:       `{"operations":[{"capability":"test.apply","request":{"value":"one","extra":true}}]}`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "oversized body",
			body:       `{"operations":[{"capability":"test.apply","request":{"value":"one"}}]}`,
			maxBytes:   16,
			wantStatus: http.StatusRequestEntityTooLarge,
		},
		{
			name:       "unknown capability",
			body:       `{"operations":[{"capability":"test.missing","request":{"value":"one"}}]}`,
			wantStatus: http.StatusBadRequest,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			events := []string{}
			registry := mustRegistry(t, &mockTxCapability{name: "test.apply", events: &events})
			handler := mustHandler(t, handlerConfig{registry: registry, maxBodyBytes: tt.maxBytes})

			defer func() {
				if recovered := recover(); recovered != nil {
					t.Fatalf("handler panicked: %v", recovered)
				}
			}()

			response := perform(handler, http.MethodPost, "/apply", tt.body)
			if response.Code != tt.wantStatus {
				t.Fatalf("status code = %d, want %d; body=%s", response.Code, tt.wantStatus, response.Body.String())
			}
			var errorResponse ErrorResponse
			decodeResponse(t, response, &errorResponse)
			if errorResponse.Error.Code == "" {
				t.Fatalf("error response missing typed code: %#v", errorResponse)
			}
			if len(events) != 0 {
				t.Fatalf("events = %v, want no apply calls", events)
			}
		})
	}
}

func TestApplyRejectsIncompleteNodeConfigBeforeTransaction(t *testing.T) {
	registry := mustRegistry(t, nodeconfig.NewCapability())
	handler := mustHandler(t, handlerConfig{registry: registry})

	response := perform(handler, http.MethodPost, "/apply", `{"operations":[{"capability":"node.config","request":{"desired":{"mode":"normal"}}}]}`)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusBadRequest, response.Body.String())
	}
	var errorResponse ErrorResponse
	decodeResponse(t, response, &errorResponse)
	if errorResponse.Error.Code != "invalid_request" {
		t.Fatalf("error code = %q, want invalid_request", errorResponse.Error.Code)
	}
	if !strings.Contains(errorResponse.Error.Message, "remoteAccess") {
		t.Fatalf("error message = %q, want remoteAccess validation", errorResponse.Error.Message)
	}
}

func TestApplyRejectsValidOpBeforeIncompleteOpWithoutApplying(t *testing.T) {
	events := []string{}
	registry := mustRegistry(t,
		&mockTxCapability{name: "test.apply", events: &events},
		nodeconfig.NewCapability(),
	)
	handler := mustHandler(t, handlerConfig{registry: registry})

	response := perform(handler, http.MethodPost, "/apply", `{"operations":[{"capability":"test.apply","request":{"value":"one"}},{"capability":"node.config","request":{"desired":{"mode":"normal"}}}]}`)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status code = %d, want %d; body=%s", response.Code, http.StatusBadRequest, response.Body.String())
	}
	if len(events) != 0 {
		t.Fatalf("events = %v, want no apply calls before incomplete op rejection", events)
	}
}

func TestMethodAndPathGuards(t *testing.T) {
	handler := mustHandler(t, handlerConfig{registry: mustRegistry(t, &mockTxCapability{name: "test.apply"})})
	tests := []struct {
		name        string
		method      string
		path        string
		wantStatus  int
		wantAllowed string
	}{
		{name: "health rejects non GET", method: http.MethodPost, path: "/healthz", wantStatus: http.StatusMethodNotAllowed, wantAllowed: http.MethodGet},
		{name: "capabilities rejects non GET", method: http.MethodPost, path: "/capabilities", wantStatus: http.StatusMethodNotAllowed, wantAllowed: http.MethodGet},
		{name: "operations rejects non GET", method: http.MethodPost, path: "/operations", wantStatus: http.StatusMethodNotAllowed, wantAllowed: http.MethodGet},
		{name: "apply rejects non POST", method: http.MethodGet, path: "/apply", wantStatus: http.StatusMethodNotAllowed, wantAllowed: http.MethodPost},
		{name: "unknown path", method: http.MethodGet, path: "/missing", wantStatus: http.StatusNotFound},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			response := perform(handler, tt.method, tt.path, "")
			if response.Code != tt.wantStatus {
				t.Fatalf("status code = %d, want %d; body=%s", response.Code, tt.wantStatus, response.Body.String())
			}
			if tt.wantAllowed != "" && response.Header().Get("Allow") != tt.wantAllowed {
				t.Fatalf("Allow = %q, want %q", response.Header().Get("Allow"), tt.wantAllowed)
			}
		})
	}
}

func TestLoopbackTCPAddrGuard(t *testing.T) {
	if !IsLoopbackTCPAddr("127.0.0.1:8786") {
		t.Fatal("127.0.0.1:8786 was not accepted as loopback")
	}
	if !IsLoopbackTCPAddr("[::1]:8786") {
		t.Fatal("[::1]:8786 was not accepted as loopback")
	}
	for _, addr := range []string{":8786", "0.0.0.0:8786", "192.0.2.10:8786", "localhost:8786", "not-a-socket"} {
		if IsLoopbackTCPAddr(addr) {
			t.Fatalf("%q was accepted, want rejected", addr)
		}
	}
}

type handlerConfig struct {
	registry     *capabilities.Registry
	discoverer   hardware.Discoverer
	maxBodyBytes int64
}

func mustHandler(t *testing.T, config handlerConfig) http.Handler {
	t.Helper()

	discoverer := config.discoverer
	if discoverer == nil {
		discoverer = stubDiscoverer{capabilities: hardware.Capabilities{
			CPU: hardware.CPUCapabilities{Arch: "x86_64", Cores: 1, Model: "fixture"},
			Accelerators: []hardware.AcceleratorCapability{
				{Kind: hardware.AcceleratorCPU, Architecture: "x86_64"},
			},
		}}
	}

	handler, err := NewHandler(Config{
		Version:         "test-version",
		StartedAt:       transportStartedAt,
		Registry:        config.registry,
		Discoverer:      discoverer,
		RequestDecoders: map[string]RequestDecoder{"test.apply": decodeMockRequest, "test.first": decodeMockRequest, "test.second": decodeMockRequest},
		MaxBodyBytes:    config.maxBodyBytes,
		Now: func() time.Time {
			return transportStartedAt.Add(90 * time.Second)
		},
	})
	if err != nil {
		t.Fatalf("NewHandler returned error: %v", err)
	}
	return handler
}

func perform(handler http.Handler, method string, path string, body string) *httptest.ResponseRecorder {
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}

	request := httptest.NewRequest(method, path, reader)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func decodeResponse(t *testing.T, response *httptest.ResponseRecorder, target interface{}) {
	t.Helper()

	if err := json.Unmarshal(response.Body.Bytes(), target); err != nil {
		t.Fatalf("response body is not expected JSON: %v; body=%s", err, response.Body.String())
	}
}

type stubDiscoverer struct {
	capabilities hardware.Capabilities
	err          error
}

func (d stubDiscoverer) Discover(context.Context) (hardware.Capabilities, error) {
	if d.err != nil {
		return hardware.Capabilities{}, d.err
	}
	return d.capabilities, nil
}

type mockRequest struct {
	Value string `json:"value"`
}

func (mockRequest) CapabilityRequest() {}

func (r mockRequest) Validate() error {
	if r.Value == "" {
		return errors.New("value is required")
	}
	return nil
}

func decodeMockRequest(raw json.RawMessage) (capabilities.TypedRequest, error) {
	return DecodeJSONRequest[mockRequest](raw)
}

type mockResponse struct{}

func (mockResponse) CapabilityResponse() {}

type mockTxCapability struct {
	name     string
	applyErr error
	events   *[]string
}

func (c *mockTxCapability) Name() string {
	return c.name
}

func (c *mockTxCapability) Handle(context.Context, capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	return mockResponse{}, nil
}

func (c *mockTxCapability) Apply(_ context.Context, request capabilities.TypedRequest) (transaction.Undo, error) {
	typedRequest, ok := request.(mockRequest)
	if !ok {
		return nil, errors.New("unexpected mock request")
	}
	if c.events != nil {
		*c.events = append(*c.events, "apply:"+typedRequest.Value)
	}
	if c.applyErr != nil {
		return nil, c.applyErr
	}
	return mockUndo{value: typedRequest.Value, events: c.events}, nil
}

type routedTxCapability struct {
	name   string
	apply  func(capabilities.TypedRequest) error
	events *[]string
}

func (c *routedTxCapability) Name() string {
	return c.name
}

func (c *routedTxCapability) Handle(context.Context, capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	return mockResponse{}, nil
}

func (c *routedTxCapability) Apply(_ context.Context, request capabilities.TypedRequest) (transaction.Undo, error) {
	if c.apply != nil {
		if err := c.apply(request); err != nil {
			return nil, err
		}
	}
	if c.events != nil {
		*c.events = append(*c.events, c.name)
	}
	return noopUndo{}, nil
}

type noopUndo struct{}

func (noopUndo) Undo(context.Context) error {
	return nil
}

type mockUndo struct {
	value  string
	events *[]string
}

func (u mockUndo) Undo(context.Context) error {
	if u.events != nil {
		*u.events = append(*u.events, "undo:"+u.value)
	}
	return nil
}

func mustRegistry(t *testing.T, registered ...capabilities.Capability) *capabilities.Registry {
	t.Helper()

	registry, err := capabilities.NewRegistry(registered...)
	if err != nil {
		t.Fatalf("NewRegistry returned error: %v", err)
	}
	return registry
}
