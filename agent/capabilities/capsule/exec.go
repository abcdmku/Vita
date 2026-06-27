package capsule

// capsule.exec — the PTY-backed, hardened, owner-gated INTERACTIVE exec surface that powers the
// on-device Terminal. Distinct from capsule.execute (which launches a FIXED-entrypoint installed
// capsule as a one-shot /apply transaction): capsule.exec runs an ARBITRARY interactive command WITH A
// TTY inside a one-shot hardened transient unit and streams stdin/stdout/window-resize for the life of
// the session. It REUSES the same hardening primitives as capsule.execute (hardenedTransientUnit
// properties + the cgroup gates), so the isolation guarantee is identical: a command cannot reach owner
// files / other capsules / secrets / the host fs / the network, and cannot escalate. See CAPSULE-EXEC.md.
//
// This file is CROSS-PLATFORM: the capability, the hardened-unit composition, the wire-frame codec, and
// the gating are pure and testable on any OS. The real PTY launcher (allocating a pty + running
// systemd-run against the slave) is linux-only and injected (exec_pty_linux.go / exec_pty_other.go), so
// the dangerous on-device path is build-tagged while the composition + codec + fail-closed behaviour are
// unit-tested everywhere.

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"strconv"
	"sync/atomic"

	"github.com/vita/agent/capabilities"
)

// execUnitNonce returns a process-unique nonce for the transient unit name. A simple atomic counter
// seeded from the pid keeps names unique within a run (systemd rejects a duplicate active unit name).
// Cross-platform so composeTerminalTransientUnit (and its tests) build on any OS.
var execNonceCounter uint64

func execUnitNonce() int64 {
	n := atomic.AddUint64(&execNonceCounter, 1)
	return int64(os.Getpid())*100000 + int64(n)
}

// ExecName is the read-only registry name for the interactive exec capability. It is registered so the
// surface appears in /state and is consistently named, but it is NOT a transaction capability: there is
// no /apply for it. The interactive session is driven over the transport's streaming /pty endpoint
// (transport/pty.go), which dispatches to OpenSession below — never through the buffered request path.
const ExecName = "capsule.exec"

// The hardened resource floor for an interactive terminal capsule. Conservative on purpose: a terminal
// is for the owner to poke at the node, not to run heavy workloads, so a runaway command is throttled by
// the cgroup long before it can disturb the host. These mirror the units capsule.execute composes.
const (
	execTerminalMemoryMaxBytes int64 = 256 * 1024 * 1024 // MemoryMax: 256 MiB
	execTerminalCPUQuotaCores        = 0.5               // CPUQuota: 50% of one core
	execTerminalTasksMax       int64 = 64                // TasksMax: 64 (a fork-bomb is capped here)

	// The interactive shell the terminal runs. A fixed, vetted argv — the USER's keystrokes are written
	// to the pty master as stdin, never interpolated into this command line, so the launcher has no
	// command-injection surface. `-i` is an interactive shell; the pty makes it line-buffered + job-aware.
	execTerminalShell    = "/bin/sh"
	execTerminalShellArg = "-i"

	// Default terminal geometry until the client sends its first resize.
	execDefaultCols uint16 = 80
	execDefaultRows uint16 = 24
)

// ---------------------------------------------------------------------------------------------
// Wire frames (shared with transport/pty.go and the TS host-proxy). A frame is:
//   uint8 type | uint32be length | length bytes payload
// ---------------------------------------------------------------------------------------------

type ExecFrameType uint8

const (
	ExecFrameStdin  ExecFrameType = 0x01 // client→agentd: raw bytes → pty master
	ExecFrameResize ExecFrameType = 0x02 // client→agentd: uint16be cols | uint16be rows
	ExecFrameStdout ExecFrameType = 0x03 // agentd→client: raw pty output
	ExecFrameExit   ExecFrameType = 0x04 // agentd→client: int32be exit code
	ExecFrameError  ExecFrameType = 0x05 // agentd→client: utf-8 message
	ExecFrameReady  ExecFrameType = 0x06 // agentd→client: utf-8 runtime label (unit name)
)

