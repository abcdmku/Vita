// Per-app typed config handle (Phase A2).
//
// The desktop hands every mounted app a `ctx.config: AppConfigHandle` (see app-sdk.ts). It resolves
// to: the manifest schema's DEFAULTS, layered with USER OVERRIDES persisted through the host bridge.
// Reads are synchronous against an in-memory resolved snapshot; writes coerce/validate against the
// schema, persist through the (optional) backend, and notify onChange subscribers.
//
// PERSISTENCE BACKEND — optional + fail-closed. The host bridge's settings ports (readSetting /
// applySetting) are strictly allowlisted to a fixed desktop key set, so they CANNOT carry arbitrary
// per-app config. Instead we probe the host for an OPTIONAL `appConfig` port (the same OWN-descriptor
// probe pattern used for `metrics` and `appWindow`). When present it persists a per-app config blob
// (conceptually /var/lib/vita/apps/<id>/config.ts via a settings namespace); when ABSENT the handle
// still works fully in-memory (defaults + live edits) so the desktop never breaks, it just doesn't
// survive a reboot. Nothing here imports or mutates the SDK DesktopHost type.

import type {
  AppConfigHandle,
  AppConfigSchema,
  AppConfigSnapshot,
  AppConfigValue,
} from "./app-sdk.ts";
import {
  appConfigDefaults,
  coerceConfigValue,
} from "./app-sdk.ts";

// The optional per-app config persistence port. A backend implements this; the desktop probes for it
// on the host. All methods are async + fail-closed (errors are swallowed → in-memory only).
export interface AppConfigBackend {
  // Read the persisted override blob for an app. Returns a flat key→value record (or undefined/empty
  // when nothing is stored). Implementations should reject malformed values; we re-validate anyway.
  read(appId: string): Promise<Readonly<Record<string, unknown>> | undefined> | Readonly<Record<string, unknown>> | undefined;
  // Persist the override blob (only the keys that differ from defaults, typically). Best-effort.
  write(appId: string, overrides: Readonly<Record<string, AppConfigValue>>): Promise<void> | void;
}

export interface AppConfigHandleInit {
  readonly appId: string;
  readonly schema: AppConfigSchema | undefined;
  // Optional persistence backend; absent → in-memory only.
  readonly backend?: AppConfigBackend | undefined;
}

// Build a config handle. Synchronous to construct (so mount() always gets a live handle); persisted
// overrides load asynchronously and merge in when they arrive, firing onChange if anything changed.
export function createAppConfigHandle(init: AppConfigHandleInit): AppConfigHandle {
  return new AppConfigHandleImpl(init);
}

// Probe a host object for an optional `appConfig` backend via an OWN data descriptor (no prototype
// walk, no inherited traps) — mirrors how Activity reads `metrics` and the index reads `appWindow`.
export function readAppConfigBackend(host: unknown): AppConfigBackend | undefined {
  if (host === null || typeof host !== "object") return undefined;

  try {
    const descriptor = Object.getOwnPropertyDescriptor(host, "appConfig");
    const value = descriptor?.value;

    if (
      value !== null &&
      typeof value === "object" &&
      typeof (value as { read?: unknown }).read === "function" &&
      typeof (value as { write?: unknown }).write === "function"
    ) {
      return value as AppConfigBackend;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

class AppConfigHandleImpl implements AppConfigHandle {
  readonly schema: AppConfigSchema;

  readonly #appId: string;
  readonly #defaults: AppConfigSnapshot;
  readonly #backend: AppConfigBackend | undefined;
  readonly #keys: Set<string>;
  readonly #listeners = new Set<(snapshot: AppConfigSnapshot) => void>();
  #overrides: Record<string, AppConfigValue> = {};
  #snapshot: AppConfigSnapshot;
  #loaded = false;

  constructor(init: AppConfigHandleInit) {
    this.schema = init.schema ?? Object.freeze([]);
    this.#appId = init.appId;
    this.#backend = init.backend;
    this.#defaults = appConfigDefaults(init.schema);
    this.#keys = new Set(Object.keys(this.#defaults));
    this.#snapshot = this.#defaults;

    // Load persisted overrides asynchronously; merge + notify when (if) they arrive.
    void this.#load();
  }

  get(key: string): AppConfigValue | undefined {
    return this.#keys.has(key) ? this.#snapshot[key] : undefined;
  }

  getAll(): AppConfigSnapshot {
    return this.#snapshot;
  }

  set(key: string, value: AppConfigValue): AppConfigSnapshot {
    return this.update({ [key]: value });
  }

  update(patch: Readonly<Record<string, AppConfigValue>>): AppConfigSnapshot {
    let changed = false;

    for (const key of Object.keys(patch)) {
      const property = this.#property(key);

      if (property === undefined) continue; // ignore unknown keys (fail-closed to the schema)

      const coerced = coerceConfigValue(property, patch[key]);

      if (this.#snapshot[key] !== coerced) {
        this.#overrides[key] = coerced;
        changed = true;
      }
    }

    if (!changed) return this.#snapshot;

    this.#snapshot = this.#resolve();
    this.#persist();
    this.#notify();

    return this.#snapshot;
  }

  onChange(callback: (snapshot: AppConfigSnapshot) => void): () => void {
    this.#listeners.add(callback);

    return () => {
      this.#listeners.delete(callback);
    };
  }

  // ----- internals -----

  #property(key: string) {
    for (const property of this.schema) {
      if (property.key === key) return property;
    }

    return undefined;
  }

  #resolve(): AppConfigSnapshot {
    const out: Record<string, AppConfigValue> = {};

    for (const property of this.schema) {
      const override = this.#overrides[property.key];

      out[property.key] = override !== undefined
        ? coerceConfigValue(property, override)
        : this.#defaults[property.key] ?? coerceConfigValue(property, property.default);
    }

    return Object.freeze(out);
  }

  async #load(): Promise<void> {
    if (this.#backend === undefined) {
      this.#loaded = true;
      return;
    }

    let stored: Readonly<Record<string, unknown>> | undefined;

    try {
      stored = await this.#backend.read(this.#appId);
    } catch {
      this.#loaded = true;
      return; // fail-closed: keep defaults
    }

    this.#loaded = true;

    if (stored === null || typeof stored !== "object") return;

    let changed = false;

    for (const property of this.schema) {
      if (!Object.prototype.hasOwnProperty.call(stored, property.key)) continue;

      const coerced = coerceConfigValue(property, stored[property.key]);

      if (this.#snapshot[property.key] !== coerced) {
        this.#overrides[property.key] = coerced;
        changed = true;
      }
    }

    if (changed) {
      this.#snapshot = this.#resolve();
      this.#notify();
    }
  }

  #persist(): void {
    if (this.#backend === undefined) return;

    try {
      // Persist the full resolved override set (only declared keys with overrides).
      const blob: Record<string, AppConfigValue> = {};

      for (const key of Object.keys(this.#overrides)) {
        if (this.#keys.has(key)) blob[key] = this.#overrides[key]!;
      }

      void Promise.resolve(this.#backend.write(this.#appId, Object.freeze(blob))).catch(() => {
        // fail-closed: persistence failure must not break the live handle.
      });
    } catch {
      // ignore
    }
  }

  #notify(): void {
    const snapshot = this.#snapshot;

    for (const listener of [...this.#listeners]) {
      try {
        listener(snapshot);
      } catch {
        // a misbehaving subscriber must not break others.
      }
    }
  }
}
