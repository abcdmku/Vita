package capsule

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/vita/agent/capabilities"
)

// ---- frame codec ----

func TestEncodeDecodeExecFrameRoundTrips(t *testing.T) {
	cases := []struct {
		name    string
		typ     ExecFrameType
		payload []byte
	}{
		{"stdin", ExecFrameStdin, []byte("ls -la\n")},
		{"stdout", ExecFrameStdout, []byte("total 0\r\n")},
		{"empty", ExecFrameReady, nil},
		{"resize", ExecFrameResize, EncodeResizePayload(120, 40)},
		{"exit", ExecFrameExit, EncodeExitPayload(0)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			encoded := EncodeExecFrame(tc.typ, tc.payload)
			typ, payload, consumed, ok, err := DecodeExecFrame(encoded)
			if err != nil {
				t.Fatalf("DecodeExecFrame error = %v", err)
			}
			if !ok {
				t.Fatalf("DecodeExecFrame ok = false, want true")
			}
			if consumed != len(encoded) {
				t.Fatalf("consumed = %d, want %d", consumed, len(encoded))
			}
			if typ != tc.typ {
				t.Fatalf("type = %d, want %d", typ, tc.typ)
			}
			if string(payload) != string(tc.payload) {
				t.Fatalf("payload = %q, want %q", payload, tc.payload)
			}
		})
	}
}

func TestDecodeExecFrameNeedsMoreBytes(t *testing.T) {
	full := EncodeExecFrame(ExecFrameStdout, []byte("hello"))
	// Only a partial frame is available: decode must report ok=false, consumed=0.
	_, _, consumed, ok, err := DecodeExecFrame(full[:4])
	if err != nil {
		t.Fatalf("error = %v, want nil", err)
	}
	if ok || consumed != 0 {
		t.Fatalf("ok=%v consumed=%d, want false/0 for a partial frame", ok, consumed)
	}
}

func TestDecodeExecFrameRejectsOversizedLength(t *testing.T) {
	// Hand-craft a header announcing a length above the cap. Decode must error (caller aborts) and not
	// wait for or allocate the bytes.
	header := make([]byte, ExecFrameHeaderBytes)
	header[0] = byte(ExecFrameStdin)
	header[1] = 0xFF
	header[2] = 0xFF
	header[3] = 0xFF
	header[4] = 0xFF
	if _, _, _, _, err := DecodeExecFrame(header); err == nil {
		t.Fatalf("DecodeExecFrame accepted an oversized announced length, want error")
	}
}

func TestDecodeResizePayloadDefaultsOnShort(t *testing.T) {
	cols, rows := DecodeResizePayload([]byte{0x00})
	if cols != execDefaultCols || rows != execDefaultRows {
		t.Fatalf("short resize = %dx%d, want defaults %dx%d", cols, rows, execDefaultCols, execDefaultRows)
	}
	cols, rows = DecodeResizePayload(EncodeResizePayload(0, 0))
	if cols != execDefaultCols || rows != execDefaultRows {
		t.Fatalf("zero resize = %dx%d, want defaults", cols, rows)
	}
}

// ---- hardened-unit composition ----

func propValues(unit transientUnit, name string) []string {
	var out []string
	for _, p := range unit.Properties {
		if p.Name == name {
			out = append(out, p.Value)
		}
	}
	return out
}

func hasProp(unit transientUnit, name, value string) bool {
	for _, v := range propValues(unit, name) {
		if v == value {
			return true
		}
	}
	return false
}

