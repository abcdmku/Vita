package backup

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"golang.org/x/sys/unix"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/internal/jsonsafe"
	"github.com/vita/agent/transaction"
)

const (
	ArchiveName = "backup.archive"

	archiveManifestVersion = 1
	archiveDigestAlgorithm = "sha256"
	archiveManifestName    = "manifest.json"
	archiveObjectsDirName  = "objects"

	defaultArchiveCapsuleVolumesRoot = "/var/lib/vita/runtime/volumes"

	archiveDirMode  = 0o700
	archiveFileMode = 0o600
)

type ArchiveOperation string

const (
	ArchiveOperationCreate  ArchiveOperation = "create"
	ArchiveOperationVerify  ArchiveOperation = "verify"
	ArchiveOperationRestore ArchiveOperation = "restore"
)

type ArchiveReadRequest struct{}

func (ArchiveReadRequest) CapabilityRequest() {}

func (ArchiveReadRequest) Validate() error { return nil }

type ArchiveApplyRequest struct {
	Op      ArchiveOperation       `json:"op"`
	Create  *ArchiveCreateRequest  `json:"create,omitempty"`
	Verify  *ArchiveVerifyRequest  `json:"verify,omitempty"`
	Restore *ArchiveRestoreRequest `json:"restore,omitempty"`
}

func (ArchiveApplyRequest) CapabilityRequest() {}

func (r *ArchiveApplyRequest) UnmarshalJSON(raw []byte) error {
	type archiveApplyRequestJSON ArchiveApplyRequest
	var decoded archiveApplyRequestJSON
	if err := jsonsafe.DecodeStrict(raw, &decoded); err != nil {
		return err
	}
	*r = ArchiveApplyRequest(decoded)
	return nil
}

func (r ArchiveApplyRequest) Validate() error {
	_, err := normalizeArchiveApplyRequest(r)
	return err
}

type ArchiveSourceRoot struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type ArchiveCreateRequest struct {
	TargetPath  string               `json:"targetPath"`
	SourceRoots *[]ArchiveSourceRoot `json:"sourceRoots,omitempty"`
}

type ArchiveVerifyRequest struct {
	TargetPath string `json:"targetPath"`
	BackupID   string `json:"backupId"`
}

type ArchiveRestoreRequest struct {
	TargetPath         string               `json:"targetPath"`
	BackupID           string               `json:"backupId"`
	DestinationRoot    string               `json:"destinationRoot"`
	CompareSourceRoots *[]ArchiveSourceRoot `json:"compareSourceRoots,omitempty"`
}

type ArchiveReadResponse struct {
	Last *ArchiveStatus `json:"last,omitempty"`
}

func (ArchiveReadResponse) CapabilityResponse() {}

type ArchiveStatus struct {
	Op       ArchiveOperation            `json:"op"`
	BackupID string                      `json:"backupId,omitempty"`
	Files    int                         `json:"files"`
	Created  bool                        `json:"created"`
	Verified bool                        `json:"verified"`
	Restored bool                        `json:"restored"`
	Failure  *ArchiveVerificationFailure `json:"failure,omitempty"`
	Status   string                      `json:"status"`
}

type ArchiveCreateResult struct {
	BackupID string `json:"backupId"`
	Files    int    `json:"files"`
}

type ArchiveVerifyResult struct {
	OK       bool                        `json:"ok"`
	BackupID string                      `json:"backupId"`
	Files    int                         `json:"files"`
	Failure  *ArchiveVerificationFailure `json:"failure,omitempty"`
}

type ArchiveRestoreResult struct {
	BackupID string `json:"backupId"`
	Files    int    `json:"files"`
	Restored bool   `json:"restored"`
}

type ArchiveVerificationFailure struct {
	Entry  string `json:"entry"`
	Reason string `json:"reason"`
}

type ArchiveCapability struct {
	mu   sync.Mutex
	last *ArchiveStatus
}

type ArchiveInvalidRequestError struct {
	Reason string
	Code   string
}

func (e *ArchiveInvalidRequestError) Error() string {
	return fmt.Sprintf("invalid backup archive request: %s", e.Reason)
}

func (e *ArchiveInvalidRequestError) ApplyErrorCode() string {
	if e == nil || e.Code == "" {
		return "backup_archive_rejected"
	}
	return e.Code
}

type ArchiveVerificationError struct {
	Failure ArchiveVerificationFailure
}

func (e *ArchiveVerificationError) Error() string {
	return fmt.Sprintf("backup archive verification failed at %s: %s", e.Failure.Entry, e.Failure.Reason)
}

func (e *ArchiveVerificationError) ApplyErrorCode() string {
	return "backup_archive_verify_failed"
}

func NewArchiveCapability() *ArchiveCapability {
	return &ArchiveCapability{}
}

func (c *ArchiveCapability) Name() string {
	return ArchiveName
}

