package capsule

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/netip"
	"strconv"
	"strings"

	"github.com/vita/agent/capabilities/network"
)

const (
	hostileNetCapsuleID = "local.hostile-net.capsule"

	capsuleNetLimitValueEnforced    = "enforced"
	capsuleNetLimitValueNotEnforced = "not_enforced"
	capsuleNetLimitValueUnknown     = "unknown"
	capsuleNetLimitStatusOK         = "OK"
	capsuleNetLimitStatusFail       = "FAIL"
)

type CapsuleNetLimitsStatus struct {
	Egress    string `json:"egress"`
	Ingress   string `json:"ingress"`
	Isolation string `json:"isolation"`
	Status    string `json:"status"`
}

func shouldConfirmCapsuleNetLimitEnforcement(manifest ExecutionManifest) bool {
	return manifest.ID == hostileNetCapsuleID && manifest.Network != nil
}

func confirmCapsuleNetLimits(ctx context.Context, manifest ExecutionManifest, unit transientUnit, check *capsuleNetnsCheck) (CapsuleNetLimitsStatus, error) {
	if err := ctx.Err(); err != nil {
		return unknownCapsuleNetLimitsStatus(), err
	}
	if manifest.Network == nil {
		return unknownCapsuleNetLimitsStatus(), errors.New("hostile capsule network manifest is absent")
	}
	if unit.NetNS == nil || unit.NetNS.Egress == nil {
		return unknownCapsuleNetLimitsStatus(), errors.New("hostile capsule network namespace is absent")
	}
	if check == nil {
		return unknownCapsuleNetLimitsStatus(), errors.New("hostile capsule network namespace check is absent")
	}

	config := *unit.NetNS.Egress
	status := CapsuleNetLimitsStatus{
		Egress:    capsuleNetLimitValueNotEnforced,
		Ingress:   capsuleNetLimitValueNotEnforced,
		Isolation: capsuleNetLimitValueNotEnforced,
		Status:    capsuleNetLimitStatusFail,
	}
	var errs error

	if err := confirmCapsuleNetLimitsEgress(config, check); err == nil {
		status.Egress = capsuleNetLimitValueEnforced
	} else {
		errs = errors.Join(errs, fmt.Errorf("egress: %w", err))
	}
	if err := confirmCapsuleNetLimitsIngress(config, check); err == nil {
		status.Ingress = capsuleNetLimitValueEnforced
	} else {
		errs = errors.Join(errs, fmt.Errorf("ingress: %w", err))
	}
	if err := confirmCapsuleNetLimitsIsolation(config, unit.Properties, check); err == nil {
		status.Isolation = capsuleNetLimitValueEnforced
	} else {
		errs = errors.Join(errs, fmt.Errorf("isolation: %w", err))
	}

	if status.Egress == capsuleNetLimitValueEnforced &&
		status.Ingress == capsuleNetLimitValueEnforced &&
		status.Isolation == capsuleNetLimitValueEnforced {
		status.Status = capsuleNetLimitStatusOK
		return status, nil
	}

	return status, errs
}

func confirmCapsuleNetLimitsEgress(config capsuleEgressConfig, check *capsuleNetnsCheck) error {
	if len(config.Grants) == 0 {
		return errors.New("hostile capsule egress grants are absent")
	}
	if check.Egress == nil {
		return errors.New("agent egress check is absent")
	}
	if check.Egress.Status != capsuleEgressStatusOK || check.Egress.Drop != capsuleEgressDropEnforced {
		return fmt.Errorf("agent egress check is not enforced: drop=%s status=%s", check.Egress.Drop, check.Egress.Status)
	}
	if check.Egress.AllowedCIDR == "" || check.Egress.DeniedCIDR == "" {
		return errors.New("agent egress probes are absent")
	}
	if check.Egress.AllowedCIDR != config.ProbeAllowedCIDR || check.Egress.DeniedCIDR != config.ProbeDeniedCIDR {
		return fmt.Errorf("agent egress probes do not match derived config: allowed=%s denied=%s", check.Egress.AllowedCIDR, check.Egress.DeniedCIDR)
	}
	if check.Egress.Table == "" {
		return errors.New("agent egress nft table evidence is absent")
	}
	return verifyCapsuleNetLimitsEgressTable(config, check.Egress.Table)
}

