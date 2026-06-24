import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { parseSriIntegrity } from "../../../sdk/typescript/src/sri.ts";
import type { ParsedSriIntegrity, SriAlgorithm } from "../../../sdk/typescript/src/sri.ts";
import { safeNormalize } from "../../../sdk/typescript/src/safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "../../../sdk/typescript/src/safe-normalize.ts";
import type { MirrorStore } from "./mirror.ts";

export interface MirrorFetcher {
  readonly fetch: (url: string) => Promise<Uint8Array>;
}

export interface FetchAndStoreSpec {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly mirrorUrl: string;
}

export interface FetchAndStoreDeps {
  readonly fetcher: MirrorFetcher;
  readonly root: string;
  readonly mirrorBaseUrl?: string;
  readonly allowedMirrorOrigins?: readonly string[];
  readonly timeoutMs?: number;
}

export interface StoredMirrorArtifact {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly key: string;
  readonly path: string;
}

export interface StoreError {
  readonly code:
    | "INVALID_SPEC"
    | "REMOTE_REJECTED"
    | "LIFECYCLE_REJECTED"
    | "FETCH_FAILED"
    | "INTEGRITY_MISMATCH"
    | "STORE_IO";
  readonly path: string;
  readonly message: string;
}

export type FetchAndStoreResult =
  | {
      readonly ok: true;
      readonly stored: StoredMirrorArtifact;
    }
  | {
      readonly ok: false;
      readonly errors: readonly StoreError[];
    };

type Path = readonly string[];

interface NormalizedSpec {
  readonly name: string;
  readonly version: string;
  readonly integrity: ParsedSriIntegrity;
  readonly integrityValue: string;
  readonly mirrorUrl: string;
}

interface NormalizedDeps {
  readonly fetch: (url: string) => Promise<unknown>;
  readonly root: string;
  readonly mirrorBaseUrl?: string;
  readonly allowedMirrorOrigins: readonly string[];
  readonly timeoutMs: number;
}

interface StoreIndexEntry {
  readonly key: string;
  readonly integrity: string;
}

const INDEX_FILE = "index.json";
const LOCAL_MIRROR_PREFIXES = ["local-mirror://", "vita-mirror://"] as const;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const MAX_FETCH_TIMEOUT_MS = 300_000;
const TEMP_ATTEMPTS = 8;

const SCRIPT_CONTAINER_FIELDS = new Set(["lifecycle", "scripts"]);
const SCRIPT_INDICATOR_FIELDS = new Set(["hasInstallScript", "requiresBuild"]);
const DIRECT_LIFECYCLE_FIELDS = new Set([
  "install",
  "postinstall",
  "postpack",
  "postprepare",
  "postpublish",
  "postrestart",
  "poststart",
  "poststop",
  "posttest",
  "postuninstall",
  "postversion",
  "preinstall",
  "prepack",
  "prepare",
  "preprepare",
  "prepublish",
  "prepublishOnly",
  "prepublishonly",
  "prerestart",
  "prestart",
  "prestop",
  "pretest",
  "preuninstall",
  "preversion",
  "publish",
  "rebuild",
  "restart",
  "start",
  "stop",
  "uninstall",
]);

const SPEC_FIELDS = new Set(["integrity", "mirrorUrl", "name", "version"]);

const EXACT_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const HEX_PATTERN = /^[0-9a-f]+$/u;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/u;

export class OnDiskMirrorStore implements MirrorStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = typeof root === "string" ? root : "";
  }

  get(key: string): Uint8Array | undefined {
    try {
      if (!isSafeStoreKey(key)) {
        return undefined;
      }

      const root = resolveStoreRoot(this.#root);
      if (root === undefined) {
        return undefined;
      }

      const index = readIndexForStore(root);
      const integrity = index.get(key);
      if (integrity === undefined) {
        return undefined;
      }

      const parsed = parseSriIntegrity(integrity);
      if (!parsed.ok) {
        return undefined;
      }

      const blobPath = contentPath(root, parsed.integrity);
      if (blobPath === undefined) {
        return undefined;
      }

      const bytes = readFileSync(blobPath);
      return verifyBytes(bytes, parsed.integrity) ? bytes : undefined;
    } catch {
      return undefined;
    }
  }
}

