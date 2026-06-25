import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSurfaceDndCoordinator,
  resolveEffect,
} from "../../../../ui_kits/desktop/viewmodels/surface-dnd.ts";
import type {
  SurfaceDndAcceptPredicate,
  SurfaceDndDragSource,
  SurfaceDndDropTarget,
  SurfaceDndPorts,
} from "../../../../ui_kits/desktop/viewmodels/surface-dnd.ts";
import type {
  DesktopCapability,
  DesktopCapabilityGrant,
  DesktopUiPackageManifest,
  FilesCapabilityPort,
} from "../../src/desktop-sdk/index.ts";

const ACCEPT_ALL: SurfaceDndAcceptPredicate = () => true;
const REJECT_ALL: SurfaceDndAcceptPredicate = () => false;

const FILES_PORT: FilesCapabilityPort = Object.freeze({
  request() {
    assert.fail("surface DnD resolution must not call the files port");
  },
});

test("file icon dragged onto a different folder resolves move with a files-move intent", () => {
  const source = iconSource("/Desktop/report.txt");
  const target = folderTarget("/Desktop/Projects");
  const first = resolveEffect(source, target, {}, dndPorts());
  const second = resolveEffect(source, target, {}, dndPorts());

  assert.deepEqual(first, {
    effect: "move",
    intent: {
      destinationFolder: "/Desktop/Projects",
      grant: "desktop",
      kind: "files-move",
      operations: [
        {
          destinationPath: "/Desktop/Projects/report.txt",
          entryKind: "file",
          sourcePath: "/Desktop/report.txt",
        },
      ],
      sources: [
        {
          entryKind: "file",
          path: "/Desktop/report.txt",
        },
      ],
    },
  });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(Object.isFrozen(first), true);
});

test("dropping onto the folder that already contains the source rejects as a no-op", () => {
  const result = resolveEffect(
    iconSource("/Desktop/Projects/report.txt"),
    folderTarget("/Desktop/Projects"),
    {},
    dndPorts(),
  );

  assert.deepEqual(result, {
    effect: "reject",
  });
});

test("app sources resolve launch on desktop background and pin on dock", () => {
  const app = appSource("vita.app.mail");

  assert.deepEqual(resolveEffect(app, desktopTarget(), {}, dndPorts()), {
    effect: "launch",
    intent: {
      appId: "vita.app.mail",
      kind: "launch-app",
      target: "desktop-background",
    },
  });

  assert.deepEqual(resolveEffect(app, dockTarget("primary"), {}, dndPorts()), {
    effect: "launch",
    intent: {
      appId: "vita.app.mail",
      dockId: "primary",
      kind: "pin-app-to-dock",
    },
  });
});

test("ctrl held over a folder resolves copy with a files-copy intent", () => {
  const result = resolveEffect(
    fileSource("/Desktop/report.txt"),
    folderTarget("/Desktop/Archive"),
    {
      ctrl: true,
    },
    dndPorts(),
  );

  assert.deepEqual(result, {
    effect: "copy",
    intent: {
      destinationFolder: "/Desktop/Archive",
      grant: "desktop",
      kind: "files-copy",
      operations: [
        {
          destinationPath: "/Desktop/Archive/report.txt",
          entryKind: "file",
          sourcePath: "/Desktop/report.txt",
        },
      ],
      sources: [
        {
          entryKind: "file",
          path: "/Desktop/report.txt",
        },
      ],
    },
  });
});

test("target validation rejects fail closed with no intent", () => {
  const result = resolveEffect(
    fileSource("/Desktop/report.txt"),
    folderTarget("/Desktop/Projects", REJECT_ALL),
    {},
    dndPorts(),
  );

  assert.deepEqual(result, {
    effect: "reject",
  });
});