func (c *ArchiveCapability) Handle(ctx context.Context, req capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	if _, ok := req.(ArchiveReadRequest); !ok {
		return nil, archiveInvalid("expected backup.ArchiveReadRequest")
	}
	if c == nil {
		return nil, archiveInvalid("missing backup archive capability")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	return ArchiveReadResponse{Last: c.cloneLast()}, nil
}

func (c *ArchiveCapability) Apply(ctx context.Context, req capabilities.TypedRequest) (transaction.Undo, error) {
	applyReq, ok := req.(ArchiveApplyRequest)
	if !ok {
		return nil, archiveInvalid("expected backup.ArchiveApplyRequest")
	}
	if c == nil {
		return nil, archiveInvalid("missing backup archive capability")
	}

	normalized, err := normalizeArchiveApplyRequest(applyReq)
	if err != nil {
		return nil, err
	}
	prior := c.cloneLast()

	switch normalized.Op {
	case ArchiveOperationCreate:
		result, undo, err := createArchive(ctx, *normalized.Create)
		if err != nil {
			return nil, err
		}
		c.setLast(ArchiveStatus{
			Op:       ArchiveOperationCreate,
			BackupID: result.BackupID,
			Files:    result.Files,
			Created:  true,
			Status:   "OK",
		})
		return archiveUndo{capability: c, prior: prior, undo: undo}, nil
	case ArchiveOperationVerify:
		result, err := verifyArchiveRequest(ctx, *normalized.Verify)
		if err != nil {
			return nil, err
		}
		if !result.OK {
			return nil, &ArchiveVerificationError{Failure: *result.Failure}
		}
		c.setLast(ArchiveStatus{
			Op:       ArchiveOperationVerify,
			BackupID: result.BackupID,
			Files:    result.Files,
			Verified: true,
			Status:   "OK",
		})
		return archiveUndo{capability: c, prior: prior}, nil
	case ArchiveOperationRestore:
		result, undo, err := restoreArchive(ctx, *normalized.Restore)
		if err != nil {
			return nil, err
		}
		c.setLast(ArchiveStatus{
			Op:       ArchiveOperationRestore,
			BackupID: result.BackupID,
			Files:    result.Files,
			Restored: result.Restored,
			Verified: true,
			Status:   "OK",
		})
		return archiveUndo{capability: c, prior: prior, undo: undo}, nil
	default:
		return nil, archiveInvalid("unknown backup archive operation")
	}
}

func (c *ArchiveCapability) Create(ctx context.Context, req ArchiveCreateRequest) (ArchiveCreateResult, transaction.Undo, error) {
	normalized, err := normalizeArchiveCreateRequest(req)
	if err != nil {
		return ArchiveCreateResult{}, nil, err
	}
	return createArchive(ctx, normalized)
}

func (c *ArchiveCapability) Verify(ctx context.Context, req ArchiveVerifyRequest) (ArchiveVerifyResult, error) {
	normalized, err := normalizeArchiveVerifyRequest(req)
	if err != nil {
		return ArchiveVerifyResult{}, err
	}
	return verifyArchiveRequest(ctx, normalized)
}

func (c *ArchiveCapability) Restore(ctx context.Context, req ArchiveRestoreRequest) (ArchiveRestoreResult, transaction.Undo, error) {
	normalized, err := normalizeArchiveRestoreRequest(req)
	if err != nil {
		return ArchiveRestoreResult{}, nil, err
	}
	return restoreArchive(ctx, normalized)
}

func (c *ArchiveCapability) cloneLast() *ArchiveStatus {
	c.mu.Lock()
	defer c.mu.Unlock()
	return cloneArchiveStatus(c.last)
}

func (c *ArchiveCapability) setLast(status ArchiveStatus) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.last = cloneArchiveStatus(&status)
}

func (c *ArchiveCapability) restoreLast(status *ArchiveStatus) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.last = cloneArchiveStatus(status)
}

type archiveUndo struct {
	capability *ArchiveCapability
	prior      *ArchiveStatus
	undo       transaction.Undo
}

func (u archiveUndo) Undo(ctx context.Context) error {
	if u.undo != nil {
		if err := u.undo.Undo(ctx); err != nil {
			return err
		}
	}
	if u.capability != nil {
		u.capability.restoreLast(u.prior)
	}
	return nil
}

type archiveRemoveUndo struct {
	path string
}

func (u archiveRemoveUndo) Undo(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if u.path == "" {
		return nil
	}
	if err := os.RemoveAll(u.path); err != nil {
		return fmt.Errorf("remove created backup archive: %w", err)
	}
	return nil
}

type archiveRestoreUndo struct {
	destination string
	priorPath   string
	hadPrior    bool
}

func (u archiveRestoreUndo) Undo(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !u.hadPrior {
		if err := os.RemoveAll(u.destination); err != nil {
			return fmt.Errorf("remove restored destination: %w", err)
		}
		return nil
	}
	if err := renameExchange(u.priorPath, u.destination); err != nil {
		return fmt.Errorf("restore prior destination: %w", err)
	}
	if err := os.RemoveAll(u.priorPath); err != nil {
		return fmt.Errorf("remove rolled-back restore staging tree: %w", err)
	}
	return nil
}

type normalizedArchiveApplyRequest struct {
	Op      ArchiveOperation
	Create  *ArchiveCreateRequest
	Verify  *ArchiveVerifyRequest
	Restore *ArchiveRestoreRequest
}

func normalizeArchiveApplyRequest(req ArchiveApplyRequest) (normalizedArchiveApplyRequest, error) {
	set := 0
	if req.Create != nil {
		set++
	}
	if req.Verify != nil {
		set++
	}
	if req.Restore != nil {
		set++
	}
	if set != 1 {
		return normalizedArchiveApplyRequest{}, archiveInvalid("exactly one of create, verify, or restore is required")
	}

	switch req.Op {
	case ArchiveOperationCreate:
		if req.Create == nil {
			return normalizedArchiveApplyRequest{}, archiveInvalid("create request is required for create op")
		}
		normalized, err := normalizeArchiveCreateRequest(*req.Create)
		if err != nil {
			return normalizedArchiveApplyRequest{}, err
		}
		return normalizedArchiveApplyRequest{Op: req.Op, Create: &normalized}, nil
	case ArchiveOperationVerify:
		if req.Verify == nil {
			return normalizedArchiveApplyRequest{}, archiveInvalid("verify request is required for verify op")
		}
		normalized, err := normalizeArchiveVerifyRequest(*req.Verify)
		if err != nil {
			return normalizedArchiveApplyRequest{}, err
		}
		return normalizedArchiveApplyRequest{Op: req.Op, Verify: &normalized}, nil
	case ArchiveOperationRestore:
		if req.Restore == nil {
			return normalizedArchiveApplyRequest{}, archiveInvalid("restore request is required for restore op")
		}
		normalized, err := normalizeArchiveRestoreRequest(*req.Restore)
		if err != nil {
			return normalizedArchiveApplyRequest{}, err
		}
		return normalizedArchiveApplyRequest{Op: req.Op, Restore: &normalized}, nil
	default:
		return normalizedArchiveApplyRequest{}, archiveInvalid("op must be create, verify, or restore")
	}
}

