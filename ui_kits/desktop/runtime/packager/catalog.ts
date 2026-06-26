// Vita app PACKAGER — the catalog / allowlist (Phase D, v1).
//
// The curated set of OS-allowed packageable npm packages. The OS will ONLY generate an app for a
// package listed here. Each entry pins the exact version + SRI integrity the OS is allowed to install
// and the capability grants the generated app inherits.
//
// This is the packager-facing model. It TIES INTO createAppRegistry (the signed app catalog): once a
// package is generated into a VitaApp, `packagerRegistrySeed()` produces a DesktopFirstPartyRegistrySeed
// (SRI over the launchable descriptor) so the generated app joins the same signed registry the
// first-party apps use. The allowlist and the registry are the two halves of the "OS allows" gate.

import { parseSriIntegrity } from "../../../../sdk/typescript/src/sri.ts";
import type {
  AppCapability,
} from "../app-sdk.ts";
import type {
  PackagerCatalog,
  PackagerCatalogEntry,
} from "./types.ts";

const EMPTY_ENTRIES: readonly PackagerCatalogEntry[] = Object.freeze([]);

// Build a frozen catalog from a set of allowlist entries. Entries whose SRI integrity does not parse
// are DROPPED fail-closed (the OS must never offer to install bytes it cannot verify). Duplicate names
// keep the first occurrence. The listing is deterministic (sorted by name).
export function createPackagerCatalog(
  entries: readonly PackagerCatalogEntry[] = EMPTY_ENTRIES,
): PackagerCatalog {
  const byName = new Map<string, PackagerCatalogEntry>();

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (entry === undefined || !isAllowlistableEntry(entry)) continue;
    if (byName.has(entry.name)) continue;

    byName.set(entry.name, freezeEntry(entry));
  }

  const listed = Object.freeze(
    [...byName.values()].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
  );

  return Object.freeze({
    allows(name: string): boolean {
      return typeof name === "string" && byName.has(name);
    },
    list(): readonly PackagerCatalogEntry[] {
      return listed;
    },
    resolve(name: string): PackagerCatalogEntry | undefined {
      if (typeof name !== "string") return undefined;

      return byName.get(name);
    },
  });
}

// An entry is allowlistable only when its required fields are well-formed AND its SRI integrity parses
// (algorithm-digest with a digest length matching the algorithm). Fail-closed on anything malformed.
function isAllowlistableEntry(entry: PackagerCatalogEntry): boolean {
  if (typeof entry.name !== "string" || entry.name.length === 0) return false;
  if (typeof entry.version !== "string" || entry.version.length === 0) return false;
  if (entry.kind !== "desktop" && entry.kind !== "cmd" && entry.kind !== "auto") return false;
  if (!Array.isArray(entry.capabilities)) return false;
  if (!parseSriIntegrity(entry.integrity).ok) return false;

  return true;
}

function freezeEntry(entry: PackagerCatalogEntry): PackagerCatalogEntry {
  const output: {
    name: string;
    version: string;
    integrity: string;
    kind: PackagerCatalogEntry["kind"];
    capabilities: readonly AppCapability[];
    title?: string;
    icon?: string;
  } = {
    capabilities: Object.freeze([...entry.capabilities]),
    integrity: entry.integrity,
    kind: entry.kind,
    name: entry.name,
    version: entry.version,
  };

  if (entry.title !== undefined) output.title = entry.title;
  if (entry.icon !== undefined) output.icon = entry.icon;

  return Object.freeze(output);
}
