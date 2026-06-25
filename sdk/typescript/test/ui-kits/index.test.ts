import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_INDEX_PALETTE_COMMANDS,
  INDEX_PALETTE_APP_IDS,
  INDEX_PALETTE_COMMAND_IDS,
  createIndexPaletteViewModel,
  rankIndexPaletteCommands,
} from "../../../../ui_kits/desktop/viewmodels/index.ts";
import type {
  IndexPalettePorts,
} from "../../../../ui_kits/desktop/viewmodels/index.ts";
import type {
  DesktopAppLaunch,
  DesktopCapability,
  DesktopCapabilityGrant,
  DesktopHostResult,
  DesktopLaunchableApp,
  DesktopLauncherIntent,
  DesktopUiPackageManifest,
} from "../../src/desktop-sdk/index.ts";

test("index palette seeds design commands and dock apps deterministically", () => {
  const viewModel = createIndexPaletteViewModel(fakePorts([]));
  const snapshot = viewModel.snapshot();

  assert.deepEqual(viewModel.registry.map((command) => [
    command.id,
    command.title,
    command.kind,
  ]), [
    [INDEX_PALETTE_COMMAND_IDS.runKernel, "Run kernel.ts", "command"],
    ["app.files", "Open Files", "app"],
    [INDEX_PALETTE_COMMAND_IDS.toggleDarkMode, "Toggle Dark Mode", "command"],
    ["app.terminal", "Terminal", "app"],
    ["app.code", "Code", "app"],
    ["app.mail", "Mail", "app"],
    ["app.browser", "Browser", "app"],
    ["app.settings", "Settings", "app"],
  ]);
  assert.deepEqual(snapshot.results.map((command) => command.id), DEFAULT_INDEX_PALETTE_COMMANDS.map((command) => command.id));
  assert.equal(snapshot.query, "");
  assert.equal(snapshot.highlightedIndex, 0);
});

test("index palette setQuery performs deterministic fuzzy ranking", () => {
  const viewModel = createIndexPaletteViewModel(fakePorts([]));

  assert.equal(rankIndexPaletteCommands("rk")[0]?.id, INDEX_PALETTE_COMMAND_IDS.runKernel);

  let state = viewModel.setQuery("FILES");

  assert.equal(state.query, "FILES");
  assert.equal(state.highlightedIndex, 0);
  assert.equal(state.results[0]?.id, "app.files");

  state = viewModel.setQuery("tdm");

  assert.deepEqual(state.results.map((command) => command.id), [
    INDEX_PALETTE_COMMAND_IDS.toggleDarkMode,
  ]);

  state = viewModel.setQuery("missing");

  assert.deepEqual(state.results, []);
  assert.equal(state.highlightedIndex, -1);
});

test("index palette moveSelection wraps through ranked results", () => {
  const viewModel = createIndexPaletteViewModel(fakePorts([]));

  assert.equal(viewModel.moveSelection(1).highlightedIndex, 1);
  assert.equal(viewModel.moveSelection(-1).highlightedIndex, 0);
  assert.equal(viewModel.moveSelection(-1).highlightedIndex, DEFAULT_INDEX_PALETTE_COMMANDS.length - 1);
  assert.equal(viewModel.moveSelection(2).highlightedIndex, 1);

  const empty = viewModel.setQuery("no-such-command");

  assert.equal(empty.highlightedIndex, -1);
  assert.equal(viewModel.moveSelection(1).highlightedIndex, -1);
});

test("index palette execute launches app commands through the app-launch port", async () => {
  const events: string[] = [];
  const viewModel = createIndexPaletteViewModel(fakePorts(events, [
    grant("apps.launch", INDEX_PALETTE_APP_IDS.files),
  ]));

  viewModel.setQuery("files");
  const result = await viewModel.execute(0);

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail("expected Open Files launch to succeed");
  }
  assert.equal(result.command.id, "app.files");
  assert.equal(result.dispatch, "launchApp");
  assert.equal(result.value.app.id, INDEX_PALETTE_APP_IDS.files);
  assert.deepEqual(events, [
    `launch:${INDEX_PALETTE_APP_IDS.files}`,
  ]);
});

