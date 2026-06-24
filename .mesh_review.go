package mesh

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/capabilities/network"
	"github.com/vita/agent/internal/jsonsafe"
	"github.com/vita/agent/internal/sysdeps"
	"github.com/vita/agent/transaction"
)

const (
	Name = "mesh.config"

	defaultInterfaceName = "vita-mesh0"
	defaultNftFamily     = "inet"
	defaultNftTable      = "vita_mesh"
	defaultKeyRoot       = "/var/lib/vita-agent/mesh/keys"

	meshPrivateKeyBytes = 32
	meshPublicKeyBytes  = 32
	meshKeyBase64Length = 44
	meshPrivateKeyMax   = 4096

	meshDropEnforced = "enforced"
	meshHandshakeOK  = "OK"
	meshReachOK      = "OK"
	meshStatusOK     = "OK"
	meshStatusFail   = "FAIL"
)

type MeshConfig struct {
	PrivateKeyRef string     `json:"privateKeyRef"`
	ListenPort    int        `json:"listenPort"`
	InterfaceCIDR string     `json:"interfaceCidr"`
	Peers         []MeshPeer `json:"peers"`
}

type MeshPeer struct {
	PublicKey           string        `json:"publicKey"`
	AllowedIPs          []string      `json:"allowedIps"`
	Endpoint            string        `json:"endpoint,omitempty"`
	PersistentKeepalive *int          `json:"persistentKeepalive,omitempty"`
	Services            []MeshService `json:"services"`
}

type MeshService struct {
	Proto network.Protocol `json:"proto"`
	Port  int              `json:"port"`
}

type ApplyRequest struct {
	Desired *MeshConfig `json:"desired"`
}

func (ApplyRequest) CapabilityRequest() {}

func (r *ApplyRequest) UnmarshalJSON(raw []byte) error {
	type applyRequestJSON ApplyRequest
	var decoded applyRequestJSON
	if err := jsonsafe.DecodeStrict(raw, &decoded); err != nil {
		return err
	}

	*r = ApplyRequest(decoded)
	return nil
}

func (r ApplyRequest) Validate() error {
	if r.Desired == nil {
		return &InvalidRequestError{Reason: "desired is required"}
	}
	_, err := normalizeMeshConfig(*r.Desired, defaultKeyRoot)
	return err
}

type ReadRequest struct{}

func (ReadRequest) CapabilityRequest() {}

func (ReadRequest) Validate() error { return nil }

type ReadResponse struct {
	Applied bool        `json:"applied"`
	Config  *MeshConfig `json:"config,omitempty"`
	Status  *MeshStatus `json:"status,omitempty"`
}

func (ReadResponse) CapabilityResponse() {}

type MeshStatus struct {
	Interface string `json:"interface"`
	Peers     int    `json:"peers"`
	Handshake string `json:"handshake,omitempty"`
	Reach     string `json:"reach,omitempty"`
	Denied    string `json:"denied,omitempty"`
	Drop      string `json:"drop,omitempty"`
	Status    string `json:"status"`
}

type Capability struct {
	system  meshSystem
	keyRoot string

	mu             sync.Mutex
	lastConfig     *MeshConfig
	lastNormalized *normalizedMeshConfig
	lastStatus     *MeshStatus
}

type meshSystem interface {
	CreateWireGuardLink(string) error
	SetWireGuardPrivateKey(string, []byte, int) error
	ReplaceWireGuardPeers(string, []sysdeps.WireGuardPeer) error
	AddIPAddress(string, string) error
	SetLinkUp(string) error
	DeleteLink(string) error
	ApplyNftRuleset([]byte) error
	ListNftTable(string, string) ([]byte, error)
	DeleteNftTable(string, string) error
	WireGuardDevice(string) (sysdeps.WireGuardDeviceStatus, error)
}

type defaultMeshSystem struct{}

type normalizedMeshConfig struct {
	PrivateKeyRef       string
	ListenPort          int
	InterfaceName       string
	InterfacePrefix     netip.Prefix
	InterfaceAddress    string
	NftFamily           string
	NftTable            string
	Peers               []normalizedMeshPeer
	ExpectedPeerKeyList []string
}

type normalizedMeshPeer struct {
	PublicKey           string
	PublicKeyBytes      []byte
	AllowedIPs          []string
	Endpoint            string
	PersistentKeepalive *int
	Services            []MeshService
}

type InvalidRequestError struct {
	Reason string
}

