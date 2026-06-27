// App settings / Properties window (Phase A2) — desktop-provided, generated.
//
// For a given app this renders its config TWO ways:
//   (a) a generated FORM from the AppConfigSchema — one control per property type (string→text,
//       number→number, boolean→checkbox, enum→select) — that writes through config.set; and
//   (b) a RAW view showing the per-app TS config FILE text (read-only for v1).
//
// It is desktop-provided and dark-themed. The renderer is pure (schema + snapshot → HTML); a small
// `wireSettingsForm` attaches one delegated listener per surface that reads the changed control and
// calls config.set, then re-renders. Decoupled from the WM: the host mounts the returned HTML into a
// managed window body and calls wireSettingsForm with that body element.

import type {
  AppConfigHandle,
  AppConfigProperty,
  AppConfigSchema,
  AppConfigSnapshot,
  AppConfigValue,
} from "./app-sdk.ts";
import type {
  WmElement,
} from "./window-manager.ts";

// Data attributes the form uses so the delegated listener can find the property + read the value.
const PROP_KEY_ATTR = "data-vita-config-key";
const PROP_TYPE_ATTR = "data-vita-config-type";
const TAB_ATTR = "data-vita-settings-tab";

export type SettingsTab = "form" | "raw";

export interface SettingsWindowInput {
  readonly appId: string;
  readonly appTitle: string;
  readonly appIcon: string;
  readonly schema: AppConfigSchema;
  readonly snapshot: AppConfigSnapshot;
  // Which tab is active. Defaults to "form".
  readonly tab?: SettingsTab;
}

// Render the full settings surface (tab strip + active tab body). Pure.
export function renderSettingsWindow(input: SettingsWindowInput): string {
  const tab = input.tab ?? "form";
  const hasSchema = input.schema.length > 0;

  return (
    `<div ${TAB_ATTR}-root="1" style="display:flex;flex-direction:column;height:100%;background:var(--surface);color:var(--text)">` +
    renderHeader(input) +
    renderTabStrip(tab, hasSchema) +
    `<div style="flex:1;min-height:0;overflow:auto">` +
    (tab === "raw" ? renderRawTab(input) : renderFormTab(input, hasSchema)) +
    `</div>` +
    `</div>`
  );
}

function renderHeader(input: SettingsWindowInput): string {
  return (
    `<div style="display:flex;align-items:center;gap:10px;padding:16px 20px 12px;border-bottom:1px solid var(--hairline)">` +
    `<span style="font-size:20px">${input.appIcon}</span>` +
    `<div>` +
    `<div style="font-size:15px;font-weight:600;color:var(--text)">${escapeHtml(input.appTitle)} — Properties</div>` +
    `<div style="font-size:11px;color:var(--text-faint);font-family:var(--font-mono,monospace)">${escapeHtml(input.appId)}</div>` +
    `</div>` +
    `</div>`
  );
}

function renderTabStrip(active: SettingsTab, hasSchema: boolean): string {
  const tab = (id: SettingsTab, label: string): string => {
    const on = id === active;

    return (
      `<span ${TAB_ATTR}="${id}" role="tab" tabindex="0" aria-selected="${on ? "true" : "false"}" ` +
      `style="cursor:pointer;padding:7px 14px;border-radius:8px;font-size:12.5px;` +
      `${on ? "background:var(--surface-raised);color:var(--text)" : "color:var(--text-secondary)"}">` +
      `${escapeHtml(label)}</span>`
    );
  };

  return (
    `<div style="display:flex;gap:6px;padding:10px 16px;border-bottom:1px solid var(--hairline)">` +
    tab("form", hasSchema ? "Settings" : "Settings") +
    tab("raw", "Config file") +
    `</div>`
  );
}

// ----- form tab (generated from the schema) -----

function renderFormTab(input: SettingsWindowInput, hasSchema: boolean): string {
  if (!hasSchema) {
    return (
      `<div style="padding:28px 20px;color:var(--text-faint);text-align:center">` +
      `<div style="font-size:13px;color:var(--text-muted);margin-bottom:6px">No configurable settings</div>` +
      `<div style="font-size:12px">${escapeHtml(input.appTitle)} does not declare a config schema.</div></div>`
    );
  }

  let rows = "";

  for (const property of input.schema) {
    rows += renderField(property, input.snapshot[property.key]);
  }

  return `<div style="padding:18px 20px;display:flex;flex-direction:column;gap:18px;max-width:560px">${rows}</div>`;
}

