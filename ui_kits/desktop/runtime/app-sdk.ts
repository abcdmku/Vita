// Vita desktop app-host SDK (Phase A) — the contract apps build against.
//
// THE MODEL (owner architecture direction): the CORE DESKTOP PACKAGE provides everything an app
// needs — window management, input routing, dark-themed chrome, and this app-host SDK. An app is a
// SMALL, SEPARATE module that exports a `VitaApp` (a manifest + a `mount` function) and is INJECTED
// into a desktop-provided, already-themed window surface. The app author never touches window
// chrome, drag/resize/close, z-order, or theming — they render into `ctx.surface.root` and use
// `ctx.host` (the real platform host bridge) for data. They get a real managed window for free.
//
// Decoupling: this file is the stable seam between the desktop (window-manager.ts, app-window-host.ts)
// and apps (runtime/apps/*.ts). It deliberately carries NO heavy DOM-`lib` dependency — the only DOM
// touchpoint is the structural `WmElement` surface root re-used from window-manager.ts, matching the
// rest of the runtime's portable `*Like` style so `npm run typecheck` stays clean.

import type {
  DesktopHost,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  WmElement,
} from "./window-manager.ts";

// ---------------------------------------------------------------------------------------------
// Manifest.
// ---------------------------------------------------------------------------------------------

// Capabilities an app declares it needs. These are advisory at the SDK layer (the real grant
// enforcement lives in the host bridge / app-registry); they let the desktop reason about an app
// and surface honest "backend unavailable" states when a capability isn't wired.
export type AppCapability =
  | "files.read"
  | "files.write"
  | "settings.read"
  | "settings.write"
  | "metrics.read"
  | "web.local";

// How the app gets its window. "managed" (the default) = the desktop provides a managed window and
// mounts the app into its body surface with the desktop's own padded/themed inner chrome. "custom" =
// the desktop STILL owns the OUTER managed window (drag/close/resize/focus/z-order stay the desktop's
// job — an injected app never gets a raw OS window), but it hands the app a BARE body surface: no
// inner padding/background applied by the desktop, so the app paints edge-to-edge and manages its own
// inner chrome (toolbars, its own background). Unknown/omitted falls back to "managed". This field is
// honoured in app-window-host.ts (see prepareSurfaceForMode) — it is a real branch, not a no-op stub.
export type AppWindowMode = "managed" | "custom";

// ---------------------------------------------------------------------------------------------
// App config schema (Phase A2) — typed TS configuration declared on the manifest.
// ---------------------------------------------------------------------------------------------

// A single typed configuration property an app declares. The desktop generates a settings FORM from
// these (one input per `type`) and seeds the config handle's defaults. `options` is required for
// "enum" and ignored otherwise.
export type AppConfigPropertyType = "string" | "number" | "boolean" | "enum";

// A concrete value a config property can hold. Enums are encoded as strings.
export type AppConfigValue = string | number | boolean;

export interface AppConfigEnumOption {
  readonly value: string;
  readonly label?: string;
}

export interface AppConfigProperty {
  readonly key: string;
  readonly type: AppConfigPropertyType;
  readonly label: string;
  readonly default: AppConfigValue;
  // Only meaningful for type:"enum" — the allowed choices (value + optional human label).
  readonly options?: readonly AppConfigEnumOption[];
  // Optional one-line hint rendered under the control in the generated form.
  readonly description?: string;
}

// The typed property schema an app declares on its manifest. Each entry is one configurable property.
export type AppConfigSchema = readonly AppConfigProperty[];

// A resolved config snapshot: every schema key → its current value (default layered with the user
// override). Always carries exactly the schema's keys.
export type AppConfigSnapshot = Readonly<Record<string, AppConfigValue>>;

export interface AppManifest {
  readonly id: string;
  readonly title: string;
  readonly icon: string; // emoji or glyph shown in the dock/title bar
  readonly capabilities: readonly AppCapability[];
  // Defaults to "managed" when omitted — see AppWindowMode.
  readonly window?: AppWindowMode;
  // Typed configuration schema (Phase A2). When present, the desktop generates a settings form and
  // seeds defaults; an app reads/writes via ctx.config. Omitted => the app has no settings surface.
  readonly config?: AppConfigSchema;
}

