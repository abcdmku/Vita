package auditlog

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/vita/agent/internal/atomicfile"
)

type ActorKind string

const (
	ActorKindHuman  ActorKind = "human"
	ActorKindAgent  ActorKind = "agent"
	ActorKindSystem ActorKind = "system"
)

type Operation string

const (
	OperationApply Operation = "apply"
	OperationRead  Operation = "read"
)

type Outcome string

const (
	OutcomeCommitted  Outcome = "committed"
	OutcomeRejected   Outcome = "rejected"
	OutcomeRolledBack Outcome = "rolled_back"
	OutcomeFailed     Outcome = "failed"
)

const maxReasonLength = 512

var (
	ErrInvalidEvent = errors.New("auditlog: invalid event")
	ErrCorruptLog   = errors.New("auditlog: corrupt log")
	ErrLogFull      = errors.New("auditlog: log full; rotation required")

	dataURLPattern          = regexp.MustCompile(`(?i)\bdata:`)
	pemBlockPattern         = regexp.MustCompile(`(?i)-----BEGIN\b`)
	privateKeyPattern       = regexp.MustCompile(`(?i)\b(?:private[-_\s]?key|openssh\s+private\s+key|age-secret-key|xprv|seed[-_\s]?phrase|mnemonic|recovery[-_\s]?phrase)\b`)
	secretAssignmentPattern = regexp.MustCompile(`(?i)\b(?:private[-_\s]?key|api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|password|secret)\s*(?:=|:(?:[^/]|$))`)
	seedWordsPattern        = regexp.MustCompile(`(?i)\b[a-z]{3,12}(?:\s+[a-z]{3,12}){11,23}\b`)
	longHexPattern          = regexp.MustCompile(`(?:0x)?[A-Fa-f0-9]{32,}`)
	longBase64Pattern       = regexp.MustCompile(`[A-Za-z0-9+/]{48,}={0,2}|[A-Za-z0-9_-]{48,}`)
)

type Event struct {
	Sequence        uint64
	TimestampMillis int64
	ActorKind       ActorKind
	ActorID         string
	Capability      string
	Operation       Operation
	Outcome         Outcome
	Reason          string
}

// TempFile is the subset of *os.File the store needs to write a fresh,
// exclusively-created temp file before committing it with a rename.
type TempFile = atomicfile.TempFile

// FileSystem abstracts the filesystem operations the store performs. The
// atomic-write contract requires a fresh, exclusively-created temp file
// (O_CREATE|O_EXCL via CreateTemp) so a pre-planted symlink/hardlink at a
// predictable path can never be followed or clobbered before the commit
// point. A predictable WriteFile-to-fixed-temp path is deliberately absent.
type FileSystem interface {
	ReadFile(name string) ([]byte, error)
	MkdirAll(path string, perm fs.FileMode) error
	CreateTemp(dir, pattern string) (TempFile, error)
	Rename(oldPath, newPath string) error
	Remove(name string) error
	SyncDir(dir string) error
}

type OSFileSystem struct{}

func (OSFileSystem) ReadFile(name string) ([]byte, error) {
	return os.ReadFile(name)
}

func (OSFileSystem) MkdirAll(path string, perm fs.FileMode) error {
	return os.MkdirAll(path, perm)
}

func (OSFileSystem) CreateTemp(dir, pattern string) (TempFile, error) {
	return os.CreateTemp(dir, pattern)
}

func (OSFileSystem) Rename(oldPath, newPath string) error {
	return os.Rename(oldPath, newPath)
}

func (OSFileSystem) Remove(name string) error {
	return os.Remove(name)
}

func (OSFileSystem) SyncDir(dir string) error {
	return atomicfile.OSFileSystem{}.SyncDir(dir)
}

type Store struct {
	mu        sync.Mutex
	fs        FileSystem
	path      string
	maxEvents int
}

func NewStore(fileSystem FileSystem, path string, maxEvents int) (*Store, error) {
	if fileSystem == nil {
		return nil, errors.New("auditlog: nil filesystem")
	}
	if path == "" {
		return nil, errors.New("auditlog: empty path")
	}
	if maxEvents <= 0 {
		return nil, errors.New("auditlog: max events must be positive")
	}

	return &Store{
		fs:        fileSystem,
		path:      path,
		maxEvents: maxEvents,
	}, nil
}

