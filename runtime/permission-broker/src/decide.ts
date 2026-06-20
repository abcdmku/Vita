import { validatePackageContract } from "../../../sdk/manifests/src/package-contract.ts";
import type {
  DataClass,
  NetworkEgressRule,
  NetworkIngressRule,
  NetworkProtocol,
  PackageContract,
} from "../../../sdk/manifests/src/package-contract.ts";
import type {
  BrokerPolicy,
  CapabilityDenial,
  CapabilityGrant,
  CapabilityRequest,
  DataAccessMode,
  DataCapabilityGrant,
  DataGrantPolicy,
  DenialCode,
  GrantDecision,
  NetworkEgressCapabilityGrant,
  NetworkIngressCapabilityGrant,
  RequestedCapability,
} from "./grants.ts";

type Plain = null | boolean | number | string | Plain[] | { [key: string]: Plain };
type Obj = { [key: string]: Plain };
type CloneResult = { readonly ok: true; readonly value: Plain } | { readonly ok: false };

interface ParsedRequest {
  readonly contract: Plain | undefined;
  readonly capabilities: readonly RequestedCapability[];
  readonly malformed: boolean;
}

interface ParsedPolicy {
  readonly data: readonly DataGrantPolicy[];
  readonly ingress: readonly NetworkIngressRule[];
  readonly egress: readonly NetworkEgressRule[];
}

interface Declarations {
  readonly dataClasses: readonly DataClass[];
  readonly volumes: readonly Pick<DataGrantPolicy, "scope" | "class" | "access">[];
  readonly ingress: readonly NetworkIngressRule[];
  readonly egress: readonly NetworkEgressRule[];
}

const MAX_DEPTH = 64;
const MAX_ITEMS = 10_000;
const DATA_CLASSES = new Set<string>([
  "user-content",
  "app-state",
  "cache",
  "logs",
  "telemetry",
  "configuration",
]);
const ACCESS_MODES = new Set<string>(["read-only", "read-write"]);
const NETWORK_PROTOCOLS = new Set<string>(["http", "https", "tcp", "udp", "ws", "wss"]);

export function decideGrants(request: CapabilityRequest, policy: BrokerPolicy): GrantDecision {
  try {
    const requestClone = clonePlain(request, new WeakSet<object>(), 0);
    if (!requestClone.ok) return denyUnknown("MALFORMED_REQUEST", "Capability request is malformed.");

    const parsedRequest = readRequest(requestClone.value);
    if (parsedRequest.malformed || parsedRequest.contract === undefined) {
      return denyAll(
        parsedRequest.capabilities,
        "MALFORMED_REQUEST",
        "Capability request must include packageContract and capabilities.",
      );
    }

    const policyClone = clonePlain(policy, new WeakSet<object>(), 0);
    const parsedPolicy = policyClone.ok ? readPolicy(policyClone.value) : undefined;
    if (parsedPolicy === undefined) {
      return denyAll(
        parsedRequest.capabilities,
        "MALFORMED_POLICY",
        "Broker policy must include complete data, ingress, and egress policy.",
      );
    }

    const contract = validatePackageContract(parsedRequest.contract);
    if (!contract.ok) {
      return denyAll(
        parsedRequest.capabilities,
        "INVALID_PACKAGE_CONTRACT",
        "Package contract failed manifest validation.",
      );
    }

    return decideNormalized(parsedRequest.capabilities, declarationsFrom(contract.contract), parsedPolicy);
  } catch {
    return denyUnknown("MALFORMED_REQUEST", "Capability decision failed closed.");
  }
}

function decideNormalized(
  capabilities: readonly RequestedCapability[],
  declarations: Declarations,
  policy: ParsedPolicy,
): GrantDecision {
  const granted: CapabilityGrant[] = [];
  const denied: CapabilityDenial[] = [];

  for (let index = 0; index < capabilities.length; index += 1) {
    const capability = capabilities[index];
    if (capability === undefined) continue;

    if (capability.kind === "unknown") {
      denied[denied.length] = deny(capability, "UNKNOWN_CAPABILITY", "Capability kind is unknown.");
    } else if (!declared(capability, declarations)) {
      denied[denied.length] = deny(
        capability,
        "NOT_DECLARED",
        "Capability was not declared by the package contract.",
      );
    } else if (!allowedByPolicy(capability, policy)) {
      denied[denied.length] = deny(
        capability,
        "POLICY_DENIED",
        "Capability exceeds the destination broker policy.",
      );
    } else {
      granted[granted.length] = capability;
    }
  }

  return { granted, denied };
}

