import { validateIdentityConfig } from "./identity-model.ts";
import { safeNormalize } from "./safe-normalize.ts";
import type { Did, Handle, PdsEndpoint } from "./identity-model.ts";
import type { PlainJson, PlainJsonObject } from "./safe-normalize.ts";

export type VerificationMethodType = "Multikey";
export type ServiceType = "AtprotoPersonalDataServer";
export type DidUrl = `${Did}#${string}`;
export type DidFragment = `#${string}`;
export type PublicKeyMultibase = `z${string}`;

export interface VerificationMethod {
  readonly id: DidUrl;
  readonly type: VerificationMethodType;
  readonly controller: Did;
  readonly publicKeyMultibase: PublicKeyMultibase;
}

export interface Service {
  readonly id: DidUrl | DidFragment;
  readonly type: ServiceType;
  readonly serviceEndpoint: PdsEndpoint;
}

export interface DidDocument {
  readonly id: Did;
  readonly alsoKnownAs: readonly Handle[];
  readonly verificationMethod: readonly VerificationMethod[];
  readonly service: readonly Service[];
}

export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

export type Result =
  | {
      readonly ok: true;
      readonly document: DidDocument;
      readonly value: DidDocument;
    }
  | {
      readonly ok: false;
      readonly errors: readonly ValidationError[];
    };

type JsonRecord = PlainJsonObject;
type Path = readonly string[];

const DID_DOCUMENT_FIELDS = new Set([
  "alsoKnownAs",
  "id",
  "service",
  "verificationMethod",
]);
const VERIFICATION_METHOD_FIELDS = new Set([
  "controller",
  "id",
  "publicKeyMultibase",
  "type",
]);
const SERVICE_FIELDS = new Set(["id", "serviceEndpoint", "type"]);

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

const MAX_ID_LENGTH = 2048;
const MAX_PUBLIC_KEY_MULTIBASE_LENGTH = 4096;
const FRAGMENT_PATTERN = /^(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+$/u;
const BASE58BTC_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

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

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const PEM_BLOCK_PATTERN = /-----BEGIN\b/i;
const PRIVATE_KEY_PATTERN =
  /\b(?:private[-_\s]?key|openssh\s+private\s+key|age-secret-key|xprv|seed[-_\s]?phrase|mnemonic|recovery[-_\s]?phrase)\b/i;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(?:private[-_\s]?key|api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|password|secret)\s*(?:=|:(?!\/\/))/i;
const SEED_WORDS_PATTERN = /\b[a-z]{3,12}(?:\s+[a-z]{3,12}){11,23}\b/i;

export function validateDidDocument(input: unknown): Result {
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
    const document = parseDidDocument(normalized.value, [], errors);

    if (document === undefined || errors.length > 0) {
      return reject(errors);
    }

    return {
      document,
      ok: true,
      value: document,
    };
  } catch {
    return reject([{ path: "", message: "DID document validation failed." }]);
  }
}

function parseDidDocument(
  value: PlainJson,
  path: Path,
  errors: ValidationError[],
): DidDocument | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected DID document object.");
    return undefined;
  }

  const errorStart = errors.length;

  rejectUnknownFields(value, DID_DOCUMENT_FIELDS, path, errors);
  rejectSecretFieldNames(value, path, errors);

  const id = validateRequiredDid(value, "id", [...path, "id"], errors);
  const alsoKnownAs = parseAlsoKnownAs(value, [...path, "alsoKnownAs"], errors);
  const verificationMethod = parseVerificationMethods(
    value,
    [...path, "verificationMethod"],
    id,
    errors,
  );
  const service = parseServices(value, [...path, "service"], id, errors);

  if (
    errors.length > errorStart ||
    id === undefined ||
    alsoKnownAs === undefined ||
    verificationMethod === undefined ||
    service === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    alsoKnownAs,
    id,
    service,
    verificationMethod,
  });
}

function parseAlsoKnownAs(
  value: JsonRecord,
  path: Path,
  errors: ValidationError[],
): readonly Handle[] | undefined {
  const child = readRequiredProperty(value, "alsoKnownAs", path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!Array.isArray(child)) {
    addError(errors, path, "Expected alsoKnownAs handle array.");
    return undefined;
  }

  if (child.length === 0) {
    addError(errors, path, "Expected at least one alsoKnownAs handle.");
    return undefined;
  }

  const handles: Handle[] = [];
  const errorStart = errors.length;

  for (let index = 0; index < child.length; index += 1) {
    const handle = validateHandleValue(child[index], [...path, String(index)], errors);

    if (handle !== undefined) {
      handles.push(handle);
    }
  }

  if (errors.length > errorStart) {
    return undefined;
  }

  return Object.freeze(handles);
}

