package capsule

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/vita/agent/capabilities"
	storagecapsules "github.com/vita/agent/storage/capsules"
)

func TestExecuteComposesHardenedTransientUnitFromValidatedManifest(t *testing.T) {
	ctx := context.Background()
	entry := executeEntry()
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	launcher := &recordingTransientLauncher{
		status: transientUnitStatus{DynamicUID: "61408"},
	}
	capability := newExecuteCapability(
		fs,
		memoryExecutionManifestStore{
			entry.ID: executeManifest(entry),
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
		defaultDenoPath,
		"run",
		"--no-remote",
		"--cached-only",
		"--no-config",
		"--quiet",
		"/usr/lib/vita/capsules/local.test.capsule/main.ts",
	}
	if !reflect.DeepEqual(started.Argv, wantArgv) {
		t.Fatalf("argv = %v, want %v", started.Argv, wantArgv)
	}

	props := propertyValues(started.Properties)
	assertProperty(t, props, "DynamicUser", "yes")
	assertProperty(t, props, "CapabilityBoundingSet", "")
	assertProperty(t, props, "AmbientCapabilities", "")
	assertProperty(t, props, "NoNewPrivileges", "yes")
	assertProperty(t, props, "ProtectSystem", "strict")
	assertProperty(t, props, "RestrictAddressFamilies", "AF_UNIX")
	assertProperty(t, props, "UMask", "0077")
	assertProperty(t, props, "MemoryMax", "67108864")
	assertProperty(t, props, "CPUQuota", "25%")
	assertProperty(t, props, "TasksMax", "32")
	assertContainsProperty(t, props, "SystemCallFilter", "@system-service")
	assertContainsProperty(t, props, "SystemCallFilter", "pkey_alloc pkey_free pkey_mprotect")

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
	if readResponse.Last.ID != entry.ID || readResponse.Last.Unit != started.Name || readResponse.Last.DynamicUID != "61408" {
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
	response, err = capability.Handle(ctx, ExecuteReadRequest{})
	if err != nil {
		t.Fatalf("Handle after undo returned error: %v", err)
	}
	readResponse = response.(ExecuteReadResponse)
	if readResponse.Last != nil {
		t.Fatalf("Last after undo = %#v, want nil", readResponse.Last)
	}
}

func TestExecuteComposesPersistentVolumeBindAndSupplementaryGroup(t *testing.T) {
	ctx := context.Background()
	entry := executeEntry()
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	launcher := &recordingTransientLauncher{
		status: transientUnitStatus{DynamicUID: "61408"},
	}
	manifest := executeManifest(entry)
	manifest.Data = executionDataWithStateVolume()
	volumeMount := storagecapsules.Mount{
		VolumeName:  "state",
		Source:      "/var/lib/vita/runtime/volumes/local.test.capsule/state",
		Destination: storagecapsules.VolumeMountPath("state"),
		BindPath: "/var/lib/vita/runtime/volumes/local.test.capsule/state:" +
			storagecapsules.VolumeMountPath("state"),
		Group:   "vita-cap-test",
		GroupID: 4242,
	}
	volumes := &recordingVolumeProvisioner{
		mounts: []storagecapsules.Mount{volumeMount},
	}
	capability := newExecuteCapability(
		fs,
		memoryExecutionManifestStore{entry.ID: manifest},
		launcher,
	)
	capability.volumes = volumes

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

	wantSpecs := []storagecapsules.VolumeSpec{manifest.Data.Volumes[0].VolumeSpec()}
	if !reflect.DeepEqual(volumes.setupSpecs, wantSpecs) {
		t.Fatalf("setup volume specs = %#v, want %#v", volumes.setupSpecs, wantSpecs)
	}
	if volumes.setupCapsuleID != entry.ID {
		t.Fatalf("setup capsule id = %q, want %q", volumes.setupCapsuleID, entry.ID)
	}

	started := launcher.starts[0]
	props := propertyValues(started.Properties)
	assertProperty(t, props, "DynamicUser", "yes")
	assertProperty(t, props, "SupplementaryGroups", "vita-cap-test")
	assertProperty(t, props, "BindPaths", volumeMount.BindPath)
	assertProperty(t, props, "UMask", "0007")
	if _, ok := props["BindReadOnlyPaths"]; ok {
		t.Fatalf("BindReadOnlyPaths = %v, want none for read-write volume", props["BindReadOnlyPaths"])
	}

	wantArgv := []string{
		defaultDenoPath,
		"run",
		"--no-remote",
		"--cached-only",
		"--no-config",
		"--quiet",
		"--allow-read=" + volumeMount.Destination,
		"--allow-write=" + volumeMount.Destination,
		"/usr/lib/vita/capsules/local.test.capsule/main.ts",
	}
	if !reflect.DeepEqual(started.Argv, wantArgv) {
		t.Fatalf("argv = %v, want %v", started.Argv, wantArgv)
	}

	response, err := capability.Handle(ctx, ExecuteReadRequest{})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	readResponse := response.(ExecuteReadResponse)
	wantVolumeStatus := []VolumeStatus{{
		Name:    "state",
		Path:    volumeMount.Destination,
		Mounted: "OK",
		Status:  "OK",
	}}
	if !reflect.DeepEqual(readResponse.Last.Volumes, wantVolumeStatus) {
		t.Fatalf("Last.Volumes = %#v, want %#v", readResponse.Last.Volumes, wantVolumeStatus)
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if !reflect.DeepEqual(volumes.teardownMounts, []storagecapsules.Mount{volumeMount}) {
		t.Fatalf("teardown mounts = %#v, want %#v", volumes.teardownMounts, []storagecapsules.Mount{volumeMount})
	}
}

func TestExecuteRejectsUnknownCapsuleWithoutStartingUnit(t *testing.T) {
	ctx := context.Background()
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{})))
	launcher := &recordingTransientLauncher{}
	capability := newExecuteCapability(fs, memoryExecutionManifestStore{}, launcher)

	undo, err := capability.Apply(ctx, ExecuteApplyRequest{Desired: &ExecuteDesired{
		ID:        "local.test.capsule",
		Version:   "1.0.0",
		Integrity: validSHA256SRI,
	}})

	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil", undo)
	}
	var invalid *ExecuteInvalidRequestError
	if !errors.As(err, &invalid) {
		t.Fatalf("Apply error = %T %v, want ExecuteInvalidRequestError", err, err)
	}
	if len(launcher.starts) != 0 {
		t.Fatalf("StartTransientUnit calls = %d, want 0", len(launcher.starts))
	}
}

