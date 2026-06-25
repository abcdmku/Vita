//go:build linux

package restore

import (
	"context"
	"errors"
	"fmt"
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
	"github.com/vita/agent/capabilities/backup"
	"github.com/vita/agent/internal/jsonsafe"
	"github.com/vita/agent/transaction"
)

const (
	Name = "restore.replacement"

	defaultCapsuleVolumesRoot = "/var/lib/vita/runtime/volumes"
	defaultAgentStateRoot     = "/var/lib/vita-agent"

	restoreDirMode fs.FileMode = 0o700
)

type Operation string

const OperationReplace Operation = "replace"

type ReadRequest struct{}

func (ReadRequest) CapabilityRequest() {}

func (ReadRequest) Validate() error { return nil }

type ApplyRequest struct {
	Op      Operation           `json:"op"`
	Replace *ReplacementRequest `json:"replace,omitempty"`
}

func (ApplyRequest) CapabilityRequest() {}

func (r *ApplyRequest) UnmarshalJSON(raw []byte) error {
	type applyRequestJSON ApplyRequest
	var decoded applyRequestJSON
	if err := jsonsafe.DecodeStrict(raw, &decoded); err != nil {
		return err
	}
	*r = ApplyRequest(decoded)
	return nil
}

func (r ApplyRequest) Validate() error {
	_, err := normalizeApplyRequest(r)
	return err
}

type ReplacementRequest struct {
	BackupSource string         `json:"backupSource"`
	ExpectFrom   *string        `json:"expectFrom,omitempty"`
	Plan         *[]PlanMapping `json:"plan,omitempty"`
}

type PlanMapping struct {
	Name            string `json:"name"`
	BackupRoot      string `json:"backupRoot"`
	DestinationRoot string `json:"destinationRoot"`
}

type ReadResponse struct {
	Last *Status `json:"last,omitempty"`
}

func (ReadResponse) CapabilityResponse() {}

type Status struct {
	Op       Operation    `json:"op"`
	BackupID string       `json:"backupId"`
	Files    int          `json:"files"`
	From     string       `json:"from,omitempty"`
	To       string       `json:"to,omitempty"`
	Roots    []RootStatus `json:"roots"`
	Restored bool         `json:"restored"`
	Verified bool         `json:"verified"`
	Status   string       `json:"status"`
}

type RootStatus struct {
	Name            string `json:"name"`
	BackupRoot      string `json:"backupRoot"`
	DestinationRoot string `json:"destinationRoot"`
	Files           int    `json:"files"`
	Restored        bool   `json:"restored"`
	Verified        bool   `json:"verified"`
}

type ReplacementResult struct {
	BackupID string       `json:"backupId"`
	Files    int          `json:"files"`
	From     string       `json:"from,omitempty"`
	To       string       `json:"to,omitempty"`
	Roots    []RootStatus `json:"roots"`
	Restored bool         `json:"restored"`
	Verified bool         `json:"verified"`
}

type Capability struct {
	mu     sync.Mutex
	last   *Status
	nodeID func(context.Context) (string, error)
}

type InvalidRequestError struct {
	Reason string
	Code   string
}

func (e *InvalidRequestError) Error() string {
	return fmt.Sprintf("invalid replacement restore request: %s", e.Reason)
}

func (e *InvalidRequestError) ApplyErrorCode() string {
	if e == nil || e.Code == "" {
		return "restore_replacement_rejected"
	}
	return e.Code
}

type OperationError struct {
	Code string
	Err  error
}

func (e *OperationError) Error() string {
	if e == nil || e.Err == nil {
		return "replacement restore operation failed"
	}
	return e.Err.Error()
}

