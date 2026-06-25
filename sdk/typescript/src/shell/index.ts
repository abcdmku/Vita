import { types as nodeTypes } from "node:util";

import { safeNormalize } from "../safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "../safe-normalize.ts";

export const KNOWN_GOOD_FALLBACK_SHELL_ID = "vita.shell.fallback";

export type ShellResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: ShellError;
    };

export interface ShellError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export interface ShellRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ShellPlacementInput {
  readonly zone?: string;
  readonly layer?: string;
  readonly order?: number;
  readonly anchor?: string;
  readonly workspace?: string;
  readonly rect?: ShellRect;
}

export interface ShellPlacement {
  readonly zone: string;
  readonly layer: string;
  readonly order: number;
  readonly anchor?: string;
  readonly workspace?: string;
  readonly rect?: ShellRect;
}

export interface ShellCssRule {
  readonly selector: string;
  readonly declarations: PlainJsonObject;
}

export interface ShellStyleSheet {
  readonly text: string;
  readonly rules: readonly ShellCssRule[];
}

export type ShellCssDefinition =
  | string
  | {
      readonly text?: string;
      readonly rules?: readonly {
        readonly selector: string;
        readonly declarations: Readonly<Record<string, string>>;
      }[];
    };

export interface ShellElement {
  readonly kind: "component";
  readonly component: string;
  readonly key?: string;
  readonly role?: string;
  readonly props: PlainJsonObject;
  readonly placement: ShellPlacementInput;
  readonly className?: string;
  readonly children: readonly ShellElement[];
}

export interface ShellElementOptions {
  readonly key?: string;
  readonly role?: string;
  readonly props?: PlainJsonObject;
  readonly placement?: ShellPlacementInput;
  readonly className?: string;
  readonly children?: readonly ShellElement[];
}

export interface ShellConfigRenderApi {
  readonly component: typeof shellComponent;
  readonly surface: typeof shellSurface;
}

export type ShellConfigRender = (api: ShellConfigRenderApi) => unknown;

export interface ShellConfigDefinition {
  readonly id: string;
  readonly revision?: string;
  readonly css?: ShellCssDefinition;
  readonly render: ShellConfigRender;
}

export interface EvaluatedShellConfig {
  readonly id: string;
  readonly revision: string;
  readonly root: ShellElement;
  readonly css: ShellStyleSheet;
}

export interface ShellComponentRenderContext {
  readonly componentId: string;
  readonly path: string;
  readonly role: string;
  readonly placement: ShellPlacement;
  readonly children: readonly ShellElement[];
  readonly component: typeof shellComponent;
  readonly surface: typeof shellSurface;
}

export type ShellComponentRender<Props extends PlainJsonObject = PlainJsonObject> = (
  props: Props,
  context: ShellComponentRenderContext,
) => unknown;

export interface ShellComponentDefinition<Props extends PlainJsonObject = PlainJsonObject> {
  readonly id: string;
  readonly role: string;
  readonly defaultPlacement: ShellPlacementInput;
  readonly render: ShellComponentRender<Props>;
}

export interface RegisteredShellComponent {
  readonly id: string;
  readonly role: string;
  readonly defaultPlacement: ShellPlacement;
  readonly render: ShellComponentRender;
}

export interface ShellComponentRenderResult {
  readonly surface: PlainJsonObject;
  readonly children: readonly ShellElement[];
  readonly className?: string;
}

export interface ShellWindowManagerPlacementRequest {
  readonly surfaceId: string;
  readonly componentId: string;
  readonly role: string;
  readonly path: string;
  readonly parentSurfaceId?: string;
  readonly requestedPlacement: ShellPlacement;
}

export interface ShellWindowManagerPolicy {
  readonly placeSurface: (request: ShellWindowManagerPlacementRequest) => unknown;
}

export interface ShellSurfaceCreateRequest {
  readonly surfaceId: string;
  readonly componentId: string;
  readonly role: string;
  readonly path: string;
  readonly placement: ShellPlacement;
  readonly payload: PlainJsonObject;
  readonly className?: string;
}

export interface ShellSubstratePort {
  readonly createSurface: (request: ShellSurfaceCreateRequest) => unknown;
  readonly removeSurface: (surfaceId: string) => unknown;
}

export interface ShellCompositionPorts {
  readonly wm?: ShellWindowManagerPolicy;
  readonly substrate?: ShellSubstratePort;
}

export interface ShellResolvedSurface {
  readonly id: string;
  readonly componentId: string;
  readonly role: string;
  readonly path: string;
  readonly placement: ShellPlacement;
  readonly payload: PlainJsonObject;
  readonly substrate: PlainJsonObject;
  readonly children: readonly ShellResolvedSurface[];
  readonly key?: string;
  readonly className?: string;
  readonly parentSurfaceId?: string;
}

export interface ShellComposedLayout {
  readonly configId: string;
  readonly revision: string;
  readonly css: ShellStyleSheet;
  readonly root: ShellResolvedSurface;
  readonly surfaces: readonly ShellResolvedSurface[];
}

export interface ShellLayoutDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export interface ShellManagedSnapshot {
  readonly source: "configured" | "fallback";
  readonly layout: ShellComposedLayout;
  readonly error?: ShellError;
}

export type ShellPreviewResult =
  | {
      readonly ok: true;
      readonly layout: ShellComposedLayout;
      readonly diff: ShellLayoutDiff;
    }
  | {
      readonly ok: false;
      readonly error: ShellError;
      readonly fallbackLayout: ShellComposedLayout;
      readonly diff: ShellLayoutDiff;
    };

export type ShellApplyResult =
  | {
      readonly ok: true;
      readonly outcome: "committed";
      readonly layout: ShellComposedLayout;
      readonly diff: ShellLayoutDiff;
    }
  | {
      readonly ok: false;
      readonly outcome: "fallback" | "failsafe";
      readonly error: ShellError;
      readonly layout: ShellComposedLayout;
      readonly fallbackLayout: ShellComposedLayout;
      readonly status?: "FAILSAFE";
    };

export type ShellRollbackResult =
  | {
      readonly ok: true;
      readonly outcome: "rolledBack" | "fallback";
      readonly layout: ShellComposedLayout;
    }
  | {
      readonly ok: false;
      readonly outcome: "fallback" | "failsafe";
      readonly error: ShellError;
      readonly layout: ShellComposedLayout;
      readonly status?: "FAILSAFE";
    };

interface ObjectSnapshot {
  readonly value: Readonly<Record<string, unknown>>;
}

interface ComposeState {
  readonly registry: ShellComponentRegistry;
  nodes: number;
}

interface ShellLayoutPlan {
  readonly configId: string;
  readonly revision: string;
  readonly css: ShellStyleSheet;
  readonly root: PlannedShellSurface;
}

interface PlannedShellSurface {
  readonly id: string;
  readonly componentId: string;
  readonly role: string;
  readonly path: string;
  readonly placement: ShellPlacement;
  readonly payload: PlainJsonObject;
  readonly children: readonly PlannedShellSurface[];
  readonly key?: string;
  readonly className?: string;
  readonly parentSurfaceId?: string;
}

interface PlacedShellSurface {
  readonly id: string;
  readonly componentId: string;
  readonly role: string;
  readonly path: string;
  readonly placement: ShellPlacement;
  readonly payload: PlainJsonObject;
  readonly children: readonly PlacedShellSurface[];
  readonly key?: string;
  readonly className?: string;
  readonly parentSurfaceId?: string;
}

interface ApplyState {
  readonly ports: ShellCompositionPorts;
  readonly createdSurfaceIds: string[];
  readonly surfaces: ShellResolvedSurface[];
}

const DEFAULT_MAX_SHELL_NODES = 10_000;
const DEFAULT_CONFIG_REVISION = "draft";
const EMPTY_PROPS: PlainJsonObject = Object.freeze({});
const EMPTY_CHILDREN: readonly ShellElement[] = Object.freeze([]);
const EMPTY_RULES: readonly ShellCssRule[] = Object.freeze([]);
const EMPTY_CSS: ShellStyleSheet = Object.freeze({
  rules: EMPTY_RULES,
  text: "",
});
const EMPTY_DIFF: ShellLayoutDiff = Object.freeze({
  added: Object.freeze([]),
  changed: Object.freeze([]),
  removed: Object.freeze([]),
});
const DEFAULT_PLACEMENT: ShellPlacement = Object.freeze({
  layer: "desktop",
  order: 0,
  zone: "center",
});
const COMPONENT_DEFINITION_FIELDS = Object.freeze([
  "id",
  "role",
  "defaultPlacement",
  "render",
]);
const CONFIG_DEFINITION_REQUIRED_FIELDS = Object.freeze(["id", "render"]);
const CONFIG_DEFINITION_OPTIONAL_FIELDS = Object.freeze(["revision", "css"]);
const CONFIG_RENDER_OUTPUT_FIELDS = Object.freeze(["root", "revision", "css"]);
const ELEMENT_REQUIRED_FIELDS = Object.freeze(["component"]);
const ELEMENT_OPTIONAL_FIELDS = Object.freeze([
  "kind",
  "key",
  "role",
  "props",
  "placement",
  "className",
  "children",
]);
const PLACEMENT_FIELDS = Object.freeze([
  "zone",
  "layer",
  "order",
  "anchor",
  "workspace",
  "rect",
]);
const RECT_FIELDS = Object.freeze(["x", "y", "width", "height"]);
const CSS_FIELDS = Object.freeze(["text", "rules"]);
const CSS_RULE_FIELDS = Object.freeze(["selector", "declarations"]);
const RENDER_RESULT_FIELDS = Object.freeze(["surface", "children", "className"]);
const FALLBACK_CSS_TEXT =
  ".vita-fallback-shell{display:flex;align-items:center;justify-content:center;min-height:100%;font-family:system-ui,sans-serif;background:#101418;color:#f6f8fa;}";

