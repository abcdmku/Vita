package pdssync

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/big"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/internal/jsonsafe"
	"github.com/vita/agent/transaction"
)

const (
	Name = "pds.sync-state"

	defaultStateRoot         = "/var/lib/vita-agent"
	defaultSyncStateFilename = "pds-sync-state.json"
	syncStateFileMode        = 0o600
	stateRootMode            = 0o700

	maxCIDLength         = 512
	maxDIDLength         = 2048
	maxCursor      int64 = 9007199254740991
	maxDigestBytes       = 128

	didPlcPrefix = "did:plc:"
	didWebPrefix = "did:web:"
	cidVersion   = 1
)

const MaxCursor = maxCursor

type SyncState struct {
	Repo     string `json:"repo"`
	Cursor   int64  `json:"cursor"`
	RepoHead string `json:"repoHead"`
}

func (s SyncState) Validate() error {
	return validateSyncState(s)
}

func (s *SyncState) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, syncStateFields); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	repo, err := requiredStringField(fields, "repo")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	cursor, err := requiredCursorField(fields, "cursor")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	repoHead, err := requiredStringField(fields, "repoHead")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	state := SyncState{
		Repo:     repo,
		Cursor:   cursor,
		RepoHead: repoHead,
	}
	if err := validateSyncState(state); err != nil {
		return err
	}

	*s = state
	return nil
}

type ReadRequest struct{}

func (ReadRequest) CapabilityRequest() {}

func (ReadRequest) Validate() error { return nil }

type ApplyRequest struct {
	Desired *SyncState `json:"desired"`
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

	var desired SyncState
	if err := json.Unmarshal(rawDesired, &desired); err != nil {
		return err
	}

	*r = ApplyRequest{Desired: &desired}
	return nil
}

func (r ApplyRequest) Validate() error {
	if r.Desired == nil {
		return &InvalidRequestError{Reason: "desired is required"}
	}
	return validateSyncState(*r.Desired)
}

type ReadResponse struct {
	Exists bool      `json:"exists"`
	State  SyncState `json:"state"`
	Raw    []byte    `json:"raw"`
}

func (ReadResponse) CapabilityResponse() {}

type Capability struct {
	fs syncStateFileSystem
	mu sync.Mutex
}

type syncStateSnapshot struct {
	exists bool
	bytes  []byte
}

type syncStateFileSystem interface {
	Read(context.Context) (syncStateSnapshot, error)
	AtomicWrite(context.Context, []byte) error
	Replace(context.Context, syncStateSnapshot) error
}

type InvalidRequestError struct {
	Reason string
}

func (e *InvalidRequestError) Error() string {
	return fmt.Sprintf("invalid PDS sync state request: %s", e.Reason)
}

type ParseError struct {
	Reason string
}

func (e *ParseError) Error() string {
	return fmt.Sprintf("parse PDS sync state: %s", e.Reason)
}

func NewCapability() *Capability {
	return newCapability(newDefaultFileSystem())
}

func newCapability(fs syncStateFileSystem) *Capability {
	return &Capability{fs: fs}
}

func (c *Capability) Name() string {
	return Name
}

