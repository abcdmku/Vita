package capsule

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestOCITransientUnitCarriesManifestResourceLimits(t *testing.T) {
	entry := executeOCIEntry()
	manifest := executeOCIManifest(entry)
	manifest.ResourceLimits = ExecutionResourceLimits{
		CPUCores:   0.5,
		RamMiB:     128,
		StorageMiB: 16,
		TasksMax:   16,
	}

	unit, err := composeOCITransientUnit(manifest)
	if err != nil {
		t.Fatalf("composeOCITransientUnit returned error: %v", err)
	}

	props := propertyValues(unit.Properties)
	assertProperty(t, props, "MemoryMax", "134217728")
	assertProperty(t, props, "CPUQuota", "50%")
	assertProperty(t, props, "TasksMax", "16")
}

func TestOCILimitStatusParsesCgroupEvents(t *testing.T) {
	limits := ExecutionResourceLimits{
		CPUCores:   0.25,
		RamMiB:     64,
		StorageMiB: 16,
		TasksMax:   16,
	}

	for _, tc := range []struct {
		name  string
		files ociCgroupLimitFiles
		want  OCILimitsStatus
	}{
		{
			name: "events hit",
			files: ociCgroupLimitFiles{
				MemoryMax:    []byte("67108864\n"),
				MemoryEvents: []byte("low 0\nhigh 0\nmax 3\noom 1\noom_kill 1\n"),
				PidsMax:      []byte("16\n"),
				PidsEvents:   []byte("max 7\n"),
				CPUMax:       []byte("25000 100000\n"),
				CPUStat:      []byte("usage_usec 1000\nnr_periods 4\nnr_throttled 2\nthrottled_usec 500\n"),
			},
			want: OCILimitsStatus{
				Mem:    ociLimitValueEnforced,
				Tasks:  ociLimitValueEnforced,
				CPU:    ociLimitValueEnforced,
				Status: ociLimitStatusOK,
			},
		},
		{
			name: "limits set but no event hit",
			files: ociCgroupLimitFiles{
				MemoryMax:    []byte("67108864\n"),
				MemoryEvents: []byte("low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n"),
				PidsMax:      []byte("16\n"),
				PidsEvents:   []byte("max 0\n"),
				CPUMax:       []byte("25000 100000\n"),
				CPUStat:      []byte("usage_usec 1000\nnr_periods 4\nnr_throttled 0\nthrottled_usec 0\n"),
			},
			want: OCILimitsStatus{
				Mem:    ociLimitValueNotEnforced,
				Tasks:  ociLimitValueNotEnforced,
				CPU:    ociLimitValueNotEnforced,
				Status: ociLimitStatusFail,
			},
		},
		{
			name: "limits absent",
			files: ociCgroupLimitFiles{
				MemoryMax:    []byte("max\n"),
				MemoryEvents: []byte("max 4\noom 1\noom_kill 1\n"),
				PidsMax:      []byte("max\n"),
				PidsEvents:   []byte("max 2\n"),
				CPUMax:       []byte("max 100000\n"),
				CPUStat:      []byte("nr_throttled 3\n"),
			},
			want: OCILimitsStatus{
				Mem:    ociLimitValueNotEnforced,
				Tasks:  ociLimitValueNotEnforced,
				CPU:    ociLimitValueNotEnforced,
				Status: ociLimitStatusFail,
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := evaluateOCILimitsStatus(limits, tc.files)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("evaluateOCILimitsStatus = %#v, want %#v", got, tc.want)
			}
		})
	}
}

func TestExecuteConfirmsHostileOCILimitsAndExposesStatus(t *testing.T) {
	ctx := context.Background()
	entry := CapsuleEntry{
		ID:        hostileOCICapsuleID,
		Version:   "1.0.0",
		Integrity: validSHA256SRI,
		State:     StateInstalled,
	}
	manifest := executeOCIManifest(entry)
	manifest.ResourceLimits.TasksMax = 16
	manifest.baseDir = "/usr/lib/vita/capsules/" + hostileOCICapsuleID
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	launcher := &recordingTransientLauncher{
		status: transientUnitStatus{DynamicUID: "61410"},
		ociLimits: OCILimitsStatus{
			Mem:    ociLimitValueEnforced,
			Tasks:  ociLimitValueEnforced,
			CPU:    ociLimitValueEnforced,
			Status: ociLimitStatusOK,
		},
	}
	capability := newExecuteCapability(
		fs,
		memoryExecutionManifestStore{entry.ID: manifest},
		launcher,
	)

	undo, err := capability.Apply(ctx, executeApply(entry))
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply returned nil undo")
	}
	if len(launcher.confirmedLimits) != 1 {
		t.Fatalf("ConfirmOCILimits calls = %d, want 1", len(launcher.confirmedLimits))
	}
	if launcher.confirmedLimits[0].unit != capsuleUnitName(entry.ID) {
		t.Fatalf("confirmed unit = %q, want %q", launcher.confirmedLimits[0].unit, capsuleUnitName(entry.ID))
	}
	if launcher.confirmedLimits[0].limits.TasksMax != 16 {
		t.Fatalf("confirmed TasksMax = %d, want 16", launcher.confirmedLimits[0].limits.TasksMax)
	}

	response, err := capability.Handle(ctx, ExecuteReadRequest{})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	readResponse := response.(ExecuteReadResponse)
	if readResponse.Last == nil || readResponse.Last.OCILimits == nil {
		t.Fatalf("Last = %#v, want OCI limit status", readResponse.Last)
	}
	if *readResponse.Last.OCILimits != launcher.ociLimits {
		t.Fatalf("Last.OCILimits = %#v, want %#v", *readResponse.Last.OCILimits, launcher.ociLimits)
	}
}

func TestExecuteStopsHostileOCIWhenLimitsAreNotEnforced(t *testing.T) {
	ctx := context.Background()
	entry := CapsuleEntry{
		ID:        hostileOCICapsuleID,
		Version:   "1.0.0",
		Integrity: validSHA256SRI,
		State:     StateInstalled,
	}
	manifest := executeOCIManifest(entry)
	manifest.baseDir = "/usr/lib/vita/capsules/" + hostileOCICapsuleID
	fs := newMemoryFileSystem(mustRenderRegistry(t, registryWithCapsules([]CapsuleEntry{entry})))
	launcher := &recordingTransientLauncher{
		status: transientUnitStatus{DynamicUID: "61410"},
		ociLimits: OCILimitsStatus{
			Mem:    ociLimitValueEnforced,
			Tasks:  ociLimitValueNotEnforced,
			CPU:    ociLimitValueEnforced,
			Status: ociLimitStatusFail,
		},
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
	if startErr.ApplyErrorCode() != "oci_limits_failed" {
		t.Fatalf("ApplyErrorCode = %q, want oci_limits_failed", startErr.ApplyErrorCode())
	}
	wantUnit := capsuleUnitName(entry.ID)
	if !reflect.DeepEqual(launcher.stops, []string{wantUnit}) {
		t.Fatalf("stops = %v, want [%s]", launcher.stops, wantUnit)
	}
	if !reflect.DeepEqual(launcher.resets, []string{wantUnit}) {
		t.Fatalf("resets = %v, want [%s]", launcher.resets, wantUnit)
	}
}
