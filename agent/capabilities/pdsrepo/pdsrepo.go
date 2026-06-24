package pdsrepo

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
	"strconv"
	"strings"
	"sync"

	"github.com/vita/agent/capabilities"
	"github.com/vita/agent/capabilities/pdssync"
	"github.com/vita/agent/internal/atomicfile"
	"github.com/vita/agent/internal/jsonsafe"
	"github.com/vita/agent/transaction"
)

const (
	Name = "pds.repo"

	defaultStateRoot         = "/var/lib/vita-agent"
	defaultRepoStateFilename = "pds-repo.json"
	repoStateFileMode        = 0o600
	stateRootMode            = 0o700

	maxCollectionLength = 317
	maxRKeyLength       = 512

	createRecordOp = "create-record"
)

type RepoRecord struct {
	Collection  string `json:"collection"`
	RKey        string `json:"rkey"`
	ValueDigest string `json:"valueDigest"`
}

func (r RepoRecord) Validate() error {
	return validateRepoRecord(r)
}

func (r *RepoRecord) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, repoRecordFields); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	collection, err := requiredStringField(fields, "collection")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	rkey, err := requiredStringField(fields, "rkey")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	valueDigest, err := requiredStringField(fields, "valueDigest")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	record := RepoRecord{
		Collection:  collection,
		RKey:        rkey,
		ValueDigest: valueDigest,
	}
	if err := validateRepoRecord(record); err != nil {
		return err
	}

	*r = record
	return nil
}

type Commit struct {
	Cursor int64 `json:"cursor"`
}

func (c Commit) Validate() error {
	return validateCursor(c.Cursor, "commit.cursor")
}

func (c *Commit) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, commitFields); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	cursor, err := requiredCursorField(fields, "cursor")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	*c = Commit{Cursor: cursor}
	return nil
}

type DesiredState struct {
	Repo    string       `json:"repo"`
	Commit  Commit       `json:"commit"`
	Records []RepoRecord `json:"records"`
}

func (s DesiredState) Validate() error {
	return validateDesiredState(s)
}

func (s *DesiredState) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, desiredStateFields); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	repo, err := requiredStringField(fields, "repo")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	commit, err := requiredCommitField(fields, "commit")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	records, err := requiredRecordsField(fields, "records")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	desired := DesiredState{
		Repo:    repo,
		Commit:  commit,
		Records: records,
	}
	if err := validateDesiredState(desired); err != nil {
		return err
	}

	*s = desired
	return nil
}

type ApplyRequest struct {
	Desired *DesiredState `json:"desired"`
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

	var desired DesiredState
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
	return validateDesiredState(*r.Desired)
}

type ReadRequest struct{}

func (ReadRequest) CapabilityRequest() {}

func (ReadRequest) Validate() error { return nil }

type CommitLogEntry struct {
	Cursor     int64  `json:"cursor"`
	Op         string `json:"op"`
	Collection string `json:"collection"`
	RKey       string `json:"rkey"`
}

func (e CommitLogEntry) Validate() error {
	return validateCommitLogEntry(e)
}

func (e *CommitLogEntry) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, commitLogEntryFields); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	cursor, err := requiredCursorField(fields, "cursor")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	op, err := requiredStringField(fields, "op")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	collection, err := requiredStringField(fields, "collection")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	rkey, err := requiredStringField(fields, "rkey")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	entry := CommitLogEntry{
		Cursor:     cursor,
		Op:         op,
		Collection: collection,
		RKey:       rkey,
	}
	if err := validateCommitLogEntry(entry); err != nil {
		return err
	}

	*e = entry
	return nil
}

type RepoState struct {
	Repo         string           `json:"repo"`
	Records      []RepoRecord     `json:"records"`
	CommitCursor int64            `json:"commitCursor"`
	Log          []CommitLogEntry `json:"log"`
}

func (s RepoState) Validate() error {
	return validateRepoState(s)
}