// ExecFrameHeaderBytes is the fixed header size (1 type + 4 length).
const ExecFrameHeaderBytes = 5

// ExecMaxFramePayloadBytes bounds a single decoded frame so a hostile peer cannot announce a huge length
// and force a large allocation. Generous for a terminal (a paste), still a hard ceiling.
const ExecMaxFramePayloadBytes = 1 << 20 // 1 MiB

// EncodeExecFrame serializes one frame. payload may be nil/empty.
func EncodeExecFrame(t ExecFrameType, payload []byte) []byte {
	out := make([]byte, ExecFrameHeaderBytes+len(payload))
	out[0] = byte(t)
	binary.BigEndian.PutUint32(out[1:5], uint32(len(payload)))
	copy(out[5:], payload)
	return out
}

// DecodeExecFrame decodes ONE frame from buf. It returns the frame type, payload (a copy), the number of
// bytes consumed, and ok. ok is false (consumed 0) when buf does not yet hold a complete frame — the
// caller reads more and retries. An announced length over the cap returns an error so the caller can
// abort the connection rather than allocate.
func DecodeExecFrame(buf []byte) (t ExecFrameType, payload []byte, consumed int, ok bool, err error) {
	if len(buf) < ExecFrameHeaderBytes {
		return 0, nil, 0, false, nil
	}
	length := binary.BigEndian.Uint32(buf[1:5])
	if length > ExecMaxFramePayloadBytes {
		return 0, nil, 0, false, fmt.Errorf("capsule exec frame length %d exceeds %d", length, ExecMaxFramePayloadBytes)
	}
	total := ExecFrameHeaderBytes + int(length)
	if len(buf) < total {
		return 0, nil, 0, false, nil
	}
	p := make([]byte, length)
	copy(p, buf[ExecFrameHeaderBytes:total])
	return ExecFrameType(buf[0]), p, total, true, nil
}

// DecodeResizePayload reads a RESIZE payload (uint16be cols | uint16be rows). A short payload yields the
// defaults rather than an error (a malformed resize must never kill the session).
func DecodeResizePayload(payload []byte) (cols, rows uint16) {
	if len(payload) < 4 {
		return execDefaultCols, execDefaultRows
	}
	cols = binary.BigEndian.Uint16(payload[0:2])
	rows = binary.BigEndian.Uint16(payload[2:4])
	if cols == 0 {
		cols = execDefaultCols
	}
	if rows == 0 {
		rows = execDefaultRows
	}
	return cols, rows
}

// EncodeExitPayload / EncodeResizePayload are the small encoders the transport + tests share.
func EncodeExitPayload(code int32) []byte {
	p := make([]byte, 4)
	binary.BigEndian.PutUint32(p, uint32(code))
	return p
}

func EncodeResizePayload(cols, rows uint16) []byte {
	p := make([]byte, 4)
	binary.BigEndian.PutUint16(p[0:2], cols)
	binary.BigEndian.PutUint16(p[2:4], rows)
	return p
}

// ---------------------------------------------------------------------------------------------
// The PTY launcher seam. The capability composes a hardened transientUnit and hands it to a launcher
// that allocates a pty, runs the unit's argv against the slave (DynamicUser + the full hardening), and
// returns a live session. Injected so the capability is testable with a fake (no systemd / no pty) and
// the real linux launcher stays build-tagged.
// ---------------------------------------------------------------------------------------------

