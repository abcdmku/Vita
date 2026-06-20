package update

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/transaction"
)

const (
	Name = "update.plan"

	defaultStateRoot      = "/var/lib/vita-agent"
	defaultStateFilename  = "rauc-update-desired-state.json"
	updateStateFileMode   = 0o600
	updateStateRootMode   = 0o700
	maxBundleRefLength    = 256
	maxBundleVersionBytes = 128
)

type Slot string

const (
	SlotA Slot = "a"
	SlotB Slot = "b"
)

type BundleRef struct {
	Ref       string `json:"ref"`
	Integrity string `json:"integrity"`
	Version   string `json:"version"`
}

type Plan struct {
	TargetSlot Slot      `json:"targetSlot"`
	Bundle     BundleRef `json:"bundle"`
}

type ReadRequest struct{}

func (ReadRequest) CapabilityRequest() {}

func (ReadRequest) Validate() error { return nil }

type ApplyRequest struct {
	Desired Plan `json:"desired"`
}

func (ApplyRequest) CapabilityRequest() {}

func (r ApplyRequest) Validate() error {
	return validatePlan(r.Desired)
}

type ReadResponse struct {
	Exists bool   `json:"exists"`
	Plan   Plan   `json:"plan"`
	Raw    []byte `json:"raw"`
}

func (ReadResponse) CapabilityResponse() {}

type Capability struct {
	fs stateFileSystem
}

type stateSnapshot struct {
	exists bool
	bytes  []byte
}

type stateFileSystem interface {
	Read(context.Context) (stateSnapshot, error)
	AtomicWrite(context.Context, []byte) error
	Replace(context.Context, stateSnapshot) error
}

type InvalidRequestError struct {
	Reason string
}

func (e *InvalidRequestError) Error() string {
	return fmt.Sprintf("invalid update plan request: %s", e.Reason)
}

type ParseError struct {
	Reason string
}

func (e *ParseError) Error() string {
	return fmt.Sprintf("parse update plan: %s", e.Reason)
}

func NewCapability() *Capability {
	return newCapability(newDefaultFileSystem())
}

func newCapability(fs stateFileSystem) *Capability {
	return &Capability{fs: fs}
}

func (c *Capability) Name() string {
	return Name
}

func (c *Capability) Handle(ctx context.Context, req capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	if _, ok := req.(ReadRequest); !ok {
		return nil, &InvalidRequestError{Reason: "expected update.ReadRequest"}
	}
	if c == nil || c.fs == nil {
		return nil, &InvalidRequestError{Reason: "missing update state filesystem"}
	}

	snapshot, err := c.fs.Read(ctx)
	if err != nil {
		return nil, err
	}
	if !snapshot.exists {
		return ReadResponse{Exists: false}, nil
	}

	parsed, err := parsePlan(snapshot.bytes)
	if err != nil {
		return nil, err
	}

	return ReadResponse{
		Exists: true,
		Plan:   parsed,
		Raw:    cloneBytes(snapshot.bytes),
	}, nil
}

func (c *Capability) Apply(ctx context.Context, req capabilities.TypedRequest) (transaction.Undo, error) {
	applyReq, ok := req.(ApplyRequest)
	if !ok {
		return nil, &InvalidRequestError{Reason: "expected update.ApplyRequest"}
	}
	if c == nil || c.fs == nil {
		return nil, &InvalidRequestError{Reason: "missing update state filesystem"}
	}
	if err := applyReq.Validate(); err != nil {
		return nil, err
	}

	prior, err := c.fs.Read(ctx)
	if err != nil {
		return nil, err
	}

	if err := c.fs.AtomicWrite(ctx, renderPlan(applyReq.Desired)); err != nil {
		return nil, err
	}

	return undoState{
		fs:    c.fs,
		prior: cloneSnapshot(prior),
	}, nil
}

type undoState struct {
	fs    stateFileSystem
	prior stateSnapshot
}

func (u undoState) Undo(ctx context.Context) error {
	if u.fs == nil {
		return &InvalidRequestError{Reason: "missing update state filesystem"}
	}
	return u.fs.Replace(ctx, cloneSnapshot(u.prior))
}

type defaultFileSystem struct {
	stateRoot string
	path      string
}

func newDefaultFileSystem() stateFileSystem {
	return defaultFileSystem{
		stateRoot: defaultStateRoot,
		path:      filepath.Join(defaultStateRoot, defaultStateFilename),
	}
}

func (fs defaultFileSystem) Read(ctx context.Context) (stateSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return stateSnapshot{}, err
	}

	content, err := os.ReadFile(fs.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return stateSnapshot{exists: false}, nil
		}
		return stateSnapshot{}, fmt.Errorf("read update state: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return stateSnapshot{}, err
	}

	return stateSnapshot{exists: true, bytes: cloneBytes(content)}, nil
}

