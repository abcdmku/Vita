package capsules

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func TestSetupVolumeMapsPersistentSpecToStateDirectory(t *testing.T) {
	spec := validVolumeSpec(t, "local.test.capsule", "state")

	mount, err := SetupVolume("local.test.capsule", spec)
	if err != nil {
		t.Fatalf("SetupVolume returned error: %v", err)
	}

	wantPath := "/var/lib/vita/runtime/volumes/local.test.capsule/state"
	if mount.Name != "state" {
		t.Fatalf("Name = %q, want state", mount.Name)
	}
	if mount.Path != wantPath {
		t.Fatalf("Path = %q, want %q", mount.Path, wantPath)
	}
	if mount.StateDirectory != "vita/runtime/volumes/local.test.capsule/state" {
		t.Fatalf("StateDirectory = %q, want vita/runtime/volumes/local.test.capsule/state", mount.StateDirectory)
	}
	if mount.Access != VolumeAccessReadWrite {
		t.Fatalf("Access = %q, want %q", mount.Access, VolumeAccessReadWrite)
	}
	if StateDirectoryMode() != "0700" {
		t.Fatalf("StateDirectoryMode = %q, want 0700", StateDirectoryMode())
	}
}

func TestSetupVolumesRejectsDuplicateNames(t *testing.T) {
	first := validVolumeSpec(t, "local.test.capsule", "state")
	second := first

	if _, err := SetupVolumes("local.test.capsule", []VolumeSpec{first, second}); err == nil {
		t.Fatal("SetupVolumes accepted duplicate volume names")
	}
}

func TestSetupVolumeRejectsMountPathMismatch(t *testing.T) {
	spec := validVolumeSpec(t, "local.test.capsule", "state")
	spec.MountPath = "/var/lib/vita/runtime/volumes/local.test.capsule/other"

	if _, err := SetupVolume("local.test.capsule", spec); err == nil {
		t.Fatal("SetupVolume accepted a manifest mountPath that does not match the computed StateDirectory path")
	}
}

func TestVolumeSpecDecodeRejectsUnsafeAndPartialInputs(t *testing.T) {
	tests := []struct {
		name string
		raw  string
	}{
		{
			name: "missing backup false presence",
			raw:  `{"name":"state","mountPath":"/var/lib/vita/runtime/volumes/local.test.capsule/state","class":"app-state","access":"read-write","persistence":"persistent","sizeMiB":8}`,
		},
		{
			name: "non persistent",
			raw:  `{"name":"state","mountPath":"/var/lib/vita/runtime/volumes/local.test.capsule/state","class":"app-state","access":"read-write","persistence":"ephemeral","backup":false,"sizeMiB":8}`,
		},
		{
			name: "unsafe name",
			raw:  `{"name":"../state","mountPath":"/var/lib/vita/runtime/volumes/local.test.capsule/state","class":"app-state","access":"read-write","persistence":"persistent","backup":false,"sizeMiB":8}`,
		},
		{
			name: "integer-valued float",
			raw:  `{"name":"state","mountPath":"/var/lib/vita/runtime/volumes/local.test.capsule/state","class":"app-state","access":"read-write","persistence":"persistent","backup":false,"sizeMiB":8.0}`,
		},
		{
			name: "duplicate key",
			raw:  `{"name":"bad","name":"state","mountPath":"/var/lib/vita/runtime/volumes/local.test.capsule/state","class":"app-state","access":"read-write","persistence":"persistent","backup":false,"sizeMiB":8}`,
		},
		{
			name: "unknown field",
			raw:  `{"name":"state","mountPath":"/var/lib/vita/runtime/volumes/local.test.capsule/state","class":"app-state","access":"read-write","persistence":"persistent","backup":false,"sizeMiB":8,"bindPath":"/var"}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var spec VolumeSpec
			if err := json.Unmarshal([]byte(tt.raw), &spec); err == nil {
				t.Fatal("Unmarshal accepted invalid volume spec")
			}
		})
	}
}

func TestSetupVolumeConcurrentSameVolumeIsStable(t *testing.T) {
	spec := validVolumeSpec(t, "local.test.capsule", "state")
	const workers = 16

	var wg sync.WaitGroup
	results := make([]VolumeMount, workers)
	errs := make([]error, workers)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			results[index], errs[index] = SetupVolume("local.test.capsule", spec)
		}(i)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("SetupVolume[%d] returned error: %v", i, err)
		}
	}
	for i := 1; i < workers; i++ {
		if !reflect.DeepEqual(results[0], results[i]) {
			t.Fatalf("SetupVolume[%d] = %#v, want %#v", i, results[i], results[0])
		}
	}
}

func TestTeardownVolumeLeavesData(t *testing.T) {
	dir := t.TempDir()
	record := filepath.Join(dir, "record.txt")
	if err := os.WriteFile(record, []byte("persistent"), 0o600); err != nil {
		t.Fatalf("write test record: %v", err)
	}

	if err := TeardownVolume(context.Background(), VolumeMount{Name: "state", Path: dir}); err != nil {
		t.Fatalf("TeardownVolume returned error: %v", err)
	}

	got, err := os.ReadFile(record)
	if err != nil {
		t.Fatalf("TeardownVolume removed data: %v", err)
	}
	if string(got) != "persistent" {
		t.Fatalf("record = %q, want persistent", got)
	}
}

func TestVolumePathEscapesSystemdSpecialCharactersInCapsuleID(t *testing.T) {
	got, err := VolumePath("capsule:local-backup", "state")
	if err != nil {
		t.Fatalf("VolumePath returned error: %v", err)
	}
	if strings.Contains(got, ":") {
		t.Fatalf("VolumePath = %q, want no colon in StateDirectory-derived path", got)
	}
	if !strings.HasPrefix(got, "/var/lib/vita/runtime/volumes/capsule-local-backup-") {
		t.Fatalf("VolumePath = %q, want sanitized capsule scope", got)
	}
}

func validVolumeSpec(t *testing.T, capsuleID string, name string) VolumeSpec {
	t.Helper()
	mountPath, err := VolumePath(capsuleID, name)
	if err != nil {
		t.Fatalf("VolumePath returned error: %v", err)
	}
	return VolumeSpec{
		Name:        name,
		MountPath:   mountPath,
		Class:       DataClassAppState,
		Access:      VolumeAccessReadWrite,
		Persistence: VolumePersistencePersistent,
		Backup:      false,
		SizeMiB:     8,
	}
}
