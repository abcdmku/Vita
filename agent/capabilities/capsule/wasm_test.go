package capsule

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestExecuteComposesHardenedWasmTransientUnitFromValidatedManifest(t *testing.T) {
	ctx := context.Background()
	entry := executeWasmEntry()
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	launcher := &recordingTransientLauncher{
		status: transientUnitStatus{DynamicUID: "61411"},
	}
	capability := newExecuteCapability(
		fs,
		memoryExecutionManifestStore{
			entry.ID: executeWasmManifest(entry),
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
		defaultWasmtimePath,
		"run",
		"/usr/lib/vita/capsules/local.wasm.capsule/component.wasm",
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
	assertProperty(t, props, "ProtectHome", "yes")
	assertProperty(t, props, "PrivateTmp", "yes")
	assertProperty(t, props, "PrivateDevices", "yes")
	assertProperty(t, props, "RestrictNamespaces", "yes")
	assertProperty(t, props, "RestrictAddressFamilies", "AF_UNIX")
	assertProperty(t, props, "MemoryMax", "67108864")
	assertProperty(t, props, "CPUQuota", "25%")
	assertProperty(t, props, "TasksMax", "32")
	assertNoProperty(t, props, "RootDirectory")
	assertNoProperty(t, props, "MountAPIVFS")
	assertNoProperty(t, props, "Environment")
	assertNoProperty(t, props, "RuntimeDirectory")
	assertNoProperty(t, props, "StateDirectory")
	assertNoProperty(t, props, "StateDirectoryMode")
	assertContainsProperty(t, props, "SystemCallFilter", "@system-service")
	assertContainsProperty(t, props, "SystemCallFilter", "~@privileged @resources @mount @swap @reboot @raw-io @cpu-emulation @obsolete")
	assertDoesNotContainProperty(t, props, "SystemCallFilter", "pkey_alloc pkey_free pkey_mprotect")

	response, err := capability.Handle(ctx, ExecuteReadRequest{})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	readResponse := response.(ExecuteReadResponse)
	if readResponse.Last == nil {
		t.Fatal("ExecuteReadResponse.Last = nil, want execution status")
	}
	if readResponse.Last.ID != entry.ID || readResponse.Last.Unit != started.Name || readResponse.Last.DynamicUID != "61411" {
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

func TestExecutionManifestDecodesAndValidatesWasmRuntime(t *testing.T) {
	if _, ok := executionRuntimeFields["wasm"]; !ok {
		t.Fatal("executionRuntimeFields is missing wasm")
	}

	raw := []byte(`{
		"id":"local.wasm.capsule",
		"version":"1.0.0",
		"integrity":"` + validSHA256SRI + `",
		"packageClass":"wasm-service",
		"runtime":{"wasm":{"module":"component.wasm"}},
		"resourceLimits":{"cpuCores":0.25,"ramMiB":64,"storageMiB":16,"tasksMax":32}
	}`)
	var manifest ExecutionManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatalf("Unmarshal valid WASM manifest returned error: %v", err)
	}
	if manifest.Runtime.Wasm.Module != "component.wasm" {
		t.Fatalf("WASM module = %q, want component.wasm", manifest.Runtime.Wasm.Module)
	}

	ambiguous := bytes.Replace(raw, []byte(`"runtime":{"wasm":`), []byte(`"runtime":{"typescript":{"entrypoint":"main.ts"},"wasm":`), 1)
	if err := json.Unmarshal(ambiguous, &manifest); err == nil {
		t.Fatal("Unmarshal accepted ambiguous WASM/typescript runtime")
	}

	badModule := bytes.Replace(raw, []byte(`"component.wasm"`), []byte(`"main.wasm"`), 1)
	if err := json.Unmarshal(badModule, &manifest); err == nil {
		t.Fatal("Unmarshal accepted a non-fixed WASM module name")
	}

	wrongClass := bytes.Replace(raw, []byte(`"packageClass":"wasm-service"`), []byte(`"packageClass":"ts-service"`), 1)
	if err := json.Unmarshal(wrongClass, &manifest); err == nil {
		t.Fatal("Unmarshal accepted wasm runtime for ts-service")
	}
}

func TestExecutionRuntimeRequiresExactlyOneOfThreeArms(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		ok   bool
	}{
		{name: "typescript only", raw: `{"typescript":{"entrypoint":"main.ts"}}`, ok: true},
		{name: "oci only", raw: `{"oci":{"image":{"digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","entrypoint":["/init"]}}}`, ok: true},
		{name: "wasm only", raw: `{"wasm":{"module":"component.wasm"}}`, ok: true},
		{name: "none", raw: `{}`, ok: false},
		{name: "typescript and oci", raw: `{"typescript":{"entrypoint":"main.ts"},"oci":{"image":{"digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","entrypoint":["/init"]}}}`, ok: false},
		{name: "typescript and wasm", raw: `{"typescript":{"entrypoint":"main.ts"},"wasm":{"module":"component.wasm"}}`, ok: false},
		{name: "oci and wasm", raw: `{"oci":{"image":{"digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","entrypoint":["/init"]}},"wasm":{"module":"component.wasm"}}`, ok: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var runtime ExecutionRuntime
			err := json.Unmarshal([]byte(tt.raw), &runtime)
			if tt.ok && err != nil {
				t.Fatalf("Unmarshal returned error: %v", err)
			}
			if !tt.ok && err == nil {
				t.Fatal("Unmarshal returned nil, want rejection")
			}
		})
	}
}

func TestExecuteRejectsWasmMissingModuleWithoutStartingUnit(t *testing.T) {
	ctx := context.Background()
	entry := executeWasmEntry()
	root := t.TempDir()
	baseDir := filepath.Join(root, entry.ID)
	if err := os.MkdirAll(baseDir, 0o755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}
	if err := os.WriteFile(filepath.Join(baseDir, "manifest.json"), []byte(wasmManifestJSON(entry)), 0o644); err != nil {
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
	if invalid.ApplyErrorCode() != "module_absent" {
		t.Fatalf("ApplyErrorCode = %q, want module_absent", invalid.ApplyErrorCode())
	}
	if len(launcher.starts) != 0 {
		t.Fatalf("StartTransientUnit calls = %d, want 0", len(launcher.starts))
	}
}

func TestExecuteRejectsWasmBadIntegrityWithoutStartingUnit(t *testing.T) {
	ctx := context.Background()
	entry := executeWasmEntry()
	manifest := executeWasmManifest(entry)
	manifest.Integrity = otherValidSHA256SRI()
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
	if len(launcher.starts) != 0 {
		t.Fatalf("StartTransientUnit calls = %d, want 0", len(launcher.starts))
	}
}

func executeWasmEntry() CapsuleEntry {
	return CapsuleEntry{
		ID:        "local.wasm.capsule",
		Version:   "1.0.0",
		Integrity: validSHA256SRI,
		State:     StateInstalled,
	}
}

func executeWasmManifest(entry CapsuleEntry) ExecutionManifest {
	return ExecutionManifest{
		ID:           entry.ID,
		Version:      entry.Version,
		Integrity:    entry.Integrity,
		PackageClass: executePackageClassWasmService,
		Runtime: ExecutionRuntime{
			Wasm: WasmExecution{Module: "component.wasm"},
		},
		ResourceLimits: ExecutionResourceLimits{
			CPUCores:   0.25,
			RamMiB:     64,
			StorageMiB: 16,
			TasksMax:   32,
		},
		baseDir: "/usr/lib/vita/capsules/local.wasm.capsule",
	}
}

func wasmManifestJSON(entry CapsuleEntry) string {
	return `{
		"id":"` + entry.ID + `",
		"version":"` + entry.Version + `",
		"integrity":"` + entry.Integrity + `",
		"packageClass":"wasm-service",
		"runtime":{"wasm":{"module":"component.wasm"}},
		"resourceLimits":{"cpuCores":0.25,"ramMiB":64,"storageMiB":16,"tasksMax":32}
	}`
}

func otherValidSHA256SRI() string {
	return "sha256-" + base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32))
}
