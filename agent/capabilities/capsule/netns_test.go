package capsule

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestExecuteWithoutNetworkGrantDoesNotCreateNetns(t *testing.T) {
	ctx := context.Background()
	entry := executeEntry()
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	launcher := &recordingTransientLauncher{
		status: transientUnitStatus{DynamicUID: "61408"},
	}
	netns := &recordingNetnsManager{}
	capability := newExecuteCapabilityWithNetns(
		fs,
		memoryExecutionManifestStore{entry.ID: executeManifest(entry)},
		launcher,
		netns,
		nil,
	)

	undo, err := capability.Apply(ctx, executeApply(entry))
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo")
	}
	if len(netns.created) != 0 || len(netns.checked) != 0 {
		t.Fatalf("netns calls = create:%d check:%d, want none", len(netns.created), len(netns.checked))
	}
	if len(launcher.starts) != 1 {
		t.Fatalf("StartTransientUnit calls = %d, want 1", len(launcher.starts))
	}

	started := launcher.starts[0]
	if started.NetNS != nil {
		t.Fatalf("NetNS = %#v, want nil", started.NetNS)
	}
	props := propertyValues(started.Properties)
	assertProperty(t, props, "RestrictAddressFamilies", "AF_UNIX")
	assertNoProperty(t, props, "PrivateNetwork")
	assertNoProperty(t, props, "NetworkNamespacePath")
}

func TestCapsuleNetnsNameScrubsUnsafeUnitName(t *testing.T) {
	tests := []struct {
		name string
		unit string
		want string
	}{
		{name: "service suffix", unit: "vita-capsule-local.test-1234.service", want: "vita-capsule-local.test-1234"},
		{name: "unsafe runes", unit: "../bad unit;\n.service", want: "bad-unit"},
		{name: "empty after scrub", unit: ";;;;.service", want: "vita-capsule"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := capsuleNetnsName(tt.unit); got != tt.want {
				t.Fatalf("capsuleNetnsName(%q) = %q, want %q", tt.unit, got, tt.want)
			}
		})
	}
}

func TestValidateCapsuleNetnsRejectsUnsafeNamedPaths(t *testing.T) {
	valid := capsuleNetns{
		Name: "vita-capsule-test",
		Dir:  "/run/vita-agent/netns/vita-capsule-test",
		Path: "/run/vita-agent/netns/vita-capsule-test/netns",
	}
	if err := validateCapsuleNetns(valid); err != nil {
		t.Fatalf("validateCapsuleNetns(valid) returned error: %v", err)
	}

	tests := []struct {
		name  string
		netns capsuleNetns
	}{
		{
			name: "outside root",
			netns: capsuleNetns{
				Name: "vita-capsule-test",
				Dir:  "/tmp/vita-capsule-test",
				Path: "/tmp/vita-capsule-test/netns",
			},
		},
		{
			name: "wrong basename",
			netns: capsuleNetns{
				Name: "vita-capsule-test",
				Dir:  "/run/vita-agent/netns/vita-capsule-test",
				Path: "/run/vita-agent/netns/vita-capsule-test/not-netns",
			},
		},
		{
			name: "root dir",
			netns: capsuleNetns{
				Name: "vita-capsule-test",
				Dir:  "/run/vita-agent/netns",
				Path: "/run/vita-agent/netns/netns",
			},
		},
		{
			name: "path traversal",
			netns: capsuleNetns{
				Name: "vita-capsule-test",
				Dir:  "/run/vita-agent/netns/vita-capsule-test",
				Path: "/run/vita-agent/netns/vita-capsule-test/../other/netns",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := validateCapsuleNetns(tt.netns); err == nil {
				t.Fatal("validateCapsuleNetns accepted unsafe named netns")
			}
		})
	}
}

func TestValidateCapsulePrivateNetnsRejectsUnsafeProcPath(t *testing.T) {
	valid := capsuleNetns{
		Name:    "vita-capsule-test",
		Path:    "/proc/123/ns/net",
		Private: true,
	}
	if err := validateCapsuleNetns(valid); err != nil {
		t.Fatalf("validateCapsuleNetns(valid private) returned error: %v", err)
	}

	tests := []capsuleNetns{
		{Name: "vita-capsule-test", Path: "/proc/self/ns/net", Private: true},
		{Name: "vita-capsule-test", Path: "/proc/123/ns/user", Private: true},
		{Name: "vita-capsule-test", Path: "/run/vita-agent/netns/vita-capsule-test/netns", Private: true},
		{Name: "vita-capsule-test", Path: "/proc/123/../124/ns/net", Private: true},
		{Name: "vita-capsule-test", Dir: "/run/vita-agent/netns/vita-capsule-test", Private: true},
	}
	for _, netns := range tests {
		if err := validateCapsuleNetns(netns); err == nil {
			t.Fatalf("validateCapsuleNetns accepted unsafe private netns %#v", netns)
		}
	}
}

