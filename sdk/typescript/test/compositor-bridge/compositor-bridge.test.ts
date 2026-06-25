import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CompositorDriver,
  compositorWindowPlacement,
} from "../../src/compositor-bridge/index.ts";
import type {
  CompositorCommand,
  CompositorPort,
  CompositorRect,
  CompositorSurfaceKind,
  CompositorSurfaceSize,
  CompositorWindowPlacement,
} from "../../src/compositor-bridge/index.ts";
import type { ShellComposedLayout, ShellResolvedSurface } from "../../src/shell/index.ts";
import type { Rect, WindowManagerIntent, WindowPlacement } from "../../src/wm/policy.ts";

test("initial reconcile registers and places shell plus WM surfaces in stable z order", async () => {
  const calls: CompositorCommand[] = [];
  const driver = new CompositorDriver(recordingPort(calls));

  const result = await driver.reconcile({
    shell: chromeLikeShell(),
    windows: [
      windowSurface("mail", rect(80, 72, 600, 440), 1),
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(projectCommands(result.commands), [
    {
      id: "surface:desktop",
      kind: "shell:desktop",
      size: size(1440, 900),
      type: "registerSurface",
    },
    {
      id: "surface:desktop",
      rect: rect(0, 0, 1440, 900),
      type: "updatePlacement",
      visible: true,
      z: 10_000,
    },
    {
      id: "texture-mail",
      kind: "window",
      size: size(600, 440),
      type: "registerSurface",
    },
    {
      id: "texture-mail",
      rect: rect(80, 72, 600, 440),
      type: "updatePlacement",
      visible: true,
      z: 20_001,
    },
    {
      id: "surface:panel",
      kind: "shell:panel",
      size: size(1440, 40),
      type: "registerSurface",
    },
    {
      id: "surface:panel",
      rect: rect(0, 0, 1440, 40),
      type: "updatePlacement",
      visible: true,
      z: 30_001,
    },
    {
      type: "present",
    },
  ]);
  assert.deepEqual(calls, result.commands);

  calls.length = 0;
  const second = await driver.reconcile({
    shell: chromeLikeShell(),
    windows: [
      windowSurface("mail", rect(80, 72, 600, 440), 1),
    ],
  });

  assert.equal(second.ok, true);
  assert.deepEqual(second.commands, []);
  assert.deepEqual(calls, []);
});

test("move and resize reconcile as updatePlacement only", async () => {
  const calls: CompositorCommand[] = [];
  const driver = new CompositorDriver(recordingPort(calls));
  await mustReconcile(driver, {
    shell: chromeLikeShell(),
    windows: [
      windowSurface("mail", rect(80, 72, 600, 440), 1),
    ],
  });

  calls.length = 0;
  const moved = await driver.reconcile({
    shell: chromeLikeShell(),
    windows: [
      windowSurface("mail", rect(120, 90, 720, 460), 1),
    ],
  });

  assert.equal(moved.ok, true);
  assert.deepEqual(projectCommands(moved.commands), [
    {
      id: "texture-mail",
      rect: rect(120, 90, 720, 460),
      type: "updatePlacement",
      visible: true,
      z: 20_001,
    },
    {
      type: "present",
    },
  ]);
  assert.equal(calls.some((call) => call.type === "registerSurface"), false);
  assert.equal(calls.some((call) => call.type === "removeSurface"), false);
});

test("restack and WM visibility intents update placement without removing desired hidden surfaces", async () => {
  const calls: CompositorCommand[] = [];
  const driver = new CompositorDriver(recordingPort(calls));
  await mustReconcile(driver, {
    shell: chromeLikeShell(),
    windows: [
      windowSurface("mail", rect(80, 72, 600, 440), 1),
      windowSurface("chat", rect(160, 120, 500, 360), 2),
    ],
  });

  calls.length = 0;
  const hiddenIntent: WindowManagerIntent = Object.freeze({
    textureId: "texture-chat",
    type: "setTextureVisibility",
    visible: false,
    windowId: "chat",
  });
  const restackedHidden = await driver.reconcile({
    shell: chromeLikeShell(),
    windows: [
      windowSurface("chat", rect(160, 120, 500, 360), 2),
      windowSurface("mail", rect(80, 72, 600, 440), 3),
    ],
    windowIntents: [
      hiddenIntent,
    ],
  });

  assert.equal(restackedHidden.ok, true);
  assert.deepEqual(projectCommands(restackedHidden.commands), [
    {
      id: "texture-chat",
      rect: rect(160, 120, 500, 360),
      type: "updatePlacement",
      visible: false,
      z: 20_002,
    },
    {
      id: "texture-mail",
      rect: rect(80, 72, 600, 440),
      type: "updatePlacement",
      visible: true,
      z: 20_003,
    },
    {
      type: "present",
    },
  ]);
  assert.equal(calls.some((call) => call.type === "removeSurface" && call.id === "texture-chat"), false);

  calls.length = 0;
  const second = await driver.reconcile({
    shell: chromeLikeShell(),
    windows: [
      windowSurface("chat", rect(160, 120, 500, 360), 2),
      windowSurface("mail", rect(80, 72, 600, 440), 3),
    ],
    windowIntents: [
      hiddenIntent,
    ],
  });

  assert.equal(second.ok, true);
  assert.deepEqual(second.commands, []);
  assert.deepEqual(calls, []);
});

test("WM stream registering a newly visible window emits register and placement commands", async () => {
  const calls: CompositorCommand[] = [];
  const driver = new CompositorDriver(recordingPort(calls));
  await mustReconcile(driver, {
    shell: chromeLikeShell(),
    windows: [],
  });

  calls.length = 0;
  const visibleIntent: WindowManagerIntent = Object.freeze({
    textureId: "texture-files",
    type: "setTextureVisibility",
    visible: true,
    windowId: "files",
  });
  const repositionIntent: WindowManagerIntent = Object.freeze({
    rect: rect(40, 56, 720, 540),
    textureId: "texture-files",
    type: "repositionTexture",
    windowId: "files",
  });
  const opened = await driver.reconcile({
    shell: chromeLikeShell(),
    windowIntents: [
      visibleIntent,
      repositionIntent,
    ],
    windows: [],
  });

  assert.equal(opened.ok, true);
  assert.deepEqual(projectCommands(opened.commands), [
    {
      id: "texture-files",
      kind: "window",
      size: size(720, 540),
      type: "registerSurface",
    },
    {
      id: "texture-files",
      rect: rect(40, 56, 720, 540),
      type: "updatePlacement",
      visible: true,
      z: 20_000,
    },
    {
      type: "present",
    },
  ]);
  assert.deepEqual(calls, opened.commands);

  calls.length = 0;
  const second = await driver.reconcile({
    shell: chromeLikeShell(),
    windowIntents: [
      visibleIntent,
      repositionIntent,
    ],
    windows: [],
  });

  assert.equal(second.ok, true);
  assert.deepEqual(second.commands, []);
  assert.deepEqual(calls, []);
});

test("delta WM reposition intent leaves unmentioned current surfaces unchanged", async () => {
  const calls: CompositorCommand[] = [];
  const driver = new CompositorDriver(recordingPort(calls));
  await mustReconcile(driver, {
    shell: chromeLikeShell(),
    windows: [
      windowSurface("mail", rect(80, 72, 600, 440), 1),
      windowSurface("chat", rect(160, 120, 500, 360), 2),
    ],
  });

  calls.length = 0;
  const repositionIntent: WindowManagerIntent = Object.freeze({
    rect: rect(96, 88, 640, 440),
    textureId: "texture-mail",
    type: "repositionTexture",
    windowId: "mail",
  });
  const moved = await driver.reconcile({
    shell: chromeLikeShell(),
    windowIntents: [
      repositionIntent,
    ],
  });

  assert.equal(moved.ok, true);
  assert.deepEqual(projectCommands(moved.commands), [
    {
      id: "texture-mail",
      rect: rect(96, 88, 640, 440),
      type: "updatePlacement",
      visible: true,
      z: 20_001,
    },
    {
      type: "present",
    },
  ]);
  assert.equal(calls.some((call) => call.type === "removeSurface" && call.id === "texture-chat"), false);

  calls.length = 0;
  const second = await driver.reconcile({
    shell: chromeLikeShell(),
    windowIntents: [
      repositionIntent,
    ],
  });

  assert.equal(second.ok, true);
  assert.deepEqual(second.commands, []);
  assert.deepEqual(calls, []);
});

test("WM stream hiding an absent desired window removes the compositor surface", async () => {
  const calls: CompositorCommand[] = [];
  const driver = new CompositorDriver(recordingPort(calls));
  await mustReconcile(driver, {
    shell: chromeLikeShell(),
    windows: [
      windowSurface("mail", rect(80, 72, 600, 440), 1),
    ],
  });

  calls.length = 0;
  const hiddenIntent: WindowManagerIntent = Object.freeze({
    textureId: "texture-mail",
    type: "setTextureVisibility",
    visible: false,
    windowId: "mail",
  });
  const removed = await driver.reconcile({
    shell: chromeLikeShell(),
    windowIntents: [
      hiddenIntent,
    ],
    windows: [],
  });

  assert.equal(removed.ok, true);
  assert.deepEqual(projectCommands(removed.commands), [
    {
      id: "texture-mail",
      type: "removeSurface",
    },
    {
      type: "present",
    },
  ]);
  assert.equal(calls.some((call) => call.type === "updatePlacement" && call.id === "texture-mail"), false);

  calls.length = 0;
  const second = await driver.reconcile({
    shell: chromeLikeShell(),
    windowIntents: [
      hiddenIntent,
    ],
    windows: [],
  });

  assert.equal(second.ok, true);
  assert.deepEqual(second.commands, []);
  assert.deepEqual(calls, []);
});

test("removed surfaces are reconciled before added surfaces", async () => {
  const calls: CompositorCommand[] = [];
  const driver = new CompositorDriver(recordingPort(calls));
  await mustReconcile(driver, {
    shell: chromeLikeShell(),
    windows: [
      windowSurface("mail", rect(80, 72, 600, 440), 1),
    ],
  });

  calls.length = 0;
  const changed = await driver.reconcile({
    shell: chromeLikeShell(),
    windows: [
      windowSurface("files", rect(40, 56, 720, 540), 1),
    ],
  });

  assert.equal(changed.ok, true);
  assert.deepEqual(projectCommands(changed.commands), [
    {
      id: "texture-mail",
      type: "removeSurface",
    },
    {
      id: "texture-files",
      kind: "window",
      size: size(720, 540),
      type: "registerSurface",
    },
    {
      id: "texture-files",
      rect: rect(40, 56, 720, 540),
      type: "updatePlacement",
      visible: true,
      z: 20_001,
    },
    {
      type: "present",
    },
  ]);
});

test("port failure stops the batch and leaves driver state at the last committed snapshot", async () => {
  const calls: CompositorCommand[] = [];
  const failure = {
    id: "",
    type: "",
  };
  const driver = new CompositorDriver(recordingPort(calls, {
    failWhen(command) {
      return command.type === failure.type && "id" in command && command.id === failure.id;
    },
  }));
  await mustReconcile(driver, {
    shell: chromeLikeShell(),
    windows: [
      windowSurface("mail", rect(80, 72, 600, 440), 1),
      windowSurface("chat", rect(160, 120, 500, 360), 2),
    ],
  });

  const committed = driver.snapshot();
  calls.length = 0;
  failure.id = "texture-chat";
  failure.type = "updatePlacement";

  const failed = await driver.reconcile({
    shell: chromeLikeShell(),
    windows: [
      windowSurface("mail", rect(120, 90, 720, 460), 1),
      windowSurface("chat", rect(200, 140, 500, 360), 2),
    ],
  });

  assert.equal(failed.ok, false);
  if (failed.ok) {
    assert.fail("expected compositor command failure");
  }
  assert.equal(failed.error.code, "PORT_COMMAND_FAILED");
  assert.equal(failed.error.path, "/surfaces/texture-chat/updatePlacement");
  assert.deepEqual(failed.state, committed);
  assert.deepEqual(driver.snapshot(), committed);
  assert.deepEqual(projectCommands(failed.commands), [
    {
      id: "texture-mail",
      rect: rect(120, 90, 720, 460),
      type: "updatePlacement",
      visible: true,
      z: 20_001,
    },
  ]);
  assert.deepEqual(projectCommands(calls), [
    {
      id: "texture-mail",
      rect: rect(120, 90, 720, 460),
      type: "updatePlacement",
      visible: true,
      z: 20_001,
    },
    {
      id: "texture-chat",
      rect: rect(200, 140, 500, 360),
      type: "updatePlacement",
      visible: true,
      z: 20_002,
    },
  ]);
  assert.equal(calls.some((call) => call.type === "present"), false);

  calls.length = 0;
  failure.id = "";
  failure.type = "";
  const retried = await driver.reconcile({
    shell: chromeLikeShell(),
    windows: [
      windowSurface("mail", rect(120, 90, 720, 460), 1),
      windowSurface("chat", rect(200, 140, 500, 360), 2),
    ],
  });

  assert.equal(retried.ok, true);
  assert.deepEqual(projectCommands(retried.commands), [
    {
      id: "texture-mail",
      rect: rect(120, 90, 720, 460),
      type: "updatePlacement",
      visible: true,
      z: 20_001,
    },
    {
      id: "texture-chat",
      rect: rect(200, 140, 500, 360),
      type: "updatePlacement",
      visible: true,
      z: 20_002,
    },
    {
      type: "present",
    },
  ]);
});

test("duplicate shell/window surface ids reject before touching the compositor port", async () => {
  const calls: CompositorCommand[] = [];
  const driver = new CompositorDriver(recordingPort(calls));
  const rejected = await driver.reconcile({
    shell: chromeLikeShell(),
    windows: [
      {
        ...windowSurface("panel", rect(0, 0, 1440, 40), 1),
        textureId: "surface:panel",
      },
    ],
  });

  assert.equal(rejected.ok, false);
  if (rejected.ok) {
    assert.fail("expected duplicate surface rejection");
  }
  assert.equal(rejected.error.code, "DUPLICATE_SURFACE");
  assert.deepEqual(calls, []);
  assert.deepEqual(driver.snapshot(), []);
});

test("unplaced shell surfaces reject before touching the compositor port", async () => {
  const calls: CompositorCommand[] = [];
  const driver = new CompositorDriver(recordingPort(calls));
  const rejected = await driver.reconcile({
    shell: shellWithUnplacedSurface(),
    windows: [],
  });

  assert.equal(rejected.ok, false);
  if (rejected.ok) {
    assert.fail("expected unplaced shell surface rejection");
  }
  assert.equal(rejected.error.code, "INVALID_SURFACE");
  assert.equal(rejected.error.path, "/shell/surfaces/surface:unplaced/placement/rect");
  assert.deepEqual(calls, []);
  assert.deepEqual(driver.snapshot(), []);
});

async function mustReconcile(
  driver: CompositorDriver,
  input: Parameters<CompositorDriver["reconcile"]>[0],
): Promise<void> {
  const result = await driver.reconcile(input);

  if (!result.ok) {
    assert.fail(`${result.error.code}: ${result.error.message}`);
  }
}

interface RecordingPortOptions {
  readonly failWhen?: (command: CompositorCommand) => boolean;
}

function recordingPort(
  calls: CompositorCommand[],
  options: RecordingPortOptions = {},
): CompositorPort {
  return {
    present(): void {
      const command = Object.freeze({
        type: "present" as const,
      });
      calls.push(command);
      maybeFail(options, command);
    },
    registerSurface(id, kind, size): void {
      const command = Object.freeze({
        id,
        kind,
        size,
        type: "registerSurface" as const,
      });
      calls.push(command);
      maybeFail(options, command);
    },
    removeSurface(id): void {
      const command = Object.freeze({
        id,
        type: "removeSurface" as const,
      });
      calls.push(command);
      maybeFail(options, command);
    },
    updatePlacement(id, rectValue, z, visible): void {
      const command = Object.freeze({
        id,
        rect: rectValue,
        type: "updatePlacement" as const,
        visible,
        z,
      });
      calls.push(command);
      maybeFail(options, command);
    },
  };
}

function maybeFail(options: RecordingPortOptions, command: CompositorCommand): void {
  if (options.failWhen?.(command) === true) {
    throwConfiguredFailure(command);
  }
}

function throwConfiguredFailure(command: CompositorCommand): never {
  throw new Error(`configured compositor failure: ${command.type}`);
}

type ProjectedCommand =
  | {
      readonly type: "registerSurface";
      readonly id: string;
      readonly kind: CompositorSurfaceKind;
      readonly size: CompositorSurfaceSize;
    }
  | {
      readonly type: "updatePlacement";
      readonly id: string;
      readonly rect: CompositorRect;
      readonly z: number;
      readonly visible: boolean;
    }
  | {
      readonly type: "removeSurface";
      readonly id: string;
    }
  | {
      readonly type: "present";
    };

function projectCommands(commands: readonly CompositorCommand[]): readonly ProjectedCommand[] {
  return commands.map((command) => {
    switch (command.type) {
      case "registerSurface":
        return {
          id: command.id,
          kind: command.kind,
          size: command.size,
          type: command.type,
        };
      case "updatePlacement":
        return {
          id: command.id,
          rect: command.rect,
          type: command.type,
          visible: command.visible,
          z: command.z,
        };
      case "removeSurface":
        return {
          id: command.id,
          type: command.type,
        };
      case "present":
        return {
          type: command.type,
        };
    }
  });
}

function chromeLikeShell(): ShellComposedLayout {
  const panel = surface({
    id: "surface:panel",
    layer: "panel",
    order: 0,
    rect: rect(0, 0, 1440, 40),
    role: "panel",
  });
  const desktop = surface({
    children: [
      panel,
    ],
    id: "surface:desktop",
    layer: "desktop",
    order: 0,
    rect: rect(0, 0, 1440, 900),
    role: "desktop",
  });

  return Object.freeze({
    configId: "test.shell",
    css: Object.freeze({
      rules: Object.freeze([]),
      text: "",
    }),
    revision: "test",
    root: desktop,
    surfaces: Object.freeze([
      desktop,
      panel,
    ]),
  });
}

function shellWithUnplacedSurface(): ShellComposedLayout {
  const unplaced = surface({
    id: "surface:unplaced",
    layer: "panel",
    order: 0,
    role: "panel",
  });

  return Object.freeze({
    configId: "test.shell",
    css: Object.freeze({
      rules: Object.freeze([]),
      text: "",
    }),
    revision: "test",
    root: unplaced,
    surfaces: Object.freeze([
      unplaced,
    ]),
  });
}

function surface(input: {
  readonly id: string;
  readonly role: string;
  readonly layer: string;
  readonly order: number;
  readonly rect?: Rect;
  readonly children?: readonly ShellResolvedSurface[];
}): ShellResolvedSurface {
  const placement: {
    zone: string;
    layer: string;
    order: number;
    rect?: Rect;
  } = {
    layer: input.layer,
    order: input.order,
    zone: "center",
  };

  if (input.rect !== undefined) {
    placement.rect = input.rect;
  }

  return Object.freeze({
    children: Object.freeze([...(input.children ?? [])]),
    componentId: `component:${input.role}`,
    id: input.id,
    path: input.id,
    payload: Object.freeze({}),
    placement: Object.freeze(placement),
    role: input.role,
    substrate: Object.freeze({}),
  });
}

function windowSurface(
  id: string,
  rectValue: Rect,
  zIndex: number,
  visible = true,
): CompositorWindowPlacement {
  const placement: WindowPlacement = Object.freeze({
    focused: false,
    rect: rectValue,
    textureId: `texture-${id}`,
    visible: true,
    windowId: id,
    workspaceId: "main",
    zIndex,
  });

  return compositorWindowPlacement(placement, visible);
}

function rect(x: number, y: number, width: number, height: number): Rect {
  return Object.freeze({
    height,
    width,
    x,
    y,
  });
}

function size(width: number, height: number): CompositorSurfaceSize {
  return Object.freeze({
    height,
    width,
  });
}
