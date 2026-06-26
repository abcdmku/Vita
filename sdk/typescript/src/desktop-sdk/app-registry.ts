import { createHash, timingSafeEqual } from "node:crypto";

import { parseSriIntegrity } from "../sri.ts";
import type { AppWindowHints, TsxComponentRef, WebviewRuntimeRef } from "../appshell/index.ts";
import { hasDesktopCapabilityGrant } from "./loader.ts";
import type {
  DesktopCapabilityGrant,
  DesktopLaunchableApp,
  DesktopLauncherIntent,
  DesktopUiPackageManifest,
} from "./ui-package.ts";

export interface DesktopRegistryApp {
  readonly app: DesktopLaunchableApp;
  readonly title: string;
  readonly requiredGrants: readonly DesktopCapabilityGrant[];
}

export interface DesktopFirstPartyRegistryDescriptorSeed {
  readonly descriptor: DesktopRegistryApp;
  readonly integrity: string;
}

export interface DesktopFirstPartyRegistryInlineSeed extends DesktopRegistryApp {
  readonly integrity: string;
}

export type DesktopFirstPartyRegistrySeed =
  | DesktopFirstPartyRegistryDescriptorSeed
  | DesktopFirstPartyRegistryInlineSeed;

export interface CreateAppRegistryOptions {
  readonly firstParty?: readonly DesktopFirstPartyRegistrySeed[];
  readonly installedCapsules?: readonly DesktopRegistryApp[];
}

export interface DesktopRegistryError {
  readonly code: "UNKNOWN_APP" | "CAP_DENIED";
  readonly message: string;
  readonly path: string;
}

export type DesktopRegistryValidationResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: DesktopRegistryError;
    };

export interface DesktopAppRegistry {
  list(): readonly DesktopRegistryApp[];
  resolve(appId: string): DesktopRegistryApp | undefined;
  has(appId: string): boolean;
  validateLaunch(
    manifest: DesktopUiPackageManifest,
    appId: string,
  ): DesktopRegistryValidationResult<DesktopRegistryApp>;
  resolveLauncherIntent(intent: DesktopLauncherIntent): DesktopRegistryApp | undefined;
}

const EMPTY_FIRST_PARTY = Object.freeze([]) satisfies readonly DesktopFirstPartyRegistrySeed[];
const EMPTY_INSTALLED_CAPSULES = Object.freeze([]) satisfies readonly DesktopRegistryApp[];

export function createAppRegistry(
  options: CreateAppRegistryOptions = Object.freeze({}),
): DesktopAppRegistry {
  const seeded = new Map<string, DesktopRegistryApp>();
  const firstParty = options.firstParty ?? EMPTY_FIRST_PARTY;
  const installedCapsules = options.installedCapsules ?? EMPTY_INSTALLED_CAPSULES;

  for (let index = 0; index < firstParty.length; index += 1) {
    const seed = firstParty[index];

    if (seed === undefined || !firstPartySeedIntegrityMatches(seed)) continue;

    const descriptor = freezeRegistryApp(descriptorForFirstPartySeed(seed));

    if (!seeded.has(descriptor.app.id)) {
      seeded.set(descriptor.app.id, descriptor);
    }
  }

  for (let index = 0; index < installedCapsules.length; index += 1) {
    const descriptor = installedCapsules[index];

    if (descriptor === undefined) continue;

    const frozen = freezeRegistryApp(descriptor);

    if (!seeded.has(frozen.app.id)) {
      seeded.set(frozen.app.id, frozen);
    }
  }

  const listed = Object.freeze([...seeded.values()].sort(compareRegistryApps));
  const byId = new Map<string, DesktopRegistryApp>();

  for (let index = 0; index < listed.length; index += 1) {
    const descriptor = listed[index];

    if (descriptor !== undefined) {
      byId.set(descriptor.app.id, descriptor);
    }
  }

  return Object.freeze({
    has(appId: string): boolean {
      return typeof appId === "string" && byId.has(appId);
    },
    list(): readonly DesktopRegistryApp[] {
      return listed;
    },
    resolve(appId: string): DesktopRegistryApp | undefined {
      if (typeof appId !== "string") return undefined;

      return byId.get(appId);
    },
    resolveLauncherIntent(intent: DesktopLauncherIntent): DesktopRegistryApp | undefined {
      const input: unknown = intent;

      if (!isRecord(input)) return undefined;
      if (input["type"] !== "launcher.launch" || typeof input["appId"] !== "string") return undefined;

      return byId.get(input["appId"]);
    },
    validateLaunch(
      manifest: DesktopUiPackageManifest,
      appId: string,
    ): DesktopRegistryValidationResult<DesktopRegistryApp> {
      const descriptor = typeof appId === "string" ? byId.get(appId) : undefined;

      if (descriptor === undefined) {
        return reject(
          "UNKNOWN_APP",
          "app is not listed in the desktop app registry.",
          `/apps/${pathToken(typeof appId === "string" ? appId : "")}`,
        );
      }

      if (!packageCanLaunch(manifest, descriptor.app.id)) {
        return reject(
          "CAP_DENIED",
          "package manifest does not grant apps.launch for the requested app.",
          `/apps/${pathToken(descriptor.app.id)}/capability`,
        );
      }

      return accept(descriptor);
    },
  });
}

