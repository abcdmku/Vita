//go:build linux

package backup

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"golang.org/x/sys/unix"

	"github.com/vita/agent/transaction"
)

func TestArchiveCreateProducesContentAddressedManifestAndObjects(t *testing.T) {
	ctx := context.Background()
	source := t.TempDir()
	target := t.TempDir()
	writeTestFile(t, filepath.Join(source, "pds-sync-state.json"), []byte(`{"cursor":42}`+"\n"), 0o600)
	writeTestFile(t, filepath.Join(source, "capsules", "state.bin"), []byte{0x01, 0x02, 0x03}, 0o640)
	if err := os.Mkdir(filepath.Join(source, "empty-dir"), 0o700); err != nil {
		t.Fatalf("create empty source dir: %v", err)
	}

	victim := filepath.Join(target, "victim")
	writeTestFile(t, victim, []byte("victim"), 0o600)
	plantedTemp := filepath.Join(target, ".backup-archive.tmp")
	if err := os.Symlink(victim, plantedTemp); err != nil {
		t.Fatalf("preplant symlink temp: %v", err)
	}

	capability := NewArchiveCapability()
	result, _, err := capability.Create(ctx, archiveCreateRequest(target, source))
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if result.Files != 2 {
		t.Fatalf("Files = %d, want 2", result.Files)
	}
	if !archiveDigestPattern.MatchString(result.BackupID) {
		t.Fatalf("BackupID = %q, want sha256 content id", result.BackupID)
	}
	if got := mustReadFile(t, victim); string(got) != "victim" {
		t.Fatalf("preplanted symlink target = %q, want unchanged victim", got)
	}
	if link, err := os.Readlink(plantedTemp); err != nil || link != victim {
		t.Fatalf("preplanted symlink = %q, %v; want unchanged link to %q", link, err, victim)
	}

	manifest := mustLoadManifest(t, target, result.BackupID)
	if manifest.Digest != result.BackupID {
		t.Fatalf("manifest digest = %q, want backup id %q", manifest.Digest, result.BackupID)
	}
	computed, err := manifestDigest(manifestBody(manifest))
	if err != nil {
		t.Fatalf("manifestDigest returned error: %v", err)
	}
	if computed != result.BackupID {
		t.Fatalf("computed manifest digest = %q, want %q", computed, result.BackupID)
	}

	entries := manifestEntriesByID(manifest)
	assertFileEntryMatchesSource(t, entries["agent/pds-sync-state.json"], filepath.Join(source, "pds-sync-state.json"), target, result.BackupID)
	assertFileEntryMatchesSource(t, entries["agent/capsules/state.bin"], filepath.Join(source, "capsules", "state.bin"), target, result.BackupID)
	if entry, ok := entries["agent/empty-dir"]; !ok || entry.Type != "dir" || entry.Mode != 0o700 {
		t.Fatalf("empty directory entry = %#v, %v; want recorded dir mode 0700", entry, ok)
	}
}

func TestArchiveCreateAllowsAbsentSourceRootAsEmptyRoot(t *testing.T) {
	ctx := context.Background()
	target := t.TempDir()
	missingRoot := filepath.Join(t.TempDir(), "missing")

	capability := NewArchiveCapability()
	result, _, err := capability.Create(ctx, ArchiveCreateRequest{
		TargetPath:  target,
		SourceRoots: &[]ArchiveSourceRoot{{Name: "capsule-volumes", Path: missingRoot}},
	})
	if err != nil {
		t.Fatalf("Create returned error for absent source root: %v", err)
	}
	if result.Files != 0 {
		t.Fatalf("Files = %d, want 0 for empty absent root", result.Files)
	}

	manifest := mustLoadManifest(t, target, result.BackupID)
	if len(manifest.Roots) != 1 || manifest.Roots[0].Name != "capsule-volumes" {
		t.Fatalf("manifest roots = %#v, want recorded absent root", manifest.Roots)
	}
	if len(manifest.Entries) != 0 {
		t.Fatalf("manifest entries = %#v, want none for absent root", manifest.Entries)
	}

	verify, err := capability.Verify(ctx, ArchiveVerifyRequest{TargetPath: target, BackupID: result.BackupID})
	if err != nil {
		t.Fatalf("Verify returned error: %v", err)
	}
	if !verify.OK || verify.Failure != nil {
		t.Fatalf("Verify = %#v, want ok", verify)
	}
}

