package capsule

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/vita/agent/capabilities/network"
	"github.com/vita/agent/internal/sysdeps"
)

const (
	capsuleEgressDropEnforced = "enforced"
	capsuleEgressReachOK      = "OK"
	capsuleEgressDenied       = "DENY"
	capsuleEgressStatusOK     = "OK"
	capsuleEgressStatusFail   = "FAIL"

	capsuleEgressNftFamily = "inet"
)

type capsuleEgressConfig struct {
	HostInterface    string
	CapsuleInterface string
	Table            string
	HostCIDR         string
	HostAddr         string
	CapsuleCIDR      string
	CapsuleAddr      string
	ProbeHostCIDR    string
	ProbeAllowedCIDR string
	ProbeAllowedAddr string
	ProbeAllowedPort int
	ProbeDeniedCIDR  string
	ProbeDeniedAddr  string
	Grants           []capsuleEgressGrant
	Ingress          *capsuleIngressConfig

	probe *capsuleEgressProbe
}

type capsuleEgressGrant struct {
	Protocol    network.Protocol
	Destination string
	Port        int
}

type capsuleEgressCheck struct {
	AllowedCIDR string
	DeniedCIDR  string
	Drop        string
	Status      string
	Ingress     *capsuleIngressCheck
	Table       string
	HostTable   string
}

type capsuleEgressProof struct {
	Allowed string `json:"allowed"`
	Reach   string `json:"reach"`
	Denied  string `json:"denied"`
	Drop    string `json:"drop"`
	Status  string `json:"status"`
}

type capsuleEgressConfigurator interface {
	Setup(context.Context, *capsuleNetns) error
	Check(context.Context, capsuleNetns, []net.Interface) (capsuleEgressCheck, error)
	Teardown(context.Context, capsuleNetns) error
}

type defaultCapsuleEgressConfigurator struct{}

func capsuleEgressConfigForUnit(unitName string, policy *ExecutionNetwork) (*capsuleEgressConfig, error) {
	if policy == nil || len(policy.Egress) == 0 {
		return nil, nil
	}
	if err := policy.Validate(); err != nil {
		return nil, err
	}

	config := capsuleBaseEgressConfigForUnit(unitName)
	for i, rule := range policy.Egress {
		if err := rule.Validate(i); err != nil {
			return nil, err
		}
		for _, destination := range rule.Destinations {
			prefix, err := normalizeNetworkDestination(destination)
			if err != nil {
				return nil, &ExecuteInvalidRequestError{Reason: fmt.Sprintf("network.egress[%d].destinations %s", i, err)}
			}
			for _, portValue := range rule.Ports {
				if !validNetworkPort(portValue) {
					return nil, &ExecuteInvalidRequestError{Reason: fmt.Sprintf("network.egress[%d].ports must be 1-65535 or PortAll", i)}
				}
				config.Grants = append(config.Grants, capsuleEgressGrant{
					Protocol:    rule.Protocol,
					Destination: prefix.String(),
					Port:        portValue,
				})
				config.fillProbe(rule.Protocol, prefix, portValue)
			}
		}
	}
	if len(config.Grants) == 0 {
		return nil, &ExecuteInvalidRequestError{Reason: "network.egress must contain at least one grant"}
	}
	config.fillDeniedProbe()
	return config, nil
}

func capsuleBaseEgressConfigForUnit(unitName string) *capsuleEgressConfig {
	names := capsuleEgressNames(unitName)
	hostAddr, capsuleAddr := capsuleEgressIPv4Pair(unitName)
	return &capsuleEgressConfig{
		HostInterface:    names.host,
		CapsuleInterface: names.capsule,
		Table:            names.table,
		HostAddr:         hostAddr.String(),
		HostCIDR:         netip.PrefixFrom(hostAddr, 30).String(),
		CapsuleAddr:      capsuleAddr.String(),
		CapsuleCIDR:      netip.PrefixFrom(capsuleAddr, 30).String(),
	}
}

func (c *capsuleEgressConfig) fillProbe(protocol network.Protocol, prefix netip.Prefix, portValue int) {
	if c.ProbeAllowedAddr != "" || protocol != network.ProtoTCP || portValue == network.PortAll || !prefix.Addr().Is4() || prefix.Bits() != 32 {
		return
	}
	if !documentationIPv4(prefix.Addr()) {
		return
	}
	c.ProbeAllowedCIDR = prefix.String()
	c.ProbeAllowedAddr = prefix.Addr().String()
	c.ProbeAllowedPort = portValue
	c.ProbeHostCIDR = prefix.String()
}