export function shellComponent(
  component: string,
  options: ShellElementOptions = {},
): ShellElement {
  const output: {
    kind: "component";
    component: string;
    props: PlainJsonObject;
    placement: ShellPlacementInput;
    children: readonly ShellElement[];
    key?: string;
    role?: string;
    className?: string;
  } = {
    children: options.children === undefined ? EMPTY_CHILDREN : Object.freeze([...options.children]),
    component,
    kind: "component",
    placement: options.placement ?? Object.freeze({}),
    props: options.props ?? EMPTY_PROPS,
  };

  if (options.key !== undefined) output.key = options.key;
  if (options.role !== undefined) output.role = options.role;
  if (options.className !== undefined) output.className = options.className;

  return Object.freeze(output);
}

export function shellSurface(
  surface: PlainJsonObject,
  options: {
    readonly children?: readonly ShellElement[];
    readonly className?: string;
  } = {},
): ShellComponentRenderResult {
  const output: {
    surface: PlainJsonObject;
    children: readonly ShellElement[];
    className?: string;
  } = {
    children: options.children === undefined ? EMPTY_CHILDREN : Object.freeze([...options.children]),
    surface,
  };

  if (options.className !== undefined) output.className = options.className;

  return Object.freeze(output);
}

export function defineShellConfig(definition: ShellConfigDefinition): ShellConfigDefinition {
  return definition;
}

export function defineShellComponent<Props extends PlainJsonObject>(
  definition: ShellComponentDefinition<Props>,
): ShellComponentDefinition<Props> {
  return definition;
}

export class ShellComponentRegistry {
  readonly #components = new Map<string, RegisteredShellComponent>();

  register(definition: unknown): ShellResult<RegisteredShellComponent> {
    const component = normalizeComponentDefinition(definition);

    if (!component.ok) return component;
    if (this.#components.has(component.value.id)) {
      return reject(
        "DUPLICATE_COMPONENT",
        `Shell component '${component.value.id}' is already registered.`,
        "/id",
      );
    }

    this.#components.set(component.value.id, component.value);
    return component;
  }

  resolve(componentId: string): ShellResult<RegisteredShellComponent> {
    const component = this.#components.get(componentId);

    if (component === undefined) {
      return reject(
        "UNKNOWN_COMPONENT",
        `Shell component '${componentId}' is not registered.`,
        "/component",
      );
    }

    return accept(component);
  }

  list(): readonly RegisteredShellComponent[] {
    return Object.freeze([...this.#components.values()].sort((left, right) => compareStrings(left.id, right.id)));
  }
}

export function createShellComponentRegistry(
  definitions: readonly unknown[] = Object.freeze([]),
): ShellResult<ShellComponentRegistry> {
  const registry = new ShellComponentRegistry();

  for (let index = 0; index < definitions.length; index += 1) {
    const definition = definitions[index];

    if (definition === undefined) {
      return reject("INVALID_COMPONENT", `component definition ${index} is missing.`, `/components/${index}`);
    }

    const registered = registry.register(definition);

    if (!registered.ok) return registered;
  }

  return accept(registry);
}

export function evaluateShellConfig(definition: unknown): ShellResult<EvaluatedShellConfig> {
  const normalized = normalizeConfigDefinition(definition);

  if (!normalized.ok) return normalized;

  const first = renderShellConfig(normalized.value);

  if (!first.ok) return first;

  const second = renderShellConfig(normalized.value);

  if (!second.ok) return second;
  if (stableStringify(first.value) !== stableStringify(second.value)) {
    return reject(
      "NON_DETERMINISTIC_SHELL_CONFIG",
      "Shell config render output changed between deterministic preview passes.",
      "/render",
    );
  }

  return first;
}

export function composeShellLayout(
  registry: ShellComponentRegistry,
  definition: unknown,
  ports: ShellCompositionPorts = Object.freeze({}),
): ShellResult<ShellComposedLayout> {
  const plan = planShellLayout(registry, definition);

  if (!plan.ok) return plan;

  return applyShellLayoutPlan(plan.value, ports);
}

export function resolveShellLayout(
  registry: ShellComponentRegistry,
  config: EvaluatedShellConfig,
  ports: ShellCompositionPorts = Object.freeze({}),
): ShellResult<ShellComposedLayout> {
  const plan = planEvaluatedShellLayout(registry, config);

  if (!plan.ok) return plan;

  return applyShellLayoutPlan(plan.value, ports);
}

function planShellLayout(
  registry: ShellComponentRegistry,
  definition: unknown,
): ShellResult<ShellLayoutPlan> {
  const evaluated = evaluateShellConfig(definition);

  if (!evaluated.ok) return evaluated;

  return planEvaluatedShellLayout(registry, evaluated.value);
}

function planEvaluatedShellLayout(
  registry: ShellComponentRegistry,
  config: EvaluatedShellConfig,
): ShellResult<ShellLayoutPlan> {
  const state: ComposeState = {
    nodes: 0,
    registry,
  };
  const plannedRoot = planElement(state, config.root, undefined, "0");

  if (!plannedRoot.ok) return plannedRoot;

  return accept(Object.freeze({
    configId: config.id,
    css: config.css,
    revision: config.revision,
    root: plannedRoot.value,
  }));
}

function virtualShellLayoutFromPlan(plan: ShellLayoutPlan): ShellComposedLayout {
  const surfaces: ShellResolvedSurface[] = [];
  const root = virtualPlannedSurface(plan.root, surfaces);

  return Object.freeze({
    configId: plan.configId,
    css: plan.css,
    revision: plan.revision,
    root,
    surfaces: Object.freeze([...surfaces].sort((left, right) => compareStrings(left.id, right.id))),
  });
}

function applyShellLayoutPlan(
  plan: ShellLayoutPlan,
  ports: ShellCompositionPorts,
): ShellResult<ShellComposedLayout> {
  const placedRoot = placePlannedSurface(ports.wm, plan.root);

  if (!placedRoot.ok) return placedRoot;

  const state: ApplyState = {
    createdSurfaceIds: [],
    ports,
    surfaces: [],
  };
  const root = applyPlacedSurface(state, placedRoot.value);

  if (!root.ok) {
    const rollback = rollbackCreatedSurfaces(ports.substrate, state.createdSurfaceIds);

    if (!rollback.ok) return rollback;
    return root;
  }

  return accept(layoutFromAppliedSurfaces({
    configId: plan.configId,
    css: plan.css,
    revision: plan.revision,
    root: root.value,
    surfaces: state.surfaces,
  }));
}

function applyShellLayoutPlanAtomically(
  plan: ShellLayoutPlan,
  ports: ShellCompositionPorts,
  activeLayout: ShellComposedLayout,
): ShellResult<ShellComposedLayout> {
  const placedRoot = placePlannedSurface(ports.wm, plan.root);

  if (!placedRoot.ok) return placedRoot;

  const state: ApplyState = {
    createdSurfaceIds: [],
    ports,
    surfaces: [],
  };
  const root = applyPlacedSurface(state, placedRoot.value);

  if (!root.ok) {
    const restored = restorePriorLayoutAfterFailedCreate(
      ports.substrate,
      state.createdSurfaceIds,
      activeLayout,
    );

    if (!restored.ok) return restored;
    return root;
  }

  const layout = layoutFromAppliedSurfaces({
    configId: plan.configId,
    css: plan.css,
    revision: plan.revision,
    root: root.value,
    surfaces: state.surfaces,
  });
  const cleanup = removeLayoutSurfaces(ports.substrate, activeLayout, surfaceIdSet(layout));

  if (!cleanup.ok) {
    const restored = restorePriorLayoutAfterFailedCommit(ports.substrate, layout, activeLayout);

    if (!restored.ok) return restored;
    return cleanup;
  }

  return accept(layout);
}

export function diffShellLayouts(
  current: ShellComposedLayout,
  desired: ShellComposedLayout,
): ShellLayoutDiff {
  const currentById = indexSurfaces(current);
  const desiredById = indexSurfaces(desired);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const currentIds = [...currentById.keys()].sort(compareStrings);
  const desiredIds = [...desiredById.keys()].sort(compareStrings);

  for (let index = 0; index < currentIds.length; index += 1) {
    const id = currentIds[index];

    if (id === undefined) continue;
    if (!desiredById.has(id)) {
      removed.push(id);
      continue;
    }
    if (currentById.get(id) !== desiredById.get(id)) {
      changed.push(id);
    }
  }

  for (let index = 0; index < desiredIds.length; index += 1) {
    const id = desiredIds[index];

    if (id !== undefined && !currentById.has(id)) {
      added.push(id);
    }
  }

  return Object.freeze({
    added: Object.freeze(added),
    changed: Object.freeze(changed),
    removed: Object.freeze(removed),
  });
}

export function createKnownGoodFallbackRegistry(): ShellComponentRegistry {
  const registry = new ShellComponentRegistry();
  const result = registry.register(defineShellComponent({
    defaultPlacement: {
      layer: "overlay",
      order: 0,
      zone: "center",
    },
    id: KNOWN_GOOD_FALLBACK_SHELL_ID,
    render: () => shellSurface({
      message: "Shell edit failed closed to the known-good fallback.",
      safeMode: true,
      title: "Vita Fallback Shell",
    }),
    role: "fallback",
  }));

  if (!result.ok) {
    throw new Error("built-in fallback shell registration failed");
  }

  return registry;
}

export function knownGoodFallbackShellConfig(): ShellConfigDefinition {
  return defineShellConfig({
    css: FALLBACK_CSS_TEXT,
    id: KNOWN_GOOD_FALLBACK_SHELL_ID,
    render: ({ component }) => component(KNOWN_GOOD_FALLBACK_SHELL_ID, {
      className: "vita-fallback-shell",
      key: "fallback",
      placement: {
        layer: "overlay",
        order: 0,
        zone: "center",
      },
    }),
    revision: "known-good",
  });
}

export function composeKnownGoodFallbackShell(
  ports: ShellCompositionPorts = Object.freeze({}),
): ShellComposedLayout {
  const composed = composeShellLayout(
    createKnownGoodFallbackRegistry(),
    knownGoodFallbackShellConfig(),
    ports,
  );

  if (composed.ok) {
    return composed.value;
  }

  return hardcodedFallbackLayout();
}

export class ManagedShellConfigController {
  readonly #registry: ShellComponentRegistry;
  readonly #ports: ShellCompositionPorts;
  #active: ShellManagedSnapshot;
  #previous: ShellManagedSnapshot | null = null;

  constructor(registry: ShellComponentRegistry, ports: ShellCompositionPorts = Object.freeze({})) {
    this.#registry = registry;
    this.#ports = ports;
    this.#active = Object.freeze({
      layout: composeKnownGoodFallbackShell(this.#ports),
      source: "fallback",
    });
  }

  current(): ShellManagedSnapshot {
    return this.#active;
  }

  preview(definition: unknown): ShellPreviewResult {
    const planned = planShellLayout(this.#registry, definition);

    if (!planned.ok) {
      return Object.freeze({
        diff: EMPTY_DIFF,
        error: planned.error,
        fallbackLayout: composeKnownGoodFallbackShell(),
        ok: false,
      });
    }

    const layout = virtualShellLayoutFromPlan(planned.value);

    return Object.freeze({
      diff: diffShellLayouts(this.#active.layout, layout),
      layout,
      ok: true,
    });
  }

  apply(definition: unknown): ShellApplyResult {
    const activeBefore = this.#active;
    const planned = planShellLayout(this.#registry, definition);

    if (!planned.ok) {
      this.#active = Object.freeze({
        error: planned.error,
        layout: activeBefore.layout,
        source: activeBefore.source,
      });

      return Object.freeze({
        error: planned.error,
        fallbackLayout: composeKnownGoodFallbackShell(),
        layout: activeBefore.layout,
        ok: false,
        outcome: "fallback",
      });
    }

    const composed = applyShellLayoutPlanAtomically(planned.value, this.#ports, activeBefore.layout);

    if (!composed.ok) {
      const failsafe = isFailsafeError(composed.error);

      this.#active = Object.freeze({
        error: composed.error,
        layout: activeBefore.layout,
        source: activeBefore.source,
      });

      return Object.freeze({
        error: composed.error,
        fallbackLayout: composeKnownGoodFallbackShell(),
        layout: activeBefore.layout,
        ok: false,
        outcome: failsafe ? "failsafe" : "fallback",
        ...(failsafe ? { status: "FAILSAFE" as const } : {}),
      });
    }

    const diff = diffShellLayouts(activeBefore.layout, composed.value);
    this.#previous = activeBefore;
    this.#active = Object.freeze({
      layout: composed.value,
      source: "configured",
    });

