import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSearchViewModel,
} from "../../../../ui_kits/desktop/viewmodels/search.ts";
import type {
  SearchAppInput,
  SearchCommandInput,
  SearchFileScope,
  SearchResult,
  SearchSettingInput,
  SearchSource,
  SearchViewModelPorts,
} from "../../../../ui_kits/desktop/viewmodels/search.ts";
import type {
  DesktopAppLaunch,
  DesktopCapability,
  DesktopCapabilityGrant,
  DesktopHostResult,
  DesktopLaunchableApp,
  DesktopLauncherIntent,
  DesktopUiPackageManifest,
  FilesCapabilityPort,
  FilesEntry,
  FilesErrorResponse,
  FilesRequest,
  FilesResponse,
} from "../../src/desktop-sdk/index.ts";

const APP_ID = "vita.app.alpha";
const COMMAND_ID = "vita.command.alpha";
const SETTINGS_APP_ID = "vita.app.settings";
const FILE_GRANT = "workspace";
const FILE_SCOPE = Object.freeze({
  grant: FILE_GRANT,
  label: "Workspace",
  maxDepth: 1,
  path: "/workspace",
}) satisfies SearchFileScope;

test("spotlight aggregates apps, files, commands, and settings into one ranked state", async () => {
  const fixture = fixtureWithAllGrants();
  const model = createSearchViewModel({
    apps: alphaApps(),
    commands: alphaCommands(),
    fileScopes: [FILE_SCOPE],
    ports: fixture.ports,
    settings: alphaSettings(),
  });

  const state = await model.setQuery("ALPHA");

  assert.equal(state.query, "ALPHA");
  assert.equal(state.selectedIndex, 0);
  assert.equal(state.selected, state.results[0]);
  assert.deepEqual(state.results.map((result) => [result.source, result.title]), [
    ["file", "alpha.txt"],
    ["file", "alpha-notes.md"],
    ["app", "Alpha App"],
    ["command", "Alpha Command"],
    ["setting", "Alpha Setting"],
  ]);
  assert.deepEqual(state.groups.map((group) => [
    group.source,
    group.results.map((result) => result.title),
  ]), [
    ["app", ["Alpha App"]],
    ["file", ["alpha.txt", "alpha-notes.md"]],
    ["command", ["Alpha Command"]],
    ["setting", ["Alpha Setting"]],
  ]);
  assert.deepEqual(state.sources.map((source) => [source.source, source.status]), [
    ["app", "ready"],
    ["file", "ready"],
    ["command", "ready"],
    ["setting", "ready"],
  ]);
  assert.deepEqual(fixture.fileCalls.map((request) => [request.op, request.path]), [
    ["list", "/workspace"],
    ["list", "/workspace/projects"],
  ]);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.results), true);
  assert.equal(Object.isFrozen(state.groups), true);
});

test("spotlight selection wraps and empty queries do not fan out into files", async () => {
  const fixture = fixtureWithAllGrants();
  const model = createSearchViewModel({
    apps: alphaApps(),
    commands: alphaCommands(),
    fileScopes: [FILE_SCOPE],
    ports: fixture.ports,
    settings: alphaSettings(),
  });

  assert.deepEqual(model.snapshot().results.map((result) => result.source), ["app", "command", "setting"]);
  assert.deepEqual(fixture.fileCalls, []);

  await model.setQuery("alpha");

  assert.equal(model.moveSelection(1).selectedIndex, 1);
  assert.equal(model.moveSelection(-1).selectedIndex, 0);
  assert.equal(model.moveSelection(-1).selectedIndex, model.state.results.length - 1);
  assert.equal(model.moveSelection(2).selectedIndex, 1);

  const empty = await model.setQuery("missing");

  assert.deepEqual(empty.results, []);
  assert.equal(empty.selectedIndex, -1);
  assert.equal(model.moveSelection(1).selectedIndex, -1);
});

