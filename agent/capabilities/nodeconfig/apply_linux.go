//go:build linux

package nodeconfig

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/vita/agent/internal/atomicfile"
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

	if err := atomicfile.WriteWithPatternAndBeforeCommit(
		atomicfile.OSFileSystem{},
		fs.path,
		content,
		configFileMode,
		".node-config-*.tmp",
		ctx.Err,
	); err != nil {
		return fmt.Errorf("write node config: %w", err)
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
