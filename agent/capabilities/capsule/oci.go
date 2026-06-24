package capsule

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/vita/agent/internal/jsonsafe"
	capsulestorage "github.com/vita/agent/storage/capsules"
)

const (
	hostileOCICapsuleID = "local.hostile-oci.capsule"

	ociLimitValueEnforced    = "enforced"
	ociLimitValueNotEnforced = "not_enforced"
	ociLimitValueUnknown     = "unknown"
	ociLimitStatusOK         = "OK"
	ociLimitStatusFail       = "FAIL"

	ociLimitConfirmTimeout  = 5 * time.Second
	ociLimitConfirmInterval = 100 * time.Millisecond
)

type OCIExecution struct {
	Image OCIImageExecution `json:"image"`
}

func (e *OCIExecution) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, ociExecutionFields); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	var image OCIImageExecution
	if err := requiredObjectField(fields, "image", &image); err != nil {
		return err
	}

	out := OCIExecution{Image: image}
	if err := out.Validate(); err != nil {
		return err
	}

	*e = out
	return nil
}

func (e OCIExecution) Validate() error {
	return e.Image.Validate()
}

type OCIImageExecution struct {
	Digest     string   `json:"digest"`
	Entrypoint []string `json:"entrypoint"`
}

func (e *OCIImageExecution) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, ociImageExecutionFields); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	digest, err := requiredStringField(fields, "digest")
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	entrypoint, err := requiredOCIEntrypointField(fields, "entrypoint")
	if err != nil {
		return err
	}

	out := OCIImageExecution{
		Digest:     digest,
		Entrypoint: entrypoint,
	}
	if err := out.Validate(); err != nil {
		return err
	}

	*e = out
	return nil
}

func (e OCIImageExecution) Validate() error {
	if !validOCIDigest(e.Digest) {
		return &ExecuteInvalidRequestError{Reason: "runtime.oci.image.digest must be a sha256 OCI digest"}
	}
	if len(e.Entrypoint) == 0 {
		return &ExecuteInvalidRequestError{Code: "invalid_entrypoint", Reason: "runtime.oci.image.entrypoint is required"}
	}
	for i, arg := range e.Entrypoint {
		if err := validateOCIArgvElement(arg, i == 0); err != nil {
			return &ExecuteInvalidRequestError{Code: "invalid_entrypoint", Reason: fmt.Sprintf("runtime.oci.image.entrypoint[%d]: %v", i, err)}
		}
	}
	return nil
}

