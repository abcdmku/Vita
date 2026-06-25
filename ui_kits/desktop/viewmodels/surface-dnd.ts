import {
  hasDesktopCapabilityGrant,
  joinCapabilityPath,
  parentCapabilityPath,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  DesktopUiPackageManifest,
  FilesCapabilityPort,
  FilesEntry,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

export type SurfaceDndEffect = "move" | "copy" | "link" | "launch" | "reject";

export interface SurfaceDndModifiers {
  readonly ctrl?: boolean;
  readonly alt?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
}

export interface SurfaceDndFileReference {
  readonly path: string;
  readonly entryKind: FilesEntry["kind"];
  readonly grant?: string;
}

export type SurfaceDndDragSource =
  | {
      readonly kind: "file";
      readonly entries: readonly SurfaceDndFileReference[];
      readonly label?: string;
    }
  | {
      readonly kind: "icon";
      readonly entries: readonly SurfaceDndFileReference[];
      readonly iconId?: string;
      readonly label?: string;
    }
  | {
      readonly kind: "app";
      readonly appId: string;
    }
  | {
      readonly kind: "widget";
      readonly widgetId: string;
    }
  | {
      readonly kind: "text";
      readonly text: string;
    };

export type SurfaceDndAcceptPredicate = (
  source: SurfaceDndDragSource,
  target: SurfaceDndDropTarget,
) => boolean;

interface SurfaceDndDropTargetBase {
  readonly validate: SurfaceDndAcceptPredicate;
}

export type SurfaceDndDropTarget =
  | (SurfaceDndDropTargetBase & {
      readonly kind: "desktop-background";
      readonly path?: string;
      readonly grant?: string;
    })
  | (SurfaceDndDropTargetBase & {
      readonly kind: "icon";
      readonly path: string;
      readonly entryKind: FilesEntry["kind"];
      readonly grant?: string;
    })
  | (SurfaceDndDropTargetBase & {
      readonly kind: "folder-icon";
      readonly path: string;
      readonly grant?: string;
    })
  | (SurfaceDndDropTargetBase & {
      readonly kind: "dock";
      readonly dockId?: string;
    })
  | (SurfaceDndDropTargetBase & {
      readonly kind: "widget-zone";
      readonly zoneId: string;
    })
  | (SurfaceDndDropTargetBase & {
      readonly kind: "window";
      readonly windowId: string;
      readonly path?: string;
      readonly grant?: string;
    });

export type SurfaceDndTargetSnapshot =
  | {
      readonly kind: "desktop-background";
      readonly path?: string;
      readonly grant?: string;
    }
  | {
      readonly kind: "icon";
      readonly path: string;
      readonly entryKind: FilesEntry["kind"];
      readonly grant?: string;
    }
  | {
      readonly kind: "folder-icon";
      readonly path: string;
      readonly grant?: string;
    }
  | {
      readonly kind: "dock";
      readonly dockId?: string;
    }
  | {
      readonly kind: "widget-zone";
      readonly zoneId: string;
    }
  | {
      readonly kind: "window";
      readonly windowId: string;
      readonly path?: string;
      readonly grant?: string;
    };

export interface SurfaceDndFileOperation {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly entryKind: FilesEntry["kind"];
}

export interface SurfaceDndFilesIntent {
  readonly kind: "files-move" | "files-copy";
  readonly grant: string;
  readonly sources: readonly SurfaceDndFileReference[];
  readonly destinationFolder: string;
  readonly operations: readonly SurfaceDndFileOperation[];
}

export type SurfaceDndIntent =
  | SurfaceDndFilesIntent
  | {
      readonly kind: "launch-app";
      readonly appId: string;
      readonly target: "desktop-background";
    }
  | {
      readonly kind: "pin-app-to-dock";
      readonly appId: string;
      readonly dockId?: string;
    }
  | {
      readonly kind: "launch-widget";
      readonly widgetId: string;
      readonly zoneId: string;
    };

export interface SurfaceDndResolution {
  readonly effect: SurfaceDndEffect;
  readonly intent?: SurfaceDndIntent;
}

export interface SurfaceDndPorts {
  readonly files?: FilesCapabilityPort;
  readonly filesGrant?: string;
  readonly package?: DesktopUiPackageManifest;
}

export interface SurfaceDndState {
  readonly status: "idle" | "dragging";
  readonly modifiers: SurfaceDndModifiers;
  readonly targets: readonly SurfaceDndTargetSnapshot[];
  readonly candidate: SurfaceDndResolution;
  readonly source?: SurfaceDndDragSource;
  readonly committed?: SurfaceDndResolution;
}

export interface SurfaceDndCoordinator {
  readonly state: SurfaceDndState;
  beginDrag(source: SurfaceDndDragSource): SurfaceDndState;
  hover(target: SurfaceDndDropTarget, modifiers: SurfaceDndModifiers): SurfaceDndResolution;
  drop(): SurfaceDndResolution;
  cancelDrag(): SurfaceDndState;
}

const EMPTY_TARGETS: readonly SurfaceDndTargetSnapshot[] = Object.freeze([]);
const EMPTY_MODIFIERS: SurfaceDndModifiers = Object.freeze({});
const REJECT_RESOLUTION: SurfaceDndResolution = Object.freeze({
  effect: "reject",
});

export function createSurfaceDndCoordinator(ports: SurfaceDndPorts): SurfaceDndCoordinator {
  let state = freezeState({
    candidate: REJECT_RESOLUTION,
    modifiers: EMPTY_MODIFIERS,
    status: "idle",
    targets: EMPTY_TARGETS,
  });

  return Object.freeze({
    get state() {
      return state;
    },
    beginDrag(source: SurfaceDndDragSource): SurfaceDndState {
      state = freezeState({
        candidate: REJECT_RESOLUTION,
        modifiers: EMPTY_MODIFIERS,
        source: freezeSource(source),
        status: "dragging",
        targets: EMPTY_TARGETS,
      });
      return state;
    },
    hover(target: SurfaceDndDropTarget, modifiers: SurfaceDndModifiers): SurfaceDndResolution {
      if (state.source === undefined) {
        state = freezeState({
          candidate: REJECT_RESOLUTION,
          modifiers: freezeModifiers(modifiers),
          status: "idle",
          targets: EMPTY_TARGETS,
        });
        return REJECT_RESOLUTION;
      }

      const candidate = resolveEffect(state.source, target, modifiers, ports);
      state = freezeState({
        candidate,
        modifiers: freezeModifiers(modifiers),
        source: state.source,
        status: "dragging",
        targets: appendTargetSnapshot(state.targets, targetSnapshot(target)),
      });
      return candidate;
    },
    drop(): SurfaceDndResolution {
      const candidate = state.source === undefined ? REJECT_RESOLUTION : state.candidate;
      state = freezeState({
        candidate,
        committed: candidate,
        modifiers: EMPTY_MODIFIERS,
        status: "idle",
        targets: EMPTY_TARGETS,
      });
      return candidate;
    },
    cancelDrag(): SurfaceDndState {
      state = freezeState({
        candidate: REJECT_RESOLUTION,
        modifiers: EMPTY_MODIFIERS,
        status: "idle",
        targets: EMPTY_TARGETS,
      });
      return state;
    },
  });
}

export function resolveEffect(
  source: SurfaceDndDragSource,
  target: SurfaceDndDropTarget,
  modifiers: SurfaceDndModifiers,
  ports: SurfaceDndPorts,
): SurfaceDndResolution {
  const normalizedSource = freezeSource(source);

  if (!targetAccepts(normalizedSource, target)) return REJECT_RESOLUTION;

  if (isFileLikeSource(normalizedSource) && target.kind === "folder-icon") {
    return resolveFilesDrop(normalizedSource, target, modifiers, ports);
  }

  if (normalizedSource.kind === "app" && target.kind === "desktop-background") {
    return freezeResolution({
      effect: "launch",
      intent: Object.freeze({
        appId: normalizedSource.appId,
        kind: "launch-app",
        target: "desktop-background",
      }),
    });
  }

  if (normalizedSource.kind === "app" && target.kind === "dock") {
    const intent: {
      kind: "pin-app-to-dock";
      appId: string;
      dockId?: string;
    } = {
      appId: normalizedSource.appId,
      kind: "pin-app-to-dock",
    };

    if (target.dockId !== undefined) intent.dockId = target.dockId;

    return freezeResolution({
      effect: "launch",
      intent: Object.freeze(intent),
    });
  }

  if (normalizedSource.kind === "widget" && target.kind === "widget-zone") {
    return freezeResolution({
      effect: "launch",
      intent: Object.freeze({
        kind: "launch-widget",
        widgetId: normalizedSource.widgetId,
        zoneId: target.zoneId,
      }),
    });
  }

  return REJECT_RESOLUTION;
}

function resolveFilesDrop(
  source: Extract<SurfaceDndDragSource, { readonly kind: "file" | "icon" }>,
  target: Extract<SurfaceDndDropTarget, { readonly kind: "folder-icon" }>,
  modifiers: SurfaceDndModifiers,
  ports: SurfaceDndPorts,
): SurfaceDndResolution {
  const entries = freezeFileReferences(source.entries);
  const destinationFolder = normalizeCapabilityPath(target.path);
  const copy = modifiers.ctrl === true;

  if (entries.length === 0) return REJECT_RESOLUTION;
  if (!copy && isSameFolderDrop(entries, destinationFolder)) return REJECT_RESOLUTION;

  const grant = resolveFilesGrant(entries, target.grant, ports);

  if (grant === undefined) return REJECT_RESOLUTION;

  const operations = filesOperations(entries, destinationFolder);
  const intent: SurfaceDndFilesIntent = Object.freeze({
    destinationFolder,
    grant,
    kind: copy ? "files-copy" : "files-move",
    operations,
    sources: entries,
  });

  return freezeResolution({
    effect: copy ? "copy" : "move",
    intent,
  });
}

function targetAccepts(source: SurfaceDndDragSource, target: SurfaceDndDropTarget): boolean {
  try {
    return target.validate(source, target) === true;
  } catch {
    return false;
  }
}

function resolveFilesGrant(
  entries: readonly SurfaceDndFileReference[],
  targetGrant: string | undefined,
  ports: SurfaceDndPorts,
): string | undefined {
  if (ports.files === undefined || ports.package === undefined) return undefined;

  const grant = singleFilesGrant(entries, targetGrant, ports.filesGrant);

  if (grant === undefined || grant.length === 0) return undefined;
  if (!hasDesktopCapabilityGrant(ports.package, "files.write", grant)) return undefined;

  return grant;
}

function singleFilesGrant(
  entries: readonly SurfaceDndFileReference[],
  targetGrant: string | undefined,
  portGrant: string | undefined,
): string | undefined {
  let selected: string | undefined;

  let next = selectGrant(selected, portGrant);

  if (next === null) return undefined;
  selected = next;

  next = selectGrant(selected, targetGrant);

  if (next === null) return undefined;
  selected = next;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (entry === undefined) continue;
    next = selectGrant(selected, entry.grant);
    if (next === null) return undefined;
    selected = next;
  }

  return selected;
}