// ExecPtyHandle is a live PTY-backed hardened-capsule session. The transport pumps bytes both ways and
// forwards resizes; it Closes the handle when the client disconnects.
type ExecPtyHandle interface {
	// Read pulls the next chunk of pty output (stdout+stderr merged, as a tty does). It returns io.EOF
	// when the command exits.
	Read(p []byte) (int, error)
	// Write sends client keystrokes to the pty master (the command's stdin).
	Write(p []byte) (int, error)
	// Resize updates the pty window size (TIOCSWINSZ).
	Resize(cols, rows uint16) error
	// Wait blocks until the command exits and returns its exit code (or an error if it never started
	// cleanly). Safe to call once after Read returns EOF.
	Wait() (exitCode int32, err error)
	// Close tears down the transient unit + frees the pty. Idempotent.
	Close() error
	// Unit is the systemd transient unit name the session runs as (the READY label / provenance).
	Unit() string
}

// ExecPtyLauncher allocates a pty and starts the hardened unit against it. The production impl
// (exec_pty_linux.go) uses x/sys/unix + systemd-run; the !linux stub returns ErrExecUnsupported; tests
// inject a fake.
type ExecPtyLauncher interface {
	Start(ctx context.Context, unit transientUnit, cols, rows uint16) (ExecPtyHandle, error)
}

// ErrExecUnsupported is returned by the !linux launcher stub and surfaced as a clean ERROR frame so a
// dev/Windows host fails closed with an operator-actionable message instead of panicking.
var ErrExecUnsupported = errors.New("capsule.exec requires a linux node with systemd + a pty (not available on this host)")

// ExecStartError wraps a launch failure with a stable apply-error-style code for the witness logs.
type ExecStartError struct {
	Code string
	Err  error
}

func (e *ExecStartError) Error() string {
	if e == nil {
		return "capsule exec start failed"
	}
	if e.Err == nil {
		return e.Code
	}
	return fmt.Sprintf("%s: %v", e.Code, e.Err)
}

