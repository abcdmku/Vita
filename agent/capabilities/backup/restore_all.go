//go:build linux

package backup

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"

	"github.com/vita/agent/transaction"
)

type RootMapping struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type ArchiveRestoreAllRequest struct {
	TargetPath   string         `json:"targetPath"`
	BackupID     string         `json:"backupId"`
	RootMappings *[]RootMapping `json:"rootMappings,omitempty"`
}

type ArchiveRestoreAllResult struct {
	BackupID string `json:"backupId"`
	Files    int    `json:"files"`
	Volumes  int    `json:"volumes"`
	Restored bool   `json:"restored"`
}

// ArchiveVerifyRestoredRequest re-reads each already-restored destination root
// and proves its bytes hash-match the manifest. It is the MEASURED gate for the
// VITA-RESTORE-FULL marker: the marker is emitted only after this op confirms
// every mapped root's destination contents match the manifest per-entry digests
// — never from a status field alone.
type ArchiveVerifyRestoredRequest struct {
	TargetPath   string         `json:"targetPath"`
	BackupID     string         `json:"backupId"`
	RootMappings *[]RootMapping `json:"rootMappings,omitempty"`
}

// ArchiveVerifyRestoredResult reports the MEASURED outcome: Volumes is the count
// of roots whose destination bytes actually hash-matched the manifest. Verified
// is true only when every mapped root matched.
type ArchiveVerifyRestoredResult struct {
	BackupID string `json:"backupId"`
	Files    int    `json:"files"`
	Volumes  int    `json:"volumes"`
	Verified bool   `json:"verified"`
}

func normalizeArchiveVerifyRestoredRequest(req ArchiveVerifyRestoredRequest) (ArchiveVerifyRestoredRequest, error) {
	normalized, err := normalizeArchiveRestoreAllRequest(ArchiveRestoreAllRequest{
		TargetPath:   req.TargetPath,
		BackupID:     req.BackupID,
		RootMappings: req.RootMappings,
	})
	if err != nil {
		return ArchiveVerifyRestoredRequest{}, err
	}
	return ArchiveVerifyRestoredRequest{
		TargetPath:   normalized.TargetPath,
		BackupID:     normalized.BackupID,
		RootMappings: normalized.RootMappings,
	}, nil
}

// verifyRestoredArchive independently re-hashes the restored destinations against
// the manifest. It is READ-ONLY (mutates nothing) and fail-CLOSED: the backup
// store is re-verified first (content + manifest digest + backup-id), the mapping
// must exactly cover the manifest roots, and EVERY mapped destination must
// byte-match the manifest (per-entry digests via rootMatchesManifest). Any
// mismatch or unreadable destination is reported as a verification failure so the
// caller cannot emit a MEASURED success marker without proven hash-match.
func verifyRestoredArchive(ctx context.Context, req ArchiveVerifyRestoredRequest) (ArchiveVerifyRestoredResult, error) {
	normalized, err := normalizeArchiveVerifyRestoredRequest(req)
	if err != nil {
		return ArchiveVerifyRestoredResult{}, err
	}
	if err := ctx.Err(); err != nil {
		return ArchiveVerifyRestoredResult{}, err
	}
	verify, manifest, err := verifyArchive(ctx, normalized.TargetPath, normalized.BackupID)
	if err != nil {
		return ArchiveVerifyRestoredResult{}, err
	}
	if !verify.OK {
		return ArchiveVerifyRestoredResult{}, &ArchiveVerificationError{Failure: *verify.Failure}
	}

	mappings, err := restoreAllMappingsForManifest(*normalized.RootMappings, manifest)
	if err != nil {
		return ArchiveVerifyRestoredResult{}, err
	}

	matched := 0
	for _, mapping := range mappings {
		if err := ctx.Err(); err != nil {
			return ArchiveVerifyRestoredResult{}, err
		}
		ok, err := rootMatchesManifest(mapping.Path, mapping.Name, manifest)
		if err != nil {
			return ArchiveVerifyRestoredResult{}, archiveStepError("verify_restored_root_check", err)
		}
		if !ok {
			return ArchiveVerifyRestoredResult{}, &ArchiveVerificationError{Failure: ArchiveVerificationFailure{
				Entry:  mapping.Name,
				Reason: "restored root content does not match manifest",
			}}
		}
		matched++
	}

	if matched != len(manifest.Roots) {
		return ArchiveVerifyRestoredResult{}, &ArchiveVerificationError{Failure: ArchiveVerificationFailure{
			Entry:  "roots",
			Reason: "restored root count does not match manifest",
		}}
	}

	return ArchiveVerifyRestoredResult{
		BackupID: manifest.Digest,
		Files:    verify.Files,
		Volumes:  matched,
		Verified: true,
	}, nil
}

