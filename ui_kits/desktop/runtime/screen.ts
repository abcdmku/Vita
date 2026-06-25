import type {
  DesktopHost,
  DesktopMaybePromise,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  VitaActionContext,
  VitaBindValue,
} from "./binder.ts";

export const DESKTOP_SCREEN_IDS = Object.freeze([
  "desktop",
  "desktop/settings",
  "desktop/files",
  "desktop/shell",
  "desktop/activity",
  "desktop/notifications",
  "desktop/lock",
  "desktop/tiling",
] as const);

export type DesktopScreenId = typeof DESKTOP_SCREEN_IDS[number];

export interface ScreenViewModel<State> {
  snapshot(): State;
}

export type ScreenActionHandler<ViewModel, State> = {
  bivarianceHack(viewModel: ViewModel, context: VitaActionContext<State>): DesktopMaybePromise<void>;
}["bivarianceHack"];

export type ScreenActionMap<ViewModel, State> =
  | ReadonlyMap<string, ScreenActionHandler<ViewModel, State>>
  | Readonly<Record<string, ScreenActionHandler<ViewModel, State>>>;

export type ScreenBindResolver<State> = {
  bivarianceHack(snapshot: State): VitaBindValue;
}["bivarianceHack"];

export type ScreenBindMap<State> =
  | ReadonlyMap<string, ScreenBindResolver<State>>
  | Readonly<Record<string, ScreenBindResolver<State>>>;

export interface ScreenModule<
  State = unknown,
  Ports = unknown,
  ViewModel extends ScreenViewModel<State> = ScreenViewModel<State>,
> {
  readonly id: DesktopScreenId | string;
  readonly eventTypes?: readonly string[];
  selectPorts(host: DesktopHost): Ports;
  createViewModel(ports: Ports): DesktopMaybePromise<ViewModel>;
  readonly actions: ScreenActionMap<ViewModel, State>;
  readonly binds: ScreenBindMap<State>;
}
