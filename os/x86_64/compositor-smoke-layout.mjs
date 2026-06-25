#!/usr/bin/env node
// Generate the smoke VM compositor command stream from the TypeScript shell/WM model.
// This is build-time verification wiring only; the production OS stays headless.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  CompositorDriver,
  NativeCompositorPort,
  compositorWindowPlacement,
} from "../../sdk/typescript/src/compositor-bridge/index.ts";

const outputPath = process.argv[2];
const lines = [];
const port = new NativeCompositorPort({
  write(line) {
    lines.push(line);
  },
}, {
  colors: Object.freeze({
    "surface:desktop": "18344eff",
    "surface:panel": "12181fff",
    "texture-files": "e6edf2ff",
    "texture-notes": "fcebb3ff",
    "texture-terminal": "1f232cff",
  }),
});
const driver = new CompositorDriver(port);
const result = await driver.reconcile({
  shell: smokeShellLayout(),
  windows: Object.freeze([
    smokeWindow("files", rect(86, 96, 420, 280), 1),
    smokeWindow("terminal", rect(690, 235, 470, 260), 2),
    smokeWindow("notes", rect(252, 410, 360, 230), 3),
  ]),
});

if (!result.ok) {
  throw new Error(`${result.error.code}: ${result.error.message}`);
}

const commandStream = lines.join("");

if (outputPath === undefined) {
  process.stdout.write(commandStream);
} else {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, commandStream, { encoding: "utf8", mode: 0o644 });
}

function smokeShellLayout() {
  const panel = shellSurface({
    id: "surface:panel",
    layer: "panel",
    order: 0,
    rect: rect(0, 0, 1280, 42),
    role: "panel",
  });
  const desktop = shellSurface({
    children: Object.freeze([panel]),
    id: "surface:desktop",
    layer: "desktop",
    order: 0,
    rect: rect(0, 0, 1280, 720),
    role: "desktop",
  });

  return Object.freeze({
    configId: "vita.smoke.driver-layout",
    css: Object.freeze({
      rules: Object.freeze([]),
      text: "",
    }),
    revision: "PSD-010",
    root: desktop,
    surfaces: Object.freeze([
      desktop,
      panel,
    ]),
  });
}

function shellSurface(input) {
  return Object.freeze({
    children: input.children ?? Object.freeze([]),
    componentId: `component:${input.role}`,
    id: input.id,
    path: input.id,
    payload: Object.freeze({}),
    placement: Object.freeze({
      layer: input.layer,
      order: input.order,
      rect: input.rect,
      zone: "center",
    }),
    role: input.role,
    substrate: Object.freeze({}),
  });
}

function smokeWindow(id, windowRect, zIndex) {
  return compositorWindowPlacement(Object.freeze({
    focused: id === "terminal",
    rect: windowRect,
    textureId: `texture-${id}`,
    visible: true,
    windowId: id,
    workspaceId: "main",
    zIndex,
  }));
}

function rect(x, y, width, height) {
  return Object.freeze({
    height,
    width,
    x,
    y,
  });
}
