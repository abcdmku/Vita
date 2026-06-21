package auditlog

import (
	"errors"
	"io/fs"
	"reflect"
	"sync"
	"testing"
)

const testLogPath = "/audit/log.json"

func TestAppendAssignsMonotonicSequencesAndPersistsCanonicalLog(t *testing.T) {
	fileSystem := newMemoryFS()
	store := mustStore(t, fileSystem, 10)

	first, err := store.Append(Event{
		Sequence:        99,
		TimestampMillis: 1717171717000,
		ActorKind:       ActorKindAgent,
		ActorID:         "agent:planner",
		Capability:      "system.hostname",
		Operation:       OperationApply,
		Outcome:         OutcomeCommitted,
		Reason:          "hostname applied",
	})
	if err != nil {
		t.Fatalf("Append returned error: %v", err)
	}
	if first.Sequence != 1 {
		t.Fatalf("first Sequence = %d, want store-assigned 1", first.Sequence)
	}

	second, err := store.Append(validEvent())
	if err != nil {
		t.Fatalf("Append returned error: %v", err)
	}
	third, err := store.Append(validEvent())
	if err != nil {
		t.Fatalf("Append returned error: %v", err)
	}

	if second.Sequence != 2 || third.Sequence != 3 {
		t.Fatalf("assigned sequences = %d, %d, want 2, 3", second.Sequence, third.Sequence)
	}

	events, err := store.Read()
	if err != nil {
		t.Fatalf("Read returned error: %v", err)
	}
	if len(events) != 3 {
		t.Fatalf("Read returned %d events, want 3", len(events))
	}
	for index, event := range events {
		wantSequence := uint64(index + 1)
		if event.Sequence != wantSequence {
			t.Fatalf("events[%d].Sequence = %d, want %d", index, event.Sequence, wantSequence)
		}
	}

	wantRaw := `[{"sequence":1,"timestampMillis":1717171717000,"actor":{"kind":"agent","id":"agent:planner"},"capability":"system.hostname","operation":"apply","outcome":"committed","reason":"hostname applied"},{"sequence":2,"timestampMillis":1717171717000,"actor":{"kind":"agent","id":"agent:planner"},"capability":"system.hostname","operation":"apply","outcome":"committed","reason":"hostname applied"},{"sequence":3,"timestampMillis":1717171717000,"actor":{"kind":"agent","id":"agent:planner"},"capability":"system.hostname","operation":"apply","outcome":"committed","reason":"hostname applied"}]`
	if gotRaw := string(fileSystem.mustRead(t, testLogPath)); gotRaw != wantRaw {
		t.Fatalf("persisted bytes = %s, want %s", gotRaw, wantRaw)
	}
}

func TestAppendRejectsInvalidEventWithoutWriting(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Event)
	}{
		{
			name: "bad actor kind",
			mutate: func(event *Event) {
				event.ActorKind = "service"
			},
		},
		{
			name: "negative timestamp",
			mutate: func(event *Event) {
				event.TimestampMillis = -1
			},
		},
		{
			name: "empty actor id",
			mutate: func(event *Event) {
				event.ActorID = ""
			},
		},
		{
			name: "bad operation",
			mutate: func(event *Event) {
				event.Operation = "delete"
			},
		},
		{
			name: "bad outcome",
			mutate: func(event *Event) {
				event.Outcome = "succeeded"
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fileSystem := newMemoryFS()
			store := mustStore(t, fileSystem, 10)
			if _, err := store.Append(validEvent()); err != nil {
				t.Fatalf("initial Append returned error: %v", err)
			}
			before := fileSystem.mustRead(t, testLogPath)

			event := validEvent()
			tt.mutate(&event)
			if _, err := store.Append(event); !errors.Is(err, ErrInvalidEvent) {
				t.Fatalf("Append error = %v, want ErrInvalidEvent", err)
			}

			after := fileSystem.mustRead(t, testLogPath)
			if !reflect.DeepEqual(after, before) {
				t.Fatalf("log changed after invalid append: got %s, want %s", string(after), string(before))
			}
		})
	}
}

