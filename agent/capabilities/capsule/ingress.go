package capsule

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/vita/agent/capabilities/network"
)

const (
	capsuleIngressDropEnforced = "enforced"
	capsuleIngressListenerOK   = "OK"
	capsuleIngressReachOK      = "OK"
	capsuleIngressStatusOK     = "OK"
	capsuleIngressStatusFail   = "FAIL"

	capsuleIngressNftFamily = "ip"
)

type capsuleIngressConfig struct {
	HostInterface    string
	CapsuleInterface string
	HostAddr         string
	CapsuleAddr      string
	HostNatTable     string
	ProbePort        int
	ProbeDeniedPort  int
	Grants           []capsuleIngressGrant
}

type capsuleIngressGrant struct {
	Protocol network.Protocol
	Port     int
}

type capsuleIngressCheck struct {
	HostAddr   string
	Port       int
	DeniedPort int
	Drop       string
	Status     string
}

type capsuleIngressProof struct {
	Port       int    `json:"port"`
	DeniedPort int    `json:"deniedPort"`
	Listener   string `json:"listener"`
	Status     string `json:"status"`
}

func capsuleIngressConfigForUnit(unitName string, policy *ExecutionNetwork) (*capsuleIngressConfig, error) {
	if policy == nil || len(policy.Ingress) == 0 {
		return nil, nil
	}
	if err := policy.Validate(); err != nil {
		return nil, err
	}

	names := capsuleEgressNames(unitName)
	hostAddr, capsuleAddr := capsuleEgressIPv4Pair(unitName)
	config := &capsuleIngressConfig{
		HostInterface:    names.host,
		CapsuleInterface: names.capsule,
		HostAddr:         hostAddr.String(),
		CapsuleAddr:      capsuleAddr.String(),
		HostNatTable:     names.table + "_nat",
	}

	for i, rule := range policy.Ingress {
		if err := rule.Validate(i); err != nil {
			return nil, err
		}
		if rule.Public {
			return nil, &ExecuteInvalidRequestError{Reason: fmt.Sprintf("network.ingress[%d].public host-local ingress must not be public", i)}
		}
		if rule.Port == network.PortAll {
			return nil, &ExecuteInvalidRequestError{Reason: fmt.Sprintf("network.ingress[%d].port must be 1-65535 for host-local ingress", i)}
		}
		if !validNetworkPort(rule.Port) || rule.Port <= 0 {
			return nil, &ExecuteInvalidRequestError{Reason: fmt.Sprintf("network.ingress[%d].port must be 1-65535 for host-local ingress", i)}
		}
		config.Grants = append(config.Grants, capsuleIngressGrant{
			Protocol: rule.Protocol,
			Port:     rule.Port,
		})
		config.fillProbe(rule)
	}
	if len(config.Grants) == 0 {
		return nil, &ExecuteInvalidRequestError{Reason: "network.ingress must contain at least one grant"}
	}
	config.fillDeniedProbe()
	return config, nil
}

func (c *capsuleIngressConfig) fillProbe(rule ExecutionNetworkIngressRule) {
	if c.ProbePort != 0 || rule.Protocol != network.ProtoTCP || rule.Port <= 0 {
		return
	}
	c.ProbePort = rule.Port
}

func (c *capsuleIngressConfig) fillDeniedProbe() {
	if c.ProbePort <= 0 || c.ProbeDeniedPort != 0 {
		return
	}
	for _, candidate := range []int{c.ProbePort + 1, c.ProbePort - 1, 49152, 65535} {
		if candidate > 0 && candidate <= 65535 && !c.allowsPort(candidate) {
			c.ProbeDeniedPort = candidate
			return
		}
	}
}

func (c capsuleIngressConfig) allowsPort(port int) bool {
	for _, grant := range c.Grants {
		if grant.Port == port {
			return true
		}
	}
	return false
}

func validateCapsuleIngressConfig(config capsuleIngressConfig) error {
	if !network.ValidInterfaceName(config.HostInterface) || !strings.HasPrefix(config.HostInterface, "vh") {
		return &ExecuteInvalidRequestError{Reason: "capsule ingress host interface is unsafe"}
	}
	if !network.ValidInterfaceName(config.CapsuleInterface) || !strings.HasPrefix(config.CapsuleInterface, "vc") {
		return &ExecuteInvalidRequestError{Reason: "capsule ingress interface is unsafe"}
	}
	if !safeNftIdentifier(config.HostNatTable) || !strings.HasPrefix(config.HostNatTable, "vita_") {
		return &ExecuteInvalidRequestError{Reason: "capsule ingress nat table is unsafe"}
	}
	if addr, err := netip.ParseAddr(config.HostAddr); err != nil || !addr.Is4() {
		return &ExecuteInvalidRequestError{Reason: "capsule ingress host address is invalid"}
	}
	if addr, err := netip.ParseAddr(config.CapsuleAddr); err != nil || !addr.Is4() {
		return &ExecuteInvalidRequestError{Reason: "capsule ingress capsule address is invalid"}
	}
	if len(config.Grants) == 0 {
		return &ExecuteInvalidRequestError{Reason: "capsule ingress grants are required"}
	}
	for i, grant := range config.Grants {
		if !validNetworkProtocol(grant.Protocol) {
			return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("capsule ingress grants[%d].protocol is invalid", i)}
		}
		if grant.Port <= 0 || grant.Port > 65535 {
			return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("capsule ingress grants[%d].port is invalid", i)}
		}
	}
	if config.ProbePort != 0 && !config.allowsPort(config.ProbePort) {
		return &ExecuteInvalidRequestError{Reason: "capsule ingress probe port is outside the grant"}
	}
	if config.ProbeDeniedPort != 0 {
		if config.ProbeDeniedPort <= 0 || config.ProbeDeniedPort > 65535 {
			return &ExecuteInvalidRequestError{Reason: "capsule ingress denied probe port is invalid"}
		}
		if config.allowsPort(config.ProbeDeniedPort) {
			return &ExecuteInvalidRequestError{Reason: "capsule ingress denied probe port is granted"}
		}
	}
	return nil
}

