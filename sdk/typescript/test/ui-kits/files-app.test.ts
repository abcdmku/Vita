import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FILES_APP_ENTRY,
  FILES_APP_ID,
  FILES_APP_PARTITION,
  filesAppPackage,
} from "../../../../apps/files/manifest.ts";
import {
  createFilesAppViewModel,
} from "../../../../ui_kits/desktop/viewmodels/apps/files-app.ts";
import type {
  FilesAppDirectoryEntry,
  FilesAppResult,
  FilesAppState,
} from "../../../../ui_kits/desktop/viewmodels/apps/files-app.ts";
import {
  SDK_VERSION,
  defineAppPackage,
  hasAppCapabilityGrant,
} from "../../src/desktop-sdk/index.ts";
import type {
  DesktopCapability,
  FilesCapabilityPort,
  FilesEntry,
  FilesErrorResponse,
  FilesRequest,
  FilesResponse,
} from "../../src/desktop-sdk/index.ts";

test("Files app package manifest is valid, minimal, and aligned with its web descriptor", () => {
  const app = defineAppPackage(filesAppPackage);

  assert.equal(app.manifest.id, FILES_APP_ID);
  assert.equal(app.manifest.version, "1.0.0");
  assert.equal(app.manifest.sdkVersion, SDK_VERSION);
  assert.equal(app.manifest.entry, FILES_APP_ENTRY);
  assert.deepEqual(app.manifest.capabilityGrants.map((grant) => grant.capability), [
    "files.read",
    "files.write",
  ]);
  assert.equal(hasAppCapabilityGrant(app.manifest, "files.read"), true);
  assert.equal(hasAppCapabilityGrant(app.manifest, "files.write"), true);

  const deniedCapabilities: readonly DesktopCapability[] = Object.freeze([
    "apps.launch",
    "apps.stop",
    "launcher.launch",
    "settings.read",
    "settings.write",
    "shell.notifications.post",
    "shell.tray.register",
  ]);

  for (let index = 0; index < deniedCapabilities.length; index += 1) {
    const capability = deniedCapabilities[index];

    if (capability !== undefined) {
      assert.equal(hasAppCapabilityGrant(app.manifest, capability), false, capability);
    }
  }

  assert.equal(app.descriptor.id, app.manifest.id);
  assert.equal(app.descriptor.surfaceKind, "web");
  assert.equal(app.descriptor.title, "Files");
  assert.equal(app.descriptor.runtime.url, app.manifest.entry);
  assert.equal(app.descriptor.runtime.partition, FILES_APP_PARTITION);
  assert.equal(app.descriptor.defaultWindow?.mode, "floating");
  assert.equal(Object.isFrozen(app), true);
  assert.equal(Object.isFrozen(app.manifest.capabilityGrants), true);
  assert.equal(Object.isFrozen(app.descriptor.runtime), true);
});

test("Files app view-model refreshes through the injected files port and orders entries deterministically", async () => {
  const calls: FilesRequest[] = [];
  const model = createFilesAppViewModel({
    files: fakeFilesPort(calls, (request) => {
      assert.equal(request.op, "list");
      assert.equal(request.grant, "workspace");
      assert.equal(request.path, "/workspace/src");

      return entries([
        entry("zeta.ts", "file", 100, "2026-06-24T10:00:00Z"),
        entry("apps", "dir", 0, "2026-06-24T09:00:00Z"),
        entry("alpha.ts", "file", 50, "2026-06-24T08:00:00Z"),
      ]);
    }),
    grant: "workspace",
    initialPath: "/workspace/src",
  });

  const state = expectOk(await model.refresh());

  assert.deepEqual(calls, [
    {
      grant: "workspace",
      op: "list",
      path: "/workspace/src",
    },
  ]);
  assert.equal(model.snapshot(), state);
  assert.equal(model.state, state);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.entries), true);
  assert.deepEqual(state.breadcrumbs, [
    {
      label: "/",
      path: "/",
    },
    {
      label: "workspace",
      path: "/workspace",
    },
    {
      label: "src",
      path: "/workspace/src",
    },
  ]);
  assert.deepEqual(state.entries, [
    {
      kind: "dir",
      modified: "2026-06-24T09:00:00Z",
      name: "apps",
      size: 0,
    },
    {
      kind: "file",
      modified: "2026-06-24T08:00:00Z",
      name: "alpha.ts",
      size: 50,
    },
    {
      kind: "file",
      modified: "2026-06-24T10:00:00Z",
      name: "zeta.ts",
      size: 100,
    },
  ]);
  assert.equal(state.selected, undefined);
});

