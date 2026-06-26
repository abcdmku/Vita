package capsule

import (
	"errors"
	"strconv"
	"strings"
	"testing"

	"github.com/vita/agent/capabilities/network"
)

const (
	ingressFixtureUnitName = "capsule-ingress-fixture"

	ingressFixtureHostRuleset = `table ip vita_566c365617f6_nat {
  chain output {
    type nat hook output priority dstnat;
    ip daddr 169.254.125.93 tcp dport 8787 dnat to 169.254.125.94:8787
    ip daddr 169.254.125.93 udp dport 5353 dnat to 169.254.125.94:5353
    ip daddr 169.254.125.93 tcp dport 9443 dnat to 169.254.125.94:9443
  }
}
`

	ingressFixtureInputRules = `    iifname "vc566c365617" tcp dport 8787 accept
    iifname "vc566c365617" udp dport 5353 accept
    iifname "vc566c365617" tcp dport 9443 accept
`
)

func TestCapsuleIngressRendererByteStabilityAndGolden(t *testing.T) {
	config := mustCapsuleIngressFixtureConfig(t)
	tests := []struct {
		name   string
		render func() []byte
		golden string
	}{
		{
			name: "host dnat ruleset",
			render: func() []byte {
				return renderCapsuleIngressHostRuleset(*config)
			},
			golden: ingressFixtureHostRuleset,
		},
		{
			name: "netns input rules",
			render: func() []byte {
				var b strings.Builder
				writeCapsuleIngressInputRules(&b, config)
				return []byte(b.String())
			},
			golden: ingressFixtureInputRules,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			first := string(tt.render())
			second := string(tt.render())
			if first != second {
				t.Fatalf("rendered bytes changed across calls:\nfirst:\n%s\nsecond:\n%s", first, second)
			}
			if first != tt.golden {
				t.Fatalf("rendered bytes differ from golden:\ngot:\n%s\nwant:\n%s", first, tt.golden)
			}
		})
	}
}

func TestCapsuleIngressConfigUsesEgressPairing(t *testing.T) {
	config := mustCapsuleIngressFixtureConfig(t)
	names := capsuleEgressNames(ingressFixtureUnitName)
	hostAddr, capsuleAddr := capsuleEgressIPv4Pair(ingressFixtureUnitName)

	tests := []struct {
		field   string
		got     string
		derived string
		literal string
	}{
		{
			field:   "HostInterface",
			got:     config.HostInterface,
			derived: names.host,
			literal: "vh566c365617",
		},
		{
			field:   "CapsuleInterface",
			got:     config.CapsuleInterface,
			derived: names.capsule,
			literal: "vc566c365617",
		},
		{
			field:   "HostAddr",
			got:     config.HostAddr,
			derived: hostAddr.String(),
			literal: "169.254.125.93",
		},
		{
			field:   "CapsuleAddr",
			got:     config.CapsuleAddr,
			derived: capsuleAddr.String(),
			literal: "169.254.125.94",
		},
		{
			field:   "HostNatTable",
			got:     config.HostNatTable,
			derived: names.table + "_nat",
			literal: "vita_566c365617f6_nat",
		},
	}

	for _, tt := range tests {
		t.Run(tt.field, func(t *testing.T) {
			if tt.got != tt.derived {
				t.Fatalf("%s = %q, want egress-derived %q", tt.field, tt.got, tt.derived)
			}
			if tt.got != tt.literal {
				t.Fatalf("%s = %q, want fixture literal %q", tt.field, tt.got, tt.literal)
			}
		})
	}
}

func TestCapsuleIngressGrantLinesAndDeniedPorts(t *testing.T) {
	config := mustCapsuleIngressFixtureConfig(t)
	hostRuleset := string(renderCapsuleIngressHostRuleset(*config))
	inputRules := renderCapsuleIngressInputRulesForTest(config)

	if config.ProbeDeniedPort != 8788 {
		t.Fatalf("ProbeDeniedPort = %d, want deterministic non-granted port 8788", config.ProbeDeniedPort)
	}
	if err := verifyCapsuleIngressHostTable(*config, hostRuleset); err != nil {
		t.Fatalf("verifyCapsuleIngressHostTable rejected generated ruleset: %v", err)
	}
	if err := verifyCapsuleIngressNetnsTable(*config, inputRules); err != nil {
		t.Fatalf("verifyCapsuleIngressNetnsTable rejected generated input rules: %v", err)
	}

	tests := []struct {
		name     string
		ruleset  string
		contains func(string, int) bool
	}{
		{
			name:     "host",
			ruleset:  hostRuleset,
			contains: hostRulesetContainsIngressPort,
		},
		{
			name:     "netns",
			ruleset:  inputRules,
			contains: inputRulesContainIngressPort,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name+" denied ports absent", func(t *testing.T) {
			for _, port := range []int{config.ProbeDeniedPort, 8081} {
				if tt.contains(tt.ruleset, port) {
					t.Fatalf("%s ruleset contains non-granted ingress port %d:\n%s", tt.name, port, tt.ruleset)
				}
			}
		})
	}

	for _, grant := range config.Grants {
		grant := grant
		t.Run(string(grant.Protocol)+" "+strconv.Itoa(grant.Port), func(t *testing.T) {
			port := strconv.Itoa(grant.Port)
			hostLine := "ip daddr " + config.HostAddr + " " + string(grant.Protocol) + " dport " + port + " dnat to " + config.CapsuleAddr + ":" + port
			if got := strings.Count(hostRuleset, hostLine); got != 1 {
				t.Fatalf("host ruleset contains %q %d times, want exactly once:\n%s", hostLine, got, hostRuleset)
			}

			inputLine := "iifname \"" + config.CapsuleInterface + "\" " + string(grant.Protocol) + " dport " + port + " accept"
			if got := strings.Count(inputRules, inputLine); got != 1 {
				t.Fatalf("netns input rules contain %q %d times, want exactly once:\n%s", inputLine, got, inputRules)
			}
		})
	}
}