func TestDefaultCapsuleNetnsCreatePrivateIsNoop(t *testing.T) {
	manager := defaultCapsuleNetnsManager{}
	netns := capsuleNetns{
		Name:    "vita-capsule-test",
		Private: true,
	}

	created, err := manager.Create(context.Background(), netns)
	if err != nil {
		t.Fatalf("Create private netns returned error: %v", err)
	}
	if !reflect.DeepEqual(created, netns) {
		t.Fatalf("Create private netns = %#v, want %#v", created, netns)
	}
}

func TestDefaultCapsuleNetnsCheckRequiresOnlyLoopback(t *testing.T) {
	netns := capsuleNetns{
		Name:    "vita-capsule-test",
		Path:    "/proc/123/ns/net",
		Private: true,
	}

	check, err := (defaultCapsuleNetnsManager{
		interfaces: func() ([]net.Interface, error) {
			return []net.Interface{
				{Name: "lo", Flags: net.FlagUp | net.FlagLoopback},
			}, nil
		},
	}).Check(context.Background(), netns)
	if err != nil {
		t.Fatalf("Check only loopback returned error: %v", err)
	}
	if check.Status != capsuleNetnsMeasuredStatusOK || check.Isolation != capsuleNetnsIsolationEnforced {
		t.Fatalf("Check = %#v, want enforced OK", check)
	}

	check, err = (defaultCapsuleNetnsManager{
		interfaces: func() ([]net.Interface, error) {
			return []net.Interface{
				{Name: "lo", Flags: net.FlagUp | net.FlagLoopback},
				{Name: "eth0", Flags: net.FlagUp},
			}, nil
		},
	}).Check(context.Background(), netns)
	if err == nil {
		t.Fatal("Check accepted namespace with host interface")
	}
	if check.Status != capsuleNetnsMeasuredStatusFail || check.Isolation != "not_enforced" {
		t.Fatalf("Check = %#v, want not_enforced FAIL", check)
	}
	if reason := capsuleNetnsFailureReason(err); reason != "capsule_netns_failed:check_lo" {
		t.Fatalf("failure reason = %q, want capsule_netns_failed:check_lo", reason)
	}
}

func TestExecuteNetworkGrantTearsDownNetnsWhenStartFails(t *testing.T) {
	ctx := context.Background()
	entry := executeEntry()
	manifest := executeManifest(entry)
	manifest.Network = validExecutionNetwork()
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	launcher := &recordingTransientLauncher{
		err: errors.New("unit failed"),
	}
	netns := &recordingNetnsManager{}
	capability := newExecuteCapabilityWithNetns(
		fs,
		memoryExecutionManifestStore{entry.ID: manifest},
		launcher,
		netns,
		nil,
	)

	undo, err := capability.Apply(ctx, executeApply(entry))
	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil", undo)
	}
	var startErr *ExecuteStartError
	if !errors.As(err, &startErr) {
		t.Fatalf("Apply error = %T %v, want ExecuteStartError", err, err)
	}
	if len(netns.created) != 1 {
		t.Fatalf("created netns = %d, want 1", len(netns.created))
	}
	if len(netns.tornDown) != 1 || len(netns.created) != 1 || netns.tornDown[0].Name != netns.created[0].Name {
		t.Fatalf("tornDown = %#v, want teardown for created netns %#v", netns.tornDown, netns.created)
	}
}

func TestExecuteNetworkGrantStopsAndTearsDownWhenNetnsCheckFails(t *testing.T) {
	ctx := context.Background()
	entry := executeEntry()
	manifest := executeManifest(entry)
	manifest.Network = validExecutionNetwork()
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	launcher := &recordingTransientLauncher{
		status: transientUnitStatus{DynamicUID: "61408"},
	}
	netns := &recordingNetnsManager{
		check: &capsuleNetnsCheck{
			Interfaces: []string{"lo", "eth0"},
			Isolation:  "not_enforced",
			Status:     capsuleNetnsMeasuredStatusFail,
		},
	}
	capability := newExecuteCapabilityWithNetns(
		fs,
		memoryExecutionManifestStore{entry.ID: manifest},
		launcher,
		netns,
		nil,
	)

	undo, err := capability.Apply(ctx, executeApply(entry))
	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil", undo)
	}
	var startErr *ExecuteStartError
	if !errors.As(err, &startErr) {
		t.Fatalf("Apply error = %T %v, want ExecuteStartError", err, err)
	}
	if startErr.ApplyErrorCode() != "capsule_netns_failed:check_lo" {
		t.Fatalf("ApplyErrorCode = %q, want capsule_netns_failed:check_lo", startErr.ApplyErrorCode())
	}
	if !reflect.DeepEqual(launcher.stops, []string{capsuleUnitName(entry.ID)}) {
		t.Fatalf("stops = %v, want unit cleanup", launcher.stops)
	}
	if !reflect.DeepEqual(launcher.resets, []string{capsuleUnitName(entry.ID)}) {
		t.Fatalf("resets = %v, want unit cleanup", launcher.resets)
	}
	if len(netns.tornDown) != 1 || len(netns.created) != 1 || netns.tornDown[0].Name != netns.created[0].Name {
		t.Fatalf("tornDown = %#v, want teardown for created netns %#v", netns.tornDown, netns.created)
	}
}