func (c *capsuleEgressConfig) fillDeniedProbe() {
	if c.ProbeDeniedAddr != "" {
		return
	}
	for _, candidate := range []string{"198.51.100.254", "203.0.113.254", "192.0.2.254"} {
		addr := netip.MustParseAddr(candidate)
		if c.allowsAddr(addr) {
			continue
		}
		c.ProbeDeniedAddr = addr.String()
		c.ProbeDeniedCIDR = netip.PrefixFrom(addr, 32).String()
		return
	}
}

func (c capsuleEgressConfig) allowsAddr(addr netip.Addr) bool {
	for _, grant := range c.Grants {
		prefix := netip.MustParsePrefix(grant.Destination)
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

func (c defaultCapsuleEgressConfigurator) Setup(ctx context.Context, netns *capsuleNetns) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if netns == nil || netns.Egress == nil {
		return nil
	}
	config := netns.Egress
	if err := validateCapsuleEgressConfig(*config); err != nil {
		return err
	}

	target, err := os.Open(netns.Path)
	if err != nil {
		return capsuleNetnsStepError("egress_open_netns", err)
	}
	defer target.Close()

	createdHost := false
	appliedIngress := false
	if err := sysdeps.CreateVeth(config.HostInterface, config.CapsuleInterface); err != nil {
		return capsuleNetnsStepError("egress_veth_create", err)
	}
	createdHost = true
	cleanup := func() {
		if createdHost {
			_ = sysdeps.DeleteLink(config.HostInterface)
		}
		if config.probe != nil {
			_ = config.probe.Close()
			config.probe = nil
		}
		if appliedIngress && config.Ingress != nil {
			_ = sysdeps.DeleteNftTable(capsuleIngressNftFamily, config.Ingress.HostNatTable)
		}
	}
	committed := false
	defer func() {
		if !committed {
			cleanup()
		}
	}()

	if err := sysdeps.AddIPv4Address(config.HostInterface, config.HostCIDR); err != nil {
		return capsuleNetnsStepError("egress_host_addr", err)
	}
	if config.ProbeHostCIDR != "" {
		if err := sysdeps.AddIPv4Address(config.HostInterface, config.ProbeHostCIDR); err != nil {
			return capsuleNetnsStepError("egress_probe_addr", err)
		}
	}
	if err := sysdeps.SetLinkUp(config.HostInterface); err != nil {
		return capsuleNetnsStepError("egress_host_up", err)
	}
	if config.ProbeAllowedAddr != "" && config.ProbeAllowedPort > 0 {
		probe, err := startCapsuleEgressProbe(config.ProbeAllowedAddr, config.ProbeAllowedPort)
		if err != nil {
			return capsuleNetnsStepError("egress_probe_listen", err)
		}
		config.probe = probe
	}
	if err := sysdeps.MoveLinkToNetns(config.CapsuleInterface, int(target.Fd())); err != nil {
		return capsuleNetnsStepError("egress_veth_move", err)
	}

	err = withCapsuleNetns(netns.Path, func() error {
		if err := sysdeps.AddIPv4Address(config.CapsuleInterface, config.CapsuleCIDR); err != nil {
			return capsuleNetnsStepError("egress_capsule_addr", err)
		}
		if err := sysdeps.SetLinkUp(config.CapsuleInterface); err != nil {
			return capsuleNetnsStepError("egress_capsule_up", err)
		}
		if err := sysdeps.AddDefaultIPv4Route(config.CapsuleInterface, config.HostAddr); err != nil {
			return capsuleNetnsStepError("egress_default_route", err)
		}
		if err := sysdeps.DeleteNftTable(capsuleEgressNftFamily, config.Table); err != nil && !isMissingNetworkObject(err) {
			return capsuleNetnsStepError("egress_nft_delete", err)
		}
		if err := sysdeps.ApplyNftRuleset(renderCapsuleEgressRuleset(*config)); err != nil {
			return capsuleNetnsStepError("egress_nft_apply", err)
		}
		return nil
	})
	if err != nil {
		return err
	}

	if config.Ingress != nil {
		if err := sysdeps.DeleteNftTable(capsuleIngressNftFamily, config.Ingress.HostNatTable); err != nil && !isMissingNetworkObject(err) {
			return capsuleNetnsStepError("ingress_dnat_delete", err)
		}
		if err := sysdeps.ApplyNftRuleset(renderCapsuleIngressHostRuleset(*config.Ingress)); err != nil {
			return capsuleNetnsStepError("ingress_dnat_apply", err)
		}
		appliedIngress = true
	}

	committed = true
	return nil
}

func (c defaultCapsuleEgressConfigurator) Check(ctx context.Context, netns capsuleNetns, interfaces []net.Interface) (capsuleEgressCheck, error) {
	if err := ctx.Err(); err != nil {
		return capsuleEgressCheck{}, err
	}
	if netns.Egress == nil {
		return capsuleEgressCheck{}, nil
	}
	config := *netns.Egress
	if err := validateCapsuleEgressConfig(config); err != nil {
		return capsuleEgressCheck{}, err
	}
	if err := capsuleEgressInterfacesReady(interfaces, config.CapsuleInterface); err != nil {
		return capsuleEgressCheck{}, err
	}

	var table []byte
	if err := withCapsuleNetns(netns.Path, func() error {
		raw, err := sysdeps.ListNftTable(capsuleEgressNftFamily, config.Table)
		if err != nil {
			return err
		}
		table = raw
		return nil
	}); err != nil {
		return capsuleEgressCheck{}, capsuleNetnsStepError("egress_nft_check", err)
	}
	if err := verifyCapsuleEgressTable(config, string(table)); err != nil {
		return capsuleEgressCheck{}, capsuleNetnsStepError("egress_nft_check", err)
	}
	if err := withCapsuleNetns(netns.Path, func() error {
		return probeCapsuleEgressPolicy(ctx, config)
	}); err != nil {
		return capsuleEgressCheck{}, err
	}

	var ingressCheck *capsuleIngressCheck
	var hostTable []byte
	if config.Ingress != nil {
		var err error
		hostTable, err = sysdeps.ListNftTable(capsuleIngressNftFamily, config.Ingress.HostNatTable)
		if err != nil {
			return capsuleEgressCheck{}, capsuleNetnsStepError("ingress_dnat_check", err)
		}
		if err := verifyCapsuleIngressHostTable(*config.Ingress, string(hostTable)); err != nil {
			return capsuleEgressCheck{}, capsuleNetnsStepError("ingress_dnat_check", err)
		}
		ingressCheck = &capsuleIngressCheck{
			HostAddr:   config.Ingress.HostAddr,
			Port:       config.Ingress.ProbePort,
			DeniedPort: config.Ingress.ProbeDeniedPort,
			Drop:       capsuleIngressDropEnforced,
			Status:     capsuleIngressStatusOK,
		}
	}

	return capsuleEgressCheck{
		AllowedCIDR: config.ProbeAllowedCIDR,
		DeniedCIDR:  config.ProbeDeniedCIDR,
		Drop:        capsuleEgressDropEnforced,
		Status:      capsuleEgressStatusOK,
		Ingress:     ingressCheck,
		Table:       string(table),
		HostTable:   string(hostTable),
	}, nil
}

func (c defaultCapsuleEgressConfigurator) Teardown(ctx context.Context, netns capsuleNetns) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if netns.Egress == nil {
		return nil
	}
	config := netns.Egress
	var teardownErr error
	if config.probe != nil {
		if err := config.probe.Close(); err != nil {
			teardownErr = errors.Join(teardownErr, capsuleNetnsStepError("egress_probe_close", err))
		}
		config.probe = nil
	}
	if config.Ingress != nil {
		if err := sysdeps.DeleteNftTable(capsuleIngressNftFamily, config.Ingress.HostNatTable); err != nil && !isMissingNetworkObject(err) {
			teardownErr = errors.Join(teardownErr, capsuleNetnsStepError("ingress_dnat_delete", err))
		}
	}
	if err := sysdeps.DeleteLink(config.HostInterface); err != nil && !isMissingNetworkObject(err) {
		teardownErr = errors.Join(teardownErr, capsuleNetnsStepError("egress_veth_delete", err))
	}
	if err := withCapsuleNetns(netns.Path, func() error {
		return sysdeps.DeleteNftTable(capsuleEgressNftFamily, config.Table)
	}); err != nil && !isMissingNetworkObject(err) {
		teardownErr = errors.Join(teardownErr, capsuleNetnsStepError("egress_nft_delete", err))
	}
	return teardownErr
}

