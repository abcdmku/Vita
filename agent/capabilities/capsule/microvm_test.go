package capsule

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestExecuteComposesMicroVMTransientUnitFromValidatedManifest(t *testing.T) {
	ctx := context.Background()
	entry := executeMicroVMEntry()
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	launcher := &recordingTransientLauncher{
		status: transientUnitStatus{DynamicUID: "0"},
	}
	capability := newExecuteCapability(
		fs,
		memoryExecutionManifestStore{
			entry.ID: executeMicroVMManifest(entry),
		},
		launcher,
	)

	undo, err := capability.Apply(ctx, executeApply(entry))
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo")
	}
	if len(launcher.starts) != 1 {
		t.Fatalf("StartTransientUnit calls = %d, want 1", len(launcher.starts))
	}

	started := launcher.starts[0]
	if started.Name != capsuleUnitName(entry.ID) {
		t.Fatalf("unit name = %q, want %q", started.Name, capsuleUnitName(entry.ID))
	}
	wantArgv := []string{
		defaultNspawnPath,
		"--directory=/usr/lib/vita/capsules/local.microvm.capsule/rootfs",
		"--private-users=pick",
		"-U",
		"--as-pid2",
		"--ephemeral",
		"--private-network",
		"--drop-capability=all",
		"--",
		"/init",
		"--ready=ok",
	}
	if !reflect.DeepEqual(started.Argv, wantArgv) {
		t.Fatalf("argv = %v, want %v", started.Argv, wantArgv)
	}
	if len(started.Volumes) != 0 {
		t.Fatalf("volumes = %v, want none", started.Volumes)
	}

	props := propertyValues(started.Properties)
	assertProperty(t, props, "Type", "simple")
	assertProperty(t, props, "NoNewPrivileges", "yes")
	assertProperty(t, props, "AmbientCapabilities", "")
	assertProperty(t, props, "ProtectSystem", "strict")
	assertProperty(t, props, "ProtectHome", "yes")
	assertProperty(t, props, "PrivateTmp", "yes")
	assertProperty(t, props, "PrivateDevices", "yes")
	assertProperty(t, props, "RestrictNamespaces", "mnt pid ipc uts user net cgroup")
	assertProperty(t, props, "RestrictAddressFamilies", "AF_UNIX AF_NETLINK")
	assertProperty(t, props, "MemoryMax", "67108864")
	assertProperty(t, props, "CPUQuota", "25%")
	assertProperty(t, props, "TasksMax", "32")
	assertNoProperty(t, props, "RootDirectory")
	assertNoProperty(t, props, "MountAPIVFS")
	assertNoProperty(t, props, "DynamicUser")
	assertNoProperty(t, props, "StateDirectory")
	assertNoProperty(t, props, "StateDirectoryMode")

	response, err := capability.Handle(ctx, ExecuteReadRequest{})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	readResponse, ok := response.(ExecuteReadResponse)
	if !ok {
		t.Fatalf("Handle returned %T, want ExecuteReadResponse", response)
	}
	if readResponse.Last == nil {
		t.Fatal("ExecuteReadResponse.Last = nil, want execution status")
	}
	if readResponse.Last.ID != entry.ID || readResponse.Last.Unit != started.Name || readResponse.Last.DynamicUID != "0" {
		t.Fatalf("Last = %#v, want id/unit/uid from launcher", readResponse.Last)
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if !reflect.DeepEqual(launcher.stops, []string{started.Name}) {
		t.Fatalf("stops = %v, want [%s]", launcher.stops, started.Name)
	}
	if !reflect.DeepEqual(launcher.resets, []string{started.Name}) {
		t.Fatalf("resets = %v, want [%s]", launcher.resets, started.Name)
	}
}

func TestComposeMicroVMRejectsNonMicroVMService(t *testing.T) {
	manifest := executeOCIManifest(executeOCIEntry())

	unit, err := composeMicroVMTransientUnit(manifest)

	if unit.Name != "" || len(unit.Argv) != 0 {
		t.Fatalf("compose returned unit %#v, want zero unit", unit)
	}
	var invalid *ExecuteInvalidRequestError
	if !errors.As(err, &invalid) {
		t.Fatalf("compose error = %T %v, want ExecuteInvalidRequestError", err, err)
	}
}

func TestExecuteRejectsMicroVMInvalidEntrypointWithoutStartingUnit(t *testing.T) {
	ctx := context.Background()
	entry := executeMicroVMEntry()
	manifest := executeMicroVMManifest(entry)
	manifest.Runtime.OCI.Image.Entrypoint = []string{"/init;reboot"}
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
	if invalid.ApplyErrorCode() != "invalid_entrypoint" {
		t.Fatalf("ApplyErrorCode = %q, want invalid_entrypoint", invalid.ApplyErrorCode())
	}
	if len(launcher.starts) != 0 {
		t.Fatalf("StartTransientUnit calls = %d, want 0", len(launcher.starts))
	}
}

func TestExecuteRejectsMicroVMMissingRootfsWithoutStartingUnit(t *testing.T) {
	ctx := context.Background()
	entry := executeMicroVMEntry()
	root := t.TempDir()
	baseDir := filepath.Join(root, entry.ID)
	if err := os.MkdirAll(baseDir, 0o755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}
	if err := os.WriteFile(filepath.Join(baseDir, "manifest.json"), []byte(microVMManifestJSON(entry)), 0o644); err != nil {
		t.Fatalf("WriteFile manifest returned error: %v", err)
	}

	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	launcher := &recordingTransientLauncher{}
	capability := newExecuteCapability(
		fs,
		fileExecutionManifestStore{root: root},
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
	if invalid.ApplyErrorCode() != "rootfs_absent" {
		t.Fatalf("ApplyErrorCode = %q, want rootfs_absent", invalid.ApplyErrorCode())
	}
	if len(launcher.starts) != 0 {
		t.Fatalf("StartTransientUnit calls = %d, want 0", len(launcher.starts))
	}
}

func executeMicroVMEntry() CapsuleEntry {
	return CapsuleEntry{
		ID:        "local.microvm.capsule",
		Version:   "1.0.0",
		Integrity: validSHA256SRI,
		State:     StateInstalled,
	}
}

func executeMicroVMManifest(entry CapsuleEntry) ExecutionManifest {
	return ExecutionManifest{
		ID:           entry.ID,
		Version:      entry.Version,
		Integrity:    entry.Integrity,
		PackageClass: executePackageClassMicroVMService,
		Runtime: ExecutionRuntime{
			OCI: OCIExecution{
				Image: OCIImageExecution{
					Digest:     "sha256:93056d053347799089cac1bc9c225d224e31822b3cbfbaded42753f41274f57b",
					Entrypoint: []string{"/init", "--ready=ok"},
				},
			},
		},
		ResourceLimits: ExecutionResourceLimits{
			CPUCores:   0.25,
			RamMiB:     64,
			StorageMiB: 16,
			TasksMax:   32,
		},
		baseDir: "/usr/lib/vita/capsules/local.microvm.capsule",
	}
}

func microVMManifestJSON(entry CapsuleEntry) string {
	return `{
		"id":"` + entry.ID + `",
		"version":"` + entry.Version + `",
		"integrity":"` + entry.Integrity + `",
		"packageClass":"microvm-service",
		"runtime":{"oci":{"image":{"digest":"sha256:93056d053347799089cac1bc9c225d224e31822b3cbfbaded42753f41274f57b","entrypoint":["/init"]}}},
		"resourceLimits":{"cpuCores":0.25,"ramMiB":64,"storageMiB":16,"tasksMax":32}
	}`
}
