import { safeNormalize } from "../safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "../safe-normalize.ts";
import type {
  AppWindowHints,
  WebAppDescriptor,
  WebviewRuntimeRef,
} from "../appshell/index.ts";
import { compareSemver, parseSemver } from "../semver.ts";
import type { Semver } from "../semver.ts";
import { parseRange, satisfies } from "../semver-range.ts";
import { SDK_VERSION } from "./version.ts";
import type {
  DesktopCapability,
  DesktopCapabilityGrant,
  DesktopSdkCompatibility,
} from "./ui-package.ts";

export interface AppPackageManifest {
  readonly id: string;
  readonly version: string;
  readonly sdkVersion: DesktopSdkCompatibility;
  readonly entry: string;
  readonly capabilityGrants: readonly DesktopCapabilityGrant[];
}

export interface AppPackage {
  readonly manifest: AppPackageManifest;
  readonly descriptor: WebAppDescriptor;
}

type AppPackageValidationResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: AppPackageValidationError;
    };

interface AppPackageValidationError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

const APP_PACKAGE_FIELDS = Object.freeze(["descriptor", "manifest"]);
const MANIFEST_FIELDS = Object.freeze(["capabilityGrants", "entry", "id", "sdkVersion", "version"]);
const SDK_RANGE_FIELDS = Object.freeze(["max", "maxInclusive", "min", "minInclusive"]);
const WEB_DESCRIPTOR_REQUIRED_FIELDS = Object.freeze(["id", "runtime", "surfaceKind", "title"]);
const WEB_DESCRIPTOR_OPTIONAL_FIELDS = Object.freeze(["defaultWindow"]);
const WEB_RUNTIME_REQUIRED_FIELDS = Object.freeze(["url"]);
const WEB_RUNTIME_OPTIONAL_FIELDS = Object.freeze(["partition"]);
const APP_WINDOW_FIELDS = Object.freeze(["anchor", "className", "layer", "mode", "order", "rect", "workspaceId", "zone"]);
const RECT_FIELDS = Object.freeze(["height", "width", "x", "y"]);

export function defineAppPackage(input: unknown): AppPackage {
  const normalized = normalizeAppPackage(input);

  if (!normalized.ok) {
    throw new TypeError(
      `${normalized.error.code}: ${normalized.error.message} (${normalized.error.path})`,
    );
  }

  return normalized.value;
}

export function hasAppCapabilityGrant(
  manifest: AppPackageManifest,
  capability: DesktopCapability,
  resourceId?: string,
): boolean {
  for (let index = 0; index < manifest.capabilityGrants.length; index += 1) {
    const grant = manifest.capabilityGrants[index];

    if (grant === undefined || grant.capability !== capability) continue;
    if (grant.resourceId === undefined) return true;
    if (resourceId !== undefined && grant.resourceId === resourceId) return true;
  }

  return false;
}

function normalizeAppPackage(input: unknown): AppPackageValidationResult<AppPackage> {
  const normalized = safeNormalize(input);

  if (!normalized.ok) {
    return reject("INVALID_APP_PACKAGE", normalized.reason, "/package");
  }
  if (!isPlainObject(normalized.value)) {
    return reject("INVALID_APP_PACKAGE", "app package must be a plain object.", "/package");
  }

  const fields = expectFields(normalized.value, APP_PACKAGE_FIELDS, Object.freeze([]), "/package");

  if (!fields.ok) return fields;

  const manifest = normalizeAppPackageManifest(field(normalized.value, "manifest"), SDK_VERSION);

  if (!manifest.ok) return manifest;

  const descriptor = normalizeWebAppDescriptor(
    field(normalized.value, "descriptor"),
    manifest.value,
    "/package/descriptor",
  );

  if (!descriptor.ok) return descriptor;

  return accept(Object.freeze({
    descriptor: descriptor.value,
    manifest: manifest.value,
  }));
}

function normalizeAppPackageManifest(
  input: PlainJson | undefined,
  currentSdkVersion: string,
): AppPackageValidationResult<AppPackageManifest> {
  if (!isPlainObject(input)) {
    return reject("INVALID_APP_PACKAGE_MANIFEST", "manifest must be a plain object.", "/package/manifest");
  }

  const fields = expectFields(input, MANIFEST_FIELDS, Object.freeze([]), "/package/manifest");

  if (!fields.ok) return fields;

  const id = requiredString(input, "id", "/package/manifest/id");
  const version = requiredString(input, "version", "/package/manifest/version");
  const entry = requiredString(input, "entry", "/package/manifest/entry");
  const sdkVersion = normalizeSdkCompatibility(field(input, "sdkVersion"), "/package/manifest/sdkVersion");
  const grants = normalizeCapabilityGrants(field(input, "capabilityGrants"), "/package/manifest/capabilityGrants");

  if (!id.ok) return id;
  if (!version.ok) return version;
  if (!entry.ok) return entry;
  if (!sdkVersion.ok) return sdkVersion;
  if (!grants.ok) return grants;

  const parsedVersion = parseSemver(version.value);

  if (!parsedVersion.ok) {
    return reject("INVALID_APP_PACKAGE_VERSION", parsedVersion.reason, "/package/manifest/version");
  }
  if (!isSdkVersionCompatible(sdkVersion.value, currentSdkVersion)) {
    return reject(
      "SDK_VERSION_INCOMPATIBLE",
      `App package requires an SDK version incompatible with ${currentSdkVersion}.`,
      "/package/manifest/sdkVersion",
    );
  }

  return accept(Object.freeze({
    capabilityGrants: grants.value,
    entry: entry.value,
    id: id.value,
    sdkVersion: sdkVersion.value,
    version: version.value,
  }));
}

