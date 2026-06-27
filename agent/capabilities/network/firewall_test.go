package network

import (
	"strings"
	"testing"
)

// allowRule is a tiny constructor for a normalized inbound allow rule.
func allowRule(proto Protocol, port int, cidr, iface string) Rule {
	return Rule{Proto: proto, Port: port, SourceCIDR: cidr, Interface: iface}
}

func policyAllowing(rules ...Rule) Policy {
	out := append([]Rule(nil), rules...)
	return Policy{Allow: &out}
}

// TestNodeFirewallDefaultDenyEnforced proves the rendered input chain is default-deny:
// policy drop, no policy accept on input, loopback + established/related allowed.
func TestNodeFirewallDefaultDenyEnforced(t *testing.T) {
	ruleset, err := RenderNodeFirewall(NodeFirewallConfig{})
	if err != nil {
		t.Fatalf("RenderNodeFirewall: %v", err)
	}
	table := string(ruleset)

	if !strings.Contains(table, "hook input priority filter; policy drop;") {
		t.Fatalf("input chain is not default-deny:\n%s", table)
	}
	if strings.Contains(table, "hook input priority filter; policy accept;") {
		t.Fatalf("input chain must never be policy accept:\n%s", table)
	}
	if !strings.Contains(table, "iifname \"lo\" accept") {
		t.Fatalf("loopback not accepted:\n%s", table)
	}
	if !strings.Contains(table, "ct state established,related accept") {
		t.Fatalf("established/related return traffic not accepted:\n%s", table)
	}
}

// TestNodeFirewallOwnerTokenIngressAlwaysAllowed proves the owner-token TLS ingress
// (7443 by default) is the one allowed remote surface even with an empty policy.
func TestNodeFirewallOwnerTokenIngressAlwaysAllowed(t *testing.T) {
	ruleset, err := RenderNodeFirewall(NodeFirewallConfig{})
	if err != nil {
		t.Fatalf("RenderNodeFirewall: %v", err)
	}
	table := string(ruleset)
	if !strings.Contains(table, "tcp dport 7443 accept") {
		t.Fatalf("owner-token TLS ingress (7443) not allowed:\n%s", table)
	}

	verdict, err := VerifyNodeFirewall(NodeFirewallConfig{}, table)
	if err != nil {
		t.Fatalf("VerifyNodeFirewall: %v", err)
	}
	if !verdict.OwnerIngress {
		t.Fatalf("verdict did not confirm the owner ingress: %+v", verdict)
	}
	if verdict.DefaultDeny != nodeFirewallDropEnforced || verdict.Status != nodeFirewallStatusOK {
		t.Fatalf("verdict not a clean default-deny pass: %+v", verdict)
	}
}

// TestNodeFirewallCustomOwnerIngressPort proves the always-allowed port follows config.
func TestNodeFirewallCustomOwnerIngressPort(t *testing.T) {
	cfg := NodeFirewallConfig{OwnerIngressPort: 9443}
	ruleset, err := RenderNodeFirewall(cfg)
	if err != nil {
		t.Fatalf("RenderNodeFirewall: %v", err)
	}
	table := string(ruleset)
	if !strings.Contains(table, "tcp dport 9443 accept") {
		t.Fatalf("custom owner ingress port 9443 not allowed:\n%s", table)
	}
	if strings.Contains(table, "tcp dport 7443 accept") {
		t.Fatalf("default 7443 must not leak when a custom port is set:\n%s", table)
	}
}

// TestNodeFirewallGrantedIngressAllowedNonGrantedDenied proves an explicit policy grant
// is rendered (allowed), while a port NOT in the policy is absent (denied by the
// default-drop base). This is the default-deny-with-explicit-grants contract.
func TestNodeFirewallGrantedIngressAllowedNonGrantedDenied(t *testing.T) {
	// Owner grants inbound 8443/tcp from a LAN; 2222/tcp is NOT granted.
	policy := policyAllowing(allowRule(ProtoTCP, 8443, "10.0.0.0/8", "eth0"))
	cfg := NodeFirewallConfig{Policy: policy}

	ruleset, err := RenderNodeFirewall(cfg)
	if err != nil {
		t.Fatalf("RenderNodeFirewall: %v", err)
	}
	table := string(ruleset)

	// Granted port present, non-granted port absent.
	if !strings.Contains(table, "dport 8443 accept") {
		t.Fatalf("granted ingress 8443 not allowed:\n%s", table)
	}
	if strings.Contains(table, "dport 2222") {
		t.Fatalf("non-granted ingress 2222 must not appear (default-deny):\n%s", table)
	}
	if !strings.Contains(table, "10.0.0.0/8") {
		t.Fatalf("granted source CIDR not present:\n%s", table)
	}

	verdict, err := VerifyNodeFirewall(cfg, table)
	if err != nil {
		t.Fatalf("VerifyNodeFirewall: %v", err)
	}
	if verdict.GrantedIngress != 1 {
		t.Fatalf("expected 1 confirmed granted ingress, got %d (%+v)", verdict.GrantedIngress, verdict)
	}
}