// The handle the desktop hands an app on ctx.config. Reads are synchronous against the in-memory
// resolved snapshot (defaults ⊕ persisted overrides loaded at mount); writes persist through the
// optional backend and notify onChange subscribers. Fail-closed: with no backend, writes still
// update the in-memory snapshot (so the UI stays live) but are not persisted.
export interface AppConfigHandle {
  // Current value for a declared key (typed value or undefined if the key isn't in the schema).
  get(key: string): AppConfigValue | undefined;
  // The whole resolved snapshot (frozen).
  getAll(): AppConfigSnapshot;
  // Set one property. Returns the new snapshot. Values are coerced/validated against the schema;
  // an invalid value (e.g. an out-of-range enum or wrong type) is rejected and the snapshot unchanged.
  set(key: string, value: AppConfigValue): AppConfigSnapshot;
  // Patch several properties at once. Returns the new snapshot.
  update(patch: Readonly<Record<string, AppConfigValue>>): AppConfigSnapshot;
  // Subscribe to value changes. The callback gets the new snapshot. Returns an unsubscribe.
  onChange(callback: (snapshot: AppConfigSnapshot) => void): () => void;
  // The schema this handle was built from (so the settings window can render a form without re-reading
  // the manifest).
  readonly schema: AppConfigSchema;
}

// ---------------------------------------------------------------------------------------------
// Surface + window handles passed to an app.
// ---------------------------------------------------------------------------------------------

// The desktop-owned, dark-themed element the app renders into. It lives INSIDE the managed window's
// body; the app fully owns its inner content but never the surrounding chrome.
export interface AppSurface {
  readonly root: WmElement;
}

// What an app may ASK of its window. The desktop owns the chrome and may decline/defer, but these
// are the supported requests. Mirrors the platform "app proposes, desktop disposes" posture.
export interface AppWindowController {
  setTitle(title: string): void;
  setBadge(badge: string): void;
  requestClose(): void;
  requestFocus(): void;
  requestMaximize(): void;
  requestRestore(): void;
  readonly id: string;
}

// ---------------------------------------------------------------------------------------------
// Lifecycle events.
// ---------------------------------------------------------------------------------------------

export type AppLifecycleEvent = "close" | "resize" | "focus" | "visibility";

export interface AppResizeDetail {
  readonly width: number;
  readonly height: number;
}

export interface AppVisibilityDetail {
  readonly visible: boolean;
}

export interface AppFocusDetail {
  readonly focused: boolean;
}

export type AppEventDetail =
  | { readonly type: "close" }
  | { readonly type: "resize"; readonly detail: AppResizeDetail }
  | { readonly type: "focus"; readonly detail: AppFocusDetail }
  | { readonly type: "visibility"; readonly detail: AppVisibilityDetail };

export type AppEventListener = (detail: AppEventDetail) => void;

// ---------------------------------------------------------------------------------------------
// App context (the desktop hands this to mount).
// ---------------------------------------------------------------------------------------------

export interface AppContext {
  // Where to render. Desktop-owned, themed, inside the managed window.
  readonly surface: AppSurface;
  // The REAL platform APIs / host bridge: files, settings, metrics, theme, etc.
  readonly host: DesktopHost;
  // Ask the desktop about the window; the desktop owns the chrome.
  readonly window: AppWindowController;
  // Typed config (Phase A2): defaults from the manifest schema, user overrides persisted via the
  // host bridge. Always present — apps with no `config` schema get an empty handle (get→undefined).
  readonly config: AppConfigHandle;
  // Lifecycle subscription. Returns an unsubscribe.
  on(event: AppLifecycleEvent, callback: AppEventListener): () => void;
}

// ---------------------------------------------------------------------------------------------
// VitaApp — what an app module exports.
// ---------------------------------------------------------------------------------------------

// `mount` renders the app into `ctx.surface.root`, wires any behavior (delegated listeners, polling,
// etc.), and returns an OPTIONAL cleanup function the desktop calls on window close. Keep it small —
// a real app is a manifest + a mount in ~30 lines (see runtime/apps/* for examples).
export type AppCleanup = () => void;

export interface VitaApp {
  readonly manifest: AppManifest;
  mount(ctx: AppContext): AppCleanup | void;
}

