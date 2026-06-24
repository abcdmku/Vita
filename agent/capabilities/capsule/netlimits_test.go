package capsule

import (
	"context"
	"errors"
	"fmt"
	"net"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestCapsuleNetLimitsConfirmRequiresStrictAgentEvidence(t *testing.T) {
	manifest := hostileNetManifest()
	unit, err := composeTypeScriptTransientUnit(manifest)
	if err != nil {
		t.Fatalf("composeTypeScriptTransientUnit returned error: %v", err)
	}
	check := capsuleNetLimitsCheckForUnit(t, unit)

	status, err := confirmCapsuleNetLimits(context.Background(), manifest, unit, &check)
	if err != nil {
		t.Fatalf("confirmCapsuleNetLimits returned error: %v", err)
	}
	if status != enforcedCapsuleNetLimitsStatus() {
		t.Fatalf("status = %#v, want enforced OK", status)
	}

	tests := []struct {
		name   string
		mutate func(transientUnit, capsuleNetnsCheck) (transientUnit, capsuleNetnsCheck)
	}{
		{
			name: "egress policy accept",
			mutate: func(unit transientUnit, check capsuleNetnsCheck) (transientUnit, capsuleNetnsCheck) {
				check.Egress.Table = strings.Replace(check.Egress.Table, "policy drop", "policy accept", 1)
				return unit, check
			},
		},
		{
			name: "extra non-granted egress accept",
			mutate: func(unit transientUnit, check capsuleNetnsCheck) (transientUnit, capsuleNetnsCheck) {
				check.Egress.Table = strings.Replace(
					check.Egress.Table,
					"  }\n}\n",
					"    ip daddr 198.51.100.254/32 tcp dport 443 accept\n  }\n}\n",
					1,
				)
				return unit, check
			},
		},
		{
			name: "superstring non-granted egress accept",
			mutate: func(unit transientUnit, check capsuleNetnsCheck) (transientUnit, capsuleNetnsCheck) {
				check.Egress.Table = strings.Replace(
					check.Egress.Table,
					"  }\n}\n",
					"    ip daddr 203.0.113.100/32 tcp dport 443 accept\n  }\n}\n",
					1,
				)
				return unit, check
			},
		},
		{
			name: "extra host dnat",
			mutate: func(unit transientUnit, check capsuleNetnsCheck) (transientUnit, capsuleNetnsCheck) {
				ingress := unit.NetNS.Egress.Ingress
				check.Egress.HostTable = strings.Replace(
					check.Egress.HostTable,
					"  }\n}\n",
					"    ip daddr "+ingress.HostAddr+" tcp dport "+strconv.Itoa(ingress.ProbeDeniedPort)+" dnat to "+ingress.CapsuleAddr+":"+strconv.Itoa(ingress.ProbeDeniedPort)+"\n  }\n}\n",
					1,
				)
				return unit, check
			},
		},
		{
			name: "host interface visible",
			mutate: func(unit transientUnit, check capsuleNetnsCheck) (transientUnit, capsuleNetnsCheck) {
				check.Interfaces = append(check.Interfaces, "eth0")
				return unit, check
			},
		},
		{
			name: "raw capability present",
			mutate: func(unit transientUnit, check capsuleNetnsCheck) (transientUnit, capsuleNetnsCheck) {
				for i := range unit.Properties {
					if unit.Properties[i].Name == "CapabilityBoundingSet" {
						unit.Properties[i].Value = "CAP_NET_RAW"
					}
				}
				return unit, check
			},
		},
		{
			name: "privileged raw syscall filter allow list",
			mutate: func(unit transientUnit, check capsuleNetnsCheck) (transientUnit, capsuleNetnsCheck) {
				for i := range unit.Properties {
					if unit.Properties[i].Name == "SystemCallFilter" && strings.HasPrefix(unit.Properties[i].Value, "~") {
						unit.Properties[i].Value = "@privileged @raw-io"
					}
				}
				return unit, check
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mutatedUnit, mutatedCheck := tt.mutate(cloneTransientUnit(unit), cloneCapsuleNetnsCheck(check))
			status, err := confirmCapsuleNetLimits(context.Background(), manifest, mutatedUnit, &mutatedCheck)
			if err == nil {
				t.Fatal("confirmCapsuleNetLimits accepted weakened evidence")
			}
			if status.Status != capsuleNetLimitStatusFail {
				t.Fatalf("status = %#v, want FAIL", status)
			}
		})
	}
}

func TestExecuteConfirmsHostileNetLimitsAndExposesStatus(t *testing.T) {
	ctx := context.Background()
	entry := hostileNetEntry()
	manifest := hostileNetManifest()
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	launcher := &recordingTransientLauncher{
		status: transientUnitStatus{DynamicUID: "61411"},
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
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo")
	}
	if len(netns.created) != 1 || len(netns.checked) != 1 {
		t.Fatalf("netns calls = create:%d check:%d, want one each", len(netns.created), len(netns.checked))
	}
	if netns.checked[0].Path != netns.created[0].Path {
		t.Fatalf("checked netns path = %q, want managed path %q", netns.checked[0].Path, netns.created[0].Path)
	}
	if strings.HasPrefix(netns.checked[0].Path, "/proc/") {
		t.Fatalf("checked netns path = %q, want managed grant-backed namespace path", netns.checked[0].Path)
	}

	response, err := capability.Handle(ctx, ExecuteReadRequest{})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	readResponse := response.(ExecuteReadResponse)
	if readResponse.Last == nil || readResponse.Last.NetLimits == nil {
		t.Fatalf("Last = %#v, want net limit status", readResponse.Last)
	}
	if *readResponse.Last.NetLimits != enforcedCapsuleNetLimitsStatus() {
		t.Fatalf("Last.NetLimits = %#v, want enforced OK", *readResponse.Last.NetLimits)
	}
}

func TestExecuteStopsHostileNetCapsuleWhenLimitsAreNotEnforced(t *testing.T) {
	ctx := context.Background()
	entry := hostileNetEntry()
	manifest := hostileNetManifest()
	unit, err := composeTypeScriptTransientUnit(manifest)
	if err != nil {
		t.Fatalf("composeTypeScriptTransientUnit returned error: %v", err)
	}
	check := capsuleNetLimitsCheckForUnit(t, unit)
	check.Egress.Table = strings.Replace(check.Egress.Table, "policy drop", "policy accept", 1)

	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	launcher := &recordingTransientLauncher{
		status: transientUnitStatus{DynamicUID: "61411"},
	}
	netns := &recordingNetnsManager{check: &check}
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
	if startErr.ApplyErrorCode() != "capsule_net_limits_failed:egress_confirm" {
		t.Fatalf("ApplyErrorCode = %q, want capsule_net_limits_failed:egress_confirm", startErr.ApplyErrorCode())
	}
	wantUnit := capsuleUnitName(entry.ID)
	if !reflect.DeepEqual(launcher.stops, []string{wantUnit}) {
		t.Fatalf("stops = %v, want [%s]", launcher.stops, wantUnit)
	}
	if !reflect.DeepEqual(launcher.resets, []string{wantUnit}) {
		t.Fatalf("resets = %v, want [%s]", launcher.resets, wantUnit)
	}
	if len(netns.tornDown) != 1 {
		t.Fatalf("tornDown = %#v, want created netns cleanup", netns.tornDown)
	}
}

func TestExecuteReportsSpecificHostileNetCapsuleFailureReasons(t *testing.T) {
	for _, tt := range []struct {
		name     string
		launcher *recordingTransientLauncher
		netns    *recordingNetnsManager
		want     string
	}{
		{
			name: "create errno",
			launcher: &recordingTransientLauncher{
				status: transientUnitStatus{DynamicUID: "61411"},
			},
			netns: &recordingNetnsManager{
				createErr: capsuleNetnsStepError("egress_veth_create", syscall.EPERM),
			},
			want: "capsule_net_limits_failed:egress_veth_create_EPERM",
		},
		{
			name: "hostile launch",
			launcher: &recordingTransientLauncher{
				err: errors.New("deno exited before proof"),
			},
			netns: &recordingNetnsManager{},
			want:  "capsule_net_limits_failed:hostile_launch",
		},
		{
			name: "check errno",
			launcher: &recordingTransientLauncher{
				status: transientUnitStatus{DynamicUID: "61411"},
			},
			netns: &recordingNetnsManager{
				checkErr: capsuleNetnsStepError("egress_nft_check", syscall.EPERM),
			},
			want: "capsule_net_limits_failed:egress_nft_check_EPERM",
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			entry := hostileNetEntry()
			manifest := hostileNetManifest()
			fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
			capability := newExecuteCapabilityWithNetns(
				fs,
				memoryExecutionManifestStore{entry.ID: manifest},
				tt.launcher,
				tt.netns,
				nil,
			)

			undo, err := capability.Apply(context.Background(), executeApply(entry))
			if undo != nil {
				t.Fatalf("Apply returned undo %v, want nil", undo)
			}
			var startErr *ExecuteStartError
			if !errors.As(err, &startErr) {
				t.Fatalf("Apply error = %T %v, want ExecuteStartError", err, err)
			}
			if startErr.ApplyErrorCode() != tt.want {
				t.Fatalf("ApplyErrorCode = %q, want %q", startErr.ApplyErrorCode(), tt.want)
			}
		})
	}
}

