//go:build !linux

package sysdeps

// SetRealtimeClock is unsupported off Linux.
func SetRealtimeClock(sec, nsec int64) error { return ErrUnsupported }

// RealtimeClock is unsupported off Linux.
func RealtimeClock() (sec, nsec int64, err error) { return 0, 0, ErrUnsupported }

// SetHostname is unsupported off Linux.
func SetHostname(name string) error { return ErrUnsupported }

// Chown is unsupported off Linux.
func Chown(path string, uid, gid int) error { return ErrUnsupported }

// Unmount is unsupported off Linux.
func Unmount(target string) error { return ErrUnsupported }
