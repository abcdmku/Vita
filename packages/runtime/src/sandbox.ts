import { safeNormalize } from "../../../sdk/typescript/src/safe-normalize.ts";
import type {
  PlainJson,
  PlainJsonObject,
} from "../../../sdk/typescript/src/safe-normalize.ts";
import type {
  CapabilityGrant,
  DataCapabilityGrant,
  NetworkEgressCapabilityGrant,
  NetworkIngressCapabilityGrant,
} from "../../../runtime/permission-broker/src/grants.ts";

// Broker data scopes are volume names; the Deno sandbox sees them under this runtime mount root.
export const VOLUME_MOUNT_ROOT = "/var/lib/vita/runtime/volumes";
export const PRIVATE_INGRESS_HOST = "127.0.0.1";
export const PUBLIC_INGRESS_HOST = "0.0.0.0";

export interface DenoSandboxPermissions {
  readonly defaultDeny: true;
  readonly allowNet: readonly string[];
  readonly allowRead: readonly string[];
  readonly allowWrite: readonly string[];
  readonly allowEnv: readonly string[];
  readonly allowRun: readonly [];
  readonly allowFfi: readonly [];
}

export type DenoSandboxPolicyErrorCode =
  | "FORBIDDEN_GRANT"
  | "MALFORMED_GRANTS"
  | "UNMAPPABLE_GRANT";

export interface DenoSandboxPolicyError {
  readonly code: DenoSandboxPolicyErrorCode;
  readonly reason: string;
  readonly grantIndex?: number;
}

export type DenoSandboxPolicyResult =
  | {
      readonly ok: true;
      readonly policy: DenoSandboxPermissions;
    }
  | {
      readonly ok: false;
      readonly error: DenoSandboxPolicyError;
    };

type DataAccessMode = DataCapabilityGrant["access"];
type DataClass = DataCapabilityGrant["class"];
type NetworkProtocol = NetworkEgressCapabilityGrant["protocol"];
type ReadGrantResult =
  | {
      readonly ok: true;
      readonly grant: CapabilityGrant;
    }
  | {
      readonly ok: false;
      readonly code: DenoSandboxPolicyErrorCode;
      readonly reason: string;
    };

const DATA_GRANT_KEYS = ["kind", "class", "access", "scope"] as const;
const NETWORK_EGRESS_GRANT_KEYS = [
  "kind",
  "direction",
  "protocol",
  "destination",
  "port",
] as const;
const NETWORK_INGRESS_GRANT_KEYS = [
  "kind",
  "direction",
  "protocol",
  "port",
  "public",
] as const;
const DATA_CLASSES: readonly DataClass[] = [
  "user-content",
  "app-state",
  "cache",
  "logs",
  "telemetry",
  "configuration",
];
const DATA_ACCESS_MODES: readonly DataAccessMode[] = ["read-only", "read-write"];
const NETWORK_PROTOCOLS: readonly NetworkProtocol[] = [
  "http",
  "https",
  "tcp",
  "udp",
  "ws",
  "wss",
];
const VOLUME_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu;
const EMPTY_DENIED_LIST: readonly [] = Object.freeze([]);
const EMPTY_STRING_LIST: readonly string[] = Object.freeze([]);

export function denoSandboxPolicy(grantedCapabilities: unknown): DenoSandboxPolicyResult {
  const normalized = safeNormalize(grantedCapabilities, {
    maxDepth: 8,
    maxNodes: 10_000,
  });

  if (!normalized.ok) {
    return reject("MALFORMED_GRANTS", normalized.reason);
  }

  if (!Array.isArray(normalized.value)) {
    return reject("MALFORMED_GRANTS", "Granted capabilities must be an array.");
  }

  const allowNet: string[] = [];
  const allowRead: string[] = [];
  const allowWrite: string[] = [];

  for (let index = 0; index < normalized.value.length; index += 1) {
    const grantResult = readCapabilityGrant(normalized.value[index]);

    if (!grantResult.ok) {
      return reject(grantResult.code, grantResult.reason, index);
    }

    const mapResult = mapCapabilityGrant(grantResult.grant, allowNet, allowRead, allowWrite);

    if (!mapResult.ok) {
      return reject(mapResult.code, mapResult.reason, index);
    }
  }

  return {
    ok: true,
    policy: Object.freeze({
      defaultDeny: true,
      allowNet: freezeStrings(allowNet),
      allowRead: freezeStrings(allowRead),
      allowWrite: freezeStrings(allowWrite),
      allowEnv: EMPTY_STRING_LIST,
      allowRun: EMPTY_DENIED_LIST,
      allowFfi: EMPTY_DENIED_LIST,
    }),
  };
}

