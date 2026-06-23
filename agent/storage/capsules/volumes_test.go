package capsules

import (
	"context"
	"errors"
	"io/fs"
	"path"
	"reflect"
	"sync"
	"testing"
)

func TestSetupVolumeCreatesPersistentGroupOwnedSetgidDirAndBindPath(t *testing.T) {
	ctx := context.Background()
	host := newFakeVolumeHost()
	spec := persistentVolumeSpec("state")

	mount, err := setupVolume(ctx, host, VolumeMountRoot, "local.test.capsule", spec)
	if err != nil {
		t.Fatalf("setupVolume returned error: %v", err)
	}

	group := host.mustGroup(t, "local.test.capsule")
	wantSource := path.Join(VolumeMountRoot, "local.test.capsule", "state")
	wantDestination := VolumeMountPath("state")
	wantMount := Mount{
		VolumeName:  "state",
		Source:      wantSource,
		Destination: wantDestination,
		BindPath:    wantSource + ":" + wantDestination,
		Group:       group.unitToken,
		GroupID:     group.gid,
		ReadOnly:    false,
	}
	if !reflect.DeepEqual(mount, wantMount) {
		t.Fatalf("mount = %#v, want %#v", mount, wantMount)
	}

	dir := host.mustDir(t, wantSource)
	if dir.uid != 0 || dir.gid != group.gid {
		t.Fatalf("volume dir owner = %d:%d, want 0:%d", dir.uid, dir.gid, group.gid)
	}
	if dir.mode != volumeDirMode {
		t.Fatalf("volume dir mode = %#o, want %#o", dir.mode, volumeDirMode)
	}
	if got, want := host.createdGroups, []string{CapsuleGroupName("local.test.capsule")}; !reflect.DeepEqual(got, want) {
		t.Fatalf("created groups = %v, want %v", got, want)
	}
}

func TestSetupVolumeConcurrentSameVolumeIsIdempotent(t *testing.T) {
	ctx := context.Background()
	host := newFakeVolumeHost()
	spec := persistentVolumeSpec("state")

	const workers = 32
	var wg sync.WaitGroup
	results := make(chan Mount, workers)
	errs := make(chan error, workers)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			mount, err := setupVolume(ctx, host, VolumeMountRoot, "local.test.capsule", spec)
			if err != nil {
				errs <- err
				return
			}
			results <- mount
		}()
	}
	wg.Wait()
	close(results)
	close(errs)

	for err := range errs {
		t.Fatalf("setupVolume returned error: %v", err)
	}

	var first *Mount
	for mount := range results {
		if first == nil {
			copied := mount
			first = &copied
			continue
		}
		if !reflect.DeepEqual(mount, *first) {
			t.Fatalf("concurrent mount = %#v, want %#v", mount, *first)
		}
	}
	if first == nil {
		t.Fatal("no setupVolume result received")
	}
	if got, want := len(host.createdGroups), 1; got != want {
		t.Fatalf("created group count = %d, want %d", got, want)
	}
	dir := host.mustDir(t, first.Source)
	if dir.mode != volumeDirMode {
		t.Fatalf("volume dir mode after concurrent setup = %#o, want %#o", dir.mode, volumeDirMode)
	}
}

func TestTeardownVolumeUnmountsAndLeavesData(t *testing.T) {
	ctx := context.Background()
	host := newFakeVolumeHost()
	mount, err := setupVolume(ctx, host, VolumeMountRoot, "local.test.capsule", persistentVolumeSpec("state"))
	if err != nil {
		t.Fatalf("setupVolume returned error: %v", err)
	}
	recordPath := path.Join(mount.Source, "record.txt")
	host.writeData(recordPath, "survives")

	if err := teardownVolume(ctx, host, mount); err != nil {
		t.Fatalf("teardownVolume returned error: %v", err)
	}

	if got, want := host.unmounted, []string{mount.Destination}; !reflect.DeepEqual(got, want) {
		t.Fatalf("unmounted = %v, want %v", got, want)
	}
	if got := host.readData(recordPath); got != "survives" {
		t.Fatalf("record after teardown = %q, want persistent data", got)
	}
	if _, ok := host.dir(recordPath); ok {
		t.Fatal("test record unexpectedly modeled as a directory")
	}
}

