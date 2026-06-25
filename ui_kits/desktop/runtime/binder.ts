export type VitaStoreUnsubscribe = () => void;

export type VitaEventListener = (event: VitaEventLike) => void;

export interface VitaEventLike {
  readonly type: string;
  readonly target: unknown;
}

export interface VitaClassList {
  toggle(token: string, force?: boolean): boolean;
}

export type VitaDataset = Readonly<Record<string, string | undefined>>;

export interface VitaElementList {
  readonly length: number;
  readonly [index: number]: VitaElement | undefined;
}

export interface VitaElement {
  readonly dataset: VitaDataset;
  textContent: string | null;
  readonly classList: VitaClassList;
  querySelectorAll(selector: string): VitaElementList;
  closest(selector: string): VitaElement | null;
  addEventListener(type: string, listener: VitaEventListener): void;
  removeEventListener?(type: string, listener: VitaEventListener): void;
  getAttribute?(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute?(name: string): void;
  cloneNode(deep?: boolean): VitaElement;
  appendChild(child: VitaElement): VitaElement;
  removeChild(child: VitaElement): VitaElement;
}

export interface VitaActionContext<State> {
  readonly action: string;
  readonly event: VitaEventLike;
  readonly target: VitaElement;
  readonly snapshot?: State;
}

export type VitaActionHandler<State> = (context: VitaActionContext<State>) => void | Promise<void>;
export type VitaActionMap<State> = ReadonlyMap<string, VitaActionHandler<State>> | Readonly<Record<string, VitaActionHandler<State>>>;

export type VitaBindPrimitive = string | number | boolean | null | undefined;

export interface VitaListClassPatch {
  readonly className: string;
  readonly enabled: boolean;
}

export interface VitaListAttributePatch {
  readonly name: string;
  readonly value: VitaBindPrimitive;
}

export interface VitaListItem {
  readonly key: string;
  readonly text?: VitaBindPrimitive;
  readonly classes?: readonly VitaListClassPatch[];
  readonly attrs?: readonly VitaListAttributePatch[];
  readonly snapshot?: unknown;
}

export type VitaBindValue = VitaBindPrimitive | readonly VitaListItem[];
export type VitaBindResolver<State> = (snapshot: State) => VitaBindValue;
export type VitaBindMap<State> = ReadonlyMap<string, VitaBindResolver<State>> | Readonly<Record<string, VitaBindResolver<State>>>;

type ResolvedBind =
  | {
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly ok: false;
    };

export interface VitaBindTargets {
  readonly text: readonly VitaTextTarget[];
  readonly classes: readonly VitaClassTarget[];
  readonly attrs: readonly VitaAttrTarget[];
  readonly aria: readonly VitaAriaTarget[];
  readonly lists: readonly VitaListTarget[];
}

export interface VitaTextTarget {
  readonly element: VitaElement;
  readonly bindId: string;
}

export interface VitaClassBinding {
  readonly className: string;
  readonly bindId: string;
}

export interface VitaClassTarget {
  readonly element: VitaElement;
  readonly bindings: readonly VitaClassBinding[];
}

export interface VitaAttrTarget {
  readonly element: VitaElement;
  readonly attrName: string;
  readonly bindId: string;
  readonly slot: number;
}

export type VitaAriaState =
  | "checked"
  | "current"
  | "disabled"
  | "expanded"
  | "hidden"
  | "pressed"
  | "selected";
export type VitaAriaAttribute =
  | "aria-checked"
  | "aria-current"
  | "aria-disabled"
  | "aria-expanded"
  | "aria-hidden"
  | "aria-pressed"
  | "aria-selected";

export interface VitaAriaTarget {
  readonly element: VitaElement;
  readonly state: VitaAriaState;
  readonly attrName: VitaAriaAttribute;
  readonly bindId: string;
}

export interface VitaListTarget {
  readonly element: VitaElement;
  readonly bindId: string;
  readonly template: VitaElement | null;
}

export interface VitaActionBinding {
  dispose(): void;
}

export interface VitaActionBindingOptions<State> {
  readonly eventTypes?: readonly string[];
  readonly snapshot?: () => State;
}

export interface VitaBinderOptions<State> extends VitaActionBindingOptions<State> {
  readonly actions?: VitaActionMap<State>;
  readonly binds?: VitaBindMap<State>;
}

export interface VitaBinder<State> {
  readonly targets: VitaBindTargets;
  render(snapshot: State): void;
  dispose(): void;
}

export const VITA_ACTION_SELECTOR = "[data-vita-action]";
export const VITA_KEY_SELECTOR = "[data-vita-key]";
export const VITA_BIND_TEXT_SELECTORS = Object.freeze(["[data-vita-bind-text]", "[data-vita-text]"]);
export const VITA_BIND_CLASS_SELECTORS = Object.freeze(["[data-vita-bind-class]", "[data-vita-class]"]);
export const VITA_BIND_LIST_SELECTORS = Object.freeze(["[data-vita-bind-list]", "[data-vita-list]"]);
export const VITA_BIND_ARIA_STATES = Object.freeze([
  "expanded",
  "selected",
  "checked",
  "current",
  "disabled",
  "pressed",
  "hidden",
] as const);
export const VITA_MAX_ATTR_BINDINGS = 32;

const DEFAULT_ACTION_EVENTS = Object.freeze(["click"]);

export function createBinder<State>(
  root: VitaElement,
  options: VitaBinderOptions<State> = Object.freeze({}),
): VitaBinder<State> {
  const targets = captureBindTargets(root);
  const actionOptions: {
    eventTypes?: readonly string[];
    snapshot?: () => State;
  } = {};

  if (options.eventTypes !== undefined) actionOptions.eventTypes = options.eventTypes;
  if (options.snapshot !== undefined) actionOptions.snapshot = options.snapshot;

  const actionBinding = options.actions === undefined
    ? emptyActionBinding()
    : bindActions(root, options.actions, actionOptions);
  let disposed = false;

  return Object.freeze({
    targets,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      actionBinding.dispose();
    },
    render(snapshot: State): void {
      if (disposed || options.binds === undefined) return;
      applyBindSinks(targets, snapshot, options.binds);
    },
  });
}