func normalizeArchiveCreateRequest(req ArchiveCreateRequest) (ArchiveCreateRequest, error) {
	target, err := normalizeAbsolutePath(req.TargetPath, "targetPath")
	if err != nil {
		return ArchiveCreateRequest{}, err
	}
	roots, err := normalizeArchiveSourceRoots(req.SourceRoots, true, "sourceRoots")
	if err != nil {
		return ArchiveCreateRequest{}, err
	}
	if err := rejectTargetOverlapsSource(target, roots); err != nil {
		return ArchiveCreateRequest{}, err
	}

	return ArchiveCreateRequest{
		TargetPath:  target,
		SourceRoots: &roots,
	}, nil
}

func normalizeArchiveVerifyRequest(req ArchiveVerifyRequest) (ArchiveVerifyRequest, error) {
	target, err := normalizeAbsolutePath(req.TargetPath, "targetPath")
	if err != nil {
		return ArchiveVerifyRequest{}, err
	}
	backupID, err := normalizeDigestToken(req.BackupID, "backupId")
	if err != nil {
		return ArchiveVerifyRequest{}, err
	}
	return ArchiveVerifyRequest{TargetPath: target, BackupID: backupID}, nil
}

func normalizeArchiveRestoreRequest(req ArchiveRestoreRequest) (ArchiveRestoreRequest, error) {
	target, err := normalizeAbsolutePath(req.TargetPath, "targetPath")
	if err != nil {
		return ArchiveRestoreRequest{}, err
	}
	backupID, err := normalizeDigestToken(req.BackupID, "backupId")
	if err != nil {
		return ArchiveRestoreRequest{}, err
	}
	destination, err := normalizeAbsolutePath(req.DestinationRoot, "destinationRoot")
	if err != nil {
		return ArchiveRestoreRequest{}, err
	}
	if pathsOverlap(target, destination) {
		return ArchiveRestoreRequest{}, archiveInvalid("destinationRoot must be independent from targetPath")
	}

	var compareRoots *[]ArchiveSourceRoot
	if req.CompareSourceRoots != nil {
		roots, err := normalizeArchiveSourceRoots(req.CompareSourceRoots, false, "compareSourceRoots")
		if err != nil {
			return ArchiveRestoreRequest{}, err
		}
		compareRoots = &roots
	}

	return ArchiveRestoreRequest{
		TargetPath:         target,
		BackupID:           backupID,
		DestinationRoot:    destination,
		CompareSourceRoots: compareRoots,
	}, nil
}

func defaultArchiveSourceRoots() []ArchiveSourceRoot {
	return []ArchiveSourceRoot{
		{Name: "capsule-volumes", Path: defaultArchiveCapsuleVolumesRoot},
		{Name: "vita-agent", Path: defaultStateRoot},
	}
}

func normalizeArchiveSourceRoots(input *[]ArchiveSourceRoot, allowDefault bool, field string) ([]ArchiveSourceRoot, error) {
	roots := input
	if roots == nil {
		if !allowDefault {
			return nil, archiveInvalid(field + " is required")
		}
		defaults := defaultArchiveSourceRoots()
		roots = &defaults
	}
	if len(*roots) == 0 {
		return nil, archiveInvalid(field + " must contain at least one source root")
	}

	normalized := make([]ArchiveSourceRoot, len(*roots))
	seenNames := make(map[string]int, len(*roots))
	seenPaths := make(map[string]int, len(*roots))
	for i, root := range *roots {
		name, err := normalizeArchiveRootName(root.Name, fmt.Sprintf("%s[%d].name", field, i))
		if err != nil {
			return nil, err
		}
		path, err := normalizeAbsolutePath(root.Path, fmt.Sprintf("%s[%d].path", field, i))
		if err != nil {
			return nil, err
		}
		if previous, ok := seenNames[name]; ok {
			return nil, archiveInvalid(fmt.Sprintf("%s[%d].name duplicates %s[%d].name", field, i, field, previous))
		}
		if previous, ok := seenPaths[path]; ok {
			return nil, archiveInvalid(fmt.Sprintf("%s[%d].path duplicates %s[%d].path", field, i, field, previous))
		}
		seenNames[name] = i
		seenPaths[path] = i
		normalized[i] = ArchiveSourceRoot{Name: name, Path: path}
	}

	for i := 0; i < len(normalized); i++ {
		for j := i + 1; j < len(normalized); j++ {
			if pathsOverlap(normalized[i].Path, normalized[j].Path) {
				return nil, archiveInvalid(fmt.Sprintf("%s[%d].path overlaps %s[%d].path", field, i, field, j))
			}
		}
	}

	sort.Slice(normalized, func(i, j int) bool {
		return normalized[i].Name < normalized[j].Name
	})
	return normalized, nil
}

var (
	archiveRootNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	archiveDigestPattern   = regexp.MustCompile(`^sha256:[A-Za-z0-9_-]{43}$`)
)

func normalizeArchiveRootName(value string, field string) (string, error) {
	if value == "" {
		return "", archiveInvalid(field + " is required")
	}
	if containsInlineSecretMaterial(value) {
		return "", archiveInvalid(field + " must not contain inline key material")
	}
	if !archiveRootNamePattern.MatchString(value) {
		return "", archiveInvalid(field + " must be a stable root name")
	}
	return value, nil
}

func normalizeAbsolutePath(value string, field string) (string, error) {
	if value == "" {
		return "", archiveInvalid(field + " is required")
	}
	if containsInlineSecretMaterial(value) {
		return "", archiveInvalid(field + " must not contain inline key material or control characters")
	}
	if !filepath.IsAbs(value) {
		return "", archiveInvalid(field + " must be an absolute path")
	}
	cleaned := filepath.Clean(value)
	if cleaned == string(filepath.Separator) {
		return "", archiveInvalid(field + " must not be the filesystem root")
	}
	return cleaned, nil
}

func normalizeDigestToken(value string, field string) (string, error) {
	if value == "" {
		return "", archiveInvalid(field + " is required")
	}
	if containsInlineSecretMaterial(value) {
		return "", archiveInvalid(field + " must not contain inline key material")
	}
	if !archiveDigestPattern.MatchString(value) {
		return "", archiveInvalid(field + " must be a sha256 content id")
	}
	return value, nil
}