function normalizeWebAppDescriptor(
  input: PlainJson | undefined,
  manifest: AppPackageManifest,
  path: string,
): AppPackageValidationResult<WebAppDescriptor> {
  if (!isPlainObject(input)) {
    return reject("INVALID_APP_DESCRIPTOR", "descriptor must be a plain object.", path);
  }

  const fields = expectFields(input, WEB_DESCRIPTOR_REQUIRED_FIELDS, WEB_DESCRIPTOR_OPTIONAL_FIELDS, path);

  if (!fields.ok) return fields;

  const id = requiredString(input, "id", `${path}/id`);
  const title = requiredString(input, "title", `${path}/title`);
  const runtime = normalizeWebRuntime(field(input, "runtime"), `${path}/runtime`);
  const defaultWindow = normalizeAppWindowHints(field(input, "defaultWindow"), `${path}/defaultWindow`);
  const surfaceKind = field(input, "surfaceKind");

  if (!id.ok) return id;
  if (!title.ok) return title;
  if (!runtime.ok) return runtime;
  if (!defaultWindow.ok) return defaultWindow;

  if (surfaceKind !== "web") {
    return reject("INVALID_APP_DESCRIPTOR", "descriptor surfaceKind must be web.", `${path}/surfaceKind`);
  }
  if (id.value !== manifest.id) {
    return reject("INVALID_APP_DESCRIPTOR", "descriptor id must match manifest id.", `${path}/id`);
  }
  if (runtime.value.url !== manifest.entry) {
    return reject("INVALID_APP_DESCRIPTOR", "descriptor runtime.url must match manifest entry.", `${path}/runtime/url`);
  }

  const output: {
    id: string;
    title: string;
    surfaceKind: "web";
    runtime: WebviewRuntimeRef;
    defaultWindow?: AppWindowHints;
  } = {
    id: id.value,
    runtime: runtime.value,
    surfaceKind,
    title: title.value,
  };

  if (defaultWindow.value !== undefined) output.defaultWindow = defaultWindow.value;

  return accept(Object.freeze(output));
}

function normalizeWebRuntime(
  input: PlainJson | undefined,
  path: string,
): AppPackageValidationResult<WebviewRuntimeRef> {
  if (!isPlainObject(input)) {
    return reject("INVALID_APP_DESCRIPTOR", "web runtime must be a plain object.", path);
  }

  const fields = expectFields(input, WEB_RUNTIME_REQUIRED_FIELDS, WEB_RUNTIME_OPTIONAL_FIELDS, path);

  if (!fields.ok) return fields;

  const url = requiredString(input, "url", `${path}/url`);
  const partition = optionalString(input, "partition", `${path}/partition`);

  if (!url.ok) return url;
  if (!partition.ok) return partition;

  const output: {
    url: string;
    partition?: string;
  } = {
    url: url.value,
  };

  if (partition.value !== undefined) output.partition = partition.value;

  return accept(Object.freeze(output));
}

function normalizeAppWindowHints(
  input: PlainJson | undefined,
  path: string,
): AppPackageValidationResult<AppWindowHints | undefined> {
  if (input === undefined) return accept(undefined);
  if (!isPlainObject(input)) {
    return reject("INVALID_APP_DESCRIPTOR", "defaultWindow must be a plain object.", path);
  }

  const fields = expectFields(input, Object.freeze([]), APP_WINDOW_FIELDS, path);

  if (!fields.ok) return fields;

  const workspaceId = optionalString(input, "workspaceId", `${path}/workspaceId`);
  const mode = optionalWindowMode(input, "mode", `${path}/mode`);
  const zone = optionalString(input, "zone", `${path}/zone`);
  const layer = optionalString(input, "layer", `${path}/layer`);
  const order = optionalFiniteNumber(input, "order", `${path}/order`);
  const anchor = optionalString(input, "anchor", `${path}/anchor`);
  const className = optionalString(input, "className", `${path}/className`);
  const rect = optionalRect(input, "rect", `${path}/rect`);

  if (!workspaceId.ok) return workspaceId;
  if (!mode.ok) return mode;
  if (!zone.ok) return zone;
  if (!layer.ok) return layer;
  if (!order.ok) return order;
  if (!anchor.ok) return anchor;
  if (!className.ok) return className;
  if (!rect.ok) return rect;

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

  if (workspaceId.value !== undefined) output.workspaceId = workspaceId.value;
  if (rect.value !== undefined) output.rect = rect.value;
  if (mode.value !== undefined) output.mode = mode.value;
  if (zone.value !== undefined) output.zone = zone.value;
  if (layer.value !== undefined) output.layer = layer.value;
  if (order.value !== undefined) output.order = order.value;
  if (anchor.value !== undefined) output.anchor = anchor.value;
  if (className.value !== undefined) output.className = className.value;

  return accept(Object.freeze(output));
}