func TestArchiveCreateSkipsSpecialEntriesAndDanglingSymlinks(t *testing.T) {
	ctx := context.Background()
	source := t.TempDir()
	target := t.TempDir()
	writeTestFile(t, filepath.Join(source, "state.json"), []byte(`{"ok":true}`), 0o600)

	if err := os.Symlink(filepath.Join(source, "missing"), filepath.Join(source, "dangling")); err != nil {
		t.Fatalf("create dangling symlink: %v", err)
	}
	if err := unix.Mkfifo(filepath.Join(source, "events.fifo"), 0o600); err != nil {
		t.Fatalf("create fifo: %v", err)
	}
	socket, err := net.Listen("unix", filepath.Join(source, "agent.sock"))
	if err != nil {
		t.Fatalf("create unix socket: %v", err)
	}
	defer socket.Close()

	capability := NewArchiveCapability()
	result, _, err := capability.Create(ctx, archiveCreateRequest(target, source))
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if result.Files != 1 {
		t.Fatalf("Files = %d, want only the regular file", result.Files)
	}

	entries := manifestEntriesByID(mustLoadManifest(t, target, result.BackupID))
	if _, ok := entries["agent/state.json"]; !ok {
		t.Fatalf("manifest entries = %#v, want regular file", entries)
	}
	for _, skipped := range []string{"agent/dangling", "agent/events.fifo", "agent/agent.sock"} {
		if _, ok := entries[skipped]; ok {
			t.Fatalf("manifest included skipped special entry %q", skipped)
		}
	}
}

func TestArchiveBuildManifestExcludesTargetSubtree(t *testing.T) {
	ctx := context.Background()
	source := t.TempDir()
	target := filepath.Join(source, "vita-backups")
	objectsDir := filepath.Join(target, ".backup-archive-stage", archiveObjectsDirName)
	writeTestFile(t, filepath.Join(source, "state.json"), []byte(`{"ok":true}`), 0o600)
	writeTestFile(t, filepath.Join(objectsDir, "preexisting-object"), []byte("must not be walked"), 0o600)

	manifest, files, err := buildArchiveManifest(ctx, []ArchiveSourceRoot{{Name: "agent", Path: source}}, objectsDir, target)
	if err != nil {
		t.Fatalf("buildArchiveManifest returned error: %v", err)
	}
	if files != 1 {
		t.Fatalf("files = %d, want only source state file", files)
	}

	entries := manifestEntriesByID(manifest)
	if _, ok := entries["agent/state.json"]; !ok {
		t.Fatalf("manifest entries = %#v, want source state file", entries)
	}
	for id := range entries {
		if strings.Contains(id, "vita-backups") {
			t.Fatalf("manifest included backup target entry %q", id)
		}
	}
}