func rejectTargetOverlapsSource(target string, roots []ArchiveSourceRoot) error {
	for i, root := range roots {
		if pathsOverlap(target, root.Path) {
			return archiveInvalid(fmt.Sprintf("targetPath must be independent from sourceRoots[%d].path", i))
		}
	}
	return nil
}

func pathsOverlap(a string, b string) bool {
	return pathWithin(a, b) || pathWithin(b, a)
}

func pathWithin(base string, candidate string) bool {
	rel, err := filepath.Rel(base, candidate)
	if err != nil {
		return false
	}
	return rel == "." || (rel != "" && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

type archiveManifest struct {
	Version int                    `json:"version"`
	Alg     string                 `json:"alg"`
	Digest  string                 `json:"digest"`
	Roots   []archiveManifestRoot  `json:"roots"`
	Entries []archiveManifestEntry `json:"entries"`
}

type archiveManifestBody struct {
	Version int                    `json:"version"`
	Alg     string                 `json:"alg"`
	Roots   []archiveManifestRoot  `json:"roots"`
	Entries []archiveManifestEntry `json:"entries"`
}

type archiveManifestRoot struct {
	Name string `json:"name"`
}

type archiveManifestEntry struct {
	Root   string `json:"root"`
	Path   string `json:"path"`
	Type   string `json:"type"`
	Mode   uint32 `json:"mode"`
	Size   int64  `json:"size"`
	Digest string `json:"digest,omitempty"`
}

func createArchive(ctx context.Context, req ArchiveCreateRequest) (ArchiveCreateResult, transaction.Undo, error) {
	normalized, err := normalizeArchiveCreateRequest(req)
	if err != nil {
		return ArchiveCreateResult{}, nil, err
	}
	if err := ctx.Err(); err != nil {
		return ArchiveCreateResult{}, nil, err
	}
	if err := os.MkdirAll(normalized.TargetPath, archiveDirMode); err != nil {
		return ArchiveCreateResult{}, nil, fmt.Errorf("create backup archive target: %w", err)
	}

	stage, err := os.MkdirTemp(normalized.TargetPath, ".backup-archive-*.tmp")
	if err != nil {
		return ArchiveCreateResult{}, nil, fmt.Errorf("create backup archive staging directory: %w", err)
	}
	cleanupStage := true
	defer func() {
		if cleanupStage {
			_ = os.RemoveAll(stage)
		}
	}()
	if err := os.Chmod(stage, archiveDirMode); err != nil {
		return ArchiveCreateResult{}, nil, fmt.Errorf("secure backup archive staging directory: %w", err)
	}

	objectsDir := filepath.Join(stage, archiveObjectsDirName)
	if err := os.MkdirAll(objectsDir, archiveDirMode); err != nil {
		return ArchiveCreateResult{}, nil, fmt.Errorf("create backup archive object store: %w", err)
	}

	roots := *normalized.SourceRoots
	manifest, files, err := buildArchiveManifest(ctx, roots, objectsDir)
	if err != nil {
		return ArchiveCreateResult{}, nil, err
	}
	digest, err := manifestDigest(manifestBody(manifest))
	if err != nil {
		return ArchiveCreateResult{}, nil, err
	}
	manifest.Digest = digest
	if err := validateArchiveManifest(manifest); err != nil {
		return ArchiveCreateResult{}, nil, err
	}

	rendered, err := renderArchiveManifest(manifest)
	if err != nil {
		return ArchiveCreateResult{}, nil, err
	}
	if err := atomicWriteFile(filepath.Join(stage, archiveManifestName), rendered, archiveFileMode); err != nil {
		return ArchiveCreateResult{}, nil, err
	}
	if err := syncTreeDirs(stage); err != nil {
		return ArchiveCreateResult{}, nil, err
	}

	finalPath := archivePath(normalized.TargetPath, digest)
	if _, err := os.Stat(finalPath); err == nil {
		result, err := verifyArchiveRequest(ctx, ArchiveVerifyRequest{TargetPath: normalized.TargetPath, BackupID: digest})
		if err != nil {
			return ArchiveCreateResult{}, nil, err
		}
		if !result.OK {
			return ArchiveCreateResult{}, nil, &ArchiveVerificationError{Failure: *result.Failure}
		}
		return ArchiveCreateResult{BackupID: digest, Files: files}, archiveUndo{}, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return ArchiveCreateResult{}, nil, fmt.Errorf("stat backup archive destination: %w", err)
	}

	// Rename publishes the fully staged backup as the single create commit point.
	if err := os.Rename(stage, finalPath); err != nil {
		return ArchiveCreateResult{}, nil, fmt.Errorf("publish backup archive: %w", err)
	}
	cleanupStage = false

	return ArchiveCreateResult{BackupID: digest, Files: files}, archiveRemoveUndo{path: finalPath}, nil
}

func verifyArchiveRequest(ctx context.Context, req ArchiveVerifyRequest) (ArchiveVerifyResult, error) {
	normalized, err := normalizeArchiveVerifyRequest(req)
	if err != nil {
		return ArchiveVerifyResult{}, err
	}
	result, _, err := verifyArchive(ctx, normalized.TargetPath, normalized.BackupID)
	return result, err
}

func restoreArchive(ctx context.Context, req ArchiveRestoreRequest) (ArchiveRestoreResult, transaction.Undo, error) {
	normalized, err := normalizeArchiveRestoreRequest(req)
	if err != nil {
		return ArchiveRestoreResult{}, nil, err
	}
	verify, manifest, err := verifyArchive(ctx, normalized.TargetPath, normalized.BackupID)
	if err != nil {
		return ArchiveRestoreResult{}, nil, err
	}
	if !verify.OK {
		return ArchiveRestoreResult{}, nil, &ArchiveVerificationError{Failure: *verify.Failure}
	}

	if ok, err := treeMatchesManifest(normalized.DestinationRoot, manifest); err != nil {
		return ArchiveRestoreResult{}, nil, err
	} else if ok {
		return ArchiveRestoreResult{BackupID: manifest.Digest, Files: verify.Files, Restored: true}, archiveUndo{}, nil
	}

	parent := filepath.Dir(normalized.DestinationRoot)
	base := filepath.Base(normalized.DestinationRoot)
	if err := os.MkdirAll(parent, archiveDirMode); err != nil {
		return ArchiveRestoreResult{}, nil, fmt.Errorf("create restore parent: %w", err)
	}
	stage, err := os.MkdirTemp(parent, "."+base+"-restore-*.tmp")
	if err != nil {
		return ArchiveRestoreResult{}, nil, fmt.Errorf("create restore staging directory: %w", err)
	}
	cleanupStage := true
	defer func() {
		if cleanupStage {
			_ = os.RemoveAll(stage)
		}
	}()
	if err := os.Chmod(stage, archiveDirMode); err != nil {
		return ArchiveRestoreResult{}, nil, fmt.Errorf("secure restore staging directory: %w", err)
	}

	if err := materializeArchive(ctx, archivePath(normalized.TargetPath, normalized.BackupID), manifest, stage); err != nil {
		return ArchiveRestoreResult{}, nil, err
	}
	if normalized.CompareSourceRoots != nil {
		if err := compareStageToSourceRoots(ctx, stage, *normalized.CompareSourceRoots); err != nil {
			return ArchiveRestoreResult{}, nil, err
		}
	}
	if err := syncTreeDirs(stage); err != nil {
		return ArchiveRestoreResult{}, nil, err
	}

	_, statErr := os.Lstat(normalized.DestinationRoot)
	if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
		return ArchiveRestoreResult{}, nil, fmt.Errorf("stat restore destination: %w", statErr)
	}

	if errors.Is(statErr, os.ErrNotExist) {
		// Rename is the single restore commit point for a new destination.
		if err := os.Rename(stage, normalized.DestinationRoot); err != nil {
			return ArchiveRestoreResult{}, nil, fmt.Errorf("publish restored archive: %w", err)
		}
		cleanupStage = false
		return ArchiveRestoreResult{BackupID: manifest.Digest, Files: verify.Files, Restored: true}, archiveRestoreUndo{
			destination: normalized.DestinationRoot,
			hadPrior:    false,
		}, nil
	}

	// Rename exchange is the single restore commit point for an existing destination.
	if err := renameExchange(stage, normalized.DestinationRoot); err != nil {
		return ArchiveRestoreResult{}, nil, fmt.Errorf("swap restored archive into place: %w", err)
	}
	cleanupStage = false
	return ArchiveRestoreResult{BackupID: manifest.Digest, Files: verify.Files, Restored: true}, archiveRestoreUndo{
		destination: normalized.DestinationRoot,
		priorPath:   stage,
		hadPrior:    true,
	}, nil
}

func buildArchiveManifest(ctx context.Context, roots []ArchiveSourceRoot, objectsDir string) (archiveManifest, int, error) {
	manifest := archiveManifest{
		Version: archiveManifestVersion,
		Alg:     archiveDigestAlgorithm,
		Roots:   make([]archiveManifestRoot, len(roots)),
	}
	files := 0
	for i, root := range roots {
		manifest.Roots[i] = archiveManifestRoot{Name: root.Name}
		rootInfo, err := os.Lstat(root.Path)
		if err != nil {
			return archiveManifest{}, 0, fmt.Errorf("stat source root %q: %w", root.Name, err)
		}
		if rootInfo.Mode()&os.ModeSymlink != 0 || !rootInfo.IsDir() {
			return archiveManifest{}, 0, archiveInvalid(fmt.Sprintf("sourceRoots[%s].path must be a directory", root.Name))
		}

		err = filepath.WalkDir(root.Path, func(path string, d fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			rel, err := filepath.Rel(root.Path, path)
			if err != nil {
				return err
			}
			if rel == "." {
				return nil
			}
			rel = filepath.ToSlash(rel)
			if err := validateArchiveRelativePath(rel, "manifest entry path"); err != nil {
				return err
			}
			if d.Type()&os.ModeSymlink != 0 {
				return archiveInvalid(fmt.Sprintf("source entry %s/%s must not be a symlink", root.Name, rel))
			}
			info, err := d.Info()
			if err != nil {
				return err
			}
			mode := uint32(info.Mode().Perm())
			switch {
			case d.IsDir():
				manifest.Entries = append(manifest.Entries, archiveManifestEntry{
					Root: root.Name,
					Path: rel,
					Type: "dir",
					Mode: mode,
				})
			case info.Mode().IsRegular():
				digest, size, err := hashFileToObject(path, objectsDir)
				if err != nil {
					return err
				}
				manifest.Entries = append(manifest.Entries, archiveManifestEntry{
					Root:   root.Name,
					Path:   rel,
					Type:   "file",
					Mode:   mode,
					Size:   size,
					Digest: digest,
				})
				files++
			default:
				return archiveInvalid(fmt.Sprintf("source entry %s/%s must be a regular file or directory", root.Name, rel))
			}
			return nil
		})
		if err != nil {
			return archiveManifest{}, 0, fmt.Errorf("walk source root %q: %w", root.Name, err)
		}
	}

	sort.Slice(manifest.Entries, func(i, j int) bool {
		return manifestEntryLess(manifest.Entries[i], manifest.Entries[j])
	})
	return manifest, files, nil
}

func verifyArchive(ctx context.Context, target string, backupID string) (ArchiveVerifyResult, archiveManifest, error) {
	if err := ctx.Err(); err != nil {
		return ArchiveVerifyResult{}, archiveManifest{}, err
	}
	manifest, err := loadArchiveManifest(target, backupID)
	if err != nil {
		return ArchiveVerifyResult{
			OK:       false,
			BackupID: backupID,
			Failure:  &ArchiveVerificationFailure{Entry: "manifest", Reason: err.Error()},
		}, archiveManifest{}, nil
	}
	if err := validateArchiveManifest(manifest); err != nil {
		return ArchiveVerifyResult{
			OK:       false,
			BackupID: backupID,
			Failure:  &ArchiveVerificationFailure{Entry: "manifest", Reason: err.Error()},
		}, archiveManifest{}, nil
	}

	computed, err := manifestDigest(manifestBody(manifest))
	if err != nil {
		return ArchiveVerifyResult{}, archiveManifest{}, err
	}
	if computed != manifest.Digest {
		return ArchiveVerifyResult{
			OK:       false,
			BackupID: backupID,
			Files:    manifestFileCount(manifest),
			Failure:  &ArchiveVerificationFailure{Entry: "manifest", Reason: "digest mismatch"},
		}, archiveManifest{}, nil
	}
	if manifest.Digest != backupID {
		return ArchiveVerifyResult{
			OK:       false,
			BackupID: backupID,
			Files:    manifestFileCount(manifest),
			Failure:  &ArchiveVerificationFailure{Entry: "manifest", Reason: "backup id mismatch"},
		}, archiveManifest{}, nil
	}

	objectsDir := filepath.Join(archivePath(target, backupID), archiveObjectsDirName)
	for _, entry := range manifest.Entries {
		if entry.Type != "file" {
			continue
		}
		if err := ctx.Err(); err != nil {
			return ArchiveVerifyResult{}, archiveManifest{}, err
		}
		digest, size, err := digestFile(filepath.Join(objectsDir, entry.Digest))
		if err != nil {
			return ArchiveVerifyResult{
				OK:       false,
				BackupID: backupID,
				Files:    manifestFileCount(manifest),
				Failure:  &ArchiveVerificationFailure{Entry: manifestEntryID(entry), Reason: err.Error()},
			}, archiveManifest{}, nil
		}
		if digest != entry.Digest {
			return ArchiveVerifyResult{
				OK:       false,
				BackupID: backupID,
				Files:    manifestFileCount(manifest),
				Failure:  &ArchiveVerificationFailure{Entry: manifestEntryID(entry), Reason: "content digest mismatch"},
			}, archiveManifest{}, nil
		}
		if size != entry.Size {
			return ArchiveVerifyResult{
				OK:       false,
				BackupID: backupID,
				Files:    manifestFileCount(manifest),
				Failure:  &ArchiveVerificationFailure{Entry: manifestEntryID(entry), Reason: "content size mismatch"},
			}, archiveManifest{}, nil
		}
	}

	return ArchiveVerifyResult{
		OK:       true,
		BackupID: backupID,
		Files:    manifestFileCount(manifest),
	}, manifest, nil
}

func loadArchiveManifest(target string, backupID string) (archiveManifest, error) {
	raw, err := os.ReadFile(filepath.Join(archivePath(target, backupID), archiveManifestName))
	if err != nil {
		return archiveManifest{}, fmt.Errorf("read manifest: %w", err)
	}

	type archiveManifestJSON archiveManifest
	var decoded archiveManifestJSON
	if err := jsonsafe.DecodeStrict(raw, &decoded); err != nil {
		return archiveManifest{}, fmt.Errorf("parse manifest: %w", err)
	}
	return archiveManifest(decoded), nil
}

func validateArchiveManifest(manifest archiveManifest) error {
	if manifest.Version != archiveManifestVersion {
		return archiveInvalid("manifest version is unsupported")
	}
	if manifest.Alg != archiveDigestAlgorithm {
		return archiveInvalid("manifest digest algorithm is unsupported")
	}
	if _, err := normalizeDigestToken(manifest.Digest, "manifest.digest"); err != nil {
		return err
	}
	if len(manifest.Roots) == 0 {
		return archiveInvalid("manifest.roots must contain at least one root")
	}

	roots := make(map[string]struct{}, len(manifest.Roots))
	for i, root := range manifest.Roots {
		name, err := normalizeArchiveRootName(root.Name, fmt.Sprintf("manifest.roots[%d].name", i))
		if err != nil {
			return err
		}
		if _, exists := roots[name]; exists {
			return archiveInvalid(fmt.Sprintf("manifest.roots[%d].name duplicates an earlier root", i))
		}
		roots[name] = struct{}{}
	}

	for i, entry := range manifest.Entries {
		if _, ok := roots[entry.Root]; !ok {
			return archiveInvalid(fmt.Sprintf("manifest.entries[%d].root is unknown", i))
		}
		if err := normalizeManifestString(entry.Root, fmt.Sprintf("manifest.entries[%d].root", i)); err != nil {
			return err
		}
		if err := validateArchiveRelativePath(entry.Path, fmt.Sprintf("manifest.entries[%d].path", i)); err != nil {
			return err
		}
		if entry.Mode > 0o777 {
			return archiveInvalid(fmt.Sprintf("manifest.entries[%d].mode must be a permission mode", i))
		}
		switch entry.Type {
		case "dir":
			if entry.Size != 0 || entry.Digest != "" {
				return archiveInvalid(fmt.Sprintf("manifest.entries[%d] directory must not carry size or digest", i))
			}
		case "file":
			if entry.Size < 0 {
				return archiveInvalid(fmt.Sprintf("manifest.entries[%d].size must be non-negative", i))
			}
			if _, err := normalizeDigestToken(entry.Digest, fmt.Sprintf("manifest.entries[%d].digest", i)); err != nil {
				return err
			}
		default:
			return archiveInvalid(fmt.Sprintf("manifest.entries[%d].type must be file or dir", i))
		}
	}
	if !sort.SliceIsSorted(manifest.Entries, func(i, j int) bool {
		return manifestEntryLess(manifest.Entries[i], manifest.Entries[j])
	}) {
		return archiveInvalid("manifest.entries must be canonical sorted")
	}
	return nil
}

func validateArchiveRelativePath(value string, field string) error {
	if value == "" {
		return archiveInvalid(field + " is required")
	}
	if containsInlineSecretMaterial(value) {
		return archiveInvalid(field + " must not contain inline key material")
	}
	if strings.Contains(value, "\\") || strings.HasPrefix(value, "/") {
		return archiveInvalid(field + " must be a slash-relative path")
	}
	cleaned := filepath.ToSlash(filepath.Clean(filepath.FromSlash(value)))
	if cleaned != value || cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") || strings.Contains(cleaned, "/../") {
		return archiveInvalid(field + " must be a clean relative path")
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return archiveInvalid(field + " must not contain empty or dot path segments")
		}
	}
	return nil
}

