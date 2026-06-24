package atomicfile

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
)

// OnDurabilityWarning is invoked when a write COMMITTED (the rename succeeded,
// so the new bytes are live) but the post-rename parent-directory fsync failed,
// leaving the rename's durability across an immediate power loss uncertain. It
// is a non-fatal durability signal, NOT a transactional failure: the commit
// point has already passed, there is no rollback, and Write still returns nil.
// It must never be read as "prior bytes intact" — by the time it fires the NEW
// bytes are already live. The default logs to the standard logger; tests
// override it to observe the warning.
var OnDurabilityWarning = func(path string, err error) {
	log.Printf("atomicfile: committed %s but parent-dir fsync failed (durability uncertain): %v", path, err)
}

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
//
// It guarantees exactly two outcomes: (a) it returns nil and the new bytes are
// live, or (b) it returns an error and the live file is byte-identical to its
// prior state (the temp is cleaned up). The rename is the single commit point;
// only failures BEFORE it are returned as errors. A post-rename parent-dir
// fsync failure does NOT roll back (the bytes are committed) and is therefore
// reported via OnDurabilityWarning rather than as an error — there is never a
// "mutated-but-reported-failed" third state.
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

	// The rename is the single commit point. Once it succeeds the new bytes
	// are live and the operation has logically SUCCEEDED — there is no rollback.
	// Any failure BEFORE this point leaves the live file byte-identical to its
	// prior state (and the temp is cleaned up by the deferred Remove), so it is
	// returned as a transactional error. Any failure AFTER this point must NOT
	// be returned as an error: doing so would create the forbidden third state
	// (mutated-but-reported-failed) where the caller assumes the prior bytes are
	// intact while the new bytes are actually live and unrollbackable.
	if err := fsys.Rename(tmpName, path); err != nil {
		return fmt.Errorf("atomicfile: rename temp: %w", err)
	}
	committed = true

	// Post-commit: fsync the parent directory so the rename is durable across an
	// abrupt power loss. A failure here is a non-fatal DURABILITY signal, not a
	// transactional failure — the bytes are already committed. Surface it via
	// OnDurabilityWarning and return success; never return it as an error that
	// would imply the prior state survived.
	if err := fsys.SyncDir(targetDir); err != nil {
		OnDurabilityWarning(path, fmt.Errorf("atomicfile: sync parent dir: %w", err))
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