type archiveRestoreAllUndo struct {
	undos          []archiveRestoreUndo
	stage          string
	createdParents []string
}

func (u archiveRestoreAllUndo) Undo(ctx context.Context) error {
	var rollbackErr error
	for i := len(u.undos) - 1; i >= 0; i-- {
		if err := u.undos[i].Undo(ctx); err != nil {
			rollbackErr = errors.Join(rollbackErr, err)
		}
	}
	if u.stage != "" {
		if err := os.RemoveAll(u.stage); err != nil {
			rollbackErr = errors.Join(rollbackErr, fmt.Errorf("remove restore-all staging tree: %w", err))
		}
	}
	cleanupRestoreAllParents(u.createdParents)
	return rollbackErr
}

var restoreAllCommitRoot = commitRestoreAllRoot

func restoreAllArchive(ctx context.Context, req ArchiveRestoreAllRequest) (ArchiveRestoreAllResult, transaction.Undo, error) {
	normalized, err := normalizeArchiveRestoreAllRequest(req)
	if err != nil {
		return ArchiveRestoreAllResult{}, nil, err
	}
	verify, manifest, err := verifyArchive(ctx, normalized.TargetPath, normalized.BackupID)
	if err != nil {
		return ArchiveRestoreAllResult{}, nil, err
	}
	if !verify.OK {
		return ArchiveRestoreAllResult{}, nil, &ArchiveVerificationError{Failure: *verify.Failure}
	}

	mappings, err := restoreAllMappingsForManifest(*normalized.RootMappings, manifest)
	if err != nil {
		return ArchiveRestoreAllResult{}, nil, err
	}
	volumes := len(manifest.Roots)

	allMatched, err := restoreAllDestinationsMatchManifest(mappings, manifest)
	if err != nil {
		return ArchiveRestoreAllResult{}, nil, archiveStepError("restore_all_destination_check", err)
	}
	if allMatched {
		return ArchiveRestoreAllResult{BackupID: manifest.Digest, Files: verify.Files, Volumes: volumes, Restored: true}, archiveUndo{}, nil
	}

	if err := requireRestoreAllFreshDestinations(mappings); err != nil {
		return ArchiveRestoreAllResult{}, nil, err
	}
	createdParents, err := prepareRestoreAllParents(mappings)
	if err != nil {
		return ArchiveRestoreAllResult{}, nil, err
	}
	cleanupParents := true
	defer func() {
		if cleanupParents {
			cleanupRestoreAllParents(createdParents)
		}
	}()

	stageParent := filepath.Dir(mappings[0].Path)
	stage, err := os.MkdirTemp(stageParent, ".restore-all-*.tmp")
	if err != nil {
		return ArchiveRestoreAllResult{}, nil, archiveStepError("restore_all_stage_mkdir", err)
	}
	cleanupStage := true
	defer func() {
		if cleanupStage {
			_ = os.RemoveAll(stage)
		}
	}()
	if err := os.Chmod(stage, archiveDirMode); err != nil {
		return ArchiveRestoreAllResult{}, nil, archiveStepError("restore_all_stage_chmod", err)
	}

	if err := materializeArchive(ctx, archivePath(normalized.TargetPath, normalized.BackupID), manifest, stage); err != nil {
		return ArchiveRestoreAllResult{}, nil, archiveStepError("restore_all_materialize", err)
	}
	if ok, err := treeMatchesManifest(stage, manifest); err != nil {
		return ArchiveRestoreAllResult{}, nil, archiveStepError("restore_all_compare", err)
	} else if !ok {
		return ArchiveRestoreAllResult{}, nil, archiveStepError("restore_all_compare", errTreeMismatch)
	}
	if err := syncTreeDirs(stage); err != nil {
		return ArchiveRestoreAllResult{}, nil, archiveStepError("restore_all_stage_sync", err)
	}

	undos := make([]archiveRestoreUndo, 0, len(mappings))
	for _, mapping := range mappings {
		undo, err := restoreAllCommitRoot(ctx, mapping.Name, filepath.Join(stage, mapping.Name), mapping.Path)
		if err != nil {
			rollbackErr := (archiveRestoreAllUndo{undos: undos, stage: stage}).Undo(ctx)
			cleanupStage = false
			if rollbackErr != nil {
				return ArchiveRestoreAllResult{}, nil, archiveStepError("restore_all_rollback", errors.Join(err, rollbackErr))
			}
			return ArchiveRestoreAllResult{}, nil, err
		}
		undos = append(undos, undo)
	}

	cleanupStage = false
	cleanupParents = false
	return ArchiveRestoreAllResult{BackupID: manifest.Digest, Files: verify.Files, Volumes: volumes, Restored: true}, archiveRestoreAllUndo{
		undos:          undos,
		stage:          stage,
		createdParents: createdParents,
	}, nil
}

