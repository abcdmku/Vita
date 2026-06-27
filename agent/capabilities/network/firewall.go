package network

import (
	"errors"
	"fmt"
	"net/netip"
	"sort"
	"strconv"
	"strings"
)

// firewall.go renders + verifies the NODE-FACE (host) default-deny firewall from a
// validated network.Policy. The Policy capability (network.go) is the persisted,
// pure config model: an ALLOW-LIST of inbound rules. This file turns that allow-list
// into the ENFORCED posture the spec/owner ask for:
//
//   - DEFAULT-DENY base: the input chain has `policy drop`; nothing is reachable
//     from the network unless an explicit allow rule (or the owner-token TLS ingress)
//     opens it. This mirrors the per-capsule egress model (capsule/egress.go) but at
//     the NODE face: loopback-only by default, established/related return traffic
//     accepted, and every remote ingress fail-closed.
//   - The OWNER-TOKEN TLS INGRESS is the one allowed remote surface by construction:
//     the node binds 0.0.0.0:7443 (the bearer-secret, TLS owner face — see
//     ui_kits/desktop/runtime/puter/server/server-entry.ts). Render emits an explicit
//     accept for that single TCP dport so the owner face is reachable while the base
//     stays default-deny. Every OTHER ingress is denied unless the policy grants it.
//   - EGRESS default-deny is OPTIONAL and explicit: when the owner has not declared
//     egress grants the output chain stays open (the node initiates its own outbound
//     sync/update). When the owner sets an egress posture the output chain becomes
//     `policy drop` with only loopback + established/related + the granted
//     destinations accepted. (The strict, always-on egress default-deny is the
//     per-capsule netns model; the node itself needs outbound for sync/update, so its
//     egress lockdown is owner-opt-in here, NOT silently-open-by-omission for ingress.)
//
// Pure + deterministic: Render/Verify take only the validated inputs and produce a
// byte-stable ruleset / a structured verdict, with NO I/O. The caller (agentd or the
// firewall apply path) hands the rendered ruleset to sysdeps.ApplyNftRuleset and the
// listed table back to Verify against the live `nft list table` output — exactly the
// capsule egress idiom, so it is testable in go-in-docker / the harness with no root.

const (
	// nodeFirewallFamily is the nftables address family for the node face table.
	nodeFirewallFamily = "inet"
	// NodeFirewallTable is the fixed table name the node-face firewall renders into.
	// Distinct from the per-capsule `vita_<hash>` egress tables so the two layers
	// never collide.
	NodeFirewallTable = "vita_node_face"

	// OwnerTokenTLSIngressPort is the single allowed remote ingress surface: the
	// owner-token + TLS network face the platform binds on 0.0.0.0:7443. Kept in sync
	// with VITA_NETWORK_PORT's default (server-entry.ts). The firewall always opens
	// exactly this TCP dport so the owner face is reachable under default-deny.
	OwnerTokenTLSIngressPort = 7443

	// nodeFirewallDropEnforced / StatusOK mirror the capsule egress proof vocabulary
	// so the boot/marker layer reads one consistent witness shape.
	nodeFirewallDropEnforced = "enforced"
	nodeFirewallStatusOK     = "OK"
)

// NodeFirewallConfig is the rendered node-face firewall input: a validated policy plus
// the owner-token TLS ingress port the firewall must always allow. EgressDefaultDeny
// turns the output chain into a default-deny posture (owner-opt-in); when false the
// output chain is left open so the node's own outbound sync/update is unaffected.
type NodeFirewallConfig struct {
	// Policy is the validated inbound allow-list (network.Policy). nil/empty Allow ⇒
	// ONLY the owner-token TLS ingress + loopback + established/related are reachable.
	Policy Policy
	// OwnerIngressPort is the always-allowed owner-token TLS ingress TCP port. Defaults
	// to OwnerTokenTLSIngressPort when zero.
	OwnerIngressPort int
	// EgressGrants, when non-empty (and EgressDefaultDeny true), are the only outbound
	// destinations accepted under the egress default-deny output chain.
	EgressGrants []EgressGrant
	// EgressDefaultDeny opts the node into a default-deny OUTPUT chain. Default false:
	// the node initiates outbound sync/update, so egress is open unless the owner
	// explicitly locks it down.
	EgressDefaultDeny bool
}

