import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_INDEX_DOCK_APPS,
  INDEX_DOCK_APP_IDS,
} from "../../../../ui_kits/desktop/viewmodels/dock.ts";
import {
  createDesktopIconGrid,
  createDesktopIconsViewModel,
  gridCellToPixel,
} from "../../../../ui_kits/desktop/viewmodels/desktop-icons.ts";
import {
  createDesktopIconsSourceViewModel,
  desktopDirectoryEntryIconId,
  desktopLauncherIconId,
} from "../../../../ui_kits/desktop/viewmodels/desktop-icons-source.ts";
import type {
  DesktopIconsSourceHost,
} from "../../../../ui_kits/desktop/viewmodels/desktop-icons-source.ts";
import type {
  DesktopCapability,
  DesktopCapabilityGrant,
  DesktopHostResult,
  DesktopLauncherIntent,
  DesktopUiPackageManifest,
  FilesCapabilityPort,
  FilesErrorResponse,
  FilesRequest,
  FilesResponse,
} from "../../src/desktop-sdk/index.ts";

const GRID = createDesktopIconGrid({
  cell: {
    height: 32,
    width: 32,
  },
  columns: 4,
  gutter: {
    x: 8,
    y: 8,
  },
  origin: {
    x: 0,
    y: 0,
  },
});

test("desktop icon source binds Desktop entries before deterministic pinned launchers", async () => {
  const calls: FilesRequest[] = [];
  const intents: DesktopLauncherIntent[] = [];
  const source = createDesktopIconsSourceViewModel({
    desktopPath: "/home/alice/Desktop",
    files: fakeFilesPort(calls, (request) => {
      assert.equal(request.op, "list");
      assert.equal(request.grant, "desktop");
      assert.equal(request.path, "/home/alice/Desktop");

      return {
        entries: [
          entry("zeta.txt", "file", 90, "2026-06-24T09:00:00Z"),
          entry("Projects", "dir", 0, "2026-06-24T07:00:00Z"),
          entry("alpha.md", "file", 12, "2026-06-24T08:00:00Z"),
        ],
      };
    }),
    grant: "desktop",
    host: fakeHost(intents, [
      grant("files.read", "desktop"),
      grant("launcher.launch"),
    ]),
    iconModelOptions: {
      grid: GRID,
    },
  });

  const state = await source.refresh();

  assert.deepEqual(calls, [
    {
      grant: "desktop",
      op: "list",
      path: "/home/alice/Desktop",
    },
  ]);
  assert.equal(state.directory.status, "ready");
  assert.deepEqual(state.directory.entries.map((item) => [
    item.id,
    item.label,
    item.kind,
    item.iconRef,
    item.path,
  ]), [
    [
      desktopDirectoryEntryIconId("/home/alice/Desktop/Projects"),
      "Projects",
      "dir",
      "desktop:folder",
      "/home/alice/Desktop/Projects",
    ],
    [
      desktopDirectoryEntryIconId("/home/alice/Desktop/alpha.md"),
      "alpha.md",
      "file",
      "desktop:file",
      "/home/alice/Desktop/alpha.md",
    ],
    [
      desktopDirectoryEntryIconId("/home/alice/Desktop/zeta.txt"),
      "zeta.txt",
      "file",
      "desktop:file",
      "/home/alice/Desktop/zeta.txt",
    ],
  ]);
  assert.deepEqual(state.launchers.apps.map((item) => [
    item.id,
    item.appId,
    item.label,
    item.iconRef,
  ]), DEFAULT_INDEX_DOCK_APPS.map((app) => [
    desktopLauncherIconId(app.appId),
    app.appId,
    app.title,
    `dock:${app.icon}`,
  ]));
  assert.deepEqual(state.icons.map((item) => [
    item.id,
    item.label,
    item.kind,
    item.iconRef,
  ]), [
    [
      desktopDirectoryEntryIconId("/home/alice/Desktop/Projects"),
      "Projects",
      "dir",
      "desktop:folder",
    ],
    [
      desktopDirectoryEntryIconId("/home/alice/Desktop/alpha.md"),
      "alpha.md",
      "file",
      "desktop:file",
    ],
    [
      desktopDirectoryEntryIconId("/home/alice/Desktop/zeta.txt"),
      "zeta.txt",
      "file",
      "desktop:file",
    ],
    ...DEFAULT_INDEX_DOCK_APPS.map((app) => [
      desktopLauncherIconId(app.appId),
      app.title,
      "launcher",
      `dock:${app.icon}`,
    ]),
  ]);
  assert.equal(JSON.stringify(state.icons), JSON.stringify(source.snapshot().icons));
  assert.deepEqual(intents, []);
});

