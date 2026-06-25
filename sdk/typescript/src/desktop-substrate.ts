import { safeNormalize } from "./safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "./safe-normalize.ts";

export const DESKTOP_PACKAGE_CLASS = "desktop";
export const DESKTOP_SUBSTRATE_INTERFACE_ID = "com.vita.desktop-substrate";
export const DESKTOP_SUBSTRATE_VERSION = "1.0.0";
export const DESKTOP_PACKAGE_MARKER = "VITA-DESKTOP-PKG";
export const DESKTOP_COMPOSITOR_INTERFACE_ID = "com.vita.desktop-substrate.compositor";
export const DESKTOP_COMPOSITOR_VERSION = "0.1.0";
export const DESKTOP_COMPOSITOR_MARKER = "VITA-COMPOSITOR";

export type DesktopPackageClass = typeof DESKTOP_PACKAGE_CLASS;
export type DesktopCapsuleExecutionPackageClass = "ts-service";
export type DesktopCapsuleState = "installed" | "disabled";
export type DesktopSessionState = "registered" | "running" | "stopped";
export type DesktopSubstrateOperation = "discover" | "launch" | "stop" | "heartbeat";
export type DesktopSubstrateCapability =
  | "capsule.registry"
  | "capsule.execute"
  | "capsule.lifecycle"
  | "desktop.session";
export type DesktopCompositorOperation =
  | "register-surface"
  | "update-placements"
  | "set-focus"
  | "input-events";
export type DesktopCompositorCapability =
  | "gpu-texture.registry"
  | "gpu-texture.composite"
  | "desktop.input";
export type DesktopCompositorMode = "drm-kms" | "headless-test";
export type DesktopCompositorStatus = "OK" | "FAILSAFE";
export type DesktopCompositorPresent = "kms" | "recording" | "unverified";
export type DesktopGpuTextureFormat = "rgba8-unorm";
export type DesktopGpuTextureHandleKind =
  | "drm-prime-fd"
  | "opaque-native-texture"
  | "test-only";
export type DesktopInputButtonState = "pressed" | "released";

export interface DesktopSubstrateDescriptor {
  readonly interfaceId: typeof DESKTOP_SUBSTRATE_INTERFACE_ID;
  readonly version: typeof DESKTOP_SUBSTRATE_VERSION;
  readonly headlessSafe: true;
  readonly operations: readonly DesktopSubstrateOperation[];
  readonly capabilities: readonly DesktopSubstrateCapability[];
}

export interface DesktopSubstrateRequirement {
  readonly interfaceId: typeof DESKTOP_SUBSTRATE_INTERFACE_ID;
  readonly version: typeof DESKTOP_SUBSTRATE_VERSION;
  readonly operations: readonly DesktopSubstrateOperation[];
  readonly capabilities: readonly DesktopSubstrateCapability[];
}

export interface DesktopCompositorSubstrateDescriptor {
  readonly interfaceId: typeof DESKTOP_SUBSTRATE_INTERFACE_ID;
  readonly extensionInterfaceId: typeof DESKTOP_COMPOSITOR_INTERFACE_ID;
  readonly version: typeof DESKTOP_COMPOSITOR_VERSION;
  readonly mode: DesktopCompositorMode;
  readonly operations: readonly DesktopCompositorOperation[];
  readonly capabilities: readonly DesktopCompositorCapability[];
  readonly cpuReadback: "tests-screenshots-only";
}

export interface DesktopGpuTextureHandle {
  readonly kind: DesktopGpuTextureHandleKind;
  readonly value: number;
  readonly width: number;
  readonly height: number;
  readonly format: DesktopGpuTextureFormat;
}

export interface DesktopSurfaceRegistrationRequest {
  readonly surfaceId: string;
  readonly width: number;
  readonly height: number;
  readonly format: DesktopGpuTextureFormat;
}

export interface DesktopSurfaceRegistration {
  readonly surfaceId: string;
  readonly texture: DesktopGpuTextureHandle;
}

export interface DesktopSurfacePlacement {
  readonly surfaceId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly zIndex: number;
  readonly opacity?: number;
}

export interface DesktopDamageRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DesktopPlacementUpdate {
  readonly sequence: number;
  readonly placements: readonly DesktopSurfacePlacement[];
}

export interface DesktopPlacementUpdateResult {
  readonly sequence: number;
  readonly composited: true;
  readonly damage: readonly DesktopDamageRect[];
}

export interface DesktopFocusRequest {
  readonly surfaceId: string | null;
}

export type DesktopInputEvent =
  | {
      readonly kind: "key";
      readonly keyCode: number;
      readonly pressed: boolean;
    }
  | {
      readonly kind: "pointer-button";
      readonly button: number;
      readonly state: DesktopInputButtonState;
    }
  | {
      readonly kind: "pointer-motion";
      readonly dxMicropixels: number;
      readonly dyMicropixels: number;
    };

export interface DesktopCompositorMeasurement {
  readonly marker: typeof DESKTOP_COMPOSITOR_MARKER;
  readonly gpu: string;
  readonly surfaces: number;
  readonly composited: "OK" | "FAIL";
  readonly reposition: "no-repaint" | "unverified";
  readonly present: DesktopCompositorPresent;
  readonly damage: "OK" | "FAIL";
  readonly status: DesktopCompositorStatus;
  readonly reason?: string;
}

export interface DesktopNativeCompositorSubstrate {
  readonly descriptor: DesktopCompositorSubstrateDescriptor;
  readonly registerSurface: (
    request: DesktopSurfaceRegistrationRequest,
  ) => Promise<DesktopSurfaceRegistration>;
  readonly updatePlacements: (
    update: DesktopPlacementUpdate,
  ) => Promise<DesktopPlacementUpdateResult>;
  readonly setFocus: (request: DesktopFocusRequest) => Promise<void>;
  readonly inputEvents: AsyncIterable<DesktopInputEvent>;
}