func (e *OperationError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func (e *OperationError) ApplyErrorCode() string {
	if e == nil || e.Code == "" {
		return "restore_replacement_failed"
	}
	return e.Code
}

func NewCapability() *Capability {
	return newCapability(defaultNodeID)
}

func newCapability(nodeID func(context.Context) (string, error)) *Capability {
	return &Capability{nodeID: nodeID}
}

func (c *Capability) Name() string {
	return Name
}

func (c *Capability) Handle(ctx context.Context, req capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	if _, ok := req.(ReadRequest); !ok {
		return nil, invalid("expected restore.ReadRequest", "invalid_request")
	}
	if c == nil {
		return nil, invalid("missing restore replacement capability", "invalid_request")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return ReadResponse{Last: c.cloneLast()}, nil
}

func (c *Capability) Apply(ctx context.Context, req capabilities.TypedRequest) (transaction.Undo, error) {
	applyReq, ok := req.(ApplyRequest)
	if !ok {
		return nil, invalid("expected restore.ApplyRequest", "invalid_request")
	}
	if c == nil {
		return nil, invalid("missing restore replacement capability", "invalid_request")
	}
	normalized, err := normalizeApplyRequest(applyReq)
	if err != nil {
		return nil, err
	}

	prior := c.cloneLast()
	switch normalized.Op {
	case OperationReplace:
		result, undo, err := c.Replace(ctx, *normalized.Replace)
		if err != nil {
			return nil, err
		}
		c.setLast(Status{
			Op:       OperationReplace,
			BackupID: result.BackupID,
			Files:    result.Files,
			From:     result.From,
			To:       result.To,
			Roots:    cloneRootStatuses(result.Roots),
			Restored: result.Restored,
			Verified: result.Verified,
			Status:   "OK",
		})
		return capabilityUndo{capability: c, prior: prior, undo: undo}, nil
	default:
		return nil, invalid("unknown restore replacement operation", "unknown_op")
	}
}

func (c *Capability) Replace(ctx context.Context, req ReplacementRequest) (ReplacementResult, transaction.Undo, error) {
	normalized, err := normalizeReplacementRequest(req)
	if err != nil {
		return ReplacementResult{}, nil, err
	}
	if err := ctx.Err(); err != nil {
		return ReplacementResult{}, nil, err
	}

	archive, err := backup.DiscoverVerifiedArchive(ctx, normalized.BackupSource)
	if err != nil {
		return ReplacementResult{}, nil, err
	}
	mappings, err := mappingsForArchive(*normalized.Plan, archive)
	if err != nil {
		return ReplacementResult{}, nil, err
	}
	nodeID := defaultNodeID
	if c != nil && c.nodeID != nil {
		nodeID = c.nodeID
	}
	to, err := nodeID(ctx)
	if err != nil {
		return ReplacementResult{}, nil, stepError("local_node_identity", err)
	}
	if to, err = normalizeIdentityMarker(to, "local node identity"); err != nil {
		return ReplacementResult{}, nil, err
	}

	return replaceArchive(ctx, archive, mappings, normalized.ExpectFrom, to)
}

type normalizedApplyRequest struct {
	Op      Operation
	Replace *ReplacementRequest
}

func normalizeApplyRequest(req ApplyRequest) (normalizedApplyRequest, error) {
	set := 0
	if req.Replace != nil {
		set++
	}
	if set != 1 {
		return normalizedApplyRequest{}, invalid("exactly one of replace is required", "invalid_request")
	}
	if req.Op != OperationReplace {
		return normalizedApplyRequest{}, invalid("op must be replace", "unknown_op")
	}
	normalized, err := normalizeReplacementRequest(*req.Replace)
	if err != nil {
		return normalizedApplyRequest{}, err
	}
	return normalizedApplyRequest{Op: req.Op, Replace: &normalized}, nil
}

func normalizeReplacementRequest(req ReplacementRequest) (ReplacementRequest, error) {
	backupSource, err := normalizeAbsolutePath(req.BackupSource, "backupSource", "non_absolute_source")
	if err != nil {
		return ReplacementRequest{}, err
	}
	var expectFrom *string
	if req.ExpectFrom != nil {
		value, err := normalizeIdentityMarker(*req.ExpectFrom, "expectFrom")
		if err != nil {
			return ReplacementRequest{}, err
		}
		expectFrom = &value
	}
	plan, err := normalizePlan(req.Plan)
	if err != nil {
		return ReplacementRequest{}, err
	}
	return ReplacementRequest{
		BackupSource: backupSource,
		ExpectFrom:   expectFrom,
		Plan:         &plan,
	}, nil
}

func normalizePlan(input *[]PlanMapping) ([]PlanMapping, error) {
	mappings := input
	if mappings == nil {
		defaults := defaultPlan()
		mappings = &defaults
	}
	if len(*mappings) == 0 {
		return nil, invalid("plan must contain at least one mapping", "invalid_plan")
	}

	normalized := make([]PlanMapping, len(*mappings))
	seenNames := make(map[string]int, len(*mappings))
	seenBackupRoots := make(map[string]int, len(*mappings))
	seenDestinations := make(map[string]int, len(*mappings))
	for i, mapping := range *mappings {
		name, err := normalizeRootToken(mapping.Name, fmt.Sprintf("plan[%d].name", i))
		if err != nil {
			return nil, err
		}
		backupRoot, err := normalizeRootToken(mapping.BackupRoot, fmt.Sprintf("plan[%d].backupRoot", i))
		if err != nil {
			return nil, err
		}
		destination, err := normalizeAbsolutePath(mapping.DestinationRoot, fmt.Sprintf("plan[%d].destinationRoot", i), "invalid_destination")
		if err != nil {
			return nil, err
		}
		if previous, ok := seenNames[name]; ok {
			return nil, invalid(fmt.Sprintf("plan[%d].name duplicates plan[%d].name", i, previous), "invalid_plan")
		}
		if previous, ok := seenBackupRoots[backupRoot]; ok {
			return nil, invalid(fmt.Sprintf("plan[%d].backupRoot duplicates plan[%d].backupRoot", i, previous), "invalid_plan")
		}
		if previous, ok := seenDestinations[destination]; ok {
			return nil, invalid(fmt.Sprintf("plan[%d].destinationRoot duplicates plan[%d].destinationRoot", i, previous), "invalid_destination")
		}
		seenNames[name] = i
		seenBackupRoots[backupRoot] = i
		seenDestinations[destination] = i
		normalized[i] = PlanMapping{Name: name, BackupRoot: backupRoot, DestinationRoot: destination}
	}

	for i := 0; i < len(normalized); i++ {
		for j := i + 1; j < len(normalized); j++ {
			if pathsOverlap(normalized[i].DestinationRoot, normalized[j].DestinationRoot) {
				return nil, invalid(fmt.Sprintf("plan[%d].destinationRoot overlaps plan[%d].destinationRoot", i, j), "invalid_destination")
			}
		}
	}

	sort.Slice(normalized, func(i, j int) bool {
		return normalized[i].Name < normalized[j].Name
	})
	return normalized, nil
}

func defaultPlan() []PlanMapping {
	return []PlanMapping{
		{Name: "capsule-volumes", BackupRoot: "capsule-volumes", DestinationRoot: defaultCapsuleVolumesRoot},
		{Name: "vita-agent", BackupRoot: "vita-agent", DestinationRoot: defaultAgentStateRoot},
	}
}

func mappingsForArchive(plan []PlanMapping, archive backup.VerifiedArchive) ([]PlanMapping, error) {
	expected := make(map[string]struct{})
	for _, root := range archive.Roots() {
		expected[root] = struct{}{}
	}
	seen := make(map[string]struct{}, len(plan))
	for _, mapping := range plan {
		if _, ok := expected[mapping.BackupRoot]; !ok {
			return nil, invalid(fmt.Sprintf("plan contains unknown backup root %q", mapping.BackupRoot), "invalid_plan")
		}
		seen[mapping.BackupRoot] = struct{}{}
	}
	for root := range expected {
		if _, ok := seen[root]; !ok {
			return nil, invalid(fmt.Sprintf("plan missing backup root %q", root), "invalid_plan")
		}
	}
	if len(seen) != len(expected) {
		return nil, invalid("plan must exactly cover archive roots", "invalid_plan")
	}
	out := make([]PlanMapping, len(plan))
	copy(out, plan)
	sort.Slice(out, func(i, j int) bool {
		return out[i].Name < out[j].Name
	})
	return out, nil
}

type capabilityUndo struct {
	capability *Capability
	prior      *Status
	undo       transaction.Undo
}

func (u capabilityUndo) Undo(ctx context.Context) error {
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

func (c *Capability) cloneLast() *Status {
	c.mu.Lock()
	defer c.mu.Unlock()
	return cloneStatus(c.last)
}

func (c *Capability) setLast(status Status) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.last = cloneStatus(&status)
}

func (c *Capability) restoreLast(status *Status) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.last = cloneStatus(status)
}

type replacementUndo struct {
	livePath string
	prior    string
	hadPrior bool
}

func (u replacementUndo) Undo(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !u.hadPrior {
		if err := os.RemoveAll(u.livePath); err != nil {
			return fmt.Errorf("remove restored replacement tree: %w", err)
		}
		return nil
	}
	if err := renameExchange(u.prior, u.livePath); err != nil {
		return fmt.Errorf("restore prior replacement tree: %w", err)
	}
	if err := os.RemoveAll(u.prior); err != nil {
		return fmt.Errorf("remove rolled-back replacement tree: %w", err)
	}
	return nil
}

var commitReplacementRoot = commitReplacementRootAtomic

func replaceArchive(
	ctx context.Context,
	archive backup.VerifiedArchive,
	mappings []PlanMapping,
	expectFrom *string,
	to string,
) (ReplacementResult, transaction.Undo, error) {
	common, err := commonAncestor(mappingDestinations(mappings))
	if err != nil {
		return ReplacementResult{}, nil, err
	}
	if common == string(filepath.Separator) {
		return ReplacementResult{}, nil, invalid("replacement common root must not be filesystem root", "invalid_destination")
	}
	commonParent := filepath.Dir(common)
	if err := requireExistingDir(commonParent, "replacement_parent"); err != nil {
		return ReplacementResult{}, nil, err
	}

	stage, err := os.MkdirTemp(commonParent, ".restore-replacement-*.tmp")
	if err != nil {
		return ReplacementResult{}, nil, stepError("stage_mkdir", err)
	}
	cleanupStage := true
	defer func() {
		if cleanupStage {
			_ = os.RemoveAll(stage)
		}
	}()
	if err := os.Chmod(stage, restoreDirMode); err != nil {
		return ReplacementResult{}, nil, stepError("stage_chmod", err)
	}

	hadPrior := false
	info, statErr := os.Lstat(common)
	switch {
	case statErr == nil:
		if !info.IsDir() {
			return ReplacementResult{}, nil, invalid("replacement common root must be a directory", "invalid_destination")
		}
		hadPrior = true
		if err := copyTreeExcluding(ctx, common, stage, mappingDestinations(mappings)); err != nil {
			return ReplacementResult{}, nil, stepError("stage_copy_live", err)
		}
	case errors.Is(statErr, os.ErrNotExist):
		hadPrior = false
	default:
		return ReplacementResult{}, nil, stepError("replacement_common_stat", statErr)
	}

	materialized, err := os.MkdirTemp(commonParent, ".restore-replacement-materialized-*.tmp")
	if err != nil {
		return ReplacementResult{}, nil, stepError("materialized_mkdir", err)
	}
	cleanupMaterialized := true
	defer func() {
		if cleanupMaterialized {
			_ = os.RemoveAll(materialized)
		}
	}()
	if err := os.Chmod(materialized, restoreDirMode); err != nil {
		return ReplacementResult{}, nil, stepError("materialized_chmod", err)
	}
	if err := archive.Materialize(ctx, materialized); err != nil {
		return ReplacementResult{}, nil, stepError("materialize_archive", err)
	}

	for _, mapping := range mappings {
		stagedRoot, err := stagedDestination(common, stage, mapping.DestinationRoot)
		if err != nil {
			return ReplacementResult{}, nil, err
		}
		if err := replaceStagedRoot(filepath.Join(materialized, mapping.BackupRoot), stagedRoot); err != nil {
			return ReplacementResult{}, nil, stepError("stage_root_replace", err)
		}
	}
	if err := os.Remove(materialized); err != nil {
		return ReplacementResult{}, nil, stepError("materialized_cleanup", err)
	}
	cleanupMaterialized = false

	roots := make([]RootStatus, 0, len(mappings))
	for _, mapping := range mappings {
		stagedRoot, err := stagedDestination(common, stage, mapping.DestinationRoot)
		if err != nil {
			return ReplacementResult{}, nil, err
		}
		ok, err := archive.RootMatches(stagedRoot, mapping.BackupRoot)
		if err != nil {
			return ReplacementResult{}, nil, stepError("verify_staged_root", err)
		}
		if !ok {
			return ReplacementResult{}, nil, stepError("verify_staged_root", errTreeMismatch)
		}
		roots = append(roots, RootStatus{
			Name:            mapping.Name,
			BackupRoot:      mapping.BackupRoot,
			DestinationRoot: mapping.DestinationRoot,
			Files:           archive.FileCountForRoot(mapping.BackupRoot),
			Restored:        true,
			Verified:        true,
		})
	}

	from, err := detectOrigin(ctx, common, stage, mappings)
	if err != nil {
		return ReplacementResult{}, nil, err
	}
	if expectFrom != nil && from != "" && *expectFrom != from {
		return ReplacementResult{}, nil, invalid("backup origin does not match expectFrom", "from_mismatch")
	}

	if err := syncTreeDirs(stage); err != nil {
		return ReplacementResult{}, nil, stepError("stage_sync", err)
	}

	undo, err := commitReplacementRoot(ctx, common, stage, hadPrior)
	if err != nil {
		return ReplacementResult{}, nil, err
	}
	cleanupStage = false

	return ReplacementResult{
		BackupID: archive.BackupID(),
		Files:    archive.Files(),
		From:     from,
		To:       to,
		Roots:    roots,
		Restored: true,
		Verified: true,
	}, undo, nil
}

func commitReplacementRootAtomic(ctx context.Context, livePath string, stage string, hadPrior bool) (transaction.Undo, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !hadPrior {
		if err := os.Rename(stage, livePath); err != nil {
			return nil, stepError("publish_rename", err)
		}
		return replacementUndo{livePath: livePath, hadPrior: false}, nil
	}
	if err := renameExchange(stage, livePath); err != nil {
		return nil, stepError("publish_rename_exchange", err)
	}
	return replacementUndo{livePath: livePath, prior: stage, hadPrior: true}, nil
}

func copyTreeExcluding(ctx context.Context, source string, destination string, excluded []string) error {
	var dirs []struct {
		path string
		mode fs.FileMode
	}
	if err := filepath.WalkDir(source, func(path string, d fs.DirEntry, walkErr error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if walkErr != nil {
			return walkErr
		}
		if path != source && pathExcluded(path, excluded) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		target := filepath.Join(destination, rel)
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		mode := info.Mode()
		switch {
		case mode.IsDir():
			if err := os.MkdirAll(target, restoreDirMode); err != nil {
				return err
			}
			dirs = append(dirs, struct {
				path string
				mode fs.FileMode
			}{path: target, mode: mode.Perm()})
		case mode.Type()&fs.ModeSymlink != 0:
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			if err := os.Symlink(link, target); err != nil {
				return err
			}
		case mode.IsRegular():
			if err := copyRegularFile(path, target, mode.Perm()); err != nil {
				return err
			}
		default:
			return fmt.Errorf("live tree contains unsupported entry %s", path)
		}
		if path == source {
			return nil
		}
		if len(dirs) > 0 && dirs[len(dirs)-1].path == target {
			return nil
		}
		return nil
	}); err != nil {
		return err
	}
	sort.Slice(dirs, func(i, j int) bool {
		return len(dirs[i].path) > len(dirs[j].path)
	})
	for _, dir := range dirs {
		if err := os.Chmod(dir.path, dir.mode); err != nil {
			return err
		}
	}
	return nil
}

func copyRegularFile(source string, destination string, mode fs.FileMode) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(destination), restoreDirMode); err != nil {
		return err
	}
	out, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	closed := false
	defer func() {
		if !closed {
			_ = out.Close()
		}
	}()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	if err := out.Sync(); err != nil {
		return err
	}
	if err := out.Close(); err != nil {
		closed = true
		return err
	}
	closed = true
	if err := os.Chmod(destination, mode); err != nil {
		return err
	}
	return nil
}