test("index palette execute dispatches command actions through the launcher port", async () => {
  const events: string[] = [];
  const viewModel = createIndexPaletteViewModel(fakePorts(events, [
    grant("launcher.launch", "vita.command.run-kernel"),
  ]));

  viewModel.setQuery("kernel");
  const result = await viewModel.execute(0);

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail("expected Run kernel.ts command to succeed");
  }
  assert.equal(result.command.id, INDEX_PALETTE_COMMAND_IDS.runKernel);
  assert.equal(result.dispatch, "launcherIntent");
  assert.deepEqual(events, [
    "launcher:launcher.launch:vita.command.run-kernel:kernel.ts",
  ]);
});

test("index palette execute fails closed without required capability", async () => {
  const events: string[] = [];
  const viewModel = createIndexPaletteViewModel(fakePorts(events));

  viewModel.setQuery("dark");
  const result = await viewModel.execute(0);

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail("expected missing launcher capability to fail");
  }
  assert.equal(result.command?.id, INDEX_PALETTE_COMMAND_IDS.toggleDarkMode);
  assert.equal(result.error.code, "MISSING_CAPABILITY");
  assert.deepEqual(events, []);
});

test("index palette execute fails closed when launcher port is unavailable", async () => {
  const events: string[] = [];
  const viewModel = createIndexPaletteViewModel(fakePorts(events, [
    grant("launcher.launch", "vita.command.toggle-dark-mode"),
  ], {
    launcherPort: false,
  }));

  viewModel.setQuery("dark");
  const result = await viewModel.execute(0);

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail("expected unavailable launcher port to fail");
  }
  assert.equal(result.error.code, "LAUNCHER_PORT_UNAVAILABLE");
  assert.deepEqual(events, []);
});

test("index palette execute rejects invalid selection without dispatch", async () => {
  const events: string[] = [];
  const viewModel = createIndexPaletteViewModel(fakePorts(events, [
    grant("apps.launch", INDEX_PALETTE_APP_IDS.files),
  ]));

  const result = await viewModel.execute(99);

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail("expected invalid selection to fail");
  }
  assert.equal(result.error.code, "INVALID_SELECTION");
  assert.deepEqual(events, []);
});

function fakePorts(
  events: string[],
  grants: readonly DesktopCapabilityGrant[] = Object.freeze([]),
  options: {
    readonly launcherPort?: boolean;
  } = Object.freeze({}),
): IndexPalettePorts {
  const ports: {
    package: DesktopUiPackageManifest;
    launchApp(app: DesktopLaunchableApp): DesktopHostResult<DesktopAppLaunch>;
    emitLauncherIntent?: (intent: DesktopLauncherIntent) => DesktopHostResult<true>;
  } = {
    launchApp(app) {
      events.push(`launch:${app.id}`);

      return {
        ok: true,
        value: Object.freeze({
          app,
          intents: Object.freeze([]),
          surfaceId: `surface:${app.id}`,
          textureId: `surface:${app.id}`,
          windowId: `window:${app.id}`,
        }),
      };
    },
    package: manifest(grants),
  };

  if (options.launcherPort !== false) {
    ports.emitLauncherIntent = (intent) => {
      events.push(`launcher:${intent.type}:${intent.appId ?? ""}:${intent.query ?? ""}`);

      return {
        ok: true,
        value: true,
      };
    };
  }

  return Object.freeze(ports);
}

function manifest(grants: readonly DesktopCapabilityGrant[]): DesktopUiPackageManifest {
  return Object.freeze({
    capabilityGrants: Object.freeze([...grants]),
    entry: "./index.ts",
    id: "ui.index-palette.test",
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