export interface DesktopCapsuleRuntimeRef {
  readonly id: string;
  readonly version: string;
  readonly integrity: DesktopCapsuleIntegrity;
  readonly ref: string;
  readonly executionPackageClass: DesktopCapsuleExecutionPackageClass;
  readonly entrypoint: string;
}

export interface DesktopPackageSecurity {
  readonly unprivileged: true;
  readonly dynamicUser: true;
  readonly capabilities: readonly [];
  readonly seccompProfile: "capsule-default";
  readonly network: "none";
}

export interface DesktopSessionDeclaration {
  readonly id: string;
  readonly heartbeatIntervalMs: number;
  readonly heartbeatChannel: DesktopSessionHeartbeatChannel;
}

export interface DesktopSessionHeartbeatChannel {
  readonly kind: "agentd.capsule-health";
  readonly capability: "capsule.execute";
}

export interface DesktopPackageManifest {
  readonly packageClass: DesktopPackageClass;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly substrate: DesktopSubstrateRequirement;
  readonly capsule: DesktopCapsuleRuntimeRef;
  readonly security: DesktopPackageSecurity;
  readonly session: DesktopSessionDeclaration;
}

export interface DesktopCapsuleRegistryEntry {
  readonly id: string;
  readonly version: string;
  readonly integrity: DesktopCapsuleIntegrity;
  readonly state: DesktopCapsuleState;
}

export interface DesktopSessionRegistration {
  readonly packageId: string;
  readonly packageClass: DesktopPackageClass;
  readonly packageVersion: string;
  readonly sessionId: string;
  readonly substrateVersion: typeof DESKTOP_SUBSTRATE_VERSION;
  readonly heartbeatIntervalMs: number;
  readonly heartbeatChannel: DesktopSessionHeartbeatChannel;
  readonly capsule: DesktopCapsuleRuntimeRef;
}

export interface DesktopSessionHeartbeat {
  readonly packageId: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly nonce: string;
  readonly state: "running";
}

export interface DesktopSessionHeartbeatObservation {
  readonly packageId: string;
  readonly sessionId: string;
  readonly capsuleId: string;
  readonly version: string;
  readonly integrity: DesktopCapsuleIntegrity;
  readonly unit: string;
  readonly dynamicUid: string;
  readonly state: "running";
  readonly health: "OK";
}

export interface DesktopPackageProof {
  readonly packageClass: DesktopPackageClass;
  readonly installed: boolean;
  readonly launched: boolean;
  readonly heartbeat: boolean;
  readonly headlessBoundary: boolean;
  readonly reason?: string;
}

export interface DesktopSubstrateValidationError {
  readonly path: string;
  readonly message: string;
}

export type DesktopSubstrateValidationResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly errors: readonly DesktopSubstrateValidationError[];
    };

export interface DesktopInstallPlan {
  readonly operations: readonly {
    readonly capability: "capsule.registry";
    readonly request: {
      readonly desired: {
        readonly capsules: readonly DesktopCapsuleRegistryEntry[];
      };
    };
  }[];
}

export interface DesktopLaunchPlan {
  readonly operations: readonly {
    readonly capability: "capsule.execute";
    readonly request: {
      readonly desired: {
        readonly id: string;
        readonly version: string;
        readonly integrity: DesktopCapsuleIntegrity;
      };
    };
  }[];
}

export interface DesktopStopPlan {
  readonly operations: readonly {
    readonly capability: "capsule.lifecycle";
    readonly request: {
      readonly desired: {
        readonly op: "stop";
        readonly id: string;
      };
    };
  }[];
}

export type DesktopCapsuleIntegrity =
  | `sha256-${string}`
  | `sha384-${string}`
  | `sha512-${string}`;

const DESKTOP_OPERATIONS = Object.freeze([
  "discover",
  "launch",
  "stop",
  "heartbeat",
] as const);
const DESKTOP_CAPABILITIES = Object.freeze([
  "capsule.registry",
  "capsule.execute",
  "capsule.lifecycle",
  "desktop.session",
] as const);
const DESKTOP_MANIFEST_FIELDS = Object.freeze([
  "capsule",
  "id",
  "name",
  "packageClass",
  "security",
  "session",
  "substrate",
  "version",
]);
const SUBSTRATE_DESCRIPTOR_FIELDS = Object.freeze([
  "capabilities",
  "headlessSafe",
  "interfaceId",
  "operations",
  "version",
]);
const SUBSTRATE_REQUIREMENT_FIELDS = Object.freeze([
  "capabilities",
  "interfaceId",
  "operations",
  "version",
]);
const CAPSULE_FIELDS = Object.freeze([
  "entrypoint",
  "executionPackageClass",
  "id",
  "integrity",
  "ref",
  "version",
]);
const SECURITY_FIELDS = Object.freeze([
  "capabilities",
  "dynamicUser",
  "network",
  "seccompProfile",
  "unprivileged",
]);
const SESSION_FIELDS = Object.freeze(["heartbeatChannel", "heartbeatIntervalMs", "id"]);
const HEARTBEAT_CHANNEL_FIELDS = Object.freeze(["capability", "kind"]);
const REGISTRATION_FIELDS = Object.freeze([
  "capsule",
  "heartbeatChannel",
  "heartbeatIntervalMs",
  "packageClass",
  "packageId",
  "packageVersion",
  "sessionId",
  "substrateVersion",
]);
const HEARTBEAT_FIELDS = Object.freeze([
  "nonce",
  "packageId",
  "sequence",
  "sessionId",
  "state",
  "timestamp",
]);