// One generated control. The label, the input keyed to its type, and an optional description.
export function renderField(property: AppConfigProperty, value: AppConfigValue | undefined): string {
  const current = value ?? property.default;
  const control = renderControl(property, current);
  const description = property.description === undefined
    ? ""
    : `<div style="font-size:11px;color:var(--text-faint);margin-top:5px">${escapeHtml(property.description)}</div>`;

  return (
    `<label style="display:block">` +
    `<div style="font-size:12.5px;font-weight:500;color:var(--text);margin-bottom:7px">${escapeHtml(property.label)}</div>` +
    control +
    description +
    `</label>`
  );
}

function renderControl(property: AppConfigProperty, value: AppConfigValue): string {
  const keyAttrs = `${PROP_KEY_ATTR}="${escapeHtml(property.key)}" ${PROP_TYPE_ATTR}="${property.type}"`;
  const inputStyle =
    "width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;font-size:13px;" +
    "background:var(--surface-raised);color:var(--text);border:1px solid var(--border)";

  switch (property.type) {
    case "boolean": {
      const checked = value === true ? " checked" : "";

      return (
        `<span style="display:inline-flex;align-items:center;gap:8px">` +
        `<input type="checkbox" ${keyAttrs}${checked} ` +
        `style="width:16px;height:16px;accent-color:var(--accent)">` +
        `<span style="font-size:12px;color:var(--text-muted)">${value === true ? "Enabled" : "Disabled"}</span>` +
        `</span>`
      );
    }
    case "number":
      return `<input type="number" ${keyAttrs} value="${escapeAttr(String(value))}" style="${inputStyle}">`;
    case "enum": {
      const options = (property.options ?? []).map((option) => {
        const selected = option.value === value ? " selected" : "";

        return `<option value="${escapeAttr(option.value)}"${selected}>${escapeHtml(option.label ?? option.value)}</option>`;
      }).join("");

      return `<select ${keyAttrs} style="${inputStyle};cursor:pointer">${options}</select>`;
    }
    case "string":
    default:
      return `<input type="text" ${keyAttrs} value="${escapeAttr(String(value))}" style="${inputStyle}">`;
  }
}

// ----- raw tab (the TS config file text, read-only) -----

function renderRawTab(input: SettingsWindowInput): string {
  const text = renderConfigFileText(input.appId, input.schema, input.snapshot);

  return (
    `<div style="padding:14px 16px">` +
    `<div style="font-size:11px;color:var(--text-faint);margin-bottom:8px;font-family:var(--font-mono,monospace)">` +
    `/var/lib/vita/apps/${escapeHtml(input.appId)}/config.ts` +
    `</div>` +
    `<pre style="margin:0;padding:14px 16px;border-radius:10px;overflow:auto;` +
    `background:var(--surface-sunken,var(--surface-raised));border:1px solid var(--border);` +
    `font-family:var(--font-mono,monospace);font-size:12px;line-height:1.55;color:var(--text)">` +
    `${escapeHtml(text)}</pre>` +
    `</div>`
  );
}

// Render the per-app config as a typed TS module text — the "config = typed TS files" view. This is
// the serialized form of the persisted config: a typed object literal an editor (v2) could write back.
export function renderConfigFileText(
  appId: string,
  schema: AppConfigSchema,
  snapshot: AppConfigSnapshot,
): string {
  const lines: string[] = [];

  lines.push(`// Per-app config — ${appId}`);
  lines.push(`// Typed configuration; values below override the manifest schema defaults.`);
  lines.push(`import type { AppConfigSnapshot } from "vita/desktop/app-sdk";`);
  lines.push("");
  lines.push("export const config: AppConfigSnapshot = {");

  for (const property of schema) {
    const value = snapshot[property.key] ?? property.default;

    lines.push(`  ${tsKey(property.key)}: ${tsValue(value)}, // ${property.type}`);
  }

  lines.push("};");
  lines.push("");
  lines.push("export default config;");

  return lines.join("\n");
}

// ----- wiring -----

export interface SettingsFormWiring {
  dispose(): void;
}

export interface SettingsFormWireOptions {
  // The mounted settings body element.
  readonly root: WmElement;
  // The live config handle for the target app.
  readonly config: AppConfigHandle;
  // Settings window metadata (so re-render keeps header/title).
  readonly appId: string;
  readonly appTitle: string;
  readonly appIcon: string;
  // Re-render the surface with the given HTML (the host swaps body.innerHTML).
  readonly setHtml: (html: string) => void;
}

