package storagesnap

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/vita/agent/capabilities"
)

var (
	errInjectedCreateWritable = errors.New("injected create writable failure")
	errInjectedVerifyQuota    = errors.New("injected quota verify failure")
)

func TestApplyRequestDecodeAndValidation(t *testing.T) {
	valid := []string{
		`{"desired":{"op":"create","tag":"preapply"}}`,
		`{"desired":{"op":"create"}}`,
		`{"desired":{"op":"list"}}`,
		`{"desired":{"op":"rollback","name":"vita-20260624T120000Z-000001-preapply"}}`,
		`{"desired":{"op":"quota-set","quotaGiB":1}}`,
		`{"desired":{"op":"quota-enforce","quotaGiB":2}}`,
	}
	for _, raw := range valid {
		t.Run("valid "+raw, func(t *testing.T) {
			var req ApplyRequest
			if err := json.Unmarshal([]byte(raw), &req); err != nil {
				t.Fatalf("Unmarshal returned error: %v", err)
			}
			if err := req.Validate(); err != nil {
				t.Fatalf("Validate returned error: %v", err)
			}
		})
	}

	tooLong := strings.Repeat("a", maxSnapshotLabelBytes+1)
	invalid := []string{
		`{"desired":{"op":"create","tag":"bad` + "\u0001" + `"}}`,
		`{"desired":{"op":"create","tag":"bad..tag"}}`,
		`{"desired":{"op":"create","tag":"/absolute"}}`,
		`{"desired":{"op":"create","tag":"bad` + "\u0000" + `tag"}}`,
		`{"desired":{"op":"rollback","name":"` + tooLong + `"}}`,
		`{"desired":{"op":"quota-set","quotaGiB":0}}`,
		`{"desired":{"op":"quota-set","quotaGiB":-1}}`,
		`{"desired":{"op":"quota-set","quotaGiB":1000.0}}`,
		`{"desired":{"op":"quota-set","quotaGiB":1e3}}`,
		`{"desired":{"op":"destroy","name":"snap"}}`,
		`{"desired":{"op":"list","name":"snap"}}`,
		`{"desired":{"op":"rollback"}}`,
		`{"desired":{"op":"quota-set"}}`,
		`{"desired":{"op":"create","op":"list"}}`,
		`{"desired":{}}`,
		`{"request":{"op":"list"}}`,
	}
	for _, raw := range invalid {
		t.Run("invalid "+raw, func(t *testing.T) {
			var req ApplyRequest
			if err := json.Unmarshal([]byte(raw), &req); err == nil {
				if validateErr := req.Validate(); validateErr == nil {
					t.Fatal("request decoded and validated, want rejection")
				}
			}
		})
	}
}

func TestMalformedPartialAndWrongTypedRequestsRejectWithoutPanic(t *testing.T) {
	mustNotPanic(t, func() {
		var req ApplyRequest
		if err := json.Unmarshal([]byte(`{"desired":{"op":`), &req); err == nil {
			t.Fatal("malformed JSON decoded, want error")
		}
	})

	mustNotPanic(t, func() {
		req := ApplyRequest{Desired: &Desired{Op: OpRollback}}
		if err := req.Validate(); err == nil {
			t.Fatal("partial rollback request validated, want error")
		}
	})

	mustNotPanic(t, func() {
		capability := newCapability(newFakeBtrfs("live"), fixedNow)
		undo, err := capability.Apply(context.Background(), cyclicRequest{})
		if undo != nil {
			t.Fatalf("Apply returned undo for wrong request type: %v", undo)
		}
		var invalid *InvalidRequestError
		if !errors.As(err, &invalid) {
			t.Fatalf("Apply error = %T %v, want InvalidRequestError", err, err)
		}
	})
}

