package mesh

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"

	"github.com/vita/agent/capabilities/network"
	"github.com/vita/agent/internal/sysdeps"
)

func TestApplyComposesWireGuardAndDefaultDenyNftFromValidatedConfig(t *testing.T) {
	ctx := context.Background()
	keyRoot := filepath.ToSlash(filepath.Join(t.TempDir(), "keys"))
	privateKeyText := testKeyText(0x41)
	privateKeyRef := writeTestPrivateKey(t, keyRoot, "node.key", privateKeyText)
	keepalive := 25
	config := MeshConfig{
		PrivateKeyRef: privateKeyRef,
		ListenPort:    51820,
		InterfaceCIDR: "10.77.0.0/24",
		Peers: []MeshPeer{
			{
				PublicKey:           testKeyText(0x22),
				AllowedIPs:          []string{"10.77.0.2/32"},
				Endpoint:            "192.0.2.2:51821",
				PersistentKeepalive: &keepalive,
				Services: []MeshService{
					{Proto: network.ProtoTCP, Port: 22},
				},
			},
		},
	}
	system := newRecordingMeshSystem()
	capability := newCapability(system, keyRoot)

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: &config})
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo")
	}

	wantOps := []string{
		"delete-nft:inet:vita_mesh",
		"create-wg:vita-mesh0",
		"set-key:vita-mesh0:51820",
		"replace-peers:vita-mesh0:1",
		"add-ip:vita-mesh0:10.77.0.1/24",
		"apply-nft",
		"link-up:vita-mesh0",
		"wg-device:vita-mesh0",
		"list-nft:inet:vita_mesh",
	}
	if !reflect.DeepEqual(system.ops, wantOps) {
		t.Fatalf("ops = %#v, want %#v", system.ops, wantOps)
	}
	privateKeyBytes, err := base64.StdEncoding.DecodeString(privateKeyText)
	if err != nil {
		t.Fatalf("test private key did not decode: %v", err)
	}
	if !reflect.DeepEqual(system.privateKey, privateKeyBytes) {
		t.Fatal("private key bytes were not loaded from the keyfile")
	}
	if strings.Contains(string(system.ruleset), privateKeyText) {
		t.Fatal("nft ruleset contains private key material")
	}
	if len(system.peers) != 1 {
		t.Fatalf("peers = %d, want 1", len(system.peers))
	}
	gotPeer := system.peers[0]
	if gotPeer == nil {
		t.Fatal("peer entry is nil")
	}
	if gotPeer.Endpoint != "192.0.2.2:51821" {
		t.Fatalf("peer endpoint = %q, want normalized endpoint", gotPeer.Endpoint)
	}
	if gotPeer.PersistentKeepalive == nil || *gotPeer.PersistentKeepalive != keepalive {
		t.Fatalf("peer keepalive = %v, want %d", gotPeer.PersistentKeepalive, keepalive)
	}
	if !reflect.DeepEqual(gotPeer.AllowedIPs, []string{"10.77.0.2/32"}) {
		t.Fatalf("AllowedIPs = %#v, want canonical peer source", gotPeer.AllowedIPs)
	}

	ruleset := string(system.ruleset)
	for _, want := range []string{
		"table inet vita_mesh",
		"type filter hook input priority filter; policy drop;",
		"iifname != \"vita-mesh0\" accept",
		"ct state established,related accept",
		"iifname \"vita-mesh0\" ip saddr 10.77.0.2/32 tcp dport 22 accept",
	} {
		if !strings.Contains(ruleset, want) {
			t.Fatalf("ruleset missing %q:\n%s", want, ruleset)
		}
	}
	for _, forbidden := range []string{"policy accept", "0.0.0.0/0", "dport 23", "accept all"} {
		if strings.Contains(ruleset, forbidden) {
			t.Fatalf("ruleset contains forbidden %q:\n%s", forbidden, ruleset)
		}
	}

	response, err := capability.Handle(ctx, ReadRequest{})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	readResponse, ok := response.(ReadResponse)
	if !ok {
		t.Fatalf("Handle returned %T, want ReadResponse", response)
	}
	if !readResponse.Applied || readResponse.Status == nil || readResponse.Status.Drop != meshDropEnforced {
		t.Fatalf("read response = %#v, want applied default-drop status", readResponse)
	}
	if readResponse.Config == nil || readResponse.Config.PrivateKeyRef != privateKeyRef {
		t.Fatalf("read config = %#v, want keyfile reference only", readResponse.Config)
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if system.linkCreated || system.nftApplied {
		t.Fatalf("teardown leaked link=%v nft=%v", system.linkCreated, system.nftApplied)
	}
	response, err = capability.Handle(ctx, ReadRequest{})
	if err != nil {
		t.Fatalf("Handle after undo returned error: %v", err)
	}
	readResponse, ok = response.(ReadResponse)
	if !ok {
		t.Fatalf("Handle after undo returned %T, want ReadResponse", response)
	}
	if readResponse.Applied {
		t.Fatalf("read response after undo = %#v, want absent mesh state", readResponse)
	}
}

