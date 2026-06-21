package accounts

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

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/internal/jsonsafe"
	"github.com/vita/agent/transaction"
)

const (
	Name = "accounts.config"

	defaultStateRoot      = "/var/lib/vita-agent"
	defaultConfigFilename = "local-accounts-config.json"
	configFileMode        = 0o600
	stateRootMode         = 0o700

	minManagedUID = 1000
	maxManagedUID = 60000
)

type Account struct {
	Name         string   `json:"name"`
	UID          int      `json:"uid"`
	PrimaryGroup string   `json:"primaryGroup"`
	Groups       []string `json:"groups"`
	Shell        string   `json:"shell"`
	Enabled      *bool    `json:"enabled"`
}

func NewAccount(name string, uid int, primaryGroup string, groups []string, shell string, enabled bool) Account {
	return Account{
		Name:         name,
		UID:          uid,
		PrimaryGroup: primaryGroup,
		Groups:       cloneStringSlice(groups),
		Shell:        shell,
		Enabled:      boolPointer(enabled),
	}
}

func (a Account) Validate() error {
	_, err := normalizeAccount(0, a)
	return err
}

func (a *Account) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, accountFields); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	name, err := requiredStringField(fields, "name")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	uid, err := requiredUIDField(fields, "uid")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	primaryGroup, err := requiredStringField(fields, "primaryGroup")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	groups, err := requiredStringListField(fields, "groups")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	shell, err := requiredStringField(fields, "shell")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	enabled, err := requiredBoolField(fields, "enabled")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	account, err := normalizeAccount(0, NewAccount(name, uid, primaryGroup, groups, shell, enabled))
	if err != nil {
		return err
	}

	*a = account
	return nil
}

type Config struct {
	Accounts *[]Account `json:"accounts"`
}

func NewConfig(accounts []Account) Config {
	return Config{Accounts: accountsPointer(cloneAccounts(accounts))}
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

	accounts, err := requiredAccountListField(fields, "accounts")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	normalized, err := normalizeConfig(NewConfig(accounts))
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
	return fmt.Sprintf("invalid accounts request: %s", e.Reason)
}

type ParseError struct {
	Reason string
}

func (e *ParseError) Error() string {
	return fmt.Sprintf("parse accounts config: %s", e.Reason)
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
		return nil, &InvalidRequestError{Reason: "expected accounts.ReadRequest"}
	}
	if c == nil || c.fs == nil {
		return nil, &InvalidRequestError{Reason: "missing accounts config filesystem"}
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
		return nil, &InvalidRequestError{Reason: "expected accounts.ApplyRequest"}
	}
	if c == nil || c.fs == nil {
		return nil, &InvalidRequestError{Reason: "missing accounts config filesystem"}
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
			return nil, errors.Join(err, fmt.Errorf("restore prior accounts config: %w", restoreErr))
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
		return &InvalidRequestError{Reason: "missing accounts config filesystem"}
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
		return configSnapshot{}, fmt.Errorf("read accounts config: %w", err)
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
		return fmt.Errorf("create accounts state root: %w", err)
	}
	if err := os.Chmod(fs.stateRoot, stateRootMode); err != nil {
		return fmt.Errorf("secure accounts state root: %w", err)
	}

	tmp, err := os.CreateTemp(fs.stateRoot, ".local-accounts-config-*.tmp")
	if err != nil {
		return fmt.Errorf("create accounts temp file: %w", err)
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
		return fmt.Errorf("secure accounts temp file: %w", err)
	}
	written, err := tmp.Write(content)
	if err != nil {
		return fmt.Errorf("write accounts temp file: %w", err)
	}
	if written != len(content) {
		return fmt.Errorf("write accounts temp file: %w", io.ErrShortWrite)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("sync accounts temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		closed = true
		return fmt.Errorf("close accounts temp file: %w", err)
	}
	closed = true

	if err := ctx.Err(); err != nil {
		return err
	}
	// Rename is the single commit point: callers only receive an undo after nil error.
	if err := os.Rename(tmpName, fs.path); err != nil {
		return fmt.Errorf("replace accounts config: %w", err)
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
		return fmt.Errorf("remove accounts config: %w", err)
	}
	return nil
}

