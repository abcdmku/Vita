import {
  hasDesktopCapabilityGrant,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  DesktopHost,
  DesktopUiPackageManifest,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  ContextMenuRenderedItem,
  ContextMenuState,
} from "./context-menu.ts";
import type {
  DesktopIcon,
  DesktopIconsViewState,
} from "./desktop-icons.ts";
import type {
  StageCell,
  StageViewModelState,
  StageWorkspaceGroup,
} from "./stage.ts";
import type {
  WallpaperViewModelState,
} from "./wallpaper.ts";
import type {
  WidgetHostState,
  WidgetInstance,
} from "./widget-host.ts";

export const SURFACE_A11Y_REGION_ORDER = Object.freeze([
  "wallpaper",
  "icons",
  "widgets",
  "menu",
  "stage",
] as const);

export const SURFACE_REDUCED_MOTION_SETTING_KEY = "accessibility.reduceMotion";
export const SURFACE_REDUCED_MOTION_SAFE_DEFAULT = true;

export type SurfaceA11yRegion = typeof SURFACE_A11Y_REGION_ORDER[number];
export type SurfaceFocusNodeKind = "icon" | "menuitem" | "region" | "stage-window" | "widget";
export type SurfaceFocusMoveDirection = "backward" | "down" | "forward" | "left" | "right" | "up";
export type SurfaceAriaRole = "application" | "group" | "listbox" | "menu" | "menuitem" | "option" | "region";

export interface SurfaceMotionPreference {
  readonly motionAllowed: boolean;
  readonly reducedMotion: boolean;
  readonly source: "default" | "settings";
}

export interface SurfaceA11ySettingsPorts {
  readonly package: DesktopUiPackageManifest;
  readonly readSetting?: NonNullable<DesktopHost["readSetting"]>;
}

export interface SurfaceA11yInput<Context = unknown, Role = unknown> {
  readonly activeFocusId?: string | null;
  readonly icons: DesktopIconsViewState;
  readonly menu: ContextMenuState<Context, Role>;
  readonly motion?: SurfaceMotionPreference;
  readonly stage: StageViewModelState;
  readonly wallpaper?: WallpaperViewModelState | null;
  readonly widgets: WidgetHostState;
}

export interface SurfaceFocusOrder {
  readonly activeId: string | null;
  readonly nodes: readonly SurfaceFocusNode[];
}

export interface SurfaceFocusNode {
  readonly disabled?: boolean;
  readonly id: string;
  readonly kind: SurfaceFocusNodeKind;
  readonly label: string;
  readonly region: SurfaceA11yRegion;
  readonly selected?: boolean;
  readonly target: SurfaceActionTarget;
}

export type SurfaceActionTarget =
  | SurfaceRegionTarget
  | SurfaceIconTarget
  | SurfaceWidgetTarget
  | SurfaceMenuItemTarget
  | SurfaceStageWindowTarget;

export interface SurfaceRegionTarget {
  readonly id: SurfaceA11yRegion;
  readonly kind: "region";
  readonly region: SurfaceA11yRegion;
}

export interface SurfaceIconTarget {
  readonly id: string;
  readonly kind: "icon";
  readonly label: string;
  readonly region: "icons";
  readonly selected: boolean;
  readonly selectedIds: readonly string[];
}

export interface SurfaceWidgetTarget {
  readonly disabled: boolean;
  readonly id: string;
  readonly kind: "widget";
  readonly label: string;
  readonly paused: boolean;
  readonly region: "widgets";
  readonly widgetKind: string;
}

export interface SurfaceMenuItemTarget {
  readonly checked: boolean;
  readonly destructive: boolean;
  readonly disabled: boolean;
  readonly id: string;
  readonly kind: "menuitem";
  readonly label: string;
  readonly level: number;
  readonly path: readonly string[];
  readonly region: "menu";
}

export interface SurfaceStageWindowTarget {
  readonly appId: string;
  readonly kind: "stage-window";
  readonly label: string;
  readonly region: "stage";
  readonly selected: boolean;
  readonly windowId: string;
  readonly workspaceId: string;
}