export function bindActions<State>(
  root: VitaElement,
  actions: VitaActionMap<State>,
  options: VitaActionBindingOptions<State> = Object.freeze({}),
): VitaActionBinding {
  const listeners: {
    readonly eventType: string;
    readonly listener: VitaEventListener;
  }[] = [];
  let disposed = false;
  const eventTypes = normalizeEventTypes(options.eventTypes);

  for (let index = 0; index < eventTypes.length; index += 1) {
    const eventType = eventTypes[index];

    if (eventType === undefined) continue;

    const listener = (event: VitaEventLike): void => {
      if (disposed) return;
      dispatchAction(event, actions, options.snapshot);
    };

    try {
      root.addEventListener(eventType, listener);
      listeners.push(Object.freeze({ eventType, listener }));
    } catch {
      disposed = true;
      break;
    }
  }

  return Object.freeze({
    dispose(): void {
      if (disposed) return;
      disposed = true;

      for (let index = 0; index < listeners.length; index += 1) {
        const item = listeners[index];

        if (item !== undefined) {
          try {
            root.removeEventListener?.(item.eventType, item.listener);
          } catch {
            return;
          }
        }
      }
    },
  });
}

export function captureBindTargets(root: VitaElement): VitaBindTargets {
  return captureTargets(root, true);
}

export const captureBoundNodes = captureBindTargets;

export function applyBindSinks<State>(
  targets: VitaBindTargets,
  snapshot: State,
  binds: VitaBindMap<State>,
): void {
  applyScalarTargets(targets, snapshot, binds);

  for (let index = 0; index < targets.lists.length; index += 1) {
    const target = targets.lists[index];

    if (target !== undefined) {
      applyListTarget(target, snapshot, binds);
    }
  }
}

export const reflectBindSinks = applyBindSinks;
export const renderBindSinks = applyBindSinks;

function emptyActionBinding(): VitaActionBinding {
  return Object.freeze({
    dispose(): void {},
  });
}

function dispatchAction<State>(
  event: VitaEventLike,
  actions: VitaActionMap<State>,
  snapshot: (() => State) | undefined,
): void {
  const target = event.target;

  if (!isClosestTarget(target)) return;

  let actionElement: VitaElement | null;

  try {
    actionElement = target.closest(VITA_ACTION_SELECTOR);
  } catch {
    return;
  }

  if (actionElement === null) return;
  if (!eventMatchesActionElement(event, actionElement)) return;

  const action = datasetValue(actionElement, Object.freeze(["vitaAction"]));

  if (action === undefined) return;

  const handler = lookup(actions, action);

  if (handler === undefined) return;

  try {
    const base = {
      action,
      event,
      target: actionElement,
    };
    const context: VitaActionContext<State> = snapshot === undefined
      ? base
      : {
        ...base,
        snapshot: snapshot(),
      };
    const result = handler(context);

    if (isPromiseLike(result)) {
      result.catch(() => {});
    }
  } catch {
    return;
  }
}