func (e *InvalidRequestError) Error() string {
	return fmt.Sprintf("invalid mesh request: %s", e.Reason)
}

func (e *InvalidRequestError) ApplyErrorCode() string {
	return "mesh_rejected"
}

type stepFailure struct {
	Step string
	Err  error
}

func (e *stepFailure) Error() string {
	if e == nil {
		return "mesh step failed"
	}
	if e.Err == nil {
		return e.Step
	}
	return e.Step + ": " + e.Err.Error()
}

func (e *stepFailure) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func (e *stepFailure) ApplyErrorCode() string {
	if e == nil || e.Step == "" {
		return "mesh_unknown"
	}
	reason := "mesh_" + e.Step
	if errno := sysdeps.ErrnoCode(e.Err); errno != "" {
		reason += "_" + errno
	}
	return reason
}

func NewCapability() *Capability {
	return newCapability(defaultMeshSystem{}, defaultKeyRoot)
}

func newCapability(system meshSystem, keyRoot string) *Capability {
	if keyRoot == "" {
		keyRoot = defaultKeyRoot
	}
	return &Capability{system: system, keyRoot: filepath.Clean(keyRoot)}
}

func (c *Capability) Name() string {
	return Name
}

func (c *Capability) Handle(ctx context.Context, req capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	if _, ok := req.(ReadRequest); !ok {
		return nil, &InvalidRequestError{Reason: "expected mesh.ReadRequest"}
	}
	if c == nil {
		return nil, &InvalidRequestError{Reason: "missing mesh capability"}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	c.mu.Lock()
	config := cloneMeshConfig(c.lastConfig)
	normalized := c.lastNormalized
	applied := c.lastStatus != nil
	c.mu.Unlock()

	if !applied || normalized == nil {
		return ReadResponse{Applied: false}, nil
	}

	// Re-measure live mesh state at read time so the marker reflects the
	// CURRENT measured handshake/reach/denied (a peer typically completes its
	// handshake after Apply, so a cached Apply-time snapshot would never show a
	// real handshake). measureStatus reads only live kernel + nft state; it
	// never synthesizes the verification fields.
	status := c.measureStatus(*normalized)

	c.mu.Lock()
	if c.lastStatus != nil && c.lastNormalized != nil && c.lastNormalized.InterfaceName == normalized.InterfaceName {
		stored := status
		c.lastStatus = &stored
	}
	c.mu.Unlock()

	return ReadResponse{
		Applied: true,
		Config:  config,
		Status:  &status,
	}, nil
}

func (c *Capability) Apply(ctx context.Context, req capabilities.TypedRequest) (transaction.Undo, error) {
	applyReq, ok := req.(ApplyRequest)
	if !ok {
		return nil, &InvalidRequestError{Reason: "expected mesh.ApplyRequest"}
	}
	if c == nil || c.system == nil {
		return nil, &InvalidRequestError{Reason: "missing mesh dependency"}
	}
	if applyReq.Desired == nil {
		return nil, &InvalidRequestError{Reason: "desired is required"}
	}

	normalized, err := normalizeMeshConfig(*applyReq.Desired, c.keyRoot)
	if err != nil {
		return nil, err
	}
	privateKey, err := readPrivateKey(ctx, normalized.PrivateKeyRef)
	if err != nil {
		return nil, stepError("read_private_key", err)
	}

	if err := c.compose(ctx, normalized, privateKey); err != nil {
		// Fail-closed / no-leak: a setup error must never leave a half-changed
		// live system. Tear down whatever the partial compose created and
		// surface any teardown failure joined with the original cause so a
		// leaked link/rule can never hide behind the first error. A re-apply
		// also tears down any prior good mesh up front (see compose), so on
		// failure the only safe states are "fully torn down" or "prior intact";
		// either way the cached status no longer describes a live mesh, so it
		// is cleared to avoid reporting a stale config.
		teardownErr := c.teardown(context.Background(), normalized)
		c.clearLast(normalized.InterfaceName)
		return nil, errors.Join(err, teardownErr)
	}

	c.setLast(*applyReq.Desired, normalized, c.measureStatus(normalized))

	return undoMesh{capability: c, config: normalized}, nil
}

func (c *Capability) compose(ctx context.Context, config normalizedMeshConfig, privateKey []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	// Transactional re-apply: a mesh always uses the same fixed interface name
	// and nft table, so applying over an existing mesh is a full replace. Tear
	// down BOTH the existing link and the existing nft table up front so the
	// rebuild starts from a clean slate. This removes the previous
	// destructive-then-fail sequence where the nft table was deleted first and
	// CreateWireGuardLink then failed EEXIST against the still-present old link
	// (an error outcome with the live system already half-changed). Missing
	// objects are not an error (first apply, or already gone).
	if err := c.system.DeleteNftTable(config.NftFamily, config.NftTable); err != nil && !isMissingNetworkObject(err) {
		return stepError("nft_delete", err)
	}
	if err := c.system.DeleteLink(config.InterfaceName); err != nil && !isMissingNetworkObject(err) {
		return stepError("link_reset", err)
	}
	if err := c.system.CreateWireGuardLink(config.InterfaceName); err != nil {
		return stepError("link_create", err)
	}
	if err := c.system.SetWireGuardPrivateKey(config.InterfaceName, privateKey, config.ListenPort); err != nil {
		return stepError("setkey", err)
	}
	if err := c.system.ReplaceWireGuardPeers(config.InterfaceName, wireGuardPeers(config.Peers)); err != nil {
		return stepError("addpeer", err)
	}
	if err := c.system.AddIPAddress(config.InterfaceName, config.InterfaceAddress); err != nil {
		return stepError("addr_add", err)
	}
	if err := c.system.ApplyNftRuleset(renderMeshRuleset(config)); err != nil {
		return stepError("nft_apply", err)
	}
	if err := c.system.SetLinkUp(config.InterfaceName); err != nil {
		return stepError("link_up", err)
	}
	if err := c.verify(config); err != nil {
		return stepError("verify", err)
	}
	return nil
}

func (c *Capability) verify(config normalizedMeshConfig) error {
	device, err := c.system.WireGuardDevice(config.InterfaceName)
	if err != nil {
		return err
	}
	if err := verifyWireGuardDevice(config, device); err != nil {
		return err
	}
	table, err := c.system.ListNftTable(config.NftFamily, config.NftTable)
	if err != nil {
		return err
	}
	return verifyMeshNftTable(config, string(table))
}

// measureStatus reports the mesh status from REAL measured state only. The
// verification fields are never synthesized:
//   - Handshake: derived from the kernel WireGuard device — set to OK only when
//     at least one enrolled peer has a non-zero latest handshake (a real
//     WireGuard handshake actually completed, i.e. an enrolled peer connected).
//   - Reach: a reachability determination gated on a measured handshake AND the
//     live nft table actually carrying the per-peer declared-service ACCEPT
//     path (verifyMeshNftTable against the table read back from the kernel), so
//     a handshaked peer really can reach a declared service through the
//     default-deny chain.
//   - Denied: the measured count of enrolled peers that have NOT completed a
//     handshake (the denied / not-yet-reachable peer count) under an enforced
//     default-drop chain. Always present (never undefined) when a mesh is up.
//   - Drop: enforced only when the live nft chain is policy-drop with the
//     declared per-peer accepts and nothing wide-open.
//
// Any read error or a failed verification degrades the corresponding field
// fail-closed (left empty / FAIL) rather than reporting a value that was not
// measured.
func (c *Capability) measureStatus(config normalizedMeshConfig) MeshStatus {
	status := MeshStatus{
		Interface: config.InterfaceName,
		Peers:     len(config.Peers),
		Status:    meshStatusOK,
	}

	dropEnforced := false
	if table, err := c.system.ListNftTable(config.NftFamily, config.NftTable); err == nil {
		if verifyMeshNftTable(config, string(table)) == nil {
			dropEnforced = true
			status.Drop = meshDropEnforced
		}
	}

	device, err := c.system.WireGuardDevice(config.InterfaceName)
	if err != nil {
		// Cannot read the live device: report fail-closed (no handshake/reach,
		// every enrolled peer counted denied) rather than synthesizing OK.
		status.Denied = formatDeniedPeers(len(config.Peers))
		status.Status = meshStatusFail
		return status
	}

	enrolled := make(map[string]struct{}, len(config.Peers))
	for _, peer := range config.Peers {
		enrolled[peer.PublicKey] = struct{}{}
	}
	handshaked := 0
	for _, peer := range device.Peers {
		if len(peer.PublicKey) != meshPublicKeyBytes {
			continue
		}
		key := base64.StdEncoding.EncodeToString(peer.PublicKey)
		if _, ok := enrolled[key]; !ok {
			continue
		}
		if peer.LastHandshakeUnix > 0 {
			handshaked++
		}
	}

	denied := len(config.Peers) - handshaked
	if denied < 0 {
		denied = 0
	}
	status.Denied = formatDeniedPeers(denied)

	if handshaked > 0 {
		status.Handshake = meshHandshakeOK
		if dropEnforced {
			status.Reach = meshReachOK
		}
	}

	return status
}

func formatDeniedPeers(count int) string {
	return "peers:" + strconv.Itoa(count)
}

func (c *Capability) teardown(ctx context.Context, config normalizedMeshConfig) error {
	var teardownErr error
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := c.system.DeleteNftTable(config.NftFamily, config.NftTable); err != nil && !isMissingNetworkObject(err) {
		teardownErr = errors.Join(teardownErr, stepError("nft_delete", err))
	}
	if err := c.system.DeleteLink(config.InterfaceName); err != nil && !isMissingNetworkObject(err) {
		teardownErr = errors.Join(teardownErr, stepError("link_delete", err))
	}
	return teardownErr
}

func (c *Capability) setLast(config MeshConfig, normalized normalizedMeshConfig, status MeshStatus) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lastConfig = cloneMeshConfig(&config)
	normalizedCopy := normalized
	c.lastNormalized = &normalizedCopy
	c.lastStatus = &status
}

