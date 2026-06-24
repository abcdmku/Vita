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
	"github.com/vita/agent/internal/sysdeps"
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

type capsuleNetLimitsStepFailure struct {
	Step string
	Err  error
}

type capsuleNetLimitsReasonedFailure struct {
	Reason string
	Err    error
}

func (e *capsuleNetLimitsStepFailure) Error() string {
	if e == nil {
		return "capsule net limits step failed"
	}
	if e.Err == nil {
		return e.Step
	}
	return e.Step + ": " + e.Err.Error()
}

func (e *capsuleNetLimitsStepFailure) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func (e *capsuleNetLimitsReasonedFailure) Error() string {
	if e == nil {
		return "capsule net limits validation failed"
	}
	if e.Err == nil {
		return e.Reason
	}
	return e.Reason + ": " + e.Err.Error()
}

func (e *capsuleNetLimitsReasonedFailure) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func capsuleNetLimitsStepError(step string, err error) error {
	if err == nil {
		return nil
	}
	return &capsuleNetLimitsStepFailure{Step: step, Err: err}
}

func capsuleNetLimitsReasonedError(reason string, err error) error {
	if err == nil {
		return nil
	}
	return &capsuleNetLimitsReasonedFailure{Reason: reason, Err: err}
}

func shouldConfirmCapsuleNetLimitEnforcement(manifest ExecutionManifest) bool {
	return manifest.ID == hostileNetCapsuleID && manifest.Network != nil
}