function eventMatchesActionElement(event: VitaEventLike, element: VitaElement): boolean {
  const declared = datasetValue(element, Object.freeze(["vitaEvent"]));

  return declared === undefined || declared === event.type;
}

function captureTargets(root: VitaElement, includeLists: boolean): VitaBindTargets {
  const text = captureTextTargets(root);
  const classes = captureClassTargets(root);
  const attrs = captureAttrTargets(root);
  const aria = captureAriaTargets(root);
  const lists = includeLists ? captureListTargets(root) : Object.freeze([]) satisfies readonly VitaListTarget[];

  return Object.freeze({
    aria,
    attrs,
    classes,
    lists,
    text,
  });
}

function captureTextTargets(root: VitaElement): readonly VitaTextTarget[] {
  const output: VitaTextTarget[] = [];
  const rootBind = datasetValue(root, Object.freeze(["vitaBindText", "vitaText"]));

  if (rootBind !== undefined) {
    output.push(Object.freeze({
      bindId: rootBind,
      element: root,
    }));
  }

  appendTextTargets(output, querySelectors(root, VITA_BIND_TEXT_SELECTORS));
  return Object.freeze(output);
}

function appendTextTargets(output: VitaTextTarget[], elements: readonly VitaElement[]): void {
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    const bindId = element === undefined
      ? undefined
      : datasetValue(element, Object.freeze(["vitaBindText", "vitaText"]));

    if (element !== undefined && bindId !== undefined) {
      output.push(Object.freeze({ bindId, element }));
    }
  }
}

function captureClassTargets(root: VitaElement): readonly VitaClassTarget[] {
  const output: VitaClassTarget[] = [];
  const rootSpec = datasetValue(root, Object.freeze(["vitaBindClass", "vitaClass"]));

  if (rootSpec !== undefined) {
    const bindings = parseClassBindings(rootSpec);

    if (bindings.length > 0) {
      output.push(Object.freeze({
        bindings,
        element: root,
      }));
    }
  }

  const elements = querySelectors(root, VITA_BIND_CLASS_SELECTORS);

  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    const spec = element === undefined
      ? undefined
      : datasetValue(element, Object.freeze(["vitaBindClass", "vitaClass"]));

    if (element === undefined || spec === undefined) continue;

    const bindings = parseClassBindings(spec);

    if (bindings.length > 0) {
      output.push(Object.freeze({
        bindings,
        element,
      }));
    }
  }

  return Object.freeze(output);
}

function captureAttrTargets(root: VitaElement): readonly VitaAttrTarget[] {
  const output: VitaAttrTarget[] = [];

  appendAttrTargetsForElement(output, root);

  for (let slot = 0; slot < VITA_MAX_ATTR_BINDINGS; slot += 1) {
    const selectors = attrSelectors(slot);
    const elements = querySelectors(root, selectors);

    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index];

      if (element !== undefined) {
        appendAttrTarget(output, element, slot);
      }
    }
  }

  return Object.freeze(output);
}

function appendAttrTargetsForElement(output: VitaAttrTarget[], element: VitaElement): void {
  for (let slot = 0; slot < VITA_MAX_ATTR_BINDINGS; slot += 1) {
    appendAttrTarget(output, element, slot);
  }
}

function appendAttrTarget(output: VitaAttrTarget[], element: VitaElement, slot: number): void {
  const spec = datasetValue(element, attrDatasetKeys(slot));

  if (spec === undefined) return;
  if (hasAttrTarget(output, element, slot)) return;

  const parsed = parseAttrBinding(spec);

  if (parsed === null) return;

  output.push(Object.freeze({
    attrName: parsed.attrName,
    bindId: parsed.bindId,
    element,
    slot,
  }));
}

function captureAriaTargets(root: VitaElement): readonly VitaAriaTarget[] {
  const output: VitaAriaTarget[] = [];

  appendAriaTargetsForElement(output, root);

  for (let stateIndex = 0; stateIndex < VITA_BIND_ARIA_STATES.length; stateIndex += 1) {
    const state = VITA_BIND_ARIA_STATES[stateIndex];

    if (state === undefined) continue;

    const elements = querySelector(root, ariaSelector(state));

    for (let elementIndex = 0; elementIndex < elements.length; elementIndex += 1) {
      const element = elements[elementIndex];

      if (element !== undefined) {
        appendAriaTarget(output, element, state);
      }
    }
  }

  return Object.freeze(output);
}