    return Object.freeze({
      diff,
      layout: composed.value,
      ok: true,
      outcome: "committed",
    });
  }

  rollback(): ShellRollbackResult {
    if (this.#previous !== null) {
      const current = this.#active;
      const next = this.#previous;

      const recreated = realizeExistingShellLayoutAtomically(next.layout, this.#ports, current.layout);

      if (!recreated.ok) {
        this.#previous = next;
        this.#active = Object.freeze({
          error: recreated.error,
          layout: current.layout,
          source: current.source,
        });

        return Object.freeze({
          error: recreated.error,
          layout: current.layout,
          ok: false,
          outcome: "failsafe",
          status: "FAILSAFE",
        });
      }

      this.#previous = current;
      this.#active = snapshotWithLayout(next, recreated.value);

      return Object.freeze({
        layout: this.#active.layout,
        ok: true,
        outcome: "rolledBack",
      });
    }

    return Object.freeze({
      layout: this.#active.layout,
      ok: true,
      outcome: "fallback",
    });
  }
}

function snapshotWithLayout(snapshot: ShellManagedSnapshot, layout: ShellComposedLayout): ShellManagedSnapshot {
  const output: {
    source: "configured" | "fallback";
    layout: ShellComposedLayout;
    error?: ShellError;
  } = {
    layout,
    source: snapshot.source,
  };

  if (snapshot.error !== undefined) output.error = snapshot.error;

  return Object.freeze(output);
}

function surfaceIdSet(layout: ShellComposedLayout): ReadonlySet<string> {
  const ids = new Set<string>();

  for (let index = 0; index < layout.surfaces.length; index += 1) {
    const surface = layout.surfaces[index];

    if (surface !== undefined) ids.add(surface.id);
  }

  return ids;
}

function layoutFromAppliedSurfaces(input: {
  readonly configId: string;
  readonly revision: string;
  readonly css: ShellStyleSheet;
  readonly root: ShellResolvedSurface;
  readonly surfaces: readonly ShellResolvedSurface[];
}): ShellComposedLayout {
  return Object.freeze({
    configId: input.configId,
    css: input.css,
    revision: input.revision,
    root: input.root,
    surfaces: Object.freeze([...input.surfaces].sort((left, right) => compareStrings(left.id, right.id))),
  });
}

function removeLayoutSurfaces(
  substrate: ShellSubstratePort | undefined,
  layout: ShellComposedLayout,
  retainedSurfaceIds: ReadonlySet<string> = new Set<string>(),
): ShellResult<true> {
  if (substrate === undefined) return accept(true);

  const removableSurfaceIds: string[] = [];
  collectSurfaceIdsPostOrder(layout.root, removableSurfaceIds, new Set<string>());

  for (let index = 0; index < removableSurfaceIds.length; index += 1) {
    const surfaceId = removableSurfaceIds[index];

    if (surfaceId === undefined || retainedSurfaceIds.has(surfaceId)) continue;

    const removed = removeSubstrateSurface(substrate, surfaceId, `/surfaces/${pathToken(surfaceId)}`);

    if (!removed.ok) return removed;
  }

  return accept(true);
}

function collectSurfaceIdsPostOrder(
  surface: ShellResolvedSurface,
  output: string[],
  seen: Set<string>,
): void {
  for (let index = 0; index < surface.children.length; index += 1) {
    const child = surface.children[index];

    if (child !== undefined) collectSurfaceIdsPostOrder(child, output, seen);
  }

  if (!seen.has(surface.id)) {
    seen.add(surface.id);
    output.push(surface.id);
  }
}

function realizeExistingShellLayoutAtomically(
  layout: ShellComposedLayout,
  ports: ShellCompositionPorts,
  activeLayout: ShellComposedLayout,
): ShellResult<ShellComposedLayout> {
  const state: ApplyState = {
    createdSurfaceIds: [],
    ports,
    surfaces: [],
  };
  const root = realizeResolvedSurface(state, layout.root);

  if (!root.ok) {
    const restored = restorePriorLayoutAfterFailedCreate(
      ports.substrate,
      state.createdSurfaceIds,
      activeLayout,
    );

    if (!restored.ok) return restored;
    return root;
  }

  const realized = layoutFromAppliedSurfaces({
    configId: layout.configId,
    css: layout.css,
    revision: layout.revision,
    root: root.value,
    surfaces: state.surfaces,
  });
  const cleanup = removeLayoutSurfaces(ports.substrate, activeLayout, surfaceIdSet(realized));

  if (!cleanup.ok) {
    const restored = restorePriorLayoutAfterFailedCommit(ports.substrate, realized, activeLayout);

    if (!restored.ok) return restored;
    return cleanup;
  }

  return accept(realized);
}

function realizeResolvedSurface(
  state: ApplyState,
  existing: ShellResolvedSurface,
): ShellResult<ShellResolvedSurface> {
  const createRequestInput: {
    surfaceId: string;
    componentId: string;
    role: string;
    path: string;
    placement: ShellPlacement;
    payload: PlainJsonObject;
    className?: string;
  } = {
    componentId: existing.componentId,
    path: existing.path,
    payload: existing.payload,
    placement: existing.placement,
    role: existing.role,
    surfaceId: existing.id,
  };

  if (existing.className !== undefined) createRequestInput.className = existing.className;

  const substrate = createSubstrateSurface(
    state.ports.substrate,
    buildSurfaceCreateRequest(createRequestInput),
    `/${existing.path}/surface`,
    state.createdSurfaceIds,
  );

  if (!substrate.ok) return substrate;

  const children: ShellResolvedSurface[] = [];

  for (let index = 0; index < existing.children.length; index += 1) {
    const child = existing.children[index];

    if (child === undefined) {
      return reject("INVALID_SHELL_ELEMENT", `child ${index} is missing.`, `/${existing.path}/children/${index}`);
    }

    const realizedChild = realizeResolvedSurface(state, child);

    if (!realizedChild.ok) return realizedChild;
    children.push(realizedChild.value);
  }

  const surfaceInput: {
    children: readonly ShellResolvedSurface[];
    className?: string;
    componentId: string;
    id: string;
    key?: string;
    parentSurfaceId?: string;
    path: string;
    payload: PlainJsonObject;
    placement: ShellPlacement;
    role: string;
    substrate: PlainJsonObject;
  } = {
    children: Object.freeze(children),
    componentId: existing.componentId,
    id: existing.id,
    path: existing.path,
    payload: existing.payload,
    placement: existing.placement,
    role: existing.role,
    substrate: substrate.value,
  };

  if (existing.className !== undefined) surfaceInput.className = existing.className;
  if (existing.key !== undefined) surfaceInput.key = existing.key;
  if (existing.parentSurfaceId !== undefined) surfaceInput.parentSurfaceId = existing.parentSurfaceId;

  const surface = freezeSurface(surfaceInput);

  state.surfaces.push(surface);
  return accept(surface);
}