// EgressGrant is one allowed outbound destination (CIDR + protocol + port) for the
// node's own egress under the egress default-deny posture.
type EgressGrant struct {
	Proto       Protocol
	Destination string
	Port        int
}

// NodeFirewallVerdict is the structured result of verifying a rendered/live table
// against the configured policy. It is the witness the marker/boot layer consumes:
// DefaultDeny "enforced" + Status "OK" + OwnerIngress true is the pass shape.
type NodeFirewallVerdict struct {
	DefaultDeny    string // "enforced" when the input chain has policy drop and no policy accept
	OwnerIngress   bool   // the owner-token TLS ingress port is explicitly allowed
	GrantedIngress int    // count of explicit policy ingress rules confirmed present
	EgressDeny     string // "enforced" when egress default-deny is configured + present; "" otherwise
	Status         string // "OK" when every required element is present
}

// resolveOwnerIngressPort returns the configured owner ingress port or the default.
func (c NodeFirewallConfig) resolveOwnerIngressPort() int {
	if c.OwnerIngressPort == 0 {
		return OwnerTokenTLSIngressPort
	}
	return c.OwnerIngressPort
}

// validateNodeFirewallConfig fail-closes on any unsafe/invalid input BEFORE rendering,
// so a malformed policy can never produce a ruleset that silently widens access.
func validateNodeFirewallConfig(config NodeFirewallConfig) error {
	port := config.resolveOwnerIngressPort()
	if port <= 0 || port > 65535 {
		return &InvalidRequestError{Reason: "owner ingress port must be 1-65535"}
	}
	// The inbound allow-list must already be normalized/valid (the capability does this
	// on Apply); re-validate here so Render is never handed an un-normalized policy.
	if config.Policy.Allow != nil {
		if _, err := normalizePolicy(config.Policy); err != nil {
			return err
		}
	}
	if config.EgressDefaultDeny {
		for i, grant := range config.EgressGrants {
			if grant.Proto != ProtoTCP && grant.Proto != ProtoUDP {
				return &InvalidRequestError{Reason: fmt.Sprintf("egressGrants[%d].proto must be tcp or udp", i)}
			}
			if grant.Port != PortAll && (grant.Port <= 0 || grant.Port > 65535) {
				return &InvalidRequestError{Reason: fmt.Sprintf("egressGrants[%d].port must be 1-65535 or PortAll", i)}
			}
			if _, err := normalizeCIDR(grant.Destination); err != nil {
				return &InvalidRequestError{Reason: fmt.Sprintf("egressGrants[%d].destination %s", i, err)}
			}
		}
	}
	return nil
}

// RenderNodeFirewall renders the default-deny node-face nftables ruleset from the
// config. Pure: same inputs ⇒ byte-identical output. The input chain is `policy drop`
// (default-deny), accepts loopback + established/related, ALWAYS accepts the owner-token
// TLS ingress port, then accepts each explicit policy allow rule. The output chain is
// open unless EgressDefaultDeny is set, in which case it too is `policy drop` with only
// loopback + established/related + the egress grants accepted.
func RenderNodeFirewall(config NodeFirewallConfig) ([]byte, error) {
	if err := validateNodeFirewallConfig(config); err != nil {
		return nil, err
	}
	ownerPort := config.resolveOwnerIngressPort()

	var b strings.Builder
	b.WriteString("table ")
	b.WriteString(nodeFirewallFamily)
	b.WriteString(" ")
	b.WriteString(NodeFirewallTable)
	b.WriteString(" {\n")

	// ── input chain: DEFAULT-DENY ──
	b.WriteString("  chain input {\n")
	b.WriteString("    type filter hook input priority filter; policy drop;\n")
	b.WriteString("    iifname \"lo\" accept\n")
	b.WriteString("    ct state established,related accept\n")
	// The single always-allowed remote ingress surface: the owner-token TLS face.
	b.WriteString("    tcp dport ")
	b.WriteString(strconv.Itoa(ownerPort))
	b.WriteString(" accept\n")
	// Each explicit owner-granted inbound rule. Sorted for deterministic output.
	for _, rule := range sortedAllowRules(config.Policy) {
		writeIngressAllowRule(&b, rule)
	}
	b.WriteString("  }\n")

	// ── output chain: open by default; default-deny only when the owner opts in ──
	b.WriteString("  chain output {\n")
	if config.EgressDefaultDeny {
		b.WriteString("    type filter hook output priority filter; policy drop;\n")
		b.WriteString("    oifname \"lo\" accept\n")
		b.WriteString("    ct state established,related accept\n")
		for _, grant := range sortedEgressGrants(config.EgressGrants) {
			writeEgressAllowRule(&b, grant)
		}
	} else {
		b.WriteString("    type filter hook output priority filter; policy accept;\n")
	}
	b.WriteString("  }\n")

	b.WriteString("}\n")
	return []byte(b.String()), nil
}