// Attach the delegated listeners that make the generated form live: a `change`/`input` on a control
// writes through config.set; a click on a tab switches the active view. Returns a disposer.
export function wireSettingsForm(options: SettingsFormWireOptions): SettingsFormWiring {
  const { root, config } = options;
  let tab: SettingsTab = "form";

  const rerender = (): void => {
    options.setHtml(renderSettingsWindow({
      appIcon: options.appIcon,
      appId: options.appId,
      appTitle: options.appTitle,
      schema: config.schema,
      snapshot: config.getAll(),
      tab,
    }));
  };

  const onMutate = (event: unknown): void => {
    const found = findControl(event);

    if (found === undefined) return;

    const next = readControlValue(found);

    if (next === undefined) return;

    config.set(found.key, next);
    rerender();
  };

  const onClick = (event: unknown): void => {
    const selected = findTab(event);

    if (selected === undefined) return;
    if (selected === tab) return;

    tab = selected;
    rerender();
  };

  // `change` covers checkboxes/selects/blur on text; `input` makes text/number live as you type.
  addListener(root, "change", onMutate);
  addListener(root, "input", onMutate);
  addListener(root, "click", onClick);

  // Re-render when the config changes from elsewhere (e.g. the app itself writes config).
  const offChange = config.onChange(() => rerender());

  return Object.freeze({
    dispose(): void {
      removeListener(root, "change", onMutate);
      removeListener(root, "input", onMutate);
      removeListener(root, "click", onClick);
      offChange();
    },
  });
}

interface FoundControl {
  readonly key: string;
  readonly type: string;
  readonly node: ControlNode;
}

interface ControlNode {
  getAttribute?(name: string): string | null;
  value?: unknown;
  checked?: unknown;
  closest?(selector: string): ControlNode | null;
}

function findControl(event: unknown): FoundControl | undefined {
  const target = eventTarget(event);

  if (target === undefined) return undefined;

  const node = typeof target.closest === "function"
    ? safeClosest(target, `[${PROP_KEY_ATTR}]`)
    : (hasAttr(target, PROP_KEY_ATTR) ? target : null);

  if (node === null || node === undefined) return undefined;

  const key = readAttr(node, PROP_KEY_ATTR);
  const type = readAttr(node, PROP_TYPE_ATTR);

  if (key === undefined || type === undefined) return undefined;

  return { key, node, type };
}

function readControlValue(found: FoundControl): AppConfigValue | undefined {
  const node = found.node;

  if (found.type === "boolean") {
    return node.checked === true;
  }

  const raw = typeof node.value === "string" ? node.value : undefined;

  if (raw === undefined) return undefined;

  // Numbers/enums/strings are passed as strings; the handle coerces against the schema.
  return raw;
}

function findTab(event: unknown): SettingsTab | undefined {
  const target = eventTarget(event);

  if (target === undefined) return undefined;

  const node = typeof target.closest === "function"
    ? safeClosest(target, `[${TAB_ATTR}]`)
    : (hasAttr(target, TAB_ATTR) ? target : null);

  if (node === null || node === undefined) return undefined;

  const value = readAttr(node, TAB_ATTR);

  return value === "form" || value === "raw" ? value : undefined;
}

// ----- small DOM helpers (structural, no DOM lib) -----

function eventTarget(event: unknown): ControlNode | undefined {
  if (event === null || typeof event !== "object") return undefined;

  const target = (event as { target?: unknown }).target;

  return target !== null && typeof target === "object" ? (target as ControlNode) : undefined;
}

function safeClosest(node: ControlNode, selector: string): ControlNode | null {
  try {
    return node.closest?.(selector) ?? null;
  } catch {
    return null;
  }
}

function hasAttr(node: ControlNode, name: string): boolean {
  return readAttr(node, name) !== undefined;
}

function readAttr(node: ControlNode, name: string): string | undefined {
  if (typeof node.getAttribute !== "function") return undefined;

  try {
    const value = node.getAttribute(name);

    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

interface ListenerHost {
  addEventListener?(type: string, listener: (event: unknown) => void, options?: unknown): void;
  removeEventListener?(type: string, listener: (event: unknown) => void, options?: unknown): void;
}

function addListener(root: WmElement, type: string, listener: (event: unknown) => void): void {
  try {
    (root as unknown as ListenerHost).addEventListener?.(type, listener);
  } catch {
    // ignore
  }
}

function removeListener(root: WmElement, type: string, listener: (event: unknown) => void): void {
  try {
    (root as unknown as ListenerHost).removeEventListener?.(type, listener);
  } catch {
    // ignore
  }
}

// ----- text helpers -----

function tsKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? key : JSON.stringify(key);
}

function tsValue(value: AppConfigValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll("'", "&#39;");
}
