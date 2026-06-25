package backup

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/internal/atomicfile"
	"github.com/vita/agent/internal/jsonsafe"
	"github.com/vita/agent/transaction"
)

const (
	Name = "backup.policy"

	defaultStateRoot      = "/var/lib/vita-agent"
	defaultPolicyFilename = "backup-policy-desired-state.json"
	policyFileMode        = 0o600
	stateRootMode         = 0o700

	maxRetentionCount   int64 = 1000
	maxRetentionAgeDays int64 = 3650
	maxRefLength              = 2048
	maxIntervalSeconds  int64 = 365 * 24 * 60 * 60
)

type Policy struct {
	Schedule       Schedule       `json:"schedule"`
	Targets        []TargetRef    `json:"targets"`
	Retention      Retention      `json:"retention"`
	RecoveryKeyRef RecoveryKeyRef `json:"recoveryKeyRef"`
}

func (p Policy) Validate() error {
	return validatePolicy(p)
}

func (p *Policy) UnmarshalJSON(raw []byte) error {
	type policyJSON Policy
	var decoded policyJSON
	if err := jsonsafe.DecodeStrict(raw, &decoded); err != nil {
		return err
	}
	*p = Policy(decoded)
	return nil
}

type Schedule struct {
	Cron            *string `json:"cron,omitempty"`
	IntervalSeconds *int64  `json:"intervalSeconds,omitempty"`
}

type TargetRef struct {
	ID string `json:"id"`
}

type Retention struct {
	Count      *int64 `json:"count"`
	MaxAgeDays *int64 `json:"maxAgeDays"`
}

type RecoveryKeyRef struct {
	ID          string  `json:"id"`
	Handle      string  `json:"handle"`
	KeyStoreRef *string `json:"keyStoreRef,omitempty"`
}

type ReadRequest struct{}

func (ReadRequest) CapabilityRequest() {}

func (ReadRequest) Validate() error { return nil }

type ApplyRequest struct {
	Desired *Policy `json:"desired"`
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
	return validatePolicy(*r.Desired)
}

type ReadResponse struct {
	Exists bool   `json:"exists"`
	Policy Policy `json:"policy"`
	Raw    []byte `json:"raw"`
}

func (ReadResponse) CapabilityResponse() {}

type Capability struct {
	fs policyFileSystem
}

type policySnapshot struct {
	exists bool
	bytes  []byte
}

type policyFileSystem interface {
	Read(context.Context) (policySnapshot, error)
	AtomicWrite(context.Context, []byte) error
	Replace(context.Context, policySnapshot) error
}

type InvalidRequestError struct {
	Reason string
}

func (e *InvalidRequestError) Error() string {
	return fmt.Sprintf("invalid backup policy request: %s", e.Reason)
}

type ParseError struct {
	Reason string
}

func (e *ParseError) Error() string {
	return fmt.Sprintf("parse backup policy: %s", e.Reason)
}

func NewCapability() *Capability {
	return newCapability(newDefaultFileSystem())
}

func newCapability(fs policyFileSystem) *Capability {
	return &Capability{fs: fs}
}

func (c *Capability) Name() string {
	return Name
}

func (c *Capability) Handle(ctx context.Context, req capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	if _, ok := req.(ReadRequest); !ok {
		return nil, &InvalidRequestError{Reason: "expected backup.ReadRequest"}
	}
	if c == nil || c.fs == nil {
		return nil, &InvalidRequestError{Reason: "missing backup policy filesystem"}
	}

	snapshot, err := c.fs.Read(ctx)
	if err != nil {
		return nil, err
	}
	if !snapshot.exists {
		return ReadResponse{Exists: false}, nil
	}

	parsed, err := parsePolicy(snapshot.bytes)
	if err != nil {
		return nil, err
	}
	canonical, err := renderPolicy(parsed)
	if err != nil {
		return nil, err
	}

	return ReadResponse{
		Exists: true,
		Policy: clonePolicy(parsed),
		Raw:    canonical,
	}, nil
}

func (c *Capability) Apply(ctx context.Context, req capabilities.TypedRequest) (transaction.Undo, error) {
	applyReq, ok := req.(ApplyRequest)
	if !ok {
		return nil, &InvalidRequestError{Reason: "expected backup.ApplyRequest"}
	}
	if c == nil || c.fs == nil {
		return nil, &InvalidRequestError{Reason: "missing backup policy filesystem"}
	}

	normalized, err := validateApplyRequest(applyReq)
	if err != nil {
		return nil, err
	}
	desiredBytes, err := renderPolicy(normalized)
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

	return undoPolicy{
		fs:    c.fs,
		prior: cloneSnapshot(prior),
	}, nil
}

type undoPolicy struct {
	fs    policyFileSystem
	prior policySnapshot
}