// writeIngressAllowRule writes one `<src> <proto> [dport <port>] [iif <iface>] accept`.
func writeIngressAllowRule(b *strings.Builder, rule Rule) {
	b.WriteString("    ")
	prefix := netip.MustParsePrefix(rule.SourceCIDR)
	if !sourceCoversAll(prefix) {
		if prefix.Addr().Is4() {
			b.WriteString("ip saddr ")
		} else {
			b.WriteString("ip6 saddr ")
		}
		b.WriteString(prefix.String())
		b.WriteString(" ")
	}
	if rule.Interface != "" {
		b.WriteString("iifname \"")
		b.WriteString(rule.Interface)
		b.WriteString("\" ")
	}
	b.WriteString(string(rule.Proto))
	if rule.Port != PortAll {
		b.WriteString(" dport ")
		b.WriteString(strconv.Itoa(rule.Port))
	}
	b.WriteString(" accept\n")
}

// writeEgressAllowRule writes one outbound `ip daddr <cidr> <proto> [dport <port>] accept`.
func writeEgressAllowRule(b *strings.Builder, grant EgressGrant) {
	b.WriteString("    ")
	prefix := netip.MustParsePrefix(grant.Destination)
	if prefix.Addr().Is4() {
		b.WriteString("ip daddr ")
	} else {
		b.WriteString("ip6 daddr ")
	}
	b.WriteString(prefix.String())
	b.WriteString(" ")
	b.WriteString(string(grant.Proto))
	if grant.Port != PortAll {
		b.WriteString(" dport ")
		b.WriteString(strconv.Itoa(grant.Port))
	}
	b.WriteString(" accept\n")
}

// VerifyNodeFirewall checks a live `nft list table inet vita_node_face` dump against the
// configured policy and returns a structured verdict. It fail-closes: a table missing
// `policy drop`, containing `policy accept` on the input chain, missing the owner-token
// ingress, or missing any granted ingress rule yields Status != "OK". This is the node
// equivalent of capsule/egress.go's verifyCapsuleEgressTable.
func VerifyNodeFirewall(config NodeFirewallConfig, table string) (NodeFirewallVerdict, error) {
	if err := validateNodeFirewallConfig(config); err != nil {
		return NodeFirewallVerdict{}, err
	}
	verdict := NodeFirewallVerdict{}

	// The input chain MUST be default-deny.
	if !inputChainHasPolicyDrop(table) {
		return verdict, errors.New("node firewall input chain does not enforce policy drop")
	}
	verdict.DefaultDeny = nodeFirewallDropEnforced

	// established/related return traffic must be allowed (otherwise the owner face's
	// own replies would be dropped).
	if !strings.Contains(table, "ct state established,related accept") &&
		!strings.Contains(table, "ct state related,established accept") {
		return verdict, errors.New("node firewall does not allow established return traffic")
	}

	// The owner-token TLS ingress port MUST be explicitly allowed.
	ownerPort := config.resolveOwnerIngressPort()
	if !strings.Contains(table, "tcp dport "+strconv.Itoa(ownerPort)+" accept") {
		return verdict, fmt.Errorf("node firewall missing owner-token TLS ingress dport %d", ownerPort)
	}
	verdict.OwnerIngress = true

	// Every explicit policy allow rule must be present.
	rules := sortedAllowRules(config.Policy)
	for _, rule := range rules {
		if !tableContainsIngressRule(table, rule) {
			return verdict, fmt.Errorf("node firewall missing granted ingress %s/%d", rule.Proto, rule.Port)
		}
	}
	verdict.GrantedIngress = len(rules)

	// Egress: when default-deny is configured, the output chain must enforce it and
	// list every grant.
	if config.EgressDefaultDeny {
		if !outputChainHasPolicyDrop(table) {
			return verdict, errors.New("node firewall egress default-deny configured but output chain is not policy drop")
		}
		for _, grant := range sortedEgressGrants(config.EgressGrants) {
			if !tableContainsEgressGrant(table, grant) {
				return verdict, fmt.Errorf("node firewall missing egress grant to %s", grant.Destination)
			}
		}
		verdict.EgressDeny = nodeFirewallDropEnforced
	}

	verdict.Status = nodeFirewallStatusOK
	return verdict, nil
}

