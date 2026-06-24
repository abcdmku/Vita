package capsule

import (
	"context"
	"fmt"
	"net"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/vita/agent/capabilities/network"
)

func TestCapsuleIngressConfigUsesValidatedManifestGrants(t *testing.T) {
	unitName := capsuleUnitName(executeEntry().ID)
	config, err := capsuleIngressConfigForUnit(unitName, validExecutionNetwork())
	if err != nil {
		t.Fatalf("capsuleIngressConfigForUnit returned error: %v", err)
	}
	if config == nil {
		t.Fatal("capsuleIngressConfigForUnit returned nil config")
	}
	if config.HostInterface == "" || config.CapsuleInterface == "" || config.HostNatTable == "" {
		t.Fatalf("ingress names = host:%q capsule:%q nat:%q, want generated names", config.HostInterface, config.CapsuleInterface, config.HostNatTable)
	}
	if config.HostInterface == config.CapsuleInterface {
		t.Fatalf("host and capsule interface names both %q", config.HostInterface)
	}
	if config.ProbePort != 8787 || config.ProbeDeniedPort == 0 || config.ProbeDeniedPort == config.ProbePort {
		t.Fatalf("probe ports = granted:%d denied:%d, want granted 8787 and different denied port", config.ProbePort, config.ProbeDeniedPort)
	}
	wantGrant := capsuleIngressGrant{
		Protocol: network.ProtoTCP,
		Port:     8787,
	}
	if len(config.Grants) == 0 || config.Grants[0] != wantGrant {
		t.Fatalf("Grants = %#v, want first manifest grant %#v", config.Grants, wantGrant)
	}
}

func TestCapsuleIngressHostRulesetIsHostLocalDNATOnly(t *testing.T) {
	config, err := capsuleIngressConfigForUnit(capsuleUnitName(executeEntry().ID), validExecutionNetwork())
	if err != nil {
		t.Fatalf("capsuleIngressConfigForUnit returned error: %v", err)
	}
	ruleset := string(renderCapsuleIngressHostRuleset(*config))

	for _, want := range []string{
		"table ip " + config.HostNatTable,
		"type nat hook output priority dstnat;",
		"ip daddr " + config.HostAddr + " tcp dport 8787 dnat to " + config.CapsuleAddr + ":8787",
	} {
		if !strings.Contains(ruleset, want) {
			t.Fatalf("ruleset missing %q:\n%s", want, ruleset)
		}
	}
	for _, forbidden := range []string{"hook prerouting", "0.0.0.0/0", "iifname", "oifname", "eth0", "dport " + strconv.Itoa(config.ProbeDeniedPort), "policy accept"} {
		if strings.Contains(ruleset, forbidden) {
			t.Fatalf("ruleset contains forbidden %q:\n%s", forbidden, ruleset)
		}
	}
	if err := verifyCapsuleIngressHostTable(*config, ruleset); err != nil {
		t.Fatalf("verifyCapsuleIngressHostTable rejected generated ruleset: %v", err)
	}

	openAll := strings.Replace(ruleset, "ip daddr "+config.HostAddr, "ip daddr 0.0.0.0/0", 1)
	if err := verifyCapsuleIngressHostTable(*config, openAll); err == nil {
		t.Fatal("verifyCapsuleIngressHostTable accepted an open-all DNAT")
	}
}

func TestCapsuleIngressNetnsRulesetKeepsInputDefaultDeny(t *testing.T) {
	unitName := capsuleUnitName(executeEntry().ID)
	ingress, err := capsuleIngressConfigForUnit(unitName, validExecutionNetworkNoEgress())
	if err != nil {
		t.Fatalf("capsuleIngressConfigForUnit returned error: %v", err)
	}
	config := capsuleBaseEgressConfigForUnit(unitName)
	config.Ingress = ingress
	ruleset := string(renderCapsuleEgressRuleset(*config))

	for _, want := range []string{
		"table inet " + config.Table,
		"type filter hook input priority filter; policy drop;",
		"type filter hook output priority filter; policy drop;",
		"ct state established,related accept",
		"iifname \"" + config.CapsuleInterface + "\" tcp dport 8787 accept",
	} {
		if !strings.Contains(ruleset, want) {
			t.Fatalf("ruleset missing %q:\n%s", want, ruleset)
		}
	}
	if strings.Contains(ruleset, "dport "+strconv.Itoa(ingress.ProbeDeniedPort)+" accept") {
		t.Fatalf("ruleset contains non-granted ingress port %d:\n%s", ingress.ProbeDeniedPort, ruleset)
	}
	if err := verifyCapsuleEgressTable(*config, ruleset); err != nil {
		t.Fatalf("verifyCapsuleEgressTable rejected generated ingress ruleset: %v", err)
	}
	withoutAccept := strings.Replace(ruleset, "iifname \""+config.CapsuleInterface+"\" tcp dport 8787 accept\n", "", 1)
	if err := verifyCapsuleEgressTable(*config, withoutAccept); err == nil {
		t.Fatal("verifyCapsuleEgressTable accepted missing ingress accept")
	}
	allowAll := strings.Replace(ruleset, "policy drop", "policy accept", 1)
	if err := verifyCapsuleEgressTable(*config, allowAll); err == nil {
		t.Fatal("verifyCapsuleEgressTable accepted input policy accept")
	}
}

