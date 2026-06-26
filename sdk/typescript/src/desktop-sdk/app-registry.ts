import { parseSriIntegrity } from "../sri.ts";
import type { SriAlgorithm } from "../sri.ts";
import type { AppWindowHints, TsxComponentRef, WebviewRuntimeRef } from "../appshell/index.ts";
import { hasDesktopCapabilityGrant } from "./loader.ts";
import type {
  DesktopCapabilityGrant,
  DesktopLaunchableApp,
  DesktopLauncherIntent,
  DesktopUiPackageManifest,
} from "./ui-package.ts";

export interface DesktopRegistryApp {
  readonly app: DesktopLaunchableApp;
  readonly title: string;
  readonly requiredGrants: readonly DesktopCapabilityGrant[];
}

export interface DesktopFirstPartyRegistryDescriptorSeed {
  readonly descriptor: DesktopRegistryApp;
  readonly integrity: string;
}

export interface DesktopFirstPartyRegistryInlineSeed extends DesktopRegistryApp {
  readonly integrity: string;
}

export type DesktopFirstPartyRegistrySeed =
  | DesktopFirstPartyRegistryDescriptorSeed
  | DesktopFirstPartyRegistryInlineSeed;

export interface CreateAppRegistryOptions {
  readonly firstParty?: readonly DesktopFirstPartyRegistrySeed[];
  readonly installedCapsules?: readonly DesktopRegistryApp[];
}

export interface DesktopRegistryError {
  readonly code: "UNKNOWN_APP" | "CAP_DENIED";
  readonly message: string;
  readonly path: string;
}

export type DesktopRegistryValidationResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: DesktopRegistryError;
    };

export interface DesktopAppRegistry {
  list(): readonly DesktopRegistryApp[];
  resolve(appId: string): DesktopRegistryApp | undefined;
  has(appId: string): boolean;
  validateLaunch(
    manifest: DesktopUiPackageManifest,
    appId: string,
  ): DesktopRegistryValidationResult<DesktopRegistryApp>;
  resolveLauncherIntent(intent: DesktopLauncherIntent): DesktopRegistryApp | undefined;
}

const EMPTY_FIRST_PARTY = Object.freeze([]) satisfies readonly DesktopFirstPartyRegistrySeed[];
const EMPTY_INSTALLED_CAPSULES = Object.freeze([]) satisfies readonly DesktopRegistryApp[];

export function createAppRegistry(
  options: CreateAppRegistryOptions = Object.freeze({}),
): DesktopAppRegistry {
  const seeded = new Map<string, DesktopRegistryApp>();
  const firstParty = options.firstParty ?? EMPTY_FIRST_PARTY;
  const installedCapsules = options.installedCapsules ?? EMPTY_INSTALLED_CAPSULES;

  for (let index = 0; index < firstParty.length; index += 1) {
    const seed = firstParty[index];

    if (seed === undefined || !firstPartySeedIntegrityMatches(seed)) continue;

    const descriptor = freezeRegistryApp(descriptorForFirstPartySeed(seed));

    if (!seeded.has(descriptor.app.id)) {
      seeded.set(descriptor.app.id, descriptor);
    }
  }

  for (let index = 0; index < installedCapsules.length; index += 1) {
    const descriptor = installedCapsules[index];

    if (descriptor === undefined) continue;

    const frozen = freezeRegistryApp(descriptor);

    if (!seeded.has(frozen.app.id)) {
      seeded.set(frozen.app.id, frozen);
    }
  }

  const listed = Object.freeze([...seeded.values()].sort(compareRegistryApps));
  const byId = new Map<string, DesktopRegistryApp>();

  for (let index = 0; index < listed.length; index += 1) {
    const descriptor = listed[index];

    if (descriptor !== undefined) {
      byId.set(descriptor.app.id, descriptor);
    }
  }

  return Object.freeze({
    has(appId: string): boolean {
      return typeof appId === "string" && byId.has(appId);
    },
    list(): readonly DesktopRegistryApp[] {
      return listed;
    },
    resolve(appId: string): DesktopRegistryApp | undefined {
      if (typeof appId !== "string") return undefined;

      return byId.get(appId);
    },
    resolveLauncherIntent(intent: DesktopLauncherIntent): DesktopRegistryApp | undefined {
      const input: unknown = intent;

      if (!isRecord(input)) return undefined;
      if (input["type"] !== "launcher.launch" || typeof input["appId"] !== "string") return undefined;

      return byId.get(input["appId"]);
    },
    validateLaunch(
      manifest: DesktopUiPackageManifest,
      appId: string,
    ): DesktopRegistryValidationResult<DesktopRegistryApp> {
      const descriptor = typeof appId === "string" ? byId.get(appId) : undefined;

      if (descriptor === undefined) {
        return reject(
          "UNKNOWN_APP",
          "app is not listed in the desktop app registry.",
          `/apps/${pathToken(typeof appId === "string" ? appId : "")}`,
        );
      }

      if (!packageCanLaunch(manifest, descriptor.app.id)) {
        return reject(
          "CAP_DENIED",
          "package manifest does not grant apps.launch for the requested app.",
          `/apps/${pathToken(descriptor.app.id)}/capability`,
        );
      }

      return accept(descriptor);
    },
  });
}

