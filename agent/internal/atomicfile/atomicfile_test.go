package atomicfile

import (
	"errors"
	"io"
	"io/fs"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const (
	testTargetPath = "/var/lib/vita-agent/state.json"
	testTempMode   = fs.FileMode(0o600)
)

func TestWriteRenamesThenSyncsParentDir(t *testing.T) {
	fileSystem := newMemoryFS()
	fileSystem.writeRaw(testTargetPath, []byte("prior"))
	predictableTemp := testTargetPath + ".tmp"
	fileSystem.writeRaw(predictableTemp, []byte("attacker"))

	if err := WriteWithPattern(fileSystem, testTargetPath, []byte("next"), testTempMode, ".state-*.tmp"); err != nil {
		t.Fatalf("WriteWithPattern returned error: %v", err)
	}

	if got := string(fileSystem.mustRead(t, testTargetPath)); got != "next" {
		t.Fatalf("target bytes = %q, want next", got)
	}
	if got := string(fileSystem.mustRead(t, predictableTemp)); got != "attacker" {
		t.Fatalf("predictable temp changed = %q, want attacker", got)
	}
	if len(fileSystem.createdTmp) != 1 {
		t.Fatalf("created temp count = %d, want 1", len(fileSystem.createdTmp))
	}
	if _, err := fileSystem.ReadFile(fileSystem.createdTmp[0]); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("committed temp still exists: err=%v", err)
	}
	if got := fileSystem.modeFor(fileSystem.createdTmp[0]); got != testTempMode {
		t.Fatalf("temp mode = %#o, want %#o", got, testTempMode)
	}

	wantOrder := []string{
		"create-temp:/var/lib/vita-agent:.state-*.tmp",
		"chmod:" + fileSystem.createdTmp[0],
		"write:" + fileSystem.createdTmp[0],
		"sync-file:" + fileSystem.createdTmp[0],
		"close-file:" + fileSystem.createdTmp[0],
		"rename:" + fileSystem.createdTmp[0] + "->" + testTargetPath,
		"sync-dir:/var/lib/vita-agent",
	}
	if !reflect.DeepEqual(fileSystem.order, wantOrder) {
		t.Fatalf("operation order = %#v, want %#v", fileSystem.order, wantOrder)
	}
}

func TestWriteUsesDefaultExclusiveTempPattern(t *testing.T) {
	fileSystem := newMemoryFS()

	if err := Write(fileSystem, testTargetPath, []byte("next"), testTempMode); err != nil {
		t.Fatalf("Write returned error: %v", err)
	}

	if len(fileSystem.createdTmp) != 1 {
		t.Fatalf("created temp count = %d, want 1", len(fileSystem.createdTmp))
	}
	if got := filepath.Base(fileSystem.createdTmp[0]); !strings.HasPrefix(got, ".state.json-") || !strings.HasSuffix(got, ".tmp") {
		t.Fatalf("created temp basename = %q, want default pattern .state.json-*.tmp", got)
	}
}

func TestWriteRequiresParentDirSync(t *testing.T) {
	fileSystem := newMemoryFS()
	syncDirErr := errors.New("parent dir sync failed")
	fileSystem.failNextSyncDir(syncDirErr)

	err := Write(fileSystem, testTargetPath, []byte("next"), testTempMode)
	if !errors.Is(err, syncDirErr) {
		t.Fatalf("Write error = %v, want syncDirErr", err)
	}
	if !fileSystem.saw("sync-dir:/var/lib/vita-agent") {
		t.Fatalf("operation order = %#v, want observable parent dir sync", fileSystem.order)
	}
	if got := string(fileSystem.mustRead(t, testTargetPath)); got != "next" {
		t.Fatalf("target bytes after post-rename sync-dir error = %q, want committed next", got)
	}
}

