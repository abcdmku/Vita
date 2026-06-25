import type {
  DesktopSurfacePlacement,
  DesktopSurfaceRegistrationRequest,
} from "../desktop-substrate.ts";
import type { ShellComposedLayout, ShellResolvedSurface } from "../shell/index.ts";
import type {
  Rect,
  TextureId,
  WindowId,
  WindowManagerIntent,
  WindowPlacement,
  WorkspaceId,
} from "../wm/policy.ts";

type MaybePromise<T> = T | Promise<T>;

export type CompositorRect = Pick<
  DesktopSurfacePlacement,
  "x" | "y" | "width" | "height"
>;
export type CompositorSurfaceSize = Pick<
  DesktopSurfaceRegistrationRequest,
  "width" | "height"
>;
export type CompositorSurfaceKind = "shell" | "window" | `shell:${string}` | `window:${string}`;

export interface CompositorPort {
  readonly registerSurface: (
    id: string,
    kind: CompositorSurfaceKind,
    size: CompositorSurfaceSize,
  ) => MaybePromise<void>;
  readonly updatePlacement: (
    id: string,
    rect: CompositorRect,
    z: number,
    visible: boolean,
  ) => MaybePromise<void>;
  readonly removeSurface: (id: string) => MaybePromise<void>;
  readonly present: () => MaybePromise<void>;
}

export interface CompositorWindowPlacement {
  readonly windowId: WindowId;
  readonly textureId: TextureId;
  readonly workspaceId: WorkspaceId;
  readonly rect: Rect;
  readonly focused: boolean;
  readonly visible: boolean;
  readonly zIndex: number;
}

export interface CompositorReconcileInput {
  readonly shell: ShellComposedLayout;
  readonly windows?: readonly CompositorWindowPlacement[];
  readonly windowIntents?: readonly WindowManagerIntent[];
}

export type CompositorCommand =
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

export type CompositorReconcileResult =
  | {
      readonly ok: true;
      readonly commands: readonly CompositorCommand[];
      readonly state: readonly CompositorSurfaceSnapshot[];
    }
  | {
      readonly ok: false;
      readonly error: CompositorDriverError;
      readonly commands: readonly CompositorCommand[];
      readonly state: readonly CompositorSurfaceSnapshot[];
    };

export interface CompositorDriverError {
  readonly code:
    | "DUPLICATE_SURFACE"
    | "INVALID_SURFACE"
    | "UNKNOWN_WINDOW_SURFACE"
    | "PORT_COMMAND_FAILED";
  readonly message: string;
  readonly path: string;
  readonly command?: CompositorCommand;
}

export interface CompositorSurfaceSnapshot {
  readonly id: string;
  readonly kind: CompositorSurfaceKind;
  readonly size: CompositorSurfaceSize;
  readonly rect: CompositorRect;
  readonly z: number;
  readonly visible: boolean;
}

interface DesiredSurfaceState extends CompositorSurfaceSnapshot {
  readonly source: "shell" | "window";
  readonly placementKnown: boolean;
  readonly windowId?: WindowId;
}

type DesiredResult =
  | {
      readonly ok: true;
      readonly surfaces: readonly DesiredSurfaceState[];
    }
  | {
      readonly ok: false;
      readonly error: CompositorDriverError;
    };
type WindowDesiredResult =
  | {
      readonly ok: true;
      readonly surface: DesiredSurfaceState;
    }
  | {
      readonly ok: false;
      readonly error: CompositorDriverError;
    };

const EMPTY_COMMANDS: readonly CompositorCommand[] = Object.freeze([]);
const SHELL_LAYER_ORDER = Object.freeze([
  "background",
  "desktop",
  "window",
  "panel",
  "overlay",
]);
const SHELL_LAYER_WIDTH = 10_000;
const WINDOW_LAYER_BASE = 2 * SHELL_LAYER_WIDTH;
const ZERO_RECT: CompositorRect = Object.freeze({
  height: 0,
  width: 0,
  x: 0,
  y: 0,
});