func validateCapsuleEgressConfig(config capsuleEgressConfig) error {
	if !network.ValidInterfaceName(config.HostInterface) || !strings.HasPrefix(config.HostInterface, "vh") {
		return &ExecuteInvalidRequestError{Reason: "capsule egress host interface is unsafe"}
	}
	if !network.ValidInterfaceName(config.CapsuleInterface) || !strings.HasPrefix(config.CapsuleInterface, "vc") {
		return &ExecuteInvalidRequestError{Reason: "capsule egress interface is unsafe"}
	}
	if !safeNftIdentifier(config.Table) || !strings.HasPrefix(config.Table, "vita_") {
		return &ExecuteInvalidRequestError{Reason: "capsule egress table is unsafe"}
	}
	if !validIPv4InterfacePrefix(config.HostCIDR, 30) {
		return &ExecuteInvalidRequestError{Reason: "capsule egress host cidr is invalid"}
	}
	if !validIPv4InterfacePrefix(config.CapsuleCIDR, 30) {
		return &ExecuteInvalidRequestError{Reason: "capsule egress capsule cidr is invalid"}
	}
	if _, err := netip.ParseAddr(config.HostAddr); err != nil {
		return &ExecuteInvalidRequestError{Reason: "capsule egress host address is invalid"}
	}
	if len(config.Grants) == 0 && (config.Ingress == nil || len(config.Ingress.Grants) == 0) {
		return &ExecuteInvalidRequestError{Reason: "capsule network grants are required"}
	}
	if config.Ingress != nil {
		if err := validateCapsuleIngressConfig(*config.Ingress); err != nil {
			return err
		}
		if config.Ingress.HostInterface != config.HostInterface ||
			config.Ingress.CapsuleInterface != config.CapsuleInterface ||
			config.Ingress.HostAddr != config.HostAddr ||
			config.Ingress.CapsuleAddr != config.CapsuleAddr {
			return &ExecuteInvalidRequestError{Reason: "capsule ingress addresses must match capsule network"}
		}
	}
	for i, grant := range config.Grants {
		if !validNetworkProtocol(grant.Protocol) {
			return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("capsule egress grants[%d].protocol is invalid", i)}
		}
		if _, err := network.NormalizeCIDR(grant.Destination); err != nil {
			return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("capsule egress grants[%d].destination is invalid", i)}
		}
		if !validNetworkPort(grant.Port) {
			return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("capsule egress grants[%d].port is invalid", i)}
		}
	}
	return nil
}