function normalizeComponentDefinition(definition: unknown): ShellResult<RegisteredShellComponent> {
  const snapshot = snapshotDataObject(definition, "");

  if (!snapshot.ok) return snapshot;

  const fields = expectFields(snapshot.value.value, COMPONENT_DEFINITION_FIELDS);

  if (!fields.ok) return fields;

  const id = field(snapshot.value.value, "id");
  const role = field(snapshot.value.value, "role");
  const placement = field(snapshot.value.value, "defaultPlacement");
  const render = field(snapshot.value.value, "render");

  if (!isNonEmptyString(id)) {
    return reject("INVALID_COMPONENT", "component id must be a non-empty string.", "/id");
  }
  if (!isNonEmptyString(role)) {
    return reject("INVALID_COMPONENT", "component role must be a non-empty string.", "/role");
  }
  if (typeof render !== "function") {
    return reject("INVALID_COMPONENT", "component render must be a function.", "/render");
  }

  const defaultPlacement = normalizePlacement(placement, "/defaultPlacement", DEFAULT_PLACEMENT);

  if (!defaultPlacement.ok) return defaultPlacement;

  return accept(Object.freeze({
    defaultPlacement: defaultPlacement.value,
    id,
    render: render as ShellComponentRender,
    role,
  }));
}

interface NormalizedConfigDefinition {
  readonly id: string;
  readonly revision: string;
  readonly css: ShellStyleSheet;
  readonly render: ShellConfigRender;
}

function normalizeConfigDefinition(definition: unknown): ShellResult<NormalizedConfigDefinition> {
  const snapshot = snapshotDataObject(definition, "");

  if (!snapshot.ok) return snapshot;

  const fields = expectFields(
    snapshot.value.value,
    CONFIG_DEFINITION_REQUIRED_FIELDS,
    CONFIG_DEFINITION_OPTIONAL_FIELDS,
  );

  if (!fields.ok) return fields;

  const id = field(snapshot.value.value, "id");
  const revision = field(snapshot.value.value, "revision");
  const css = field(snapshot.value.value, "css");
  const render = field(snapshot.value.value, "render");

  if (!isNonEmptyString(id)) {
    return reject("INVALID_SHELL_CONFIG", "shell config id must be a non-empty string.", "/id");
  }
  if (revision !== undefined && !isNonEmptyString(revision)) {
    return reject("INVALID_SHELL_CONFIG", "shell config revision must be a non-empty string.", "/revision");
  }
  if (typeof render !== "function") {
    return reject("INVALID_SHELL_CONFIG", "shell config render must be a function.", "/render");
  }

  const style = normalizeCssDefinition(css, "/css");

  if (!style.ok) return style;

  return accept(Object.freeze({
    css: style.value,
    id,
    render: render as ShellConfigRender,
    revision: revision ?? DEFAULT_CONFIG_REVISION,
  }));
}

function renderShellConfig(definition: NormalizedConfigDefinition): ShellResult<EvaluatedShellConfig> {
  let raw: unknown;

  try {
    raw = definition.render(Object.freeze({
      component: shellComponent,
      surface: shellSurface,
    }));
  } catch {
    return reject(
      "SHELL_CONFIG_RENDER_FAILED",
      "Shell config render threw during preview.",
      "/render",
    );
  }

  const normalized = normalizeConfigRenderOutput(raw, definition);

  if (!normalized.ok) return normalized;

  return normalized;
}

function normalizeConfigRenderOutput(
  output: unknown,
  definition: NormalizedConfigDefinition,
): ShellResult<EvaluatedShellConfig> {
  const normalized = normalizeUnknownJson(output, "/render");

  if (!normalized.ok) return normalized;
  if (!isPlainObject(normalized.value)) {
    return reject("INVALID_SHELL_CONFIG", "shell config render must return an object.", "/render");
  }

  const rootValue = Object.hasOwn(normalized.value, "root")
    ? field(normalized.value, "root")
    : normalized.value;
  const root = normalizeElement(rootValue, "/root", 0);

  if (!root.ok) return root;

  if (Object.hasOwn(normalized.value, "root")) {
    const fields = expectPlainFields(normalized.value, ["root"], CONFIG_RENDER_OUTPUT_FIELDS, "/render");

    if (!fields.ok) return fields;
  }

  const revisionValue = field(normalized.value, "revision");
  const cssValue = field(normalized.value, "css");

  if (revisionValue !== undefined && !isNonEmptyString(revisionValue)) {
    return reject("INVALID_SHELL_CONFIG", "rendered revision must be a non-empty string.", "/render/revision");
  }

  const css = normalizeCssPlain(cssValue, "/render/css");

  if (!css.ok) return css;

  return accept(Object.freeze({
    css: mergeCss(definition.css, css.value),
    id: definition.id,
    revision: revisionValue ?? definition.revision,
    root: root.value,
  }));
}

function planElement(
  state: ComposeState,
  element: ShellElement,
  parentSurfaceId: string | undefined,
  path: string,
): ShellResult<PlannedShellSurface> {
  if (state.nodes >= DEFAULT_MAX_SHELL_NODES) {
    return reject("SHELL_TOO_LARGE", "shell layout node budget exceeded.", `/${path}`);
  }
  state.nodes += 1;

  const component = state.registry.resolve(element.component);

  if (!component.ok) return component;

  const role = element.role ?? component.value.role;
  const requestedPlacement = normalizePlacement(element.placement, `/${path}/placement`, component.value.defaultPlacement);

  if (!requestedPlacement.ok) return requestedPlacement;

  const surfaceId = surfaceIdFor(element.component, path);
  const rendered = renderComponent(component.value, element, role, path, requestedPlacement.value);

  if (!rendered.ok) return rendered;

  const className = combineClassNames(element.className, rendered.value.className);
  const childElements = [...element.children, ...rendered.value.children];
  const children: PlannedShellSurface[] = [];

  for (let index = 0; index < childElements.length; index += 1) {
    const child = childElements[index];

    if (child === undefined) {
      return reject("INVALID_SHELL_ELEMENT", `child ${index} is missing.`, `/${path}/children/${index}`);
    }

    const childSurface = planElement(
      state,
      child,
      surfaceId,
      `${path}.${index}${child.key === undefined ? "" : `-${pathToken(child.key)}`}`,
    );

    if (!childSurface.ok) return childSurface;
    children.push(childSurface.value);
  }

  const surfaceInput: {
    children: readonly PlannedShellSurface[];
    className?: string;
    componentId: string;
    id: string;
    key?: string;
    parentSurfaceId?: string;
    path: string;
    payload: PlainJsonObject;
    placement: ShellPlacement;
    role: string;
  } = {
    children: Object.freeze(children),
    componentId: element.component,
    id: surfaceId,
    path,
    payload: rendered.value.surface,
    placement: requestedPlacement.value,
    role,
  };

  if (className !== undefined) surfaceInput.className = className;
  if (element.key !== undefined) surfaceInput.key = element.key;
  if (parentSurfaceId !== undefined) surfaceInput.parentSurfaceId = parentSurfaceId;

  return accept(Object.freeze(surfaceInput));
}

function virtualPlannedSurface(
  planned: PlannedShellSurface,
  surfaces: ShellResolvedSurface[],
): ShellResolvedSurface {
  const children: ShellResolvedSurface[] = [];

  for (let index = 0; index < planned.children.length; index += 1) {
    const child = planned.children[index];

    if (child !== undefined) {
      children.push(virtualPlannedSurface(child, surfaces));
    }
  }

  const surfaceInput: {
    children: readonly ShellResolvedSurface[];
    className?: string;
    componentId: string;
    id: string;
    key?: string;
    parentSurfaceId?: string;
    path: string;
    payload: PlainJsonObject;
    placement: ShellPlacement;
    role: string;
    substrate: PlainJsonObject;
  } = {
    children: Object.freeze(children),
    componentId: planned.componentId,
    id: planned.id,
    path: planned.path,
    payload: planned.payload,
    placement: planned.placement,
    role: planned.role,
    substrate: Object.freeze({
      kind: "virtual",
      surfaceId: planned.id,
    }),
  };

  if (planned.className !== undefined) surfaceInput.className = planned.className;
  if (planned.key !== undefined) surfaceInput.key = planned.key;
  if (planned.parentSurfaceId !== undefined) surfaceInput.parentSurfaceId = planned.parentSurfaceId;

  const surface = freezeSurface(surfaceInput);

  surfaces.push(surface);
  return surface;
}