func (c *Capability) clearLast(interfaceName string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.lastNormalized != nil && c.lastNormalized.InterfaceName == interfaceName {
		c.lastConfig = nil
		c.lastNormalized = nil
		c.lastStatus = nil
	}
}

type undoMesh struct {
	capability *Capability
	config     normalizedMeshConfig
}

func (u undoMesh) Undo(ctx context.Context) error {
	if u.capability == nil {
		return &InvalidRequestError{Reason: "missing mesh capability"}
	}
	err := u.capability.teardown(ctx, u.config)
	u.capability.clearLast(u.config.InterfaceName)
	return err
}

func normalizeMeshConfig(config MeshConfig, keyRoot string) (normalizedMeshConfig, error) {
	keyRef, err := normalizePrivateKeyRef(config.PrivateKeyRef, keyRoot)
	if err != nil {
		return normalizedMeshConfig{}, err
	}
	if !validMeshPort(config.ListenPort) {
		return normalizedMeshConfig{}, &InvalidRequestError{Reason: "listenPort must be 1-65535"}
	}
	if !safeMeshString(config.InterfaceCIDR) {
		return normalizedMeshConfig{}, &InvalidRequestError{Reason: "interfaceCidr contains unsafe characters"}
	}
	interfacePrefix, err := network.NormalizeCIDR(config.InterfaceCIDR)
	if err != nil {
		return normalizedMeshConfig{}, &InvalidRequestError{Reason: "interfaceCidr " + err.Error()}
	}
	if network.SourceCoversAll(interfacePrefix) {
		return normalizedMeshConfig{}, &InvalidRequestError{Reason: "interfaceCidr must not cover all sources"}
	}

	peers := make([]normalizedMeshPeer, len(config.Peers))
	peerKeys := make([]string, len(config.Peers))
	seenPeers := make(map[string]struct{}, len(config.Peers))
	for i, peer := range config.Peers {
		normalizedPeer, err := normalizeMeshPeer(i, peer)
		if err != nil {
			return normalizedMeshConfig{}, err
		}
		if _, exists := seenPeers[normalizedPeer.PublicKey]; exists {
			return normalizedMeshConfig{}, &InvalidRequestError{Reason: fmt.Sprintf("peers[%d].publicKey duplicates an enrolled peer", i)}
		}
		seenPeers[normalizedPeer.PublicKey] = struct{}{}
		peers[i] = normalizedPeer
		peerKeys[i] = normalizedPeer.PublicKey
	}
	sort.Strings(peerKeys)

	return normalizedMeshConfig{
		PrivateKeyRef:       keyRef,
		ListenPort:          config.ListenPort,
		InterfaceName:       defaultInterfaceName,
		InterfacePrefix:     interfacePrefix,
		InterfaceAddress:    interfaceAddressCIDR(interfacePrefix),
		NftFamily:           defaultNftFamily,
		NftTable:            defaultNftTable,
		Peers:               peers,
		ExpectedPeerKeyList: peerKeys,
	}, nil
}

