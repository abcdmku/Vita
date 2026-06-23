//go:build linux

package sysdeps

import (
	"errors"

	"golang.org/x/sys/unix"
)

// SetRealtimeClock sets CLOCK_REALTIME to the given Unix time (seconds + nanoseconds).
// Privileged: requires CAP_SYS_TIME.
func SetRealtimeClock(sec, nsec int64) error {
	return unix.ClockSettime(unix.CLOCK_REALTIME, &unix.Timespec{Sec: sec, Nsec: nsec})
}

// RealtimeClock reads CLOCK_REALTIME as (seconds, nanoseconds).
func RealtimeClock() (sec, nsec int64, err error) {
	var ts unix.Timespec
	if err = unix.ClockGettime(unix.CLOCK_REALTIME, &ts); err != nil {
		return 0, 0, err
	}
	return ts.Sec, ts.Nsec, nil
}

// SetHostname sets the kernel hostname. Privileged: requires CAP_SYS_ADMIN.
func SetHostname(name string) error {
	return unix.Sethostname([]byte(name))
}

// Chown changes a path owner. Privileged callers use this narrow wrapper instead
// of importing the syscall package directly.
func Chown(path string, uid, gid int) error {
	return unix.Chown(path, uid, gid)
}

// Unmount detaches a mount target from the current mount namespace.
func Unmount(target string) error {
	if err := unix.Unmount(target, unix.MNT_DETACH); err != nil {
		if errors.Is(err, unix.EINVAL) || errors.Is(err, unix.ENOENT) {
			return ErrNotMounted
		}
		return err
	}
	return nil
}