func TestWritePreCommitErrorsLeaveLiveFileUnchanged(t *testing.T) {
	tests := []struct {
		name      string
		configure func(*memoryFS)
		wantErr   error
	}{
		{
			name: "create temp",
			configure: func(m *memoryFS) {
				m.failNextCreateTemp(errCreateTemp)
			},
			wantErr: errCreateTemp,
		},
		{
			name: "chmod",
			configure: func(m *memoryFS) {
				m.failNextChmod(errChmod)
			},
			wantErr: errChmod,
		},
		{
			name: "write",
			configure: func(m *memoryFS) {
				m.failNextWrite(errWrite)
			},
			wantErr: errWrite,
		},
		{
			name: "short write",
			configure: func(m *memoryFS) {
				m.shortWrite = true
			},
			wantErr: io.ErrShortWrite,
		},
		{
			name: "sync temp",
			configure: func(m *memoryFS) {
				m.failNextFileSync(errFileSync)
			},
			wantErr: errFileSync,
		},
		{
			name: "close temp",
			configure: func(m *memoryFS) {
				m.failNextClose(errClose)
			},
			wantErr: errClose,
		},
		{
			name: "before commit",
			configure: func(m *memoryFS) {
				m.beforeCommitErr = errBeforeCommit
			},
			wantErr: errBeforeCommit,
		},
		{
			name: "rename",
			configure: func(m *memoryFS) {
				m.failNextRename(errRename)
			},
			wantErr: errRename,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fileSystem := newMemoryFS()
			fileSystem.writeRaw(testTargetPath, []byte("prior"))
			tt.configure(fileSystem)

			err := WriteWithPatternAndBeforeCommit(fileSystem, testTargetPath, []byte("next"), testTempMode, ".state-*.tmp", func() error {
				return fileSystem.beforeCommitErr
			})
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("Write error = %v, want %v", err, tt.wantErr)
			}

			if got := string(fileSystem.mustRead(t, testTargetPath)); got != "prior" {
				t.Fatalf("target bytes = %q, want prior", got)
			}
			for _, name := range fileSystem.createdTmp {
				if _, err := fileSystem.ReadFile(name); err == nil {
					t.Fatalf("temp %q left behind after failed write", name)
				}
			}
		})
	}
}

func TestWriteMalformedInputsFailClosedWithoutPanic(t *testing.T) {
	tests := []struct {
		name string
		run  func() error
	}{
		{
			name: "nil filesystem",
			run: func() error {
				return Write(nil, testTargetPath, []byte("next"), testTempMode)
			},
		},
		{
			name: "empty path",
			run: func() error {
				return Write(newMemoryFS(), "", []byte("next"), testTempMode)
			},
		},
		{
			name: "nil temp file",
			run: func() error {
				fileSystem := newMemoryFS()
				fileSystem.returnNilTemp = true
				return Write(fileSystem, testTargetPath, []byte("next"), testTempMode)
			},
		},
		{
			name: "empty temp name",
			run: func() error {
				fileSystem := newMemoryFS()
				fileSystem.emptyTempName = true
				return Write(fileSystem, testTargetPath, []byte("next"), testTempMode)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("Write panicked: %v", r)
				}
			}()
			if err := tt.run(); err == nil {
				t.Fatal("Write returned nil, want fail-closed error")
			}
		})
	}
}

var (
	errCreateTemp   = errors.New("create failed")
	errChmod        = errors.New("chmod failed")
	errWrite        = errors.New("write failed")
	errFileSync     = errors.New("sync failed")
	errClose        = errors.New("close failed")
	errBeforeCommit = errors.New("context canceled")
	errRename       = errors.New("rename failed")
)

type memoryFS struct {
	files           map[string][]byte
	modes           map[string]fs.FileMode
	createdTmp      []string
	order           []string
	tempSeq         int
	createErr       error
	chmodErr        error
	writeErr        error
	fileSyncErr     error
	closeErr        error
	renameErr       error
	syncDirErr      error
	beforeCommitErr error
	shortWrite      bool
	returnNilTemp   bool
	emptyTempName   bool
}

func newMemoryFS() *memoryFS {
	return &memoryFS{
		files: map[string][]byte{},
		modes: map[string]fs.FileMode{},
	}
}

func (m *memoryFS) CreateTemp(dir, pattern string) (TempFile, error) {
	m.order = append(m.order, "create-temp:"+filepath.ToSlash(dir)+":"+pattern)
	if m.createErr != nil {
		err := m.createErr
		m.createErr = nil
		return nil, err
	}
	if m.returnNilTemp {
		return nil, nil
	}

	prefix, suffix, _ := strings.Cut(pattern, "*")
	m.tempSeq++
	name := filepath.Join(dir, prefix+string(rune('0'+m.tempSeq))+suffix)
	if m.emptyTempName {
		name = ""
	}
	if _, exists := m.files[name]; exists {
		return nil, &fs.PathError{Op: "createtemp", Path: name, Err: fs.ErrExist}
	}
	m.files[name] = []byte{}
	m.createdTmp = append(m.createdTmp, name)
	return &memTempFile{fsys: m, name: name}, nil
}