function clonePlain(value: unknown, seen: WeakSet<object>, depth: number): CloneResult {
  if (depth > MAX_DEPTH) return { ok: false };
  if (value === null || typeof value === "string" || typeof value === "boolean") return { ok: true, value };
  if (typeof value === "number") return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  if (typeof value !== "object" || seen.has(value)) return { ok: false };

  const prototype = stablePrototype(value);
  const isArray = Array.isArray(value);
  if (
    prototype === undefined ||
    (isArray && prototype !== Array.prototype) ||
    (!isArray && prototype !== Object.prototype && prototype !== null)
  ) {
    return { ok: false };
  }

  const keys = stableKeys(value);
  if (keys === undefined || keys.length > MAX_ITEMS) return { ok: false };

  seen.add(value);
  try {
    return isArray
      ? cloneArray(value as readonly unknown[], keys, seen, depth)
      : cloneObject(value, keys, seen, depth);
  } finally {
    seen.delete(value);
  }
}

function cloneArray(
  value: readonly unknown[],
  keys: readonly PropertyKey[],
  seen: WeakSet<object>,
  depth: number,
): CloneResult {
  if (value.length > MAX_ITEMS) return { ok: false };
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key !== "length" && (typeof key !== "string" || !arrayIndexKey(key))) return { ok: false };
  }

  const clone: Plain[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    const child = stableData(value, key);
    if (stableOwn(value, key) !== true || child === undefined) return { ok: false };

    const childClone = clonePlain(child, seen, depth + 1);
    if (!childClone.ok) return { ok: false };
    clone[index] = childClone.value;
  }

  return { ok: true, value: clone };
}

function cloneObject(
  value: object,
  keys: readonly PropertyKey[],
  seen: WeakSet<object>,
  depth: number,
): CloneResult {
  const clone = Object.create(null) as Obj;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string") return { ok: false };

    const child = stableData(value, key);
    if (child === undefined) return { ok: false };

    const childClone = clonePlain(child, seen, depth + 1);
    if (!childClone.ok) return { ok: false };
    clone[key] = childClone.value;
  }

  return { ok: true, value: clone };
}

function readRequest(value: Plain): ParsedRequest {
  const capabilities =
    record(value) && Array.isArray(value.capabilities)
      ? readCapabilities(value.capabilities)
      : [unknown("request")];

  if (!record(value) || !exact(value, ["packageContract", "capabilities"]) || !Array.isArray(value.capabilities)) {
    return { contract: undefined, capabilities, malformed: true };
  }

  return { contract: value.packageContract, capabilities, malformed: false };
}

function readCapabilities(values: readonly Plain[]): readonly RequestedCapability[] {
  const out: RequestedCapability[] = [];
  for (let index = 0; index < values.length; index += 1) out[index] = readCapability(values[index]);
  return out;
}

function readCapability(value: Plain | undefined): RequestedCapability {
  if (!record(value) || typeof value.kind !== "string") return unknown("capability");
  if (value.kind === "data") return readDataCapability(value);
  if (value.kind === "network") return readNetworkCapability(value);
  return unknown(value.kind);
}

function readDataCapability(value: Obj): RequestedCapability {
  return exact(value, ["kind", "class", "access", "scope"]) &&
    dataClass(value.class) &&
    accessMode(value.access) &&
    nonEmpty(value.scope)
    ? { kind: "data", class: value.class, access: value.access, scope: value.scope }
    : unknown("data");
}

function readNetworkCapability(value: Obj): RequestedCapability {
  if (value.direction === "ingress") {
    return exact(value, ["kind", "direction", "protocol", "port", "public"]) &&
      protocol(value.protocol) &&
      port(value.port) &&
      typeof value.public === "boolean"
      ? {
          kind: "network",
          direction: "ingress",
          protocol: value.protocol,
          port: value.port,
          public: value.public,
        }
      : unknown("network");
  }

  return value.direction === "egress" &&
    exact(value, ["kind", "direction", "protocol", "destination", "port"]) &&
    protocol(value.protocol) &&
    port(value.port) &&
    nonEmpty(value.destination)
    ? {
        kind: "network",
        direction: "egress",
        protocol: value.protocol,
        destination: value.destination,
        port: value.port,
      }
    : unknown("network");
}