export interface SurfaceAriaTree {
  readonly root: SurfaceAriaNode;
}

export interface SurfaceAriaNode {
  readonly checked?: boolean;
  readonly children: readonly SurfaceAriaNode[];
  readonly current?: boolean;
  readonly disabled?: boolean;
  readonly expanded?: boolean;
  readonly id: string;
  readonly label: string;
  readonly role: SurfaceAriaRole;
  readonly selected?: boolean;
}

export interface SurfaceA11yProjection {
  readonly ariaTree: SurfaceAriaTree;
  readonly focusOrder: SurfaceFocusOrder;
  readonly motion: SurfaceMotionPreference;
  readonly reducedMotion: boolean;
}

export interface SurfaceKeyboardEvent {
  readonly code?: string;
  readonly key: string;
  readonly shiftKey?: boolean;
}

export interface SurfaceDragEvent {
  readonly metaKey?: boolean;
  readonly sourceFocusId?: string | null;
}

export type SurfaceActionIntent =
  | {
      readonly direction: SurfaceFocusMoveDirection;
      readonly fromId: string | null;
      readonly target: SurfaceActionTarget | null;
      readonly toId: string | null;
      readonly type: "focus";
    }
  | {
      readonly target: SurfaceActionTarget | null;
      readonly type: "open" | "rename" | "trash";
    }
  | {
      readonly copy: true;
      readonly target: SurfaceActionTarget | null;
      readonly type: "drag-copy";
    };

interface IconEntry {
  readonly icon: DesktopIcon;
  readonly index: number;
}

const FOCUS_PREFIX = "surface-focus";
const ARIA_PREFIX = "surface-a11y";

export function createSurfaceA11yProjection<Context, Role>(
  input: SurfaceA11yInput<Context, Role>,
): SurfaceA11yProjection {
  const motion = input.motion ?? defaultSurfaceMotionPreference();

  return Object.freeze({
    ariaTree: createSurfaceAriaTree(input),
    focusOrder: createSurfaceFocusOrder(input),
    motion,
    reducedMotion: motion.reducedMotion,
  });
}

export function createSurfaceFocusOrder<Context, Role>(
  input: SurfaceA11yInput<Context, Role>,
): SurfaceFocusOrder {
  const selectedIds = Object.freeze([...input.icons.selectedIds]);
  const nodes: SurfaceFocusNode[] = [];

  nodes.push(regionFocusNode("wallpaper", wallpaperLabel(input.wallpaper)));
  nodes.push(regionFocusNode("icons", "Desktop icons"));
  appendIconFocusNodes(nodes, input.icons, selectedIds);
  nodes.push(regionFocusNode("widgets", "Widgets"));
  appendWidgetFocusNodes(nodes, input.widgets);
  nodes.push(regionFocusNode("menu", "Context menu"));
  appendMenuFocusNodes(nodes, input.menu);
  nodes.push(regionFocusNode("stage", "Stage"));
  appendStageFocusNodes(nodes, input.stage);

  const frozenNodes = Object.freeze(nodes);

  return Object.freeze({
    activeId: resolveActiveFocusId(input, frozenNodes),
    nodes: frozenNodes,
  });
}

export function createSurfaceAriaTree<Context, Role>(
  input: SurfaceA11yInput<Context, Role>,
): SurfaceAriaTree {
  const selectedIds = Object.freeze([...input.icons.selectedIds]);
  const root = ariaNode({
    children: Object.freeze([
      wallpaperAriaNode(input.wallpaper),
      iconsAriaNode(input.icons, selectedIds),
      widgetsAriaNode(input.widgets),
      menuAriaNode(input.menu),
      stageAriaNode(input.stage),
    ]),
    id: `${ARIA_PREFIX}-root`,
    label: "Vita desktop surface",
    role: "application",
  });

  return Object.freeze({
    root,
  });
}