func normalizeMeshPeer(index int, peer MeshPeer) (normalizedMeshPeer, error) {
	publicKey, publicKeyBytes, err := normalizePublicKey(peer.PublicKey)
	if err != nil {
		return normalizedMeshPeer{}, &InvalidRequestError{Reason: fmt.Sprintf("peers[%d].publicKey %s", index, err)}
	}
	if peer.AllowedIPs == nil || len(peer.AllowedIPs) == 0 {
		return normalizedMeshPeer{}, &InvalidRequestError{Reason: fmt.Sprintf("peers[%d].allowedIps must not be empty", index)}
	}
	allowed := make([]string, len(peer.AllowedIPs))
	seenAllowed := make(map[string]struct{}, len(peer.AllowedIPs))
	for i, value := range peer.AllowedIPs {
		if !safeMeshString(value) {
			return normalizedMeshPeer{}, &InvalidRequestError{Reason: fmt.Sprintf("peers[%d].allowedIps[%d] contains unsafe characters", index, i)}
		}
		prefix, err := network.NormalizeCIDR(value)
		if err != nil {
			return normalizedMeshPeer{}, &InvalidRequestError{Reason: fmt.Sprintf("peers[%d].allowedIps[%d] %s", index, i, err)}
		}
		if network.SourceCoversAll(prefix) {
			return normalizedMeshPeer{}, &InvalidRequestError{Reason: fmt.Sprintf("peers[%d].allowedIps[%d] opens all sources without unsafeWideOpen", index, i)}
		}
		canonical := prefix.String()
		if _, exists := seenAllowed[canonical]; exists {
			return normalizedMeshPeer{}, &InvalidRequestError{Reason: fmt.Sprintf("peers[%d].allowedIps[%d] duplicates an allowed IP", index, i)}
		}
		seenAllowed[canonical] = struct{}{}
		allowed[i] = canonical
	}

	endpoint := ""
	if peer.Endpoint != "" {
		normalizedEndpoint, err := normalizeEndpoint(peer.Endpoint)
		if err != nil {
			return normalizedMeshPeer{}, &InvalidRequestError{Reason: fmt.Sprintf("peers[%d].endpoint %s", index, err)}
		}
		endpoint = normalizedEndpoint
	}
	if peer.PersistentKeepalive != nil && (*peer.PersistentKeepalive <= 0 || *peer.PersistentKeepalive > 65535) {
		return normalizedMeshPeer{}, &InvalidRequestError{Reason: fmt.Sprintf("peers[%d].persistentKeepalive must be 1-65535 when present", index)}
	}
	if peer.Services == nil || len(peer.Services) == 0 {
		return normalizedMeshPeer{}, &InvalidRequestError{Reason: fmt.Sprintf("peers[%d].services must declare at least one service", index)}
	}
	services := make([]MeshService, len(peer.Services))
	for i, service := range peer.Services {
		normalized, err := normalizeMeshService(index, i, service)
		if err != nil {
			return normalizedMeshPeer{}, err
		}
		services[i] = normalized
	}

	return normalizedMeshPeer{
		PublicKey:           publicKey,
		PublicKeyBytes:      publicKeyBytes,
		AllowedIPs:          allowed,
		Endpoint:            endpoint,
		PersistentKeepalive: cloneIntPtr(peer.PersistentKeepalive),
		Services:            services,
	}, nil
}

