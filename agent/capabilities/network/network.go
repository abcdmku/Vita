package network

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/internal/jsonsafe"
	"github.com/vita/agent/transaction"
)

const (
	Name = "network.policy"

	defaultStateRoot      = "/var/lib/vita-agent"
	defaultPolicyFilename = "network-policy.json"
	policyFileMode        = 0o600
	stateRootMode         = 0o700

	maxInterfaceNameLength = 15
)

// PortAll is the only supported all-ports sentinel. Port 0 remains invalid,
// and public all-ports rules require Rule.UnsafeWideOpen.
const PortAll = -1

type Protocol string

const (
	ProtoTCP Protocol = "tcp"
	ProtoUDP Protocol = "udp"
)

type Rule struct {
	Proto          Protocol `json:"proto"`
	Port           int      `json:"port"`
	SourceCIDR     string   `json:"sourceCidr"`
	Interface      string   `json:"interface"`
	UnsafeWideOpen bool     `json:"unsafeWideOpen,omitempty"`
}

type Policy struct {
	Allow *[]Rule `json:"allow"`
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
	return fmt.Sprintf("invalid network policy request: %s", e.Reason)
}

type ParseError struct {
	Reason string
}

func (e *ParseError) Error() string {
	return fmt.Sprintf("parse network policy: %s", e.Reason)
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
		return nil, &InvalidRequestError{Reason: "expected network.ReadRequest"}
	}
	if c == nil || c.fs == nil {
		return nil, &InvalidRequestError{Reason: "missing policy filesystem"}
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

	return ReadResponse{
		Exists: true,
		Policy: clonePolicy(parsed),
		Raw:    cloneBytes(snapshot.bytes),
	}, nil
}