func TestCapsuleIngressVerifiersRejectDeniedPortTampering(t *testing.T) {
	config := mustCapsuleIngressFixtureConfig(t)
	hostRuleset := string(renderCapsuleIngressHostRuleset(*config))
	inputRules := renderCapsuleIngressInputRulesForTest(config)
	deniedPort := strconv.Itoa(config.ProbeDeniedPort)

	tests := []struct {
		name   string
		table  string
		verify func(string) error
	}{
		{
			name:  "host dnat",
			table: strings.Replace(hostRuleset, "  }\n}\n", "    ip daddr "+config.HostAddr+" tcp dport "+deniedPort+" dnat to "+config.CapsuleAddr+":"+deniedPort+"\n  }\n}\n", 1),
			verify: func(table string) error {
				return verifyCapsuleIngressHostTable(*config, table)
			},
		},
		{
			name:  "netns input",
			table: inputRules + "    iifname \"" + config.CapsuleInterface + "\" tcp dport " + deniedPort + " accept\n",
			verify: func(table string) error {
				return verifyCapsuleIngressNetnsTable(*config, table)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := tt.verify(tt.table); err == nil {
				t.Fatalf("verifier accepted table with denied port %s:\n%s", deniedPort, tt.table)
			}
		})
	}
}

func TestCapsuleIngressVerifiersRejectMissingGrant(t *testing.T) {
	config := mustCapsuleIngressFixtureConfig(t)
	hostRuleset := string(renderCapsuleIngressHostRuleset(*config))
	inputRules := renderCapsuleIngressInputRulesForTest(config)

	for _, grant := range config.Grants {
		grant := grant
		t.Run(string(grant.Protocol)+" "+strconv.Itoa(grant.Port), func(t *testing.T) {
			port := strconv.Itoa(grant.Port)
			hostLine := "    ip daddr " + config.HostAddr + " " + string(grant.Protocol) + " dport " + port + " dnat to " + config.CapsuleAddr + ":" + port + "\n"
			if err := verifyCapsuleIngressHostTable(*config, strings.Replace(hostRuleset, hostLine, "", 1)); err == nil {
				t.Fatalf("host verifier accepted ruleset missing granted %s port %s", grant.Protocol, port)
			}

			inputLine := "    iifname \"" + config.CapsuleInterface + "\" " + string(grant.Protocol) + " dport " + port + " accept\n"
			if err := verifyCapsuleIngressNetnsTable(*config, strings.Replace(inputRules, inputLine, "", 1)); err == nil {
				t.Fatalf("netns verifier accepted input rules missing granted %s port %s", grant.Protocol, port)
			}
		})
	}
}

func TestCapsuleIngressHostVerifierRejectsPublicMatches(t *testing.T) {
	config := mustCapsuleIngressFixtureConfig(t)
	hostRuleset := string(renderCapsuleIngressHostRuleset(*config))

	tests := []struct {
		name  string
		table string
	}{
		{
			name:  "iifname",
			table: strings.Replace(hostRuleset, "    ip daddr", "    iifname \"eth0\" tcp dport 8787 accept\n    ip daddr", 1),
		},
		{
			name:  "oifname",
			table: strings.Replace(hostRuleset, "    ip daddr", "    oifname \"eth0\" tcp dport 8787 accept\n    ip daddr", 1),
		},
		{
			name:  "all sources",
			table: strings.Replace(hostRuleset, "ip daddr "+config.HostAddr, "ip daddr 0.0.0.0/0", 1),
		},
		{
			name:  "prerouting hook",
			table: strings.Replace(hostRuleset, "  }\n}\n", "  }\n  chain pre {\n    type nat hook prerouting priority dstnat;\n  }\n}\n", 1),
		},
		{
			name:  "missing output hook",
			table: strings.Replace(hostRuleset, "hook output", "hook forward", 1),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := verifyCapsuleIngressHostTable(*config, tt.table); err == nil {
				t.Fatalf("verifyCapsuleIngressHostTable accepted public/non-output match %q:\n%s", tt.name, tt.table)
			}
		})
	}
}

