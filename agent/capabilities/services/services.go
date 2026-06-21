package services

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

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/internal/jsonsafe"
	"github.com/vita/agent/transaction"
)

const (
	Name = "services.config"

	defaultStateRoot      = "/var/lib/vita-agent"
	defaultConfigFilename = "enabled-services-config.json"
	configFileMode        = 0o600
	stateRootMode         = 0o700

	maxServiceNameLength = 256
)

type ServiceEntry struct {
	Name    string `json:"name"`
	Enabled *bool  `json:"enabled"`
}

func NewServiceEntry(name string, enabled bool) ServiceEntry {
	return ServiceEntry{
		Name:    name,
		Enabled: boolPointer(enabled),
	}
}

func (e ServiceEntry) Validate() error {
	return validateServiceEntry(e, "services[]")
}

func (e *ServiceEntry) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, serviceEntryFields); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	name, err := requiredStringField(fields, "name")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	enabled, err := requiredBoolField(fields, "enabled")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	entry := NewServiceEntry(name, enabled)
	if err := validateServiceEntry(entry, "services[]"); err != nil {
		return err
	}

	*e = entry
	return nil
}

type Config struct {
	Services *[]ServiceEntry `json:"services"`
}

func NewConfig(services []ServiceEntry) Config {
	return Config{Services: serviceEntriesPointer(cloneServiceEntries(services))}
}

func (c Config) Validate() error {
	_, err := normalizeConfig(c)
	return err
}

func (c *Config) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, configFields); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	services, err := requiredServiceListField(fields, "services")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	normalized, err := normalizeConfig(NewConfig(services))
	if err != nil {
		return err
	}
	*c = normalized
	return nil
}

type ReadRequest struct{}

func (ReadRequest) CapabilityRequest() {}

func (ReadRequest) Validate() error { return nil }

type ApplyRequest struct {
	Desired *Config `json:"desired"`
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

	var desired Config
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
	Exists bool   `json:"exists"`
	Config Config `json:"config"`
	Raw    []byte `json:"raw"`
}

func (ReadResponse) CapabilityResponse() {}

type Capability struct {
	fs configFileSystem
}

type configSnapshot struct {
	exists bool
	bytes  []byte
}

type configFileSystem interface {
	Read(context.Context) (configSnapshot, error)
	AtomicWrite(context.Context, []byte) error
	Replace(context.Context, configSnapshot) error
}

type InvalidRequestError struct {
	Reason string
}

func (e *InvalidRequestError) Error() string {
	return fmt.Sprintf("invalid services request: %s", e.Reason)
}

type ParseError struct {
	Reason string
}

func (e *ParseError) Error() string {
	return fmt.Sprintf("parse services config: %s", e.Reason)
}

func NewCapability() *Capability {
	return newCapability(newDefaultFileSystem())
}

func newCapability(fs configFileSystem) *Capability {
	return &Capability{fs: fs}
}

func (c *Capability) Name() string {
	return Name
}

func (c *Capability) Handle(ctx context.Context, req capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	if _, ok := req.(ReadRequest); !ok {
		return nil, &InvalidRequestError{Reason: "expected services.ReadRequest"}
	}
	if c == nil || c.fs == nil {
		return nil, &InvalidRequestError{Reason: "missing services config filesystem"}
	}

	snapshot, err := c.fs.Read(ctx)
	if err != nil {
		return nil, err
	}
	if !snapshot.exists {
		return ReadResponse{Exists: false}, nil
	}

	parsed, err := parseConfig(snapshot.bytes)
	if err != nil {
		return nil, err
	}
	canonical, err := renderConfig(parsed)
	if err != nil {
		return nil, err
	}

	return ReadResponse{
		Exists: true,
		Config: cloneConfig(parsed),
		Raw:    canonical,
	}, nil
}

func (c *Capability) Apply(ctx context.Context, req capabilities.TypedRequest) (transaction.Undo, error) {
	applyReq, ok := req.(ApplyRequest)
	if !ok {
		return nil, &InvalidRequestError{Reason: "expected services.ApplyRequest"}
	}
	if c == nil || c.fs == nil {
		return nil, &InvalidRequestError{Reason: "missing services config filesystem"}
	}

	normalized, err := validateApplyRequest(applyReq)
	if err != nil {
		return nil, err
	}
	desiredBytes, err := renderConfig(normalized)
	if err != nil {
		return nil, err
	}

	prior, err := c.fs.Read(ctx)
	if err != nil {
		return nil, err
	}
	undo := undoConfig{
		fs:    c.fs,
		prior: cloneSnapshot(prior),
	}

	if err := c.fs.AtomicWrite(ctx, desiredBytes); err != nil {
		if restoreErr := c.fs.Replace(ctx, cloneSnapshot(prior)); restoreErr != nil {
			return nil, errors.Join(err, fmt.Errorf("restore prior services config: %w", restoreErr))
		}
		return nil, err
	}

	return undo, nil
}

type undoConfig struct {
	fs    configFileSystem
	prior configSnapshot
}