function placePlannedSurface(
  wm: ShellWindowManagerPolicy | undefined,
  planned: PlannedShellSurface,
): ShellResult<PlacedShellSurface> {
  const placementRequest: {
    componentId: string;
    path: string;
    requestedPlacement: ShellPlacement;
    role: string;
    surfaceId: string;
    parentSurfaceId?: string;
  } = {
    componentId: planned.componentId,
    path: planned.path,
    requestedPlacement: planned.placement,
    role: planned.role,
    surfaceId: planned.id,
  };

  if (planned.parentSurfaceId !== undefined) placementRequest.parentSurfaceId = planned.parentSurfaceId;

  const placement = placeSurface(wm, placementRequest);

  if (!placement.ok) return placement;

  const children: PlacedShellSurface[] = [];

  for (let index = 0; index < planned.children.length; index += 1) {
    const child = planned.children[index];

    if (child === undefined) {
      return reject("INVALID_SHELL_ELEMENT", `child ${index} is missing.`, `/${planned.path}/children/${index}`);
    }

    const childSurface = placePlannedSurface(wm, child);

    if (!childSurface.ok) return childSurface;
    children.push(childSurface.value);
  }

  const surfaceInput: {
    children: readonly PlacedShellSurface[];
    className?: string;
    componentId: string;
    id: string;
    key?: string;
    parentSurfaceId?: string;
    path: string;
    payload: PlainJsonObject;
    placement: ShellPlacement;
    role: string;
  } = {
    children: Object.freeze(children),
    componentId: planned.componentId,
    id: planned.id,
    path: planned.path,
    payload: planned.payload,
    placement: placement.value,
    role: planned.role,
  };

  if (planned.className !== undefined) surfaceInput.className = planned.className;
  if (planned.key !== undefined) surfaceInput.key = planned.key;
  if (planned.parentSurfaceId !== undefined) surfaceInput.parentSurfaceId = planned.parentSurfaceId;

  return accept(Object.freeze(surfaceInput));
}

function applyPlacedSurface(
  state: ApplyState,
  placed: PlacedShellSurface,
): ShellResult<ShellResolvedSurface> {
  const createRequestInput: {
    surfaceId: string;
    componentId: string;
    role: string;
    path: string;
    placement: ShellPlacement;
    payload: PlainJsonObject;
    className?: string;
  } = {
    componentId: placed.componentId,
    path: placed.path,
    payload: placed.payload,
    placement: placed.placement,
    role: placed.role,
    surfaceId: placed.id,
  };

  if (placed.className !== undefined) createRequestInput.className = placed.className;

  const createRequest = buildSurfaceCreateRequest(createRequestInput);
  const substrate = createSubstrateSurface(
    state.ports.substrate,
    createRequest,
    `/${placed.path}/surface`,
    state.createdSurfaceIds,
  );

  if (!substrate.ok) return substrate;

  const children: ShellResolvedSurface[] = [];

  for (let index = 0; index < placed.children.length; index += 1) {
    const child = placed.children[index];

    if (child === undefined) {
      return reject("INVALID_SHELL_ELEMENT", `child ${index} is missing.`, `/${placed.path}/children/${index}`);
    }

    const childSurface = applyPlacedSurface(state, child);

    if (!childSurface.ok) return childSurface;
    children.push(childSurface.value);
  }

  const surfaceInput: {
    children: readonly ShellResolvedSurface[];
    className?: string;
    componentId: string;
    id: string;
    key?: string;
    parentSurfaceId?: string;
    path: string;
    payload: PlainJsonObject;
    placement: ShellPlacement;
    role: string;
    substrate: PlainJsonObject;
  } = {
    children: Object.freeze(children),
    componentId: placed.componentId,
    id: placed.id,
    path: placed.path,
    payload: placed.payload,
    placement: placed.placement,
    role: placed.role,
    substrate: substrate.value,
  };

  if (placed.className !== undefined) surfaceInput.className = placed.className;
  if (placed.key !== undefined) surfaceInput.key = placed.key;
  if (placed.parentSurfaceId !== undefined) surfaceInput.parentSurfaceId = placed.parentSurfaceId;

  const surface = freezeSurface(surfaceInput);

  state.surfaces.push(surface);
  return accept(surface);
}

function renderComponent(
  component: RegisteredShellComponent,
  element: ShellElement,
  role: string,
  path: string,
  placement: ShellPlacement,
): ShellResult<ShellComponentRenderResult> {
  const context: ShellComponentRenderContext = Object.freeze({
    children: element.children,
    component: shellComponent,
    componentId: component.id,
    path,
    placement,
    role,
    surface: shellSurface,
  });
  const first = callComponentRender(component, element.props, context, path);

  if (!first.ok) return first;

  const second = callComponentRender(component, element.props, context, path);

  if (!second.ok) return second;
  if (stableStringify(first.value) !== stableStringify(second.value)) {
    return reject(
      "NON_DETERMINISTIC_COMPONENT",
      `Shell component '${component.id}' render output changed between deterministic passes.`,
      `/${path}`,
    );
  }

  return first;
}

function callComponentRender(
  component: RegisteredShellComponent,
  props: PlainJsonObject,
  context: ShellComponentRenderContext,
  path: string,
): ShellResult<ShellComponentRenderResult> {
  let raw: unknown;

  try {
    raw = component.render(props, context);
  } catch {
    return reject(
      "SHELL_COMPONENT_RENDER_FAILED",
      `Shell component '${component.id}' render threw.`,
      `/${path}`,
    );
  }

  return normalizeComponentRenderResult(raw, `/${path}/render`);
}

function normalizeComponentRenderResult(
  value: unknown,
  path: string,
): ShellResult<ShellComponentRenderResult> {
  if (value === undefined || value === null) {
    return accept(Object.freeze({
      children: EMPTY_CHILDREN,
      surface: EMPTY_PROPS,
    }));
  }

  const normalized = normalizeUnknownJson(value, path);

  if (!normalized.ok) return normalized;
  if (!isPlainObject(normalized.value)) {
    return reject("INVALID_COMPONENT_RENDER", "component render must return an object.", path);
  }

  const fields = expectPlainFields(normalized.value, [], RENDER_RESULT_FIELDS, path);

  if (!fields.ok) return fields;

  const surfaceValue = field(normalized.value, "surface");
  const childrenValue = field(normalized.value, "children");
  const classNameValue = field(normalized.value, "className");
  const surface = normalizeSurfacePayload(surfaceValue, `${path}/surface`);

  if (!surface.ok) return surface;

  const children = normalizeElementArray(childrenValue, `${path}/children`, 0);

  if (!children.ok) return children;
  if (classNameValue !== undefined && typeof classNameValue !== "string") {
    return reject("INVALID_COMPONENT_RENDER", "render className must be a string.", `${path}/className`);
  }

  const output: {
    surface: PlainJsonObject;
    children: readonly ShellElement[];
    className?: string;
  } = {
    children: children.value,
    surface: surface.value,
  };

  if (classNameValue !== undefined) output.className = classNameValue;

  return accept(Object.freeze(output));
}

function normalizeElementArray(
  value: PlainJson | undefined,
  path: string,
  depth: number,
): ShellResult<readonly ShellElement[]> {
  if (value === undefined) return accept(EMPTY_CHILDREN);
  if (!Array.isArray(value)) {
    return reject("INVALID_SHELL_ELEMENT", "children must be an array.", path);
  }

  const children: ShellElement[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const child = value[index];

    if (child === undefined) {
      return reject("INVALID_SHELL_ELEMENT", `child ${index} is missing.`, `${path}/${index}`);
    }

    const normalized = normalizeElement(child, `${path}/${index}`, depth + 1);

    if (!normalized.ok) return normalized;
    children.push(normalized.value);
  }

  return accept(Object.freeze(children));
}

function normalizeElement(value: PlainJson | undefined, path: string, depth: number): ShellResult<ShellElement> {
  if (depth > 100) {
    return reject("SHELL_TOO_DEEP", "shell layout depth budget exceeded.", path);
  }
  if (!isPlainObject(value)) {
    return reject("INVALID_SHELL_ELEMENT", "shell element must be an object.", path);
  }

  const fields = expectPlainFields(value, ELEMENT_REQUIRED_FIELDS, ELEMENT_OPTIONAL_FIELDS, path);

  if (!fields.ok) return fields;

  const kind = field(value, "kind");
  const component = field(value, "component");
  const key = field(value, "key");
  const role = field(value, "role");
  const props = field(value, "props");
  const placement = field(value, "placement");
  const className = field(value, "className");

  if (kind !== undefined && kind !== "component") {
    return reject("INVALID_SHELL_ELEMENT", "shell element kind must be 'component'.", `${path}/kind`);
  }
  if (!isNonEmptyString(component)) {
    return reject("INVALID_SHELL_ELEMENT", "shell element component must be a non-empty string.", `${path}/component`);
  }
  if (key !== undefined && typeof key !== "string") {
    return reject("INVALID_SHELL_ELEMENT", "shell element key must be a string.", `${path}/key`);
  }
  if (role !== undefined && !isNonEmptyString(role)) {
    return reject("INVALID_SHELL_ELEMENT", "shell element role must be a non-empty string.", `${path}/role`);
  }
  if (className !== undefined && typeof className !== "string") {
    return reject("INVALID_SHELL_ELEMENT", "shell element className must be a string.", `${path}/className`);
  }

  const normalizedProps = normalizeProps(props, `${path}/props`);

  if (!normalizedProps.ok) return normalizedProps;

  const normalizedPlacement = normalizePlacementInput(placement, `${path}/placement`);

  if (!normalizedPlacement.ok) return normalizedPlacement;

  const children = normalizeElementArray(field(value, "children"), `${path}/children`, depth);

  if (!children.ok) return children;

  const output: {
    kind: "component";
    component: string;
    props: PlainJsonObject;
    placement: ShellPlacementInput;
    children: readonly ShellElement[];
    key?: string;
    role?: string;
    className?: string;
  } = {
    children: children.value,
    component,
    kind: "component",
    placement: normalizedPlacement.value,
    props: normalizedProps.value,
  };

  if (key !== undefined) output.key = key;
  if (role !== undefined) output.role = role;
  if (className !== undefined) output.className = className;

  return accept(Object.freeze(output));
}

