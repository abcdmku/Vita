package transport

// The STREAMING /pty endpoint — the one duplex surface on agentd's unix socket.
//
// agentd's normal surface is buffered request/response. An interactive terminal needs full-duplex byte
// streaming for the life of the session, which does not fit that model. /pty is therefore a dedicated
// streaming endpoint: a caller sends `GET /pty?cols=&rows=` with `Upgrade: vita-pty`, agentd replies
// `101 Switching Protocols`, HIJACKS the connection, opens a hardened PTY-backed capsule session through
// capsule.ExecCapability.OpenSession, and pumps length-prefixed frames both ways until the shell exits
// or the client disconnects.
//
// AUTH: this handler is reachable ONLY over the unix socket, which is SO_PEERCRED-authenticated to the
// vita-agent group at Accept() (the platform process). A peer not in that group never reaches here — the
// same gate as every other agentd surface. There is no TCP /pty (the dev TCP face does not need it and
// must never expose an interactive shell). The handler is mounted only when an ExecSessionOpener is wired.
//
// Frames (capsule.EncodeExecFrame / DecodeExecFrame): uint8 type | uint32be len | payload.
//   client→agentd: STDIN(0x01) raw → pty, RESIZE(0x02) uint16be cols|rows
//   agentd→client: READY(0x06) unit-name, STDOUT(0x03) raw, EXIT(0x04) int32be code, ERROR(0x05) msg

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"sync"

	"github.com/vita/agent/capabilities/capsule"
)

// ExecSessionOpener is the narrow seam the transport needs from the capsule.exec capability: open a
// hardened PTY-backed session at a starting geometry. *capsule.ExecCapability satisfies it. Optional in
// Config: nil ⇒ /pty is NOT mounted (the route 404s) — default-deny by omission, exactly like the rest of
// the optional surfaces.
type ExecSessionOpener interface {
	OpenSession(ctx context.Context, cols, rows uint16) (capsule.ExecPtyHandle, error)
}

// ptyReadBufBytes is the per-read chunk pulled from the pty master before it is framed to the client.
const ptyReadBufBytes = 32 * 1024

// ptyMaxInboundBufferBytes bounds the inbound reassembly buffer so a client that streams bytes without
// ever completing a frame cannot grow it unbounded.
const ptyMaxInboundBufferBytes = capsule.ExecFrameHeaderBytes + capsule.ExecMaxFramePayloadBytes

// handlePTY upgrades a /pty request to a duplex stream and bridges it to a hardened capsule session.
func (h *handler) handlePTY(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	if h.execOpener == nil {
		writeError(w, http.StatusNotFound, "not_found", "pty not available")
		return
	}

	// UNIX-SOCKET ONLY. The interactive shell is the most privileged surface agentd exposes, so it is
	// reachable ONLY over the SO_PEERCRED-authenticated unix socket (which sets the unix-peer-principal
	// keys on the request context). The dev TCP face (VITA_AGENT_DEV_TCP=1, loopback-only diagnostics)
	// does NOT set those keys, so a /pty request that arrives without them is refused — there is no TCP
	// path to an interactive shell, even on the dev face.
	if _, ok := unixPeerPrincipalKeysFromContext(r.Context()); !ok {
		writeError(w, http.StatusForbidden, "pty_unix_only", "pty is available only over the authenticated local socket")
		return
	}

	hijacker, ok := w.(http.Hijacker)
	if !ok {
		writeError(w, http.StatusInternalServerError, "pty_unsupported", "connection does not support streaming")
		return
	}

	cols := parseGeometry(r.URL.Query().Get("cols"), 80)
	rows := parseGeometry(r.URL.Query().Get("rows"), 24)

	conn, brw, err := hijacker.Hijack()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "pty_hijack_failed", "could not hijack connection")
		return
	}
	defer func() { _ = conn.Close() }()

	// From here the response is RAW bytes on the hijacked conn (no http.ResponseWriter). Complete the
	// upgrade handshake, then open the session and pump frames.
	if _, err := brw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: vita-pty\r\nConnection: Upgrade\r\n\r\n"); err != nil {
		return
	}
	if err := brw.Flush(); err != nil {
		return
	}

	session, err := h.execOpener.OpenSession(r.Context(), cols, rows)
	if err != nil {
		// Fail closed: send an ERROR frame + EXIT(1), then close. No half-open session.
		writeFrame(brw, capsule.ExecFrameError, []byte(execErrorMessage(err)))
		writeFrame(brw, capsule.ExecFrameExit, capsule.EncodeExitPayload(1))
		_ = brw.Flush()
		return
	}
	defer func() { _ = session.Close() }()

	// READY: name the unit so the client can print a provenance banner.
	if err := writeFrame(brw, capsule.ExecFrameReady, []byte(session.Unit())); err != nil {
		return
	}
	if err := brw.Flush(); err != nil {
		return
	}

	bridgePtySession(conn, brw, session)
}

