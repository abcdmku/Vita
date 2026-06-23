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
	"os"
	"os/exec"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/vita/agent/capabilities"
	capsuleruntime "github.com/vita/agent/internal/capsule-runtime"
	"github.com/vita/agent/internal/jsonsafe"
	capsulestorage "github.com/vita/agent/storage/capsules"
	"github.com/vita/agent/transaction"
)

const (
	ExecuteName = "capsule.execute"

	defaultCapsuleRoot    = "/usr/lib/vita/capsules"
	defaultDenoPath       = "/usr/lib/vita/deno"
	defaultNspawnPath     = "/usr/bin/systemd-nspawn"
	defaultJournalctlPath = "/usr/bin/journalctl"
	systemdRunPath        = "/usr/bin/systemd-run"
	systemctlPath         = "/usr/bin/systemctl"

	executePackageClassTSService      = "ts-service"
	executePackageClassOCIService     = "oci-service"
	executePackageClassMicroVMService = "microvm-service"

	maxCPUQuotaCores = 64
	maxMemoryMiB     = 1024 * 1024
	maxStorageMiB    = 1024 * 1024
	maxTasks         = 16384

	microVMWorkloadMarker        = "VITA-CAPSULE-MICROVM-WORKLOAD:"
	microVMReadinessTimeout      = 10 * time.Second
	microVMReadinessPollInterval = 200 * time.Millisecond
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
	ID         string                `json:"id"`
	Unit       string                `json:"unit"`
	DynamicUID string                `json:"dynamicUid"`
	Health     string                `json:"health"`
	Status     string                `json:"status"`
	Isolation  string                `json:"isolation,omitempty"`
	PID1       string                `json:"pid1,omitempty"`
	Volumes    []ExecuteVolumeStatus `json:"volumes,omitempty"`
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
	if manifest.PackageClass == executePackageClassOCIService || manifest.PackageClass == executePackageClassMicroVMService {
		var startErr *transientUnitStartError
		if errors.As(err, &startErr) && startErr.Code != "" {
			return startErr.Code
		}
		if manifest.PackageClass == executePackageClassMicroVMService {
			return "microvm_start_failed"
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
			journalctl: defaultJournalctlPath,
		},
		supervisor,
	)
}

func newExecuteCapability(registryFS registryFileSystem, manifests executionManifestStore, launcher transientUnitLauncher) *ExecuteCapability {
	return newExecuteCapabilityWithSupervisor(registryFS, manifests, launcher, nil)
}

