package capsule

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

// fakeJournalReader records the (unit, limit) it was asked for and returns a
// canned set of raw journald JSON lines (or an error), so the capability is
// exercised without a live journald.
type fakeJournalReader struct {
	lines    []string
	err      error
	lastUnit string
	lastN    int
	calls    int
}

func (f *fakeJournalReader) Tail(_ context.Context, unit string, limit int) ([]string, error) {
	f.calls++
	f.lastUnit = unit
	f.lastN = limit
	if f.err != nil {
		return nil, f.err
	}
	return f.lines, nil
}

func TestLogsHandleProjectsJournalEntries(t *testing.T) {
	reader := &fakeJournalReader{lines: []string{
		`{"__REALTIME_TIMESTAMP":"1718000000000000","PRIORITY":"6","MESSAGE":"capsule started"}`,
		`{"__REALTIME_TIMESTAMP":"1718000001000000","PRIORITY":"4","MESSAGE":"slow health check"}`,
		`{"__REALTIME_TIMESTAMP":"1718000002000000","PRIORITY":"3","MESSAGE":"unit failed"}`,
	}}
	capability := newLogsCapability(reader)

	resp, err := capability.Handle(context.Background(), LogsReadRequest{ID: "dev.vita.notes", Limit: 50})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	logs, ok := resp.(LogsReadResponse)
	if !ok {
		t.Fatalf("expected LogsReadResponse, got %T", resp)
	}
	if len(logs.Lines) != 3 {
		t.Fatalf("expected 3 lines, got %d", len(logs.Lines))
	}

	if got, want := logs.Lines[0].Level, LogLevelInfo; got != want {
		t.Errorf("line 0 level = %q, want %q", got, want)
	}
	if got, want := logs.Lines[1].Level, LogLevelWarn; got != want {
		t.Errorf("line 1 level = %q, want %q", got, want)
	}
	if got, want := logs.Lines[2].Level, LogLevelError; got != want {
		t.Errorf("line 2 level = %q, want %q", got, want)
	}
	if got, want := logs.Lines[0].Message, "capsule started"; got != want {
		t.Errorf("line 0 message = %q, want %q", got, want)
	}
	if got, want := logs.Lines[0].TS, "2024-06-10T06:13:20Z"; got != want {
		t.Errorf("line 0 ts = %q, want %q", got, want)
	}
}

func TestLogsHandleDerivesUnitFromCapsuleID(t *testing.T) {
	reader := &fakeJournalReader{}
	capability := newLogsCapability(reader)

	id := "dev.vita.notes"
	if _, err := capability.Handle(context.Background(), LogsReadRequest{ID: id, Limit: 10}); err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	if got, want := reader.lastUnit, capsuleUnitName(id); got != want {
		t.Errorf("tailed unit = %q, want %q (capsuleUnitName)", got, want)
	}
	if reader.lastN != 10 {
		t.Errorf("tailed limit = %d, want 10", reader.lastN)
	}
}

func TestLogsHandleDefaultsAndClampsLimit(t *testing.T) {
	cases := []struct {
		name  string
		limit int
		want  int
	}{
		{name: "zero defaults", limit: 0, want: logsDefaultLimit},
		{name: "over max clamps", limit: 999999, want: logsMaxLimit},
		{name: "in range kept", limit: 25, want: 25},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reader := &fakeJournalReader{}
			capability := newLogsCapability(reader)
			if _, err := capability.Handle(context.Background(), LogsReadRequest{ID: "x", Limit: tc.limit}); err != nil {
				t.Fatalf("Handle returned error: %v", err)
			}
			if reader.lastN != tc.want {
				t.Errorf("tailed limit = %d, want %d", reader.lastN, tc.want)
			}
		})
	}
}

func TestLogsHandleRejectsNegativeLimit(t *testing.T) {
	reader := &fakeJournalReader{}
	capability := newLogsCapability(reader)
	if _, err := capability.Handle(context.Background(), LogsReadRequest{ID: "x", Limit: -5}); err == nil {
		t.Fatal("negative limit accepted, want rejected")
	}
	if reader.calls != 0 {
		t.Errorf("rejected request still tailed the journal %d times, want 0", reader.calls)
	}
}

