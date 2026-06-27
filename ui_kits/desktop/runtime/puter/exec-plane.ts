// Puter compat — the EXEC/PROCESS plane: run a real command inside a hardened, cgroup-gated capsule and
// stream its stdin/stdout/stderr to a terminal in the browser.
//
// This is the backend half of the Terminal feature (the front half is the /pty websocket in server.ts
// and the xterm.js Terminal app). It mirrors control-plane.ts in shape: a stable, browser-friendly PORT
// (`ExecBackend`) with TWO implementations:
//
//   - createAgentExecBackend  → the ON-DEVICE wiring. A /pty session maps to a one-shot, hardened
//     capsule launched through agentd (the SAME ts/OCI/WASM capsule runtimes the rest of the OS uses —
//     DynamicUser, NoNewPrivileges, ProtectSystem=strict, MemoryMax/CPUQuota/TasksMax cgroup gates, a
//     read-only rootfs, per-capsule netns). Its stdin/stdout/stderr are streamed back over the socket.
//     agentd does NOT yet expose a `capsule.exec` capability (it has capsule.execute = launch a fixed
//     entrypoint), so this impl is written against that documented future surface and is NOT fully wired
//     until a node boot lands it — see EXEC-PLANE.md. It is the production target the stub stands in for.
//
//   - createDevExecBackend    → a DEV-HOST sandbox that genuinely runs an allow-listed command set
//     (ls / echo / cat / pwd / env / whoami / date / head / wc) inside a private, throwaway working
//     directory using node:child_process, with NO shell, an allow-list (default-deny on the binary), a
//     wall-clock + output cap, and a scrubbed environment. This is what the headless + browser
//     verification drive: real processes, real stdout/stderr, real exit codes — without a VM. It is NOT
//     the security boundary the on-device capsule is; it exists so the terminal is exercisable end-to-end
//     on the build host. (The capability GATE — only `exec`-granted apps reach it — is identical on both.)
//
// Both speak the same small message protocol the /pty websocket frames carry:
//   client → server : { t:"stdin", data }            (keystrokes / pasted input)
//                     { t:"resize", cols, rows }      (terminal geometry)
//                     { t:"signal", signal:"SIGINT" } (Ctrl-C)
//   server → client : { t:"stdout", data } | { t:"stderr", data }
//                     { t:"exit", code, signal? }     (process ended)
//                     { t:"error", message }          (could not start / internal)
// `data` is a UTF-8 string (xterm.js is byte-oriented but our allow-listed commands are text).

// ---------------------------------------------------------------------------------------------
// Wire protocol (shared by server.ts framing + the Terminal app).
// ---------------------------------------------------------------------------------------------

export type ExecClientMessage =
  | { readonly t: "stdin"; readonly data: string }
  | { readonly t: "resize"; readonly cols: number; readonly rows: number }
  | { readonly t: "signal"; readonly signal: "SIGINT" | "SIGTERM" | "SIGKILL" };

export type ExecServerMessage =
  | { readonly t: "stdout"; readonly data: string }
  | { readonly t: "stderr"; readonly data: string }
  | { readonly t: "exit"; readonly code: number | null; readonly signal?: string }
  | { readonly t: "error"; readonly message: string }
  // Emitted once, immediately after the session opens, so the terminal can print a banner naming the
  // capsule/runtime it is wired to (real vs dev-sandbox) — provenance the owner can see.
  | { readonly t: "ready"; readonly runtime: string; readonly capsule: string; readonly cwd: string };

// How a session emits server→client messages back to the socket. Returns nothing; the transport (the
// websocket adapter in server.ts) owns delivery + backpressure.
export type ExecEmit = (message: ExecServerMessage) => void;

// A live exec/pty session. The websocket adapter creates one per connection (after the capability gate
// passes), feeds it client messages, and closes it when the socket drops.
export interface ExecSession {
  // Feed a decoded client message (stdin/resize/signal) into the session.
  send(message: ExecClientMessage): void;
  // The socket closed (or the server is shutting down): terminate the underlying process + free it.
  close(): void;
}