func normalizeArchiveRestoreAllRequest(req ArchiveRestoreAllRequest) (ArchiveRestoreAllRequest, error) {
	target, err := normalizeAbsolutePath(req.TargetPath, "targetPath")
	if err != nil {
		return ArchiveRestoreAllRequest{}, err
	}
	backupID, err := normalizeDigestToken(req.BackupID, "backupId")
	if err != nil {
		return ArchiveRestoreAllRequest{}, err
	}
	mappings, err := normalizeRestoreAllRootMappings(req.RootMappings)
	if err != nil {
		return ArchiveRestoreAllRequest{}, err
	}
	for i, mapping := range mappings {
		if pathsOverlap(target, mapping.Path) {
			return ArchiveRestoreAllRequest{}, archiveInvalid(fmt.Sprintf("targetPath must be independent from rootMappings[%d].path", i))
		}
	}

	return ArchiveRestoreAllRequest{
		TargetPath:   target,
		BackupID:     backupID,
		RootMappings: &mappings,
	}, nil
}

func normalizeRestoreAllRootMappings(input *[]RootMapping) ([]RootMapping, error) {
	mappings := input
	if mappings == nil {
		defaults := defaultRestoreAllRootMappings()
		mappings = &defaults
	}
	if len(*mappings) == 0 {
		return nil, archiveInvalid("rootMappings must contain at least one root mapping")
	}

	normalized := make([]RootMapping, len(*mappings))
	seenNames := make(map[string]int, len(*mappings))
	seenPaths := make(map[string]int, len(*mappings))
	for i, mapping := range *mappings {
		name, err := normalizeArchiveRootName(mapping.Name, fmt.Sprintf("rootMappings[%d].name", i))
		if err != nil {
			return nil, err
		}
		path, err := normalizeAbsolutePath(mapping.Path, fmt.Sprintf("rootMappings[%d].path", i))
		if err != nil {
			return nil, err
		}
		if previous, ok := seenNames[name]; ok {
			return nil, archiveInvalid(fmt.Sprintf("rootMappings[%d].name duplicates rootMappings[%d].name", i, previous))
		}
		if previous, ok := seenPaths[path]; ok {
			return nil, archiveInvalid(fmt.Sprintf("rootMappings[%d].path duplicates rootMappings[%d].path", i, previous))
		}
		seenNames[name] = i
		seenPaths[path] = i
		normalized[i] = RootMapping{Name: name, Path: path}
	}

	for i := 0; i < len(normalized); i++ {
		for j := i + 1; j < len(normalized); j++ {
			if pathsOverlap(normalized[i].Path, normalized[j].Path) {
				return nil, archiveInvalid(fmt.Sprintf("rootMappings[%d].path overlaps rootMappings[%d].path", i, j))
			}
		}
	}

	sort.Slice(normalized, func(i, j int) bool {
		return normalized[i].Name < normalized[j].Name
	})
	return normalized, nil
}