func TestRollbackSingleCommitPointAndUndo(t *testing.T) {
	ctx := context.Background()
	system := newFakeBtrfs("state-B")
	system.snapshots["snap-a"] = fakeSnapshot{
		info:    snapshotInfo("snap-a", 10, true),
		content: "state-A",
	}
	capability := newCapability(system, fixedNow)

	undo, err := capability.Apply(ctx, rollbackRequest("snap-a"))
	if err != nil {
		t.Fatalf("Apply rollback returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply rollback returned nil undo")
	}
	if system.live != "state-A" {
		t.Fatalf("live data after rollback = %q, want state-A", system.live)
	}
	if system.swapCalls != 1 {
		t.Fatalf("SwapDataWithSnapshot calls = %d, want 1", system.swapCalls)
	}

	restoreName := "vita-20260624T120000Z-000002-rollback-restore"
	restore, ok := system.snapshots[restoreName]
	if !ok {
		t.Fatalf("restore snapshot %q missing", restoreName)
	}
	if restore.content != "state-B" {
		t.Fatalf("restore snapshot content = %q, want prior state-B", restore.content)
	}
	if restore.info.ReadOnly {
		t.Fatal("restore snapshot is read-only; undo needs writable prior @data reference")
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if system.live != "state-B" {
		t.Fatalf("live data after Undo = %q, want state-B", system.live)
	}
}

func TestRollbackInjectedFailureBeforeSwapLeavesLiveUnchanged(t *testing.T) {
	ctx := context.Background()
	system := newFakeBtrfs("state-B")
	system.snapshots["snap-a"] = fakeSnapshot{
		info:    snapshotInfo("snap-a", 10, true),
		content: "state-A",
	}
	system.failCreateWritable = true
	capability := newCapability(system, fixedNow)

	undo, err := capability.Apply(ctx, rollbackRequest("snap-a"))
	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil", undo)
	}
	if !errors.Is(err, errInjectedCreateWritable) {
		t.Fatalf("Apply error = %v, want injected failure", err)
	}
	if system.live != "state-B" {
		t.Fatalf("live data after failed rollback = %q, want unchanged state-B", system.live)
	}
	if system.swapCalls != 0 {
		t.Fatalf("SwapDataWithSnapshot calls = %d, want 0", system.swapCalls)
	}
	targetName := "vita-20260624T120000Z-000001-pre-rollback"
	target, ok := system.snapshots[targetName]
	if !ok {
		t.Fatalf("rollback target %q missing", targetName)
	}
	if target.content != "state-B" || !target.info.ReadOnly {
		t.Fatalf("rollback target = %#v, want read-only state-B", target)
	}
}

func TestRollbackRejectsUnknownOrWritableSnapshotWithoutMutation(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name      string
		snapshots map[string]fakeSnapshot
	}{
		{name: "unknown", snapshots: map[string]fakeSnapshot{}},
		{name: "writable", snapshots: map[string]fakeSnapshot{
			"snap-a": {info: snapshotInfo("snap-a", 10, false), content: "state-A"},
		}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			system := newFakeBtrfs("state-B")
			for name, snapshot := range tt.snapshots {
				system.snapshots[name] = snapshot
			}
			capability := newCapability(system, fixedNow)
			undo, err := capability.Apply(ctx, rollbackRequest("snap-a"))
			if undo != nil {
				t.Fatalf("Apply returned undo %v, want nil", undo)
			}
			if err == nil {
				t.Fatal("Apply returned nil error, want rejection")
			}
			if system.live != "state-B" {
				t.Fatalf("live data = %q, want unchanged state-B", system.live)
			}
			if system.swapCalls != 0 {
				t.Fatalf("SwapDataWithSnapshot calls = %d, want 0", system.swapCalls)
			}
		})
	}
}

