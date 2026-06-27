//go:build !linux

package capsule

// The !linux stub launcher for capsule.exec. The real interactive terminal needs a linux node with
// systemd + a pty, which the dev/Windows build host does not have. So on a non-linux build the launcher
// fails closed with ErrExecUnsupported — the capability, the hardened-unit composition, the wire-frame
// codec, and the gating are all still compiled + unit-tested here (cross-platform), but actually OPENING
// a session returns an operator-actionable error instead of pretending. The production path is verified
// on a real node boot (see CAPSULE-EXEC.md "What needs a boot").

import "context"

type stubExecPtyLauncher struct{}

func newDefaultExecPtyLauncher() ExecPtyLauncher { return stubExecPtyLauncher{} }

// Available reports false: the real PTY launcher is not usable on this (non-linux) host.
func (stubExecPtyLauncher) Available() bool { return false }

func (stubExecPtyLauncher) Start(_ context.Context, _ transientUnit, _, _ uint16) (ExecPtyHandle, error) {
	return nil, ErrExecUnsupported
}