test("spotlight execute routes each source through its injected port", async () => {
  const fixture = fixtureWithAllGrants();
  const model = createSearchViewModel({
    apps: alphaApps(),
    commands: alphaCommands(),
    fileScopes: [FILE_SCOPE],
    ports: fixture.ports,
    settings: alphaSettings(),
  });
  const state = await model.setQuery("alpha");
  const app = findResult(state.results, "app", "Alpha App");
  const command = findResult(state.results, "command", "Alpha Command");
  const file = findResult(state.results, "file", "alpha.txt");
  const setting = findResult(state.results, "setting", "Alpha Setting");

  fixture.events.length = 0;
  fixture.fileCalls.length = 0;

  const launched = await model.execute(app);
  const commanded = await model.execute(command);
  const opened = await model.execute(file);
  const openedSetting = await model.execute(setting);

  assert.equal(launched.ok, true);
  if (!launched.ok) assert.fail("expected app execution to succeed");
  if (launched.dispatch !== "launchApp") assert.fail("expected app launch dispatch");
  assert.equal(launched.value.app.id, APP_ID);

  assert.equal(commanded.ok, true);
  if (!commanded.ok) assert.fail("expected command execution to succeed");
  if (commanded.dispatch !== "launcherIntent") assert.fail("expected launcher intent dispatch");

  assert.equal(opened.ok, true);
  if (!opened.ok) assert.fail("expected file execution to succeed");
  if (opened.dispatch !== "openFile") assert.fail("expected file open dispatch");
  assert.equal(opened.value.path, "/workspace/alpha.txt");
  assert.equal(opened.value.data, "alpha contents");

  assert.equal(openedSetting.ok, true);
  if (!openedSetting.ok) assert.fail("expected setting execution to succeed");
  if (openedSetting.dispatch !== "openSetting") assert.fail("expected setting open dispatch");

  assert.deepEqual(fixture.events, [
    `launch:${APP_ID}`,
    `launcher:launcher.launch:${COMMAND_ID}:alpha run`,
    `launcher:launcher.launch:${SETTINGS_APP_ID}:alpha`,
  ]);
  assert.deepEqual(fixture.fileCalls.map((request) => [request.op, request.path]), [
    ["read", "/workspace/alpha.txt"],
  ]);
});

test("spotlight degrades unavailable sources without crashing or calling denied ports", async () => {
  const events: string[] = [];
  const fileCalls: FilesRequest[] = [];
  const ports = fakePorts(events, [
    grant("apps.launch", APP_ID),
  ], {
    files: fakeFilesPort(fileCalls, () => {
      throw new Error("must not be called without files.read");
    }),
  });
  const model = createSearchViewModel({
    apps: alphaApps(),
    commands: alphaCommands(),
    fileScopes: [FILE_SCOPE],
    ports,
    settings: alphaSettings(),
  });

  const state = await model.setQuery("alpha");

  assert.deepEqual(state.results.map((result) => [result.source, result.title]), [
    ["app", "Alpha App"],
  ]);
  assert.deepEqual(state.sources.map((source) => [source.source, source.status, source.error?.code ?? ""]), [
    ["app", "ready", ""],
    ["file", "forbidden", "MISSING_CAPABILITY"],
    ["command", "forbidden", "MISSING_CAPABILITY"],
    ["setting", "forbidden", "MISSING_CAPABILITY"],
  ]);
  assert.deepEqual(fileCalls, []);

  const launched = await model.execute();

  assert.equal(launched.ok, true);
  assert.deepEqual(events, [`launch:${APP_ID}`]);
});

test("spotlight fails closed when a granted source port throws", async () => {
  const events: string[] = [];
  const fileCalls: FilesRequest[] = [];
  const ports = fakePorts(events, [
    grant("apps.launch", APP_ID),
    grant("files.read", FILE_GRANT),
  ], {
    files: fakeFilesPort(fileCalls, () => {
      throw new Error("configured failure");
    }),
  });
  const model = createSearchViewModel({
    apps: alphaApps(),
    commands: [],
    fileScopes: [FILE_SCOPE],
    ports,
    settings: [],
  });

  const state = await model.setQuery("alpha");

  assert.deepEqual(state.results.map((result) => [result.source, result.title]), [
    ["app", "Alpha App"],
  ]);
  assert.deepEqual(state.sources.map((source) => [source.source, source.status, source.error?.code ?? ""]), [
    ["app", "ready", ""],
    ["file", "error", "FILES_PORT_FAILED"],
    ["command", "ready", ""],
    ["setting", "ready", ""],
  ]);
  assert.deepEqual(fileCalls.map((request) => [request.op, request.path]), [
    ["list", "/workspace"],
  ]);
});

function fixtureWithAllGrants(): {
  readonly events: string[];
  readonly fileCalls: FilesRequest[];
  readonly ports: SearchViewModelPorts;
} {
  const events: string[] = [];
  const fileCalls: FilesRequest[] = [];
  const ports = fakePorts(events, [
    grant("apps.launch", APP_ID),
    grant("launcher.launch", COMMAND_ID),
    grant("launcher.launch", SETTINGS_APP_ID),
    grant("files.read", FILE_GRANT),
  ], {
    files: fakeFilesPort(fileCalls, filesHandler),
  });

  return Object.freeze({
    events,
    fileCalls,
    ports,
  });
}