function parseVerificationMethods(
  value: JsonRecord,
  path: Path,
  documentDid: Did | undefined,
  errors: ValidationError[],
): readonly VerificationMethod[] | undefined {
  const child = readRequiredProperty(value, "verificationMethod", path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!Array.isArray(child)) {
    addError(errors, path, "Expected verificationMethod array.");
    return undefined;
  }

  if (child.length === 0) {
    addError(errors, path, "Expected at least one verification method.");
    return undefined;
  }

  const methods: VerificationMethod[] = [];
  const seenIds = new Map<DidUrl, number>();
  const errorStart = errors.length;

  for (let index = 0; index < child.length; index += 1) {
    const method = parseVerificationMethod(
      child[index],
      [...path, String(index)],
      documentDid,
      errors,
    );

    if (method === undefined) {
      continue;
    }

    const previousIndex = seenIds.get(method.id);

    if (previousIndex !== undefined) {
      addError(
        errors,
        [...path, String(index), "id"],
        `Duplicate verification method id also appears at verificationMethod/${previousIndex}/id.`,
      );
    } else {
      seenIds.set(method.id, index);
    }

    methods.push(method);
  }

  if (errors.length > errorStart) {
    return undefined;
  }

  return Object.freeze(methods);
}

function parseVerificationMethod(
  value: PlainJson | undefined,
  path: Path,
  documentDid: Did | undefined,
  errors: ValidationError[],
): VerificationMethod | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected verification method object.");
    return undefined;
  }

  const errorStart = errors.length;

  rejectUnknownFields(value, VERIFICATION_METHOD_FIELDS, path, errors);
  rejectSecretFieldNames(value, path, errors);

  const id = validateRequiredVerificationMethodId(
    value,
    "id",
    [...path, "id"],
    documentDid,
    errors,
  );
  const type = validateRequiredVerificationMethodType(value, "type", [...path, "type"], errors);
  const controller = validateRequiredDid(value, "controller", [...path, "controller"], errors);
  const publicKeyMultibase = validateRequiredPublicKeyMultibase(
    value,
    "publicKeyMultibase",
    [...path, "publicKeyMultibase"],
    errors,
  );

  if (
    errors.length > errorStart ||
    id === undefined ||
    type === undefined ||
    controller === undefined ||
    publicKeyMultibase === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    controller,
    id,
    publicKeyMultibase,
    type,
  });
}

function parseServices(
  value: JsonRecord,
  path: Path,
  documentDid: Did | undefined,
  errors: ValidationError[],
): readonly Service[] | undefined {
  const child = readRequiredProperty(value, "service", path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!Array.isArray(child)) {
    addError(errors, path, "Expected service array.");
    return undefined;
  }

  if (child.length === 0) {
    addError(errors, path, "Expected at least one service.");
    return undefined;
  }

  const services: Service[] = [];
  const seenIds = new Map<DidUrl | DidFragment, number>();
  const errorStart = errors.length;

  for (let index = 0; index < child.length; index += 1) {
    const service = parseService(child[index], [...path, String(index)], documentDid, errors);

    if (service === undefined) {
      continue;
    }

    const previousIndex = seenIds.get(service.id);

    if (previousIndex !== undefined) {
      addError(
        errors,
        [...path, String(index), "id"],
        `Duplicate service id also appears at service/${previousIndex}/id.`,
      );
    } else {
      seenIds.set(service.id, index);
    }

    services.push(service);
  }

  if (errors.length > errorStart) {
    return undefined;
  }

  return Object.freeze(services);
}

