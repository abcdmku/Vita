package capsule

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/internal/jsonsafe"
	capsulestorage "github.com/vita/agent/storage/capsules"
	"github.com/vita/agent/transaction"
)

const (
	Name      = "capsule.registry"
	FetchName = "capsule.fetch"

	defaultStateRoot        = "/var/lib/vita-agent"
	defaultRegistryFilename = "installed-capsule-registry.json"
	registryFileMode        = 0o600
	stateRootMode           = 0o700

	maxCapsuleIDLength = 255
	maxVersionLength   = 128
)

type State string

const (
	StateInstalled State = "installed"
	StateDisabled  State = "disabled"
)

type CapsuleEntry struct {
	ID        string `json:"id"`
	Version   string `json:"version"`
	Integrity string `json:"integrity"`
	State     State  `json:"state"`
}

func (e CapsuleEntry) Validate() error {
	return validateCapsuleEntry(e, "capsules[]")
}

func (e *CapsuleEntry) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, capsuleEntryFields); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	id, err := requiredStringField(fields, "id")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	version, err := requiredStringField(fields, "version")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	integrity, err := requiredStringField(fields, "integrity")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	stateValue, err := requiredStringField(fields, "state")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	entry := CapsuleEntry{
		ID:        id,
		Version:   version,
		Integrity: integrity,
		State:     State(stateValue),
	}
	if err := validateCapsuleEntry(entry, "capsules[]"); err != nil {
		return err
	}

	*e = entry
	return nil
}

type Registry struct {
	Capsules *[]CapsuleEntry `json:"capsules"`
}

func (r Registry) Validate() error {
	_, err := normalizeRegistry(r)
	return err
}

func (r *Registry) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, registryFields); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	rawCapsules, ok := fields["capsules"]
	if !ok {
		return &InvalidRequestError{Reason: "capsules is required"}
	}
	if bytes.Equal(bytes.TrimSpace(rawCapsules), []byte("null")) {
		return &InvalidRequestError{Reason: "capsules is required"}
	}

	var capsules []CapsuleEntry
	if err := decodeSingleJSONValue(rawCapsules, &capsules); err != nil {
		return err
	}

	decoded := Registry{Capsules: &capsules}
	normalized, err := normalizeRegistry(decoded)
	if err != nil {
		return err
	}
	*r = normalized
	return nil
}

type ReadRequest struct{}

func (ReadRequest) CapabilityRequest() {}

func (ReadRequest) Validate() error { return nil }

type ApplyRequest struct {
	Desired *Registry `json:"desired"`
}

func (ApplyRequest) CapabilityRequest() {}

func (r *ApplyRequest) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, applyRequestFields); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	rawDesired, ok := fields["desired"]
	if !ok {
		return &InvalidRequestError{Reason: "desired is required"}
	}
	if bytes.Equal(bytes.TrimSpace(rawDesired), []byte("null")) {
		return &InvalidRequestError{Reason: "desired is required"}
	}

	var desired Registry
	if err := decodeSingleJSONValue(rawDesired, &desired); err != nil {
		return err
	}

	*r = ApplyRequest{Desired: &desired}
	return nil
}

func (r ApplyRequest) Validate() error {
	if r.Desired == nil {
		return &InvalidRequestError{Reason: "desired is required"}
	}
	return r.Desired.Validate()
}

type ReadResponse struct {
	Exists   bool     `json:"exists"`
	Registry Registry `json:"registry"`
	Raw      []byte   `json:"raw"`
}

func (ReadResponse) CapabilityResponse() {}

type Capability struct {
	fs registryFileSystem
}

type registrySnapshot struct {
	exists bool
	bytes  []byte
}

type registryFileSystem interface {
	Read(context.Context) (registrySnapshot, error)
	AtomicWrite(context.Context, []byte) error
	Replace(context.Context, registrySnapshot) error
}

type InvalidRequestError struct {
	Reason string
}

func (e *InvalidRequestError) Error() string {
	return fmt.Sprintf("invalid capsule registry request: %s", e.Reason)
}

type ParseError struct {
	Reason string
}

func (e *ParseError) Error() string {
	return fmt.Sprintf("parse capsule registry: %s", e.Reason)
}

func NewCapability() *Capability {
	return newCapability(newDefaultFileSystem())
}