function appendAriaTargetsForElement(output: VitaAriaTarget[], element: VitaElement): void {
  for (let index = 0; index < VITA_BIND_ARIA_STATES.length; index += 1) {
    const state = VITA_BIND_ARIA_STATES[index];

    if (state !== undefined) appendAriaTarget(output, element, state);
  }
}

function appendAriaTarget(output: VitaAriaTarget[], element: VitaElement, state: VitaAriaState): void {
  const bindId = datasetValue(element, Object.freeze([ariaDatasetKey(state)]));

  if (bindId === undefined) return;
  if (hasAriaTarget(output, element, state)) return;

  output.push(Object.freeze({
    attrName: ariaAttribute(state),
    bindId,
    element,
    state,
  }));
}

function captureListTargets(root: VitaElement): readonly VitaListTarget[] {
  const output: VitaListTarget[] = [];
  const rootBind = datasetValue(root, Object.freeze(["vitaBindList", "vitaList"]));

  if (rootBind !== undefined) {
    output.push(Object.freeze({
      bindId: rootBind,
      element: root,
      template: firstKeyedNode(root),
    }));
  }

  const elements = querySelectors(root, VITA_BIND_LIST_SELECTORS);

  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    const bindId = element === undefined
      ? undefined
      : datasetValue(element, Object.freeze(["vitaBindList", "vitaList"]));

    if (element !== undefined && bindId !== undefined) {
      output.push(Object.freeze({
        bindId,
        element,
        template: firstKeyedNode(element),
      }));
    }
  }

  return Object.freeze(output);
}

function applyScalarTargets<State>(
  targets: Pick<VitaBindTargets, "aria" | "attrs" | "classes" | "text">,
  snapshot: State,
  binds: VitaBindMap<State>,
): void {
  for (let index = 0; index < targets.text.length; index += 1) {
    const target = targets.text[index];

    if (target !== undefined) {
      applyTextTarget(target, snapshot, binds);
    }
  }

  for (let index = 0; index < targets.classes.length; index += 1) {
    const target = targets.classes[index];

    if (target !== undefined) {
      applyClassTarget(target, snapshot, binds);
    }
  }

  for (let index = 0; index < targets.attrs.length; index += 1) {
    const target = targets.attrs[index];

    if (target !== undefined) {
      applyAttrTarget(target, snapshot, binds);
    }
  }

  for (let index = 0; index < targets.aria.length; index += 1) {
    const target = targets.aria[index];

    if (target !== undefined) {
      applyAriaTarget(target, snapshot, binds);
    }
  }
}

function applyTextTarget<State>(
  target: VitaTextTarget,
  snapshot: State,
  binds: VitaBindMap<State>,
): void {
  const resolved = resolveBind(target.bindId, snapshot, binds);

  if (!resolved.ok) return;

  const value = textValue(resolved.value);

  if (value === null) return;

  try {
    if (target.element.textContent !== value) {
      target.element.textContent = value;
    }
  } catch {
    return;
  }
}

function applyClassTarget<State>(
  target: VitaClassTarget,
  snapshot: State,
  binds: VitaBindMap<State>,
): void {
  for (let index = 0; index < target.bindings.length; index += 1) {
    const binding = target.bindings[index];

    if (binding === undefined) continue;

    const resolved = resolveBind(binding.bindId, snapshot, binds);

    if (!resolved.ok) continue;

    const enabled = boolValue(resolved.value);

    if (enabled === null) continue;

    try {
      target.element.classList.toggle(binding.className, enabled);
    } catch {
      return;
    }
  }
}

function applyAttrTarget<State>(
  target: VitaAttrTarget,
  snapshot: State,
  binds: VitaBindMap<State>,
): void {
  const resolved = resolveBind(target.bindId, snapshot, binds);

  if (!resolved.ok) return;

  const value = attrValue(resolved.value);

  if (value === null) return;

  try {
    writeAttributeIfChanged(target.element, target.attrName, value);
  } catch {
    return;
  }
}