function readPolicy(value: Plain): ParsedPolicy | undefined {
  if (!record(value) || !exact(value, ["data", "network"]) || !Array.isArray(value.data)) return undefined;

  const network = value.network;
  if (
    !record(network) ||
    !exact(network, ["ingress", "egress"]) ||
    !Array.isArray(network.ingress) ||
    !Array.isArray(network.egress)
  ) {
    return undefined;
  }

  const data = readArray(value.data, readDataPolicy);
  const ingress = readArray(network.ingress, readIngress);
  const egress = readArray(network.egress, readEgress);
  return data === undefined || ingress === undefined || egress === undefined
    ? undefined
    : { data, ingress, egress };
}

function readDataPolicy(value: Plain | undefined): DataGrantPolicy | undefined {
  return record(value) &&
    exact(value, ["class", "access", "scope"]) &&
    dataClass(value.class) &&
    accessMode(value.access) &&
    nonEmpty(value.scope)
    ? { class: value.class, access: value.access, scope: value.scope }
    : undefined;
}

function readIngress(value: Plain | undefined): NetworkIngressRule | undefined {
  return record(value) &&
    exact(value, ["name", "protocol", "port", "public"]) &&
    nonEmpty(value.name) &&
    protocol(value.protocol) &&
    port(value.port) &&
    typeof value.public === "boolean"
    ? { name: value.name, protocol: value.protocol, port: value.port, public: value.public }
    : undefined;
}

function readEgress(value: Plain | undefined): NetworkEgressRule | undefined {
  if (
    !record(value) ||
    !exact(value, ["name", "protocol", "destinations", "ports"]) ||
    !nonEmpty(value.name) ||
    !protocol(value.protocol)
  ) {
    return undefined;
  }

  const destinations = stringList(value.destinations);
  const ports = portList(value.ports);
  return destinations === undefined || ports === undefined
    ? undefined
    : { name: value.name, protocol: value.protocol, destinations, ports };
}

function declarationsFrom(contract: PackageContract): Declarations {
  const volumes: Pick<DataGrantPolicy, "scope" | "class" | "access">[] = [];
  for (let index = 0; index < contract.data.volumes.length; index += 1) {
    const volume = contract.data.volumes[index];
    if (volume !== undefined) {
      volumes[volumes.length] = { scope: volume.name, class: volume.class, access: volume.access };
    }
  }

  return {
    dataClasses: copy(contract.data.classes),
    volumes,
    ingress: copy(contract.network.ingress),
    egress: copy(contract.network.egress),
  };
}

function declared(capability: CapabilityGrant, declarations: Declarations): boolean {
  if (capability.kind === "data") return dataGrant(capability, declarations.dataClasses, declarations.volumes);
  return capability.direction === "ingress"
    ? ingressGrant(capability, declarations.ingress)
    : egressGrant(capability, declarations.egress);
}

function allowedByPolicy(capability: CapabilityGrant, policy: ParsedPolicy): boolean {
  if (capability.kind === "data") return dataGrant(capability, undefined, policy.data);
  return capability.direction === "ingress"
    ? ingressGrant(capability, policy.ingress)
    : egressGrant(capability, policy.egress);
}

function dataGrant(
  capability: DataCapabilityGrant,
  classes: readonly string[] | undefined,
  grants: readonly Pick<DataGrantPolicy, "class" | "scope" | "access">[],
): boolean {
  if (classes !== undefined && !hasString(classes, capability.class)) return false;
  for (let index = 0; index < grants.length; index += 1) {
    const grant = grants[index];
    if (
      grant !== undefined &&
      grant.class === capability.class &&
      grant.scope === capability.scope &&
      accessCovers(grant.access, capability.access)
    ) {
      return true;
    }
  }
  return false;
}

function ingressGrant(capability: NetworkIngressCapabilityGrant, rules: readonly NetworkIngressRule[]): boolean {
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (
      rule !== undefined &&
      rule.protocol === capability.protocol &&
      rule.port === capability.port &&
      rule.public === capability.public
    ) {
      return true;
    }
  }
  return false;
}

function egressGrant(capability: NetworkEgressCapabilityGrant, rules: readonly NetworkEgressRule[]): boolean {
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (
      rule !== undefined &&
      rule.protocol === capability.protocol &&
      hasString(rule.destinations, capability.destination) &&
      hasNumber(rule.ports, capability.port)
    ) {
      return true;
    }
  }
  return false;
}