function selectGrant(current: string | undefined, candidate: string | undefined): string | undefined | null {
  if (candidate === undefined || candidate.length === 0) return current;
  if (current === undefined) return candidate;
  if (current !== candidate) return null;

  return current;
}

function isSameFolderDrop(entries: readonly SurfaceDndFileReference[], destinationFolder: string): boolean {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (entry === undefined) continue;
    const sourcePath = normalizeCapabilityPath(entry.path);

    if (sourcePath === destinationFolder) return true;
    if (normalizeCapabilityPath(parentCapabilityPath(sourcePath)) === destinationFolder) return true;
  }

  return false;
}

function filesOperations(
  entries: readonly SurfaceDndFileReference[],
  destinationFolder: string,
): readonly SurfaceDndFileOperation[] {
  const operations: SurfaceDndFileOperation[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (entry === undefined) continue;
    operations.push(Object.freeze({
      destinationPath: joinCapabilityPath(destinationFolder, basename(entry.path)),
      entryKind: entry.entryKind,
      sourcePath: normalizeCapabilityPath(entry.path),
    }));
  }

  return Object.freeze(operations);
}

function isFileLikeSource(
  source: SurfaceDndDragSource,
): source is Extract<SurfaceDndDragSource, { readonly kind: "file" | "icon" }> {
  return source.kind === "file" || source.kind === "icon";
}