export const DEFAULT_DESKTOP_SUBSTRATE_DESCRIPTOR: DesktopSubstrateDescriptor =
  Object.freeze({
    capabilities: DESKTOP_CAPABILITIES,
    headlessSafe: true,
    interfaceId: DESKTOP_SUBSTRATE_INTERFACE_ID,
    operations: DESKTOP_OPERATIONS,
    version: DESKTOP_SUBSTRATE_VERSION,
  });

export function validateDesktopSubstrateDescriptor(
  input: unknown,
): DesktopSubstrateValidationResult<DesktopSubstrateDescriptor> {
  const errors: DesktopSubstrateValidationError[] = [];
  const value = normalizeObject(input, errors);

  if (value === undefined) {
    return reject(errors);
  }

  rejectUnknownFields(value, SUBSTRATE_DESCRIPTOR_FIELDS, [], errors);
  const interfaceId = readRequiredString(value, "interfaceId", ["interfaceId"], errors);
  const version = readRequiredString(value, "version", ["version"], errors);
  const headlessSafe = readRequiredBoolean(value, "headlessSafe", ["headlessSafe"], errors);
  const operations = readRequiredEnumArray(
    value,
    "operations",
    DESKTOP_OPERATIONS,
    ["operations"],
    errors,
  );
  const capabilities = readRequiredEnumArray(
    value,
    "capabilities",
    DESKTOP_CAPABILITIES,
    ["capabilities"],
    errors,
  );

  if (interfaceId !== undefined && interfaceId !== DESKTOP_SUBSTRATE_INTERFACE_ID) {
    addError(errors, ["interfaceId"], "Expected desktop substrate interface id.");
  }
  if (version !== undefined && version !== DESKTOP_SUBSTRATE_VERSION) {
    addError(errors, ["version"], "Expected supported desktop substrate version.");
  }
  if (headlessSafe !== undefined && headlessSafe !== true) {
    addError(errors, ["headlessSafe"], "Desktop substrate must be headless-safe.");
  }
  requireAllOperations(operations, ["operations"], errors);
  requireAllCapabilities(capabilities, ["capabilities"], errors);

  if (
    errors.length > 0 ||
    interfaceId !== DESKTOP_SUBSTRATE_INTERFACE_ID ||
    version !== DESKTOP_SUBSTRATE_VERSION ||
    headlessSafe !== true ||
    operations === undefined ||
    capabilities === undefined
  ) {
    return reject(errors);
  }

  return accept(
    Object.freeze({
      capabilities,
      headlessSafe,
      interfaceId,
      operations,
      version,
    }),
  );
}

export function validateDesktopPackageManifest(
  input: unknown,
): DesktopSubstrateValidationResult<DesktopPackageManifest> {
  const errors: DesktopSubstrateValidationError[] = [];
  const value = normalizeObject(input, errors);

  if (value === undefined) {
    return reject(errors);
  }

  rejectUnknownFields(value, DESKTOP_MANIFEST_FIELDS, [], errors);
  const packageClass = readRequiredString(value, "packageClass", ["packageClass"], errors);
  const id = readRequiredString(value, "id", ["id"], errors);
  const name = readRequiredString(value, "name", ["name"], errors);
  const version = readRequiredString(value, "version", ["version"], errors);
  const substrate = readSubstrateRequirement(value, "substrate", ["substrate"], errors);
  const capsule = readCapsuleRuntimeRef(value, "capsule", ["capsule"], errors);
  const security = readPackageSecurity(value, "security", ["security"], errors);
  const session = readSessionDeclaration(value, "session", ["session"], errors);

  if (packageClass !== undefined && packageClass !== DESKTOP_PACKAGE_CLASS) {
    addError(errors, ["packageClass"], "Expected desktop package class.");
  }
  if (id !== undefined && !validDesktopId(id)) {
    addError(errors, ["id"], "Expected safe desktop package id.");
  }
  if (version !== undefined && !validVersion(version)) {
    addError(errors, ["version"], "Expected safe desktop package version.");
  }

  if (
    errors.length > 0 ||
    packageClass !== DESKTOP_PACKAGE_CLASS ||
    id === undefined ||
    name === undefined ||
    version === undefined ||
    substrate === undefined ||
    capsule === undefined ||
    security === undefined ||
    session === undefined
  ) {
    return reject(errors);
  }

  return accept(
    Object.freeze({
      capsule,
      id,
      name,
      packageClass,
      security,
      session,
      substrate,
      version,
    }),
  );
}

