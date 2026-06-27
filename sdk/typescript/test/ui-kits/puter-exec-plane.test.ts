// exec-plane tests — exercise the EXEC/PROCESS plane: the /pty wire-protocol decoder, the dev-sandbox
// backend (real command shape via an injected fake child_process: spawn + allow-list default-deny +
// stdin line buffering + scrubbed env), and the `exec` capability gate (default-deny: only an
// exec-granted session opens a session; everything else is CAP_DENIED).
//
// Run: node --experimental-strip-types --test sdk/typescript/test/ui-kits/puter-exec-plane.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import { createCapabilityRegistry } from "../../../../ui_kits/desktop/runtime/puter/capability.ts";
import {
  createAppGrantRegistry,
  createBrokerPermissionModel,
} from "../../../../ui_kits/desktop/runtime/puter/permission-model.ts";
import {
  type ChildProcessLike,
  type ExecServerMessage,
  type SpawnedChild,
  createDevExecBackend,
  decodeClientMessage,
} from "../../../../ui_kits/desktop/runtime/puter/exec-plane.ts";

// A controllable fake child: records the spawn call, lets the test push stdout/stderr + exit.
interface FakeChild extends SpawnedChild {
  emitStdout(s: string): void;
  emitStderr(s: string): void;
  emitExit(code: number | null, signal?: string | null): void;
  readonly stdinWrites: string[];
  readonly killed: string[];
}

interface FakeSpawn {
  readonly childProcess: ChildProcessLike;
  readonly calls: { command: string; args: readonly string[]; cwd: string; env: Readonly<Record<string, string>> }[];
  last(): FakeChild | undefined;
}

function fakeSpawn(): FakeSpawn {
  const calls: FakeSpawn["calls"] = [];
  let last: FakeChild | undefined;

  const childProcess: ChildProcessLike = {
    spawn(command, args, options) {
      calls.push({ command, args, cwd: options.cwd, env: options.env });

      let onExit: ((code: number | null, signal: string | null) => void) | undefined;
      const stdoutCbs: ((c: Uint8Array) => void)[] = [];
      const stderrCbs: ((c: Uint8Array) => void)[] = [];
      const stdinWrites: string[] = [];
      const killed: string[] = [];

      const child: FakeChild = {
        stdout: { on: (_e, cb) => stdoutCbs.push(cb) },
        stderr: { on: (_e, cb) => stderrCbs.push(cb) },
        stdin: { write: (d: string) => stdinWrites.push(d), end: () => undefined },
        on: (event, cb) => { if (event === "exit") onExit = cb as (c: number | null, s: string | null) => void; },
        kill: (signal?: string) => killed.push(signal ?? "SIGTERM"),
        emitStdout: (s: string) => { for (const cb of stdoutCbs) cb(new TextEncoder().encode(s)); },
        emitStderr: (s: string) => { for (const cb of stderrCbs) cb(new TextEncoder().encode(s)); },
        emitExit: (code: number | null, signal: string | null = null) => onExit?.(code, signal),
        stdinWrites,
        killed,
      };

      last = child;
      return child;
    },
  };

  return { childProcess, calls, last: () => last };
}

function devBackend(spawn: FakeSpawn): ReturnType<typeof createDevExecBackend> {
  return createDevExecBackend({
    childProcess: spawn.childProcess,
    makeCwd: () => "/tmp/sandbox",
    pathEnv: "/usr/bin",
    timeoutMs: 50_000, // long; tests drive exit explicitly
  });
}

const CTX = { appId: "vita.terminal", appInstanceId: "term-1", ownerUsername: "owner" } as const;

// ---- wire protocol decoder ----

test("decodeClientMessage: accepts valid stdin/resize/signal, rejects junk (fail-closed)", () => {
  assert.deepEqual(decodeClientMessage(JSON.stringify({ t: "stdin", data: "ls\r" })), { t: "stdin", data: "ls\r" });
  assert.deepEqual(decodeClientMessage(JSON.stringify({ t: "resize", cols: 80, rows: 24 })), { t: "resize", cols: 80, rows: 24 });
  assert.deepEqual(decodeClientMessage(JSON.stringify({ t: "signal", signal: "SIGINT" })), { t: "signal", signal: "SIGINT" });

  // fail-closed cases
  assert.equal(decodeClientMessage("not json"), undefined);
  assert.equal(decodeClientMessage(JSON.stringify({ t: "stdin" })), undefined); // missing data
  assert.equal(decodeClientMessage(JSON.stringify({ t: "resize", cols: "x", rows: 1 })), undefined);
  assert.equal(decodeClientMessage(JSON.stringify({ t: "signal", signal: "SIGHUP" })), undefined); // not allowed
  assert.equal(decodeClientMessage(JSON.stringify({ t: "exec", cmd: "rm" })), undefined); // unknown type
});

// ---- dev backend: real command shape ----

test("dev backend: typing a permitted command spawns it with no shell, scrubbed env, sandbox cwd", () => {
  const spawn = fakeSpawn();
  const backend = devBackend(spawn);
  const out: ExecServerMessage[] = [];
  const session = backend.open((m) => out.push(m), CTX);

  // a banner + a prompt arrive first
  assert.equal(out[0]?.t, "ready");

  session.send({ t: "stdin", data: "echo hi\r" });

  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0]?.command, "echo");
  assert.deepEqual(spawn.calls[0]?.args, ["hi"]);
  assert.equal(spawn.calls[0]?.cwd, "/tmp/sandbox");
  // scrubbed env: only PATH/HOME/PWD/TERM/VITA_CAPSULE — no leaked secrets.
  assert.deepEqual(Object.keys(spawn.calls[0]?.env ?? {}).sort(), ["HOME", "PATH", "PWD", "TERM", "VITA_CAPSULE"].sort());
  assert.equal(spawn.calls[0]?.env["PATH"], "/usr/bin");

  // stdout streams back, exit re-prompts.
  spawn.last()?.emitStdout("hi\n");
  spawn.last()?.emitExit(0);
  const texts = out.filter((m) => m.t === "stdout").map((m) => (m as { data: string }).data).join("");
  assert.ok(texts.includes("hi"), "stdout streamed");
  session.close();
});

