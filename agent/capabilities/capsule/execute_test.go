package capsule

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/capabilities/network"
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

func TestExecuteComposesHardenedOCITransientUnitFromValidatedManifest(t *testing.T) {
	ctx := context.Background()
	entry := executeOCIEntry()
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	launcher := &recordingTransientLauncher{
		status: transientUnitStatus{DynamicUID: "61409"},
	}
	capability := newExecuteCapability(
		fs,
		memoryExecutionManifestStore{
			entry.ID: executeOCIManifest(entry),
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
	wantArgv := []string{"/init", "--ready=ok"}
	if !reflect.DeepEqual(started.Argv, wantArgv) {
		t.Fatalf("argv = %v, want %v", started.Argv, wantArgv)
	}

	props := propertyValues(started.Properties)
	assertProperty(t, props, "RootDirectory", "/usr/lib/vita/capsules/local.oci.capsule/rootfs")
	assertProperty(t, props, "MountAPIVFS", "yes")
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
	readResponse, ok := response.(ExecuteReadResponse)
	if !ok {
		t.Fatalf("Handle returned %T, want ExecuteReadResponse", response)
	}
	if readResponse.Last == nil {
		t.Fatal("ExecuteReadResponse.Last = nil, want execution status")
	}
	if readResponse.Last.ID != entry.ID || readResponse.Last.Unit != started.Name || readResponse.Last.DynamicUID != "61409" {
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

func TestExecutionManifestDecodesAndValidatesNetwork(t *testing.T) {
	if _, ok := executionManifestFields["network"]; !ok {
		t.Fatal("executionManifestFields is missing network")
	}

	raw := []byte(networkManifestJSON(executeEntry()))
	var manifest ExecutionManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatalf("Unmarshal valid network manifest returned error: %v", err)
	}
	if manifest.Network == nil {
		t.Fatal("Network = nil, want parsed network grants")
	}
	if len(manifest.Network.Ingress) != 1 {
		t.Fatalf("Network.Ingress length = %d, want 1", len(manifest.Network.Ingress))
	}
	if len(manifest.Network.Egress) != 1 {
		t.Fatalf("Network.Egress length = %d, want 1", len(manifest.Network.Egress))
	}
	ingress := manifest.Network.Ingress[0]
	if ingress.Protocol != network.ProtoTCP || ingress.Port != 8787 || ingress.SourceCIDR != "127.0.0.1/32" || ingress.Interface != "lo" {
		t.Fatalf("Network.Ingress[0] = %#v, want canonical loopback tcp grant", ingress)
	}
	egress := manifest.Network.Egress[0]
	if egress.Protocol != network.ProtoTCP || !reflect.DeepEqual(egress.Ports, []int{443}) || egress.Interface != "eth0" {
		t.Fatalf("Network.Egress[0] = %#v, want tcp 443 eth0 grant", egress)
	}
	wantDestinations := []string{"203.0.113.10/32", "2001:db8::/32"}
	if !reflect.DeepEqual(egress.Destinations, wantDestinations) {
		t.Fatalf("Network.Egress[0].Destinations = %#v, want %#v", egress.Destinations, wantDestinations)
	}
}

func TestExecutionManifestRejectsInvalidNetworkGrants(t *testing.T) {
	base := networkManifestJSON(executeEntry())
	tests := []struct {
		name string
		raw  string
	}{
		{
			name: "host-bit smuggled cidr",
			raw:  strings.Replace(base, `"sourceCidr":"127.0.0.1/32"`, `"sourceCidr":"10.0.0.5/24"`, 1),
		},
		{
			name: "wide-open cidr without unsafe flag",
			raw:  strings.Replace(base, `"sourceCidr":"127.0.0.1/32"`, `"sourceCidr":"0.0.0.0/0"`, 1),
		},
		{
			name: "hostname egress destination",
			raw:  strings.Replace(base, `"203.0.113.10"`, `"example.com"`, 1),
		},
		{
			name: "bad port",
			raw:  strings.Replace(base, `"ports":[443]`, `"ports":[0]`, 1),
		},
		{
			name: "bad interface",
			raw:  strings.Replace(base, `"interface":"eth0"`, `"interface":"bad iface"`, 1),
		},
		{
			name: "bad protocol",
			raw:  strings.Replace(base, `"protocol":"tcp"`, `"protocol":"http"`, 1),
		},
		{
			name: "bad direction",
			raw:  strings.Replace(base, `"name":"health"`, `"direction":"egress","name":"health"`, 1),
		},
		{
			name: "control character in name",
			raw:  strings.Replace(base, `"name":"health"`, "\"name\":\"health\\ncheck\"", 1),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var manifest ExecutionManifest
			err := json.Unmarshal([]byte(tt.raw), &manifest)
			if err == nil {
				t.Fatal("Unmarshal accepted invalid network grant")
			}
			var invalid *ExecuteInvalidRequestError
			if !errors.As(err, &invalid) {
				t.Fatalf("Unmarshal error = %T %v, want ExecuteInvalidRequestError", err, err)
			}
		})
	}
}

func TestFileExecutionManifestStoreLoadsNetworkFromDisk(t *testing.T) {
	entry := executeEntry()
	root := t.TempDir()
	baseDir := filepath.Join(root, entry.ID)
	if err := os.MkdirAll(baseDir, 0o755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}
	if err := os.WriteFile(filepath.Join(baseDir, "manifest.json"), []byte(networkManifestJSON(entry)), 0o644); err != nil {
		t.Fatalf("WriteFile manifest returned error: %v", err)
	}
	if err := os.WriteFile(filepath.Join(baseDir, "main.ts"), []byte("console.log('ok');\n"), 0o644); err != nil {
		t.Fatalf("WriteFile entrypoint returned error: %v", err)
	}

	manifest, err := (fileExecutionManifestStore{root: root}).Load(context.Background(), entry.ID)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if manifest.Network == nil || len(manifest.Network.Ingress) != 1 || len(manifest.Network.Egress) != 1 {
		t.Fatalf("Network = %#v, want parsed ingress and egress grants", manifest.Network)
	}
	if filepath.Clean(manifest.baseDir) != filepath.Clean(baseDir) {
		t.Fatalf("baseDir = %q, want %q", manifest.baseDir, baseDir)
	}
}

func TestExecutionManifestAbsentNetworkIsUnchanged(t *testing.T) {
	raw := []byte(`{
		"id":"local.test.capsule",
		"version":"1.0.0",
		"integrity":"` + validSHA256SRI + `",
		"packageClass":"ts-service",
		"runtime":{"typescript":{"entrypoint":"main.ts"}},
		"resourceLimits":{"cpuCores":0.25,"ramMiB":64,"storageMiB":16,"tasksMax":32}
	}`)
	var manifest ExecutionManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatalf("Unmarshal manifest without network returned error: %v", err)
	}
	if manifest.Network != nil {
		t.Fatalf("Network = %#v, want nil for absent network", manifest.Network)
	}
}

func TestExecuteWithNetworkGrantsReportsCountsAndWidensSandbox(t *testing.T) {
	ctx := context.Background()
	entry := executeEntry()
	manifest := executeManifest(entry)
	manifest.Network = validExecutionNetwork()
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	launcher := &recordingTransientLauncher{
		status: transientUnitStatus{DynamicUID: "61408"},
	}
	netns := &recordingNetnsManager{}
	capability := newExecuteCapabilityWithNetns(
		fs,
		memoryExecutionManifestStore{
			entry.ID: manifest,
		},
		launcher,
		netns,
		nil,
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

	props := propertyValues(launcher.starts[0].Properties)
	assertProperty(t, props, "RestrictAddressFamilies", "AF_UNIX AF_INET AF_INET6 AF_NETLINK")
	assertNoProperty(t, props, "PrivateNetwork")
	assertProperty(t, props, "NetworkNamespacePath", launcher.starts[0].NetNS.Path)

	response, err := capability.Handle(ctx, ExecuteReadRequest{})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	readResponse := response.(ExecuteReadResponse)
	if readResponse.Last == nil || readResponse.Last.Network == nil {
		t.Fatalf("Last.Network = %#v, want network count status", readResponse.Last)
	}
	if readResponse.Last.Network.Ingress != 1 || readResponse.Last.Network.Egress != 1 {
		t.Fatalf("Last.Network = %#v, want ingress=1 egress=1", readResponse.Last.Network)
	}
	if readResponse.Last.Network.NetNS != launcher.starts[0].NetNS.Name ||
		readResponse.Last.Network.Isolation != capsuleNetnsIsolationEnforced ||
		readResponse.Last.Network.EgressDrop != capsuleEgressDropEnforced {
		t.Fatalf("Last.Network = %#v, want netns name, enforced isolation, and egress drop", readResponse.Last.Network)
	}
	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if len(netns.tornDown) != 1 || netns.tornDown[0].Name != launcher.starts[0].NetNS.Name {
		t.Fatalf("netns teardowns = %#v, want started netns", netns.tornDown)
	}
}

func TestExecutionManifestDecodesAndValidatesOCIRuntime(t *testing.T) {
	if _, ok := executionRuntimeFields["oci"]; !ok {
		t.Fatal("executionRuntimeFields is missing oci")
	}

	raw := []byte(`{
		"id":"local.oci.capsule",
		"version":"1.0.0",
		"integrity":"` + validSHA256SRI + `",
		"packageClass":"oci-service",
		"runtime":{"oci":{"image":{"digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","entrypoint":["/init","--ready=ok"]}}},
		"resourceLimits":{"cpuCores":0.25,"ramMiB":64,"storageMiB":16,"tasksMax":32}
	}`)
	var manifest ExecutionManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatalf("Unmarshal valid OCI manifest returned error: %v", err)
	}
	if !reflect.DeepEqual(manifest.Runtime.OCI.Image.Entrypoint, []string{"/init", "--ready=ok"}) {
		t.Fatalf("OCI entrypoint = %#v, want /init argv", manifest.Runtime.OCI.Image.Entrypoint)
	}

	ambiguous := strings.Replace(string(raw), `"runtime":{"oci":`, `"runtime":{"typescript":{"entrypoint":"main.ts"},"oci":`, 1)
	if err := json.Unmarshal([]byte(ambiguous), &manifest); err == nil {
		t.Fatal("Unmarshal accepted ambiguous OCI/typescript runtime")
	}

	relative := strings.Replace(string(raw), `"/init"`, `"init"`, 1)
	if err := json.Unmarshal([]byte(relative), &manifest); err == nil {
		t.Fatal("Unmarshal accepted non-absolute OCI entrypoint")
	}

	metachar := strings.Replace(string(raw), `"/init"`, `"/init;reboot"`, 1)
	if err := json.Unmarshal([]byte(metachar), &manifest); err == nil {
		t.Fatal("Unmarshal accepted OCI entrypoint with shell metacharacter")
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

func TestExecuteRejectsOCIMissingRootfsWithoutStartingUnit(t *testing.T) {
	ctx := context.Background()
	entry := executeOCIEntry()
	root := t.TempDir()
	baseDir := filepath.Join(root, entry.ID)
	if err := os.MkdirAll(baseDir, 0o755); err != nil {
		t.Fatalf("MkdirAll returned error: %v", err)
	}
	if err := os.WriteFile(filepath.Join(baseDir, "manifest.json"), []byte(ociManifestJSON(entry)), 0o644); err != nil {
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

func TestExecuteRejectsOCINonWorldExecutableEntrypointWithoutStartingUnit(t *testing.T) {
	ctx := context.Background()
	entry := executeOCIEntry()
	root := t.TempDir()
	baseDir := filepath.Join(root, entry.ID)
	rootfs := filepath.Join(baseDir, "rootfs")
	if err := os.MkdirAll(rootfs, 0o755); err != nil {
		t.Fatalf("MkdirAll rootfs returned error: %v", err)
	}
	if err := os.WriteFile(filepath.Join(baseDir, "manifest.json"), []byte(ociManifestJSON(entry)), 0o644); err != nil {
		t.Fatalf("WriteFile manifest returned error: %v", err)
	}
	if err := os.WriteFile(filepath.Join(rootfs, "init"), []byte("#!/bin/sh\n"), 0o744); err != nil {
		t.Fatalf("WriteFile init returned error: %v", err)
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
	if invalid.ApplyErrorCode() != "permission_denied" {
		t.Fatalf("ApplyErrorCode = %q, want permission_denied", invalid.ApplyErrorCode())
	}
	if len(launcher.starts) != 0 {
		t.Fatalf("StartTransientUnit calls = %d, want 0", len(launcher.starts))
	}
}

func TestExecuteRejectsInvalidOCIEntrypointWithoutStartingUnit(t *testing.T) {
	for _, tc := range []struct {
		name       string
		entrypoint []string
	}{
		{name: "relative", entrypoint: []string{"init"}},
		{name: "metachar", entrypoint: []string{"/init;reboot"}},
		{name: "control", entrypoint: []string{"/init", "bad\narg"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			entry := executeOCIEntry()
			manifest := executeOCIManifest(entry)
			manifest.Runtime.OCI.Image.Entrypoint = tc.entrypoint
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
		})
	}
}

func TestExecuteOCIStartFailureReturnsSpecificDiagnosticCode(t *testing.T) {
	ctx := context.Background()
	entry := executeOCIEntry()
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	launcher := &recordingTransientLauncher{
		err: &transientUnitStartError{
			Code: "exec_failed",
			Diagnostics: transientUnitDiagnostics{
				ActiveState:    "failed",
				SubState:       "failed",
				Result:         "exit-code",
				ExecMainStatus: "203",
			},
			Err: errors.New("unit failed"),
		},
	}
	capability := newExecuteCapability(
		fs,
		memoryExecutionManifestStore{entry.ID: executeOCIManifest(entry)},
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
	if startErr.ApplyErrorCode() != "exec_failed" {
		t.Fatalf("ApplyErrorCode = %q, want exec_failed", startErr.ApplyErrorCode())
	}
	if len(launcher.starts) != 1 {
		t.Fatalf("StartTransientUnit calls = %d, want 1", len(launcher.starts))
	}
}

func TestSystemdRunLauncherStartFailureIncludesUnitDiagnostics(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake systemd scripts require a POSIX shell")
	}

	dir := t.TempDir()
	systemdRun := filepath.Join(dir, "systemd-run")
	systemctl := filepath.Join(dir, "systemctl")
	if err := os.WriteFile(systemdRun, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("WriteFile systemd-run returned error: %v", err)
	}
	if err := os.WriteFile(systemctl, []byte(`#!/bin/sh
case "$1" in
  is-active)
    exit 3
    ;;
  show)
    printf '%s\n' \
      'ActiveState=failed' \
      'SubState=failed' \
      'Result=exit-code' \
      'ExecMainCode=exited' \
      'ExecMainStatus=203'
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

	launcher := systemdRunLauncher{
		systemdRun: systemdRun,
		systemctl:  systemctl,
	}

	_, err := launcher.StartTransientUnit(context.Background(), transientUnit{
		Name: "vita-capsule-local-oci.service",
		Argv: []string{"/init"},
	})

	var startErr *transientUnitStartError
	if !errors.As(err, &startErr) {
		t.Fatalf("StartTransientUnit error = %T %v, want transientUnitStartError", err, err)
	}
	if startErr.Code != "exec_failed" {
		t.Fatalf("start error code = %q, want exec_failed", startErr.Code)
	}
	if startErr.Diagnostics.Result != "exit-code" || startErr.Diagnostics.ExecMainStatus != "203" || startErr.Diagnostics.ActiveState != "failed" {
		t.Fatalf("diagnostics = %#v, want failed/exit-code/203", startErr.Diagnostics)
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
	starts          []transientUnit
	stops           []string
	resets          []string
	confirmedLimits []confirmedOCILimits
	status          transientUnitStatus
	ociLimits       OCILimitsStatus
	ociLimitsErr    error
	err             error
}

type confirmedOCILimits struct {
	unit   string
	limits ExecutionResourceLimits
}

func (l *recordingTransientLauncher) StartTransientUnit(ctx context.Context, unit transientUnit) (transientUnitStatus, error) {
	if err := ctx.Err(); err != nil {
		return transientUnitStatus{}, err
	}
	l.starts = append(l.starts, cloneTransientUnit(unit))
	if l.err != nil {
		return transientUnitStatus{}, l.err
	}
	status := l.status
	if unit.NetNS != nil && status.NetworkNamespacePath == "" {
		status.NetworkNamespacePath = "/proc/123/ns/net"
	}
	return status, nil
}

func (l *recordingTransientLauncher) ConfirmOCILimits(ctx context.Context, unit string, limits ExecutionResourceLimits) (OCILimitsStatus, error) {
	if err := ctx.Err(); err != nil {
		return OCILimitsStatus{}, err
	}
	l.confirmedLimits = append(l.confirmedLimits, confirmedOCILimits{
		unit:   unit,
		limits: limits,
	})
	if l.ociLimitsErr != nil {
		return OCILimitsStatus{}, l.ociLimitsErr
	}
	return l.ociLimits, nil
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

func executeOCIEntry() CapsuleEntry {
	return CapsuleEntry{
		ID:        "local.oci.capsule",
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

func executeOCIManifest(entry CapsuleEntry) ExecutionManifest {
	return ExecutionManifest{
		ID:           entry.ID,
		Version:      entry.Version,
		Integrity:    entry.Integrity,
		PackageClass: executePackageClassOCIService,
		Runtime: ExecutionRuntime{
			OCI: OCIExecution{
				Image: OCIImageExecution{
					Digest:     "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
		baseDir: "/usr/lib/vita/capsules/local.oci.capsule",
	}
}

func ociManifestJSON(entry CapsuleEntry) string {
	return `{
		"id":"` + entry.ID + `",
		"version":"` + entry.Version + `",
		"integrity":"` + entry.Integrity + `",
		"packageClass":"oci-service",
		"runtime":{"oci":{"image":{"digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","entrypoint":["/init"]}}},
		"resourceLimits":{"cpuCores":0.25,"ramMiB":64,"storageMiB":16,"tasksMax":32}
	}`
}

func networkManifestJSON(entry CapsuleEntry) string {
	return `{
		"id":"` + entry.ID + `",
		"version":"` + entry.Version + `",
		"integrity":"` + entry.Integrity + `",
		"packageClass":"ts-service",
		"runtime":{"typescript":{"entrypoint":"main.ts"}},
		"resourceLimits":{"cpuCores":0.25,"ramMiB":64,"storageMiB":16,"tasksMax":32},
		"network":{
			"ingress":[
				{"name":"health","protocol":"tcp","port":8787,"sourceCidr":"127.0.0.1/32","interface":"lo","public":false}
			],
			"egress":[
				{"name":"api","protocol":"tcp","destinations":["203.0.113.10","2001:db8::/32"],"ports":[443],"interface":"eth0"}
			]
		}
	}`
}

func validExecutionNetwork() *ExecutionNetwork {
	return &ExecutionNetwork{
		Ingress: []ExecutionNetworkIngressRule{
			{
				Name:       "health",
				Protocol:   network.ProtoTCP,
				Port:       8787,
				SourceCIDR: "127.0.0.1/32",
				Interface:  "lo",
				Public:     false,
			},
		},
		Egress: []ExecutionNetworkEgressRule{
			{
				Name:         "api",
				Protocol:     network.ProtoTCP,
				Destinations: []string{"203.0.113.10/32"},
				Ports:        []int{443},
				Interface:    "eth0",
			},
		},
	}
}

func validExecutionNetworkNoEgress() *ExecutionNetwork {
	return &ExecutionNetwork{
		Ingress: []ExecutionNetworkIngressRule{
			{
				Name:       "health",
				Protocol:   network.ProtoTCP,
				Port:       8787,
				SourceCIDR: "127.0.0.1/32",
				Interface:  "lo",
				Public:     false,
			},
		},
		Egress: []ExecutionNetworkEgressRule{},
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
	var netns *capsuleNetns
	if unit.NetNS != nil {
		cloned := *unit.NetNS
		netns = &cloned
	}
	return transientUnit{
		Name:       unit.Name,
		Argv:       argv,
		Properties: properties,
		Volumes:    volumes,
		NetNS:      netns,
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

func assertDoesNotContainProperty(t *testing.T, props map[string][]string, name string, want string) {
	t.Helper()
	for _, value := range props[name] {
		if value == want {
			t.Fatalf("%s = %v, want no value %q", name, props[name], want)
		}
	}
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