export function validateDesktopSessionRegistration(
  input: unknown,
): DesktopSubstrateValidationResult<DesktopSessionRegistration> {
  const errors: DesktopSubstrateValidationError[] = [];
  const value = normalizeObject(input, errors);

  if (value === undefined) {
    return reject(errors);
  }

  rejectUnknownFields(value, REGISTRATION_FIELDS, [], errors);
  const packageId = readRequiredString(value, "packageId", ["packageId"], errors);
  const packageClass = readRequiredString(value, "packageClass", ["packageClass"], errors);
  const packageVersion = readRequiredString(value, "packageVersion", ["packageVersion"], errors);
  const sessionId = readRequiredString(value, "sessionId", ["sessionId"], errors);
  const substrateVersion = readRequiredString(value, "substrateVersion", ["substrateVersion"], errors);
  const heartbeatIntervalMs = readRequiredPositiveInteger(
    value,
    "heartbeatIntervalMs",
    ["heartbeatIntervalMs"],
    errors,
  );
  const heartbeatChannel = readHeartbeatChannel(value, "heartbeatChannel", ["heartbeatChannel"], errors);
  const capsule = readCapsuleRuntimeRef(value, "capsule", ["capsule"], errors);

  if (packageId !== undefined && !validDesktopId(packageId)) {
    addError(errors, ["packageId"], "Expected safe desktop package id.");
  }
  if (packageClass !== undefined && packageClass !== DESKTOP_PACKAGE_CLASS) {
    addError(errors, ["packageClass"], "Expected desktop package class.");
  }
  if (packageVersion !== undefined && !validVersion(packageVersion)) {
    addError(errors, ["packageVersion"], "Expected safe desktop package version.");
  }
  if (sessionId !== undefined && !validSessionId(sessionId)) {
    addError(errors, ["sessionId"], "Expected safe desktop session id.");
  }
  if (substrateVersion !== undefined && substrateVersion !== DESKTOP_SUBSTRATE_VERSION) {
    addError(errors, ["substrateVersion"], "Expected supported desktop substrate version.");
  }

  if (
    errors.length > 0 ||
    packageId === undefined ||
    packageClass !== DESKTOP_PACKAGE_CLASS ||
    packageVersion === undefined ||
    sessionId === undefined ||
    substrateVersion !== DESKTOP_SUBSTRATE_VERSION ||
    heartbeatIntervalMs === undefined ||
    heartbeatChannel === undefined ||
    capsule === undefined
  ) {
    return reject(errors);
  }

  return accept(
    Object.freeze({
      capsule,
      heartbeatChannel,
      heartbeatIntervalMs,
      packageClass,
      packageId,
      packageVersion,
      sessionId,
      substrateVersion,
    }),
  );
}

export function validateDesktopSessionHeartbeat(
  input: unknown,
): DesktopSubstrateValidationResult<DesktopSessionHeartbeat> {
  const errors: DesktopSubstrateValidationError[] = [];
  const value = normalizeObject(input, errors);

  if (value === undefined) {
    return reject(errors);
  }

  rejectUnknownFields(value, HEARTBEAT_FIELDS, [], errors);
  const packageId = readRequiredString(value, "packageId", ["packageId"], errors);
  const sessionId = readRequiredString(value, "sessionId", ["sessionId"], errors);
  const sequence = readRequiredPositiveInteger(value, "sequence", ["sequence"], errors);
  const timestamp = readRequiredString(value, "timestamp", ["timestamp"], errors);
  const nonce = readRequiredString(value, "nonce", ["nonce"], errors);
  const state = readRequiredString(value, "state", ["state"], errors);

  if (packageId !== undefined && !validDesktopId(packageId)) {
    addError(errors, ["packageId"], "Expected safe desktop package id.");
  }
  if (sessionId !== undefined && !validSessionId(sessionId)) {
    addError(errors, ["sessionId"], "Expected safe desktop session id.");
  }
  if (timestamp !== undefined && !validHeartbeatTimestamp(timestamp)) {
    addError(errors, ["timestamp"], "Expected ISO timestamp string.");
  }
  if (nonce !== undefined && !validHeartbeatNonce(nonce)) {
    addError(errors, ["nonce"], "Expected safe heartbeat nonce.");
  }
  if (state !== undefined && state !== "running") {
    addError(errors, ["state"], "Expected running heartbeat state.");
  }

  if (
    errors.length > 0 ||
    packageId === undefined ||
    sessionId === undefined ||
    sequence === undefined ||
    timestamp === undefined ||
    nonce === undefined ||
    state !== "running"
  ) {
    return reject(errors);
  }

  return accept(
    Object.freeze({
      packageId,
      nonce,
      sequence,
      sessionId,
      state,
      timestamp,
    }),
  );
}

export function desktopPackageToSessionRegistration(
  manifest: DesktopPackageManifest,
): DesktopSessionRegistration {
  return Object.freeze({
    capsule: manifest.capsule,
    heartbeatChannel: manifest.session.heartbeatChannel,
    heartbeatIntervalMs: manifest.session.heartbeatIntervalMs,
    packageClass: DESKTOP_PACKAGE_CLASS,
    packageId: manifest.id,
    packageVersion: manifest.version,
    sessionId: manifest.session.id,
    substrateVersion: DESKTOP_SUBSTRATE_VERSION,
  });
}

export function desktopPackageToCapsuleEntry(
  manifest: DesktopPackageManifest,
): DesktopCapsuleRegistryEntry {
  return Object.freeze({
    id: manifest.capsule.id,
    integrity: manifest.capsule.integrity,
    state: "installed",
    version: manifest.capsule.version,
  });
}

export function buildDesktopInstallPlan(
  manifest: DesktopPackageManifest,
  current: readonly DesktopCapsuleRegistryEntry[] = Object.freeze([]),
): DesktopInstallPlan {
  const desiredEntry = desktopPackageToCapsuleEntry(manifest);
  const capsules = upsertCapsuleEntry(current, desiredEntry);

  return Object.freeze({
    operations: Object.freeze([
      Object.freeze({
        capability: "capsule.registry" as const,
        request: Object.freeze({
          desired: Object.freeze({
            capsules,
          }),
        }),
      }),
    ]),
  });
}

export function buildDesktopLaunchPlan(manifest: DesktopPackageManifest): DesktopLaunchPlan {
  return Object.freeze({
    operations: Object.freeze([
      Object.freeze({
        capability: "capsule.execute" as const,
        request: Object.freeze({
          desired: Object.freeze({
            id: manifest.capsule.id,
            integrity: manifest.capsule.integrity,
            version: manifest.capsule.version,
          }),
        }),
      }),
    ]),
  });
}