func TestAppendRejectsInlineKeyMaterialWithoutWriting(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Event)
	}{
		{
			name: "data URL reason",
			mutate: func(event *Event) {
				event.Reason = "data:text/plain;base64,cmVkYWN0ZWQ="
			},
		},
		{
			name: "PEM reason",
			mutate: func(event *Event) {
				event.Reason = "-----BEGIN PRIVATE KEY----- redacted -----END PRIVATE KEY-----"
			},
		},
		{
			name: "long base64 actor",
			mutate: func(event *Event) {
				event.ActorID = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fileSystem := newMemoryFS()
			store := mustStore(t, fileSystem, 10)
			if _, err := store.Append(validEvent()); err != nil {
				t.Fatalf("initial Append returned error: %v", err)
			}
			before := fileSystem.mustRead(t, testLogPath)

			event := validEvent()
			tt.mutate(&event)
			if _, err := store.Append(event); !errors.Is(err, ErrInvalidEvent) {
				t.Fatalf("Append error = %v, want ErrInvalidEvent", err)
			}

			after := fileSystem.mustRead(t, testLogPath)
			if !reflect.DeepEqual(after, before) {
				t.Fatalf("log changed after rejected key material: got %s, want %s", string(after), string(before))
			}
		})
	}
}

func TestAppendFailsClosedWhenLogFull(t *testing.T) {
	fileSystem := newMemoryFS()
	store := mustStore(t, fileSystem, 2)

	if _, err := store.Append(validEvent()); err != nil {
		t.Fatalf("first Append returned error: %v", err)
	}
	if _, err := store.Append(validEvent()); err != nil {
		t.Fatalf("second Append returned error: %v", err)
	}
	before := fileSystem.mustRead(t, testLogPath)

	_, err := store.Append(validEvent())
	if !errors.Is(err, ErrLogFull) {
		t.Fatalf("Append error = %v, want ErrLogFull", err)
	}
	var full *LogFullError
	if !errors.As(err, &full) {
		t.Fatalf("Append error = %T, want LogFullError", err)
	}
	if full.MaxEvents != 2 {
		t.Fatalf("LogFullError.MaxEvents = %d, want 2", full.MaxEvents)
	}

	after := fileSystem.mustRead(t, testLogPath)
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("full log changed: got %s, want %s", string(after), string(before))
	}
}

func TestAtomicRenameFailureLeavesLiveLogUnchanged(t *testing.T) {
	fileSystem := newMemoryFS()
	store := mustStore(t, fileSystem, 10)

	if _, err := store.Append(validEvent()); err != nil {
		t.Fatalf("initial Append returned error: %v", err)
	}
	before := fileSystem.mustRead(t, testLogPath)

	renameErr := errors.New("rename failed")
	fileSystem.failNextRename(renameErr)
	if _, err := store.Append(validEvent()); !errors.Is(err, renameErr) {
		t.Fatalf("Append error = %v, want renameErr", err)
	}

	after := fileSystem.mustRead(t, testLogPath)
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("log changed after failed rename: got %s, want %s", string(after), string(before))
	}

	stored, err := store.Append(validEvent())
	if err != nil {
		t.Fatalf("Append after failed rename returned error: %v", err)
	}
	if stored.Sequence != 2 {
		t.Fatalf("stored Sequence = %d, want 2", stored.Sequence)
	}
}

func TestLoadRejectsCorruptLogsFailClosed(t *testing.T) {
	canonical := `[{"sequence":1,"timestampMillis":1717171717000,"actor":{"kind":"agent","id":"agent:planner"},"capability":"system.hostname","operation":"apply","outcome":"committed","reason":"hostname applied"}]`
	tests := []struct {
		name string
		raw  string
	}{
		{
			name: "non monotonic",
			raw:  `[{"sequence":1,"timestampMillis":1717171717000,"actor":{"kind":"agent","id":"agent:planner"},"capability":"system.hostname","operation":"apply","outcome":"committed"},{"sequence":1,"timestampMillis":1717171717000,"actor":{"kind":"agent","id":"agent:planner"},"capability":"system.hostname","operation":"apply","outcome":"committed"}]`,
		},
		{
			name: "duplicate key",
			raw:  `[{"sequence":1,"sequence":1,"timestampMillis":1717171717000,"actor":{"kind":"agent","id":"agent:planner"},"capability":"system.hostname","operation":"apply","outcome":"committed"}]`,
		},
		{
			name: "non canonical whitespace",
			raw:  canonical + "\n",
		},
		{
			name: "non canonical field order",
			raw:  `[{"timestampMillis":1717171717000,"sequence":1,"actor":{"kind":"agent","id":"agent:planner"},"capability":"system.hostname","operation":"apply","outcome":"committed"}]`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fileSystem := newMemoryFS()
			fileSystem.writeRaw(testLogPath, []byte(tt.raw))
			store := mustStore(t, fileSystem, 10)
			before := fileSystem.mustRead(t, testLogPath)

			if _, err := store.Read(); !errors.Is(err, ErrCorruptLog) {
				t.Fatalf("Read error = %v, want ErrCorruptLog", err)
			}
			if _, err := store.Append(validEvent()); !errors.Is(err, ErrCorruptLog) {
				t.Fatalf("Append error = %v, want ErrCorruptLog", err)
			}

			after := fileSystem.mustRead(t, testLogPath)
			if !reflect.DeepEqual(after, before) {
				t.Fatalf("corrupt log changed: got %s, want %s", string(after), string(before))
			}
		})
	}
}

