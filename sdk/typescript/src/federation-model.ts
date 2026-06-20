import { validateIdentityConfig } from "./identity-model.ts";
import { safeNormalize } from "./safe-normalize.ts";
import type { Did, Handle, PdsEndpoint } from "./identity-model.ts";
import type { PlainJson, PlainJsonObject } from "./safe-normalize.ts";

export type RelaySubscribePolicy = "allowed-peers" | "disabled";
export type PeerTrust = "allow" | "block";

export interface RelayConfig {
  readonly endpoint: PdsEndpoint;
  readonly subscribePolicy: RelaySubscribePolicy;
}

export interface FederationPeer {
  readonly did: Did;
  readonly handle: Handle;
  readonly endpoint: PdsEndpoint;
  readonly trust: PeerTrust;
}

export interface FederationConfig {
  readonly relays: readonly RelayConfig[];
  readonly peers: readonly FederationPeer[];
}

export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

export type Result =
  | {
      readonly ok: true;
      readonly config: FederationConfig;
      readonly value: FederationConfig;
    }
  | {
      readonly ok: false;
      readonly errors: readonly ValidationError[];
    };

type JsonRecord = PlainJsonObject;
type Path = readonly string[];

const FEDERATION_CONFIG_FIELDS = new Set(["peers", "relays"]);
const RELAY_CONFIG_FIELDS = new Set(["endpoint", "subscribePolicy"]);
const FEDERATION_PEER_FIELDS = new Set(["did", "endpoint", "handle", "trust"]);

const RELAY_SUBSCRIBE_POLICIES = new Set<RelaySubscribePolicy>([
  "allowed-peers",
  "disabled",
]);
const PEER_TRUST_VALUES = new Set<PeerTrust>(["allow", "block"]);

const VALID_DID: Did = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
const VALID_HANDLE: Handle = "validator.example.com";
const VALID_ENDPOINT: PdsEndpoint = "https://pds.example.com";
const VALID_SIGNING_KEY_REF = Object.freeze({
  handle: "identity-signing-primary",
  id: "key:identity-signing-primary",
});
const VALID_ROTATION_KEY_REF = Object.freeze({
  handle: "identity-rotation-primary",
  id: "key:identity-rotation-primary",
});

const SECRET_FIELD_NAME_TOKENS = new Set([
  "apikey",
  "key",
  "keymaterial",
  "mnemonic",
  "passphrase",
  "pem",
  "privatekey",
  "recoverykey",
  "rotationkey",
  "seed",
  "seedphrase",
  "secret",
  "signingkey",
]);

export function validateFederationConfig(input: unknown): Result {
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
    const config = parseFederationConfig(normalized.value, [], errors);

    if (config === undefined || errors.length > 0) {
      return reject(errors);
    }

    return {
      ok: true,
      config,
      value: config,
    };
  } catch {
    return reject([{ path: "", message: "Federation config validation failed." }]);
  }
}

function parseFederationConfig(
  value: PlainJson,
  path: Path,
  errors: ValidationError[],
): FederationConfig | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected federation config object.");
    return undefined;
  }

  const errorStart = errors.length;

  rejectUnknownFields(value, FEDERATION_CONFIG_FIELDS, path, errors);
  rejectSecretFieldNames(value, path, errors);

  const relays = parseRelays(value, [...path, "relays"], errors);
  const peers = parsePeers(value, [...path, "peers"], errors);

  if (
    errors.length > errorStart ||
    relays === undefined ||
    peers === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    relays,
    peers,
  });
}

function parseRelays(
  value: JsonRecord,
  path: Path,
  errors: ValidationError[],
): readonly RelayConfig[] | undefined {
  const child = readRequiredProperty(value, "relays", path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!Array.isArray(child)) {
    addError(errors, path, "Expected relays array.");
    return undefined;
  }

  const relays: RelayConfig[] = [];
  const errorStart = errors.length;

  for (let index = 0; index < child.length; index += 1) {
    const item = child[index];

    if (item === undefined) {
      addError(errors, [...path, String(index)], "Expected relay config object.");
      continue;
    }

    const relay = parseRelay(item, [...path, String(index)], errors);

    if (relay !== undefined) {
      relays.push(relay);
    }
  }

  if (errors.length > errorStart) {
    return undefined;
  }

  return Object.freeze(relays);
}

function parseRelay(
  value: PlainJson,
  path: Path,
  errors: ValidationError[],
): RelayConfig | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected relay config object.");
    return undefined;
  }

  const errorStart = errors.length;

  rejectUnknownFields(value, RELAY_CONFIG_FIELDS, path, errors);
  rejectSecretFieldNames(value, path, errors);

  const endpoint = validateRequiredHttpsBaseEndpoint(
    value,
    "endpoint",
    [...path, "endpoint"],
    errors,
  );
  const subscribePolicy = readRequiredEnum(
    value,
    "subscribePolicy",
    RELAY_SUBSCRIBE_POLICIES,
    [...path, "subscribePolicy"],
    errors,
  );

  if (
    errors.length > errorStart ||
    endpoint === undefined ||
    subscribePolicy === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    endpoint,
    subscribePolicy,
  });
}