func composeOCITransientUnit(manifest ExecutionManifest) (transientUnit, error) {
	if err := manifest.Runtime.ValidateForPackageClass(executePackageClassOCIService); err != nil {
		return transientUnit{}, err
	}

	unitName := capsuleUnitName(manifest.ID)
	var netns *capsuleNetns
	if manifest.Network != nil {
		unitNetns := capsuleNetnsForUnit(unitName, "")
		netns = &unitNetns
	}
	limits := manifest.ResourceLimits
	volumes, err := capsulestorage.SetupVolumes(manifest.ID, manifest.Data.Volumes)
	if err != nil {
		return transientUnit{}, &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	properties := hardenedTransientUnitProperties(manifest, false)
	properties = append(properties,
		systemdProperty{Name: "RootDirectory", Value: ociRootDirectory(manifest)},
		systemdProperty{Name: "MountAPIVFS", Value: "yes"},
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
		Argv:       append([]string(nil), manifest.Runtime.OCI.Image.Entrypoint...),
		Properties: properties,
		Volumes:    volumes,
		NetNS:      netns,
	}, nil
}

type OCILimitsStatus struct {
	Mem    string `json:"mem"`
	Tasks  string `json:"tasks"`
	CPU    string `json:"cpu"`
	Status string `json:"status"`
}

type ociCgroupLimitFiles struct {
	MemoryMax    []byte
	MemoryEvents []byte
	PidsMax      []byte
	PidsEvents   []byte
	CPUMax       []byte
	CPUStat      []byte
}

func (l systemdRunLauncher) ConfirmOCILimits(ctx context.Context, unit string, limits ExecutionResourceLimits) (OCILimitsStatus, error) {
	cgroupPath, err := l.unitCgroupPath(ctx, unit)
	if err != nil {
		return unknownOCILimitsStatus(), err
	}

	deadline := time.Now().Add(ociLimitConfirmTimeout)
	last := unknownOCILimitsStatus()
	for {
		status, err := readOCILimitsStatus(cgroupPath, limits)
		if err == nil {
			last = status
			if status.Status == ociLimitStatusOK {
				return status, nil
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return unknownOCILimitsStatus(), err
		}

		if !time.Now().Before(deadline) {
			return last, nil
		}

		timer := time.NewTimer(ociLimitConfirmInterval)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			return unknownOCILimitsStatus(), ctx.Err()
		case <-timer.C:
		}
	}
}

func (l systemdRunLauncher) unitCgroupPath(ctx context.Context, unit string) (string, error) {
	controlGroup, err := l.showUnitProperty(ctx, unit, "ControlGroup")
	if err != nil {
		return "", err
	}
	cleaned := path.Clean("/" + strings.TrimPrefix(strings.TrimSpace(controlGroup), "/"))
	if cleaned == "/" || strings.Contains(cleaned, "\x00") {
		return "", fmt.Errorf("read capsule transient unit cgroup: empty ControlGroup")
	}
	return path.Join("/sys/fs/cgroup", strings.TrimPrefix(cleaned, "/")), nil
}

func readOCILimitsStatus(cgroupPath string, limits ExecutionResourceLimits) (OCILimitsStatus, error) {
	memoryMax, err := os.ReadFile(path.Join(cgroupPath, "memory.max"))
	if err != nil {
		return OCILimitsStatus{}, err
	}
	memoryEvents, err := os.ReadFile(path.Join(cgroupPath, "memory.events"))
	if err != nil {
		return OCILimitsStatus{}, err
	}
	pidsMax, err := os.ReadFile(path.Join(cgroupPath, "pids.max"))
	if err != nil {
		return OCILimitsStatus{}, err
	}
	pidsEvents, err := os.ReadFile(path.Join(cgroupPath, "pids.events"))
	if err != nil {
		return OCILimitsStatus{}, err
	}
	cpuMax, err := os.ReadFile(path.Join(cgroupPath, "cpu.max"))
	if err != nil {
		return OCILimitsStatus{}, err
	}
	cpuStat, err := os.ReadFile(path.Join(cgroupPath, "cpu.stat"))
	if err != nil {
		return OCILimitsStatus{}, err
	}

	return evaluateOCILimitsStatus(limits, ociCgroupLimitFiles{
		MemoryMax:    memoryMax,
		MemoryEvents: memoryEvents,
		PidsMax:      pidsMax,
		PidsEvents:   pidsEvents,
		CPUMax:       cpuMax,
		CPUStat:      cpuStat,
	}), nil
}

func evaluateOCILimitsStatus(limits ExecutionResourceLimits, files ociCgroupLimitFiles) OCILimitsStatus {
	status := OCILimitsStatus{
		Mem:   ociLimitState(memoryLimitEnforced(limits.RamMiB*1024*1024, files.MemoryMax, files.MemoryEvents)),
		Tasks: ociLimitState(tasksLimitEnforced(limits.TasksMax, files.PidsMax, files.PidsEvents)),
		CPU:   ociLimitState(cpuLimitEnforced(limits.CPUCores, files.CPUMax, files.CPUStat)),
	}
	if status.Mem == ociLimitValueEnforced && status.Tasks == ociLimitValueEnforced && status.CPU == ociLimitValueEnforced {
		status.Status = ociLimitStatusOK
	} else {
		status.Status = ociLimitStatusFail
	}
	return status
}

func memoryLimitEnforced(limitBytes int64, maxRaw []byte, eventsRaw []byte) bool {
	return cgroupLimitAtOrBelow(maxRaw, limitBytes) && cgroupCounterHit(eventsRaw, "max", "oom", "oom_kill")
}

func tasksLimitEnforced(limit int64, maxRaw []byte, eventsRaw []byte) bool {
	return cgroupLimitAtOrBelow(maxRaw, limit) && cgroupCounterHit(eventsRaw, "max")
}

func cpuLimitEnforced(limitCores float64, maxRaw []byte, statRaw []byte) bool {
	if limitCores <= 0 || !cpuMaxAtOrBelow(maxRaw, limitCores) {
		return false
	}
	return cgroupCounterHit(statRaw, "nr_throttled", "throttled_usec")
}

func cgroupLimitAtOrBelow(raw []byte, expected int64) bool {
	if expected <= 0 {
		return false
	}
	value, ok := parseSingleCgroupUint(raw)
	return ok && value > 0 && value <= uint64(expected)
}

func cpuMaxAtOrBelow(raw []byte, expectedCores float64) bool {
	fields := strings.Fields(string(raw))
	if len(fields) != 2 || fields[0] == "max" {
		return false
	}
	quota, err := strconv.ParseUint(fields[0], 10, 64)
	if err != nil || quota == 0 {
		return false
	}
	period, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil || period == 0 {
		return false
	}
	actual := float64(quota) / float64(period)
	return actual > 0 && actual <= expectedCores+0.000001
}

func parseSingleCgroupUint(raw []byte) (uint64, bool) {
	value := strings.TrimSpace(string(raw))
	if value == "" || value == "max" || strings.ContainsAny(value, " \t\r\n") {
		return 0, false
	}
	parsed, err := strconv.ParseUint(value, 10, 64)
	return parsed, err == nil
}

func cgroupCounterHit(raw []byte, names ...string) bool {
	counters := parseCgroupCounters(raw)
	for _, name := range names {
		if counters[name] > 0 {
			return true
		}
	}
	return false
}

func parseCgroupCounters(raw []byte) map[string]uint64 {
	counters := make(map[string]uint64)
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		counters[fields[0]] = value
	}
	return counters
}

