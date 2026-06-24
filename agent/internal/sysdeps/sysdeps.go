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

// WireGuardPeer is the narrow typed peer configuration accepted by the
// WireGuard sysdeps helpers. Keys are raw 32-byte WireGuard keys; callers own
// all validation and must not pass untrusted text through this boundary.
type WireGuardPeer struct {
	PublicKey           []byte
	AllowedIPs          []string
	Endpoint            string
	PersistentKeepalive *int
}

type WireGuardPeerStatus struct {
	PublicKey         []byte
	AllowedIPs        []string
	LastHandshakeUnix int64
}

type WireGuardDeviceStatus struct {
	Name       string
	ListenPort int
	Peers      []WireGuardPeerStatus
}

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
	case syscall.ENODEV:
		return "ENODEV"
	case syscall.ENOSYS:
		return "ENOSYS"
	case syscall.EOPNOTSUPP:
		return "EOPNOTSUPP"
	case syscall.EPERM:
		return "EPERM"
	default:
		return "ERRNO_" + strconv.Itoa(int(errno))
	}
}