function freezeState(input: {
  readonly status: "idle" | "dragging";
  readonly modifiers: SurfaceDndModifiers;
  readonly targets: readonly SurfaceDndTargetSnapshot[];
  readonly candidate: SurfaceDndResolution;
  readonly source?: SurfaceDndDragSource;
  readonly committed?: SurfaceDndResolution;
}): SurfaceDndState {
  const output: {
    status: "idle" | "dragging";
    modifiers: SurfaceDndModifiers;
    targets: readonly SurfaceDndTargetSnapshot[];
    candidate: SurfaceDndResolution;
    source?: SurfaceDndDragSource;
    committed?: SurfaceDndResolution;
  } = {
    candidate: freezeResolution(input.candidate),
    modifiers: freezeModifiers(input.modifiers),
    status: input.status,
    targets: Object.freeze(input.targets.map(freezeTargetSnapshot)),
  };

  if (input.source !== undefined) output.source = freezeSource(input.source);
  if (input.committed !== undefined) output.committed = freezeResolution(input.committed);

  return Object.freeze(output);
}

function freezeSource(source: SurfaceDndDragSource): SurfaceDndDragSource {
  if (source.kind === "file") {
    const output: {
      kind: "file";
      entries: readonly SurfaceDndFileReference[];
      label?: string;
    } = {
      entries: freezeFileReferences(source.entries),
      kind: "file",
    };

    if (source.label !== undefined) output.label = source.label;

    return Object.freeze(output);
  }

  if (source.kind === "icon") {
    const output: {
      kind: "icon";
      entries: readonly SurfaceDndFileReference[];
      iconId?: string;
      label?: string;
    } = {
      entries: freezeFileReferences(source.entries),
      kind: "icon",
    };

    if (source.iconId !== undefined) output.iconId = source.iconId;
    if (source.label !== undefined) output.label = source.label;

    return Object.freeze(output);
  }

  if (source.kind === "app") {
    return Object.freeze({
      appId: source.appId,
      kind: "app",
    });
  }

  if (source.kind === "widget") {
    return Object.freeze({
      kind: "widget",
      widgetId: source.widgetId,
    });
  }

  return Object.freeze({
    kind: "text",
    text: source.text,
  });
}