func TestExecuteRejectsInvalidManifestWithoutStartingUnit(t *testing.T) {
	ctx := context.Background()
	entry := executeEntry()
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	manifest := executeManifest(entry)
	manifest.PackageClass = "oci-service"
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
	if len(launcher.starts) != 0 {
		t.Fatalf("StartTransientUnit calls = %d, want 0", len(launcher.starts))
	}
}

func TestExecuteApplyRejectsWrongRequestTypeWithoutStartingUnit(t *testing.T) {
	ctx := context.Background()
	launcher := &recordingTransientLauncher{}
	capability := newExecuteCapability(newMemoryFileSystem(nil), memoryExecutionManifestStore{}, launcher)

	undo, err := capability.Apply(ctx, pathSmugglingRequest{Path: "/tmp/unit.service", Desired: validRegistry()})

	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil", undo)
	}
	var invalid *ExecuteInvalidRequestError
	if !errors.As(err, &invalid) {
		t.Fatalf("Apply error = %T %v, want ExecuteInvalidRequestError", err, err)
	}
	if len(launcher.starts) != 0 {
		t.Fatalf("StartTransientUnit calls = %d, want 0", len(launcher.starts))
	}
}

type memoryExecutionManifestStore map[string]ExecutionManifest

func (s memoryExecutionManifestStore) Load(ctx context.Context, id string) (ExecutionManifest, error) {
	if err := ctx.Err(); err != nil {
		return ExecutionManifest{}, err
	}
	manifest, ok := s[id]
	if !ok {
		return ExecutionManifest{}, &ExecuteInvalidRequestError{Reason: "capsule manifest is absent"}
	}
	return manifest, nil
}

type recordingTransientLauncher struct {
	starts []transientUnit
	stops  []string
	resets []string
	status transientUnitStatus
	err    error
}