func (u undoPolicy) Undo(ctx context.Context) error {
	if u.fs == nil {
		return &InvalidRequestError{Reason: "missing backup policy filesystem"}
	}
	return u.fs.Replace(ctx, cloneSnapshot(u.prior))
}

type defaultFileSystem struct {
	stateRoot string
	path      string
}

func newDefaultFileSystem() policyFileSystem {
	return defaultFileSystem{
		stateRoot: defaultStateRoot,
		path:      filepath.Join(defaultStateRoot, defaultPolicyFilename),
	}
}

func (fs defaultFileSystem) Read(ctx context.Context) (policySnapshot, error) {
	if err := ctx.Err(); err != nil {
		return policySnapshot{}, err
	}

	content, err := os.ReadFile(fs.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return policySnapshot{exists: false}, nil
		}
		return policySnapshot{}, fmt.Errorf("read backup policy: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return policySnapshot{}, err
	}

	return policySnapshot{exists: true, bytes: cloneBytes(content)}, nil
}

func (fs defaultFileSystem) AtomicWrite(ctx context.Context, content []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.MkdirAll(fs.stateRoot, stateRootMode); err != nil {
		return fmt.Errorf("create backup policy state root: %w", err)
	}
	if err := os.Chmod(fs.stateRoot, stateRootMode); err != nil {
		return fmt.Errorf("secure backup policy state root: %w", err)
	}

	if err := atomicfile.WriteWithPatternAndBeforeCommit(
		atomicfile.OSFileSystem{},
		fs.path,
		content,
		policyFileMode,
		".backup-policy-*.tmp",
		ctx.Err,
	); err != nil {
		return fmt.Errorf("write backup policy: %w", err)
	}
	return nil
}

func (fs defaultFileSystem) Replace(ctx context.Context, snapshot policySnapshot) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if snapshot.exists {
		return fs.AtomicWrite(ctx, snapshot.bytes)
	}

	if err := os.Remove(fs.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove backup policy: %w", err)
	}
	return nil
}

func validateApplyRequest(req ApplyRequest) (Policy, error) {
	if req.Desired == nil {
		return Policy{}, &InvalidRequestError{Reason: "desired is required"}
	}
	return normalizePolicy(*req.Desired)
}

func validatePolicy(policy Policy) error {
	_, err := normalizePolicy(policy)
	return err
}

func normalizePolicy(policy Policy) (Policy, error) {
	normalizedSchedule, err := normalizeSchedule(policy.Schedule)
	if err != nil {
		return Policy{}, err
	}
	normalizedTargets, err := normalizeTargets(policy.Targets)
	if err != nil {
		return Policy{}, err
	}
	normalizedRetention, err := normalizeRetention(policy.Retention)
	if err != nil {
		return Policy{}, err
	}
	normalizedRecoveryKeyRef, err := normalizeRecoveryKeyRef(policy.RecoveryKeyRef)
	if err != nil {
		return Policy{}, err
	}

	return Policy{
		Schedule:       normalizedSchedule,
		Targets:        normalizedTargets,
		Retention:      normalizedRetention,
		RecoveryKeyRef: normalizedRecoveryKeyRef,
	}, nil
}

func normalizeSchedule(schedule Schedule) (Schedule, error) {
	hasCron := schedule.Cron != nil
	hasInterval := schedule.IntervalSeconds != nil
	if hasCron == hasInterval {
		return Schedule{}, &InvalidRequestError{Reason: "schedule must set exactly one of cron or intervalSeconds"}
	}

	if hasCron {
		cron := *schedule.Cron
		if !validCronSchedule(cron) {
			return Schedule{}, &InvalidRequestError{Reason: "schedule.cron must be a valid 5-field cron expression or supported @ macro"}
		}
		return Schedule{Cron: cloneStringPtr(schedule.Cron)}, nil
	}

	if *schedule.IntervalSeconds < 1 || *schedule.IntervalSeconds > maxIntervalSeconds {
		return Schedule{}, &InvalidRequestError{Reason: "schedule.intervalSeconds must be from 1 to 31536000"}
	}
	return Schedule{IntervalSeconds: cloneInt64Ptr(schedule.IntervalSeconds)}, nil
}

func normalizeTargets(targets []TargetRef) ([]TargetRef, error) {
	if len(targets) == 0 {
		return nil, &InvalidRequestError{Reason: "targets must contain at least one target reference"}
	}

	normalized := make([]TargetRef, len(targets))
	seen := make(map[string]int, len(targets))
	for i, target := range targets {
		if err := validateRef(target.ID, fmt.Sprintf("targets[%d].id", i)); err != nil {
			return nil, err
		}
		if previous, ok := seen[target.ID]; ok {
			return nil, &InvalidRequestError{Reason: fmt.Sprintf("targets[%d].id duplicates targets[%d].id", i, previous)}
		}
		seen[target.ID] = i
		normalized[i] = TargetRef{ID: target.ID}
	}

	return normalized, nil
}