export async function fetchAndStore(
  specInput: unknown,
  depsInput: unknown,
): Promise<FetchAndStoreResult> {
  try {
    const deps = normalizeDeps(depsInput);
    if (!deps.ok) {
      return reject([deps.error]);
    }

    const spec = normalizeSpec(specInput);
    if (!spec.ok) {
      return reject(spec.errors);
    }

    const fetchUrl = resolveMirrorFetchUrl(spec.value.mirrorUrl, deps.value);
    if (!fetchUrl.ok) {
      return reject([fetchUrl.error]);
    }

    const fetched = await fetchWithTimeout(deps.value.fetch, fetchUrl.url, deps.value.timeoutMs);
    if (!fetched.ok) {
      return reject([fetched.error]);
    }

    if (!verifyBytes(fetched.bytes, spec.value.integrity)) {
      return reject([
        error(
          "INTEGRITY_MISMATCH",
          ["integrity"],
          "Fetched mirror artifact does not match the pinned SRI integrity.",
        ),
      ]);
    }

    const stored = await storeVerifiedArtifact(spec.value, fetched.bytes, deps.value.root);
    if (!stored.ok) {
      return reject([stored.error]);
    }

    return {
      ok: true,
      stored: stored.value,
    };
  } catch {
    return reject([
      error("STORE_IO", [], "Mirror artifact fetch/store failed closed."),
    ]);
  }
}

function normalizeSpec(input: unknown):
  | {
      readonly ok: true;
      readonly value: NormalizedSpec;
    }
  | {
      readonly ok: false;
      readonly errors: readonly StoreError[];
    } {
  const normalized = safeNormalize(input, { maxDepth: 32, maxNodes: 1_000 });
  if (!normalized.ok) {
    return reject([
      error("INVALID_SPEC", [], `Spec could not be safely normalized: ${normalized.reason}`),
    ]);
  }

  if (!plainObject(normalized.value)) {
    return reject([error("INVALID_SPEC", [], "Expected mirror artifact spec object.")]);
  }

  const errors: StoreError[] = [];
  const keys = sortedKeys(normalized.value);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) {
      continue;
    }

    if (DIRECT_LIFECYCLE_FIELDS.has(key) || SCRIPT_CONTAINER_FIELDS.has(key) || SCRIPT_INDICATOR_FIELDS.has(key)) {
      errors[errors.length] = error(
        "LIFECYCLE_REJECTED",
        [key],
        "Lifecycle scripts and build indicators are not allowed for mirrored artifacts.",
      );
      continue;
    }

    if (!SPEC_FIELDS.has(key)) {
      errors[errors.length] = error("INVALID_SPEC", [key], "Unknown mirror artifact spec field.");
    }
  }

  const name = normalized.value.name;
  if (typeof name !== "string" || !isPackageName(name)) {
    errors[errors.length] = error("INVALID_SPEC", ["name"], "Expected package name.");
  }

  const version = normalized.value.version;
  if (typeof version !== "string" || !isExactVersion(version)) {
    errors[errors.length] = error("INVALID_SPEC", ["version"], "Expected exact semantic version.");
  }

  const integrity = parseSriIntegrity(normalized.value.integrity);
  if (!integrity.ok) {
    errors[errors.length] = error(
      "INVALID_SPEC",
      ["integrity"],
      `Expected valid SRI integrity: ${integrity.reason}`,
    );
  }

  const mirrorUrl = normalized.value.mirrorUrl;
  if (typeof mirrorUrl !== "string" || mirrorUrl === "" || hasControl(mirrorUrl)) {
    errors[errors.length] = error("REMOTE_REJECTED", ["mirrorUrl"], "Expected mirror URL string.");
  }

  if (errors.length > 0) {
    return reject(errors);
  }

  if (
    typeof name !== "string" ||
    typeof version !== "string" ||
    typeof mirrorUrl !== "string" ||
    !integrity.ok
  ) {
    return reject([error("INVALID_SPEC", [], "Mirror artifact spec validation failed closed.")]);
  }

  return {
    ok: true,
    value: {
      integrity: integrity.integrity,
      integrityValue: integrity.integrity.value,
      mirrorUrl,
      name,
      version,
    },
  };
}