func TestArchiveVerifyDetectsContentAndManifestTamper(t *testing.T) {
	ctx := context.Background()
	source := t.TempDir()
	target := t.TempDir()
	writeTestFile(t, filepath.Join(source, "state.json"), []byte(`{"ok":true}`), 0o600)

	capability := NewArchiveCapability()
	result, _, err := capability.Create(ctx, archiveCreateRequest(target, source))
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	verify, err := capability.Verify(ctx, ArchiveVerifyRequest{TargetPath: target, BackupID: result.BackupID})
	if err != nil {
		t.Fatalf("Verify returned error: %v", err)
	}
	if !verify.OK || verify.Failure != nil {
		t.Fatalf("Verify = %#v, want ok", verify)
	}

	manifest := mustLoadManifest(t, target, result.BackupID)
	fileEntry := firstFileEntry(t, manifest)
	objectPath := filepath.Join(archivePath(target, result.BackupID), archiveObjectsDirName, fileEntry.Digest)
	content := mustReadFile(t, objectPath)
	content[0] ^= 0xff
	writeTestFile(t, objectPath, content, 0o600)

	verify, err = capability.Verify(ctx, ArchiveVerifyRequest{TargetPath: target, BackupID: result.BackupID})
	if err != nil {
		t.Fatalf("Verify returned error after content tamper: %v", err)
	}
	if verify.OK || verify.Failure == nil {
		t.Fatalf("Verify after content tamper = %#v, want specific failure", verify)
	}
	if verify.Failure.Entry != manifestEntryID(fileEntry) || !strings.Contains(verify.Failure.Reason, "digest") {
		t.Fatalf("content tamper failure = %#v, want entry %q digest failure", verify.Failure, manifestEntryID(fileEntry))
	}

	target2 := t.TempDir()
	result2, _, err := capability.Create(ctx, archiveCreateRequest(target2, source))
	if err != nil {
		t.Fatalf("second Create returned error: %v", err)
	}
	manifestPath := filepath.Join(archivePath(target2, result2.BackupID), archiveManifestName)
	rawManifest := string(mustReadFile(t, manifestPath))
	tamperedManifest := strings.Replace(rawManifest, result2.BackupID, "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", 1)
	writeTestFile(t, manifestPath, []byte(tamperedManifest), 0o600)

	verify, err = capability.Verify(ctx, ArchiveVerifyRequest{TargetPath: target2, BackupID: result2.BackupID})
	if err != nil {
		t.Fatalf("Verify returned error after manifest tamper: %v", err)
	}
	if verify.OK || verify.Failure == nil || verify.Failure.Entry != "manifest" {
		t.Fatalf("Verify after manifest tamper = %#v, want manifest failure", verify)
	}
}

func TestArchiveRestoreRoundTripAndUndoRestoresPriorTree(t *testing.T) {
	ctx := context.Background()
	source := t.TempDir()
	target := t.TempDir()
	destination := filepath.Join(t.TempDir(), "restore-root")
	writeTestFile(t, filepath.Join(source, "pds-sync-state.json"), []byte(`{"cursor":42}`+"\n"), 0o600)
	writeTestFile(t, filepath.Join(source, "capsules", "state.bin"), []byte{0x10, 0x20}, 0o640)
	if err := os.MkdirAll(filepath.Join(source, "empty"), 0o700); err != nil {
		t.Fatalf("create empty source dir: %v", err)
	}
	writeTestFile(t, filepath.Join(destination, "prior.txt"), []byte("prior"), 0o600)
	prior := mustDigestTree(t, destination)

	capability := NewArchiveCapability()
	created, _, err := capability.Create(ctx, archiveCreateRequest(target, source))
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	restored, undo, err := capability.Restore(ctx, ArchiveRestoreRequest{
		TargetPath:         target,
		BackupID:           created.BackupID,
		DestinationRoot:    destination,
		CompareSourceRoots: &[]ArchiveSourceRoot{{Name: "agent", Path: source}},
	})
	if err != nil {
		t.Fatalf("Restore returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Restore returned nil undo")
	}
	if !restored.Restored || restored.BackupID != created.BackupID || restored.Files != created.Files {
		t.Fatalf("Restore result = %#v, want restored backup %q files %d", restored, created.BackupID, created.Files)
	}
	if err := compareTrees(ctx, source, filepath.Join(destination, "agent")); err != nil {
		t.Fatalf("restored tree differs from source: %v", err)
	}

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	if got := mustDigestTree(t, destination); !reflect.DeepEqual(got, prior) {
		t.Fatalf("destination after Undo = %#v, want prior %#v", got, prior)
	}
	assertNoRestoreTemps(t, filepath.Dir(destination), filepath.Base(destination))
}