func TestCapsuleNetLimitsRealNetnsHostileProbesSkipWithoutPrivileges(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("real netns net-limits test requires Linux")
	}

	unitName := capsuleUnitName(fmt.Sprintf("local.netlimits.%d", time.Now().UnixNano()))
	policy := validExecutionNetwork()
	netns, err := capsuleNetnsForNetwork(unitName, "", policy)
	if err != nil {
		t.Fatalf("capsuleNetnsForNetwork returned error: %v", err)
	}
	manager := defaultCapsuleNetnsManager{}
	created, err := manager.Create(context.Background(), netns)
	if err != nil {
		if ingressRealOpUnavailable(err) {
			t.Skipf("real net-limits unavailable: %v", err)
		}
		t.Fatalf("Create returned error: %v", err)
	}
	defer func() {
		if err := manager.Teardown(context.Background(), created); err != nil {
			t.Fatalf("Teardown returned error: %v", err)
		}
	}()

	ingress := created.Egress.Ingress
	listeners := make([]net.Listener, 0, 2)
	if err := withCapsuleNetns(created.Path, func() error {
		for _, port := range []int{ingress.ProbePort, ingress.ProbeDeniedPort} {
			listener, listenErr := net.Listen("tcp4", net.JoinHostPort(ingress.CapsuleAddr, strconv.Itoa(port)))
			if listenErr != nil {
				for _, opened := range listeners {
					_ = opened.Close()
				}
				return listenErr
			}
			listeners = append(listeners, listener)
			go acceptAndClose(listener)
		}
		return nil
	}); err != nil {
		t.Fatalf("listen inside capsule netns returned error: %v", err)
	}
	defer func() {
		for _, listener := range listeners {
			_ = listener.Close()
		}
	}()

	check, err := manager.Check(context.Background(), created)
	if err != nil {
		t.Fatalf("Check returned error: %v", err)
	}
	if check.Egress == nil || check.Egress.Table == "" || check.Egress.HostTable == "" {
		t.Fatalf("Check.Egress = %#v, want nft table evidence", check.Egress)
	}
	unit := transientUnit{
		Name:       unitName,
		Properties: hardenedTransientUnitProperties(ExecutionManifest{ID: "local.netlimits.capsule", Network: policy}, true),
		NetNS:      &created,
	}
	status, err := confirmCapsuleNetLimits(context.Background(), ExecutionManifest{ID: hostileNetCapsuleID, Network: policy}, unit, &check)
	if err != nil {
		t.Fatalf("confirmCapsuleNetLimits returned error: %v", err)
	}
	if status != enforcedCapsuleNetLimitsStatus() {
		t.Fatalf("status = %#v, want enforced OK", status)
	}

	if !dialFromNetns(t, created.Path, created.Egress.ProbeAllowedAddr, created.Egress.ProbeAllowedPort, 2*time.Second) {
		t.Fatalf("capsule netns could not reach granted egress %s:%d", created.Egress.ProbeAllowedAddr, created.Egress.ProbeAllowedPort)
	}
	if dialFromNetns(t, created.Path, created.Egress.ProbeDeniedAddr, created.Egress.ProbeAllowedPort, 500*time.Millisecond) {
		t.Fatalf("capsule netns reached non-granted egress %s:%d", created.Egress.ProbeDeniedAddr, created.Egress.ProbeAllowedPort)
	}
	if !eventuallyDialTCP(ingress.HostAddr, ingress.ProbePort, 2*time.Second) {
		t.Fatalf("host could not reach granted ingress %s:%d", ingress.HostAddr, ingress.ProbePort)
	}
	if eventuallyDialTCP(ingress.HostAddr, ingress.ProbeDeniedPort, 500*time.Millisecond) {
		t.Fatalf("host reached non-granted ingress %s:%d", ingress.HostAddr, ingress.ProbeDeniedPort)
	}

	for i := 0; i < 16; i++ {
		_ = dialFromNetns(t, created.Path, created.Egress.ProbeDeniedAddr, created.Egress.ProbeAllowedPort, 100*time.Millisecond)
	}
	if !eventuallyDialTCP(ingress.HostAddr, ingress.ProbePort, 2*time.Second) {
		t.Fatalf("granted ingress degraded after denied burst")
	}
}