// TestNodeFirewallVerifyFailsClosedOnPolicyAccept proves the verifier fail-closes when a
// tampered/live table downgrades the input chain to policy accept (the prime failure the
// default-deny posture must catch).
func TestNodeFirewallVerifyFailsClosedOnPolicyAccept(t *testing.T) {
	tampered := strings.Join([]string{
		"table inet vita_node_face {",
		"  chain input {",
		"    type filter hook input priority filter; policy accept;", // ← downgraded
		"    iifname \"lo\" accept",
		"    ct state established,related accept",
		"    tcp dport 7443 accept",
		"  }",
		"}",
	}, "\n")

	if _, err := VerifyNodeFirewall(NodeFirewallConfig{}, tampered); err == nil {
		t.Fatal("VerifyNodeFirewall accepted a policy-accept input chain (must fail closed)")
	}
}

// TestNodeFirewallVerifyFailsClosedWhenOwnerIngressMissing proves a table that drops the
// owner-token TLS ingress is rejected (the owner face would be unreachable / the witness
// would be wrong).
func TestNodeFirewallVerifyFailsClosedWhenOwnerIngressMissing(t *testing.T) {
	missing := strings.Join([]string{
		"table inet vita_node_face {",
		"  chain input {",
		"    type filter hook input priority filter; policy drop;",
		"    iifname \"lo\" accept",
		"    ct state established,related accept",
		// no `tcp dport 7443 accept`
		"  }",
		"}",
	}, "\n")

	if _, err := VerifyNodeFirewall(NodeFirewallConfig{}, missing); err == nil {
		t.Fatal("VerifyNodeFirewall accepted a table missing the owner ingress (must fail closed)")
	}
}

// TestNodeFirewallEgressDefaultDenyOptIn proves egress is open by default (node may
// initiate sync/update) and becomes default-deny only when the owner opts in, listing
// only the granted destinations.
func TestNodeFirewallEgressDefaultDenyOptIn(t *testing.T) {
	// Default: output chain is open.
	open, err := RenderNodeFirewall(NodeFirewallConfig{})
	if err != nil {
		t.Fatalf("RenderNodeFirewall(open): %v", err)
	}
	if !strings.Contains(string(open), "hook output priority filter; policy accept;") {
		t.Fatalf("egress must be open by default:\n%s", open)
	}

	// Opt-in: default-deny output chain, only the granted destination accepted.
	cfg := NodeFirewallConfig{
		EgressDefaultDeny: true,
		EgressGrants: []EgressGrant{
			{Proto: ProtoTCP, Port: 443, Destination: "192.0.2.0/24"},
		},
	}
	locked, err := RenderNodeFirewall(cfg)
	if err != nil {
		t.Fatalf("RenderNodeFirewall(locked): %v", err)
	}
	table := string(locked)
	if !strings.Contains(table, "hook output priority filter; policy drop;") {
		t.Fatalf("egress default-deny opt-in did not produce policy drop output chain:\n%s", table)
	}
	if !strings.Contains(table, "ip daddr 192.0.2.0/24 tcp dport 443 accept") {
		t.Fatalf("egress grant not rendered:\n%s", table)
	}
	if strings.Contains(table, "203.0.113.0/24") {
		t.Fatalf("a non-granted egress destination must not appear (default-deny):\n%s", table)
	}

	verdict, err := VerifyNodeFirewall(cfg, table)
	if err != nil {
		t.Fatalf("VerifyNodeFirewall(locked): %v", err)
	}
	if verdict.EgressDeny != nodeFirewallDropEnforced {
		t.Fatalf("egress default-deny not confirmed: %+v", verdict)
	}
}

// TestNodeFirewallRenderDeterministic proves Render is byte-stable regardless of the
// input rule ordering (pure/deterministic, per the config-evaluation contract).
func TestNodeFirewallRenderDeterministic(t *testing.T) {
	a := policyAllowing(
		allowRule(ProtoTCP, 8443, "10.0.0.0/8", "eth0"),
		allowRule(ProtoUDP, 51820, "192.168.0.0/16", "eth0"),
	)
	b := policyAllowing(
		allowRule(ProtoUDP, 51820, "192.168.0.0/16", "eth0"),
		allowRule(ProtoTCP, 8443, "10.0.0.0/8", "eth0"),
	)

	ra, err := RenderNodeFirewall(NodeFirewallConfig{Policy: a})
	if err != nil {
		t.Fatalf("render a: %v", err)
	}
	rb, err := RenderNodeFirewall(NodeFirewallConfig{Policy: b})
	if err != nil {
		t.Fatalf("render b: %v", err)
	}
	if string(ra) != string(rb) {
		t.Fatalf("Render not deterministic across rule order:\n--- a ---\n%s\n--- b ---\n%s", ra, rb)
	}
}

// TestNodeFirewallRejectsInvalidConfig proves Render fail-closes on bad input (an invalid
// owner ingress port, an un-normalized policy) rather than emitting a loose ruleset.
func TestNodeFirewallRejectsInvalidConfig(t *testing.T) {
	if _, err := RenderNodeFirewall(NodeFirewallConfig{OwnerIngressPort: 70000}); err == nil {
		t.Fatal("Render accepted an out-of-range owner ingress port")
	}

	// A wide-open all-ports/all-sources rule without UnsafeWideOpen is invalid (the
	// policy normalizer rejects it) — Render must surface that, not silently widen.
	wideOpen := policyAllowing(Rule{Proto: ProtoTCP, Port: PortAll, SourceCIDR: "0.0.0.0/0", Interface: "eth0"})
	if _, err := RenderNodeFirewall(NodeFirewallConfig{Policy: wideOpen}); err == nil {
		t.Fatal("Render accepted a wide-open rule without UnsafeWideOpen")
	}
}
