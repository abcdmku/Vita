package capsule

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/netip"
	"os"
	"os/exec"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/capabilities/network"
	capsuleruntime "github.com/vita/agent/internal/capsule-runtime"
	"github.com/vita/agent/internal/jsonsafe"
	capsulestorage "github.com/vita/agent/storage/capsules"
	"github.com/vita/agent/transaction"
)

const (
	ExecuteName = "capsule.execute"

	defaultCapsuleRoot  = "/usr/lib/vita/capsules"
	defaultDenoPath     = "/usr/lib/vita/deno"
	defaultWasmtimePath = "/usr/lib/vita/bin/wasmtime"
	systemdRunPath      = "/usr/bin/systemd-run"
	systemctlPath       = "/usr/bin/systemctl"

	executePackageClassTSService   = "ts-service"
	executePackageClassOCIService  = "oci-service"
	executePackageClassWasmService = "wasm-service"

	maxCPUQuotaCores = 64
	maxMemoryMiB     = 1024 * 1024
	maxStorageMiB    = 1024 * 1024
	maxTasks         = 16384
)

type ExecuteDesired struct {
	ID        string `json:"id"`
	Version   string `json:"version"`
	Integrity string `json:"integrity"`
}

func (d ExecuteDesired) Validate() error {
	return validateExecuteDesired(d, "desired")
}

func (d *ExecuteDesired) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, executeDesiredFields); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	id, err := requiredStringField(fields, "id")
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	version, err := requiredStringField(fields, "version")
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	integrity, err := requiredStringField(fields, "integrity")
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	desired := ExecuteDesired{
		ID:        id,
		Version:   version,
		Integrity: integrity,
	}
	if err := desired.Validate(); err != nil {
		return err
	}

	*d = desired
	return nil
}

type ExecuteApplyRequest struct {
	Desired *ExecuteDesired `json:"desired"`
}

func (ExecuteApplyRequest) CapabilityRequest() {}

func (r *ExecuteApplyRequest) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, executeApplyRequestFields); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	rawDesired, ok := fields["desired"]
	if !ok || bytes.Equal(bytes.TrimSpace(rawDesired), []byte("null")) {
		return &ExecuteInvalidRequestError{Reason: "desired is required"}
	}

	var desired ExecuteDesired
	if err := decodeSingleJSONValue(rawDesired, &desired); err != nil {
		return err
	}

	*r = ExecuteApplyRequest{Desired: &desired}
	return nil
}

func (r ExecuteApplyRequest) Validate() error {
	if r.Desired == nil {
		return &ExecuteInvalidRequestError{Reason: "desired is required"}
	}
	return r.Desired.Validate()
}

type ExecuteReadRequest struct{}

func (ExecuteReadRequest) CapabilityRequest() {}

func (ExecuteReadRequest) Validate() error { return nil }

type ExecuteReadResponse struct {
	Last *ExecuteStatus `json:"last,omitempty"`
}

func (ExecuteReadResponse) CapabilityResponse() {}

type ExecuteStatus struct {
	ID         string                  `json:"id"`
	Unit       string                  `json:"unit"`
	DynamicUID string                  `json:"dynamicUid"`
	Health     string                  `json:"health"`
	Status     string                  `json:"status"`
	Volumes    []ExecuteVolumeStatus   `json:"volumes,omitempty"`
	OCILimits  *OCILimitsStatus        `json:"ociLimits,omitempty"`
	NetLimits  *CapsuleNetLimitsStatus `json:"netLimits,omitempty"`
	Network    *ExecuteNetworkStatus   `json:"network,omitempty"`
}

type ExecuteNetworkStatus struct {
	Ingress           int    `json:"ingress"`
	Egress            int    `json:"egress"`
	NetNS             string `json:"netns,omitempty"`
	Loopback          string `json:"loopback,omitempty"`
	Isolation         string `json:"isolation,omitempty"`
	IngressPort       int    `json:"ingressPort,omitempty"`
	IngressReach      string `json:"ingressReach,omitempty"`
	IngressDeniedPort int    `json:"ingressDeniedPort,omitempty"`
	IngressDrop       string `json:"ingressDrop,omitempty"`
	EgressAllowed     string `json:"egressAllowed,omitempty"`
	EgressReach       string `json:"egressReach,omitempty"`
	EgressDenied      string `json:"egressDenied,omitempty"`
	EgressDrop        string `json:"egressDrop,omitempty"`
	IngressHostAddr   string `json:"-"`
	ProofPath         string `json:"-"`
}

type ExecuteVolumeStatus struct {
	Name           string `json:"name"`
	Path           string `json:"path"`
	StateDirectory string `json:"stateDirectory"`
	Access         string `json:"access"`
	Mounted        string `json:"mounted"`
	Status         string `json:"status"`
}

type ExecuteCapability struct {
	registryFS registryFileSystem
	manifests  executionManifestStore
	launcher   transientUnitLauncher
	netns      capsuleNetnsManager
	supervisor *capsuleruntime.Supervisor

	mu   sync.Mutex
	last *ExecuteStatus
}

type ExecuteInvalidRequestError struct {
	Reason string
	Code   string
}

func (e *ExecuteInvalidRequestError) Error() string {
	return fmt.Sprintf("invalid capsule execute request: %s", e.Reason)
}

func (e *ExecuteInvalidRequestError) ApplyErrorCode() string {
	if e == nil || e.Code == "" {
		return "capsule_execute_rejected"
	}
	return e.Code
}

type ExecuteStartError struct {
	Code string
	Err  error
}

func (e *ExecuteStartError) Error() string {
	if e == nil {
		return "capsule start failed"
	}
	if e.Err == nil {
		return e.ApplyErrorCode()
	}
	return fmt.Sprintf("%s: %v", e.ApplyErrorCode(), e.Err)
}