function applyAriaTarget<State>(
  target: VitaAriaTarget,
  snapshot: State,
  binds: VitaBindMap<State>,
): void {
  const resolved = resolveBind(target.bindId, snapshot, binds);

  if (!resolved.ok) return;

  const value = ariaValue(target.state, resolved.value);

  if (value.kind === "skip") return;

  try {
    if (value.kind === "remove") {
      removeAttributeIfPresent(target.element, target.attrName);
    } else {
      writeAttributeIfChanged(target.element, target.attrName, value.value);
    }
  } catch {
    return;
  }
}

function applyListTarget<State>(
  target: VitaListTarget,
  snapshot: State,
  binds: VitaBindMap<State>,
): void {
  const resolved = resolveBind(target.bindId, snapshot, binds);

  if (!resolved.ok) return;

  const items = listValue(resolved.value);

  if (items === null) return;

  const currentNodes = currentKeyedNodes(target.element);
  const usedKeys = new Set<string>();
  const desiredNodes: VitaElement[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];

    if (item === undefined || usedKeys.has(item.key)) continue;

    usedKeys.add(item.key);

    const existing = currentNodes.byKey.get(item.key);
    const node = existing ?? cloneListNode(target.template, item.key);

    if (node === null) continue;

    setKey(node, item.key);
    patchListNode(node, item, binds);
    desiredNodes.push(node);
  }

  for (let index = 0; index < desiredNodes.length; index += 1) {
    const node = desiredNodes[index];

    if (node !== undefined) {
      try {
        target.element.appendChild(node);
      } catch {
        return;
      }
    }
  }

  for (let index = 0; index < currentNodes.nodes.length; index += 1) {
    const node = currentNodes.nodes[index];

    if (node === undefined) continue;

    const key = datasetValue(node, Object.freeze(["vitaKey"]));

    if (key === undefined || !usedKeys.has(key) || currentNodes.duplicates.has(node)) {
      try {
        target.element.removeChild(node);
      } catch {
        return;
      }
    }
  }
}

function patchListNode<State>(
  node: VitaElement,
  item: VitaListItem,
  binds: VitaBindMap<State>,
): void {
  if ("text" in item) {
    const value = textValue(item.text);

    if (value !== null) {
      try {
        if (node.textContent !== value) {
          node.textContent = value;
        }
      } catch {
        return;
      }
    }
  }

  if (item.classes !== undefined) {
    for (let index = 0; index < item.classes.length; index += 1) {
      const patch = item.classes[index];

      if (patch !== undefined) {
        try {
          node.classList.toggle(patch.className, patch.enabled);
        } catch {
          return;
        }
      }
    }
  }

  if (item.attrs !== undefined) {
    for (let index = 0; index < item.attrs.length; index += 1) {
      const patch = item.attrs[index];
      const value = patch === undefined ? null : attrValue(patch.value);

      if (patch !== undefined && value !== null) {
        try {
          node.setAttribute(patch.name, value);
        } catch {
          return;
        }
      }
    }
  }

  const itemSnapshot = (item.snapshot ?? item) as State;
  const nestedTargets = captureTargets(node, false);

  applyScalarTargets(nestedTargets, itemSnapshot, binds);
}

function currentKeyedNodes(element: VitaElement): {
  readonly byKey: ReadonlyMap<string, VitaElement>;
  readonly duplicates: ReadonlySet<VitaElement>;
  readonly nodes: readonly VitaElement[];
} {
  const nodes = querySelector(element, VITA_KEY_SELECTOR);
  const byKey = new Map<string, VitaElement>();
  const duplicates = new Set<VitaElement>();

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const key = node === undefined ? undefined : datasetValue(node, Object.freeze(["vitaKey"]));

    if (node === undefined || key === undefined) continue;
    if (byKey.has(key)) {
      duplicates.add(node);
      continue;
    }

    byKey.set(key, node);
  }

  return Object.freeze({
    byKey,
    duplicates,
    nodes,
  });
}

function cloneListNode(template: VitaElement | null, key: string): VitaElement | null {
  if (template === null) return null;

  try {
    const clone = template.cloneNode(true);

    setKey(clone, key);
    return clone;
  } catch {
    return null;
  }
}

function firstKeyedNode(element: VitaElement): VitaElement | null {
  const nodes = querySelector(element, VITA_KEY_SELECTOR);

  return nodes[0] ?? null;
}

function setKey(element: VitaElement, key: string): void {
  try {
    element.setAttribute("data-vita-key", key);
  } catch {
    return;
  }
}

