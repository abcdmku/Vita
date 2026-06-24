const SOCKET_PATH = "/run/vita-owner-test-authenticator/signer.sock";
const KEY_PATH = "/usr/lib/vita/owner-authenticator/test-authenticator-key.jwk";
const OWNER_RP_ID = "owner.example.com";
const OWNER_ACTION = "vita.owner.test-action";
const OWNER_CREDENTIAL_ID = "nZWYv8t4X7tiL7rYujaDiwAUxKqgmIV37hHNg90kaCM";
const WEBAUTHN_GET_TYPE = "webauthn.get";
const AUTHENTICATOR_FLAG_UP = 0x01;
const ASSERTED_SIGN_COUNT = 1;
const MAX_REQUEST_BYTES = 4096;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const runtime = globalThis as unknown as {
  readonly crypto: CryptoLike;
  atob(data: string): string;
  btoa(data: string): string;
};

interface CryptoLike {
  readonly subtle: {
    digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
    importKey(
      format: "jwk",
      keyData: Readonly<Record<string, unknown>>,
      algorithm: Readonly<{ readonly name: "ECDSA"; readonly namedCurve: "P-256" }>,
      extractable: boolean,
      keyUsages: readonly string[],
    ): Promise<CryptoKeyLike>;
    sign(
      algorithm: Readonly<{ readonly name: "ECDSA"; readonly hash: "SHA-256" }>,
      key: CryptoKeyLike,
      data: Uint8Array,
    ): Promise<ArrayBuffer>;
  };
}

type CryptoKeyLike = object;

interface SignRequest {
  readonly action: string;
  readonly challenge: string;
  readonly credentialId: string;
  readonly rpId: string;
}

interface OwnerAssertion {
  readonly credentialId: string;
  readonly authenticatorData: string;
  readonly clientDataJSON: string;
  readonly signature: string;
  readonly action: string;
}

type SignResponse =
  | {
      readonly ok: true;
      readonly assertion: OwnerAssertion;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

async function main(): Promise<void> {
  const key = await loadSigningKey();

  try {
    await Deno.remove(SOCKET_PATH);
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) {
      throw cause;
    }
  }

  const listener = Deno.listen({ path: SOCKET_PATH, transport: "unix" });
  await Deno.chmod(SOCKET_PATH, 0o660);

  for await (const conn of listener) {
    void handleConnection(conn, key);
  }
}

async function handleConnection(conn: Deno.Conn, key: CryptoKeyLike): Promise<void> {
  try {
    const request = parseSignRequest(await readRequestLine(conn));
    const assertion = await signAssertion(key, request);
    await writeResponse(conn, { assertion, ok: true });
  } catch {
    await writeResponse(conn, { ok: false, reason: "denied" });
  } finally {
    conn.close();
  }
}

async function loadSigningKey(): Promise<CryptoKeyLike> {
  const parsed: unknown = JSON.parse(await Deno.readTextFile(KEY_PATH));
  if (!isJsonObject(parsed)) {
    throw new Error("invalid key fixture");
  }

  const kty = readStringField(parsed, "kty");
  const crv = readStringField(parsed, "crv");
  const x = readStringField(parsed, "x");
  const y = readStringField(parsed, "y");
  const d = readStringField(parsed, "d");
  if (
    kty !== "EC" ||
    crv !== "P-256" ||
    x === undefined ||
    y === undefined ||
    d === undefined ||
    base64URLDecode(x).length !== 32 ||
    base64URLDecode(y).length !== 32 ||
    base64URLDecode(d).length !== 32
  ) {
    throw new Error("invalid key fixture");
  }

  const jwk: Readonly<Record<string, unknown>> = {
    crv,
    d,
    ext: false,
    key_ops: ["sign"],
    kty,
    x,
    y,
  };
  return runtime.crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

function parseSignRequest(raw: string): SignRequest {
  const parsed: unknown = JSON.parse(raw);
  if (!isJsonObject(parsed)) {
    throw new Error("request must be an object");
  }

  const keys = Object.keys(parsed).sort(compareStrings);
  if (keys.join(",") !== "action,challenge,credentialId,rpId") {
    throw new Error("request has invalid fields");
  }

  const action = readStringField(parsed, "action");
  const challenge = readStringField(parsed, "challenge");
  const credentialId = readStringField(parsed, "credentialId");
  const rpId = readStringField(parsed, "rpId");
  if (
    action !== OWNER_ACTION ||
    credentialId !== OWNER_CREDENTIAL_ID ||
    rpId !== OWNER_RP_ID ||
    challenge === undefined ||
    base64URLDecode(challenge).length !== 32
  ) {
    throw new Error("request denied");
  }

  return {
    action,
    challenge,
    credentialId,
    rpId,
  };
}

async function signAssertion(key: CryptoKeyLike, request: SignRequest): Promise<OwnerAssertion> {
  const authenticatorData = await makeAuthenticatorData(request.rpId, AUTHENTICATOR_FLAG_UP, ASSERTED_SIGN_COUNT);
  const clientDataJSON = encoder.encode(JSON.stringify({
    challenge: request.challenge,
    origin: `https://${request.rpId}`,
    type: WEBAUTHN_GET_TYPE,
  }));
  const clientDataHash = new Uint8Array(await runtime.crypto.subtle.digest("SHA-256", clientDataJSON));
  const signed = concatBytes([authenticatorData, clientDataHash]);
  const rawSignature = new Uint8Array(await runtime.crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    signed,
  ));

  return {
    action: request.action,
    authenticatorData: base64URLEncode(authenticatorData),
    clientDataJSON: base64URLEncode(clientDataJSON),
    credentialId: request.credentialId,
    signature: base64URLEncode(derEncodeECDSASignature(rawSignature)),
  };
}