func (s *RepoState) UnmarshalJSON(raw []byte) error {
	if err := jsonsafe.RejectDuplicateObjectKeys(raw); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	fields, err := decodeObject(raw)
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	if err := rejectUnknownFields(fields, repoStateFields); err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	repo, err := requiredStringField(fields, "repo")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	records, err := requiredStoredRecordsField(fields, "records")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	commitCursor, err := requiredCursorField(fields, "commitCursor")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}
	log, err := requiredLogField(fields, "log")
	if err != nil {
		return &InvalidRequestError{Reason: err.Error()}
	}

	state := RepoState{
		Repo:         repo,
		Records:      records,
		CommitCursor: commitCursor,
		Log:          log,
	}
	if err := validateRepoState(state); err != nil {
		return err
	}

	*s = state
	return nil
}

type ReadResponse struct {
	Exists       bool             `json:"exists"`
	Repo         string           `json:"repo"`
	Records      []RepoRecord     `json:"records"`
	CommitCursor int64            `json:"commitCursor"`
	Log          []CommitLogEntry `json:"log"`
}

func (ReadResponse) CapabilityResponse() {}

type Capability struct {
	fs repoFileSystem
	mu sync.Mutex
}

type repoSnapshot struct {
	exists bool
	bytes  []byte
}

type repoFileSystem interface {
	Read(context.Context) (repoSnapshot, error)
	AtomicWrite(context.Context, []byte) error
	Replace(context.Context, repoSnapshot) error
}

type InvalidRequestError struct {
	Reason string
}

func (e *InvalidRequestError) Error() string {
	return fmt.Sprintf("invalid PDS repo request: %s", e.Reason)
}

func (e *InvalidRequestError) ApplyErrorCode() string {
	return "invalid_request"
}

type ParseError struct {
	Reason string
}

func (e *ParseError) Error() string {
	return fmt.Sprintf("parse PDS repo state: %s", e.Reason)
}

func NewCapability() *Capability {
	return newCapability(newDefaultFileSystem())
}

// NewCapabilityAt builds a PDS repo capability whose authoritative state file
// lives under the supplied state root instead of the fixed default. It is used
// by the power-cut proof (agentd powercut-marker) to drive the SAME durable
// AtomicWrite path against a test-controlled /var-like mount; the on-disk
// format, filename, and modes are identical to NewCapability. The root is a
// fixed, code-controlled path supplied by agentd — never raw runtime text.
func NewCapabilityAt(stateRoot string) *Capability {
	return newCapability(defaultFileSystem{
		stateRoot: stateRoot,
		path:      filepath.Join(stateRoot, defaultRepoStateFilename),
	})
}

func newCapability(fs repoFileSystem) *Capability {
	return &Capability{fs: fs}
}

func (c *Capability) Name() string {
	return Name
}