function alphaApps(): readonly SearchAppInput[] {
  return Object.freeze([
    Object.freeze({
      app: tsxApp(APP_ID, "Alpha App"),
      id: "app.alpha",
      subtitle: "Application",
      title: "Alpha App",
    }),
  ]);
}

function alphaCommands(): readonly SearchCommandInput[] {
  return Object.freeze([
    Object.freeze({
      id: "command.alpha",
      intent: Object.freeze({
        appId: COMMAND_ID,
        query: "alpha run",
        type: "launcher.launch",
      }),
      subtitle: "Command",
      title: "Alpha Command",
    }),
  ]);
}

function alphaSettings(): readonly SearchSettingInput[] {
  return Object.freeze([
    Object.freeze({
      appId: SETTINGS_APP_ID,
      id: "setting.alpha",
      sectionId: "alpha",
      subtitle: "system settings",
      title: "Alpha Setting",
    }),
  ]);
}

function fakePorts(
  events: string[],
  grants: readonly DesktopCapabilityGrant[],
  options: {
    readonly files?: FilesCapabilityPort;
    readonly launcherPort?: boolean;
    readonly launchPort?: boolean;
  } = Object.freeze({}),
): SearchViewModelPorts {
  const ports: {
    package: DesktopUiPackageManifest;
    launchApp?: (app: DesktopLaunchableApp) => DesktopHostResult<DesktopAppLaunch>;
    emitLauncherIntent?: (intent: DesktopLauncherIntent) => DesktopHostResult<true>;
    files?: FilesCapabilityPort;
  } = {
    package: manifest(grants),
  };

  if (options.launchPort !== false) {
    ports.launchApp = (app) => {
      events.push(`launch:${app.id}`);

      return {
        ok: true,
        value: Object.freeze({
          app,
          intents: Object.freeze([]),
          surfaceId: `surface:${app.id}`,
          textureId: `texture:${app.id}`,
          windowId: `window:${app.id}`,
        }),
      };
    };
  }
  if (options.launcherPort !== false) {
    ports.emitLauncherIntent = (intent) => {
      events.push(`launcher:${intent.type}:${intent.appId ?? ""}:${intent.query ?? ""}`);

      return {
        ok: true,
        value: true,
      };
    };
  }
  if (options.files !== undefined) ports.files = options.files;

  return Object.freeze(ports);
}

function fakeFilesPort(
  calls: FilesRequest[],
  handler: (request: FilesRequest) => FilesResponse | FilesErrorResponse,
): FilesCapabilityPort {
  return Object.freeze({
    request(request: FilesRequest) {
      calls.push(request);
      return handler(request);
    },
  });
}

function filesHandler(request: FilesRequest): FilesResponse | FilesErrorResponse {
  if (request.op === "list" && request.path === "/workspace") {
    return Object.freeze({
      entries: Object.freeze([
        entry("projects", "dir", 0, "2026-06-24T09:00:00Z"),
        entry("alpha.txt", "file", 25, "2026-06-24T10:00:00Z"),
        entry("beta.log", "file", 12, "2026-06-24T11:00:00Z"),
      ]),
    });
  }
  if (request.op === "list" && request.path === "/workspace/projects") {
    return Object.freeze({
      entries: Object.freeze([
        entry("alpha-notes.md", "file", 40, "2026-06-24T12:00:00Z"),
      ]),
    });
  }
  if (request.op === "read" && request.path === "/workspace/alpha.txt") {
    return Object.freeze({
      data: "alpha contents",
      kind: "file",
      mtime: "2026-06-24T10:00:00Z",
      size: 25,
    });
  }

  return Object.freeze({
    error: Object.freeze({
      code: "AccessForbidden",
      message: "path is outside the grant",
    }),
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

function findResult(results: readonly SearchResult[], source: SearchSource, title: string): SearchResult {
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];

    if (result !== undefined && result.source === source && result.title === title) return result;
  }

  assert.fail(`missing ${source} result '${title}'`);
}

function tsxApp(id: string, title: string): DesktopLaunchableApp {
  return Object.freeze({
    id,
    runtime: Object.freeze({
      componentId: id,
    }),
    surfaceKind: "tsx",
    title,
  });
}

function manifest(grants: readonly DesktopCapabilityGrant[]): DesktopUiPackageManifest {
  return Object.freeze({
    capabilityGrants: Object.freeze([...grants]),
    entry: "./Search.test.ts",
    id: "ui.search.test",
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
