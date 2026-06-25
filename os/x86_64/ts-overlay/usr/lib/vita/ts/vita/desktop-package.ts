import {
  parseCapsuleRegistryReadResponse,
} from "./capsule-preview.ts";
import {
  readDesktopSessionHeartbeatThroughSubstrate,
} from "./desktop-substrate.ts";
import type {
  CapsuleEntry,
  CapsuleRegistry,
} from "./capsule-registry-model.ts";
import type {
  AgentApplyPlan,
  AgentApplyResult,
  AgentCapabilityState,
  AgentClient,
} from "./agent-client.ts";
import type {
  DesktopSessionRegistration,
} from "./desktop-substrate.ts";

export const DESKTOP_PACKAGE_MARKER = "VITA-DESKTOP-PKG";
export const DESKTOP_STUB_CAPSULE_ID = "com.vita.desktop.stub";
const DESKTOP_STUB_CAPSULE_VERSION = "1.0.0";
const DESKTOP_STUB_CAPSULE_INTEGRITY = "sha256-sPt3ZRLmh4AiIyy5GMMpd6DAPKE/vAP3KdOOr0kAb6w=";
const DESKTOP_STUB_BUNDLE_REF = "file:///usr/lib/vita/capsule-bundles/com.vita.desktop.stub.tar.zst";
const DESKTOP_STUB_SESSION_ID = "stub-session";

export const DESKTOP_STUB_CAPSULE_ENTRY = Object.freeze({
  id: DESKTOP_STUB_CAPSULE_ID,
  integrity: DESKTOP_STUB_CAPSULE_INTEGRITY,
  state: "installed",
  version: DESKTOP_STUB_CAPSULE_VERSION,
}) satisfies CapsuleEntry;

