package capsule

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/vita/agent/capabilities/network"
)

func TestCapsuleEgressConfigUsesValidatedManifestGrants(t *testing.T) {
	unitName := capsuleUnitName(executeEntry().ID)
	config, err := capsuleEgressConfigForUnit(unitName, validExecutionNetwork())
	if err != nil {
		t.Fatalf("capsuleEgressConfigForUnit returned error: %v", err)
	}
	if config == nil {
		t.Fatal("capsuleEgressConfigForUnit returned nil config")
	}
	if config.HostInterface == "" || config.CapsuleInterface == "" || config.Table == "" {
		t.Fatalf("egress names = host:%q capsule:%q table:%q, want generated names", config.HostInterface, config.CapsuleInterface, config.Table)
	}
	if config.HostInterface == config.CapsuleInterface {
		t.Fatalf("host and capsule interface names both %q", config.HostInterface)
	}
	if config.ProbeAllowedCIDR != "203.0.113.10/32" || config.ProbeAllowedAddr != "203.0.113.10" || config.ProbeAllowedPort != 443 {
		t.Fatalf("probe allow = cidr:%q addr:%q port:%d, want 203.0.113.10/32 addr port 443", config.ProbeAllowedCIDR, config.ProbeAllowedAddr, config.ProbeAllowedPort)
	}
	if config.ProbeDeniedCIDR == "" || config.ProbeDeniedAddr == "" {
		t.Fatalf("probe denied = cidr:%q addr:%q, want out-of-grant probe", config.ProbeDeniedCIDR, config.ProbeDeniedAddr)
	}
	wantGrant := capsuleEgressGrant{
		Protocol:    network.ProtoTCP,
		Destination: "203.0.113.10/32",
		Port:        443,
	}
	if len(config.Grants) == 0 || config.Grants[0] != wantGrant {
		t.Fatalf("Grants = %#v, want first manifest grant %#v", config.Grants, wantGrant)
	}
}

func TestCapsuleEgressRulesetIsDefaultDenyAndManifestOnly(t *testing.T) {
	config, err := capsuleEgressConfigForUnit(capsuleUnitName(executeEntry().ID), validExecutionNetwork())
	if err != nil {
		t.Fatalf("capsuleEgressConfigForUnit returned error: %v", err)
	}
	ruleset := string(renderCapsuleEgressRuleset(*config))

	for _, want := range []string{
		"table inet " + config.Table,
		"type filter hook output priority filter; policy drop;",
		"type filter hook input priority filter; policy drop;",
		"ct state established,related accept",
		"ip daddr 203.0.113.10/32 tcp dport 443 accept",
	} {
		if !strings.Contains(ruleset, want) {
			t.Fatalf("ruleset missing %q:\n%s", want, ruleset)
		}
	}
	for _, forbidden := range []string{"policy accept", "0.0.0.0/0", "198.51.100.254", "accept all"} {
		if strings.Contains(ruleset, forbidden) {
			t.Fatalf("ruleset contains forbidden %q:\n%s", forbidden, ruleset)
		}
	}
	if err := verifyCapsuleEgressTable(*config, ruleset); err != nil {
		t.Fatalf("verifyCapsuleEgressTable rejected generated ruleset: %v", err)
	}
	if err := verifyCapsuleEgressTable(*config, strings.Replace(ruleset, "policy drop", "policy accept", 1)); err == nil {
		t.Fatal("verifyCapsuleEgressTable accepted an allow-all policy")
	}
}

func TestCapsuleEgressRulesetPortAllDoesNotEmitDport(t *testing.T) {
	policy := &ExecutionNetwork{
		Ingress: []ExecutionNetworkIngressRule{},
		Egress: []ExecutionNetworkEgressRule{
			{
				Name:         "api",
				Protocol:     network.ProtoUDP,
				Destinations: []string{"203.0.113.10/32"},
				Ports:        []int{network.PortAll},
				Interface:    "eth0",
			},
		},
	}
	config, err := capsuleEgressConfigForUnit(capsuleUnitName(executeEntry().ID), policy)
	if err != nil {
		t.Fatalf("capsuleEgressConfigForUnit returned error: %v", err)
	}
	ruleset := string(renderCapsuleEgressRuleset(*config))
	if !strings.Contains(ruleset, "ip daddr 203.0.113.10/32 udp accept") {
		t.Fatalf("ruleset missing all-port udp accept:\n%s", ruleset)
	}
	if strings.Contains(ruleset, "dport") {
		t.Fatalf("PortAll ruleset contains dport:\n%s", ruleset)
	}
}

