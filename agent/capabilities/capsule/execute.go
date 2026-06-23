package capsule

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/internal/jsonsafe"
	storagecapsules "github.com/vita/agent/storage/capsules"
	"github.com/vita/agent/transaction"
)

const (
	ExecuteName = "capsule.execute"

	defaultCapsuleRoot = "/usr/lib/vita/capsules"
	defaultDenoPath    = "/usr/lib/vita/deno"
	systemdRunPath     = "/usr/bin/systemd-run"
	systemctlPath      = "/usr/bin/systemctl"

	executePackageClassTSService = "ts-service"

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
	ID         string         `json:"id"`
	Unit       string         `json:"unit"`
	DynamicUID string         `json:"dynamicUid"`
	Health     string         `json:"health"`
	Status     string         `json:"status"`
	Volumes    []VolumeStatus `json:"volumes,omitempty"`
}

type VolumeStatus struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Mounted string `json:"mounted"`
	Status  string `json:"status"`
}

type ExecuteCapability struct {
	registryFS registryFileSystem
	manifests  executionManifestStore
	launcher   transientUnitLauncher
	volumes    capsuleVolumeProvisioner

	mu   sync.Mutex
	last *ExecuteStatus
}

type ExecuteInvalidRequestError struct {
	Reason string
}

func (e *ExecuteInvalidRequestError) Error() string {
	return fmt.Sprintf("invalid capsule execute request: %s", e.Reason)
}

func NewExecuteCapability() *ExecuteCapability {
	return newExecuteCapability(
		newDefaultFileSystem(),
		fileExecutionManifestStore{root: defaultCapsuleRoot},
		systemdRunLauncher{
			systemdRun: systemdRunPath,
			systemctl:  systemctlPath,
		},
	)
}