func TestApplyRejectsInvalidMeshConfigBeforeTouchingInterface(t *testing.T) {
	keyRoot := filepath.ToSlash(filepath.Join(t.TempDir(), "keys"))
	privateKeyRef := writeTestPrivateKey(t, keyRoot, "node.key", testKeyText(0x42))
	base := validMeshConfig(privateKeyRef)

	tests := []struct {
		name   string
		mutate func(*MeshConfig)
		want   string
	}{
		{
			name: "wide open v4 allowed IP",
			mutate: func(config *MeshConfig) {
				config.Peers[0].AllowedIPs = []string{"0.0.0.0/0"}
			},
			want: "opens all sources",
		},
		{
			name: "wide open v6 allowed IP",
			mutate: func(config *MeshConfig) {
				config.Peers[0].AllowedIPs = []string{"::/0"}
			},
			want: "opens all sources",
		},
		{
			name: "inline private key",
			mutate: func(config *MeshConfig) {
				config.PrivateKeyRef = testKeyText(0x43)
			},
			want: "not inline key bytes",
		},
		{
			name: "undeclared services",
			mutate: func(config *MeshConfig) {
				config.Peers[0].Services = nil
			},
			want: "services must declare",
		},
		{
			name: "out of range service port",
			mutate: func(config *MeshConfig) {
				config.Peers[0].Services = []MeshService{{Proto: network.ProtoTCP, Port: 65536}}
			},
			want: "port must be 1-65535",
		},
		{
			name: "PortAll service rejected",
			mutate: func(config *MeshConfig) {
				config.Peers[0].Services = []MeshService{{Proto: network.ProtoTCP, Port: network.PortAll}}
			},
			want: "port must be 1-65535",
		},
		{
			name: "host-bit-smuggled CIDR",
			mutate: func(config *MeshConfig) {
				config.Peers[0].AllowedIPs = []string{"10.77.0.2/24"}
			},
			want: "canonical CIDR",
		},
		{
			name: "bad public key length",
			mutate: func(config *MeshConfig) {
				config.Peers[0].PublicKey = "abcd"
			},
			want: "44 base64",
		},
		{
			name: "bad public key base64",
			mutate: func(config *MeshConfig) {
				config.Peers[0].PublicKey = strings.Repeat("!", meshKeyBase64Length)
			},
			want: "valid base64",
		},
		{
			name: "raw text in endpoint",
			mutate: func(config *MeshConfig) {
				config.Peers[0].Endpoint = "192.0.2.2:51821\nadd rule inet x y accept"
			},
			want: "unsafe",
		},
		{
			name: "bad listen port",
			mutate: func(config *MeshConfig) {
				config.ListenPort = 0
			},
			want: "listenPort",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			config := cloneMeshConfig(&base)
			if config == nil {
				t.Fatal("cloneMeshConfig returned nil")
			}
			tt.mutate(config)
			system := newRecordingMeshSystem()
			capability := newCapability(system, keyRoot)

			undo, err := capability.Apply(context.Background(), ApplyRequest{Desired: config})
			if undo != nil {
				t.Fatalf("Apply returned undo %v, want nil", undo)
			}
			var invalid *InvalidRequestError
			if !errors.As(err, &invalid) {
				t.Fatalf("Apply error = %T %v, want InvalidRequestError", err, err)
			}
			if !strings.Contains(invalid.Reason, tt.want) {
				t.Fatalf("invalid reason = %q, want it to contain %q", invalid.Reason, tt.want)
			}
			if len(system.ops) != 0 {
				t.Fatalf("system ops = %#v, want no privileged calls before validation rejects", system.ops)
			}
		})
	}
}

