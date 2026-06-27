// CONTRACT test for the on-device capsule.exec forwarding (no VM, no agentd).
//
// Proves the TS half of the production terminal wiring against the SAME wire shapes agentd speaks:
//   1. The host-proxy duplex stream (createAgentdPtyStream) performs the /pty unix-socket upgrade, then
//      reassembles + dispatches length-prefixed frames — against a FAKE Deno unix conn that emulates
//      agentd's transport/pty.go (sends 101, a READY frame, echoes STDIN as STDOUT, then EXIT).
//   2. The production backend (createAgentExecBackend) bridges the api_origin's JSON /pty websocket
//      protocol ({t:"stdin"|"resize"|"signal"} ⇄ {t:"ready"|"stdout"|"exit"|"error"}) to those frames.
//
// The frame format here MUST match agent/capabilities/capsule/exec.go (uint8 type | uint32be len | data)
// and the Go transport test (transport/pty_test.go) drives the SAME shapes from the agentd side — so the
// two ends are proven against one contract.
//
// Run: node --experimental-strip-types ui_kits/desktop/runtime/puter/spike/contract-capsule-exec.ts

import { createAgentdPtyStream, encodePtyFrame, encodeResizePayload } from "../server/agentd-host-proxy.ts";
import { createAgentExecBackend, type ExecServerMessage, type PtyFrameStream } from "../exec-plane.ts";

const PTY_FRAME_STDIN = 0x01;
const PTY_FRAME_RESIZE = 0x02;
const PTY_FRAME_STDOUT = 0x03;
const PTY_FRAME_EXIT = 0x04;
const PTY_FRAME_READY = 0x06;