func newExecuteCapability(registryFS registryFileSystem, manifests executionManifestStore, launcher transientUnitLauncher) *ExecuteCapability {
	return &ExecuteCapability{
		registryFS: registryFS,
		manifests:  manifests,
		launcher:   launcher,
		volumes:    defaultCapsuleVolumeProvisioner{},
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
	last.Volumes = cloneVolumeStatuses(c.last.Volumes)
	return ExecuteReadResponse{Last: &last}, nil
}

func (c *ExecuteCapability) Apply(ctx context.Context, req capabilities.TypedRequest) (transaction.Undo, error) {
	applyReq, ok := req.(ExecuteApplyRequest)
	if !ok {
		return nil, &ExecuteInvalidRequestError{Reason: "expected capsule.ExecuteApplyRequest"}
	}
	if c == nil || c.registryFS == nil || c.manifests == nil || c.launcher == nil || c.volumes == nil {
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

	volumeSpecs := volumeSpecsFromManifest(manifest)
	volumeMounts, err := c.volumes.SetupVolumes(ctx, manifest.ID, volumeSpecs)
	if err != nil {
		return nil, err
	}

	unit, err := composeTransientUnit(manifest, volumeMounts)
	if err != nil {
		return nil, err
	}

	status, err := c.launcher.StartTransientUnit(ctx, unit)
	if err != nil {
		return nil, err
	}

	executeStatus := ExecuteStatus{
		ID:         manifest.ID,
		Unit:       unit.Name,
		DynamicUID: status.DynamicUID,
		Health:     "OK",
		Status:     "OK",
		Volumes:    volumeStatuses(volumeMounts),
	}
	c.setLast(executeStatus)

	return executeUndo{
		capability: c,
		launcher:   c.launcher,
		unit:       unit.Name,
		volumes:    c.volumes,
		mounts:     cloneVolumeMounts(volumeMounts),
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
		Volumes:    cloneVolumeStatuses(status.Volumes),
	}
}

func (c *ExecuteCapability) clearLast(unit string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.last != nil && c.last.Unit == unit {
		c.last = nil
	}
}

type executeUndo struct {
	capability *ExecuteCapability
	launcher   transientUnitLauncher
	unit       string
	volumes    capsuleVolumeProvisioner
	mounts     []storagecapsules.Mount
}

func (u executeUndo) Undo(ctx context.Context) error {
	if u.launcher == nil {
		return &ExecuteInvalidRequestError{Reason: "missing capsule execute launcher"}
	}
	if err := stopAndUnlinkTransientUnit(ctx, u.launcher, u.unit); err != nil {
		return err
	}
	if u.volumes != nil {
		if err := u.volumes.TeardownVolumes(ctx, cloneVolumeMounts(u.mounts)); err != nil {
			return err
		}
	}
	if u.capability != nil {
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
	Data           *ExecutionData          `json:"data,omitempty"`
	ResourceLimits ExecutionResourceLimits `json:"resourceLimits"`

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
	var data *ExecutionData
	if rawData, ok := fields["data"]; ok {
		if bytes.Equal(bytes.TrimSpace(rawData), []byte("null")) {
			return &ExecuteInvalidRequestError{Reason: "data must be an object"}
		}
		var decodedData ExecutionData
		if err := decodeSingleJSONValue(rawData, &decodedData); err != nil {
			return err
		}
		data = &decodedData
	}
	var limits ExecutionResourceLimits
	if err := requiredObjectField(fields, "resourceLimits", &limits); err != nil {
		return err
	}

	manifest := ExecutionManifest{
		ID:             id,
		Version:        version,
		Integrity:      integrity,
		PackageClass:   packageClass,
		Runtime:        runtime,
		Data:           data,
		ResourceLimits: limits,
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
	if m.PackageClass != executePackageClassTSService {
		return &ExecuteInvalidRequestError{Reason: "manifest.packageClass must be ts-service"}
	}
	if err := m.Runtime.Validate(); err != nil {
		return err
	}
	if m.Data != nil {
		if err := m.Data.Validate(); err != nil {
			return err
		}
	}
	return m.ResourceLimits.Validate()
}

type ExecutionRuntime struct {
	TypeScript TypeScriptExecution `json:"typescript"`
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

	var ts TypeScriptExecution
	if err := requiredObjectField(fields, "typescript", &ts); err != nil {
		return err
	}

	r.TypeScript = ts
	return nil
}

func (r ExecutionRuntime) Validate() error {
	return r.TypeScript.Validate()
}

type ExecutionData struct {
	Classes []string              `json:"classes"`
	Volumes []ExecutionDataVolume `json:"volumes"`
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

	classes, err := requiredStringArrayField(fields, "classes")
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	var volumes []ExecutionDataVolume
	if err := requiredArrayField(fields, "volumes", &volumes); err != nil {
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
	if d.Classes == nil {
		return &ExecuteInvalidRequestError{Reason: "data.classes is required"}
	}
	if d.Volumes == nil {
		return &ExecuteInvalidRequestError{Reason: "data.volumes is required"}
	}

	classes := make(map[string]struct{}, len(d.Classes))
	for i, class := range d.Classes {
		if !validDataClass(class) {
			return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("data.classes[%d] must be a known data class", i)}
		}
		if _, ok := classes[class]; ok {
			return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("data.classes[%d] duplicates an earlier class", i)}
		}
		classes[class] = struct{}{}
	}

	seenVolumes := make(map[string]int, len(d.Volumes))
	for i, volume := range d.Volumes {
		if err := volume.ValidateAt(i); err != nil {
			return err
		}
		if _, ok := classes[volume.Class]; !ok {
			return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("data.volumes[%d].class must be declared in data.classes", i)}
		}
		if previous, ok := seenVolumes[volume.Name]; ok {
			return &ExecuteInvalidRequestError{Reason: fmt.Sprintf("data.volumes[%d].name duplicates data.volumes[%d].name", i, previous)}
		}
		seenVolumes[volume.Name] = i
	}

	return nil
}

type ExecutionDataVolume struct {
	Name        string `json:"name"`
	MountPath   string `json:"mountPath"`
	Class       string `json:"class"`
	Access      string `json:"access"`
	Persistence string `json:"persistence"`
	Backup      *bool  `json:"backup"`
	SizeMiB     int64  `json:"sizeMiB"`
}

func (v *ExecutionDataVolume) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, executionDataVolumeFields); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	name, err := requiredStringField(fields, "name")
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	mountPath, err := requiredStringField(fields, "mountPath")
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	class, err := requiredStringField(fields, "class")
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	access, err := requiredStringField(fields, "access")
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	persistence, err := requiredStringField(fields, "persistence")
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	backup, err := requiredBoolPtrField(fields, "backup")
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	sizeMiB, err := requiredPositiveInt64Field(fields, "sizeMiB")
	if err != nil {
		return err
	}

	out := ExecutionDataVolume{
		Name:        name,
		MountPath:   mountPath,
		Class:       class,
		Access:      access,
		Persistence: persistence,
		Backup:      backup,
		SizeMiB:     sizeMiB,
	}
	if err := out.ValidateAt(0); err != nil {
		return err
	}

	*v = out
	return nil
}

