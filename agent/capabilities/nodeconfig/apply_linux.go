//go:build linux

package nodeconfig

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

const (
	defaultStateRoot      = "/var/lib/vita-agent"
	defaultConfigFilename = "node-config.env"
	configFileMode        = 0o600
	stateRootMode         = 0o700
)

type linuxConfigFileSystem struct {
	stateRoot string
	path      string
}

func newDefaultFileSystem() configFileSystem {
	return linuxConfigFileSystem{
		stateRoot: defaultStateRoot,
		path:      filepath.Join(defaultStateRoot, defaultConfigFilename),
	}
}

func (fs linuxConfigFileSystem) Read(ctx context.Context) (configSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return configSnapshot{}, err
	}

	content, err := os.ReadFile(fs.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return configSnapshot{exists: false}, nil
		}
		return configSnapshot{}, fmt.Errorf("read node config: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return configSnapshot{}, err
	}

	return configSnapshot{exists: true, bytes: cloneBytes(content)}, nil
}

func (fs linuxConfigFileSystem) AtomicWrite(ctx context.Context, content []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.MkdirAll(fs.stateRoot, stateRootMode); err != nil {
		return fmt.Errorf("create node config state root: %w", err)
	}
	if err := os.Chmod(fs.stateRoot, stateRootMode); err != nil {
		return fmt.Errorf("secure node config state root: %w", err)
	}

	tmp, err := os.CreateTemp(fs.stateRoot, ".node-config-*.tmp")
	if err != nil {
		return fmt.Errorf("create node config temp file: %w", err)
	}
	tmpName := tmp.Name()
	closed := false
	defer func() {
		if !closed {
			_ = tmp.Close()
		}
		_ = os.Remove(tmpName)
	}()

	if err := tmp.Chmod(configFileMode); err != nil {
		return fmt.Errorf("secure node config temp file: %w", err)
	}
	written, err := tmp.Write(content)
	if err != nil {
		return fmt.Errorf("write node config temp file: %w", err)
	}
	if written != len(content) {
		return fmt.Errorf("write node config temp file: %w", io.ErrShortWrite)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("sync node config temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		closed = true
		return fmt.Errorf("close node config temp file: %w", err)
	}
	closed = true

	if err := ctx.Err(); err != nil {
		return err
	}
	// Rename is the single commit point: callers only receive an undo after nil error.
	if err := os.Rename(tmpName, fs.path); err != nil {
		return fmt.Errorf("replace node config: %w", err)
	}

	return nil
}

func (fs linuxConfigFileSystem) Replace(ctx context.Context, snapshot configSnapshot) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if snapshot.exists {
		return fs.AtomicWrite(ctx, snapshot.bytes)
	}

	if err := os.Remove(fs.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove node config: %w", err)
	}
	return nil
}