func (e *ExecuteStartError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func (e *ExecuteStartError) ApplyErrorCode() string {
	if e == nil || e.Code == "" {
		return "capsule_start_failed"
	}
	return e.Code
}

func executeStartFailureCode(manifest ExecutionManifest, unit transientUnit, err error) string {
	if manifest.PackageClass == executePackageClassOCIService {
		var startErr *transientUnitStartError
		if errors.As(err, &startErr) && startErr.Code != "" {
			return startErr.Code
		}
		return "oci_start_failed"
	}
	if len(unit.Volumes) > 0 {
		return "capsule_volume_start_failed"
	}
	return "capsule_start_failed"
}

func NewExecuteCapability() *ExecuteCapability {
	return NewExecuteCapabilityWithSupervisor(capsuleruntime.NewSupervisor(capsuleruntime.Options{}))
}

func NewExecuteCapabilityWithSupervisor(supervisor *capsuleruntime.Supervisor) *ExecuteCapability {
	return newExecuteCapabilityWithSupervisor(
		newDefaultFileSystem(),
		fileExecutionManifestStore{root: defaultCapsuleRoot},
		systemdRunLauncher{
			systemdRun: systemdRunPath,
			systemctl:  systemctlPath,
		},
		supervisor,
	)
}

func newExecuteCapability(registryFS registryFileSystem, manifests executionManifestStore, launcher transientUnitLauncher) *ExecuteCapability {
	return newExecuteCapabilityWithSupervisor(registryFS, manifests, launcher, nil)
}

func newExecuteCapabilityWithSupervisor(registryFS registryFileSystem, manifests executionManifestStore, launcher transientUnitLauncher, supervisor *capsuleruntime.Supervisor) *ExecuteCapability {
	return newExecuteCapabilityWithNetns(registryFS, manifests, launcher, newDefaultCapsuleNetnsManager(), supervisor)
}

func newExecuteCapabilityWithNetns(registryFS registryFileSystem, manifests executionManifestStore, launcher transientUnitLauncher, netns capsuleNetnsManager, supervisor *capsuleruntime.Supervisor) *ExecuteCapability {
	return &ExecuteCapability{
		registryFS: registryFS,
		manifests:  manifests,
		launcher:   launcher,
		netns:      netns,
		supervisor: supervisor,
	}
}

func (c *ExecuteCapability) Name() string {
	return ExecuteName
}

func (c *ExecuteCapability) Handle(ctx context.Context, req capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	if _, ok := req.(ExecuteReadRequest); !ok {
		return nil, &ExecuteInvalidRequestError{Reason: "expected capsule.ExecuteReadRequest"}
	}
	if c == nil {
		return nil, &ExecuteInvalidRequestError{Reason: "missing capsule execute capability"}
	}

	if err := ctx.Err(); err != nil {
		return nil, err
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	if c.last == nil {
		return ExecuteReadResponse{}, nil
	}
	last := *c.last
	last.Volumes = cloneExecuteVolumeStatuses(c.last.Volumes)
	last.OCILimits = cloneOCILimitsStatus(c.last.OCILimits)
	last.NetLimits = cloneCapsuleNetLimitsStatus(c.last.NetLimits)
	last.Network = cloneExecuteNetworkStatus(c.last.Network)
	if c.supervisor != nil {
		for _, workload := range c.supervisor.Snapshot() {
			if workload.Unit == last.Unit {
				last.Health = string(workload.Health)
				last.Status = string(workload.Status)
				break
			}
		}
	}
	c.refreshNetworkProof(ctx, &last)
	return ExecuteReadResponse{Last: &last}, nil
}

func (c *ExecuteCapability) Apply(ctx context.Context, req capabilities.TypedRequest) (transaction.Undo, error) {
	applyReq, ok := req.(ExecuteApplyRequest)
	if !ok {
		return nil, &ExecuteInvalidRequestError{Reason: "expected capsule.ExecuteApplyRequest"}
	}
	if c == nil || c.registryFS == nil || c.manifests == nil || c.launcher == nil {
		return nil, &ExecuteInvalidRequestError{Reason: "missing capsule execute dependency"}
	}
	if applyReq.Desired == nil {
		return nil, &ExecuteInvalidRequestError{Reason: "desired is required"}
	}

	desired := *applyReq.Desired
	if err := validateExecuteDesired(desired, "desired"); err != nil {
		return nil, err
	}

	entry, err := c.installedEntry(ctx, desired)
	if err != nil {
		return nil, err
	}

	manifest, err := c.manifests.Load(ctx, desired.ID)
	if err != nil {
		return nil, err
	}
	if err := validateManifestMatchesRequest(manifest, desired, entry); err != nil {
		return nil, err
	}

	unit, err := composeTransientUnit(manifest)
	if err != nil {
		return nil, err
	}
	healthChecks, err := healthChecksForUnit(manifest.HealthChecks, unit.Name)
	if err != nil {
		return nil, &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	var createdNetns *capsuleNetns
	if unit.NetNS != nil {
		if c.netns == nil {
			return nil, &ExecuteInvalidRequestError{Reason: "missing capsule netns manager"}
		}
		netns, err := c.netns.Create(ctx, *unit.NetNS)
		if err != nil {
			reason := capsuleNetnsFailureReason(err)
			if shouldConfirmCapsuleNetLimitEnforcement(manifest) {
				reason = capsuleNetLimitsFailureReason(err)
			}
			log.Printf("VITA-CAPSULE-NET-NS-ERROR: reason=%s status=FAILSAFE", reason)
			return nil, &ExecuteStartError{Code: reason, Err: err}
		}
		unit.NetNS = &netns
		unit.Properties = replaceCapsuleNetnsProperties(unit.Properties, unit.NetNS)
		createdNetns = &netns
	}

	status, err := c.launcher.StartTransientUnit(ctx, unit)
	if err != nil {
		code := executeStartFailureCode(manifest, unit, err)
		if shouldConfirmCapsuleNetLimitEnforcement(manifest) {
			code = capsuleNetLimitsFailureReason(capsuleNetLimitsStepError("hostile_launch", err))
		} else if createdNetns != nil {
			code = capsuleNetnsFailureReason(capsuleNetnsStepError("join_unit", err))
		} else if manifest.PackageClass != executePackageClassOCIService && len(unit.Volumes) > 0 {
			code = "capsule_volume_start_failed"
			log.Printf("VITA-CAPSULE-VOLUME-ERROR: reason=%s status=FAILSAFE", code)
		}
		if createdNetns != nil {
			if cleanupErr := c.netns.Teardown(ctx, *createdNetns); cleanupErr != nil {
				err = errors.Join(err, cleanupErr)
			}
			log.Printf("VITA-CAPSULE-NET-NS-ERROR: reason=%s status=FAILSAFE", code)
		}
		return nil, &ExecuteStartError{Code: code, Err: err}
	}
	if unit.NetNS != nil && unit.NetNS.Private {
		if status.NetworkNamespacePath == "" {
			limitErr := capsuleNetnsStepError("join_unit", errors.New("systemd did not report a capsule network namespace path"))
			cleanupErr := errors.Join(
				stopAndUnlinkTransientUnit(ctx, c.launcher, unit.Name),
				c.netns.Teardown(ctx, *unit.NetNS),
			)
			reason := capsuleNetnsFailureReason(limitErr)
			if shouldConfirmCapsuleNetLimitEnforcement(manifest) {
				reason = capsuleNetLimitsFailureReason(limitErr)
			}
			log.Printf("VITA-CAPSULE-NET-NS-ERROR: reason=%s status=FAILSAFE", reason)
			return nil, &ExecuteStartError{Code: reason, Err: errors.Join(limitErr, cleanupErr)}
		}
		unit.NetNS.Path = status.NetworkNamespacePath
	}

	var netnsCheck *capsuleNetnsCheck
	if unit.NetNS != nil {
		checked, checkErr := c.netns.Check(ctx, *unit.NetNS)
		netnsCheck = &checked
		if checkErr != nil || checked.Status != capsuleNetnsMeasuredStatusOK || checked.Isolation != capsuleNetnsIsolationEnforced {
			limitErr := checkErr
			if limitErr == nil {
				limitErr = capsuleNetnsStepError("check_lo", fmt.Errorf("capsule network namespace isolation not enforced"))
			}
			cleanupErr := errors.Join(
				stopAndUnlinkTransientUnit(ctx, c.launcher, unit.Name),
				c.netns.Teardown(ctx, *unit.NetNS),
			)
			reason := capsuleNetnsFailureReason(limitErr)
			if shouldConfirmCapsuleNetLimitEnforcement(manifest) {
				reason = capsuleNetLimitsFailureReason(limitErr)
			}
			log.Printf("VITA-CAPSULE-NET-NS-ERROR: reason=%s status=FAILSAFE", reason)
			return nil, &ExecuteStartError{Code: reason, Err: errors.Join(limitErr, cleanupErr)}
		}
	}

	var netLimits *CapsuleNetLimitsStatus
	if shouldConfirmCapsuleNetLimitEnforcement(manifest) {
		confirmed, err := confirmCapsuleNetLimits(ctx, manifest, unit, netnsCheck)
		confirmed = normalizeCapsuleNetLimitsStatus(confirmed)
		netLimits = &confirmed
		logCapsuleNetLimitsStatus(manifest.ID, confirmed)
		if err != nil || confirmed.Status != capsuleNetLimitStatusOK {
			limitErr := err
			if limitErr == nil {
				limitErr = capsuleNetLimitsStepError("limits_status", fmt.Errorf("capsule net limits not enforced: egress=%s ingress=%s isolation=%s", confirmed.Egress, confirmed.Ingress, confirmed.Isolation))
			}
			if cleanupErr := stopAndUnlinkTransientUnit(ctx, c.launcher, unit.Name); cleanupErr != nil {
				limitErr = errors.Join(limitErr, cleanupErr)
			}
			if createdNetns != nil {
				if cleanupErr := c.netns.Teardown(ctx, *createdNetns); cleanupErr != nil {
					limitErr = errors.Join(limitErr, cleanupErr)
				}
				log.Printf("VITA-CAPSULE-NET-NS-ERROR: reason=%s status=FAILSAFE", capsuleNetLimitsFailureReason(limitErr))
			}
			return nil, &ExecuteStartError{Code: capsuleNetLimitsFailureReason(limitErr), Err: limitErr}
		}
	}

	var ociLimits *OCILimitsStatus
	if shouldConfirmOCILimitEnforcement(manifest) {
		confirmed, err := c.launcher.ConfirmOCILimits(ctx, unit.Name, manifest.ResourceLimits)
		confirmed = normalizeOCILimitsStatus(confirmed)
		ociLimits = &confirmed
		logOCILimitsStatus(manifest.ID, confirmed)
		if err != nil || confirmed.Status != ociLimitStatusOK {
			limitErr := err
			if limitErr == nil {
				limitErr = fmt.Errorf("oci cgroup limits not enforced: mem=%s tasks=%s cpu=%s", confirmed.Mem, confirmed.Tasks, confirmed.CPU)
			}
			if cleanupErr := stopAndUnlinkTransientUnit(ctx, c.launcher, unit.Name); cleanupErr != nil {
				limitErr = errors.Join(limitErr, cleanupErr)
			}
			if createdNetns != nil {
				if cleanupErr := c.netns.Teardown(ctx, *createdNetns); cleanupErr != nil {
					limitErr = errors.Join(limitErr, cleanupErr)
				}
				log.Printf("VITA-CAPSULE-NET-NS-ERROR: reason=oci_limits_failed status=FAILSAFE")
			}
			return nil, &ExecuteStartError{Code: "oci_limits_failed", Err: limitErr}
		}
	}

	executeStatus := ExecuteStatus{
		ID:         manifest.ID,
		Unit:       unit.Name,
		DynamicUID: status.DynamicUID,
		Health:     "OK",
		Status:     "OK",
		Volumes:    volumeStatuses(unit.Volumes),
		OCILimits:  ociLimits,
		NetLimits:  netLimits,
		Network:    executeNetworkStatus(manifest.Network, unit.NetNS, netnsCheck),
	}
	c.setLast(executeStatus)
	c.startWorkload(manifest.ID, unit.Name, healthChecks)
	for _, volume := range unit.Volumes {
		log.Printf("VITA-CAPSULE-VOLUME: id=%s vol=%s path=%s mounted=OK status=OK", manifest.ID, volume.Name, volume.Path)
	}

	return executeUndo{
		capability: c,
		launcher:   c.launcher,
		netns:      c.netns,
		unit:       unit.Name,
		unitNetns:  createdNetns,
	}, nil
}

func (c *ExecuteCapability) installedEntry(ctx context.Context, desired ExecuteDesired) (CapsuleEntry, error) {
	snapshot, err := c.registryFS.Read(ctx)
	if err != nil {
		return CapsuleEntry{}, err
	}
	if !snapshot.exists {
		return CapsuleEntry{}, &ExecuteInvalidRequestError{Reason: "capsule registry is absent"}
	}

	registry, err := parseRegistry(snapshot.bytes)
	if err != nil {
		return CapsuleEntry{}, err
	}
	if registry.Capsules == nil {
		return CapsuleEntry{}, &ExecuteInvalidRequestError{Reason: "capsule registry is invalid"}
	}

	for _, entry := range *registry.Capsules {
		if entry.ID != desired.ID {
			continue
		}
		if entry.State != StateInstalled {
			return CapsuleEntry{}, &ExecuteInvalidRequestError{Reason: "capsule is not installed"}
		}
		if entry.Version != desired.Version || entry.Integrity != desired.Integrity {
			return CapsuleEntry{}, &ExecuteInvalidRequestError{Reason: "capsule registry entry does not match execute request"}
		}
		return entry, nil
	}

	return CapsuleEntry{}, &ExecuteInvalidRequestError{Reason: "unknown capsule"}
}

func (c *ExecuteCapability) setLast(status ExecuteStatus) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.last = &ExecuteStatus{
		ID:         status.ID,
		Unit:       status.Unit,
		DynamicUID: status.DynamicUID,
		Health:     status.Health,
		Status:     status.Status,
		Volumes:    cloneExecuteVolumeStatuses(status.Volumes),
		OCILimits:  cloneOCILimitsStatus(status.OCILimits),
		NetLimits:  cloneCapsuleNetLimitsStatus(status.NetLimits),
		Network:    cloneExecuteNetworkStatus(status.Network),
	}
}

func (c *ExecuteCapability) clearLast(unit string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.last != nil && c.last.Unit == unit {
		c.last = nil
	}
}

func (c *ExecuteCapability) refreshNetworkProof(ctx context.Context, status *ExecuteStatus) {
	if status == nil || status.Network == nil || status.Network.ProofPath == "" {
		return
	}
	proof, ok := readCapsuleNetnsProof(ctx, status.Network.ProofPath)
	if !ok || !measuredCapsuleNetnsProof(proof, status.ID) {
		return
	}
	status.Network.Loopback = capsuleNetnsLoopbackOK
	if proof.Egress != nil {
		check := capsuleEgressCheck{
			AllowedCIDR: status.Network.EgressAllowed,
			DeniedCIDR:  status.Network.EgressDenied,
			Drop:        status.Network.EgressDrop,
			Status:      capsuleEgressStatusOK,
		}
		if measuredCapsuleEgressProof(*proof.Egress, check) {
			status.Network.EgressReach = capsuleEgressReachOK
			status.Network.EgressDrop = capsuleEgressDropEnforced
		}
	}
	if proof.Ingress != nil {
		refreshCapsuleIngressProof(ctx, status.Network, *proof.Ingress)
	}
}

func (c *ExecuteCapability) startWorkload(id string, unit string, checks []capsuleruntime.Check) {
	if c.supervisor == nil {
		return
	}
	c.supervisor.StartWorkload(capsuleruntime.WorkloadSpec{
		ID:     id,
		Unit:   unit,
		Checks: checks,
	})
}

func (c *ExecuteCapability) stopWorkload(unit string) {
	if c.supervisor != nil {
		c.supervisor.StopWorkload(unit)
	}
}

func (c *ExecuteCapability) Workloads() []capsuleruntime.WorkloadStatus {
	if c == nil || c.supervisor == nil {
		return []capsuleruntime.WorkloadStatus{}
	}
	return c.supervisor.Snapshot()
}

func volumeStatuses(volumes []capsulestorage.VolumeMount) []ExecuteVolumeStatus {
	if len(volumes) == 0 {
		return nil
	}

	out := make([]ExecuteVolumeStatus, 0, len(volumes))
	for _, volume := range volumes {
		out = append(out, ExecuteVolumeStatus{
			Name:           volume.Name,
			Path:           volume.Path,
			StateDirectory: volume.StateDirectory,
			Access:         string(volume.Access),
			Mounted:        "OK",
			Status:         "OK",
		})
	}
	return out
}

func cloneExecuteVolumeStatuses(volumes []ExecuteVolumeStatus) []ExecuteVolumeStatus {
	if len(volumes) == 0 {
		return nil
	}
	out := make([]ExecuteVolumeStatus, len(volumes))
	copy(out, volumes)
	return out
}

type executeUndo struct {
	capability *ExecuteCapability
	launcher   transientUnitLauncher
	netns      capsuleNetnsManager
	unit       string
	unitNetns  *capsuleNetns
}

func (u executeUndo) Undo(ctx context.Context) error {
	if u.launcher == nil {
		return &ExecuteInvalidRequestError{Reason: "missing capsule execute launcher"}
	}
	if err := stopAndUnlinkTransientUnit(ctx, u.launcher, u.unit); err != nil {
		return err
	}
	if u.unitNetns != nil {
		if u.netns == nil {
			return &ExecuteInvalidRequestError{Reason: "missing capsule netns manager"}
		}
		if err := u.netns.Teardown(ctx, *u.unitNetns); err != nil {
			return err
		}
	}
	if u.capability != nil {
		u.capability.stopWorkload(u.unit)
		u.capability.clearLast(u.unit)
	}
	return nil
}

type ExecutionManifest struct {
	ID             string                  `json:"id"`
	Version        string                  `json:"version"`
	Integrity      string                  `json:"integrity"`
	PackageClass   string                  `json:"packageClass"`
	Runtime        ExecutionRuntime        `json:"runtime"`
	ResourceLimits ExecutionResourceLimits `json:"resourceLimits"`
	Data           ExecutionData           `json:"data,omitempty"`
	HealthChecks   []capsuleruntime.Check  `json:"healthChecks,omitempty"`
	Network        *ExecutionNetwork       `json:"network,omitempty"`

	baseDir string
}

func (m *ExecutionManifest) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, executionManifestFields); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	id, err := requiredStringField(fields, "id")
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	version, err := requiredStringField(fields, "version")
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	integrity, err := requiredStringField(fields, "integrity")
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	packageClass, err := requiredStringField(fields, "packageClass")
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	var runtime ExecutionRuntime
	if err := requiredObjectField(fields, "runtime", &runtime); err != nil {
		return err
	}
	var limits ExecutionResourceLimits
	if err := requiredObjectField(fields, "resourceLimits", &limits); err != nil {
		return err
	}
	healthChecks, err := optionalHealthChecksField(fields, "healthChecks")
	if err != nil {
		return err
	}
	data, err := optionalExecutionDataField(fields, "data")
	if err != nil {
		return err
	}
	networkPolicy, err := optionalExecutionNetworkField(fields, "network")
	if err != nil {
		return err
	}

	manifest := ExecutionManifest{
		ID:             id,
		Version:        version,
		Integrity:      integrity,
		PackageClass:   packageClass,
		Runtime:        runtime,
		ResourceLimits: limits,
		Data:           data,
		HealthChecks:   healthChecks,
		Network:        networkPolicy,
	}
	if err := manifest.Validate(); err != nil {
		return err
	}

	*m = manifest
	return nil
}