function normalizeProps(value: PlainJson | undefined, path: string): ShellResult<PlainJsonObject> {
  if (value === undefined) return accept(EMPTY_PROPS);
  if (!isPlainObject(value)) {
    return reject("INVALID_SHELL_ELEMENT", "props must be an object.", path);
  }

  return accept(value);
}

function normalizeSurfacePayload(value: PlainJson | undefined, path: string): ShellResult<PlainJsonObject> {
  if (value === undefined) return accept(EMPTY_PROPS);
  if (!isPlainObject(value)) {
    return reject("INVALID_COMPONENT_RENDER", "surface payload must be an object.", path);
  }

  return accept(value);
}

function normalizePlacementInput(value: PlainJson | undefined, path: string): ShellResult<ShellPlacementInput> {
  if (value === undefined) return accept(Object.freeze({}));
  if (!isPlainObject(value)) {
    return reject("INVALID_PLACEMENT", "placement must be an object.", path);
  }

  const fields = expectPlainFields(value, [], PLACEMENT_FIELDS, path);

  if (!fields.ok) return fields;

  return normalizePlacementRecord(value, path);
}

function normalizePlacement(
  value: unknown,
  path: string,
  defaults: ShellPlacementInput,
): ShellResult<ShellPlacement> {
  let normalizedValue: PlainJsonObject | undefined;

  if (value === undefined) {
    normalizedValue = undefined;
  } else {
    const normalized = normalizeUnknownJson(value, path);

    if (!normalized.ok) return normalized;
    if (!isPlainObject(normalized.value)) {
      return reject("INVALID_PLACEMENT", "placement must be an object.", path);
    }

    normalizedValue = normalized.value;
  }

  const placementInput = normalizedValue === undefined
    ? accept(Object.freeze({}) satisfies ShellPlacementInput)
    : normalizePlacementRecord(normalizedValue, path);

  if (!placementInput.ok) return placementInput;

  const merged = mergePlacement(defaults, placementInput.value);
  const zone = merged.zone ?? DEFAULT_PLACEMENT.zone;
  const layer = merged.layer ?? DEFAULT_PLACEMENT.layer;
  const order = merged.order ?? DEFAULT_PLACEMENT.order;
  const output: {
    zone: string;
    layer: string;
    order: number;
    anchor?: string;
    workspace?: string;
    rect?: ShellRect;
  } = {
    layer,
    order,
    zone,
  };

  if (!isNonEmptyString(zone)) {
    return reject("INVALID_PLACEMENT", "placement zone must be a non-empty string.", `${path}/zone`);
  }
  if (!isNonEmptyString(layer)) {
    return reject("INVALID_PLACEMENT", "placement layer must be a non-empty string.", `${path}/layer`);
  }
  if (!Number.isSafeInteger(order)) {
    return reject("INVALID_PLACEMENT", "placement order must be a safe integer.", `${path}/order`);
  }
  if (merged.anchor !== undefined) output.anchor = merged.anchor;
  if (merged.workspace !== undefined) output.workspace = merged.workspace;
  if (merged.rect !== undefined) output.rect = merged.rect;

  return accept(Object.freeze(output));
}

function normalizePlacementRecord(value: PlainJsonObject, path: string): ShellResult<ShellPlacementInput> {
  const zone = field(value, "zone");
  const layer = field(value, "layer");
  const order = field(value, "order");
  const anchor = field(value, "anchor");
  const workspace = field(value, "workspace");
  const rect = field(value, "rect");
  const output: {
    zone?: string;
    layer?: string;
    order?: number;
    anchor?: string;
    workspace?: string;
    rect?: ShellRect;
  } = {};

  if (zone !== undefined) {
    if (!isNonEmptyString(zone)) {
      return reject("INVALID_PLACEMENT", "placement zone must be a non-empty string.", `${path}/zone`);
    }
    output.zone = zone;
  }
  if (layer !== undefined) {
    if (!isNonEmptyString(layer)) {
      return reject("INVALID_PLACEMENT", "placement layer must be a non-empty string.", `${path}/layer`);
    }
    output.layer = layer;
  }
  if (order !== undefined) {
    if (typeof order !== "number" || !Number.isSafeInteger(order)) {
      return reject("INVALID_PLACEMENT", "placement order must be a safe integer.", `${path}/order`);
    }
    output.order = order;
  }
  if (anchor !== undefined) {
    if (!isNonEmptyString(anchor)) {
      return reject("INVALID_PLACEMENT", "placement anchor must be a non-empty string.", `${path}/anchor`);
    }
    output.anchor = anchor;
  }
  if (workspace !== undefined) {
    if (!isNonEmptyString(workspace)) {
      return reject("INVALID_PLACEMENT", "placement workspace must be a non-empty string.", `${path}/workspace`);
    }
    output.workspace = workspace;
  }
  if (rect !== undefined) {
    const normalizedRect = normalizeRect(rect, `${path}/rect`);

    if (!normalizedRect.ok) return normalizedRect;
    output.rect = normalizedRect.value;
  }

  return accept(Object.freeze(output));
}

function normalizeRect(value: PlainJson, path: string): ShellResult<ShellRect> {
  if (!isPlainObject(value)) {
    return reject("INVALID_PLACEMENT", "placement rect must be an object.", path);
  }

  const fields = expectPlainFields(value, RECT_FIELDS, [], path);

  if (!fields.ok) return fields;

  const x = field(value, "x");
  const y = field(value, "y");
  const width = field(value, "width");
  const height = field(value, "height");

  if (!isFiniteNumber(x)) return reject("INVALID_PLACEMENT", "placement rect x must be finite.", `${path}/x`);
  if (!isFiniteNumber(y)) return reject("INVALID_PLACEMENT", "placement rect y must be finite.", `${path}/y`);
  if (!isFiniteNumber(width) || width <= 0) {
    return reject("INVALID_PLACEMENT", "placement rect width must be positive.", `${path}/width`);
  }
  if (!isFiniteNumber(height) || height <= 0) {
    return reject("INVALID_PLACEMENT", "placement rect height must be positive.", `${path}/height`);
  }

  return accept(Object.freeze({
    height,
    width,
    x,
    y,
  }));
}

function mergePlacement(defaults: ShellPlacementInput, override: ShellPlacementInput): ShellPlacementInput {
  const output: {
    zone?: string;
    layer?: string;
    order?: number;
    anchor?: string;
    workspace?: string;
    rect?: ShellRect;
  } = {};

  if (defaults.zone !== undefined) output.zone = defaults.zone;
  if (defaults.layer !== undefined) output.layer = defaults.layer;
  if (defaults.order !== undefined) output.order = defaults.order;
  if (defaults.anchor !== undefined) output.anchor = defaults.anchor;
  if (defaults.workspace !== undefined) output.workspace = defaults.workspace;
  if (defaults.rect !== undefined) output.rect = defaults.rect;
  if (override.zone !== undefined) output.zone = override.zone;
  if (override.layer !== undefined) output.layer = override.layer;
  if (override.order !== undefined) output.order = override.order;
  if (override.anchor !== undefined) output.anchor = override.anchor;
  if (override.workspace !== undefined) output.workspace = override.workspace;
  if (override.rect !== undefined) output.rect = override.rect;

  return Object.freeze(output);
}

function normalizeCssDefinition(value: unknown, path: string): ShellResult<ShellStyleSheet> {
  if (value === undefined) return accept(EMPTY_CSS);
  if (typeof value === "string") return accept(cssFromText(value));

  const normalized = normalizeUnknownJson(value, path);

  if (!normalized.ok) return normalized;

  return normalizeCssPlain(normalized.value, path);
}

function normalizeCssPlain(value: PlainJson | undefined, path: string): ShellResult<ShellStyleSheet> {
  if (value === undefined) return accept(EMPTY_CSS);
  if (typeof value === "string") return accept(cssFromText(value));
  if (!isPlainObject(value)) {
    return reject("INVALID_CSS", "css must be a string or object.", path);
  }

  const fields = expectPlainFields(value, [], CSS_FIELDS, path);

  if (!fields.ok) return fields;

  const text = field(value, "text");
  const rules = field(value, "rules");

  if (text !== undefined && typeof text !== "string") {
    return reject("INVALID_CSS", "css text must be a string.", `${path}/text`);
  }

  const normalizedRules = normalizeCssRules(rules, `${path}/rules`);

  if (!normalizedRules.ok) return normalizedRules;

  return accept(Object.freeze({
    rules: normalizedRules.value,
    text: joinCssText(text ?? "", cssRulesToText(normalizedRules.value)),
  }));
}