func (e *ExecStartError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

// ---------------------------------------------------------------------------------------------
// The capability.
// ---------------------------------------------------------------------------------------------

// ExecCapability is the interactive exec surface. It is a read-only registry entry (so it shows in
// /state and is consistently named) PLUS the OpenSession entry the streaming /pty transport dispatches
// to. It never registers an Apply — it is not a transaction.
type ExecCapability struct {
	launcher ExecPtyLauncher
}

// NewExecCapability builds the production capability backed by the real (linux) PTY launcher.
func NewExecCapability() *ExecCapability {
	return &ExecCapability{launcher: newDefaultExecPtyLauncher()}
}

// NewExecCapabilityWithLauncher injects a launcher (tests / a future alternate runtime).
func NewExecCapabilityWithLauncher(launcher ExecPtyLauncher) *ExecCapability {
	return &ExecCapability{launcher: launcher}
}

func (c *ExecCapability) Name() string { return ExecName }

// ExecReadRequest / ExecReadResponse are the read surface so capsule.exec appears in /state. The read is
// intentionally inert (the interactive surface has no persisted "last" state) — it answers a small,
// stable availability record so the console/state projection has a well-formed entry.
type ExecReadRequest struct{}

func (ExecReadRequest) CapabilityRequest() {}

func (ExecReadRequest) Validate() error { return nil }

type ExecReadResponse struct {
	// Available reports whether the on-device PTY launcher is usable on this host (true on a linux node,
	// false on the dev/Windows host where the launcher is the stub). Lets a caller see, without opening a
	// session, whether the real terminal backend is live here.
	Available bool `json:"available"`
	// Streaming names the transport endpoint the interactive session uses (provenance; it is not the
	// buffered request path).
	Streaming string `json:"streaming"`
}

func (ExecReadResponse) CapabilityResponse() {}

// Handle answers the read surface only. The interactive session never flows through Handle — it is
// dispatched by the streaming /pty transport to OpenSession. A non-read request is rejected fail-closed.
func (c *ExecCapability) Handle(ctx context.Context, req capabilities.TypedRequest) (capabilities.TypedResponse, error) {
	if _, ok := req.(ExecReadRequest); !ok {
		return nil, &ExecuteInvalidRequestError{Reason: "expected capsule.ExecReadRequest", Code: "capsule_exec_rejected"}
	}
	if c == nil {
		return nil, &ExecuteInvalidRequestError{Reason: "missing capsule exec capability", Code: "capsule_exec_rejected"}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return ExecReadResponse{Available: execLauncherAvailable(c.launcher), Streaming: "/pty"}, nil
}

// OpenSession composes a hardened terminal unit and starts an interactive PTY session against it. This
// is the entry the streaming /pty transport calls AFTER the peer-cred gate has authenticated the caller.
// It is fail-closed: any composition/launch error returns an *ExecStartError (the transport sends it to
// the client as an ERROR frame and closes; no half-open session leaks).
func (c *ExecCapability) OpenSession(ctx context.Context, cols, rows uint16) (ExecPtyHandle, error) {
	if c == nil || c.launcher == nil {
		return nil, &ExecStartError{Code: "capsule_exec_unconfigured", Err: errors.New("missing capsule exec launcher")}
	}
	if cols == 0 {
		cols = execDefaultCols
	}
	if rows == 0 {
		rows = execDefaultRows
	}

	unit := composeTerminalTransientUnit()

	handle, err := c.launcher.Start(ctx, unit, cols, rows)
	if err != nil {
		if errors.Is(err, ErrExecUnsupported) {
			return nil, &ExecStartError{Code: "capsule_exec_unsupported", Err: err}
		}
		return nil, &ExecStartError{Code: "capsule_exec_start_failed", Err: err}
	}
	return handle, nil
}

// composeTerminalTransientUnit builds the one-shot hardened unit the interactive shell runs in. It
// REUSES hardenedTransientUnitProperties (the SAME property set capsule.execute uses) so the isolation
// guarantee is identical, then pins the conservative terminal cgroup gates and the fixed shell argv.
// NO network is granted (Network=nil → RestrictAddressFamilies=AF_UNIX), so the command cannot reach the
// network — the strict floor.
func composeTerminalTransientUnit() transientUnit {
	// A synthetic manifest carrying only what the hardened-property composition reads (an id for the
	// Description + a nil Network for the no-network default). The terminal is not an installed capsule,
	// so it has no registry entry/integrity — it is a transient, owner-driven shell.
	manifest := ExecutionManifest{ID: "vita-terminal", Network: nil}

	// includeDenoPkey=false: this is /bin/sh, not the Deno runtime, so the deno pkey_* syscall allowance
	// is not needed (keeping the seccomp filter as tight as possible).
	properties := hardenedTransientUnitProperties(manifest, false)
	properties = append(properties,
		systemdProperty{Name: "MemoryMax", Value: strconv.FormatInt(execTerminalMemoryMaxBytes, 10)},
		systemdProperty{Name: "CPUQuota", Value: cpuQuota(execTerminalCPUQuotaCores)},
		systemdProperty{Name: "TasksMax", Value: strconv.FormatInt(execTerminalTasksMax, 10)},
		// A private per-session runtime dir for the shell's scratch (the only writable location;
		// ProtectSystem=strict makes everything else read-only).
		systemdProperty{Name: "RuntimeDirectory", Value: "vita-terminal"},
		systemdProperty{Name: "RuntimeDirectoryMode", Value: "0700"},
		// A clean, minimal environment — no host env leaks into the shell.
		systemdProperty{Name: "Environment", Value: "TERM=xterm-256color HOME=/run/vita-terminal PATH=/usr/bin:/bin"},
	)

	return transientUnit{
		Name:       execTerminalUnitName(),
		Argv:       []string{execTerminalShell, execTerminalShellArg},
		Properties: properties,
	}
}

// execTerminalUnitName returns a unique transient unit name for this session. systemd-run also requires
// uniqueness; the launcher may further uniquify, but a per-session name keeps the witness logs readable.
func execTerminalUnitName() string {
	return "vita-terminal-" + strconv.FormatInt(execUnitNonce(), 10) + ".service"
}

func execLauncherAvailable(launcher ExecPtyLauncher) bool {
	avail, ok := launcher.(interface{ Available() bool })
	if !ok {
		return false
	}
	return avail.Available()
}
