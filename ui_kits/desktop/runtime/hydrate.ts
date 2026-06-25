import type {
  DesktopHost,
  DesktopMaybePromise,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import {
  createBinder,
} from "./binder.ts";
import type {
  VitaActionHandler,
  VitaActionMap,
  VitaBindMap,
  VitaBindValue,
  VitaElement,
} from "./binder.ts";
import {
  store,
} from "./reactive.ts";
import type {
  Store,
  StoreUnsubscribe,
} from "./reactive.ts";
import type {
  ScreenActionHandler,
  ScreenBindResolver,
  ScreenModule,
  ScreenViewModel,
} from "./screen.ts";

export interface ScreenHydrationError {
  readonly code: "SCREEN_HYDRATION_FAILED";
  readonly message: string;
  readonly path: string;
}

export interface HydratedActiveScreen<State> {
  readonly id: string;
  readonly ok: true;
  readonly root: VitaElement;
  snapshot(): State;
  dispose(): void;
}

export interface HydratedInertScreen {
  readonly id: string;
  readonly ok: false;
  readonly root: VitaElement;
  readonly error: ScreenHydrationError;
  snapshot(): undefined;
  dispose(): void;
}

export type HydratedScreen<State = unknown> = HydratedActiveScreen<State> | HydratedInertScreen;

export function hydrateScreen<
  State,
  Ports,
  ViewModel extends ScreenViewModel<State>,
>(
  root: VitaElement,
  module: ScreenModule<State, Ports, ViewModel>,
  host: DesktopHost,
): DesktopMaybePromise<HydratedScreen<State>> {
  const id = safeScreenId(module);

  try {
    const ports = module.selectPorts(host);
    const pendingViewModel = module.createViewModel(ports);

    if (isPromiseLike(pendingViewModel)) {
      return pendingViewModel
        .then((viewModel) => activateScreen(root, module, id, viewModel))
        .catch((error) => inertScreen(root, id, error, "/createViewModel"));
    }

    return activateScreen(root, module, id, pendingViewModel);
  } catch (error) {
    return inertScreen(root, id, error, "/hydrate");
  }
}

export function disposeScreen(screen: Pick<HydratedScreen<unknown>, "dispose"> | null | undefined): void {
  try {
    screen?.dispose();
  } catch {
    return;
  }
}

export function inertScreen(
  root: VitaElement,
  id: string,
  error: unknown,
  path = "/hydrate",
): HydratedInertScreen {
  const hydrationError = Object.freeze({
    code: "SCREEN_HYDRATION_FAILED",
    message: errorMessage(error, "screen hydration failed closed."),
    path,
  }) satisfies ScreenHydrationError;
  let disposed = false;

  return Object.freeze({
    error: hydrationError,
    id,
    ok: false,
    root,
    dispose(): void {
      disposed = true;
    },
    snapshot(): undefined {
      if (disposed) return undefined;

      return undefined;
    },
  });
}

function activateScreen<
  State,
  Ports,
  ViewModel extends ScreenViewModel<State>,
>(
  root: VitaElement,
  module: ScreenModule<State, Ports, ViewModel>,
  id: string,
  viewModel: ViewModel,
): HydratedScreen<State> {
  const initial = snapshotViewModel(viewModel);

  if (!initial.ok) return inertScreen(root, id, initial.error, "/snapshot");

  const state = store(initial.value);
  let disposed = false;
  let unsubscribe: StoreUnsubscribe | null = null;
  let binding = createBinder(root, {
    actions: buildActionMap(module.actions, viewModel, state, () => disposed, () => {
      dispose();
    }),
    binds: buildBindMap(module.binds),
    snapshot: () => state.get(),
  });

  function dispose(): void {
    if (disposed) return;
    disposed = true;

    const currentUnsubscribe = unsubscribe;

    unsubscribe = null;
    if (currentUnsubscribe !== null) currentUnsubscribe();
    binding.dispose();
  }

  unsubscribe = state.subscribe((snapshot) => {
    if (!disposed) binding.render(snapshot);
  });
  binding.render(state.get());

  return Object.freeze({
    id,
    ok: true,
    root,
    dispose,
    snapshot(): State {
      return state.get();
    },
  });
}

function buildBindMap<State>(
  binds: ReadonlyMap<string, ScreenBindResolver<State>> | Readonly<Record<string, ScreenBindResolver<State>>>,
): VitaBindMap<State> {
  const output = new Map<string, (snapshot: State) => VitaBindValue>();
  const entries = bindEntries(binds);

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (entry !== undefined) {
      output.set(entry.key, (snapshot) => entry.resolver(snapshot));
    }
  }

  return output;
}

