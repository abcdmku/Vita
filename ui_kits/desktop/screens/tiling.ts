import type {
  DesktopHost,
  DesktopMaybePromise,
  Rect,
  TextureId,
  WindowId,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  VitaActionContext,
  VitaListItem,
} from "../runtime/binder.ts";
import type {
  ScreenModule,
} from "../runtime/screen.ts";
import {
  createTilingViewModel,
} from "../viewmodels/Tiling.ts";
import type {
  TilingPaneState,
  TilingViewModel,
  TilingViewModelState,
  TilingWindowManagerPort,
  TilingWorkspaceStatus,
} from "../viewmodels/Tiling.ts";
import {
  datasetValue,
  optionalHostPort,
  textListItem,
} from "./shared.ts";

export interface TilingScreenPorts {
  readonly wm: TilingWindowManagerPort;
}

const NOOP_WM = Object.freeze({
  repositionTexture(_textureId: TextureId, _rect: Rect, _windowId: WindowId): void {},
  setFocus(_windowId: WindowId | null): void {},
  setTextureVisibility(_textureId: TextureId, _visible: boolean, _windowId: WindowId): void {},
}) satisfies TilingWindowManagerPort;

export const tilingScreen = Object.freeze({
  actions: new Map<string, (viewModel: TilingViewModel, context: VitaActionContext<TilingViewModelState>) => DesktopMaybePromise<void>>([
    ["tiling.focusPane", (viewModel, context) => {
      viewModel.focusPane(datasetValue(context.target, Object.freeze(["vitaPaneId"])) ?? "editor");
    }],
    ["tiling.cycleLayout", (viewModel) => {
      viewModel.cycleLayout();
    }],
    ["tiling.splitFocus", (viewModel, context) => {
      viewModel.splitFocus(datasetValue(context.target, Object.freeze(["vitaDirection"])) ?? "next");
    }],
    ["tiling.moveToWorkspace", (viewModel, context) => {
      const workspaceId = datasetValue(context.target, Object.freeze(["vitaWorkspaceId"]));
      const paneId = datasetValue(context.target, Object.freeze(["vitaPaneId"]));

      if (workspaceId !== undefined) {
        const intent: {
          type: "moveToWorkspace";
          workspaceId: string;
          paneId?: string;
        } = {
          type: "moveToWorkspace",
          workspaceId,
        };

        if (paneId !== undefined) intent.paneId = paneId;
        viewModel.moveWindow(Object.freeze(intent));
      }
    }],
  ]),
  binds: new Map<string, (snapshot: TilingViewModelState) => string | boolean | readonly VitaListItem[]>([
    ["tiling.layout", (snapshot) => snapshot.layout],
    ["tiling.activePane", (snapshot) => snapshot.activePaneId ?? ""],
    ["tiling.path", (snapshot) => snapshot.statusBar.path],
    ["tiling.info", (snapshot) => snapshot.statusBar.info],
    ["tiling.workspaceSummary", (snapshot) => snapshot.statusBar.workspaceSummary],
    ["tiling.intentCount", (snapshot) => `${snapshot.statusBar.intentCount}`],
    ["tiling.panes", (snapshot) => snapshot.panes.map(paneItem)],
    ["tiling.workspaces", (snapshot) => snapshot.statusBar.workspaces.map(workspaceItem)],
  ]),
  createViewModel(ports: TilingScreenPorts): TilingViewModel {
    return createTilingViewModel({
      wm: ports.wm,
    });
  },
  id: "desktop/tiling",
  selectPorts(host: DesktopHost): TilingScreenPorts {
    return Object.freeze({
      wm: optionalHostPort(host, "windowManager", isTilingWindowManagerPort) ??
        optionalHostPort(host, "wm", isTilingWindowManagerPort) ??
        NOOP_WM,
    });
  },
}) satisfies ScreenModule<TilingViewModelState, TilingScreenPorts, TilingViewModel>;

export default tilingScreen;

function isTilingWindowManagerPort(value: unknown): value is TilingWindowManagerPort {
  return value !== null &&
    typeof value === "object" &&
    typeof ownData(value, "repositionTexture") === "function" &&
    typeof ownData(value, "setFocus") === "function";
}

function paneItem(pane: TilingPaneState): VitaListItem {
  return textListItem({
    action: "tiling.focusPane",
    classes: Object.freeze([
      Object.freeze({
        className: "on",
        enabled: pane.focused,
      }),
      Object.freeze({
        className: "is-hidden",
        enabled: !pane.visible,
      }),
    ]),
    data: Object.freeze([
      Object.freeze({
        name: "data-vita-pane-id",
        value: pane.id,
      }),
    ]),
    key: `pane:${pane.id}`,
    text: `${pane.title}  ${pane.path}`,
  });
}

function workspaceItem(workspace: TilingWorkspaceStatus): VitaListItem {
  return textListItem({
    action: "tiling.moveToWorkspace",
    classes: Object.freeze([
      Object.freeze({
        className: "on",
        enabled: workspace.active,
      }),
    ]),
    data: Object.freeze([
      Object.freeze({
        name: "data-vita-workspace-id",
        value: workspace.id,
      }),
    ]),
    key: `workspace:${workspace.id}`,
    text: workspace.label,
  });
}

function ownData(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      return undefined;
    }

    return descriptor.value;
  } catch {
    return undefined;
  }
}