function parseService(
  value: PlainJson | undefined,
  path: Path,
  documentDid: Did | undefined,
  errors: ValidationError[],
): Service | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected service object.");
    return undefined;
  }

  const errorStart = errors.length;

  rejectUnknownFields(value, SERVICE_FIELDS, path, errors);
  rejectSecretFieldNames(value, path, errors);

  const id = validateRequiredServiceId(value, "id", [...path, "id"], documentDid, errors);
  const type = validateRequiredServiceType(value, "type", [...path, "type"], errors);
  const serviceEndpoint = validateRequiredHttpsBaseEndpoint(
    value,
    "serviceEndpoint",
    [...path, "serviceEndpoint"],
    errors,
  );

  if (
    errors.length > errorStart ||
    id === undefined ||
    type === undefined ||
    serviceEndpoint === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    id,
    serviceEndpoint,
    type,
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

function validateHandleValue(
  value: PlainJson | undefined,
  path: Path,
  errors: ValidationError[],
): Handle | undefined {
  if (value === undefined) {
    addError(errors, path, "Expected domain-style handle.");
    return undefined;
  }

  const result = validateIdentityConfig(identityValidationInput({ handle: value }));

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
    addError(errors, path, "Expected HTTPS service endpoint.");
    return undefined;
  }

  return result.config.pds.endpoint;
}

function validateRequiredVerificationMethodId(
  value: JsonRecord,
  key: string,
  path: Path,
  documentDid: Did | undefined,
  errors: ValidationError[],
): DidUrl | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (
    typeof child !== "string" ||
    documentDid === undefined ||
    !isDidUrlWithFragment(child, documentDid)
  ) {
    addError(errors, path, "Expected verification method id in <did>#<fragment> form.");
    return undefined;
  }

  return child;
}

function validateRequiredServiceId(
  value: JsonRecord,
  key: string,
  path: Path,
  documentDid: Did | undefined,
  errors: ValidationError[],
): DidUrl | DidFragment | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (
    typeof child !== "string" ||
    !isServiceIdentifier(child, documentDid)
  ) {
    addError(errors, path, "Expected service id fragment.");
    return undefined;
  }

  return child;
}

function validateRequiredVerificationMethodType(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): VerificationMethodType | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (child !== "Multikey") {
    addError(errors, path, "Expected verification method type Multikey.");
    return undefined;
  }

  return child;
}

function validateRequiredServiceType(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): ServiceType | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (child !== "AtprotoPersonalDataServer") {
    addError(errors, path, "Expected service type AtprotoPersonalDataServer.");
    return undefined;
  }

  return child;
}

function validateRequiredPublicKeyMultibase(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): PublicKeyMultibase | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (typeof child !== "string") {
    addError(errors, path, "Expected publicKeyMultibase string.");
    return undefined;
  }

  if (containsInlinePrivateKeyMaterial(child)) {
    addError(errors, path, "publicKeyMultibase must not contain inline private key material.");
    return undefined;
  }

  if (!isPublicKeyMultibaseReference(child)) {
    addError(errors, path, "Expected base58btc multibase public key reference.");
    return undefined;
  }

  return child;
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

function isDidUrlWithFragment(value: string, did: Did): value is DidUrl {
  if (value.length > MAX_ID_LENGTH || !value.startsWith(`${did}#`)) {
    return false;
  }

  return isFragment(value.slice(did.length + 1));
}

function isServiceIdentifier(value: string, documentDid: Did | undefined): value is DidUrl | DidFragment {
  if (value.length > MAX_ID_LENGTH) {
    return false;
  }

  if (value.startsWith("#")) {
    return isFragment(value.slice(1));
  }

  return documentDid !== undefined && isDidUrlWithFragment(value, documentDid);
}

function isFragment(value: string): boolean {
  return value.length > 0 && FRAGMENT_PATTERN.test(value);
}

function isPublicKeyMultibaseReference(value: string): value is PublicKeyMultibase {
  if (
    value.length < 2 ||
    value.length > MAX_PUBLIC_KEY_MULTIBASE_LENGTH ||
    value !== value.trim() ||
    value[0] !== "z"
  ) {
    return false;
  }

  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];

    if (character === undefined || !BASE58BTC_ALPHABET.includes(character)) {
      return false;
    }
  }

  return true;
}

function containsInlinePrivateKeyMaterial(value: string): boolean {
  return (
    CONTROL_CHARACTER_PATTERN.test(value) ||
    PEM_BLOCK_PATTERN.test(value) ||
    PRIVATE_KEY_PATTERN.test(value) ||
    SECRET_ASSIGNMENT_PATTERN.test(value) ||
    SEED_WORDS_PATTERN.test(value)
  );
}

function isSecretFieldName(value: string): boolean {
  return SECRET_FIELD_NAME_TOKENS.has(value.replace(/[-_]/gu, "").toLowerCase());
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

function reject(errors: readonly ValidationError[]): Extract<Result, { readonly ok: false }> {
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

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}