func TestCapsuleIngressConfigRejectsPublicPortAllAndRawRuleText(t *testing.T) {
	tests := []struct {
		name string
		rule ExecutionNetworkIngressRule
	}{
		{
			name: "public exposure deferred",
			rule: ExecutionNetworkIngressRule{
				Protocol:   network.ProtoTCP,
				Port:       8787,
				SourceCIDR: "127.0.0.1/32",
				Interface:  "lo",
				Public:     true,
			},
		},
		{
			name: "port all rejected for host local dnat",
			rule: ExecutionNetworkIngressRule{
				Protocol:   network.ProtoTCP,
				Port:       network.PortAll,
				SourceCIDR: "127.0.0.1/32",
				Interface:  "lo",
				Public:     false,
			},
		},
		{
			name: "raw nft text",
			rule: ExecutionNetworkIngressRule{
				Protocol:   network.ProtoTCP,
				Port:       8787,
				SourceCIDR: "127.0.0.1/32\nadd rule inet x y accept",
				Interface:  "lo",
				Public:     false,
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			policy := &ExecutionNetwork{
				Ingress: []ExecutionNetworkIngressRule{tt.rule},
				Egress:  []ExecutionNetworkEgressRule{},
			}
			if config, err := capsuleIngressConfigForUnit(capsuleUnitName(executeEntry().ID), policy); err == nil {
				t.Fatalf("capsuleIngressConfigForUnit accepted invalid rule; config=%#v", config)
			}
		})
	}
}

func TestCapsuleIngressOnlyNetworkUsesNamedNetns(t *testing.T) {
	netns, err := capsuleNetnsForNetwork(capsuleUnitName(executeEntry().ID), "", validExecutionNetworkNoEgress())
	if err != nil {
		t.Fatalf("capsuleNetnsForNetwork returned error: %v", err)
	}
	if netns.Private || netns.Egress == nil || netns.Egress.Ingress == nil {
		t.Fatalf("NetNS = %#v, want named netns with ingress config", netns)
	}
	if len(netns.Egress.Grants) != 0 {
		t.Fatalf("egress grants = %#v, want none for ingress-only policy", netns.Egress.Grants)
	}
}

func TestCapsuleIngressAbsentGrantGetsNoIngress(t *testing.T) {
	policy := &ExecutionNetwork{
		Ingress: []ExecutionNetworkIngressRule{},
		Egress:  []ExecutionNetworkEgressRule{},
	}
	config, err := capsuleIngressConfigForUnit(capsuleUnitName(executeEntry().ID), policy)
	if err != nil {
		t.Fatalf("capsuleIngressConfigForUnit returned error: %v", err)
	}
	if config != nil {
		t.Fatalf("capsuleIngressConfigForUnit = %#v, want nil for no ingress grants", config)
	}
	netns, err := capsuleNetnsForNetwork(capsuleUnitName(executeEntry().ID), "", policy)
	if err != nil {
		t.Fatalf("capsuleNetnsForNetwork returned error: %v", err)
	}
	if !netns.Private || netns.Egress != nil {
		t.Fatalf("NetNS = %#v, want private loopback-only netns for no grants", netns)
	}
}

func TestCapsuleIngressProofRequiresListenerAndRealHostProbe(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen returned error: %v", err)
	}
	defer listener.Close()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
		}
	}()
	port := listener.Addr().(*net.TCPAddr).Port
	deniedPort := reserveClosedTCPPort(t)

	status := &ExecuteNetworkStatus{
		IngressHostAddr:   "127.0.0.1",
		IngressPort:       port,
		IngressDeniedPort: deniedPort,
		IngressDrop:       capsuleIngressDropEnforced,
	}
	refreshCapsuleIngressProof(context.Background(), status, capsuleIngressProof{
		Port:       port,
		DeniedPort: deniedPort,
		Listener:   capsuleIngressListenerOK,
		Status:     capsuleIngressStatusOK,
	})
	if status.IngressReach != capsuleIngressReachOK || status.IngressDrop != capsuleIngressDropEnforced {
		t.Fatalf("status after measured proof = %#v, want ingress reach/drop", status)
	}

	status.IngressReach = ""
	refreshCapsuleIngressProof(context.Background(), status, capsuleIngressProof{
		Port:       port,
		DeniedPort: deniedPort + 1,
		Listener:   capsuleIngressListenerOK,
		Status:     capsuleIngressStatusOK,
	})
	if status.IngressReach != "" {
		t.Fatalf("status after mismatched proof = %#v, want no synthesized reach", status)
	}
}

