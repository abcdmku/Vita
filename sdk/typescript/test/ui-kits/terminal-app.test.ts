import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TERMINAL_APP_ENTRY,
  TERMINAL_APP_ID,
  TERMINAL_APP_PARTITION,
  terminalAppPackage,
} from "../../../../apps/terminal/manifest.ts";
import {
  SDK_VERSION,
  defineAppPackage,
  hasAppCapabilityGrant,
} from "../../src/desktop-sdk/index.ts";
import {
  createTerminalAppViewModel,
  createTerminalBuiltInResolver,
} from "../../../../ui_kits/desktop/viewmodels/apps/terminal-app.ts";
import type {
  TerminalCommandRequest,
  TerminalCommandResolver,
  TerminalCommandResult,
  TerminalAppState,
  TerminalResolvedLine,
} from "../../../../ui_kits/desktop/viewmodels/apps/terminal-app.ts";

test("terminal app package manifest is a valid web app with minimal grants", () => {
  const terminalPackage = defineAppPackage(terminalAppPackage);

  assert.equal(terminalPackage.manifest.id, TERMINAL_APP_ID);
  assert.equal(terminalPackage.manifest.version, "1.0.0");
  assert.equal(terminalPackage.manifest.sdkVersion, SDK_VERSION);
  assert.equal(terminalPackage.manifest.entry, TERMINAL_APP_ENTRY);
  assert.deepEqual(terminalPackage.manifest.capabilityGrants, []);
  assert.equal(hasAppCapabilityGrant(terminalPackage.manifest, "files.read"), false);
  assert.equal(hasAppCapabilityGrant(terminalPackage.manifest, "files.write"), false);
  assert.equal(terminalPackage.descriptor.id, TERMINAL_APP_ID);
  assert.equal(terminalPackage.descriptor.title, "Terminal");
  assert.equal(terminalPackage.descriptor.surfaceKind, "web");
  assert.equal(terminalPackage.descriptor.runtime.url, terminalPackage.manifest.entry);
  assert.equal(terminalPackage.descriptor.runtime.partition, TERMINAL_APP_PARTITION);
  assert.equal(terminalPackage.descriptor.defaultWindow?.mode, "floating");
});

test("terminal view-model types and submits through an injected pure resolver", () => {
  const calls: TerminalCommandRequest[] = [];
  const viewModel = createTerminalAppViewModel({
    resolver: fakeResolver(calls, (request) => output([
      line("output", `ran:${request.commandName}`),
      line("output", `args:${request.argumentText}`),
    ])),
  });

  assert.deepEqual(project(viewModel.snapshot()), {
    history: [],
    historyCursor: null,
    inputBuffer: "",
    promptLabel: "vita:~$",
    scrollback: [],
  });

  const typed = viewModel.type("echo hello world");

  assert.equal(typed.ok, true);
  assert.equal(typed.state.inputBuffer, "echo hello world");

  const submitted = viewModel.submit();

  assert.equal(submitted.ok, true);
  assert.deepEqual(calls, [
    {
      args: ["hello", "world"],
      argumentText: "hello world",
      commandName: "echo",
      promptLabel: "vita:~$",
      rawInput: "echo hello world",
    },
  ]);
  assert.deepEqual(submitted.state.scrollback, [
    {
      kind: "input",
      text: "echo hello world",
    },
    {
      kind: "output",
      text: "ran:echo",
    },
    {
      kind: "output",
      text: "args:hello world",
    },
  ]);
  assert.deepEqual(submitted.state.history, ["echo hello world"]);
  assert.equal(submitted.state.historyCursor, null);
  assert.equal(submitted.state.inputBuffer, "");
});

test("terminal built-ins are deterministic and keep command execution in memory", () => {
  const viewModel = createTerminalAppViewModel({
    resolver: createTerminalBuiltInResolver(),
  });

  assert.equal(viewModel.type("help").ok, true);
  const help = viewModel.submit();

  assert.equal(help.ok, true);
  assert.deepEqual(help.state.scrollback, [
    {
      kind: "input",
      text: "help",
    },
    {
      kind: "output",
      text: "Available commands: clear, echo, help",
    },
  ]);

  assert.equal(viewModel.type("echo capsule ready").ok, true);
  const echo = viewModel.submit();

  assert.equal(echo.ok, true);
  assert.deepEqual(echo.state.scrollback.slice(-2), [
    {
      kind: "input",
      text: "echo capsule ready",
    },
    {
      kind: "output",
      text: "capsule ready",
    },
  ]);

  assert.equal(viewModel.type("clear").ok, true);
  const clearedByCommand = viewModel.submit();

  assert.equal(clearedByCommand.ok, true);
  assert.deepEqual(clearedByCommand.state.scrollback, []);
  assert.deepEqual(clearedByCommand.state.history, ["help", "echo capsule ready", "clear"]);
});