func (c *Capability) Handle(ctx context.Context, req capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	if _, ok := req.(ReadRequest); !ok {
		return nil, &InvalidRequestError{Reason: "expected pdssync.ReadRequest"}
	}
	if c == nil || c.fs == nil {
		return nil, &InvalidRequestError{Reason: "missing PDS sync state filesystem"}
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	snapshot, err := c.fs.Read(ctx)
	if err != nil {
		return nil, err
	}
	if !snapshot.exists {
		return ReadResponse{Exists: false}, nil
	}

	parsed, err := parseSyncState(snapshot.bytes)
	if err != nil {
		return nil, err
	}

	return ReadResponse{
		Exists: true,
		State:  parsed,
		Raw:    renderSyncState(parsed),
	}, nil
}

func (c *Capability) Apply(ctx context.Context, req capabilities.TypedRequest) (transaction.Undo, error) {
	applyReq, ok := req.(ApplyRequest)
	if !ok {
		return nil, &InvalidRequestError{Reason: "expected pdssync.ApplyRequest"}
	}
	if c == nil || c.fs == nil {
		return nil, &InvalidRequestError{Reason: "missing PDS sync state filesystem"}
	}
	if err := applyReq.Validate(); err != nil {
		return nil, err
	}

	desired := cloneSyncState(*applyReq.Desired)
	desiredBytes := renderSyncState(desired)

	c.mu.Lock()
	defer c.mu.Unlock()

	prior, err := c.fs.Read(ctx)
	if err != nil {
		return nil, err
	}
	if prior.exists {
		priorState, err := parseSyncState(cloneBytes(prior.bytes))
		if err != nil {
			return nil, err
		}
		if desired.Cursor < priorState.Cursor {
			return nil, &InvalidRequestError{Reason: "cursor must not regress below current sync cursor"}
		}
	}

	undo := undoSyncState{
		fs:    c.fs,
		mu:    &c.mu,
		prior: cloneSnapshot(prior),
	}
	if err := c.fs.AtomicWrite(ctx, desiredBytes); err != nil {
		return nil, err
	}

	return undo, nil
}

type undoSyncState struct {
	fs    syncStateFileSystem
	mu    *sync.Mutex
	prior syncStateSnapshot
}

func (u undoSyncState) Undo(ctx context.Context) error {
	if u.fs == nil {
		return &InvalidRequestError{Reason: "missing PDS sync state filesystem"}
	}
	if u.mu != nil {
		u.mu.Lock()
		defer u.mu.Unlock()
	}
	return u.fs.Replace(ctx, cloneSnapshot(u.prior))
}

type defaultFileSystem struct {
	stateRoot string
	path      string
}

func newDefaultFileSystem() syncStateFileSystem {
	return defaultFileSystem{
		stateRoot: defaultStateRoot,
		path:      filepath.Join(defaultStateRoot, defaultSyncStateFilename),
	}
}

func (fs defaultFileSystem) Read(ctx context.Context) (syncStateSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return syncStateSnapshot{}, err
	}

	content, err := os.ReadFile(fs.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return syncStateSnapshot{exists: false}, nil
		}
		return syncStateSnapshot{}, fmt.Errorf("read PDS sync state: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return syncStateSnapshot{}, err
	}

	return syncStateSnapshot{exists: true, bytes: cloneBytes(content)}, nil
}

func (fs defaultFileSystem) AtomicWrite(ctx context.Context, content []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.MkdirAll(fs.stateRoot, stateRootMode); err != nil {
		return fmt.Errorf("create PDS sync state root: %w", err)
	}
	if err := os.Chmod(fs.stateRoot, stateRootMode); err != nil {
		return fmt.Errorf("secure PDS sync state root: %w", err)
	}

	tmp, err := os.CreateTemp(fs.stateRoot, ".pds-sync-state-*.tmp")
	if err != nil {
		return fmt.Errorf("create PDS sync state temp file: %w", err)
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

	if err := tmp.Chmod(syncStateFileMode); err != nil {
		return fmt.Errorf("secure PDS sync state temp file: %w", err)
	}
	written, err := tmp.Write(content)
	if err != nil {
		return fmt.Errorf("write PDS sync state temp file: %w", err)
	}
	if written != len(content) {
		return fmt.Errorf("write PDS sync state temp file: %w", io.ErrShortWrite)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("sync PDS sync state temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		closed = true
		return fmt.Errorf("close PDS sync state temp file: %w", err)
	}
	closed = true

	if err := ctx.Err(); err != nil {
		return err
	}
	// Rename is the single commit point: callers only receive an undo after nil error.
	if err := os.Rename(tmpName, fs.path); err != nil {
		return fmt.Errorf("replace PDS sync state: %w", err)
	}
	cleanupTemp = false
	return nil
}

func (fs defaultFileSystem) Replace(ctx context.Context, snapshot syncStateSnapshot) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if snapshot.exists {
		return fs.AtomicWrite(ctx, snapshot.bytes)
	}

	if err := os.Remove(fs.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove PDS sync state: %w", err)
	}
	return nil
}

var (
	applyRequestFields = map[string]struct{}{
		"desired": {},
	}
	syncStateFields = map[string]struct{}{
		"cursor":   {},
		"repo":     {},
		"repoHead": {},
	}

	didPlcIdentifierPattern  = regexp.MustCompile(`^[a-z2-7]{24}$`)
	didWebPathSegmentPattern = regexp.MustCompile(`^(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+$`)
	didWebHostLabelPattern   = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
	controlCharacterPattern  = regexp.MustCompile(`[\x00-\x1f\x7f]`)

	secretFieldNameTokens = map[string]struct{}{
		"apikey":      {},
		"key":         {},
		"keymaterial": {},
		"mnemonic":    {},
		"passphrase":  {},
		"pem":         {},
		"privatekey":  {},
		"recoverykey": {},
		"rotationkey": {},
		"seed":        {},
		"seedphrase":  {},
		"secret":      {},
		"signingkey":  {},
	}
)

const (
	base32LowerAlphabet = "abcdefghijklmnopqrstuvwxyz234567"
	base58BTCAlphabet   = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
)

func validateSyncState(state SyncState) error {
	if !isSupportedDID(state.Repo) {
		return &InvalidRequestError{Reason: "repo must be a supported did:plc or did:web identifier"}
	}
	if state.Cursor < 0 || state.Cursor > maxCursor {
		return &InvalidRequestError{Reason: "cursor must be a monotonic integer from 0 through 9007199254740991"}
	}
	if !isCIDV1(state.RepoHead) {
		return &InvalidRequestError{Reason: "repoHead must be a well-formed CIDv1 string"}
	}
	return nil
}

func renderSyncState(state SyncState) []byte {
	encoded, err := json.Marshal(state)
	if err != nil {
		return nil
	}
	return append(encoded, '\n')
}

func parseSyncState(raw []byte) (SyncState, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return SyncState{}, &ParseError{Reason: "empty PDS sync state"}
	}
	var state SyncState
	if err := jsonsafe.DecodeStrict(raw, &state); err != nil {
		return SyncState{}, &ParseError{Reason: err.Error()}
	}
	if err := validateSyncState(state); err != nil {
		return SyncState{}, err
	}
	return state, nil
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
		if isSecretFieldName(key) {
			return fmt.Errorf("%s contains inline key material", key)
		}
		if _, ok := allowed[key]; !ok {
			return fmt.Errorf("unknown field %q", key)
		}
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

func requiredCursorField(fields map[string]json.RawMessage, key string) (int64, error) {
	raw, ok := fields[key]
	if !ok {
		return 0, fmt.Errorf("%s is required", key)
	}

	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var number json.Number
	if err := decoder.Decode(&number); err != nil {
		return 0, fmt.Errorf("%s must be a monotonic integer", key)
	}
	var extra struct{}
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return 0, fmt.Errorf("%s must contain exactly one JSON value", key)
		}
		return 0, err
	}

	cursor, err := parseCursorNumber(number)
	if err != nil {
		return 0, fmt.Errorf("%s must be a monotonic integer from 0 through 9007199254740991", key)
	}
	return cursor, nil
}

