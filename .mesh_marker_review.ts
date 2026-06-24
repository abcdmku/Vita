export const MESH_CAPABILITY = "mesh.config";
export const MESH_MARKER = "VITA-MESH";
export const MESH_REJECT_MARKER = "VITA-MESH-REJECT";
export const MESH_ERROR_MARKER = "VITA-MESH-ERROR";

export type MeshReadResult =
  | {
      readonly ok: true;
      readonly status: MeshMeasuredStatus;
    }
  | {
      readonly ok: false;
    };

export interface MeshMeasuredStatus {
  readonly peers: number;
  readonly handshake?: "OK";
  readonly reach?: "OK";
  readonly denied?: string;
  readonly drop?: "enforced";
  readonly status: "OK";
}

export function parseMeshState(value: unknown): MeshReadResult {
  if (!isJsonObject(value)) {
    return { ok: false };
  }

  if (value["applied"] !== true || !isJsonObject(value["status"])) {
    return { ok: false };
  }

  const status = value["status"];
  const peers = readNonNegativeIntegerField(status, "peers");
  const state = readStringField(status, "status");
  const handshake = readOptionalStringField(status, "handshake");
  const reach = readOptionalStringField(status, "reach");
  const denied = readOptionalStringField(status, "denied");
  const drop = readOptionalStringField(status, "drop");

  if (peers === undefined || state !== "OK") {
    return { ok: false };
  }

  return {
    ok: true,
    status: {
      peers,
      status: state,
      ...(handshake === "OK" ? { handshake } : {}),
      ...(reach === "OK" ? { reach } : {}),
      ...(denied === undefined ? {} : { denied }),
      ...(drop === "enforced" ? { drop } : {}),
    },
  };
}

export function formatMeshMarker(result: MeshReadResult): string {
  if (
    !result.ok ||
    result.status.peers <= 0 ||
    result.status.handshake !== "OK" ||
    result.status.reach !== "OK" ||
    result.status.denied === undefined ||
    result.status.drop !== "enforced" ||
    result.status.status !== "OK"
  ) {
    return formatMeshErrorMarker("mesh_unverified");
  }

  return (
    `${MESH_MARKER}: ` +
    `peers=${result.status.peers} ` +
    "handshake=OK " +
    "reach=OK " +
    `denied=${markerToken(result.status.denied)} ` +
    "drop=enforced " +
    "status=OK"
  );
}

export function formatMeshRejectMarker(reason: string): string {
  return `${MESH_REJECT_MARKER}: reason=${markerToken(reason)} status=OK`;
}

export function formatMeshErrorMarker(reason: string): string {
  return `${MESH_ERROR_MARKER}: reason=${markerToken(reason)} status=FAILSAFE`;
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

function readOptionalStringField(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const child = value[key];

  if (child === undefined) {
    return undefined;
  }
  if (typeof child !== "string" || child.length === 0) {
    return undefined;
  }

  return child;
}

function readNonNegativeIntegerField(
  value: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const child = value[key];

  if (typeof child !== "number" || !Number.isSafeInteger(child) || child < 0) {
    return undefined;
  }

  return child;
}

function markerToken(value: string): string {
  const token = value.replace(/[^A-Za-z0-9_.-]+/gu, "_");
  return token.length === 0 ? "unknown" : token;
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