function parseClassBindings(spec: string): readonly VitaClassBinding[] {
  const output: VitaClassBinding[] = [];
  const tokens = spec.trim().split(/\s+/u);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === undefined || token.length === 0) continue;

    const colon = token.indexOf(":");
    const className = colon < 0 ? token : token.slice(0, colon);
    const bindId = colon < 0 ? token : token.slice(colon + 1);

    if (className.length > 0 && bindId.length > 0) {
      output.push(Object.freeze({
        bindId,
        className,
      }));
    }
  }

  return Object.freeze(output);
}

function parseAttrBinding(spec: string): {
  readonly attrName: string;
  readonly bindId: string;
} | null {
  const trimmed = spec.trim();

  if (trimmed.length === 0) return null;

  const colon = trimmed.indexOf(":");
  const attrName = colon < 0 ? trimmed : trimmed.slice(0, colon);
  const bindId = colon < 0 ? trimmed : trimmed.slice(colon + 1);

  if (!isAttributeName(attrName) || bindId.length === 0) return null;

  return Object.freeze({
    attrName,
    bindId,
  });
}

function isAttributeName(value: string): boolean {
  if (value.length === 0) return false;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const valid =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 45 ||
      code === 58 ||
      code === 95;

    if (!valid) return false;
  }

  return true;
}

function resolveBind<State>(
  bindId: string,
  snapshot: State,
  binds: VitaBindMap<State>,
): ResolvedBind {
  const resolver = lookup(binds, bindId);

  if (resolver !== undefined) {
    try {
      return Object.freeze({
        ok: true,
        value: resolver(snapshot),
      });
    } catch {
      return unresolved();
    }
  }

  return snapshotFieldResult(snapshot, bindId);
}

function textValue(value: unknown): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return `${value}`;
  if (typeof value === "boolean") return value ? "true" : "false";

  return null;
}

function boolValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;

  return null;
}

function attrValue(value: unknown): string | null {
  return textValue(value);
}

type NormalizedAriaValue =
  | {
      readonly kind: "remove";
    }
  | {
      readonly kind: "skip";
    }
  | {
      readonly kind: "write";
      readonly value: string;
    };

function ariaValue(state: VitaAriaState, value: unknown): NormalizedAriaValue {
  if (value === null || value === undefined) {
    return Object.freeze({ kind: "remove" });
  }

  if (state === "checked") {
    const checked = checkedAriaValue(value);

    return checked === null
      ? Object.freeze({ kind: "skip" })
      : Object.freeze({ kind: "write", value: checked });
  }

  if (state === "current") {
    const current = currentAriaValue(value);

    return current === null
      ? Object.freeze({ kind: "skip" })
      : Object.freeze({ kind: "write", value: current });
  }

  const enabled = boolValue(value);

  return enabled === null
    ? Object.freeze({ kind: "skip" })
    : Object.freeze({ kind: "write", value: enabled ? "true" : "false" });
}

function checkedAriaValue(value: unknown): string | null {
  const booleanValue = boolValue(value);

  if (booleanValue !== null) return booleanValue ? "true" : "false";
  if (value === "mixed") return "mixed";

  return null;
}

function currentAriaValue(value: unknown): string | null {
  const booleanValue = boolValue(value);

  if (booleanValue !== null) return booleanValue ? "true" : "false";
  if (
    value === "page" ||
    value === "step" ||
    value === "location" ||
    value === "date" ||
    value === "time"
  ) {
    return value;
  }

  return null;
}

function listValue(value: unknown): readonly VitaListItem[] | null {
  if (!Array.isArray(value)) return null;

  const output: VitaListItem[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const item = normalizeListItem(value[index]);

    if (item !== null) output.push(item);
  }

  return Object.freeze(output);
}

function normalizeListItem(value: unknown): VitaListItem | null {
  if (!isObjectLike(value)) return null;

  const key = snapshotFieldResult(value, "key");

  if (!key.ok || typeof key.value !== "string" || key.value.length === 0) return null;

  const output: {
    key: string;
    text?: VitaBindPrimitive;
    classes?: readonly VitaListClassPatch[];
    attrs?: readonly VitaListAttributePatch[];
    snapshot?: unknown;
  } = {
    key: key.value,
  };
  const text = snapshotFieldResult(value, "text");
  const classes = normalizeClassPatches(snapshotField(value, "classes"));
  const attrs = normalizeAttrPatches(snapshotField(value, "attrs"));
  const snapshot = snapshotFieldResult(value, "snapshot");

  if (text.ok && (isPrimitive(text.value) || text.value === null || text.value === undefined)) output.text = text.value;
  if (classes !== null) output.classes = classes;
  if (attrs !== null) output.attrs = attrs;
  output.snapshot = snapshot.ok ? snapshot.value : value;

  return Object.freeze(output);
}