export function nextSurfaceFocus(
  order: SurfaceFocusOrder,
  currentId: string | null,
  direction: "backward" | "forward",
): SurfaceFocusNode | null {
  if (order.nodes.length === 0) return null;

  const currentIndex = findFocusIndex(order.nodes, currentId);

  if (currentIndex < 0) {
    return direction === "forward"
      ? order.nodes[0] ?? null
      : order.nodes[order.nodes.length - 1] ?? null;
  }

  const step = direction === "forward" ? 1 : -1;
  const nextIndex = positiveModulo(currentIndex + step, order.nodes.length);

  return order.nodes[nextIndex] ?? null;
}

export function resolveSurfaceHotkey<Context, Role>(
  input: SurfaceA11yInput<Context, Role>,
  event: SurfaceKeyboardEvent,
): SurfaceActionIntent | null {
  const order = createSurfaceFocusOrder(input);
  const key = normalizeKey(event.key, event.code);
  const activeId = order.activeId;

  if (key === "Tab") {
    const direction = event.shiftKey === true ? "backward" : "forward";
    const next = nextSurfaceFocus(order, activeId, direction);

    return focusIntent(direction, activeId, next);
  }

  if (key === "ArrowUp") return arrowFocusIntent(order, activeId, "up");
  if (key === "ArrowDown") return arrowFocusIntent(order, activeId, "down");
  if (key === "ArrowLeft") return arrowFocusIntent(order, activeId, "left");
  if (key === "ArrowRight") return arrowFocusIntent(order, activeId, "right");

  const target = focusTargetById(order.nodes, activeId);

  if (key === "F2") {
    return Object.freeze({
      target,
      type: "rename",
    });
  }
  if (key === "Enter") {
    return Object.freeze({
      target,
      type: "open",
    });
  }
  if (key === "Delete") {
    return Object.freeze({
      target,
      type: "trash",
    });
  }

  return null;
}

export function resolveSurfaceDragIntent<Context, Role>(
  input: SurfaceA11yInput<Context, Role>,
  event: SurfaceDragEvent,
): SurfaceActionIntent | null {
  if (event.metaKey !== true) return null;

  const order = createSurfaceFocusOrder(input);
  const focusId = event.sourceFocusId ?? order.activeId;

  return Object.freeze({
    copy: true,
    target: focusTargetById(order.nodes, focusId),
    type: "drag-copy",
  });
}

export async function readSurfaceMotionPreference(
  ports: SurfaceA11ySettingsPorts,
): Promise<SurfaceMotionPreference> {
  if (!hasDesktopCapabilityGrant(ports.package, "settings.read", SURFACE_REDUCED_MOTION_SETTING_KEY)) {
    return defaultSurfaceMotionPreference();
  }

  const readSetting = ports.readSetting;

  if (readSetting === undefined) return defaultSurfaceMotionPreference();

  try {
    const result = await readSetting(Object.freeze({
      key: SURFACE_REDUCED_MOTION_SETTING_KEY,
    }));

    if (!result.ok || typeof result.value !== "boolean") {
      return defaultSurfaceMotionPreference();
    }

    return motionPreference(result.value, "settings");
  } catch {
    return defaultSurfaceMotionPreference();
  }
}

export function defaultSurfaceMotionPreference(): SurfaceMotionPreference {
  return motionPreference(SURFACE_REDUCED_MOTION_SAFE_DEFAULT, "default");
}

export function surfaceFocusIdForRegion(region: SurfaceA11yRegion): string {
  return `${FOCUS_PREFIX}-region-${region}`;
}

export function surfaceFocusIdForIcon(iconId: string): string {
  return `${FOCUS_PREFIX}-icon-${idToken(iconId)}`;
}

export function surfaceFocusIdForWidget(widgetId: string): string {
  return `${FOCUS_PREFIX}-widget-${idToken(widgetId)}`;
}

export function surfaceFocusIdForMenuItem(path: readonly string[]): string {
  return `${FOCUS_PREFIX}-menu-${pathToken(path)}`;
}

export function surfaceFocusIdForStageWindow(workspaceId: string, windowId: string): string {
  return `${FOCUS_PREFIX}-stage-${idToken(workspaceId)}-${idToken(windowId)}`;
}