function normalizeDeps(input: unknown):
  | {
      readonly ok: true;
      readonly value: NormalizedDeps;
    }
  | {
      readonly ok: false;
      readonly error: StoreError;
    } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      error: error("STORE_IO", [], "Expected fetchAndStore dependency object."),
      ok: false,
    };
  }

  const root = ownDataValue(input, "root");
  if (typeof root !== "string" || root === "" || hasControl(root)) {
    return {
      error: error("STORE_IO", ["root"], "Expected store root path string."),
      ok: false,
    };
  }

  const fetcher = ownDataValue(input, "fetcher");
  if (fetcher === undefined || fetcher === null || typeof fetcher !== "object" || Array.isArray(fetcher)) {
    return {
      error: error("STORE_IO", ["fetcher"], "Expected mirror fetcher object."),
      ok: false,
    };
  }

  const fetchValue = ownDataValue(fetcher, "fetch");
  if (typeof fetchValue !== "function") {
    return {
      error: error("STORE_IO", ["fetcher", "fetch"], "Expected mirror fetch function."),
      ok: false,
    };
  }

  const mirrorBaseUrl = ownDataValue(input, "mirrorBaseUrl");
  if (mirrorBaseUrl !== undefined && (typeof mirrorBaseUrl !== "string" || mirrorBaseUrl === "" || hasControl(mirrorBaseUrl))) {
    return {
      error: error("STORE_IO", ["mirrorBaseUrl"], "Expected mirror base URL string."),
      ok: false,
    };
  }

  const allowedMirrorOrigins = ownDataValue(input, "allowedMirrorOrigins");
  const origins = normalizeAllowedOrigins(allowedMirrorOrigins, mirrorBaseUrl);
  if (!origins.ok) {
    return {
      error: origins.error,
      ok: false,
    };
  }

  const timeoutValue = ownDataValue(input, "timeoutMs");
  const timeoutMs =
    timeoutValue === undefined
      ? DEFAULT_FETCH_TIMEOUT_MS
      : allowedTimeout(timeoutValue);

  if (timeoutMs === undefined) {
    return {
      error: error("STORE_IO", ["timeoutMs"], "Expected fetch timeout in milliseconds."),
      ok: false,
    };
  }

  const value: NormalizedDeps = typeof mirrorBaseUrl === "string"
    ? {
        allowedMirrorOrigins: origins.value,
        fetch: async (url: string): Promise<unknown> => {
          const output: unknown = Reflect.apply(fetchValue, fetcher, [url]);
          return await output;
        },
        mirrorBaseUrl,
        root,
        timeoutMs,
      }
    : {
        allowedMirrorOrigins: origins.value,
        fetch: async (url: string): Promise<unknown> => {
          const output: unknown = Reflect.apply(fetchValue, fetcher, [url]);
          return await output;
        },
        root,
        timeoutMs,
      };

  return {
    ok: true,
    value,
  };
}

function resolveMirrorFetchUrl(
  mirrorUrl: string,
  deps: NormalizedDeps,
):
  | {
      readonly ok: true;
      readonly url: string;
    }
  | {
      readonly ok: false;
      readonly error: StoreError;
    } {
  const localReference = localMirrorReference(mirrorUrl);
  if (localReference !== undefined) {
    if (!isSafeMirrorReference(localReference)) {
      return {
        error: error("REMOTE_REJECTED", ["mirrorUrl"], "Expected safe local mirror reference."),
        ok: false,
      };
    }

    if (deps.mirrorBaseUrl === undefined) {
      return {
        error: error("REMOTE_REJECTED", ["mirrorUrl"], "Local mirror references require a configured mirror base URL."),
        ok: false,
      };
    }

    const resolved = resolveAgainstMirrorBase(localReference, deps.mirrorBaseUrl);
    if (resolved === undefined) {
      return {
        error: error("REMOTE_REJECTED", ["mirrorUrl"], "Expected mirror URL under the configured mirror base."),
        ok: false,
      };
    }

    return {
      ok: true,
      url: resolved,
    };
  }

  const explicit = parseHttpUrl(mirrorUrl);
  if (explicit === undefined || !hasString(deps.allowedMirrorOrigins, explicit.origin)) {
    return {
      error: error("REMOTE_REJECTED", ["mirrorUrl"], "Remote artifact URL is not an allowed mirror origin."),
      ok: false,
    };
  }

  return {
    ok: true,
    url: explicit.href,
  };
}

async function fetchWithTimeout(
  fetch: (url: string) => Promise<unknown>,
  url: string,
  timeoutMs: number,
): Promise<
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
    }
  | {
      readonly ok: false;
      readonly error: StoreError;
    }