func (m *memoryFS) Rename(oldPath, newPath string) error {
	m.order = append(m.order, "rename:"+oldPath+"->"+newPath)
	if m.renameErr != nil {
		err := m.renameErr
		m.renameErr = nil
		return err
	}

	data, ok := m.files[oldPath]
	if !ok {
		return &fs.PathError{Op: "rename", Path: oldPath, Err: fs.ErrNotExist}
	}
	m.files[newPath] = cloneBytes(data)
	delete(m.files, oldPath)
	return nil
}

func (m *memoryFS) Remove(name string) error {
	delete(m.files, name)
	return nil
}

func (m *memoryFS) SyncDir(dir string) error {
	m.order = append(m.order, "sync-dir:"+filepath.ToSlash(dir))
	if m.syncDirErr != nil {
		err := m.syncDirErr
		m.syncDirErr = nil
		return err
	}
	return nil
}

func (m *memoryFS) ReadFile(name string) ([]byte, error) {
	data, ok := m.files[name]
	if !ok {
		return nil, &fs.PathError{Op: "read", Path: name, Err: fs.ErrNotExist}
	}
	return cloneBytes(data), nil
}

func (m *memoryFS) writeRaw(name string, data []byte) {
	m.files[name] = cloneBytes(data)
}

func (m *memoryFS) mustRead(t *testing.T, name string) []byte {
	t.Helper()

	data, err := m.ReadFile(name)
	if err != nil {
		t.Fatalf("ReadFile(%q) returned error: %v", name, err)
	}
	return data
}

func (m *memoryFS) modeFor(name string) fs.FileMode {
	return m.modes[name]
}

func (m *memoryFS) saw(event string) bool {
	for _, got := range m.order {
		if got == event {
			return true
		}
	}
	return false
}

func (m *memoryFS) failNextCreateTemp(err error) { m.createErr = err }
func (m *memoryFS) failNextChmod(err error)      { m.chmodErr = err }
func (m *memoryFS) failNextWrite(err error)      { m.writeErr = err }
func (m *memoryFS) failNextFileSync(err error)   { m.fileSyncErr = err }
func (m *memoryFS) failNextClose(err error)      { m.closeErr = err }
func (m *memoryFS) failNextRename(err error)     { m.renameErr = err }
func (m *memoryFS) failNextSyncDir(err error)    { m.syncDirErr = err }

type memTempFile struct {
	fsys *memoryFS
	name string
}

func (f *memTempFile) Name() string { return f.name }

func (f *memTempFile) Chmod(mode fs.FileMode) error {
	f.fsys.order = append(f.fsys.order, "chmod:"+f.name)
	if f.fsys.chmodErr != nil {
		err := f.fsys.chmodErr
		f.fsys.chmodErr = nil
		return err
	}
	f.fsys.modes[f.name] = mode
	return nil
}

func (f *memTempFile) Write(data []byte) (int, error) {
	f.fsys.order = append(f.fsys.order, "write:"+f.name)
	if f.fsys.writeErr != nil {
		err := f.fsys.writeErr
		f.fsys.writeErr = nil
		return 0, err
	}
	written := len(data)
	if f.fsys.shortWrite && written > 0 {
		written--
	}
	f.fsys.files[f.name] = append(f.fsys.files[f.name], data[:written]...)
	return written, nil
}

func (f *memTempFile) Sync() error {
	f.fsys.order = append(f.fsys.order, "sync-file:"+f.name)
	if f.fsys.fileSyncErr != nil {
		err := f.fsys.fileSyncErr
		f.fsys.fileSyncErr = nil
		return err
	}
	return nil
}

func (f *memTempFile) Close() error {
	f.fsys.order = append(f.fsys.order, "close-file:"+f.name)
	if f.fsys.closeErr != nil {
		err := f.fsys.closeErr
		f.fsys.closeErr = nil
		return err
	}
	return nil
}

func cloneBytes(in []byte) []byte {
	if in == nil {
		return nil
	}
	out := make([]byte, len(in))
	copy(out, in)
	return out
}