interface Check { readonly name: string; readonly ok: boolean; readonly detail: string }
const checks: Check[] = [];
const record = (name: string, ok: boolean, detail = ""): void => {
  checks.push({ detail, name, ok });
  console.log(`[contract-capsule-exec] ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// ── A FAKE Deno unix conn that emulates agentd's /pty endpoint ───────────────────────────────────────
// It accepts the upgrade request, replies 101, sends a READY frame, then echoes any STDIN frame it
// receives back as a STDOUT frame and records resizes. This mirrors transport/pty_test.go's fake handle.
class FakeAgentdPtyConn {
  private readonly outbox: Uint8Array[] = [];
  private resolveRead: ((v: number | null) => void) | undefined;
  private inbound: Uint8Array = new Uint8Array(0);
  private upgraded = false;
  public closed = false;
  public readonly resizes: [number, number][] = [];

  // Queue bytes for the client to read and wake a pending read.
  private push(bytes: Uint8Array): void {
    this.outbox.push(bytes);
    if (this.resolveRead !== undefined) {
      const r = this.resolveRead;
      this.resolveRead = undefined;
      this.deliver(r);
    }
  }

  private deliver(resolve: (v: number | null) => void): void {
    const chunk = this.outbox.shift();
    if (chunk === undefined) { resolve(0); return; }
    this.pendingChunk = chunk;
    resolve(chunk.length);
  }

  private pendingChunk: Uint8Array | undefined;

  async read(p: Uint8Array): Promise<number | null> {
    if (this.pendingChunk !== undefined) {
      const n = this.copyOut(p);
      return n;
    }
    if (this.outbox.length > 0) {
      this.pendingChunk = this.outbox.shift();
      return this.copyOut(p);
    }
    if (this.closed) return null;
    return await new Promise<number | null>((resolve) => {
      this.resolveRead = (v) => {
        if (this.pendingChunk !== undefined) { resolve(this.copyOut(p)); return; }
        resolve(v);
      };
    });
  }

  private copyOut(p: Uint8Array): number {
    const chunk = this.pendingChunk!;
    const n = Math.min(p.length, chunk.length);
    p.set(chunk.subarray(0, n));
    if (n < chunk.length) this.pendingChunk = chunk.subarray(n);
    else this.pendingChunk = undefined;
    return n;
  }

  async write(p: Uint8Array): Promise<number> {
    this.inbound = concat(this.inbound, p);
    if (!this.upgraded) {
      const headerEnd = indexOfCRLFCRLF(this.inbound);
      if (headerEnd < 0) return p.length;
      this.upgraded = true;
      this.inbound = this.inbound.subarray(headerEnd + 4);
      // Reply: 101 + READY frame naming the unit.
      this.push(new TextEncoder().encode("HTTP/1.1 101 Switching Protocols\r\nUpgrade: vita-pty\r\nConnection: Upgrade\r\n\r\n"));
      this.push(encodePtyFrame(PTY_FRAME_READY, new TextEncoder().encode("vita-terminal-1.service")));
    }
    // Drain client frames: echo STDIN as STDOUT, record RESIZE.
    for (;;) {
      if (this.inbound.length < 5) break;
      const len = (this.inbound[1]! << 24) | (this.inbound[2]! << 16) | (this.inbound[3]! << 8) | this.inbound[4]!;
      if (this.inbound.length < 5 + len) break;
      const type = this.inbound[0]!;
      const payload = this.inbound.subarray(5, 5 + len);
      if (type === PTY_FRAME_STDIN) {
        this.push(encodePtyFrame(PTY_FRAME_STDOUT, payload.slice()));
      } else if (type === PTY_FRAME_RESIZE && len >= 4) {
        this.resizes.push([(payload[0]! << 8) | payload[1]!, (payload[2]! << 8) | payload[3]!]);
      }
      this.inbound = this.inbound.subarray(5 + len);
    }
    return p.length;
  }

  close(): void {
    this.closed = true;
    if (this.resolveRead !== undefined) { const r = this.resolveRead; this.resolveRead = undefined; r(null); }
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}
function indexOfCRLFCRLF(buf: Uint8Array): number {
  for (let i = 0; i + 3 < buf.length; i += 1) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) return i;
  }
  return -1;
}

async function main(): Promise<void> {
  // ── 1. host-proxy duplex stream against the fake agentd conn ──
  {
    const conn = new FakeAgentdPtyConn();
    const deno = { connect: async () => conn };
    const stream = await createAgentdPtyStream({ socketPath: "/fake", cols: 100, rows: 30, deno });

    const frames: { type: number; text: string }[] = [];
    stream.onFrame((f) => frames.push({ type: f.type, text: new TextDecoder().decode(f.payload) }));

    await waitFor(() => frames.some((f) => f.type === PTY_FRAME_READY), 1000);
    const ready = frames.find((f) => f.type === PTY_FRAME_READY);
    record("host-proxy: upgrade + READY frame", ready?.text === "vita-terminal-1.service", `ready=${ready?.text ?? "none"}`);

    stream.send(PTY_FRAME_STDIN, new TextEncoder().encode("echo hi\n"));
    await waitFor(() => frames.some((f) => f.type === PTY_FRAME_STDOUT), 1000);
    const out = frames.find((f) => f.type === PTY_FRAME_STDOUT);
    record("host-proxy: STDIN echoes back as STDOUT frame", out?.text === "echo hi\n", `stdout=${JSON.stringify(out?.text)}`);

    stream.send(PTY_FRAME_RESIZE, encodeResizePayload(180, 50));
    await waitFor(() => conn.resizes.length > 0, 1000);
    record("host-proxy: RESIZE frame forwarded", conn.resizes.length === 1 && conn.resizes[0]![0] === 180 && conn.resizes[0]![1] === 50, `resizes=${JSON.stringify(conn.resizes)}`);

    let closedFired = false;
    stream.onClose(() => { closedFired = true; });
    stream.close();
    await waitFor(() => closedFired, 1000);
    record("host-proxy: onClose fires on stream close", closedFired);
  }

  // ── 2. the production backend bridges JSON ⇄ frames ──
  {
    const conn = new FakeAgentdPtyConn();
    const deno = { connect: async () => conn };
    const backend = createAgentExecBackend({
      openStream: (geom) => createAgentdPtyStream({ socketPath: "/fake", cols: geom.cols, rows: geom.rows, deno }),
    });

    record("backend: label is agentd-capsule", backend.label === "agentd-capsule", `label=${backend.label}`);

    const emitted: ExecServerMessage[] = [];
    const session = backend.open((m) => emitted.push(m), { appId: "vita.terminal", appInstanceId: "i1", ownerUsername: "owner" });

    await waitFor(() => emitted.some((m) => m.t === "ready"), 1000);
    const readyMsg = emitted.find((m) => m.t === "ready");
    record("backend: emits READY (runtime named) from the stream", readyMsg?.t === "ready" && readyMsg.runtime === "agentd-capsule", `runtime=${readyMsg?.t === "ready" ? readyMsg.runtime : "none"}`);

    // A JSON stdin message → STDIN frame → echoed STDOUT frame → JSON stdout message.
    session.send({ t: "stdin", data: "whoami\n" });
    await waitFor(() => emitted.some((m) => m.t === "stdout" && m.data.includes("whoami")), 1000);
    const stdoutMsg = emitted.find((m) => m.t === "stdout");
    record("backend: JSON stdin → frame → JSON stdout round-trips", stdoutMsg?.t === "stdout" && stdoutMsg.data === "whoami\n", `stdout=${JSON.stringify(stdoutMsg?.t === "stdout" ? stdoutMsg.data : null)}`);

    // A JSON resize message → RESIZE frame.
    session.send({ t: "resize", cols: 132, rows: 43 });
    await waitFor(() => conn.resizes.length > 0, 1000);
    record("backend: JSON resize → RESIZE frame", conn.resizes.some((r) => r[0] === 132 && r[1] === 43), `resizes=${JSON.stringify(conn.resizes)}`);

    // SIGINT → a 0x03 (Ctrl-C) STDIN byte, echoed back.
    const beforeCtrlC = emitted.length;
    session.send({ t: "signal", signal: "SIGINT" });
    await waitFor(() => emitted.length > beforeCtrlC && emitted.slice(beforeCtrlC).some((m) => m.t === "stdout" && m.data.charCodeAt(0) === 0x03), 1000);
    const ctrlc = emitted.slice(beforeCtrlC).find((m) => m.t === "stdout");
    record("backend: SIGINT maps to a Ctrl-C (0x03) stdin byte", ctrlc?.t === "stdout" && ctrlc.data.charCodeAt(0) === 0x03);

    session.close();
    await waitFor(() => emitted.some((m) => m.t === "exit"), 1000);
    record("backend: close → EXIT emitted", emitted.some((m) => m.t === "exit"));
  }

  // ── 3. fail-closed: openStream rejects → the terminal sees a clean ERROR + EXIT, no hang ──
  {
    const backend = createAgentExecBackend({
      openStream: () => Promise.reject(new Error("socket refused")),
    });
    const emitted: ExecServerMessage[] = [];
    backend.open((m) => emitted.push(m), { appId: "vita.terminal", appInstanceId: "i2", ownerUsername: "owner" });
    await waitFor(() => emitted.some((m) => m.t === "exit"), 1000);
    const err = emitted.find((m) => m.t === "error");
    record("backend: connect failure → ERROR + EXIT (fail-closed)", err?.t === "error" && emitted.some((m) => m.t === "exit"), `error=${err?.t === "error" ? err.message : "none"}`);
  }

  const passed = checks.filter((c) => c.ok).length;
  console.log(`[contract-capsule-exec] === ${passed}/${checks.length} checks passed ===`);
  if (passed !== checks.length) process.exitCode = 1;
}

function waitFor(pred: () => boolean, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (pred()) { resolve(); return; }
    const started = Date.now();
    const iv = setInterval(() => {
      if (pred() || Date.now() - started > ms) { clearInterval(iv); resolve(); }
    }, 10);
  });
}

main().catch((err: unknown) => {
  console.error(`[contract-capsule-exec] FATAL ${err instanceof Error ? err.stack : String(err)}`);
  process.exitCode = 1;
});