func (m ExecutionManifest) Validate() error {
	if !validCapsuleID(m.ID) {
		return &ExecuteInvalidRequestError{Reason: "manifest.id must be a well-formed capsule id"}
	}
	if !validVersion(m.Version) {
		return &ExecuteInvalidRequestError{Reason: "manifest.version must be a safe non-inline version string"}
	}
	if !isValidSRI(m.Integrity) {
		return &ExecuteInvalidRequestError{Reason: "manifest.integrity must be a real SRI integrity"}
	}
	switch m.PackageClass {
	case executePackageClassTSService, executePackageClassOCIService, executePackageClassWasmService:
	default:
		return &ExecuteInvalidRequestError{Reason: "manifest.packageClass must be ts-service, oci-service, or wasm-service"}
	}
	if err := m.Runtime.ValidateForPackageClass(m.PackageClass); err != nil {
		return err
	}
	if err := m.ResourceLimits.Validate(); err != nil {
		return err
	}
	if err := m.Data.Validate(); err != nil {
		return err
	}
	if m.Network != nil {
		if err := m.Network.Validate(); err != nil {
			return err
		}
	}
	for i, check := range m.HealthChecks {
		if err := check.Validate(); err != nil {
			return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("healthChecks[%d]: %v", i, err)}
		}
	}
	return nil
}

type ExecutionRuntime struct {
	TypeScript TypeScriptExecution `json:"typescript"`
	OCI        OCIExecution        `json:"oci"`
	Wasm       WasmExecution       `json:"wasm"`
}

func (r *ExecutionRuntime) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, executionRuntimeFields); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	rawTS, hasTS := fields["typescript"]
	rawOCI, hasOCI := fields["oci"]
	rawWasm, hasWasm := fields["wasm"]
	declared := 0
	if hasTS {
		declared++
	}
	if hasOCI {
		declared++
	}
	if hasWasm {
		declared++
	}
	if declared != 1 {
		return &ExecuteInvalidRequestError{Reason: "runtime must declare exactly one of typescript, oci, or wasm"}
	}

	var runtime ExecutionRuntime
	switch {
	case hasTS:
		if bytes.Equal(bytes.TrimSpace(rawTS), []byte("null")) {
			return &ExecuteInvalidRequestError{Reason: "runtime.typescript is required"}
		}
		var ts TypeScriptExecution
		if err := decodeSingleJSONValue(rawTS, &ts); err != nil {
			return err
		}
		runtime.TypeScript = ts
	case hasOCI:
		if bytes.Equal(bytes.TrimSpace(rawOCI), []byte("null")) {
			return &ExecuteInvalidRequestError{Reason: "runtime.oci is required"}
		}
		var oci OCIExecution
		if err := decodeSingleJSONValue(rawOCI, &oci); err != nil {
			return err
		}
		runtime.OCI = oci
	default:
		if bytes.Equal(bytes.TrimSpace(rawWasm), []byte("null")) {
			return &ExecuteInvalidRequestError{Reason: "runtime.wasm is required"}
		}
		var wasm WasmExecution
		if err := decodeSingleJSONValue(rawWasm, &wasm); err != nil {
			return err
		}
		runtime.Wasm = wasm
	}

	*r = runtime
	return nil
}

func (r ExecutionRuntime) Validate() error {
	valid := 0
	if err := r.TypeScript.Validate(); err == nil {
		valid++
	}
	if err := r.OCI.Validate(); err == nil {
		valid++
	}
	if err := r.Wasm.Validate(); err == nil {
		valid++
	}
	if valid == 1 {
		return nil
	}
	return &ExecuteInvalidRequestError{Reason: "runtime must declare exactly one supported runtime"}
}

func (r ExecutionRuntime) ValidateForPackageClass(packageClass string) error {
	switch packageClass {
	case executePackageClassTSService:
		if err := r.TypeScript.Validate(); err != nil {
			return err
		}
		if err := r.OCI.Validate(); err == nil {
			return &ExecuteInvalidRequestError{Reason: "runtime.oci must not be declared for ts-service"}
		}
		if err := r.Wasm.Validate(); err == nil {
			return &ExecuteInvalidRequestError{Reason: "runtime.wasm must not be declared for ts-service"}
		}
	case executePackageClassOCIService:
		if err := r.OCI.Validate(); err != nil {
			return err
		}
		if err := r.TypeScript.Validate(); err == nil {
			return &ExecuteInvalidRequestError{Reason: "runtime.typescript must not be declared for oci-service"}
		}
		if err := r.Wasm.Validate(); err == nil {
			return &ExecuteInvalidRequestError{Reason: "runtime.wasm must not be declared for oci-service"}
		}
	case executePackageClassWasmService:
		if err := r.Wasm.Validate(); err != nil {
			return err
		}
		if err := r.TypeScript.Validate(); err == nil {
			return &ExecuteInvalidRequestError{Reason: "runtime.typescript must not be declared for wasm-service"}
		}
		if err := r.OCI.Validate(); err == nil {
			return &ExecuteInvalidRequestError{Reason: "runtime.oci must not be declared for wasm-service"}
		}
	default:
		return &ExecuteInvalidRequestError{Reason: "manifest.packageClass must be ts-service, oci-service, or wasm-service"}
	}
	return nil
}

type ExecutionData struct {
	Classes []capsulestorage.DataClass  `json:"classes,omitempty"`
	Volumes []capsulestorage.VolumeSpec `json:"volumes,omitempty"`
}

func (d *ExecutionData) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, executionDataFields); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	classes, err := requiredDataClassesField(fields, "classes")
	if err != nil {
		return err
	}
	volumes, err := requiredVolumesField(fields, "volumes")
	if err != nil {
		return err
	}

	out := ExecutionData{
		Classes: classes,
		Volumes: volumes,
	}
	if err := out.Validate(); err != nil {
		return err
	}

	*d = out
	return nil
}