func TestCapsuleIngressValidateRejectsDeniedPortInsideGrant(t *testing.T) {
	config, err := capsuleIngressConfigForUnit(capsuleUnitName(executeEntry().ID), validExecutionNetwork())
	if err != nil {
		t.Fatalf("capsuleIngressConfigForUnit returned error: %v", err)
	}
	config.ProbeDeniedPort = config.ProbePort
	if err := validateCapsuleIngressConfig(*config); err == nil {
		t.Fatal("validateCapsuleIngressConfig accepted denied probe on a granted port")
	}
}

func TestCapsuleIngressRealHostLocalDNATSkipsWithoutPrivileges(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("real netns ingress test requires Linux")
	}

	grantedPort := 38087
	deniedPort := 38088
	unitName := capsuleUnitName(fmt.Sprintf("local.ingress.%d", time.Now().UnixNano()))
	policy := &ExecutionNetwork{
		Ingress: []ExecutionNetworkIngressRule{
			{
				Protocol:   network.ProtoTCP,
				Port:       grantedPort,
				SourceCIDR: "127.0.0.1/32",
				Interface:  "lo",
				Public:     false,
			},
		},
		Egress: []ExecutionNetworkEgressRule{},
	}
	netns, err := capsuleNetnsForNetwork(unitName, "", policy)
	if err != nil {
		t.Fatalf("capsuleNetnsForNetwork returned error: %v", err)
	}
	manager := defaultCapsuleNetnsManager{}
	created, err := manager.Create(context.Background(), netns)
	if err != nil {
		if ingressRealOpUnavailable(err) {
			t.Skipf("real host-local ingress unavailable: %v", err)
		}
		t.Fatalf("Create returned error: %v", err)
	}
	defer func() {
		if err := manager.Teardown(context.Background(), created); err != nil {
			t.Fatalf("Teardown returned error: %v", err)
		}
	}()

	var listener net.Listener
	if err := withCapsuleNetns(created.Path, func() error {
		var listenErr error
		listener, listenErr = net.Listen("tcp4", net.JoinHostPort(created.Egress.Ingress.CapsuleAddr, strconv.Itoa(grantedPort)))
		return listenErr
	}); err != nil {
		t.Fatalf("listen inside capsule netns returned error: %v", err)
	}
	defer listener.Close()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
		}
	}()

	check, err := manager.Check(context.Background(), created)
	if err != nil {
		t.Fatalf("Check returned error: %v", err)
	}
	if check.Ingress == nil || check.Ingress.Port != grantedPort || check.Ingress.DeniedPort != deniedPort {
		t.Fatalf("Check.Ingress = %#v, want granted and denied ports", check.Ingress)
	}
	if !eventuallyDialTCP(created.Egress.Ingress.HostAddr, grantedPort, 2*time.Second) {
		t.Fatalf("host dial to granted ingress %s:%d did not reach listener", created.Egress.Ingress.HostAddr, grantedPort)
	}
	if eventuallyDialTCP(created.Egress.Ingress.HostAddr, deniedPort, 500*time.Millisecond) {
		t.Fatalf("host dial to non-granted ingress %s:%d unexpectedly reached a listener", created.Egress.Ingress.HostAddr, deniedPort)
	}
}

func reserveClosedTCPPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen denied probe reserve returned error: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		t.Fatalf("Close denied probe reserve returned error: %v", err)
	}
	return port
}

func ingressRealOpUnavailable(err error) bool {
	reason := strings.ToUpper(err.Error())
	return strings.Contains(reason, "EPERM") ||
		strings.Contains(reason, "EACCES") ||
		strings.Contains(reason, "ENOENT") ||
		strings.Contains(reason, "NO SUCH FILE") ||
		strings.Contains(reason, "EXECUTABLE FILE NOT FOUND")
}

func eventuallyDialTCP(host string, port int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		dialer := net.Dialer{Timeout: 100 * time.Millisecond}
		conn, err := dialer.Dial("tcp4", net.JoinHostPort(host, strconv.Itoa(port)))
		if err == nil {
			_ = conn.Close()
			return true
		}
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(50 * time.Millisecond)
	}
}