func newCapability(fs registryFileSystem) *Capability {
	return &Capability{fs: fs}
}

func (c *Capability) Name() string {
	return Name
}

func (c *Capability) Handle(ctx context.Context, req capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	if _, ok := req.(ReadRequest); !ok {
		return nil, &InvalidRequestError{Reason: "expected capsule.ReadRequest"}
	}
	if c == nil || c.fs == nil {
		return nil, &InvalidRequestError{Reason: "missing capsule registry filesystem"}
	}

	snapshot, err := c.fs.Read(ctx)
	if err != nil {
		return nil, err
	}
	if !snapshot.exists {
		return ReadResponse{Exists: false}, nil
	}

	parsed, err := parseRegistry(snapshot.bytes)
	if err != nil {
		return nil, err
	}
	canonical, err := renderRegistry(parsed)
	if err != nil {
		return nil, err
	}

	return ReadResponse{
		Exists:   true,
		Registry: cloneRegistry(parsed),
		Raw:      canonical,
	}, nil
}

func (c *Capability) Apply(ctx context.Context, req capabilities.TypedRequest) (transaction.Undo, error) {
	applyReq, ok := req.(ApplyRequest)
	if !ok {
		return nil, &InvalidRequestError{Reason: "expected capsule.ApplyRequest"}
	}
	if c == nil || c.fs == nil {
		return nil, &InvalidRequestError{Reason: "missing capsule registry filesystem"}
	}

	normalized, err := validateApplyRequest(applyReq)
	if err != nil {
		return nil, err
	}
	desiredBytes, err := renderRegistry(normalized)
	if err != nil {
		return nil, err
	}

	prior, err := c.fs.Read(ctx)
	if err != nil {
		return nil, err
	}

	if err := c.fs.AtomicWrite(ctx, desiredBytes); err != nil {
		return nil, err
	}

	return undoRegistry{
		fs:    c.fs,
		prior: cloneSnapshot(prior),
	}, nil
}

type undoRegistry struct {
	fs    registryFileSystem
	prior registrySnapshot
}

func (u undoRegistry) Undo(ctx context.Context) error {
	if u.fs == nil {
		return &InvalidRequestError{Reason: "missing capsule registry filesystem"}
	}
	return u.fs.Replace(ctx, cloneSnapshot(u.prior))
}

type FetchDesired struct {
	ID          string  `json:"id"`
	Version     string  `json:"version"`
	Ref         string  `json:"ref"`
	Integrity   string  `json:"integrity"`
	ImageDigest *string `json:"imageDigest,omitempty"`
}

func (d FetchDesired) Validate() error {
	return validateFetchDesired(d, "desired")
}

func (d *FetchDesired) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &FetchInvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &FetchInvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, fetchDesiredFields); err != nil {
		return &FetchInvalidRequestError{Reason: err.Error()}
	}

	id, err := requiredStringField(fields, "id")
	if err != nil {
		return &FetchInvalidRequestError{Reason: err.Error()}
	}
	version, err := requiredStringField(fields, "version")
	if err != nil {
		return &FetchInvalidRequestError{Reason: err.Error()}
	}
	ref, err := requiredStringField(fields, "ref")
	if err != nil {
		return &FetchInvalidRequestError{Reason: err.Error()}
	}
	integrity, err := requiredStringField(fields, "integrity")
	if err != nil {
		return &FetchInvalidRequestError{Reason: err.Error()}
	}
	imageDigest, err := optionalStringPointerField(fields, "imageDigest")
	if err != nil {
		return &FetchInvalidRequestError{Reason: err.Error()}
	}

	desired := FetchDesired{
		ID:          id,
		Version:     version,
		Ref:         ref,
		Integrity:   integrity,
		ImageDigest: imageDigest,
	}
	if err := desired.Validate(); err != nil {
		return err
	}

	*d = desired
	return nil
}

type FetchApplyRequest struct {
	Desired *FetchDesired `json:"desired"`
}

func (FetchApplyRequest) CapabilityRequest() {}

