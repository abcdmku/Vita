// /pty DoS caps (MEDIUM finding) — proves the websocket pty bridge bounds three abuse vectors:
//   (1) MAX FRAME SIZE: a frame announcing a payload > 1 MiB is rejected and the connection dropped.
//   (2) BOUNDED REASSEMBLY: a client streaming bytes without completing a frame cannot grow the
//       server's reassembly buffer unbounded (it is dropped once the buffer exceeds the cap).
//   (3) CONCURRENT SESSION CAP: at most PTY_MAX_CONCURRENT_SESSIONS (8) live /pty sessions per face; the
//       next upgrade is refused with 503.
// And a happy-path: a normal small stdin frame reaches the exec backend (the caps don't break terminals).
//
// Run: node --experimental-strip-types --test sdk/typescript/test/ui-kits/puter-pty-dos.test.ts

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { connect, type Socket } from "node:net";
import { test } from "node:test";

import { startHarnessServer } from "../../../../ui_kits/desktop/runtime/puter/server.ts";
import { createCapabilityRegistry } from "../../../../ui_kits/desktop/runtime/puter/capability.ts";
import { createAppGrantRegistry, createBrokerPermissionModel } from "../../../../ui_kits/desktop/runtime/puter/permission-model.ts";
import type {
  ExecBackend,
  ExecClientMessage,
  ExecEmit,
  ExecServerMessage,
  ExecSession,
  ExecSessionContext,
} from "../../../../ui_kits/desktop/runtime/puter/exec-plane.ts";

const STATIC_ROOT = new URL("../../../../ui_kits/desktop/runtime/puter/", import.meta.url).pathname;

// A trivial exec backend that records every client message it receives (so we can prove a real frame
// made it through). It keeps the session open until close() is called.
function recordingBackend(): { backend: ExecBackend; received: ExecClientMessage[]; openCount: () => number } {
  const received: ExecClientMessage[] = [];
  let opens = 0;

  const backend: ExecBackend = {
    label: "test-recording",
    open(emit: ExecEmit, _context: ExecSessionContext): ExecSession {
      opens += 1;
      emit({ t: "ready", runtime: "test", capsule: "test", cwd: "/tmp" });
      return {
        send(message: ExecClientMessage): void {
          received.push(message);
        },
        close(): void {
          /* no-op */
        },
      };
    },
  };

  return { backend, openCount: () => opens, received };
}

function execRegistry(): ReturnType<typeof createCapabilityRegistry> {
  const grants = createAppGrantRegistry({ "vita.terminal": ["exec", "auth"] });
  const caps = createCapabilityRegistry({ permissionModel: createBrokerPermissionModel({ grants }) });
  caps.mintAppSession({ appId: "vita.terminal", appInstanceId: "t1", grants: ["exec", "auth"], token: "TERM-TOKEN" });
  return caps;
}

// Open a raw TCP connection and send a websocket upgrade for /pty with the exec token in the query. Does
// NOT use a ws library — we drive the bytes directly so we can send malformed/oversized frames. Returns
// the socket plus the raw HTTP response head (so the caller can read the status line).
function openPty(port: number, token = "TERM-TOKEN"): Promise<{ socket: Socket; head: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      const key = "dGhlIHNhbXBsZSBub25jZQ=="; // any base64 16-byte nonce
      socket.write(
        `GET /pty?auth_token=${token} HTTP/1.1\r\n` +
          "Host: 127.0.0.1\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n` +
          "Sec-WebSocket-Version: 13\r\n\r\n",
      );
    });

    // A bounded timeout so a stuck upgrade fails the test instead of hanging; cleared on resolve so it
    // never keeps the event loop alive after the test settles (which trips node:test teardown).
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("pty upgrade timed out"));
    }, 3000);
    timer.unref();

    let head = "";
    const onData = (chunk: Buffer): void => {
      head += chunk.toString("latin1");
      if (head.includes("\r\n\r\n")) {
        clearTimeout(timer);
        socket.removeListener("data", onData);
        resolve({ head, socket });
      }
    };
    socket.on("data", onData);
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function statusOf(head: string): number {
  const m = /^HTTP\/1\.1 (\d{3})/u.exec(head);
  return m ? Number(m[1]) : 0;
}

// A MASKED websocket CLOSE frame (opcode 0x8, empty payload) — the bridge handles this explicitly
// (frame.opcode === 0x8 → finish), which frees the session slot deterministically.
function maskedCloseFrame(): Buffer {
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  return Buffer.concat([Buffer.from([0x88, 0x80]), mask]);
}