export type DesktopCapsuleReadResult =
  | {
      readonly ok: true;
      readonly entry?: CapsuleEntry;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export interface DesktopPackageProof {
  readonly packageClass: "desktop";
  readonly installed: boolean;
  readonly launched: boolean;
  readonly heartbeat: boolean;
  readonly headlessBoundary: boolean;
  readonly reason?: string;
}

type DesktopInstallResult =
  | {
      readonly ok: true;
      readonly entry: CapsuleEntry;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export type DesktopExecuteMeasurement =
  | {
      readonly ok: true;
      readonly unit: string;
      readonly dynamicUid: string;
      readonly volumes: readonly DesktopExecuteVolumeStatus[];
    }
  | {
      readonly ok: false;
    };

export interface DesktopExecuteVolumeStatus {
  readonly name: string;
  readonly path: string;
  readonly stateDirectory: string;
  readonly access: string;
  readonly mounted: "OK";
  readonly status: "OK";
}

export interface DesktopPackageProofOptions {
  readonly observeHeadlessBoundary: () => Promise<boolean>;
}

const DESKTOP_STUB_SESSION_REGISTRATION = Object.freeze({
  capsule: Object.freeze({
    entrypoint: "main.ts",
    executionPackageClass: "ts-service",
    id: DESKTOP_STUB_CAPSULE_ID,
    integrity: DESKTOP_STUB_CAPSULE_INTEGRITY,
    ref: DESKTOP_STUB_BUNDLE_REF,
    version: DESKTOP_STUB_CAPSULE_VERSION,
  }),
  heartbeatChannel: Object.freeze({
    capability: "capsule.execute",
    kind: "agentd.capsule-health",
  }),
  heartbeatIntervalMs: 1000,
  packageClass: "desktop",
  packageId: DESKTOP_STUB_CAPSULE_ID,
  packageVersion: DESKTOP_STUB_CAPSULE_VERSION,
  sessionId: DESKTOP_STUB_SESSION_ID,
  substrateVersion: "1.0.0",
}) satisfies DesktopSessionRegistration;

export async function readDesktopCapsuleEntry(
  client: Pick<AgentClient, "getState">,
): Promise<DesktopCapsuleReadResult> {
  try {
    const current = parseCapsuleRegistryReadResponse(await client.getState("capsule.registry"));

    if (!current.ok) {
      return {
        ok: false,
        reason: "registry_unreadable",
      };
    }

    for (let index = 0; index < current.registry.length; index += 1) {
      const entry = current.registry[index];

      if (entry !== undefined && entry.id === DESKTOP_STUB_CAPSULE_ID) {
        return {
          entry,
          ok: true,
        };
      }
    }

    return {
      ok: true,
    };
  } catch {
    return {
      ok: false,
      reason: "registry_unreadable",
    };
  }
}

export function mergeDesktopCapsuleRegistry(
  base: CapsuleRegistry,
  desktopEntry: CapsuleEntry | undefined,
): CapsuleRegistry {
  if (desktopEntry === undefined) {
    return base;
  }

  const merged: CapsuleEntry[] = [];
  let replaced = false;

  for (let index = 0; index < base.length; index += 1) {
    const entry = base[index];

    if (entry === undefined) {
      continue;
    }
    if (entry.id === desktopEntry.id) {
      merged[merged.length] = desktopEntry;
      replaced = true;
    } else {
      merged[merged.length] = entry;
    }
  }

  if (!replaced) {
    merged[merged.length] = desktopEntry;
  }

  return Object.freeze(merged);
}

export async function runDesktopPackageProof(
  client: Pick<AgentClient, "apply" | "getState">,
  options: DesktopPackageProofOptions,
): Promise<DesktopPackageProof> {
  try {
    const install = await installDesktopStubPackage(client);
    if (!install.ok) {
      return failed(install.reason);
    }

    const entry = install.entry;
    const launchResult = await client.apply(buildLaunchPlan(entry));
    if (launchResult.outcome !== "committed") {
      return failed(`launch_${agentApplyResultReason(launchResult)}`);
    }

    const launched = parseDesktopExecuteState(await client.getState("capsule.execute"), entry);
    if (!launched.ok) {
      await stopDesktopBestEffort(client, entry);
      return failed("launch_unmeasured");
    }

    const heartbeat = await readDesktopSessionHeartbeatThroughSubstrate({
      readCapsuleExecuteState: () => client.getState("capsule.execute"),
      registration: DESKTOP_STUB_SESSION_REGISTRATION,
    });
    if (!heartbeat.ok) {
      await stopDesktopBestEffort(client, entry);
      return failed(heartbeat.reason);
    }

    const stopResult = await client.apply(buildStopPlan(entry));
    if (stopResult.outcome !== "committed") {
      return failed(`stop_${agentApplyResultReason(stopResult)}`);
    }

    if (!(await options.observeHeadlessBoundary())) {
      return failed("headless_boundary_missing");
    }

    return {
      heartbeat: true,
      headlessBoundary: true,
      installed: true,
      launched: true,
      packageClass: "desktop",
    };
  } catch {
    return failed("transport_failed");
  }
}

async function installDesktopStubPackage(
  client: Pick<AgentClient, "apply" | "getState">,
): Promise<DesktopInstallResult> {
  const fetchResult = await client.apply(buildFetchPlan());
  if (fetchResult.outcome !== "committed") {
    return rejectInstall(`fetch_${agentApplyResultReason(fetchResult)}`);
  }

  if (!parseDesktopFetchState(await client.getState("capsule.fetch"))) {
    return rejectInstall("fetch_unmeasured");
  }

  const current = parseCapsuleRegistryReadResponse(await client.getState("capsule.registry"));
  if (!current.ok) {
    return rejectInstall("registry_unreadable");
  }

  const desiredRegistry = mergeDesktopCapsuleRegistry(current.registry, DESKTOP_STUB_CAPSULE_ENTRY);
  const installResult = await client.apply(buildInstallPlan(desiredRegistry));
  if (installResult.outcome !== "committed") {
    return rejectInstall(`install_${agentApplyResultReason(installResult)}`);
  }

  const installed = await readDesktopCapsuleEntry(client);
  if (!installed.ok) {
    return rejectInstall(installed.reason);
  }
  if (installed.entry === undefined || !sameCapsuleEntry(installed.entry, DESKTOP_STUB_CAPSULE_ENTRY)) {
    return rejectInstall("install_unmeasured");
  }

  return {
    entry: installed.entry,
    ok: true,
  };
}

function buildFetchPlan(): AgentApplyPlan {
  return Object.freeze({
    operations: Object.freeze([
      Object.freeze({
        capability: "capsule.fetch",
        request: Object.freeze({
          desired: Object.freeze({
            id: DESKTOP_STUB_CAPSULE_ID,
            integrity: DESKTOP_STUB_CAPSULE_INTEGRITY,
            ref: DESKTOP_STUB_BUNDLE_REF,
            version: DESKTOP_STUB_CAPSULE_VERSION,
          }),
        }),
      }),
    ]),
  }) satisfies AgentApplyPlan;
}

function buildInstallPlan(registry: CapsuleRegistry): AgentApplyPlan {
  const capsules = capsuleRegistryJson(registry);

  return Object.freeze({
    operations: Object.freeze([
      Object.freeze({
        capability: "capsule.registry",
        request: Object.freeze({
          desired: Object.freeze({
            capsules,
          }),
        }),
      }),
    ]),
  }) satisfies AgentApplyPlan;
}

function capsuleRegistryJson(
  registry: CapsuleRegistry,
): readonly Readonly<Record<string, string>>[] {
  const capsules: Readonly<Record<string, string>>[] = [];

  for (let index = 0; index < registry.length; index += 1) {
    const entry = registry[index];

    if (entry !== undefined) {
      capsules[capsules.length] = Object.freeze({
        id: entry.id,
        integrity: entry.integrity,
        state: entry.state,
        version: entry.version,
      });
    }
  }

  return Object.freeze(capsules);
}

export function formatDesktopPackageProofMarker(proof: DesktopPackageProof): string {
  if (proof.installed && proof.launched && proof.heartbeat && proof.headlessBoundary) {
    return (
      `${DESKTOP_PACKAGE_MARKER}: ` +
      "class=desktop installed=OK launched=OK heartbeat=OK headless-boundary=OK status=OK"
    );
  }

  return (
    `${DESKTOP_PACKAGE_MARKER}: ` +
    "class=desktop installed=FAIL launched=FAIL heartbeat=FAIL " +
    `headless-boundary=FAIL status=FAILSAFE reason=${markerToken(proof.reason ?? "desktop_not_measured")}`
  );
}

function buildLaunchPlan(entry: CapsuleEntry): AgentApplyPlan {
  return Object.freeze({
    operations: Object.freeze([
      Object.freeze({
        capability: "capsule.execute",
        request: Object.freeze({
          desired: Object.freeze({
            id: entry.id,
            integrity: entry.integrity,
            version: entry.version,
          }),
        }),
      }),
    ]),
  }) satisfies AgentApplyPlan;
}

function buildStopPlan(entry: CapsuleEntry): AgentApplyPlan {
  return Object.freeze({
    operations: Object.freeze([
      Object.freeze({
        capability: "capsule.lifecycle",
        request: Object.freeze({
          desired: Object.freeze({
            id: entry.id,
            op: "stop",
          }),
        }),
      }),
    ]),
  }) satisfies AgentApplyPlan;
}

function parseDesktopFetchState(state: AgentCapabilityState): boolean {
  const last = state["last"];

  if (!isRecord(last)) {
    return false;
  }

  return (
    last["id"] === DESKTOP_STUB_CAPSULE_ID &&
    last["version"] === DESKTOP_STUB_CAPSULE_VERSION &&
    last["integrity"] === DESKTOP_STUB_CAPSULE_INTEGRITY &&
    last["ref"] === DESKTOP_STUB_BUNDLE_REF &&
    last["status"] === "OK" &&
    typeof last["localPath"] === "string" &&
    last["localPath"].length > 0
  );
}

function parseDesktopExecuteState(
  state: AgentCapabilityState,
  entry: CapsuleEntry,
): DesktopExecuteMeasurement {
  const last = state["last"];

  if (!isRecord(last)) {
    return { ok: false };
  }

  const unit = last["unit"];
  const dynamicUid = last["dynamicUid"];
  const volumes = parseDesktopExecuteVolumes(last["volumes"]);

  if (
    last["id"] !== entry.id ||
    last["version"] !== entry.version ||
    last["integrity"] !== entry.integrity ||
    last["status"] !== "OK" ||
    last["health"] !== "OK" ||
    typeof unit !== "string" ||
    unit.length === 0 ||
    typeof dynamicUid !== "string" ||
    dynamicUid.length === 0 ||
    volumes === undefined
  ) {
    return { ok: false };
  }

  return {
    dynamicUid,
    ok: true,
    unit,
    volumes,
  };
}

function parseDesktopExecuteVolumes(value: unknown): readonly DesktopExecuteVolumeStatus[] | undefined {
  if (value === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const volumes: DesktopExecuteVolumeStatus[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];

    if (!isRecord(item)) {
      return undefined;
    }

    const volume = parseDesktopExecuteVolume(item);
    if (volume === undefined) {
      return undefined;
    }

    volumes[volumes.length] = volume;
  }

  return Object.freeze(volumes);
}

function parseDesktopExecuteVolume(
  value: Readonly<Record<string, unknown>>,
): DesktopExecuteVolumeStatus | undefined {
  const name = readStringField(value, "name");
  const path = readStringField(value, "path");
  const stateDirectory = readStringField(value, "stateDirectory");
  const access = readStringField(value, "access");
  const mounted = readStringField(value, "mounted");
  const status = readStringField(value, "status");

  if (
    name === undefined ||
    path === undefined ||
    stateDirectory === undefined ||
    access === undefined ||
    mounted !== "OK" ||
    status !== "OK"
  ) {
    return undefined;
  }

  return {
    access,
    mounted,
    name,
    path,
    stateDirectory,
    status,
  };
}

async function stopDesktopBestEffort(
  client: Pick<AgentClient, "apply">,
  entry: CapsuleEntry,
): Promise<void> {
  try {
    await client.apply(buildStopPlan(entry));
  } catch {
    // The caller reports the measured failure that required cleanup.
  }
}

function rejectInstall(reason: string): DesktopInstallResult {
  return {
    ok: false,
    reason,
  };
}

function sameCapsuleEntry(left: CapsuleEntry, right: CapsuleEntry): boolean {
  return (
    left.id === right.id &&
    left.version === right.version &&
    left.integrity === right.integrity &&
    left.state === right.state
  );
}

function failed(reason: string): DesktopPackageProof {
  return {
    heartbeat: false,
    headlessBoundary: false,
    installed: false,
    launched: false,
    packageClass: "desktop",
    reason: markerToken(reason),
  };
}

function agentApplyResultReason(result: AgentApplyResult): string {
  const error = result.error;
  if (error === undefined) {
    return "transaction_rejected";
  }
  return markerToken(error.code.length > 0 ? error.code : "transaction_rejected");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readStringField(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const child = value[key];

  if (typeof child !== "string" || child.length === 0) {
    return undefined;
  }

  return child;
}

function markerToken(value: string): string {
  const token = value.replace(/[^A-Za-z0-9_.:-]+/gu, "_");
  return token.length === 0 ? "unknown" : token;
}
