package storage

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/internal/atomicfile"
	"github.com/vita/agent/internal/jsonsafe"
	"github.com/vita/agent/transaction"
)

const (
	Name = "storage.layout"

	defaultStateRoot      = "/var/lib/vita-agent"
	defaultLayoutFilename = "storage-layout.json"
	layoutFileMode        = 0o600
	stateRootMode         = 0o700
)

type Role string

const (
	RoleSystemState      Role = "system-state"
	RoleUserData         Role = "user-data"
	RoleAppState         Role = "app-state"
	RoleSnapshots        Role = "snapshots"
	RoleLocalBackupCache Role = "local-backup-cache"
)

type Subvolume struct {
	Role     Role    `json:"role"`
	Path     string  `json:"path"`
	AppID    *string `json:"appId,omitempty"`
	QuotaGiB *int64  `json:"quotaGiB,omitempty"`
}

type Layout struct {
	Subvolumes *[]Subvolume `json:"subvolumes"`
}

type ReadRequest struct{}

func (ReadRequest) CapabilityRequest() {}

func (ReadRequest) Validate() error { return nil }

type ApplyRequest struct {
	Desired *Layout `json:"desired"`
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
	if r.Desired == nil {
		return &InvalidRequestError{Reason: "desired is required"}
	}
	return validateLayout(*r.Desired)
}

type ReadResponse struct {
	Exists bool   `json:"exists"`
	Layout Layout `json:"layout"`
	Raw    []byte `json:"raw"`
}

func (ReadResponse) CapabilityResponse() {}

type Capability struct {
	fs layoutFileSystem
}

type layoutSnapshot struct {
	exists bool
	bytes  []byte
}

type layoutFileSystem interface {
	Read(context.Context) (layoutSnapshot, error)
	AtomicWrite(context.Context, []byte) error
	Replace(context.Context, layoutSnapshot) error
}

type InvalidRequestError struct {
	Reason string
}

func (e *InvalidRequestError) Error() string {
	return fmt.Sprintf("invalid storage layout request: %s", e.Reason)
}

type ParseError struct {
	Reason string
}

func (e *ParseError) Error() string {
	return fmt.Sprintf("parse storage layout: %s", e.Reason)
}

func NewCapability() *Capability {
	return newCapability(newDefaultFileSystem())
}

func newCapability(fs layoutFileSystem) *Capability {
	return &Capability{fs: fs}
}

func (c *Capability) Name() string {
	return Name
}

func (c *Capability) Handle(ctx context.Context, req capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	if _, ok := req.(ReadRequest); !ok {
		return nil, &InvalidRequestError{Reason: "expected storage.ReadRequest"}
	}
	if c == nil || c.fs == nil {
		return nil, &InvalidRequestError{Reason: "missing storage layout filesystem"}
	}

	snapshot, err := c.fs.Read(ctx)
	if err != nil {
		return nil, err
	}
	if !snapshot.exists {
		return ReadResponse{Exists: false}, nil
	}

	parsed, err := parseLayout(snapshot.bytes)
	if err != nil {
		return nil, err
	}

	return ReadResponse{
		Exists: true,
		Layout: cloneLayout(parsed),
		Raw:    cloneBytes(snapshot.bytes),
	}, nil
}

func (c *Capability) Apply(ctx context.Context, req capabilities.TypedRequest) (transaction.Undo, error) {
	applyReq, ok := req.(ApplyRequest)
	if !ok {
		return nil, &InvalidRequestError{Reason: "expected storage.ApplyRequest"}
	}
	if c == nil || c.fs == nil {
		return nil, &InvalidRequestError{Reason: "missing storage layout filesystem"}
	}
	normalized, err := validateApplyRequest(applyReq)
	if err != nil {
		return nil, err
	}

	prior, err := c.fs.Read(ctx)
	if err != nil {
		return nil, err
	}

	if err := c.fs.AtomicWrite(ctx, renderLayout(normalized)); err != nil {
		return nil, err
	}

	return undoLayout{
		fs:    c.fs,
		prior: cloneSnapshot(prior),
	}, nil
}

type undoLayout struct {
	fs    layoutFileSystem
	prior layoutSnapshot
}

func (u undoLayout) Undo(ctx context.Context) error {
	if u.fs == nil {
		return &InvalidRequestError{Reason: "missing storage layout filesystem"}
	}
	return u.fs.Replace(ctx, cloneSnapshot(u.prior))
}