func TestArchiveRestoreTamperRefusesWithoutMutationOrLeaks(t *testing.T) {
	ctx := context.Background()
	source := t.TempDir()
	target := t.TempDir()
	destination := filepath.Join(t.TempDir(), "restore-root")
	writeTestFile(t, filepath.Join(source, "state.json"), []byte(`{"ok":true}`), 0o600)
	writeTestFile(t, filepath.Join(destination, "prior.txt"), []byte("prior"), 0o600)
	prior := mustDigestTree(t, destination)

	capability := NewArchiveCapability()
	created, _, err := capability.Create(ctx, archiveCreateRequest(target, source))
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	manifest := mustLoadManifest(t, target, created.BackupID)
	entry := firstFileEntry(t, manifest)
	objectPath := filepath.Join(archivePath(target, created.BackupID), archiveObjectsDirName, entry.Digest)
	content := mustReadFile(t, objectPath)
	content[0] ^= 0xff
	writeTestFile(t, objectPath, content, 0o600)

	beforeTemps := restoreTemps(t, filepath.Dir(destination), filepath.Base(destination))
	undo, err := restoreViaApply(ctx, capability, target, created.BackupID, destination)
	if undo != nil {
		t.Fatalf("Restore Apply returned undo %v, want nil", undo)
	}
	var verifyErr *ArchiveVerificationError
	if !errors.As(err, &verifyErr) {
		t.Fatalf("Restore Apply error = %T %v, want ArchiveVerificationError", err, err)
	}
	if code := verifyErr.ApplyErrorCode(); code != "verify_digest_mismatch" {
		t.Fatalf("verification error code = %q, want verify_digest_mismatch", code)
	}
	if got := mustDigestTree(t, destination); !reflect.DeepEqual(got, prior) {
		t.Fatalf("destination after refused restore = %#v, want unchanged %#v", got, prior)
	}
	afterTemps := restoreTemps(t, filepath.Dir(destination), filepath.Base(destination))
	if !reflect.DeepEqual(afterTemps, beforeTemps) {
		t.Fatalf("restore temp dirs after refused restore = %v, want unchanged %v", afterTemps, beforeTemps)
	}
}

func TestArchiveFailClosedInputHandling(t *testing.T) {
	ctx := context.Background()
	source := t.TempDir()
	target := t.TempDir()
	writeTestFile(t, filepath.Join(source, "state.json"), []byte(`{"ok":true}`), 0o600)

	tests := []struct {
		name string
		req  ArchiveApplyRequest
	}{
		{
			name: "missing create target",
			req:  ArchiveApplyRequest{Op: ArchiveOperationCreate, Create: &ArchiveCreateRequest{}},
		},
		{
			name: "non absolute target",
			req: ArchiveApplyRequest{Op: ArchiveOperationCreate, Create: &ArchiveCreateRequest{
				TargetPath:  "relative",
				SourceRoots: &[]ArchiveSourceRoot{{Name: "agent", Path: source}},
			}},
		},
		{
			name: "control char target",
			req: ArchiveApplyRequest{Op: ArchiveOperationCreate, Create: &ArchiveCreateRequest{
				TargetPath:  filepath.Join(t.TempDir(), "bad\npath"),
				SourceRoots: &[]ArchiveSourceRoot{{Name: "agent", Path: source}},
			}},
		},
		{
			name: "inline secret metadata",
			req: ArchiveApplyRequest{Op: ArchiveOperationCreate, Create: &ArchiveCreateRequest{
				TargetPath:  target,
				SourceRoots: &[]ArchiveSourceRoot{{Name: "private-key", Path: source}},
			}},
		},
		{
			name: "unknown op",
			req: ArchiveApplyRequest{
				Op:     ArchiveOperation("tamper"),
				Verify: &ArchiveVerifyRequest{TargetPath: target, BackupID: "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},
			},
		},
		{
			name: "restore target destination overlap",
			req: ArchiveApplyRequest{Op: ArchiveOperationRestore, Restore: &ArchiveRestoreRequest{
				TargetPath:      target,
				BackupID:        "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
				DestinationRoot: filepath.Join(target, "restore"),
			}},
		},
	}

	capability := NewArchiveCapability()
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			undo, err := capability.Apply(ctx, tt.req)
			if undo != nil {
				t.Fatalf("Apply returned undo %v, want nil", undo)
			}
			var invalid *ArchiveInvalidRequestError
			if !errors.As(err, &invalid) {
				t.Fatalf("Apply error = %T %v, want ArchiveInvalidRequestError", err, err)
			}
		})
	}

	secretSource := t.TempDir()
	writeTestFile(t, filepath.Join(secretSource, "private-key.txt"), []byte("metadata name only"), 0o600)
	undo, err := capability.Apply(ctx, ArchiveApplyRequest{Op: ArchiveOperationCreate, Create: &ArchiveCreateRequest{
		TargetPath:  t.TempDir(),
		SourceRoots: &[]ArchiveSourceRoot{{Name: "agent", Path: secretSource}},
	}})
	if undo != nil {
		t.Fatalf("Apply with secret path returned undo %v, want nil", undo)
	}
	var invalid *ArchiveInvalidRequestError
	if !errors.As(err, &invalid) {
		t.Fatalf("Apply with secret path error = %T %v, want ArchiveInvalidRequestError", err, err)
	}
}

