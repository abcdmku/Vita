package timesync

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
	"sort"
	"strings"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/internal/jsonsafe"
	"github.com/vita/agent/transaction"
)

const (
	Name = "time.sync"

	defaultStateRoot      = "/var/lib/vita-agent"
	defaultConfigFilename = "time-sync-config.json"
	configFileMode        = 0o600
	stateRootMode         = 0o700

	maxServers        = 8
	maxHostnameLength = 253
)

type Config struct {
	Enabled *bool    `json:"enabled"`
	Servers []string `json:"servers"`
}

func NewConfig(enabled bool, servers []string) Config {
	return Config{
		Enabled: boolPointer(enabled),
		Servers: cloneStrings(servers),
	}
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

	enabled, err := requiredBoolField(fields, "enabled")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	servers, err := requiredStringListField(fields, "servers")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	normalized, err := normalizeConfig(Config{
		Enabled: boolPointer(enabled),
		Servers: servers,
	})
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
	if !ok {
		return &InvalidRequestError{Reason: "desired is required"}
	}
	if bytes.Equal(bytes.TrimSpace(rawDesired), []byte("null")) {
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
	return fmt.Sprintf("invalid time sync request: %s", e.Reason)
}

type ParseError struct {
	Reason string
}

func (e *ParseError) Error() string {
	return fmt.Sprintf("parse time sync config: %s", e.Reason)
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
		return nil, &InvalidRequestError{Reason: "expected timesync.ReadRequest"}
	}
	if c == nil || c.fs == nil {
		return nil, &InvalidRequestError{Reason: "missing time sync config filesystem"}
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
		return nil, &InvalidRequestError{Reason: "expected timesync.ApplyRequest"}
	}
	if c == nil || c.fs == nil {
		return nil, &InvalidRequestError{Reason: "missing time sync config filesystem"}
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
		return &InvalidRequestError{Reason: "missing time sync config filesystem"}
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
		return configSnapshot{}, fmt.Errorf("read time sync config: %w", err)
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
		return fmt.Errorf("create time sync state root: %w", err)
	}
	if err := os.Chmod(fs.stateRoot, stateRootMode); err != nil {
		return fmt.Errorf("secure time sync state root: %w", err)
	}

	tmp, err := os.CreateTemp(fs.stateRoot, ".time-sync-config-*.tmp")
	if err != nil {
		return fmt.Errorf("create time sync temp file: %w", err)
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
		return fmt.Errorf("secure time sync temp file: %w", err)
	}
	written, err := tmp.Write(content)
	if err != nil {
		return fmt.Errorf("write time sync temp file: %w", err)
	}
	if written != len(content) {
		return fmt.Errorf("write time sync temp file: %w", io.ErrShortWrite)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("sync time sync temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		closed = true
		return fmt.Errorf("close time sync temp file: %w", err)
	}
	closed = true

	if err := ctx.Err(); err != nil {
		return err
	}
	// Rename is the single commit point: callers only receive an undo after nil error.
	if err := os.Rename(tmpName, fs.path); err != nil {
		return fmt.Errorf("replace time sync config: %w", err)
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
		return fmt.Errorf("remove time sync config: %w", err)
	}
	return nil
}

var (
	applyRequestFields = map[string]struct{}{
		"desired": {},
	}
	configFields = map[string]struct{}{
		"enabled": {},
		"servers": {},
	}

	hostnameLabelPattern  = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$`)
	controlCharacterMatch = regexp.MustCompile(`[\x00-\x1f\x7f]`)
)

func validateApplyRequest(req ApplyRequest) (Config, error) {
	if req.Desired == nil {
		return Config{}, &InvalidRequestError{Reason: "desired is required"}
	}
	return normalizeConfig(*req.Desired)
}

func normalizeConfig(config Config) (Config, error) {
	if config.Enabled == nil {
		return Config{}, &InvalidRequestError{Reason: "enabled is required"}
	}

	enabled := *config.Enabled
	if enabled {
		if len(config.Servers) == 0 {
			return Config{}, &InvalidRequestError{Reason: "servers must contain 1-8 entries when enabled"}
		}
		if len(config.Servers) > maxServers {
			return Config{}, &InvalidRequestError{Reason: "servers must contain 1-8 entries when enabled"}
		}
	} else if len(config.Servers) != 0 {
		return Config{}, &InvalidRequestError{Reason: "servers must be empty when disabled"}
	}

	normalizedServers := make([]string, 0, len(config.Servers))
	seen := make(map[string]int, len(config.Servers))
	for i, server := range config.Servers {
		normalized, err := normalizeServer(server)
		if err != nil {
			return Config{}, &InvalidRequestError{Reason: fmt.Sprintf("servers[%d] must be a valid hostname or IP literal", i)}
		}
		if previous, ok := seen[normalized]; ok {
			return Config{}, &InvalidRequestError{Reason: fmt.Sprintf("servers[%d] duplicates servers[%d]", i, previous)}
		}
		seen[normalized] = i
		normalizedServers = append(normalizedServers, normalized)
	}

	return Config{
		Enabled: boolPointer(enabled),
		Servers: normalizedServers,
	}, nil
}

func normalizeServer(value string) (string, error) {
	if value == "" || value != strings.TrimSpace(value) || controlCharacterMatch.MatchString(value) {
		return "", errors.New("invalid server")
	}

	if addr, err := netip.ParseAddr(value); err == nil {
		return addr.String(), nil
	}
	if !validHostname(value) {
		return "", errors.New("invalid server")
	}

	return strings.ToLower(value), nil
}

func validHostname(value string) bool {
	if value == "" ||
		len(value) > maxHostnameLength ||
		value != strings.TrimSpace(value) ||
		strings.HasSuffix(value, ".") ||
		strings.Contains(value, "..") ||
		strings.ContainsAny(value, ":/?#[]@") ||
		controlCharacterMatch.MatchString(value) {
		return false
	}

	labels := strings.Split(value, ".")
	for _, label := range labels {
		if len(label) == 0 || len(label) > 63 || !hostnameLabelPattern.MatchString(label) {
			return false
		}
	}
	return true
}

func renderConfig(config Config) ([]byte, error) {
	normalized, err := normalizeConfig(config)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return nil, fmt.Errorf("render time sync config: %w", err)
	}
	return append(encoded, '\n'), nil
}

func parseConfig(raw []byte) (Config, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return Config{}, &ParseError{Reason: "empty time sync config"}
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

func requiredStringListField(fields map[string]json.RawMessage, key string) ([]string, error) {
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

	items := make([]string, len(rawItems))
	for i, rawItem := range rawItems {
		if bytes.Equal(bytes.TrimSpace(rawItem), []byte("null")) {
			return nil, fmt.Errorf("%s[%d] must be a string", key, i)
		}

		var value string
		if err := decodeSingleJSONValue(rawItem, &value); err != nil {
			return nil, fmt.Errorf("%s[%d] must be a string", key, i)
		}
		items[i] = value
	}
	return items, nil
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
	normalized := Config{
		Servers: cloneStrings(config.Servers),
	}
	if config.Enabled != nil {
		normalized.Enabled = boolPointer(*config.Enabled)
	}
	return normalized
}

func cloneSnapshot(snapshot configSnapshot) configSnapshot {
	return configSnapshot{
		exists: snapshot.exists,
		bytes:  cloneBytes(snapshot.bytes),
	}
}

func cloneStrings(in []string) []string {
	if in == nil {
		return nil
	}
	out := make([]string, len(in))
	copy(out, in)
	return out
}

func cloneBytes(in []byte) []byte {
	if in == nil {
		return nil
	}
	out := make([]byte, len(in))
	copy(out, in)
	return out
}

func boolPointer(value bool) *bool {
	out := value
	return &out
}
