//go:build linux

package capsule

// The REAL (linux) PTY launcher for capsule.exec. It allocates a pseudo-terminal, then runs the
// hardened transient unit's argv (the interactive shell) against the pty SLAVE through systemd-run, so
// the shell gets a controlling tty AND the full DynamicUser + seccomp + cgroup hardening systemd applies.
// The pty MASTER is the duplex byte stream the transport pumps to/from the client.
//
// systemd-run is invoked with --wait --collect and the composed --property=... flags; the slave fd is
// the unit process's stdin/stdout/stderr. Because the unit runs under DynamicUser with ProtectSystem=
// strict / empty CapabilityBoundingSet / SystemCallFilter, the shell inside the pty has exactly the
// isolation CAPSULE-EXEC.md describes — it cannot reach owner files, other capsules, secrets, the host
// fs, or the network, and cannot escalate.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"

	"golang.org/x/sys/unix"
)

// defaultExecPtyLauncher runs systemd-run against an allocated pty. Production path.
type defaultExecPtyLauncher struct {
	systemdRun string
	systemctl  string
}

func newDefaultExecPtyLauncher() ExecPtyLauncher {
	return defaultExecPtyLauncher{systemdRun: systemdRunPath, systemctl: systemctlPath}
}

// Available reports the launcher is usable on this host (linux). The read surface uses it.
func (defaultExecPtyLauncher) Available() bool { return true }

func (l defaultExecPtyLauncher) Start(ctx context.Context, unit transientUnit, cols, rows uint16) (ExecPtyHandle, error) {
	master, slave, err := openPTY()
	if err != nil {
		return nil, &ExecStartError{Code: "capsule_exec_pty_alloc_failed", Err: err}
	}
	if err := setWinsize(master.Fd(), cols, rows); err != nil {
		_ = master.Close()
		_ = slave.Close()
		return nil, &ExecStartError{Code: "capsule_exec_pty_winsize_failed", Err: err}
	}

	args := []string{"--unit", unit.Name, "--collect", "--wait", "--quiet", "--same-dir"}
	for _, property := range unit.Properties {
		args = append(args, "--property="+property.Name+"="+property.Value)
	}
	args = append(args, "--")
	args = append(args, unit.Argv...)

	cmd := exec.CommandContext(ctx, l.systemdRun, args...)
	cmd.Stdin = slave
	cmd.Stdout = slave
	cmd.Stderr = slave
	// Give the unit a fresh session with the pty slave as its controlling terminal, so the interactive
	// shell behaves like a real login terminal (job control, signals, line editing).
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid:  true,
		Setctty: true,
		Ctty:    0, // index into the child's fds: stdin (the slave) is the controlling tty
	}

	if err := cmd.Start(); err != nil {
		_ = master.Close()
		_ = slave.Close()
		return nil, &ExecStartError{Code: "capsule_exec_start_failed", Err: err}
	}
	// The parent no longer needs the slave fd; the child holds its own copies. Closing it here means the
	// master sees EOF once the child closes all its slave fds (i.e. the shell exits).
	_ = slave.Close()

	return &ptyHandle{
		master:    master,
		cmd:       cmd,
		unit:      unit.Name,
		systemctl: l.systemctl,
	}, nil
}

// ptyHandle is the live session: the pty master + the systemd-run process.
type ptyHandle struct {
	master    *os.File
	cmd       *exec.Cmd
	unit      string
	systemctl string

	mu       sync.Mutex
	waited   bool
	exitCode int32
	closed   bool
}

func (h *ptyHandle) Read(p []byte) (int, error)  { return h.master.Read(p) }
func (h *ptyHandle) Write(p []byte) (int, error) { return h.master.Write(p) }

func (h *ptyHandle) Resize(cols, rows uint16) error {
	return setWinsize(h.master.Fd(), cols, rows)
}

func (h *ptyHandle) Unit() string { return h.unit }

func (h *ptyHandle) Wait() (int32, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.waited {
		return h.exitCode, nil
	}
	h.waited = true

	err := h.cmd.Wait()
	if err == nil {
		h.exitCode = 0
		return 0, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		h.exitCode = int32(exitErr.ExitCode())
		return h.exitCode, nil
	}
	// Process never produced a clean exit status (killed by context, signal, etc.). Report a non-zero
	// code so the client sees the session ended, and surface the error for the witness log.
	h.exitCode = -1
	return -1, fmt.Errorf("capsule exec wait: %w", err)
}

func (h *ptyHandle) Close() error {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return nil
	}
	h.closed = true
	h.mu.Unlock()

	// Closing the master sends SIGHUP to the shell's session (the controlling tty went away); systemd-run
	// --collect then reaps the transient unit. Best-effort stop in case the shell ignores the hangup.
	closeErr := h.master.Close()
	if h.cmd.Process != nil {
		_ = h.cmd.Process.Signal(syscall.SIGTERM)
	}
	if h.systemctl != "" && h.unit != "" {
		ctx := context.Background()
		_ = exec.CommandContext(ctx, h.systemctl, "stop", h.unit).Run()
	}
	return closeErr
}

// openPTY allocates a pseudo-terminal master/slave pair.
func openPTY() (master *os.File, slave *os.File, err error) {
	m, err := os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		return nil, nil, fmt.Errorf("open /dev/ptmx: %w", err)
	}
	if err := unlockPT(m.Fd()); err != nil {
		_ = m.Close()
		return nil, nil, err
	}
	sname, err := ptsName(m.Fd())
	if err != nil {
		_ = m.Close()
		return nil, nil, err
	}
	s, err := os.OpenFile(sname, os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		_ = m.Close()
		return nil, nil, fmt.Errorf("open pty slave %s: %w", sname, err)
	}
	return m, s, nil
}

func unlockPT(fd uintptr) error {
	var n uint32 // TIOCSPTLCK = 0 unlocks
	if err := unix.IoctlSetPointerInt(int(fd), unix.TIOCSPTLCK, int(n)); err != nil {
		return fmt.Errorf("unlock pty: %w", err)
	}
	return nil
}

func ptsName(fd uintptr) (string, error) {
	n, err := unix.IoctlGetInt(int(fd), unix.TIOCGPTN)
	if err != nil {
		return "", fmt.Errorf("pts name: %w", err)
	}
	return fmt.Sprintf("/dev/pts/%d", n), nil
}

func setWinsize(fd uintptr, cols, rows uint16) error {
	ws := &unix.Winsize{Col: cols, Row: rows}
	if err := unix.IoctlSetWinsize(int(fd), unix.TIOCSWINSZ, ws); err != nil {
		return fmt.Errorf("set winsize: %w", err)
	}
	return nil
}

// io.EOF is what Read returns once the shell exits; surface it explicitly so the transport's pump loop
// recognizes the end cleanly.
var _ = io.EOF