func TestSetupFailureCleansUpAndReportsSpecificErrno(t *testing.T) {
	ctx := context.Background()
	keyRoot := filepath.ToSlash(filepath.Join(t.TempDir(), "keys"))
	privateKeyRef := writeTestPrivateKey(t, keyRoot, "node.key", testKeyText(0x44))
	system := newRecordingMeshSystem()
	system.failApplyNft = syscall.EPERM
	capability := newCapability(system, keyRoot)

	undo, err := capability.Apply(ctx, ApplyRequest{Desired: ptrMeshConfig(validMeshConfig(privateKeyRef))})
	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil", undo)
	}
	if err == nil {
		t.Fatal("Apply returned nil error, want simulated nft failure")
	}
	if reason := meshFailureReason(err); reason != "mesh_nft_apply_EPERM" {
		t.Fatalf("meshFailureReason = %q, want mesh_nft_apply_EPERM", reason)
	}
	if system.linkCreated || system.nftApplied {
		t.Fatalf("failed setup leaked link=%v nft=%v", system.linkCreated, system.nftApplied)
	}
	if !containsOp(system.ops, "delete-link:vita-mesh0") {
		t.Fatalf("ops = %#v, want cleanup delete-link", system.ops)
	}
}

func TestVerifyMeshNftTableRejectsOpenOrIncompleteRulesets(t *testing.T) {
	keyRoot := filepath.ToSlash(filepath.Join(t.TempDir(), "keys"))
	privateKeyRef := filepath.ToSlash(filepath.Join(keyRoot, "node.key"))
	config, err := normalizeMeshConfig(validMeshConfig(privateKeyRef), keyRoot)
	if err != nil {
		t.Fatalf("normalizeMeshConfig returned error: %v", err)
	}
	ruleset := string(renderMeshRuleset(config))
	if err := verifyMeshNftTable(config, ruleset); err != nil {
		t.Fatalf("verifyMeshNftTable rejected generated ruleset: %v", err)
	}
	if err := verifyMeshNftTable(config, strings.Replace(ruleset, "policy drop", "policy accept", 1)); err == nil {
		t.Fatal("verifyMeshNftTable accepted an allow-all base chain")
	}
	if err := verifyMeshNftTable(config, strings.Replace(ruleset, "iifname \"vita-mesh0\" ip saddr", "ip saddr", 1)); err == nil {
		t.Fatal("verifyMeshNftTable accepted a no-interface-filter service rule")
	}
	if err := verifyMeshNftTable(config, strings.Replace(ruleset, "tcp dport 22 accept", "tcp dport 23 accept", 1)); err == nil {
		t.Fatal("verifyMeshNftTable accepted a missing declared service port")
	}
}

func TestConfigAndRulesDoNotCarryPrivateKeyBytes(t *testing.T) {
	keyRoot := filepath.ToSlash(filepath.Join(t.TempDir(), "keys"))
	privateKeyText := testKeyText(0x45)
	privateKeyRef := writeTestPrivateKey(t, keyRoot, "node.key", privateKeyText)
	config := validMeshConfig(privateKeyRef)
	normalized, err := normalizeMeshConfig(config, keyRoot)
	if err != nil {
		t.Fatalf("normalizeMeshConfig returned error: %v", err)
	}

	if strings.Contains(string(renderMeshConfig(config)), privateKeyText) {
		t.Fatal("rendered config contains private key bytes")
	}
	if strings.Contains(string(renderMeshRuleset(normalized)), privateKeyText) {
		t.Fatal("rendered nft ruleset contains private key bytes")
	}
}

func validMeshConfig(privateKeyRef string) MeshConfig {
	return MeshConfig{
		PrivateKeyRef: privateKeyRef,
		ListenPort:    51820,
		InterfaceCIDR: "10.77.0.0/24",
		Peers: []MeshPeer{
			{
				PublicKey:  testKeyText(0x21),
				AllowedIPs: []string{"10.77.0.2/32"},
				Services: []MeshService{
					{Proto: network.ProtoTCP, Port: 22},
				},
			},
		},
	}
}

func ptrMeshConfig(config MeshConfig) *MeshConfig {
	return &config
}

