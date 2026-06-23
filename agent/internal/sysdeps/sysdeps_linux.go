//go:build linux

package sysdeps

import "golang.org/x/sys/unix"

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