function firstPartySeedIntegrityMatches(seed: DesktopFirstPartyRegistrySeed): boolean {
  const parsed = parseSriIntegrity(seed.integrity);

  if (!parsed.ok) return false;

  let serialized: string | undefined;

  try {
    serialized = JSON.stringify(descriptorForFirstPartySeed(seed));
  } catch {
    return false;
  }

  if (serialized === undefined) return false;

  const expected = decodeBase64(parsed.integrity.digest);

  if (expected === undefined) return false;

  const actual = sha2(parsed.integrity.algorithm, utf8Bytes(serialized));

  return expected.length === actual.length && timingSafeEqualBytes(expected, actual);
}

function descriptorForFirstPartySeed(seed: DesktopFirstPartyRegistrySeed): DesktopRegistryApp {
  if ("descriptor" in seed) return seed.descriptor;

  return {
    app: seed.app,
    title: seed.title,
    requiredGrants: seed.requiredGrants,
  };
}

function packageCanLaunch(manifest: DesktopUiPackageManifest, appId: string): boolean {
  try {
    return hasDesktopCapabilityGrant(manifest, "apps.launch", appId);
  } catch {
    return false;
  }
}

function freezeRegistryApp(input: DesktopRegistryApp): DesktopRegistryApp {
  return Object.freeze({
    app: freezeLaunchableApp(input.app),
    title: input.title,
    requiredGrants: freezeCapabilityGrants(input.requiredGrants),
  });
}

function freezeLaunchableApp(app: DesktopLaunchableApp): DesktopLaunchableApp {
  switch (app.surfaceKind) {
    case "tsx": {
      const runtime: {
        componentId: string;
        props?: NonNullable<TsxComponentRef["props"]>;
      } = {
        componentId: app.runtime.componentId,
      };

      if (app.runtime.props !== undefined) runtime.props = app.runtime.props;

      const output: {
        id: string;
        title: string;
        surfaceKind: "tsx";
        runtime: TsxComponentRef;
        defaultWindow?: AppWindowHints;
      } = {
        id: app.id,
        runtime: Object.freeze(runtime),
        surfaceKind: "tsx",
        title: app.title,
      };

      if (app.defaultWindow !== undefined) output.defaultWindow = freezeWindowHints(app.defaultWindow);

      return Object.freeze(output);
    }
    case "web": {
      const runtime: {
        url: string;
        partition?: string;
      } = {
        url: app.runtime.url,
      };

      if (app.runtime.partition !== undefined) runtime.partition = app.runtime.partition;

      const output: {
        id: string;
        title: string;
        surfaceKind: "web";
        runtime: WebviewRuntimeRef;
        defaultWindow?: AppWindowHints;
      } = {
        id: app.id,
        runtime: Object.freeze(runtime),
        surfaceKind: "web",
        title: app.title,
      };

      if (app.defaultWindow !== undefined) output.defaultWindow = freezeWindowHints(app.defaultWindow);

      return Object.freeze(output);
    }
  }
}

function freezeCapabilityGrants(
  grants: readonly DesktopCapabilityGrant[],
): readonly DesktopCapabilityGrant[] {
  const output: DesktopCapabilityGrant[] = [];

  for (let index = 0; index < grants.length; index += 1) {
    const grant = grants[index];

    if (grant === undefined) continue;

    const frozen: {
      capability: DesktopCapabilityGrant["capability"];
      resourceId?: string;
    } = {
      capability: grant.capability,
    };

    if (grant.resourceId !== undefined) frozen.resourceId = grant.resourceId;

    output.push(Object.freeze(frozen));
  }

  return Object.freeze(output);
}

