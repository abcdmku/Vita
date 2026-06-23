package capsule

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestExecuteRejectsCrunExecutorUnderCurrentHardening(t *testing.T) {
	ctx := context.Background()
	entry := executeCrunOCIEntry()
	manifest := executeCrunOCIManifest(entry)
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	launcher := &recordingTransientLauncher{
		status: transientUnitStatus{DynamicUID: "61411"},
	}
	capability := newExecuteCapability(
		fs,
		memoryExecutionManifestStore{entry.ID: manifest},
		launcher,
	)

	undo, err := capability.Apply(ctx, executeApply(entry))

	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil", undo)
	}
	var invalid *ExecuteInvalidRequestError
	if !errors.As(err, &invalid) {
		t.Fatalf("Apply error = %T %v, want ExecuteInvalidRequestError", err, err)
	}
	if invalid.ApplyErrorCode() != ociCrunUnsupportedCode {
		t.Fatalf("ApplyErrorCode = %q, want %q", invalid.ApplyErrorCode(), ociCrunUnsupportedCode)
	}
	if len(launcher.starts) != 0 {
		t.Fatalf("StartTransientUnit calls = %d, want 0", len(launcher.starts))
	}
	if len(launcher.confirmedLimits) != 0 {
		t.Fatalf("ConfirmOCILimits calls = %d, want 0", len(launcher.confirmedLimits))
	}

	response, err := capability.Handle(ctx, ExecuteReadRequest{})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	readResponse := response.(ExecuteReadResponse)
	if readResponse.Last != nil {
		t.Fatalf("Last = %#v, want nil after crun reject", readResponse.Last)
	}
}

func TestOCIRootdirExecutorRemainsDefault(t *testing.T) {
	entry := executeOCIEntry()
	manifest := executeOCIManifest(entry)

	unit, err := composeOCITransientUnit(manifest)
	if err != nil {
		t.Fatalf("composeOCITransientUnit returned error: %v", err)
	}

	if !reflect.DeepEqual(unit.Argv, manifest.Runtime.OCI.Image.Entrypoint) {
		t.Fatalf("argv = %v, want rootdir entrypoint %v", unit.Argv, manifest.Runtime.OCI.Image.Entrypoint)
	}
	if unit.OCIConfig != nil {
		t.Fatalf("OCIConfig = %#v, want nil for rootdir executor", unit.OCIConfig)
	}
	props := propertyValues(unit.Properties)
	assertProperty(t, props, "RootDirectory", "/usr/lib/vita/capsules/local.oci.capsule/rootfs")
	assertProperty(t, props, "MountAPIVFS", "yes")
	assertNoProperty(t, props, "RuntimeDirectory")
}

func TestExecuteRejectsInvalidOCIExecutorWithoutStartingUnit(t *testing.T) {
	ctx := context.Background()
	entry := executeCrunOCIEntry()
	manifest := executeCrunOCIManifest(entry)
	manifest.Runtime.OCI.Executor = "podman"
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	launcher := &recordingTransientLauncher{}
	capability := newExecuteCapability(
		fs,
		memoryExecutionManifestStore{entry.ID: manifest},
		launcher,
	)

	undo, err := capability.Apply(ctx, executeApply(entry))

	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil", undo)
	}
	var invalid *ExecuteInvalidRequestError
	if !errors.As(err, &invalid) {
		t.Fatalf("Apply error = %T %v, want ExecuteInvalidRequestError", err, err)
	}
	if invalid.ApplyErrorCode() != "invalid_executor" {
		t.Fatalf("ApplyErrorCode = %q, want invalid_executor", invalid.ApplyErrorCode())
	}
	if len(launcher.starts) != 0 {
		t.Fatalf("StartTransientUnit calls = %d, want 0", len(launcher.starts))
	}
}

func TestOCIRuntimeDecodesCrunExecutorEnvAndRejectsImageConfig(t *testing.T) {
	raw := []byte(`{
		"id":"local.crun-oci.capsule",
		"version":"1.0.0",
		"integrity":"` + validSHA256SRI + `",
		"packageClass":"oci-service",
		"runtime":{"oci":{"executor":"crun","image":{"digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","entrypoint":["/init"],"env":["VITA_EXECUTOR=crun"]}}},
		"resourceLimits":{"cpuCores":0.25,"ramMiB":64,"storageMiB":16,"tasksMax":32}
	}`)
	var manifest ExecutionManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatalf("Unmarshal valid crun manifest returned error: %v", err)
	}
	if manifest.Runtime.OCI.Executor != ociExecutorCrun {
		t.Fatalf("executor = %q, want crun", manifest.Runtime.OCI.Executor)
	}
	if !reflect.DeepEqual(manifest.Runtime.OCI.Image.Env, []string{"VITA_EXECUTOR=crun"}) {
		t.Fatalf("env = %#v, want manifest env", manifest.Runtime.OCI.Image.Env)
	}

	withImageConfig := strings.Replace(string(raw), `"env":["VITA_EXECUTOR=crun"]`, `"env":["VITA_EXECUTOR=crun"],"config":{"process":{"args":["/evil"]}}`, 1)
	if err := json.Unmarshal([]byte(withImageConfig), &manifest); err == nil {
		t.Fatal("Unmarshal accepted image-supplied config, want unknown-field rejection")
	}
}

func TestStageGeneratedOCIConfigWritesCanonicalConfig(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("generated OCI bundle paths are POSIX runtime paths")
	}

	entry := executeCrunOCIEntry()
	manifest := executeCrunOCIManifest(entry)
	bundlePath := path.Join(t.TempDir(), "bundle")
	config := &generatedOCIConfig{
		BundlePath: bundlePath,
		Spec:       authoredOCIRuntimeSpec(manifest),
	}

	if err := stageGeneratedOCIConfig(config); err != nil {
		t.Fatalf("stageGeneratedOCIConfig returned error: %v", err)
	}

	raw, err := os.ReadFile(path.Join(bundlePath, "config.json"))
	if err != nil {
		t.Fatalf("ReadFile config.json returned error: %v", err)
	}
	var got authoredOCISpec
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("Unmarshal staged config returned error: %v", err)
	}
	if !reflect.DeepEqual(got, config.Spec) {
		t.Fatalf("staged config = %#v, want %#v", got, config.Spec)
	}
}

func executeCrunOCIEntry() CapsuleEntry {
	return CapsuleEntry{
		ID:        "local.crun-oci.capsule",
		Version:   "1.0.0",
		Integrity: validSHA256SRI,
		State:     StateInstalled,
	}
}

func executeCrunOCIManifest(entry CapsuleEntry) ExecutionManifest {
	manifest := executeOCIManifest(entry)
	manifest.Runtime.OCI.Executor = ociExecutorCrun
	manifest.Runtime.OCI.Image.Env = []string{"VITA_EXECUTOR=crun"}
	manifest.baseDir = "/usr/lib/vita/capsules/" + entry.ID
	return manifest
}

func assertNoOCICapabilities(t *testing.T, capabilities authoredOCICapabilities) {
	t.Helper()
	if len(capabilities.Bounding) != 0 ||
		len(capabilities.Effective) != 0 ||
		len(capabilities.Inheritable) != 0 ||
		len(capabilities.Permitted) != 0 ||
		len(capabilities.Ambient) != 0 {
		t.Fatalf("capabilities = %#v, want all capability sets empty", capabilities)
	}
}