function normalizeClassPatches(value: unknown): readonly VitaListClassPatch[] | null {
  if (!Array.isArray(value)) return null;

  const output: VitaListClassPatch[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];

    if (!isObjectLike(item)) continue;

    const className = snapshotField(item, "className");
    const enabled = snapshotField(item, "enabled");

    if (typeof className === "string" && className.length > 0 && typeof enabled === "boolean") {
      output.push(Object.freeze({
        className,
        enabled,
      }));
    }
  }

  return Object.freeze(output);
}

function normalizeAttrPatches(value: unknown): readonly VitaListAttributePatch[] | null {
  if (!Array.isArray(value)) return null;

  const output: VitaListAttributePatch[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];

    if (!isObjectLike(item)) continue;

    const name = snapshotField(item, "name");
    const patchValue = snapshotField(item, "value");

    if (typeof name === "string" && isAttributeName(name) && (isPrimitive(patchValue) || patchValue === null || patchValue === undefined)) {
      output.push(Object.freeze({
        name,
        value: patchValue,
      }));
    }
  }

  return Object.freeze(output);
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function lookup<T>(source: ReadonlyMap<string, T> | Readonly<Record<string, T>>, key: string): T | undefined {
  if (isReadonlyMap(source)) {
    return source.get(key);
  }

  return Object.hasOwn(source, key) ? source[key] : undefined;
}

function isReadonlyMap<T>(source: ReadonlyMap<string, T> | Readonly<Record<string, T>>): source is ReadonlyMap<string, T> {
  try {
    return typeof Reflect.get(source, "get") === "function" && typeof Reflect.get(source, "has") === "function";
  } catch {
    return false;
  }
}

function snapshotField(value: unknown, key: string): unknown {
  const result = snapshotFieldResult(value, key);

  return result.ok ? result.value : undefined;
}

function snapshotFieldResult(value: unknown, key: string): ResolvedBind {
  if (!isObjectLike(value)) return unresolved();

  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      return unresolved();
    }

    return Object.freeze({
      ok: true,
      value: descriptor.value,
    });
  } catch {
    return unresolved();
  }
}

function unresolved(): ResolvedBind {
  return Object.freeze({
    ok: false,
  });
}

function datasetValue(element: VitaElement, keys: readonly string[]): string | undefined {
  try {
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const value = key === undefined ? undefined : element.dataset[key];

      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function querySelectors(root: VitaElement, selectors: readonly string[]): readonly VitaElement[] {
  const output: VitaElement[] = [];

  for (let index = 0; index < selectors.length; index += 1) {
    const selector = selectors[index];

    if (selector !== undefined) {
      appendUnique(output, querySelector(root, selector));
    }
  }

  return Object.freeze(output);
}

function querySelector(root: VitaElement, selector: string): readonly VitaElement[] {
  try {
    return elementsFromList(root.querySelectorAll(selector));
  } catch {
    return Object.freeze([]);
  }
}

function elementsFromList(list: VitaElementList): readonly VitaElement[] {
  const output: VitaElement[] = [];

  for (let index = 0; index < list.length; index += 1) {
    const element = list[index];

    if (element !== undefined) output.push(element);
  }

  return Object.freeze(output);
}

function appendUnique(output: VitaElement[], elements: readonly VitaElement[]): void {
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];

    if (element !== undefined && !containsElement(output, element)) {
      output.push(element);
    }
  }
}

function containsElement(elements: readonly VitaElement[], target: VitaElement): boolean {
  for (let index = 0; index < elements.length; index += 1) {
    if (elements[index] === target) return true;
  }

  return false;
}

function hasAttrTarget(targets: readonly VitaAttrTarget[], element: VitaElement, slot: number): boolean {
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];

    if (target !== undefined && target.element === element && target.slot === slot) return true;
  }

  return false;
}

function hasAriaTarget(targets: readonly VitaAriaTarget[], element: VitaElement, state: VitaAriaState): boolean {
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];

    if (target !== undefined && target.element === element && target.state === state) return true;
  }

  return false;
}