func replaceStagedRoot(sourceRoot string, stagedRoot string) error {
	if err := os.RemoveAll(stagedRoot); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(stagedRoot), restoreDirMode); err != nil {
		return err
	}
	if err := os.Rename(sourceRoot, stagedRoot); err != nil {
		return err
	}
	return nil
}

func detectOrigin(ctx context.Context, common string, stage string, mappings []PlanMapping) (string, error) {
	for _, mapping := range mappings {
		if mapping.BackupRoot != "vita-agent" {
			continue
		}
		root, err := stagedDestination(common, stage, mapping.DestinationRoot)
		if err != nil {
			return "", err
		}
		origin, err := originFromAgentRoot(ctx, root)
		if err != nil {
			return "", err
		}
		return origin, nil
	}
	return "", nil
}

func originFromAgentRoot(ctx context.Context, root string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	identityPath := filepath.Join(root, "identity-attestation.json")
	if raw, err := os.ReadFile(identityPath); err == nil {
		var attestation struct {
			DID           string `json:"did"`
			Handle        string `json:"handle"`
			SigningKeyRef struct {
				ID     string `json:"id"`
				Handle string `json:"handle"`
			} `json:"signingKeyRef"`
		}
		if err := jsonsafe.DecodeStrict(raw, &attestation); err != nil {
			return "", stepError("origin_identity_parse", err)
		}
		if attestation.Handle != "" {
			return normalizeIdentityMarker(attestation.Handle, "origin identity handle")
		}
		if attestation.DID != "" {
			return normalizeIdentityMarker(attestation.DID, "origin identity did")
		}
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", stepError("origin_identity_read", err)
	}

	pdsPath := filepath.Join(root, "pds-sync-state.json")
	if raw, err := os.ReadFile(pdsPath); err == nil {
		var state struct {
			Repo     string `json:"repo"`
			Cursor   int64  `json:"cursor"`
			RepoHead string `json:"repoHead"`
		}
		if err := jsonsafe.DecodeStrict(raw, &state); err != nil {
			return "", stepError("origin_pds_parse", err)
		}
		if state.Repo != "" {
			return normalizeIdentityMarker(state.Repo, "origin pds repo")
		}
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", stepError("origin_pds_read", err)
	}
	return "", nil
}