func TestComposeTerminalUnitIsHardened(t *testing.T) {
	unit := composeTerminalTransientUnit()

	// The fixed, vetted shell argv — no user input in the launch command line.
	if len(unit.Argv) != 2 || unit.Argv[0] != execTerminalShell || unit.Argv[1] != execTerminalShellArg {
		t.Fatalf("argv = %v, want [%s %s]", unit.Argv, execTerminalShell, execTerminalShellArg)
	}

	// The core hardening properties must be present (same set capsule.execute composes).
	mustHave := map[string]string{
		"DynamicUser":           "yes",
		"NoNewPrivileges":       "yes",
		"CapabilityBoundingSet": "",
		"AmbientCapabilities":   "",
		"ProtectSystem":         "strict",
		"ProtectHome":           "yes",
		"PrivateTmp":            "yes",
		"PrivateDevices":        "yes",
		"RestrictNamespaces":    "yes",
		"RestrictSUIDSGID":      "yes",
		"LockPersonality":       "yes",
	}
	for name, value := range mustHave {
		if !hasProp(unit, name, value) {
			t.Fatalf("missing hardening property %s=%q; got %v", name, value, propValues(unit, name))
		}
	}

	// NO network by default: RestrictAddressFamilies must be AF_UNIX (no AF_INET/AF_INET6).
	if !hasProp(unit, "RestrictAddressFamilies", "AF_UNIX") {
		t.Fatalf("RestrictAddressFamilies = %v, want AF_UNIX (no network)", propValues(unit, "RestrictAddressFamilies"))
	}

	// seccomp: @system-service base + the dangerous-class denylist.
	scf := propValues(unit, "SystemCallFilter")
	if !contains(scf, "@system-service") {
		t.Fatalf("SystemCallFilter missing @system-service; got %v", scf)
	}
	deniedFound := false
	for _, v := range scf {
		if strings.Contains(v, "~@privileged") {
			deniedFound = true
		}
		// The deno pkey allowance must NOT be present for /bin/sh (tighter filter).
		if strings.Contains(v, "pkey_alloc") {
			t.Fatalf("terminal unit unexpectedly allows pkey_alloc (deno-only): %v", scf)
		}
	}
	if !deniedFound {
		t.Fatalf("SystemCallFilter missing the ~@privileged denylist; got %v", scf)
	}

	// cgroup gates: the conservative terminal caps.
	if !hasProp(unit, "MemoryMax", "268435456") {
		t.Fatalf("MemoryMax = %v, want 256 MiB", propValues(unit, "MemoryMax"))
	}
	if !hasProp(unit, "TasksMax", "64") {
		t.Fatalf("TasksMax = %v, want 64", propValues(unit, "TasksMax"))
	}
	if len(propValues(unit, "CPUQuota")) != 1 {
		t.Fatalf("CPUQuota = %v, want exactly one", propValues(unit, "CPUQuota"))
	}

	// A private scratch + a clean, host-free environment.
	if !hasProp(unit, "RuntimeDirectory", "vita-terminal") {
		t.Fatalf("missing RuntimeDirectory=vita-terminal")
	}
	envs := propValues(unit, "Environment")
	if len(envs) != 1 || !strings.Contains(envs[0], "TERM=xterm-256color") {
		t.Fatalf("Environment = %v, want a single clean env with TERM", envs)
	}
}

func TestComposeTerminalUnitNamesAreUnique(t *testing.T) {
	a := composeTerminalTransientUnit().Name
	b := composeTerminalTransientUnit().Name
	if a == b {
		t.Fatalf("two terminal units share a name %q (must be unique)", a)
	}
	if !strings.HasPrefix(a, "vita-terminal-") || !strings.HasSuffix(a, ".service") {
		t.Fatalf("unit name %q is not the expected vita-terminal-*.service shape", a)
	}
}

func contains(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}

// ---- capability: read surface + OpenSession fail-closed ----

func TestExecCapabilityReadSurface(t *testing.T) {
	// With the available fake launcher, the read reports available + the streaming endpoint.
	cap := NewExecCapabilityWithLauncher(&fakeLauncher{available: true})
	resp, err := cap.Handle(context.Background(), ExecReadRequest{})
	if err != nil {
		t.Fatalf("Handle error = %v", err)
	}
	read, ok := resp.(ExecReadResponse)
	if !ok {
		t.Fatalf("response = %T, want ExecReadResponse", resp)
	}
	if !read.Available {
		t.Fatalf("Available = false, want true for an available launcher")
	}
	if read.Streaming != "/pty" {
		t.Fatalf("Streaming = %q, want /pty", read.Streaming)
	}
}

