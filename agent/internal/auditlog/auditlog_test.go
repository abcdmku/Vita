package auditlog

import (
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"reflect"
	"strings"
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

func TestAppendSyncsParentDirAfterRename(t *testing.T) {
	fileSystem := newMemoryFS()
	store := mustStore(t, fileSystem, 10)

	if _, err := store.Append(validEvent()); err != nil {
		t.Fatalf("initial Append returned error: %v", err)
	}
	fileSystem.resetOps()

	if _, err := store.Append(validEvent()); err != nil {
		t.Fatalf("Append returned error: %v", err)
	}

	if len(fileSystem.ops) != 2 {
		t.Fatalf("filesystem ops = %#v, want rename then sync-dir", fileSystem.ops)
	}
	if !strings.HasPrefix(fileSystem.ops[0], "rename:") {
		t.Fatalf("first filesystem op = %q, want rename", fileSystem.ops[0])
	}
	if fileSystem.ops[1] != "sync-dir:/audit" {
		t.Fatalf("second filesystem op = %q, want sync-dir:/audit", fileSystem.ops[1])
	}
}

// TestAppendIgnoresPrePlantedPredictableTemp proves the random-temp +
// O_EXCL atomic-write pattern is immune to a TOCTOU/symlink attack at the OLD
// predictable temp path. An attacker who pre-plants an entry at path+".tmp"
// (the formerly-followed location) no longer affects anything: CreateTemp uses
// a fresh random name, so Append still succeeds atomically and the planted
// entry is left untouched.
func TestAppendIgnoresPrePlantedPredictableTemp(t *testing.T) {
	fileSystem := newMemoryFS()
	store := mustStore(t, fileSystem, 10)

	if _, err := store.Append(validEvent()); err != nil {
		t.Fatalf("initial Append returned error: %v", err)
	}

	predictableTemp := testLogPath + ".tmp"
	planted := []byte("attacker-controlled-target")
	fileSystem.writeRaw(predictableTemp, planted)

	stored, err := store.Append(validEvent())
	if err != nil {
		t.Fatalf("Append with pre-planted predictable temp returned error: %v", err)
	}
	if stored.Sequence != 2 {
		t.Fatalf("stored Sequence = %d, want 2", stored.Sequence)
	}

	events, err := store.Read()
	if err != nil {
		t.Fatalf("Read returned error: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("Read returned %d events, want 2", len(events))
	}

	// The planted entry at the old predictable temp path is never followed or
	// clobbered: it is left byte-identical.
	after := fileSystem.mustRead(t, predictableTemp)
	if !reflect.DeepEqual(after, planted) {
		t.Fatalf("pre-planted predictable temp changed: got %s, want %s", string(after), string(planted))
	}
}

// TestAppendFailsClosedWhenTempDirCreationFails proves Append fails CLOSED and
// leaves the live log UNCHANGED when the atomic-write cannot create its temp
// directory (e.g. an unwritable target dir or a symlink loop).
func TestAppendFailsClosedWhenTempDirCreationFails(t *testing.T) {
	fileSystem := newMemoryFS()
	store := mustStore(t, fileSystem, 10)

	if _, err := store.Append(validEvent()); err != nil {
		t.Fatalf("initial Append returned error: %v", err)
	}
	before := fileSystem.mustRead(t, testLogPath)

	mkdirErr := errors.New("mkdir failed: not a directory")
	fileSystem.failNextMkdir(mkdirErr)
	if _, err := store.Append(validEvent()); !errors.Is(err, mkdirErr) {
		t.Fatalf("Append error = %v, want mkdirErr", err)
	}

	after := fileSystem.mustRead(t, testLogPath)
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("log changed after failed temp dir creation: got %s, want %s", string(after), string(before))
	}

	// Recovery: a subsequent Append succeeds and the live log advances.
	stored, err := store.Append(validEvent())
	if err != nil {
		t.Fatalf("Append after failed mkdir returned error: %v", err)
	}
	if stored.Sequence != 2 {
		t.Fatalf("stored Sequence = %d, want 2", stored.Sequence)
	}
}

// TestAppendFailsClosedWhenTempCreateFails proves Append fails CLOSED and
// leaves the live log UNCHANGED when the exclusive temp file cannot be created
// (e.g. CreateTemp's O_EXCL open fails because the slot is occupied).
func TestAppendFailsClosedWhenTempCreateFails(t *testing.T) {
	fileSystem := newMemoryFS()
	store := mustStore(t, fileSystem, 10)

	if _, err := store.Append(validEvent()); err != nil {
		t.Fatalf("initial Append returned error: %v", err)
	}
	before := fileSystem.mustRead(t, testLogPath)

	createErr := errors.New("createtemp failed")
	fileSystem.failNextCreateTemp(createErr)
	if _, err := store.Append(validEvent()); !errors.Is(err, createErr) {
		t.Fatalf("Append error = %v, want createErr", err)
	}

	after := fileSystem.mustRead(t, testLogPath)
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("log changed after failed temp create: got %s, want %s", string(after), string(before))
	}
}