func normalizeManifestString(value string, field string) error {
	if value == "" {
		return archiveInvalid(field + " is required")
	}
	if containsInlineSecretMaterial(value) {
		return archiveInvalid(field + " must not contain inline key material")
	}
	return nil
}

func materializeArchive(ctx context.Context, backupDir string, manifest archiveManifest, destination string) error {
	rootModes := map[string]uint32{}
	for _, root := range manifest.Roots {
		rootPath := filepath.Join(destination, root.Name)
		if err := os.MkdirAll(rootPath, archiveDirMode); err != nil {
			return fmt.Errorf("create restore root %q: %w", root.Name, err)
		}
		rootModes[rootPath] = archiveDirMode
	}

	dirModes := make(map[string]uint32)
	objectsDir := filepath.Join(backupDir, archiveObjectsDirName)
	for _, entry := range manifest.Entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		entryPath, err := manifestEntryPath(destination, entry)
		if err != nil {
			return err
		}
		switch entry.Type {
		case "dir":
			if err := os.MkdirAll(entryPath, archiveDirMode); err != nil {
				return fmt.Errorf("create restore directory %s: %w", manifestEntryID(entry), err)
			}
			dirModes[entryPath] = entry.Mode
		case "file":
			parent := filepath.Dir(entryPath)
			if err := os.MkdirAll(parent, archiveDirMode); err != nil {
				return fmt.Errorf("create restore file parent %s: %w", manifestEntryID(entry), err)
			}
			if err := atomicCopyFile(filepath.Join(objectsDir, entry.Digest), entryPath, fs.FileMode(entry.Mode)); err != nil {
				return fmt.Errorf("restore file %s: %w", manifestEntryID(entry), err)
			}
		}
	}

	dirs := make([]string, 0, len(dirModes)+len(rootModes))
	for path := range dirModes {
		dirs = append(dirs, path)
	}
	for path := range rootModes {
		dirs = append(dirs, path)
	}
	sort.Slice(dirs, func(i, j int) bool {
		return len(dirs[i]) > len(dirs[j])
	})
	for _, path := range dirs {
		mode, ok := dirModes[path]
		if !ok {
			mode = rootModes[path]
		}
		if err := os.Chmod(path, fs.FileMode(mode)); err != nil {
			return fmt.Errorf("set restore directory mode: %w", err)
		}
	}
	return nil
}