test("terminal unknown commands append deterministic errors and fail closed", () => {
  const viewModel = createTerminalAppViewModel({
    resolver: createTerminalBuiltInResolver(),
  });

  assert.equal(viewModel.type("rm -rf /").ok, true);

  const rejected = viewModel.submit();

  assert.equal(rejected.ok, false);
  if (rejected.ok) {
    assert.fail("expected unknown command to fail closed");
  }
  assert.equal(rejected.error.code, "UNKNOWN_COMMAND");
  assert.equal(rejected.error.message, "unknown command: rm");
  assert.deepEqual(rejected.state.scrollback, [
    {
      kind: "input",
      text: "rm -rf /",
    },
    {
      kind: "error",
      text: "unknown command: rm",
    },
  ]);
  assert.deepEqual(rejected.state.history, ["rm -rf /"]);
  assert.equal(rejected.state.inputBuffer, "");
});

test("terminal missing or malformed resolver results fail closed without mutating scrollback", () => {
  const missingPort = createTerminalAppViewModel();

  assert.equal(missingPort.type("help").ok, true);

  const beforeMissingSubmit = project(missingPort.snapshot());
  const missing = missingPort.submit();

  assert.equal(missing.ok, false);
  if (missing.ok) {
    assert.fail("expected missing resolver to fail closed");
  }
  assert.equal(missing.error.code, "TERMINAL_RESOLVER_UNAVAILABLE");
  assert.deepEqual(project(missing.state), beforeMissingSubmit);

  const malformed = createTerminalAppViewModel({
    resolver: {
      resolve() {
        return Object.freeze({
          ok: true,
        });
      },
    },
  });

  assert.equal(malformed.type("help").ok, true);

  const beforeMalformedSubmit = project(malformed.snapshot());
  const malformedResult = malformed.submit();

  assert.equal(malformedResult.ok, false);
  if (malformedResult.ok) {
    assert.fail("expected malformed resolver result to fail closed");
  }
  assert.equal(malformedResult.error.code, "TERMINAL_RESOLVER_MALFORMED");
  assert.deepEqual(project(malformedResult.state), beforeMalformedSubmit);
});

test("terminal history prev and next move the cursor deterministically", () => {
  const viewModel = createTerminalAppViewModel({
    resolver: createTerminalBuiltInResolver(),
  });

  assert.equal(viewModel.type("echo one").ok, true);
  assert.equal(viewModel.submit().ok, true);
  assert.equal(viewModel.type("echo two").ok, true);
  assert.equal(viewModel.submit().ok, true);

  const firstPrev = viewModel.historyPrev();

  assert.equal(firstPrev.ok, true);
  assert.equal(firstPrev.state.inputBuffer, "echo two");
  assert.equal(firstPrev.state.historyCursor, 1);

  const secondPrev = viewModel.historyPrev();

  assert.equal(secondPrev.ok, true);
  assert.equal(secondPrev.state.inputBuffer, "echo one");
  assert.equal(secondPrev.state.historyCursor, 0);

  const firstNext = viewModel.historyNext();

  assert.equal(firstNext.ok, true);
  assert.equal(firstNext.state.inputBuffer, "echo two");
  assert.equal(firstNext.state.historyCursor, 1);

  const secondNext = viewModel.historyNext();

  assert.equal(secondNext.ok, true);
  assert.equal(secondNext.state.inputBuffer, "");
  assert.equal(secondNext.state.historyCursor, null);
});

test("terminal clear action empties scrollback and snapshots are frozen", () => {
  const viewModel = createTerminalAppViewModel({
    resolver: createTerminalBuiltInResolver(),
  });

  assert.equal(viewModel.type("echo stable").ok, true);
  const submitted = viewModel.submit();

  assert.equal(submitted.ok, true);

  const firstSnapshot = viewModel.snapshot();

  assert.equal(Object.isFrozen(firstSnapshot), true);
  assert.equal(Object.isFrozen(firstSnapshot.scrollback), true);
  assert.equal(Object.isFrozen(firstSnapshot.scrollback[0]), true);
  assert.deepEqual(viewModel.snapshot(), firstSnapshot);

  const cleared = viewModel.clear();

  assert.equal(cleared.ok, true);
  assert.deepEqual(cleared.state.scrollback, []);
  assert.deepEqual(firstSnapshot.scrollback, [
    {
      kind: "input",
      text: "echo stable",
    },
    {
      kind: "output",
      text: "stable",
    },
  ]);
});

function fakeResolver(
  calls: TerminalCommandRequest[],
  handler: (request: TerminalCommandRequest) => TerminalCommandResult,
): TerminalCommandResolver {
  return Object.freeze({
    resolve(request: TerminalCommandRequest): TerminalCommandResult {
      calls.push(request);
      return handler(request);
    },
  });
}

function output(lines: readonly TerminalResolvedLine[]): TerminalCommandResult {
  return Object.freeze({
    kind: "output",
    lines: Object.freeze([...lines]),
    ok: true,
  });
}

function line(kind: TerminalResolvedLine["kind"], text: string): TerminalResolvedLine {
  return Object.freeze({
    kind,
    text,
  });
}

function project(state: TerminalAppState) {
  return {
    history: state.history,
    historyCursor: state.historyCursor,
    inputBuffer: state.inputBuffer,
    promptLabel: state.promptLabel,
    scrollback: state.scrollback,
  };
}
