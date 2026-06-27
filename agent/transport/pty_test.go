package transport

import (
	"bufio"
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vita/agent/capabilities/capsule"
)

// fakeExecOpener / fakePtyHandle drive the /pty bridge without a real pty or systemd. The handle echoes
// any stdin it receives back as stdout (so a round-trip is observable), records resizes, and exits when
// closed.
type fakeExecOpener struct {
	handle *fakePtyHandle
	err    error

	gotCols uint16
	gotRows uint16
	mu      sync.Mutex
}

func (o *fakeExecOpener) OpenSession(_ context.Context, cols, rows uint16) (capsule.ExecPtyHandle, error) {
	o.mu.Lock()
	o.gotCols = cols
	o.gotRows = rows
	o.mu.Unlock()
	if o.err != nil {
		return nil, o.err
	}
	return o.handle, nil
}

type fakePtyHandle struct {
	unit string

	mu       sync.Mutex
	outbound chan []byte
	resized  [][2]uint16
	closed   bool
}

func newFakePtyHandle(unit string) *fakePtyHandle {
	return &fakePtyHandle{unit: unit, outbound: make(chan []byte, 64)}
}

func (h *fakePtyHandle) Read(p []byte) (int, error) {
	chunk, ok := <-h.outbound
	if !ok {
		return 0, errEOFTest
	}
	n := copy(p, chunk)
	return n, nil
}

func (h *fakePtyHandle) Write(p []byte) (int, error) {
	// Echo stdin back as output (mimics a tty echoing keystrokes).
	cp := make([]byte, len(p))
	copy(cp, p)
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return len(p), nil
	}
	select {
	case h.outbound <- cp:
	default:
	}
	return len(p), nil
}

func (h *fakePtyHandle) Resize(cols, rows uint16) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.resized = append(h.resized, [2]uint16{cols, rows})
	return nil
}

func (h *fakePtyHandle) Wait() (int32, error) { return 0, nil }

func (h *fakePtyHandle) Close() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.closed {
		h.closed = true
		close(h.outbound)
	}
	return nil
}

func (h *fakePtyHandle) Unit() string { return h.unit }

var errEOFTest = &eofError{}

type eofError struct{}

func (*eofError) Error() string { return "EOF" }

// dialPty performs the raw /pty upgrade against a test server and returns the live conn after the 101.
func dialPty(t *testing.T, ts *httptest.Server, query string) (net.Conn, *bufio.Reader) {
	t.Helper()
	addr := strings.TrimPrefix(ts.URL, "http://")
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	req := "GET /pty" + query + " HTTP/1.1\r\nHost: agentd\r\nUpgrade: vita-pty\r\nConnection: Upgrade\r\n\r\n"
	if _, err := conn.Write([]byte(req)); err != nil {
		t.Fatalf("write upgrade: %v", err)
	}
	br := bufio.NewReader(conn)
	status, err := br.ReadString('\n')
	if err != nil {
		t.Fatalf("read status: %v", err)
	}
	if !strings.Contains(status, "101") {
		t.Fatalf("status = %q, want 101", status)
	}
	// Drain the rest of the upgrade response headers up to the blank line.
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			t.Fatalf("read header: %v", err)
		}
		if line == "\r\n" || line == "\n" {
			break
		}
	}
	return conn, br
}

func readFrame(t *testing.T, br *bufio.Reader) (capsule.ExecFrameType, []byte) {
	t.Helper()
	header := make([]byte, capsule.ExecFrameHeaderBytes)
	if _, err := readFull(br, header); err != nil {
		t.Fatalf("read frame header: %v", err)
	}
	length := int(header[1])<<24 | int(header[2])<<16 | int(header[3])<<8 | int(header[4])
	payload := make([]byte, length)
	if length > 0 {
		if _, err := readFull(br, payload); err != nil {
			t.Fatalf("read frame payload: %v", err)
		}
	}
	return capsule.ExecFrameType(header[0]), payload
}

func readFull(br *bufio.Reader, p []byte) (int, error) {
	total := 0
	for total < len(p) {
		n, err := br.Read(p[total:])
		total += n
		if err != nil {
			return total, err
		}
	}
	return total, nil
}