function appendIconFocusNodes(
  nodes: SurfaceFocusNode[],
  icons: DesktopIconsViewState,
  selectedIds: readonly string[],
): void {
  const ordered = orderedIconsForFocus(icons.icons);

  for (let index = 0; index < ordered.length; index += 1) {
    const icon = ordered[index];

    if (icon === undefined) continue;

    const selected = containsString(selectedIds, icon.id);
    const target = Object.freeze({
      id: icon.id,
      kind: "icon",
      label: icon.label,
      region: "icons",
      selected,
      selectedIds: Object.freeze([...selectedIds]),
    } satisfies SurfaceIconTarget);

    nodes.push(focusNode({
      id: surfaceFocusIdForIcon(icon.id),
      kind: "icon",
      label: icon.label,
      region: "icons",
      selected,
      target,
    }));
  }
}

function appendWidgetFocusNodes(nodes: SurfaceFocusNode[], widgets: WidgetHostState): void {
  for (let index = 0; index < widgets.instances.length; index += 1) {
    const widget = widgets.instances[index];

    if (widget === undefined) continue;

    const target = widgetTarget(widget);

    nodes.push(focusNode({
      disabled: target.disabled,
      id: surfaceFocusIdForWidget(widget.id),
      kind: "widget",
      label: target.label,
      region: "widgets",
      target,
    }));
  }
}

function appendMenuFocusNodes<Context, Role>(
  nodes: SurfaceFocusNode[],
  menu: ContextMenuState<Context, Role>,
): void {
  if (!menu.open) return;

  for (let levelIndex = 0; levelIndex < menu.levels.length; levelIndex += 1) {
    const level = menu.levels[levelIndex];

    if (level === undefined) continue;

    for (let itemIndex = 0; itemIndex < level.items.length; itemIndex += 1) {
      const item = level.items[itemIndex];

      if (item === undefined || item.kind !== "item" || item.disabled) continue;

      const target = menuItemTarget(item);

      nodes.push(focusNode({
        id: surfaceFocusIdForMenuItem(item.path),
        kind: "menuitem",
        label: item.label,
        region: "menu",
        target,
      }));
    }
  }
}

function appendStageFocusNodes(nodes: SurfaceFocusNode[], stage: StageViewModelState): void {
  for (let workspaceIndex = 0; workspaceIndex < stage.workspaces.length; workspaceIndex += 1) {
    const workspace = stage.workspaces[workspaceIndex];

    if (workspace === undefined) continue;

    for (let cellIndex = 0; cellIndex < workspace.cells.length; cellIndex += 1) {
      const cell = workspace.cells[cellIndex];

      if (cell === undefined) continue;

      const selected = stage.focusedCell?.workspaceId === workspace.workspaceId &&
        stage.focusedCell.windowId === cell.windowId;
      const target = stageWindowTarget(workspace, cell, selected);

      nodes.push(focusNode({
        id: surfaceFocusIdForStageWindow(workspace.workspaceId, cell.windowId),
        kind: "stage-window",
        label: cell.title,
        region: "stage",
        selected,
        target,
      }));
    }
  }
}

function resolveActiveFocusId<Context, Role>(
  input: SurfaceA11yInput<Context, Role>,
  nodes: readonly SurfaceFocusNode[],
): string | null {
  if (input.activeFocusId !== undefined && findFocusIndex(nodes, input.activeFocusId) >= 0) {
    return input.activeFocusId;
  }

  const menuFocusId = focusedMenuItemId(input.menu);

  if (menuFocusId !== null && findFocusIndex(nodes, menuFocusId) >= 0) {
    return menuFocusId;
  }

  const iconId = selectedIconFocusId(input.icons);

  if (iconId !== null && findFocusIndex(nodes, iconId) >= 0) {
    return iconId;
  }

  const stageId = focusedStageWindowFocusId(input.stage);

  if (stageId !== null && findFocusIndex(nodes, stageId) >= 0) {
    return stageId;
  }

  return nodes[0]?.id ?? null;
}