func (d ExecutionData) Validate() error {
	for i, class := range d.Classes {
		if !validExecutionDataClass(class) {
			return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("data.classes[%d] must be a supported data class", i)}
		}
	}
	seenClasses := make(map[capsulestorage.DataClass]int, len(d.Classes))
	for i, class := range d.Classes {
		if previous, ok := seenClasses[class]; ok {
			return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("data.classes[%d] duplicates data.classes[%d]", i, previous)}
		}
		seenClasses[class] = i
	}
	if len(d.Volumes) > 0 && len(seenClasses) == 0 {
		return &ExecuteInvalidRequestError{Reason: "data.classes must declare volume classes"}
	}
	seenVolumes := make(map[string]int, len(d.Volumes))
	for i, volume := range d.Volumes {
		if err := volume.Validate(); err != nil {
			return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("data.volumes[%d]: %v", i, err)}
		}
		if previous, ok := seenVolumes[volume.Name]; ok {
			return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("data.volumes[%d].name duplicates data.volumes[%d].name", i, previous)}
		}
		seenVolumes[volume.Name] = i
		if len(d.Classes) > 0 {
			if _, ok := seenClasses[volume.Class]; !ok {
				return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("data.volumes[%d].class must be declared in data.classes", i)}
			}
		}
	}
	return nil
}

type ExecutionNetwork struct {
	Ingress []ExecutionNetworkIngressRule `json:"ingress"`
	Egress  []ExecutionNetworkEgressRule  `json:"egress"`
}

func (n *ExecutionNetwork) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, executionNetworkFields); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	ingress, err := requiredNetworkIngressField(fields, "ingress")
	if err != nil {
		return err
	}
	egress, err := requiredNetworkEgressField(fields, "egress")
	if err != nil {
		return err
	}

	out := ExecutionNetwork{
		Ingress: ingress,
		Egress:  egress,
	}
	if err := out.Validate(); err != nil {
		return err
	}

	*n = out
	return nil
}

func (n ExecutionNetwork) Validate() error {
	for i, rule := range n.Ingress {
		if err := rule.Validate(i); err != nil {
			return err
		}
	}
	for i, rule := range n.Egress {
		if err := rule.Validate(i); err != nil {
			return err
		}
	}
	return nil
}

type ExecutionNetworkIngressRule struct {
	Direction      string           `json:"direction,omitempty"`
	Name           string           `json:"name,omitempty"`
	Protocol       network.Protocol `json:"protocol"`
	Port           int              `json:"port"`
	SourceCIDR     string           `json:"sourceCidr"`
	Interface      string           `json:"interface"`
	Public         bool             `json:"public"`
	UnsafeWideOpen bool             `json:"unsafeWideOpen,omitempty"`
}

func (r *ExecutionNetworkIngressRule) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, executionNetworkIngressFields); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	name, err := optionalNetworkNameField(fields, "name")
	if err != nil {
		return err
	}
	direction, err := optionalNetworkDirectionField(fields, "direction", "ingress")
	if err != nil {
		return err
	}
	protocol, err := requiredNetworkProtocolField(fields, "protocol")
	if err != nil {
		return err
	}
	portValue, err := requiredNetworkPortField(fields, "port")
	if err != nil {
		return err
	}
	sourceCIDR, prefix, err := requiredNetworkCIDRField(fields, "sourceCidr")
	if err != nil {
		return err
	}
	iface, err := requiredNetworkInterfaceField(fields, "interface")
	if err != nil {
		return err
	}
	public, err := requiredBoolField(fields, "public")
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: "network.ingress[].public " + err.Error()}
	}
	unsafeWideOpen, err := optionalBoolField(fields, "unsafeWideOpen")
	if err != nil {
		return err
	}
	if network.SourceCoversAll(prefix) && !unsafeWideOpen {
		return &ExecuteInvalidRequestError{Reason: "network.ingress[].sourceCidr opens all sources without unsafeWideOpen"}
	}

	out := ExecutionNetworkIngressRule{
		Direction:      direction,
		Name:           name,
		Protocol:       protocol,
		Port:           portValue,
		SourceCIDR:     sourceCIDR,
		Interface:      iface,
		Public:         public,
		UnsafeWideOpen: unsafeWideOpen,
	}
	if err := out.Validate(0); err != nil {
		return err
	}

	*r = out
	return nil
}

func (r ExecutionNetworkIngressRule) Validate(index int) error {
	if r.Direction != "" && r.Direction != "ingress" {
		return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("network.ingress[%d].direction must be ingress", index)}
	}
	if r.Name != "" && !validExecutionNetworkName(r.Name) {
		return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("network.ingress[%d].name must be a safe network grant name", index)}
	}
	if !validNetworkProtocol(r.Protocol) {
		return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("network.ingress[%d].protocol must be tcp or udp", index)}
	}
	if !validNetworkPort(r.Port) {
		return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("network.ingress[%d].port must be 1-65535 or PortAll", index)}
	}
	prefix, err := network.NormalizeCIDR(r.SourceCIDR)
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("network.ingress[%d].sourceCidr %s", index, err)}
	}
	if network.SourceCoversAll(prefix) && !r.UnsafeWideOpen {
		return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("network.ingress[%d].sourceCidr opens all sources without unsafeWideOpen", index)}
	}
	if !network.ValidInterfaceName(r.Interface) || !safeExecutionNetworkString(r.Interface) {
		return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("network.ingress[%d].interface must be a concrete interface name", index)}
	}
	return nil
}

type ExecutionNetworkEgressRule struct {
	Direction      string           `json:"direction,omitempty"`
	Name           string           `json:"name,omitempty"`
	Protocol       network.Protocol `json:"protocol"`
	Destinations   []string         `json:"destinations"`
	Ports          []int            `json:"ports"`
	Interface      string           `json:"interface"`
	UnsafeWideOpen bool             `json:"unsafeWideOpen,omitempty"`
}

func (r *ExecutionNetworkEgressRule) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, executionNetworkEgressFields); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	name, err := optionalNetworkNameField(fields, "name")
	if err != nil {
		return err
	}
	direction, err := optionalNetworkDirectionField(fields, "direction", "egress")
	if err != nil {
		return err
	}
	protocol, err := requiredNetworkProtocolField(fields, "protocol")
	if err != nil {
		return err
	}
	destinations, prefixes, err := requiredNetworkDestinationsField(fields, "destinations")
	if err != nil {
		return err
	}
	ports, err := requiredNetworkPortsField(fields, "ports")
	if err != nil {
		return err
	}
	iface, err := requiredNetworkInterfaceField(fields, "interface")
	if err != nil {
		return err
	}
	unsafeWideOpen, err := optionalBoolField(fields, "unsafeWideOpen")
	if err != nil {
		return err
	}
	if coversAnyAll(prefixes) && !unsafeWideOpen {
		return &ExecuteInvalidRequestError{Reason: "network.egress[].destinations opens all destinations without unsafeWideOpen"}
	}

	out := ExecutionNetworkEgressRule{
		Direction:      direction,
		Name:           name,
		Protocol:       protocol,
		Destinations:   destinations,
		Ports:          ports,
		Interface:      iface,
		UnsafeWideOpen: unsafeWideOpen,
	}
	if err := out.Validate(0); err != nil {
		return err
	}

	*r = out
	return nil
}

func (r ExecutionNetworkEgressRule) Validate(index int) error {
	if r.Direction != "" && r.Direction != "egress" {
		return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("network.egress[%d].direction must be egress", index)}
	}
	if r.Name != "" && !validExecutionNetworkName(r.Name) {
		return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("network.egress[%d].name must be a safe network grant name", index)}
	}
	if !validNetworkProtocol(r.Protocol) {
		return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("network.egress[%d].protocol must be tcp or udp", index)}
	}
	if len(r.Destinations) == 0 {
		return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("network.egress[%d].destinations must not be empty", index)}
	}
	for i, destination := range r.Destinations {
		prefix, err := normalizeNetworkDestination(destination)
		if err != nil {
			return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("network.egress[%d].destinations[%d] %s", index, i, err)}
		}
		if network.SourceCoversAll(prefix) && !r.UnsafeWideOpen {
			return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("network.egress[%d].destinations[%d] opens all destinations without unsafeWideOpen", index, i)}
		}
	}
	if len(r.Ports) == 0 {
		return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("network.egress[%d].ports must not be empty", index)}
	}
	for i, portValue := range r.Ports {
		if !validNetworkPort(portValue) {
			return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("network.egress[%d].ports[%d] must be 1-65535 or PortAll", index, i)}
		}
	}
	if !network.ValidInterfaceName(r.Interface) || !safeExecutionNetworkString(r.Interface) {
		return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("network.egress[%d].interface must be a concrete interface name", index)}
	}
	return nil
}

type TypeScriptExecution struct {
	Entrypoint string `json:"entrypoint"`
}

func (e *TypeScriptExecution) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, typeScriptExecutionFields); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	entrypoint, err := requiredStringField(fields, "entrypoint")
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	out := TypeScriptExecution{Entrypoint: entrypoint}
	if err := out.Validate(); err != nil {
		return err
	}

	*e = out
	return nil
}

func (e TypeScriptExecution) Validate() error {
	if e.Entrypoint != "main.ts" {
		return &ExecuteInvalidRequestError{Reason: "runtime.typescript.entrypoint must be main.ts"}
	}
	return nil
}

type ExecutionResourceLimits struct {
	CPUCores   float64 `json:"cpuCores"`
	RamMiB     int64   `json:"ramMiB"`
	StorageMiB int64   `json:"storageMiB"`
	TasksMax   int64   `json:"tasksMax"`
}

func (l *ExecutionResourceLimits) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, executionResourceLimitFields); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	cpu, err := requiredPositiveFloatField(fields, "cpuCores")
	if err != nil {
		return err
	}
	ram, err := requiredPositiveInt64Field(fields, "ramMiB")
	if err != nil {
		return err
	}
	storage, err := requiredPositiveInt64Field(fields, "storageMiB")
	if err != nil {
		return err
	}
	tasks, err := requiredPositiveInt64Field(fields, "tasksMax")
	if err != nil {
		return err
	}

	limits := ExecutionResourceLimits{
		CPUCores:   cpu,
		RamMiB:     ram,
		StorageMiB: storage,
		TasksMax:   tasks,
	}
	if err := limits.Validate(); err != nil {
		return err
	}

	*l = limits
	return nil
}

func (l ExecutionResourceLimits) Validate() error {
	if !positiveFinite(l.CPUCores) || l.CPUCores > maxCPUQuotaCores {
		return &ExecuteInvalidRequestError{Reason: "resourceLimits.cpuCores must be positive and bounded"}
	}
	if l.RamMiB <= 0 || l.RamMiB > maxMemoryMiB {
		return &ExecuteInvalidRequestError{Reason: "resourceLimits.ramMiB must be positive and bounded"}
	}
	if l.StorageMiB <= 0 || l.StorageMiB > maxStorageMiB {
		return &ExecuteInvalidRequestError{Reason: "resourceLimits.storageMiB must be positive and bounded"}
	}
	if l.TasksMax <= 0 || l.TasksMax > maxTasks {
		return &ExecuteInvalidRequestError{Reason: "resourceLimits.tasksMax must be positive and bounded"}
	}
	return nil
}