func writeTestPrivateKey(t *testing.T, root string, name string, keyText string) string {
	t.Helper()
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatalf("MkdirAll key root returned error: %v", err)
	}
	path := filepath.Join(root, name)
	if err := os.WriteFile(path, []byte(keyText+"\n"), 0o600); err != nil {
		t.Fatalf("WriteFile key returned error: %v", err)
	}
	return filepath.ToSlash(path)
}

func testKeyText(seed byte) string {
	raw := make([]byte, meshPrivateKeyBytes)
	for i := range raw {
		raw[i] = seed + byte(i%7)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func containsOp(ops []string, want string) bool {
	for _, op := range ops {
		if op == want {
			return true
		}
	}
	return false
}

type recordingMeshSystem struct {
	ops          []string
	privateKey   []byte
	listenPort   int
	peers        []*sysdeps.WireGuardPeer
	ruleset      []byte
	linkCreated  bool
	nftApplied   bool
	failApplyNft error
}

func newRecordingMeshSystem() *recordingMeshSystem {
	return &recordingMeshSystem{}
}

func (s *recordingMeshSystem) CreateWireGuardLink(name string) error {
	s.ops = append(s.ops, "create-wg:"+name)
	s.linkCreated = true
	return nil
}

func (s *recordingMeshSystem) SetWireGuardPrivateKey(name string, privateKey []byte, listenPort int) error {
	s.ops = append(s.ops, "set-key:"+name+":"+strconvItoa(listenPort))
	s.privateKey = cloneBytes(privateKey)
	s.listenPort = listenPort
	return nil
}

func (s *recordingMeshSystem) ReplaceWireGuardPeers(name string, peers []sysdeps.WireGuardPeer) error {
	s.ops = append(s.ops, "replace-peers:"+name+":"+strconvItoa(len(peers)))
	s.peers = make([]*sysdeps.WireGuardPeer, len(peers))
	for i := range peers {
		peer := peers[i]
		peer.PublicKey = cloneBytes(peer.PublicKey)
		peer.AllowedIPs = cloneStrings(peer.AllowedIPs)
		peer.PersistentKeepalive = cloneIntPtr(peer.PersistentKeepalive)
		s.peers[i] = &peer
	}
	return nil
}

func (s *recordingMeshSystem) AddIPAddress(name string, cidr string) error {
	s.ops = append(s.ops, "add-ip:"+name+":"+cidr)
	return nil
}

func (s *recordingMeshSystem) SetLinkUp(name string) error {
	s.ops = append(s.ops, "link-up:"+name)
	return nil
}

func (s *recordingMeshSystem) DeleteLink(name string) error {
	s.ops = append(s.ops, "delete-link:"+name)
	s.linkCreated = false
	return nil
}

func (s *recordingMeshSystem) ApplyNftRuleset(ruleset []byte) error {
	s.ops = append(s.ops, "apply-nft")
	if s.failApplyNft != nil {
		return s.failApplyNft
	}
	s.ruleset = cloneBytes(ruleset)
	s.nftApplied = true
	return nil
}

func (s *recordingMeshSystem) ListNftTable(family string, table string) ([]byte, error) {
	s.ops = append(s.ops, "list-nft:"+family+":"+table)
	return cloneBytes(s.ruleset), nil
}

func (s *recordingMeshSystem) DeleteNftTable(family string, table string) error {
	s.ops = append(s.ops, "delete-nft:"+family+":"+table)
	s.nftApplied = false
	return nil
}

func (s *recordingMeshSystem) WireGuardDevice(name string) (sysdeps.WireGuardDeviceStatus, error) {
	s.ops = append(s.ops, "wg-device:"+name)
	status := sysdeps.WireGuardDeviceStatus{
		Name:       name,
		ListenPort: s.listenPort,
		Peers:      make([]sysdeps.WireGuardPeerStatus, len(s.peers)),
	}
	for i, peer := range s.peers {
		if peer == nil {
			continue
		}
		status.Peers[i] = sysdeps.WireGuardPeerStatus{
			PublicKey:  cloneBytes(peer.PublicKey),
			AllowedIPs: cloneStrings(peer.AllowedIPs),
		}
	}
	return status, nil
}

func strconvItoa(value int) string {
	return strconv.FormatInt(int64(value), 10)
}