func defaultRestoreAllRootMappings() []RootMapping {
	return []RootMapping{
		{Name: "capsule-volumes", Path: defaultArchiveCapsuleVolumesRoot},
		{Name: "vita-agent", Path: defaultStateRoot},
	}
}

func restoreAllMappingsForManifest(mappings []RootMapping, manifest archiveManifest) ([]RootMapping, error) {
	expected := make(map[string]struct{}, len(manifest.Roots))
	for _, root := range manifest.Roots {
		expected[root.Name] = struct{}{}
	}

	byName := make(map[string]RootMapping, len(mappings))
	for _, mapping := range mappings {
		if _, ok := expected[mapping.Name]; !ok {
			return nil, archiveInvalid(fmt.Sprintf("rootMappings contains unknown root %q", mapping.Name))
		}
		byName[mapping.Name] = mapping
	}

	ordered := make([]RootMapping, 0, len(manifest.Roots))
	for _, root := range manifest.Roots {
		mapping, ok := byName[root.Name]
		if !ok {
			return nil, archiveInvalid(fmt.Sprintf("rootMappings missing manifest root %q", root.Name))
		}
		ordered = append(ordered, mapping)
	}
	if len(ordered) != len(mappings) {
		return nil, archiveInvalid("rootMappings must exactly cover manifest roots")
	}
	sort.Slice(ordered, func(i, j int) bool {
		return ordered[i].Name < ordered[j].Name
	})
	return ordered, nil
}

func restoreAllDestinationsMatchManifest(mappings []RootMapping, manifest archiveManifest) (bool, error) {
	for _, mapping := range mappings {
		ok, err := rootMatchesManifest(mapping.Path, mapping.Name, manifest)
		if err != nil {
			return false, err
		}
		if !ok {
			return false, nil
		}
	}
	return true, nil
}

func requireRestoreAllFreshDestinations(mappings []RootMapping) error {
	for _, mapping := range mappings {
		empty, err := restoreAllDestinationAbsentOrEmpty(mapping.Path)
		if err != nil {
			return archiveStepError("restore_all_destination_check", err)
		}
		if !empty {
			return restoreAllDestinationNotEmpty(mapping.Name)
		}
	}
	return nil
}

func restoreAllDestinationAbsentOrEmpty(path string) (bool, error) {
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return true, nil
		}
		return false, fmt.Errorf("stat restore-all destination: %w", err)
	}
	if !info.IsDir() {
		return false, nil
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return false, fmt.Errorf("read restore-all destination: %w", err)
	}
	return len(entries) == 0, nil
}

func prepareRestoreAllParents(mappings []RootMapping) ([]string, error) {
	missing := make(map[string]struct{})
	for _, mapping := range mappings {
		dirs, err := restoreAllMissingDirs(filepath.Dir(mapping.Path))
		if err != nil {
			return nil, archiveStepError("restore_all_parent_stat", err)
		}
		for _, dir := range dirs {
			missing[dir] = struct{}{}
		}
	}

	planned := make([]string, 0, len(missing))
	for dir := range missing {
		planned = append(planned, dir)
	}
	sort.Slice(planned, func(i, j int) bool {
		return len(planned[i]) < len(planned[j])
	})
	created := make([]string, 0, len(planned))
	for _, dir := range planned {
		if err := os.Mkdir(dir, archiveDirMode); err != nil {
			if !errors.Is(err, os.ErrExist) {
				cleanupRestoreAllParents(created)
				return nil, archiveStepError("restore_all_parent_mkdir", err)
			}
			continue
		}
		created = append(created, dir)
		if err := os.Chmod(dir, archiveDirMode); err != nil {
			cleanupRestoreAllParents(created)
			return nil, archiveStepError("restore_all_parent_chmod", err)
		}
	}
	sort.Slice(created, func(i, j int) bool {
		return len(created[i]) > len(created[j])
	})
	return created, nil
}

