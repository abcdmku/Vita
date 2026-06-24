package storagesnap

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/internal/jsonsafe"
	"github.com/vita/agent/transaction"
)

const (
	Name = "storage.snapshot"

	maxSnapshotLabelBytes = 96
	maxSnapshotTagBytes   = 32
	gibBytes              = uint64(1024 * 1024 * 1024)
)

type Operation string

const (
	OpCreate       Operation = "create"
	OpList         Operation = "list"
	OpRollback     Operation = "rollback"
	OpQuotaSet     Operation = "quota-set"
	OpQuotaEnforce Operation = "quota-enforce"
)

type Desired struct {
	Op       Operation `json:"op"`
	Tag      *string   `json:"tag,omitempty"`
	Name     *string   `json:"name,omitempty"`
	QuotaGiB *int64    `json:"quotaGiB,omitempty"`
}

func (d *Desired) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, desiredFields); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	op, err := requiredOperationField(fields, "op")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	tag, err := optionalStringPtrField(fields, "tag")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	name, err := optionalStringPtrField(fields, "name")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	quotaGiB, err := optionalInt64PtrField(fields, "quotaGiB")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	decoded := Desired{
		Op:       op,
		Tag:      tag,
		Name:     name,
		QuotaGiB: quotaGiB,
	}
	if err := decoded.Validate(); err != nil {
		return err
	}

	*d = decoded
	return nil
}

func (d Desired) Validate() error {
	switch d.Op {
	case OpCreate:
		if d.Name != nil {
			return &InvalidRequestError{Reason: "name is agent-owned and must be omitted for create"}
		}
		if d.QuotaGiB != nil {
			return &InvalidRequestError{Reason: "quotaGiB is only valid for quota operations"}
		}
		if d.Tag != nil {
			if err := validateSnapshotTag(*d.Tag); err != nil {
				return err
			}
		}
	case OpList:
		if d.Tag != nil || d.Name != nil || d.QuotaGiB != nil {
			return &InvalidRequestError{Reason: "list does not accept tag, name, or quotaGiB"}
		}
	case OpRollback:
		if d.Tag != nil {
			return &InvalidRequestError{Reason: "tag is only valid for create"}
		}
		if d.QuotaGiB != nil {
			return &InvalidRequestError{Reason: "quotaGiB is only valid for quota operations"}
		}
		if d.Name == nil {
			return &InvalidRequestError{Reason: "name is required for rollback"}
		}
		if err := validateSnapshotLabel(*d.Name, "name"); err != nil {
			return err
		}
	case OpQuotaSet, OpQuotaEnforce:
		if d.Tag != nil || d.Name != nil {
			return &InvalidRequestError{Reason: "quota operations do not accept tag or name"}
		}
		if d.QuotaGiB == nil {
			return &InvalidRequestError{Reason: "quotaGiB is required for quota operations"}
		}
		if err := validateQuotaGiB(*d.QuotaGiB); err != nil {
			return err
		}
	default:
		return &InvalidRequestError{Reason: "op must be create, list, rollback, quota-set, or quota-enforce"}
	}
	return nil
}

