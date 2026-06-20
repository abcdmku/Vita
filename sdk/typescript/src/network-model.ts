import { safeNormalize } from "./safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "./safe-normalize.ts";

export type Protocol = "tcp" | "udp";
export type InterfaceKind = "ethernet" | "wifi" | "loopback" | "bridge";

export interface NetworkInterface {
  readonly name: string;
  readonly kind: InterfaceKind;
}

export interface InboundRule {
  readonly protocol: Protocol;
  readonly port: number;
  readonly sourceCidr: string;
}

export interface FirewallPolicy {
  readonly allow: readonly InboundRule[];
  readonly unsafeWideOpen: boolean;
}

export interface NetworkConfig {
  readonly interfaces: readonly NetworkInterface[];
  readonly firewall: FirewallPolicy;
}

export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

export type Result =
  | { readonly ok: true; readonly config: NetworkConfig; readonly value: NetworkConfig }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

type JsonRecord = PlainJsonObject;
type Path = readonly string[];

const NETWORK_CONFIG_FIELDS = new Set(["firewall", "interfaces"]);
const INTERFACE_FIELDS = new Set(["kind", "name"]);
const FIREWALL_FIELDS = new Set(["allow", "unsafeWideOpen"]);
const RULE_FIELDS = new Set(["port", "protocol", "sourceCidr"]);

const PROTOCOLS = new Set<Protocol>(["tcp", "udp"]);
const INTERFACE_KINDS = new Set<InterfaceKind>(["ethernet", "wifi", "loopback", "bridge"]);
const INTERFACE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,14}$/u;
const WIDE_OPEN_CIDRS = new Set(["0.0.0.0/0", "::/0"]);
const MAX_INTERFACES = 64;
const MAX_RULES = 1024;

export function validateNetworkConfig(input: unknown): Result {
  try {
    const normalized = safeNormalize(input);

    if (!normalized.ok) {
      return reject([{ path: "", message: `Invalid untrusted input: ${normalized.reason}` }]);
    }

    const errors: ValidationError[] = [];
    const config = parseNetworkConfig(normalized.value, [], errors);

    if (config === undefined || errors.length > 0) {
      return reject(errors);
    }

    return { ok: true, config, value: config };
  } catch {
    return reject([{ path: "", message: "Network config validation failed." }]);
  }
}

function parseNetworkConfig(value: PlainJson, path: Path, errors: ValidationError[]): NetworkConfig | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected network config object.");
    return undefined;
  }

  const errorStart = errors.length;
  rejectUnknownFields(value, NETWORK_CONFIG_FIELDS, path, errors);

  const interfaces = parseInterfaces(value, [...path, "interfaces"], errors);
  const firewall = parseFirewall(value, [...path, "firewall"], errors);

  if (errors.length > errorStart || interfaces === undefined || firewall === undefined) {
    return undefined;
  }

  return Object.freeze({ interfaces, firewall });
}

function parseInterfaces(value: JsonRecord, path: Path, errors: ValidationError[]): readonly NetworkInterface[] | undefined {
  const child = readRequiredProperty(value, "interfaces", path, errors);
  if (child === undefined) return undefined;

  if (!Array.isArray(child)) {
    addError(errors, path, "Expected interfaces array.");
    return undefined;
  }
  if (child.length === 0) {
    addError(errors, path, "Expected at least one interface.");
    return undefined;
  }
  if (child.length > MAX_INTERFACES) {
    addError(errors, path, "Too many interfaces.");
    return undefined;
  }

  const result: NetworkInterface[] = [];
  const seen = new Set<string>();
  const errorStart = errors.length;

  for (let index = 0; index < child.length; index += 1) {
    const parsed = parseInterface(child[index], [...path, String(index)], errors);
    if (parsed === undefined) continue;
    if (seen.has(parsed.name)) {
      addError(errors, [...path, String(index), "name"], "Duplicate interface name.");
      continue;
    }
    seen.add(parsed.name);
    result.push(parsed);
  }

  if (errors.length > errorStart) return undefined;
  return Object.freeze(result);
}