func stagedDestination(common string, stage string, destination string) (string, error) {
	rel, err := filepath.Rel(common, destination)
	if err != nil {
		return "", err
	}
	if rel == "." {
		return stage, nil
	}
	if strings.HasPrefix(rel, ".."+string(filepath.Separator)) || rel == ".." || filepath.IsAbs(rel) {
		return "", invalid("destination escapes replacement common root", "invalid_destination")
	}
	return filepath.Join(stage, rel), nil
}

func mappingDestinations(mappings []PlanMapping) []string {
	out := make([]string, len(mappings))
	for i, mapping := range mappings {
		out[i] = mapping.DestinationRoot
	}
	return out
}

func pathExcluded(path string, excluded []string) bool {
	for _, root := range excluded {
		if pathWithin(root, path) {
			return true
		}
	}
	return false
}

func commonAncestor(paths []string) (string, error) {
	if len(paths) == 0 {
		return "", invalid("plan must contain at least one mapping", "invalid_plan")
	}
	common := splitAbsPath(paths[0])
	for _, path := range paths[1:] {
		parts := splitAbsPath(path)
		limit := len(common)
		if len(parts) < limit {
			limit = len(parts)
		}
		index := 0
		for index < limit && common[index] == parts[index] {
			index++
		}
		common = common[:index]
	}
	if len(common) == 0 {
		return string(filepath.Separator), nil
	}
	return string(filepath.Separator) + filepath.Join(common...), nil
}