function readCapabilityGrant(value: PlainJson | undefined): ReadGrantResult {
  if (!isPlainRecord(value)) {
    return grantFailure("MALFORMED_GRANTS", "Capability grant must be an object.");
  }

  const kind = value.kind;

  if (kind === "run" || kind === "ffi") {
    return grantFailure("FORBIDDEN_GRANT", "Deno run and FFI permissions are always denied.");
  }

  if (kind === "data") {
    return readDataGrant(value);
  }

  if (kind === "network") {
    return readNetworkGrant(value);
  }

  return grantFailure("MALFORMED_GRANTS", "Capability grant must use the broker grant vocabulary.");
}

function readDataGrant(value: PlainJsonObject): ReadGrantResult {
  if (!hasExactKeys(value, DATA_GRANT_KEYS)) {
    return grantFailure("MALFORMED_GRANTS", "Data grant must have exactly kind, class, access, and scope.");
  }

  const dataClass = value.class;
  const access = value.access;
  const scope = value.scope;

  if (!isDataClass(dataClass) || !isDataAccessMode(access) || !isVolumeName(scope)) {
    return grantFailure("UNMAPPABLE_GRANT", "Data grant must name a bounded broker data volume.");
  }

  return {
    ok: true,
    grant: {
      kind: "data",
      class: dataClass,
      access,
      scope,
    },
  };
}

function readNetworkGrant(value: PlainJsonObject): ReadGrantResult {
  const direction = value.direction;

  if (direction === "ingress") {
    return readNetworkIngressGrant(value);
  }

  if (direction === "egress") {
    return readNetworkEgressGrant(value);
  }

  return grantFailure("MALFORMED_GRANTS", "Network grant must be ingress or egress.");
}

function readNetworkIngressGrant(value: PlainJsonObject): ReadGrantResult {
  if (!hasExactKeys(value, NETWORK_INGRESS_GRANT_KEYS)) {
    return grantFailure(
      "MALFORMED_GRANTS",
      "Network ingress grant must have exactly kind, direction, protocol, port, and public.",
    );
  }

  const protocol = value.protocol;
  const port = value.port;
  const publicAccess = value.public;

  if (!isNetworkProtocol(protocol) || !isPort(port) || typeof publicAccess !== "boolean") {
    return grantFailure("UNMAPPABLE_GRANT", "Network ingress grant must map to a bounded listen address.");
  }

  return {
    ok: true,
    grant: {
      kind: "network",
      direction: "ingress",
      protocol,
      port,
      public: publicAccess,
    },
  };
}

function readNetworkEgressGrant(value: PlainJsonObject): ReadGrantResult {
  if (!hasExactKeys(value, NETWORK_EGRESS_GRANT_KEYS)) {
    return grantFailure(
      "MALFORMED_GRANTS",
      "Network egress grant must have exactly kind, direction, protocol, destination, and port.",
    );
  }

  const protocol = value.protocol;
  const destination = value.destination;
  const port = value.port;

  if (!isNetworkProtocol(protocol) || !isBoundedNetworkHost(destination) || !isPort(port)) {
    return grantFailure("UNMAPPABLE_GRANT", "Network egress grant must map to a bounded host and port.");
  }

  return {
    ok: true,
    grant: {
      kind: "network",
      direction: "egress",
      protocol,
      destination,
      port,
    },
  };
}

function mapCapabilityGrant(
  grant: CapabilityGrant,
  allowNet: string[],
  allowRead: string[],
  allowWrite: string[],
): { readonly ok: true } | { readonly ok: false; readonly code: DenoSandboxPolicyErrorCode; readonly reason: string } {
  if (grant.kind === "data") {
    const mountPath = volumeMountPath(grant.scope);

    if (mountPath === undefined) {
      return {
        ok: false,
        code: "UNMAPPABLE_GRANT",
        reason: "Data grant scope cannot be mapped to a bounded volume mount.",
      };
    }

    pushUnique(allowRead, mountPath);

    if (grant.access === "read-write") {
      pushUnique(allowWrite, mountPath);
    }

    return { ok: true };
  }

  if (grant.direction === "ingress") {
    pushUnique(allowNet, ingressTarget(grant));
    return { ok: true };
  }

  pushUnique(allowNet, egressTarget(grant));
  return { ok: true };
}