test("Files app view-model navigates, moves up, selects entries, and refreshes current state", async () => {
  const calls: FilesRequest[] = [];
  const model = createFilesAppViewModel({
    files: fakeFilesPort(calls, (request) => {
      if (request.path === "/workspace/src/apps") {
        return entries([
          entry("main.ts", "file", 1_200, "2026-06-24T10:20:00Z"),
        ]);
      }
      if (request.path === "/workspace/src") {
        return entries([
          entry("apps", "dir", 0, "2026-06-24T09:00:00Z"),
          entry("kernel.ts", "file", 8_400, "2026-06-24T10:18:00Z"),
        ]);
      }

      return forbidden();
    }),
    grant: "workspace",
    initialPath: "/workspace/src",
  });

  const apps = expectOk(await model.navigate("apps"));

  assert.equal(apps.path, "/workspace/src/apps");
  assert.deepEqual(apps.entries.map((item) => item.name), ["main.ts"]);

  const selected = expectOk(model.select(currentEntry(apps, "main.ts")));

  assert.deepEqual(selected.selected, {
    kind: "file",
    modified: "2026-06-24T10:20:00Z",
    name: "main.ts",
    size: 1_200,
  });

  const missingSelection = model.select("missing.txt");

  assert.equal(missingSelection.ok, false);
  if (missingSelection.ok) {
    assert.fail("expected missing selection to fail closed");
  }
  assert.equal(missingSelection.error.code, "EntryNotFound");
  assert.equal(model.snapshot(), selected);

  const up = expectOk(await model.up());

  assert.equal(up.path, "/workspace/src");
  assert.equal(up.selected, undefined);

  const refreshed = expectOk(await model.refresh());

  assert.equal(refreshed.path, "/workspace/src");
  assert.deepEqual(calls.map((request) => request.path), [
    "/workspace/src/apps",
    "/workspace/src",
    "/workspace/src",
  ]);
});

test("Files app view-model fails closed before calling the files port when the grant is missing", async () => {
  const calls: FilesRequest[] = [];
  const model = createFilesAppViewModel({
    files: fakeFilesPort(calls, () => {
      throw new Error("must not call files port without grant");
    }),
    initialPath: "/workspace/src",
  });

  const result = await model.refresh();

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail("expected missing grant failure");
  }
  assert.deepEqual(calls, []);
  assert.equal(result.error.code, "MissingFilesGrant");
  assertFailClosedState(model.snapshot(), "forbidden", "/workspace/src", "MissingFilesGrant");
});

test("Files app view-model fails closed when the files port denies a directory read", async () => {
  const calls: FilesRequest[] = [];
  const model = createFilesAppViewModel({
    files: fakeFilesPort(calls, (request) => {
      if (request.path === "/workspace/src") {
        return entries([
          entry("kernel.ts", "file", 8_400, "2026-06-24T10:18:00Z"),
        ]);
      }

      return forbidden();
    }),
    grant: "workspace",
    initialPath: "/workspace/src",
  });

  const ready = expectOk(await model.refresh());

  expectOk(model.select(currentEntry(ready, "kernel.ts")));

  const denied = await model.navigate("/private");

  assert.equal(denied.ok, false);
  if (denied.ok) {
    assert.fail("expected denied directory read");
  }
  assert.deepEqual(calls.map((request) => request.path), [
    "/workspace/src",
    "/private",
  ]);
  assert.equal(denied.error.code, "AccessForbidden");
  assertFailClosedState(model.snapshot(), "forbidden", "/private", "AccessForbidden");
});

function fakeFilesPort(
  calls: FilesRequest[],
  handler: (request: FilesRequest) => FilesResponse | FilesErrorResponse,
): FilesCapabilityPort {
  return {
    request(request) {
      calls.push(request);
      return handler(request);
    },
  };
}

function entries(value: readonly FilesEntry[]): FilesResponse {
  return Object.freeze({
    entries: Object.freeze([...value]),
  });
}

function entry(
  name: string,
  kind: FilesEntry["kind"],
  size: number,
  mtime: string,
): FilesEntry {
  return Object.freeze({
    kind,
    mtime,
    name,
    size,
  });
}

function forbidden(): FilesErrorResponse {
  return Object.freeze({
    error: Object.freeze({
      code: "AccessForbidden",
      message: "path is outside the grant",
    }),
  });
}

function expectOk<T>(result: FilesAppResult<T>): T {
  if (!result.ok) {
    assert.fail(`expected ok result, got ${result.error.code}`);
  }

  return result.value;
}

function currentEntry(
  state: FilesAppState,
  name: string,
): FilesAppDirectoryEntry {
  for (let index = 0; index < state.entries.length; index += 1) {
    const item = state.entries[index];

    if (item !== undefined && item.name === name) return item;
  }

  assert.fail(`missing entry '${name}'`);
}

function assertFailClosedState(
  state: FilesAppState,
  status: "forbidden" | "error",
  path: string,
  code: string,
): void {
  assert.equal(state.status, status);
  assert.equal(state.path, path);
  assert.deepEqual(state.entries, []);
  assert.equal(state.selected, undefined);
  assert.equal(state.error?.code, code);
}