func TestExecuteNetworkProofRefreshesReadStateFromMeasuredWorkload(t *testing.T) {
	ctx := context.Background()
	entry := executeEntry()
	manifest := executeManifest(entry)
	manifest.Network = validExecutionNetwork()
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	launcher := &recordingTransientLauncher{
		status: transientUnitStatus{DynamicUID: "61408"},
	}
	proofPath := filepath.Join(t.TempDir(), "netns-proof.json")
	netns := &recordingNetnsManager{
		check: &capsuleNetnsCheck{
			Interfaces: []string{"lo"},
			Isolation:  capsuleNetnsIsolationEnforced,
			Status:     capsuleNetnsMeasuredStatusOK,
		},
		proofPath: proofPath,
	}
	capability := newExecuteCapabilityWithNetns(
		fs,
		memoryExecutionManifestStore{entry.ID: manifest},
		launcher,
		netns,
		nil,
	)

	if _, err := capability.Apply(ctx, executeApply(entry)); err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if err := os.WriteFile(proofPath, []byte(`{"id":"local.test.capsule","loopback":"OK","external":"FAIL","status":"OK"}`), 0o600); err != nil {
		t.Fatalf("WriteFile proof returned error: %v", err)
	}

	response, err := capability.Handle(ctx, ExecuteReadRequest{})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	readResponse := response.(ExecuteReadResponse)
	if readResponse.Last == nil || readResponse.Last.Network == nil {
		t.Fatalf("Last.Network = %#v, want network status", readResponse.Last)
	}
	if readResponse.Last.Network.Loopback != capsuleNetnsLoopbackOK {
		t.Fatalf("Loopback = %q, want OK", readResponse.Last.Network.Loopback)
	}
	if readResponse.Last.Network.Isolation != capsuleNetnsIsolationEnforced {
		t.Fatalf("Isolation = %q, want enforced", readResponse.Last.Network.Isolation)
	}
}

