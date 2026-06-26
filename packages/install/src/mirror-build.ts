import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { parseSriIntegrity } from "../../../sdk/typescript/src/sri.ts";
import type { ParsedSriIntegrity, SriAlgorithm } from "../../../sdk/typescript/src/sri.ts";
import { resolveFromMirror } from "./mirror.ts";
import type {
  MirrorResolutionError,
  MirrorStore,
} from "./mirror.ts";
import { fetchAndStore } from "./mirror-store.ts";
import type { StoreError } from "./mirror-store.ts";

export interface MirrorBuildInput {
  readonly lockfile: unknown;
  readonly tarballs: MirrorBuildTarballs;
  readonly root: string;
}

export type MirrorBuildTarballs =
  | ReadonlyMap<string, Uint8Array>
  | Readonly<Record<string, Uint8Array>>;

export interface MirrorBuildManifestEntry {
  readonly sri: string;
  readonly path: string;
}

export type MirrorBuildManifest = Readonly<Record<string, MirrorBuildManifestEntry>>;

export interface MirrorBuildError {
  readonly code:
    | "INVALID_INPUT"
    | "POLICY_REJECTED"
    | "MISSING_TARBALL"
    | "INTEGRITY_MISMATCH"
    | "STORE_IO";
  readonly path: string;
  readonly message: string;
}

export type MirrorBuildResult =
  | {
      readonly ok: true;
      readonly manifest: MirrorBuildManifest;
    }
  | {
      readonly ok: false;
      readonly errors: readonly MirrorBuildError[];
    };

type Path = readonly string[];

interface NormalizedBuildInput {
  readonly lockfile: unknown;
  readonly root: string;
  readonly tarballs: ReadonlyMap<string, Uint8Array>;
}

interface DataSnapshot {
  readonly ok: true;
  readonly values: ReadonlyMap<string, unknown>;
}

const BUILD_INPUT_FIELDS = new Set(["lockfile", "root", "tarballs"]);
const OFFLINE_MIRROR_BASE_URL = "https://offline-mirror.invalid/";

export async function buildMirrorStore(input: unknown): Promise<MirrorBuildResult> {
  try {
    const normalized = normalizeBuildInput(input);
    if (!normalized.ok) {
      return reject([normalized.error]);
    }

    const resolution = resolveFromMirror(normalized.value.lockfile, byteStore(normalized.value.tarballs));
    if (!resolution.ok) {
      return reject(resolution.errors.map(mirrorResolutionError));
    }

    const manifest: Record<string, MirrorBuildManifestEntry> = {};
    const packages = resolution.resolution.packages;

    for (let index = 0; index < packages.length; index += 1) {
      const packageRecord = packages[index];
      if (packageRecord === undefined) {
        continue;
      }

      const bytes = normalized.value.tarballs.get(packageRecord.key);
      if (bytes === undefined) {
        return reject([
          error(
            "MISSING_TARBALL",
            [],
            `Package ${packageRecord.key} has no supplied tarball.`,
          ),
        ]);
      }

      const integrity = strongestMatchingSri(packageRecord.integrity, bytes);
      if (integrity === undefined) {
        return reject([
          error(
            "INTEGRITY_MISMATCH",
            ["integrity"],
            `Package ${packageRecord.key} does not match lockfile integrity.`,
          ),
        ]);
      }

      const stored = await fetchAndStore(
        {
          integrity: integrity.value,
          mirrorUrl: localMirrorUrl(packageRecord.key),
          name: packageRecord.name,
          version: packageRecord.version,
        },
        {
          fetcher: {
            async fetch(): Promise<Uint8Array> {
              return new Uint8Array(bytes);
            },
          },
          mirrorBaseUrl: OFFLINE_MIRROR_BASE_URL,
          root: normalized.value.root,
        },
      );

      if (!stored.ok) {
        return reject(stored.errors.map(storeWriteError));
      }

      Object.defineProperty(manifest, packageRecord.key, {
        configurable: true,
        enumerable: true,
        value: {
          path: stored.stored.path,
          sri: stored.stored.integrity,
        },
        writable: true,
      });
    }

    return {
      manifest,
      ok: true,
    };
  } catch {
    return reject([
      error("STORE_IO", [], "Mirror build failed closed."),
    ]);
  }
}