var (
	applyRequestFields = map[string]struct{}{
		"desired": {},
	}
	configFields = map[string]struct{}{
		"accounts": {},
	}
	accountFields = map[string]struct{}{
		"enabled":      {},
		"groups":       {},
		"name":         {},
		"primaryGroup": {},
		"shell":        {},
		"uid":          {},
	}

	accountNamePattern = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)
	groupNamePattern   = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)
	dataURLPattern     = regexp.MustCompile(`(?i)\bdata:`)
	pemBlockPattern    = regexp.MustCompile(`(?i)-----BEGIN\b`)
	longBase64Pattern  = regexp.MustCompile(`[A-Za-z0-9+/]{48,}={0,2}|[A-Za-z0-9_-]{48,}`)

	privilegedGroups = map[string]struct{}{
		"admin": {},
		"root":  {},
		"sudo":  {},
		"wheel": {},
	}
	allowedShells = map[string]struct{}{
		"/bin/bash":         {},
		"/bin/sh":           {},
		"/usr/bin/bash":     {},
		"/usr/bin/zsh":      {},
		"/usr/sbin/nologin": {},
		"/bin/false":        {},
	}
)

func validateApplyRequest(req ApplyRequest) (Config, error) {
	if req.Desired == nil {
		return Config{}, &InvalidRequestError{Reason: "desired is required"}
	}
	return normalizeConfig(*req.Desired)
}

func normalizeConfig(config Config) (Config, error) {
	if config.Accounts == nil {
		return Config{}, &InvalidRequestError{Reason: "accounts is required"}
	}
	if *config.Accounts == nil {
		return Config{}, &InvalidRequestError{Reason: "accounts must be a list"}
	}

	accounts := *config.Accounts
	normalized := make([]Account, len(accounts))
	seenNames := make(map[string]int, len(accounts))
	seenUIDs := make(map[int]int, len(accounts))
	for i, account := range accounts {
		normalizedAccount, err := normalizeAccount(i, account)
		if err != nil {
			return Config{}, err
		}
		if previous, ok := seenNames[normalizedAccount.Name]; ok {
			return Config{}, &InvalidRequestError{Reason: fmt.Sprintf("accounts[%d].name duplicates accounts[%d].name", i, previous)}
		}
		seenNames[normalizedAccount.Name] = i
		if previous, ok := seenUIDs[normalizedAccount.UID]; ok {
			return Config{}, &InvalidRequestError{Reason: fmt.Sprintf("accounts[%d].uid duplicates accounts[%d].uid", i, previous)}
		}
		seenUIDs[normalizedAccount.UID] = i
		normalized[i] = normalizedAccount
	}

	return Config{Accounts: &normalized}, nil
}

func normalizeAccount(index int, account Account) (Account, error) {
	field := fmt.Sprintf("accounts[%d]", index)
	if !validAccountName(account.Name) {
		return Account{}, &InvalidRequestError{Reason: field + ".name must be a valid POSIX account name"}
	}
	if account.UID < minManagedUID || account.UID > maxManagedUID {
		return Account{}, &InvalidRequestError{Reason: fmt.Sprintf("%s.uid must be an integer from %d through %d", field, minManagedUID, maxManagedUID)}
	}
	if !validGroupName(account.PrimaryGroup) {
		return Account{}, &InvalidRequestError{Reason: field + ".primaryGroup must be a valid POSIX group name"}
	}
	if isPrivilegedGroup(account.PrimaryGroup) {
		return Account{}, &InvalidRequestError{Reason: field + ".primaryGroup must not be a privileged group"}
	}
	if account.Groups == nil {
		return Account{}, &InvalidRequestError{Reason: field + ".groups must be a list"}
	}
	if !isAllowedShell(account.Shell) {
		return Account{}, &InvalidRequestError{Reason: field + ".shell must be an allowlisted shell"}
	}
	if account.Enabled == nil {
		return Account{}, &InvalidRequestError{Reason: field + ".enabled is required"}
	}

	groups := make([]string, 0, len(account.Groups))
	seenGroups := make(map[string]struct{}, len(account.Groups))
	for i, group := range account.Groups {
		groupField := fmt.Sprintf("%s.groups[%d]", field, i)
		if !validGroupName(group) {
			return Account{}, &InvalidRequestError{Reason: groupField + " must be a valid POSIX group name"}
		}
		if isPrivilegedGroup(group) {
			return Account{}, &InvalidRequestError{Reason: groupField + " must not be a privileged group"}
		}
		if _, exists := seenGroups[group]; !exists {
			seenGroups[group] = struct{}{}
			groups = append(groups, group)
		}
	}

	return Account{
		Name:         account.Name,
		UID:          account.UID,
		PrimaryGroup: account.PrimaryGroup,
		Groups:       groups,
		Shell:        account.Shell,
		Enabled:      cloneBoolPtr(account.Enabled),
	}, nil
}