func (c *Capability) Handle(ctx context.Context, req capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	if _, ok := req.(ReadRequest); !ok {
		return nil, &InvalidRequestError{Reason: "expected pdsrepo.ReadRequest"}
	}
	if c == nil || c.fs == nil {
		return nil, &InvalidRequestError{Reason: "missing PDS repo filesystem"}
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	snapshot, err := c.fs.Read(ctx)
	if err != nil {
		return nil, err
	}
	if !snapshot.exists {
		return emptyReadResponse(), nil
	}

	parsed, err := parseRepoState(snapshot.bytes)
	if err != nil {
		return nil, err
	}

	return readResponseFromState(parsed), nil
}

func (c *Capability) Apply(ctx context.Context, req capabilities.TypedRequest) (transaction.Undo, error) {
	applyReq, ok := req.(ApplyRequest)
	if !ok {
		return nil, &InvalidRequestError{Reason: "expected pdsrepo.ApplyRequest"}
	}
	if c == nil || c.fs == nil {
		return nil, &InvalidRequestError{Reason: "missing PDS repo filesystem"}
	}
	if err := applyReq.Validate(); err != nil {
		return nil, err
	}

	desired := cloneDesiredState(*applyReq.Desired)

	c.mu.Lock()
	defer c.mu.Unlock()

	prior, err := c.fs.Read(ctx)
	if err != nil {
		return nil, err
	}

	next, changed, err := applyDesiredState(cloneSnapshot(prior), desired)
	if err != nil {
		return nil, err
	}

	undo := undoRepoState{
		fs:    c.fs,
		mu:    &c.mu,
		prior: cloneSnapshot(prior),
	}
	if !changed {
		return undo, nil
	}

	if err := c.fs.AtomicWrite(ctx, renderRepoState(next)); err != nil {
		return nil, err
	}

	return undo, nil
}

type undoRepoState struct {
	fs    repoFileSystem
	mu    *sync.Mutex
	prior repoSnapshot
}

func (u undoRepoState) Undo(ctx context.Context) error {
	if u.fs == nil {
		return &InvalidRequestError{Reason: "missing PDS repo filesystem"}
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
	atomicFS  atomicfile.FileSystem
}

func newDefaultFileSystem() repoFileSystem {
	return defaultFileSystem{
		stateRoot: defaultStateRoot,
		path:      filepath.Join(defaultStateRoot, defaultRepoStateFilename),
	}
}

func (fs defaultFileSystem) Read(ctx context.Context) (repoSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return repoSnapshot{}, err
	}

	content, err := os.ReadFile(fs.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return repoSnapshot{exists: false}, nil
		}
		return repoSnapshot{}, fmt.Errorf("read PDS repo state: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return repoSnapshot{}, err
	}

	return repoSnapshot{exists: true, bytes: cloneBytes(content)}, nil
}

func (fs defaultFileSystem) AtomicWrite(ctx context.Context, content []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.MkdirAll(fs.stateRoot, stateRootMode); err != nil {
		return fmt.Errorf("create PDS repo state root: %w", err)
	}
	if err := os.Chmod(fs.stateRoot, stateRootMode); err != nil {
		return fmt.Errorf("secure PDS repo state root: %w", err)
	}

	if err := atomicfile.WriteWithPatternAndBeforeCommit(
		fs.atomicFileSystem(),
		fs.path,
		content,
		repoStateFileMode,
		".pds-repo-*.tmp",
		ctx.Err,
	); err != nil {
		return fmt.Errorf("write PDS repo state: %w", err)
	}
	return nil
}

func (fs defaultFileSystem) atomicFileSystem() atomicfile.FileSystem {
	if fs.atomicFS != nil {
		return fs.atomicFS
	}
	return atomicfile.OSFileSystem{}
}

func (fs defaultFileSystem) Replace(ctx context.Context, snapshot repoSnapshot) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if snapshot.exists {
		return fs.AtomicWrite(ctx, snapshot.bytes)
	}

	if err := os.Remove(fs.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove PDS repo state: %w", err)
	}
	return nil
}