function optionalRect(
  value: PlainJsonObject,
  key: string,
  path: string,
): AppPackageValidationResult<NonNullable<AppWindowHints["rect"]> | undefined> {
  const rect = field(value, key);

  if (rect === undefined) return accept(undefined);
  if (!isPlainObject(rect)) {
    return reject("INVALID_APP_DESCRIPTOR", "window rect must be a plain object.", path);
  }

  const fields = expectFields(rect, RECT_FIELDS, Object.freeze([]), path);

  if (!fields.ok) return fields;

  const x = requiredFiniteNumber(rect, "x", `${path}/x`);
  const y = requiredFiniteNumber(rect, "y", `${path}/y`);
  const width = requiredFiniteNumber(rect, "width", `${path}/width`);
  const height = requiredFiniteNumber(rect, "height", `${path}/height`);

  if (!x.ok) return x;
  if (!y.ok) return y;
  if (!width.ok) return width;
  if (!height.ok) return height;

  return accept(Object.freeze({
    height: height.value,
    width: width.value,
    x: x.value,
    y: y.value,
  }));
}

function normalizeSdkCompatibility(
  value: PlainJson | undefined,
  path: string,
): AppPackageValidationResult<DesktopSdkCompatibility> {
  if (typeof value === "string") {
    const parsed = parseSemver(value);

    if (!parsed.ok) return reject("INVALID_SDK_VERSION", parsed.reason, path);

    return accept(value);
  }
  if (!isPlainObject(value)) {
    return reject("INVALID_SDK_VERSION", "sdkVersion must be a semver string or explicit range.", path);
  }

  const fields = expectFields(value, Object.freeze([]), SDK_RANGE_FIELDS, path);

  if (!fields.ok) return fields;

  const parsed = parseRange(value);

  if (!parsed.ok) return reject("INVALID_SDK_VERSION", parsed.reason, path);

  const output: {
    min?: string;
    minInclusive?: boolean;
    max?: string;
    maxInclusive?: boolean;
  } = {};
  const min = field(value, "min");
  const minInclusive = field(value, "minInclusive");
  const max = field(value, "max");
  const maxInclusive = field(value, "maxInclusive");

  if (typeof min === "string") output.min = min;
  if (typeof minInclusive === "boolean") output.minInclusive = minInclusive;
  if (typeof max === "string") output.max = max;
  if (typeof maxInclusive === "boolean") output.maxInclusive = maxInclusive;

  return accept(Object.freeze(output));
}

function normalizeCapabilityGrants(
  value: PlainJson | undefined,
  path: string,
): AppPackageValidationResult<readonly DesktopCapabilityGrant[]> {
  if (!Array.isArray(value)) {
    return reject("INVALID_CAPABILITY_GRANTS", "capabilityGrants must be an array.", path);
  }

  const output: DesktopCapabilityGrant[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < value.length; index += 1) {
    const grant = value[index];

    if (!isPlainObject(grant)) {
      return reject("INVALID_CAPABILITY_GRANT", "capability grant must be an object.", `${path}/${index}`);
    }

    const fields = expectFields(
      grant,
      Object.freeze(["capability"]),
      Object.freeze(["resourceId"]),
      `${path}/${index}`,
    );

    if (!fields.ok) return fields;

    const capabilityValue = field(grant, "capability");
    const resourceIdValue = field(grant, "resourceId");

    if (!isDesktopCapability(capabilityValue)) {
      return reject("INVALID_CAPABILITY_GRANT", "capability is not supported.", `${path}/${index}/capability`);
    }
    if (resourceIdValue !== undefined && (typeof resourceIdValue !== "string" || resourceIdValue.length === 0)) {
      return reject("INVALID_CAPABILITY_GRANT", "resourceId must be a non-empty string.", `${path}/${index}/resourceId`);
    }

    const seenKey = `${capabilityValue}\u0000${resourceIdValue ?? "*"}`;

    if (seen.has(seenKey)) {
      return reject("INVALID_CAPABILITY_GRANT", "capability grants must be unique.", `${path}/${index}`);
    }

    seen.add(seenKey);

    const normalized: {
      capability: DesktopCapability;
      resourceId?: string;
    } = {
      capability: capabilityValue,
    };

    if (resourceIdValue !== undefined) normalized.resourceId = resourceIdValue;
    output.push(Object.freeze(normalized));
  }

  return accept(Object.freeze(output));
}