func compareStageToSourceRoots(ctx context.Context, stage string, roots []ArchiveSourceRoot) error {
	for _, root := range roots {
		sourceRoot := root.Path
		restoredRoot := filepath.Join(stage, root.Name)
		if err := compareTrees(ctx, sourceRoot, restoredRoot); err != nil {
			return fmt.Errorf("restored tree differs from source root %q: %w", root.Name, err)
		}
	}
	return nil
}

func compareTrees(ctx context.Context, left string, right string) error {
	leftEntries, err := digestTree(ctx, left)
	if err != nil {
		return err
	}
	rightEntries, err := digestTree(ctx, right)
	if err != nil {
		return err
	}
	if len(leftEntries) != len(rightEntries) {
		return fmt.Errorf("entry count %d != %d", len(leftEntries), len(rightEntries))
	}
	for key, leftEntry := range leftEntries {
		rightEntry, ok := rightEntries[key]
		if !ok {
			return fmt.Errorf("missing restored entry %s", key)
		}
		if leftEntry != rightEntry {
			return fmt.Errorf("entry %s differs", key)
		}
	}
	return nil
}

type treeDigestEntry struct {
	Type   string
	Mode   uint32
	Size   int64
	Digest string
}

func digestTree(ctx context.Context, root string) (map[string]treeDigestEntry, error) {
	entries := map[string]treeDigestEntry{}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		rel = filepath.ToSlash(rel)
		info, err := d.Info()
		if err != nil {
			return err
		}
		mode := uint32(info.Mode().Perm())
		if d.IsDir() {
			entries[rel] = treeDigestEntry{Type: "dir", Mode: mode}
			return nil
		}
		if !info.Mode().IsRegular() {
			return archiveInvalid("tree contains non-regular entry")
		}
		digest, size, err := digestFile(path)
		if err != nil {
			return err
		}
		entries[rel] = treeDigestEntry{Type: "file", Mode: mode, Size: size, Digest: digest}
		return nil
	})
	return entries, err
}