func parseCursorNumber(number json.Number) (int64, error) {
	raw := number.String()
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsInf(value, 0) || math.IsNaN(value) || math.Trunc(value) != value || value < 0 || value > float64(maxCursor) {
		return 0, errors.New("invalid cursor")
	}

	return int64(value), nil
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

func isSupportedDID(value string) bool {
	if len(value) > maxDIDLength || value != strings.TrimSpace(value) {
		return false
	}
	return isDIDPlc(value) || isDIDWeb(value)
}

func IsSupportedDID(value string) bool {
	return isSupportedDID(value)
}

func isDIDPlc(value string) bool {
	if !strings.HasPrefix(value, didPlcPrefix) {
		return false
	}
	return didPlcIdentifierPattern.MatchString(value[len(didPlcPrefix):])
}

func isDIDWeb(value string) bool {
	if !strings.HasPrefix(value, didWebPrefix) {
		return false
	}

	identifier := value[len(didWebPrefix):]
	if identifier == "" ||
		strings.Contains(identifier, "/") ||
		strings.Contains(identifier, "?") ||
		strings.Contains(identifier, "#") ||
		controlCharacterPattern.MatchString(identifier) {
		return false
	}

	segments := strings.Split(identifier, ":")
	host := segments[0]
	if !isDIDWebHost(host) {
		return false
	}

	for i := 1; i < len(segments); i++ {
		segment := segments[i]
		if segment == "" ||
			segment == "." ||
			segment == ".." ||
			!didWebPathSegmentPattern.MatchString(segment) {
			return false
		}
	}
	return true
}

func isDIDWebHost(value string) bool {
	if len(value) < 3 ||
		len(value) > 253 ||
		value != strings.ToLower(value) ||
		strings.HasSuffix(value, ".") {
		return false
	}

	labels := strings.Split(value, ".")
	if len(labels) < 2 {
		return false
	}

	for _, label := range labels {
		if len(label) == 0 || len(label) > 63 || !didWebHostLabelPattern.MatchString(label) {
			return false
		}
	}

	topLevelLabel := labels[len(labels)-1]
	return len(topLevelLabel) >= 2 && !allDigits(topLevelLabel)
}

func isCIDV1(value string) bool {
	if value == "" ||
		len(value) > maxCIDLength ||
		value != strings.TrimSpace(value) ||
		controlCharacterPattern.MatchString(value) {
		return false
	}

	bytes, ok := decodeMultibase(value)
	if !ok {
		return false
	}
	return isCIDV1Bytes(bytes)
}

func decodeMultibase(value string) ([]byte, bool) {
	prefix := value[0]
	encoded := value[1:]
	if encoded == "" {
		return nil, false
	}

	switch prefix {
	case 'b':
		if encoded != strings.ToLower(encoded) {
			return nil, false
		}
		return decodeBase32(encoded)
	case 'B':
		if encoded != strings.ToUpper(encoded) {
			return nil, false
		}
		return decodeBase32(strings.ToLower(encoded))
	case 'z':
		return decodeBase58BTC(encoded)
	default:
		return nil, false
	}
}

func decodeBase32(value string) ([]byte, bool) {
	buffer := uint32(0)
	bits := 0
	out := make([]byte, 0, len(value)*5/8)

	for i := 0; i < len(value); i++ {
		digit := strings.IndexByte(base32LowerAlphabet, value[i])
		if digit < 0 {
			return nil, false
		}

		buffer = (buffer << 5) | uint32(digit)
		bits += 5

		for bits >= 8 {
			bits -= 8
			out = append(out, byte((buffer>>bits)&0xff))
			if bits == 0 {
				buffer = 0
			} else {
				buffer &= (1 << bits) - 1
			}
		}
	}

	if bits > 0 && buffer != 0 {
		return nil, false
	}
	return out, true
}

func decodeBase58BTC(value string) ([]byte, bool) {
	decoded := big.NewInt(0)
	base := big.NewInt(58)
	for i := 0; i < len(value); i++ {
		digit := strings.IndexByte(base58BTCAlphabet, value[i])
		if digit < 0 {
			return nil, false
		}
		decoded.Mul(decoded, base)
		decoded.Add(decoded, big.NewInt(int64(digit)))
	}

	out := decoded.Bytes()
	leadingZeros := 0
	for leadingZeros < len(value) && value[leadingZeros] == '1' {
		leadingZeros++
	}
	if leadingZeros > 0 {
		out = append(make([]byte, leadingZeros), out...)
	}
	return out, true
}

func isCIDV1Bytes(bytes []byte) bool {
	version, next, ok := readVarint(bytes, 0)
	if !ok || version != cidVersion {
		return false
	}

	codec, next, ok := readVarint(bytes, next)
	if !ok || codec == 0 {
		return false
	}

	hashCode, next, ok := readVarint(bytes, next)
	if !ok || hashCode == 0 {
		return false
	}

	digestSize, next, ok := readVarint(bytes, next)
	if !ok || digestSize == 0 || digestSize > maxDigestBytes {
		return false
	}
	return next+int(digestSize) == len(bytes)
}

func readVarint(bytes []byte, offset int) (uint64, int, bool) {
	if offset < 0 || offset >= len(bytes) {
		return 0, 0, false
	}

	var value uint64
	var shift uint
	for i := offset; i < len(bytes); i++ {
		current := bytes[i]
		part := uint64(current & 0x7f)
		if shift >= 64 || (part<<shift)>>shift != part {
			return 0, 0, false
		}
		value |= part << shift

		if current < 0x80 {
			size := i - offset + 1
			if size > 1 {
				minShift := uint(7 * (size - 1))
				if minShift >= 64 || value < (uint64(1)<<minShift) {
					return 0, 0, false
				}
			}
			return value, i + 1, true
		}

		shift += 7
		if shift > 63 {
			return 0, 0, false
		}
	}

	return 0, 0, false
}

func isSecretFieldName(value string) bool {
	normalized := strings.NewReplacer("-", "", "_", "").Replace(strings.ToLower(value))
	_, ok := secretFieldNameTokens[normalized]
	return ok
}

func IsSecretFieldName(value string) bool {
	return isSecretFieldName(value)
}

func allDigits(value string) bool {
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return value != ""
}

func cloneSyncState(state SyncState) SyncState {
	return SyncState{
		Repo:     state.Repo,
		Cursor:   state.Cursor,
		RepoHead: state.RepoHead,
	}
}

func cloneSnapshot(snapshot syncStateSnapshot) syncStateSnapshot {
	return syncStateSnapshot{
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
