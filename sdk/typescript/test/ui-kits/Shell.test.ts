import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createShellViewModel,
} from "../../../../ui_kits/desktop/viewmodels/Shell.ts";
import type {
  ShellCommandOutput,
  ShellCommandRequest,
  ShellCommandResult,
  ShellSessionPort,
  ShellViewModelState,
} from "../../../../ui_kits/desktop/viewmodels/Shell.ts";

test("shell view-model seeds deterministic REPL tabs and creates/closes tabs", () => {
  const calls: ShellCommandRequest[] = [];
  const vm = createShellViewModel({
    session: fakeSession(calls, (request) => output([`ran ${request.input}`], 0)),
  });

  const initial = vm.snapshot();

  assert.deepEqual(initial.tabs.map((tab) => [tab.id, tab.title, tab.cwd, tab.running]), [
    ["kernel", "kernel", "~/vita", false],
    ["build", "build", "~/vita", false],
  ]);
  assert.equal(initial.activeTabId, "kernel");
  assert.equal(initial.activeTab, initial.tabs[0]);
  assert.deepEqual(calls, []);

  const created = vm.newTab();

  assert.equal(created.ok, true);
  assert.equal(created.state.activeTabId, "shell-1");
  assert.deepEqual(created.state.tabs.map((tab) => tab.id), ["kernel", "build", "shell-1"]);
  assert.equal(created.state.activeTab.cwd, "~/vita");

  const closed = vm.closeTab("shell-1");

  assert.equal(closed.ok, true);
  assert.deepEqual(closed.state.tabs.map((tab) => tab.id), ["kernel", "build"]);
  assert.equal(closed.state.activeTabId, "build");

  const missing = vm.closeTab("missing");

  assert.equal(missing.ok, false);
  if (missing.ok) {
    assert.fail("expected unknown tab to fail closed");
  }
  assert.equal(missing.error.code, "UNKNOWN_TAB");
  assert.deepEqual(missing.state.tabs.map((tab) => tab.id), ["kernel", "build"]);
});

test("shell submit runs through the injected session port and appends output deterministically", async () => {
  const calls: ShellCommandRequest[] = [];
  const pending = deferred<ShellCommandResult>();
  const vm = createShellViewModel({
    session: {
      runCommand(request) {
        calls.push(request);
        return pending.promise;
      },
    },
  });

  const submitted = vm.submit("await boot()");

  assert.equal(vm.state.activeTab.running, true);
  assert.deepEqual(calls, [
    {
      cwd: "~/vita",
      input: "await boot()",
      tabId: "kernel",
    },
  ]);

  pending.resolve(accept(output(["kernel ready", "mounted vfs"], 0, "/workspace/vita")));

  const result = await submitted;

  assert.equal(result.ok, true);
  assert.equal(result.state.activeTab.running, false);
  assert.equal(result.state.activeTab.cwd, "/workspace/vita");
  assert.equal(result.state.activeTab.lastExitCode, 0);
  assert.deepEqual(result.state.activeTab.history, ["await boot()"]);
  assert.deepEqual(result.state.activeTab.outputBuffer, [
    {
      kind: "input",
      text: "await boot()",
    },
    {
      kind: "output",
      text: "kernel ready",
    },
    {
      kind: "output",
      text: "mounted vfs",
    },
  ]);
});

test("shell history navigation and clear operate on the active tab state", async () => {
  const calls: ShellCommandRequest[] = [];
  const vm = createShellViewModel({
    session: fakeSession(calls, (request) => output([`out:${request.input}`], request.input === "fail" ? 2 : 0)),
  });

  assert.equal((await vm.submit("one")).ok, true);
  assert.equal((await vm.submit("fail")).ok, true);

  const firstPrev = vm.historyPrev();

  assert.equal(firstPrev.ok, true);
  assert.equal(firstPrev.state.activeTab.draftInput, "fail");
  assert.equal(firstPrev.state.activeTab.historyIndex, 1);

  const secondPrev = vm.historyPrev();

  assert.equal(secondPrev.ok, true);
  assert.equal(secondPrev.state.activeTab.draftInput, "one");
  assert.equal(secondPrev.state.activeTab.historyIndex, 0);

  const firstNext = vm.historyNext();

  assert.equal(firstNext.ok, true);
  assert.equal(firstNext.state.activeTab.draftInput, "fail");
  assert.equal(firstNext.state.activeTab.historyIndex, 1);

  const secondNext = vm.historyNext();

  assert.equal(secondNext.ok, true);
  assert.equal(secondNext.state.activeTab.draftInput, "");
  assert.equal(secondNext.state.activeTab.historyIndex, null);
  assert.equal(secondNext.state.activeTab.lastExitCode, 2);

  const cleared = vm.clear();

  assert.equal(cleared.ok, true);
  assert.deepEqual(cleared.state.activeTab.outputBuffer, []);
  assert.deepEqual(cleared.state.activeTab.history, ["one", "fail"]);
  assert.equal(cleared.state.activeTab.lastExitCode, null);
  assert.deepEqual(calls.map((request) => request.input), ["one", "fail"]);
});

