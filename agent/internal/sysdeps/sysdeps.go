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

import "errors"

// ErrUnsupported is returned by the non-Linux stubs.
var ErrUnsupported = errors.New("sysdeps: operation not supported on this platform")

// ErrNotMounted is returned when an unmount target is already absent from the
// current mount namespace.
var ErrNotMounted = errors.New("sysdeps: target is not mounted")