func confirmCapsuleNetLimits(ctx context.Context, manifest ExecutionManifest, unit transientUnit, check *capsuleNetnsCheck) (CapsuleNetLimitsStatus, error) {
	if err := ctx.Err(); err != nil {
		return unknownCapsuleNetLimitsStatus(), capsuleNetLimitsStepError("context", err)
	}
	if manifest.Network == nil {
		return unknownCapsuleNetLimitsStatus(), capsuleNetLimitsStepError("hostile_manifest", errors.New("hostile capsule network manifest is absent"))
	}
	if unit.NetNS == nil || unit.NetNS.Egress == nil {
		return unknownCapsuleNetLimitsStatus(), capsuleNetLimitsStepError("hostile_netns", errors.New("hostile capsule network namespace is absent"))
	}
	if check == nil {
		return unknownCapsuleNetLimitsStatus(), capsuleNetLimitsStepError("hostile_check", errors.New("hostile capsule network namespace check is absent"))
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
		errs = errors.Join(errs, capsuleNetLimitsAxisError("egress_confirm", err))
	}
	if err := confirmCapsuleNetLimitsIngress(ctx, config, check); err == nil {
		status.Ingress = capsuleNetLimitValueEnforced
	} else {
		errs = errors.Join(errs, capsuleNetLimitsAxisError("ingress_confirm", err))
	}
	if err := confirmCapsuleNetLimitsIsolation(config, unit.Properties, check); err == nil {
		status.Isolation = capsuleNetLimitValueEnforced
	} else {
		errs = errors.Join(errs, capsuleNetLimitsAxisError("isolation_confirm", err))
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

func capsuleNetLimitsAxisError(axis string, err error) error {
	if err == nil {
		return nil
	}
	var stepErr *capsuleNetLimitsStepFailure
	if errors.As(err, &stepErr) && stepErr != nil && (stepErr.Step == axis || strings.HasPrefix(stepErr.Step, axis+":")) {
		return err
	}
	return capsuleNetLimitsStepError(axis, err)
}

func capsuleNetLimitsSubstepError(axis string, substep string, err error) error {
	if err == nil {
		return nil
	}
	return capsuleNetLimitsStepError(axis+":"+substep, err)
}

func confirmCapsuleNetLimitsIngress(ctx context.Context, config capsuleEgressConfig, check *capsuleNetnsCheck) error {
	const axis = "ingress_confirm"
	if config.Ingress == nil || len(config.Ingress.Grants) == 0 {
		return capsuleNetLimitsSubstepError(axis, "grants_absent", errors.New("hostile capsule ingress grants are absent"))
	}
	if check.Ingress == nil {
		return capsuleNetLimitsSubstepError(axis, "agent_check_absent", errors.New("agent ingress check is absent"))
	}
	if check.Ingress.Drop != capsuleIngressDropEnforced {
		return capsuleNetLimitsSubstepError(axis, "policy_not_drop", fmt.Errorf("agent ingress check is not enforced: drop=%s status=%s", check.Ingress.Drop, check.Ingress.Status))
	}
	if check.Ingress.Port <= 0 || check.Ingress.DeniedPort <= 0 || check.Ingress.Port == check.Ingress.DeniedPort {
		return capsuleNetLimitsSubstepError(axis, "probe_invalid", errors.New("agent ingress probes are invalid"))
	}
	if check.Ingress.HostAddr != config.Ingress.HostAddr ||
		check.Ingress.Port != config.Ingress.ProbePort ||
		check.Ingress.DeniedPort != config.Ingress.ProbeDeniedPort {
		return capsuleNetLimitsSubstepError(axis, "probe_mismatch", fmt.Errorf("agent ingress probes do not match derived config: host=%s port=%d denied=%d", check.Ingress.HostAddr, check.Ingress.Port, check.Ingress.DeniedPort))
	}
	if check.Egress == nil || check.Egress.Table == "" || check.Egress.HostTable == "" {
		return capsuleNetLimitsSubstepError(axis, "nft_read_err", errors.New("agent ingress nft table evidence is absent"))
	}
	if err := verifyCapsuleIngressNetnsTable(*config.Ingress, check.Egress.Table); err != nil {
		return capsuleNetLimitsSubstepError(axis, "netns_table_invalid", err)
	}
	if err := verifyCapsuleNetLimitsIngressHostTable(*config.Ingress, check.Egress.HostTable); err != nil {
		substep := "host_table_invalid"
		if reason := capsuleNetLimitsReasonedFailureReason(err); reason != "" {
			substep += ":" + reason
		}
		return capsuleNetLimitsSubstepError(axis, substep, err)
	}
	if reached := probeCapsuleIngressTCP(ctx, check.Ingress.HostAddr, check.Ingress.DeniedPort); reached == capsuleIngressReachOK {
		return capsuleNetLimitsSubstepError(axis, "nonGranted_reachable", fmt.Errorf("non-granted ingress %s:%d was reachable", check.Ingress.HostAddr, check.Ingress.DeniedPort))
	}
	return nil
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
	if !hasDenyPrefixedSystemCallFilter(properties, "@privileged", "@raw-io") {
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
		return capsuleNetLimitsReasonedError(capsuleNetLimitsIngressHostTableReason(err), err)
	}
	for _, line := range strings.Split(table, "\n") {
		trimmed := strings.TrimSpace(line)
		if capsuleNetLimitsHostAcceptRule(trimmed) {
			return capsuleNetLimitsReasonedError("unexpected_accept_rule", fmt.Errorf("nft host ingress table contains unexpected accept: %s", trimmed))
		}
		if !capsuleNetLimitsHostDNATLine(trimmed) {
			continue
		}
		if capsuleNetLimitsAllowedHostDNAT(config, trimmed) {
			continue
		}
		return capsuleNetLimitsReasonedError("non_granted_dnat", fmt.Errorf("nft host ingress table contains non-granted dnat: %s", trimmed))
	}
	return nil
}

func capsuleNetLimitsAllowedHostDNAT(config capsuleIngressConfig, line string) bool {
	for _, grant := range config.Grants {
		if capsuleIngressHostDNATLineMatches(config, grant, line) {
			return true
		}
	}
	return false
}

func capsuleNetLimitsHostAcceptRule(line string) bool {
	if line == "" {
		return false
	}
	fields := nftLineFields(line)
	if nftFieldsContainSequence(fields, "type", "nat", "hook", "output") &&
		nftFieldsContainSequence(fields, "policy", "accept") {
		acceptTokens := 0
		for _, field := range fields {
			if field == "accept" {
				acceptTokens++
			}
		}
		return acceptTokens > 1
	}
	return nftFieldsContainToken(fields, "accept")
}

func capsuleNetLimitsHostDNATLine(line string) bool {
	fields := nftLineFields(line)
	return nftFieldsContainToken(fields, "dnat") && nftFieldsContainToken(fields, "to")
}

func capsuleNetLimitsReasonedFailureReason(err error) string {
	var reasoned *capsuleNetLimitsReasonedFailure
	if errors.As(err, &reasoned) && reasoned != nil {
		return reasoned.Reason
	}
	return ""
}

func capsuleNetLimitsIngressHostTableReason(err error) string {
	if err == nil {
		return "unknown"
	}
	message := err.Error()
	switch {
	case strings.Contains(message, "missing table"):
		return "missing_table"
	case strings.Contains(message, "missing output chain"):
		return "missing_output_chain"
	case strings.Contains(message, "not scoped to host output"):
		return "missing_output_hook"
	case strings.Contains(message, "exposes prerouting"):
		return "prerouting_hook"
	case strings.Contains(message, "must not match public interfaces"):
		return "public_interface_match"
	case strings.Contains(message, "public all-sources"):
		return "public_all_sources"
	case strings.Contains(message, "non-granted port"):
		return "non_granted_port"
	case strings.Contains(message, "missing host-veth address"):
		return "missing_host_addr"
	case strings.Contains(message, "missing") && strings.Contains(message, "dport"):
		return "missing_granted_dport"
	case strings.Contains(message, "missing dnat"):
		return "missing_granted_dnat"
	default:
		return "parse_error"
	}
}

func hasSystemdProperty(properties []systemdProperty, name string, value string) bool {
	for _, property := range properties {
		if property.Name == name && property.Value == value {
			return true
		}
	}
	return false
}

func hasDenyPrefixedSystemCallFilter(properties []systemdProperty, tokens ...string) bool {
	for _, property := range properties {
		if property.Name != "SystemCallFilter" || !strings.HasPrefix(strings.TrimSpace(property.Value), "~") {
			continue
		}
		hasAll := true
		for _, token := range tokens {
			if !strings.Contains(property.Value, token) {
				hasAll = false
				break
			}
		}
		if hasAll {
			return true
		}
	}
	return false
}

func capsuleNetLimitsFailureReason(err error) string {
	reason := "unknown"
	var limitsErr *capsuleNetLimitsStepFailure
	if errors.As(err, &limitsErr) && limitsErr != nil {
		reason = capsuleNetLimitsStepReason(limitsErr.Step, limitsErr.Err)
	} else {
		var netnsErr *capsuleNetnsStepFailure
		if errors.As(err, &netnsErr) && netnsErr != nil {
			reason = capsuleNetLimitsStepReason(netnsErr.Step, netnsErr.Err)
		}
	}
	return "capsule_net_limits_failed:" + reason
}

func capsuleNetLimitsStepReason(step string, err error) string {
	reason := step
	if reason == "" {
		reason = "unknown"
	}
	if errno := sysdeps.ErrnoCode(err); errno != "" {
		reason += "_" + errno
	}
	return reason
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
