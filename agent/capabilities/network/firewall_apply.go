package network

import (
	"context"
	"errors"
	"fmt"

	"github.com/vita/agent/internal/sysdeps"
)

// firewall_apply.go is the WIRING that makes the node-face default-deny firewall ENFORCED, not just
// renderable. firewall.go is pure (Render/Verify produce/check a ruleset with no I/O); this file is the
// effectful apply path the agentd boot calls: it hands the rendered ruleset to nftables, lists the live
// table back, verifies the live posture matches the config (fail-closed), and returns the boot WITNESS
// the marker layer prints. It mirrors the WIRED capsule-egress idiom (capsule/egress.go:248,288 —
// sysdeps.ApplyNftRuleset(render(...)) then sysdeps.ListNftTable(...) + verify).
//
// The nft operations go through the NodeFirewallNft seam so the apply path is testable in the harness /
// go-in-docker WITHOUT root (a fake records the applied ruleset and returns it as the "live" table).

// NodeFirewallNft is the minimal nftables seam the node-firewall apply path needs: apply a rendered
// ruleset and list a table back. The production implementation (DefaultNodeFirewallNft) delegates to the
// build-tagged sysdeps package; tests inject a fake.
type NodeFirewallNft interface {
	// ApplyRuleset applies a rendered nftables ruleset (`nft -f -` semantics).
	ApplyRuleset(ruleset []byte) error
	// ListTable returns the live `nft list table <family> <table>` output for verification.
	ListTable(family, table string) ([]byte, error)
}

// DefaultNodeFirewallNft routes to the real sysdeps (linux: nft; stub: ErrUnsupported). This is what
// agentd uses on a real node.
type DefaultNodeFirewallNft struct{}

// ApplyRuleset applies the ruleset via sysdeps.ApplyNftRuleset.
func (DefaultNodeFirewallNft) ApplyRuleset(ruleset []byte) error {
	return sysdeps.ApplyNftRuleset(ruleset)
}

// ListTable lists the table via sysdeps.ListNftTable.
func (DefaultNodeFirewallNft) ListTable(family, table string) ([]byte, error) {
	return sysdeps.ListNftTable(family, table)
}

// NodeFirewallApplyResult is the outcome of an apply+verify pass: the structured verdict plus the boot
// witness marker line the caller prints to the serial console. Marker shape:
//
//	VITA-NODE-FIREWALL: default=deny owner_ingress=OK[ egress=deny][ granted_ingress=N] status=OK
//
// (the contract's required `default=deny owner_ingress=OK` tokens are always present on success).
type NodeFirewallApplyResult struct {
	Verdict NodeFirewallVerdict
	Marker  string
}

// ApplyNodeFirewall renders the node-face default-deny firewall from `config`, applies it via `nft`,
// lists the LIVE table back, and verifies the live posture matches the config. Fail-closed: any
// render/apply/list/verify error is returned and NO success marker is produced — a node that cannot
// prove its firewall is default-deny must not claim it is. On success it returns the verdict + the boot
// witness marker.
//
// `nft` is the nftables seam; pass DefaultNodeFirewallNft{} on a real node, or a fake in tests.
func ApplyNodeFirewall(nft NodeFirewallNft, config NodeFirewallConfig) (NodeFirewallApplyResult, error) {
	if nft == nil {
		return NodeFirewallApplyResult{}, errors.New("node firewall: nil nft seam")
	}

	// Render (validates the config + produces the byte-stable default-deny ruleset).
	ruleset, err := RenderNodeFirewall(config)
	if err != nil {
		return NodeFirewallApplyResult{}, fmt.Errorf("render node firewall: %w", err)
	}

	// Apply to the live ruleset.
	if err := nft.ApplyRuleset(ruleset); err != nil {
		return NodeFirewallApplyResult{}, fmt.Errorf("apply node firewall ruleset: %w", err)
	}

	// List the LIVE table and verify it matches — this is the independent check that the kernel actually
	// holds the default-deny posture (an apply that silently no-ops, or a tampered table, fails here).
	live, err := nft.ListTable(nodeFirewallFamily, NodeFirewallTable)
	if err != nil {
		return NodeFirewallApplyResult{}, fmt.Errorf("list live node firewall table: %w", err)
	}

	verdict, err := VerifyNodeFirewall(config, string(live))
	if err != nil {
		return NodeFirewallApplyResult{}, fmt.Errorf("verify live node firewall: %w", err)
	}
	if verdict.Status != nodeFirewallStatusOK {
		return NodeFirewallApplyResult{}, fmt.Errorf("node firewall verify did not reach OK: %+v", verdict)
	}

	return NodeFirewallApplyResult{Verdict: verdict, Marker: nodeFirewallMarker(verdict)}, nil
}

// ProvisionNodeFirewall is the boot convenience agentd calls: read the node's live inbound allow-list
// from the network capability, build the node-firewall config (always opening the owner-token TLS
// ingress), then apply+verify it. The owner ingress port is fixed at the platform default
// (OwnerTokenTLSIngressPort) unless overridden. Egress stays open by default (the node initiates its own
// sync/update) — egress default-deny remains an explicit owner opt-in elsewhere.
//
// Returns the apply result (verdict + witness marker) or an error. agentd logs the marker on success and
// the error on failure; whether a firewall failure is fatal at boot is the caller's policy.
func ProvisionNodeFirewall(ctx context.Context, capability *Capability, nft NodeFirewallNft, ownerIngressPort int) (NodeFirewallApplyResult, error) {
	if capability == nil {
		return NodeFirewallApplyResult{}, errors.New("node firewall: nil network capability")
	}

	policy, err := capability.CurrentPolicy(ctx)
	if err != nil {
		return NodeFirewallApplyResult{}, fmt.Errorf("load node network policy: %w", err)
	}

	config := NodeFirewallConfig{
		Policy:           policy,
		OwnerIngressPort: ownerIngressPort, // 0 → OwnerTokenTLSIngressPort (resolved in render/verify)
	}
	return ApplyNodeFirewall(nft, config)
}

// nodeFirewallMarker builds the boot witness line from a passing verdict. The contract requires the
// `default=deny owner_ingress=OK` tokens; egress + granted-ingress are appended when present so the
// witness reflects the full posture.
func nodeFirewallMarker(verdict NodeFirewallVerdict) string {
	owner := "FAIL"
	if verdict.OwnerIngress {
		owner = "OK"
	}
	deny := "deny"
	if verdict.DefaultDeny != nodeFirewallDropEnforced {
		deny = "OPEN"
	}

	marker := fmt.Sprintf("VITA-NODE-FIREWALL: default=%s owner_ingress=%s", deny, owner)
	if verdict.GrantedIngress > 0 {
		marker += fmt.Sprintf(" granted_ingress=%d", verdict.GrantedIngress)
	}
	if verdict.EgressDeny == nodeFirewallDropEnforced {
		marker += " egress=deny"
	}
	marker += fmt.Sprintf(" status=%s", verdict.Status)
	return marker
}