func (fs defaultFileSystem) AtomicWrite(ctx context.Context, content []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.MkdirAll(fs.stateRoot, updateStateRootMode); err != nil {
		return fmt.Errorf("create update state root: %w", err)
	}
	if err := os.Chmod(fs.stateRoot, updateStateRootMode); err != nil {
		return fmt.Errorf("secure update state root: %w", err)
	}

	tmp, err := os.CreateTemp(fs.stateRoot, ".rauc-update-desired-state-*.tmp")
	if err != nil {
		return fmt.Errorf("create update state temp file: %w", err)
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

	if err := tmp.Chmod(updateStateFileMode); err != nil {
		return fmt.Errorf("secure update state temp file: %w", err)
	}
	written, err := tmp.Write(content)
	if err != nil {
		return fmt.Errorf("write update state temp file: %w", err)
	}
	if written != len(content) {
		return fmt.Errorf("write update state temp file: %w", io.ErrShortWrite)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("sync update state temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		closed = true
		return fmt.Errorf("close update state temp file: %w", err)
	}
	closed = true

	if err := ctx.Err(); err != nil {
		return err
	}
	// Rename is the single commit point: callers only receive an undo after nil error.
	if err := os.Rename(tmpName, fs.path); err != nil {
		return fmt.Errorf("replace update state: %w", err)
	}
	cleanupTemp = false
	return nil
}

func (fs defaultFileSystem) Replace(ctx context.Context, snapshot stateSnapshot) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if snapshot.exists {
		return fs.AtomicWrite(ctx, snapshot.bytes)
	}

	if err := os.Remove(fs.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove update state: %w", err)
	}
	return nil
}

var (
	bundleRefPattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$`)
	bundleVersionPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$`)
	sriPattern           = regexp.MustCompile(`^sha(256|384|512)-([A-Za-z0-9+/]+={0,2})$`)
	inlineRefSchemes     = map[string]struct{}{
		"data":    {},
		"inline":  {},
		"literal": {},
	}
)

func validatePlan(plan Plan) error {
	switch plan.TargetSlot {
	case SlotA, SlotB:
	default:
		return &InvalidRequestError{Reason: "targetSlot must be a or b"}
	}

	return validateBundleRef(plan.Bundle)
}

func validateBundleRef(bundle BundleRef) error {
	if bundle.Ref == "" {
		return &InvalidRequestError{Reason: "bundle.ref is required"}
	}
	if len(bundle.Ref) > maxBundleRefLength || !bundleRefPattern.MatchString(bundle.Ref) {
		return &InvalidRequestError{Reason: "bundle.ref must be a valid bundle reference"}
	}
	if hasInlineBundleScheme(bundle.Ref) {
		return &InvalidRequestError{Reason: "bundle.ref must not embed bundle bytes"}
	}
	if bundle.Integrity == "" {
		return &InvalidRequestError{Reason: "bundle.integrity is required"}
	}
	if !isValidSRI(bundle.Integrity) {
		return &InvalidRequestError{Reason: "bundle.integrity must be a real SRI integrity (sha256/384/512)"}
	}
	if bundle.Version == "" {
		return &InvalidRequestError{Reason: "bundle.version is required"}
	}
	if len(bundle.Version) > maxBundleVersionBytes || !bundleVersionPattern.MatchString(bundle.Version) {
		return &InvalidRequestError{Reason: "bundle.version must be a valid version string"}
	}
	return nil
}

func hasInlineBundleScheme(ref string) bool {
	separator := strings.IndexByte(ref, ':')
	if separator <= 0 {
		return false
	}
	scheme := strings.ToLower(ref[:separator])
	_, forbidden := inlineRefSchemes[scheme]
	return forbidden
}

func isValidSRI(value string) bool {
	matches := sriPattern.FindStringSubmatch(value)
	if len(matches) != 3 {
		return false
	}

	expectedLength := 0
	switch matches[1] {
	case "256":
		expectedLength = 32
	case "384":
		expectedLength = 48
	case "512":
		expectedLength = 64
	default:
		return false
	}

	digest := matches[2]
	var decoded []byte
	var err error
	if strings.Contains(digest, "=") {
		decoded, err = base64.StdEncoding.DecodeString(digest)
	} else {
		decoded, err = base64.RawStdEncoding.DecodeString(digest)
	}
	return err == nil && len(decoded) == expectedLength
}

func renderPlan(plan Plan) []byte {
	encoded, err := json.Marshal(plan)
	if err != nil {
		return nil
	}
	return append(encoded, '\n')
}

func parsePlan(raw []byte) (Plan, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return Plan{}, &ParseError{Reason: "empty update plan"}
	}

	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()

	var plan Plan
	if err := decoder.Decode(&plan); err != nil {
		return Plan{}, &ParseError{Reason: err.Error()}
	}
	var extra struct{}
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return Plan{}, &ParseError{Reason: "body must contain exactly one JSON value"}
		}
		return Plan{}, &ParseError{Reason: err.Error()}
	}

	if err := validatePlan(plan); err != nil {
		return Plan{}, err
	}
	return plan, nil
}

func cloneSnapshot(snapshot stateSnapshot) stateSnapshot {
	return stateSnapshot{
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