func (u undoConfig) Undo(ctx context.Context) error {
	if u.fs == nil {
		return &InvalidRequestError{Reason: "missing services config filesystem"}
	}
	return u.fs.Replace(ctx, cloneSnapshot(u.prior))
}

type defaultFileSystem struct {
	stateRoot string
	path      string
}

func newDefaultFileSystem() configFileSystem {
	return defaultFileSystem{
		stateRoot: defaultStateRoot,
		path:      filepath.Join(defaultStateRoot, defaultConfigFilename),
	}
}

func (fs defaultFileSystem) Read(ctx context.Context) (configSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return configSnapshot{}, err
	}

	content, err := os.ReadFile(fs.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return configSnapshot{exists: false}, nil
		}
		return configSnapshot{}, fmt.Errorf("read services config: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return configSnapshot{}, err
	}

	return configSnapshot{exists: true, bytes: cloneBytes(content)}, nil
}

func (fs defaultFileSystem) AtomicWrite(ctx context.Context, content []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.MkdirAll(fs.stateRoot, stateRootMode); err != nil {
		return fmt.Errorf("create services state root: %w", err)
	}
	if err := os.Chmod(fs.stateRoot, stateRootMode); err != nil {
		return fmt.Errorf("secure services state root: %w", err)
	}

	tmp, err := os.CreateTemp(fs.stateRoot, ".enabled-services-config-*.tmp")
	if err != nil {
		return fmt.Errorf("create services temp file: %w", err)
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

	if err := tmp.Chmod(configFileMode); err != nil {
		return fmt.Errorf("secure services temp file: %w", err)
	}
	written, err := tmp.Write(content)
	if err != nil {
		return fmt.Errorf("write services temp file: %w", err)
	}
	if written != len(content) {
		return fmt.Errorf("write services temp file: %w", io.ErrShortWrite)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("sync services temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		closed = true
		return fmt.Errorf("close services temp file: %w", err)
	}
	closed = true

	if err := ctx.Err(); err != nil {
		return err
	}
	// Rename is the single commit point: callers only receive an undo after nil error.
	if err := os.Rename(tmpName, fs.path); err != nil {
		return fmt.Errorf("replace services config: %w", err)
	}
	cleanupTemp = false
	return nil
}

func (fs defaultFileSystem) Replace(ctx context.Context, snapshot configSnapshot) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if snapshot.exists {
		return fs.AtomicWrite(ctx, snapshot.bytes)
	}

	if err := os.Remove(fs.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove services config: %w", err)
	}
	return nil
}

var (
	applyRequestFields = map[string]struct{}{
		"desired": {},
	}
	configFields = map[string]struct{}{
		"services": {},
	}
	serviceEntryFields = map[string]struct{}{
		"enabled": {},
		"name":    {},
	}
	systemdUnitSuffixes = []string{
		".service",
		".socket",
		".device",
		".mount",
		".automount",
		".swap",
		".target",
		".path",
		".timer",
		".slice",
		".scope",
	}

	controlCharacter  = regexp.MustCompile(`[\x00-\x1f\x7f]`)
	privateKeyPattern = regexp.MustCompile(
		`(?i)\b(?:private[-_\s]?key|openssh[-_\s]?private[-_\s]?key|age[-_\s]?secret[-_\s]?key|xprv|seed[-_\s]?phrase|mnemonic|recovery[-_\s]?phrase)\b`,
	)
	secretAssignment  = regexp.MustCompile(`(?i)\b(?:private[-_\s]?key|api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|password|secret)\s*[:=]`)
	longHexPattern    = regexp.MustCompile(`(?:0x)?[A-Fa-f0-9]{32,}`)
	longBase64Pattern = regexp.MustCompile(
		`[A-Za-z0-9+/]{48,}={0,2}|[A-Za-z0-9_-]{48,}`,
	)
	inlineReferenceSchemes = map[string]struct{}{
		"data":    {},
		"inline":  {},
		"literal": {},
	}
)

func validateApplyRequest(req ApplyRequest) (Config, error) {
	if req.Desired == nil {
		return Config{}, &InvalidRequestError{Reason: "desired is required"}
	}
	return normalizeConfig(*req.Desired)
}

func normalizeConfig(config Config) (Config, error) {
	if config.Services == nil {
		return Config{}, &InvalidRequestError{Reason: "services is required"}
	}
	if *config.Services == nil {
		return Config{}, &InvalidRequestError{Reason: "services must be a list"}
	}

	services := *config.Services
	normalized := make([]ServiceEntry, len(services))
	seen := make(map[string]int, len(services))
	for i, entry := range services {
		field := fmt.Sprintf("services[%d]", i)
		if err := validateServiceEntry(entry, field); err != nil {
			return Config{}, err
		}
		if previous, ok := seen[entry.Name]; ok {
			return Config{}, &InvalidRequestError{Reason: fmt.Sprintf("services[%d].name duplicates services[%d].name", i, previous)}
		}
		seen[entry.Name] = i
		normalized[i] = NewServiceEntry(entry.Name, *entry.Enabled)
	}

	return Config{Services: &normalized}, nil
}

func validateServiceEntry(entry ServiceEntry, field string) error {
	if entry.Name == "" {
		return &InvalidRequestError{Reason: field + ".name is required"}
	}
	if !validServiceName(entry.Name) {
		return &InvalidRequestError{Reason: field + ".name must be a valid systemd unit name"}
	}
	if entry.Enabled == nil {
		return &InvalidRequestError{Reason: field + ".enabled is required"}
	}
	return nil
}

func validServiceName(name string) bool {
	if name == "" ||
		len(name) > maxServiceNameLength ||
		name != strings.TrimSpace(name) ||
		strings.HasPrefix(name, ".") ||
		strings.ContainsAny(name, "/\\") ||
		strings.Contains(name, "..") ||
		controlCharacter.MatchString(name) ||
		containsInlineServiceMaterial(name) ||
		hasInlineReferenceScheme(name) {
		return false
	}

	for _, r := range name {
		switch {
		case r >= 'A' && r <= 'Z':
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9':
		case r == ':', r == '.', r == '_', r == '@', r == '-':
		default:
			return false
		}
	}

	prefix, ok := serviceNamePrefix(name)
	if !ok || prefix == "" || strings.HasPrefix(prefix, ".") {
		return false
	}
	for _, r := range prefix {
		switch {
		case r >= 'A' && r <= 'Z':
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9':
		case r == ':', r == '.', r == '_', r == '@', r == '-':
		default:
			return false
		}
	}

	return true
}

func serviceNamePrefix(name string) (string, bool) {
	for _, suffix := range systemdUnitSuffixes {
		if strings.HasSuffix(name, suffix) {
			return strings.TrimSuffix(name, suffix), true
		}
	}
	return "", false
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

func containsInlineServiceMaterial(value string) bool {
	if strings.Contains(strings.ToUpper(value), "-----BEGIN") ||
		privateKeyPattern.MatchString(value) ||
		secretAssignment.MatchString(value) {
		return true
	}
	return longHexPattern.MatchString(value) || longBase64Pattern.MatchString(value)
}

func renderConfig(config Config) ([]byte, error) {
	normalized, err := normalizeConfig(config)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return nil, fmt.Errorf("render services config: %w", err)
	}
	return append(encoded, '\n'), nil
}

func parseConfig(raw []byte) (Config, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return Config{}, &ParseError{Reason: "empty services config"}
	}

	var config Config
	if err := json.Unmarshal(raw, &config); err != nil {
		return Config{}, &ParseError{Reason: err.Error()}
	}
	normalized, err := normalizeConfig(config)
	if err != nil {
		return Config{}, err
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
		if _, ok := allowed[key]; !ok {
			return fmt.Errorf("unknown field %q", key)
		}
	}
	return nil
}