function freezeWindowHints(hints: AppWindowHints): AppWindowHints {
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

  if (hints.workspaceId !== undefined) output.workspaceId = hints.workspaceId;
  if (hints.rect !== undefined) {
    output.rect = Object.freeze({
      height: hints.rect.height,
      width: hints.rect.width,
      x: hints.rect.x,
      y: hints.rect.y,
    });
  }
  if (hints.mode !== undefined) output.mode = hints.mode;
  if (hints.zone !== undefined) output.zone = hints.zone;
  if (hints.layer !== undefined) output.layer = hints.layer;
  if (hints.order !== undefined) output.order = hints.order;
  if (hints.anchor !== undefined) output.anchor = hints.anchor;
  if (hints.className !== undefined) output.className = hints.className;

  return Object.freeze(output);
}

function compareRegistryApps(left: DesktopRegistryApp, right: DesktopRegistryApp): number {
  if (left.app.id < right.app.id) return -1;
  if (left.app.id > right.app.id) return 1;

  return 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pathToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function accept<T>(value: T): DesktopRegistryValidationResult<T> {
  return {
    ok: true,
    value,
  };
}

function reject<T>(
  code: DesktopRegistryError["code"],
  message: string,
  path: string,
): DesktopRegistryValidationResult<T> {
  return {
    error: {
      code,
      message,
      path,
    },
    ok: false,
  };
}

// --- Portable, dependency-free SRI digest verification ---------------------
// app-registry is a pure SDK module re-exported from the desktop-sdk barrel,
// which is bundled into the browser/CEF in-surface runtime (offline, no
// `node:` imports allowed). So digest recomputation is implemented here with
// self-contained SHA-2 + base64 helpers rather than `node:crypto`/`Buffer`.
// Deterministic and synchronous (called during construction); produces the
// same bytes as `createHash(...).digest()` so the SRI fail-closed semantics
// hold identically in Node tests and the bundled surface.

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;

  let diff = 0;

  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }

  return diff === 0;
}

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeBase64(value: string): Uint8Array | undefined {
  let clean = value;

  // Tolerate standard base64 with optional `=` padding only.
  const padIndex = clean.indexOf("=");

  if (padIndex !== -1) {
    if (!/^={1,2}$/.test(clean.slice(padIndex))) return undefined;
    clean = clean.slice(0, padIndex);
  }

  if (clean.length === 0) return new Uint8Array(0);

  const out: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (let i = 0; i < clean.length; i += 1) {
    const symbol = BASE64_ALPHABET.indexOf(clean[i] ?? "");

    if (symbol === -1) return undefined;

    buffer = (buffer << 6) | symbol;
    bits += 6;

    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }

  return Uint8Array.from(out);
}

function sha2(algorithm: SriAlgorithm, message: Uint8Array): Uint8Array {
  if (algorithm === "sha256") return sha256(message);

  return sha512(message, algorithm === "sha384");
}