func hostileNetEntry() CapsuleEntry {
	return CapsuleEntry{
		ID:        hostileNetCapsuleID,
		Version:   "1.0.0",
		Integrity: validSHA256SRI,
		State:     StateInstalled,
	}
}

func hostileNetManifest() ExecutionManifest {
	entry := hostileNetEntry()
	manifest := executeManifest(entry)
	manifest.Network = validExecutionNetwork()
	manifest.baseDir = "/usr/lib/vita/capsules/" + hostileNetCapsuleID
	return manifest
}

func capsuleNetLimitsCheckForUnit(t *testing.T, unit transientUnit) capsuleNetnsCheck {
	t.Helper()
	if unit.NetNS == nil || unit.NetNS.Egress == nil || unit.NetNS.Egress.Ingress == nil {
		t.Fatalf("unit.NetNS = %#v, want network grants", unit.NetNS)
	}
	ingress := unit.NetNS.Egress.Ingress
	ingressCheck := &capsuleIngressCheck{
		HostAddr:   ingress.HostAddr,
		Port:       ingress.ProbePort,
		DeniedPort: ingress.ProbeDeniedPort,
		Drop:       capsuleIngressDropEnforced,
		Status:     capsuleIngressStatusOK,
	}
	egressCheck := &capsuleEgressCheck{
		AllowedCIDR: unit.NetNS.Egress.ProbeAllowedCIDR,
		DeniedCIDR:  unit.NetNS.Egress.ProbeDeniedCIDR,
		Drop:        capsuleEgressDropEnforced,
		Status:      capsuleEgressStatusOK,
		Ingress:     ingressCheck,
		Table:       string(renderCapsuleEgressRuleset(*unit.NetNS.Egress)),
		HostTable:   string(renderCapsuleIngressHostRuleset(*ingress)),
	}
	return capsuleNetnsCheck{
		Interfaces: []string{"lo", unit.NetNS.Egress.CapsuleInterface},
		Isolation:  capsuleNetnsIsolationEnforced,
		Status:     capsuleNetnsMeasuredStatusOK,
		Egress:     egressCheck,
		Ingress:    ingressCheck,
	}
}