func renderCapsuleIngressHostRuleset(config capsuleIngressConfig) []byte {
	var b strings.Builder
	b.WriteString("table ")
	b.WriteString(capsuleIngressNftFamily)
	b.WriteString(" ")
	b.WriteString(config.HostNatTable)
	b.WriteString(" {\n")
	b.WriteString("  chain output {\n")
	b.WriteString("    type nat hook output priority dstnat;\n")
	for _, grant := range config.Grants {
		b.WriteString("    ip daddr ")
		b.WriteString(config.HostAddr)
		b.WriteString(" ")
		b.WriteString(string(grant.Protocol))
		b.WriteString(" dport ")
		b.WriteString(strconv.Itoa(grant.Port))
		b.WriteString(" dnat to ")
		b.WriteString(config.CapsuleAddr)
		b.WriteString(":")
		b.WriteString(strconv.Itoa(grant.Port))
		b.WriteString("\n")
	}
	b.WriteString("  }\n")
	b.WriteString("}\n")
	return []byte(b.String())
}

func writeCapsuleIngressInputRules(b *strings.Builder, config *capsuleIngressConfig) {
	if config == nil {
		return
	}
	for _, grant := range config.Grants {
		b.WriteString("    iifname \"")
		b.WriteString(config.CapsuleInterface)
		b.WriteString("\" ")
		b.WriteString(string(grant.Protocol))
		b.WriteString(" dport ")
		b.WriteString(strconv.Itoa(grant.Port))
		b.WriteString(" accept\n")
	}
}

func verifyCapsuleIngressNetnsTable(config capsuleIngressConfig, table string) error {
	if err := validateCapsuleIngressConfig(config); err != nil {
		return err
	}
	if config.ProbeDeniedPort != 0 {
		deniedPort := strconv.Itoa(config.ProbeDeniedPort)
		for _, proto := range []network.Protocol{network.ProtoTCP, network.ProtoUDP} {
			if strings.Contains(table, "iifname \""+config.CapsuleInterface+"\" "+string(proto)+" dport "+deniedPort+" accept") {
				return fmt.Errorf("nft table contains non-granted ingress port %d", config.ProbeDeniedPort)
			}
		}
	}
	for _, grant := range config.Grants {
		if !strings.Contains(table, "iifname \""+config.CapsuleInterface+"\"") {
			return fmt.Errorf("nft table missing ingress interface %s", config.CapsuleInterface)
		}
		if !strings.Contains(table, string(grant.Protocol)+" dport "+strconv.Itoa(grant.Port)+" accept") {
			return fmt.Errorf("nft table missing ingress %s port %d accept", grant.Protocol, grant.Port)
		}
	}
	return nil
}

func verifyCapsuleIngressHostTable(config capsuleIngressConfig, table string) error {
	if err := validateCapsuleIngressConfig(config); err != nil {
		return err
	}
	if !nftTableContainsSequence(table, "table", capsuleIngressNftFamily, config.HostNatTable) {
		return fmt.Errorf("nft host ingress table missing table %s %s", capsuleIngressNftFamily, config.HostNatTable)
	}
	if !nftTableContainsSequence(table, "chain", "output") {
		return errors.New("nft host ingress table missing output chain")
	}
	if !nftTableContainsSequence(table, "hook", "output") {
		return errors.New("nft host ingress table is not scoped to host output")
	}
	if nftTableContainsSequence(table, "hook", "prerouting") {
		return errors.New("nft host ingress table exposes prerouting")
	}
	if nftTableContainsToken(table, "iifname") || nftTableContainsToken(table, "oifname") {
		return errors.New("nft host ingress table must not match public interfaces")
	}
	if containsNetworkToken(table, "0.0.0.0/0") {
		return errors.New("nft host ingress table contains public all-sources match")
	}
	if config.ProbeDeniedPort != 0 {
		deniedPort := strconv.Itoa(config.ProbeDeniedPort)
		for _, line := range strings.Split(table, "\n") {
			fields := nftLineFields(line)
			if nftFieldsContainSequence(fields, "dport", deniedPort) ||
				nftFieldsContainToken(fields, config.CapsuleAddr+":"+deniedPort) {
				return fmt.Errorf("nft host ingress table contains non-granted port %d", config.ProbeDeniedPort)
			}
		}
	}
	for _, grant := range config.Grants {
		port := strconv.Itoa(grant.Port)
		if !nftTableContainsSequence(table, "ip", "daddr", config.HostAddr) {
			return fmt.Errorf("nft host ingress table missing host-veth address %s", config.HostAddr)
		}
		if !nftTableContainsSequence(table, string(grant.Protocol), "dport", port) {
			return fmt.Errorf("nft host ingress table missing %s dport %d", grant.Protocol, grant.Port)
		}
		if !capsuleIngressHostDNATGrantPresent(config, table, grant) {
			return fmt.Errorf("nft host ingress table missing dnat to capsule port %d", grant.Port)
		}
	}
	return nil
}