func treeMatchesManifest(destination string, manifest archiveManifest) (bool, error) {
	if _, err := os.Lstat(destination); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, fmt.Errorf("stat restore destination: %w", err)
	}

	expected := make(map[string]archiveManifestEntry, len(manifest.Entries))
	for _, entry := range manifest.Entries {
		expected[manifestEntryID(entry)] = entry
	}
	seen := make(map[string]struct{}, len(expected))
	for _, root := range manifest.Roots {
		rootPath := filepath.Join(destination, root.Name)
		if info, err := os.Lstat(rootPath); err != nil || !info.IsDir() {
			return false, nil
		}
		err := filepath.WalkDir(rootPath, func(path string, d fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			rel, err := filepath.Rel(rootPath, path)
			if err != nil {
				return err
			}
			if rel == "." {
				return nil
			}
			rel = filepath.ToSlash(rel)
			entry, ok := expected[root.Name+"/"+rel]
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
			seen[root.Name+"/"+rel] = struct{}{}
			return nil
		})
		if errors.Is(err, errTreeMismatch) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
	}
	return len(seen) == len(expected), nil
}

var errTreeMismatch = errors.New("tree mismatch")

func hashFileToObject(source string, objectsDir string) (string, int64, error) {
	in, err := os.Open(source)
	if err != nil {
		return "", 0, fmt.Errorf("open source file: %w", err)
	}
	defer in.Close()

	tmp, err := os.CreateTemp(objectsDir, ".object-*.tmp")
	if err != nil {
		return "", 0, fmt.Errorf("create object temp file: %w", err)
	}
	tmpName := tmp.Name()
	closed := false
	cleanupTemp := true
	defer func() {
		if cleanupTemp {
			if !closed {
				_ = tmp.Close()
			}
			_ = os.Remove(tmpName)
		}
	}()

	if err := tmp.Chmod(archiveFileMode); err != nil {
		return "", 0, fmt.Errorf("secure object temp file: %w", err)
	}
	hasher := sha256.New()
	size, err := copyAndHash(tmp, in, hasher)
	if err != nil {
		return "", 0, fmt.Errorf("write object temp file: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return "", 0, fmt.Errorf("sync object temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		closed = true
		return "", 0, fmt.Errorf("close object temp file: %w", err)
	}
	closed = true

	digest := digestBytes(hasher.Sum(nil))
	if err := os.Rename(tmpName, filepath.Join(objectsDir, digest)); err != nil {
		return "", 0, fmt.Errorf("publish content object: %w", err)
	}
	cleanupTemp = false
	return digest, size, nil
}

func atomicWriteFile(path string, content []byte, mode fs.FileMode) error {
	dir := filepath.Dir(path)
	base := filepath.Base(path)
	if err := os.MkdirAll(dir, archiveDirMode); err != nil {
		return fmt.Errorf("create parent directory: %w", err)
	}
	tmp, err := os.CreateTemp(dir, "."+base+"-*.tmp")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpName := tmp.Name()
	closed := false
	cleanupTemp := true
	defer func() {
		if cleanupTemp {
			if !closed {
				_ = tmp.Close()
			}
			_ = os.Remove(tmpName)
		}
	}()
	if err := tmp.Chmod(mode); err != nil {
		return fmt.Errorf("secure temp file: %w", err)
	}
	written, err := tmp.Write(content)
	if err != nil {
		return fmt.Errorf("write temp file: %w", err)
	}
	if written != len(content) {
		return fmt.Errorf("write temp file: %w", io.ErrShortWrite)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("sync temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		closed = true
		return fmt.Errorf("close temp file: %w", err)
	}
	closed = true
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("replace file: %w", err)
	}
	cleanupTemp = false
	return nil
}

func atomicCopyFile(source string, destination string, mode fs.FileMode) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()

	dir := filepath.Dir(destination)
	base := filepath.Base(destination)
	tmp, err := os.CreateTemp(dir, "."+base+"-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	closed := false
	cleanupTemp := true
	defer func() {
		if cleanupTemp {
			if !closed {
				_ = tmp.Close()
			}
			_ = os.Remove(tmpName)
		}
	}()
	if err := tmp.Chmod(mode); err != nil {
		return err
	}
	if _, err := io.Copy(tmp, in); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		closed = true
		return err
	}
	closed = true
	if err := os.Rename(tmpName, destination); err != nil {
		return err
	}
	cleanupTemp = false
	return nil
}

