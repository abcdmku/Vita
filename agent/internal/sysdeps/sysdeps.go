// Package sysdeps is the single audited import site for the extended syscall
// package golang.org/x/sys/unix (vendored under agent/vendor). Privileged Linux
// host capabilities (time, hostname, network, ...) call these narrow, named
// wrappers instead of importing x/sys directly, so the privileged syscall
// surface stays small, reviewable, and offline-buildable.
//
// These wrappers perform the irreversible privileged effect ONLY. Capabilities
// own the transactional semantics (read prior state, validate, apply via an
// injected facade, record an Undo) — see agent/transaction. Tests inject mock
// facades; they must never call these real wrappers.
package sysdeps

import (
	"errors"
	"strconv"
	"syscall"
)

// ErrUnsupported is returned by the non-Linux stubs.
var ErrUnsupported = errors.New("sysdeps: operation not supported on this platform")

// ErrnoCode returns a stable errno token from a wrapped syscall failure.
func ErrnoCode(err error) string {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return ""
	}
	switch errno {
	case syscall.EACCES:
		return "EACCES"
	case syscall.EEXIST:
		return "EEXIST"
	case syscall.EINVAL:
		return "EINVAL"
	case syscall.ENOENT:
		return "ENOENT"
	case syscall.ENOSYS:
		return "ENOSYS"
	case syscall.EPERM:
		return "EPERM"
	default:
		return "ERRNO_" + strconv.Itoa(int(errno))
	}
}
