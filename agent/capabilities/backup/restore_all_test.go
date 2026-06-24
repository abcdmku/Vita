//go:build linux

package backup

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

var errSimulatedRestoreAllCommit = errors.New("simulated restore-all commit failure")

func TestArchiveRestoreAllFreshNodeRoundTripAndUndo(t *testing.T) {
	ctx := context.Background()
	capability := NewArchiveCapability()
	target := t.TempDir()
	sources := createRestoreAllSources(t)
	destParent := t.TempDir()
	capsuleDest := filepath.Join(destParent, "runtime", "volumes")
	agentDest := filepath.Join(destParent, "vita-agent")
	if err := os.Mkdir(agentDest, 0o700); err != nil {
		t.Fatalf("create empty existing destination: %v", err)
	}
	before := mustDigestTree(t, destParent)

	created, _, err := capability.Create(ctx, ArchiveCreateRequest{
		TargetPath:  target,
		SourceRoots: &sources.roots,
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	manifest := mustLoadManifest(t, target, created.BackupID)

	result, undo, err := capability.RestoreAll(ctx, ArchiveRestoreAllRequest{
		TargetPath: target,
		BackupID:   created.BackupID,
		RootMappings: &[]RootMapping{
			{Name: "vita-agent", Path: agentDest},
			{Name: "capsule-volumes", Path: capsuleDest},
		},
	})
	if err != nil {
		t.Fatalf("RestoreAll returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("RestoreAll returned nil undo")
	}
	if result.BackupID != created.BackupID || result.Files != created.Files || result.Volumes != 2 || !result.Restored {
		t.Fatalf("RestoreAll result = %#v, want backup %q files %d volumes 2 restored", result, created.BackupID, created.Files)
	}
	assertTreeEqual(t, capsuleDest, sources.capsule)
	assertTreeEqual(t, agentDest, sources.agent)
	assertRootMatchesManifest(t, capsuleDest, "capsule-volumes", manifest)
	assertRootMatchesManifest(t, agentDest, "vita-agent", manifest)

	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
	assertPathAbsent(t, capsuleDest)
	assertDirEmpty(t, agentDest)
	if got := mustDigestTree(t, destParent); !reflect.DeepEqual(got, before) {
		t.Fatalf("destination parent after Undo = %#v, want prior %#v", got, before)
	}
	assertNoRestoreAllTemps(t, destParent)
}

func TestArchiveRestoreAllApplySetsMeasuredStatus(t *testing.T) {
	ctx := context.Background()
	capability := NewArchiveCapability()
	target := t.TempDir()
	sources := createRestoreAllSources(t)
	destParent := t.TempDir()
	capsuleDest := filepath.Join(destParent, "capsule-volumes")
	agentDest := filepath.Join(destParent, "vita-agent")

	created, _, err := capability.Create(ctx, ArchiveCreateRequest{
		TargetPath:  target,
		SourceRoots: &sources.roots,
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	undo, err := capability.Apply(ctx, ArchiveApplyRequest{
		Op: ArchiveOperationRestoreAll,
		RestoreAll: &ArchiveRestoreAllRequest{
			TargetPath: target,
			BackupID:   created.BackupID,
			RootMappings: &[]RootMapping{
				{Name: "capsule-volumes", Path: capsuleDest},
				{Name: "vita-agent", Path: agentDest},
			},
		},
	})
	if err != nil {
		t.Fatalf("Apply restore-all returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply restore-all returned nil undo")
	}
	response, err := capability.Handle(ctx, ArchiveReadRequest{})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	read, ok := response.(ArchiveReadResponse)
	if !ok || read.Last == nil {
		t.Fatalf("Handle response = %#v, want ArchiveReadResponse with last status", response)
	}
	if read.Last.Op != ArchiveOperationRestoreAll || read.Last.BackupID != created.BackupID || read.Last.Files != created.Files || !read.Last.Verified || !read.Last.Restored || read.Last.Status != "OK" {
		t.Fatalf("last status = %#v, want measured restore-all status", read.Last)
	}
	if err := undo.Undo(ctx); err != nil {
		t.Fatalf("Undo returned error: %v", err)
	}
}

func TestArchiveRestoreAllTamperRefusesBeforeMutationOrLeaks(t *testing.T) {
	ctx := context.Background()
	capability := NewArchiveCapability()
	target := t.TempDir()
	sources := createRestoreAllSources(t)
	destParent := t.TempDir()
	capsuleDest := filepath.Join(destParent, "capsule-volumes")
	agentDest := filepath.Join(destParent, "vita-agent")
	before := mustDigestTree(t, destParent)

	created, _, err := capability.Create(ctx, ArchiveCreateRequest{
		TargetPath:  target,
		SourceRoots: &sources.roots,
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	manifest := mustLoadManifest(t, target, created.BackupID)
	entry := firstFileEntry(t, manifest)
	objectPath := filepath.Join(archivePath(target, created.BackupID), archiveObjectsDirName, entry.Digest)
	content := mustReadFile(t, objectPath)
	content[0] ^= 0xff
	writeTestFile(t, objectPath, content, 0o600)

	result, undo, err := capability.RestoreAll(ctx, ArchiveRestoreAllRequest{
		TargetPath: target,
		BackupID:   created.BackupID,
		RootMappings: &[]RootMapping{
			{Name: "capsule-volumes", Path: capsuleDest},
			{Name: "vita-agent", Path: agentDest},
		},
	})
	if err == nil {
		t.Fatalf("RestoreAll result = %#v, undo = %v, want verification failure", result, undo)
	}
	if undo != nil {
		t.Fatalf("RestoreAll returned undo %v, want nil", undo)
	}
	var verifyErr *ArchiveVerificationError
	if !errors.As(err, &verifyErr) {
		t.Fatalf("RestoreAll error = %T %v, want ArchiveVerificationError", err, err)
	}
	if code := verifyErr.ApplyErrorCode(); code != "verify_digest_mismatch" {
		t.Fatalf("ApplyErrorCode = %q, want verify_digest_mismatch", code)
	}
	if got := mustDigestTree(t, destParent); !reflect.DeepEqual(got, before) {
		t.Fatalf("destination parent after refused restore-all = %#v, want unchanged %#v", got, before)
	}
	assertNoRestoreAllTemps(t, destParent)
}

func TestArchiveRestoreAllRollsBackCommittedRootsOnLaterCommitFailure(t *testing.T) {
	ctx := context.Background()
	capability := NewArchiveCapability()
	target := t.TempDir()
	sources := createRestoreAllSources(t)
	destParent := t.TempDir()
	capsuleDest := filepath.Join(destParent, "capsule-volumes")
	agentDest := filepath.Join(destParent, "vita-agent")
	before := mustDigestTree(t, destParent)

	created, _, err := capability.Create(ctx, ArchiveCreateRequest{
		TargetPath:  target,
		SourceRoots: &sources.roots,
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}

	realCommit := restoreAllCommitRoot
	restoreAllCommitRoot = func(ctx context.Context, rootName string, stagedRoot string, destination string) (archiveRestoreUndo, error) {
		if rootName == "vita-agent" {
			return archiveRestoreUndo{}, errSimulatedRestoreAllCommit
		}
		return realCommit(ctx, rootName, stagedRoot, destination)
	}
	defer func() {
		restoreAllCommitRoot = realCommit
	}()

	result, undo, err := capability.RestoreAll(ctx, ArchiveRestoreAllRequest{
		TargetPath: target,
		BackupID:   created.BackupID,
		RootMappings: &[]RootMapping{
			{Name: "capsule-volumes", Path: capsuleDest},
			{Name: "vita-agent", Path: agentDest},
		},
	})
	if err == nil {
		t.Fatalf("RestoreAll result = %#v, undo = %v, want simulated commit failure", result, undo)
	}
	if undo != nil {
		t.Fatalf("RestoreAll returned undo %v, want nil", undo)
	}
	if !errors.Is(err, errSimulatedRestoreAllCommit) {
		t.Fatalf("RestoreAll error = %v, want simulated commit failure", err)
	}
	if got := mustDigestTree(t, destParent); !reflect.DeepEqual(got, before) {
		t.Fatalf("destination parent after rolled-back restore-all = %#v, want unchanged %#v", got, before)
	}
	assertNoRestoreAllTemps(t, destParent)
}

func TestArchiveRestoreAllFreshNodePreconditionRejectsNonEmptyDestination(t *testing.T) {
	ctx := context.Background()
	capability := NewArchiveCapability()
	target := t.TempDir()
	sources := createRestoreAllSources(t)
	destParent := t.TempDir()
	capsuleDest := filepath.Join(destParent, "capsule-volumes")
	agentDest := filepath.Join(destParent, "vita-agent")
	writeTestFile(t, filepath.Join(capsuleDest, "live.txt"), []byte("live"), 0o600)
	before := mustDigestTree(t, destParent)

	created, _, err := capability.Create(ctx, ArchiveCreateRequest{
		TargetPath:  target,
		SourceRoots: &sources.roots,
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	result, undo, err := capability.RestoreAll(ctx, ArchiveRestoreAllRequest{
		TargetPath: target,
		BackupID:   created.BackupID,
		RootMappings: &[]RootMapping{
			{Name: "capsule-volumes", Path: capsuleDest},
			{Name: "vita-agent", Path: agentDest},
		},
	})
	if err == nil {
		t.Fatalf("RestoreAll result = %#v, undo = %v, want fresh-node rejection", result, undo)
	}
	if undo != nil {
		t.Fatalf("RestoreAll returned undo %v, want nil", undo)
	}
	var invalid *ArchiveInvalidRequestError
	if !errors.As(err, &invalid) {
		t.Fatalf("RestoreAll error = %T %v, want ArchiveInvalidRequestError", err, err)
	}
	if invalid.Reason != "restore_all_destination_not_empty:capsule-volumes" {
		t.Fatalf("invalid reason = %q, want restore_all_destination_not_empty:capsule-volumes", invalid.Reason)
	}
	if got := mustDigestTree(t, destParent); !reflect.DeepEqual(got, before) {
		t.Fatalf("destination parent after fresh-node rejection = %#v, want unchanged %#v", got, before)
	}
}

func TestArchiveRestoreAllMappingCoverageAndDefaultMapping(t *testing.T) {
	ctx := context.Background()
	capability := NewArchiveCapability()
	target := t.TempDir()
	sources := createRestoreAllSources(t)
	destParent := t.TempDir()
	validDigest := "sha256:" + strings.Repeat("A", 43)

	normalized, err := normalizeArchiveRestoreAllRequest(ArchiveRestoreAllRequest{
		TargetPath: filepath.Join(t.TempDir(), "backup-store"),
		BackupID:   validDigest,
	})
	if err != nil {
		t.Fatalf("normalizeArchiveRestoreAllRequest default mapping returned error: %v", err)
	}
	if got := *normalized.RootMappings; !reflect.DeepEqual(got, defaultRestoreAllRootMappings()) {
		t.Fatalf("default rootMappings = %#v, want canonical restore-all roots", got)
	}

	created, _, err := capability.Create(ctx, ArchiveCreateRequest{
		TargetPath:  target,
		SourceRoots: &sources.roots,
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}

	tests := []struct {
		name     string
		mappings []RootMapping
		want     string
	}{
		{
			name: "missing manifest root",
			mappings: []RootMapping{
				{Name: "capsule-volumes", Path: filepath.Join(destParent, "capsule-volumes")},
			},
			want: "rootMappings missing manifest root",
		},
		{
			name: "unknown extra root",
			mappings: []RootMapping{
				{Name: "capsule-volumes", Path: filepath.Join(destParent, "capsule-volumes")},
				{Name: "extra-root", Path: filepath.Join(destParent, "extra-root")},
				{Name: "vita-agent", Path: filepath.Join(destParent, "vita-agent")},
			},
			want: "rootMappings contains unknown root",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, undo, err := capability.RestoreAll(ctx, ArchiveRestoreAllRequest{
				TargetPath:   target,
				BackupID:     created.BackupID,
				RootMappings: &tt.mappings,
			})
			if err == nil {
				t.Fatalf("RestoreAll result = %#v, undo = %v, want coverage rejection", result, undo)
			}
			if undo != nil {
				t.Fatalf("RestoreAll returned undo %v, want nil", undo)
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("RestoreAll error = %v, want %q", err, tt.want)
			}
		})
	}

	otherSourceA := filepath.Join(t.TempDir(), "alpha")
	otherSourceB := filepath.Join(t.TempDir(), "beta")
	writeTestFile(t, filepath.Join(otherSourceA, "state.txt"), []byte("alpha"), 0o600)
	writeTestFile(t, filepath.Join(otherSourceB, "state.txt"), []byte("beta"), 0o600)
	otherCreated, _, err := capability.Create(ctx, ArchiveCreateRequest{
		TargetPath: target,
		SourceRoots: &[]ArchiveSourceRoot{
			{Name: "alpha", Path: otherSourceA},
			{Name: "beta", Path: otherSourceB},
		},
	})
	if err != nil {
		t.Fatalf("Create noncanonical backup returned error: %v", err)
	}
	result, undo, err := capability.RestoreAll(ctx, ArchiveRestoreAllRequest{
		TargetPath: target,
		BackupID:   otherCreated.BackupID,
	})
	if err == nil {
		t.Fatalf("RestoreAll default mapping result = %#v, undo = %v, want noncanonical manifest rejection", result, undo)
	}
	if undo != nil {
		t.Fatalf("RestoreAll default mapping returned undo %v, want nil", undo)
	}
	if !strings.Contains(err.Error(), "rootMappings contains unknown root") && !strings.Contains(err.Error(), "rootMappings missing manifest root") {
		t.Fatalf("RestoreAll default mapping error = %v, want exact-coverage rejection", err)
	}
}

func TestArchiveRestoreAllFailClosedInputHandling(t *testing.T) {
	ctx := context.Background()
	capability := NewArchiveCapability()
	target := filepath.Join(t.TempDir(), "backup-store")
	destination := filepath.Join(t.TempDir(), "restore")
	validDigest := "sha256:" + strings.Repeat("A", 43)
	validMappings := []RootMapping{
		{Name: "capsule-volumes", Path: filepath.Join(destination, "capsule-volumes")},
		{Name: "vita-agent", Path: filepath.Join(destination, "vita-agent")},
	}

	tests := []struct {
		name string
		req  ArchiveApplyRequest
	}{
		{
			name: "missing required fields",
			req:  ArchiveApplyRequest{Op: ArchiveOperationRestoreAll, RestoreAll: &ArchiveRestoreAllRequest{}},
		},
		{
			name: "non absolute target",
			req: ArchiveApplyRequest{Op: ArchiveOperationRestoreAll, RestoreAll: &ArchiveRestoreAllRequest{
				TargetPath:   "relative",
				BackupID:     validDigest,
				RootMappings: &validMappings,
			}},
		},
		{
			name: "filesystem root target",
			req: ArchiveApplyRequest{Op: ArchiveOperationRestoreAll, RestoreAll: &ArchiveRestoreAllRequest{
				TargetPath:   string(filepath.Separator),
				BackupID:     validDigest,
				RootMappings: &validMappings,
			}},
		},
		{
			name: "filesystem root destination",
			req: ArchiveApplyRequest{Op: ArchiveOperationRestoreAll, RestoreAll: &ArchiveRestoreAllRequest{
				TargetPath: target,
				BackupID:   validDigest,
				RootMappings: &[]RootMapping{
					{Name: "capsule-volumes", Path: string(filepath.Separator)},
					{Name: "vita-agent", Path: filepath.Join(destination, "vita-agent")},
				},
			}},
		},
		{
			name: "control char destination",
			req: ArchiveApplyRequest{Op: ArchiveOperationRestoreAll, RestoreAll: &ArchiveRestoreAllRequest{
				TargetPath: target,
				BackupID:   validDigest,
				RootMappings: &[]RootMapping{
					{Name: "capsule-volumes", Path: filepath.Join(destination, "bad\npath")},
					{Name: "vita-agent", Path: filepath.Join(destination, "vita-agent")},
				},
			}},
		},
		{
			name: "inline secret destination",
			req: ArchiveApplyRequest{Op: ArchiveOperationRestoreAll, RestoreAll: &ArchiveRestoreAllRequest{
				TargetPath: target,
				BackupID:   validDigest,
				RootMappings: &[]RootMapping{
					{Name: "capsule-volumes", Path: filepath.Join(destination, "private-key")},
					{Name: "vita-agent", Path: filepath.Join(destination, "vita-agent")},
				},
			}},
		},
		{
			name: "target destination overlap",
			req: ArchiveApplyRequest{Op: ArchiveOperationRestoreAll, RestoreAll: &ArchiveRestoreAllRequest{
				TargetPath: target,
				BackupID:   validDigest,
				RootMappings: &[]RootMapping{
					{Name: "capsule-volumes", Path: filepath.Join(target, "capsule-volumes")},
					{Name: "vita-agent", Path: filepath.Join(destination, "vita-agent")},
				},
			}},
		},
		{
			name: "overlapping destinations",
			req: ArchiveApplyRequest{Op: ArchiveOperationRestoreAll, RestoreAll: &ArchiveRestoreAllRequest{
				TargetPath: target,
				BackupID:   validDigest,
				RootMappings: &[]RootMapping{
					{Name: "capsule-volumes", Path: filepath.Join(destination, "root")},
					{Name: "vita-agent", Path: filepath.Join(destination, "root", "child")},
				},
			}},
		},
		{
			name: "explicit empty mappings",
			req: ArchiveApplyRequest{Op: ArchiveOperationRestoreAll, RestoreAll: &ArchiveRestoreAllRequest{
				TargetPath:   target,
				BackupID:     validDigest,
				RootMappings: &[]RootMapping{},
			}},
		},
		{
			name: "restore-all op with wrong arm",
			req: ArchiveApplyRequest{Op: ArchiveOperationRestoreAll, Verify: &ArchiveVerifyRequest{
				TargetPath: target,
				BackupID:   validDigest,
			}},
		},
		{
			name: "unknown op",
			req: ArchiveApplyRequest{Op: ArchiveOperation("restore-everything"), RestoreAll: &ArchiveRestoreAllRequest{
				TargetPath:   target,
				BackupID:     validDigest,
				RootMappings: &validMappings,
			}},
		},
	}

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

	raw := []byte(`{"op":"restore-all","restoreAll":{"targetPath":"/tmp/target","backupId":"sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","backupId":"sha256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB","rootMappings":[{"name":"capsule-volumes","path":"/tmp/capsule"},{"name":"vita-agent","path":"/tmp/agent"}]}}`)
	var req ArchiveApplyRequest
	err := json.Unmarshal(raw, &req)
	if err == nil {
		t.Fatal("Unmarshal returned nil, want duplicate-key error")
	}
	if !strings.Contains(err.Error(), "duplicate JSON object key") {
		t.Fatalf("Unmarshal error = %v, want duplicate-key rejection", err)
	}
}

func TestArchiveVerifyRestoredConfirmsRestoredRootsHashMatchManifest(t *testing.T) {
	ctx := context.Background()
	capability := NewArchiveCapability()
	target := t.TempDir()
	sources := createRestoreAllSources(t)
	destParent := t.TempDir()
	capsuleDest := filepath.Join(destParent, "capsule-volumes")
	agentDest := filepath.Join(destParent, "vita-agent")
	mappings := []RootMapping{
		{Name: "capsule-volumes", Path: capsuleDest},
		{Name: "vita-agent", Path: agentDest},
	}

	created, _, err := capability.Create(ctx, ArchiveCreateRequest{
		TargetPath:  target,
		SourceRoots: &sources.roots,
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if _, _, err := capability.RestoreAll(ctx, ArchiveRestoreAllRequest{
		TargetPath:   target,
		BackupID:     created.BackupID,
		RootMappings: &mappings,
	}); err != nil {
		t.Fatalf("RestoreAll returned error: %v", err)
	}

	result, err := capability.VerifyRestored(ctx, ArchiveVerifyRestoredRequest{
		TargetPath:   target,
		BackupID:     created.BackupID,
		RootMappings: &mappings,
	})
	if err != nil {
		t.Fatalf("VerifyRestored returned error: %v", err)
	}
	if result.BackupID != created.BackupID || result.Files != created.Files || result.Volumes != 2 || !result.Verified {
		t.Fatalf("VerifyRestored result = %#v, want backup %q files %d volumes 2 verified", result, created.BackupID, created.Files)
	}

	// The Apply path must surface a MEASURED verify-restored status the marker
	// driver reads (verified + volumes count).
	undo, err := capability.Apply(ctx, ArchiveApplyRequest{
		Op: ArchiveOperationVerifyRestored,
		VerifyRestored: &ArchiveVerifyRestoredRequest{
			TargetPath:   target,
			BackupID:     created.BackupID,
			RootMappings: &mappings,
		},
	})
	if err != nil {
		t.Fatalf("Apply verify-restored returned error: %v", err)
	}
	if undo == nil {
		t.Fatal("Apply verify-restored returned nil undo")
	}
	response, err := capability.Handle(ctx, ArchiveReadRequest{})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	read, ok := response.(ArchiveReadResponse)
	if !ok || read.Last == nil {
		t.Fatalf("Handle response = %#v, want ArchiveReadResponse with last status", response)
	}
	if read.Last.Op != ArchiveOperationVerifyRestored || read.Last.BackupID != created.BackupID ||
		read.Last.Files != created.Files || read.Last.Volumes != 2 || !read.Last.Verified ||
		!read.Last.Restored || read.Last.Status != "OK" {
		t.Fatalf("last status = %#v, want measured verify-restored status", read.Last)
	}
}

func TestArchiveVerifyRestoredRefusesTamperedDestination(t *testing.T) {
	ctx := context.Background()
	capability := NewArchiveCapability()
	target := t.TempDir()
	sources := createRestoreAllSources(t)
	destParent := t.TempDir()
	capsuleDest := filepath.Join(destParent, "capsule-volumes")
	agentDest := filepath.Join(destParent, "vita-agent")
	mappings := []RootMapping{
		{Name: "capsule-volumes", Path: capsuleDest},
		{Name: "vita-agent", Path: agentDest},
	}

	created, _, err := capability.Create(ctx, ArchiveCreateRequest{
		TargetPath:  target,
		SourceRoots: &sources.roots,
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if _, _, err := capability.RestoreAll(ctx, ArchiveRestoreAllRequest{
		TargetPath:   target,
		BackupID:     created.BackupID,
		RootMappings: &mappings,
	}); err != nil {
		t.Fatalf("RestoreAll returned error: %v", err)
	}

	// Mutate a restored destination byte AFTER the restore committed: a status
	// field would still read "restored=true", but a MEASURED re-hash of the
	// destination must detect the divergence and REFUSE.
	tamperedFile := filepath.Join(agentDest, "node-config.env")
	content := mustReadFile(t, tamperedFile)
	content[0] ^= 0xff
	writeTestFile(t, tamperedFile, content, 0o600)

	if _, err := capability.VerifyRestored(ctx, ArchiveVerifyRestoredRequest{
		TargetPath:   target,
		BackupID:     created.BackupID,
		RootMappings: &mappings,
	}); err == nil {
		t.Fatal("VerifyRestored returned nil error for tampered destination, want refusal")
	} else {
		var verifyErr *ArchiveVerificationError
		if !errors.As(err, &verifyErr) {
			t.Fatalf("VerifyRestored error = %T %v, want ArchiveVerificationError", err, err)
		}
		if verifyErr.Failure.Entry != "vita-agent" {
			t.Fatalf("verification failure entry = %q, want vita-agent", verifyErr.Failure.Entry)
		}
	}
}

func TestArchiveVerifyRestoredRefusesMissingDestination(t *testing.T) {
	ctx := context.Background()
	capability := NewArchiveCapability()
	target := t.TempDir()
	sources := createRestoreAllSources(t)
	destParent := t.TempDir()
	capsuleDest := filepath.Join(destParent, "capsule-volumes")
	agentDest := filepath.Join(destParent, "vita-agent")
	mappings := []RootMapping{
		{Name: "capsule-volumes", Path: capsuleDest},
		{Name: "vita-agent", Path: agentDest},
	}

	created, _, err := capability.Create(ctx, ArchiveCreateRequest{
		TargetPath:  target,
		SourceRoots: &sources.roots,
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	// Only restore one root; the other destination is absent. A no-op verify
	// would pass; a MEASURED verify must refuse because not every root matches.
	if _, _, err := capability.RestoreAll(ctx, ArchiveRestoreAllRequest{
		TargetPath: target,
		BackupID:   created.BackupID,
		RootMappings: &[]RootMapping{
			{Name: "capsule-volumes", Path: capsuleDest},
		},
	}); err == nil {
		t.Fatal("RestoreAll with partial mapping returned nil error, want mapping totality refusal")
	}

	if _, err := capability.VerifyRestored(ctx, ArchiveVerifyRestoredRequest{
		TargetPath:   target,
		BackupID:     created.BackupID,
		RootMappings: &mappings,
	}); err == nil {
		t.Fatal("VerifyRestored returned nil error for absent destination, want refusal")
	} else {
		var verifyErr *ArchiveVerificationError
		if !errors.As(err, &verifyErr) {
			t.Fatalf("VerifyRestored error = %T %v, want ArchiveVerificationError", err, err)
		}
	}
}

func TestArchiveVerifyRestoredFailsClosedOnInvalidRequest(t *testing.T) {
	ctx := context.Background()
	capability := NewArchiveCapability()
	cases := []struct {
		name string
		req  ArchiveVerifyRestoredRequest
	}{
		{
			name: "relative target",
			req:  ArchiveVerifyRestoredRequest{TargetPath: "relative", BackupID: "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},
		},
		{
			name: "missing backup id",
			req:  ArchiveVerifyRestoredRequest{TargetPath: "/tmp/target"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := capability.VerifyRestored(ctx, tc.req); err == nil {
				t.Fatal("VerifyRestored returned nil error, want rejection")
			} else {
				var invalid *ArchiveInvalidRequestError
				if !errors.As(err, &invalid) {
					t.Fatalf("VerifyRestored error = %T %v, want ArchiveInvalidRequestError", err, err)
				}
			}
		})
	}
}

type restoreAllSources struct {
	roots   []ArchiveSourceRoot
	capsule string
	agent   string
}

func createRestoreAllSources(t *testing.T) restoreAllSources {
	t.Helper()
	parent := t.TempDir()
	capsule := filepath.Join(parent, "capsule-volumes")
	agent := filepath.Join(parent, "vita-agent")
	writeTestFile(t, filepath.Join(capsule, "capsule-a", "state.bin"), []byte{0x01, 0x02, 0x03}, 0o640)
	writeTestFile(t, filepath.Join(capsule, "capsule-b", "nested", "state.json"), []byte(`{"ready":true}`+"\n"), 0o600)
	if err := os.MkdirAll(filepath.Join(capsule, "empty"), 0o700); err != nil {
		t.Fatalf("create capsule empty dir: %v", err)
	}
	if err := os.Chmod(filepath.Join(capsule, "empty"), 0o700); err != nil {
		t.Fatalf("chmod capsule empty dir: %v", err)
	}
	writeTestFile(t, filepath.Join(agent, "pds-sync-state.json"), []byte(`{"cursor":"abc"}`+"\n"), 0o600)
	writeTestFile(t, filepath.Join(agent, "node-config.env"), []byte("VITA_MODE=normal\n"), 0o600)
	return restoreAllSources{
		roots: []ArchiveSourceRoot{
			{Name: "capsule-volumes", Path: capsule},
			{Name: "vita-agent", Path: agent},
		},
		capsule: capsule,
		agent:   agent,
	}
}

func assertTreeEqual(t *testing.T, gotRoot string, wantRoot string) {
	t.Helper()
	got := mustDigestTree(t, gotRoot)
	want := mustDigestTree(t, wantRoot)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("tree %s = %#v, want source %s %#v", gotRoot, got, wantRoot, want)
	}
}

func assertRootMatchesManifest(t *testing.T, destination string, rootName string, manifest archiveManifest) {
	t.Helper()
	ok, err := rootMatchesManifest(destination, rootName, manifest)
	if err != nil {
		t.Fatalf("rootMatchesManifest returned error: %v", err)
	}
	if !ok {
		t.Fatalf("root %s at %s does not match manifest", rootName, destination)
	}
}

func assertDirEmpty(t *testing.T, path string) {
	t.Helper()
	entries, err := os.ReadDir(path)
	if err != nil {
		t.Fatalf("read dir %s: %v", path, err)
	}
	if len(entries) != 0 {
		t.Fatalf("dir %s entries = %v, want empty", path, entries)
	}
}

func assertPathAbsent(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Lstat(path); err == nil {
		t.Fatalf("path %s exists, want absent", path)
	} else if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stat %s: %v", path, err)
	}
}

func assertNoRestoreAllTemps(t *testing.T, parent string) {
	t.Helper()
	temps := restoreAllTemps(t, parent)
	if len(temps) != 0 {
		t.Fatalf("restore-all temp dirs = %v, want none", temps)
	}
}

func restoreAllTemps(t *testing.T, parent string) []string {
	t.Helper()
	entries, err := os.ReadDir(parent)
	if err != nil {
		t.Fatalf("read restore-all parent: %v", err)
	}
	var temps []string
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".restore-all-") {
			temps = append(temps, entry.Name())
		}
	}
	sort.Strings(temps)
	return temps
}