func (r *FetchApplyRequest) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &FetchInvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &FetchInvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, fetchApplyRequestFields); err != nil {
		return &FetchInvalidRequestError{Reason: err.Error()}
	}

	rawDesired, ok := fields["desired"]
	if !ok || bytes.Equal(bytes.TrimSpace(rawDesired), []byte("null")) {
		return &FetchInvalidRequestError{Reason: "desired is required"}
	}

	var desired FetchDesired
	if err := decodeSingleJSONValue(rawDesired, &desired); err != nil {
		return err
	}

	*r = FetchApplyRequest{Desired: &desired}
	return nil
}

func (r FetchApplyRequest) Validate() error {
	if r.Desired == nil {
		return &FetchInvalidRequestError{Reason: "desired is required"}
	}
	return r.Desired.Validate()
}

type FetchReadRequest struct{}

func (FetchReadRequest) CapabilityRequest() {}

func (FetchReadRequest) Validate() error { return nil }

type FetchReadResponse struct {
	Last *FetchStatus `json:"last,omitempty"`
}

func (FetchReadResponse) CapabilityResponse() {}

type FetchStatus struct {
	ID          string   `json:"id"`
	Version     string   `json:"version"`
	Ref         string   `json:"ref"`
	Integrity   string   `json:"integrity"`
	LocalPath   string   `json:"localPath"`
	RootFSPath  string   `json:"rootfsPath,omitempty"`
	ImageDigest string   `json:"imageDigest,omitempty"`
	Layers      int      `json:"layers,omitempty"`
	Entrypoint  []string `json:"entrypoint,omitempty"`
	Env         []string `json:"env,omitempty"`
	Status      string   `json:"status"`
}

type FetchCapability struct {
	store capsuleFetchStore

	mu   sync.Mutex
	last *FetchStatus
}

type capsuleFetchStore interface {
	FetchCapsuleFor(context.Context, string, string, string, string) (string, error)
	FetchOCIImageFor(context.Context, string, string, string, string, string) (capsulestorage.OCIFetchResult, error)
	CachePath(string, string) (string, error)
	RemoveStagedCapsule(context.Context, string) error
}

type defaultFetchStore struct{}

func (defaultFetchStore) FetchCapsuleFor(ctx context.Context, ref string, integrity string, id string, version string) (string, error) {
	return capsulestorage.FetchCapsuleFor(ctx, ref, integrity, id, version)
}

func (defaultFetchStore) FetchOCIImageFor(ctx context.Context, ref string, integrity string, id string, version string, imageDigest string) (capsulestorage.OCIFetchResult, error) {
	return capsulestorage.FetchOCIImageFor(ctx, ref, integrity, id, version, imageDigest)
}

func (defaultFetchStore) CachePath(id string, version string) (string, error) {
	return capsulestorage.CachePath(id, version)
}

func (defaultFetchStore) RemoveStagedCapsule(ctx context.Context, localPath string) error {
	return capsulestorage.RemoveStagedCapsule(ctx, localPath)
}

type FetchInvalidRequestError struct {
	Reason string
}

func (e *FetchInvalidRequestError) Error() string {
	return fmt.Sprintf("invalid capsule fetch request: %s", e.Reason)
}

func NewFetchCapability() *FetchCapability {
	return newFetchCapability(defaultFetchStore{})
}

func newFetchCapability(store capsuleFetchStore) *FetchCapability {
	return &FetchCapability{store: store}
}

func (c *FetchCapability) Name() string {
	return FetchName
}