function attrSelectors(slot: number): readonly string[] {
  return Object.freeze([
    `[data-vita-bind-attr-${slot}]`,
    `[data-vita-bind-attr${slot}]`,
    `[data-vita-attr-${slot}]`,
    `[data-vita-attr${slot}]`,
  ]);
}

function attrDatasetKeys(slot: number): readonly string[] {
  return Object.freeze([
    `vitaBindAttr-${slot}`,
    `vitaBindAttr${slot}`,
    `vitaAttr-${slot}`,
    `vitaAttr${slot}`,
  ]);
}

function ariaSelector(state: VitaAriaState): string {
  return `[data-vita-bind-aria-${state}]`;
}

function ariaDatasetKey(state: VitaAriaState): string {
  let output = "vitaBindAria";
  let capitalizeNext = true;

  for (let index = 0; index < state.length; index += 1) {
    const char = state[index];

    if (char === undefined) continue;

    output += capitalizeNext ? char.toUpperCase() : char;
    capitalizeNext = char === "-";
  }

  return output;
}

function ariaAttribute(state: VitaAriaState): VitaAriaAttribute {
  switch (state) {
    case "checked":
      return "aria-checked";
    case "current":
      return "aria-current";
    case "disabled":
      return "aria-disabled";
    case "expanded":
      return "aria-expanded";
    case "hidden":
      return "aria-hidden";
    case "pressed":
      return "aria-pressed";
    case "selected":
      return "aria-selected";
  }
}

type AttributeRead =
  | {
      readonly ok: true;
      readonly value: string | null;
    }
  | {
      readonly ok: false;
    };

function writeAttributeIfChanged(element: VitaElement, name: string, value: string): void {
  const current = readAttribute(element, name);

  if (current.ok && current.value === value) return;
  if (!current.ok && hasAttributeReader(element)) return;

  element.setAttribute(name, value);
}

function removeAttributeIfPresent(element: VitaElement, name: string): void {
  const current = readAttribute(element, name);

  if (current.ok && current.value === null) return;
  if (!current.ok && hasAttributeReader(element)) return;

  const remover = readFunction(element, "removeAttribute");

  if (remover === undefined) return;

  remover(name);
}

function readAttribute(element: VitaElement, name: string): AttributeRead {
  const getter = readFunction(element, "getAttribute");

  if (getter !== undefined) {
    return readAttributeWith(getter, element, name);
  }

  const testGetter = readFunction(element, "attribute");

  if (testGetter !== undefined) {
    return readAttributeWith(testGetter, element, name);
  }

  return Object.freeze({
    ok: false,
  });
}

type AttributeReader = (name: string) => unknown;

function readAttributeWith(getter: AttributeReader, element: VitaElement, name: string): AttributeRead {
  try {
    const value = getter(name);

    return Object.freeze({
      ok: true,
      value: typeof value === "string" ? value : null,
    });
  } catch {
    return Object.freeze({
      ok: false,
    });
  }
}

function hasAttributeReader(element: VitaElement): boolean {
  return readFunction(element, "getAttribute") !== undefined || readFunction(element, "attribute") !== undefined;
}

function readFunction(source: object, key: string): AttributeReader | undefined {
  try {
    const value = Reflect.get(source, key);

    if (typeof value !== "function") return undefined;

    return (name: string): unknown => Reflect.apply(value, source, [name]);
  } catch {
    return undefined;
  }
}

function normalizeEventTypes(input: readonly string[] | undefined): readonly string[] {
  const source = input === undefined ? DEFAULT_ACTION_EVENTS : input;
  const output: string[] = [];

  for (let index = 0; index < source.length; index += 1) {
    const eventType = source[index];

    if (eventType !== undefined && eventType.length > 0 && !containsString(output, eventType)) {
      output.push(eventType);
    }
  }

  return output.length === 0 ? DEFAULT_ACTION_EVENTS : Object.freeze(output);
}

function containsString(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }

  return false;
}

function isClosestTarget(value: unknown): value is Pick<VitaElement, "closest"> {
  if (!isObjectLike(value)) return false;

  try {
    return typeof Reflect.get(value, "closest") === "function";
  } catch {
    return false;
  }
}

function isPromiseLike(value: unknown): value is Promise<void> {
  if (!isObjectLike(value)) return false;

  try {
    return typeof Reflect.get(value, "catch") === "function";
  } catch {
    return false;
  }
}

function isObjectLike(value: unknown): value is object {
  return value !== null && typeof value === "object";
}