func validIPv4InterfacePrefix(value string, bits int) bool {
	prefix, err := netip.ParsePrefix(value)
	return err == nil && prefix.Addr().Is4() && prefix.Bits() == bits
}

func renderCapsuleEgressRuleset(config capsuleEgressConfig) []byte {
	var b strings.Builder
	b.WriteString("table ")
	b.WriteString(capsuleEgressNftFamily)
	b.WriteString(" ")
	b.WriteString(config.Table)
	b.WriteString(" {\n")
	b.WriteString("  chain input {\n")
	b.WriteString("    type filter hook input priority filter; policy drop;\n")
	b.WriteString("    iifname \"lo\" accept\n")
	b.WriteString("    ct state established,related accept\n")
	writeCapsuleIngressInputRules(&b, config.Ingress)
	b.WriteString("  }\n")
	b.WriteString("  chain output {\n")
	b.WriteString("    type filter hook output priority filter; policy drop;\n")
	b.WriteString("    oifname \"lo\" accept\n")
	b.WriteString("    ct state established,related accept\n")
	for _, grant := range config.Grants {
		b.WriteString("    ")
		prefix := netip.MustParsePrefix(grant.Destination)
		if prefix.Addr().Is4() {
			b.WriteString("ip daddr ")
		} else {
			b.WriteString("ip6 daddr ")
		}
		b.WriteString(prefix.String())
		b.WriteString(" ")
		b.WriteString(string(grant.Protocol))
		if grant.Port != network.PortAll {
			b.WriteString(" dport ")
			b.WriteString(strconv.Itoa(grant.Port))
		}
		b.WriteString(" accept\n")
	}
	b.WriteString("  }\n")
	b.WriteString("}\n")
	return []byte(b.String())
}