// Convenience: assert a value is a VitaApp at the seam (frozen, mount present). Apps that come from
// dynamic registration can be validated here before the desktop tries to mount them.
export function isVitaApp(value: unknown): value is VitaApp {
  if (value === null || typeof value !== "object") return false;

  const manifest = (value as { manifest?: unknown }).manifest;
  const mount = (value as { mount?: unknown }).mount;

  if (manifest === null || typeof manifest !== "object" || typeof mount !== "function") return false;

  const id = (manifest as { id?: unknown }).id;

  return typeof id === "string" && id.length > 0;
}

// A tiny helper so an app file reads declaratively: `export default defineApp({ manifest, mount })`.
export function defineApp(app: VitaApp): VitaApp {
  // Spreading {...app.manifest} preserves the optional `window` mode; default to "managed".
  const manifest: {
    id: string;
    title: string;
    icon: string;
    capabilities: readonly AppCapability[];
    window: AppWindowMode;
    config?: AppConfigSchema;
  } = {
    ...app.manifest,
    capabilities: Object.freeze([...app.manifest.capabilities]),
    window: app.manifest.window ?? "managed",
  };

  // Deep-freeze the config schema (and its enum option arrays) when declared, so the manifest stays
  // immutable end-to-end.
  if (app.manifest.config !== undefined) {
    manifest.config = freezeConfigSchema(app.manifest.config);
  }

  return Object.freeze({
    manifest: Object.freeze(manifest),
    mount: app.mount,
  });
}

// Deep-freeze a config schema: the array, every property, and any enum `options` array/entries.
export function freezeConfigSchema(schema: AppConfigSchema): AppConfigSchema {
  return Object.freeze(
    schema.map((property) => {
      const options = property.options === undefined
        ? undefined
        : Object.freeze(property.options.map((option) => Object.freeze({ ...option })));
      const frozen: AppConfigProperty = options === undefined
        ? Object.freeze({ ...property })
        : Object.freeze({ ...property, options });

      return frozen;
    }),
  );
}

// Pure: resolve the default snapshot from a schema. Each property contributes its `default`. Invalid
// declared defaults (e.g. an enum default not in `options`) are coerced to the first option / a safe
// fallback so the snapshot is always well-typed. No I/O — same schema → same snapshot.
export function appConfigDefaults(schema: AppConfigSchema | undefined): AppConfigSnapshot {
  const out: Record<string, AppConfigValue> = {};

  if (schema !== undefined) {
    for (const property of schema) {
      out[property.key] = coerceConfigValue(property, property.default);
    }
  }

  return Object.freeze(out);
}

// Pure: coerce/validate a candidate value against a property's type. Returns the coerced value when
// acceptable, else the property's default. Enums must match a declared option.
export function coerceConfigValue(property: AppConfigProperty, value: unknown): AppConfigValue {
  switch (property.type) {
    case "boolean":
      if (typeof value === "boolean") return value;
      if (value === "true") return true;
      if (value === "false") return false;
      return fallbackConfigValue(property);
    case "number": {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value);

        if (Number.isFinite(parsed)) return parsed;
      }
      return fallbackConfigValue(property);
    }
    case "enum": {
      const options = property.options ?? [];
      const candidate = typeof value === "string" ? value : undefined;

      if (candidate !== undefined && options.some((option) => option.value === candidate)) {
        return candidate;
      }
      return fallbackConfigValue(property);
    }
    case "string":
    default:
      if (typeof value === "string") return value;
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
      if (typeof value === "boolean") return String(value);
      return fallbackConfigValue(property);
  }
}

// The safe fallback for a property when its declared default is itself unusable.
function fallbackConfigValue(property: AppConfigProperty): AppConfigValue {
  switch (property.type) {
    case "boolean":
      return typeof property.default === "boolean" ? property.default : false;
    case "number":
      return typeof property.default === "number" && Number.isFinite(property.default) ? property.default : 0;
    case "enum": {
      const options = property.options ?? [];

      if (typeof property.default === "string" && options.some((option) => option.value === property.default)) {
        return property.default;
      }
      return options[0]?.value ?? "";
    }
    case "string":
    default:
      return typeof property.default === "string" ? property.default : "";
  }
}