func (v ExecutionDataVolume) ValidateAt(index int) error {
	field := fmt.Sprintf("data.volumes[%d]", index)
	if !validVolumeName(v.Name) {
		return &ExecuteInvalidRequestError{Reason: field + ".name must be a bounded volume name"}
	}
	if v.MountPath != storagecapsules.VolumeMountPath(v.Name) {
		return &ExecuteInvalidRequestError{Reason: field + ".mountPath must be " + storagecapsules.VolumeMountPath(v.Name)}
	}
	if !validDataClass(v.Class) {
		return &ExecuteInvalidRequestError{Reason: field + ".class must be a known data class"}
	}
	if v.Access != "read-only" && v.Access != "read-write" {
		return &ExecuteInvalidRequestError{Reason: field + ".access must be read-only or read-write"}
	}
	if v.Persistence != "persistent" {
		return &ExecuteInvalidRequestError{Reason: field + ".persistence must be persistent"}
	}
	if v.Backup == nil {
		return &ExecuteInvalidRequestError{Reason: field + ".backup is required"}
	}
	if v.SizeMiB <= 0 {
		return &ExecuteInvalidRequestError{Reason: field + ".sizeMiB must be positive"}
	}
	return nil
}

func (v ExecutionDataVolume) VolumeSpec() storagecapsules.VolumeSpec {
	backup := false
	if v.Backup != nil {
		backup = *v.Backup
	}
	return storagecapsules.VolumeSpec{
		Name:        v.Name,
		MountPath:   v.MountPath,
		Class:       v.Class,
		Access:      v.Access,
		Persistence: v.Persistence,
		Backup:      backup,
		SizeMiB:     v.SizeMiB,
	}
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

type capsuleVolumeProvisioner interface {
	SetupVolumes(context.Context, string, []storagecapsules.VolumeSpec) ([]storagecapsules.Mount, error)
	TeardownVolumes(context.Context, []storagecapsules.Mount) error
}

type defaultCapsuleVolumeProvisioner struct{}

func (defaultCapsuleVolumeProvisioner) SetupVolumes(ctx context.Context, capsuleID string, specs []storagecapsules.VolumeSpec) ([]storagecapsules.Mount, error) {
	mounts := make([]storagecapsules.Mount, 0, len(specs))
	for _, spec := range specs {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		mount, err := storagecapsules.SetupVolumeContext(ctx, capsuleID, spec)
		if err != nil {
			return nil, err
		}
		mounts = append(mounts, mount)
	}
	return mounts, nil
}

func (defaultCapsuleVolumeProvisioner) TeardownVolumes(ctx context.Context, mounts []storagecapsules.Mount) error {
	for _, mount := range mounts {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := storagecapsules.TeardownVolumeContext(ctx, mount); err != nil {
			return err
		}
	}
	return nil
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

	entrypointPath, err := manifestEntrypointPath(manifest)
	if err != nil {
		return ExecutionManifest{}, err
	}
	if _, err := os.Stat(entrypointPath); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ExecutionManifest{}, &ExecuteInvalidRequestError{Reason: "capsule entrypoint is absent"}
		}
		return ExecutionManifest{}, fmt.Errorf("stat capsule entrypoint: %w", err)
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
}

type transientUnitStatus struct {
	DynamicUID string
}