export const buildMirror = buildMirrorStore;
export const buildMirrorFromLockfile = buildMirrorStore;

function normalizeBuildInput(input: unknown):
  | {
      readonly ok: true;
      readonly value: NormalizedBuildInput;
    }
  | {
      readonly ok: false;
      readonly error: MirrorBuildError;
    } {
  const snapshot = snapshotPlainDataObject(input);
  if (!snapshot.ok) {
    return {
      error: error("INVALID_INPUT", [], "Expected mirror build input object with data properties."),
      ok: false,
    };
  }

  const keys = sortedKeys(snapshot.values);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined || !BUILD_INPUT_FIELDS.has(key)) {
      return {
        error: error("INVALID_INPUT", [key ?? ""], "Unknown mirror build input field."),
        ok: false,
      };
    }
  }

  const lockfile = snapshot.values.get("lockfile");
  const root = snapshot.values.get("root");
  if (typeof root !== "string" || root === "" || hasControl(root)) {
    return {
      error: error("STORE_IO", ["root"], "Expected store root path string."),
      ok: false,
    };
  }

  const tarballs = normalizeTarballs(snapshot.values.get("tarballs"));
  if (!tarballs.ok) {
    return {
      error: tarballs.error,
      ok: false,
    };
  }

  return {
    ok: true,
    value: {
      lockfile,
      root,
      tarballs: tarballs.value,
    },
  };
}

function normalizeTarballs(input: unknown):
  | {
      readonly ok: true;
      readonly value: ReadonlyMap<string, Uint8Array>;
    }
  | {
      readonly ok: false;
      readonly error: MirrorBuildError;
    } {
  if (nodeTypes.isProxy(input)) {
    return {
      error: error("INVALID_INPUT", ["tarballs"], "Expected tarballs map or record."),
      ok: false,
    };
  }

  if (input instanceof Map && Object.getPrototypeOf(input) === Map.prototype) {
    const entries = new Map<string, Uint8Array>();

    for (const [key, value] of input.entries()) {
      const normalized = normalizeTarballEntry(key, value, ["tarballs", String(key)]);
      if (!normalized.ok) {
        return {
          error: normalized.error,
          ok: false,
        };
      }

      entries.set(normalized.key, normalized.bytes);
    }

    return {
      ok: true,
      value: entries,
    };
  }

  const snapshot = snapshotPlainDataObject(input);
  if (!snapshot.ok) {
    return {
      error: error("INVALID_INPUT", ["tarballs"], "Expected tarballs map or record."),
      ok: false,
    };
  }

  const entries = new Map<string, Uint8Array>();
  const keys = sortedKeys(snapshot.values);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) {
      continue;
    }

    const normalized = normalizeTarballEntry(key, snapshot.values.get(key), ["tarballs", key]);
    if (!normalized.ok) {
      return {
        error: normalized.error,
        ok: false,
      };
    }

    entries.set(normalized.key, normalized.bytes);
  }

  return {
    ok: true,
    value: entries,
  };
}

function normalizeTarballEntry(
  key: unknown,
  value: unknown,
  path: Path,
):
  | {
      readonly ok: true;
      readonly key: string;
      readonly bytes: Uint8Array;
    }
  | {
      readonly ok: false;
      readonly error: MirrorBuildError;
    } {
  if (typeof key !== "string" || key === "" || hasControl(key)) {
    return {
      error: error("INVALID_INPUT", path, "Expected tarball key string."),
      ok: false,
    };
  }

  if (nodeTypes.isProxy(value) || !(value instanceof Uint8Array)) {
    return {
      error: error("INVALID_INPUT", path, "Expected tarball bytes."),
      ok: false,
    };
  }

  return {
    bytes: new Uint8Array(value),
    key,
    ok: true,
  };
}

