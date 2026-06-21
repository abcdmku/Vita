import { safeNormalize } from "./safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "./safe-normalize.ts";

export interface ServiceEntry {
  readonly name: string;
  readonly enabled: boolean;
}

export interface ServicesConfig {
  readonly services: readonly ServiceEntry[];
}

export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

export type ServicesConfigValidationResult =
  | {
      readonly ok: true;
      readonly config: ServicesConfig;
      readonly value: ServicesConfig;
    }
  | {
      readonly ok: false;
      readonly errors: readonly ValidationError[];
    };

export type Result = ServicesConfigValidationResult;

type JsonRecord = PlainJsonObject;
type Path = readonly string[];

const SERVICES_CONFIG_FIELDS = new Set(["services"]);
const SERVICE_ENTRY_FIELDS = new Set(["enabled", "name"]);

const SYSTEMD_UNIT_SUFFIXES = [
  ".service",
  ".socket",
  ".device",
  ".mount",
  ".automount",
  ".swap",
  ".target",
  ".path",
  ".timer",
  ".slice",
  ".scope",
] as const;

const MAX_SYSTEMD_UNIT_NAME_LENGTH = 256;
const SYSTEMD_UNIT_NAME_PATTERN = /^[A-Za-z0-9:._@-]+$/u;
const DATA_URL_PATTERN = /\bdata:/iu;
const PEM_BLOCK_PATTERN = /-----BEGIN\b/iu;
const LONG_BASE64_PATTERN = /[A-Za-z0-9+/]{48,}={0,2}|[A-Za-z0-9_-]{48,}/u;

export function validateServicesConfig(input: unknown): ServicesConfigValidationResult {
  try {
    const normalized = safeNormalize(input);

    if (!normalized.ok) {
      return reject([
        {
          path: "",
          message: `Invalid untrusted input: ${normalized.reason}`,
        },
      ]);
    }

    const errors: ValidationError[] = [];
    const config = parseServicesConfig(normalized.value, [], errors);

    if (config === undefined || errors.length > 0) {
      return reject(errors);
    }

    return {
      ok: true,
      config,
      value: config,
    };
  } catch {
    return reject([{ path: "", message: "Services config validation failed." }]);
  }
}

function parseServicesConfig(
  value: PlainJson,
  path: Path,
  errors: ValidationError[],
): ServicesConfig | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected services config object.");
    return undefined;
  }

  const errorStart = errors.length;

  rejectUnknownFields(value, SERVICES_CONFIG_FIELDS, path, errors);

  const services = readRequiredServices(value, [...path, "services"], errors);

  if (errors.length > errorStart || services === undefined) {
    return undefined;
  }

  return Object.freeze({
    services,
  });
}

function readRequiredServices(
  value: JsonRecord,
  path: Path,
  errors: ValidationError[],
): readonly ServiceEntry[] | undefined {
  const child = readRequiredProperty(value, "services", path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!Array.isArray(child)) {
    addError(errors, path, "Expected services array.");
    return undefined;
  }

  const services: ServiceEntry[] = [];
  const seenNames = new Map<string, number>();
  const errorStart = errors.length;

  for (let index = 0; index < child.length; index += 1) {
    const itemPath = [...path, String(index)];
    const service = parseServiceEntry(child[index], itemPath, errors);

    if (service === undefined) {
      continue;
    }

    const previousIndex = seenNames.get(service.name);

    if (previousIndex !== undefined) {
      addError(
        errors,
        [...itemPath, "name"],
        `Duplicate service name also appears at ${formatPath([
          ...path,
          String(previousIndex),
          "name",
        ])}.`,
      );
    } else {
      seenNames.set(service.name, index);
    }

    services.push(service);
  }

  if (errors.length > errorStart) {
    return undefined;
  }

  return Object.freeze(services);
}

function parseServiceEntry(
  value: PlainJson | undefined,
  path: Path,
  errors: ValidationError[],
): ServiceEntry | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected service entry object.");
    return undefined;
  }

  const errorStart = errors.length;

  rejectUnknownFields(value, SERVICE_ENTRY_FIELDS, path, errors);

  const name = readRequiredSystemdUnitName(value, "name", [...path, "name"], errors);
  const enabled = readRequiredBoolean(value, "enabled", [...path, "enabled"], errors);

  if (errors.length > errorStart || name === undefined || enabled === undefined) {
    return undefined;
  }

  return Object.freeze({
    enabled,
    name,
  });
}

function readRequiredSystemdUnitName(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): string | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (typeof child !== "string" || !isSystemdUnitName(child)) {
    addError(errors, path, "Expected valid systemd unit name.");
    return undefined;
  }

  return child;
}

function readRequiredBoolean(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): boolean | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (typeof child !== "boolean") {
    addError(errors, path, "Expected boolean.");
    return undefined;
  }

  return child;
}

function readRequiredProperty(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): PlainJson | undefined {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }

  return value[key];
}

function rejectUnknownFields(
  value: JsonRecord,
  allowed: ReadonlySet<string>,
  path: Path,
  errors: ValidationError[],
): void {
  const keys = Object.keys(value).sort(compareStrings);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && !allowed.has(key)) {
      addError(errors, [...path, key], "Unknown field.");
    }
  }
}

function isSystemdUnitName(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_SYSTEMD_UNIT_NAME_LENGTH ||
    value !== value.trim() ||
    value.startsWith(".") ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("..") ||
    !SYSTEMD_UNIT_NAME_PATTERN.test(value) ||
    containsInlineKeyMaterial(value)
  ) {
    return false;
  }

  const suffix = findSystemdUnitSuffix(value);

  return suffix !== undefined && value.length > suffix.length;
}

function findSystemdUnitSuffix(value: string): string | undefined {
  for (let index = 0; index < SYSTEMD_UNIT_SUFFIXES.length; index += 1) {
    const suffix = SYSTEMD_UNIT_SUFFIXES[index];

    if (suffix !== undefined && value.endsWith(suffix)) {
      return suffix;
    }
  }

  return undefined;
}

function containsInlineKeyMaterial(value: string): boolean {
  return DATA_URL_PATTERN.test(value) || PEM_BLOCK_PATTERN.test(value) || LONG_BASE64_PATTERN.test(value);
}

function isRecord(value: PlainJson | undefined): value is JsonRecord {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function addError(errors: ValidationError[], path: Path, message: string): void {
  errors.push({
    message,
    path: formatPath(path),
  });
}

function reject(
  errors: readonly ValidationError[],
): Extract<ServicesConfigValidationResult, { readonly ok: false }> {
  return {
    ok: false,
    errors,
  };
}

function formatPath(path: Path): string {
  return path.map(escapePathToken).join("/");
}

function escapePathToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
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