func TestListDeterminism(t *testing.T) {
	system := newFakeBtrfs("live")
	system.snapshots["z-last"] = fakeSnapshot{info: snapshotInfo("z-last", 3, true), content: "z"}
	system.snapshots["a-first"] = fakeSnapshot{info: snapshotInfo("a-first", 2, true), content: "a"}
	system.snapshots["m-middle"] = fakeSnapshot{info: snapshotInfo("m-middle", 1, true), content: "m"}
	capability := newCapability(system, fixedNow)

	first, err := capability.Handle(context.Background(), ReadRequest{})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	second, err := capability.Handle(context.Background(), ApplyRequest{Desired: &Desired{Op: OpList}})
	if err != nil {
		t.Fatalf("Handle(list op) returned error: %v", err)
	}

	firstJSON, err := json.Marshal(first)
	if err != nil {
		t.Fatalf("marshal first response: %v", err)
	}
	secondJSON, err := json.Marshal(second)
	if err != nil {
		t.Fatalf("marshal second response: %v", err)
	}
	if !reflect.DeepEqual(firstJSON, secondJSON) {
		t.Fatalf("list output differs:\nfirst=%s\nsecond=%s", firstJSON, secondJSON)
	}

	list := first.(ListResponse)
	got := []string{list.Snapshots[0].Name, list.Snapshots[1].Name, list.Snapshots[2].Name}
	want := []string{"a-first", "m-middle", "z-last"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("snapshot order = %v, want %v", got, want)
	}
}

func TestSnapshotBeforeApply(t *testing.T) {
	ctx := context.Background()
	system := newFakeBtrfs("before")
	capability := newCapability(system, fixedNow)

	snapshot, err := capability.SnapshotBeforeApply(ctx, "apply")
	if err != nil {
		t.Fatalf("SnapshotBeforeApply returned error: %v", err)
	}
	if snapshot.Name != "vita-20260624T120000Z-000001-apply" {
		t.Fatalf("snapshot name = %q", snapshot.Name)
	}
	if !snapshot.ReadOnly {
		t.Fatal("snapshot is not read-only")
	}
	if system.snapshots[snapshot.Name].content != "before" {
		t.Fatalf("snapshot content = %q, want before", system.snapshots[snapshot.Name].content)
	}

	if _, err := capability.SnapshotBeforeApply(ctx, "../bad"); err == nil {
		t.Fatal("SnapshotBeforeApply accepted invalid tag")
	}
}

func TestCreateAndQuotaApplyUndo(t *testing.T) {
	ctx := context.Background()

	system := newFakeBtrfs("live")
	capability := newCapability(system, fixedNow)
	undo, err := capability.Apply(ctx, ApplyRequest{Desired: &Desired{Op: OpCreate, Tag: stringPtr("manual")}})
	if err != nil {
		t.Fatalf("create Apply returned error: %v", err)
	}
	name := "vita-20260624T120000Z-000001-manual"
	if _, ok := system.snapshots[name]; !ok {
		t.Fatalf("create did not create snapshot %q", name)
	}
	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("create Undo returned error: %v", err)
	}
	if _, ok := system.snapshots[name]; ok {
		t.Fatalf("create Undo left snapshot %q", name)
	}

	system = newFakeBtrfs("live")
	system.quota = QuotaLimit{Set: true, Bytes: 4 * gibBytes}
	capability = newCapability(system, fixedNow)
	undo, err = capability.Apply(ctx, ApplyRequest{Desired: &Desired{Op: OpQuotaSet, QuotaGiB: int64Ptr(2)}})
	if err != nil {
		t.Fatalf("quota-set Apply returned error: %v", err)
	}
	if system.quota != (QuotaLimit{Set: true, Bytes: 2 * gibBytes}) {
		t.Fatalf("quota after Apply = %#v", system.quota)
	}
	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("quota Undo returned error: %v", err)
	}
	if system.quota != (QuotaLimit{Set: true, Bytes: 4 * gibBytes}) {
		t.Fatalf("quota after Undo = %#v", system.quota)
	}

	undo, err = capability.Apply(ctx, ApplyRequest{Desired: &Desired{Op: OpQuotaEnforce, QuotaGiB: int64Ptr(3)}})
	if err != nil {
		t.Fatalf("quota-enforce Apply returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("quota-enforce returned nil undo")
	}
	if system.verifiedBytes != 3*gibBytes {
		t.Fatalf("verifiedBytes = %d, want %d", system.verifiedBytes, 3*gibBytes)
	}

	system.failVerifyQuota = true
	undo, err = capability.Apply(ctx, ApplyRequest{Desired: &Desired{Op: OpQuotaEnforce, QuotaGiB: int64Ptr(3)}})
	if undo != nil {
		t.Fatalf("quota-enforce failure returned undo %v, want nil", undo)
	}
	if !errors.Is(err, errInjectedVerifyQuota) {
		t.Fatalf("quota-enforce error = %v, want injected verify failure", err)
	}
}