export function buildDesktopStopPlan(manifest: DesktopPackageManifest): DesktopStopPlan {
  return Object.freeze({
    operations: Object.freeze([
      Object.freeze({
        capability: "capsule.lifecycle" as const,
        request: Object.freeze({
          desired: Object.freeze({
            id: manifest.capsule.id,
            op: "stop" as const,
          }),
        }),
      }),
    ]),
  });
}

export function createDesktopSessionHeartbeat(
  registration: DesktopSessionRegistration,
  sequence: number,
  timestamp: string,
  nonce: string,
): DesktopSessionHeartbeat {
  return Object.freeze({
    nonce,
    packageId: registration.packageId,
    sequence,
    sessionId: registration.sessionId,
    state: "running" as const,
    timestamp,
  });
}

export function formatDesktopHeartbeat(heartbeat: DesktopSessionHeartbeat): string {
  return (
    "VITA-DESKTOP-HEARTBEAT: " +
    `id=${markerToken(heartbeat.packageId)} ` +
    `session=${markerToken(heartbeat.sessionId)} ` +
    `sequence=${heartbeat.sequence} ` +
    `timestamp=${markerToken(heartbeat.timestamp)} ` +
    `nonce=${markerToken(heartbeat.nonce)} ` +
    "state=running status=OK"
  );
}

export interface DesktopSessionHeartbeatReadOptions {
  readonly registration: DesktopSessionRegistration;
  readonly readCapsuleExecuteState: () => Promise<unknown>;
}