func normalizeRetention(retention Retention) (Retention, error) {
	if retention.Count == nil {
		return Retention{}, &InvalidRequestError{Reason: "retention.count is required"}
	}
	if *retention.Count < 1 || *retention.Count > maxRetentionCount {
		return Retention{}, &InvalidRequestError{Reason: "retention.count must be from 1 to 1000"}
	}
	if retention.MaxAgeDays == nil {
		return Retention{}, &InvalidRequestError{Reason: "retention.maxAgeDays is required"}
	}
	if *retention.MaxAgeDays < 1 || *retention.MaxAgeDays > maxRetentionAgeDays {
		return Retention{}, &InvalidRequestError{Reason: "retention.maxAgeDays must be from 1 to 3650"}
	}

	return Retention{
		Count:      cloneInt64Ptr(retention.Count),
		MaxAgeDays: cloneInt64Ptr(retention.MaxAgeDays),
	}, nil
}

func normalizeRecoveryKeyRef(ref RecoveryKeyRef) (RecoveryKeyRef, error) {
	if err := validateRef(ref.ID, "recoveryKeyRef.id"); err != nil {
		return RecoveryKeyRef{}, err
	}
	if err := validateRef(ref.Handle, "recoveryKeyRef.handle"); err != nil {
		return RecoveryKeyRef{}, err
	}
	if ref.KeyStoreRef != nil {
		if err := validateRef(*ref.KeyStoreRef, "recoveryKeyRef.keyStoreRef"); err != nil {
			return RecoveryKeyRef{}, err
		}
	}

	return RecoveryKeyRef{
		ID:          ref.ID,
		Handle:      ref.Handle,
		KeyStoreRef: cloneStringPtr(ref.KeyStoreRef),
	}, nil
}

var (
	opaqueRefPattern        = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{2,159}$`)
	schemePattern           = regexp.MustCompile(`^[a-z][a-z0-9+.-]*$`)
	controlCharacterPattern = regexp.MustCompile(`[\x00-\x1f\x7f]`)
	privateKeyPattern       = regexp.MustCompile(`(?i)\b(?:private[-_\s]?key|openssh\s+private\s+key|age-secret-key|xprv|seed[-_\s]?phrase|mnemonic|recovery[-_\s]?phrase)\b`)
	secretAssignmentPattern = regexp.MustCompile(`(?i)\b(?:private[-_\s]?key|api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|password|secret)\s*[:=]`)
	seedWordsPattern        = regexp.MustCompile(`(?i)\b[a-z]{3,12}(?:\s+[a-z]{3,12}){11,23}\b`)
	longHexPattern          = regexp.MustCompile(`(?:0x)?[A-Fa-f0-9]{32,}`)
	longBase64Pattern       = regexp.MustCompile(`[A-Za-z0-9+/]{48,}={0,2}|[A-Za-z0-9_-]{48,}`)
	inlineRefSchemes        = map[string]struct{}{
		"data":    {},
		"inline":  {},
		"literal": {},
	}
)

func validateRef(value string, field string) error {
	if value == "" {
		return &InvalidRequestError{Reason: fmt.Sprintf("%s is required", field)}
	}
	if containsInlineSecretMaterial(value) {
		return &InvalidRequestError{Reason: fmt.Sprintf("%s must not contain inline key material", field)}
	}
	if len(value) > maxRefLength || !validReferenceSyntax(value) {
		return &InvalidRequestError{Reason: fmt.Sprintf("%s must be an opaque reference", field)}
	}
	return nil
}

func validReferenceSyntax(value string) bool {
	if value != strings.TrimSpace(value) || strings.ContainsAny(value, " \t\r\n<>{}`\"'") {
		return false
	}
	if hasInlineReferenceScheme(value) {
		return false
	}

	separator := strings.Index(value, "://")
	if separator == -1 {
		return opaqueRefPattern.MatchString(value)
	}
	if separator <= 0 || separator == len(value)-3 {
		return false
	}

	scheme := strings.ToLower(value[:separator])
	body := value[separator+3:]
	if _, forbidden := inlineRefSchemes[scheme]; forbidden {
		return false
	}
	return schemePattern.MatchString(scheme) && body != ""
}

func hasInlineReferenceScheme(value string) bool {
	colon := strings.IndexByte(value, ':')
	if colon <= 0 {
		return false
	}
	scheme := strings.ToLower(value[:colon])
	_, forbidden := inlineRefSchemes[scheme]
	return forbidden
}

