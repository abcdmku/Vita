package capsule

import (
	"errors"
	"fmt"
	"os"
	"path"
	"strconv"

	"github.com/vita/agent/internal/jsonsafe"
	capsulestorage "github.com/vita/agent/storage/capsules"
)

const wasmModuleName = "component.wasm"

type WasmExecution struct {
	Module string `json:"module"`
}

func (e *WasmExecution) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, wasmExecutionFields); err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	module, err := requiredStringField(fields, "module")
	if err != nil {
		return &ExecuteInvalidRequestError{Reason: err.Error()}
	}

	out := WasmExecution{Module: module}
	if err := out.Validate(); err != nil {
		return err
	}

	*e = out
	return nil
}

func (e WasmExecution) Validate() error {
	if e.Module != wasmModuleName {
		return &ExecuteInvalidRequestError{Reason: "runtime.wasm.module must be component.wasm"}
	}
	return nil
}

func composeWasmTransientUnit(manifest ExecutionManifest) (transientUnit, error) {
	if err := manifest.Runtime.ValidateForPackageClass(executePackageClassWasmService); err != nil {
		return transientUnit{}, err
	}
	module, err := manifestWasmModulePath(manifest)
	if err != nil {
		return transientUnit{}, err
	}

	unitName := capsuleUnitName(manifest.ID)
	var netns *capsuleNetns
	if manifest.Network != nil {
		unitNetns, err := capsuleNetnsForNetwork(unitName, "", manifest.Network)
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
	properties := hardenedTransientUnitProperties(manifest, false)
	properties = append(properties,
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
		Argv:       wasmtimeArgv(module),
		Properties: properties,
		Volumes:    volumes,
		NetNS:      netns,
	}, nil
}

func wasmtimeArgv(module string) []string {
	return []string{
		defaultWasmtimePath,
		"run",
		module,
	}
}

func manifestWasmModulePath(manifest ExecutionManifest) (string, error) {
	if err := manifest.Runtime.Wasm.Validate(); err != nil {
		return "", err
	}
	baseDir := manifest.baseDir
	if baseDir == "" {
		baseDir = path.Join(defaultCapsuleRoot, manifest.ID)
	}
	return path.Join(baseDir, manifest.Runtime.Wasm.Module), nil
}

func statWasmManifestArtifacts(manifest ExecutionManifest) error {
	modulePath, err := manifestWasmModulePath(manifest)
	if err != nil {
		return err
	}
	info, err := os.Stat(modulePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &ExecuteInvalidRequestError{Code: "module_absent", Reason: "capsule wasm module is absent"}
		}
		return fmt.Errorf("stat capsule wasm module: %w", err)
	}
	if info.IsDir() {
		return &ExecuteInvalidRequestError{Code: "module_inaccessible", Reason: "capsule wasm module must be a file"}
	}
	return nil
}

var wasmExecutionFields = map[string]struct{}{
	"module": {},
}