func TestCapsuleEgressConfigRevalidatesAndRejectsRawRuleText(t *testing.T) {
	tests := []struct {
		name string
		rule ExecutionNetworkEgressRule
	}{
		{
			name: "host-bit smuggled cidr",
			rule: ExecutionNetworkEgressRule{
				Protocol:     network.ProtoTCP,
				Destinations: []string{"203.0.113.10/24"},
				Ports:        []int{443},
				Interface:    "eth0",
			},
		},
		{
			name: "raw nft text",
			rule: ExecutionNetworkEgressRule{
				Protocol:     network.ProtoTCP,
				Destinations: []string{"203.0.113.10/32\nadd rule inet x y accept"},
				Ports:        []int{443},
				Interface:    "eth0",
			},
		},
		{
			name: "wide open without unsafe flag",
			rule: ExecutionNetworkEgressRule{
				Protocol:     network.ProtoTCP,
				Destinations: []string{"0.0.0.0/0"},
				Ports:        []int{network.PortAll},
				Interface:    "eth0",
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			policy := &ExecutionNetwork{
				Ingress: []ExecutionNetworkIngressRule{},
				Egress:  []ExecutionNetworkEgressRule{tt.rule},
			}
			if config, err := capsuleEgressConfigForUnit(capsuleUnitName(executeEntry().ID), policy); err == nil {
				t.Fatalf("capsuleEgressConfigForUnit accepted invalid rule; config=%#v", config)
			}
		})
	}
}

func TestComposeTypeScriptWithEgressGrantUsesNamedNetns(t *testing.T) {
	manifest := executeManifest(executeEntry())
	manifest.Network = validExecutionNetwork()

	unit, err := composeTypeScriptTransientUnit(manifest)
	if err != nil {
		t.Fatalf("composeTypeScriptTransientUnit returned error: %v", err)
	}
	if unit.NetNS == nil || unit.NetNS.Private || unit.NetNS.Egress == nil {
		t.Fatalf("NetNS = %#v, want named netns with egress", unit.NetNS)
	}

	props := propertyValues(unit.Properties)
	assertNoProperty(t, props, "PrivateNetwork")
	assertProperty(t, props, "NetworkNamespacePath", unit.NetNS.Path)
	assertProperty(t, props, "RestrictAddressFamilies", "AF_UNIX AF_INET AF_INET6 AF_NETLINK")
	if !containsArg(unit.Argv, "--allow-net") {
		t.Fatalf("argv = %v, want --allow-net for proof capsule", unit.Argv)
	}
	if !containsArgPrefix(unit.Argv, "--allow-env=VITA_CAPSULE_NETNS_PROOF,VITA_CAPSULE_EGRESS_ALLOWED_ADDR") {
		t.Fatalf("argv = %v, want scoped proof egress env", unit.Argv)
	}
}

func TestComposeTypeScriptNetworkWithoutEgressStaysPrivateLoopbackOnly(t *testing.T) {
	manifest := executeManifest(executeEntry())
	manifest.Network = validExecutionNetworkNoEgress()

	unit, err := composeTypeScriptTransientUnit(manifest)
	if err != nil {
		t.Fatalf("composeTypeScriptTransientUnit returned error: %v", err)
	}
	if unit.NetNS == nil || !unit.NetNS.Private || unit.NetNS.Egress != nil {
		t.Fatalf("NetNS = %#v, want private loopback-only netns", unit.NetNS)
	}
	props := propertyValues(unit.Properties)
	assertProperty(t, props, "PrivateNetwork", "yes")
	assertNoProperty(t, props, "NetworkNamespacePath")
}