// SHA-256 (FIPS 180-4) over 32-bit words.
const SHA256_K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr32(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

function sha256(message: Uint8Array): Uint8Array {
  const h = Uint32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const padded = padMessage(message, 64);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const j = offset + i * 4;

      w[i] =
        (((padded[j] ?? 0) << 24) |
          ((padded[j + 1] ?? 0) << 16) |
          ((padded[j + 2] ?? 0) << 8) |
          (padded[j + 3] ?? 0)) >>>
        0;
    }

    for (let i = 16; i < 64; i += 1) {
      const w15 = w[i - 15] ?? 0;
      const w2 = w[i - 2] ?? 0;
      const s0 = rotr32(w15, 7) ^ rotr32(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr32(w2, 17) ^ rotr32(w2, 19) ^ (w2 >>> 10);

      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }

    let a = h[0] ?? 0;
    let b = h[1] ?? 0;
    let c = h[2] ?? 0;
    let d = h[3] ?? 0;
    let e = h[4] ?? 0;
    let f = h[5] ?? 0;
    let g = h[6] ?? 0;
    let hh = h[7] ?? 0;

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + (SHA256_K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const s0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h[0] = ((h[0] ?? 0) + a) >>> 0;
    h[1] = ((h[1] ?? 0) + b) >>> 0;
    h[2] = ((h[2] ?? 0) + c) >>> 0;
    h[3] = ((h[3] ?? 0) + d) >>> 0;
    h[4] = ((h[4] ?? 0) + e) >>> 0;
    h[5] = ((h[5] ?? 0) + f) >>> 0;
    h[6] = ((h[6] ?? 0) + g) >>> 0;
    h[7] = ((h[7] ?? 0) + hh) >>> 0;
  }

  const out = new Uint8Array(32);

  for (let i = 0; i < 8; i += 1) {
    const value = h[i] ?? 0;

    out[i * 4] = (value >>> 24) & 0xff;
    out[i * 4 + 1] = (value >>> 16) & 0xff;
    out[i * 4 + 2] = (value >>> 8) & 0xff;
    out[i * 4 + 3] = value & 0xff;
  }

  return out;
}

// SHA-512 / SHA-384 (FIPS 180-4) over 64-bit words, implemented with bigint
// for portability (no native u64). SHA-384 shares the algorithm with a
// different IV and a 48-byte truncated output.
const SHA512_K: readonly bigint[] = [
  0x428a2f98d728ae22n, 0x7137449123ef65cdn, 0xb5c0fbcfec4d3b2fn,
  0xe9b5dba58189dbbcn, 0x3956c25bf348b538n, 0x59f111f1b605d019n,
  0x923f82a4af194f9bn, 0xab1c5ed5da6d8118n, 0xd807aa98a3030242n,
  0x12835b0145706fben, 0x243185be4ee4b28cn, 0x550c7dc3d5ffb4e2n,
  0x72be5d74f27b896fn, 0x80deb1fe3b1696b1n, 0x9bdc06a725c71235n,
  0xc19bf174cf692694n, 0xe49b69c19ef14ad2n, 0xefbe4786384f25e3n,
  0x0fc19dc68b8cd5b5n, 0x240ca1cc77ac9c65n, 0x2de92c6f592b0275n,
  0x4a7484aa6ea6e483n, 0x5cb0a9dcbd41fbd4n, 0x76f988da831153b5n,
  0x983e5152ee66dfabn, 0xa831c66d2db43210n, 0xb00327c898fb213fn,
  0xbf597fc7beef0ee4n, 0xc6e00bf33da88fc2n, 0xd5a79147930aa725n,
  0x06ca6351e003826fn, 0x142929670a0e6e70n, 0x27b70a8546d22ffcn,
  0x2e1b21385c26c926n, 0x4d2c6dfc5ac42aedn, 0x53380d139d95b3dfn,
  0x650a73548baf63den, 0x766a0abb3c77b2a8n, 0x81c2c92e47edaee6n,
  0x92722c851482353bn, 0xa2bfe8a14cf10364n, 0xa81a664bbc423001n,
  0xc24b8b70d0f89791n, 0xc76c51a30654be30n, 0xd192e819d6ef5218n,
  0xd69906245565a910n, 0xf40e35855771202an, 0x106aa07032bbd1b8n,
  0x19a4c116b8d2d0c8n, 0x1e376c085141ab53n, 0x2748774cdf8eeb99n,
  0x34b0bcb5e19b48a8n, 0x391c0cb3c5c95a63n, 0x4ed8aa4ae3418acbn,
  0x5b9cca4f7763e373n, 0x682e6ff3d6b2b8a3n, 0x748f82ee5defb2fcn,
  0x78a5636f43172f60n, 0x84c87814a1f0ab72n, 0x8cc702081a6439ecn,
  0x90befffa23631e28n, 0xa4506cebde82bde9n, 0xbef9a3f7b2c67915n,
  0xc67178f2e372532bn, 0xca273eceea26619cn, 0xd186b8c721c0c207n,
  0xeada7dd6cde0eb1en, 0xf57d4f7fee6ed178n, 0x06f067aa72176fban,
  0x0a637dc5a2c898a6n, 0x113f9804bef90daen, 0x1b710b35131c471bn,
  0x28db77f523047d84n, 0x32caab7b40c72493n, 0x3c9ebe0a15c9bebcn,
  0x431d67c49c100d4cn, 0x4cc5d4becb3e42b6n, 0x597f299cfc657e2an,
  0x5fcb6fab3ad6faecn, 0x6c44198c4a475817n,
];

const U64_MASK = (1n << 64n) - 1n;

function rotr64(value: bigint, bits: bigint): bigint {
  return ((value >> bits) | (value << (64n - bits))) & U64_MASK;
}

function sha512(message: Uint8Array, truncate384: boolean): Uint8Array {
  const h = truncate384
    ? [
        0xcbbb9d5dc1059ed8n, 0x629a292a367cd507n, 0x9159015a3070dd17n,
        0x152fecd8f70e5939n, 0x67332667ffc00b31n, 0x8eb44a8768581511n,
        0xdb0c2e0d64f98fa7n, 0x47b5481dbefa4fa4n,
      ]
    : [
        0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn,
        0xa54ff53a5f1d36f1n, 0x510e527fade682d1n, 0x9b05688c2b3e6c1fn,
        0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
      ];
  const padded = padMessage(message, 128);
  const w: bigint[] = new Array(80).fill(0n);

  for (let offset = 0; offset < padded.length; offset += 128) {
    for (let i = 0; i < 16; i += 1) {
      let word = 0n;

      for (let b = 0; b < 8; b += 1) {
        word = (word << 8n) | BigInt(padded[offset + i * 8 + b] ?? 0);
      }

      w[i] = word & U64_MASK;
    }

    for (let i = 16; i < 80; i += 1) {
      const w15 = w[i - 15] ?? 0n;
      const w2 = w[i - 2] ?? 0n;
      const s0 = rotr64(w15, 1n) ^ rotr64(w15, 8n) ^ (w15 >> 7n);
      const s1 = rotr64(w2, 19n) ^ rotr64(w2, 61n) ^ (w2 >> 6n);

      w[i] = ((w[i - 16] ?? 0n) + s0 + (w[i - 7] ?? 0n) + s1) & U64_MASK;
    }

    let a = h[0] ?? 0n;
    let b = h[1] ?? 0n;
    let c = h[2] ?? 0n;
    let d = h[3] ?? 0n;
    let e = h[4] ?? 0n;
    let f = h[5] ?? 0n;
    let g = h[6] ?? 0n;
    let hh = h[7] ?? 0n;

    for (let i = 0; i < 80; i += 1) {
      const s1 = rotr64(e, 14n) ^ rotr64(e, 18n) ^ rotr64(e, 41n);
      const ch = (e & f) ^ (~e & U64_MASK & g);
      const t1 = (hh + s1 + ch + (SHA512_K[i] ?? 0n) + (w[i] ?? 0n)) & U64_MASK;
      const s0 = rotr64(a, 28n) ^ rotr64(a, 34n) ^ rotr64(a, 39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) & U64_MASK;

      hh = g;
      g = f;
      f = e;
      e = (d + t1) & U64_MASK;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) & U64_MASK;
    }

    h[0] = ((h[0] ?? 0n) + a) & U64_MASK;
    h[1] = ((h[1] ?? 0n) + b) & U64_MASK;
    h[2] = ((h[2] ?? 0n) + c) & U64_MASK;
    h[3] = ((h[3] ?? 0n) + d) & U64_MASK;
    h[4] = ((h[4] ?? 0n) + e) & U64_MASK;
    h[5] = ((h[5] ?? 0n) + f) & U64_MASK;
    h[6] = ((h[6] ?? 0n) + g) & U64_MASK;
    h[7] = ((h[7] ?? 0n) + hh) & U64_MASK;
  }

  const wordCount = truncate384 ? 6 : 8;
  const out = new Uint8Array(wordCount * 8);

  for (let i = 0; i < wordCount; i += 1) {
    let value = h[i] ?? 0n;

    for (let b = 7; b >= 0; b -= 1) {
      out[i * 8 + b] = Number(value & 0xffn);
      value >>= 8n;
    }
  }

  return out;
}

function padMessage(message: Uint8Array, blockBytes: number): Uint8Array {
  const lengthFieldBytes = blockBytes === 64 ? 8 : 16;
  const totalLen = message.length + 1 + lengthFieldBytes;
  const padded = new Uint8Array(Math.ceil(totalLen / blockBytes) * blockBytes);

  padded.set(message, 0);
  padded[message.length] = 0x80;

  // Big-endian bit length in the trailing length field.
  const bitLength = BigInt(message.length) * 8n;

  for (let i = 0; i < lengthFieldBytes; i += 1) {
    padded[padded.length - 1 - i] = Number((bitLength >> BigInt(i * 8)) & 0xffn);
  }

  return padded;
}