func ociLimitState(enforced bool) string {
	if enforced {
		return ociLimitValueEnforced
	}
	return ociLimitValueNotEnforced
}

func shouldConfirmOCILimitEnforcement(manifest ExecutionManifest) bool {
	return manifest.PackageClass == executePackageClassOCIService && manifest.ID == hostileOCICapsuleID
}

func logOCILimitsStatus(id string, status OCILimitsStatus) {
	status = normalizeOCILimitsStatus(status)
	log.Printf(
		"VITA-CAPSULE-OCI-LIMITS: id=%s mem=%s tasks=%s cpu=%s status=%s",
		id,
		status.Mem,
		status.Tasks,
		status.CPU,
		status.Status,
	)
}

func normalizeOCILimitsStatus(status OCILimitsStatus) OCILimitsStatus {
	if status.Mem == "" {
		status.Mem = ociLimitValueUnknown
	}
	if status.Tasks == "" {
		status.Tasks = ociLimitValueUnknown
	}
	if status.CPU == "" {
		status.CPU = ociLimitValueUnknown
	}
	if status.Status == "" {
		status.Status = ociLimitStatusFail
	}
	return status
}

func unknownOCILimitsStatus() OCILimitsStatus {
	return OCILimitsStatus{
		Mem:    ociLimitValueUnknown,
		Tasks:  ociLimitValueUnknown,
		CPU:    ociLimitValueUnknown,
		Status: ociLimitStatusFail,
	}
}

func cloneOCILimitsStatus(status *OCILimitsStatus) *OCILimitsStatus {
	if status == nil {
		return nil
	}
	cloned := *status
	return &cloned
}

func statOCIManifestArtifacts(manifest ExecutionManifest) error {
	rootfs := ociRootDirectory(manifest)
	info, err := os.Stat(rootfs)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &ExecuteInvalidRequestError{Code: "rootfs_absent", Reason: "capsule oci rootfs is absent"}
		}
		return fmt.Errorf("stat capsule oci rootfs: %w", err)
	}
	if !info.IsDir() {
		return &ExecuteInvalidRequestError{Code: "rootfs_inaccessible", Reason: "capsule oci rootfs must be a directory"}
	}
	if !worldReadableExecutable(info.Mode()) {
		return &ExecuteInvalidRequestError{Code: "permission_denied", Reason: "capsule oci rootfs must be world-readable and executable"}
	}

	entrypointPath, err := ociEntrypointHostPath(manifest)
	if err != nil {
		return err
	}
	if err := statOCIEntrypointDirectories(rootfs, entrypointPath); err != nil {
		return err
	}
	info, err = os.Stat(entrypointPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &ExecuteInvalidRequestError{Code: "exec_failed", Reason: "capsule oci entrypoint is absent"}
		}
		return fmt.Errorf("stat capsule oci entrypoint: %w", err)
	}
	if info.IsDir() {
		return &ExecuteInvalidRequestError{Code: "invalid_entrypoint", Reason: "capsule oci entrypoint must be a file"}
	}
	if !worldReadableExecutable(info.Mode()) {
		return &ExecuteInvalidRequestError{Code: "permission_denied", Reason: "capsule oci entrypoint must be world-readable and executable"}
	}
	return nil
}

