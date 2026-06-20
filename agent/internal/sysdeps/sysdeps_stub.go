//go:build !linux

package sysdeps

// SetRealtimeClock is unsupported off Linux.
func SetRealtimeClock(sec, nsec int64) error { return ErrUnsupported }

// RealtimeClock is unsupported off Linux.
func RealtimeClock() (sec, nsec int64, err error) { return 0, 0, ErrUnsupported }

// SetHostname is unsupported off Linux.
func SetHostname(name string) error { return ErrUnsupported }
