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
	ID         string `json:"id"`
	Unit       string `json:"unit"`
	DynamicUID string `json:"dynamicUid"`
	Health     string `json:"health"`
	Status     string `json:"status"`
}

type ExecuteCapability struct {
	registryFS registryFileSystem
	manifests  executionManifestStore
	launcher   transientUnitLauncher

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
	}
	c.setLast(executeStatus)

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
}

func (u executeUndo) Undo(ctx context.Context) error {
	if u.launcher == nil {
		return &ExecuteInvalidRequestError{Reason: "missing capsule execute launcher"}
	}
	if err := stopAndUnlinkTransientUnit(ctx, u.launcher, u.unit); err != nil {
		return err
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

func composeTransientUnit(manifest ExecutionManifest) (transientUnit, error) {
	entrypoint, err := manifestEntrypointPath(manifest)
	if err != nil {
		return transientUnit{}, err
	}

	unitName := capsuleUnitName(manifest.ID)
	runtimeDir := capsuleRuntimeDirectory(manifest.ID)
	limits := manifest.ResourceLimits
	return transientUnit{
		Name: unitName,
		Argv: []string{
			defaultDenoPath,
			"run",
			"--no-remote",
			"--cached-only",
			"--no-config",
			"--quiet",
			entrypoint,
		},
		Properties: []systemdProperty{
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
			{Name: "UMask", Value: "0077"},
			{Name: "Environment", Value: "DENO_DIR=/run/" + runtimeDir + " DENO_NO_UPDATE_CHECK=1 NO_COLOR=1"},
			{Name: "RuntimeDirectory", Value: runtimeDir},
			{Name: "RuntimeDirectoryMode", Value: "0700"},
			{Name: "MemoryMax", Value: strconv.FormatInt(limits.RamMiB*1024*1024, 10)},
			{Name: "CPUQuota", Value: cpuQuota(limits.CPUCores)},
			{Name: "TasksMax", Value: strconv.FormatInt(limits.TasksMax, 10)},
		},
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