func TestConcurrentAppendsSerializeSequences(t *testing.T) {
	const goroutines = 64

	fileSystem := newMemoryFS()
	store := mustStore(t, fileSystem, goroutines)
	start := make(chan struct{})
	errs := make(chan error, goroutines)

	var wg sync.WaitGroup
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := store.Append(validEvent())
			errs <- err
		}()
	}

	close(start)
	wg.Wait()
	close(errs)

	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent Append returned error: %v", err)
		}
	}

	events, err := store.Read()
	if err != nil {
		t.Fatalf("Read returned error: %v", err)
	}
	if len(events) != goroutines {
		t.Fatalf("Read returned %d events, want %d", len(events), goroutines)
	}

	seen := make(map[uint64]struct{}, goroutines)
	for index, event := range events {
		wantSequence := uint64(index + 1)
		if event.Sequence != wantSequence {
			t.Fatalf("events[%d].Sequence = %d, want %d", index, event.Sequence, wantSequence)
		}
		if _, exists := seen[event.Sequence]; exists {
			t.Fatalf("duplicate sequence %d", event.Sequence)
		}
		seen[event.Sequence] = struct{}{}
	}
}

func mustStore(t *testing.T, fileSystem FileSystem, maxEvents int) *Store {
	t.Helper()

	store, err := NewStore(fileSystem, testLogPath, maxEvents)
	if err != nil {
		t.Fatalf("NewStore returned error: %v", err)
	}
	return store
}

func validEvent() Event {
	return Event{
		TimestampMillis: 1717171717000,
		ActorKind:       ActorKindAgent,
		ActorID:         "agent:planner",
		Capability:      "system.hostname",
		Operation:       OperationApply,
		Outcome:         OutcomeCommitted,
		Reason:          "hostname applied",
	}
}

type memoryFS struct {
	mu        sync.Mutex
	files     map[string][]byte
	writeErr  error
	renameErr error
}

func newMemoryFS() *memoryFS {
	return &memoryFS{files: map[string][]byte{}}
}

func (m *memoryFS) ReadFile(name string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	data, ok := m.files[name]
	if !ok {
		return nil, &fs.PathError{Op: "read", Path: name, Err: fs.ErrNotExist}
	}

	out := make([]byte, len(data))
	copy(out, data)
	return out, nil
}

func (m *memoryFS) WriteFile(name string, data []byte, _ fs.FileMode) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.writeErr != nil {
		err := m.writeErr
		m.writeErr = nil
		return err
	}

	out := make([]byte, len(data))
	copy(out, data)
	m.files[name] = out
	return nil
}

func (m *memoryFS) Rename(oldPath, newPath string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.renameErr != nil {
		err := m.renameErr
		m.renameErr = nil
		return err
	}

	data, ok := m.files[oldPath]
	if !ok {
		return &fs.PathError{Op: "rename", Path: oldPath, Err: fs.ErrNotExist}
	}

	out := make([]byte, len(data))
	copy(out, data)
	m.files[newPath] = out
	delete(m.files, oldPath)
	return nil
}

func (m *memoryFS) Remove(name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	delete(m.files, name)
	return nil
}

func (m *memoryFS) failNextRename(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.renameErr = err
}

func (m *memoryFS) writeRaw(name string, data []byte) {
	m.mu.Lock()
	defer m.mu.Unlock()

	out := make([]byte, len(data))
	copy(out, data)
	m.files[name] = out
}

func (m *memoryFS) mustRead(t *testing.T, name string) []byte {
	t.Helper()

	data, err := m.ReadFile(name)
	if err != nil {
		t.Fatalf("ReadFile(%q) returned error: %v", name, err)
	}
	return data
}
