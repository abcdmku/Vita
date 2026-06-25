import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createFilesViewModel,
} from "../../../../ui_kits/desktop/viewmodels/files.ts";
import type {
  FilesFavoriteInput,
  FilesViewEntry,
} from "../../../../ui_kits/desktop/viewmodels/files.ts";
import type {
  FilesCapabilityPort,
  FilesErrorResponse,
  FilesRequest,
  FilesResponse,
} from "../../src/desktop-sdk/index.ts";

const FAVORITES = Object.freeze([
  Object.freeze({
    id: "home",
    label: "Home",
    path: "/workspace",
  }),
  Object.freeze({
    id: "src",
    label: "src",
    path: "/workspace/src",
  }),
  Object.freeze({
    id: "apps",
    label: "apps",
    path: "/workspace/src/apps",
  }),
]) satisfies readonly FilesFavoriteInput[];

test("files view-model refreshes through the injected files port and orders folders first", async () => {
  const calls: FilesRequest[] = [];
  const model = createFilesViewModel({
    favorites: FAVORITES,
    files: fakeFilesPort(calls, (request) => {
      assert.equal(request.op, "list");
      assert.equal(request.grant, "workspace");
      assert.equal(request.path, "/workspace/src");

      return {
        entries: [
          entry("zeta.ts", "file", 100, "2026-06-24T10:00:00Z"),
          entry("apps", "dir", 0, "2026-06-24T09:00:00Z"),
          entry("alpha.ts", "file", 50, "2026-06-24T08:00:00Z"),
        ],
      };
    }),
    grant: "workspace",
    initialPath: "/workspace/src",
  });

  const state = await model.refresh();

  assert.deepEqual(calls, [
    {
      grant: "workspace",
      op: "list",
      path: "/workspace/src",
    },
  ]);
  assert.equal(state.status, "ready");
  assert.equal(model.state, state);
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
  assert.deepEqual(state.favorites.map((favorite) => [favorite.id, favorite.selected]), [
    ["home", false],
    ["src", true],
    ["apps", false],
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

test("files view-model navigates, moves up, opens favorites, and selects listed entries", async () => {
  const calls: FilesRequest[] = [];
  const model = createFilesViewModel({
    favorites: FAVORITES,
    files: fakeFilesPort(calls, (request) => {
      if (request.path === "/workspace/src") {
        return {
          entries: [
            entry("apps", "dir", 0, "2026-06-24T09:00:00Z"),
            entry("kernel.ts", "file", 8_400, "2026-06-24T10:18:00Z"),
          ],
        };
      }
      if (request.path === "/workspace/src/apps") {
        return {
          entries: [
            entry("main.ts", "file", 1_200, "2026-06-24T10:20:00Z"),
          ],
        };
      }
      if (request.path === "/workspace") {
        return {
          entries: [
            entry("src", "dir", 0, "2026-06-24T09:00:00Z"),
          ],
        };
      }

      return forbidden();
    }),
    grant: "workspace",
    initialPath: "/workspace/src",
  });

  const apps = await model.navigate("apps");

  assert.equal(apps.path, "/workspace/src/apps");
  assert.deepEqual(apps.entries.map((item) => item.name), ["main.ts"]);
  assert.deepEqual(apps.favorites.map((favorite) => [favorite.id, favorite.selected]), [
    ["home", false],
    ["src", false],
    ["apps", true],
  ]);

  const selected = model.select("main.ts");

  assert.deepEqual(selected.selected, {
    kind: "file",
    modified: "2026-06-24T10:20:00Z",
    name: "main.ts",
    size: 1_200,
  });

  const up = await model.up();

  assert.equal(up.path, "/workspace/src");
  assert.equal(up.selected, undefined);

  const home = await model.openFavorite("home");

  assert.equal(home.path, "/workspace");
  assert.deepEqual(home.entries.map((item) => item.name), ["src"]);
  assert.deepEqual(calls.map((request) => request.path), [
    "/workspace/src/apps",
    "/workspace/src",
    "/workspace",
  ]);
});

test("files view-model fails closed without a files grant before calling the port", async () => {
  const calls: FilesRequest[] = [];
  const model = createFilesViewModel({
    favorites: FAVORITES,
    files: fakeFilesPort(calls, () => {
      throw new Error("must not call files port without grant");
    }),
    initialPath: "/workspace/src",
  });

  const state = await model.refresh();

  assert.deepEqual(calls, []);
  assert.equal(state.status, "forbidden");
  assert.equal(state.path, "/workspace/src");
  assert.deepEqual(state.entries, []);
  assert.equal(state.selected, undefined);
  assert.equal(state.error?.code, "MissingFilesGrant");
});

test("files view-model clears stale state when the SDK files port rejects a directory read", async () => {
  const calls: FilesRequest[] = [];
  const model = createFilesViewModel({
    favorites: FAVORITES,
    files: fakeFilesPort(calls, (request) => {
      if (request.path === "/workspace/src") {
        return {
          entries: [
            entry("kernel.ts", "file", 8_400, "2026-06-24T10:18:00Z"),
          ],
        };
      }

      return forbidden();
    }),
    grant: "workspace",
    initialPath: "/workspace/src",
  });

  await model.refresh();
  model.select(currentEntry(model.state.entries, "kernel.ts"));

  const denied = await model.navigate("/private");

  assert.deepEqual(calls.map((request) => request.path), [
    "/workspace/src",
    "/private",
  ]);
  assert.equal(denied.status, "forbidden");
  assert.equal(denied.path, "/private");
  assert.deepEqual(denied.entries, []);
  assert.equal(denied.selected, undefined);
  assert.equal(denied.error?.code, "AccessForbidden");
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

function entry(
  name: string,
  kind: "file" | "dir" | "symlink-skipped",
  size: number,
  mtime: string,
): NonNullable<FilesResponse["entries"]>[number] {
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

function currentEntry(
  entries: readonly FilesViewEntry[],
  name: string,
): FilesViewEntry {
  for (let index = 0; index < entries.length; index += 1) {
    const item = entries[index];

    if (item !== undefined && item.name === name) return item;
  }

  assert.fail(`missing entry '${name}'`);
}