func (c *FetchCapability) Handle(ctx context.Context, req capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	if _, ok := req.(FetchReadRequest); !ok {
		return nil, &FetchInvalidRequestError{Reason: "expected capsule.FetchReadRequest"}
	}
	if c == nil {
		return nil, &FetchInvalidRequestError{Reason: "missing capsule fetch capability"}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	if c.last == nil {
		return FetchReadResponse{}, nil
	}
	last := *c.last
	return FetchReadResponse{Last: &last}, nil
}

func (c *FetchCapability) Apply(ctx context.Context, req capabilities.TypedRequest) (transaction.Undo, error) {
	applyReq, ok := req.(FetchApplyRequest)
	if !ok {
		return nil, &FetchInvalidRequestError{Reason: "expected capsule.FetchApplyRequest"}
	}
	if c == nil || c.store == nil {
		return nil, &FetchInvalidRequestError{Reason: "missing capsule fetch dependency"}
	}
	if applyReq.Desired == nil {
		return nil, &FetchInvalidRequestError{Reason: "desired is required"}
	}

	desired := *applyReq.Desired
	if err := validateFetchDesired(desired, "desired"); err != nil {
		return nil, err
	}

	target, err := c.store.CachePath(desired.ID, desired.Version)
	if err != nil {
		return nil, err
	}
	preexisting := pathExists(target)

	localPath := ""
	var ociResult capsulestorage.OCIFetchResult
	if desired.ImageDigest != nil {
		ociResult, err = c.store.FetchOCIImageFor(ctx, desired.Ref, desired.Integrity, desired.ID, desired.Version, *desired.ImageDigest)
		if err != nil {
			return nil, err
		}
		localPath = ociResult.CapsulePath
	} else {
		localPath, err = c.store.FetchCapsuleFor(ctx, desired.Ref, desired.Integrity, desired.ID, desired.Version)
		if err != nil {
			return nil, err
		}
	}
	if localPath != target {
		if !preexisting {
			_ = c.store.RemoveStagedCapsule(ctx, localPath)
		}
		return nil, &FetchInvalidRequestError{Reason: "staged capsule path does not match request"}
	}

	status := FetchStatus{
		ID:          desired.ID,
		Version:     desired.Version,
		Ref:         desired.Ref,
		Integrity:   desired.Integrity,
		LocalPath:   localPath,
		RootFSPath:  ociResult.RootFSPath,
		ImageDigest: ociResult.ImageDigest,
		Layers:      ociResult.Layers,
		Entrypoint:  cloneStrings(ociResult.Entrypoint),
		Env:         cloneStrings(ociResult.Env),
		Status:      "OK",
	}
	c.setLastFetch(status)

	return fetchUndo{
		capability:   c,
		store:        c.store,
		localPath:    localPath,
		removeOnUndo: !preexisting,
	}, nil
}

func (c *FetchCapability) setLastFetch(status FetchStatus) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.last = &FetchStatus{
		ID:          status.ID,
		Version:     status.Version,
		Ref:         status.Ref,
		Integrity:   status.Integrity,
		LocalPath:   status.LocalPath,
		RootFSPath:  status.RootFSPath,
		ImageDigest: status.ImageDigest,
		Layers:      status.Layers,
		Entrypoint:  cloneStrings(status.Entrypoint),
		Env:         cloneStrings(status.Env),
		Status:      status.Status,
	}
}

func (c *FetchCapability) clearLastFetch(localPath string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.last != nil && c.last.LocalPath == localPath {
		c.last = nil
	}
}

type fetchUndo struct {
	capability   *FetchCapability
	store        capsuleFetchStore
	localPath    string
	removeOnUndo bool
}

func (u fetchUndo) Undo(ctx context.Context) error {
	if u.store == nil {
		return &FetchInvalidRequestError{Reason: "missing capsule fetch dependency"}
	}
	if u.removeOnUndo {
		if err := u.store.RemoveStagedCapsule(ctx, u.localPath); err != nil {
			return err
		}
	}
	if u.capability != nil {
		u.capability.clearLastFetch(u.localPath)
	}
	return nil
}

type defaultFileSystem struct {
	stateRoot string
	path      string
}

func newDefaultFileSystem() registryFileSystem {
	return defaultFileSystem{
		stateRoot: defaultStateRoot,
		path:      filepath.Join(defaultStateRoot, defaultRegistryFilename),
	}
}

func (fs defaultFileSystem) Read(ctx context.Context) (registrySnapshot, error) {
	if err := ctx.Err(); err != nil {
		return registrySnapshot{}, err
	}

	content, err := os.ReadFile(fs.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return registrySnapshot{exists: false}, nil
		}
		return registrySnapshot{}, fmt.Errorf("read capsule registry: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return registrySnapshot{}, err
	}

	return registrySnapshot{exists: true, bytes: cloneBytes(content)}, nil
}