type defaultFileSystem struct {
	stateRoot string
	path      string
}

func newDefaultFileSystem() layoutFileSystem {
	return defaultFileSystem{
		stateRoot: defaultStateRoot,
		path:      filepath.Join(defaultStateRoot, defaultLayoutFilename),
	}
}

func (fs defaultFileSystem) Read(ctx context.Context) (layoutSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return layoutSnapshot{}, err
	}

	content, err := os.ReadFile(fs.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return layoutSnapshot{exists: false}, nil
		}
		return layoutSnapshot{}, fmt.Errorf("read storage layout: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return layoutSnapshot{}, err
	}

	return layoutSnapshot{exists: true, bytes: cloneBytes(content)}, nil
}

func (fs defaultFileSystem) AtomicWrite(ctx context.Context, content []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.MkdirAll(fs.stateRoot, stateRootMode); err != nil {
		return fmt.Errorf("create storage layout state root: %w", err)
	}
	if err := os.Chmod(fs.stateRoot, stateRootMode); err != nil {
		return fmt.Errorf("secure storage layout state root: %w", err)
	}

	if err := atomicfile.WriteWithPatternAndBeforeCommit(
		atomicfile.OSFileSystem{},
		fs.path,
		content,
		layoutFileMode,
		".storage-layout-*.tmp",
		ctx.Err,
	); err != nil {
		return fmt.Errorf("write storage layout: %w", err)
	}
	return nil
}

func (fs defaultFileSystem) Replace(ctx context.Context, snapshot layoutSnapshot) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if snapshot.exists {
		return fs.AtomicWrite(ctx, snapshot.bytes)
	}

	if err := os.Remove(fs.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove storage layout: %w", err)
	}
	return nil
}

func validateApplyRequest(req ApplyRequest) (Layout, error) {
	if req.Desired == nil {
		return Layout{}, &InvalidRequestError{Reason: "desired is required"}
	}
	return normalizeLayout(*req.Desired)
}

func validateLayout(layout Layout) error {
	_, err := normalizeLayout(layout)
	return err
}

var singletonRoles = map[Role]struct{}{
	RoleSystemState:      {},
	RoleUserData:         {},
	RoleSnapshots:        {},
	RoleLocalBackupCache: {},
}

var requiredRoles = []Role{
	RoleSystemState,
	RoleUserData,
	RoleAppState,
	RoleSnapshots,
	RoleLocalBackupCache,
}

func normalizeLayout(layout Layout) (Layout, error) {
	if layout.Subvolumes == nil {
		return Layout{}, &InvalidRequestError{Reason: "subvolumes is required"}
	}
	if *layout.Subvolumes == nil {
		return Layout{}, &InvalidRequestError{Reason: "subvolumes must be a list"}
	}

	subvolumes := *layout.Subvolumes
	if len(subvolumes) == 0 {
		return Layout{}, &InvalidRequestError{Reason: "subvolumes must contain required storage areas"}
	}

	normalized := make([]Subvolume, len(subvolumes))
	seenRoles := make(map[Role]int, len(requiredRoles))
	seenAppIDs := make(map[string]int)

	for i, subvolume := range subvolumes {
		normalizedSubvolume, err := normalizeSubvolume(i, subvolume)
		if err != nil {
			return Layout{}, err
		}
		normalized[i] = normalizedSubvolume

		if previousIndex, ok := seenRoles[normalizedSubvolume.Role]; ok {
			if _, singleton := singletonRoles[normalizedSubvolume.Role]; singleton {
				return Layout{}, &InvalidRequestError{Reason: fmt.Sprintf("subvolumes[%d].role duplicates %s area from subvolumes[%d]", i, normalizedSubvolume.Role, previousIndex)}
			}
		} else {
			seenRoles[normalizedSubvolume.Role] = i
		}

		if normalizedSubvolume.Role == RoleAppState && normalizedSubvolume.AppID != nil {
			appID := *normalizedSubvolume.AppID
			if previousIndex, ok := seenAppIDs[appID]; ok {
				return Layout{}, &InvalidRequestError{Reason: fmt.Sprintf("subvolumes[%d].appId duplicates app-state appId from subvolumes[%d]", i, previousIndex)}
			}
			seenAppIDs[appID] = i
		}
	}

	for _, role := range requiredRoles {
		if _, ok := seenRoles[role]; !ok {
			return Layout{}, &InvalidRequestError{Reason: fmt.Sprintf("missing required %s storage area", role)}
		}
	}

	return Layout{Subvolumes: &normalized}, nil
}