// TestAppendFailsClosedWhenTempSyncFails proves a failure between temp write
// and the rename commit point leaves the live log UNCHANGED and removes the
// orphaned temp file (no third "mutated-but-reported-failed" state).
func TestAppendFailsClosedWhenTempSyncFails(t *testing.T) {
	fileSystem := newMemoryFS()
	store := mustStore(t, fileSystem, 10)

	if _, err := store.Append(validEvent()); err != nil {
		t.Fatalf("initial Append returned error: %v", err)
	}
	before := fileSystem.mustRead(t, testLogPath)

	syncErr := errors.New("sync failed")
	fileSystem.failNextSync(syncErr)
	if _, err := store.Append(validEvent()); !errors.Is(err, syncErr) {
		t.Fatalf("Append error = %v, want syncErr", err)
	}

	after := fileSystem.mustRead(t, testLogPath)
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("log changed after failed sync: got %s, want %s", string(after), string(before))
	}

	// The orphaned temp file was cleaned up (best-effort) before the commit.
	for _, name := range fileSystem.createdTmp {
		if _, err := fileSystem.ReadFile(name); err == nil {
			t.Fatalf("temp file %q left behind after failed sync", name)
		}
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
	mu         sync.Mutex
	files      map[string][]byte
	dirs       map[string]struct{}
	tempSeq    int
	mkdirErr   error
	createErr  error
	renameErr  error
	syncErr    error
	syncDirErr error
	createdTmp []string
	ops        []string
}

func newMemoryFS() *memoryFS {
	return &memoryFS{files: map[string][]byte{}, dirs: map[string]struct{}{}}
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

func (m *memoryFS) MkdirAll(path string, _ fs.FileMode) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.mkdirErr != nil {
		err := m.mkdirErr
		m.mkdirErr = nil
		return err
	}

	m.dirs[path] = struct{}{}
	return nil
}

func (m *memoryFS) CreateTemp(dir, pattern string) (TempFile, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.createErr != nil {
		err := m.createErr
		m.createErr = nil
		return nil, err
	}

	// Emulate os.CreateTemp: a FRESH random-named file created with
	// O_CREATE|O_EXCL. The name is unique, so any pre-existing entry (even at
	// the OLD predictable path+".tmp") is never touched or followed.
	prefix, suffix, _ := strings.Cut(pattern, "*")
	m.tempSeq++
	name := filepath.Join(dir, fmt.Sprintf("%s%d%s", prefix, m.tempSeq, suffix))
	if _, exists := m.files[name]; exists {
		return nil, &fs.PathError{Op: "createtemp", Path: name, Err: fs.ErrExist}
	}
	m.files[name] = []byte{}
	m.createdTmp = append(m.createdTmp, name)

	return &memTempFile{fsys: m, name: name}, nil
}

func (m *memoryFS) failNextSync(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.syncErr = err
}

func (m *memoryFS) failNextSyncDir(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.syncDirErr = err
}

func (m *memoryFS) failNextMkdir(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.mkdirErr = err
}

func (m *memoryFS) failNextCreateTemp(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.createErr = err
}

// memTempFile emulates the *os.File handle returned by CreateTemp, writing
// directly into the parent memoryFS map under its unique random name.
type memTempFile struct {
	fsys *memoryFS
	name string
}

func (f *memTempFile) Name() string { return f.name }

func (f *memTempFile) Chmod(fs.FileMode) error { return nil }

func (f *memTempFile) Write(data []byte) (int, error) {
	f.fsys.mu.Lock()
	defer f.fsys.mu.Unlock()

	cur := f.fsys.files[f.name]
	cur = append(cur, data...)
	f.fsys.files[f.name] = cur
	return len(data), nil
}

func (f *memTempFile) Sync() error {
	f.fsys.mu.Lock()
	defer f.fsys.mu.Unlock()

	if f.fsys.syncErr != nil {
		err := f.fsys.syncErr
		f.fsys.syncErr = nil
		return err
	}
	return nil
}

func (f *memTempFile) Close() error { return nil }

func (m *memoryFS) Rename(oldPath, newPath string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ops = append(m.ops, "rename:"+oldPath+"->"+newPath)

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

func (m *memoryFS) SyncDir(dir string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ops = append(m.ops, "sync-dir:"+filepath.ToSlash(dir))

	if m.syncDirErr != nil {
		err := m.syncDirErr
		m.syncDirErr = nil
		return err
	}
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

func (m *memoryFS) resetOps() {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.ops = nil
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