export type DesktopSessionHeartbeatReadResult =
  | {
      readonly ok: true;
      readonly heartbeat: DesktopSessionHeartbeatObservation;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export async function readDesktopSessionHeartbeatThroughSubstrate(
  options: DesktopSessionHeartbeatReadOptions,
): Promise<DesktopSessionHeartbeatReadResult> {
  let state: unknown;
  try {
    state = await options.readCapsuleExecuteState();
  } catch {
    return Object.freeze({
      ok: false,
      reason: "heartbeat_unreadable",
    });
  }

  const heartbeat = validateDesktopSessionHeartbeatObservation(options.registration, state);
  if (!heartbeat.ok) {
    return Object.freeze({
      ok: false,
      reason: "heartbeat_unhealthy",
    });
  }

  return Object.freeze({
    heartbeat: heartbeat.value,
    ok: true,
  });
}

export function validateDesktopSessionHeartbeatObservation(
  registration: DesktopSessionRegistration,
  input: unknown,
): DesktopSubstrateValidationResult<DesktopSessionHeartbeatObservation> {
  const errors: DesktopSubstrateValidationError[] = [];
  const value = normalizeObject(input, errors);

  if (value === undefined) {
    return reject(errors);
  }

  const last = readRequiredObject(value, "last", ["last"], errors);
  if (last === undefined) {
    return reject(errors);
  }

  const capsuleId = readRequiredString(last, "id", ["last", "id"], errors);
  const version = readRequiredString(last, "version", ["last", "version"], errors);
  const integrity = readRequiredString(last, "integrity", ["last", "integrity"], errors);
  const unit = readRequiredString(last, "unit", ["last", "unit"], errors);
  const dynamicUid = readRequiredString(last, "dynamicUid", ["last", "dynamicUid"], errors);
  const status = readRequiredString(last, "status", ["last", "status"], errors);
  const health = readRequiredString(last, "health", ["last", "health"], errors);

  if (capsuleId !== undefined && capsuleId !== registration.capsule.id) {
    addError(errors, ["last", "id"], "Expected launched desktop capsule id.");
  }
  if (version !== undefined && version !== registration.capsule.version) {
    addError(errors, ["last", "version"], "Expected launched desktop capsule version.");
  }
  if (integrity !== undefined && integrity !== registration.capsule.integrity) {
    addError(errors, ["last", "integrity"], "Expected launched desktop capsule integrity.");
  }
  if (status !== undefined && status !== "OK") {
    addError(errors, ["last", "status"], "Expected running desktop capsule status.");
  }
  if (health !== undefined && health !== "OK") {
    addError(errors, ["last", "health"], "Expected healthy desktop capsule state.");
  }

  if (
    errors.length > 0 ||
    capsuleId !== registration.capsule.id ||
    version !== registration.capsule.version ||
    integrity !== registration.capsule.integrity ||
    !isCapsuleIntegrity(integrity) ||
    unit === undefined ||
    dynamicUid === undefined ||
    status !== "OK" ||
    health !== "OK"
  ) {
    return reject(errors);
  }

  return accept(
    Object.freeze({
      capsuleId,
      dynamicUid,
      health,
      integrity,
      packageId: registration.packageId,
      sessionId: registration.sessionId,
      state: "running" as const,
      unit,
      version,
    }),
  );
}

export function formatDesktopPackageMarker(proof: DesktopPackageProof): string {
  if (
    proof.packageClass === DESKTOP_PACKAGE_CLASS &&
    proof.installed &&
    proof.launched &&
    proof.heartbeat &&
    proof.headlessBoundary
  ) {
    return (
      `${DESKTOP_PACKAGE_MARKER}: ` +
      "class=desktop installed=OK launched=OK heartbeat=OK headless-boundary=OK status=OK"
    );
  }

  const reason = markerToken(proof.reason ?? "desktop_package_not_measured");
  return (
    `${DESKTOP_PACKAGE_MARKER}: ` +
    "class=desktop installed=FAIL launched=FAIL heartbeat=FAIL " +
    `headless-boundary=FAIL status=FAILSAFE reason=${reason}`
  );
}

export function formatDesktopCompositorMarker(measurement: DesktopCompositorMeasurement): string {
  const nativeOnlyKmsOk = measurement.present === "kms" && measurement.status === "OK";
  const composited = nativeOnlyKmsOk ? "FAIL" : measurement.composited;
  const reposition = nativeOnlyKmsOk ? "unverified" : measurement.reposition;
  const damage = nativeOnlyKmsOk ? "FAIL" : measurement.damage;
  const status: DesktopCompositorStatus = nativeOnlyKmsOk ? "FAILSAFE" : measurement.status;
  const base =
    `${DESKTOP_COMPOSITOR_MARKER}: ` +
    `gpu=${markerToken(measurement.gpu)} ` +
    `surfaces=${measurement.surfaces} ` +
    `composited=${composited} ` +
    `reposition=${reposition} ` +
    `present=${measurement.present} ` +
    `damage=${damage} ` +
    `status=${status}`;

  if (status === "OK") {
    return base;
  }

  const reason = nativeOnlyKmsOk
    ? "native_kms_marker_only"
    : measurement.reason ?? "unavailable";
  return `${base} reason=${markerToken(reason)}`;
}

function readSubstrateRequirement(
  value: PlainJsonObject,
  key: string,
  path: readonly string[],
  errors: DesktopSubstrateValidationError[],
): DesktopSubstrateRequirement | undefined {
  const child = readRequiredObject(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  rejectUnknownFields(child, SUBSTRATE_REQUIREMENT_FIELDS, path, errors);
  const interfaceId = readRequiredString(child, "interfaceId", [...path, "interfaceId"], errors);
  const version = readRequiredString(child, "version", [...path, "version"], errors);
  const operations = readRequiredEnumArray(
    child,
    "operations",
    DESKTOP_OPERATIONS,
    [...path, "operations"],
    errors,
  );
  const capabilities = readRequiredEnumArray(
    child,
    "capabilities",
    DESKTOP_CAPABILITIES,
    [...path, "capabilities"],
    errors,
  );

  if (interfaceId !== undefined && interfaceId !== DESKTOP_SUBSTRATE_INTERFACE_ID) {
    addError(errors, [...path, "interfaceId"], "Expected desktop substrate interface id.");
  }
  if (version !== undefined && version !== DESKTOP_SUBSTRATE_VERSION) {
    addError(errors, [...path, "version"], "Expected supported desktop substrate version.");
  }
  requireAllOperations(operations, [...path, "operations"], errors);
  requireAllCapabilities(capabilities, [...path, "capabilities"], errors);

  if (
    interfaceId !== DESKTOP_SUBSTRATE_INTERFACE_ID ||
    version !== DESKTOP_SUBSTRATE_VERSION ||
    operations === undefined ||
    capabilities === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    capabilities,
    interfaceId,
    operations,
    version,
  });
}

function readCapsuleRuntimeRef(
  value: PlainJsonObject,
  key: string,
  path: readonly string[],
  errors: DesktopSubstrateValidationError[],
): DesktopCapsuleRuntimeRef | undefined {
  const child = readRequiredObject(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  rejectUnknownFields(child, CAPSULE_FIELDS, path, errors);
  const id = readRequiredString(child, "id", [...path, "id"], errors);
  const version = readRequiredString(child, "version", [...path, "version"], errors);
  const integrity = readRequiredString(child, "integrity", [...path, "integrity"], errors);
  const ref = readRequiredString(child, "ref", [...path, "ref"], errors);
  const executionPackageClass = readRequiredString(
    child,
    "executionPackageClass",
    [...path, "executionPackageClass"],
    errors,
  );
  const entrypoint = readRequiredString(child, "entrypoint", [...path, "entrypoint"], errors);

  if (id !== undefined && !validDesktopId(id)) {
    addError(errors, [...path, "id"], "Expected safe desktop capsule id.");
  }
  if (version !== undefined && !validVersion(version)) {
    addError(errors, [...path, "version"], "Expected safe desktop capsule version.");
  }
  if (integrity !== undefined && !isCapsuleIntegrity(integrity)) {
    addError(errors, [...path, "integrity"], "Expected SRI capsule integrity.");
  }
  if (ref !== undefined && !validReference(ref)) {
    addError(errors, [...path, "ref"], "Expected package/capsule reference URI.");
  }
  if (executionPackageClass !== undefined && executionPackageClass !== "ts-service") {
    addError(errors, [...path, "executionPackageClass"], "Expected ts-service capsule execution class.");
  }
  if (entrypoint !== undefined && !validRelativeEntrypoint(entrypoint)) {
    addError(errors, [...path, "entrypoint"], "Expected safe relative TypeScript entrypoint.");
  }

  if (
    id === undefined ||
    version === undefined ||
    !isCapsuleIntegrity(integrity) ||
    ref === undefined ||
    executionPackageClass !== "ts-service" ||
    entrypoint === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    entrypoint,
    executionPackageClass,
    id,
    integrity,
    ref,
    version,
  });
}

function readPackageSecurity(
  value: PlainJsonObject,
  key: string,
  path: readonly string[],
  errors: DesktopSubstrateValidationError[],
): DesktopPackageSecurity | undefined {
  const child = readRequiredObject(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  rejectUnknownFields(child, SECURITY_FIELDS, path, errors);
  const unprivileged = readRequiredBoolean(child, "unprivileged", [...path, "unprivileged"], errors);
  const dynamicUser = readRequiredBoolean(child, "dynamicUser", [...path, "dynamicUser"], errors);
  const capabilities = readRequiredEmptyArray(child, "capabilities", [...path, "capabilities"], errors);
  const seccompProfile = readRequiredString(child, "seccompProfile", [...path, "seccompProfile"], errors);
  const network = readRequiredString(child, "network", [...path, "network"], errors);

  if (unprivileged !== undefined && unprivileged !== true) {
    addError(errors, [...path, "unprivileged"], "Desktop package must be unprivileged.");
  }
  if (dynamicUser !== undefined && dynamicUser !== true) {
    addError(errors, [...path, "dynamicUser"], "Desktop package must use DynamicUser.");
  }
  if (seccompProfile !== undefined && seccompProfile !== "capsule-default") {
    addError(errors, [...path, "seccompProfile"], "Expected capsule default seccomp profile.");
  }
  if (network !== undefined && network !== "none") {
    addError(errors, [...path, "network"], "Desktop stub must not request network.");
  }

  if (
    unprivileged !== true ||
    dynamicUser !== true ||
    capabilities === undefined ||
    seccompProfile !== "capsule-default" ||
    network !== "none"
  ) {
    return undefined;
  }

  return Object.freeze({
    capabilities,
    dynamicUser,
    network,
    seccompProfile,
    unprivileged,
  });
}

function readSessionDeclaration(
  value: PlainJsonObject,
  key: string,
  path: readonly string[],
  errors: DesktopSubstrateValidationError[],
): DesktopSessionDeclaration | undefined {
  const child = readRequiredObject(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  rejectUnknownFields(child, SESSION_FIELDS, path, errors);
  const id = readRequiredString(child, "id", [...path, "id"], errors);
  const heartbeatIntervalMs = readRequiredPositiveInteger(
    child,
    "heartbeatIntervalMs",
    [...path, "heartbeatIntervalMs"],
    errors,
  );
  const heartbeatChannel = readHeartbeatChannel(
    child,
    "heartbeatChannel",
    [...path, "heartbeatChannel"],
    errors,
  );

  if (id !== undefined && !validSessionId(id)) {
    addError(errors, [...path, "id"], "Expected safe desktop session id.");
  }
  if (
    id === undefined ||
    heartbeatIntervalMs === undefined ||
    heartbeatChannel === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    heartbeatChannel,
    heartbeatIntervalMs,
    id,
  });
}

function readHeartbeatChannel(
  value: PlainJsonObject,
  key: string,
  path: readonly string[],
  errors: DesktopSubstrateValidationError[],
): DesktopSessionHeartbeatChannel | undefined {
  const child = readRequiredObject(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  rejectUnknownFields(child, HEARTBEAT_CHANNEL_FIELDS, path, errors);
  const kind = readRequiredString(child, "kind", [...path, "kind"], errors);
  const capability = readRequiredString(child, "capability", [...path, "capability"], errors);

  if (kind !== undefined && kind !== "agentd.capsule-health") {
    addError(errors, [...path, "kind"], "Expected agentd capsule-health heartbeat channel.");
  }
  if (capability !== undefined && capability !== "capsule.execute") {
    addError(errors, [...path, "capability"], "Expected capsule.execute heartbeat capability.");
  }
  if (kind !== "agentd.capsule-health" || capability !== "capsule.execute") {
    return undefined;
  }

  return Object.freeze({
    capability,
    kind,
  });
}

function normalizeObject(
  input: unknown,
  errors: DesktopSubstrateValidationError[],
): PlainJsonObject | undefined {
  const normalized = safeNormalize(input);

  if (!normalized.ok) {
    addError(errors, [], normalized.reason);
    return undefined;
  }
  if (!isPlainObject(normalized.value)) {
    addError(errors, [], "Expected object.");
    return undefined;
  }

  return normalized.value;
}

function rejectUnknownFields(
  value: PlainJsonObject,
  allowed: readonly string[],
  path: readonly string[],
  errors: DesktopSubstrateValidationError[],
): void {
  const keys = Object.keys(value).sort(compareStrings);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && !hasString(allowed, key)) {
      addError(errors, [...path, key], "Unknown field.");
    }
  }
}

function readRequiredObject(
  value: PlainJsonObject,
  key: string,
  path: readonly string[],
  errors: DesktopSubstrateValidationError[],
): PlainJsonObject | undefined {
  const child = readRequiredField(value, key, path, errors);

  if (!isPlainObject(child)) {
    addError(errors, path, "Expected object.");
    return undefined;
  }

  return child;
}

function readRequiredString(
  value: PlainJsonObject,
  key: string,
  path: readonly string[],
  errors: DesktopSubstrateValidationError[],
): string | undefined {
  const child = readRequiredField(value, key, path, errors);

  if (typeof child !== "string" || child.length === 0) {
    addError(errors, path, "Expected non-empty string.");
    return undefined;
  }

  return child;
}

function readRequiredBoolean(
  value: PlainJsonObject,
  key: string,
  path: readonly string[],
  errors: DesktopSubstrateValidationError[],
): boolean | undefined {
  const child = readRequiredField(value, key, path, errors);

  if (typeof child !== "boolean") {
    addError(errors, path, "Expected boolean.");
    return undefined;
  }

  return child;
}

function readRequiredPositiveInteger(
  value: PlainJsonObject,
  key: string,
  path: readonly string[],
  errors: DesktopSubstrateValidationError[],
): number | undefined {
  const child = readRequiredField(value, key, path, errors);

  if (typeof child !== "number" || !Number.isSafeInteger(child) || child <= 0) {
    addError(errors, path, "Expected positive safe integer.");
    return undefined;
  }

  return child;
}

function readRequiredEmptyArray(
  value: PlainJsonObject,
  key: string,
  path: readonly string[],
  errors: DesktopSubstrateValidationError[],
): readonly [] | undefined {
  const child = readRequiredField(value, key, path, errors);

  if (!Array.isArray(child)) {
    addError(errors, path, "Expected array.");
    return undefined;
  }
  if (child.length !== 0) {
    addError(errors, path, "Expected empty array.");
    return undefined;
  }

  return Object.freeze([]);
}

function readRequiredEnumArray<T extends string>(
  value: PlainJsonObject,
  key: string,
  allowed: readonly T[],
  path: readonly string[],
  errors: DesktopSubstrateValidationError[],
): readonly T[] | undefined {
  const child = readRequiredField(value, key, path, errors);

  if (!Array.isArray(child)) {
    addError(errors, path, "Expected array.");
    return undefined;
  }
  if (child.length === 0) {
    addError(errors, path, "Expected non-empty array.");
    return undefined;
  }

  const out: T[] = [];
  const seen: string[] = [];
  for (let index = 0; index < child.length; index += 1) {
    const item = child[index];
    const itemPath = [...path, String(index)];

    if (typeof item !== "string" || !hasString(allowed, item)) {
      addError(errors, itemPath, "Expected supported desktop substrate value.");
      continue;
    }
    if (hasString(seen, item)) {
      addError(errors, itemPath, "Duplicate value.");
      continue;
    }
    seen[seen.length] = item;
    out[out.length] = item;
  }

  return Object.freeze(out);
}

function readRequiredField(
  value: PlainJsonObject,
  key: string,
  path: readonly string[],
  errors: DesktopSubstrateValidationError[],
): PlainJson | undefined {
  if (!Object.hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }

  return value[key];
}

function requireAllOperations(
  operations: readonly DesktopSubstrateOperation[] | undefined,
  path: readonly string[],
  errors: DesktopSubstrateValidationError[],
): void {
  if (operations === undefined) {
    return;
  }

  for (let index = 0; index < DESKTOP_OPERATIONS.length; index += 1) {
    const operation = DESKTOP_OPERATIONS[index];

    if (operation !== undefined && !hasString(operations, operation)) {
      addError(errors, path, `Missing required operation ${operation}.`);
    }
  }
}

function requireAllCapabilities(
  capabilities: readonly DesktopSubstrateCapability[] | undefined,
  path: readonly string[],
  errors: DesktopSubstrateValidationError[],
): void {
  if (capabilities === undefined) {
    return;
  }

  for (let index = 0; index < DESKTOP_CAPABILITIES.length; index += 1) {
    const capability = DESKTOP_CAPABILITIES[index];

    if (capability !== undefined && !hasString(capabilities, capability)) {
      addError(errors, path, `Missing required capability ${capability}.`);
    }
  }
}

function upsertCapsuleEntry(
  current: readonly DesktopCapsuleRegistryEntry[],
  entry: DesktopCapsuleRegistryEntry,
): readonly DesktopCapsuleRegistryEntry[] {
  const out: DesktopCapsuleRegistryEntry[] = [];
  let replaced = false;

  for (let index = 0; index < current.length; index += 1) {
    const item = current[index];

    if (item === undefined) {
      continue;
    }
    if (item.id === entry.id) {
      out[out.length] = entry;
      replaced = true;
    } else {
      out[out.length] = Object.freeze({
        id: item.id,
        integrity: item.integrity,
        state: item.state,
        version: item.version,
      });
    }
  }

  if (!replaced) {
    out[out.length] = entry;
  }

  return Object.freeze(out);
}

function isPlainObject(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCapsuleIntegrity(value: string | undefined): value is DesktopCapsuleIntegrity {
  return (
    value !== undefined &&
    /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/u.test(value)
  );
}

function validDesktopId(value: string): boolean {
  return (
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(value) ||
    /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/u.test(value)
  );
}

function validVersion(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/u.test(value);
}

function validSessionId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{1,127}$/u.test(value);
}

function validHeartbeatTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value));
}