test("dev backend: default-deny — a non-allow-listed command is refused, never spawned", () => {
  const spawn = fakeSpawn();
  const backend = devBackend(spawn);
  const out: ExecServerMessage[] = [];
  const session = backend.open((m) => out.push(m), CTX);

  session.send({ t: "stdin", data: "rm -rf /\r" });

  assert.equal(spawn.calls.length, 0, "rm was NOT spawned");
  const stderr = out.filter((m) => m.t === "stderr").map((m) => (m as { data: string }).data).join("");
  assert.ok(/not permitted/i.test(stderr), "refusal surfaced");
  session.close();
});

test("dev backend: input while a command runs is fed to its stdin (interactive cat)", () => {
  const spawn = fakeSpawn();
  const backend = devBackend(spawn);
  const out: ExecServerMessage[] = [];
  const session = backend.open((m) => out.push(m), CTX);

  session.send({ t: "stdin", data: "cat\r" });        // starts cat (stays running)
  session.send({ t: "stdin", data: "a line\r" });     // goes to cat's stdin, not a new command

  assert.equal(spawn.calls.length, 1, "only cat spawned");
  assert.deepEqual(spawn.last()?.stdinWrites, ["a line\n"]);
  session.close();
  // close kills the running child.
  assert.ok((spawn.last()?.killed.length ?? 0) > 0, "close killed the child");
});

test("dev backend: SIGINT with no running command clears the line + re-prompts (no spawn)", () => {
  const spawn = fakeSpawn();
  const backend = devBackend(spawn);
  const out: ExecServerMessage[] = [];
  const session = backend.open((m) => out.push(m), CTX);

  session.send({ t: "signal", signal: "SIGINT" });
  assert.equal(spawn.calls.length, 0);
  session.close();
});

// ---- capability gate: exec is default-deny, enforced by the PRODUCTION broker model ----

// NOTE: this replaces an earlier test that gated `exec` with the DEFAULT session-grant model
// (createCapabilityRegistry() with no permissionModel), which merely checked set-membership of the
// session's own grants. That is NOT the production enforcement path and would have passed even with the
// capability-confusion bug. This version wires the REAL `createBrokerPermissionModel` (the on-device
// enforcement) and additionally proves `exec` is DISTINCT from control/meta at the gate.
test("capability (broker model): only an exec-granted app authorizes exec; control/meta-only apps are CAP_DENIED (403)", () => {
  const grants = createAppGrantRegistry({
    "vita.terminal": ["exec", "auth"],
    "vita.notepad": ["fs.read", "fs.write", "ui", "auth"],
    "vita.console": ["control", "auth"],
    "vita.pkgmgr": ["meta", "auth"],
  });
  const caps = createCapabilityRegistry({ permissionModel: createBrokerPermissionModel({ grants }) });

  // The session's baked grant set is IRRELEVANT under the broker model — the broker decides from the
  // per-app declared policy keyed by appId. Mint each session with a deliberately over-broad grant set
  // to prove the broker (not the session) is the authority.
  const term = caps.mintAppSession({ appId: "vita.terminal", appInstanceId: "t", grants: ["exec", "control", "meta", "auth"], token: "T" });
  const note = caps.mintAppSession({ appId: "vita.notepad", appInstanceId: "n", grants: ["exec", "control", "meta", "auth"], token: "N" });
  const consoleApp = caps.mintAppSession({ appId: "vita.console", appInstanceId: "c", grants: ["exec", "control", "meta", "auth"], token: "C" });
  const pkg = caps.mintAppSession({ appId: "vita.pkgmgr", appInstanceId: "p", grants: ["exec", "control", "meta", "auth"], token: "P" });

  // Terminal: exec ALLOW.
  assert.equal(caps.authorize(term, "exec").ok, true, "terminal may exec");

  // Notepad (no privileged grant): exec DENIED 403 (default-deny).
  const noteDenied = caps.authorize(note, "exec");
  assert.equal(noteDenied.ok, false);
  if (!noteDenied.ok) {
    assert.equal(noteDenied.code, "CAP_DENIED");
    assert.equal(noteDenied.status, 403);
  }

  // CAPABILITY SEPARATION: a control-only app and a meta-only app are BOTH denied exec, even though all
  // three privileged caps share the `configuration` class. The distinct broker scope keeps them apart.
  assert.equal(caps.authorize(consoleApp, "exec").ok, false, "control-only app must NOT exec");
  assert.equal(caps.authorize(pkg, "exec").ok, false, "meta-only app must NOT exec");
  // And the converse: the exec-granted Terminal is denied control + meta.
  assert.equal(caps.authorize(term, "control").ok, false, "exec-only Terminal must NOT control");
  assert.equal(caps.authorize(term, "meta").ok, false, "exec-only Terminal must NOT meta");

  // unknown token → UNAUTHENTICATED 401 (the /pty upgrade refuses before any session opens).
  const unauth = caps.resolveToken("nope");
  assert.equal(unauth.ok, false);
  if (!unauth.ok) {
    assert.equal(unauth.code, "UNAUTHENTICATED");
    assert.equal(unauth.status, 401);
  }
});