function parseInterface(value: PlainJson | undefined, path: Path, errors: ValidationError[]): NetworkInterface | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected interface object.");
    return undefined;
  }

  const errorStart = errors.length;
  rejectUnknownFields(value, INTERFACE_FIELDS, path, errors);

  const name = readString(value, "name", [...path, "name"], errors);
  if (name !== undefined && !INTERFACE_NAME_PATTERN.test(name)) {
    addError(errors, [...path, "name"], "Expected a valid interface name.");
  }

  const kind = readString(value, "kind", [...path, "kind"], errors);
  if (kind !== undefined && !INTERFACE_KINDS.has(kind as InterfaceKind)) {
    addError(errors, [...path, "kind"], "Expected ethernet, wifi, loopback, or bridge.");
  }

  if (errors.length > errorStart || name === undefined || kind === undefined || !INTERFACE_NAME_PATTERN.test(name)) {
    return undefined;
  }

  return Object.freeze({ name, kind: kind as InterfaceKind });
}

function parseFirewall(value: JsonRecord, path: Path, errors: ValidationError[]): FirewallPolicy | undefined {
  const child = readRequiredProperty(value, "firewall", path, errors);
  if (child === undefined) return undefined;

  if (!isRecord(child)) {
    addError(errors, path, "Expected firewall object.");
    return undefined;
  }

  const errorStart = errors.length;
  rejectUnknownFields(child, FIREWALL_FIELDS, path, errors);

  // `allow` is REQUIRED (default-deny is expressed as an explicit empty list, not an absent field).
  const unsafeWideOpen = readOptionalBoolean(child, "unsafeWideOpen", [...path, "unsafeWideOpen"], errors) ?? false;
  const allow = parseRules(child, [...path, "allow"], unsafeWideOpen, errors);

  if (errors.length > errorStart || allow === undefined) {
    return undefined;
  }

  return Object.freeze({ allow, unsafeWideOpen });
}

function parseRules(value: JsonRecord, path: Path, unsafeWideOpen: boolean, errors: ValidationError[]): readonly InboundRule[] | undefined {
  if (!hasOwn(value, "allow") || value.allow === undefined) {
    addError(errors, path, "allow is required (use an empty array for deny-all).");
    return undefined;
  }

  const child = value.allow;
  if (!Array.isArray(child)) {
    addError(errors, path, "Expected allow array.");
    return undefined;
  }
  if (child.length > MAX_RULES) {
    addError(errors, path, "Too many rules.");
    return undefined;
  }

  const result: InboundRule[] = [];
  const errorStart = errors.length;

  for (let index = 0; index < child.length; index += 1) {
    const parsed = parseRule(child[index], [...path, String(index)], unsafeWideOpen, errors);
    if (parsed !== undefined) result.push(parsed);
  }

  if (errors.length > errorStart) return undefined;
  return Object.freeze(result);
}

function parseRule(value: PlainJson | undefined, path: Path, unsafeWideOpen: boolean, errors: ValidationError[]): InboundRule | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected rule object.");
    return undefined;
  }

  const errorStart = errors.length;
  rejectUnknownFields(value, RULE_FIELDS, path, errors);

  const protocol = readString(value, "protocol", [...path, "protocol"], errors);
  if (protocol !== undefined && !PROTOCOLS.has(protocol as Protocol)) {
    addError(errors, [...path, "protocol"], "Expected tcp or udp.");
  }

  const port = readNumber(value, "port", [...path, "port"], errors);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    addError(errors, [...path, "port"], "Expected port 1-65535.");
  }

  const sourceCidr = readString(value, "sourceCidr", [...path, "sourceCidr"], errors);
  if (sourceCidr !== undefined && !isValidCidr(sourceCidr)) {
    addError(errors, [...path, "sourceCidr"], "Expected a valid CIDR.");
  }
  if (sourceCidr !== undefined && WIDE_OPEN_CIDRS.has(sourceCidr) && !unsafeWideOpen) {
    addError(errors, [...path, "sourceCidr"], "Wide-open source requires unsafeWideOpen.");
  }

  if (
    errors.length > errorStart ||
    protocol === undefined ||
    port === undefined ||
    sourceCidr === undefined
  ) {
    return undefined;
  }

  return Object.freeze({ protocol: protocol as Protocol, port, sourceCidr });
}

