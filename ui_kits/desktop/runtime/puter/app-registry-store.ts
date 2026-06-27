// Puter compat — the APPS / SITES / SHARES / REALTIME registry behind the local api_origin.
//
// Real third-party Puter apps reach more than fs/kv/auth: they enumerate + register APPS
// (`puter.apps.*` → `/drivers/call` interface "puter-apps"), publish SITES / subdomains
// (`puter.hosting.*` → interface "puter-subdomains", and the REST `/sites`), SHARE files/dirs
// (`puter.share` / `/share`), and subscribe to REALTIME change events. The original spike served only
// fs/kv/auth, so any app touching those surfaces 404'd (and the SDK threw). This module adds that
// breadth — STORE-BACKED (persisted in the SAME PuterStore KV under reserved key prefixes, so it
// survives reload exactly like fs/kv) and CAPABILITY-GATED (each surface maps to a grant the caller
// must hold; default-deny otherwise). AGPL-clean: this is Vita's own implementation against our store.
//
// Persistence model (all under the owner's single app store KV; reserved prefixes never collide with
// an app's own keys because the api_origin namespaces them — see api-origin.ts wiring):
//   __vita.apps.<appId>        → ShellAppRecord JSON     (registered apps)
//   __vita.sites.<subdomain>   → SiteRecord JSON         (published sites / subdomains)
//   __vita.shares.<token>      → ShareRecord JSON        (file/dir shares)
//   __vita.events              → EventRecord[] JSON (ring buffer, newest last) — the realtime feed
//
// No HTTP, no DOM. Pure logic over the injected PuterKvStore. The api_origin maps driver-call methods
// + REST routes onto these functions.

import type { PuterKvStore } from "./store.ts";

// ---------------------------------------------------------------------------------------------
// Records (the shapes the SDK + REST consumers read). Kept close to puter's entity-storage shapes so
// the genuine SDK is satisfied (uid/name/... ), but minimal.
// ---------------------------------------------------------------------------------------------

export interface AppRecord {
  readonly uid: string;
  readonly name: string;
  readonly title: string;
  readonly index_url: string;
  readonly icon?: string;
  readonly description?: string;
  readonly created_at: number;
  // Who registered it (the calling app's id) — provenance for the listing.
  readonly owner_app: string;
}

export interface SiteRecord {
  readonly uid: string;
  readonly subdomain: string;
  // The fs path whose contents the subdomain serves (puter.hosting maps a dir to a subdomain).
  readonly root_dir: string | null;
  readonly url: string;
  readonly created_at: number;
  readonly owner_app: string;
}

export interface ShareRecord {
  readonly token: string;
  readonly path: string;
  // "read" | "write" — the access the share grants. Sharing UI only needs read today.
  readonly mode: "read" | "write";
  readonly url: string;
  readonly created_at: number;
  readonly owner_app: string;
}

export interface EventRecord {
  readonly seq: number;
  readonly ts: number;
  // e.g. "fs.write" | "kv.set" | "app.create" | "site.create" | "share.create".
  readonly kind: string;
  readonly path?: string;
  readonly app?: string;
  readonly detail?: string;
}

// ---------------------------------------------------------------------------------------------
// The registry surface the api_origin calls. Every method is store-backed + synchronous (the KV is
// sync). `ownerApp` is the calling app's id (from the resolved session) — recorded as provenance.
// ---------------------------------------------------------------------------------------------

export interface AppSiteRegistry {
  // apps
  listApps(): readonly AppRecord[];
  getApp(name: string): AppRecord | undefined;
  createApp(input: { name?: string; title?: string; index_url?: string; icon?: string; description?: string }, ownerApp: string): AppRecord;
  deleteApp(name: string): boolean;
  // sites / subdomains
  listSites(): readonly SiteRecord[];
  getSite(subdomain: string): SiteRecord | undefined;
  createSite(input: { subdomain?: string; root_dir?: string | null }, ownerApp: string, originBase: string): SiteRecord;
  deleteSite(subdomain: string): boolean;
  // shares
  listShares(): readonly ShareRecord[];
  createShare(input: { path?: string; mode?: "read" | "write" }, ownerApp: string, originBase: string): ShareRecord;
  // realtime events
  recordEvent(input: Omit<EventRecord, "seq" | "ts">): EventRecord;
  events(sinceSeq: number, limit: number): { readonly events: readonly EventRecord[]; readonly cursor: number };
}

const APP_PREFIX = "__vita.apps.";
const SITE_PREFIX = "__vita.sites.";
const SHARE_PREFIX = "__vita.shares.";
const EVENTS_KEY = "__vita.events";
const EVENTS_CAP = 500; // ring-buffer cap so the feed never grows unbounded.