type transientUnitLauncher interface {
	StartTransientUnit(context.Context, transientUnit) (transientUnitStatus, error)
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
		return transientUnitStatus{}, fmt.Errorf("start capsule transient unit: %w: %s", err, strings.TrimSpace(string(output)))
	}

	if output, err := exec.CommandContext(ctx, l.systemctl, "is-active", "--quiet", unit.Name).CombinedOutput(); err != nil {
		cleanupErr := stopAndUnlinkTransientUnit(ctx, l, unit.Name)
		return transientUnitStatus{}, errors.Join(
			fmt.Errorf("capsule transient unit did not become active: %w: %s", err, strings.TrimSpace(string(output))),
			cleanupErr,
		)
	}

	uid, err := l.dynamicUID(ctx, unit.Name)
	if err != nil {
		cleanupErr := stopAndUnlinkTransientUnit(ctx, l, unit.Name)
		return transientUnitStatus{}, errors.Join(err, cleanupErr)
	}

	return transientUnitStatus{DynamicUID: uid}, nil
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
		"id":             {},
		"integrity":      {},
		"packageClass":   {},
		"resourceLimits": {},
		"runtime":        {},
		"version":        {},
	}
	executionRuntimeFields = map[string]struct{}{
		"typescript": {},
	}
	executionDataFields = map[string]struct{}{
		"classes": {},
		"volumes": {},
	}
	executionDataVolumeFields = map[string]struct{}{
		"access":      {},
		"backup":      {},
		"class":       {},
		"mountPath":   {},
		"name":        {},
		"persistence": {},
		"sizeMiB":     {},
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
	volumeNamePattern    = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,127}$`)
	executionDataClasses = map[string]struct{}{
		"app-state":     {},
		"cache":         {},
		"configuration": {},
		"logs":          {},
		"telemetry":     {},
		"user-content":  {},
	}
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

func composeTransientUnit(manifest ExecutionManifest, mounts []storagecapsules.Mount) (transientUnit, error) {
	entrypoint, err := manifestEntrypointPath(manifest)
	if err != nil {
		return transientUnit{}, err
	}
	volumeProperties, err := volumeUnitProperties(mounts)
	if err != nil {
		return transientUnit{}, err
	}

	unitName := capsuleUnitName(manifest.ID)
	runtimeDir := capsuleRuntimeDirectory(manifest.ID)
	limits := manifest.ResourceLimits
	argv := []string{
		defaultDenoPath,
		"run",
		"--no-remote",
		"--cached-only",
		"--no-config",
		"--quiet",
	}
	argv = append(argv, denoVolumePermissionArgs(mounts)...)
	argv = append(argv, entrypoint)

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
		{Name: "SystemCallFilter", Value: "pkey_alloc pkey_free pkey_mprotect"},
		{Name: "UMask", Value: capsuleUMask(mounts)},
		{Name: "Environment", Value: "DENO_DIR=/run/" + runtimeDir + " DENO_NO_UPDATE_CHECK=1 NO_COLOR=1"},
		{Name: "RuntimeDirectory", Value: runtimeDir},
		{Name: "RuntimeDirectoryMode", Value: "0700"},
		{Name: "MemoryMax", Value: strconv.FormatInt(limits.RamMiB*1024*1024, 10)},
		{Name: "CPUQuota", Value: cpuQuota(limits.CPUCores)},
		{Name: "TasksMax", Value: strconv.FormatInt(limits.TasksMax, 10)},
	}
	properties = append(properties, volumeProperties...)

	return transientUnit{
		Name:       unitName,
		Argv:       argv,
		Properties: properties,
	}, nil
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

func volumeSpecsFromManifest(manifest ExecutionManifest) []storagecapsules.VolumeSpec {
	if manifest.Data == nil || len(manifest.Data.Volumes) == 0 {
		return nil
	}

	specs := make([]storagecapsules.VolumeSpec, 0, len(manifest.Data.Volumes))
	for _, volume := range manifest.Data.Volumes {
		specs = append(specs, volume.VolumeSpec())
	}
	return specs
}

func volumeStatuses(mounts []storagecapsules.Mount) []VolumeStatus {
	if len(mounts) == 0 {
		return nil
	}

	statuses := make([]VolumeStatus, 0, len(mounts))
	for _, mount := range mounts {
		statuses = append(statuses, VolumeStatus{
			Name:    mount.VolumeName,
			Path:    mount.Destination,
			Mounted: "OK",
			Status:  "OK",
		})
	}
	return statuses
}

func volumeUnitProperties(mounts []storagecapsules.Mount) ([]systemdProperty, error) {
	if len(mounts) == 0 {
		return nil, nil
	}

	groups := make([]string, 0, 1)
	properties := make([]systemdProperty, 0, len(mounts)+1)
	for _, mount := range mounts {
		if mount.VolumeName == "" {
			return nil, &ExecuteInvalidRequestError{Reason: "capsule volume name is required"}
		}
		if mount.Destination == "" {
			return nil, &ExecuteInvalidRequestError{Reason: "capsule volume destination is required"}
		}
		if mount.Group == "" {
			return nil, &ExecuteInvalidRequestError{Reason: "capsule volume group is required"}
		}
		if mount.BindPath == "" {
			return nil, &ExecuteInvalidRequestError{Reason: "capsule volume bind path is required"}
		}
		pushUniqueString(&groups, mount.Group)
		propertyName := "BindPaths"
		if mount.ReadOnly {
			propertyName = "BindReadOnlyPaths"
		}
		properties = append(properties, systemdProperty{Name: propertyName, Value: mount.BindPath})
	}

	return append([]systemdProperty{{Name: "SupplementaryGroups", Value: strings.Join(groups, " ")}}, properties...), nil
}

func denoVolumePermissionArgs(mounts []storagecapsules.Mount) []string {
	if len(mounts) == 0 {
		return nil
	}

	readPaths := make([]string, 0, len(mounts))
	writePaths := make([]string, 0, len(mounts))
	for _, mount := range mounts {
		if mount.Destination == "" {
			continue
		}
		pushUniqueString(&readPaths, mount.Destination)
		if !mount.ReadOnly {
			pushUniqueString(&writePaths, mount.Destination)
		}
	}

	args := make([]string, 0, 2)
	if len(readPaths) > 0 {
		args = append(args, "--allow-read="+strings.Join(readPaths, ","))
	}
	if len(writePaths) > 0 {
		args = append(args, "--allow-write="+strings.Join(writePaths, ","))
	}
	return args
}

func capsuleUMask(mounts []storagecapsules.Mount) string {
	if len(mounts) == 0 {
		return "0077"
	}
	return "0007"
}

func cloneVolumeStatuses(statuses []VolumeStatus) []VolumeStatus {
	if statuses == nil {
		return nil
	}
	out := make([]VolumeStatus, len(statuses))
	copy(out, statuses)
	return out
}

func cloneVolumeMounts(mounts []storagecapsules.Mount) []storagecapsules.Mount {
	if mounts == nil {
		return nil
	}
	out := make([]storagecapsules.Mount, len(mounts))
	copy(out, mounts)
	return out
}

func pushUniqueString(values *[]string, value string) {
	for _, existing := range *values {
		if existing == value {
			return
		}
	}
	*values = append(*values, value)
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

func requiredArrayField(fields map[string]json.RawMessage, key string, target interface{}) error {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return &ExecuteInvalidRequestError{Reason: key + " is required"}
	}
	if err := decodeSingleJSONValue(raw, target); err != nil {
		return err
	}
	return nil
}

func requiredStringArrayField(fields map[string]json.RawMessage, key string) ([]string, error) {
	var values []string
	if err := requiredArrayField(fields, key, &values); err != nil {
		return nil, err
	}
	if values == nil {
		return nil, fmt.Errorf("%s must be an array", key)
	}
	for i, value := range values {
		if value == "" {
			return nil, fmt.Errorf("%s[%d] must be non-empty", key, i)
		}
	}
	return values, nil
}

func requiredBoolPtrField(fields map[string]json.RawMessage, key string) (*bool, error) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, fmt.Errorf("%s is required", key)
	}

	var value bool
	if err := decodeSingleJSONValue(raw, &value); err != nil {
		return nil, fmt.Errorf("%s must be a boolean", key)
	}
	return &value, nil
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

func validDataClass(value string) bool {
	_, ok := executionDataClasses[value]
	return ok
}

func validVolumeName(value string) bool {
	return value != "." &&
		value != ".." &&
		value == strings.TrimSpace(value) &&
		!controlCharacter.MatchString(value) &&
		volumeNamePattern.MatchString(value)
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