function isValidCidr(value: string): boolean {
  if (value !== value.trim()) return false;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return false;

  const address = value.slice(0, slash);
  const prefixText = value.slice(slash + 1);
  if (!/^[0-9]{1,3}$/u.test(prefixText)) return false;
  const prefix = Number(prefixText);

  if (address.includes(":")) {
    return Number.isInteger(prefix) && prefix >= 0 && prefix <= 128 && isIpv6(address);
  }

  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const octets = address.split(".");
  if (octets.length !== 4) return false;
  for (const octet of octets) {
    if (!/^[0-9]{1,3}$/u.test(octet)) return false;
    const n = Number(octet);
    if (n < 0 || n > 255) return false;
    if (octet.length > 1 && octet.startsWith("0")) return false;
  }
  return true;
}

function isIpv6(value: string): boolean {
  if (value.length === 0 || /[^0-9a-f:]/u.test(value)) return false;
  const doubleColon = value.split("::");
  if (doubleColon.length > 2) return false;
  const groups = value.replace("::", ":").split(":").filter((g) => g.length > 0);
  if (groups.length > 8) return false;
  for (const group of groups) {
    if (group.length > 4) return false;
  }
  return doubleColon.length === 2 || groups.length === 8;
}

function readRequiredProperty(value: JsonRecord, key: string, path: Path, errors: ValidationError[]): PlainJson | undefined {
  if (!hasOwn(value, key) || value[key] === undefined) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }
  return value[key];
}

function readString(value: JsonRecord, key: string, path: Path, errors: ValidationError[]): string | undefined {
  const child = readRequiredProperty(value, key, path, errors);
  if (child === undefined) return undefined;
  if (typeof child !== "string") {
    addError(errors, path, "Expected string.");
    return undefined;
  }
  return child;
}

function readNumber(value: JsonRecord, key: string, path: Path, errors: ValidationError[]): number | undefined {
  const child = readRequiredProperty(value, key, path, errors);
  if (child === undefined) return undefined;
  if (typeof child !== "number" || !Number.isFinite(child)) {
    addError(errors, path, "Expected number.");
    return undefined;
  }
  return child;
}

function readOptionalBoolean(value: JsonRecord, key: string, path: Path, errors: ValidationError[]): boolean | undefined {
  if (!hasOwn(value, key) || value[key] === undefined) return undefined;
  const child = value[key];
  if (typeof child !== "boolean") {
    addError(errors, path, "Expected boolean.");
    return undefined;
  }
  return child;
}

function rejectUnknownFields(value: JsonRecord, allowed: ReadonlySet<string>, path: Path, errors: ValidationError[]): void {
  const keys = Object.keys(value).sort(compareStrings);
  for (const key of keys) {
    if (!allowed.has(key)) {
      addError(errors, [...path, key], "Unknown field.");
    }
  }
}

function isRecord(value: PlainJson | undefined): value is JsonRecord {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function addError(errors: ValidationError[], path: Path, message: string): void {
  errors.push({ message, path: formatPath(path) });
}

function reject(errors: readonly ValidationError[]): Extract<Result, { readonly ok: false }> {
  return { ok: false, errors };
}

function formatPath(path: Path): string {
  return path.map((token) => token.replaceAll("~", "~0").replaceAll("/", "~1")).join("/");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