func TestCapsuleEgressProofRefreshRequiresMeasuredReachAndDrop(t *testing.T) {
	proofPath := filepath.Join(t.TempDir(), "proof.json")
	proof := `{"id":"local.test.capsule","loopback":"OK","external":"FAIL","egress":{"allowed":"203.0.113.10/32","reach":"OK","denied":"198.51.100.254/32","drop":"enforced","status":"OK"},"status":"OK"}`
	if err := os.WriteFile(proofPath, []byte(proof+"\n"), 0o600); err != nil {
		t.Fatalf("WriteFile proof returned error: %v", err)
	}

	status := ExecuteStatus{
		ID: "local.test.capsule",
		Network: &ExecuteNetworkStatus{
			ProofPath:     proofPath,
			EgressAllowed: "203.0.113.10/32",
			EgressDenied:  "198.51.100.254/32",
			EgressDrop:    capsuleEgressDropEnforced,
		},
	}
	(&ExecuteCapability{}).refreshNetworkProof(context.Background(), &status)
	if status.Network.Loopback != capsuleNetnsLoopbackOK || status.Network.EgressReach != capsuleEgressReachOK {
		t.Fatalf("Network after refresh = %#v, want loopback and egress reach proof", status.Network)
	}

	status.Network.EgressReach = ""
	status.Network.EgressDrop = ""
	(&ExecuteCapability{}).refreshNetworkProof(context.Background(), &status)
	if status.Network.EgressReach != "" {
		t.Fatalf("Network after refresh without agent drop = %#v, want no egress reach", status.Network)
	}
}

func TestCapsuleEgressInterfacesReadyDiagnosesAbsentAndDown(t *testing.T) {
	tests := []struct {
		name       string
		interfaces []net.Interface
		wantReason string
	}{
		{
			name:       "absent capsule link",
			interfaces: []net.Interface{{Name: "lo", Flags: net.FlagUp | net.FlagLoopback}},
			wantReason: "capsule_netns_failed:egress_check_link_absent",
		},
		{
			name: "down capsule link",
			interfaces: []net.Interface{
				{Name: "lo", Flags: net.FlagUp | net.FlagLoopback},
				{Name: "vc123", Flags: 0},
			},
			wantReason: "capsule_netns_failed:egress_check_link_down",
		},
		{
			name: "unexpected link",
			interfaces: []net.Interface{
				{Name: "lo", Flags: net.FlagUp | net.FlagLoopback},
				{Name: "vc123", Flags: net.FlagUp},
				{Name: "eth0", Flags: net.FlagUp},
			},
			wantReason: "capsule_netns_failed:egress_check_link_extra",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := capsuleEgressInterfacesReady(tt.interfaces, "vc123")
			if err == nil {
				t.Fatal("capsuleEgressInterfacesReady accepted invalid interface set")
			}
			if reason := capsuleNetnsFailureReason(err); reason != tt.wantReason {
				t.Fatalf("reason = %q, want %q", reason, tt.wantReason)
			}
		})
	}

	if err := capsuleEgressInterfacesReady([]net.Interface{
		{Name: "lo", Flags: net.FlagUp | net.FlagLoopback},
		{Name: "vc123", Flags: net.FlagUp},
	}, "vc123"); err != nil {
		t.Fatalf("capsuleEgressInterfacesReady returned error for ready links: %v", err)
	}
}

func TestCapsuleEgressNamesAreDeterministicAndDoNotCollide(t *testing.T) {
	first := capsuleEgressNames(capsuleUnitName("local.test.capsule"))
	second := capsuleEgressNames(capsuleUnitName("local.test.capsule"))
	other := capsuleEgressNames(capsuleUnitName("local.other.capsule"))
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("egress names are not deterministic: %#v != %#v", first, second)
	}
	if first == other {
		t.Fatalf("egress names collide for different capsules: %#v", first)
	}
	for _, name := range []string{first.host, first.capsule} {
		if !network.ValidInterfaceName(name) {
			t.Fatalf("interface name %q is invalid", name)
		}
	}
	if !safeNftIdentifier(first.table) {
		t.Fatalf("table name %q is invalid", first.table)
	}
}

func containsArg(argv []string, want string) bool {
	for _, arg := range argv {
		if arg == want {
			return true
		}
	}
	return false
}

func containsArgPrefix(argv []string, want string) bool {
	for _, arg := range argv {
		if strings.HasPrefix(arg, want) {
			return true
		}
	}
	return false
}