func TestCapabilityRegisteredUnderClosedName(t *testing.T) {
	capability := newCapability(newFakeBtrfs("live"), fixedNow)
	registry, err := capabilities.NewRegistry(capability)
	if err != nil {
		t.Fatalf("NewRegistry returned error: %v", err)
	}

	registered, ok := registry.Lookup(Name)
	if !ok {
		t.Fatalf("registry missing %s", Name)
	}
	if registered.Name() != Name {
		t.Fatalf("registered capability name = %q, want %q", registered.Name(), Name)
	}
	if _, err := registry.Dispatch(context.Background(), "storage.missing", ReadRequest{}); err == nil {
		t.Fatal("unknown capability dispatched successfully")
	}

	var req ApplyRequest
	if err := json.Unmarshal([]byte(`{"desired":{"op":"missing"}}`), &req); err == nil {
		t.Fatal("unknown op decoded successfully")
	}
}

func TestRealBtrfsOpsSkipWithoutPrivilege(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skipf("real btrfs exercise requires linux, got %s", runtime.GOOS)
	}
	for _, name := range []string{"btrfs", "losetup", "mkfs.btrfs", "mount", "umount", "fallocate"} {
		if _, err := exec.LookPath(name); err != nil {
			t.Skipf("real btrfs exercise needs %s: %v", name, err)
		}
	}
	if os.Geteuid() != 0 {
		t.Skip("real btrfs exercise requires root for loop and mount")
	}
	if out, err := exec.Command("losetup", "-f").CombinedOutput(); err != nil {
		t.Skipf("real btrfs exercise needs a free loop device: %v (%s)", err, strings.TrimSpace(string(out)))
	}

	ctx := context.Background()
	tmp := t.TempDir()
	img := filepath.Join(tmp, "vita-data.img")
	if err := os.WriteFile(img, nil, 0o600); err != nil {
		t.Fatalf("create image: %v", err)
	}
	if err := os.Truncate(img, 768*1024*1024); err != nil {
		t.Fatalf("truncate image: %v", err)
	}

	loopOut, err := exec.Command("losetup", "--find", "--show", img).CombinedOutput()
	if err != nil {
		skipIfPrivilegeError(t, "attach loop", err, loopOut)
		t.Fatalf("attach loop: %v (%s)", err, strings.TrimSpace(string(loopOut)))
	}
	loop := strings.TrimSpace(string(loopOut))
	defer exec.Command("losetup", "-d", loop).Run()

	runReal(t, "mkfs.btrfs", "mkfs.btrfs", "-f", "-L", "vita-data", loop)
	mnt := filepath.Join(tmp, "mnt")
	if err := os.Mkdir(mnt, 0o700); err != nil {
		t.Fatalf("mkdir mountpoint: %v", err)
	}
	mounted := false
	defer func() {
		if mounted {
			exec.Command("umount", mnt).Run()
		}
	}()
	runReal(t, "mount btrfs", "mount", "-t", "btrfs", loop, mnt)
	mounted = true
	runReal(t, "create @data", "btrfs", "subvolume", "create", filepath.Join(mnt, "@data"))
	runReal(t, "create @snapshots", "btrfs", "subvolume", "create", filepath.Join(mnt, "@snapshots"))
	runReal(t, "enable quota", "btrfs", "quota", "enable", mnt)

	dataFile := filepath.Join(mnt, "@data", "sentinel.txt")
	if err := os.WriteFile(dataFile, []byte("A"), 0o600); err != nil {
		t.Fatalf("write sentinel A: %v", err)
	}

	backend := newBtrfsSystemAtTopLevel(mnt)
	snapshot, err := backend.CreateReadOnlySnapshot(ctx, "snap-a")
	if err != nil {
		t.Fatalf("CreateReadOnlySnapshot returned error: %v", err)
	}
	if !snapshot.ReadOnly {
		t.Fatal("real snapshot is not read-only")
	}

	runReal(t, "small qgroup limit", "btrfs", "qgroup", "limit", "16M", filepath.Join(mnt, "@data"))
	runReal(t, "under quota write", "fallocate", "-l", "1048576", filepath.Join(mnt, "@data", "under"))
	overOut, overErr := exec.Command("fallocate", "-l", "67108864", filepath.Join(mnt, "@data", "over")).CombinedOutput()
	if overErr == nil {
		t.Fatal("over-quota write unexpectedly succeeded")
	}
	if !quotaFailureOutput(overOut, overErr) {
		t.Fatalf("over-quota write failed with unexpected error: %v (%s)", overErr, strings.TrimSpace(string(overOut)))
	}
	_ = os.Remove(filepath.Join(mnt, "@data", "under"))
	_ = os.Remove(filepath.Join(mnt, "@data", "over"))
	runReal(t, "clear qgroup limit", "btrfs", "qgroup", "limit", "none", filepath.Join(mnt, "@data"))

	if err := os.WriteFile(dataFile, []byte("B"), 0o600); err != nil {
		t.Fatalf("write sentinel B: %v", err)
	}
	capability := newCapability(backend, fixedNow)
	undo, err := capability.Apply(ctx, rollbackRequest("snap-a"))
	if err != nil {
		t.Fatalf("rollback Apply returned error: %v", err)
	}
	restored, err := os.ReadFile(dataFile)
	if err != nil {
		t.Fatalf("read restored sentinel: %v", err)
	}
	if string(restored) != "A" {
		t.Fatalf("restored sentinel = %q, want A", restored)
	}
	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("rollback Undo returned error: %v", err)
	}
	prior, err := os.ReadFile(dataFile)
	if err != nil {
		t.Fatalf("read undo sentinel: %v", err)
	}
	if string(prior) != "B" {
		t.Fatalf("undo sentinel = %q, want B", prior)
	}
}

