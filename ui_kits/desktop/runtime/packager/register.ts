// Vita app PACKAGER — registration bridge (Phase D, v1).
//
// Once `generateApp(...)` produces a VitaApp, it must join the running desktop two ways:
//   1. The DOCK / app set the app-window-host resolves (a `Map<appId, VitaApp>`), so clicking the dock
//      tile mounts it; and
//   2. The signed app registry (createAppRegistry) — the SRI-verified catalog the launch path validates
//      against. A generated app becomes a first-party-style registry seed (SRI over its launchable
//      descriptor) so it is gated by the same "OS allows" check as the built-ins.
//
// This module is the small glue between the generated VitaApp and those two surfaces. It does NOT
// itself run the offline install — it operates on an already-generated app.

import { createHash } from "node:crypto";

import type {
  AppCapability,
  VitaApp,
} from "../app-sdk.ts";
import type {
  DesktopCapability,
  DesktopCapabilityGrant,
  DesktopFirstPartyRegistrySeed,
  DesktopLaunchableApp,
  DesktopRegistryApp,
} from "../../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  PackagerGeneratedApp,
} from "./types.ts";

// A mutable app set the app-window-host can resolve. `builtinAppRegistry()` returns a fresh Map; a
// generated app is added to it with `registerGeneratedApp`.
export type DesktopAppSet = Map<string, VitaApp>;

// Register a generated app into a dock/app set. Returns false (and leaves the set unchanged) when an app
// with the same id is already present — fail-closed against id collisions, matching createAppRegistry's
// first-writer-wins behavior.
export function registerGeneratedApp(set: DesktopAppSet, generated: PackagerGeneratedApp): boolean {
  const id = generated.app.manifest.id;

  if (set.has(id)) return false;

  set.set(id, generated.app);
  return true;
}

// Build a DesktopRegistryApp descriptor for a generated app. The launchable descriptor is a `tsx`
// surface whose componentId is the generated app id (the runtime resolves it to the VitaApp via the
// app set above). The required grants are the generated app's capabilities mapped onto the desktop
// capability vocabulary (the catalog grant the app inherited).
export function registryDescriptorForGeneratedApp(generated: PackagerGeneratedApp): DesktopRegistryApp {
  const id = generated.app.manifest.id;
  const app: DesktopLaunchableApp = Object.freeze({
    id,
    runtime: Object.freeze({ componentId: id }),
    surfaceKind: "tsx" as const,
    title: generated.app.manifest.title,
  });

  return Object.freeze({
    app,
    requiredGrants: mapCapabilityGrants(generated.app.manifest.capabilities),
    title: generated.app.manifest.title,
  });
}

// Build a SRI-verified first-party registry SEED for a generated app, ready to pass to
// `createAppRegistry({ firstParty: [...] })`. The integrity is sha256 over the canonical JSON of the
// descriptor — the SAME scheme createAppRegistry recomputes and checks, so the seed verifies in the
// registry (and a tampered descriptor would be dropped fail-closed there).
export function packagerRegistrySeed(generated: PackagerGeneratedApp): DesktopFirstPartyRegistrySeed {
  const descriptor = registryDescriptorForGeneratedApp(generated);

  return Object.freeze({
    descriptor,
    integrity: `sha256-${createHash("sha256").update(JSON.stringify(descriptor), "utf8").digest("base64")}`,
  });
}

// Map the SDK-layer app capabilities (AppManifest.capabilities) onto the desktop capability grant
// vocabulary used by the registry. Capabilities without a desktop-grant analogue (e.g. "web.local",
// "metrics.read") are advisory-only and produce no registry grant. Deterministic + deduplicated.
function mapCapabilityGrants(capabilities: readonly AppCapability[]): readonly DesktopCapabilityGrant[] {
  const seen = new Set<DesktopCapability>();
  const grants: DesktopCapabilityGrant[] = [];

  for (const capability of capabilities) {
    const mapped = APP_TO_DESKTOP_CAPABILITY[capability];

    if (mapped === undefined || seen.has(mapped)) continue;

    seen.add(mapped);
    grants.push(Object.freeze({ capability: mapped }));
  }

  return Object.freeze(grants);
}

// AppCapability -> DesktopCapability. Only the capabilities with a real desktop-grant analogue map;
// the rest stay advisory at the SDK layer (no registry grant).
const APP_TO_DESKTOP_CAPABILITY: Readonly<Record<AppCapability, DesktopCapability | undefined>> = Object.freeze({
  "files.read": "files.read",
  "files.write": "files.write",
  "metrics.read": undefined,
  "settings.read": "settings.read",
  "settings.write": "settings.write",
  "web.local": undefined,
});