function validHeartbeatNonce(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/u.test(value);
}

function validReference(value: string): boolean {
  if (value !== value.trim() || /[\s<>{}`"']/u.test(value)) {
    return false;
  }

  const separator = value.indexOf("://");
  if (separator <= 0 || separator === value.length - 3) {
    return false;
  }

  const scheme = value.slice(0, separator).toLowerCase();
  return /^[a-z][a-z0-9+.-]*$/u.test(scheme) && scheme !== "data" && scheme !== "inline";
}

function validRelativeEntrypoint(value: string): boolean {
  return (
    value.endsWith(".ts") &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").some((part) => part === "" || part === "." || part === "..") &&
    /^[A-Za-z0-9_./-]+$/u.test(value)
  );
}

function markerToken(value: string): string {
  const token = value.replace(/[^A-Za-z0-9_.:-]+/gu, "_");
  return token.length === 0 ? "unknown" : token;
}


function hasString<T extends string>(values: readonly T[], target: string): target is T {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === target) {
      return true;
    }
  }

  return false;
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function addError(
  errors: DesktopSubstrateValidationError[],
  path: readonly string[],
  message: string,
): void {
  errors[errors.length] = {
    message,
    path: formatPath(path),
  };
}

function formatPath(path: readonly string[]): string {
  return path.map(escapePathToken).join("/");
}

function escapePathToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

function accept<T>(value: T): Extract<DesktopSubstrateValidationResult<T>, { readonly ok: true }> {
  return {
    ok: true,
    value,
  };
}

function reject<T>(
  errors: readonly DesktopSubstrateValidationError[],
): Extract<DesktopSubstrateValidationResult<T>, { readonly ok: false }> {
  return {
    errors,
    ok: false,
  };
}