function freezeFileReferences(entries: readonly SurfaceDndFileReference[]): readonly SurfaceDndFileReference[] {
  const output: SurfaceDndFileReference[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (entry === undefined) continue;
    output.push(freezeFileReference(entry));
  }

  return Object.freeze(output);
}

function freezeFileReference(entry: SurfaceDndFileReference): SurfaceDndFileReference {
  const output: {
    path: string;
    entryKind: FilesEntry["kind"];
    grant?: string;
  } = {
    entryKind: entry.entryKind,
    path: normalizeCapabilityPath(entry.path),
  };

  if (entry.grant !== undefined) output.grant = entry.grant;

  return Object.freeze(output);
}

function freezeResolution(resolution: SurfaceDndResolution): SurfaceDndResolution {
  if (resolution.intent === undefined) return Object.freeze({ effect: resolution.effect });

  return Object.freeze({
    effect: resolution.effect,
    intent: freezeIntent(resolution.intent),
  });
}

function freezeIntent(intent: SurfaceDndIntent): SurfaceDndIntent {
  switch (intent.kind) {
    case "files-copy":
    case "files-move":
      return Object.freeze({
        destinationFolder: normalizeCapabilityPath(intent.destinationFolder),
        grant: intent.grant,
        kind: intent.kind,
        operations: Object.freeze(intent.operations.map(freezeFileOperation)),
        sources: freezeFileReferences(intent.sources),
      });
    case "launch-app":
      return Object.freeze({
        appId: intent.appId,
        kind: "launch-app",
        target: "desktop-background",
      });
    case "pin-app-to-dock": {
      const output: {
        kind: "pin-app-to-dock";
        appId: string;
        dockId?: string;
      } = {
        appId: intent.appId,
        kind: "pin-app-to-dock",
      };

      if (intent.dockId !== undefined) output.dockId = intent.dockId;

      return Object.freeze(output);
    }
    case "launch-widget":
      return Object.freeze({
        kind: "launch-widget",
        widgetId: intent.widgetId,
        zoneId: intent.zoneId,
      });
  }
}