function normalizeCssRules(value: PlainJson | undefined, path: string): ShellResult<readonly ShellCssRule[]> {
  if (value === undefined) return accept(EMPTY_RULES);
  if (!Array.isArray(value)) {
    return reject("INVALID_CSS", "css rules must be an array.", path);
  }

  const rules: ShellCssRule[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const rule = value[index];

    if (!isPlainObject(rule)) {
      return reject("INVALID_CSS", "css rule must be an object.", `${path}/${index}`);
    }

    const fields = expectPlainFields(rule, CSS_RULE_FIELDS, [], `${path}/${index}`);

    if (!fields.ok) return fields;

    const selector = field(rule, "selector");
    const declarations = field(rule, "declarations");

    if (!isNonEmptyString(selector)) {
      return reject("INVALID_CSS", "css selector must be a non-empty string.", `${path}/${index}/selector`);
    }
    if (!isPlainObject(declarations)) {
      return reject("INVALID_CSS", "css declarations must be an object.", `${path}/${index}/declarations`);
    }

    const normalizedDeclarations = normalizeCssDeclarations(declarations, `${path}/${index}/declarations`);

    if (!normalizedDeclarations.ok) return normalizedDeclarations;
    rules.push(Object.freeze({
      declarations: normalizedDeclarations.value,
      selector,
    }));
  }

  return accept(Object.freeze(rules));
}

function normalizeCssDeclarations(value: PlainJsonObject, path: string): ShellResult<PlainJsonObject> {
  const keys = Object.keys(value).sort(compareStrings);
  const output: Record<string, PlainJson> = Object.create(null) as Record<string, PlainJson>;

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined) continue;

    const declaration = value[key];

    if (typeof declaration !== "string") {
      return reject("INVALID_CSS", "css declaration values must be strings.", `${path}/${key}`);
    }

    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: true,
      value: declaration,
      writable: true,
    });
  }

  return accept(Object.freeze(output));
}

function mergeCss(first: ShellStyleSheet, second: ShellStyleSheet): ShellStyleSheet {
  if (first.text.length === 0 && first.rules.length === 0) return second;
  if (second.text.length === 0 && second.rules.length === 0) return first;

  return Object.freeze({
    rules: Object.freeze([...first.rules, ...second.rules]),
    text: joinCssText(first.text, second.text),
  });
}

function cssFromText(text: string): ShellStyleSheet {
  return Object.freeze({
    rules: EMPTY_RULES,
    text,
  });
}

function cssRulesToText(rules: readonly ShellCssRule[]): string {
  const rendered: string[] = [];

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];

    if (rule === undefined) continue;

    const declarations = Object.keys(rule.declarations)
      .sort(compareStrings)
      .map((key) => `${key}:${String(rule.declarations[key])}`)
      .join(";");
    rendered.push(`${rule.selector}{${declarations}}`);
  }

  return rendered.join("\n");
}

function joinCssText(first: string, second: string): string {
  if (first.length === 0) return second;
  if (second.length === 0) return first;

  return `${first}\n${second}`;
}

function placeSurface(
  wm: ShellWindowManagerPolicy | undefined,
  request: ShellWindowManagerPlacementRequest,
): ShellResult<ShellPlacement> {
  if (wm === undefined) return accept(request.requestedPlacement);

  let raw: unknown;

  try {
    raw = wm.placeSurface(request);
  } catch {
    return reject("WM_POLICY_FAILED", "window-manager policy failed during shell placement.", `/${request.path}`);
  }

  return normalizePlacement(raw, `/${request.path}/placement`, request.requestedPlacement);
}

function buildSurfaceCreateRequest(input: {
  readonly surfaceId: string;
  readonly componentId: string;
  readonly role: string;
  readonly path: string;
  readonly placement: ShellPlacement;
  readonly payload: PlainJsonObject;
  readonly className?: string;
}): ShellSurfaceCreateRequest {
  const output: {
    surfaceId: string;
    componentId: string;
    role: string;
    path: string;
    placement: ShellPlacement;
    payload: PlainJsonObject;
    className?: string;
  } = {
    componentId: input.componentId,
    path: input.path,
    payload: input.payload,
    placement: input.placement,
    role: input.role,
    surfaceId: input.surfaceId,
  };

  if (input.className !== undefined) output.className = input.className;

  return Object.freeze(output);
}

function createSubstrateSurface(
  substrate: ShellSubstratePort | undefined,
  request: ShellSurfaceCreateRequest,
  path: string,
  createdSurfaceIds?: string[],
): ShellResult<PlainJsonObject> {
  if (substrate === undefined) {
    return accept(Object.freeze({
      kind: "virtual",
      surfaceId: request.surfaceId,
    }));
  }

  let raw: unknown;

  try {
    if (createdSurfaceIds !== undefined) {
      createdSurfaceIds.push(request.surfaceId);
    }
    raw = substrate.createSurface(request);
  } catch {
    return reject("SUBSTRATE_CREATE_FAILED", "substrate surface creation failed.", path);
  }

  const normalized = normalizeUnknownJson(raw, path);

  if (!normalized.ok) return normalized;
  if (!isPlainObject(normalized.value)) {
    return reject("INVALID_SUBSTRATE_SURFACE", "substrate surface must be an object.", path);
  }

  return accept(normalized.value);
}

function removeSubstrateSurface(
  substrate: ShellSubstratePort | undefined,
  surfaceId: string,
  path: string,
): ShellResult<true> {
  if (substrate === undefined) return accept(true);

  try {
    substrate.removeSurface(surfaceId);
  } catch {
    return reject("SUBSTRATE_REMOVE_FAILED", "substrate surface removal failed.", path);
  }

  return accept(true);
}

function rollbackCreatedSurfaces(
  substrate: ShellSubstratePort | undefined,
  createdSurfaceIds: readonly string[],
): ShellResult<true> {
  if (substrate === undefined) return accept(true);

  const removedSurfaceIds = new Set<string>();

  for (let index = createdSurfaceIds.length - 1; index >= 0; index -= 1) {
    const surfaceId = createdSurfaceIds[index];

    if (surfaceId !== undefined && !removedSurfaceIds.has(surfaceId)) {
      removedSurfaceIds.add(surfaceId);

      const removed = removeSubstrateSurface(substrate, surfaceId, `/surfaces/${pathToken(surfaceId)}`);

      if (!removed.ok) return removed;
    }
  }

  return accept(true);
}

function restorePriorLayoutAfterFailedCreate(
  substrate: ShellSubstratePort | undefined,
  createdSurfaceIds: readonly string[],
  priorLayout: ShellComposedLayout,
): ShellResult<true> {
  if (substrate === undefined) return accept(true);

  const priorSurfacesById = indexSurfaceObjects(priorLayout);
  const attemptedSurfaceIds = new Set<string>();
  const removedNewSurfaceIds = new Set<string>();

  for (let index = createdSurfaceIds.length - 1; index >= 0; index -= 1) {
    const surfaceId = createdSurfaceIds[index];

    if (surfaceId === undefined) continue;
    attemptedSurfaceIds.add(surfaceId);

    if (!priorSurfacesById.has(surfaceId) && !removedNewSurfaceIds.has(surfaceId)) {
      removedNewSurfaceIds.add(surfaceId);

      const removed = removeSubstrateSurface(substrate, surfaceId, `/surfaces/${pathToken(surfaceId)}`);

      if (!removed.ok) return removed;
    }
  }

  return restorePriorSurfaces(substrate, priorLayout, attemptedSurfaceIds);
}

function restorePriorLayoutAfterFailedCommit(
  substrate: ShellSubstratePort | undefined,
  targetLayout: ShellComposedLayout,
  priorLayout: ShellComposedLayout,
): ShellResult<true> {
  if (substrate === undefined) return accept(true);

  const priorSurfaceIds = surfaceIdSet(priorLayout);
  const targetSurfaceIds: string[] = [];
  const removedNewSurfaceIds = new Set<string>();
  collectSurfaceIdsPostOrder(targetLayout.root, targetSurfaceIds, new Set<string>());

  for (let index = 0; index < targetSurfaceIds.length; index += 1) {
    const surfaceId = targetSurfaceIds[index];

    if (surfaceId === undefined || priorSurfaceIds.has(surfaceId) || removedNewSurfaceIds.has(surfaceId)) {
      continue;
    }
    removedNewSurfaceIds.add(surfaceId);

    const removed = removeSubstrateSurface(substrate, surfaceId, `/surfaces/${pathToken(surfaceId)}`);

    if (!removed.ok) return removed;
  }

  return restorePriorSurfaces(substrate, priorLayout);
}

function restorePriorSurfaces(
  substrate: ShellSubstratePort,
  priorLayout: ShellComposedLayout,
  onlySurfaceIds?: ReadonlySet<string>,
): ShellResult<true> {
  const priorSurfaces = collectSurfacesPreOrder(priorLayout.root);

  for (let index = 0; index < priorSurfaces.length; index += 1) {
    const surface = priorSurfaces[index];

    if (surface === undefined || (onlySurfaceIds !== undefined && !onlySurfaceIds.has(surface.id))) {
      continue;
    }

    const restored = createSubstrateSurface(
      substrate,
      createRequestFromResolvedSurface(surface),
      `/${surface.path}/surface`,
    );

    if (!restored.ok) {
      return reject("SUBSTRATE_RESTORE_FAILED", "substrate surface restore failed.", restored.error.path);
    }
  }

  return accept(true);
}

function collectSurfacesPreOrder(surface: ShellResolvedSurface): readonly ShellResolvedSurface[] {
  const output: ShellResolvedSurface[] = [];
  collectSurfacesPreOrderInto(surface, output);

  return Object.freeze(output);
}

