package atomicfile

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

// TempFile is the subset of *os.File needed to stage content before the
// single rename commit point.
type TempFile interface {
	Name() string
	Chmod(mode fs.FileMode) error
	Write(data []byte) (int, error)
	Sync() error
	Close() error
}

// FileSystem abstracts the atomic-write filesystem operations. CreateTemp
// must create a fresh exclusive temp file; predictable temp paths are
// deliberately not part of this interface.
type FileSystem interface {
	CreateTemp(dir, pattern string) (TempFile, error)
	Rename(oldPath, newPath string) error
	Remove(name string) error
	SyncDir(dir string) error
}

type OSFileSystem struct{}

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
	dirf, err := os.Open(dir)
	if err != nil {
		return err
	}

	syncErr := dirf.Sync()
	closeErr := dirf.Close()
	if syncErr != nil {
		return syncErr
	}
	return closeErr
}

// Write atomically replaces path with data using a fresh temp file in the
// target directory, then fsyncs the parent directory so the rename is durable
// across power loss.
func Write(fsys FileSystem, path string, data []byte, mode fs.FileMode) error {
	return WriteWithPattern(fsys, path, data, mode, defaultTempPattern(path))
}

// WriteWithPattern is Write with a caller-supplied os.CreateTemp pattern. It
// exists so callers can preserve their established temp-file names while
// sharing the durable rename implementation.
func WriteWithPattern(fsys FileSystem, path string, data []byte, mode fs.FileMode, pattern string) error {
	return WriteWithPatternAndBeforeCommit(fsys, path, data, mode, pattern, nil)
}

// WriteWithPatternAndBeforeCommit is WriteWithPattern with one final
// pre-rename guard. If beforeCommit returns an error, the live file is still
// byte-identical to its prior state.
func WriteWithPatternAndBeforeCommit(
	fsys FileSystem,
	path string,
	data []byte,
	mode fs.FileMode,
	pattern string,
	beforeCommit func() error,
) error {
	if fsys == nil {
		return errors.New("atomicfile: nil filesystem")
	}
	if path == "" {
		return errors.New("atomicfile: empty path")
	}
	if pattern == "" {
		pattern = defaultTempPattern(path)
	}

	targetDir := filepath.Dir(path)
	tmp, err := fsys.CreateTemp(targetDir, pattern)
	if err != nil {
		return fmt.Errorf("atomicfile: create temp: %w", err)
	}
	if tmp == nil {
		return errors.New("atomicfile: create temp returned nil file")
	}

	tmpName := tmp.Name()
	if tmpName == "" {
		_ = tmp.Close()
		return errors.New("atomicfile: temp file has empty name")
	}

	closed := false
	committed := false
	defer func() {
		if !closed {
			_ = tmp.Close()
		}
		if !committed {
			_ = fsys.Remove(tmpName)
		}
	}()

	if err := tmp.Chmod(mode); err != nil {
		return fmt.Errorf("atomicfile: chmod temp: %w", err)
	}
	written, err := tmp.Write(data)
	if err != nil {
		return fmt.Errorf("atomicfile: write temp: %w", err)
	}
	if written != len(data) {
		return fmt.Errorf("atomicfile: write temp: %w", io.ErrShortWrite)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("atomicfile: sync temp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		closed = true
		return fmt.Errorf("atomicfile: close temp: %w", err)
	}
	closed = true

	if beforeCommit != nil {
		if err := beforeCommit(); err != nil {
			return err
		}
	}

	if err := fsys.Rename(tmpName, path); err != nil {
		return fmt.Errorf("atomicfile: rename temp: %w", err)
	}
	committed = true

	if err := fsys.SyncDir(targetDir); err != nil {
		return fmt.Errorf("atomicfile: sync parent dir: %w", err)
	}
	return nil
}

func defaultTempPattern(path string) string {
	base := filepath.Base(path)
	if base == "." || base == string(filepath.Separator) || base == "" {
		base = "file"
	}
	return "." + base + "-*.tmp"
}
