package network

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// fakeNft is an in-memory nftables seam for the node-firewall apply path: ApplyRuleset records the
// applied bytes (and serves them back as the "live" table), letting the apply→list→verify chain run in
// the harness with NO root / NO real nft. A test can also override the served table to simulate a
// tampered/divergent live table (the fail-closed case the verifier must catch).
type fakeNft struct {
	applied      []byte
	applyErr     error
	listErr      error
	listOverride []byte // when non-nil, ListTable returns THIS instead of the applied ruleset
	applyCalls   int
	listCalls    int
}

func (f *fakeNft) ApplyRuleset(ruleset []byte) error {
	f.applyCalls++
	if f.applyErr != nil {
		return f.applyErr
	}
	f.applied = append([]byte(nil), ruleset...)
	return nil
}

func (f *fakeNft) ListTable(family, table string) ([]byte, error) {
	f.listCalls++
	if f.listErr != nil {
		return nil, f.listErr
	}
	if f.listOverride != nil {
		return f.listOverride, nil
	}
	return f.applied, nil
}

// TestApplyNodeFirewallWiresApplyVerifyAndMarker is the PROVING test for finding #2: the node firewall
// is genuinely WIRED — Render → Apply(nft) → List(live) → Verify → witness marker. The pre-fix code had
// RenderNodeFirewall/VerifyNodeFirewall with NO callers; this exercises the apply path end-to-end.
func TestApplyNodeFirewallWiresApplyVerifyAndMarker(t *testing.T) {
	nft := &fakeNft{}
	cfg := NodeFirewallConfig{
		Policy: policyAllowing(allowRule(ProtoTCP, 8443, "10.0.0.0/8", "eth0")),
	}

	result, err := ApplyNodeFirewall(nft, cfg)
	if err != nil {
		t.Fatalf("ApplyNodeFirewall: %v", err)
	}

	// The ruleset was actually applied AND the live table was listed for verification.
	if nft.applyCalls != 1 {
		t.Fatalf("expected exactly one apply, got %d", nft.applyCalls)
	}
	if nft.listCalls != 1 {
		t.Fatalf("expected exactly one list (verification), got %d", nft.listCalls)
	}

	// The applied ruleset is the default-deny posture.
	applied := string(nft.applied)
	if !strings.Contains(applied, "hook input priority filter; policy drop;") {
		t.Fatalf("applied ruleset is not default-deny:\n%s", applied)
	}
	if !strings.Contains(applied, "tcp dport 7443 accept") {
		t.Fatalf("applied ruleset missing owner-token TLS ingress:\n%s", applied)
	}

	// The verdict is a clean pass.
	if result.Verdict.DefaultDeny != nodeFirewallDropEnforced || !result.Verdict.OwnerIngress || result.Verdict.Status != nodeFirewallStatusOK {
		t.Fatalf("verdict not a clean default-deny pass: %+v", result.Verdict)
	}

	// The boot witness marker carries the contract-required tokens.
	if !strings.Contains(result.Marker, "VITA-NODE-FIREWALL: default=deny owner_ingress=OK") {
		t.Fatalf("witness marker missing required tokens: %q", result.Marker)
	}
	if !strings.Contains(result.Marker, "status=OK") {
		t.Fatalf("witness marker missing status=OK: %q", result.Marker)
	}
	if !strings.Contains(result.Marker, "granted_ingress=1") {
		t.Fatalf("witness marker should report the granted ingress: %q", result.Marker)
	}
}

// TestApplyNodeFirewallFailsClosedOnTamperedLiveTable proves the apply path independently VERIFIES the
// live table and fails closed when it diverges from the applied posture (e.g. another actor downgraded
// the input chain to policy accept). No success marker is produced.
func TestApplyNodeFirewallFailsClosedOnTamperedLiveTable(t *testing.T) {
	tampered := strings.Join([]string{
		"table inet vita_node_face {",
		"  chain input {",
		"    type filter hook input priority filter; policy accept;", // downgraded
		"    iifname \"lo\" accept",
		"    ct state established,related accept",
		"    tcp dport 7443 accept",
		"  }",
		"}",
	}, "\n")
	nft := &fakeNft{listOverride: []byte(tampered)}

	result, err := ApplyNodeFirewall(nft, NodeFirewallConfig{})
	if err == nil {
		t.Fatalf("ApplyNodeFirewall accepted a tampered live table (must fail closed); marker=%q", result.Marker)
	}
	if result.Marker != "" {
		t.Fatalf("a failed apply must not produce a success marker, got %q", result.Marker)
	}
}

// TestApplyNodeFirewallPropagatesApplyError proves an nft apply error is surfaced (fail-closed), not
// swallowed — a node that cannot install the ruleset must not claim a default-deny posture.
func TestApplyNodeFirewallPropagatesApplyError(t *testing.T) {
	sentinel := errors.New("nft apply boom")
	nft := &fakeNft{applyErr: sentinel}

	if _, err := ApplyNodeFirewall(nft, NodeFirewallConfig{}); err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("expected the apply error to propagate, got %v", err)
	}
	if nft.listCalls != 0 {
		t.Fatal("verification must not run after an apply failure")
	}
}

// TestProvisionNodeFirewallRendersFromLivePolicy proves the boot convenience reads the node's persisted
// allow-list and applies a firewall that opens the owner ingress + the granted port — and that with NO
// persisted policy it still applies the safe owner-ingress-only default-deny base.
func TestProvisionNodeFirewallRendersFromLivePolicy(t *testing.T) {
	ctx := context.Background()

	// (1) No persisted policy → owner-ingress-only default-deny base, still applied + verified.
	emptyCap := newCapability(newMemoryFileSystem(nil))
	nftEmpty := &fakeNft{}
	res, err := ProvisionNodeFirewall(ctx, emptyCap, nftEmpty, 0)
	if err != nil {
		t.Fatalf("ProvisionNodeFirewall(empty policy): %v", err)
	}
	if !strings.Contains(string(nftEmpty.applied), "tcp dport 7443 accept") {
		t.Fatalf("empty-policy firewall did not open the owner ingress:\n%s", nftEmpty.applied)
	}
	if res.Verdict.GrantedIngress != 0 {
		t.Fatalf("empty policy should grant no explicit ingress, got %d", res.Verdict.GrantedIngress)
	}

	// (2) A persisted policy granting 9443/tcp → that port is opened under the default-deny base.
	policyJSON := []byte(`{"allow":[{"proto":"tcp","port":9443,"sourceCidr":"10.0.0.0/8","interface":"eth0"}]}`)
	cap2 := newCapability(newMemoryFileSystem(policyJSON))
	nft2 := &fakeNft{}
	res2, err := ProvisionNodeFirewall(ctx, cap2, nft2, 0)
	if err != nil {
		t.Fatalf("ProvisionNodeFirewall(with policy): %v", err)
	}
	applied := string(nft2.applied)
	if !strings.Contains(applied, "dport 9443 accept") {
		t.Fatalf("granted ingress 9443 not applied:\n%s", applied)
	}
	if !strings.Contains(applied, "tcp dport 7443 accept") {
		t.Fatalf("owner ingress still required:\n%s", applied)
	}
	if res2.Verdict.GrantedIngress != 1 {
		t.Fatalf("expected 1 granted ingress, got %d", res2.Verdict.GrantedIngress)
	}
}