// inputChainHasPolicyDrop reports whether the input chain hook line is `policy drop`.
func inputChainHasPolicyDrop(table string) bool {
	return chainHookHasPolicy(table, "input", "drop")
}

// outputChainHasPolicyDrop reports whether the output chain hook line is `policy drop`.
func outputChainHasPolicyDrop(table string) bool {
	return chainHookHasPolicy(table, "output", "drop")
}

// chainHookHasPolicy scans for a `hook <chain> priority ...; policy <policy>;` line.
// `nft list` may collapse or reorder whitespace, so we match on the hook + policy
// tokens within a single line rather than an exact substring.
func chainHookHasPolicy(table, chain, policy string) bool {
	for _, line := range strings.Split(table, "\n") {
		l := strings.ToLower(strings.TrimSpace(line))
		if strings.Contains(l, "hook "+chain) && strings.Contains(l, "policy "+policy) {
			return true
		}
	}
	return false
}

// tableContainsIngressRule reports whether the rendered/live table carries the rule's
// distinguishing tokens (source, interface, protocol, port). Conservative: every
// present token must appear (a missing token ⇒ the rule is not confirmed).
func tableContainsIngressRule(table string, rule Rule) bool {
	prefix := netip.MustParsePrefix(rule.SourceCIDR)
	if !sourceCoversAll(prefix) && !strings.Contains(table, prefix.String()) {
		return false
	}
	if rule.Interface != "" && !strings.Contains(table, "iifname \""+rule.Interface+"\"") {
		return false
	}
	if !strings.Contains(table, string(rule.Proto)) {
		return false
	}
	if rule.Port != PortAll && !strings.Contains(table, "dport "+strconv.Itoa(rule.Port)) {
		return false
	}
	return true
}

// tableContainsEgressGrant reports whether the egress grant's destination + port are present.
func tableContainsEgressGrant(table string, grant EgressGrant) bool {
	prefix := netip.MustParsePrefix(grant.Destination)
	if !strings.Contains(table, prefix.String()) {
		return false
	}
	if grant.Port != PortAll && !strings.Contains(table, "dport "+strconv.Itoa(grant.Port)) {
		return false
	}
	return true
}

// sortedAllowRules returns the policy's allow rules in a deterministic order so Render
// output is byte-stable regardless of input ordering.
func sortedAllowRules(policy Policy) []Rule {
	if policy.Allow == nil {
		return nil
	}
	rules := make([]Rule, len(*policy.Allow))
	copy(rules, *policy.Allow)
	sort.SliceStable(rules, func(i, j int) bool {
		return ruleSortKey(rules[i]) < ruleSortKey(rules[j])
	})
	return rules
}

func ruleSortKey(r Rule) string {
	return fmt.Sprintf("%s|%s|%05d|%s", r.SourceCIDR, r.Interface, normalizeSortPort(r.Port), r.Proto)
}

func sortedEgressGrants(grants []EgressGrant) []EgressGrant {
	out := make([]EgressGrant, len(grants))
	copy(out, grants)
	sort.SliceStable(out, func(i, j int) bool {
		return egressSortKey(out[i]) < egressSortKey(out[j])
	})
	return out
}

func egressSortKey(g EgressGrant) string {
	return fmt.Sprintf("%s|%05d|%s", g.Destination, normalizeSortPort(g.Port), g.Proto)
}

// normalizeSortPort maps PortAll (-1) to a high sentinel so it sorts last, deterministically.
func normalizeSortPort(port int) int {
	if port == PortAll {
		return 65536
	}
	return port
}