function collectSurfacesPreOrderInto(
  surface: ShellResolvedSurface,
  output: ShellResolvedSurface[],
): void {
  output.push(surface);

  for (let index = 0; index < surface.children.length; index += 1) {
    const child = surface.children[index];

    if (child !== undefined) collectSurfacesPreOrderInto(child, output);
  }
}

function indexSurfaceObjects(layout: ShellComposedLayout): ReadonlyMap<string, ShellResolvedSurface> {
  const output = new Map<string, ShellResolvedSurface>();

  for (let index = 0; index < layout.surfaces.length; index += 1) {
    const surface = layout.surfaces[index];

    if (surface !== undefined) output.set(surface.id, surface);
  }

  return output;
}

function createRequestFromResolvedSurface(surface: ShellResolvedSurface): ShellSurfaceCreateRequest {
  const input: {
    surfaceId: string;
    componentId: string;
    role: string;
    path: string;
    placement: ShellPlacement;
    payload: PlainJsonObject;
    className?: string;
  } = {
    componentId: surface.componentId,
    path: surface.path,
    payload: surface.payload,
    placement: surface.placement,
    role: surface.role,
    surfaceId: surface.id,
  };

  if (surface.className !== undefined) input.className = surface.className;

  return buildSurfaceCreateRequest(input);
}

function isFailsafeError(error: ShellError): boolean {
  return error.code === "SUBSTRATE_REMOVE_FAILED" || error.code === "SUBSTRATE_RESTORE_FAILED";
}

function freezeSurface(input: {
  readonly id: string;
  readonly componentId: string;
  readonly role: string;
  readonly path: string;
  readonly placement: ShellPlacement;
  readonly payload: PlainJsonObject;
  readonly substrate: PlainJsonObject;
  readonly children: readonly ShellResolvedSurface[];
  readonly key?: string;
  readonly className?: string;
  readonly parentSurfaceId?: string;
}): ShellResolvedSurface {
  const output: {
    id: string;
    componentId: string;
    role: string;
    path: string;
    placement: ShellPlacement;
    payload: PlainJsonObject;
    substrate: PlainJsonObject;
    children: readonly ShellResolvedSurface[];
    key?: string;
    className?: string;
    parentSurfaceId?: string;
  } = {
    children: input.children,
    componentId: input.componentId,
    id: input.id,
    path: input.path,
    payload: input.payload,
    placement: input.placement,
    role: input.role,
    substrate: input.substrate,
  };

  if (input.key !== undefined) output.key = input.key;
  if (input.className !== undefined) output.className = input.className;
  if (input.parentSurfaceId !== undefined) output.parentSurfaceId = input.parentSurfaceId;

  return Object.freeze(output);
}

function normalizeUnknownJson(value: unknown, path: string): ShellResult<PlainJson> {
  const normalized = safeNormalize(value);

  if (!normalized.ok) {
    return reject("INVALID_JSON_SHAPE", normalized.reason, path);
  }

  return accept(normalized.value);
}

function snapshotDataObject(value: unknown, path: string): ShellResult<ObjectSnapshot> {
  try {
    if (value === null || typeof value !== "object") {
      return reject("INVALID_OBJECT", "value must be a plain data object.", path);
    }
    if (nodeTypes.isProxy(value) || Array.isArray(value)) {
      return reject("INVALID_OBJECT", "value must be a plain data object.", path);
    }

    const prototype = Object.getPrototypeOf(value);

    if (prototype !== Object.prototype && prototype !== null) {
      return reject("INVALID_OBJECT", "value must be a plain data object.", path);
    }

    const keys = Reflect.ownKeys(value);
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === undefined || typeof key === "symbol") {
        return reject("INVALID_OBJECT", "value must contain only string data properties.", path);
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key);

      if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value") || descriptor.enumerable !== true) {
        return reject("INVALID_OBJECT", "value must contain only enumerable data properties.", path);
      }

      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true,
      });
    }

    return accept(Object.freeze({
      value: Object.freeze(output),
    }));
  } catch {
    return reject("INVALID_OBJECT", "value must be a plain data object.", path);
  }
}

function expectFields(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = Object.freeze([]),
  path = "",
): ShellResult<true> {
  const keys = Object.keys(value);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined || (!contains(required, key) && !contains(optional, key))) {
      return reject("UNEXPECTED_FIELD", `${pathPrefix(path)}${key ?? "field"} is not an expected field.`, path);
    }
  }

  for (let index = 0; index < required.length; index += 1) {
    const key = required[index];

    if (key === undefined || !Object.hasOwn(value, key)) {
      return reject("MISSING_FIELD", `${pathPrefix(path)}${key ?? "field"} is required.`, path);
    }
  }

  return accept(true);
}

function expectPlainFields(
  value: PlainJsonObject,
  required: readonly string[],
  optional: readonly string[] = Object.freeze([]),
  path = "",
): ShellResult<true> {
  const keys = Object.keys(value);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined || (!contains(required, key) && !contains(optional, key))) {
      return reject("UNEXPECTED_FIELD", `${pathPrefix(path)}${key ?? "field"} is not an expected field.`, path);
    }
  }

  for (let index = 0; index < required.length; index += 1) {
    const key = required[index];

    if (key === undefined || !Object.hasOwn(value, key)) {
      return reject("MISSING_FIELD", `${pathPrefix(path)}${key ?? "field"} is required.`, path);
    }
  }

  return accept(true);
}

function field(value: PlainJsonObject, key: string): PlainJson | undefined;
function field(value: Readonly<Record<string, unknown>>, key: string): unknown | undefined;
function field(value: Readonly<Record<string, unknown>> | PlainJsonObject, key: string): unknown | undefined {
  if (!Object.hasOwn(value, key)) return undefined;

  return value[key];
}

function isPlainObject(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function contains(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }

  return false;
}

function combineClassNames(first: string | undefined, second: string | undefined): string | undefined {
  if (first === undefined || first.length === 0) return second;
  if (second === undefined || second.length === 0) return first;

  return `${first} ${second}`;
}

function surfaceIdFor(componentId: string, path: string): string {
  return `surface:${pathToken(componentId)}:${path}`;
}

function pathToken(value: string): string {
  let token = "";

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isAlphaNumeric =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122);

    if (isAlphaNumeric || code === 45 || code === 46 || code === 95) {
      token += value[index] ?? "";
    } else {
      token += `_${code.toString(16).padStart(4, "0")}`;
    }
  }

  return token.length === 0 ? "component" : token;
}

function indexSurfaces(layout: ShellComposedLayout): Map<string, string> {
  const output = new Map<string, string>();

  for (let index = 0; index < layout.surfaces.length; index += 1) {
    const surface = layout.surfaces[index];

    if (surface !== undefined) {
      output.set(surface.id, surfaceDiffSignature(surface));
    }
  }

  return output;
}

function surfaceDiffSignature(surface: ShellResolvedSurface): string {
  const input: {
    children: readonly string[];
    className?: string;
    componentId: string;
    id: string;
    key?: string;
    parentSurfaceId?: string;
    path: string;
    payload: PlainJsonObject;
    placement: ShellPlacement;
    role: string;
  } = {
    children: Object.freeze(surface.children.map((child) => surfaceDiffSignature(child))),
    componentId: surface.componentId,
    id: surface.id,
    path: surface.path,
    payload: surface.payload,
    placement: surface.placement,
    role: surface.role,
  };

  if (surface.className !== undefined) input.className = surface.className;
  if (surface.key !== undefined) input.key = surface.key;
  if (surface.parentSurfaceId !== undefined) input.parentSurfaceId = surface.parentSurfaceId;

  return stableStringify(input);
}

function hardcodedFallbackLayout(): ShellComposedLayout {
  const placement: ShellPlacement = Object.freeze({
    layer: "overlay",
    order: 0,
    zone: "center",
  });
  const payload: PlainJsonObject = Object.freeze({
    message: "Shell edit failed closed to the known-good fallback.",
    safeMode: true,
    title: "Vita Fallback Shell",
  });
  const substrate: PlainJsonObject = Object.freeze({
    kind: "virtual",
    surfaceId: `surface:${pathToken(KNOWN_GOOD_FALLBACK_SHELL_ID)}:0`,
  });
  const surface: ShellResolvedSurface = Object.freeze({
    children: Object.freeze([]),
    className: "vita-fallback-shell",
    componentId: KNOWN_GOOD_FALLBACK_SHELL_ID,
    id: `surface:${pathToken(KNOWN_GOOD_FALLBACK_SHELL_ID)}:0`,
    path: "0",
    payload,
    placement,
    role: "fallback",
    substrate,
  });

  return Object.freeze({
    configId: KNOWN_GOOD_FALLBACK_SHELL_ID,
    css: cssFromText(FALLBACK_CSS_TEXT),
    revision: "known-good",
    root: surface,
    surfaces: Object.freeze([surface]),
  });
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items: string[] = [];

    for (let index = 0; index < value.length; index += 1) {
      items.push(stableStringify(value[index]));
    }

    return `[${items.join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record).sort(compareStrings);
    const entries: string[] = [];

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key !== undefined) {
        entries.push(`${JSON.stringify(key)}:${stableStringify(record[key])}`);
      }
    }

    return `{${entries.join(",")}}`;
  }

  return "null";
}

function pathPrefix(path: string): string {
  return path.length === 0 ? "" : `${path}: `;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;

  return 0;
}

function accept<T>(value: T): ShellResult<T> {
  return {
    ok: true,
    value,
  };
}

function reject<T>(code: string, message: string, path: string): ShellResult<T> {
  return {
    error: {
      code,
      message,
      path,
    },
    ok: false,
  };
}