func verifyCapsuleEgressTable(config capsuleEgressConfig, table string) error {
	if !strings.Contains(table, "policy drop") {
		return errors.New("nft table does not enforce policy drop")
	}
	if strings.Contains(table, "policy accept") {
		return errors.New("nft table contains policy accept")
	}
	if !strings.Contains(table, "ct state established,related accept") &&
		!strings.Contains(table, "ct state related,established accept") {
		return errors.New("nft table does not allow established return traffic")
	}
	if config.Ingress != nil {
		if err := verifyCapsuleIngressNetnsTable(*config.Ingress, table); err != nil {
			return err
		}
	}
	for _, grant := range config.Grants {
		if !tableContainsDestination(table, grant.Destination) {
			return fmt.Errorf("nft table missing destination %s", grant.Destination)
		}
		if !strings.Contains(table, string(grant.Protocol)) {
			return fmt.Errorf("nft table missing protocol %s", grant.Protocol)
		}
		if grant.Port != network.PortAll && !strings.Contains(table, "dport "+strconv.Itoa(grant.Port)) {
			return fmt.Errorf("nft table missing port %d", grant.Port)
		}
	}
	return nil
}

func tableContainsDestination(table string, destination string) bool {
	if containsNetworkToken(table, destination) {
		return true
	}
	prefix := netip.MustParsePrefix(destination)
	if (prefix.Addr().Is4() && prefix.Bits() == 32) || (prefix.Addr().Is6() && prefix.Bits() == 128) {
		return containsNetworkToken(table, prefix.Addr().String())
	}
	return false
}

func containsNetworkToken(value string, token string) bool {
	if token == "" {
		return false
	}
	offset := 0
	for {
		index := strings.Index(value[offset:], token)
		if index < 0 {
			return false
		}
		start := offset + index
		end := start + len(token)
		if networkTokenBoundary(value, start-1) && networkTokenBoundary(value, end) {
			return true
		}
		offset = end
	}
}

func networkTokenBoundary(value string, index int) bool {
	if index < 0 || index >= len(value) {
		return true
	}
	switch b := value[index]; {
	case b >= '0' && b <= '9':
		return false
	case b >= 'A' && b <= 'Z':
		return false
	case b >= 'a' && b <= 'z':
		return false
	case b == '.', b == ':', b == '/':
		return false
	default:
		return true
	}
}

func capsuleEgressInterfacesReady(interfaces []net.Interface, capsuleInterface string) error {
	loopbackUp := false
	loopbackSeen := false
	capsuleSeen := false
	capsuleUp := false
	for _, iface := range interfaces {
		if iface.Name == "lo" {
			loopbackSeen = true
			if iface.Flags&net.FlagLoopback != 0 && iface.Flags&net.FlagUp != 0 {
				loopbackUp = true
			}
			continue
		}
		if iface.Name == capsuleInterface {
			capsuleSeen = true
			if iface.Flags&net.FlagUp != 0 {
				capsuleUp = true
			}
			continue
		}
		return capsuleNetnsStepError("egress_check_link_extra", fmt.Errorf("capsule network namespace exposes unexpected interface %s", iface.Name))
	}
	if !loopbackSeen {
		return capsuleNetnsStepError("egress_check_lo_absent", errors.New("capsule network namespace loopback interface is absent"))
	}
	if !loopbackUp {
		return capsuleNetnsStepError("egress_check_lo_down", errors.New("capsule network namespace loopback interface is present but down"))
	}
	if !capsuleSeen {
		return capsuleNetnsStepError("egress_check_link_absent", fmt.Errorf("capsule egress interface %s is absent", capsuleInterface))
	}
	if !capsuleUp {
		return capsuleNetnsStepError("egress_check_link_down", fmt.Errorf("capsule egress interface %s is present but down", capsuleInterface))
	}
	return nil
}

type capsuleEgressNamesResult struct {
	host    string
	capsule string
	table   string
}