func capsuleIngressHostDNATGrantPresent(config capsuleIngressConfig, table string, grant capsuleIngressGrant) bool {
	for _, line := range strings.Split(table, "\n") {
		if capsuleIngressHostDNATLineMatches(config, grant, line) {
			return true
		}
	}
	return false
}

func capsuleIngressHostDNATLineMatches(config capsuleIngressConfig, grant capsuleIngressGrant, line string) bool {
	fields := nftLineFields(line)
	port := strconv.Itoa(grant.Port)
	return nftFieldsContainSequence(fields, "ip", "daddr", config.HostAddr) &&
		nftFieldsContainSequence(fields, string(grant.Protocol), "dport", port) &&
		(nftFieldsContainSequence(fields, "dnat", "to", config.CapsuleAddr+":"+port) ||
			nftFieldsContainSequence(fields, "dnat", "ip", "to", config.CapsuleAddr+":"+port))
}

func nftTableContainsSequence(table string, want ...string) bool {
	for _, line := range strings.Split(table, "\n") {
		if nftFieldsContainSequence(nftLineFields(line), want...) {
			return true
		}
	}
	return false
}

func nftTableContainsToken(table string, want string) bool {
	for _, line := range strings.Split(table, "\n") {
		if nftFieldsContainToken(nftLineFields(line), want) {
			return true
		}
	}
	return false
}

func nftLineFields(line string) []string {
	raw := strings.Fields(line)
	fields := make([]string, 0, len(raw))
	for _, field := range raw {
		if strings.HasPrefix(field, "#") {
			break
		}
		field = strings.Trim(field, "{};,")
		if field != "" {
			fields = append(fields, field)
		}
	}
	return fields
}

func nftFieldsContainSequence(fields []string, want ...string) bool {
	if len(want) == 0 {
		return true
	}
	if len(fields) < len(want) {
		return false
	}
	for start := 0; start <= len(fields)-len(want); start++ {
		matched := true
		for offset, token := range want {
			if fields[start+offset] != token {
				matched = false
				break
			}
		}
		if matched {
			return true
		}
	}
	return false
}

func nftFieldsContainToken(fields []string, want string) bool {
	for _, field := range fields {
		if field == want {
			return true
		}
	}
	return false
}

func refreshCapsuleIngressProof(ctx context.Context, status *ExecuteNetworkStatus, proof capsuleIngressProof) {
	if status == nil {
		return
	}
	check := capsuleIngressCheck{
		HostAddr:   status.IngressHostAddr,
		Port:       status.IngressPort,
		DeniedPort: status.IngressDeniedPort,
		Drop:       status.IngressDrop,
		Status:     capsuleIngressStatusOK,
	}
	if !measuredCapsuleIngressListenerProof(proof, check) {
		return
	}
	reach := probeCapsuleIngressTCP(ctx, check.HostAddr, check.Port)
	denied := probeCapsuleIngressTCP(ctx, check.HostAddr, check.DeniedPort)
	if reach != capsuleIngressReachOK || denied == capsuleIngressReachOK {
		return
	}
	status.IngressReach = capsuleIngressReachOK
	status.IngressDrop = capsuleIngressDropEnforced
}

func measuredCapsuleIngressListenerProof(proof capsuleIngressProof, check capsuleIngressCheck) bool {
	return check.Status == capsuleIngressStatusOK &&
		check.Drop == capsuleIngressDropEnforced &&
		check.HostAddr != "" &&
		check.Port > 0 &&
		check.DeniedPort > 0 &&
		proof.Port == check.Port &&
		proof.DeniedPort == check.DeniedPort &&
		proof.Listener == capsuleIngressListenerOK &&
		proof.Status == capsuleIngressStatusOK
}

func probeCapsuleIngressTCP(ctx context.Context, host string, port int) string {
	if host == "" || port <= 0 || port > 65535 {
		return capsuleIngressStatusFail
	}
	dialer := net.Dialer{Timeout: 500 * time.Millisecond}
	conn, err := dialer.DialContext(ctx, "tcp4", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return capsuleIngressStatusFail
	}
	_ = conn.Close()
	return capsuleIngressReachOK
}