type executionManifestStore interface {
	Load(context.Context, string) (ExecutionManifest, error)
}

type fileExecutionManifestStore struct {
	root string
}

func (s fileExecutionManifestStore) Load(ctx context.Context, id string) (ExecutionManifest, error) {
	if err := ctx.Err(); err != nil {
		return ExecutionManifest{}, err
	}
	if !validCapsuleID(id) {
		return ExecutionManifest{}, &ExecuteInvalidRequestError{Reason: "capsule id is invalid"}
	}

	baseDir := path.Join(s.root, id)
	manifestPath := path.Join(baseDir, "manifest.json")
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ExecutionManifest{}, &ExecuteInvalidRequestError{Reason: "capsule manifest is absent"}
		}
		return ExecutionManifest{}, fmt.Errorf("read capsule manifest: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return ExecutionManifest{}, err
	}

	var manifest ExecutionManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return ExecutionManifest{}, err
	}
	manifest.baseDir = baseDir

	if err := statExecutionManifestArtifacts(manifest); err != nil {
		return ExecutionManifest{}, err
	}

	return manifest, nil
}

type systemdProperty struct {
	Name  string
	Value string
}

type transientUnit struct {
	Name       string
	Argv       []string
	Properties []systemdProperty
	Volumes    []capsulestorage.VolumeMount
	NetNS      *capsuleNetns
}

type transientUnitStatus struct {
	DynamicUID           string
	NetworkNamespacePath string
}

type transientUnitDiagnostics struct {
	ActiveState    string
	SubState       string
	Result         string
	ExecMainCode   string
	ExecMainStatus string
}

type transientUnitStartError struct {
	Code        string
	Unit        string
	Diagnostics transientUnitDiagnostics
	Err         error
}

func (e *transientUnitStartError) Error() string {
	if e == nil {
		return "transient unit start failed"
	}
	detail := "transient unit start failed"
	if e.Unit != "" {
		detail = "transient unit " + e.Unit + " start failed"
	}
	if e.Code != "" {
		detail += ": " + e.Code
	}
	if e.Diagnostics != (transientUnitDiagnostics{}) {
		detail += fmt.Sprintf(
			" (active=%s sub=%s result=%s execCode=%s execStatus=%s)",
			e.Diagnostics.ActiveState,
			e.Diagnostics.SubState,
			e.Diagnostics.Result,
			e.Diagnostics.ExecMainCode,
			e.Diagnostics.ExecMainStatus,
		)
	}
	if e.Err != nil {
		detail += ": " + e.Err.Error()
	}
	return detail
}

