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

// UnshareNetworkNamespace moves the current thread into a fresh network namespace.
// Privileged: requires CAP_SYS_ADMIN.
func UnshareNetworkNamespace() error {
	return unix.Unshare(unix.CLONE_NEWNET)
}

// SetNetworkNamespace moves the current thread into the network namespace
// referenced by fd. Privileged: requires CAP_SYS_ADMIN.
func SetNetworkNamespace(fd int) error {
	return unix.Setns(fd, unix.CLONE_NEWNET)
}

// BindMount bind-mounts source onto target.
// Privileged: requires CAP_SYS_ADMIN.
func BindMount(source string, target string) error {
	return unix.Mount(source, target, "none", unix.MS_BIND, "")
}

// UnmountDetach lazily detaches a mount.
// Privileged: requires CAP_SYS_ADMIN.
func UnmountDetach(target string) error {
	return unix.Unmount(target, unix.MNT_DETACH)
}

// SetLoopbackUp marks the loopback interface up in the current network namespace.
// Privileged: requires CAP_NET_ADMIN in that namespace.
func SetLoopbackUp() error {
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)

	ifreq, err := unix.NewIfreq("lo")
	if err != nil {
		return err
	}
	if err := unix.IoctlIfreq(fd, unix.SIOCGIFFLAGS, ifreq); err != nil {
		return err
	}
	ifreq.SetUint16(ifreq.Uint16() | uint16(unix.IFF_UP))
	return unix.IoctlIfreq(fd, unix.SIOCSIFFLAGS, ifreq)
}
