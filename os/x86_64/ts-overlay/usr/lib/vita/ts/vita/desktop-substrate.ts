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
  readonly volumeName: string;
  readonly fileName: string;
  readonly nonceFileName: string;
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

export interface DesktopSessionHeartbeat {
  readonly packageId: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly nonce: string;
  readonly state: "running";
}

export interface DesktopSessionHeartbeatReadOptions {
  readonly registration: DesktopSessionRegistration;
  readonly volumePath: string;
  readonly expectedNonce: string;
  readonly launchedAfterMs: number;
  readonly readTextFile: (path: string) => Promise<string>;
}

export type DesktopSessionHeartbeatReadResult =
  | {
      readonly ok: true;
      readonly heartbeat: DesktopSessionHeartbeat;
      readonly line: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

type DesktopSessionHeartbeatValidationResult =
  | {
      readonly ok: true;
      readonly value: DesktopSessionHeartbeat;
    }
  | {
      readonly ok: false;
    };

export async function readDesktopSessionHeartbeatThroughSubstrate(
  options: DesktopSessionHeartbeatReadOptions,
): Promise<DesktopSessionHeartbeatReadResult> {
  if (
    !validHeartbeatNonce(options.expectedNonce) ||
    !validVolumePath(options.volumePath)
  ) {
    return Object.freeze({
      ok: false,
      reason: "heartbeat_request_invalid",
    });
  }

  let raw: string;
  try {
    raw = await options.readTextFile(
      desktopSessionHeartbeatPath(options.volumePath, options.registration.heartbeatChannel),
    );
  } catch {
    return Object.freeze({
      ok: false,
      reason: "heartbeat_unreadable",
    });
  }

  const line = normalizeHeartbeatFile(raw);
  if (line === undefined) {
    return Object.freeze({
      ok: false,
      reason: "heartbeat_malformed",
    });
  }

  const parsed = parseDesktopHeartbeatLine(line);
  if (!parsed.ok) {
    return Object.freeze({
      ok: false,
      reason: "heartbeat_malformed",
    });
  }

  const timestampMs = Date.parse(parsed.value.timestamp);
  if (
    parsed.value.packageId !== options.registration.packageId ||
    parsed.value.sessionId !== options.registration.sessionId ||
    parsed.value.nonce !== options.expectedNonce ||
    !Number.isFinite(timestampMs) ||
    timestampMs < options.launchedAfterMs
  ) {
    return Object.freeze({
      ok: false,
      reason: "heartbeat_stale",
    });
  }

  return Object.freeze({
    heartbeat: parsed.value,
    line,
    ok: true,
  });
}

export function desktopSessionHeartbeatPath(
  volumePath: string,
  channel: DesktopSessionHeartbeatChannel,
): string {
  const root = volumePath.endsWith("/") ? volumePath.slice(0, volumePath.length - 1) : volumePath;
  return `${root}/${channel.fileName}`;
}

export function desktopSessionLaunchNoncePath(
  volumePath: string,
  channel: DesktopSessionHeartbeatChannel,
): string {
  const root = volumePath.endsWith("/") ? volumePath.slice(0, volumePath.length - 1) : volumePath;
  return `${root}/${channel.nonceFileName}`;
}

function parseDesktopHeartbeatLine(line: string): DesktopSessionHeartbeatValidationResult {
  const fields = parseMarkerFields(line, "VITA-DESKTOP-HEARTBEAT:");
  if (fields === undefined) {
    return rejectHeartbeat();
  }

  const sequenceRaw = fields.get("sequence");
  const sequence = sequenceRaw === undefined ? NaN : Number(sequenceRaw);
  return validateDesktopSessionHeartbeat({
    nonce: fields.get("nonce"),
    packageId: fields.get("id"),
    sequence,
    sessionId: fields.get("session"),
    state: fields.get("state"),
    timestamp: fields.get("timestamp"),
  });
}

function validateDesktopSessionHeartbeat(
  value: {
    readonly packageId: string | undefined;
    readonly sessionId: string | undefined;
    readonly sequence: number;
    readonly timestamp: string | undefined;
    readonly nonce: string | undefined;
    readonly state: string | undefined;
  },
): DesktopSessionHeartbeatValidationResult {
  if (
    value.packageId === undefined ||
    !validDesktopId(value.packageId) ||
    value.sessionId === undefined ||
    !validSessionId(value.sessionId) ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence <= 0 ||
    value.timestamp === undefined ||
    !validHeartbeatTimestamp(value.timestamp) ||
    value.nonce === undefined ||
    !validHeartbeatNonce(value.nonce) ||
    value.state !== "running"
  ) {
    return rejectHeartbeat();
  }

  return Object.freeze({
    ok: true,
    value: Object.freeze({
      nonce: value.nonce,
      packageId: value.packageId,
      sequence: value.sequence,
      sessionId: value.sessionId,
      state: "running",
      timestamp: value.timestamp,
    }),
  });
}

function parseMarkerFields(line: string, prefix: string): ReadonlyMap<string, string> | undefined {
  if (!line.startsWith(prefix)) {
    return undefined;
  }

  const fields = new Map<string, string>();
  const tokens = line.slice(prefix.length).trim().split(" ");
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === undefined || token.length === 0) {
      continue;
    }
    const separator = token.indexOf("=");
    if (separator <= 0 || separator === token.length - 1) {
      return undefined;
    }
    const key = token.slice(0, separator);
    const value = token.slice(separator + 1);
    if (fields.has(key)) {
      return undefined;
    }
    fields.set(key, value);
  }

  return fields;
}

function normalizeHeartbeatFile(raw: string): string | undefined {
  const line = raw.endsWith("\n") ? raw.slice(0, raw.length - 1) : raw;

  if (line.length === 0 || line.length > 512 || line.includes("\n") || line.includes("\r")) {
    return undefined;
  }

  return line;
}

function validDesktopId(value: string): boolean {
  return (
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(value) ||
    /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/u.test(value)
  );
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

function validVolumePath(value: string): boolean {
  return (
    value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.includes("\0") &&
    !value.split("/").some((part) => part === "." || part === "..")
  );
}

function rejectHeartbeat(): Extract<DesktopSessionHeartbeatValidationResult, { readonly ok: false }> {
  return {
    ok: false,
  };
}