func splitAbsPath(path string) []string {
	cleaned := filepath.Clean(path)
	trimmed := strings.Trim(cleaned, string(filepath.Separator))
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, string(filepath.Separator))
}

func requireExistingDir(path string, step string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return stepError(step+"_stat", err)
	}
	if !info.IsDir() {
		return stepError(step+"_stat", fmt.Errorf("%s is not a directory", path))
	}
	return nil
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
		handle, err := os.Open(dir)
		if err != nil {
			return err
		}
		err = handle.Sync()
		closeErr := handle.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}

var rootTokenPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

func normalizeRootToken(value string, field string) (string, error) {
	if value == "" {
		return "", invalid(field+" is required", "invalid_plan")
	}
	if backup.ContainsInlineSecretMaterial(value) {
		return "", invalid(field+" must not contain inline key material", "inline_secret_material")
	}
	if !rootTokenPattern.MatchString(value) {
		return "", invalid(field+" must be a stable root name", "invalid_plan")
	}
	return value, nil
}

func normalizeAbsolutePath(value string, field string, nonAbsoluteCode string) (string, error) {
	if value == "" {
		return "", invalid(field+" is required", "invalid_request")
	}
	if backup.ContainsInlineSecretMaterial(value) {
		return "", invalid(field+" must not contain inline key material or control characters", "inline_secret_material")
	}
	if !filepath.IsAbs(value) {
		return "", invalid(field+" must be an absolute path", nonAbsoluteCode)
	}
	if hasDotDotSegment(value) {
		return "", invalid(field+" must not contain dot-dot traversal", "invalid_destination")
	}
	cleaned := filepath.Clean(value)
	if cleaned == string(filepath.Separator) {
		return "", invalid(field+" must not be the filesystem root", "invalid_destination")
	}
	return cleaned, nil
}