test("desktop icon source activates folders and files through the SDK files helpers", async () => {
  const calls: FilesRequest[] = [];
  const source = createDesktopIconsSourceViewModel({
    desktopPath: "/Desktop",
    files: fakeFilesPort(calls, (request) => {
      if (request.op === "list" && request.path === "/Desktop") {
        return {
          entries: [
            entry("Notes.txt", "file", 24, "2026-06-24T08:00:00Z"),
            entry("Projects", "dir", 0, "2026-06-24T07:00:00Z"),
          ],
        };
      }
      if (request.op === "list" && request.path === "/Desktop/Projects") {
        return {
          entries: [
            entry("Plan.md", "file", 30, "2026-06-24T09:00:00Z"),
          ],
        };
      }
      if (request.op === "read" && request.path === "/Desktop/Notes.txt") {
        return {
          data: "meeting notes",
          mtime: "2026-06-24T08:00:00Z",
          size: 24,
        };
      }

      return forbidden();
    }),
    grant: "desktop",
    host: fakeHost([], [
      grant("files.read", "desktop"),
      grant("launcher.launch"),
    ]),
    iconModelOptions: {
      grid: GRID,
    },
  });

  await source.refresh();
  calls.length = 0;

  const folder = await source.activate(desktopDirectoryEntryIconId("/Desktop/Projects"));

  assert.equal(folder.ok, true);
  if (!folder.ok || folder.dispatch !== "openDirectory") {
    assert.fail("expected folder activation to open a directory");
  }
  assert.equal(folder.path, "/Desktop/Projects");
  assert.equal(folder.transition.state.path, "/Desktop/Projects");
  assert.deepEqual(calls, [
    {
      grant: "desktop",
      op: "list",
      path: "/Desktop/Projects",
    },
  ]);

  calls.length = 0;
  const file = await source.activate(desktopDirectoryEntryIconId("/Desktop/Notes.txt"));

  assert.equal(file.ok, true);
  if (!file.ok || file.dispatch !== "readFile") {
    assert.fail("expected file activation to read the file");
  }
  assert.equal(file.path, "/Desktop/Notes.txt");
  assert.equal(file.transition.state.selected?.data, "meeting notes");
  assert.deepEqual(calls, [
    {
      grant: "desktop",
      op: "read",
      path: "/Desktop/Notes.txt",
    },
  ]);
});

test("desktop icon source emits exactly one launcher intent for pinned app activation", async () => {
  const calls: FilesRequest[] = [];
  const intents: DesktopLauncherIntent[] = [];
  const source = createDesktopIconsSourceViewModel({
    desktopPath: "/Desktop",
    files: fakeFilesPort(calls, () => ({
      entries: [],
    })),
    grant: "desktop",
    host: fakeHost(intents, [
      grant("files.read", "desktop"),
      grant("launcher.launch"),
    ]),
    iconModelOptions: {
      grid: GRID,
    },
  });

  await source.refresh();
  const result = await source.activate(desktopLauncherIconId(INDEX_DOCK_APP_IDS.terminal));

  assert.equal(result.ok, true);
  if (!result.ok || result.dispatch !== "launcherIntent") {
    assert.fail("expected launcher activation to emit an intent");
  }
  assert.equal(result.appId, INDEX_DOCK_APP_IDS.terminal);
  assert.deepEqual(result.intent, {
    appId: INDEX_DOCK_APP_IDS.terminal,
    type: "launcher.launch",
  });
  assert.deepEqual(intents, [
    {
      appId: INDEX_DOCK_APP_IDS.terminal,
      type: "launcher.launch",
    },
  ]);
});

test("desktop icon source reconcile keeps stable ids and positions while adding and removing entries", async () => {
  let desktopEntries: readonly NonNullable<FilesResponse["entries"]>[number][] = Object.freeze([
    entry("Archive", "dir", 0, "2026-06-24T07:00:00Z"),
    entry("Notes.txt", "file", 24, "2026-06-24T08:00:00Z"),
  ]);
  const source = createDesktopIconsSourceViewModel({
    desktopPath: "/Desktop",
    files: fakeFilesPort([], (request) => {
      assert.equal(request.op, "list");

      return {
        entries: desktopEntries,
      };
    }),
    grant: "desktop",
    host: fakeHost([], [
      grant("files.read", "desktop"),
      grant("launcher.launch"),
    ]),
    iconModel: createDesktopIconsViewModel({
      grid: GRID,
      mode: "free",
    }),
  });

  const first = await source.refresh();
  const archiveId = desktopDirectoryEntryIconId("/Desktop/Archive");
  const notesId = desktopDirectoryEntryIconId("/Desktop/Notes.txt");
  const terminalId = desktopLauncherIconId(INDEX_DOCK_APP_IDS.terminal);
  const movedPosition = gridCellToPixel({
    col: 3,
    row: 4,
  }, GRID);
  source.iconModel.setIcons(first.icons.map((icon) => icon.id === notesId
    ? {
        ...icon,
        position: movedPosition,
      }
    : icon));

  desktopEntries = Object.freeze([
    entry("Notes.txt", "file", 24, "2026-06-24T08:00:00Z"),
    entry("Todo.txt", "file", 10, "2026-06-24T09:00:00Z"),
  ]);

  const reconciled = await source.reconcile();
  const todoId = desktopDirectoryEntryIconId("/Desktop/Todo.txt");

  assert.equal(hasIcon(reconciled.icons, archiveId), false);
  assert.equal(hasIcon(reconciled.icons, notesId), true);
  assert.equal(hasIcon(reconciled.icons, todoId), true);
  assert.equal(hasIcon(reconciled.icons, terminalId), true);
  assert.deepEqual(iconPosition(reconciled.icons, notesId), movedPosition);
  assert.deepEqual(reconciled.icons.map((icon) => icon.id).slice(0, 2), [
    notesId,
    todoId,
  ]);
});