export function createAppSiteRegistry(kv: PuterKvStore): AppSiteRegistry {
  function readJson<T>(key: string): T | undefined {
    const raw = kv.get(key);

    if (raw === null) return undefined;

    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  function listByPrefix<T>(prefix: string): T[] {
    const out: T[] = [];

    for (const { key, value } of kv.list()) {
      if (!key.startsWith(prefix)) continue;

      try {
        out.push(JSON.parse(value) as T);
      } catch {
        // skip malformed
      }
    }

    return out;
  }

  function nextEventSeq(): number {
    const events = readJson<EventRecord[]>(EVENTS_KEY) ?? [];

    return events.length === 0 ? 1 : (events[events.length - 1]!.seq + 1);
  }

  const impl: AppSiteRegistry = {
    createApp(input, ownerApp): AppRecord {
      const name = sanitizeName(input.name ?? input.title ?? `app-${Date.now().toString(36)}`);
      const record: AppRecord = Object.freeze({
        created_at: nowSeconds(),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.icon === undefined ? {} : { icon: input.icon }),
        index_url: input.index_url ?? "",
        name,
        owner_app: ownerApp,
        title: input.title ?? name,
        uid: `app-${name}`,
      });

      kv.set(`${APP_PREFIX}${name}`, JSON.stringify(record));
      pushEvent({ app: ownerApp, detail: name, kind: "app.create" });
      return record;
    },
    createShare(input, ownerApp, originBase): ShareRecord {
      const token = `shr-${randomId()}`;
      const path = input.path ?? "/";
      const record: ShareRecord = Object.freeze({
        created_at: nowSeconds(),
        mode: input.mode === "write" ? "write" : "read",
        owner_app: ownerApp,
        path,
        token,
        url: `${originBase}/shared/${token}`,
      });

      kv.set(`${SHARE_PREFIX}${token}`, JSON.stringify(record));
      pushEvent({ app: ownerApp, detail: path, kind: "share.create", path });
      return record;
    },
    createSite(input, ownerApp, originBase): SiteRecord {
      const subdomain = sanitizeName(input.subdomain ?? `site-${randomId()}`);
      const record: SiteRecord = Object.freeze({
        created_at: nowSeconds(),
        owner_app: ownerApp,
        root_dir: input.root_dir ?? null,
        subdomain,
        uid: `sd-${subdomain}`,
        url: `${originBase}/sites/${subdomain}/`,
      });

      kv.set(`${SITE_PREFIX}${subdomain}`, JSON.stringify(record));
      pushEvent({ app: ownerApp, detail: subdomain, kind: "site.create" });
      return record;
    },
    deleteApp(name): boolean {
      const key = `${APP_PREFIX}${sanitizeName(name)}`;

      if (kv.get(key) === null) return false;

      kv.del(key);
      return true;
    },
    deleteSite(subdomain): boolean {
      const key = `${SITE_PREFIX}${sanitizeName(subdomain)}`;

      if (kv.get(key) === null) return false;

      kv.del(key);
      return true;
    },
    events(sinceSeq, limit): { events: readonly EventRecord[]; cursor: number } {
      const all = readJson<EventRecord[]>(EVENTS_KEY) ?? [];
      const filtered = all.filter((e) => e.seq > sinceSeq).slice(0, Math.max(1, Math.min(limit, EVENTS_CAP)));
      const cursor = filtered.length === 0 ? sinceSeq : filtered[filtered.length - 1]!.seq;

      return { cursor, events: Object.freeze(filtered) };
    },
    getApp(name): AppRecord | undefined {
      return readJson<AppRecord>(`${APP_PREFIX}${sanitizeName(name)}`);
    },
    getSite(subdomain): SiteRecord | undefined {
      return readJson<SiteRecord>(`${SITE_PREFIX}${sanitizeName(subdomain)}`);
    },
    listApps(): readonly AppRecord[] {
      return Object.freeze(listByPrefix<AppRecord>(APP_PREFIX).sort((a, b) => a.name.localeCompare(b.name)));
    },
    listShares(): readonly ShareRecord[] {
      return Object.freeze(listByPrefix<ShareRecord>(SHARE_PREFIX).sort((a, b) => b.created_at - a.created_at));
    },
    listSites(): readonly SiteRecord[] {
      return Object.freeze(listByPrefix<SiteRecord>(SITE_PREFIX).sort((a, b) => a.subdomain.localeCompare(b.subdomain)));
    },
    recordEvent(input): EventRecord {
      return pushEvent(input);
    },
  };

  return Object.freeze(impl);

  function pushEvent(input: Omit<EventRecord, "seq" | "ts">): EventRecord {
    const events = readJson<EventRecord[]>(EVENTS_KEY) ?? [];
    const record: EventRecord = Object.freeze({ seq: nextEventSeq(), ts: nowSeconds(), ...input });

    events.push(record);

    // Trim to the ring-buffer cap (drop oldest).
    const trimmed = events.length > EVENTS_CAP ? events.slice(events.length - EVENTS_CAP) : events;

    kv.set(EVENTS_KEY, JSON.stringify(trimmed));
    return record;
  }
}

// ---------------------------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------------------------

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// A subdomain/app name is lowercase alnum + hyphen. Collapse anything else to '-'. Pure.
function sanitizeName(input: string): string {
  const s = input.trim().toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "");

  return s === "" ? `x-${randomId()}` : s.slice(0, 63);
}

let RAND_COUNTER = 0;

function randomId(): string {
  const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
  const getRandomValues = g.crypto?.getRandomValues;

  if (typeof getRandomValues === "function") {
    const bytes = new Uint8Array(8);

    getRandomValues.call(g.crypto, bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  RAND_COUNTER += 1;
  return `${Date.now().toString(36)}${RAND_COUNTER.toString(36)}`;
}