func digestFile(path string) (string, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()

	hasher := sha256.New()
	size, err := copyAndHash(io.Discard, file, hasher)
	if err != nil {
		return "", 0, err
	}
	return digestBytes(hasher.Sum(nil)), size, nil
}

func copyAndHash(dst io.Writer, src io.Reader, hasher hash.Hash) (int64, error) {
	return io.Copy(io.MultiWriter(dst, hasher), src)
}

func digestBytes(digest []byte) string {
	return "sha256:" + base64.RawURLEncoding.EncodeToString(digest)
}

func renderArchiveManifest(manifest archiveManifest) ([]byte, error) {
	encoded, err := json.Marshal(manifest)
	if err != nil {
		return nil, fmt.Errorf("render archive manifest: %w", err)
	}
	return append(encoded, '\n'), nil
}

func manifestDigest(body archiveManifestBody) (string, error) {
	encoded, err := json.Marshal(body)
	if err != nil {
		return "", fmt.Errorf("render archive manifest body: %w", err)
	}
	sum := sha256.Sum256(encoded)
	return digestBytes(sum[:]), nil
}

func manifestBody(manifest archiveManifest) archiveManifestBody {
	return archiveManifestBody{
		Version: manifest.Version,
		Alg:     manifest.Alg,
		Roots:   cloneManifestRoots(manifest.Roots),
		Entries: cloneManifestEntries(manifest.Entries),
	}
}

func manifestEntryLess(a archiveManifestEntry, b archiveManifestEntry) bool {
	if a.Root != b.Root {
		return a.Root < b.Root
	}
	if a.Path != b.Path {
		return a.Path < b.Path
	}
	return a.Type < b.Type
}

func manifestEntryID(entry archiveManifestEntry) string {
	return entry.Root + "/" + entry.Path
}

func manifestEntryPath(destination string, entry archiveManifestEntry) (string, error) {
	root := filepath.Join(destination, entry.Root)
	path := filepath.Join(root, filepath.FromSlash(entry.Path))
	if !pathWithin(root, path) {
		return "", archiveInvalid("manifest entry escapes restore root")
	}
	return path, nil
}

func manifestFileCount(manifest archiveManifest) int {
	files := 0
	for _, entry := range manifest.Entries {
		if entry.Type == "file" {
			files++
		}
	}
	return files
}

func archivePath(target string, backupID string) string {
	return filepath.Join(target, backupID)
}

func syncTreeDirs(root string) error {
	var dirs []string
	if err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			dirs = append(dirs, path)
		}
		return nil
	}); err != nil {
		return err
	}
	sort.Slice(dirs, func(i, j int) bool {
		return len(dirs[i]) > len(dirs[j])
	})
	for _, dir := range dirs {
		if err := syncDir(dir); err != nil {
			return err
		}
	}
	return nil
}

func syncDir(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	if err := dir.Sync(); err != nil {
		return err
	}
	return nil
}

func renameExchange(a string, b string) error {
	return unix.Renameat2(unix.AT_FDCWD, a, unix.AT_FDCWD, b, unix.RENAME_EXCHANGE)
}

func archiveInvalid(reason string) *ArchiveInvalidRequestError {
	return &ArchiveInvalidRequestError{Reason: reason}
}

func cloneArchiveStatus(status *ArchiveStatus) *ArchiveStatus {
	if status == nil {
		return nil
	}
	out := *status
	if status.Failure != nil {
		failure := *status.Failure
		out.Failure = &failure
	}
	return &out
}

func cloneManifestRoots(in []archiveManifestRoot) []archiveManifestRoot {
	out := make([]archiveManifestRoot, len(in))
	copy(out, in)
	return out
}

func cloneManifestEntries(in []archiveManifestEntry) []archiveManifestEntry {
	out := make([]archiveManifestEntry, len(in))
	copy(out, in)
	return out
}