func newExecuteCapabilityWithSupervisor(registryFS registryFileSystem, manifests executionManifestStore, launcher transientUnitLauncher, supervisor *capsuleruntime.Supervisor) *ExecuteCapability {
	return &ExecuteCapability{
		registryFS: registryFS,
		manifests:  manifests,
		launcher:   launcher,
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
	if c.supervisor != nil {
		for _, workload := range c.supervisor.Snapshot() {
			if workload.Unit == last.Unit {
				last.Health = string(workload.Health)
				last.Status = string(workload.Status)
				break
			}
		}
	}
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

	status, err := c.launcher.StartTransientUnit(ctx, unit)
	if err != nil {
		code := executeStartFailureCode(manifest, unit, err)
		if manifest.PackageClass != executePackageClassOCIService && len(unit.Volumes) > 0 {
			code = "capsule_volume_start_failed"
			log.Printf("VITA-CAPSULE-VOLUME-ERROR: reason=%s status=FAILSAFE", code)
		}
		return nil, &ExecuteStartError{Code: code, Err: err}
	}
	microVMStatus, err := verifiedMicroVMStatus(manifest, status)
	if err != nil {
		cleanupErr := stopAndUnlinkTransientUnit(ctx, c.launcher, unit.Name)
		return nil, &ExecuteStartError{Code: microVMReadinessFailureCode(err, "workload_line_absent"), Err: errors.Join(err, cleanupErr)}
	}

	executeStatus := ExecuteStatus{
		ID:         manifest.ID,
		Unit:       unit.Name,
		DynamicUID: status.DynamicUID,
		Health:     "OK",
		Status:     "OK",
		Volumes:    volumeStatuses(unit.Volumes),
	}
	if microVMStatus != nil {
		executeStatus.Isolation = microVMStatus.Isolation
		executeStatus.PID1 = microVMStatus.PID1
	}
	c.setLast(executeStatus)
	c.startWorkload(manifest.ID, unit.Name, healthChecks)
	for _, volume := range unit.Volumes {
		log.Printf("VITA-CAPSULE-VOLUME: id=%s vol=%s path=%s mounted=OK status=OK", manifest.ID, volume.Name, volume.Path)
	}

	return executeUndo{
		capability: c,
		launcher:   c.launcher,
		unit:       unit.Name,
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
		Isolation:  status.Isolation,
		PID1:       status.PID1,
		Volumes:    cloneExecuteVolumeStatuses(status.Volumes),
	}
}

func (c *ExecuteCapability) clearLast(unit string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.last != nil && c.last.Unit == unit {
		c.last = nil
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

func verifiedMicroVMStatus(manifest ExecutionManifest, status transientUnitStatus) (*microVMReadinessStatus, error) {
	if manifest.PackageClass != executePackageClassMicroVMService {
		return nil, nil
	}
	if status.MicroVM == nil {
		return nil, &microVMReadinessError{Code: "workload_line_absent", Err: errors.New("microvm workload readiness marker was not observed")}
	}
	if status.MicroVM.Isolation != "nspawn" ||
		status.MicroVM.PID1 != "own" ||
		status.MicroVM.Health != "OK" ||
		status.MicroVM.Status != "OK" {
		return nil, &microVMReadinessError{Code: "workload_pid1_not_own", Err: fmt.Errorf("microvm workload readiness marker was invalid: isolation=%s pid1=%s health=%s status=%s",
			status.MicroVM.Isolation,
			status.MicroVM.PID1,
			status.MicroVM.Health,
			status.MicroVM.Status,
		)}
	}
	return status.MicroVM, nil
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
	unit       string
}

func (u executeUndo) Undo(ctx context.Context) error {
	if u.launcher == nil {
		return &ExecuteInvalidRequestError{Reason: "missing capsule execute launcher"}
	}
	if err := stopAndUnlinkTransientUnit(ctx, u.launcher, u.unit); err != nil {
		return err
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

	manifest := ExecutionManifest{
		ID:             id,
		Version:        version,
		Integrity:      integrity,
		PackageClass:   packageClass,
		Runtime:        runtime,
		ResourceLimits: limits,
		Data:           data,
		HealthChecks:   healthChecks,
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
	case executePackageClassTSService, executePackageClassOCIService, executePackageClassMicroVMService:
	default:
		return &ExecuteInvalidRequestError{Reason: supportedPackageClassMessage()}
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
	if hasTS == hasOCI {
		return &ExecuteInvalidRequestError{Reason: "runtime must declare exactly one of typescript or oci"}
	}

	var runtime ExecutionRuntime
	if hasTS {
		if bytes.Equal(bytes.TrimSpace(rawTS), []byte("null")) {
			return &ExecuteInvalidRequestError{Reason: "runtime.typescript is required"}
		}
		var ts TypeScriptExecution
		if err := decodeSingleJSONValue(rawTS, &ts); err != nil {
			return err
		}
		runtime.TypeScript = ts
	} else {
		if bytes.Equal(bytes.TrimSpace(rawOCI), []byte("null")) {
			return &ExecuteInvalidRequestError{Reason: "runtime.oci is required"}
		}
		var oci OCIExecution
		if err := decodeSingleJSONValue(rawOCI, &oci); err != nil {
			return err
		}
		runtime.OCI = oci
	}

	*r = runtime
	return nil
}

func (r ExecutionRuntime) Validate() error {
	tsErr := r.TypeScript.Validate()
	ociErr := r.OCI.Validate()
	switch {
	case tsErr == nil && ociErr == nil:
		return &ExecuteInvalidRequestError{Reason: "runtime must declare exactly one supported runtime"}
	case tsErr == nil || ociErr == nil:
		return nil
	default:
		return &ExecuteInvalidRequestError{Reason: "runtime must declare exactly one supported runtime"}
	}
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
	case executePackageClassOCIService:
		if err := r.OCI.Validate(); err != nil {
			return err
		}
		if err := r.TypeScript.Validate(); err == nil {
			return &ExecuteInvalidRequestError{Reason: "runtime.typescript must not be declared for oci-service"}
		}
	case executePackageClassMicroVMService:
		if err := r.OCI.Validate(); err != nil {
			return err
		}
		if err := r.TypeScript.Validate(); err == nil {
			return &ExecuteInvalidRequestError{Reason: "runtime.typescript must not be declared for microvm-service"}
		}
	default:
		return &ExecuteInvalidRequestError{Reason: supportedPackageClassMessage()}
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
	Name             string
	Argv             []string
	Properties       []systemdProperty
	Volumes          []capsulestorage.VolumeMount
	MicroVMReadiness *microVMReadinessProbe
}

type transientUnitStatus struct {
	DynamicUID string
	MicroVM    *microVMReadinessStatus
}

type microVMReadinessProbe struct {
	ID string
}

type microVMReadinessStatus struct {
	Isolation string
	PID1      string
	Health    string
	Status    string
}

type microVMReadinessResult struct {
	Code             string
	WorkloadLineSeen bool
}

type microVMReadinessError struct {
	Code string
	Err  error
}

func (e *microVMReadinessError) Error() string {
	if e == nil {
		return "microvm readiness failed"
	}
	if e.Code == "" {
		if e.Err == nil {
			return "microvm readiness failed"
		}
		return e.Err.Error()
	}
	if e.Err == nil {
		return e.Code
	}
	return e.Code + ": " + e.Err.Error()
}

func (e *microVMReadinessError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
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
	StopTransientUnit(context.Context, string) error
	ResetFailedUnit(context.Context, string) error
}

type systemdRunLauncher struct {
	systemdRun string
	systemctl  string
	journalctl string
}

func (l systemdRunLauncher) StartTransientUnit(ctx context.Context, unit transientUnit) (transientUnitStatus, error) {
	startedAt := time.Now().Add(-1 * time.Second)
	args := []string{"--unit", unit.Name, "--collect"}
	for _, property := range unit.Properties {
		args = append(args, "--property="+property.Name+"="+property.Value)
	}
	args = append(args, "--")
	args = append(args, unit.Argv...)

	if output, err := exec.CommandContext(ctx, l.systemdRun, args...).CombinedOutput(); err != nil {
		return transientUnitStatus{}, l.startError(ctx, unit, fmt.Errorf("start capsule transient unit: %w: %s", err, strings.TrimSpace(string(output))))
	}

	if output, err := exec.CommandContext(ctx, l.systemctl, "is-active", "--quiet", unit.Name).CombinedOutput(); err != nil {
		startErr := l.startError(ctx, unit, fmt.Errorf("capsule transient unit did not become active: %w: %s", err, strings.TrimSpace(string(output))))
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
	microVMStatus, err := l.waitForMicroVMReadiness(ctx, unit, startedAt)
	if err != nil {
		diagnostics, diagErr := l.unitDiagnostics(ctx, unit.Name)
		cause := err
		if diagErr != nil {
			cause = errors.Join(cause, diagErr)
		}
		cleanupErr := stopAndUnlinkTransientUnit(ctx, l, unit.Name)
		if cleanupErr != nil {
			cause = errors.Join(cause, cleanupErr)
		}
		startErr := &transientUnitStartError{
			Code:        classifyMicroVMReadinessFailure(unit, diagnostics, err),
			Unit:        unit.Name,
			Diagnostics: diagnostics,
			Err:         cause,
		}
		return transientUnitStatus{}, startErr
	}

	return transientUnitStatus{DynamicUID: uid, MicroVM: microVMStatus}, nil
}

func (l systemdRunLauncher) startError(ctx context.Context, unit transientUnit, cause error) *transientUnitStartError {
	diagnostics, err := l.unitDiagnostics(ctx, unit.Name)
	if err != nil {
		cause = errors.Join(cause, err)
	}
	return &transientUnitStartError{
		Code:        classifyTransientUnitStartFailure(diagnostics, cause.Error(), isNspawnTransientUnit(unit)),
		Unit:        unit.Name,
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

func (l systemdRunLauncher) waitForMicroVMReadiness(ctx context.Context, unit transientUnit, since time.Time) (*microVMReadinessStatus, error) {
	probe := unit.MicroVMReadiness
	if probe == nil {
		return nil, nil
	}
	if probe.ID == "" {
		return nil, &microVMReadinessError{Code: "workload_probe_invalid", Err: errors.New("microvm readiness id is required")}
	}

	deadline := time.Now().Add(microVMReadinessTimeout)
	var lastErr error
	for {
		status, err := l.readMicroVMReadiness(ctx, unit.Name, *probe, since)
		if err == nil {
			return status, nil
		}
		lastErr = err
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		if !time.Now().Before(deadline) {
			break
		}

		timer := time.NewTimer(microVMReadinessPollInterval)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			return nil, ctx.Err()
		case <-timer.C:
		}
	}

	if lastErr == nil {
		lastErr = &microVMReadinessError{Code: "workload_line_absent", Err: errors.New("microvm workload readiness marker was not observed")}
	}
	return nil, lastErr
}

func (l systemdRunLauncher) readMicroVMReadiness(ctx context.Context, unit string, probe microVMReadinessProbe, since time.Time) (*microVMReadinessStatus, error) {
	journalctl := l.journalctl
	if journalctl == "" {
		journalctl = defaultJournalctlPath
	}
	args := []string{
		"--unit", unit,
		"--no-pager",
		"--output=cat",
		"--since", since.Format("2006-01-02 15:04:05"),
		"--lines=200",
	}
	output, err := exec.CommandContext(ctx, journalctl, args...).CombinedOutput()
	if err != nil {
		return nil, &microVMReadinessError{
			Code: "journal_read_failed",
			Err:  fmt.Errorf("read microvm workload journal: %w: %s", err, strings.TrimSpace(string(output))),
		}
	}

	status, result := inspectMicroVMReadiness(output, probe)
	if status == nil {
		return nil, &microVMReadinessError{
			Code: result.Code,
			Err:  fmt.Errorf("microvm workload readiness marker was not valid for %s", probe.ID),
		}
	}
	return status, nil
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

func classifyTransientUnitStartFailure(diagnostics transientUnitDiagnostics, detail string, nspawn bool) string {
	lowerDetail := strings.ToLower(detail)
	if nspawn {
		if strings.TrimSpace(diagnostics.ExecMainStatus) == "203" ||
			(strings.Contains(lowerDetail, "systemd-nspawn") &&
				(strings.Contains(lowerDetail, "no such file") || strings.Contains(lowerDetail, "not found"))) {
			return "nspawn_absent"
		}
	}
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
		if nspawn {
			return "nspawn_exec_failed"
		}
		return "process_exited"
	case "timeout":
		return "start_timeout"
	case "resources":
		return "resource_limit_failed"
	case "signal", "core-dump":
		if nspawn {
			return "nspawn_exec_failed"
		}
		return "process_signaled"
	}
	if diagnostics.ActiveState == "failed" || diagnostics.SubState == "failed" {
		if nspawn {
			return "nspawn_exec_failed"
		}
		return "unit_failed"
	}
	return "unit_start_failed"
}

func classifyMicroVMReadinessFailure(unit transientUnit, diagnostics transientUnitDiagnostics, err error) string {
	if diagnostics.ActiveState == "failed" ||
		diagnostics.SubState == "failed" ||
		(strings.TrimSpace(diagnostics.Result) != "" && strings.TrimSpace(diagnostics.Result) != "success") {
		code := classifyTransientUnitStartFailure(diagnostics, errorString(err), isNspawnTransientUnit(unit))
		if code != "unit_start_failed" {
			return code
		}
	}
	return microVMReadinessFailureCode(err, "workload_line_absent")
}

func microVMReadinessFailureCode(err error, fallback string) string {
	var readinessErr *microVMReadinessError
	if errors.As(err, &readinessErr) && readinessErr.Code != "" {
		return readinessErr.Code
	}
	var invalid *ExecuteInvalidRequestError
	if errors.As(err, &invalid) && invalid.ApplyErrorCode() != "capsule_execute_rejected" {
		return invalid.ApplyErrorCode()
	}
	return fallback
}

func isNspawnTransientUnit(unit transientUnit) bool {
	if len(unit.Argv) == 0 {
		return false
	}
	return path.Base(unit.Argv[0]) == "systemd-nspawn"
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
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
		"packageClass":   {},
		"resourceLimits": {},
		"runtime":        {},
		"version":        {},
	}
	executionRuntimeFields = map[string]struct{}{
		"oci":        {},
		"typescript": {},
	}
	executionDataFields = map[string]struct{}{
		"classes": {},
		"volumes": {},
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
	case executePackageClassMicroVMService:
		return statOCIManifestArtifacts(manifest)
	default:
		return &ExecuteInvalidRequestError{Reason: supportedPackageClassMessage()}
	}
	return nil
}

func composeTransientUnit(manifest ExecutionManifest) (transientUnit, error) {
	switch manifest.PackageClass {
	case executePackageClassTSService:
		return composeTypeScriptTransientUnit(manifest)
	case executePackageClassOCIService:
		return composeOCITransientUnit(manifest)
	case executePackageClassMicroVMService:
		return composeMicroVMTransientUnit(manifest)
	default:
		return transientUnit{}, &ExecuteInvalidRequestError{Reason: supportedPackageClassMessage()}
	}
}

func supportedPackageClassMessage() string {
	return "manifest.packageClass must be ts-service, oci-service, or microvm-service"
}

func composeTypeScriptTransientUnit(manifest ExecutionManifest) (transientUnit, error) {
	entrypoint, err := manifestEntrypointPath(manifest)
	if err != nil {
		return transientUnit{}, err
	}

	unitName := capsuleUnitName(manifest.ID)
	runtimeDir := capsuleRuntimeDirectory(manifest.ID)
	limits := manifest.ResourceLimits
	volumes, err := capsulestorage.SetupVolumes(manifest.ID, manifest.Data.Volumes)
	if err != nil {
		return transientUnit{}, &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	argv := denoArgv(entrypoint, volumes)
	properties := hardenedTransientUnitProperties(manifest, true)
	properties = append(properties,
		systemdProperty{Name: "Environment", Value: "DENO_DIR=/run/" + runtimeDir + " DENO_NO_UPDATE_CHECK=1 NO_COLOR=1"},
		systemdProperty{Name: "RuntimeDirectory", Value: runtimeDir},
		systemdProperty{Name: "RuntimeDirectoryMode", Value: "0700"},
		systemdProperty{Name: "MemoryMax", Value: strconv.FormatInt(limits.RamMiB*1024*1024, 10)},
		systemdProperty{Name: "CPUQuota", Value: cpuQuota(limits.CPUCores)},
		systemdProperty{Name: "TasksMax", Value: strconv.FormatInt(limits.TasksMax, 10)},
	)
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
		{Name: "RestrictAddressFamilies", Value: "AF_UNIX"},
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

func denoArgv(entrypoint string, volumes []capsulestorage.VolumeMount) []string {
	argv := []string{
		defaultDenoPath,
		"run",
		"--no-remote",
		"--cached-only",
		"--no-config",
		"--quiet",
	}
	readPaths, writePaths := volumePermissionPaths(volumes)
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

func parseMicroVMReadiness(raw []byte, probe microVMReadinessProbe) (*microVMReadinessStatus, bool) {
	status, result := inspectMicroVMReadiness(raw, probe)
	return status, result.Code == ""
}

func inspectMicroVMReadiness(raw []byte, probe microVMReadinessProbe) (*microVMReadinessStatus, microVMReadinessResult) {
	workloadLineSeen := false
	matchingIDSeen := false
	failureCode := "workload_line_absent"
	for _, rawLine := range bytes.Split(raw, []byte{'\n'}) {
		line := strings.TrimSpace(string(rawLine))
		if !strings.HasPrefix(line, microVMWorkloadMarker) {
			continue
		}
		workloadLineSeen = true
		fields := markerFields(strings.TrimSpace(strings.TrimPrefix(line, microVMWorkloadMarker)))
		if fields["id"] != probe.ID {
			if !matchingIDSeen {
				failureCode = "workload_id_mismatch"
			}
			continue
		}
		matchingIDSeen = true
		if fields["status"] != "OK" {
			failureCode = "workload_status_not_ok"
			continue
		}
		pid, err := strconv.ParseUint(fields["pid"], 10, 32)
		if fields["pid1"] != "own" || err != nil || (pid != 1 && pid != 2) {
			failureCode = "workload_pid1_not_own"
			continue
		}
		return &microVMReadinessStatus{
			Isolation: "nspawn",
			PID1:      "own",
			Health:    "OK",
			Status:    "OK",
		}, microVMReadinessResult{}
	}
	return nil, microVMReadinessResult{
		Code:             failureCode,
		WorkloadLineSeen: workloadLineSeen,
	}
}

func markerFields(value string) map[string]string {
	fields := make(map[string]string)
	for _, token := range strings.Fields(value) {
		key, fieldValue, ok := strings.Cut(token, "=")
		if !ok || key == "" || fieldValue == "" {
			continue
		}
		fields[key] = fieldValue
	}
	return fields
}