func (e *transientUnitStartError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

type transientUnitLauncher interface {
	StartTransientUnit(context.Context, transientUnit) (transientUnitStatus, error)
	ConfirmOCILimits(context.Context, string, ExecutionResourceLimits) (OCILimitsStatus, error)
	StopTransientUnit(context.Context, string) error
	ResetFailedUnit(context.Context, string) error
}

type systemdRunLauncher struct {
	systemdRun string
	systemctl  string
}

func (l systemdRunLauncher) StartTransientUnit(ctx context.Context, unit transientUnit) (transientUnitStatus, error) {
	args := []string{"--unit", unit.Name, "--collect"}
	for _, property := range unit.Properties {
		args = append(args, "--property="+property.Name+"="+property.Value)
	}
	args = append(args, "--")
	args = append(args, unit.Argv...)

	if output, err := exec.CommandContext(ctx, l.systemdRun, args...).CombinedOutput(); err != nil {
		return transientUnitStatus{}, l.startError(ctx, unit.Name, fmt.Errorf("start capsule transient unit: %w: %s", err, strings.TrimSpace(string(output))))
	}

	if output, err := exec.CommandContext(ctx, l.systemctl, "is-active", "--quiet", unit.Name).CombinedOutput(); err != nil {
		startErr := l.startError(ctx, unit.Name, fmt.Errorf("capsule transient unit did not become active: %w: %s", err, strings.TrimSpace(string(output))))
		cleanupErr := stopAndUnlinkTransientUnit(ctx, l, unit.Name)
		if cleanupErr != nil {
			startErr.Err = errors.Join(startErr.Err, cleanupErr)
		}
		return transientUnitStatus{}, startErr
	}

	uid, err := l.dynamicUID(ctx, unit.Name)
	if err != nil {
		cleanupErr := stopAndUnlinkTransientUnit(ctx, l, unit.Name)
		return transientUnitStatus{}, errors.Join(err, cleanupErr)
	}

	netnsPath := ""
	if unit.NetNS != nil {
		pid, err := l.mainPID(ctx, unit.Name)
		if err != nil {
			cleanupErr := stopAndUnlinkTransientUnit(ctx, l, unit.Name)
			return transientUnitStatus{}, errors.Join(err, cleanupErr)
		}
		netnsPath = path.Join("/proc", pid, "ns/net")
	}

	return transientUnitStatus{DynamicUID: uid, NetworkNamespacePath: netnsPath}, nil
}

func (l systemdRunLauncher) startError(ctx context.Context, unit string, cause error) *transientUnitStartError {
	diagnostics, err := l.unitDiagnostics(ctx, unit)
	if err != nil {
		cause = errors.Join(cause, err)
	}
	return &transientUnitStartError{
		Code:        classifyTransientUnitStartFailure(diagnostics, cause.Error()),
		Unit:        unit,
		Diagnostics: diagnostics,
		Err:         cause,
	}
}

func (l systemdRunLauncher) StopTransientUnit(ctx context.Context, unit string) error {
	if output, err := exec.CommandContext(ctx, l.systemctl, "stop", unit).CombinedOutput(); err != nil {
		return fmt.Errorf("stop capsule transient unit: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func (l systemdRunLauncher) ResetFailedUnit(ctx context.Context, unit string) error {
	if output, err := exec.CommandContext(ctx, l.systemctl, "reset-failed", unit).CombinedOutput(); err != nil {
		return fmt.Errorf("reset capsule transient unit: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func (l systemdRunLauncher) dynamicUID(ctx context.Context, unit string) (string, error) {
	if uid, err := l.showUnitProperty(ctx, unit, "UID"); err == nil && uid != "" && uid != "[not set]" {
		if _, parseErr := strconv.ParseUint(uid, 10, 32); parseErr == nil {
			return uid, nil
		}
	}

	pid, err := l.mainPID(ctx, unit)
	if err != nil {
		return "", err
	}
	statusPath := path.Join("/proc", pid, "status")
	raw, err := os.ReadFile(statusPath)
	if err != nil {
		return "", fmt.Errorf("read capsule transient unit uid: %w", err)
	}
	uid, ok := parseProcStatusUID(raw)
	if !ok {
		return "", fmt.Errorf("read capsule transient unit uid: /proc status missing Uid")
	}
	return uid, nil
}

func (l systemdRunLauncher) mainPID(ctx context.Context, unit string) (string, error) {
	for _, property := range []string{"MainPID", "ExecMainPID"} {
		value, err := l.showUnitProperty(ctx, unit, property)
		if err != nil {
			return "", err
		}
		if value == "" || value == "0" {
			continue
		}
		if _, parseErr := strconv.ParseUint(value, 10, 32); parseErr != nil {
			return "", fmt.Errorf("read capsule transient unit pid: %s is invalid", property)
		}
		return value, nil
	}
	return "", fmt.Errorf("read capsule transient unit pid: no main pid")
}

func (l systemdRunLauncher) showUnitProperty(ctx context.Context, unit string, property string) (string, error) {
	output, err := exec.CommandContext(ctx, l.systemctl, "show", "--property="+property, "--value", unit).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("read capsule transient unit property %s: %w: %s", property, err, strings.TrimSpace(string(output)))
	}
	return strings.TrimSpace(string(output)), nil
}

func (l systemdRunLauncher) unitDiagnostics(ctx context.Context, unit string) (transientUnitDiagnostics, error) {
	args := []string{
		"show",
		"--property=ActiveState",
		"--property=SubState",
		"--property=Result",
		"--property=ExecMainCode",
		"--property=ExecMainStatus",
		unit,
	}
	output, err := exec.CommandContext(ctx, l.systemctl, args...).CombinedOutput()
	if err != nil {
		return transientUnitDiagnostics{}, fmt.Errorf("read capsule transient unit diagnostics: %w: %s", err, strings.TrimSpace(string(output)))
	}
	values := parseSystemctlShowProperties(output)
	return transientUnitDiagnostics{
		ActiveState:    values["ActiveState"],
		SubState:       values["SubState"],
		Result:         values["Result"],
		ExecMainCode:   values["ExecMainCode"],
		ExecMainStatus: values["ExecMainStatus"],
	}, nil
}

func parseSystemctlShowProperties(output []byte) map[string]string {
	values := make(map[string]string)
	for _, line := range strings.Split(string(output), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		name, value, ok := strings.Cut(line, "=")
		if !ok || name == "" {
			continue
		}
		values[name] = value
	}
	return values
}

func classifyTransientUnitStartFailure(diagnostics transientUnitDiagnostics, detail string) string {
	lowerDetail := strings.ToLower(detail)
	switch {
	case strings.Contains(lowerDetail, "permission denied") || strings.Contains(lowerDetail, "access denied"):
		return "permission_denied"
	case strings.Contains(lowerDetail, "failed at step namespace") ||
		strings.Contains(lowerDetail, "mount namespacing") ||
		strings.Contains(lowerDetail, "namespace"):
		return "namespace_setup_failed"
	case strings.Contains(lowerDetail, "rootdirectory") ||
		strings.Contains(lowerDetail, "root directory") ||
		strings.Contains(lowerDetail, "chroot"):
		return "rootfs_inaccessible"
	}

	switch strings.TrimSpace(diagnostics.ExecMainStatus) {
	case "203":
		return "exec_failed"
	case "210":
		return "rootfs_inaccessible"
	case "226":
		return "namespace_setup_failed"
	case "228":
		return "seccomp_setup_failed"
	}

	if strings.TrimSpace(diagnostics.Result) == "signal" && strings.TrimSpace(diagnostics.ExecMainStatus) == "31" {
		return "seccomp_blocked"
	}

	switch strings.TrimSpace(diagnostics.Result) {
	case "exit-code":
		return "process_exited"
	case "timeout":
		return "start_timeout"
	case "resources":
		return "resource_limit_failed"
	case "signal", "core-dump":
		return "process_signaled"
	}
	if diagnostics.ActiveState == "failed" || diagnostics.SubState == "failed" {
		return "unit_failed"
	}
	return "unit_start_failed"
}

var (
	executeApplyRequestFields = map[string]struct{}{
		"desired": {},
	}
	executeDesiredFields = map[string]struct{}{
		"id":        {},
		"integrity": {},
		"version":   {},
	}
	executionManifestFields = map[string]struct{}{
		"data":           {},
		"healthChecks":   {},
		"id":             {},
		"integrity":      {},
		"network":        {},
		"packageClass":   {},
		"resourceLimits": {},
		"runtime":        {},
		"version":        {},
	}
	executionRuntimeFields = map[string]struct{}{
		"oci":        {},
		"typescript": {},
		"wasm":       {},
	}
	executionDataFields = map[string]struct{}{
		"classes": {},
		"volumes": {},
	}
	executionNetworkFields = map[string]struct{}{
		"egress":  {},
		"ingress": {},
	}
	executionNetworkIngressFields = map[string]struct{}{
		"direction":      {},
		"interface":      {},
		"name":           {},
		"port":           {},
		"protocol":       {},
		"public":         {},
		"sourceCidr":     {},
		"unsafeWideOpen": {},
	}
	executionNetworkEgressFields = map[string]struct{}{
		"destinations":   {},
		"direction":      {},
		"interface":      {},
		"name":           {},
		"ports":          {},
		"protocol":       {},
		"unsafeWideOpen": {},
	}
	typeScriptExecutionFields = map[string]struct{}{
		"entrypoint": {},
	}
	executionResourceLimitFields = map[string]struct{}{
		"cpuCores":   {},
		"ramMiB":     {},
		"storageMiB": {},
		"tasksMax":   {},
	}
	unsafeRuntimeDirRune = regexp.MustCompile(`[^A-Za-z0-9_.-]+`)
	networkNamePattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`)
	networkMetaCharacter = regexp.MustCompile("[\\\\'\"`$;&|<>()\\[\\]{}!*?%]")
)

func validateExecuteDesired(desired ExecuteDesired, field string) error {
	if desired.ID == "" {
		return &ExecuteInvalidRequestError{Reason: field + ".id is required"}
	}
	if !validCapsuleID(desired.ID) {
		return &ExecuteInvalidRequestError{Reason: field + ".id must be a well-formed capsule id"}
	}
	if desired.Version == "" {
		return &ExecuteInvalidRequestError{Reason: field + ".version is required"}
	}
	if !validVersion(desired.Version) {
		return &ExecuteInvalidRequestError{Reason: field + ".version must be a safe non-inline version string"}
	}
	if desired.Integrity == "" {
		return &ExecuteInvalidRequestError{Reason: field + ".integrity is required"}
	}
	if !isValidSRI(desired.Integrity) {
		return &ExecuteInvalidRequestError{Reason: field + ".integrity must be a real SRI integrity"}
	}
	return nil
}

func validateManifestMatchesRequest(manifest ExecutionManifest, desired ExecuteDesired, entry CapsuleEntry) error {
	if err := manifest.Validate(); err != nil {
		return err
	}
	if manifest.ID != desired.ID || manifest.Version != desired.Version || manifest.Integrity != desired.Integrity {
		return &ExecuteInvalidRequestError{Reason: "capsule manifest does not match execute request"}
	}
	if entry.ID != manifest.ID || entry.Version != manifest.Version || entry.Integrity != manifest.Integrity || entry.State != StateInstalled {
		return &ExecuteInvalidRequestError{Reason: "capsule registry entry does not match manifest"}
	}
	return nil
}

func statExecutionManifestArtifacts(manifest ExecutionManifest) error {
	switch manifest.PackageClass {
	case executePackageClassTSService:
		entrypointPath, err := manifestEntrypointPath(manifest)
		if err != nil {
			return err
		}
		if _, err := os.Stat(entrypointPath); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return &ExecuteInvalidRequestError{Reason: "capsule entrypoint is absent"}
			}
			return fmt.Errorf("stat capsule entrypoint: %w", err)
		}
	case executePackageClassOCIService:
		return statOCIManifestArtifacts(manifest)
	case executePackageClassWasmService:
		return statWasmManifestArtifacts(manifest)
	default:
		return &ExecuteInvalidRequestError{Reason: "manifest.packageClass must be ts-service, oci-service, or wasm-service"}
	}
	return nil
}

func composeTransientUnit(manifest ExecutionManifest) (transientUnit, error) {
	switch manifest.PackageClass {
	case executePackageClassTSService:
		return composeTypeScriptTransientUnit(manifest)
	case executePackageClassOCIService:
		return composeOCITransientUnit(manifest)
	case executePackageClassWasmService:
		return composeWasmTransientUnit(manifest)
	default:
		return transientUnit{}, &ExecuteInvalidRequestError{Reason: "manifest.packageClass must be ts-service, oci-service, or wasm-service"}
	}
}

func composeTypeScriptTransientUnit(manifest ExecutionManifest) (transientUnit, error) {
	entrypoint, err := manifestEntrypointPath(manifest)
	if err != nil {
		return transientUnit{}, err
	}

	unitName := capsuleUnitName(manifest.ID)
	runtimeDir := capsuleRuntimeDirectory(manifest.ID)
	networkProofPath := ""
	var netns *capsuleNetns
	if manifest.Network != nil {
		networkProofPath = "/run/" + runtimeDir + "/netns-proof.json"
		unitNetns, err := capsuleNetnsForNetwork(unitName, networkProofPath, manifest.Network)
		if err != nil {
			return transientUnit{}, err
		}
		netns = &unitNetns
	}
	limits := manifest.ResourceLimits
	volumes, err := capsulestorage.SetupVolumes(manifest.ID, manifest.Data.Volumes)
	if err != nil {
		return transientUnit{}, &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	argv := denoArgv(entrypoint, volumes, networkProofPath)
	properties := hardenedTransientUnitProperties(manifest, true)
	environment := "DENO_DIR=/run/" + runtimeDir + " DENO_NO_UPDATE_CHECK=1 NO_COLOR=1"
	if networkProofPath != "" {
		environment += " VITA_CAPSULE_NETNS_PROOF=" + networkProofPath
	}
	if netns != nil && netns.Egress != nil && netns.Egress.ProbeAllowedAddr != "" {
		environment += " VITA_CAPSULE_HOST_ADDR=" + netns.Egress.HostAddr
		environment += " VITA_CAPSULE_EGRESS_ALLOWED_ADDR=" + netns.Egress.ProbeAllowedAddr
		environment += " VITA_CAPSULE_EGRESS_ALLOWED_CIDR=" + netns.Egress.ProbeAllowedCIDR
		environment += " VITA_CAPSULE_EGRESS_ALLOWED_PORT=" + strconv.Itoa(netns.Egress.ProbeAllowedPort)
		environment += " VITA_CAPSULE_EGRESS_DENIED_ADDR=" + netns.Egress.ProbeDeniedAddr
		environment += " VITA_CAPSULE_EGRESS_DENIED_CIDR=" + netns.Egress.ProbeDeniedCIDR
	}
	if netns != nil && netns.Egress != nil && netns.Egress.Ingress != nil {
		environment += " VITA_CAPSULE_INGRESS_GRANTED_PORT=" + strconv.Itoa(netns.Egress.Ingress.ProbePort)
		environment += " VITA_CAPSULE_INGRESS_DENIED_PORT=" + strconv.Itoa(netns.Egress.Ingress.ProbeDeniedPort)
	}
	properties = append(properties,
		systemdProperty{Name: "Environment", Value: environment},
		systemdProperty{Name: "RuntimeDirectory", Value: runtimeDir},
		systemdProperty{Name: "RuntimeDirectoryMode", Value: "0700"},
		systemdProperty{Name: "MemoryMax", Value: strconv.FormatInt(limits.RamMiB*1024*1024, 10)},
		systemdProperty{Name: "CPUQuota", Value: cpuQuota(limits.CPUCores)},
		systemdProperty{Name: "TasksMax", Value: strconv.FormatInt(limits.TasksMax, 10)},
	)
	properties = appendCapsuleNetnsProperties(properties, netns)
	if len(volumes) > 0 {
		properties = append(properties,
			systemdProperty{Name: "StateDirectory", Value: stateDirectories(volumes)},
			systemdProperty{Name: "StateDirectoryMode", Value: capsulestorage.StateDirectoryMode()},
		)
	}

	return transientUnit{
		Name:       unitName,
		Argv:       argv,
		Properties: properties,
		Volumes:    volumes,
		NetNS:      netns,
	}, nil
}

func hardenedTransientUnitProperties(manifest ExecutionManifest, includeDenoPkey bool) []systemdProperty {
	properties := []systemdProperty{
		{Name: "Description", Value: "Vita capsule " + manifest.ID},
		{Name: "Type", Value: "simple"},
		{Name: "DynamicUser", Value: "yes"},
		{Name: "NoNewPrivileges", Value: "yes"},
		{Name: "CapabilityBoundingSet", Value: ""},
		{Name: "AmbientCapabilities", Value: ""},
		{Name: "ProtectSystem", Value: "strict"},
		{Name: "ProtectHome", Value: "yes"},
		{Name: "PrivateTmp", Value: "yes"},
		{Name: "PrivateDevices", Value: "yes"},
		{Name: "ProtectControlGroups", Value: "yes"},
		{Name: "ProtectKernelTunables", Value: "yes"},
		{Name: "ProtectKernelModules", Value: "yes"},
		{Name: "ProtectKernelLogs", Value: "yes"},
		{Name: "ProtectClock", Value: "yes"},
		{Name: "ProtectHostname", Value: "yes"},
		{Name: "ProtectProc", Value: "invisible"},
		{Name: "RestrictSUIDSGID", Value: "yes"},
		{Name: "RestrictNamespaces", Value: "yes"},
		{Name: "RestrictRealtime", Value: "yes"},
		{Name: "RestrictAddressFamilies", Value: restrictAddressFamilies(manifest.Network)},
		{Name: "LockPersonality", Value: "yes"},
		{Name: "MemoryDenyWriteExecute", Value: "no"},
		{Name: "SystemCallArchitectures", Value: "native"},
		{Name: "SystemCallFilter", Value: "@system-service"},
		{Name: "SystemCallFilter", Value: "~@privileged @resources @mount @swap @reboot @raw-io @cpu-emulation @obsolete"},
	}
	if includeDenoPkey {
		properties = append(properties, systemdProperty{Name: "SystemCallFilter", Value: "pkey_alloc pkey_free pkey_mprotect"})
	}
	return append(properties, systemdProperty{Name: "UMask", Value: "0077"})
}

func restrictAddressFamilies(networkPolicy *ExecutionNetwork) string {
	if networkPolicy == nil {
		return "AF_UNIX"
	}
	return "AF_UNIX AF_INET AF_INET6 AF_NETLINK"
}

func appendCapsuleNetnsProperties(properties []systemdProperty, netns *capsuleNetns) []systemdProperty {
	if netns == nil {
		return properties
	}
	if netns.Private {
		return append(properties, systemdProperty{Name: "PrivateNetwork", Value: "yes"})
	}
	return append(properties, systemdProperty{Name: "NetworkNamespacePath", Value: netns.Path})
}

func replaceCapsuleNetnsProperties(properties []systemdProperty, netns *capsuleNetns) []systemdProperty {
	out := make([]systemdProperty, 0, len(properties)+1)
	for _, property := range properties {
		if property.Name == "PrivateNetwork" || property.Name == "NetworkNamespacePath" {
			continue
		}
		out = append(out, property)
	}
	return appendCapsuleNetnsProperties(out, netns)
}

func denoArgv(entrypoint string, volumes []capsulestorage.VolumeMount, networkProofPath string) []string {
	argv := []string{
		defaultDenoPath,
		"run",
		"--no-remote",
		"--cached-only",
		"--no-config",
		"--quiet",
	}
	if networkProofPath != "" {
		argv = append(argv,
			"--allow-net",
			"--allow-env=VITA_CAPSULE_NETNS_PROOF,VITA_CAPSULE_EGRESS_ALLOWED_ADDR,VITA_CAPSULE_EGRESS_ALLOWED_CIDR,VITA_CAPSULE_EGRESS_ALLOWED_PORT,VITA_CAPSULE_EGRESS_DENIED_ADDR,VITA_CAPSULE_EGRESS_DENIED_CIDR,VITA_CAPSULE_HOST_ADDR,VITA_CAPSULE_INGRESS_GRANTED_PORT,VITA_CAPSULE_INGRESS_DENIED_PORT",
		)
	}
	readPaths, writePaths := volumePermissionPaths(volumes)
	if networkProofPath != "" {
		writePaths = append(writePaths, networkProofPath)
	}
	if len(readPaths) > 0 {
		argv = append(argv, "--allow-read="+strings.Join(readPaths, ","))
	}
	if len(writePaths) > 0 {
		argv = append(argv, "--allow-write="+strings.Join(writePaths, ","))
	}
	argv = append(argv, entrypoint)
	return argv
}

func volumePermissionPaths(volumes []capsulestorage.VolumeMount) ([]string, []string) {
	readPaths := make([]string, 0, len(volumes))
	writePaths := make([]string, 0, len(volumes))
	for _, volume := range volumes {
		readPaths = append(readPaths, volume.Path)
		if volume.Access == capsulestorage.VolumeAccessReadWrite {
			writePaths = append(writePaths, volume.Path)
		}
	}
	return readPaths, writePaths
}

func stateDirectories(volumes []capsulestorage.VolumeMount) string {
	dirs := make([]string, 0, len(volumes))
	for _, volume := range volumes {
		dirs = append(dirs, volume.StateDirectory)
	}
	return strings.Join(dirs, " ")
}

func healthChecksForUnit(checks []capsuleruntime.Check, unit string) ([]capsuleruntime.Check, error) {
	return capsuleruntime.ChecksForUnit(checks, unit)
}

func manifestEntrypointPath(manifest ExecutionManifest) (string, error) {
	if err := manifest.Runtime.TypeScript.Validate(); err != nil {
		return "", err
	}
	baseDir := manifest.baseDir
	if baseDir == "" {
		baseDir = path.Join(defaultCapsuleRoot, manifest.ID)
	}
	return path.Join(baseDir, manifest.Runtime.TypeScript.Entrypoint), nil
}

func capsuleUnitName(id string) string {
	sum := sha256.Sum256([]byte(id))
	return "vita-capsule-" + unitNameSlug(id) + "-" + hex.EncodeToString(sum[:4]) + ".service"
}

func capsuleRuntimeDirectory(id string) string {
	sum := sha256.Sum256([]byte(id))
	return "vita-capsule-" + unitNameSlug(id) + "-" + hex.EncodeToString(sum[:4])
}

func unitNameSlug(id string) string {
	slug := unsafeRuntimeDirRune.ReplaceAllString(id, "-")
	slug = strings.Trim(slug, ".-")
	if slug == "" {
		slug = "capsule"
	}
	if len(slug) > 96 {
		slug = slug[:96]
	}
	return slug
}

func cpuQuota(cores float64) string {
	return strconv.FormatFloat(cores*100, 'f', -1, 64) + "%"
}

func stopAndUnlinkTransientUnit(ctx context.Context, launcher transientUnitLauncher, unit string) error {
	return errors.Join(
		launcher.StopTransientUnit(ctx, unit),
		launcher.ResetFailedUnit(ctx, unit),
	)
}

func requiredObjectField(fields map[string]json.RawMessage, key string, target interface{}) error {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return &ExecuteInvalidRequestError{Reason: key + " is required"}
	}
	if err := decodeSingleJSONValue(raw, target); err != nil {
		return err
	}
	return nil
}

func optionalHealthChecksField(fields map[string]json.RawMessage, key string) ([]capsuleruntime.Check, error) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}

	var checks []capsuleruntime.Check
	if err := decodeSingleJSONValue(raw, &checks); err != nil {
		return nil, &ExecuteInvalidRequestError{Reason: fmt.Sprintf("%s must be a list of health checks: %v", key, err)}
	}
	for i, check := range checks {
		if err := check.Validate(); err != nil {
			return nil, &ExecuteInvalidRequestError{Reason: fmt.Sprintf("%s[%d]: %v", key, i, err)}
		}
	}
	return checks, nil
}

