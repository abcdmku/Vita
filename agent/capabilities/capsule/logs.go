package capsule

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/vita/agent/capabilities"
)

// LogsName is the read-only capability that tails a capsule's per-transient-unit
// journald log. It is the one agentd surface the deploy/management console needs
// that did not previously exist (CONTROL-PLANE.md "Logs endpoint"): the console
// reaches it through the api_origin /control/apps/:id/logs bridge, which the
// on-device host-proxy forwards to agentd over the unix socket. It is owner-gated
// by the same SO_PEERCRED auth as the rest of agentd (no extra auth here — the
// transport already authenticated the peer before dispatch).
//
// It is a READ capability only: it never registers an Apply, so it is not a
// transaction operation. The transport routes GET /read/capsule.logs?id=&limit=
// to it with the query parameters folded into a LogsReadRequest (mirroring the
// pdsrepo query-read special case).
const LogsName = "capsule.logs"

const (
	journalctlPath = "/usr/bin/journalctl"

	// logsDefaultLimit is the number of journal lines returned when the caller
	// omits limit. logsMaxLimit bounds the tail so a huge journal cannot blow the
	// response (the api_origin bridge clamps to the same ceiling).
	logsDefaultLimit = 200
	logsMaxLimit     = 1000
)

// LogLevel is the syslog-ish level the console consumes. It mirrors the TS
// LogLine.level union ("info" | "warn" | "error").
type LogLevel string

const (
	LogLevelInfo  LogLevel = "info"
	LogLevelWarn  LogLevel = "warn"
	LogLevelError LogLevel = "error"
)

// LogLine is one journal entry projected to the browser-friendly shape the
// console renders (matches the TS LogLine in control-plane.ts).
type LogLine struct {
	// TS is an RFC3339/ISO-8601 UTC timestamp.
	TS string `json:"ts"`
	// Level is the syslog priority folded to info/warn/error.
	Level LogLevel `json:"level"`
	// Message is the journal MESSAGE field.
	Message string `json:"message"`
}

// LogsReadRequest is the typed read request for a capsule's journal tail. The
// transport builds it from the GET /read/capsule.logs query parameters; it is
// never an /apply operation (read-only).
type LogsReadRequest struct {
	ID    string
	Limit int
}

func (LogsReadRequest) CapabilityRequest() {}

// Validate enforces a non-empty id and a bounded, non-negative limit. A zero or
// absent limit is normalized to the default by the transport before Handle, but
// Validate stays defensive so a direct caller cannot request an unbounded tail.
func (r LogsReadRequest) Validate() error {
	if strings.TrimSpace(r.ID) == "" {
		return &LogsInvalidRequestError{Reason: "id is required"}
	}
	if r.Limit < 0 {
		return &LogsInvalidRequestError{Reason: "limit must be non-negative"}
	}
	if r.Limit > logsMaxLimit {
		return &LogsInvalidRequestError{Reason: fmt.Sprintf("limit must be <= %d", logsMaxLimit)}
	}
	return nil
}

// LogsReadResponse carries the tail. The transport serializes it as
// { "lines": [ ... ] } — the shape createAgentHttpControlPlane.logs() parses.
type LogsReadResponse struct {
	Lines []LogLine `json:"lines"`
}

func (LogsReadResponse) CapabilityResponse() {}

type LogsInvalidRequestError struct {
	Reason string
}

func (e *LogsInvalidRequestError) Error() string {
	return fmt.Sprintf("invalid capsule logs request: %s", e.Reason)
}

// JournalReader tails a transient unit's journal. Abstracted so the capability is
// unit-testable without a live journald (the systemd-backed impl shells out to
// journalctl; tests inject a fake). Exported so the transport package's routing
// tests can build a LogsCapability over a fake reader.
type JournalReader interface {
	// Tail returns up to limit most-recent raw journald JSON lines for unit
	// (journalctl -u <unit> -n <limit> -o json --no-pager, oldest-first). An empty
	// result is NOT an error (a unit that never ran has no journal).
	Tail(ctx context.Context, unit string, limit int) ([]string, error)
}

// LogsCapability is the read-only capsule journal tail.
type LogsCapability struct {
	reader JournalReader
}

// NewLogsCapability builds the production capability backed by journalctl.
func NewLogsCapability() *LogsCapability {
	return &LogsCapability{reader: journalctlReader{journalctl: journalctlPath}}
}

// NewLogsCapabilityWithReader builds the capability over an injected JournalReader.
// The production path uses NewLogsCapability (journalctl); this seam lets a caller
// (or a routing test) supply an alternate journal source without a live journald.
func NewLogsCapabilityWithReader(reader JournalReader) *LogsCapability {
	return &LogsCapability{reader: reader}
}

func newLogsCapability(reader JournalReader) *LogsCapability {
	return &LogsCapability{reader: reader}
}

func (c *LogsCapability) Name() string {
	return LogsName
}