func (s *Store) Append(e Event) (Event, error) {
	if s == nil {
		return Event{}, errors.New("auditlog: nil store")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	events, err := s.load()
	if err != nil {
		return Event{}, err
	}

	if len(events) >= s.maxEvents {
		return Event{}, &LogFullError{MaxEvents: s.maxEvents}
	}

	e.Sequence = uint64(len(events) + 1)
	if err := validateEvent(e); err != nil {
		return Event{}, err
	}

	next := make([]Event, 0, len(events)+1)
	next = append(next, events...)
	next = append(next, e)

	if err := s.persist(next); err != nil {
		return Event{}, err
	}

	return e, nil
}

func (s *Store) Read() ([]Event, error) {
	if s == nil {
		return nil, errors.New("auditlog: nil store")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	events, err := s.load()
	if err != nil {
		return nil, err
	}

	out := make([]Event, len(events))
	copy(out, events)
	return out, nil
}

type LogFullError struct {
	MaxEvents int
}

func (e *LogFullError) Error() string {
	return fmt.Sprintf("auditlog: log full; rotation required (maxEvents=%d)", e.MaxEvents)
}

func (e *LogFullError) Unwrap() error {
	return ErrLogFull
}

type InvalidEventError struct {
	Field  string
	Reason string
}

func (e *InvalidEventError) Error() string {
	if e.Field == "" {
		return fmt.Sprintf("auditlog: invalid event: %s", e.Reason)
	}
	return fmt.Sprintf("auditlog: invalid event field %q: %s", e.Field, e.Reason)
}

func (e *InvalidEventError) Unwrap() error {
	return ErrInvalidEvent
}

type CorruptLogError struct {
	Reason string
	Err    error
}

func (e *CorruptLogError) Error() string {
	if e.Err == nil {
		return fmt.Sprintf("auditlog: corrupt log: %s", e.Reason)
	}
	return fmt.Sprintf("auditlog: corrupt log: %s: %v", e.Reason, e.Err)
}

func (e *CorruptLogError) Unwrap() error {
	if e.Err == nil {
		return ErrCorruptLog
	}
	return errors.Join(ErrCorruptLog, e.Err)
}

func (s *Store) load() ([]Event, error) {
	data, err := s.fs.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []Event{}, nil
		}
		return nil, err
	}

	if err := rejectDuplicateJSONKeys(data); err != nil {
		return nil, &CorruptLogError{Reason: "duplicate or invalid JSON", Err: err}
	}

	var wireEvents []wireEvent
	if err := json.Unmarshal(data, &wireEvents); err != nil {
		return nil, &CorruptLogError{Reason: "decode", Err: err}
	}

	events := make([]Event, 0, len(wireEvents))
	for index, wire := range wireEvents {
		event := eventFromWire(wire)
		if err := validateEvent(event); err != nil {
			return nil, &CorruptLogError{Reason: fmt.Sprintf("event %d validation", index), Err: err}
		}

		wantSequence := uint64(index + 1)
		if event.Sequence != wantSequence {
			return nil, &CorruptLogError{Reason: fmt.Sprintf("event %d sequence %d, want %d", index, event.Sequence, wantSequence)}
		}

		events = append(events, event)
	}

	canonical, err := canonicalBytes(events)
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(data, canonical) {
		return nil, &CorruptLogError{Reason: "non-canonical bytes"}
	}

	return events, nil
}

// persist writes the canonical log atomically. It uses a fresh,
// exclusively-created temp file (O_CREATE|O_EXCL via CreateTemp) in the log's
// own directory so a pre-planted symlink/hardlink at a predictable path can
// never be followed or clobbered. The Rename is the single commit point, and
// the parent directory is fsynced afterward so the commit survives power loss.
// On any pre-commit error the temp is removed (best-effort) and the live log is
// left byte-identical to before.
func (s *Store) persist(events []Event) error {
	data, err := canonicalBytes(events)
	if err != nil {
		return err
	}

	targetDir := filepath.Dir(s.path)
	if err := s.fs.MkdirAll(targetDir, 0o700); err != nil {
		return err
	}

	return atomicfile.WriteWithPattern(s.fs, s.path, data, 0o600, ".auditlog-*.tmp")
}

type wireActor struct {
	Kind ActorKind `json:"kind"`
	ID   string    `json:"id"`
}

type wireEvent struct {
	Sequence        uint64    `json:"sequence"`
	TimestampMillis int64     `json:"timestampMillis"`
	Actor           wireActor `json:"actor"`
	Capability      string    `json:"capability"`
	Operation       Operation `json:"operation"`
	Outcome         Outcome   `json:"outcome"`
	Reason          string    `json:"reason,omitempty"`
}

func eventFromWire(wire wireEvent) Event {
	return Event{
		Sequence:        wire.Sequence,
		TimestampMillis: wire.TimestampMillis,
		ActorKind:       wire.Actor.Kind,
		ActorID:         wire.Actor.ID,
		Capability:      wire.Capability,
		Operation:       wire.Operation,
		Outcome:         wire.Outcome,
		Reason:          wire.Reason,
	}
}

func wireFromEvent(event Event) wireEvent {
	return wireEvent{
		Sequence:        event.Sequence,
		TimestampMillis: event.TimestampMillis,
		Actor: wireActor{
			Kind: event.ActorKind,
			ID:   event.ActorID,
		},
		Capability: event.Capability,
		Operation:  event.Operation,
		Outcome:    event.Outcome,
		Reason:     event.Reason,
	}
}