function parsePeers(
  value: JsonRecord,
  path: Path,
  errors: ValidationError[],
): readonly FederationPeer[] | undefined {
  const child = readRequiredProperty(value, "peers", path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!Array.isArray(child)) {
    addError(errors, path, "Expected peers array.");
    return undefined;
  }

  const peers: FederationPeer[] = [];
  const seenPeerDids = new Map<Did, number>();
  const errorStart = errors.length;

  for (let index = 0; index < child.length; index += 1) {
    const item = child[index];

    if (item === undefined) {
      addError(errors, [...path, String(index)], "Expected federation peer object.");
      continue;
    }

    const peer = parsePeer(item, [...path, String(index)], errors);

    if (peer === undefined) {
      continue;
    }

    const previousIndex = seenPeerDids.get(peer.did);

    if (previousIndex !== undefined) {
      addError(
        errors,
        [...path, String(index), "did"],
        `Duplicate peer DID also appears at peers/${previousIndex}/did.`,
      );
    } else {
      seenPeerDids.set(peer.did, index);
    }

    peers.push(peer);
  }

  if (errors.length > errorStart) {
    return undefined;
  }

  return Object.freeze(peers);
}

function parsePeer(
  value: PlainJson,
  path: Path,
  errors: ValidationError[],
): FederationPeer | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected federation peer object.");
    return undefined;
  }

  const errorStart = errors.length;

  rejectUnknownFields(value, FEDERATION_PEER_FIELDS, path, errors);
  rejectSecretFieldNames(value, path, errors);

  const did = validateRequiredDid(value, "did", [...path, "did"], errors);
  const handle = validateRequiredHandle(value, "handle", [...path, "handle"], errors);
  const endpoint = validateRequiredHttpsBaseEndpoint(
    value,
    "endpoint",
    [...path, "endpoint"],
    errors,
  );
  const trust = readRequiredEnum(
    value,
    "trust",
    PEER_TRUST_VALUES,
    [...path, "trust"],
    errors,
  );

  if (
    errors.length > errorStart ||
    did === undefined ||
    handle === undefined ||
    endpoint === undefined ||
    trust === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    did,
    handle,
    endpoint,
    trust,
  });
}

function validateRequiredDid(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): Did | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  const result = validateIdentityConfig(identityValidationInput({ did: child }));

  if (!result.ok) {
    addError(errors, path, "Expected supported did:plc or did:web identifier.");
    return undefined;
  }

  return result.config.did;
}

function validateRequiredHandle(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): Handle | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  const result = validateIdentityConfig(identityValidationInput({ handle: child }));

  if (!result.ok) {
    addError(errors, path, "Expected domain-style handle.");
    return undefined;
  }

  return result.config.handle;
}

function validateRequiredHttpsBaseEndpoint(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): PdsEndpoint | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  const result = validateIdentityConfig(identityValidationInput({ endpoint: child }));

  if (!result.ok) {
    addError(errors, path, "Expected HTTPS base endpoint.");
    return undefined;
  }

  return result.config.pds.endpoint;
}

function identityValidationInput(overrides: {
  readonly did?: PlainJson;
  readonly endpoint?: PlainJson;
  readonly handle?: PlainJson;
}): PlainJsonObject {
  const did = overrides.did !== undefined ? overrides.did : VALID_DID;
  const endpoint = overrides.endpoint !== undefined ? overrides.endpoint : VALID_ENDPOINT;
  const handle = overrides.handle !== undefined ? overrides.handle : VALID_HANDLE;

  return Object.freeze({
    did,
    handle,
    pds: Object.freeze({
      endpoint,
    }),
    rotationKeyRefs: Object.freeze([VALID_ROTATION_KEY_REF]),
    signingKeyRef: VALID_SIGNING_KEY_REF,
  });
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

  const child = value[key];

  if (child === undefined) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }

  return child;
}

function readRequiredEnum<T extends string>(
  value: JsonRecord,
  key: string,
  allowed: ReadonlySet<T>,
  path: Path,
  errors: ValidationError[],
): T | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!isStringInSet(child, allowed)) {
    addError(errors, path, `Expected one of: ${[...allowed].join(", ")}.`);
    return undefined;
  }

  return child;
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

    if (key !== undefined && !allowed.has(key) && !isSecretFieldName(key)) {
      addError(errors, [...path, key], "Unknown field.");
    }
  }
}

function rejectSecretFieldNames(
  value: JsonRecord,
  path: Path,
  errors: ValidationError[],
): void {
  const keys = Object.keys(value).sort(compareStrings);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && isSecretFieldName(key)) {
      addError(errors, [...path, key], "Inline key material is not allowed.");
    }
  }
}

function isRecord(value: PlainJson | undefined): value is JsonRecord {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringInSet<T extends string>(
  value: PlainJson,
  allowed: ReadonlySet<T>,
): value is T {
  return typeof value === "string" && allowed.has(value as T);
}

function isSecretFieldName(value: string): boolean {
  return SECRET_FIELD_NAME_TOKENS.has(value.replace(/[-_]/gu, "").toLowerCase());
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

function reject(errors: readonly ValidationError[]): Extract<Result, { readonly ok: false }> {
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