func (c *LogsCapability) Handle(ctx context.Context, req capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	read, ok := req.(LogsReadRequest)
	if !ok {
		return nil, &LogsInvalidRequestError{Reason: "expected capsule.LogsReadRequest"}
	}
	if c == nil || c.reader == nil {
		return nil, &LogsInvalidRequestError{Reason: "missing capsule logs reader"}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	// The bare read (no id) is the /state projection path: capsule.logs is a
	// query-parameterized read (the real request carries id+limit from the query
	// string, built in the transport). With no id there is no capsule to tail, so
	// return an empty tail rather than an invalid-request error — that keeps the
	// /state response clean (no synthetic error entry) while the real
	// GET /read/capsule.logs?id= path still validates a present id below.
	if strings.TrimSpace(read.ID) == "" {
		return LogsReadResponse{Lines: []LogLine{}}, nil
	}

	// Normalize the limit: 0/absent -> default, over-max -> clamped. A direct
	// caller that passes a NEGATIVE limit is still rejected (the transport rejects
	// it too); 0 is the "unset" sentinel the query path uses when limit is omitted.
	if read.Limit < 0 {
		return nil, &LogsInvalidRequestError{Reason: "limit must be non-negative"}
	}
	limit := read.Limit
	if limit == 0 {
		limit = logsDefaultLimit
	}
	if limit > logsMaxLimit {
		limit = logsMaxLimit
	}

	unit := capsuleUnitName(read.ID)

	raw, err := c.reader.Tail(ctx, unit, limit)
	if err != nil {
		return nil, fmt.Errorf("tail capsule journal %s: %w", unit, err)
	}

	lines := make([]LogLine, 0, len(raw))
	for _, entry := range raw {
		line, ok := parseJournalLine(entry)
		if !ok {
			continue
		}
		lines = append(lines, line)
	}

	return LogsReadResponse{Lines: lines}, nil
}

// journalEntry is the subset of journalctl -o json fields we project. All values
// are strings in journald's JSON export (numeric fields included).
type journalEntry struct {
	RealtimeTimestamp string `json:"__REALTIME_TIMESTAMP"`
	Priority          string `json:"PRIORITY"`
	Message           string `json:"MESSAGE"`
}

// parseJournalLine folds one journald JSON record into a LogLine. A record with no
// MESSAGE (or unparseable JSON) is skipped (ok=false) rather than surfaced as a
// blank line.
func parseJournalLine(raw string) (LogLine, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return LogLine{}, false
	}

	var entry journalEntry
	if err := json.Unmarshal([]byte(trimmed), &entry); err != nil {
		return LogLine{}, false
	}

	message := entry.Message
	if message == "" {
		return LogLine{}, false
	}

	return LogLine{
		TS:      journalTimestamp(entry.RealtimeTimestamp),
		Level:   journalLevel(entry.Priority),
		Message: message,
	}, true
}

// journalTimestamp converts journald's __REALTIME_TIMESTAMP (microseconds since
// the unix epoch, as a string) to an RFC3339 UTC string. An absent/unparseable
// timestamp yields the unix epoch in UTC (so the field is always well-formed).
func journalTimestamp(micros string) string {
	parsed, err := strconv.ParseInt(strings.TrimSpace(micros), 10, 64)
	if err != nil {
		return time.Unix(0, 0).UTC().Format(time.RFC3339)
	}
	return time.UnixMicro(parsed).UTC().Format(time.RFC3339)
}

// journalLevel folds a syslog priority (0..7) to the console's info/warn/error
// triad: 0..3 (emerg..err) -> error, 4 (warning) -> warn, else info. An
// absent/unparseable priority is treated as info.
func journalLevel(priority string) LogLevel {
	parsed, err := strconv.Atoi(strings.TrimSpace(priority))
	if err != nil {
		return LogLevelInfo
	}
	switch {
	case parsed <= 3:
		return LogLevelError
	case parsed == 4:
		return LogLevelWarn
	default:
		return LogLevelInfo
	}
}

// journalctlReader is the production journalReader: it shells out to journalctl
// scoped to one transient unit, JSON output, bounded tail, no pager.
type journalctlReader struct {
	journalctl string
}

func (r journalctlReader) Tail(ctx context.Context, unit string, limit int) ([]string, error) {
	if limit <= 0 {
		limit = logsDefaultLimit
	}
	args := []string{
		"--unit", unit,
		"--lines", strconv.Itoa(limit),
		"--output", "json",
		"--no-pager",
	}

	output, err := exec.CommandContext(ctx, r.journalctl, args...).Output()
	if err != nil {
		// A unit that never ran has no journal: journalctl exits non-zero with a
		// "no entries"/"Failed to ..." message on stderr. Treat the no-entries case
		// as an empty tail (the console renders "no logs yet"), not a hard error.
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && journalctlNoEntries(string(exitErr.Stderr)) {
			return nil, nil
		}
		return nil, fmt.Errorf("run journalctl: %w", err)
	}

	lines := make([]string, 0, limit)
	for _, line := range strings.Split(string(output), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		lines = append(lines, line)
	}
	return lines, nil
}

func journalctlNoEntries(stderr string) bool {
	lowered := strings.ToLower(stderr)
	return strings.Contains(lowered, "no entries") || strings.Contains(lowered, "failed to")
}