func TestArchiveApplyReportsSpecificFilesystemDiagnosticCode(t *testing.T) {
	ctx := context.Background()
	source := t.TempDir()
	targetParent := filepath.Join(t.TempDir(), "not-a-dir")
	writeTestFile(t, filepath.Join(source, "state.json"), []byte(`{"ok":true}`), 0o600)
	writeTestFile(t, targetParent, []byte("file"), 0o600)

	capability := NewArchiveCapability()
	undo, err := capability.Apply(ctx, ArchiveApplyRequest{Op: ArchiveOperationCreate, Create: &ArchiveCreateRequest{
		TargetPath:  filepath.Join(targetParent, "child"),
		SourceRoots: &[]ArchiveSourceRoot{{Name: "agent", Path: source}},
	}})
	if undo != nil {
		t.Fatalf("Apply returned undo %v, want nil", undo)
	}
	var opErr *ArchiveOperationError
	if !errors.As(err, &opErr) {
		t.Fatalf("Apply error = %T %v, want ArchiveOperationError", err, err)
	}
	if code := opErr.ApplyErrorCode(); code != "create_target_mkdir_ENOTDIR" {
		t.Fatalf("ApplyErrorCode = %q, want create_target_mkdir_ENOTDIR", code)
	}
}

func TestArchiveSourceWalkDiagnosticCodeIncludesErrnoAndPath(t *testing.T) {
	err := archiveStepPathError("create_source_walk", "/var/lib/vita/runtime/volumes/capsule.sock", os.ErrPermission)
	var opErr *ArchiveOperationError
	if !errors.As(err, &opErr) {
		t.Fatalf("archiveStepPathError = %T %v, want ArchiveOperationError", err, err)
	}
	if code := opErr.ApplyErrorCode(); code != "create_source_walk:EACCES:var_lib_vita_runtime_volumes_capsule_sock" {
		t.Fatalf("ApplyErrorCode = %q, want source walk errno and path", code)
	}
}

func TestArchiveDuplicateJSONKeysRejectedBeforeDecode(t *testing.T) {
	raw := []byte(`{"op":"create","op":"verify","create":{"targetPath":"/tmp/target","sourceRoots":[{"name":"agent","path":"/tmp/source"}]}}`)
	var req ArchiveApplyRequest
	err := json.Unmarshal(raw, &req)
	if err == nil {
		t.Fatal("Unmarshal returned nil, want duplicate-key error")
	}
	if !strings.Contains(err.Error(), "duplicate JSON object key") {
		t.Fatalf("Unmarshal error = %v, want duplicate-key rejection", err)
	}
}

func TestArchiveCapabilityRegisteredUnderClosedName(t *testing.T) {
	registry := mustRegistry(t, NewArchiveCapability())
	if _, ok := registry.Lookup(ArchiveName); !ok {
		t.Fatalf("registry missing %q", ArchiveName)
	}
	if _, ok := registry.Lookup("backup.archive.tamper"); ok {
		t.Fatal("registry accepted unknown archive capability name")
	}
	response, err := registry.Dispatch(context.Background(), ArchiveName, ArchiveReadRequest{})
	if err != nil {
		t.Fatalf("Dispatch returned error: %v", err)
	}
	if _, ok := response.(ArchiveReadResponse); !ok {
		t.Fatalf("Dispatch response = %T, want ArchiveReadResponse", response)
	}
}

