package capsule

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vita/agent/capabilities"
	capsuleruntime "github.com/vita/agent/internal/capsule-runtime"
	capsulestorage "github.com/vita/agent/storage/capsules"
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
	assertProperty(t, props, "MemoryMax", "67108864")
	assertProperty(t, props, "CPUQuota", "25%")
	assertProperty(t, props, "TasksMax", "32")
	assertNoProperty(t, props, "StateDirectory")
	assertNoProperty(t, props, "StateDirectoryMode")
	assertNoProperty(t, props, "BindPaths")
	assertNoProperty(t, props, "BindReadOnlyPaths")
	assertNoProperty(t, props, "SupplementaryGroups")
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

func TestExecuteComposesStateDirectoryVolumeAndScopedDenoWrite(t *testing.T) {
	ctx := context.Background()
	entry := executeEntry()
	manifest := executeManifest(entry)
	manifest.Data = ExecutionData{
		Classes: []capsulestorage.DataClass{capsulestorage.DataClassAppState},
		Volumes: []capsulestorage.VolumeSpec{
			executeVolumeSpec(t, entry.ID, "state"),
		},
	}
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	launcher := &recordingTransientLauncher{
		status: transientUnitStatus{DynamicUID: "61408"},
	}
	capability := newExecuteCapability(
		fs,
		memoryExecutionManifestStore{
			entry.ID: manifest,
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
	volumePath := "/var/lib/vita/runtime/volumes/local.test.capsule/state"
	wantArgv := []string{
		defaultDenoPath,
		"run",
		"--no-remote",
		"--cached-only",
		"--no-config",
		"--quiet",
		"--allow-read=" + volumePath,
		"--allow-write=" + volumePath,
		"/usr/lib/vita/capsules/local.test.capsule/main.ts",
	}
	if !reflect.DeepEqual(started.Argv, wantArgv) {
		t.Fatalf("argv = %v, want %v", started.Argv, wantArgv)
	}

	props := propertyValues(started.Properties)
	assertProperty(t, props, "DynamicUser", "yes")
	assertProperty(t, props, "StateDirectory", "vita/runtime/volumes/local.test.capsule/state")
	assertProperty(t, props, "StateDirectoryMode", "0700")
	assertNoProperty(t, props, "BindPaths")
	assertNoProperty(t, props, "BindReadOnlyPaths")
	assertNoProperty(t, props, "SupplementaryGroups")
	if len(started.Volumes) != 1 {
		t.Fatalf("Volumes length = %d, want 1", len(started.Volumes))
	}
	if started.Volumes[0].Path != volumePath || started.Volumes[0].StateDirectory != "vita/runtime/volumes/local.test.capsule/state" {
		t.Fatalf("Volumes[0] = %#v, want state directory volume", started.Volumes[0])
	}

	response, err := capability.Handle(ctx, ExecuteReadRequest{})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	readResponse := response.(ExecuteReadResponse)
	if readResponse.Last == nil {
		t.Fatal("ExecuteReadResponse.Last = nil, want execution status")
	}
	wantVolumes := []ExecuteVolumeStatus{
		{
			Name:           "state",
			Path:           volumePath,
			StateDirectory: "vita/runtime/volumes/local.test.capsule/state",
			Access:         "read-write",
			Mounted:        "OK",
			Status:         "OK",
		},
	}
	if !reflect.DeepEqual(readResponse.Last.Volumes, wantVolumes) {
		t.Fatalf("Last.Volumes = %#v, want %#v", readResponse.Last.Volumes, wantVolumes)
	}
}

func TestExecuteWiresHealthSupervisorAndMergesWorkloadStatus(t *testing.T) {
	ctx := context.Background()
	entry := executeEntry()
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	launcher := &recordingTransientLauncher{
		status: transientUnitStatus{DynamicUID: "61408"},
	}
	manifest := executeManifest(entry)
	manifest.HealthChecks = []capsuleruntime.Check{
		{
			Name:            "lifecycle",
			Type:            capsuleruntime.CheckTypeLifecycle,
			Target:          "self",
			IntervalSeconds: 60,
			TimeoutSeconds:  1,
		},
	}
	prober := &recordingHealthProber{
		status:   capsuleruntime.StatusDown,
		restarts: 3,
	}
	supervisor := capsuleruntime.NewSupervisor(capsuleruntime.Options{
		Prober: prober,
		Jitter: func(capsuleruntime.WorkloadSpec, capsuleruntime.Check) time.Duration {
			return 0
		},
	})
	capability := newExecuteCapabilityWithSupervisor(
		fs,
		memoryExecutionManifestStore{entry.ID: manifest},
		launcher,
		supervisor,
	)
	t.Cleanup(func() {
		supervisor.StopWorkload(capsuleUnitName(entry.ID))
	})

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
	unit := launcher.starts[0].Name

	polled := prober.polledChecks()
	if len(polled) == 0 {
		t.Fatal("health supervisor did not poll the capsule workload")
	}
	if polled[0].Target != unit {
		t.Fatalf("health check target = %q, want rewritten unit %q", polled[0].Target, unit)
	}

	workloads := capability.Workloads()
	wantWorkloads := []capsuleruntime.WorkloadStatus{
		{
			ID:       entry.ID,
			Unit:     unit,
			Status:   capsuleruntime.StatusDown,
			Health:   capsuleruntime.StatusDown,
			Restarts: 3,
		},
	}
	if !reflect.DeepEqual(workloads, wantWorkloads) {
		t.Fatalf("Workloads = %#v, want %#v", workloads, wantWorkloads)
	}

	response, err := capability.Handle(ctx, ExecuteReadRequest{})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	readResponse := response.(ExecuteReadResponse)
	if readResponse.Last == nil {
		t.Fatal("Handle Last = nil, want execution status")
	}
	if readResponse.Last.Health != string(capsuleruntime.StatusDown) || readResponse.Last.Status != string(capsuleruntime.StatusDown) {
		t.Fatalf("Handle Last health/status = %q/%q, want down/down", readResponse.Last.Health, readResponse.Last.Status)
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if got := capability.Workloads(); len(got) != 0 {
		t.Fatalf("Workloads after Undo = %#v, want empty", got)
	}
}

func TestExecutionManifestDecodesAndValidatesHealthChecks(t *testing.T) {
	if _, ok := executionManifestFields["healthChecks"]; !ok {
		t.Fatal("executionManifestFields is missing healthChecks")
	}

	raw := []byte(`{
		"id":"local.test.capsule",
		"version":"1.0.0",
		"integrity":"` + validSHA256SRI + `",
		"packageClass":"ts-service",
		"runtime":{"typescript":{"entrypoint":"main.ts"}},
		"resourceLimits":{"cpuCores":0.25,"ramMiB":64,"storageMiB":16,"tasksMax":32},
		"healthChecks":[
			{"name":"ready","type":"http","target":"http://127.0.0.1:8787/health","intervalSeconds":5,"timeoutSeconds":1}
		]
	}`)
	var manifest ExecutionManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatalf("Unmarshal valid manifest returned error: %v", err)
	}
	if len(manifest.HealthChecks) != 1 {
		t.Fatalf("HealthChecks length = %d, want 1", len(manifest.HealthChecks))
	}
	if manifest.HealthChecks[0].Name != "ready" || manifest.HealthChecks[0].Type != capsuleruntime.CheckTypeHTTP {
		t.Fatalf("decoded health check = %#v, want ready http", manifest.HealthChecks[0])
	}

	invalid := strings.Replace(string(raw), `"intervalSeconds":5`, `"intervalSeconds":0`, 1)
	if err := json.Unmarshal([]byte(invalid), &manifest); err == nil {
		t.Fatal("Unmarshal accepted an invalid health check")
	}
}

func TestExecutionManifestDecodesAndValidatesDataVolumes(t *testing.T) {
	if _, ok := executionManifestFields["data"]; !ok {
		t.Fatal("executionManifestFields is missing data")
	}

	raw := []byte(`{
		"id":"local.test.capsule",
		"version":"1.0.0",
		"integrity":"` + validSHA256SRI + `",
		"packageClass":"ts-service",
		"runtime":{"typescript":{"entrypoint":"main.ts"}},
		"resourceLimits":{"cpuCores":0.25,"ramMiB":64,"storageMiB":16,"tasksMax":32},
		"data":{
			"classes":["app-state"],
			"volumes":[
				{"name":"state","mountPath":"/var/lib/vita/runtime/volumes/local.test.capsule/state","class":"app-state","access":"read-write","persistence":"persistent","backup":false,"sizeMiB":8}
			]
		}
	}`)
	var manifest ExecutionManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatalf("Unmarshal valid manifest returned error: %v", err)
	}
	if len(manifest.Data.Volumes) != 1 {
		t.Fatalf("Data.Volumes length = %d, want 1", len(manifest.Data.Volumes))
	}
	if manifest.Data.Volumes[0].Name != "state" || manifest.Data.Volumes[0].Access != capsulestorage.VolumeAccessReadWrite {
		t.Fatalf("decoded volume = %#v, want state read-write", manifest.Data.Volumes[0])
	}

	invalid := strings.Replace(string(raw), `"persistence":"persistent"`, `"persistence":"ephemeral"`, 1)
	if err := json.Unmarshal([]byte(invalid), &manifest); err == nil {
		t.Fatal("Unmarshal accepted an unsupported ephemeral volume")
	}
}

func TestHealthChecksForUnitRewritesAliasesAndRejectsOtherLifecycleUnits(t *testing.T) {
	unit := capsuleUnitName("local.test.capsule")
	checks := []capsuleruntime.Check{
		{
			Name:            "self",
			Type:            capsuleruntime.CheckTypeLifecycle,
			Target:          "self",
			IntervalSeconds: 5,
			TimeoutSeconds:  1,
		},
		{
			Name:            "unit",
			Type:            capsuleruntime.CheckTypeLifecycle,
			Target:          "unit",
			IntervalSeconds: 5,
			TimeoutSeconds:  1,
		},
		{
			Name:            "explicit-own",
			Type:            capsuleruntime.CheckTypeLifecycle,
			Target:          unit,
			IntervalSeconds: 5,
			TimeoutSeconds:  1,
		},
		{
			Name:            "http",
			Type:            capsuleruntime.CheckTypeHTTP,
			Target:          "http://127.0.0.1:8787/health",
			IntervalSeconds: 5,
			TimeoutSeconds:  1,
		},
	}

	rewritten, err := healthChecksForUnit(checks, unit)
	if err != nil {
		t.Fatalf("healthChecksForUnit returned error: %v", err)
	}
	for i := 0; i < 3; i++ {
		if rewritten[i].Target != unit {
			t.Fatalf("rewritten[%d].Target = %q, want %q", i, rewritten[i].Target, unit)
		}
	}
	if rewritten[3].Target != checks[3].Target {
		t.Fatalf("http target = %q, want unchanged %q", rewritten[3].Target, checks[3].Target)
	}

	bad := []capsuleruntime.Check{
		{
			Name:            "host",
			Type:            capsuleruntime.CheckTypeLifecycle,
			Target:          "ssh.service",
			IntervalSeconds: 5,
			TimeoutSeconds:  1,
		},
	}
	if _, err := healthChecksForUnit(bad, unit); err == nil {
		t.Fatal("healthChecksForUnit accepted a lifecycle target outside the capsule unit")
	}
}

func TestExecuteRejectsLifecycleHealthCheckOutsideOwnUnitBeforeStarting(t *testing.T) {
	ctx := context.Background()
	entry := executeEntry()
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	manifest := executeManifest(entry)
	manifest.HealthChecks = []capsuleruntime.Check{
		{
			Name:            "host",
			Type:            capsuleruntime.CheckTypeLifecycle,
			Target:          "ssh.service",
			IntervalSeconds: 5,
			TimeoutSeconds:  1,
		},
	}
	launcher := &recordingTransientLauncher{}
	capability := newExecuteCapabilityWithSupervisor(
		fs,
		memoryExecutionManifestStore{entry.ID: manifest},
		launcher,
		capsuleruntime.NewSupervisor(capsuleruntime.Options{}),
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

func TestExecuteRejectsInvalidVolumeManifestWithoutStartingUnit(t *testing.T) {
	ctx := context.Background()
	entry := executeEntry()
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	manifest := executeManifest(entry)
	volume := executeVolumeSpec(t, entry.ID, "state")
	volume.MountPath = "/var/lib/vita/runtime/volumes/local.test.capsule/other"
	manifest.Data = ExecutionData{
		Classes: []capsulestorage.DataClass{capsulestorage.DataClassAppState},
		Volumes: []capsulestorage.VolumeSpec{volume},
	}
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

func TestExecuteVolumeStartFailureReturnsSpecificCode(t *testing.T) {
	ctx := context.Background()
	entry := executeEntry()
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	manifest := executeManifest(entry)
	manifest.Data = ExecutionData{
		Classes: []capsulestorage.DataClass{capsulestorage.DataClassAppState},
		Volumes: []capsulestorage.VolumeSpec{
			executeVolumeSpec(t, entry.ID, "state"),
		},
	}
	launcher := &recordingTransientLauncher{
		err: errors.New("unit exited"),
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
	var startErr *ExecuteStartError
	if !errors.As(err, &startErr) {
		t.Fatalf("Apply error = %T %v, want ExecuteStartError", err, err)
	}
	if startErr.ApplyErrorCode() != "capsule_volume_start_failed" {
		t.Fatalf("ApplyErrorCode = %q, want capsule_volume_start_failed", startErr.ApplyErrorCode())
	}
	if len(launcher.starts) != 1 {
		t.Fatalf("StartTransientUnit calls = %d, want 1", len(launcher.starts))
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
	l.starts = append(l.starts, cloneTransientUnit(unit))
	if l.err != nil {
		return transientUnitStatus{}, l.err
	}
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
	volumes := append([]capsulestorage.VolumeMount(nil), unit.Volumes...)
	return transientUnit{
		Name:       unit.Name,
		Argv:       argv,
		Properties: properties,
		Volumes:    volumes,
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

func assertNoProperty(t *testing.T, props map[string][]string, name string) {
	t.Helper()
	if values := props[name]; len(values) != 0 {
		t.Fatalf("%s = %v, want absent", name, values)
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

func executeVolumeSpec(t *testing.T, capsuleID string, name string) capsulestorage.VolumeSpec {
	t.Helper()
	mountPath, err := capsulestorage.VolumePath(capsuleID, name)
	if err != nil {
		t.Fatalf("VolumePath returned error: %v", err)
	}
	return capsulestorage.VolumeSpec{
		Name:        name,
		MountPath:   mountPath,
		Class:       capsulestorage.DataClassAppState,
		Access:      capsulestorage.VolumeAccessReadWrite,
		Persistence: capsulestorage.VolumePersistencePersistent,
		Backup:      false,
		SizeMiB:     8,
	}
}

type recordingHealthProber struct {
	mu       sync.Mutex
	status   capsuleruntime.Status
	restarts int
	checks   []capsuleruntime.Check
}

func (p *recordingHealthProber) PollHealth(_ context.Context, check capsuleruntime.Check) (capsuleruntime.Status, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	p.checks = append(p.checks, check)
	return p.status, nil
}

func (p *recordingHealthProber) Restarts(context.Context, string) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	return p.restarts, nil
}

func (p *recordingHealthProber) polledChecks() []capsuleruntime.Check {
	p.mu.Lock()
	defer p.mu.Unlock()

	out := make([]capsuleruntime.Check, len(p.checks))
	copy(out, p.checks)
	return out
}

var _ capabilities.TypedRequest = ExecuteApplyRequest{}