test("missing files port or files.write grant rejects mutating file drops with no intent", () => {
  const source = fileSource("/Desktop/report.txt");
  const target = folderTarget("/Desktop/Projects");

  assert.deepEqual(resolveEffect(source, target, {}, dndPorts({
    includeFiles: false,
  })), {
    effect: "reject",
  });

  assert.deepEqual(resolveEffect(source, target, {
    ctrl: true,
  }, dndPorts({
    grants: [],
  })), {
    effect: "reject",
  });
});

test("coordinator tracks hover targets and commits the resolved drop intent", () => {
  const coordinator = createSurfaceDndCoordinator(dndPorts());

  const dragging = coordinator.beginDrag(iconSource("/Desktop/report.txt"));

  assert.equal(dragging.status, "dragging");
  assert.deepEqual(dragging.targets, []);

  const hovered = coordinator.hover(folderTarget("/Desktop/Projects"), {});

  assert.equal(hovered.effect, "move");
  assert.deepEqual(coordinator.state.targets, [
    {
      kind: "folder-icon",
      path: "/Desktop/Projects",
    },
  ]);
  assert.deepEqual(coordinator.state.candidate, hovered);

  const dropped = coordinator.drop();

  assert.deepEqual(dropped, hovered);
  assert.equal(coordinator.state.status, "idle");
  assert.deepEqual(coordinator.state.committed, hovered);

  const cancelled = coordinator.cancelDrag();

  assert.equal(cancelled.status, "idle");
  assert.deepEqual(cancelled.candidate, {
    effect: "reject",
  });
});

function dndPorts(options: {
  readonly includeFiles?: boolean;
  readonly filesGrant?: string;
  readonly grants?: readonly DesktopCapabilityGrant[];
} = {}): SurfaceDndPorts {
  const output: {
    files?: FilesCapabilityPort;
    filesGrant?: string;
    package: DesktopUiPackageManifest;
  } = {
    package: manifest(options.grants ?? [
      grant("files.write", "desktop"),
    ]),
  };

  if (options.includeFiles !== false) output.files = FILES_PORT;
  output.filesGrant = options.filesGrant ?? "desktop";

  return Object.freeze(output);
}

function iconSource(path: string): SurfaceDndDragSource {
  return Object.freeze({
    entries: Object.freeze([
      fileReference(path),
    ]),
    iconId: "icon:report",
    kind: "icon",
  });
}

function fileSource(path: string): SurfaceDndDragSource {
  return Object.freeze({
    entries: Object.freeze([
      fileReference(path),
    ]),
    kind: "file",
  });
}

function appSource(appId: string): SurfaceDndDragSource {
  return Object.freeze({
    appId,
    kind: "app",
  });
}

function fileReference(path: string): {
  readonly path: string;
  readonly entryKind: "file";
} {
  return Object.freeze({
    entryKind: "file",
    path,
  });
}

function folderTarget(
  path: string,
  validate: SurfaceDndAcceptPredicate = ACCEPT_ALL,
): SurfaceDndDropTarget {
  return Object.freeze({
    kind: "folder-icon",
    path,
    validate,
  });
}

function desktopTarget(): SurfaceDndDropTarget {
  return Object.freeze({
    kind: "desktop-background",
    validate: ACCEPT_ALL,
  });
}

function dockTarget(dockId: string): SurfaceDndDropTarget {
  return Object.freeze({
    dockId,
    kind: "dock",
    validate: ACCEPT_ALL,
  });
}

function manifest(grants: readonly DesktopCapabilityGrant[]): DesktopUiPackageManifest {
  return Object.freeze({
    capabilityGrants: Object.freeze([...grants]),
    entry: "./surface-dnd.test.ts",
    id: "ui.surface-dnd.test",
    sdkVersion: "1.0.0",
    version: "1.0.0",
  });
}

function grant(capability: DesktopCapability, resourceId?: string): DesktopCapabilityGrant {
  const output: {
    capability: DesktopCapability;
    resourceId?: string;
  } = {
    capability,
  };

  if (resourceId !== undefined) output.resourceId = resourceId;

  return Object.freeze(output);
}