test("shell output buffering keeps the newest deterministic lines", async () => {
  const calls: ShellCommandRequest[] = [];
  const vm = createShellViewModel({
    outputLimit: 3,
    session: fakeSession(calls, () => output(["a", "b", "c", "d"], 0)),
  });

  const result = await vm.submit("many");

  assert.equal(result.ok, true);
  assert.deepEqual(result.state.activeTab.outputBuffer, [
    {
      kind: "output",
      text: "b",
    },
    {
      kind: "output",
      text: "c",
    },
    {
      kind: "output",
      text: "d",
    },
  ]);
});

test("shell submit fails closed when the session port is missing, denies, throws, or is busy", async () => {
  const missingPort = createShellViewModel({});
  const missingBefore = projectState(missingPort.snapshot());
  const missing = await missingPort.submit("pwd");

  assert.equal(missing.ok, false);
  if (missing.ok) {
    assert.fail("expected missing port to fail closed");
  }
  assert.equal(missing.error.code, "SHELL_SESSION_PORT_UNAVAILABLE");
  assert.deepEqual(projectState(missing.state), missingBefore);

  const deniedCalls: ShellCommandRequest[] = [];
  const deniedVm = createShellViewModel({
    session: {
      runCommand(request) {
        deniedCalls.push(request);
        return reject("SHELL_ACCESS_DENIED", "command denied by session policy.", "/command");
      },
    },
  });
  const deniedBefore = projectState(deniedVm.snapshot());
  const denied = await deniedVm.submit("rm -rf /");

  assert.equal(denied.ok, false);
  if (denied.ok) {
    assert.fail("expected denied command to fail closed");
  }
  assert.equal(denied.error.code, "SHELL_ACCESS_DENIED");
  assert.deepEqual(projectState(denied.state), deniedBefore);
  assert.deepEqual(projectState(deniedVm.snapshot()), deniedBefore);
  assert.equal(deniedCalls.length, 1);

  const thrownCalls: ShellCommandRequest[] = [];
  const throwingVm = createShellViewModel({
    session: {
      runCommand(request) {
        thrownCalls.push(request);
        throw new Error("configured failure");
      },
    },
  });
  const thrownBefore = projectState(throwingVm.snapshot());
  const thrown = await throwingVm.submit("whoami");

  assert.equal(thrown.ok, false);
  if (thrown.ok) {
    assert.fail("expected throwing port to fail closed");
  }
  assert.equal(thrown.error.code, "SHELL_SESSION_PORT_FAILED");
  assert.deepEqual(projectState(thrown.state), thrownBefore);
  assert.deepEqual(thrownCalls.map((request) => request.input), ["whoami"]);

  const busyCalls: ShellCommandRequest[] = [];
  const pending = deferred<ShellCommandResult>();
  const busyVm = createShellViewModel({
    session: {
      runCommand(request) {
        busyCalls.push(request);
        return pending.promise;
      },
    },
  });
  const first = busyVm.submit("sleep");
  const busy = await busyVm.submit("second");

  assert.equal(busy.ok, false);
  if (busy.ok) {
    assert.fail("expected busy session to fail closed");
  }
  assert.equal(busy.error.code, "SESSION_RUNNING");
  assert.equal(busyCalls.length, 1);

  pending.resolve(accept(output(["done"], 0)));

  assert.equal((await first).ok, true);
});

test("shell refuses to close the final remaining tab", () => {
  const vm = createShellViewModel({
    initialTabs: [
      {
        id: "only",
        title: "only",
      },
    ],
    session: fakeSession([], () => output([], 0)),
  });

  const closed = vm.closeTab("only");

  assert.equal(closed.ok, false);
  if (closed.ok) {
    assert.fail("expected final tab close to fail closed");
  }
  assert.equal(closed.error.code, "LAST_TAB");
  assert.deepEqual(closed.state.tabs.map((tab) => tab.id), ["only"]);
  assert.equal(closed.state.activeTabId, "only");
});

function fakeSession(
  calls: ShellCommandRequest[],
  handler: (request: ShellCommandRequest) => ShellCommandOutput,
): ShellSessionPort {
  return {
    runCommand(request) {
      calls.push(request);
      return accept(handler(request));
    },
  };
}

function output(lines: readonly string[], exitCode: number, cwd?: string): ShellCommandOutput {
  const value: {
    lines: readonly string[];
    exitCode: number;
    cwd?: string;
  } = {
    exitCode,
    lines: Object.freeze([...lines]),
  };

  if (cwd !== undefined) value.cwd = cwd;

  return Object.freeze(value);
}

function accept(value: ShellCommandOutput): ShellCommandResult {
  return Object.freeze({
    ok: true,
    value,
  });
}

function reject(code: string, message: string, path: string): ShellCommandResult {
  return Object.freeze({
    error: Object.freeze({
      code,
      message,
      path,
    }),
    ok: false,
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolver: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolver = resolve;
  });

  return Object.freeze({
    promise,
    resolve(value: T): void {
      if (resolver === undefined) {
        assert.fail("deferred resolver was not initialized");
      }

      resolver(value);
    },
  });
}

function projectState(state: ShellViewModelState) {
  return {
    activeTabId: state.activeTabId,
    tabs: state.tabs.map((tab) => ({
      cwd: tab.cwd,
      draftInput: tab.draftInput,
      history: tab.history,
      historyIndex: tab.historyIndex,
      id: tab.id,
      lastExitCode: tab.lastExitCode,
      outputBuffer: tab.outputBuffer,
      running: tab.running,
      title: tab.title,
    })),
  };
}