func (fs defaultFileSystem) AtomicWrite(ctx context.Context, content []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.MkdirAll(fs.stateRoot, stateRootMode); err != nil {
		return fmt.Errorf("create capsule registry state root: %w", err)
	}
	if err := os.Chmod(fs.stateRoot, stateRootMode); err != nil {
		return fmt.Errorf("secure capsule registry state root: %w", err)
	}

	tmp, err := os.CreateTemp(fs.stateRoot, ".installed-capsule-registry-*.tmp")
	if err != nil {
		return fmt.Errorf("create capsule registry temp file: %w", err)
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

	if err := tmp.Chmod(registryFileMode); err != nil {
		return fmt.Errorf("secure capsule registry temp file: %w", err)
	}
	written, err := tmp.Write(content)
	if err != nil {
		return fmt.Errorf("write capsule registry temp file: %w", err)
	}
	if written != len(content) {
		return fmt.Errorf("write capsule registry temp file: %w", io.ErrShortWrite)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("sync capsule registry temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		closed = true
		return fmt.Errorf("close capsule registry temp file: %w", err)
	}
	closed = true

	if err := ctx.Err(); err != nil {
		return err
	}
	// Rename is the single commit point: callers only receive an undo after nil error.
	if err := os.Rename(tmpName, fs.path); err != nil {
		return fmt.Errorf("replace capsule registry: %w", err)
	}
	cleanupTemp = false
	return nil
}

func (fs defaultFileSystem) Replace(ctx context.Context, snapshot registrySnapshot) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if snapshot.exists {
		return fs.AtomicWrite(ctx, snapshot.bytes)
	}

	if err := os.Remove(fs.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove capsule registry: %w", err)
	}
	return nil
}

var (
	fetchApplyRequestFields = map[string]struct{}{
		"desired": {},
	}
	fetchDesiredFields = map[string]struct{}{
		"id":          {},
		"imageDigest": {},
		"integrity":   {},
		"ref":         {},
		"version":     {},
	}
	applyRequestFields = map[string]struct{}{
		"desired": {},
	}
	registryFields = map[string]struct{}{
		"capsules": {},
	}
	capsuleEntryFields = map[string]struct{}{
		"id":        {},
		"integrity": {},
		"state":     {},
		"version":   {},
	}

	reverseDNSPattern      = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$`)
	opaqueIDPattern        = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$`)
	versionPattern         = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$`)
	controlCharacter       = regexp.MustCompile(`[\x00-\x1f\x7f]`)
	privateKeyPattern      = regexp.MustCompile(`(?i)\b(?:private[-_\s]?key|openssh\s+private\s+key|age-secret-key|xprv|seed[-_\s]?phrase|mnemonic|recovery[-_\s]?phrase)\b`)
	secretAssignment       = regexp.MustCompile(`(?i)\b(?:private[-_\s]?key|api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|password|secret)\s*[:=]`)
	seedWordsPattern       = regexp.MustCompile(`(?i)\b[a-z]{3,12}(?:\s+[a-z]{3,12}){11,23}\b`)
	longHexPattern         = regexp.MustCompile(`(?:0x)?[A-Fa-f0-9]{32,}`)
	longBase64Pattern      = regexp.MustCompile(`[A-Za-z0-9+/]{48,}={0,2}|[A-Za-z0-9_-]{48,}`)
	inlineReferenceSchemes = map[string]struct{}{
		"data":    {},
		"inline":  {},
		"literal": {},
	}
	embeddedCapsuleFieldNames = map[string]struct{}{
		"archive":      {},
		"blob":         {},
		"bytes":        {},
		"capsulebytes": {},
		"content":      {},
		"data":         {},
		"payload":      {},
	}
)

func validateApplyRequest(req ApplyRequest) (Registry, error) {
	if req.Desired == nil {
		return Registry{}, &InvalidRequestError{Reason: "desired is required"}
	}
	return normalizeRegistry(*req.Desired)
}

func validateFetchDesired(desired FetchDesired, field string) error {
	if desired.ID == "" {
		return &FetchInvalidRequestError{Reason: field + ".id is required"}
	}
	if !validCapsuleID(desired.ID) {
		return &FetchInvalidRequestError{Reason: field + ".id must be a well-formed capsule id"}
	}
	if desired.Version == "" {
		return &FetchInvalidRequestError{Reason: field + ".version is required"}
	}
	if !validVersion(desired.Version) {
		return &FetchInvalidRequestError{Reason: field + ".version must be a safe non-inline version string"}
	}
	if desired.Ref == "" {
		return &FetchInvalidRequestError{Reason: field + ".ref is required"}
	}
	if _, err := capsulestorage.ResolveLocalRef(desired.Ref); err != nil {
		return &FetchInvalidRequestError{Reason: field + ".ref must be a local file artifact reference"}
	}
	if desired.Integrity == "" {
		return &FetchInvalidRequestError{Reason: field + ".integrity is required"}
	}
	if !isValidSRI(desired.Integrity) {
		return &FetchInvalidRequestError{Reason: field + ".integrity must be a real SRI integrity"}
	}
	if desired.ImageDigest != nil {
		if *desired.ImageDigest == "" {
			return &FetchInvalidRequestError{Reason: field + ".imageDigest is required when present"}
		}
		if !capsulestorage.IsValidOCIDigest(*desired.ImageDigest) {
			return &FetchInvalidRequestError{Reason: field + ".imageDigest must be sha256:<64 lowercase hex>"}
		}
	}
	return nil
}

func normalizeRegistry(registry Registry) (Registry, error) {
	if registry.Capsules == nil {
		return Registry{}, &InvalidRequestError{Reason: "capsules is required"}
	}

	capsules := *registry.Capsules
	normalized := make([]CapsuleEntry, len(capsules))
	seen := make(map[string]int, len(capsules))
	for i, entry := range capsules {
		field := fmt.Sprintf("capsules[%d]", i)
		if err := validateCapsuleEntry(entry, field); err != nil {
			return Registry{}, err
		}
		if previous, ok := seen[entry.ID]; ok {
			return Registry{}, &InvalidRequestError{Reason: fmt.Sprintf("capsules[%d].id duplicates capsules[%d].id", i, previous)}
		}
		seen[entry.ID] = i
		normalized[i] = CapsuleEntry{
			ID:        entry.ID,
			Version:   entry.Version,
			Integrity: entry.Integrity,
			State:     entry.State,
		}
	}

	return Registry{Capsules: &normalized}, nil
}

func validateCapsuleEntry(entry CapsuleEntry, field string) error {
	if entry.ID == "" {
		return &InvalidRequestError{Reason: field + ".id is required"}
	}
	if !validCapsuleID(entry.ID) {
		return &InvalidRequestError{Reason: field + ".id must be a well-formed reverse-DNS or opaque capsule id"}
	}
	if entry.Version == "" {
		return &InvalidRequestError{Reason: field + ".version is required"}
	}
	if !validVersion(entry.Version) {
		return &InvalidRequestError{Reason: field + ".version must be a safe non-inline version string"}
	}
	if entry.Integrity == "" {
		return &InvalidRequestError{Reason: field + ".integrity is required"}
	}
	if !isValidSRI(entry.Integrity) {
		return &InvalidRequestError{Reason: field + ".integrity must be a real SRI integrity (sha256/384/512)"}
	}

	switch entry.State {
	case StateInstalled, StateDisabled:
	default:
		return &InvalidRequestError{Reason: field + ".state must be installed or disabled"}
	}

	return nil
}

func validCapsuleID(value string) bool {
	if len(value) > maxCapsuleIDLength ||
		value != strings.TrimSpace(value) ||
		controlCharacter.MatchString(value) ||
		containsInlineCapsuleMaterial(value) ||
		hasInlineReferenceScheme(value) {
		return false
	}
	return reverseDNSPattern.MatchString(value) || opaqueIDPattern.MatchString(value)
}

func validVersion(value string) bool {
	if len(value) > maxVersionLength ||
		value != strings.TrimSpace(value) ||
		controlCharacter.MatchString(value) ||
		containsInlineCapsuleMaterial(value) ||
		hasInlineReferenceScheme(value) {
		return false
	}
	return versionPattern.MatchString(value)
}

func hasInlineReferenceScheme(value string) bool {
	colon := strings.IndexByte(value, ':')
	if colon <= 0 {
		return false
	}
	scheme := strings.ToLower(value[:colon])
	_, forbidden := inlineReferenceSchemes[scheme]
	return forbidden
}

func containsInlineCapsuleMaterial(value string) bool {
	if strings.Contains(strings.ToUpper(value), "-----BEGIN") ||
		privateKeyPattern.MatchString(value) ||
		secretAssignment.MatchString(value) ||
		seedWordsPattern.MatchString(value) {
		return true
	}
	return longHexPattern.MatchString(value) || longBase64Pattern.MatchString(value)
}

func isValidSRI(value string) bool {
	return capsulestorage.IsValidIntegrity(value)
}

func pathExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil || !errors.Is(err, os.ErrNotExist)
}

func renderRegistry(registry Registry) ([]byte, error) {
	normalized, err := normalizeRegistry(registry)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return nil, fmt.Errorf("render capsule registry: %w", err)
	}
	return append(encoded, '\n'), nil
}

func parseRegistry(raw []byte) (Registry, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return Registry{}, &ParseError{Reason: "empty capsule registry"}
	}

	var registry Registry
	if err := json.Unmarshal(raw, &registry); err != nil {
		return Registry{}, &ParseError{Reason: err.Error()}
	}
	normalized, err := normalizeRegistry(registry)
	if err != nil {
		return Registry{}, err
	}
	return normalized, nil
}

func decodeObject(raw []byte) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delimiter, ok := token.(json.Delim)
	if !ok || delimiter != '{' {
		return nil, errors.New("expected object")
	}

	fields := make(map[string]json.RawMessage)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key, ok := token.(string)
		if !ok {
			return nil, errors.New("expected object key")
		}
		if _, exists := fields[key]; exists {
			return nil, fmt.Errorf("duplicate JSON object key %q", key)
		}

		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		fields[key] = cloneBytes(value)
	}

	token, err = decoder.Token()
	if err != nil {
		return nil, err
	}
	delimiter, ok = token.(json.Delim)
	if !ok || delimiter != '}' {
		return nil, errors.New("expected object end")
	}

	var extra struct{}
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return nil, errors.New("body must contain exactly one JSON value")
		}
		return nil, err
	}

	return fields, nil
}

func rejectUnknownFields(fields map[string]json.RawMessage, allowed map[string]struct{}) error {
	names := make([]string, 0, len(fields))
	for key := range fields {
		names = append(names, key)
	}
	sort.Strings(names)

	for _, key := range names {
		if _, ok := allowed[key]; ok {
			continue
		}
		if isEmbeddedCapsuleFieldName(key) {
			return fmt.Errorf("%s must not embed capsule bytes", key)
		}
		return fmt.Errorf("unknown field %q", key)
	}
	return nil
}

func requiredStringField(fields map[string]json.RawMessage, key string) (string, error) {
	raw, ok := fields[key]
	if !ok {
		return "", fmt.Errorf("%s is required", key)
	}

	var value string
	if err := decodeSingleJSONValue(raw, &value); err != nil {
		return "", fmt.Errorf("%s must be a string", key)
	}
	return value, nil
}

func optionalStringPointerField(fields map[string]json.RawMessage, key string) (*string, error) {
	raw, ok := fields[key]
	if !ok {
		return nil, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, fmt.Errorf("%s must be a string", key)
	}
	var value string
	if err := decodeSingleJSONValue(raw, &value); err != nil {
		return nil, fmt.Errorf("%s must be a string", key)
	}
	return &value, nil
}

func decodeSingleJSONValue(raw []byte, target interface{}) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := decoder.Decode(target); err != nil {
		return err
	}

	var extra struct{}
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return errors.New("body must contain exactly one JSON value")
		}
		return err
	}
	return nil
}

func isEmbeddedCapsuleFieldName(value string) bool {
	normalized := strings.NewReplacer("-", "", "_", "").Replace(strings.ToLower(value))
	_, ok := embeddedCapsuleFieldNames[normalized]
	return ok
}

func cloneRegistry(registry Registry) Registry {
	if registry.Capsules == nil {
		return Registry{}
	}
	capsules := cloneCapsules(*registry.Capsules)
	return Registry{Capsules: &capsules}
}

func cloneCapsules(capsules []CapsuleEntry) []CapsuleEntry {
	out := make([]CapsuleEntry, len(capsules))
	copy(out, capsules)
	return out
}

func cloneSnapshot(snapshot registrySnapshot) registrySnapshot {
	return registrySnapshot{
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

func cloneStrings(in []string) []string {
	if in == nil {
		return nil
	}
	out := make([]string, len(in))
	copy(out, in)
	return out
}