type cyclicRequest struct {
	next *cyclicRequest
}

func (cyclicRequest) CapabilityRequest() {}

type fakeSnapshot struct {
	info    SnapshotInfo
	content string
}

type fakeBtrfs struct {
	live string

	snapshots map[string]fakeSnapshot
	nextID    uint64

	failCreateWritable bool
	swapCalls          int

	quota           QuotaLimit
	verifiedBytes   uint64
	failVerifyQuota bool
}

func newFakeBtrfs(live string) *fakeBtrfs {
	return &fakeBtrfs{
		live:      live,
		snapshots: make(map[string]fakeSnapshot),
		nextID:    100,
	}
}

func (f *fakeBtrfs) CreateReadOnlySnapshot(_ context.Context, name string) (SnapshotInfo, error) {
	if err := validateSnapshotLabel(name, "name"); err != nil {
		return SnapshotInfo{}, err
	}
	if _, exists := f.snapshots[name]; exists {
		return SnapshotInfo{}, &InvalidRequestError{Reason: "snapshot already exists"}
	}
	f.nextID++
	info := snapshotInfo(name, f.nextID, true)
	f.snapshots[name] = fakeSnapshot{info: info, content: f.live}
	return info, nil
}

func (f *fakeBtrfs) CreateWritableSnapshotFrom(_ context.Context, sourceName string, targetName string) (SnapshotInfo, error) {
	if f.failCreateWritable {
		f.failCreateWritable = false
		return SnapshotInfo{}, errInjectedCreateWritable
	}
	source, ok := f.snapshots[sourceName]
	if !ok {
		return SnapshotInfo{}, os.ErrNotExist
	}
	if _, exists := f.snapshots[targetName]; exists {
		return SnapshotInfo{}, &InvalidRequestError{Reason: "snapshot already exists"}
	}
	f.nextID++
	info := snapshotInfo(targetName, f.nextID, false)
	f.snapshots[targetName] = fakeSnapshot{info: info, content: source.content}
	return info, nil
}