> {
  let timer: NodeJS.Timeout | undefined;

  try {
    const timeout = new Promise<never>((_, rejectTimeout) => {
      timer = setTimeout(() => {
        rejectTimeout(new Error("mirror fetch timed out"));
      }, timeoutMs);
    });

    const value: unknown = await Promise.race([fetch(url), timeout]);
    if (!(value instanceof Uint8Array)) {
      return {
        error: error("FETCH_FAILED", ["mirrorUrl"], "Mirror fetcher returned non-byte artifact."),
        ok: false,
      };
    }

    return {
      bytes: value,
      ok: true,
    };
  } catch {
    return {
      error: error("FETCH_FAILED", ["mirrorUrl"], "Mirror fetch failed."),
      ok: false,
    };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function storeVerifiedArtifact(
  spec: NormalizedSpec,
  bytes: Uint8Array,
  rootInput: string,
): Promise<
  | {
      readonly ok: true;
      readonly value: StoredMirrorArtifact;
    }
  | {
      readonly ok: false;
      readonly error: StoreError;
    }
> {
  try {
    const root = resolveStoreRoot(rootInput);
    if (root === undefined) {
      return {
        error: error("STORE_IO", ["root"], "Store root path is not safe."),
        ok: false,
      };
    }

    const blobPath = contentPath(root, spec.integrity);
    if (blobPath === undefined) {
      return {
        error: error("STORE_IO", ["integrity"], "Could not derive content-addressed blob path."),
        ok: false,
      };
    }

    const index = await readIndexForUpdate(root);
    if (!index.ok) {
      return {
        error: index.error,
        ok: false,
      };
    }

    if (!verifyBytes(bytes, spec.integrity)) {
      return {
        error: error(
          "INTEGRITY_MISMATCH",
          ["integrity"],
          "Fetched mirror artifact does not match the pinned SRI integrity.",
        ),
        ok: false,
      };
    }

    const stableBytes = new Uint8Array(bytes);

    await mkdir(dirname(blobPath), { recursive: true });

    if (!existingVerifiedBlob(blobPath, spec.integrity)) {
      await atomicWriteFile(root, blobPath, stableBytes);
    }

    const key = packageKey(spec.name, spec.version);
    index.entries.set(key, spec.integrityValue);
    await atomicWriteFile(root, join(root, INDEX_FILE), indexJson(index.entries));

    return {
      ok: true,
      value: {
        integrity: spec.integrityValue,
        key,
        name: spec.name,
        path: blobPath,
        version: spec.version,
      },
    };
  } catch {
    return {
      error: error("STORE_IO", [], "Could not write mirror artifact store."),
      ok: false,
    };
  }
}

async function atomicWriteFile(root: string, target: string, content: Uint8Array | string): Promise<void> {
  if (!isPathInside(root, target)) {
    throw new Error("target outside store root");
  }

  await mkdir(root, { recursive: true });

  let tempPath: string | undefined;
  let handle:
    | Awaited<ReturnType<typeof open>>
    | undefined;

  try {
    for (let attempt = 0; attempt < TEMP_ATTEMPTS; attempt += 1) {
      const candidate = join(root, `.mirror-store-${randomBytes(16).toString("hex")}.tmp`);
      if (!isPathInside(root, candidate)) {
        throw new Error("temp outside store root");
      }

      try {
        handle = await open(candidate, "wx", 0o600);
        tempPath = candidate;
        break;
      } catch (candidateError) {
        if (!isNodeError(candidateError) || candidateError.code !== "EEXIST") {
          throw candidateError;
        }
      }
    }

    if (handle === undefined || tempPath === undefined) {
      throw new Error("could not allocate temp file");
    }

    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;

    await rename(tempPath, target);
    tempPath = undefined;
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }

    if (tempPath !== undefined) {
      await unlink(tempPath).catch(() => undefined);
    }
  }
}

function readIndexForStore(root: string): Map<string, string> {
  try {
    const raw = readFileSync(join(root, INDEX_FILE), "utf8");
    return parseIndexJson(raw);
  } catch {
    return new Map<string, string>();
  }
}

async function readIndexForUpdate(root: string): Promise<
  | {
      readonly ok: true;
      readonly entries: Map<string, string>;
    }
  | {
      readonly ok: false;
      readonly error: StoreError;
    }
> {
  try {
    const raw = await readFile(join(root, INDEX_FILE), "utf8");
    return {
      entries: parseIndexJson(raw),
      ok: true,
    };
  } catch (cause) {
    if (isNodeError(cause) && cause.code === "ENOENT") {
      return {
        entries: new Map<string, string>(),
        ok: true,
      };
    }

    return {
      error: error("STORE_IO", [INDEX_FILE], "Could not read mirror store index."),
      ok: false,
    };
  }
}

function parseIndexJson(raw: string): Map<string, string> {
  const parsed: unknown = JSON.parse(raw);
  const entries = new Map<string, string>();

  if (!recordObject(parsed)) {
    return entries;
  }

  const keys = Object.keys(parsed).sort(compareStrings);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined || !isSafeStoreKey(key)) {
      continue;
    }

    const value = parsed[key];
    if (typeof value === "string" && parseSriIntegrity(value).ok) {
      entries.set(key, value);
    }
  }

  return entries;
}