func TestSetupVolumeRejectsUnsafeOrNonPersistentSpec(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name      string
		capsuleID string
		spec      VolumeSpec
	}{
		{
			name:      "capsule traversal",
			capsuleID: "../local.test.capsule",
			spec:      persistentVolumeSpec("state"),
		},
		{
			name:      "bad volume name",
			capsuleID: "local.test.capsule",
			spec: func() VolumeSpec {
				spec := persistentVolumeSpec("State")
				spec.MountPath = VolumeMountPath("state")
				return spec
			}(),
		},
		{
			name:      "unexpected mount path",
			capsuleID: "local.test.capsule",
			spec: func() VolumeSpec {
				spec := persistentVolumeSpec("state")
				spec.MountPath = "/var/lib/vita/runtime/volumes/local.test.capsule/state"
				return spec
			}(),
		},
		{
			name:      "ephemeral is out of scope",
			capsuleID: "local.test.capsule",
			spec: func() VolumeSpec {
				spec := persistentVolumeSpec("state")
				spec.Persistence = "ephemeral"
				return spec
			}(),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			host := newFakeVolumeHost()
			mount, err := setupVolume(ctx, host, VolumeMountRoot, tt.capsuleID, tt.spec)
			if err == nil {
				t.Fatalf("setupVolume returned nil error and mount %#v, want rejection", mount)
			}
			if len(host.createdGroups) != 0 {
				t.Fatalf("created groups = %v, want none", host.createdGroups)
			}
		})
	}
}

type fakeDir struct {
	mode fs.FileMode
	uid  int
	gid  int
}

type fakeVolumeHost struct {
	mu            sync.Mutex
	dirs          map[string]fakeDir
	data          map[string]string
	groupsByID    map[string]groupIdentity
	createdGroups []string
	unmounted     []string
	nextGID       int
}

func newFakeVolumeHost() *fakeVolumeHost {
	return &fakeVolumeHost{
		dirs:       make(map[string]fakeDir),
		data:       make(map[string]string),
		groupsByID: make(map[string]groupIdentity),
		nextGID:    4242,
	}
}

func (h *fakeVolumeHost) MkdirAll(target string, mode fs.FileMode) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	if _, ok := h.dirs[target]; !ok {
		h.dirs[target] = fakeDir{mode: mode}
	}
	return nil
}

func (h *fakeVolumeHost) Chown(target string, uid, gid int) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	dir, ok := h.dirs[target]
	if !ok {
		return errors.New("missing fake dir")
	}
	dir.uid = uid
	dir.gid = gid
	h.dirs[target] = dir
	return nil
}

func (h *fakeVolumeHost) Chmod(target string, mode fs.FileMode) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	dir, ok := h.dirs[target]
	if !ok {
		return errors.New("missing fake dir")
	}
	dir.mode = mode
	h.dirs[target] = dir
	return nil
}

func (h *fakeVolumeHost) EnsureGroup(ctx context.Context, capsuleID string) (groupIdentity, error) {
	if err := ctx.Err(); err != nil {
		return groupIdentity{}, err
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	if group, ok := h.groupsByID[capsuleID]; ok {
		return group, nil
	}

	name := CapsuleGroupName(capsuleID)
	group := groupIdentity{
		name:      name,
		gid:       h.nextGID,
		unitToken: name,
	}
	h.nextGID++
	h.groupsByID[capsuleID] = group
	h.createdGroups = append(h.createdGroups, name)
	return group, nil
}

func (h *fakeVolumeHost) Unmount(target string) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	h.unmounted = append(h.unmounted, target)
	return nil
}

func (h *fakeVolumeHost) mustGroup(t *testing.T, capsuleID string) groupIdentity {
	t.Helper()

	h.mu.Lock()
	defer h.mu.Unlock()

	group, ok := h.groupsByID[capsuleID]
	if !ok {
		t.Fatalf("group for %q was not created", capsuleID)
	}
	return group
}

func (h *fakeVolumeHost) mustDir(t *testing.T, target string) fakeDir {
	t.Helper()

	dir, ok := h.dir(target)
	if !ok {
		t.Fatalf("dir %q was not created", target)
	}
	return dir
}

func (h *fakeVolumeHost) dir(target string) (fakeDir, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()

	dir, ok := h.dirs[target]
	return dir, ok
}

func (h *fakeVolumeHost) writeData(target string, value string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	h.data[target] = value
}

func (h *fakeVolumeHost) readData(target string) string {
	h.mu.Lock()
	defer h.mu.Unlock()

	return h.data[target]
}

func persistentVolumeSpec(name string) VolumeSpec {
	return VolumeSpec{
		Name:        name,
		MountPath:   VolumeMountPath(name),
		Class:       "app-state",
		Access:      "read-write",
		Persistence: "persistent",
		Backup:      true,
		SizeMiB:     16,
	}
}