func TestExecCapabilityRejectsWrongRequest(t *testing.T) {
	cap := NewExecCapabilityWithLauncher(&fakeLauncher{available: true})
	if _, err := cap.Handle(context.Background(), ExecuteReadRequest{}); err == nil {
		t.Fatalf("Handle accepted a non-ExecReadRequest, want fail-closed error")
	}
}

func TestExecCapabilityOpenSessionSurfacesUnsupported(t *testing.T) {
	// The !linux stub (and a host without systemd) returns ErrExecUnsupported. OpenSession must wrap it
	// in an *ExecStartError with the stable code, fail-closed (no handle).
	cap := NewExecCapabilityWithLauncher(&fakeLauncher{startErr: ErrExecUnsupported})
	handle, err := cap.OpenSession(context.Background(), 80, 24)
	if handle != nil {
		t.Fatalf("handle = %v, want nil on unsupported", handle)
	}
	var startErr *ExecStartError
	if !errors.As(err, &startErr) {
		t.Fatalf("error = %v, want *ExecStartError", err)
	}
	if startErr.Code != "capsule_exec_unsupported" {
		t.Fatalf("code = %q, want capsule_exec_unsupported", startErr.Code)
	}
	if !errors.Is(err, ErrExecUnsupported) {
		t.Fatalf("error does not wrap ErrExecUnsupported")
	}
}

func TestExecCapabilityOpenSessionStartsAndPassesGeometry(t *testing.T) {
	fake := &fakeLauncher{available: true, handle: &fakeHandle{unit: "vita-terminal-1.service"}}
	cap := NewExecCapabilityWithLauncher(fake)
	handle, err := cap.OpenSession(context.Background(), 132, 50)
	if err != nil {
		t.Fatalf("OpenSession error = %v", err)
	}
	if handle == nil {
		t.Fatalf("handle = nil, want a session")
	}
	if fake.gotCols != 132 || fake.gotRows != 50 {
		t.Fatalf("launcher geometry = %dx%d, want 132x50", fake.gotCols, fake.gotRows)
	}
	// The composed unit handed to the launcher must be the hardened terminal unit.
	if !hasProp(fake.gotUnit, "DynamicUser", "yes") {
		t.Fatalf("launcher unit is not hardened (no DynamicUser=yes)")
	}
	if handle.Unit() != "vita-terminal-1.service" {
		t.Fatalf("Unit = %q, want the launcher's unit name", handle.Unit())
	}
}

func TestExecCapabilityOpenSessionNilLauncherFailsClosed(t *testing.T) {
	cap := &ExecCapability{launcher: nil}
	if _, err := cap.OpenSession(context.Background(), 80, 24); err == nil {
		t.Fatalf("OpenSession with nil launcher accepted, want fail-closed")
	}
}

// Compile-time: the capability satisfies the registry Capability interface.
var _ capabilities.Capability = (*ExecCapability)(nil)

// ---- fakes ----

type fakeLauncher struct {
	available bool
	handle    ExecPtyHandle
	startErr  error

	gotUnit transientUnit
	gotCols uint16
	gotRows uint16
}

func (f *fakeLauncher) Start(_ context.Context, unit transientUnit, cols, rows uint16) (ExecPtyHandle, error) {
	f.gotUnit = unit
	f.gotCols = cols
	f.gotRows = rows
	if f.startErr != nil {
		return nil, f.startErr
	}
	return f.handle, nil
}

func (f *fakeLauncher) Available() bool { return f.available }

type fakeHandle struct {
	unit string
}

func (h *fakeHandle) Read(_ []byte) (int, error)  { return 0, io.EOF }
func (h *fakeHandle) Write(p []byte) (int, error)  { return len(p), nil }
func (h *fakeHandle) Resize(_, _ uint16) error     { return nil }
func (h *fakeHandle) Wait() (int32, error)         { return 0, nil }
func (h *fakeHandle) Close() error                 { return nil }
func (h *fakeHandle) Unit() string                 { return h.unit }