func archiveCreateRequest(target string, source string) ArchiveCreateRequest {
	return ArchiveCreateRequest{
		TargetPath:  target,
		SourceRoots: &[]ArchiveSourceRoot{{Name: "agent", Path: source}},
	}
}

func restoreViaApply(ctx context.Context, capability *ArchiveCapability, target string, backupID string, destination string) (transaction.Undo, error) {
	undo, err := capability.Apply(ctx, ArchiveApplyRequest{Op: ArchiveOperationRestore, Restore: &ArchiveRestoreRequest{
		TargetPath:      target,
		BackupID:        backupID,
		DestinationRoot: destination,
	}})
	if undo == nil {
		return nil, err
	}
	return undo, errors.New("restore unexpectedly succeeded")
}

func mustLoadManifest(t *testing.T, target string, backupID string) archiveManifest {
	t.Helper()
	manifest, err := loadArchiveManifest(target, backupID)
	if err != nil {
		t.Fatalf("loadArchiveManifest returned error: %v", err)
	}
	if err := validateArchiveManifest(manifest); err != nil {
		t.Fatalf("validateArchiveManifest returned error: %v", err)
	}
	return manifest
}

func manifestEntriesByID(manifest archiveManifest) map[string]archiveManifestEntry {
	entries := make(map[string]archiveManifestEntry, len(manifest.Entries))
	for _, entry := range manifest.Entries {
		entries[manifestEntryID(entry)] = entry
	}
	return entries
}

func firstFileEntry(t *testing.T, manifest archiveManifest) archiveManifestEntry {
	t.Helper()
	for _, entry := range manifest.Entries {
		if entry.Type == "file" {
			return entry
		}
	}
	t.Fatal("manifest has no file entry")
	return archiveManifestEntry{}
}

func assertFileEntryMatchesSource(t *testing.T, entry archiveManifestEntry, sourcePath string, target string, backupID string) {
	t.Helper()
	if entry.Type != "file" {
		t.Fatalf("entry %s = %#v, want file", manifestEntryID(entry), entry)
	}
	info, err := os.Stat(sourcePath)
	if err != nil {
		t.Fatalf("stat source file: %v", err)
	}
	digest, size, err := digestFile(sourcePath)
	if err != nil {
		t.Fatalf("digestFile returned error: %v", err)
	}
	if entry.Digest != digest || entry.Size != size || entry.Mode != uint32(info.Mode().Perm()) {
		t.Fatalf("entry = %#v, want digest=%q size=%d mode=%#o", entry, digest, size, info.Mode().Perm())
	}
	objectDigest, objectSize, err := digestFile(filepath.Join(archivePath(target, backupID), archiveObjectsDirName, entry.Digest))
	if err != nil {
		t.Fatalf("digest object returned error: %v", err)
	}
	if objectDigest != entry.Digest || objectSize != entry.Size {
		t.Fatalf("object digest/size = %q/%d, want %q/%d", objectDigest, objectSize, entry.Digest, entry.Size)
	}
}

func writeTestFile(t *testing.T, path string, content []byte, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("create parent for %s: %v", path, err)
	}
	if err := os.WriteFile(path, content, mode); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatalf("chmod %s: %v", path, err)
	}
}

func mustReadFile(t *testing.T, path string) []byte {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return content
}

func mustDigestTree(t *testing.T, root string) map[string]treeDigestEntry {
	t.Helper()
	entries, err := digestTree(context.Background(), root)
	if err != nil {
		t.Fatalf("digestTree(%s) returned error: %v", root, err)
	}
	return entries
}

func assertNoRestoreTemps(t *testing.T, parent string, base string) {
	t.Helper()
	temps := restoreTemps(t, parent, base)
	if len(temps) != 0 {
		t.Fatalf("restore temp dirs = %v, want none", temps)
	}
}

func restoreTemps(t *testing.T, parent string, base string) []string {
	t.Helper()
	entries, err := os.ReadDir(parent)
	if err != nil {
		t.Fatalf("read restore parent: %v", err)
	}
	prefix := "." + base + "-restore-"
	var temps []string
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), prefix) {
			temps = append(temps, entry.Name())
		}
	}
	sort.Strings(temps)
	return temps
}