func requiredServiceListField(fields map[string]json.RawMessage, key string) ([]ServiceEntry, error) {
	raw, ok := fields[key]
	if !ok {
		return nil, fmt.Errorf("%s is required", key)
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, fmt.Errorf("%s must be a list", key)
	}

	var rawItems []json.RawMessage
	if err := decodeSingleJSONValue(raw, &rawItems); err != nil {
		return nil, fmt.Errorf("%s must be a list", key)
	}

	items := make([]ServiceEntry, len(rawItems))
	for i, rawItem := range rawItems {
		if bytes.Equal(bytes.TrimSpace(rawItem), []byte("null")) {
			return nil, fmt.Errorf("%s[%d] must be an object", key, i)
		}
		var entry ServiceEntry
		if err := decodeSingleJSONValue(rawItem, &entry); err != nil {
			return nil, err
		}
		items[i] = entry
	}
	return items, nil
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

func requiredBoolField(fields map[string]json.RawMessage, key string) (bool, error) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return false, fmt.Errorf("%s is required", key)
	}

	var value bool
	if err := decodeSingleJSONValue(raw, &value); err != nil {
		return false, fmt.Errorf("%s must be a boolean", key)
	}
	return value, nil
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

func cloneConfig(config Config) Config {
	if config.Services == nil {
		return Config{}
	}
	services := *config.Services
	if services == nil {
		var nilServices []ServiceEntry
		return Config{Services: &nilServices}
	}
	return Config{Services: serviceEntriesPointer(cloneServiceEntries(services))}
}

func cloneServiceEntries(entries []ServiceEntry) []ServiceEntry {
	out := make([]ServiceEntry, len(entries))
	for i, entry := range entries {
		out[i] = ServiceEntry{
			Name:    entry.Name,
			Enabled: cloneBoolPtr(entry.Enabled),
		}
	}
	return out
}

func cloneSnapshot(snapshot configSnapshot) configSnapshot {
	return configSnapshot{
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

func serviceEntriesPointer(entries []ServiceEntry) *[]ServiceEntry {
	return &entries
}

func boolPointer(value bool) *bool {
	out := value
	return &out
}

func cloneBoolPtr(in *bool) *bool {
	if in == nil {
		return nil
	}
	out := *in
	return &out
}
