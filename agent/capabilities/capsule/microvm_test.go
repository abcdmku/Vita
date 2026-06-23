package capsule

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

func TestExecuteComposesMicroVMTransientUnitFromValidatedManifest(t *testing.T) {
	ctx := context.Background()
	entry := executeMicroVMEntry()
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	launcher := &recordingTransientLauncher{
		status: transientUnitStatus{
			DynamicUID: "0",
			MicroVM: &microVMReadinessStatus{
				Isolation: "nspawn",
				PID1:      "own",
				Health:    "OK",
				Status:    "OK",
			},
		},
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
	if started.MicroVMReadiness == nil || started.MicroVMReadiness.ID != entry.ID {
		t.Fatalf("MicroVMReadiness = %#v, want id %q", started.MicroVMReadiness, entry.ID)
	}

	props := propertyValues(started.Properties)
	assertProperty(t, props, "Type", "simple")
	assertProperty(t, props, "AmbientCapabilities", "")
	assertProperty(t, props, "ProtectHome", "yes")
	assertProperty(t, props, "PrivateTmp", "yes")
	assertProperty(t, props, "RestrictNamespaces", "mnt pid ipc uts user net cgroup")
	assertProperty(t, props, "RestrictAddressFamilies", "AF_UNIX AF_NETLINK")
	assertProperty(t, props, "Environment", "TMPDIR=/run/vita-capsule-local.microvm.capsule-022e7cca-nspawn")
	assertProperty(t, props, "RuntimeDirectory", "vita-capsule-local.microvm.capsule-022e7cca-nspawn")
	assertProperty(t, props, "RuntimeDirectoryMode", "0700")
	assertProperty(t, props, "MemoryMax", "67108864")
	assertProperty(t, props, "CPUQuota", "25%")
	assertProperty(t, props, "TasksMax", "32")
	assertNoProperty(t, props, "NoNewPrivileges")
	assertNoProperty(t, props, "ProtectSystem")
	assertNoProperty(t, props, "PrivateDevices")
	assertNoProperty(t, props, "CapabilityBoundingSet")
	assertNoProperty(t, props, "RootDirectory")
	assertNoProperty(t, props, "MountAPIVFS")
	assertNoProperty(t, props, "DynamicUser")

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
	if readResponse.Last.Isolation != "nspawn" || readResponse.Last.PID1 != "own" {
		t.Fatalf("Last microvm proof = isolation=%q pid1=%q, want nspawn/own", readResponse.Last.Isolation, readResponse.Last.PID1)
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

func TestExecuteRejectsMicroVMWithoutReadinessProofAfterStart(t *testing.T) {
	ctx := context.Background()
	entry := executeMicroVMEntry()
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	launcher := &recordingTransientLauncher{
		status: transientUnitStatus{DynamicUID: "0"},
	}
	capability := newExecuteCapability(
		fs,
		memoryExecutionManifestStore{entry.ID: executeMicroVMManifest(entry)},
		launcher,
	)

	undo, err := capability.Apply(ctx, executeApply(entry))

	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil", undo)
	}
	var startErr *ExecuteStartError
	if !errors.As(err, &startErr) {
		t.Fatalf("Apply error = %T %v, want ExecuteStartError", err, err)
	}
	if startErr.ApplyErrorCode() != "microvm_readiness_failed" {
		t.Fatalf("ApplyErrorCode = %q, want microvm_readiness_failed", startErr.ApplyErrorCode())
	}
	if len(launcher.starts) != 1 {
		t.Fatalf("StartTransientUnit calls = %d, want 1", len(launcher.starts))
	}
	if !reflect.DeepEqual(launcher.stops, []string{launcher.starts[0].Name}) {
		t.Fatalf("stops = %v, want [%s]", launcher.stops, launcher.starts[0].Name)
	}
	if !reflect.DeepEqual(launcher.resets, []string{launcher.starts[0].Name}) {
		t.Fatalf("resets = %v, want [%s]", launcher.resets, launcher.starts[0].Name)
	}

	response, err := capability.Handle(ctx, ExecuteReadRequest{})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	readResponse, ok := response.(ExecuteReadResponse)
	if !ok {
		t.Fatalf("Handle returned %T, want ExecuteReadResponse", response)
	}
	if readResponse.Last != nil {
		t.Fatalf("ExecuteReadResponse.Last = %#v, want nil after rejected readiness", readResponse.Last)
	}
}

func TestParseMicroVMReadinessRequiresOwnPIDProof(t *testing.T) {
	probe := microVMReadinessProbe{ID: "local.microvm.capsule"}

	status, ok := parseMicroVMReadiness([]byte(`
noise
VITA-CAPSULE-MICROVM-WORKLOAD: id=local.microvm.capsule pid=2 pid1=own status=OK
`), probe)
	if !ok {
		t.Fatal("parseMicroVMReadiness rejected valid readiness marker")
	}
	if status.Isolation != "nspawn" || status.PID1 != "own" || status.Health != "OK" || status.Status != "OK" {
		t.Fatalf("status = %#v, want nspawn/own/OK", status)
	}

	rejects := map[string]string{
		"wrong id":       "VITA-CAPSULE-MICROVM-WORKLOAD: id=other.capsule pid=2 pid1=own status=OK",
		"host pid":       "VITA-CAPSULE-MICROVM-WORKLOAD: id=local.microvm.capsule pid=412 pid1=own status=OK",
		"unexpected pid": "VITA-CAPSULE-MICROVM-WORKLOAD: id=local.microvm.capsule pid=2 pid1=unexpected status=OK",
		"bad status":     "VITA-CAPSULE-MICROVM-WORKLOAD: id=local.microvm.capsule pid=2 pid1=own status=FAIL",
	}
	for name, line := range rejects {
		t.Run(name, func(t *testing.T) {
			if parsed, ok := parseMicroVMReadiness([]byte(line), probe); ok {
				t.Fatalf("parseMicroVMReadiness accepted %#v, want reject", parsed)
			}
		})
	}
}

func TestSystemdRunLauncherReadsMicroVMReadinessFromJournal(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake systemd scripts require a POSIX shell")
	}

	dir := t.TempDir()
	systemdRun := filepath.Join(dir, "systemd-run")
	systemctl := filepath.Join(dir, "systemctl")
	journalctl := filepath.Join(dir, "journalctl")
	if err := os.WriteFile(systemdRun, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("WriteFile systemd-run returned error: %v", err)
	}
	if err := os.WriteFile(systemctl, []byte(`#!/bin/sh
case "$1" in
  is-active)
    exit 0
    ;;
  show)
    if [ "$2" = "--property=UID" ]; then
      printf '61408\n'
      exit 0
    fi
    printf '%s\n' 'ActiveState=active' 'SubState=running' 'Result=success' 'ExecMainCode=0' 'ExecMainStatus=0'
    exit 0
    ;;
  stop|reset-failed)
    exit 0
    ;;
esac
exit 1
`), 0o755); err != nil {
		t.Fatalf("WriteFile systemctl returned error: %v", err)
	}
	if err := os.WriteFile(journalctl, []byte(`#!/bin/sh
printf '%s\n' 'VITA-CAPSULE-MICROVM-WORKLOAD: id=local.microvm.capsule pid=1 pid1=own status=OK'
exit 0
`), 0o755); err != nil {
		t.Fatalf("WriteFile journalctl returned error: %v", err)
	}

	launcher := systemdRunLauncher{
		systemdRun: systemdRun,
		systemctl:  systemctl,
		journalctl: journalctl,
	}
	status, err := launcher.StartTransientUnit(context.Background(), transientUnit{
		Name:             "vita-capsule-local-microvm.service",
		Argv:             []string{defaultNspawnPath, "--directory=/rootfs", "--", "/init"},
		MicroVMReadiness: &microVMReadinessProbe{ID: "local.microvm.capsule"},
	})
	if err != nil {
		t.Fatalf("StartTransientUnit returned error: %v", err)
	}
	if status.DynamicUID != "61408" {
		t.Fatalf("DynamicUID = %q, want 61408", status.DynamicUID)
	}
	if status.MicroVM == nil || status.MicroVM.Isolation != "nspawn" || status.MicroVM.PID1 != "own" {
		t.Fatalf("MicroVM = %#v, want measured nspawn/own readiness", status.MicroVM)
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