func normalizeMeshService(peerIndex int, serviceIndex int, service MeshService) (MeshService, error) {
	switch service.Proto {
	case network.ProtoTCP, network.ProtoUDP:
	default:
		return MeshService{}, &InvalidRequestError{Reason: fmt.Sprintf("peers[%d].services[%d].proto must be tcp or udp", peerIndex, serviceIndex)}
	}
	if !validMeshPort(service.Port) {
		return MeshService{}, &InvalidRequestError{Reason: fmt.Sprintf("peers[%d].services[%d].port must be 1-65535", peerIndex, serviceIndex)}
	}
	return MeshService{Proto: service.Proto, Port: service.Port}, nil
}

func normalizePublicKey(value string) (string, []byte, error) {
	if value == "" || value != strings.TrimSpace(value) || hasControl(value) {
		return "", nil, errors.New("must be base64 public key text")
	}
	if len(value) != meshKeyBase64Length {
		return "", nil, errors.New("must be exactly 44 base64 characters")
	}
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return "", nil, errors.New("must be valid base64")
	}
	if len(decoded) != meshPublicKeyBytes {
		return "", nil, errors.New("must decode to 32 bytes")
	}
	return base64.StdEncoding.EncodeToString(decoded), decoded, nil
}

func normalizeEndpoint(value string) (string, error) {
	if !safeMeshString(value) {
		return "", errors.New("contains unsafe characters")
	}
	host, portText, err := net.SplitHostPort(value)
	if err != nil {
		return "", errors.New("must be host:port")
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return "", errors.New("host must be an IP literal")
	}
	port, err := strconv.Atoi(portText)
	if err != nil || !validMeshPort(port) {
		return "", errors.New("port must be 1-65535")
	}
	return net.JoinHostPort(addr.String(), strconv.Itoa(port)), nil
}