func (f *fakeBtrfs) DeleteSnapshot(_ context.Context, name string) error {
	if _, ok := f.snapshots[name]; !ok {
		return os.ErrNotExist
	}
	delete(f.snapshots, name)
	return nil
}

func (f *fakeBtrfs) ListSnapshots(context.Context) ([]SnapshotInfo, error) {
	out := make([]SnapshotInfo, 0, len(f.snapshots))
	for _, snapshot := range f.snapshots {
		out = append(out, snapshot.info)
	}
	return out, nil
}

func (f *fakeBtrfs) SnapshotInfo(_ context.Context, name string) (SnapshotInfo, error) {
	snapshot, ok := f.snapshots[name]
	if !ok {
		return SnapshotInfo{}, os.ErrNotExist
	}
	return snapshot.info, nil
}

func (f *fakeBtrfs) SwapDataWithSnapshot(_ context.Context, name string) error {
	snapshot, ok := f.snapshots[name]
	if !ok {
		return os.ErrNotExist
	}
	f.swapCalls++
	f.live, snapshot.content = snapshot.content, f.live
	f.snapshots[name] = snapshot
	return nil
}

func (f *fakeBtrfs) QuotaLimit(context.Context) (QuotaLimit, error) {
	return f.quota, nil
}

func (f *fakeBtrfs) SetQuota(_ context.Context, bytes uint64) error {
	f.quota = QuotaLimit{Set: true, Bytes: bytes}
	return nil
}

func (f *fakeBtrfs) ClearQuota(context.Context) error {
	f.quota = QuotaLimit{}
	return nil
}

func (f *fakeBtrfs) VerifyQuota(_ context.Context, bytes uint64) error {
	f.verifiedBytes = bytes
	if f.failVerifyQuota {
		return errInjectedVerifyQuota
	}
	return nil
}

func snapshotInfo(name string, id uint64, readOnly bool) SnapshotInfo {
	return SnapshotInfo{
		Name:            name,
		ID:              id,
		CreatedAt:       fixedNow(),
		ReadOnly:        readOnly,
		ReferencedBytes: id * 10,
		ExclusiveBytes:  id,
	}
}

func rollbackRequest(name string) ApplyRequest {
	return ApplyRequest{Desired: &Desired{Op: OpRollback, Name: stringPtr(name)}}
}

func fixedNow() time.Time {
	return time.Date(2026, 6, 24, 12, 0, 0, 0, time.UTC)
}

func stringPtr(value string) *string {
	return &value
}

func int64Ptr(value int64) *int64 {
	return &value
}

func mustNotPanic(t *testing.T, fn func()) {
	t.Helper()
	defer func() {
		if recovered := recover(); recovered != nil {
			t.Fatalf("function panicked: %v", recovered)
		}
	}()
	fn()
}

func runReal(t *testing.T, label string, executable string, args ...string) {
	t.Helper()
	out, err := exec.Command(executable, args...).CombinedOutput()
	if err != nil {
		skipIfPrivilegeError(t, label, err, out)
		t.Fatalf("%s failed: %v (%s)", label, err, strings.TrimSpace(string(out)))
	}
}

func skipIfPrivilegeError(t *testing.T, label string, err error, out []byte) {
	t.Helper()
	text := strings.ToLower(err.Error() + " " + string(out))
	if strings.Contains(text, "operation not permitted") ||
		strings.Contains(text, "permission denied") ||
		strings.Contains(text, "failed to setup loop") ||
		strings.Contains(text, "cannot find an unused loop") {
		t.Skipf("%s requires loop/mount privilege: %v (%s)", label, err, strings.TrimSpace(string(out)))
	}
}

func quotaFailureOutput(out []byte, err error) bool {
	text := strings.ToLower(err.Error() + " " + string(out))
	return strings.Contains(text, "disk quota exceeded") ||
		strings.Contains(text, "no space left") ||
		strings.Contains(text, "edquot") ||
		strings.Contains(text, "enospc")
}
