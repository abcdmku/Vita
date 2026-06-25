// Vendored subset from sdk/typescript/src/desktop-substrate.ts for the on-device
// TS overlay. Keep the SDK source canonical; this file carries only the seam
// pieces needed by the boot-time desktop package proof.

export type DesktopCapsuleExecutionPackageClass = "ts-service";
export type DesktopPackageClass = "desktop";
export type DesktopCapsuleIntegrity =
  | `sha256-${string}`
  | `sha384-${string}`
  | `sha512-${string}`;

export interface DesktopSessionHeartbeatChannel {
  readonly kind: "agentd.capsule-health";
  readonly capability: "capsule.execute";
}

export interface DesktopCapsuleRuntimeRef {
  readonly id: string;
  readonly version: string;
  readonly integrity: DesktopCapsuleIntegrity;
  readonly ref: string;
  readonly executionPackageClass: DesktopCapsuleExecutionPackageClass;
  readonly entrypoint: string;
}

export interface DesktopSessionRegistration {
  readonly packageId: string;
  readonly packageClass: DesktopPackageClass;
  readonly packageVersion: string;
  readonly sessionId: string;
  readonly substrateVersion: "1.0.0";
  readonly heartbeatIntervalMs: number;
  readonly heartbeatChannel: DesktopSessionHeartbeatChannel;
  readonly capsule: DesktopCapsuleRuntimeRef;
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

function validateDesktopSessionHeartbeatObservation(
  registration: DesktopSessionRegistration,
  state: unknown,
): { readonly ok: true; readonly value: DesktopSessionHeartbeatObservation } | { readonly ok: false } {
  if (!isRecord(state)) {
    return rejectHeartbeat();
  }

  const last = state["last"];
  if (!isRecord(last)) {
    return rejectHeartbeat();
  }

  const capsuleId = readStringField(last, "id");
  const version = readStringField(last, "version");
  const integrity = readStringField(last, "integrity");
  const unit = readStringField(last, "unit");
  const dynamicUid = readStringField(last, "dynamicUid");
  const status = readStringField(last, "status");
  const health = readStringField(last, "health");

  if (
    capsuleId !== registration.capsule.id ||
    version !== registration.capsule.version ||
    integrity !== registration.capsule.integrity ||
    !isCapsuleIntegrity(integrity) ||
    unit === undefined ||
    dynamicUid === undefined ||
    status !== "OK" ||
    health !== "OK"
  ) {
    return rejectHeartbeat();
  }

  return Object.freeze({
    ok: true,
    value: Object.freeze({
      capsuleId,
      dynamicUid,
      health,
      integrity,
      packageId: registration.packageId,
      sessionId: registration.sessionId,
      state: "running",
      unit,
      version,
    }),
  });
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCapsuleIntegrity(value: string | undefined): value is DesktopCapsuleIntegrity {
  return (
    value !== undefined &&
    /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/u.test(value)
  );
}

function rejectHeartbeat(): { readonly ok: false } {
  return {
    ok: false,
  };
}