func TestLogsHandleBareReadReturnsEmpty(t *testing.T) {
	reader := &fakeJournalReader{lines: []string{`{"MESSAGE":"should not be read"}`}}
	capability := newLogsCapability(reader)

	// The /state projection path: a bare read with no id must NOT tail anything and
	// must return an empty tail (not an error).
	resp, err := capability.Handle(context.Background(), LogsReadRequest{})
	if err != nil {
		t.Fatalf("bare read returned error: %v", err)
	}
	logs, ok := resp.(LogsReadResponse)
	if !ok {
		t.Fatalf("expected LogsReadResponse, got %T", resp)
	}
	if len(logs.Lines) != 0 {
		t.Errorf("bare read returned %d lines, want 0", len(logs.Lines))
	}
	if reader.calls != 0 {
		t.Errorf("bare read tailed the journal %d times, want 0", reader.calls)
	}
}

func TestLogsHandleSkipsUnparseableAndEmptyMessageLines(t *testing.T) {
	reader := &fakeJournalReader{lines: []string{
		`not json`,
		`{"__REALTIME_TIMESTAMP":"1718000000000000","PRIORITY":"6"}`, // no MESSAGE
		`{"__REALTIME_TIMESTAMP":"1718000000000000","PRIORITY":"6","MESSAGE":"kept"}`,
		``,
	}}
	capability := newLogsCapability(reader)

	resp, err := capability.Handle(context.Background(), LogsReadRequest{ID: "x", Limit: 10})
	if err != nil {
		t.Fatalf("Handle returned error: %v", err)
	}
	logs := resp.(LogsReadResponse)
	if len(logs.Lines) != 1 {
		t.Fatalf("expected 1 kept line, got %d", len(logs.Lines))
	}
	if logs.Lines[0].Message != "kept" {
		t.Errorf("kept message = %q, want %q", logs.Lines[0].Message, "kept")
	}
}

func TestLogsHandlePropagatesReaderError(t *testing.T) {
	wantErr := errors.New("journalctl exploded")
	reader := &fakeJournalReader{err: wantErr}
	capability := newLogsCapability(reader)

	_, err := capability.Handle(context.Background(), LogsReadRequest{ID: "x", Limit: 10})
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !errors.Is(err, wantErr) {
		t.Errorf("error %v does not wrap %v", err, wantErr)
	}
}

func TestLogsReadRequestValidate(t *testing.T) {
	if err := (LogsReadRequest{ID: "x", Limit: 10}).Validate(); err != nil {
		t.Errorf("valid request rejected: %v", err)
	}
	if err := (LogsReadRequest{ID: "", Limit: 10}).Validate(); err == nil {
		t.Error("empty id accepted, want rejected")
	}
	if err := (LogsReadRequest{ID: "x", Limit: -1}).Validate(); err == nil {
		t.Error("negative limit accepted, want rejected")
	}
	if err := (LogsReadRequest{ID: "x", Limit: logsMaxLimit + 1}).Validate(); err == nil {
		t.Error("over-max limit accepted, want rejected")
	}
}

func TestParseJournalLineLevels(t *testing.T) {
	cases := map[string]LogLevel{
		"0": LogLevelError, // emerg
		"3": LogLevelError, // err
		"4": LogLevelWarn,  // warning
		"5": LogLevelInfo,  // notice
		"6": LogLevelInfo,  // info
		"7": LogLevelInfo,  // debug
		"":  LogLevelInfo,  // absent
		"x": LogLevelInfo,  // unparseable
	}
	for priority, want := range cases {
		if got := journalLevel(priority); got != want {
			t.Errorf("journalLevel(%q) = %q, want %q", priority, got, want)
		}
	}
}

func TestLogsCapabilityName(t *testing.T) {
	if got := NewLogsCapability().Name(); got != LogsName {
		t.Errorf("Name() = %q, want %q", got, LogsName)
	}
	if LogsName != "capsule.logs" {
		t.Errorf("LogsName = %q, want capsule.logs", LogsName)
	}
}

func TestLogsResponseShapeIsBrowserFriendly(t *testing.T) {
	// Guard the JSON tags the TS bridge parses: { lines: [ { ts, level, message } ] }.
	respType := reflect.TypeOf(LogsReadResponse{})
	field, _ := respType.FieldByName("Lines")
	if got := field.Tag.Get("json"); got != "lines" {
		t.Errorf("Lines json tag = %q, want lines", got)
	}
	lineType := reflect.TypeOf(LogLine{})
	for field, want := range map[string]string{"TS": "ts", "Level": "level", "Message": "message"} {
		f, _ := lineType.FieldByName(field)
		if got := f.Tag.Get("json"); got != want {
			t.Errorf("LogLine.%s json tag = %q, want %q", field, got, want)
		}
	}
}