func TestCapsuleIngressConfigRejectsInvalidHostLocalGrants(t *testing.T) {
	tests := []struct {
		name string
		rule ExecutionNetworkIngressRule
	}{
		{
			name: "public host exposure",
			rule: ExecutionNetworkIngressRule{
				Name:       "bad-public",
				Protocol:   network.ProtoTCP,
				Port:       8787,
				SourceCIDR: "127.0.0.1/32",
				Interface:  "lo",
				Public:     true,
			},
		},
		{
			name: "port all",
			rule: ExecutionNetworkIngressRule{
				Name:       "bad-port-all",
				Protocol:   network.ProtoTCP,
				Port:       network.PortAll,
				SourceCIDR: "127.0.0.1/32",
				Interface:  "lo",
				Public:     false,
			},
		},
		{
			name: "zero port",
			rule: ExecutionNetworkIngressRule{
				Name:       "bad-zero-port",
				Protocol:   network.ProtoTCP,
				Port:       0,
				SourceCIDR: "127.0.0.1/32",
				Interface:  "lo",
				Public:     false,
			},
		},
		{
			name: "port too high",
			rule: ExecutionNetworkIngressRule{
				Name:       "bad-high-port",
				Protocol:   network.ProtoTCP,
				Port:       65536,
				SourceCIDR: "127.0.0.1/32",
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
			config, err := capsuleIngressConfigForUnit(ingressFixtureUnitName, policy)
			if err == nil {
				t.Fatalf("capsuleIngressConfigForUnit accepted invalid host-local ingress rule; config=%#v", config)
			}
			var invalid *ExecuteInvalidRequestError
			if !errors.As(err, &invalid) {
				t.Fatalf("capsuleIngressConfigForUnit error = %T %v, want ExecuteInvalidRequestError", err, err)
			}
		})
	}
}

func TestCapsuleIngressOnlyNetworkUsesNamedNetns(t *testing.T) {
	netns, err := capsuleNetnsForNetwork(ingressFixtureUnitName, "", ingressFixturePolicy())
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
	config, err := capsuleIngressConfigForUnit(ingressFixtureUnitName, policy)
	if err != nil {
		t.Fatalf("capsuleIngressConfigForUnit returned error: %v", err)
	}
	if config != nil {
		t.Fatalf("capsuleIngressConfigForUnit = %#v, want nil for no ingress grants", config)
	}
	netns, err := capsuleNetnsForNetwork(ingressFixtureUnitName, "", policy)
	if err != nil {
		t.Fatalf("capsuleNetnsForNetwork returned error: %v", err)
	}
	if !netns.Private || netns.Egress != nil {
		t.Fatalf("NetNS = %#v, want private loopback-only netns for no grants", netns)
	}
}

func TestCapsuleIngressValidateRejectsDeniedPortInsideGrant(t *testing.T) {
	config := mustCapsuleIngressFixtureConfig(t)
	config.ProbeDeniedPort = config.ProbePort
	if err := validateCapsuleIngressConfig(*config); err == nil {
		t.Fatal("validateCapsuleIngressConfig accepted denied probe on a granted port")
	}
}

func mustCapsuleIngressFixtureConfig(t *testing.T) *capsuleIngressConfig {
	t.Helper()

	config, err := capsuleIngressConfigForUnit(ingressFixtureUnitName, ingressFixturePolicy())
	if err != nil {
		t.Fatalf("capsuleIngressConfigForUnit returned error: %v", err)
	}
	if config == nil {
		t.Fatal("capsuleIngressConfigForUnit returned nil config")
	}
	return config
}

func ingressFixturePolicy() *ExecutionNetwork {
	return &ExecutionNetwork{
		Ingress: []ExecutionNetworkIngressRule{
			{
				Name:       "health",
				Protocol:   network.ProtoTCP,
				Port:       8787,
				SourceCIDR: "127.0.0.1/32",
				Interface:  "lo",
				Public:     false,
			},
			{
				Name:       "discovery",
				Protocol:   network.ProtoUDP,
				Port:       5353,
				SourceCIDR: "127.0.0.1/32",
				Interface:  "lo",
				Public:     false,
			},
			{
				Name:       "admin",
				Protocol:   network.ProtoTCP,
				Port:       9443,
				SourceCIDR: "127.0.0.1/32",
				Interface:  "lo",
				Public:     false,
			},
		},
		Egress: []ExecutionNetworkEgressRule{},
	}
}

func renderCapsuleIngressInputRulesForTest(config *capsuleIngressConfig) string {
	var b strings.Builder
	writeCapsuleIngressInputRules(&b, config)
	return b.String()
}

func hostRulesetContainsIngressPort(ruleset string, port int) bool {
	portValue := strconv.Itoa(port)
	return strings.Contains(ruleset, "dport "+portValue) ||
		strings.Contains(ruleset, ":"+portValue)
}

func inputRulesContainIngressPort(ruleset string, port int) bool {
	return strings.Contains(ruleset, "dport "+strconv.Itoa(port))
}