async function makeAuthenticatorData(rpId: string, flags: number, counter: number): Promise<Uint8Array> {
  const rpIDHash = new Uint8Array(await runtime.crypto.subtle.digest("SHA-256", encoder.encode(rpId)));
  const out = new Uint8Array(37);
  out.set(rpIDHash, 0);
  out[32] = flags;
  out[33] = (counter >>> 24) & 0xff;
  out[34] = (counter >>> 16) & 0xff;
  out[35] = (counter >>> 8) & 0xff;
  out[36] = counter & 0xff;
  return out;
}

function derEncodeECDSASignature(rawSignature: Uint8Array): Uint8Array {
  if (rawSignature.length !== 64) {
    throw new Error("unexpected ECDSA signature shape");
  }
  const r = derInteger(rawSignature.slice(0, 32));
  const s = derInteger(rawSignature.slice(32));
  return concatBytes([
    new Uint8Array([0x30, r.length + s.length]),
    r,
    s,
  ]);
}

function derInteger(raw: Uint8Array): Uint8Array {
  let start = 0;
  while (start < raw.length - 1 && raw[start] === 0) {
    start += 1;
  }
  const trimmed = raw.slice(start);
  const needsPositivePrefix = (trimmed[0] ?? 0) >= 0x80;
  const value = needsPositivePrefix ? concatBytes([new Uint8Array([0]), trimmed]) : trimmed;
  return concatBytes([new Uint8Array([0x02, value.length]), value]);
}

async function readRequestLine(conn: Deno.Conn): Promise<string> {
  const chunks: Uint8Array[] = [];
  const buffer = new Uint8Array(512);
  let total = 0;

  while (true) {
    const read = await conn.read(buffer);
    if (read === null) {
      break;
    }
    const newline = buffer.subarray(0, read).indexOf(0x0a);
    const take = newline >= 0 ? newline : read;
    total += take;
    if (total > MAX_REQUEST_BYTES) {
      throw new Error("request too large");
    }
    chunks.push(buffer.slice(0, take));
    if (newline >= 0) {
      break;
    }
  }

  if (total === 0) {
    throw new Error("empty request");
  }
  return decoder.decode(concatBytes(chunks));
}

async function writeResponse(conn: Deno.Conn, response: SignResponse): Promise<void> {
  await writeAll(conn, encoder.encode(`${JSON.stringify(response)}\n`));
}

async function writeAll(conn: Deno.Conn, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const written = await conn.write(data.subarray(offset));
    if (written <= 0) {
      throw new Error("socket write made no progress");
    }
    offset += written;
  }
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (let index = 0; index < parts.length; index += 1) {
    total += parts[index]?.length ?? 0;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part !== undefined) {
      out.set(part, offset);
      offset += part.length;
    }
  }
  return out;
}

function base64URLEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index] ?? 0);
  }
  return runtime.btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64URLDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.includes("=") || value.length % 4 === 1) {
    throw new Error("invalid base64url");
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = runtime.atob(padded);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    out[index] = binary.charCodeAt(index);
  }
  return out;
}

function readStringField(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const child = value[key];
  if (typeof child !== "string" || child.length === 0) {
    return undefined;
  }
  return child;
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

main().catch((cause) => {
  console.error("owner test authenticator failed", cause);
  Deno.exit(1);
});