function firstPartySeedIntegrityMatches(seed: DesktopFirstPartyRegistrySeed): boolean {
  const parsed = parseSriIntegrity(seed.integrity);

  if (!parsed.ok) return false;

  let serialized: string | undefined;

  try {
    serialized = JSON.stringify(descriptorForFirstPartySeed(seed));
  } catch {
    return false;
  }

  if (serialized === undefined) return false;

  const expected = Buffer.from(parsed.integrity.digest, "base64");
  const actual = createHash(parsed.integrity.algorithm)
    .update(serialized, "utf8")
    .digest();

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function descriptorForFirstPartySeed(seed: DesktopFirstPartyRegistrySeed): DesktopRegistryApp {
  if ("descriptor" in seed) return seed.descriptor;

  return {
    app: seed.app,
    title: seed.title,
    requiredGrants: seed.requiredGrants,
  };
}

function packageCanLaunch(manifest: DesktopUiPackageManifest, appId: string): boolean {
  try {
    return hasDesktopCapabilityGrant(manifest, "apps.launch", appId);
  } catch {
    return false;
  }
}

function freezeRegistryApp(input: DesktopRegistryApp): DesktopRegistryApp {
  return Object.freeze({
    app: freezeLaunchableApp(input.app),
    title: input.title,
    requiredGrants: freezeCapabilityGrants(input.requiredGrants),
  });
}

function freezeLaunchableApp(app: DesktopLaunchableApp): DesktopLaunchableApp {
  switch (app.surfaceKind) {
    case "tsx": {
      const runtime: {
        componentId: string;
        props?: NonNullable<TsxComponentRef["props"]>;
      } = {
        componentId: app.runtime.componentId,
      };

      if (app.runtime.props !== undefined) runtime.props = app.runtime.props;

      const output: {
        id: string;
        title: string;
        surfaceKind: "tsx";
        runtime: TsxComponentRef;
        defaultWindow?: AppWindowHints;
      } = {
        id: app.id,
        runtime: Object.freeze(runtime),
        surfaceKind: "tsx",
        title: app.title,
      };

      if (app.defaultWindow !== undefined) output.defaultWindow = freezeWindowHints(app.defaultWindow);

      return Object.freeze(output);
    }
    case "web": {
      const runtime: {
        url: string;
        partition?: string;
      } = {
        url: app.runtime.url,
      };

      if (app.runtime.partition !== undefined) runtime.partition = app.runtime.partition;

      const output: {
        id: string;
        title: string;
        surfaceKind: "web";
        runtime: WebviewRuntimeRef;
        defaultWindow?: AppWindowHints;
      } = {
        id: app.id,
        runtime: Object.freeze(runtime),
        surfaceKind: "web",
        title: app.title,
      };

      if (app.defaultWindow !== undefined) output.defaultWindow = freezeWindowHints(app.defaultWindow);

      return Object.freeze(output);
    }
  }
}

function freezeCapabilityGrants(
  grants: readonly DesktopCapabilityGrant[],
): readonly DesktopCapabilityGrant[] {
  const output: DesktopCapabilityGrant[] = [];

  for (let index = 0; index < grants.length; index += 1) {
    const grant = grants[index];

    if (grant === undefined) continue;

    const frozen: {
      capability: DesktopCapabilityGrant["capability"];
      resourceId?: string;
    } = {
      capability: grant.capability,
    };

    if (grant.resourceId !== undefined) frozen.resourceId = grant.resourceId;

    output.push(Object.freeze(frozen));
  }

  return Object.freeze(output);
}

function freezeWindowHints(hints: AppWindowHints): AppWindowHints {
  const output: {
    workspaceId?: string;
    rect?: NonNullable<AppWindowHints["rect"]>;
    mode?: NonNullable<AppWindowHints["mode"]>;
    zone?: string;
    layer?: string;
    order?: number;
    anchor?: string;
    className?: string;
  } = {};

  if (hints.workspaceId !== undefined) output.workspaceId = hints.workspaceId;
  if (hints.rect !== undefined) {
    output.rect = Object.freeze({
      height: hints.rect.height,
      width: hints.rect.width,
      x: hints.rect.x,
      y: hints.rect.y,
    });
  }
  if (hints.mode !== undefined) output.mode = hints.mode;
  if (hints.zone !== undefined) output.zone = hints.zone;
  if (hints.layer !== undefined) output.layer = hints.layer;
  if (hints.order !== undefined) output.order = hints.order;
  if (hints.anchor !== undefined) output.anchor = hints.anchor;
  if (hints.className !== undefined) output.className = hints.className;

  return Object.freeze(output);
}

function compareRegistryApps(left: DesktopRegistryApp, right: DesktopRegistryApp): number {
  if (left.app.id < right.app.id) return -1;
  if (left.app.id > right.app.id) return 1;

  return 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pathToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function accept<T>(value: T): DesktopRegistryValidationResult<T> {
  return {
    ok: true,
    value,
  };
}

function reject<T>(
  code: DesktopRegistryError["code"],
  message: string,
  path: string,
): DesktopRegistryValidationResult<T> {
  return {
    error: {
      code,
      message,
      path,
    },
    ok: false,
  };
}