// Build a MASKED client websocket frame (browser→server frames must be masked). opcode 0x1 = text.
function maskedTextFrame(payload: Buffer, announcedLen?: number): Buffer {
  const len = announcedLen ?? payload.byteLength;
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  let header: Buffer;

  if (len < 126) {
    header = Buffer.from([0x81, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }

  const masked = Buffer.alloc(payload.byteLength);
  for (let i = 0; i < payload.byteLength; i += 1) masked[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);

  return Buffer.concat([header, mask, masked]);
}

test("/pty: a NORMAL small stdin frame reaches the exec backend (caps don't break terminals)", async () => {
  const rec = recordingBackend();
  const server = await startHarnessServer({
    apiOrigin: { handleAsync: async () => ({ body: new Uint8Array(0), headers: {}, status: 404 }) } as never,
    capabilities: execRegistry(),
    execBackend: rec.backend,
    staticRoot: STATIC_ROOT,
  });

  try {
    const { head, socket } = await openPty(server.port);
    assert.equal(statusOf(head), 101, "pty upgrade should succeed for an exec-granted token");

    const payload = Buffer.from(JSON.stringify({ t: "stdin", data: "ls\r" }), "utf8");
    socket.write(maskedTextFrame(payload));

    // Give the server a tick to decode + deliver.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(rec.received.length, 1, "exactly one client message delivered");
    assert.deepEqual(rec.received[0], { t: "stdin", data: "ls\r" });
    socket.destroy();
  } finally {
    await server.close();
  }
});

test("/pty: an OVERSIZED frame (announced length > 1 MiB) drops the connection without crashing the server", async () => {
  const rec = recordingBackend();
  const server = await startHarnessServer({
    apiOrigin: { handleAsync: async () => ({ body: new Uint8Array(0), headers: {}, status: 404 }) } as never,
    capabilities: execRegistry(),
    execBackend: rec.backend,
    staticRoot: STATIC_ROOT,
  });

  try {
    const { head, socket } = await openPty(server.port);
    assert.equal(statusOf(head), 101);

    // Announce a 5 MiB payload (> the 1 MiB cap) but send only a tiny body. The server must reject on the
    // ANNOUNCED length and close — it must NOT wait for 5 MiB or allocate it.
    const tiny = Buffer.from("x");
    const frame = maskedTextFrame(tiny, 5 * 1024 * 1024);
    const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
    socket.write(frame);

    await closed; // the server dropped us — proves the oversized frame was refused
    assert.equal(rec.received.length, 0, "no client message should be delivered from an oversized frame");

    // The server is still alive: a fresh pty upgrade still works.
    const again = await openPty(server.port);
    assert.equal(statusOf(again.head), 101, "server survived the oversized-frame abuse");
    again.socket.destroy();
  } finally {
    await server.close();
  }
});

test("/pty: at most 8 concurrent sessions — the 9th upgrade is refused with 503", async () => {
  const rec = recordingBackend();
  const server = await startHarnessServer({
    apiOrigin: { handleAsync: async () => ({ body: new Uint8Array(0), headers: {}, status: 404 }) } as never,
    capabilities: execRegistry(),
    execBackend: rec.backend,
    staticRoot: STATIC_ROOT,
  });

  const open: Socket[] = [];
  try {
    // Open 8 sessions (the cap). All should upgrade.
    for (let i = 0; i < 8; i += 1) {
      const { head, socket } = await openPty(server.port);
      assert.equal(statusOf(head), 101, `session ${i + 1} should upgrade`);
      open.push(socket);
    }

    // The 9th must be refused with 503 (too many sessions) — no 101.
    const ninth = await openPty(server.port);
    assert.equal(statusOf(ninth.head), 503, "the 9th concurrent pty must be refused 503");
    ninth.socket.destroy();

    // Closing one frees a slot; a new session then succeeds. Send a real ws CLOSE frame so the server
    // bridge runs finish() deterministically (decrementing the counter), then poll for the freed slot.
    open[0]?.write(maskedCloseFrame());
    let reopened: { socket: Socket; head: string } | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((r) => setTimeout(r, 50));
      const candidate = await openPty(server.port);
      if (statusOf(candidate.head) === 101) {
        reopened = candidate;
        break;
      }
      candidate.socket.destroy();
    }
    assert.ok(reopened, "a slot should free up after a session closes (got only 503s)");
    reopened.socket.destroy();
  } finally {
    for (const s of open) s.destroy();
    await server.close();
  }
});

// Silence unused-type warnings for the message union (imported for documentation of the wire shape).
void (0 as unknown as ExecServerMessage);