func containsInlineSecretMaterial(value string) bool {
	if controlCharacterPattern.MatchString(value) ||
		strings.Contains(strings.ToUpper(value), "-----BEGIN") ||
		privateKeyPattern.MatchString(value) ||
		secretAssignmentPattern.MatchString(value) ||
		seedWordsPattern.MatchString(value) {
		return true
	}
	return longHexPattern.MatchString(value) || longBase64Pattern.MatchString(value)
}

func ContainsInlineSecretMaterial(value string) bool {
	return containsInlineSecretMaterial(value)
}

var cronMacros = map[string]struct{}{
	"@hourly":  {},
	"@daily":   {},
	"@weekly":  {},
	"@monthly": {},
}

type cronBounds struct {
	min int
	max int
}

var cronFieldBounds = []cronBounds{
	{min: 0, max: 59},
	{min: 0, max: 23},
	{min: 1, max: 31},
	{min: 1, max: 12},
	{min: 0, max: 7},
}

func validCronSchedule(value string) bool {
	if value == "" || value != strings.TrimSpace(value) || containsInlineSecretMaterial(value) {
		return false
	}
	if _, ok := cronMacros[value]; ok {
		return true
	}

	fields := strings.Fields(value)
	if len(fields) != len(cronFieldBounds) {
		return false
	}
	for i, field := range fields {
		if !validCronField(field, cronFieldBounds[i]) {
			return false
		}
	}
	return true
}

func validCronField(field string, bounds cronBounds) bool {
	if field == "" {
		return false
	}

	parts := strings.Split(field, ",")
	for _, part := range parts {
		if !validCronPart(part, bounds) {
			return false
		}
	}
	return true
}

func validCronPart(part string, bounds cronBounds) bool {
	if part == "" {
		return false
	}

	base := part
	if strings.Contains(part, "/") {
		pieces := strings.Split(part, "/")
		if len(pieces) != 2 || pieces[0] == "" || pieces[1] == "" {
			return false
		}
		step, err := strconv.Atoi(pieces[1])
		if err != nil || step < 1 || step > bounds.max {
			return false
		}
		base = pieces[0]
	}

	if base == "*" {
		return true
	}
	if strings.Contains(base, "-") {
		pieces := strings.Split(base, "-")
		if len(pieces) != 2 {
			return false
		}
		start, ok := parseCronNumber(pieces[0], bounds)
		if !ok {
			return false
		}
		end, ok := parseCronNumber(pieces[1], bounds)
		return ok && start <= end
	}
	_, ok := parseCronNumber(base, bounds)
	return ok
}

func parseCronNumber(value string, bounds cronBounds) (int, bool) {
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0, false
	}
	return parsed, parsed >= bounds.min && parsed <= bounds.max
}

func renderPolicy(policy Policy) ([]byte, error) {
	encoded, err := json.Marshal(policy)
	if err != nil {
		return nil, fmt.Errorf("render backup policy: %w", err)
	}
	return append(encoded, '\n'), nil
}

func parsePolicy(raw []byte) (Policy, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return Policy{}, &ParseError{Reason: "empty backup policy"}
	}
	var policy Policy
	if err := jsonsafe.DecodeStrict(raw, &policy); err != nil {
		return Policy{}, &ParseError{Reason: err.Error()}
	}

	normalized, err := normalizePolicy(policy)
	if err != nil {
		return Policy{}, err
	}
	return normalized, nil
}

func clonePolicy(policy Policy) Policy {
	return Policy{
		Schedule:       cloneSchedule(policy.Schedule),
		Targets:        cloneTargets(policy.Targets),
		Retention:      cloneRetention(policy.Retention),
		RecoveryKeyRef: cloneRecoveryKeyRef(policy.RecoveryKeyRef),
	}
}

func cloneSchedule(schedule Schedule) Schedule {
	return Schedule{
		Cron:            cloneStringPtr(schedule.Cron),
		IntervalSeconds: cloneInt64Ptr(schedule.IntervalSeconds),
	}
}

func cloneTargets(targets []TargetRef) []TargetRef {
	out := make([]TargetRef, len(targets))
	copy(out, targets)
	return out
}

func cloneRetention(retention Retention) Retention {
	return Retention{
		Count:      cloneInt64Ptr(retention.Count),
		MaxAgeDays: cloneInt64Ptr(retention.MaxAgeDays),
	}
}

func cloneRecoveryKeyRef(ref RecoveryKeyRef) RecoveryKeyRef {
	return RecoveryKeyRef{
		ID:          ref.ID,
		Handle:      ref.Handle,
		KeyStoreRef: cloneStringPtr(ref.KeyStoreRef),
	}
}

func cloneSnapshot(snapshot policySnapshot) policySnapshot {
	return policySnapshot{
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