func normalizePrivateKeyRef(value string, keyRoot string) (string, error) {
	if value == "" {
		return "", &InvalidRequestError{Reason: "privateKeyRef is required"}
	}
	if looksLikeInlineKey(value) {
		return "", &InvalidRequestError{Reason: "privateKeyRef must be a keyfile path, not inline key bytes"}
	}
	if !safeMeshString(value) {
		return "", &InvalidRequestError{Reason: "privateKeyRef contains unsafe characters"}
	}
	if !filepath.IsAbs(value) {
		return "", &InvalidRequestError{Reason: "privateKeyRef must be an absolute keyfile path"}
	}
	cleanRoot := filepath.Clean(keyRoot)
	cleanPath := filepath.Clean(value)
	rel, err := filepath.Rel(cleanRoot, cleanPath)
	if err != nil || rel == "." || rel == "" || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || rel == ".." || filepath.IsAbs(rel) {
		return "", &InvalidRequestError{Reason: "privateKeyRef must stay under the mesh keystore"}
	}
	return cleanPath, nil
}

func readPrivateKey(ctx context.Context, path string) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	raw, err := io.ReadAll(io.LimitReader(file, meshPrivateKeyMax+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > meshPrivateKeyMax {
		return nil, errors.New("mesh private key file is too large")
	}
	text := string(bytes.TrimSpace(raw))
	if len(text) != meshKeyBase64Length {
		return nil, errors.New("mesh private key must be 44 base64 characters")
	}
	decoded, err := base64.StdEncoding.DecodeString(text)
	if err != nil {
		return nil, errors.New("mesh private key must be valid base64")
	}
	if len(decoded) != meshPrivateKeyBytes {
		return nil, errors.New("mesh private key must decode to 32 bytes")
	}
	return decoded, nil
}

func interfaceAddressCIDR(prefix netip.Prefix) string {
	addr := prefix.Addr()
	if prefix.Bits() < addr.BitLen() {
		next := addr.Next()
		if next.IsValid() && prefix.Contains(next) {
			addr = next
		}
	}
	return netip.PrefixFrom(addr, prefix.Bits()).String()
}

func wireGuardPeers(peers []normalizedMeshPeer) []sysdeps.WireGuardPeer {
	out := make([]sysdeps.WireGuardPeer, len(peers))
	for i, peer := range peers {
		out[i] = sysdeps.WireGuardPeer{
			PublicKey:           cloneBytes(peer.PublicKeyBytes),
			AllowedIPs:          cloneStrings(peer.AllowedIPs),
			Endpoint:            peer.Endpoint,
			PersistentKeepalive: cloneIntPtr(peer.PersistentKeepalive),
		}
	}
	return out
}

func renderMeshRuleset(config normalizedMeshConfig) []byte {
	var b strings.Builder
	b.WriteString("table ")
	b.WriteString(config.NftFamily)
	b.WriteString(" ")
	b.WriteString(config.NftTable)
	b.WriteString(" {\n")
	b.WriteString("  chain input {\n")
	b.WriteString("    type filter hook input priority filter; policy drop;\n")
	b.WriteString("    iifname != \"")
	b.WriteString(config.InterfaceName)
	b.WriteString("\" accept\n")
	b.WriteString("    ct state established,related accept\n")
	for _, peer := range config.Peers {
		for _, allowed := range peer.AllowedIPs {
			prefix := netip.MustParsePrefix(allowed)
			for _, service := range peer.Services {
				b.WriteString("    iifname \"")
				b.WriteString(config.InterfaceName)
				b.WriteString("\" ")
				if prefix.Addr().Is4() {
					b.WriteString("ip saddr ")
				} else {
					b.WriteString("ip6 saddr ")
				}
				b.WriteString(prefix.String())
				b.WriteString(" ")
				b.WriteString(string(service.Proto))
				b.WriteString(" dport ")
				b.WriteString(strconv.Itoa(service.Port))
				b.WriteString(" accept\n")
			}
		}
	}
	b.WriteString("  }\n")
	b.WriteString("}\n")
	return []byte(b.String())
}

func verifyWireGuardDevice(config normalizedMeshConfig, device sysdeps.WireGuardDeviceStatus) error {
	if device.Name != config.InterfaceName {
		return fmt.Errorf("wireguard device name = %q, want %q", device.Name, config.InterfaceName)
	}
	if device.ListenPort != config.ListenPort {
		return fmt.Errorf("wireguard listen port = %d, want %d", device.ListenPort, config.ListenPort)
	}
	if len(device.Peers) != len(config.Peers) {
		return fmt.Errorf("wireguard peer count = %d, want %d", len(device.Peers), len(config.Peers))
	}

	want := make(map[string][]string, len(config.Peers))
	for _, peer := range config.Peers {
		allowed := cloneStrings(peer.AllowedIPs)
		sort.Strings(allowed)
		want[peer.PublicKey] = allowed
	}
	for _, peer := range device.Peers {
		if len(peer.PublicKey) != meshPublicKeyBytes {
			return errors.New("wireguard device returned malformed peer public key")
		}
		key := base64.StdEncoding.EncodeToString(peer.PublicKey)
		wantAllowed, ok := want[key]
		if !ok {
			return fmt.Errorf("wireguard device has unexpected peer %s", key)
		}
		gotAllowed := cloneStrings(peer.AllowedIPs)
		sort.Strings(gotAllowed)
		if strings.Join(gotAllowed, "\x00") != strings.Join(wantAllowed, "\x00") {
			return fmt.Errorf("wireguard allowed IPs for peer %s do not match validated config", key)
		}
	}
	return nil
}

func verifyMeshNftTable(config normalizedMeshConfig, table string) error {
	if !strings.Contains(table, "policy drop") {
		return errors.New("nft table does not enforce policy drop")
	}
	if strings.Contains(table, "policy accept") {
		return errors.New("nft table contains policy accept")
	}
	if !strings.Contains(table, "iifname != \""+config.InterfaceName+"\" accept") {
		return errors.New("nft table does not scope default-deny to mesh interface")
	}
	if !strings.Contains(table, "ct state established,related accept") &&
		!strings.Contains(table, "ct state related,established accept") {
		return errors.New("nft table does not allow established return traffic")
	}
	for _, peer := range config.Peers {
		for _, allowed := range peer.AllowedIPs {
			if !tableContainsPrefix(table, allowed) {
				return fmt.Errorf("nft table missing allowed IP %s", allowed)
			}
			for _, service := range peer.Services {
				if !meshAcceptRulePresent(table, config.InterfaceName, allowed, service) {
					return fmt.Errorf("nft table missing mesh accept for %s %s port %d", allowed, service.Proto, service.Port)
				}
			}
		}
	}
	return nil
}

func meshAcceptRulePresent(table string, interfaceName string, allowed string, service MeshService) bool {
	prefix := netip.MustParsePrefix(allowed)
	sourceForms := []string{prefix.String()}
	if (prefix.Addr().Is4() && prefix.Bits() == 32) || (prefix.Addr().Is6() && prefix.Bits() == 128) {
		sourceForms = append(sourceForms, prefix.Addr().String())
	}
	family := "ip"
	if prefix.Addr().Is6() {
		family = "ip6"
	}
	for _, source := range sourceForms {
		want := "iifname \"" + interfaceName + "\" " +
			family + " saddr " + source + " " +
			string(service.Proto) + " dport " + strconv.Itoa(service.Port) + " accept"
		if strings.Contains(table, want) {
			return true
		}
	}
	return false
}

func tableContainsPrefix(table string, value string) bool {
	if strings.Contains(table, value) {
		return true
	}
	prefix := netip.MustParsePrefix(value)
	if (prefix.Addr().Is4() && prefix.Bits() == 32) || (prefix.Addr().Is6() && prefix.Bits() == 128) {
		return strings.Contains(table, prefix.Addr().String())
	}
	return false
}

func validMeshPort(value int) bool {
	return value > 0 && value <= 65535 && value != network.PortAll
}

func safeMeshString(value string) bool {
	if value == "" || value != strings.TrimSpace(value) || hasControl(value) {
		return false
	}
	for _, r := range value {
		switch r {
		case '"', '\'', '`', ';', '|', '&', '$', '<', '>', '\\':
			return false
		default:
			if unicode.IsControl(r) {
				return false
			}
		}
	}
	return true
}

func hasControl(value string) bool {
	for _, r := range value {
		if unicode.IsControl(r) {
			return true
		}
	}
	return false
}

func looksLikeInlineKey(value string) bool {
	trimmed := strings.TrimSpace(value)
	if strings.Contains(strings.ToUpper(trimmed), "PRIVATE KEY") {
		return true
	}
	if len(trimmed) != meshKeyBase64Length {
		return false
	}
	decoded, err := base64.StdEncoding.DecodeString(trimmed)
	return err == nil && len(decoded) == meshPrivateKeyBytes
}

func isMissingNetworkObject(err error) bool {
	if err == nil {
		return false
	}
	reason := strings.ToUpper(err.Error())
	return errors.Is(err, os.ErrNotExist) ||
		sysdeps.ErrnoCode(err) == "ENOENT" ||
		sysdeps.ErrnoCode(err) == "ENODEV" ||
		strings.Contains(reason, "NO SUCH FILE OR DIRECTORY") ||
		strings.Contains(reason, "NO SUCH DEVICE") ||
		strings.Contains(reason, "NO SUCH FILE")
}

func stepError(step string, err error) error {
	if err == nil {
		return nil
	}
	return &stepFailure{Step: step, Err: err}
}

func cloneMeshConfig(config *MeshConfig) *MeshConfig {
	if config == nil {
		return nil
	}
	out := *config
	out.Peers = make([]MeshPeer, len(config.Peers))
	for i, peer := range config.Peers {
		out.Peers[i] = MeshPeer{
			PublicKey:           peer.PublicKey,
			AllowedIPs:          cloneStrings(peer.AllowedIPs),
			Endpoint:            peer.Endpoint,
			PersistentKeepalive: cloneIntPtr(peer.PersistentKeepalive),
			Services:            cloneServices(peer.Services),
		}
	}
	return &out
}

func cloneServices(in []MeshService) []MeshService {
	if in == nil {
		return nil
	}
	out := make([]MeshService, len(in))
	copy(out, in)
	return out
}

func cloneStrings(in []string) []string {
	if in == nil {
		return nil
	}
	out := make([]string, len(in))
	copy(out, in)
	return out
}

func cloneBytes(in []byte) []byte {
	if in == nil {
		return nil
	}
	out := make([]byte, len(in))
	copy(out, in)
	return out
}

func cloneIntPtr(in *int) *int {
	if in == nil {
		return nil
	}
	value := *in
	return &value
}

func (defaultMeshSystem) CreateWireGuardLink(name string) error {
	return sysdeps.CreateWireGuardLink(name)
}

func (defaultMeshSystem) SetWireGuardPrivateKey(name string, privateKey []byte, listenPort int) error {
	return sysdeps.SetWireGuardPrivateKey(name, privateKey, listenPort)
}

func (defaultMeshSystem) ReplaceWireGuardPeers(name string, peers []sysdeps.WireGuardPeer) error {
	return sysdeps.ReplaceWireGuardPeers(name, peers)
}

func (defaultMeshSystem) AddIPAddress(name string, cidr string) error {
	return sysdeps.AddIPAddress(name, cidr)
}

func (defaultMeshSystem) SetLinkUp(name string) error {
	return sysdeps.SetLinkUp(name)
}

func (defaultMeshSystem) DeleteLink(name string) error {
	return sysdeps.DeleteLink(name)
}

func (defaultMeshSystem) ApplyNftRuleset(ruleset []byte) error {
	return sysdeps.ApplyNftRuleset(ruleset)
}

func (defaultMeshSystem) ListNftTable(family string, table string) ([]byte, error) {
	return sysdeps.ListNftTable(family, table)
}

func (defaultMeshSystem) DeleteNftTable(family string, table string) error {
	return sysdeps.DeleteNftTable(family, table)
}

func (defaultMeshSystem) WireGuardDevice(name string) (sysdeps.WireGuardDeviceStatus, error) {
	return sysdeps.WireGuardDevice(name)
}

func meshFailureReason(err error) string {
	var stepErr *stepFailure
	if errors.As(err, &stepErr) && stepErr != nil {
		return stepErr.ApplyErrorCode()
	}
	return "mesh_unknown"
}

func renderMeshConfig(config MeshConfig) []byte {
	encoded, err := json.Marshal(config)
	if err != nil {
		return nil
	}
	return append(encoded, '\n')
}