function readArray<T>(values: readonly Plain[], read: (value: Plain | undefined) => T | undefined): T[] | undefined {
  const out: T[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const item = read(values[index]);
    if (item === undefined) return undefined;
    out[index] = item;
  }
  return out;
}

function stablePrototype(value: object): object | null | undefined {
  try {
    const first = Object.getPrototypeOf(value);
    return first === Object.getPrototypeOf(value) ? first : undefined;
  } catch {
    return undefined;
  }
}

function stableKeys(value: object): readonly PropertyKey[] | undefined {
  try {
    const first = Reflect.ownKeys(value);
    const second = Reflect.ownKeys(value);
    if (first.length !== second.length) return undefined;
    for (let index = 0; index < first.length; index += 1) {
      if (first[index] !== second[index]) return undefined;
    }
    return first;
  } catch {
    return undefined;
  }
}

function stableOwn(value: object, key: PropertyKey): boolean | undefined {
  try {
    const first = Object.hasOwn(value, key);
    return first === Object.hasOwn(value, key) ? first : undefined;
  } catch {
    return undefined;
  }
}

function stableData(value: object, key: PropertyKey): unknown | undefined {
  try {
    const first = Object.getOwnPropertyDescriptor(value, key);
    const second = Object.getOwnPropertyDescriptor(value, key);
    if (first === undefined || second === undefined || !("value" in first) || !("value" in second)) {
      return undefined;
    }

    const indexed = (value as Record<PropertyKey, unknown>)[key];
    return Object.is(first.value, second.value) &&
      Object.is(indexed, first.value) &&
      Object.is((value as Record<PropertyKey, unknown>)[key], first.value)
      ? first.value
      : undefined;
  } catch {
    return undefined;
  }
}

function exact(value: Obj, allowed: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== allowed.length) return false;

  for (let index = 0; index < allowed.length; index += 1) {
    const key = allowed[index];
    if (key === undefined || !Object.hasOwn(value, key)) return false;
  }

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string" || !hasString(allowed, key)) return false;
  }
  return true;
}

function stringList(value: Plain | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const out: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!nonEmpty(item)) return undefined;
    out[index] = item;
  }
  return out;
}

function portList(value: Plain | undefined): number[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const out: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!port(item)) return undefined;
    out[index] = item;
  }
  return out;
}

function denyAll(capabilities: readonly RequestedCapability[], code: DenialCode, reason: string): GrantDecision {
  const denied: CapabilityDenial[] = [];
  for (let index = 0; index < capabilities.length; index += 1) {
    const capability = capabilities[index];
    if (capability !== undefined) denied[denied.length] = deny(capability, code, reason);
  }
  return { granted: [], denied };
}

function denyUnknown(code: DenialCode, reason: string): GrantDecision {
  return denyAll([unknown("input")], code, reason);
}

function deny(capability: RequestedCapability, code: DenialCode, reason: string): CapabilityDenial {
  return { capability, code, reason };
}

function unknown(name: string): RequestedCapability {
  return { kind: "unknown", name };
}

function record(value: Plain | undefined): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: Plain | undefined): value is string {
  return typeof value === "string" && value !== "";
}

function dataClass(value: Plain | undefined): value is DataClass {
  return typeof value === "string" && DATA_CLASSES.has(value);
}

function accessMode(value: Plain | undefined): value is DataAccessMode {
  return typeof value === "string" && ACCESS_MODES.has(value);
}

function protocol(value: Plain | undefined): value is NetworkProtocol {
  return typeof value === "string" && NETWORK_PROTOCOLS.has(value);
}

function port(value: Plain | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function accessCovers(allowed: DataAccessMode, requested: DataAccessMode): boolean {
  return allowed === "read-write" || requested === "read-only";
}

function arrayIndexKey(key: string): boolean {
  const parsed = Number(key);
  return Number.isInteger(parsed) && parsed >= 0 && parsed < 4_294_967_295 && String(parsed) === key;
}

function hasString(values: readonly string[], target: string | undefined): boolean {
  if (target === undefined) return false;
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === target) return true;
  }
  return false;
}

function hasNumber(values: readonly number[], target: number): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === target) return true;
  }
  return false;
}

function copy<T>(values: readonly T[]): T[] {
  const out: T[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (item !== undefined) out[out.length] = item;
  }
  return out;
}