function byteStore(tarballs: ReadonlyMap<string, Uint8Array>): MirrorStore {
  return {
    get(key: string): Uint8Array | undefined {
      const bytes = tarballs.get(key);
      return bytes === undefined ? undefined : new Uint8Array(bytes);
    },
  };
}

function strongestMatchingSri(integrity: string, bytes: Uint8Array): ParsedSriIntegrity | undefined {
  const tokens = integrity.trim().split(/\s+/u);
  let strongest: SriAlgorithm | undefined;
  const candidates: ParsedSriIntegrity[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token === "") {
      return undefined;
    }

    const parsed = parseSriIntegrity(token);
    if (!parsed.ok) {
      return undefined;
    }

    const algorithm = parsed.integrity.algorithm;
    if (strongest === undefined || sriStrength(algorithm) > sriStrength(strongest)) {
      strongest = algorithm;
      candidates.length = 0;
      candidates[candidates.length] = parsed.integrity;
    } else if (algorithm === strongest) {
      candidates[candidates.length] = parsed.integrity;
    }
  }

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (candidate !== undefined && matchesIntegrity(bytes, candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function matchesIntegrity(bytes: Uint8Array, integrity: ParsedSriIntegrity): boolean {
  const expected = Buffer.from(integrity.digest, "base64");
  if (expected.length !== integrity.byteLength) {
    return false;
  }

  const actual = createHash(integrity.algorithm).update(bytes).digest();
  return actual.length === expected.length && Buffer.compare(actual, expected) === 0;
}

function sriStrength(algorithm: SriAlgorithm): number {
  switch (algorithm) {
    case "sha256":
      return 1;
    case "sha384":
      return 2;
    case "sha512":
      return 3;
  }
}

function localMirrorUrl(key: string): string {
  return `local-mirror://${encodeURIComponent(key)}.tgz`;
}

function snapshotPlainDataObject(input: unknown):
  | DataSnapshot
  | {
      readonly ok: false;
    } {
  try {
    if (
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      nodeTypes.isProxy(input)
    ) {
      return { ok: false };
    }

    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      return { ok: false };
    }

    const keys = Reflect.ownKeys(input);
    const values = new Map<string, unknown>();
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (key === undefined || typeof key === "symbol") {
        return { ok: false };
      }

      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        descriptor === undefined ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
        descriptor.enumerable !== true
      ) {
        return { ok: false };
      }

      values.set(key, descriptor.value);
    }

    return {
      ok: true,
      values,
    };
  } catch {
    return { ok: false };
  }
}

function sortedKeys(values: ReadonlyMap<string, unknown>): string[] {
  const keys: string[] = [];
  for (const key of values.keys()) {
    keys[keys.length] = key;
  }

  keys.sort(compareStrings);
  return keys;
}

function mirrorResolutionError(value: MirrorResolutionError): MirrorBuildError {
  if (value.code === "NOT_IN_MIRROR") {
    return {
      code: "MISSING_TARBALL",
      message: value.message,
      path: value.path,
    };
  }

  return {
    code: value.code,
    message: value.message,
    path: value.path,
  };
}

function storeWriteError(value: StoreError): MirrorBuildError {
  if (value.code === "INTEGRITY_MISMATCH") {
    return {
      code: "INTEGRITY_MISMATCH",
      message: value.message,
      path: value.path,
    };
  }

  return {
    code: "STORE_IO",
    message: value.message,
    path: value.path,
  };
}

function hasControl(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
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

function error(code: MirrorBuildError["code"], path: Path, message: string): MirrorBuildError {
  return {
    code,
    message,
    path: formatPath(path),
  };
}

function reject(errors: readonly MirrorBuildError[]): Extract<MirrorBuildResult, { readonly ok: false }> {
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