func capsuleEgressNames(unitName string) capsuleEgressNamesResult {
	sum := sha256.Sum256([]byte(unitName))
	token := hex.EncodeToString(sum[:5])
	return capsuleEgressNamesResult{
		host:    "vh" + token,
		capsule: "vc" + token,
		table:   "vita_" + hex.EncodeToString(sum[:6]),
	}
}

func capsuleEgressIPv4Pair(unitName string) (netip.Addr, netip.Addr) {
	sum := sha256.Sum256([]byte(unitName))
	block := int(binary.BigEndian.Uint16(sum[6:8]) & 0x0fff)
	base := block * 4
	third := 64 + (base / 256)
	fourth := base % 256
	return netip.AddrFrom4([4]byte{169, 254, byte(third), byte(fourth + 1)}),
		netip.AddrFrom4([4]byte{169, 254, byte(third), byte(fourth + 2)})
}

func documentationIPv4(addr netip.Addr) bool {
	return netip.MustParsePrefix("192.0.2.0/24").Contains(addr) ||
		netip.MustParsePrefix("198.51.100.0/24").Contains(addr) ||
		netip.MustParsePrefix("203.0.113.0/24").Contains(addr)
}

func safeNftIdentifier(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		switch {
		case r >= 'A' && r <= 'Z':
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9':
		case r == '_':
		default:
			return false
		}
	}
	return true
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

type capsuleEgressProbe struct {
	listener net.Listener
	done     chan struct{}
}

func startCapsuleEgressProbe(addr string, portValue int) (*capsuleEgressProbe, error) {
	listener, err := net.Listen("tcp4", net.JoinHostPort(addr, strconv.Itoa(portValue)))
	if err != nil {
		return nil, err
	}
	probe := &capsuleEgressProbe{
		listener: listener,
		done:     make(chan struct{}),
	}
	go probe.accept()
	return probe, nil
}

func (p *capsuleEgressProbe) accept() {
	defer close(p.done)
	for {
		conn, err := p.listener.Accept()
		if err != nil {
			return
		}
		_ = conn.Close()
	}
}

func (p *capsuleEgressProbe) Close() error {
	if p == nil || p.listener == nil {
		return nil
	}
	err := p.listener.Close()
	<-p.done
	return err
}

func probeCapsuleEgressPolicy(ctx context.Context, config capsuleEgressConfig) error {
	if config.ProbeAllowedAddr == "" || config.ProbeDeniedAddr == "" || config.ProbeAllowedPort <= 0 {
		return nil
	}
	allowed := probeCapsuleEgressTCP(ctx, config.ProbeAllowedAddr, config.ProbeAllowedPort)
	if allowed != capsuleEgressReachOK {
		return capsuleNetnsStepError("egress_probe_allowed", fmt.Errorf("granted egress %s:%d was not reachable", config.ProbeAllowedAddr, config.ProbeAllowedPort))
	}
	denied := probeCapsuleEgressTCP(ctx, config.ProbeDeniedAddr, config.ProbeAllowedPort)
	if denied == capsuleEgressReachOK {
		return capsuleNetnsStepError("egress_probe_denied", fmt.Errorf("non-granted egress %s:%d was reachable", config.ProbeDeniedAddr, config.ProbeAllowedPort))
	}
	return nil
}

func probeCapsuleEgressTCP(ctx context.Context, host string, portValue int) string {
	if host == "" || portValue <= 0 || portValue > 65535 {
		return capsuleEgressStatusFail
	}
	dialer := net.Dialer{Timeout: 500 * time.Millisecond}
	conn, err := dialer.DialContext(ctx, "tcp4", net.JoinHostPort(host, strconv.Itoa(portValue)))
	if err != nil {
		return capsuleEgressStatusFail
	}
	_ = conn.Close()
	return capsuleEgressReachOK
}

func measuredCapsuleEgressProof(proof capsuleEgressProof, check capsuleEgressCheck) bool {
	return check.Status == capsuleEgressStatusOK &&
		check.Drop == capsuleEgressDropEnforced &&
		check.AllowedCIDR != "" &&
		check.DeniedCIDR != "" &&
		proof.Allowed == check.AllowedCIDR &&
		proof.Denied == check.DeniedCIDR &&
		proof.Reach == capsuleEgressReachOK &&
		proof.Drop == capsuleEgressDropEnforced &&
		proof.Status == capsuleEgressStatusOK
}