func optionalExecutionDataField(fields map[string]json.RawMessage, key string) (ExecutionData, error) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return ExecutionData{}, nil
	}

	var data ExecutionData
	if err := decodeSingleJSONValue(raw, &data); err != nil {
		return ExecutionData{}, err
	}
	return data, nil
}

func optionalExecutionNetworkField(fields map[string]json.RawMessage, key string) (*ExecutionNetwork, error) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}

	var networkPolicy ExecutionNetwork
	if err := decodeSingleJSONValue(raw, &networkPolicy); err != nil {
		return nil, err
	}
	return &networkPolicy, nil
}

func requiredNetworkIngressField(fields map[string]json.RawMessage, key string) ([]ExecutionNetworkIngressRule, error) {
	rawItems, err := requiredRawListField(fields, key)
	if err != nil {
		return nil, err
	}

	items := make([]ExecutionNetworkIngressRule, len(rawItems))
	for i, rawItem := range rawItems {
		if bytes.Equal(bytes.TrimSpace(rawItem), []byte("null")) {
			return nil, &ExecuteInvalidRequestError{Reason: fmt.Sprintf("network.%s[%d] must be an object", key, i)}
		}
		var rule ExecutionNetworkIngressRule
		if err := decodeSingleJSONValue(rawItem, &rule); err != nil {
			return nil, err
		}
		if err := rule.Validate(i); err != nil {
			return nil, err
		}
		items[i] = rule
	}
	return items, nil
}

func requiredNetworkEgressField(fields map[string]json.RawMessage, key string) ([]ExecutionNetworkEgressRule, error) {
	rawItems, err := requiredRawListField(fields, key)
	if err != nil {
		return nil, err
	}

	items := make([]ExecutionNetworkEgressRule, len(rawItems))
	for i, rawItem := range rawItems {
		if bytes.Equal(bytes.TrimSpace(rawItem), []byte("null")) {
			return nil, &ExecuteInvalidRequestError{Reason: fmt.Sprintf("network.%s[%d] must be an object", key, i)}
		}
		var rule ExecutionNetworkEgressRule
		if err := decodeSingleJSONValue(rawItem, &rule); err != nil {
			return nil, err
		}
		if err := rule.Validate(i); err != nil {
			return nil, err
		}
		items[i] = rule
	}
	return items, nil
}

func requiredRawListField(fields map[string]json.RawMessage, key string) ([]json.RawMessage, error) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, &ExecuteInvalidRequestError{Reason: "network." + key + " is required"}
	}

	var rawItems []json.RawMessage
	if err := decodeSingleJSONValue(raw, &rawItems); err != nil {
		return nil, &ExecuteInvalidRequestError{Reason: "network." + key + " must be a list"}
	}
	if rawItems == nil {
		return nil, &ExecuteInvalidRequestError{Reason: "network." + key + " must be a list"}
	}
	return rawItems, nil
}

func optionalNetworkNameField(fields map[string]json.RawMessage, key string) (string, error) {
	raw, ok := fields[key]
	if !ok {
		return "", nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", &ExecuteInvalidRequestError{Reason: "network grant name must be a string"}
	}

	var value string
	if err := decodeSingleJSONValue(raw, &value); err != nil {
		return "", &ExecuteInvalidRequestError{Reason: "network grant name must be a string"}
	}
	if !validExecutionNetworkName(value) {
		return "", &ExecuteInvalidRequestError{Reason: "network grant name must be a safe network grant name"}
	}
	return value, nil
}

func optionalNetworkDirectionField(fields map[string]json.RawMessage, key string, want string) (string, error) {
	raw, ok := fields[key]
	if !ok {
		return "", nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", &ExecuteInvalidRequestError{Reason: "network grant direction must be ingress or egress"}
	}

	var value string
	if err := decodeSingleJSONValue(raw, &value); err != nil {
		return "", &ExecuteInvalidRequestError{Reason: "network grant direction must be a string"}
	}
	if !safeExecutionNetworkString(value) || (value != "ingress" && value != "egress") {
		return "", &ExecuteInvalidRequestError{Reason: "network grant direction must be ingress or egress"}
	}
	if value != want {
		return "", &ExecuteInvalidRequestError{Reason: "network grant direction must match its list"}
	}
	return value, nil
}

func requiredNetworkProtocolField(fields map[string]json.RawMessage, key string) (network.Protocol, error) {
	value, err := requiredStringField(fields, key)
	if err != nil {
		return "", &ExecuteInvalidRequestError{Reason: "network grant " + err.Error()}
	}
	if !safeExecutionNetworkString(value) || !validNetworkProtocol(network.Protocol(value)) {
		return "", &ExecuteInvalidRequestError{Reason: "network grant protocol must be tcp or udp"}
	}
	return network.Protocol(value), nil
}

func requiredNetworkPortField(fields map[string]json.RawMessage, key string) (int, error) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return 0, &ExecuteInvalidRequestError{Reason: "network grant " + key + " is required"}
	}

	var value int
	if err := decodeSingleJSONValue(raw, &value); err != nil {
		return 0, &ExecuteInvalidRequestError{Reason: "network grant " + key + " must be an integer"}
	}
	if !validNetworkPort(value) {
		return 0, &ExecuteInvalidRequestError{Reason: "network grant " + key + " must be 1-65535 or PortAll"}
	}
	return value, nil
}