func statOCIEntrypointDirectories(rootfs string, entrypointPath string) error {
	parent := path.Dir(entrypointPath)
	for {
		if parent == rootfs || parent == "." || parent == "/" {
			return nil
		}
		info, err := os.Stat(parent)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return &ExecuteInvalidRequestError{Code: "exec_failed", Reason: "capsule oci entrypoint directory is absent"}
			}
			return fmt.Errorf("stat capsule oci entrypoint directory: %w", err)
		}
		if !info.IsDir() {
			return &ExecuteInvalidRequestError{Code: "invalid_entrypoint", Reason: "capsule oci entrypoint path parent must be a directory"}
		}
		if !worldReadableExecutable(info.Mode()) {
			return &ExecuteInvalidRequestError{Code: "permission_denied", Reason: "capsule oci entrypoint directory must be world-readable and executable"}
		}
		parent = path.Dir(parent)
	}
}

func ociEntrypointHostPath(manifest ExecutionManifest) (string, error) {
	if err := manifest.Runtime.ValidateForPackageClass(executePackageClassOCIService); err != nil {
		return "", err
	}
	entrypoint := manifest.Runtime.OCI.Image.Entrypoint[0]
	cleaned := path.Clean(entrypoint)
	return path.Join(ociRootDirectory(manifest), strings.TrimPrefix(cleaned, "/")), nil
}

func ociRootDirectory(manifest ExecutionManifest) string {
	baseDir := manifest.baseDir
	if baseDir == "" {
		baseDir = path.Join(defaultCapsuleRoot, manifest.ID)
	}
	return path.Join(baseDir, "rootfs")
}

func requiredOCIEntrypointField(fields map[string]json.RawMessage, key string) ([]string, error) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, &ExecuteInvalidRequestError{Code: "invalid_entrypoint", Reason: "runtime.oci.image." + key + " is required"}
	}

	var entrypoint []string
	if err := decodeSingleJSONValue(raw, &entrypoint); err != nil {
		return nil, &ExecuteInvalidRequestError{Code: "invalid_entrypoint", Reason: "runtime.oci.image." + key + " must be an argv list"}
	}
	if entrypoint == nil {
		return nil, &ExecuteInvalidRequestError{Code: "invalid_entrypoint", Reason: "runtime.oci.image." + key + " must be an argv list"}
	}
	return entrypoint, nil
}

func validOCIDigest(value string) bool {
	algorithm, encoded, ok := strings.Cut(value, ":")
	if !ok || algorithm != "sha256" || len(encoded) != 64 || encoded != strings.ToLower(encoded) {
		return false
	}
	decoded, err := hex.DecodeString(encoded)
	return err == nil && len(decoded) == 32
}

func validateOCIArgvElement(value string, entrypoint bool) error {
	if value == "" {
		return errors.New("must not be empty")
	}
	if controlCharacter.MatchString(value) {
		return errors.New("must not contain control characters")
	}
	if !safeOCIArgvToken(value) {
		return errors.New("contains unsupported argv characters")
	}
	if !entrypoint {
		return nil
	}
	if !path.IsAbs(value) {
		return errors.New("must be an absolute in-rootfs path")
	}
	if value == "/" || path.Clean(value) != value {
		return errors.New("must be a clean absolute in-rootfs path")
	}
	return nil
}

func worldReadableExecutable(mode os.FileMode) bool {
	return mode.Perm()&0o005 == 0o005
}

func safeOCIArgvToken(value string) bool {
	for _, r := range value {
		switch {
		case r >= 'A' && r <= 'Z':
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9':
		case strings.ContainsRune("/._-:=+,", r):
		default:
			return false
		}
	}
	return true
}

var (
	ociExecutionFields = map[string]struct{}{
		"image": {},
	}
	ociImageExecutionFields = map[string]struct{}{
		"digest":     {},
		"entrypoint": {},
	}
)