function indexJson(entries: ReadonlyMap<string, string>): string {
  const safeEntries: StoreIndexEntry[] = [];

  for (const [key, integrity] of entries) {
    if (isSafeStoreKey(key) && parseSriIntegrity(integrity).ok) {
      safeEntries[safeEntries.length] = { integrity, key };
    }
  }

  safeEntries.sort(compareIndexEntries);

  const lines: string[] = ["{"];
  for (let index = 0; index < safeEntries.length; index += 1) {
    const entry = safeEntries[index];
    if (entry === undefined) {
      continue;
    }

    const comma = index === safeEntries.length - 1 ? "" : ",";
    lines[lines.length] = `  ${JSON.stringify(entry.key)}: ${JSON.stringify(entry.integrity)}${comma}`;
  }

  lines[lines.length] = "}";
  return `${lines.join("\n")}\n`;
}

function contentPath(root: string, integrity: ParsedSriIntegrity): string | undefined {
  const hex = digestHex(integrity);
  if (hex === undefined || !isSafeAlgorithm(integrity.algorithm)) {
    return undefined;
  }

  const shard = hex.slice(0, 2);
  if (shard.length !== 2 || !safePathComponent(shard) || !safePathComponent(hex)) {
    return undefined;
  }

  const target = join(root, integrity.algorithm, shard, hex);
  return isPathInside(root, target) ? target : undefined;
}

function digestHex(integrity: ParsedSriIntegrity): string | undefined {
  const digest = Buffer.from(integrity.digest, "base64");
  if (digest.length !== integrity.byteLength) {
    return undefined;
  }

  const hex = digest.toString("hex");
  return HEX_PATTERN.test(hex) ? hex : undefined;
}

function verifyBytes(bytes: Uint8Array, integrity: ParsedSriIntegrity): boolean {
  const expected = Buffer.from(integrity.digest, "base64");
  if (expected.length !== integrity.byteLength) {
    return false;
  }

  const actual = createHash(integrity.algorithm).update(bytes).digest();
  return actual.length === expected.length && Buffer.compare(actual, expected) === 0;
}

function existingVerifiedBlob(path: string, integrity: ParsedSriIntegrity): boolean {
  try {
    const bytes = readFileSync(path);
    return verifyBytes(bytes, integrity);
  } catch {
    return false;
  }
}

function resolveStoreRoot(root: string): string | undefined {
  if (root === "" || hasControl(root)) {
    return undefined;
  }

  return resolve(root);
}