func canonicalBytes(events []Event) ([]byte, error) {
	wireEvents := make([]wireEvent, 0, len(events))
	for _, event := range events {
		wireEvents = append(wireEvents, wireFromEvent(event))
	}

	return json.Marshal(wireEvents)
}

func validateEvent(event Event) error {
	if event.Sequence == 0 {
		return &InvalidEventError{Field: "sequence", Reason: "must be positive"}
	}
	if event.TimestampMillis < 0 {
		return &InvalidEventError{Field: "timestampMillis", Reason: "must be non-negative"}
	}
	if !validActorKind(event.ActorKind) {
		return &InvalidEventError{Field: "actor.kind", Reason: "must be human, agent, or system"}
	}
	if event.ActorID == "" || event.ActorID != strings.TrimSpace(event.ActorID) {
		return &InvalidEventError{Field: "actor.id", Reason: "must be non-empty"}
	}
	if containsInlineKeyMaterial(event.ActorID) {
		return &InvalidEventError{Field: "actor.id", Reason: "inline key material is not allowed"}
	}
	if !validCapabilityName(event.Capability) {
		return &InvalidEventError{Field: "capability", Reason: "must be a well-formed capability name"}
	}
	if !validOperation(event.Operation) {
		return &InvalidEventError{Field: "operation", Reason: "must be apply or read"}
	}
	if !validOutcome(event.Outcome) {
		return &InvalidEventError{Field: "outcome", Reason: "must be committed, rejected, rolled_back, or failed"}
	}
	if len(event.Reason) > maxReasonLength {
		return &InvalidEventError{Field: "reason", Reason: "must be at most 512 bytes"}
	}
	if event.Reason != "" && containsInlineKeyMaterial(event.Reason) {
		return &InvalidEventError{Field: "reason", Reason: "inline key material is not allowed"}
	}

	return nil
}

func validActorKind(value ActorKind) bool {
	return value == ActorKindHuman || value == ActorKindAgent || value == ActorKindSystem
}

func validOperation(value Operation) bool {
	return value == OperationApply || value == OperationRead
}

func validOutcome(value Outcome) bool {
	return value == OutcomeCommitted || value == OutcomeRejected || value == OutcomeRolledBack || value == OutcomeFailed
}

func validCapabilityName(value string) bool {
	if value == "" || len(value) > 128 || value != strings.TrimSpace(value) || containsInlineKeyMaterial(value) {
		return false
	}

	runes := []rune(value)
	if !isASCIIAlnum(runes[0]) {
		return false
	}

	for index, r := range runes {
		if isASCIIAlnum(r) {
			continue
		}
		if !isCapabilitySeparator(r) {
			return false
		}
		next := index + 1
		if next >= len(runes) || !isASCIIAlnum(runes[next]) {
			return false
		}
	}

	return true
}

func isASCIIAlnum(r rune) bool {
	return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
}

func isCapabilitySeparator(r rune) bool {
	return r == '.' || r == '_' || r == ':' || r == '@' || r == '-'
}

func containsInlineKeyMaterial(value string) bool {
	if !utf8.ValidString(value) || containsControlCharacter(value) {
		return true
	}
	if dataURLPattern.MatchString(value) ||
		pemBlockPattern.MatchString(value) ||
		privateKeyPattern.MatchString(value) ||
		secretAssignmentPattern.MatchString(value) ||
		seedWordsPattern.MatchString(value) {
		return true
	}

	return longHexPattern.MatchString(value) || longBase64Pattern.MatchString(value)
}

func containsControlCharacter(value string) bool {
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

func rejectDuplicateJSONKeys(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()

	if err := scanJSONValue(decoder); err != nil {
		return err
	}

	token, err := decoder.Token()
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err != nil {
		return err
	}
	return fmt.Errorf("unexpected trailing JSON token %v", token)
}

func scanJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}

	delim, ok := token.(json.Delim)
	if !ok {
		return nil
	}

	switch delim {
	case '{':
		seen := map[string]struct{}{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return fmt.Errorf("object key is %T, want string", keyToken)
			}
			if _, exists := seen[key]; exists {
				return fmt.Errorf("duplicate JSON object key %q", key)
			}
			seen[key] = struct{}{}

			if err := scanJSONValue(decoder); err != nil {
				return err
			}
		}

		return expectDelim(decoder, '}')
	case '[':
		for decoder.More() {
			if err := scanJSONValue(decoder); err != nil {
				return err
			}
		}

		return expectDelim(decoder, ']')
	default:
		return fmt.Errorf("unexpected JSON delimiter %q", delim)
	}
}

func expectDelim(decoder *json.Decoder, want json.Delim) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}

	got, ok := token.(json.Delim)
	if !ok || got != want {
		return fmt.Errorf("JSON delimiter %v, want %q", token, want)
	}
	return nil
}