func TestExecuteNetworkProofDoesNotSetLoopbackForIncompleteMeasurement(t *testing.T) {
	tests := []struct {
		name  string
		proof string
	}{
		{
			name:  "external reachable",
			proof: `{"id":"local.test.capsule","loopback":"OK","external":"REACHABLE","status":"OK"}`,
		},
		{
			name:  "workload status fail",
			proof: `{"id":"local.test.capsule","loopback":"OK","external":"FAIL","status":"FAIL"}`,
		},
		{
			name:  "mismatched id",
			proof: `{"id":"other.test.capsule","loopback":"OK","external":"FAIL","status":"OK"}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			entry := executeEntry()
			manifest := executeManifest(entry)
			manifest.Network = validExecutionNetwork()
			fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
			launcher := &recordingTransientLauncher{
				status: transientUnitStatus{DynamicUID: "61408"},
			}
			proofPath := filepath.Join(t.TempDir(), "netns-proof.json")
			netns := &recordingNetnsManager{
				check: &capsuleNetnsCheck{
					Interfaces: []string{"lo"},
					Isolation:  capsuleNetnsIsolationEnforced,
					Status:     capsuleNetnsMeasuredStatusOK,
				},
				proofPath: proofPath,
			}
			capability := newExecuteCapabilityWithNetns(
				fs,
				memoryExecutionManifestStore{entry.ID: manifest},
				launcher,
				netns,
				nil,
			)

			if _, err := capability.Apply(ctx, executeApply(entry)); err != nil {
				t.Fatalf("Apply returned error: %v", err)
			}
			if err := os.WriteFile(proofPath, []byte(tt.proof+"\n"), 0o600); err != nil {
				t.Fatalf("WriteFile proof returned error: %v", err)
			}

			response, err := capability.Handle(ctx, ExecuteReadRequest{})
			if err != nil {
				t.Fatalf("Handle returned error: %v", err)
			}
			readResponse := response.(ExecuteReadResponse)
			if readResponse.Last == nil || readResponse.Last.Network == nil {
				t.Fatalf("Last.Network = %#v, want network status", readResponse.Last)
			}
			if readResponse.Last.Network.Loopback != "" {
				t.Fatalf("Loopback = %q, want unset for unmeasured proof", readResponse.Last.Network.Loopback)
			}
			if readResponse.Last.Network.Isolation != capsuleNetnsIsolationEnforced {
				t.Fatalf("Isolation = %q, want agent-side isolation to remain enforced", readResponse.Last.Network.Isolation)
			}
		})
	}
}

func TestComposeOCIWithNetworkGrantUsesPrivateNetworkAndWidenedFamilies(t *testing.T) {
	manifest := executeOCIManifest(executeOCIEntry())
	manifest.Network = validExecutionNetwork()

	unit, err := composeOCITransientUnit(manifest)
	if err != nil {
		t.Fatalf("composeOCITransientUnit returned error: %v", err)
	}
	if unit.NetNS == nil || !unit.NetNS.Private {
		t.Fatalf("NetNS = %#v, want private netns descriptor", unit.NetNS)
	}

	props := propertyValues(unit.Properties)
	assertProperty(t, props, "RestrictAddressFamilies", "AF_UNIX AF_INET AF_INET6 AF_NETLINK")
	assertProperty(t, props, "PrivateNetwork", "yes")
	assertNoProperty(t, props, "NetworkNamespacePath")
	assertProperty(t, props, "DynamicUser", "yes")
	assertProperty(t, props, "CapabilityBoundingSet", "")
	assertProperty(t, props, "AmbientCapabilities", "")
	assertProperty(t, props, "NoNewPrivileges", "yes")
	assertProperty(t, props, "ProtectSystem", "strict")
	assertContainsProperty(t, props, "SystemCallFilter", "@system-service")
}

func TestComposeWasmWithNetworkGrantUsesPrivateNetworkAndWidenedFamilies(t *testing.T) {
	manifest := executeWasmManifest(executeWasmEntry())
	manifest.Network = validExecutionNetwork()

	unit, err := composeWasmTransientUnit(manifest)
	if err != nil {
		t.Fatalf("composeWasmTransientUnit returned error: %v", err)
	}
	if unit.NetNS == nil || !unit.NetNS.Private {
		t.Fatalf("NetNS = %#v, want private netns descriptor", unit.NetNS)
	}

	props := propertyValues(unit.Properties)
	assertProperty(t, props, "RestrictAddressFamilies", "AF_UNIX AF_INET AF_INET6 AF_NETLINK")
	assertProperty(t, props, "PrivateNetwork", "yes")
	assertNoProperty(t, props, "NetworkNamespacePath")
	assertProperty(t, props, "DynamicUser", "yes")
	assertProperty(t, props, "CapabilityBoundingSet", "")
	assertProperty(t, props, "AmbientCapabilities", "")
	assertProperty(t, props, "NoNewPrivileges", "yes")
	assertProperty(t, props, "ProtectSystem", "strict")
	assertContainsProperty(t, props, "SystemCallFilter", "@system-service")
}

type recordingNetnsManager struct {
	created  []capsuleNetns
	checked  []capsuleNetns
	tornDown []capsuleNetns

	check     *capsuleNetnsCheck
	createErr error
	checkErr  error
	tearErr   error
	proofPath string
}

func (m *recordingNetnsManager) Create(ctx context.Context, netns capsuleNetns) (capsuleNetns, error) {
	if err := ctx.Err(); err != nil {
		return capsuleNetns{}, err
	}
	if m.createErr != nil {
		return capsuleNetns{}, m.createErr
	}
	if m.proofPath != "" {
		netns.ProofPath = m.proofPath
	}
	m.created = append(m.created, netns)
	return netns, nil
}

func (m *recordingNetnsManager) Check(ctx context.Context, netns capsuleNetns) (capsuleNetnsCheck, error) {
	if err := ctx.Err(); err != nil {
		return capsuleNetnsCheck{}, err
	}
	m.checked = append(m.checked, netns)
	if m.checkErr != nil {
		return capsuleNetnsCheck{}, m.checkErr
	}
	if m.check == nil {
		return capsuleNetnsCheck{
			Interfaces: []string{"lo"},
			Isolation:  capsuleNetnsIsolationEnforced,
			Status:     capsuleNetnsMeasuredStatusOK,
		}, nil
	}
	return *m.check, nil
}

func (m *recordingNetnsManager) Teardown(ctx context.Context, netns capsuleNetns) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	m.tornDown = append(m.tornDown, netns)
	return m.tearErr
}
