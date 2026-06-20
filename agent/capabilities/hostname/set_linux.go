//go:build linux

package hostname

import (
	"context"
	"fmt"
	"os"

	"github.com/vita/agent/internal/sysdeps"
)

type systemHost struct{}

func newDefaultHost() host {
	return systemHost{}
}

func (systemHost) Current(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}

	current, err := os.Hostname()
	if err != nil {
		return "", fmt.Errorf("read kernel hostname: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}

	return current, nil
}

func (systemHost) Set(ctx context.Context, desired string) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	if err := sysdeps.SetHostname(desired); err != nil {
		return fmt.Errorf("set kernel hostname: %w", err)
	}
	return nil
}