type ApplyRequest struct {
	Desired *Desired `json:"desired"`
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
	if !ok || bytes.Equal(bytes.TrimSpace(rawDesired), []byte("null")) {
		return &InvalidRequestError{Reason: "desired is required"}
	}

	var desired Desired
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

type ReadRequest struct{}

func (ReadRequest) CapabilityRequest() {}

func (ReadRequest) Validate() error { return nil }

type SnapshotInfo struct {
	Name            string    `json:"name"`
	ID              uint64    `json:"id"`
	CreatedAt       time.Time `json:"createdAt"`
	ReadOnly        bool      `json:"readOnly"`
	ReferencedBytes uint64    `json:"referencedBytes"`
	ExclusiveBytes  uint64    `json:"exclusiveBytes"`
}

type ListResponse struct {
	Snapshots []SnapshotInfo `json:"snapshots"`
}

func (ListResponse) CapabilityResponse() {}

type CreateResponse struct {
	Snapshot SnapshotInfo `json:"snapshot"`
}

func (CreateResponse) CapabilityResponse() {}

type QuotaLimit struct {
	Set   bool
	Bytes uint64
}

type btrfsSystem interface {
	CreateReadOnlySnapshot(context.Context, string) (SnapshotInfo, error)
	CreateWritableSnapshotFrom(context.Context, string, string) (SnapshotInfo, error)
	DeleteSnapshot(context.Context, string) error
	ListSnapshots(context.Context) ([]SnapshotInfo, error)
	SnapshotInfo(context.Context, string) (SnapshotInfo, error)
	SwapDataWithSnapshot(context.Context, string) error
	QuotaLimit(context.Context) (QuotaLimit, error)
	SetQuota(context.Context, uint64) error
	ClearQuota(context.Context) error
	VerifyQuota(context.Context, uint64) error
}

type Capability struct {
	system btrfsSystem
	now    func() time.Time

	mu   sync.Mutex
	next uint64
}

type InvalidRequestError struct {
	Reason string
}

func (e *InvalidRequestError) Error() string {
	return fmt.Sprintf("invalid storage snapshot request: %s", e.Reason)
}

func (e *InvalidRequestError) ApplyErrorCode() string {
	return "storage_snapshot_rejected"
}

type UnsupportedPlatformError struct {
	GOOS string
}

func (e *UnsupportedPlatformError) Error() string {
	if e == nil || e.GOOS == "" {
		return "storage snapshot unsupported on this platform"
	}
	return fmt.Sprintf("storage snapshot unsupported on %s", e.GOOS)
}

func NewCapability() *Capability {
	return newCapability(newDefaultBtrfsSystem(), time.Now)
}

func newCapability(system btrfsSystem, now func() time.Time) *Capability {
	if now == nil {
		now = time.Now
	}
	return &Capability{system: system, now: now}
}

func (c *Capability) Name() string {
	return Name
}

func (c *Capability) Handle(ctx context.Context, req capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	if c == nil || c.system == nil {
		return nil, &InvalidRequestError{Reason: "missing btrfs snapshot system"}
	}

	switch typed := req.(type) {
	case ReadRequest:
		return c.list(ctx)
	case ApplyRequest:
		if err := typed.Validate(); err != nil {
			return nil, err
		}
		if typed.Desired.Op != OpList {
			return nil, &InvalidRequestError{Reason: "Handle only supports list"}
		}
		return c.list(ctx)
	default:
		return nil, &InvalidRequestError{Reason: "expected storagesnap.ReadRequest or storagesnap.ApplyRequest"}
	}
}

func (c *Capability) Apply(ctx context.Context, req capabilities.TypedRequest) (transaction.Undo, error) {
	applyReq, ok := req.(ApplyRequest)
	if !ok {
		return nil, &InvalidRequestError{Reason: "expected storagesnap.ApplyRequest"}
	}
	if c == nil || c.system == nil {
		return nil, &InvalidRequestError{Reason: "missing btrfs snapshot system"}
	}
	if err := applyReq.Validate(); err != nil {
		return nil, err
	}

	desired := *applyReq.Desired
	switch desired.Op {
	case OpCreate:
		tag := ""
		if desired.Tag != nil {
			tag = *desired.Tag
		}
		return c.applyCreate(ctx, tag)
	case OpList:
		return noOpUndo{}, nil
	case OpRollback:
		return c.applyRollback(ctx, *desired.Name)
	case OpQuotaSet:
		return c.applyQuotaSet(ctx, *desired.QuotaGiB)
	case OpQuotaEnforce:
		bytes, err := quotaGiBToBytes(*desired.QuotaGiB)
		if err != nil {
			return nil, err
		}
		if err := c.system.VerifyQuota(ctx, bytes); err != nil {
			return nil, err
		}
		return noOpUndo{}, nil
	default:
		return nil, &InvalidRequestError{Reason: "unknown op"}
	}
}

func (c *Capability) SnapshotBeforeApply(ctx context.Context, tag string) (SnapshotInfo, error) {
	if c == nil || c.system == nil {
		return SnapshotInfo{}, &InvalidRequestError{Reason: "missing btrfs snapshot system"}
	}
	if tag != "" {
		if err := validateSnapshotTag(tag); err != nil {
			return SnapshotInfo{}, err
		}
	}
	name := c.nextSnapshotName(tag)
	snapshot, err := c.createReadOnly(ctx, name)
	if err != nil {
		return SnapshotInfo{}, err
	}
	return cloneSnapshotInfo(snapshot), nil
}

// createReadOnly takes a read-only snapshot and enforces the read-only
// invariant transactionally: if the backend returns a snapshot that is not
// read-only, the residue is deleted before the error is returned so a failed
// create leaves NOTHING behind (single-commit, fail-closed). The backend's own
// CreateReadOnlySnapshot is also transactional (see btrfs_linux.go); this is
// defense-in-depth that holds for ANY backend and is what the pure suite proves.
func (c *Capability) createReadOnly(ctx context.Context, name string) (SnapshotInfo, error) {
	snapshot, err := c.system.CreateReadOnlySnapshot(ctx, name)
	if err != nil {
		return SnapshotInfo{}, err
	}
	if !snapshot.ReadOnly {
		err := &InvalidRequestError{Reason: "created snapshot is not read-only"}
		if delErr := c.system.DeleteSnapshot(ctx, snapshot.Name); delErr != nil {
			return SnapshotInfo{}, errors.Join(err, fmt.Errorf("undo non-read-only snapshot %q: %w", snapshot.Name, delErr))
		}
		return SnapshotInfo{}, err
	}
	return snapshot, nil
}

func (c *Capability) list(ctx context.Context) (ListResponse, error) {
	snapshots, err := c.system.ListSnapshots(ctx)
	if err != nil {
		return ListResponse{}, err
	}
	return ListResponse{Snapshots: normalizeSnapshots(snapshots)}, nil
}

func (c *Capability) applyCreate(ctx context.Context, tag string) (transaction.Undo, error) {
	name := c.nextSnapshotName(tag)
	snapshot, err := c.createReadOnly(ctx, name)
	if err != nil {
		return nil, err
	}
	return deleteSnapshotUndo{system: c.system, name: snapshot.Name}, nil
}

func (c *Capability) applyRollback(ctx context.Context, snapshotName string) (transaction.Undo, error) {
	snapshot, err := c.system.SnapshotInfo(ctx, snapshotName)
	if err != nil {
		return nil, err
	}
	if !snapshot.ReadOnly {
		return nil, &InvalidRequestError{Reason: "rollback snapshot must be read-only"}
	}

	// Snapshot the rollback TARGET first so the rollback is itself reversible. The
	// pre-rollback target is a durable, named safety snapshot (the prior @data made
	// recoverable) — it is intentionally retained even if a later step fails, so it
	// is created via createReadOnly (which only enforces the read-only invariant
	// and reclaims a non-read-only result, never a successful one).
	rollbackTargetName := c.nextSnapshotName("pre-rollback")
	if _, err := c.createReadOnly(ctx, rollbackTargetName); err != nil {
		return nil, err
	}

	restoreName := c.nextSnapshotName("rollback-restore")
	if _, err := c.system.CreateWritableSnapshotFrom(ctx, snapshotName, restoreName); err != nil {
		return nil, err
	}

	undo := rollbackUndo{system: c.system, restoreName: restoreName}
	// SwapDataWithSnapshot is the single commit point. No fallible work runs after
	// it returns nil; a failure here leaves live @data byte-unchanged.
	if err := c.system.SwapDataWithSnapshot(ctx, restoreName); err != nil {
		return nil, err
	}
	return undo, nil
}

func (c *Capability) applyQuotaSet(ctx context.Context, quotaGiB int64) (transaction.Undo, error) {
	bytes, err := quotaGiBToBytes(quotaGiB)
	if err != nil {
		return nil, err
	}
	prior, err := c.system.QuotaLimit(ctx)
	if err != nil {
		return nil, err
	}
	undo := quotaUndo{system: c.system, prior: prior}
	if err := c.system.SetQuota(ctx, bytes); err != nil {
		return nil, err
	}
	return undo, nil
}

func (c *Capability) nextSnapshotName(tag string) string {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.next++
	base := fmt.Sprintf("vita-%s-%06d", c.now().UTC().Format("20060102T150405Z"), c.next)
	if tag == "" {
		return base
	}
	return base + "-" + tag
}

type deleteSnapshotUndo struct {
	system btrfsSystem
	name   string
}

func (u deleteSnapshotUndo) Undo(ctx context.Context) error {
	if u.system == nil {
		return &InvalidRequestError{Reason: "missing btrfs snapshot system"}
	}
	return u.system.DeleteSnapshot(ctx, u.name)
}

type rollbackUndo struct {
	system      btrfsSystem
	restoreName string
}

func (u rollbackUndo) Undo(ctx context.Context) error {
	if u.system == nil {
		return &InvalidRequestError{Reason: "missing btrfs snapshot system"}
	}
	return u.system.SwapDataWithSnapshot(ctx, u.restoreName)
}

type quotaUndo struct {
	system btrfsSystem
	prior  QuotaLimit
}

func (u quotaUndo) Undo(ctx context.Context) error {
	if u.system == nil {
		return &InvalidRequestError{Reason: "missing btrfs snapshot system"}
	}
	if !u.prior.Set {
		return u.system.ClearQuota(ctx)
	}
	return u.system.SetQuota(ctx, u.prior.Bytes)
}

type noOpUndo struct{}

func (noOpUndo) Undo(context.Context) error { return nil }

func normalizeSnapshots(snapshots []SnapshotInfo) []SnapshotInfo {
	out := make([]SnapshotInfo, len(snapshots))
	for i, snapshot := range snapshots {
		out[i] = cloneSnapshotInfo(snapshot)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func cloneSnapshotInfo(in SnapshotInfo) SnapshotInfo {
	return SnapshotInfo{
		Name:            in.Name,
		ID:              in.ID,
		CreatedAt:       in.CreatedAt.Round(0).UTC(),
		ReadOnly:        in.ReadOnly,
		ReferencedBytes: in.ReferencedBytes,
		ExclusiveBytes:  in.ExclusiveBytes,
	}
}

func validateSnapshotTag(tag string) error {
	if tag == "" {
		return &InvalidRequestError{Reason: "tag must not be empty when present"}
	}
	if len(tag) > maxSnapshotTagBytes {
		return &InvalidRequestError{Reason: "tag is too long"}
	}
	return validateSnapshotLabel(tag, "tag")
}

var snapshotLabelPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
var controlCharacterPattern = regexp.MustCompile(`[\x00-\x1f\x7f]`)

func validateSnapshotLabel(label string, field string) error {
	if label == "" {
		return &InvalidRequestError{Reason: field + " must not be empty"}
	}
	if len(label) > maxSnapshotLabelBytes {
		return &InvalidRequestError{Reason: field + " is too long"}
	}
	if strings.HasPrefix(label, "/") ||
		strings.Contains(label, "/") ||
		strings.Contains(label, "\\") ||
		strings.Contains(label, "..") ||
		strings.ContainsRune(label, '\x00') ||
		controlCharacterPattern.MatchString(label) ||
		!snapshotLabelPattern.MatchString(label) {
		return &InvalidRequestError{Reason: field + " must be a safe snapshot label"}
	}
	return nil
}

func validateQuotaGiB(value int64) error {
	if value <= 0 {
		return &InvalidRequestError{Reason: "quotaGiB must be positive"}
	}
	if value > int64(math.MaxUint64/gibBytes) {
		return &InvalidRequestError{Reason: "quotaGiB is too large"}
	}
	return nil
}

func quotaGiBToBytes(value int64) (uint64, error) {
	if err := validateQuotaGiB(value); err != nil {
		return 0, err
	}
	return uint64(value) * gibBytes, nil
}

var applyRequestFields = map[string]struct{}{
	"desired": {},
}

var desiredFields = map[string]struct{}{
	"op":       {},
	"tag":      {},
	"name":     {},
	"quotaGiB": {},
}

func decodeObject(raw []byte) (map[string]json.RawMessage, error) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, errors.New("object must not be null")
	}
	var fields map[string]json.RawMessage
	if err := decodeSingleJSONValue(raw, &fields); err != nil {
		return nil, err
	}
	if fields == nil {
		return nil, errors.New("object must be a JSON object")
	}
	return fields, nil
}

func rejectUnknownFields(fields map[string]json.RawMessage, allowed map[string]struct{}) error {
	for key := range fields {
		if _, ok := allowed[key]; !ok {
			return fmt.Errorf("unknown field %q", key)
		}
	}
	return nil
}

func requiredOperationField(fields map[string]json.RawMessage, key string) (Operation, error) {
	value, err := requiredStringField(fields, key)
	if err != nil {
		return "", err
	}
	return Operation(value), nil
}

func requiredStringField(fields map[string]json.RawMessage, key string) (string, error) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", fmt.Errorf("%s is required", key)
	}
	var value string
	if err := decodeSingleJSONValue(raw, &value); err != nil {
		return "", fmt.Errorf("%s must be a string", key)
	}
	return value, nil
}

func optionalStringPtrField(fields map[string]json.RawMessage, key string) (*string, error) {
	raw, ok := fields[key]
	if !ok {
		return nil, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, fmt.Errorf("%s must be a string when present", key)
	}
	var value string
	if err := decodeSingleJSONValue(raw, &value); err != nil {
		return nil, fmt.Errorf("%s must be a string", key)
	}
	return &value, nil
}

func optionalInt64PtrField(fields map[string]json.RawMessage, key string) (*int64, error) {
	raw, ok := fields[key]
	if !ok {
		return nil, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, fmt.Errorf("%s must be an integer when present", key)
	}
	var value int64
	if err := decodeSingleJSONValue(raw, &value); err != nil {
		return nil, fmt.Errorf("%s must be an integer", key)
	}
	return &value, nil
}

func decodeSingleJSONValue(raw []byte, target interface{}) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
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
