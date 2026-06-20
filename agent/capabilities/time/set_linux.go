//go:build linux

package nodetime

import (
	"context"
	"fmt"
	"time"

	"github.com/vita/agent/internal/sysdeps"
)

type systemClock struct{}

func newDefaultClock() clock {
	return systemClock{}
}

func (systemClock) Now(ctx context.Context) (time.Time, error) {
	if err := ctx.Err(); err != nil {
		return time.Time{}, err
	}

	sec, nsec, err := sysdeps.RealtimeClock()
	if err != nil {
		return time.Time{}, fmt.Errorf("read realtime clock: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return time.Time{}, err
	}

	return time.Unix(sec, nsec).UTC(), nil
}

func (systemClock) Set(ctx context.Context, desired time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	desired = desired.Round(0).UTC()
	if err := sysdeps.SetRealtimeClock(desired.Unix(), int64(desired.Nanosecond())); err != nil {
		return fmt.Errorf("set realtime clock: %w", err)
	}
	return nil
}