func (l *recordingTransientLauncher) StartTransientUnit(ctx context.Context, unit transientUnit) (transientUnitStatus, error) {
	if err := ctx.Err(); err != nil {
		return transientUnitStatus{}, err
	}
	if l.err != nil {
		return transientUnitStatus{}, l.err
	}
	l.starts = append(l.starts, cloneTransientUnit(unit))
	return l.status, nil
}

func (l *recordingTransientLauncher) StopTransientUnit(ctx context.Context, unit string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	l.stops = append(l.stops, unit)
	return nil
}

func (l *recordingTransientLauncher) ResetFailedUnit(ctx context.Context, unit string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	l.resets = append(l.resets, unit)
	return nil
}

type recordingVolumeProvisioner struct {
	setupCapsuleID string
	setupSpecs     []storagecapsules.VolumeSpec
	mounts         []storagecapsules.Mount
	teardownMounts []storagecapsules.Mount
	err            error
	teardownErr    error
}

func (p *recordingVolumeProvisioner) SetupVolumes(ctx context.Context, capsuleID string, specs []storagecapsules.VolumeSpec) ([]storagecapsules.Mount, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if p.err != nil {
		return nil, p.err
	}
	p.setupCapsuleID = capsuleID
	p.setupSpecs = append([]storagecapsules.VolumeSpec(nil), specs...)
	return cloneVolumeMounts(p.mounts), nil
}

func (p *recordingVolumeProvisioner) TeardownVolumes(ctx context.Context, mounts []storagecapsules.Mount) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if p.teardownErr != nil {
		return p.teardownErr
	}
	p.teardownMounts = cloneVolumeMounts(mounts)
	return nil
}

func executeEntry() CapsuleEntry {
	return CapsuleEntry{
		ID:        "local.test.capsule",
		Version:   "1.0.0",
		Integrity: validSHA256SRI,
		State:     StateInstalled,
	}
}

func executeManifest(entry CapsuleEntry) ExecutionManifest {
	return ExecutionManifest{
		ID:           entry.ID,
		Version:      entry.Version,
		Integrity:    entry.Integrity,
		PackageClass: executePackageClassTSService,
		Runtime: ExecutionRuntime{
			TypeScript: TypeScriptExecution{Entrypoint: "main.ts"},
		},
		ResourceLimits: ExecutionResourceLimits{
			CPUCores:   0.25,
			RamMiB:     64,
			StorageMiB: 16,
			TasksMax:   32,
		},
		baseDir: "/usr/lib/vita/capsules/local.test.capsule",
	}
}

func executionDataWithStateVolume() *ExecutionData {
	return &ExecutionData{
		Classes: []string{"app-state"},
		Volumes: []ExecutionDataVolume{{
			Name:        "state",
			MountPath:   storagecapsules.VolumeMountPath("state"),
			Class:       "app-state",
			Access:      "read-write",
			Persistence: "persistent",
			Backup:      boolPtr(true),
			SizeMiB:     16,
		}},
	}
}

func executeApply(entry CapsuleEntry) ExecuteApplyRequest {
	desired := ExecuteDesired{
		ID:        entry.ID,
		Version:   entry.Version,
		Integrity: entry.Integrity,
	}
	return ExecuteApplyRequest{Desired: &desired}
}

func cloneTransientUnit(unit transientUnit) transientUnit {
	argv := append([]string(nil), unit.Argv...)
	properties := append([]systemdProperty(nil), unit.Properties...)
	return transientUnit{
		Name:       unit.Name,
		Argv:       argv,
		Properties: properties,
	}
}

func propertyValues(properties []systemdProperty) map[string][]string {
	out := make(map[string][]string)
	for _, property := range properties {
		out[property.Name] = append(out[property.Name], property.Value)
	}
	return out
}

func assertProperty(t *testing.T, props map[string][]string, name string, want string) {
	t.Helper()
	values := props[name]
	if len(values) != 1 || values[0] != want {
		t.Fatalf("%s = %v, want [%q]", name, values, want)
	}
}

func assertContainsProperty(t *testing.T, props map[string][]string, name string, want string) {
	t.Helper()
	for _, value := range props[name] {
		if value == want {
			return
		}
	}
	t.Fatalf("%s = %v, want value %q", name, props[name], want)
}

var _ capabilities.TypedRequest = ExecuteApplyRequest{}

func boolPtr(value bool) *bool {
	return &value
}