test("desktop icon source fails closed without files.read before port I/O", async () => {
  const calls: FilesRequest[] = [];
  const source = createDesktopIconsSourceViewModel({
    desktopPath: "/Desktop",
    files: fakeFilesPort(calls, () => {
      throw new Error("must not call files port without files.read grant");
    }),
    grant: "desktop",
    host: fakeHost([], [
      grant("launcher.launch"),
    ]),
    iconModelOptions: {
      grid: GRID,
    },
  });

  const state = await source.refresh();

  assert.deepEqual(calls, []);
  assert.equal(state.directory.status, "forbidden");
  assert.deepEqual(state.directory.entries, []);
  assert.equal(state.directory.error?.code, "MISSING_FILES_GRANT");

  const result = await source.activate(desktopDirectoryEntryIconId("/Desktop/Notes.txt"));

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail("expected missing files.read to deny activation");
  }
  assert.equal(result.error.code, "MISSING_FILES_GRANT");
  assert.deepEqual(calls, []);
});

test("desktop icon source fails closed without launcher.launch before emitting intents", async () => {
  const intents: DesktopLauncherIntent[] = [];
  const source = createDesktopIconsSourceViewModel({
    desktopPath: "/Desktop",
    files: fakeFilesPort([], () => ({
      entries: [],
    })),
    grant: "desktop",
    host: fakeHost(intents, [
      grant("files.read", "desktop"),
    ]),
    iconModelOptions: {
      grid: GRID,
    },
  });

  const state = await source.refresh();

  assert.equal(state.launchers.status, "forbidden");
  assert.deepEqual(state.launchers.apps, []);

  const result = await source.activate(desktopLauncherIconId(INDEX_DOCK_APP_IDS.terminal));

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail("expected missing launcher.launch to deny activation");
  }
  assert.equal(result.error.code, "MISSING_LAUNCHER_GRANT");
  assert.deepEqual(intents, []);
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

function fakeHost(
  intents: DesktopLauncherIntent[],
  grants: readonly DesktopCapabilityGrant[],
): DesktopIconsSourceHost {
  return Object.freeze({
    emitLauncherIntent(intent: DesktopLauncherIntent): DesktopHostResult<true> {
      intents.push(intent);

      return {
        ok: true,
        value: true,
      };
    },
    package: manifest(grants),
  });
}

function manifest(grants: readonly DesktopCapabilityGrant[]): DesktopUiPackageManifest {
  return Object.freeze({
    capabilityGrants: Object.freeze([...grants]),
    entry: "./desktop-icons-source.ts",
    id: "ui.desktop-icons-source.test",
    sdkVersion: "1.0.0",
    version: "1.0.0",
  });
}

function grant(
  capability: DesktopCapability,
  resourceId?: string,
): DesktopCapabilityGrant {
  const output: {
    capability: DesktopCapability;
    resourceId?: string;
  } = {
    capability,
  };

  if (resourceId !== undefined) output.resourceId = resourceId;

  return Object.freeze(output);
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

function hasIcon(
  icons: readonly { readonly id: string }[],
  id: string,
): boolean {
  for (let index = 0; index < icons.length; index += 1) {
    if (icons[index]?.id === id) return true;
  }

  return false;
}

function iconPosition(
  icons: readonly { readonly id: string; readonly position: { readonly x: number; readonly y: number } }[],
  id: string,
): { readonly x: number; readonly y: number } {
  for (let index = 0; index < icons.length; index += 1) {
    const icon = icons[index];

    if (icon !== undefined && icon.id === id) return icon.position;
  }

  assert.fail(`missing icon '${id}'`);
}