function freezeFileOperation(operation: SurfaceDndFileOperation): SurfaceDndFileOperation {
  return Object.freeze({
    destinationPath: normalizeCapabilityPath(operation.destinationPath),
    entryKind: operation.entryKind,
    sourcePath: normalizeCapabilityPath(operation.sourcePath),
  });
}

function freezeModifiers(modifiers: SurfaceDndModifiers): SurfaceDndModifiers {
  const output: {
    ctrl?: boolean;
    alt?: boolean;
    meta?: boolean;
    shift?: boolean;
  } = {};

  if (modifiers.ctrl !== undefined) output.ctrl = modifiers.ctrl;
  if (modifiers.alt !== undefined) output.alt = modifiers.alt;
  if (modifiers.meta !== undefined) output.meta = modifiers.meta;
  if (modifiers.shift !== undefined) output.shift = modifiers.shift;

  return Object.freeze(output);
}

function targetSnapshot(target: SurfaceDndDropTarget): SurfaceDndTargetSnapshot {
  if (target.kind === "desktop-background") {
    const output: {
      kind: "desktop-background";
      path?: string;
      grant?: string;
    } = {
      kind: "desktop-background",
    };

    if (target.path !== undefined) output.path = normalizeCapabilityPath(target.path);
    if (target.grant !== undefined) output.grant = target.grant;

    return Object.freeze(output);
  }

  if (target.kind === "icon") {
    const output: {
      kind: "icon";
      path: string;
      entryKind: FilesEntry["kind"];
      grant?: string;
    } = {
      entryKind: target.entryKind,
      kind: "icon",
      path: normalizeCapabilityPath(target.path),
    };

    if (target.grant !== undefined) output.grant = target.grant;

    return Object.freeze(output);
  }

  if (target.kind === "folder-icon") {
    const output: {
      kind: "folder-icon";
      path: string;
      grant?: string;
    } = {
      kind: "folder-icon",
      path: normalizeCapabilityPath(target.path),
    };

    if (target.grant !== undefined) output.grant = target.grant;

    return Object.freeze(output);
  }

  if (target.kind === "dock") {
    const output: {
      kind: "dock";
      dockId?: string;
    } = {
      kind: "dock",
    };

    if (target.dockId !== undefined) output.dockId = target.dockId;

    return Object.freeze(output);
  }

  if (target.kind === "widget-zone") {
    return Object.freeze({
      kind: "widget-zone",
      zoneId: target.zoneId,
    });
  }

  const output: {
    kind: "window";
    windowId: string;
    path?: string;
    grant?: string;
  } = {
    kind: "window",
    windowId: target.windowId,
  };

  if (target.path !== undefined) output.path = normalizeCapabilityPath(target.path);
  if (target.grant !== undefined) output.grant = target.grant;

  return Object.freeze(output);
}