func requiredNetworkPortsField(fields map[string]json.RawMessage, key string) ([]int, error) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, &ExecuteInvalidRequestError{Reason: "network grant " + key + " is required"}
	}

	var ports []int
	if err := decodeSingleJSONValue(raw, &ports); err != nil {
		return nil, &ExecuteInvalidRequestError{Reason: "network grant " + key + " must be an integer list"}
	}
	if len(ports) == 0 {
		return nil, &ExecuteInvalidRequestError{Reason: "network grant " + key + " must not be empty"}
	}
	for i, portValue := range ports {
		if !validNetworkPort(portValue) {
			return nil, &ExecuteInvalidRequestError{Reason: fmt.Sprintf("network grant %s[%d] must be 1-65535 or PortAll", key, i)}
		}
	}
	return ports, nil
}

func requiredNetworkCIDRField(fields map[string]json.RawMessage, key string) (string, netip.Prefix, error) {
	value, err := requiredStringField(fields, key)
	if err != nil {
		return "", netip.Prefix{}, &ExecuteInvalidRequestError{Reason: "network grant " + err.Error()}
	}
	if !safeExecutionNetworkString(value) {
		return "", netip.Prefix{}, &ExecuteInvalidRequestError{Reason: "network grant " + key + " contains unsafe characters"}
	}
	prefix, err := network.NormalizeCIDR(value)
	if err != nil {
		return "", netip.Prefix{}, &ExecuteInvalidRequestError{Reason: "network grant " + key + " " + err.Error()}
	}
	return prefix.String(), prefix, nil
}

func requiredNetworkDestinationsField(fields map[string]json.RawMessage, key string) ([]string, []netip.Prefix, error) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil, &ExecuteInvalidRequestError{Reason: "network grant " + key + " is required"}
	}

	var destinations []string
	if err := decodeSingleJSONValue(raw, &destinations); err != nil {
		return nil, nil, &ExecuteInvalidRequestError{Reason: "network grant " + key + " must be a string list"}
	}
	if len(destinations) == 0 {
		return nil, nil, &ExecuteInvalidRequestError{Reason: "network grant " + key + " must not be empty"}
	}

	normalized := make([]string, len(destinations))
	prefixes := make([]netip.Prefix, len(destinations))
	for i, destination := range destinations {
		prefix, err := normalizeNetworkDestination(destination)
		if err != nil {
			return nil, nil, &ExecuteInvalidRequestError{Reason: fmt.Sprintf("network grant %s[%d] %s", key, i, err)}
		}
		normalized[i] = prefix.String()
		prefixes[i] = prefix
	}
	return normalized, prefixes, nil
}

func requiredNetworkInterfaceField(fields map[string]json.RawMessage, key string) (string, error) {
	value, err := requiredStringField(fields, key)
	if err != nil {
		return "", &ExecuteInvalidRequestError{Reason: "network grant " + err.Error()}
	}
	if !safeExecutionNetworkString(value) || !network.ValidInterfaceName(value) {
		return "", &ExecuteInvalidRequestError{Reason: "network grant interface must be a concrete interface name"}
	}
	return value, nil
}

func requiredBoolField(fields map[string]json.RawMessage, key string) (bool, error) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return false, fmt.Errorf("%s is required", key)
	}

	var value bool
	if err := decodeSingleJSONValue(raw, &value); err != nil {
		return false, fmt.Errorf("%s must be a boolean", key)
	}
	return value, nil
}

func optionalBoolField(fields map[string]json.RawMessage, key string) (bool, error) {
	raw, ok := fields[key]
	if !ok {
		return false, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return false, &ExecuteInvalidRequestError{Reason: "network grant " + key + " must be a boolean"}
	}

	var value bool
	if err := decodeSingleJSONValue(raw, &value); err != nil {
		return false, &ExecuteInvalidRequestError{Reason: "network grant " + key + " must be a boolean"}
	}
	return value, nil
}

func requiredDataClassesField(fields map[string]json.RawMessage, key string) ([]capsulestorage.DataClass, error) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, &ExecuteInvalidRequestError{Reason: "data." + key + " is required"}
	}

	var classes []capsulestorage.DataClass
	if err := decodeSingleJSONValue(raw, &classes); err != nil {
		return nil, &ExecuteInvalidRequestError{Reason: "data." + key + " must be a list"}
	}
	if classes == nil {
		return nil, &ExecuteInvalidRequestError{Reason: "data." + key + " must be a list"}
	}
	for i, class := range classes {
		if !validExecutionDataClass(class) {
			return nil, &ExecuteInvalidRequestError{Reason: fmt.Sprintf("data.%s[%d] must be a supported data class", key, i)}
		}
	}
	return classes, nil
}

func requiredVolumesField(fields map[string]json.RawMessage, key string) ([]capsulestorage.VolumeSpec, error) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, &ExecuteInvalidRequestError{Reason: "data." + key + " is required"}
	}

	var volumes []capsulestorage.VolumeSpec
	if err := decodeSingleJSONValue(raw, &volumes); err != nil {
		return nil, &ExecuteInvalidRequestError{Reason: fmt.Sprintf("data.%s must be a list of volume specs: %v", key, err)}
	}
	if volumes == nil {
		return nil, &ExecuteInvalidRequestError{Reason: "data." + key + " must be a list"}
	}
	for i, volume := range volumes {
		if err := volume.Validate(); err != nil {
			return nil, &ExecuteInvalidRequestError{Reason: fmt.Sprintf("data.%s[%d]: %v", key, i, err)}
		}
	}
	return volumes, nil
}

func requiredPositiveFloatField(fields map[string]json.RawMessage, key string) (float64, error) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return 0, &ExecuteInvalidRequestError{Reason: key + " is required"}
	}

	var value float64
	if err := decodeSingleJSONValue(raw, &value); err != nil {
		return 0, fmt.Errorf("%s must be a number", key)
	}
	if !positiveFinite(value) {
		return 0, &ExecuteInvalidRequestError{Reason: key + " must be positive"}
	}
	return value, nil
}

func requiredPositiveInt64Field(fields map[string]json.RawMessage, key string) (int64, error) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return 0, &ExecuteInvalidRequestError{Reason: key + " is required"}
	}

	var value int64
	if err := decodeSingleJSONValue(raw, &value); err != nil {
		return 0, fmt.Errorf("%s must be an integer", key)
	}
	if value <= 0 {
		return 0, &ExecuteInvalidRequestError{Reason: key + " must be positive"}
	}
	return value, nil
}

func normalizeNetworkDestination(value string) (netip.Prefix, error) {
	if !safeExecutionNetworkString(value) {
		return netip.Prefix{}, errors.New("contains unsafe characters")
	}
	if strings.Contains(value, "/") {
		prefix, err := network.NormalizeCIDR(value)
		if err != nil {
			return netip.Prefix{}, err
		}
		return prefix, nil
	}

	addr, err := netip.ParseAddr(value)
	if err != nil {
		return netip.Prefix{}, errors.New("must be a CIDR prefix or IP address")
	}
	bits := 32
	if addr.Is6() {
		bits = 128
	}
	return netip.PrefixFrom(addr, bits), nil
}

func coversAnyAll(prefixes []netip.Prefix) bool {
	for _, prefix := range prefixes {
		if network.SourceCoversAll(prefix) {
			return true
		}
	}
	return false
}

func validNetworkProtocol(value network.Protocol) bool {
	switch value {
	case network.ProtoTCP, network.ProtoUDP:
		return true
	default:
		return false
	}
}

func validNetworkPort(value int) bool {
	return value == network.PortAll || (value > 0 && value <= 65535)
}

func validExecutionNetworkName(value string) bool {
	return safeExecutionNetworkString(value) && networkNamePattern.MatchString(value)
}

func safeExecutionNetworkString(value string) bool {
	return value != "" &&
		value == strings.TrimSpace(value) &&
		!controlCharacter.MatchString(value) &&
		!networkMetaCharacter.MatchString(value) &&
		!containsInlineCapsuleMaterial(value) &&
		!hasInlineReferenceScheme(value)
}

func executeNetworkStatus(networkPolicy *ExecutionNetwork, netns *capsuleNetns, check *capsuleNetnsCheck) *ExecuteNetworkStatus {
	if networkPolicy == nil {
		return nil
	}
	status := &ExecuteNetworkStatus{
		Ingress: len(networkPolicy.Ingress),
		Egress:  len(networkPolicy.Egress),
	}
	if netns != nil {
		status.NetNS = netns.Name
		status.ProofPath = netns.ProofPath
	}
	if check != nil && check.Status == capsuleNetnsMeasuredStatusOK && check.Isolation == capsuleNetnsIsolationEnforced {
		status.Isolation = capsuleNetnsIsolationEnforced
		if check.Egress != nil && check.Egress.Status == capsuleEgressStatusOK && len(networkPolicy.Egress) > 0 {
			status.EgressAllowed = check.Egress.AllowedCIDR
			status.EgressDenied = check.Egress.DeniedCIDR
			status.EgressDrop = check.Egress.Drop
		}
		if check.Ingress != nil && check.Ingress.Status == capsuleIngressStatusOK {
			status.IngressHostAddr = check.Ingress.HostAddr
			status.IngressPort = check.Ingress.Port
			status.IngressDeniedPort = check.Ingress.DeniedPort
			status.IngressDrop = check.Ingress.Drop
		}
	}
	return status
}

func cloneExecuteNetworkStatus(status *ExecuteNetworkStatus) *ExecuteNetworkStatus {
	if status == nil {
		return nil
	}
	out := *status
	return &out
}

func positiveFinite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value > 0
}

func validExecutionDataClass(value capsulestorage.DataClass) bool {
	switch value {
	case capsulestorage.DataClassUserContent,
		capsulestorage.DataClassAppState,
		capsulestorage.DataClassCache,
		capsulestorage.DataClassLogs,
		capsulestorage.DataClassTelemetry,
		capsulestorage.DataClassConfiguration:
		return true
	default:
		return false
	}
}

func parseProcStatusUID(raw []byte) (string, bool) {
	for _, line := range bytes.Split(raw, []byte{'\n'}) {
		if !bytes.HasPrefix(line, []byte("Uid:")) {
			continue
		}
		fields := strings.Fields(string(line))
		if len(fields) < 2 {
			return "", false
		}
		if _, err := strconv.ParseUint(fields[1], 10, 32); err != nil {
			return "", false
		}
		return fields[1], true
	}
	return "", false
}