func confirmCapsuleNetLimitsIngress(config capsuleEgressConfig, check *capsuleNetnsCheck) error {
	if config.Ingress == nil || len(config.Ingress.Grants) == 0 {
		return errors.New("hostile capsule ingress grants are absent")
	}
	if check.Ingress == nil {
		return errors.New("agent ingress check is absent")
	}
	if check.Ingress.Status != capsuleIngressStatusOK || check.Ingress.Drop != capsuleIngressDropEnforced {
		return fmt.Errorf("agent ingress check is not enforced: drop=%s status=%s", check.Ingress.Drop, check.Ingress.Status)
	}
	if check.Ingress.Port <= 0 || check.Ingress.DeniedPort <= 0 || check.Ingress.Port == check.Ingress.DeniedPort {
		return errors.New("agent ingress probes are invalid")
	}
	if check.Ingress.HostAddr != config.Ingress.HostAddr ||
		check.Ingress.Port != config.Ingress.ProbePort ||
		check.Ingress.DeniedPort != config.Ingress.ProbeDeniedPort {
		return fmt.Errorf("agent ingress probes do not match derived config: host=%s port=%d denied=%d", check.Ingress.HostAddr, check.Ingress.Port, check.Ingress.DeniedPort)
	}
	if check.Egress == nil || check.Egress.Table == "" || check.Egress.HostTable == "" {
		return errors.New("agent ingress nft table evidence is absent")
	}
	if err := verifyCapsuleIngressNetnsTable(*config.Ingress, check.Egress.Table); err != nil {
		return err
	}
	return verifyCapsuleNetLimitsIngressHostTable(*config.Ingress, check.Egress.HostTable)
}

func confirmCapsuleNetLimitsIsolation(config capsuleEgressConfig, properties []systemdProperty, check *capsuleNetnsCheck) error {
	if check.Status != capsuleNetnsMeasuredStatusOK || check.Isolation != capsuleNetnsIsolationEnforced {
		return fmt.Errorf("agent netns check is not enforced: isolation=%s status=%s", check.Isolation, check.Status)
	}
	if err := capsuleNetLimitsOnlyVethAndLoopback(config, check.Interfaces); err != nil {
		return err
	}
	if err := capsuleNetLimitsHostAddrNotGranted(config); err != nil {
		return err
	}
	return capsuleNetLimitsHardening(properties)
}

func capsuleNetLimitsOnlyVethAndLoopback(config capsuleEgressConfig, interfaces []string) error {
	if len(interfaces) != 2 {
		return fmt.Errorf("capsule netns exposes %d interfaces, want lo and %s", len(interfaces), config.CapsuleInterface)
	}
	seenLoopback := false
	seenVeth := false
	for _, name := range interfaces {
		switch name {
		case "lo":
			seenLoopback = true
		case config.CapsuleInterface:
			seenVeth = true
		default:
			return fmt.Errorf("capsule netns exposes unexpected interface %s", name)
		}
	}
	if !seenLoopback || !seenVeth {
		return fmt.Errorf("capsule netns interfaces = %s, want lo and %s", strings.Join(interfaces, ","), config.CapsuleInterface)
	}
	return nil
}

func capsuleNetLimitsHostAddrNotGranted(config capsuleEgressConfig) error {
	addr, err := netip.ParseAddr(config.HostAddr)
	if err != nil {
		return fmt.Errorf("capsule host veth address is invalid: %w", err)
	}
	if config.allowsAddr(addr) {
		return fmt.Errorf("capsule egress grants include host veth address %s", config.HostAddr)
	}
	return nil
}

func capsuleNetLimitsHardening(properties []systemdProperty) error {
	if !hasSystemdProperty(properties, "NoNewPrivileges", "yes") {
		return errors.New("NoNewPrivileges is not enforced")
	}
	if !hasSystemdProperty(properties, "CapabilityBoundingSet", "") {
		return errors.New("CapabilityBoundingSet is not empty")
	}
	if !hasSystemdProperty(properties, "AmbientCapabilities", "") {
		return errors.New("AmbientCapabilities is not empty")
	}
	if !hasSystemdProperty(properties, "RestrictNamespaces", "yes") {
		return errors.New("RestrictNamespaces is not enforced")
	}
	if !hasSystemdProperty(properties, "RestrictAddressFamilies", "AF_UNIX AF_INET AF_INET6 AF_NETLINK") {
		return errors.New("RestrictAddressFamilies is not the granted-capsule set")
	}
	if !hasSystemdProperty(properties, "SystemCallFilter", "@system-service") {
		return errors.New("SystemCallFilter @system-service is absent")
	}
	if !hasSystemdPropertyContaining(properties, "SystemCallFilter", "@privileged") ||
		!hasSystemdPropertyContaining(properties, "SystemCallFilter", "@raw-io") {
		return errors.New("SystemCallFilter privileged/raw-io deny set is absent")
	}
	return nil
}

func verifyCapsuleNetLimitsEgressTable(config capsuleEgressConfig, table string) error {
	if err := verifyCapsuleEgressTable(config, table); err != nil {
		return err
	}
	for _, line := range strings.Split(table, "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.Contains(trimmed, " accept") {
			continue
		}
		if capsuleNetLimitsAllowedAcceptLine(config, trimmed) {
			continue
		}
		return fmt.Errorf("nft table contains non-granted accept: %s", trimmed)
	}
	return nil
}