// What the websocket adapter knows about the authenticated session opening the pty (for provenance +
// per-app working-dir scoping). Mirrors the fields the capability gate already resolved.
export interface ExecSessionContext {
  readonly appId: string;
  readonly appInstanceId: string;
  readonly ownerUsername: string;
}

// The EXEC backend PORT. One method: open a session, given an emit callback + the authenticated context.
export interface ExecBackend {
  open(emit: ExecEmit, context: ExecSessionContext): ExecSession;
  // A human label for the banner / logs (e.g. "dev-sandbox" or "agentd-capsule").
  readonly label: string;
}

// ---------------------------------------------------------------------------------------------
// DEV-HOST sandbox backend — genuinely runs an allow-listed command set with no shell, scrubbed env,
// a private cwd, and wall-clock + output caps. Drives the verification on the build host (no VM).
// ---------------------------------------------------------------------------------------------

// The node:child_process surface we depend on, injected so this stays testable + so the browser bundle
// never statically imports node:child_process (it is dynamically imported only in the dev backend).
export interface ChildProcessLike {
  spawn(
    command: string,
    args: readonly string[],
    options: {
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
      readonly stdio: readonly ["pipe", "pipe", "pipe"];
      readonly shell: false;
    },
  ): SpawnedChild;
}

export interface SpawnedChild {
  readonly stdout: { on(event: "data", cb: (chunk: Uint8Array) => void): void };
  readonly stderr: { on(event: "data", cb: (chunk: Uint8Array) => void): void };
  readonly stdin: { write(data: string): void; end(): void };
  on(event: "exit", cb: (code: number | null, signal: string | null) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  kill(signal?: string): void;
}

export interface DevExecBackendOptions {
  // The node:child_process binding. Injected (tests / explicit wiring). The harness passes the real one.
  readonly childProcess: ChildProcessLike;
  // A factory for a fresh, private, throwaway working directory per session (e.g. mkdtempSync). The
  // command runs here so `ls` shows a clean sandbox, not the host cwd. Returns the absolute path.
  readonly makeCwd: (appId: string) => string;
  // The PATH the sandbox resolves binaries against (the allow-list binaries must be findable here). On
  // the dev host the harness passes the inherited PATH; nothing else from process.env leaks through.
  readonly pathEnv: string;
  // Wall-clock cap per command (ms). Default 5000. A runaway/blocking command is killed.
  readonly timeoutMs?: number;
  // Total stdout+stderr cap (bytes). Default 256 KiB. Protects the socket from a firehose.
  readonly maxOutputBytes?: number;
  // Override the allow-list (tests). Default: the read-only inspection set below.
  readonly allowedCommands?: readonly string[];
}

// The default allow-list: read-only, side-effect-light inspection commands. NO shell, NO interpreters,
// NO network tools, NO writers/deleters. Default-deny: anything not on this list is refused with a
// terminal error (this is the dev backend's command-level gate; the capability gate already ran).
const DEFAULT_ALLOWED = Object.freeze([
  "ls", "echo", "cat", "pwd", "env", "whoami", "date", "head", "wc", "uname", "hostname",
]);

export function createDevExecBackend(options: DevExecBackendOptions): ExecBackend {
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
  const allowed = new Set(options.allowedCommands ?? DEFAULT_ALLOWED);

  return Object.freeze({
    label: "dev-sandbox",
    open(emit: ExecEmit, context: ExecSessionContext): ExecSession {
      const cwd = options.makeCwd(context.appId);
      // A SCRUBBED environment — only PATH + a few inert markers. No secrets, no tokens, no host env.
      const env: Record<string, string> = Object.freeze({
        PATH: options.pathEnv,
        HOME: cwd,
        PWD: cwd,
        TERM: "xterm-256color",
        VITA_CAPSULE: `term-${context.appInstanceId}`,
      });

      let child: SpawnedChild | undefined;
      let outputBytes = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let lineBuffer = "";
      let closed = false;

      emit({ t: "ready", runtime: "dev-sandbox", capsule: env["VITA_CAPSULE"] ?? "term", cwd });
      prompt();

      function prompt(): void {
        if (!closed) emit({ t: "stdout", data: `\r\n${context.ownerUsername}@vita:~$ ` });
      }

      function runCommandLine(commandLine: string): void {
        const trimmed = commandLine.trim();

        if (trimmed === "") { prompt(); return; }

        // Split on whitespace (no shell). The Terminal is a line-at-a-time command runner, not a pty
        // into a persistent shell process — that is the on-device capsule's job. Quotes are not honored
        // here (dev sandbox); the allow-listed commands don't need them for the verification.
        const parts = trimmed.split(/\s+/u);
        const command = parts[0] ?? "";
        const args = parts.slice(1);

        if (!allowed.has(command)) {
          emit({ t: "stderr", data: `vita: command not permitted in this sandbox: ${command}\r\n` });
          emit({ t: "stdout", data: `vita: allowed: ${[...allowed].join(", ")}\r\n` });
          prompt();
          return;
        }

        let spawned: SpawnedChild;

        try {
          spawned = options.childProcess.spawn(command, args, {
            cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"],
          });
        } catch (err) {
          emit({ t: "stderr", data: `vita: failed to start ${command}: ${err instanceof Error ? err.message : String(err)}\r\n` });
          prompt();
          return;
        }

        child = spawned;
        timer = setTimeout(() => {
          emit({ t: "stderr", data: `\r\nvita: ${command} exceeded ${timeoutMs}ms — terminated\r\n` });
          try { spawned.kill("SIGKILL"); } catch { /* already gone */ }
        }, timeoutMs);

        const onChunk = (kind: "stdout" | "stderr") => (chunk: Uint8Array): void => {
          outputBytes += chunk.byteLength;
          // Normalize \n → \r\n so xterm renders lines correctly.
          const text = new TextDecoder().decode(chunk).replace(/\r?\n/gu, "\r\n");

          if (outputBytes > maxOutputBytes) {
            emit({ t: "stderr", data: `\r\nvita: output truncated at ${maxOutputBytes} bytes\r\n` });
            try { spawned.kill("SIGKILL"); } catch { /* already gone */ }
            return;
          }

          emit({ t: kind, data: text });
        };

        spawned.stdout.on("data", onChunk("stdout"));
        spawned.stderr.on("data", onChunk("stderr"));
        spawned.on("error", (err: Error) => {
          emit({ t: "stderr", data: `vita: ${command}: ${err.message}\r\n` });
        });
        spawned.on("exit", (code: number | null, signal: string | null) => {
          if (timer !== undefined) clearTimeout(timer);
          child = undefined;
          outputBytes = 0;
          if (signal !== null && code === null) emit({ t: "stdout", data: `\r\n[exited via ${signal}]` });
          prompt();
        });
      }

      return Object.freeze({
        send(message: ExecClientMessage): void {
          if (closed) return;

          if (message.t === "stdin") {
            // Accumulate keystrokes into a line; run on Enter (\r or \n). Echo so the user sees typing
            // (xterm local echo is off by default for a remote pty). Backspace edits the line buffer.
            for (const ch of message.data) {
              if (ch === "\r" || ch === "\n") {
                emit({ t: "stdout", data: "\r\n" });
                const line = lineBuffer;

                lineBuffer = "";
                // A command is already running: feed the line to its stdin instead of starting another.
                if (child !== undefined) {
                  try { child.stdin.write(line + "\n"); } catch { /* stdin closed */ }
                } else {
                  runCommandLine(line);
                }
              } else if (ch === "" || ch === "\b") {
                if (lineBuffer.length > 0) {
                  lineBuffer = lineBuffer.slice(0, -1);
                  emit({ t: "stdout", data: "\b \b" });
                }
              } else if (ch >= " ") {
                lineBuffer += ch;
                emit({ t: "stdout", data: ch });
              }
            }
          } else if (message.t === "signal") {
            if (child !== undefined) {
              try { child.kill(message.signal); } catch { /* already gone */ }
            } else {
              lineBuffer = "";
              emit({ t: "stdout", data: "^C" });
              prompt();
            }
          }
          // resize is a no-op for the line-runner dev backend (no real pty geometry).
        },
        close(): void {
          closed = true;
          if (timer !== undefined) clearTimeout(timer);
          if (child !== undefined) {
            try { child.kill("SIGKILL"); } catch { /* already gone */ }
          }
        },
      });
    },
  });
}

// ---------------------------------------------------------------------------------------------
// ON-DEVICE agentd capsule backend — the PRODUCTION terminal. Maps a /pty websocket session to a
// hardened, PTY-backed, cgroup-gated capsule launched through agentd's `capsule.exec` capability. The
// session is forwarded over agentd's streaming /pty unix-socket endpoint (transport/pty.go) via the
// host-proxy's duplex frame stream (server/agentd-host-proxy.ts createAgentdPtyStream). The capsule has
// the SAME hardening as the rest of the OS (DynamicUser, NoNewPrivileges, ProtectSystem=strict,
// read-only rootfs, seccomp, AF_UNIX-only / NO network, MemoryMax/CPUQuota/TasksMax). See CAPSULE-EXEC.md.
//
// This module stays browser-bundle-safe: the Deno-only unix-socket stream is INJECTED (the same DI
// pattern the rest of the file uses with `fetch`), so exec-plane.ts never imports Deno/node. The boot
// entry (server-entry.ts) wires the real createAgentdPtyStream; tests inject a fake.
// ---------------------------------------------------------------------------------------------

// The duplex frame stream the backend forwards over (matches host-proxy's AgentdPtyStream). Kept as a
// local structural type so exec-plane.ts has no import from the Deno-only host-proxy module.
export interface PtyFrameStream {
  onFrame(cb: (frame: { readonly type: number; readonly payload: Uint8Array }) => void): void;
  onClose(cb: () => void): void;
  send(type: number, payload: Uint8Array): void;
  close(): void;
}

// Frame types — MUST match agent/capabilities/capsule/exec.go + host-proxy.
const PTY_FRAME_STDIN = 0x01;
const PTY_FRAME_RESIZE = 0x02;
const PTY_FRAME_STDOUT = 0x03;
const PTY_FRAME_EXIT = 0x04;
const PTY_FRAME_ERROR = 0x05;
const PTY_FRAME_READY = 0x06;

export interface AgentExecOptions {
  // Open the duplex /pty stream to agentd (over the host-proxy unix socket). Injected so this stays
  // runtime-agnostic + browser-bundle-safe; the boot entry passes the real createAgentdPtyStream.
  readonly openStream: (opts: { readonly cols: number; readonly rows: number }) => Promise<PtyFrameStream>;
  // Initial terminal geometry until the client sends its first resize. Default 80x24.
  readonly cols?: number;
  readonly rows?: number;
}

export function createAgentExecBackend(opts: AgentExecOptions): ExecBackend {
  return Object.freeze({
    label: "agentd-capsule",
    open(emit: ExecEmit, context: ExecSessionContext): ExecSession {
      const cols = opts.cols ?? 80;
      const rows = opts.rows ?? 24;

      let stream: PtyFrameStream | undefined;
      let closed = false;
      let exited = false;
      // Client messages that arrive before the stream connects are buffered, then flushed in order.
      const pending: ExecClientMessage[] = [];
      const decoder = new TextDecoder();

      const sendFrame = (message: ExecClientMessage): void => {
        if (stream === undefined || closed) return;
        if (message.t === "stdin") {
          stream.send(PTY_FRAME_STDIN, new TextEncoder().encode(message.data));
        } else if (message.t === "resize") {
          const p = new Uint8Array(4);
          p[0] = (message.cols >>> 8) & 0xff;
          p[1] = message.cols & 0xff;
          p[2] = (message.rows >>> 8) & 0xff;
          p[3] = message.rows & 0xff;
          stream.send(PTY_FRAME_RESIZE, p);
        } else if (message.t === "signal") {
          // A tty carries Ctrl-C as the byte 0x03 in stdin; SIGINT maps to that. SIGTERM/SIGKILL end the
          // session by closing the stream (the shell gets SIGHUP when the pty master closes).
          if (message.signal === "SIGINT") {
            stream.send(PTY_FRAME_STDIN, new Uint8Array([0x03]));
          } else {
            stream.close();
          }
        }
      };

      const emitExit = (code: number | null): void => {
        if (exited) return;
        exited = true;
        emit({ t: "exit", code });
      };

      opts
        .openStream({ cols, rows })
        .then((s) => {
          if (closed) { s.close(); return; }
          stream = s;

          s.onFrame((frame) => {
            switch (frame.type) {
              case PTY_FRAME_READY:
                emit({ t: "ready", runtime: "agentd-capsule", capsule: decoder.decode(frame.payload), cwd: "/" });
                break;
              case PTY_FRAME_STDOUT:
                emit({ t: "stdout", data: decoder.decode(frame.payload) });
                break;
              case PTY_FRAME_ERROR:
                emit({ t: "error", message: decoder.decode(frame.payload) });
                break;
              case PTY_FRAME_EXIT: {
                const p = frame.payload;
                const code = p.length >= 4 ? ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) : null;
                emitExit(code);
                break;
              }
              default:
                break;
            }
          });
          s.onClose(() => { emitExit(exited ? null : 0); });

          // Flush anything the client typed before the stream was ready.
          for (const message of pending) sendFrame(message);
          pending.length = 0;
        })
        .catch((err: unknown) => {
          emit({
            t: "error",
            message: `exec: could not open on-device capsule session: ${err instanceof Error ? err.message : String(err)}`,
          });
          emitExit(1);
        });

      void context;

      return Object.freeze({
        send(message: ExecClientMessage): void {
          if (closed) return;
          if (stream === undefined) { pending.push(message); return; }
          sendFrame(message);
        },
        close(): void {
          closed = true;
          if (stream !== undefined) { try { stream.close(); } catch { /* ignore */ } }
        },
      });
    },
  });
}

// Decode a raw websocket text-frame payload into a validated ExecClientMessage, or undefined if it is
// malformed / not a known type. Pure — server.ts calls this on each inbound frame. Fail-closed: an
// unknown `t` or a wrong-shaped field yields undefined (the frame is dropped, never mis-dispatched).
export function decodeClientMessage(raw: string): ExecClientMessage | undefined {
  let parsed: unknown;

  try { parsed = JSON.parse(raw); } catch { return undefined; }

  if (parsed === null || typeof parsed !== "object") return undefined;

  const obj = parsed as Record<string, unknown>;
  const t = obj["t"];

  if (t === "stdin" && typeof obj["data"] === "string") {
    return { t: "stdin", data: obj["data"] };
  }

  if (t === "resize" && typeof obj["cols"] === "number" && typeof obj["rows"] === "number") {
    return { t: "resize", cols: obj["cols"], rows: obj["rows"] };
  }

  if (t === "signal") {
    const sig = obj["signal"];

    if (sig === "SIGINT" || sig === "SIGTERM" || sig === "SIGKILL") {
      return { t: "signal", signal: sig };
    }
  }

  return undefined;
}