func validAccountName(value string) bool {
	return accountNamePattern.MatchString(value) && !containsInlineKeyMaterial(value)
}

func validGroupName(value string) bool {
	return groupNamePattern.MatchString(value) && !containsInlineKeyMaterial(value)
}

func isPrivilegedGroup(value string) bool {
	_, ok := privilegedGroups[value]
	return ok
}

func isAllowedShell(value string) bool {
	if containsInlineKeyMaterial(value) {
		return false
	}
	_, ok := allowedShells[value]
	return ok
}

func containsInlineKeyMaterial(value string) bool {
	return dataURLPattern.MatchString(value) ||
		pemBlockPattern.MatchString(value) ||
		longBase64Pattern.MatchString(value)
}

func renderConfig(config Config) ([]byte, error) {
	normalized, err := normalizeConfig(config)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return nil, fmt.Errorf("render accounts config: %w", err)
	}
	return append(encoded, '\n'), nil
}

func parseConfig(raw []byte) (Config, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return Config{}, &ParseError{Reason: "empty accounts config"}
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

func requiredAccountListField(fields map[string]json.RawMessage, key string) ([]Account, error) {
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

	items := make([]Account, len(rawItems))
	for i, rawItem := range rawItems {
		if bytes.Equal(bytes.TrimSpace(rawItem), []byte("null")) {
			return nil, fmt.Errorf("%s[%d] must be an object", key, i)
		}
		var account Account
		if err := decodeSingleJSONValue(rawItem, &account); err != nil {
			return nil, err
		}
		items[i] = account
	}
	return items, nil
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
		var item string
		if err := decodeSingleJSONValue(rawItem, &item); err != nil {
			return nil, fmt.Errorf("%s[%d] must be a string", key, i)
		}
		items[i] = item
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

func requiredUIDField(fields map[string]json.RawMessage, key string) (int, error) {
	raw, ok := fields[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return 0, fmt.Errorf("%s is required", key)
	}

	var value int
	if err := decodeSingleJSONValue(raw, &value); err != nil {
		return 0, fmt.Errorf("%s must be an integer", key)
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
	if config.Accounts == nil {
		return Config{}
	}
	accounts := *config.Accounts
	if accounts == nil {
		var nilAccounts []Account
		return Config{Accounts: &nilAccounts}
	}
	return Config{Accounts: accountsPointer(cloneAccounts(accounts))}
}

func cloneAccounts(accounts []Account) []Account {
	out := make([]Account, len(accounts))
	for i, account := range accounts {
		out[i] = Account{
			Name:         account.Name,
			UID:          account.UID,
			PrimaryGroup: account.PrimaryGroup,
			Groups:       cloneStringSlice(account.Groups),
			Shell:        account.Shell,
			Enabled:      cloneBoolPtr(account.Enabled),
		}
	}
	return out
}

func cloneStringSlice(values []string) []string {
	if values == nil {
		return nil
	}
	out := make([]string, len(values))
	copy(out, values)
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

func accountsPointer(accounts []Account) *[]Account {
	return &accounts
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