function selectedIconFocusId(icons: DesktopIconsViewState): string | null {
  const selected = new Set<string>(icons.selectedIds);
  const ordered = orderedIconsForFocus(icons.icons);

  for (let index = 0; index < ordered.length; index += 1) {
    const icon = ordered[index];

    if (icon !== undefined && selected.has(icon.id)) {
      return surfaceFocusIdForIcon(icon.id);
    }
  }

  return null;
}

function focusedMenuItemId<Context, Role>(menu: ContextMenuState<Context, Role>): string | null {
  if (!menu.open || menu.focusedCursor === null) return null;

  return surfaceFocusIdForMenuItem(menu.focusedCursor.path);
}

function focusedStageWindowFocusId(stage: StageViewModelState): string | null {
  if (stage.focusedCell === null) return null;

  return surfaceFocusIdForStageWindow(stage.focusedCell.workspaceId, stage.focusedCell.windowId);
}

function wallpaperAriaNode(wallpaper: WallpaperViewModelState | null | undefined): SurfaceAriaNode {
  return ariaNode({
    children: Object.freeze([]),
    id: `${ARIA_PREFIX}-wallpaper`,
    label: wallpaperLabel(wallpaper),
    role: "region",
  });
}

function iconsAriaNode(icons: DesktopIconsViewState, selectedIds: readonly string[]): SurfaceAriaNode {
  const children: SurfaceAriaNode[] = [];
  const ordered = orderedIconsForFocus(icons.icons);

  for (let index = 0; index < ordered.length; index += 1) {
    const icon = ordered[index];

    if (icon === undefined) continue;

    children.push(ariaNode({
      children: Object.freeze([]),
      id: `${ARIA_PREFIX}-icon-${idToken(icon.id)}`,
      label: icon.label,
      role: "option",
      selected: containsString(selectedIds, icon.id),
    }));
  }

  return ariaNode({
    children: Object.freeze(children),
    id: `${ARIA_PREFIX}-icons`,
    label: "Desktop icons",
    role: "listbox",
  });
}

function widgetsAriaNode(widgets: WidgetHostState): SurfaceAriaNode {
  const children: SurfaceAriaNode[] = [];

  for (let index = 0; index < widgets.instances.length; index += 1) {
    const widget = widgets.instances[index];

    if (widget === undefined) continue;

    const target = widgetTarget(widget);

    children.push(ariaNode({
      children: Object.freeze([]),
      disabled: target.disabled,
      id: `${ARIA_PREFIX}-widget-${idToken(widget.id)}`,
      label: target.label,
      role: "group",
    }));
  }

  return ariaNode({
    children: Object.freeze(children),
    id: `${ARIA_PREFIX}-widgets`,
    label: "Widgets",
    role: "region",
  });
}

function menuAriaNode<Context, Role>(menu: ContextMenuState<Context, Role>): SurfaceAriaNode {
  const children: SurfaceAriaNode[] = [];

  if (menu.open) {
    for (let levelIndex = 0; levelIndex < menu.levels.length; levelIndex += 1) {
      const level = menu.levels[levelIndex];

      if (level === undefined) continue;

      for (let itemIndex = 0; itemIndex < level.items.length; itemIndex += 1) {
        const item = level.items[itemIndex];

        if (item === undefined || item.kind !== "item") continue;

        children.push(ariaNode({
          checked: item.checked,
          children: Object.freeze([]),
          disabled: item.disabled,
          id: `${ARIA_PREFIX}-menu-${pathToken(item.path)}`,
          label: item.label,
          role: "menuitem",
        }));
      }
    }
  }

  return ariaNode({
    children: Object.freeze(children),
    expanded: menu.open,
    id: `${ARIA_PREFIX}-menu`,
    label: "Context menu",
    role: "menu",
  });
}