function isSdkVersionCompatible(
  compatibility: DesktopSdkCompatibility,
  currentSdkVersion: string,
): boolean {
  if (typeof compatibility === "string") {
    return isSemverCompatible(compatibility, currentSdkVersion);
  }

  return satisfies(currentSdkVersion, compatibility);
}

function isSemverCompatible(required: string, current: string): boolean {
  const requiredSemver = parseSemver(required);
  const currentSemver = parseSemver(current);

  if (!requiredSemver.ok || !currentSemver.ok) return false;
  if (!sameCompatibleLine(requiredSemver.value, currentSemver.value)) return false;

  return compareSemver(currentSemver.value, requiredSemver.value) >= 0;
}

function sameCompatibleLine(required: Semver, current: Semver): boolean {
  if (required.major !== current.major) return false;
  if (required.major === 0 && required.minor !== current.minor) return false;

  return true;
}

function expectFields(
  value: PlainJsonObject,
  requiredFields: readonly string[],
  optionalFields: readonly string[],
  path: string,
): AppPackageValidationResult<true> {
  const keys = Object.keys(value);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && !contains(requiredFields, key) && !contains(optionalFields, key)) {
      return reject("UNEXPECTED_FIELD", "object contains an unsupported field.", `${path}/${pathToken(key)}`);
    }
  }

  for (let index = 0; index < requiredFields.length; index += 1) {
    const key = requiredFields[index];

    if (key !== undefined && !Object.hasOwn(value, key)) {
      return reject("MISSING_FIELD", "object is missing a required field.", `${path}/${key}`);
    }
  }

  return accept(true);
}

function requiredString(
  value: PlainJsonObject,
  key: string,
  path: string,
): AppPackageValidationResult<string> {
  const current = field(value, key);

  if (typeof current !== "string" || current.length === 0) {
    return reject("INVALID_STRING", "field must be a non-empty string.", path);
  }

  return accept(current);
}

function optionalString(
  value: PlainJsonObject,
  key: string,
  path: string,
): AppPackageValidationResult<string | undefined> {
  const current = field(value, key);

  if (current === undefined) return accept(undefined);
  if (typeof current !== "string") {
    return reject("INVALID_STRING", "field must be a string when present.", path);
  }

  return accept(current);
}

function requiredFiniteNumber(
  value: PlainJsonObject,
  key: string,
  path: string,
): AppPackageValidationResult<number> {
  const current = field(value, key);

  if (typeof current !== "number" || !Number.isFinite(current)) {
    return reject("INVALID_NUMBER", "field must be a finite number.", path);
  }

  return accept(current);
}

function optionalFiniteNumber(
  value: PlainJsonObject,
  key: string,
  path: string,
): AppPackageValidationResult<number | undefined> {
  const current = field(value, key);

  if (current === undefined) return accept(undefined);
  if (typeof current !== "number" || !Number.isFinite(current)) {
    return reject("INVALID_NUMBER", "field must be a finite number when present.", path);
  }

  return accept(current);
}

function optionalWindowMode(
  value: PlainJsonObject,
  key: string,
  path: string,
): AppPackageValidationResult<NonNullable<AppWindowHints["mode"]> | undefined> {
  const current = field(value, key);

  if (current === undefined) return accept(undefined);
  if (current !== "floating" && current !== "tiled") {
    return reject("INVALID_APP_DESCRIPTOR", "window mode must be floating or tiled when present.", path);
  }

  return accept(current);
}

function isDesktopCapability(value: PlainJson | undefined): value is DesktopCapability {
  return (
    value === "apps.launch" ||
    value === "apps.stop" ||
    value === "files.read" ||
    value === "files.write" ||
    value === "launcher.launch" ||
    value === "settings.read" ||
    value === "settings.write" ||
    value === "shell.notifications.post" ||
    value === "shell.tray.register"
  );
}

function field(value: PlainJsonObject, key: string): PlainJson | undefined {
  if (!Object.hasOwn(value, key)) return undefined;

  return value[key];
}

function isPlainObject(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function contains(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }

  return false;
}

function pathToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function accept<T>(value: T): AppPackageValidationResult<T> {
  return {
    ok: true,
    value,
  };
}

function reject<T>(code: string, message: string, path: string): AppPackageValidationResult<T> {
  return {
    error: {
      code,
      message,
      path,
    },
    ok: false,
  };
}