func (c *Capability) Apply(ctx context.Context, req capabilities.TypedRequest) (transaction.Undo, error) {
	applyReq, ok := req.(ApplyRequest)
	if !ok {
		return nil, &InvalidRequestError{Reason: "expected network.ApplyRequest"}
	}
	if c == nil || c.fs == nil {
		return nil, &InvalidRequestError{Reason: "missing policy filesystem"}
	}
	normalized, err := validateApplyRequest(applyReq)
	if err != nil {
		return nil, err
	}

	prior, err := c.fs.Read(ctx)
	if err != nil {
		return nil, err
	}

	if err := c.fs.AtomicWrite(ctx, renderPolicy(normalized)); err != nil {
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
		return &InvalidRequestError{Reason: "missing policy filesystem"}
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
		return policySnapshot{}, fmt.Errorf("read network policy: %w", err)
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
		return fmt.Errorf("create network policy state root: %w", err)
	}
	if err := os.Chmod(fs.stateRoot, stateRootMode); err != nil {
		return fmt.Errorf("secure network policy state root: %w", err)
	}

	tmp, err := os.CreateTemp(fs.stateRoot, ".network-policy-*.tmp")
	if err != nil {
		return fmt.Errorf("create network policy temp file: %w", err)
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

	if err := tmp.Chmod(policyFileMode); err != nil {
		return fmt.Errorf("secure network policy temp file: %w", err)
	}
	written, err := tmp.Write(content)
	if err != nil {
		return fmt.Errorf("write network policy temp file: %w", err)
	}
	if written != len(content) {
		return fmt.Errorf("write network policy temp file: %w", io.ErrShortWrite)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("sync network policy temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		closed = true
		return fmt.Errorf("close network policy temp file: %w", err)
	}
	closed = true

	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, fs.path); err != nil {
		return fmt.Errorf("replace network policy: %w", err)
	}
	cleanupTemp = false
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
		return fmt.Errorf("remove network policy: %w", err)
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
	if policy.Allow == nil {
		return Policy{}, &InvalidRequestError{Reason: "allow is required"}
	}
	if *policy.Allow == nil {
		return Policy{}, &InvalidRequestError{Reason: "allow must be a list"}
	}

	rules := *policy.Allow
	normalized := make([]Rule, len(rules))
	for i, rule := range rules {
		normalizedRule, err := normalizeRule(i, rule)
		if err != nil {
			return Policy{}, err
		}
		normalized[i] = normalizedRule
	}

	return Policy{Allow: &normalized}, nil
}

func normalizeRule(index int, rule Rule) (Rule, error) {
	switch rule.Proto {
	case ProtoTCP, ProtoUDP:
	default:
		return Rule{}, &InvalidRequestError{Reason: fmt.Sprintf("allow[%d].proto must be tcp or udp", index)}
	}

	if rule.Port != PortAll && (rule.Port <= 0 || rule.Port > 65535) {
		return Rule{}, &InvalidRequestError{Reason: fmt.Sprintf("allow[%d].port must be 1-65535 or PortAll", index)}
	}

	prefix, err := normalizeCIDR(rule.SourceCIDR)
	if err != nil {
		return Rule{}, &InvalidRequestError{Reason: fmt.Sprintf("allow[%d].sourceCidr %s", index, err)}
	}
	if !validInterfaceName(rule.Interface) {
		return Rule{}, &InvalidRequestError{Reason: fmt.Sprintf("allow[%d].interface must be a concrete interface name", index)}
	}
	if rule.Port == PortAll && sourceCoversAll(prefix) && !rule.UnsafeWideOpen {
		return Rule{}, &InvalidRequestError{Reason: fmt.Sprintf("allow[%d] opens all inbound ports from all sources without unsafeWideOpen", index)}
	}

	return Rule{
		Proto:          rule.Proto,
		Port:           rule.Port,
		SourceCIDR:     prefix.String(),
		Interface:      rule.Interface,
		UnsafeWideOpen: rule.UnsafeWideOpen,
	}, nil
}

func normalizeCIDR(value string) (netip.Prefix, error) {
	if value == "" || value != strings.TrimSpace(value) {
		return netip.Prefix{}, errors.New("must be a CIDR prefix")
	}
	prefix, err := netip.ParsePrefix(value)
	if err != nil {
		return netip.Prefix{}, errors.New("must be a CIDR prefix")
	}
	masked := prefix.Masked()
	if prefix != masked {
		return netip.Prefix{}, errors.New("must be a canonical CIDR prefix")
	}
	return masked, nil
}

func NormalizeCIDR(value string) (netip.Prefix, error) {
	return normalizeCIDR(value)
}

var interfaceNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]*$`)

func validInterfaceName(value string) bool {
	return value != "" &&
		len(value) <= maxInterfaceNameLength &&
		value == strings.TrimSpace(value) &&
		interfaceNamePattern.MatchString(value)
}

func ValidInterfaceName(value string) bool {
	return validInterfaceName(value)
}

func sourceCoversAll(prefix netip.Prefix) bool {
	return prefix.Bits() == 0 && prefix.Addr().IsUnspecified()
}

func SourceCoversAll(prefix netip.Prefix) bool {
	return sourceCoversAll(prefix)
}

func renderPolicy(policy Policy) []byte {
	encoded, err := json.Marshal(policy)
	if err != nil {
		return nil
	}
	return append(encoded, '\n')
}

func parsePolicy(raw []byte) (Policy, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return Policy{}, &ParseError{Reason: "empty policy"}
	}

	var policy Policy
	if err := jsonsafe.DecodeStrict(raw, &policy); err != nil {
		return Policy{}, &ParseError{Reason: err.Error()}
	}

	return normalizePolicy(policy)
}

func clonePolicy(policy Policy) Policy {
	if policy.Allow == nil {
		return Policy{}
	}
	rules := *policy.Allow
	if rules == nil {
		var nilRules []Rule
		return Policy{Allow: &nilRules}
	}
	out := make([]Rule, len(rules))
	copy(out, rules)
	return Policy{Allow: &out}
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