export class CompositorDriver {
  readonly #port: CompositorPort;
  #current = new Map<string, DesiredSurfaceState>();

  constructor(port: CompositorPort) {
    this.#port = port;
  }

  snapshot(): readonly CompositorSurfaceSnapshot[] {
    return snapshotFromState(this.#current);
  }

  async reconcile(input: CompositorReconcileInput): Promise<CompositorReconcileResult> {
    const desiredResult = desiredSurfacesFromInput(input, this.#current);

    if (!desiredResult.ok) {
      return {
        commands: EMPTY_COMMANDS,
        error: desiredResult.error,
        ok: false,
        state: this.snapshot(),
      };
    }

    const next = mapById(desiredResult.surfaces);
    const commands = diffCommands(this.#current, next);

    if (commands.length === 0) {
      return {
        commands: EMPTY_COMMANDS,
        ok: true,
        state: this.snapshot(),
      };
    }

    const commandsWithPresent = Object.freeze([
      ...commands,
      Object.freeze({
        type: "present" as const,
      }),
    ]);
    const executed: CompositorCommand[] = [];

    for (let index = 0; index < commandsWithPresent.length; index += 1) {
      const command = commandsWithPresent[index];

      if (command === undefined) {
        continue;
      }

      try {
        await executeCommand(this.#port, command);
        executed.push(command);
      } catch {
        return {
          commands: Object.freeze(executed),
          error: {
            code: "PORT_COMMAND_FAILED",
            command,
            message: `Compositor command '${command.type}' failed.`,
            path: commandPath(command),
          },
          ok: false,
          state: this.snapshot(),
        };
      }
    }

    this.#current = next;

    return {
      commands: commandsWithPresent,
      ok: true,
      state: this.snapshot(),
    };
  }
}

export function compositorWindowPlacement(
  placement: WindowPlacement,
  visible: boolean = placement.visible,
): CompositorWindowPlacement {
  return Object.freeze({
    focused: placement.focused,
    rect: placement.rect,
    textureId: placement.textureId,
    visible,
    windowId: placement.windowId,
    workspaceId: placement.workspaceId,
    zIndex: placement.zIndex,
  });
}

function desiredSurfacesFromInput(
  input: CompositorReconcileInput,
  current: ReadonlyMap<string, DesiredSurfaceState>,
): DesiredResult {
  const surfaces: DesiredSurfaceState[] = [];
  const shellSurfaces = shellDesiredSurfaces(input.shell);

  if (!shellSurfaces.ok) {
    return shellSurfaces;
  }

  for (let index = 0; index < shellSurfaces.surfaces.length; index += 1) {
    const surface = shellSurfaces.surfaces[index];

    if (surface !== undefined) {
      surfaces.push(surface);
    }
  }

  if (input.windows === undefined && input.windowIntents !== undefined) {
    for (const surface of current.values()) {
      if (surface.source === "window") {
        surfaces.push(surface);
      }
    }
  }

  const windows = input.windows ?? Object.freeze([]);
  for (let index = 0; index < windows.length; index += 1) {
    const placement = windows[index];

    if (placement === undefined) {
      continue;
    }

    const normalized = windowDesiredSurface(placement, `/windows/${index}`);

    if (!normalized.ok) return normalized;
    surfaces.push(normalized.surface);
  }

  const duplicate = firstDuplicateSurfaceId(surfaces);

  if (duplicate !== null) {
    return {
      error: {
        code: "DUPLICATE_SURFACE",
        message: `Surface '${duplicate}' appears more than once in compositor input.`,
        path: `/surfaces/${pathToken(duplicate)}`,
      },
      ok: false,
    };
  }

  const patched = mapById(surfaces);
  const intents = input.windowIntents ?? Object.freeze([]);

  for (let index = 0; index < intents.length; index += 1) {
    const intent = intents[index];

    if (intent === undefined) {
      continue;
    }

    const patchedIntent = applyWindowIntent(patched, current, intent, `/windowIntents/${index}`);

    if (!patchedIntent.ok) return patchedIntent;
  }

  const unresolvedPlacement = firstVisibleWindowWithoutPlacement(patched);

  if (unresolvedPlacement !== undefined) {
    return {
      error: {
        code: "INVALID_SURFACE",
        message: `Window surface '${unresolvedPlacement.id}' is visible but has no known compositor placement.`,
        path: `/surfaces/${pathToken(unresolvedPlacement.id)}/placement/rect`,
      },
      ok: false,
    };
  }

  return {
    ok: true,
    surfaces: snapshotDesiredState(patched),
  };
}

function shellDesiredSurfaces(layout: ShellComposedLayout): DesiredResult {
  const surfaces = [...layout.surfaces];
  surfaces.sort(compareShellSurfaces);

  const output: DesiredSurfaceState[] = [];

  for (let index = 0; index < surfaces.length; index += 1) {
    const surface = surfaces[index];

    if (surface === undefined) {
      continue;
    }

    const rect = surface.placement.rect;

    if (rect === undefined) {
      return {
        error: {
          code: "INVALID_SURFACE",
          message: `Shell surface '${surface.id}' has no resolved compositor rect.`,
          path: `/shell/surfaces/${pathToken(surface.id)}/placement/rect`,
        },
        ok: false,
      };
    }

    const normalizedRect = normalizeRect(rect);

    if (normalizedRect === undefined) {
      return {
        error: {
          code: "INVALID_SURFACE",
          message: `Shell surface '${surface.id}' has an invalid compositor rect.`,
          path: `/shell/surfaces/${pathToken(surface.id)}/placement/rect`,
        },
        ok: false,
      };
    }

    output.push(Object.freeze({
      id: surface.id,
      kind: shellKind(surface),
      placementKnown: true,
      rect: normalizedRect,
      size: sizeFromRect(normalizedRect),
      source: "shell",
      visible: true,
      z: shellZ(surface, index),
    }));
  }

  return {
    ok: true,
    surfaces: Object.freeze(output),
  };
}

function windowDesiredSurface(
  placement: CompositorWindowPlacement,
  path: string,
): WindowDesiredResult {
  const rect = normalizeRect(placement.rect);

  if (rect === undefined) {
    return {
      error: {
        code: "INVALID_SURFACE",
        message: "Window placement rect must contain finite non-negative dimensions.",
        path: `${path}/rect`,
      },
      ok: false,
    };
  }

  return {
    ok: true,
    surface: Object.freeze({
      id: placement.textureId,
      kind: "window",
      placementKnown: true,
      rect,
      size: sizeFromRect(rect),
      source: "window",
      visible: placement.visible,
      windowId: placement.windowId,
      z: WINDOW_LAYER_BASE + normalizeZ(placement.zIndex),
    }),
  };
}

function applyWindowIntent(
  desired: Map<string, DesiredSurfaceState>,
  current: ReadonlyMap<string, DesiredSurfaceState>,
  intent: WindowManagerIntent,
  path: string,
): DesiredResult {
  if (intent.type === "setFocus") {
    return applyFocusIntent(desired, intent.windowId, path);
  }

  const id = intent.textureId;

  if (intent.type === "setTextureVisibility") {
    const desiredSurface = desired.get(id);

    if (desiredSurface === undefined && !intent.visible) {
      return {
        ok: true,
        surfaces: Object.freeze([]),
      };
    }

    const existing = desiredSurface ?? current.get(id) ?? provisionalWindowSurface(id, intent.windowId, desired);

    if (existing.source !== "window") {
      return {
        error: {
          code: "INVALID_SURFACE",
          message: `Window intent references non-window compositor surface '${id}'.`,
          path: `${path}/textureId`,
        },
        ok: false,
      };
    }

    if (!intent.visible && !existing.placementKnown && current.get(id) === undefined) {
      desired.delete(id);
      return {
        ok: true,
        surfaces: Object.freeze([]),
      };
    }

    desired.set(id, Object.freeze({
      ...existing,
      visible: intent.visible,
    }));
    return {
      ok: true,
      surfaces: Object.freeze([]),
    };
  }

  const existing = desired.get(id) ?? current.get(id);

  if (existing === undefined) {
    return {
      error: {
        code: "UNKNOWN_WINDOW_SURFACE",
        message: `Window intent references unknown compositor surface '${id}'.`,
        path: `${path}/textureId`,
      },
      ok: false,
    };
  }

  if (existing.source !== "window") {
    return {
      error: {
        code: "INVALID_SURFACE",
        message: `Window intent references non-window compositor surface '${id}'.`,
        path: `${path}/textureId`,
      },
      ok: false,
    };
  }

  if (intent.type === "repositionTexture") {
    const rect = normalizeRect(intent.rect);

    if (rect === undefined) {
      return {
        error: {
          code: "INVALID_SURFACE",
          message: "Window intent rect must contain finite non-negative dimensions.",
          path: `${path}/rect`,
        },
        ok: false,
      };
    }

    desired.set(id, Object.freeze({
      ...existing,
      placementKnown: true,
      rect,
      size: sizeFromRect(rect),
      visible: true,
    }));
    return {
      ok: true,
      surfaces: Object.freeze([]),
    };
  }

  return {
    ok: true,
    surfaces: Object.freeze([]),
  };
}

function applyFocusIntent(
  desired: Map<string, DesiredSurfaceState>,
  windowId: WindowId | null,
  path: string,
): DesiredResult {
  if (windowId === null) {
    return {
      ok: true,
      surfaces: Object.freeze([]),
    };
  }

  const windows = windowSurfacesByZ(desired);
  const targetIndex = windows.findIndex((surface) => surface.windowId === windowId);

  if (targetIndex < 0) {
    return {
      error: {
        code: "UNKNOWN_WINDOW_SURFACE",
        message: `Focus intent references unknown window '${windowId}'.`,
        path: `${path}/windowId`,
      },
      ok: false,
    };
  }

  if (targetIndex === windows.length - 1) {
    return {
      ok: true,
      surfaces: Object.freeze([]),
    };
  }

  const target = windows[targetIndex];

  if (target === undefined) {
    return {
      error: {
        code: "UNKNOWN_WINDOW_SURFACE",
        message: `Focus intent references unknown window '${windowId}'.`,
        path: `${path}/windowId`,
      },
      ok: false,
    };
  }

  const zSlots = windows.map((surface) => surface.z);
  const restacked = [
    ...windows.slice(0, targetIndex),
    ...windows.slice(targetIndex + 1),
    target,
  ];

  for (let index = 0; index < restacked.length; index += 1) {
    const surface = restacked[index];
    const z = zSlots[index];

    if (surface !== undefined && z !== undefined && surface.z !== z) {
      desired.set(surface.id, Object.freeze({
        ...surface,
        z,
      }));
    }
  }

  return {
    ok: true,
    surfaces: Object.freeze([]),
  };
}

function windowSurfacesByZ(
  desired: ReadonlyMap<string, DesiredSurfaceState>,
): readonly DesiredSurfaceState[] {
  const windows: DesiredSurfaceState[] = [];

  for (const surface of desired.values()) {
    if (surface.source === "window" && surface.visible) {
      windows.push(surface);
    }
  }

  windows.sort((left, right) => {
    const z = left.z - right.z;
    if (z !== 0) return z;

    return compareStrings(left.id, right.id);
  });

  return Object.freeze(windows);
}

function provisionalWindowSurface(
  id: string,
  windowId: WindowId,
  desired: ReadonlyMap<string, DesiredSurfaceState>,
): DesiredSurfaceState {
  return Object.freeze({
    id,
    kind: "window",
    placementKnown: false,
    rect: ZERO_RECT,
    size: sizeFromRect(ZERO_RECT),
    source: "window",
    visible: true,
    windowId,
    z: nextWindowIntentZ(desired),
  });
}

function firstVisibleWindowWithoutPlacement(
  state: ReadonlyMap<string, DesiredSurfaceState>,
): DesiredSurfaceState | undefined {
  for (const surface of state.values()) {
    if (surface.source === "window" && surface.visible && !surface.placementKnown) {
      return surface;
    }
  }

  return undefined;
}

function nextWindowIntentZ(desired: ReadonlyMap<string, DesiredSurfaceState>): number {
  let next = 0;

  for (const surface of desired.values()) {
    if (surface.source !== "window") {
      continue;
    }

    const offset = surface.z - WINDOW_LAYER_BASE;
    if (Number.isSafeInteger(offset) && offset >= next) {
      next = offset + 1;
    }
  }

  return WINDOW_LAYER_BASE + next;
}

function diffCommands(
  current: ReadonlyMap<string, DesiredSurfaceState>,
  next: ReadonlyMap<string, DesiredSurfaceState>,
): readonly CompositorCommand[] {
  const commands: CompositorCommand[] = [];
  const currentIds = [...current.keys()].sort(compareStrings);
  const nextIds = [...next.keys()].sort((left, right) => compareDesiredIds(next, left, right));

  for (let index = 0; index < currentIds.length; index += 1) {
    const id = currentIds[index];

    if (id !== undefined && !next.has(id)) {
      commands.push(Object.freeze({
        id,
        type: "removeSurface",
      }));
    }
  }

  for (let index = 0; index < currentIds.length; index += 1) {
    const id = currentIds[index];

    if (id === undefined) {
      continue;
    }

    const existing = current.get(id);
    const desired = next.get(id);

    if (existing === undefined || desired === undefined || existing.kind === desired.kind) {
      continue;
    }

    commands.push(Object.freeze({
      id,
      type: "removeSurface",
    }));
  }

  for (let index = 0; index < nextIds.length; index += 1) {
    const id = nextIds[index];

    if (id === undefined) {
      continue;
    }

    const existing = current.get(id);
    const desired = next.get(id);

    if (desired === undefined) {
      continue;
    }

    if (existing === undefined || existing.kind !== desired.kind) {
      commands.push(Object.freeze({
        id,
        kind: desired.kind,
        size: desired.size,
        type: "registerSurface",
      }));
      commands.push(updateCommand(desired));
      continue;
    }

    if (!samePlacement(existing, desired)) {
      commands.push(updateCommand(desired));
    }
  }

  return Object.freeze(commands);
}

function executeCommand(port: CompositorPort, command: CompositorCommand): MaybePromise<void> {
  switch (command.type) {
    case "registerSurface":
      return port.registerSurface(command.id, command.kind, command.size);
    case "updatePlacement":
      return port.updatePlacement(command.id, command.rect, command.z, command.visible);
    case "removeSurface":
      return port.removeSurface(command.id);
    case "present":
      return port.present();
  }
}

function updateCommand(surface: DesiredSurfaceState): CompositorCommand {
  return Object.freeze({
    id: surface.id,
    rect: surface.rect,
    type: "updatePlacement",
    visible: surface.visible,
    z: surface.z,
  });
}

function shellKind(surface: ShellResolvedSurface): CompositorSurfaceKind {
  return `shell:${surface.role}`;
}

function shellZ(surface: ShellResolvedSurface, stableIndex: number): number {
  const layerIndex = knownLayerIndex(surface.placement.layer);
  return (layerIndex * SHELL_LAYER_WIDTH) + normalizeZ(surface.placement.order) + stableIndex;
}

function knownLayerIndex(layer: string): number {
  for (let index = 0; index < SHELL_LAYER_ORDER.length; index += 1) {
    if (SHELL_LAYER_ORDER[index] === layer) {
      return index;
    }
  }

  return SHELL_LAYER_ORDER.length;
}

function compareShellSurfaces(left: ShellResolvedSurface, right: ShellResolvedSurface): number {
  const leftLayer = knownLayerIndex(left.placement.layer);
  const rightLayer = knownLayerIndex(right.placement.layer);

  if (leftLayer !== rightLayer) {
    return leftLayer - rightLayer;
  }

  const layer = compareStrings(left.placement.layer, right.placement.layer);
  if (layer !== 0) return layer;

  const order = left.placement.order - right.placement.order;
  if (order !== 0) return order;

  return compareStrings(left.id, right.id);
}

function compareDesiredIds(
  next: ReadonlyMap<string, DesiredSurfaceState>,
  left: string,
  right: string,
): number {
  const leftSurface = next.get(left);
  const rightSurface = next.get(right);

  if (leftSurface !== undefined && rightSurface !== undefined) {
    const z = leftSurface.z - rightSurface.z;
    if (z !== 0) return z;
  }

  return compareStrings(left, right);
}

function samePlacement(left: DesiredSurfaceState, right: DesiredSurfaceState): boolean {
  return (
    sameRect(left.rect, right.rect) &&
    left.z === right.z &&
    left.visible === right.visible
  );
}

function sameRect(left: CompositorRect, right: CompositorRect): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function normalizeRect(rect: Rect | CompositorRect): CompositorRect | undefined {
  const x = normalizeFiniteNumber(rect.x);
  const y = normalizeFiniteNumber(rect.y);
  const width = normalizeFiniteNumber(rect.width);
  const height = normalizeFiniteNumber(rect.height);

  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined ||
    width < 0 ||
    height < 0
  ) {
    return undefined;
  }

  return Object.freeze({
    height,
    width,
    x,
    y,
  });
}

function normalizeFiniteNumber(value: number): number | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }

  return Math.trunc(value);
}

function normalizeZ(value: number): number {
  return Number.isSafeInteger(value) ? value : 0;
}

function sizeFromRect(rect: CompositorRect): CompositorSurfaceSize {
  return Object.freeze({
    height: rect.height,
    width: rect.width,
  });
}

function firstDuplicateSurfaceId(surfaces: readonly DesiredSurfaceState[]): string | null {
  const seen = new Set<string>();

  for (let index = 0; index < surfaces.length; index += 1) {
    const surface = surfaces[index];

    if (surface === undefined) {
      continue;
    }
    if (seen.has(surface.id)) {
      return surface.id;
    }

    seen.add(surface.id);
  }

  return null;
}

function mapById(surfaces: readonly DesiredSurfaceState[]): Map<string, DesiredSurfaceState> {
  const output = new Map<string, DesiredSurfaceState>();

  for (let index = 0; index < surfaces.length; index += 1) {
    const surface = surfaces[index];

    if (surface !== undefined) {
      output.set(surface.id, surface);
    }
  }

  return output;
}

function snapshotFromState(
  state: ReadonlyMap<string, DesiredSurfaceState>,
): readonly CompositorSurfaceSnapshot[] {
  return snapshotDesiredState(state).map((surface) => Object.freeze({
    id: surface.id,
    kind: surface.kind,
    rect: surface.rect,
    size: surface.size,
    visible: surface.visible,
    z: surface.z,
  }));
}

function snapshotDesiredState(
  state: ReadonlyMap<string, DesiredSurfaceState>,
): readonly DesiredSurfaceState[] {
  const surfaces = [...state.values()];
  surfaces.sort((left, right) => {
    const z = left.z - right.z;
    if (z !== 0) return z;

    return compareStrings(left.id, right.id);
  });

  return Object.freeze(surfaces);
}

function commandPath(command: CompositorCommand): string {
  if (command.type === "present") {
    return "/present";
  }

  return `/surfaces/${pathToken(command.id)}/${command.type}`;
}

function pathToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;

  return 0;
}