func hasDotDotSegment(value string) bool {
	for _, segment := range strings.Split(filepath.ToSlash(value), "/") {
		if segment == ".." {
			return true
		}
	}
	return false
}

func normalizeIdentityMarker(value string, field string) (string, error) {
	if value == "" {
		return "", invalid(field+" is required", "invalid_identity")
	}
	if value != strings.TrimSpace(value) || backup.ContainsInlineSecretMaterial(value) {
		return "", invalid(field+" must not contain inline key material or control characters", "inline_secret_material")
	}
	return value, nil
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

func renameExchange(a string, b string) error {
	return unix.Renameat2(unix.AT_FDCWD, a, unix.AT_FDCWD, b, unix.RENAME_EXCHANGE)
}

var errTreeMismatch = errors.New("tree mismatch")

func stepError(step string, err error) error {
	if err == nil {
		return nil
	}
	code := sanitizeCode(step)
	if errno := errnoCode(err); errno != "" {
		code += "_" + errno
	}
	return &OperationError{
		Code: code,
		Err:  fmt.Errorf("%s: %w", step, err),
	}
}

func errnoCode(err error) string {
	var errno unix.Errno
	if errors.As(err, &errno) {
		return errnoName(errno)
	}
	if errors.Is(err, os.ErrNotExist) {
		return "ENOENT"
	}
	if errors.Is(err, os.ErrPermission) {
		return "EACCES"
	}
	if errors.Is(err, os.ErrExist) {
		return "EEXIST"
	}
	return ""
}

func errnoName(errno unix.Errno) string {
	switch errno {
	case unix.EACCES:
		return "EACCES"
	case unix.EEXIST:
		return "EEXIST"
	case unix.EINVAL:
		return "EINVAL"
	case unix.EIO:
		return "EIO"
	case unix.ENOENT:
		return "ENOENT"
	case unix.ENOSPC:
		return "ENOSPC"
	case unix.ENOTDIR:
		return "ENOTDIR"
	case unix.ENOTEMPTY:
		return "ENOTEMPTY"
	case unix.EPERM:
		return "EPERM"
	case unix.EXDEV:
		return "EXDEV"
	default:
		return fmt.Sprintf("ERRNO_%d", errno)
	}
}

func invalid(reason string, code string) *InvalidRequestError {
	if code == "" {
		code = sanitizeCode(reason)
	}
	return &InvalidRequestError{Reason: reason, Code: code}
}

func sanitizeCode(value string) string {
	var builder strings.Builder
	lastUnderscore := false
	for _, r := range value {
		switch {
		case r >= 'A' && r <= 'Z':
			builder.WriteRune(r)
			lastUnderscore = false
		case r >= 'a' && r <= 'z':
			builder.WriteRune(r)
			lastUnderscore = false
		case r >= '0' && r <= '9':
			builder.WriteRune(r)
			lastUnderscore = false
		case r == '_' || r == '-' || r == '.':
			builder.WriteByte('_')
			lastUnderscore = true
		default:
			if !lastUnderscore {
				builder.WriteByte('_')
				lastUnderscore = true
			}
		}
	}
	token := strings.Trim(builder.String(), "_")
	if token == "" {
		return "invalid_request"
	}
	return token
}

func defaultNodeID(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	name, err := os.Hostname()
	if err != nil {
		return "", err
	}
	return name, nil
}

func cloneStatus(status *Status) *Status {
	if status == nil {
		return nil
	}
	out := *status
	out.Roots = cloneRootStatuses(status.Roots)
	return &out
}

func cloneRootStatuses(in []RootStatus) []RootStatus {
	out := make([]RootStatus, len(in))
	copy(out, in)
	return out
}
