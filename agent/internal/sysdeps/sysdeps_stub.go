//go:build !linux

package sysdeps

// SetRealtimeClock is unsupported off Linux.
func SetRealtimeClock(sec, nsec int64) error { return ErrUnsupported }

// RealtimeClock is unsupported off Linux.
func RealtimeClock() (sec, nsec int64, err error) { return 0, 0, ErrUnsupported }

// SetHostname is unsupported off Linux.
func SetHostname(name string) error { return ErrUnsupported }

// UnshareNetworkNamespace is unsupported off Linux.
func UnshareNetworkNamespace() error { return ErrUnsupported }

// SetNetworkNamespace is unsupported off Linux.
func SetNetworkNamespace(fd int) error { return ErrUnsupported }

// BindMount is unsupported off Linux.
func BindMount(source string, target string) error { return ErrUnsupported }

// UnmountDetach is unsupported off Linux.
func UnmountDetach(target string) error { return ErrUnsupported }

// SetLoopbackUp is unsupported off Linux.
func SetLoopbackUp() error { return ErrUnsupported }