function freezeTargetSnapshot(snapshot: SurfaceDndTargetSnapshot): SurfaceDndTargetSnapshot {
  if (snapshot.kind === "desktop-background") {
    const output: {
      kind: "desktop-background";
      path?: string;
      grant?: string;
    } = {
      kind: "desktop-background",
    };

    if (snapshot.path !== undefined) output.path = normalizeCapabilityPath(snapshot.path);
    if (snapshot.grant !== undefined) output.grant = snapshot.grant;

    return Object.freeze(output);
  }

  if (snapshot.kind === "icon") {
    const output: {
      kind: "icon";
      path: string;
      entryKind: FilesEntry["kind"];
      grant?: string;
    } = {
      entryKind: snapshot.entryKind,
      kind: "icon",
      path: normalizeCapabilityPath(snapshot.path),
    };

    if (snapshot.grant !== undefined) output.grant = snapshot.grant;

    return Object.freeze(output);
  }

  if (snapshot.kind === "folder-icon") {
    const output: {
      kind: "folder-icon";
      path: string;
      grant?: string;
    } = {
      kind: "folder-icon",
      path: normalizeCapabilityPath(snapshot.path),
    };

    if (snapshot.grant !== undefined) output.grant = snapshot.grant;

    return Object.freeze(output);
  }

  if (snapshot.kind === "dock") {
    const output: {
      kind: "dock";
      dockId?: string;
    } = {
      kind: "dock",
    };

    if (snapshot.dockId !== undefined) output.dockId = snapshot.dockId;

    return Object.freeze(output);
  }

  if (snapshot.kind === "widget-zone") {
    return Object.freeze({
      kind: "widget-zone",
      zoneId: snapshot.zoneId,
    });
  }

  const output: {
    kind: "window";
    windowId: string;
    path?: string;
    grant?: string;
  } = {
    kind: "window",
    windowId: snapshot.windowId,
  };

  if (snapshot.path !== undefined) output.path = normalizeCapabilityPath(snapshot.path);
  if (snapshot.grant !== undefined) output.grant = snapshot.grant;

  return Object.freeze(output);
}

function appendTargetSnapshot(
  targets: readonly SurfaceDndTargetSnapshot[],
  snapshot: SurfaceDndTargetSnapshot,
): readonly SurfaceDndTargetSnapshot[] {
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];

    if (target !== undefined && sameTargetSnapshot(target, snapshot)) return targets;
  }

  return Object.freeze([...targets, snapshot]);
}

function sameTargetSnapshot(left: SurfaceDndTargetSnapshot, right: SurfaceDndTargetSnapshot): boolean {
  if (left.kind !== right.kind) return false;

  if (left.kind === "desktop-background" && right.kind === "desktop-background") {
    return left.path === right.path && left.grant === right.grant;
  }

  if (left.kind === "icon" && right.kind === "icon") {
    return left.path === right.path && left.entryKind === right.entryKind && left.grant === right.grant;
  }

  if (left.kind === "folder-icon" && right.kind === "folder-icon") {
    return left.path === right.path && left.grant === right.grant;
  }

  if (left.kind === "dock" && right.kind === "dock") return left.dockId === right.dockId;
  if (left.kind === "widget-zone" && right.kind === "widget-zone") return left.zoneId === right.zoneId;
  if (left.kind === "window" && right.kind === "window") {
    return left.windowId === right.windowId && left.path === right.path && left.grant === right.grant;
  }

  return false;
}

function basename(path: string): string {
  const normalized = normalizeCapabilityPath(path);

  if (normalized === "/") return "/";

  const trimmed = normalized.replace(/\/+$/u, "");
  const separator = trimmed.lastIndexOf("/");

  if (separator < 0) return trimmed;

  return trimmed.slice(separator + 1);
}

function normalizeCapabilityPath(path: string): string {
  if (path.length === 0) return "/";

  const absolute = path.startsWith("/");
  const parts = path.split("/");
  const normalized: string[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];

    if (part === undefined || part.length === 0 || part === ".") continue;
    if (part === "..") {
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }

  if (absolute) {
    if (normalized.length === 0) return "/";

    return `/${normalized.join("/")}`;
  }

  if (normalized.length === 0) return ".";

  return normalized.join("/");
}