func cloneCapsuleNetnsCheck(check capsuleNetnsCheck) capsuleNetnsCheck {
	out := check
	out.Interfaces = append([]string(nil), check.Interfaces...)
	if check.Egress != nil {
		egress := *check.Egress
		out.Egress = &egress
	}
	if check.Ingress != nil {
		ingress := *check.Ingress
		out.Ingress = &ingress
		if out.Egress != nil && out.Egress.Ingress == check.Ingress {
			out.Egress.Ingress = &ingress
		}
	}
	return out
}

func enforcedCapsuleNetLimitsStatus() CapsuleNetLimitsStatus {
	return CapsuleNetLimitsStatus{
		Egress:    capsuleNetLimitValueEnforced,
		Ingress:   capsuleNetLimitValueEnforced,
		Isolation: capsuleNetLimitValueEnforced,
		Status:    capsuleNetLimitStatusOK,
	}
}

func acceptAndClose(listener net.Listener) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		_ = conn.Close()
	}
}

func dialFromNetns(t *testing.T, netnsPath string, host string, port int, timeout time.Duration) bool {
	t.Helper()
	var reached bool
	err := withCapsuleNetns(netnsPath, func() error {
		reached = eventuallyDialTCP(host, port, timeout)
		return nil
	})
	if err != nil {
		t.Fatalf("dial in capsule netns returned error: %v", err)
	}
	return reached
}