func normalizeSubvolume(index int, subvolume Subvolume) (Subvolume, error) {
	switch subvolume.Role {
	case RoleSystemState, RoleUserData, RoleAppState, RoleSnapshots, RoleLocalBackupCache:
	default:
		return Subvolume{}, &InvalidRequestError{Reason: fmt.Sprintf("subvolumes[%d].role must be a valid storage role", index)}
	}

	if !isCanonicalAbsolutePath(subvolume.Path) {
		return Subvolume{}, &InvalidRequestError{Reason: fmt.Sprintf("subvolumes[%d].path must be a canonical absolute path", index)}
	}

	if subvolume.Role == RoleAppState {
		if subvolume.AppID == nil || *subvolume.AppID == "" {
			return Subvolume{}, &InvalidRequestError{Reason: fmt.Sprintf("subvolumes[%d].appId is required for app-state", index)}
		}
	} else if subvolume.AppID != nil {
		return Subvolume{}, &InvalidRequestError{Reason: fmt.Sprintf("subvolumes[%d].appId is only allowed for app-state", index)}
	}

	if subvolume.QuotaGiB != nil && *subvolume.QuotaGiB <= 0 {
		return Subvolume{}, &InvalidRequestError{Reason: fmt.Sprintf("subvolumes[%d].quotaGiB must be positive when present", index)}
	}

	return Subvolume{
		Role:     subvolume.Role,
		Path:     subvolume.Path,
		AppID:    cloneStringPtr(subvolume.AppID),
		QuotaGiB: cloneInt64Ptr(subvolume.QuotaGiB),
	}, nil
}

func isCanonicalAbsolutePath(value string) bool {
	if !strings.HasPrefix(value, "/") || value == "/" || strings.HasSuffix(value, "/") {
		return false
	}

	segments := strings.Split(value, "/")
	for i := 1; i < len(segments); i++ {
		segment := segments[i]
		if segment == "" || segment == "." || segment == ".." || strings.ContainsRune(segment, '\x00') {
			return false
		}
	}
	return true
}

func renderLayout(layout Layout) []byte {
	encoded, err := json.Marshal(layout)
	if err != nil {
		return nil
	}
	return append(encoded, '\n')
}

func parseLayout(raw []byte) (Layout, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return Layout{}, &ParseError{Reason: "empty storage layout"}
	}

	var layout Layout
	if err := jsonsafe.DecodeStrict(raw, &layout); err != nil {
		return Layout{}, &ParseError{Reason: err.Error()}
	}

	return normalizeLayout(layout)
}

func cloneLayout(layout Layout) Layout {
	if layout.Subvolumes == nil {
		return Layout{}
	}

	subvolumes := *layout.Subvolumes
	if subvolumes == nil {
		var nilSubvolumes []Subvolume
		return Layout{Subvolumes: &nilSubvolumes}
	}

	out := make([]Subvolume, len(subvolumes))
	for i, subvolume := range subvolumes {
		out[i] = cloneSubvolume(subvolume)
	}
	return Layout{Subvolumes: &out}
}

func cloneSubvolume(subvolume Subvolume) Subvolume {
	return Subvolume{
		Role:     subvolume.Role,
		Path:     subvolume.Path,
		AppID:    cloneStringPtr(subvolume.AppID),
		QuotaGiB: cloneInt64Ptr(subvolume.QuotaGiB),
	}
}

func cloneSnapshot(snapshot layoutSnapshot) layoutSnapshot {
	return layoutSnapshot{
		exists: snapshot.exists,
		bytes:  cloneBytes(snapshot.bytes),
	}
}

func cloneBytes(in []byte) []byte {
	if in == nil {
		return nil
	}
	out := make([]byte, len(in))
	copy(out, in)
	return out
}

func cloneStringPtr(in *string) *string {
	if in == nil {
		return nil
	}
	out := *in
	return &out
}

func cloneInt64Ptr(in *int64) *int64 {
	if in == nil {
		return nil
	}
	out := *in
	return &out
}