function buildActionMap<State, ViewModel extends ScreenViewModel<State>>(
  actions: ReadonlyMap<string, ScreenActionHandler<ViewModel, State>> | Readonly<Record<string, ScreenActionHandler<ViewModel, State>>>,
  viewModel: ViewModel,
  state: Store<State>,
  isDisposed: () => boolean,
  dispose: () => void,
): VitaActionMap<State> {
  const output = new Map<string, VitaActionHandler<State>>();
  const entries = actionEntries(actions);

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (entry === undefined) continue;
    output.set(entry.key, (context) => {
      if (isDisposed()) return;

      let result: DesktopMaybePromise<void>;

      try {
        result = entry.handler(viewModel, context);
      } catch {
        return;
      }

      if (isPromiseLike(result)) {
        return result
          .then(() => {
            commitSnapshot(viewModel, state, isDisposed, dispose);
          })
          .catch(() => {});
      }

      commitSnapshot(viewModel, state, isDisposed, dispose);
    });
  }

  return output;
}

function bindEntries<State>(
  binds: ReadonlyMap<string, ScreenBindResolver<State>> | Readonly<Record<string, ScreenBindResolver<State>>>,
): readonly {
  readonly key: string;
  readonly resolver: ScreenBindResolver<State>;
}[] {
  const output: {
    readonly key: string;
    readonly resolver: ScreenBindResolver<State>;
  }[] = [];

  if (isReadonlyBindMap(binds)) {
    for (const [key, resolver] of binds) {
      if (key.length > 0) {
        output.push(Object.freeze({ key, resolver }));
      }
    }

    return Object.freeze(output);
  }

  const keys = Object.keys(binds);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const resolver = key === undefined ? undefined : binds[key];

    if (key !== undefined && key.length > 0 && resolver !== undefined) {
      output.push(Object.freeze({ key, resolver }));
    }
  }

  return Object.freeze(output);
}

function actionEntries<State, ViewModel>(
  actions: ReadonlyMap<string, ScreenActionHandler<ViewModel, State>> | Readonly<Record<string, ScreenActionHandler<ViewModel, State>>>,
): readonly {
  readonly key: string;
  readonly handler: ScreenActionHandler<ViewModel, State>;
}[] {
  const output: {
    readonly key: string;
    readonly handler: ScreenActionHandler<ViewModel, State>;
  }[] = [];

  if (isReadonlyMap(actions)) {
    for (const [key, handler] of actions) {
      if (key.length > 0) {
        output.push(Object.freeze({ handler, key }));
      }
    }

    return Object.freeze(output);
  }

  const keys = Object.keys(actions);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const handler = key === undefined ? undefined : actions[key];

    if (key !== undefined && key.length > 0 && handler !== undefined) {
      output.push(Object.freeze({ handler, key }));
    }
  }

  return Object.freeze(output);
}

function commitSnapshot<State>(
  viewModel: ScreenViewModel<State>,
  state: Store<State>,
  isDisposed: () => boolean,
  dispose: () => void,
): void {
  if (isDisposed()) return;

  const next = snapshotViewModel(viewModel);

  if (!next.ok) {
    dispose();
    return;
  }

  state.set(next.value);
}

function snapshotViewModel<State>(
  viewModel: ScreenViewModel<State>,
): {
  readonly ok: true;
  readonly value: State;
} | {
  readonly ok: false;
  readonly error: unknown;
} {
  try {
    return Object.freeze({
      ok: true,
      value: viewModel.snapshot(),
    });
  } catch (error) {
    return Object.freeze({
      error,
      ok: false,
    });
  }
}

function safeScreenId(module: Pick<ScreenModule<unknown>, "id">): string {
  try {
    return module.id.length > 0 ? module.id : "unknown";
  } catch {
    return "unknown";
  }
}

function isReadonlyBindMap<State>(
  source: ReadonlyMap<string, ScreenBindResolver<State>> | Readonly<Record<string, ScreenBindResolver<State>>>,
): source is ReadonlyMap<string, ScreenBindResolver<State>> {
  try {
    return typeof Reflect.get(source, "entries") === "function" && typeof Reflect.get(source, "get") === "function";
  } catch {
    return false;
  }
}

function isReadonlyMap<State, ViewModel>(
  source: ReadonlyMap<string, ScreenActionHandler<ViewModel, State>> | Readonly<Record<string, ScreenActionHandler<ViewModel, State>>>,
): source is ReadonlyMap<string, ScreenActionHandler<ViewModel, State>> {
  try {
    return typeof Reflect.get(source, "entries") === "function" && typeof Reflect.get(source, "get") === "function";
  } catch {
    return false;
  }
}

function isPromiseLike<T>(value: DesktopMaybePromise<T>): value is Promise<T> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;

  try {
    return typeof Reflect.get(value, "then") === "function";
  } catch {
    return false;
  }
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) return error.message;

  return fallback;
}