function stageAriaNode(stage: StageViewModelState): SurfaceAriaNode {
  const children: SurfaceAriaNode[] = [];

  for (let index = 0; index < stage.workspaces.length; index += 1) {
    const workspace = stage.workspaces[index];

    if (workspace === undefined) continue;

    const workspaceChildren: SurfaceAriaNode[] = [];

    for (let cellIndex = 0; cellIndex < workspace.cells.length; cellIndex += 1) {
      const cell = workspace.cells[cellIndex];

      if (cell === undefined) continue;

      const selected = stage.focusedCell?.workspaceId === workspace.workspaceId &&
        stage.focusedCell.windowId === cell.windowId;

      workspaceChildren.push(ariaNode({
        children: Object.freeze([]),
        current: selected,
        id: `${ARIA_PREFIX}-stage-${idToken(workspace.workspaceId)}-${idToken(cell.windowId)}`,
        label: cell.title,
        role: "option",
        selected,
      }));
    }

    children.push(ariaNode({
      children: Object.freeze(workspaceChildren),
      id: `${ARIA_PREFIX}-stage-workspace-${idToken(workspace.workspaceId)}`,
      label: workspace.label,
      role: "group",
    }));
  }

  return ariaNode({
    children: Object.freeze(children),
    id: `${ARIA_PREFIX}-stage`,
    label: "Stage",
    role: "region",
  });
}

function orderedIconsForFocus(icons: readonly DesktopIcon[]): readonly DesktopIcon[] {
  const entries: IconEntry[] = [];

  for (let index = 0; index < icons.length; index += 1) {
    const icon = icons[index];

    if (icon !== undefined) {
      entries.push(Object.freeze({
        icon,
        index,
      }));
    }
  }

  entries.sort(compareIconEntriesForFocus);

  return Object.freeze(entries.map((entry) => entry.icon));
}

function compareIconEntriesForFocus(left: IconEntry, right: IconEntry): number {
  const folderRank = iconFolderRank(left.icon) - iconFolderRank(right.icon);

  if (folderRank !== 0) return folderRank;

  const label = compareStrings(canonicalSortText(left.icon.label), canonicalSortText(right.icon.label));

  if (label !== 0) return label;

  const id = compareStrings(left.icon.id, right.icon.id);

  if (id !== 0) return id;

  return left.index - right.index;
}

function iconFolderRank(icon: DesktopIcon): number {
  const kind = canonicalSortText(icon.kind);

  return kind === "directory" || kind === "folder" ? 0 : 1;
}

function regionFocusNode(region: SurfaceA11yRegion, label: string): SurfaceFocusNode {
  return focusNode({
    id: surfaceFocusIdForRegion(region),
    kind: "region",
    label,
    region,
    target: Object.freeze({
      id: region,
      kind: "region",
      region,
    } satisfies SurfaceRegionTarget),
  });
}

function widgetTarget(widget: WidgetInstance): SurfaceWidgetTarget {
  const label = `${titleCase(widget.kind)} widget`;

  return Object.freeze({
    disabled: !widget.enabled,
    id: widget.id,
    kind: "widget",
    label,
    paused: widget.paused,
    region: "widgets",
    widgetKind: widget.kind,
  });
}

function menuItemTarget<Role>(item: ContextMenuRenderedItem<Role>): SurfaceMenuItemTarget {
  return Object.freeze({
    checked: item.checked,
    destructive: item.destructive,
    disabled: item.disabled,
    id: item.id,
    kind: "menuitem",
    label: item.label,
    level: item.level,
    path: Object.freeze([...item.path]),
    region: "menu",
  });
}

function stageWindowTarget(
  workspace: StageWorkspaceGroup,
  cell: StageCell,
  selected: boolean,
): SurfaceStageWindowTarget {
  return Object.freeze({
    appId: cell.appId,
    kind: "stage-window",
    label: cell.title,
    region: "stage",
    selected,
    windowId: cell.windowId,
    workspaceId: workspace.workspaceId,
  });
}

function arrowFocusIntent(
  order: SurfaceFocusOrder,
  activeId: string | null,
  direction: "down" | "left" | "right" | "up",
): SurfaceActionIntent {
  const next = direction === "up" || direction === "left"
    ? nextSurfaceFocus(order, activeId, "backward")
    : nextSurfaceFocus(order, activeId, "forward");

  return focusIntent(direction, activeId, next);
}

function focusIntent(
  direction: SurfaceFocusMoveDirection,
  fromId: string | null,
  next: SurfaceFocusNode | null,
): SurfaceActionIntent {
  return Object.freeze({
    direction,
    fromId,
    target: next?.target ?? null,
    toId: next?.id ?? null,
    type: "focus",
  });
}