function volumeMountPath(scope: string): string | undefined {
  return isVolumeName(scope) ? `${VOLUME_MOUNT_ROOT}/${scope}` : undefined;
}

function ingressTarget(grant: NetworkIngressCapabilityGrant): string {
  // The broker carries public/private ingress intent, not a host string.
  return `${grant.public ? PUBLIC_INGRESS_HOST : PRIVATE_INGRESS_HOST}:${grant.port}`;
}

function egressTarget(grant: NetworkEgressCapabilityGrant): string {
  return `${grant.destination}:${grant.port}`;
}

function hasExactKeys(value: PlainJsonObject, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);

  if (keys.length !== allowed.length) {
    return false;
  }

  for (let index = 0; index < allowed.length; index += 1) {
    const key = allowed[index];

    if (key === undefined || !Object.hasOwn(value, key)) {
      return false;
    }
  }

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined || !hasString(allowed, key)) {
      return false;
    }
  }

  return true;
}

function isPlainRecord(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDataClass(value: PlainJson | undefined): value is DataClass {
  return typeof value === "string" && hasString(DATA_CLASSES, value);
}

function isDataAccessMode(value: PlainJson | undefined): value is DataAccessMode {
  return typeof value === "string" && hasString(DATA_ACCESS_MODES, value);
}

function isNetworkProtocol(value: PlainJson | undefined): value is NetworkProtocol {
  return typeof value === "string" && hasString(NETWORK_PROTOCOLS, value);
}

function isPort(value: PlainJson | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function isVolumeName(value: PlainJson | undefined): value is string {
  return typeof value === "string" && VOLUME_NAME_PATTERN.test(value);
}

function isBoundedNetworkHost(value: PlainJson | undefined): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 253) {
    return false;
  }

  if (value === "*" || value === "0.0.0.0" || value === "::") {
    return false;
  }

  if (/[/:\\,\s]/u.test(value)) {
    return false;
  }

  return isIpv4Address(value) || isDnsName(value);
}

function isIpv4Address(value: string): boolean {
  const parts = value.split(".");

  if (parts.length !== 4) {
    return false;
  }

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];

    if (
      part === undefined ||
      part.length === 0 ||
      !/^[0-9]{1,3}$/u.test(part) ||
      (part.length > 1 && part.startsWith("0"))
    ) {
      return false;
    }

    const octet = Number(part);

    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return false;
    }
  }

  return true;
}

function isDnsName(value: string): boolean {
  if (value.endsWith(".")) {
    return false;
  }

  const labels = value.split(".");

  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index];

    if (label === undefined || !HOST_LABEL_PATTERN.test(label)) {
      return false;
    }
  }

  return true;
}

function pushUnique(values: string[], value: string): void {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) {
      return;
    }
  }

  values[values.length] = value;
}

function freezeStrings(values: readonly string[]): readonly string[] {
  const copy: string[] = [];

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];

    if (value !== undefined) {
      copy[copy.length] = value;
    }
  }

  return Object.freeze(copy);
}

function hasString<T extends string>(values: readonly T[], target: string): target is T {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === target) {
      return true;
    }
  }

  return false;
}

function grantFailure(
  code: DenoSandboxPolicyErrorCode,
  reason: string,
): Extract<ReadGrantResult, { readonly ok: false }> {
  return {
    ok: false,
    code,
    reason,
  };
}

function reject(
  code: DenoSandboxPolicyErrorCode,
  reason: string,
  grantIndex?: number,
): Extract<DenoSandboxPolicyResult, { readonly ok: false }> {
  if (grantIndex === undefined) {
    return {
      ok: false,
      error: {
        code,
        reason,
      },
    };
  }

  return {
    ok: false,
    error: {
      code,
      reason,
      grantIndex,
    },
  };
}