func capsuleNetLimitsAllowedAcceptLine(config capsuleEgressConfig, line string) bool {
	switch {
	case line == `iifname "lo" accept`, line == `oifname "lo" accept`:
		return true
	case strings.Contains(line, "ct state established,related accept"),
		strings.Contains(line, "ct state related,established accept"):
		return true
	case capsuleNetLimitsAllowedEgressAccept(config, line):
		return true
	case capsuleNetLimitsAllowedIngressAccept(config.Ingress, line):
		return true
	default:
		return false
	}
}

func capsuleNetLimitsAllowedEgressAccept(config capsuleEgressConfig, line string) bool {
	if !strings.Contains(line, " daddr ") {
		return false
	}
	for _, grant := range config.Grants {
		if !tableContainsDestination(line, grant.Destination) {
			continue
		}
		if !strings.Contains(line, string(grant.Protocol)) {
			continue
		}
		if grant.Port != network.PortAll && !strings.Contains(line, "dport "+strconv.Itoa(grant.Port)) {
			continue
		}
		return true
	}
	return false
}

func capsuleNetLimitsAllowedIngressAccept(config *capsuleIngressConfig, line string) bool {
	if config == nil {
		return false
	}
	if !strings.Contains(line, `iifname "`+config.CapsuleInterface+`"`) {
		return false
	}
	for _, grant := range config.Grants {
		if strings.Contains(line, string(grant.Protocol)+" dport "+strconv.Itoa(grant.Port)+" accept") {
			return true
		}
	}
	return false
}

func verifyCapsuleNetLimitsIngressHostTable(config capsuleIngressConfig, table string) error {
	if err := verifyCapsuleIngressHostTable(config, table); err != nil {
		return err
	}
	for _, line := range strings.Split(table, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.Contains(trimmed, " accept") {
			return fmt.Errorf("nft host ingress table contains unexpected accept: %s", trimmed)
		}
		if !strings.Contains(trimmed, "dnat to") {
			continue
		}
		if capsuleNetLimitsAllowedHostDNAT(config, trimmed) {
			continue
		}
		return fmt.Errorf("nft host ingress table contains non-granted dnat: %s", trimmed)
	}
	return nil
}

func capsuleNetLimitsAllowedHostDNAT(config capsuleIngressConfig, line string) bool {
	for _, grant := range config.Grants {
		port := strconv.Itoa(grant.Port)
		if strings.Contains(line, "ip daddr "+config.HostAddr) &&
			strings.Contains(line, string(grant.Protocol)+" dport "+port) &&
			strings.Contains(line, "dnat to "+config.CapsuleAddr+":"+port) {
			return true
		}
	}
	return false
}

func hasSystemdProperty(properties []systemdProperty, name string, value string) bool {
	for _, property := range properties {
		if property.Name == name && property.Value == value {
			return true
		}
	}
	return false
}

func hasSystemdPropertyContaining(properties []systemdProperty, name string, token string) bool {
	for _, property := range properties {
		if property.Name == name && strings.Contains(property.Value, token) {
			return true
		}
	}
	return false
}

func logCapsuleNetLimitsStatus(id string, status CapsuleNetLimitsStatus) {
	status = normalizeCapsuleNetLimitsStatus(status)
	log.Printf(
		"VITA-CAPSULE-NET-LIMITS: id=%s egress=%s ingress=%s isolation=%s status=%s",
		id,
		status.Egress,
		status.Ingress,
		status.Isolation,
		status.Status,
	)
}

func normalizeCapsuleNetLimitsStatus(status CapsuleNetLimitsStatus) CapsuleNetLimitsStatus {
	if status.Egress == "" {
		status.Egress = capsuleNetLimitValueUnknown
	}
	if status.Ingress == "" {
		status.Ingress = capsuleNetLimitValueUnknown
	}
	if status.Isolation == "" {
		status.Isolation = capsuleNetLimitValueUnknown
	}
	if status.Status == "" {
		status.Status = capsuleNetLimitStatusFail
	}
	return status
}

func unknownCapsuleNetLimitsStatus() CapsuleNetLimitsStatus {
	return CapsuleNetLimitsStatus{
		Egress:    capsuleNetLimitValueUnknown,
		Ingress:   capsuleNetLimitValueUnknown,
		Isolation: capsuleNetLimitValueUnknown,
		Status:    capsuleNetLimitStatusFail,
	}
}

func cloneCapsuleNetLimitsStatus(status *CapsuleNetLimitsStatus) *CapsuleNetLimitsStatus {
	if status == nil {
		return nil
	}
	cloned := *status
	return &cloned
}