func newPtyHandler(t *testing.T, opener ExecSessionOpener) http.Handler {
	t.Helper()
	registry := mustRegistry(t)
	h, err := NewHandler(Config{
		Registry:   registry,
		ExecOpener: opener,
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	return h
}

// newAuthenticatedPtyServer starts a test server that injects the unix-peer-principal context the
// authenticated unix socket sets in production (UnixPeerConnContext). /pty is unix-socket only, so it
// requires those keys; this lets the TCP-based httptest server stand in for the authenticated socket.
func newAuthenticatedPtyServer(t *testing.T, opener ExecSessionOpener) *httptest.Server {
	t.Helper()
	ts := httptest.NewUnstartedServer(newPtyHandler(t, opener))
	ts.Config.ConnContext = func(ctx context.Context, _ net.Conn) context.Context {
		return contextWithUnixPeerPrincipalKeys(ctx, []string{UnixPeerGroupPrincipalKey(DefaultUnixPeerGroupName)})
	}
	ts.Start()
	return ts
}

func TestPtyStreamsReadyAndEchoesStdin(t *testing.T) {
	handle := newFakePtyHandle("vita-terminal-7.service")
	opener := &fakeExecOpener{handle: handle}
	ts := newAuthenticatedPtyServer(t, opener)
	defer ts.Close()

	conn, br := dialPty(t, ts, "?cols=120&rows=40")
	defer conn.Close()

	// READY frame names the unit.
	typ, payload := readFrame(t, br)
	if typ != capsule.ExecFrameReady {
		t.Fatalf("first frame type = %d, want READY", typ)
	}
	if string(payload) != "vita-terminal-7.service" {
		t.Fatalf("ready unit = %q, want vita-terminal-7.service", payload)
	}

	// Geometry was forwarded.
	opener.mu.Lock()
	gotCols, gotRows := opener.gotCols, opener.gotRows
	opener.mu.Unlock()
	if gotCols != 120 || gotRows != 40 {
		t.Fatalf("opener geometry = %dx%d, want 120x40", gotCols, gotRows)
	}

	// Send a STDIN frame; the fake echoes it back as STDOUT.
	if _, err := conn.Write(capsule.EncodeExecFrame(capsule.ExecFrameStdin, []byte("whoami\n"))); err != nil {
		t.Fatalf("write stdin: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	typ, payload = readFrame(t, br)
	if typ != capsule.ExecFrameStdout {
		t.Fatalf("echo frame type = %d, want STDOUT", typ)
	}
	if string(payload) != "whoami\n" {
		t.Fatalf("echo payload = %q, want whoami\\n", payload)
	}

	// A RESIZE frame is forwarded to the handle.
	if _, err := conn.Write(capsule.EncodeExecFrame(capsule.ExecFrameResize, capsule.EncodeResizePayload(200, 60))); err != nil {
		t.Fatalf("write resize: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		handle.mu.Lock()
		n := len(handle.resized)
		handle.mu.Unlock()
		if n > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("resize never forwarded to handle")
		}
		time.Sleep(10 * time.Millisecond)
	}
	handle.mu.Lock()
	last := handle.resized[len(handle.resized)-1]
	handle.mu.Unlock()
	if last != [2]uint16{200, 60} {
		t.Fatalf("forwarded resize = %v, want [200 60]", last)
	}
}

func TestPtyFailClosedWhenSessionCannotStart(t *testing.T) {
	opener := &fakeExecOpener{err: capsule.ErrExecUnsupported}
	ts := newAuthenticatedPtyServer(t, opener)
	defer ts.Close()

	conn, br := dialPty(t, ts, "")
	defer conn.Close()

	// On a start failure the bridge sends ERROR then EXIT(1) and closes — no half-open session.
	typ, payload := readFrame(t, br)
	if typ != capsule.ExecFrameError {
		t.Fatalf("first frame = %d, want ERROR on start failure", typ)
	}
	if !strings.Contains(string(payload), "capsule.exec not available") {
		t.Fatalf("error payload = %q, want the unsupported message", payload)
	}
	typ, payload = readFrame(t, br)
	if typ != capsule.ExecFrameExit {
		t.Fatalf("second frame = %d, want EXIT", typ)
	}
	code := int32(payload[0])<<24 | int32(payload[1])<<16 | int32(payload[2])<<8 | int32(payload[3])
	if code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
	}
}

func TestPtyNotMountedWithoutOpener(t *testing.T) {
	// No ExecOpener wired ⇒ /pty answers 404 (default-deny by omission).
	ts := httptest.NewServer(newPtyHandler(t, nil))
	defer ts.Close()

	res, err := http.Get(ts.URL + "/pty")
	if err != nil {
		t.Fatalf("GET /pty: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 when no exec opener", res.StatusCode)
	}
}

func TestPtyRefusedWithoutUnixPeerContext(t *testing.T) {
	// A request that did NOT arrive over the authenticated unix socket (no unix-peer-principal keys in
	// context, like the dev TCP face) must be refused 403 — there is no TCP path to an interactive shell.
	opener := &fakeExecOpener{handle: newFakePtyHandle("vita-terminal-9.service")}
	ts := httptest.NewServer(newPtyHandler(t, opener)) // plain server: no ConnContext, no peer keys
	defer ts.Close()

	res, err := http.Get(ts.URL + "/pty")
	if err != nil {
		t.Fatalf("GET /pty: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 for a non-unix /pty request", res.StatusCode)
	}
}