function focusTargetById(nodes: readonly SurfaceFocusNode[], id: string | null): SurfaceActionTarget | null {
  const index = findFocusIndex(nodes, id);

  return index < 0 ? null : nodes[index]?.target ?? null;
}

function findFocusIndex(nodes: readonly SurfaceFocusNode[], id: string | null): number {
  if (id === null) return -1;

  for (let index = 0; index < nodes.length; index += 1) {
    if (nodes[index]?.id === id) return index;
  }

  return -1;
}

function focusNode(input: SurfaceFocusNode): SurfaceFocusNode {
  const output: {
    id: string;
    kind: SurfaceFocusNodeKind;
    label: string;
    region: SurfaceA11yRegion;
    target: SurfaceActionTarget;
    disabled?: boolean;
    selected?: boolean;
  } = {
    id: input.id,
    kind: input.kind,
    label: input.label,
    region: input.region,
    target: input.target,
  };

  if (input.disabled !== undefined) output.disabled = input.disabled;
  if (input.selected !== undefined) output.selected = input.selected;

  return Object.freeze(output);
}

function ariaNode(input: SurfaceAriaNode): SurfaceAriaNode {
  const output: {
    children: readonly SurfaceAriaNode[];
    id: string;
    label: string;
    role: SurfaceAriaRole;
    checked?: boolean;
    current?: boolean;
    disabled?: boolean;
    expanded?: boolean;
    selected?: boolean;
  } = {
    children: Object.freeze([...input.children]),
    id: input.id,
    label: input.label,
    role: input.role,
  };

  if (input.checked !== undefined) output.checked = input.checked;
  if (input.current !== undefined) output.current = input.current;
  if (input.disabled !== undefined) output.disabled = input.disabled;
  if (input.expanded !== undefined) output.expanded = input.expanded;
  if (input.selected !== undefined) output.selected = input.selected;

  return Object.freeze(output);
}

function motionPreference(reducedMotion: boolean, source: SurfaceMotionPreference["source"]): SurfaceMotionPreference {
  return Object.freeze({
    motionAllowed: !reducedMotion,
    reducedMotion,
    source,
  });
}

function normalizeKey(key: string, code: string | undefined): string {
  const token = key.length === 0 && code !== undefined ? code : key;
  const folded = token.trim().toLocaleLowerCase("en-US");

  switch (folded) {
    case "arrowdown":
    case "down":
      return "ArrowDown";
    case "arrowleft":
    case "left":
      return "ArrowLeft";
    case "arrowright":
    case "right":
      return "ArrowRight";
    case "arrowup":
    case "up":
      return "ArrowUp";
    case "del":
    case "delete":
      return "Delete";
    case "enter":
    case "return":
      return "Enter";
    case "f2":
      return "F2";
    case "tab":
      return "Tab";
    default:
      return token;
  }
}

function wallpaperLabel(wallpaper: WallpaperViewModelState | null | undefined): string {
  if (wallpaper === null || wallpaper === undefined) return "Wallpaper";

  if (wallpaper.resolved.kind === "source" && wallpaper.resolved.sourceRef !== null) {
    return `Wallpaper ${wallpaper.resolved.sourceRef}`;
  }

  return `Wallpaper ${wallpaper.resolved.solidColor}`;
}

function titleCase(value: string): string {
  if (value.length === 0) return value;

  return `${value[0]?.toLocaleUpperCase("en-US") ?? ""}${value.slice(1).replaceAll("-", " ")}`;
}

function canonicalSortText(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;

  return 0;
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function containsString(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }

  return false;
}

function pathToken(path: readonly string[]): string {
  if (path.length === 0) return "root";

  return path.map(idToken).join("-");
}

function idToken(value: string): string {
  let output = "";

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (char === undefined) continue;

    const code = char.charCodeAt(0);
    const safe =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 45 ||
      code === 95;

    output += safe ? char : `_${code.toString(16).padStart(4, "0")}`;
  }

  return output.length === 0 ? "empty" : output;
}