// bridgePtySession runs the two pump loops: pty output → STDOUT frames, and inbound frames → pty
// stdin/resize. It returns once either side ends, then sends EXIT.
func bridgePtySession(conn net.Conn, brw *bufio.ReadWriter, session capsule.ExecPtyHandle) {
	var writeMu sync.Mutex
	safeFrame := func(t capsule.ExecFrameType, payload []byte) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		if err := writeFrame(brw, t, payload); err != nil {
			return err
		}
		return brw.Flush()
	}

	done := make(chan struct{})
	var once sync.Once
	finish := func() { once.Do(func() { close(done) }) }

	// Reader pump: pty output → STDOUT frames.
	go func() {
		defer finish()
		buf := make([]byte, ptyReadBufBytes)
		for {
			n, err := session.Read(buf)
			if n > 0 {
				if writeErr := safeFrame(capsule.ExecFrameStdout, buf[:n]); writeErr != nil {
					return
				}
			}
			if err != nil {
				return // io.EOF (shell exited) or a read error
			}
		}
	}()

	// Writer pump: inbound frames → pty stdin / resize. A read error / EOF on the client side ends it.
	go func() {
		defer finish()
		inbound := make([]byte, 0, ptyReadBufBytes)
		tmp := make([]byte, ptyReadBufBytes)
		for {
			// Drain any complete frames already buffered.
			for {
				t, payload, consumed, ok, decErr := capsule.DecodeExecFrame(inbound)
				if decErr != nil {
					return // oversized announced length → abort
				}
				if !ok {
					break // need more bytes
				}
				inbound = inbound[consumed:]
				switch t {
				case capsule.ExecFrameStdin:
					if _, err := session.Write(payload); err != nil {
						return
					}
				case capsule.ExecFrameResize:
					cols, rows := capsule.DecodeResizePayload(payload)
					_ = session.Resize(cols, rows)
				default:
					// ignore unknown/agentd→client types arriving from the client
				}
			}
			if len(inbound) > ptyMaxInboundBufferBytes {
				return // reassembly buffer overflow → abort
			}

			n, err := brw.Read(tmp)
			if n > 0 {
				inbound = append(inbound, tmp[:n]...)
			}
			if err != nil {
				return // client closed
			}
		}
	}()

	<-done

	// The session ended (shell exited or client dropped). Reap the exit code and send EXIT, best-effort.
	code, _ := session.Wait()
	_ = safeFrame(capsule.ExecFrameExit, capsule.EncodeExitPayload(code))
	_ = conn.Close()
}

func writeFrame(w io.Writer, t capsule.ExecFrameType, payload []byte) error {
	_, err := w.Write(capsule.EncodeExecFrame(t, payload))
	return err
}

func parseGeometry(value string, fallback uint16) uint16 {
	if value == "" {
		return fallback
	}
	n, err := strconv.ParseUint(value, 10, 16)
	if err != nil || n == 0 {
		return fallback
	}
	return uint16(n)
}

func execErrorMessage(err error) string {
	if err == nil {
		return "capsule exec failed"
	}
	if errors.Is(err, capsule.ErrExecUnsupported) {
		return "capsule.exec not available on this node (requires linux + systemd + pty)"
	}
	return "capsule exec could not start: " + err.Error()
}