function isPathInside(root: string, target: string): boolean {
  const relativePath = relative(root, resolve(target));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function localMirrorReference(value: string): string | undefined {
  for (let index = 0; index < LOCAL_MIRROR_PREFIXES.length; index += 1) {
    const prefix = LOCAL_MIRROR_PREFIXES[index];
    if (prefix !== undefined && value.startsWith(prefix)) {
      return value.slice(prefix.length);
    }
  }

  return undefined;
}

function isSafeMirrorReference(value: string): boolean {
  if (value === "" || hasControl(value) || value.startsWith("//") || SCHEME_PATTERN.test(value)) {
    return false;
  }

  const withoutLeadingSlash = stripLeadingSlashes(value);
  if (withoutLeadingSlash === "") {
    return false;
  }

  const pathPart = withoutLeadingSlash.split(/[?#]/u)[0];
  if (pathPart === undefined || pathPart === "") {
    return false;
  }

  const segments = pathPart.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined || segment === "." || segment === "..") {
      return false;
    }
  }

  return true;
}

function resolveAgainstMirrorBase(reference: string, baseUrl: string): string | undefined {
  try {
    const base = parseHttpUrl(baseUrl);
    if (base === undefined) {
      return undefined;
    }

    const normalizedReference = stripLeadingSlashes(reference);
    const baseHref = mirrorBaseHref(base);
    const resolved = new URL(normalizedReference, baseHref);
    return resolved.origin === base.origin && isUrlPathUnderBase(resolved, base)
      ? resolved.href
      : undefined;
  } catch {
    return undefined;
  }
}

function mirrorBaseHref(base: URL): string {
  if (!base.pathname.endsWith("/")) {
    base.pathname = `${base.pathname}/`;
  }

  return base.href;
}

function isUrlPathUnderBase(resolved: URL, base: URL): boolean {
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  return basePath === "/" || resolved.pathname.startsWith(basePath);
}

function parseHttpUrl(value: string): URL | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeAllowedOrigins(
  value: unknown,
  mirrorBaseUrl: unknown,
):
  | {
      readonly ok: true;
      readonly value: readonly string[];
    }
  | {
      readonly ok: false;
      readonly error: StoreError;
    } {
  const origins: string[] = [];

  if (typeof mirrorBaseUrl === "string") {
    const parsedBase = parseHttpUrl(mirrorBaseUrl);
    if (parsedBase === undefined) {
      return {
        error: error("STORE_IO", ["mirrorBaseUrl"], "Expected HTTP(S) mirror base URL."),
        ok: false,
      };
    }

    origins[origins.length] = parsedBase.origin;
  }

  if (value === undefined) {
    return {
      ok: true,
      value: origins,
    };
  }

  if (!Array.isArray(value)) {
    return {
      error: error("STORE_IO", ["allowedMirrorOrigins"], "Expected allowed mirror origins array."),
      ok: false,
    };
  }

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string" || item === "" || hasControl(item)) {
      return {
        error: error("STORE_IO", ["allowedMirrorOrigins", String(index)], "Expected mirror origin string."),
        ok: false,
      };
    }

    const parsed = parseHttpUrl(item);
    if (parsed === undefined) {
      return {
        error: error("STORE_IO", ["allowedMirrorOrigins", String(index)], "Expected HTTP(S) mirror origin."),
        ok: false,
      };
    }

    if (!hasString(origins, parsed.origin)) {
      origins[origins.length] = parsed.origin;
    }
  }

  return {
    ok: true,
    value: origins,
  };
}

function ownDataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
    return undefined;
  }

  return descriptor.value;
}

function recordObject(value: unknown): value is { readonly [key: string]: unknown } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function plainObject(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function isExactVersion(value: string): boolean {
  return EXACT_VERSION_PATTERN.test(value);
}

function isPackageName(value: string): boolean {
  return PACKAGE_NAME_PATTERN.test(value);
}

function isSafeStoreKey(value: string): boolean {
  const separator = value.lastIndexOf("@");
  if (separator <= 0 || separator === value.length - 1 || hasControl(value)) {
    return false;
  }

  return isPackageName(value.slice(0, separator)) && isExactVersion(value.slice(separator + 1));
}

function packageKey(name: string, version: string): string {
  return `${name}@${version}`;
}

function isSafeAlgorithm(value: SriAlgorithm): boolean {
  return value === "sha256" || value === "sha384" || value === "sha512";
}

function safePathComponent(value: string): boolean {
  return value !== "" && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\") && !hasControl(value);
}

function hasControl(value: string): boolean {
  return CONTROL_PATTERN.test(value);
}

function stripLeadingSlashes(value: string): string {
  let index = 0;
  while (index < value.length && value.charAt(index) === "/") {
    index += 1;
  }

  return value.slice(index);
}

function allowedTimeout(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_FETCH_TIMEOUT_MS
    ? value
    : undefined;
}

function sortedKeys(value: PlainJsonObject): string[] {
  return Object.keys(value).sort(compareStrings);
}

function compareIndexEntries(left: StoreIndexEntry, right: StoreIndexEntry): number {
  return compareStrings(left.key, right.key);
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

function hasString(values: readonly string[], target: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === target) {
      return true;
    }
  }

  return false;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function error(code: StoreError["code"], path: Path, message: string): StoreError {
  return {
    code,
    message,
    path: formatPath(path),
  };
}

function reject(errors: readonly StoreError[]): {
  readonly ok: false;
  readonly errors: readonly StoreError[];
} {
  return {
    errors,
    ok: false,
  };
}

function formatPath(path: Path): string {
  return path.map(escapePathToken).join("/");
}

function escapePathToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}