func restoreAllMissingDirs(path string) ([]string, error) {
	var missing []string
	current := filepath.Clean(path)
	for {
		info, err := os.Lstat(current)
		if err == nil {
			if !info.IsDir() {
				return nil, &os.PathError{Op: "mkdir", Path: current, Err: fs.ErrInvalid}
			}
			return missing, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		missing = append(missing, current)
		parent := filepath.Dir(current)
		if parent == current {
			return nil, fmt.Errorf("restore-all parent %q is outside an existing directory", path)
		}
		current = parent
	}
}

func cleanupRestoreAllParents(paths []string) {
	sort.Slice(paths, func(i, j int) bool {
		return len(paths[i]) > len(paths[j])
	})
	for _, path := range paths {
		_ = os.Remove(path)
	}
}

func commitRestoreAllRoot(ctx context.Context, rootName string, stagedRoot string, destination string) (archiveRestoreUndo, error) {
	if err := ctx.Err(); err != nil {
		return archiveRestoreUndo{}, err
	}
	empty, err := restoreAllDestinationAbsentOrEmpty(destination)
	if err != nil {
		return archiveRestoreUndo{}, archiveStepError("restore_all_destination_check", err)
	}
	if !empty {
		return archiveRestoreUndo{}, restoreAllDestinationNotEmpty(rootName)
	}

	_, statErr := os.Lstat(destination)
	if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
		return archiveRestoreUndo{}, archiveStepError("restore_all_destination_stat", statErr)
	}
	if errors.Is(statErr, os.ErrNotExist) {
		if err := os.Rename(stagedRoot, destination); err != nil {
			return archiveRestoreUndo{}, archiveStepError("restore_all_publish_rename", err)
		}
		return archiveRestoreUndo{destination: destination, hadPrior: false}, nil
	}

	if err := renameExchange(stagedRoot, destination); err != nil {
		return archiveRestoreUndo{}, archiveStepError("restore_all_rename_exchange", err)
	}
	return archiveRestoreUndo{destination: destination, priorPath: stagedRoot, hadPrior: true}, nil
}

func rootMatchesManifest(destination string, rootName string, manifest archiveManifest) (bool, error) {
	rootKnown := false
	expected := make(map[string]archiveManifestEntry)
	for _, root := range manifest.Roots {
		if root.Name == rootName {
			rootKnown = true
			break
		}
	}
	if !rootKnown {
		return false, archiveInvalid(fmt.Sprintf("manifest root %q is unknown", rootName))
	}
	for _, entry := range manifest.Entries {
		if entry.Root == rootName {
			expected[entry.Path] = entry
		}
	}

	info, err := os.Lstat(destination)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, fmt.Errorf("stat restore-all destination: %w", err)
	}
	if !info.IsDir() {
		return false, nil
	}

	seen := make(map[string]struct{}, len(expected))
	err = filepath.WalkDir(destination, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(destination, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		rel = filepath.ToSlash(rel)
		entry, ok := expected[rel]
		if !ok {
			return errTreeMismatch
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if uint32(info.Mode().Perm()) != entry.Mode {
			return errTreeMismatch
		}
		if entry.Type == "dir" {
			if !d.IsDir() {
				return errTreeMismatch
			}
		} else {
			if !info.Mode().IsRegular() || info.Size() != entry.Size {
				return errTreeMismatch
			}
			digest, _, err := digestFile(path)
			if err != nil {
				return err
			}
			if digest != entry.Digest {
				return errTreeMismatch
			}
		}
		seen[rel] = struct{}{}
		return nil
	})
	if errors.Is(err, errTreeMismatch) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return len(seen) == len(expected), nil
}

func restoreAllDestinationNotEmpty(rootName string) *ArchiveInvalidRequestError {
	reason := "restore_all_destination_not_empty:" + rootName
	return &ArchiveInvalidRequestError{
		Reason: reason,
		Code:   "restore_all_destination_not_empty:" + sanitizeArchiveCode(rootName),
	}
}
