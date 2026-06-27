// Puter platform server — TLS for the NETWORK face (node-only).
//
// DECISION (single self-hosted node): use IN-PROCESS native TLS, NOT a reverse proxy (caddy).
// Rationale, recorded here because it is load-bearing:
//   - The service is ALREADY an in-process HTTP server (server.ts wraps node:http). Adding TLS is a
//     one-line swap to node:https/node:tls — ZERO new packages, ZERO new processes.
//   - A reverse proxy (caddy) would add a ~40MB Go binary to VENDOR + SIGN into the read-only verity
//     image, a second systemd unit, an ACME/automatic-HTTPS machine that is pointless for a single
//     self-hosted node behind an owner-token, AND a localhost caddy→backend hop that itself needs
//     trust. None of that buys anything here.
//   - On-device the runtime is Deno (vita-ts.service): `Deno.serveTls({ cert, key })` is the native
//     equivalent of node:https — same posture, no extra binary. This module is the Node side (harness
//     + Node-hosted service); the launch contract (LAUNCH.md) documents the Deno.serveTls mapping.
//   - The owner token is a BEARER SECRET, so TLS is MANDATORY on the network face (confidentiality +
//     integrity for the bearer). TLS is transport security; the owner token is the actual authn. The
//     localhost/kiosk face stays plain HTTP (trust-on-host; the loopback never leaves the device).
//
// Cert sourcing (in priority order, all node-native — no third-party cert lib):
//   1. An OWNER-PROVIDED cert+key (PEM paths) — production: the owner holds the private key (spec §16).
//   2. A SELF-SIGNED cert generated in-process from node:crypto (dev/bootstrap, or a self-hosted node
//      with no CA). Generated deterministically-enough for a single owner; the owner token, not the
//      cert chain, is the trust anchor.
//
// Node-only: imports node:crypto / node:fs. NEVER import from the browser bundle.

import { existsSync, readFileSync } from "node:fs";
import {
  createPrivateKey,
  createSign,
  generateKeyPairSync,
  randomBytes,
  X509Certificate,
} from "node:crypto";

// A PEM cert+key pair fed to node:https / Deno.serveTls. `cert` and `key` are PEM strings.
export interface TlsMaterial {
  readonly cert: string;
  readonly key: string;
  // How this material was obtained — for logging/provenance (never the key itself).
  readonly source: "owner-provided" | "self-signed";
  // For a self-signed cert: the SHA-256 fingerprint the owner can pin out-of-band. undefined for
  // owner-provided (the owner already knows their chain).
  readonly fingerprintSha256?: string;
}

export interface TlsSourceOptions {
  // Owner-provided PEM file paths. If BOTH exist, they win (production path).
  readonly certPath?: string;
  readonly keyPath?: string;
  // Subject CN / SAN for a generated self-signed cert. Default "vita.local".
  readonly selfSignedHost?: string;
  // Validity days for a generated cert. Default 825 (the CA/Browser-forum max for a leaf).
  readonly validityDays?: number;
}

// Resolve the TLS material for the network face. Prefers an owner-provided cert+key; otherwise
// generates a self-signed cert in-process (no third-party dependency). Throws only if an
// owner-provided path is given but unreadable (fail-loud on a misconfigured production cert).
export function resolveTlsMaterial(options: TlsSourceOptions = {}): TlsMaterial {
  const { certPath, keyPath } = options;

  if (certPath !== undefined && keyPath !== undefined) {
    if (!existsSync(certPath)) throw new Error(`TLS cert not found: ${certPath}`);
    if (!existsSync(keyPath)) throw new Error(`TLS key not found: ${keyPath}`);

    return Object.freeze({
      cert: readFileSync(certPath, "utf8"),
      key: readFileSync(keyPath, "utf8"),
      source: "owner-provided",
    });
  }

  return generateSelfSigned(options.selfSignedHost ?? "vita.local", options.validityDays ?? 825);
}

// Generate a self-signed X.509 cert + RSA key entirely from node:crypto. We hand-assemble a minimal
// DER TBSCertificate (v3) so we depend on NOTHING beyond the Node standard library — `node:crypto`
// has no high-level "make a self-signed cert" API, so we build the smallest valid certificate that
// node:https / Deno.serveTls will serve. The owner token (not the cert chain) is the trust anchor, so
// a self-signed leaf with a pinnable fingerprint is sufficient for a single self-hosted node.
export function generateSelfSigned(host: string, validityDays: number): TlsMaterial {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const spkiDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const now = Date.now();
  const notBefore = new Date(now - 60_000); // 1 min skew tolerance
  const notAfter = new Date(now + validityDays * 86_400_000);
  const serial = randomBytes(16);

  const tbs = buildTbsCertificate({ host, notAfter, notBefore, serial, spkiDer });
  const signature = createSign("RSA-SHA256").update(tbs).sign(privateKey);
  const certDer = wrapCertificate(tbs, signature);
  const certPem = derToPem(certDer, "CERTIFICATE");
  const keyPem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  const fingerprintSha256 = new X509Certificate(certPem).fingerprint256;

  // Sanity: re-parse so a malformed DER fails HERE (in the generator) not at serve time.
  void createPrivateKey(keyPem);

  return Object.freeze({
    cert: certPem,
    fingerprintSha256,
    key: keyPem,
    source: "self-signed",
  });
}