var (
	applyRequestFields = map[string]struct{}{
		"desired": {},
	}
	desiredStateFields = map[string]struct{}{
		"commit":  {},
		"records": {},
		"repo":    {},
	}
	commitFields = map[string]struct{}{
		"cursor": {},
	}
	repoRecordFields = map[string]struct{}{
		"collection":  {},
		"rkey":        {},
		"valueDigest": {},
	}
	repoStateFields = map[string]struct{}{
		"commitCursor": {},
		"log":          {},
		"records":      {},
		"repo":         {},
	}
	commitLogEntryFields = map[string]struct{}{
		"collection": {},
		"cursor":     {},
		"op":         {},
		"rkey":       {},
	}

	nsidSegmentPattern = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$`)
	rkeyPattern        = regexp.MustCompile(`^[A-Za-z0-9._~:-]+$`)
	sha256HexPattern   = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

func applyDesiredState(prior repoSnapshot, desired DesiredState) (RepoState, bool, error) {
	if !prior.exists {
		state := RepoState{
			Repo:         desired.Repo,
			Records:      cloneRecords(desired.Records),
			CommitCursor: desired.Commit.Cursor,
			Log:          logEntriesForRecords(desired.Commit.Cursor, desired.Records),
		}
		sortRepoState(&state)
		return state, true, nil
	}

	state, err := parseRepoState(prior.bytes)
	if err != nil {
		return RepoState{}, false, err
	}
	if desired.Repo != state.Repo {
		return RepoState{}, false, &InvalidRequestError{Reason: "repo must match current PDS repo"}
	}
	if desired.Commit.Cursor < state.CommitCursor {
		return RepoState{}, false, &InvalidRequestError{Reason: "commit cursor must not regress below current repo cursor"}
	}

	existing := recordMap(state.Records)
	newRecords := make([]RepoRecord, 0, len(desired.Records))
	for _, record := range desired.Records {
		key := recordKeyFromRecord(record)
		current, ok := existing[key]
		if ok {
			if current.ValueDigest != record.ValueDigest {
				return RepoState{}, false, &InvalidRequestError{Reason: "record already exists with a different value digest"}
			}
			continue
		}
		existing[key] = record
		newRecords = append(newRecords, cloneRecord(record))
	}

	if len(newRecords) == 0 {
		if desired.Commit.Cursor > state.CommitCursor {
			return RepoState{}, false, &InvalidRequestError{Reason: "commit cursor cannot advance without new records"}
		}
		return state, false, nil
	}
	if desired.Commit.Cursor <= state.CommitCursor {
		return RepoState{}, false, &InvalidRequestError{Reason: "commit cursor must advance when creating records"}
	}

	state.Records = append(cloneRecords(state.Records), newRecords...)
	state.Log = append(cloneLog(state.Log), logEntriesForRecords(desired.Commit.Cursor, newRecords)...)
	state.CommitCursor = desired.Commit.Cursor
	sortRepoState(&state)
	return state, true, nil
}

func validateDesiredState(state DesiredState) error {
	if !pdssync.IsSupportedDID(state.Repo) {
		return &InvalidRequestError{Reason: "repo must be a supported did:plc or did:web identifier"}
	}
	if err := validateCursor(state.Commit.Cursor, "commit.cursor"); err != nil {
		return err
	}
	if len(state.Records) == 0 {
		return &InvalidRequestError{Reason: "records must contain at least one record"}
	}

	seen := make(map[recordKey]RepoRecord, len(state.Records))
	for _, record := range state.Records {
		if err := validateRepoRecord(record); err != nil {
			return err
		}
		key := recordKeyFromRecord(record)
		if _, ok := seen[key]; ok {
			return &InvalidRequestError{Reason: "records must not contain duplicate record keys"}
		}
		seen[key] = record
	}
	return nil
}

func validateRepoState(state RepoState) error {
	if !pdssync.IsSupportedDID(state.Repo) {
		return &InvalidRequestError{Reason: "repo must be a supported did:plc or did:web identifier"}
	}
	if err := validateCursor(state.CommitCursor, "commitCursor"); err != nil {
		return err
	}

	seen := make(map[recordKey]struct{}, len(state.Records))
	for _, record := range state.Records {
		if err := validateRepoRecord(record); err != nil {
			return err
		}
		key := recordKeyFromRecord(record)
		if _, ok := seen[key]; ok {
			return &InvalidRequestError{Reason: "stored records contain duplicate record keys"}
		}
		seen[key] = struct{}{}
	}

	var lastCursor int64 = -1
	for _, entry := range state.Log {
		if err := validateCommitLogEntry(entry); err != nil {
			return err
		}
		if entry.Cursor > state.CommitCursor {
			return &InvalidRequestError{Reason: "commit log cursor exceeds repo cursor"}
		}
		if entry.Cursor < lastCursor {
			return &InvalidRequestError{Reason: "commit log cursors must not regress"}
		}
		lastCursor = entry.Cursor
	}
	return nil
}

func validateRepoRecord(record RepoRecord) error {
	if !isNSIDLike(record.Collection) {
		return &InvalidRequestError{Reason: "collection must be an NSID-shaped string"}
	}
	if !isRecordKey(record.RKey) {
		return &InvalidRequestError{Reason: "rkey must be a bounded AT Protocol record key"}
	}
	if !sha256HexPattern.MatchString(record.ValueDigest) {
		return &InvalidRequestError{Reason: "valueDigest must be a lowercase SHA-256 hex digest"}
	}
	return nil
}

func validateCommitLogEntry(entry CommitLogEntry) error {
	if err := validateCursor(entry.Cursor, "log.cursor"); err != nil {
		return err
	}
	if entry.Op != createRecordOp {
		return &InvalidRequestError{Reason: "commit log op must be create-record"}
	}
	if !isNSIDLike(entry.Collection) {
		return &InvalidRequestError{Reason: "commit log collection must be an NSID-shaped string"}
	}
	if !isRecordKey(entry.RKey) {
		return &InvalidRequestError{Reason: "commit log rkey must be a bounded AT Protocol record key"}
	}
	return nil
}

func validateCursor(cursor int64, field string) error {
	if cursor < 0 || cursor > pdssync.MaxCursor {
		return &InvalidRequestError{Reason: fmt.Sprintf("%s must be a monotonic integer from 0 through 9007199254740991", field)}
	}
	return nil
}

func isNSIDLike(value string) bool {
	if value == "" ||
		len(value) > maxCollectionLength ||
		value != strings.TrimSpace(value) ||
		strings.ContainsAny(value, "/?#") {
		return false
	}
	segments := strings.Split(value, ".")
	if len(segments) < 3 {
		return false
	}
	for _, segment := range segments {
		if !nsidSegmentPattern.MatchString(segment) {
			return false
		}
	}
	return true
}

func isRecordKey(value string) bool {
	return value != "" &&
		len(value) <= maxRKeyLength &&
		value == strings.TrimSpace(value) &&
		rkeyPattern.MatchString(value)
}

func renderRepoState(state RepoState) []byte {
	canonical := cloneRepoState(state)
	sortRepoState(&canonical)
	encoded, err := json.Marshal(canonical)
	if err != nil {
		return nil
	}
	return append(encoded, '\n')
}

func parseRepoState(raw []byte) (RepoState, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return RepoState{}, &ParseError{Reason: "empty PDS repo state"}
	}
	var state RepoState
	if err := jsonsafe.DecodeStrict(raw, &state); err != nil {
		return RepoState{}, &ParseError{Reason: err.Error()}
	}
	if err := validateRepoState(state); err != nil {
		return RepoState{}, err
	}
	sortRepoState(&state)
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
		if pdssync.IsSecretFieldName(key) {
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
	if strings.ContainsAny(raw, ".eE") || !isIntegerLiteral(raw) {
		return 0, errors.New("invalid cursor")
	}
	cursor, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || cursor < 0 || cursor > pdssync.MaxCursor {
		return 0, errors.New("invalid cursor")
	}
	return cursor, nil
}

func isIntegerLiteral(value string) bool {
	if value == "" {
		return false
	}
	start := 0
	if value[0] == '-' {
		start = 1
	}
	if start >= len(value) {
		return false
	}
	for i := start; i < len(value); i++ {
		if value[i] < '0' || value[i] > '9' {
			return false
		}
	}
	return true
}

func requiredCommitField(fields map[string]json.RawMessage, key string) (Commit, error) {
	raw, ok := fields[key]
	if !ok {
		return Commit{}, fmt.Errorf("%s is required", key)
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return Commit{}, fmt.Errorf("%s is required", key)
	}

	var commit Commit
	if err := json.Unmarshal(raw, &commit); err != nil {
		return Commit{}, err
	}
	return commit, nil
}

func requiredRecordsField(fields map[string]json.RawMessage, key string) ([]RepoRecord, error) {
	records, err := requiredStoredRecordsField(fields, key)
	if err != nil {
		return nil, err
	}
	if len(records) == 0 {
		return nil, fmt.Errorf("%s must contain at least one record", key)
	}
	return records, nil
}

func requiredStoredRecordsField(fields map[string]json.RawMessage, key string) ([]RepoRecord, error) {
	raw, ok := fields[key]
	if !ok {
		return nil, fmt.Errorf("%s is required", key)
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, fmt.Errorf("%s must be an array", key)
	}

	var records []RepoRecord
	if err := json.Unmarshal(raw, &records); err != nil {
		return nil, fmt.Errorf("%s must be an array of repo records", key)
	}
	if records == nil {
		return nil, fmt.Errorf("%s must be an array", key)
	}
	return cloneRecords(records), nil
}

func requiredLogField(fields map[string]json.RawMessage, key string) ([]CommitLogEntry, error) {
	raw, ok := fields[key]
	if !ok {
		return nil, fmt.Errorf("%s is required", key)
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, fmt.Errorf("%s must be an array", key)
	}

	var log []CommitLogEntry
	if err := json.Unmarshal(raw, &log); err != nil {
		return nil, fmt.Errorf("%s must be an array of commit log entries", key)
	}
	if log == nil {
		return nil, fmt.Errorf("%s must be an array", key)
	}
	return cloneLog(log), nil
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

type recordKey struct {
	collection string
	rkey       string
}

func recordKeyFromRecord(record RepoRecord) recordKey {
	return recordKey{collection: record.Collection, rkey: record.RKey}
}

func recordKeyFromLog(entry CommitLogEntry) recordKey {
	return recordKey{collection: entry.Collection, rkey: entry.RKey}
}

func recordMap(records []RepoRecord) map[recordKey]RepoRecord {
	out := make(map[recordKey]RepoRecord, len(records))
	for _, record := range records {
		out[recordKeyFromRecord(record)] = record
	}
	return out
}

func logEntriesForRecords(cursor int64, records []RepoRecord) []CommitLogEntry {
	out := make([]CommitLogEntry, 0, len(records))
	for _, record := range records {
		out = append(out, CommitLogEntry{
			Cursor:     cursor,
			Op:         createRecordOp,
			Collection: record.Collection,
			RKey:       record.RKey,
		})
	}
	return out
}

func emptyReadResponse() ReadResponse {
	return ReadResponse{
		Exists:       false,
		Repo:         "",
		Records:      []RepoRecord{},
		CommitCursor: 0,
		Log:          []CommitLogEntry{},
	}
}

func readResponseFromState(state RepoState) ReadResponse {
	canonical := cloneRepoState(state)
	sortRepoState(&canonical)
	return ReadResponse{
		Exists:       true,
		Repo:         canonical.Repo,
		Records:      cloneRecords(canonical.Records),
		CommitCursor: canonical.CommitCursor,
		Log:          cloneLog(canonical.Log),
	}
}

func sortRepoState(state *RepoState) {
	sort.Slice(state.Records, func(i, j int) bool {
		left := state.Records[i]
		right := state.Records[j]
		if left.Collection != right.Collection {
			return left.Collection < right.Collection
		}
		return left.RKey < right.RKey
	})
}

func cloneDesiredState(state DesiredState) DesiredState {
	return DesiredState{
		Repo:    state.Repo,
		Commit:  Commit{Cursor: state.Commit.Cursor},
		Records: cloneRecords(state.Records),
	}
}

func cloneRepoState(state RepoState) RepoState {
	return RepoState{
		Repo:         state.Repo,
		Records:      cloneRecords(state.Records),
		CommitCursor: state.CommitCursor,
		Log:          cloneLog(state.Log),
	}
}

func cloneRecord(record RepoRecord) RepoRecord {
	return RepoRecord{
		Collection:  record.Collection,
		RKey:        record.RKey,
		ValueDigest: record.ValueDigest,
	}
}

func cloneRecords(in []RepoRecord) []RepoRecord {
	if in == nil {
		return nil
	}
	out := make([]RepoRecord, len(in))
	for i, record := range in {
		out[i] = cloneRecord(record)
	}
	return out
}

func cloneLog(in []CommitLogEntry) []CommitLogEntry {
	if in == nil {
		return nil
	}
	out := make([]CommitLogEntry, len(in))
	copy(out, in)
	return out
}

func cloneSnapshot(snapshot repoSnapshot) repoSnapshot {
	return repoSnapshot{
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