// ---------------------------------------------------------------------------------------------
// Minimal DER encoder for the self-signed certificate. Pure byte assembly; no external lib.
// ---------------------------------------------------------------------------------------------

function der(tag: number, content: Buffer): Buffer {
  const len = content.length;
  let lenBytes: Buffer;

  if (len < 0x80) {
    lenBytes = Buffer.from([len]);
  } else {
    const tmp: number[] = [];
    let n = len;

    while (n > 0) {
      tmp.unshift(n & 0xff);
      n >>= 8;
    }
    lenBytes = Buffer.from([0x80 | tmp.length, ...tmp]);
  }

  return Buffer.concat([Buffer.from([tag]), lenBytes, content]);
}

const SEQUENCE = 0x30;
const SET = 0x31;
const INTEGER = 0x02;
const BIT_STRING = 0x03;
const OCTET_STRING = 0x04;
const OID = 0x06;
const UTF8_STRING = 0x0c;
const UTC_TIME = 0x17;
const CONTEXT0 = 0xa0;
const CONTEXT3 = 0xa3;

function oid(parts: readonly number[]): Buffer {
  const first = parts[0] ?? 0;
  const second = parts[1] ?? 0;
  const bytes: number[] = [first * 40 + second];

  for (const p of parts.slice(2)) {
    const stack: number[] = [];
    let v = p;

    stack.unshift(v & 0x7f);
    v >>= 7;
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v >>= 7;
    }
    bytes.push(...stack);
  }

  return der(OID, Buffer.from(bytes));
}

function integer(buf: Buffer): Buffer {
  // Ensure positive (prepend 0x00 if high bit set).
  const body = buf.length > 0 && (buf[0]! & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), buf]) : buf;

  return der(INTEGER, body);
}

function utcTime(d: Date): Buffer {
  const s = d.toISOString().replace(/[-:T]/gu, "").slice(2, 14) + "Z"; // YYMMDDHHMMSSZ

  return der(UTC_TIME, Buffer.from(s, "ascii"));
}

const OID_SHA256_RSA = oid([1, 2, 840, 113549, 1, 1, 11]);
const OID_COMMON_NAME = oid([2, 5, 4, 3]);
const OID_SAN = oid([2, 5, 29, 17]);

function nullParams(): Buffer {
  return Buffer.from([0x05, 0x00]);
}

function algId(): Buffer {
  return der(SEQUENCE, Buffer.concat([OID_SHA256_RSA, nullParams()]));
}

function name(cn: string): Buffer {
  const attr = der(SEQUENCE, Buffer.concat([OID_COMMON_NAME, der(UTF8_STRING, Buffer.from(cn, "utf8"))]));

  return der(SEQUENCE, der(SET, attr));
}

function subjectAltName(host: string): Buffer {
  // SAN dNSName [2] IMPLICIT — context tag 0x82.
  const dnsName = der(0x82, Buffer.from(host, "ascii"));
  const seq = der(SEQUENCE, dnsName);
  const ext = der(SEQUENCE, Buffer.concat([OID_SAN, der(OCTET_STRING, seq)]));

  return der(CONTEXT3, der(SEQUENCE, ext));
}

interface TbsInput {
  readonly host: string;
  readonly serial: Buffer;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly spkiDer: Buffer;
}

function buildTbsCertificate(input: TbsInput): Buffer {
  const version = der(CONTEXT0, der(INTEGER, Buffer.from([2]))); // v3
  const serial = integer(input.serial);
  const sigAlg = algId();
  const issuer = name(input.host);
  const validity = der(SEQUENCE, Buffer.concat([utcTime(input.notBefore), utcTime(input.notAfter)]));
  const subject = name(input.host);
  const spki = input.spkiDer; // already a DER SubjectPublicKeyInfo
  const extensions = subjectAltName(input.host);

  return der(
    SEQUENCE,
    Buffer.concat([version, serial, sigAlg, issuer, validity, subject, spki, extensions]),
  );
}

function wrapCertificate(tbs: Buffer, signature: Buffer): Buffer {
  const sigAlg = algId();
  const sigBitString = der(BIT_STRING, Buffer.concat([Buffer.from([0]), signature]));

  return der(SEQUENCE, Buffer.concat([tbs, sigAlg, sigBitString]));
}

function derToPem(der_: Buffer, label: string): string {
  const b64 = der_.toString("base64").replace(/(.{64})/gu, "$1\n").replace(/\n$/u, "");

  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}
