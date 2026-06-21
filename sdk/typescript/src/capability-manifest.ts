import { safeNormalize } from "./safe-normalize.ts";
import { DEFAULT_CAPABILITY_MANIFESTS } from "./generated/capability-manifests.generated.ts";
import type { PlainJson, PlainJsonObject } from "./safe-normalize.ts";

/**
 * Additive ADR 0007 proof-of-concept for a deliberately closed capability-manifest
 * dialect. Cross-field invariants are limited to the rule union below; a capability
 * that needs a different invariant requires a governance-reviewed dialect extension,
 * not an embedded expression language.
 *
 * String formats are a closed, governed set. `posixUsername`, `posixAccountName`, `groupName`,
 * `systemdUnitName`, `absolutePath`, `rfc3339Instant`, `capsuleId`,
 * `capsuleVersion`, `sriIntegrity`, `bundleRefString`, and
 * `bundleVersionString`, `didPlcOrWeb`, `atprotoHandle`, `keyReference`,
 * `cidrLiteral`, and `networkInterfaceName`
 * are structured capability-agent parity formats.
 * `ipLiteral` and `hostnameOrIp`
 * are parity-safe only because schema/capabilities/formats/ip-conformance.json
 * is run by both the TypeScript RFC 5952 canonicalizer here and the Go netip
 * validator in agent/internal/capmanifest.
 *
 * The lowercase primitive is ASCII-only by contract: A-Z map to a-z and every other
 * code point is left unchanged. That avoids JS/Go Unicode case-folding drift.
 *
 * Default registry keys are the agent operation names carried in each manifest's
 * `capability` field, for example `node.config` and `hostname.set`.
 */

export type StringFieldFormat =
  | "hostnameRFC1123"
  | "hostnameLabel"
  | "ipLiteral"
  | "hostnameOrIp"
  | "posixUsername"
  | "posixAccountName"
  | "groupName"
  | "systemdUnitName"
  | "absolutePath"
  | "rfc3339Instant"
  | "capsuleId"
  | "capsuleVersion"
  | "sriIntegrity"
  | "bundleRefString"
  | "bundleVersionString"
  | "didPlcOrWeb"
  | "atprotoHandle"
  | "keyReference"
  | "cidrLiteral"
  | "networkInterfaceName";

export interface StringFieldSchema {
  readonly type: "string";
  readonly required: boolean;
  readonly maxLength?: number;
  readonly maxBytes?: number;
  readonly minLength?: number;
  readonly enum?: readonly string[];
  readonly notInEnum?: readonly string[];
  readonly lowercase?: boolean;
  readonly noControlChars?: boolean;
  readonly noInlineCapsuleMaterial?: boolean;
  readonly noInlineIdentityMaterial?: boolean;
  readonly noInlineMaterial?: boolean;
  readonly noInlineSecrets?: boolean;
  readonly nonEmpty?: boolean;
  readonly trimmed?: boolean;
  readonly forbiddenSchemePrefix?: boolean;
  readonly format?: StringFieldFormat;
}

export interface IntegerFieldSchema {
  readonly type: "integer";
  readonly required: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly sentinelValues?: readonly number[];
}

export interface BooleanFieldSchema {
  readonly type: "boolean";
  readonly required: boolean;
}

export interface ArrayFieldSchema {
  readonly type: "array";
  readonly required: boolean;
  readonly items: FieldSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly dedupItems?: boolean;
  readonly uniqueBy?: readonly string[];
}

export interface ObjectFieldSchema {
  readonly type: "object";
  readonly required: boolean;
  readonly fields: Readonly<Record<string, FieldSchema>>;
  readonly crossFieldRules?: readonly CrossFieldRule[];
}

export type FieldSchema =
  | StringFieldSchema
  | IntegerFieldSchema
  | BooleanFieldSchema
  | ArrayFieldSchema
  | ObjectFieldSchema;

export type CrossFieldRule =
  | {
      readonly type: "requireNonEmptyArrayWhenTrue";
      readonly control: string;
      readonly target: string;
    }
  | {
      readonly type: "requireEmptyArrayWhenFalse";
      readonly control: string;
      readonly target: string;
    }
  | {
      readonly type: "forbidIntegerSentinelAndCidrCoversAllUnlessTrue";
      readonly control: string;
      readonly integer: string;
      readonly target: string;
      readonly sentinel: number;
    };

export interface CapabilityManifest {
  readonly capability: string;
  readonly version?: 1;
  readonly defaultRegistry?: false;
  readonly fields: Readonly<Record<string, FieldSchema>>;
  readonly crossFieldRules: readonly CrossFieldRule[];
}

export interface LoadedCapabilityManifest extends CapabilityManifest {
  readonly version: 1;
}

export type CapabilityManifestLoadResult =
  | {
      readonly ok: true;
      readonly manifest: LoadedCapabilityManifest;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export type CapabilityValue =
  | string
  | number
  | boolean
  | readonly CapabilityValue[]
  | CapabilityObject;

export interface CapabilityObject {
  readonly [key: string]: CapabilityValue;
}

export type CapabilityRecord = CapabilityObject;

export interface CapabilityRejection {
  readonly path: string;
  readonly message: string;
}

export type CapabilityValidationResult =
  | {
      readonly ok: true;
      readonly value: CapabilityRecord;
    }
  | {
      readonly ok: false;
      readonly rejections: readonly CapabilityRejection[];
    };

export type CapabilityValidator = (input: unknown) => CapabilityValidationResult;

export type CapabilityManifestRegistry = ReadonlyMap<string, CapabilityManifest>;

// Re-export everything the codegen emits (DEFAULT_CAPABILITY_MANIFESTS + each <CAP>_MANIFEST). Using
// `export *` so a newly-generated cap manifest is publicly available WITHOUT editing this list by hand —
// the generated file only ever exports manifests, so there is nothing internal to leak.
export * from "./generated/capability-manifests.generated.ts";

type JsonRecord = PlainJsonObject;
type Path = readonly string[];

interface CompiledManifest {
  readonly capability: string;
  readonly fields: ReadonlyMap<string, CompiledFieldSchema>;
  readonly fieldNames: readonly string[];
  readonly crossFieldRules: readonly CrossFieldRule[];
}

interface ParsedManifest {
  readonly manifest: CapabilityManifest;
  readonly compiled: CompiledManifest;
}

interface ParsedManifestFields {
  readonly manifest: Readonly<Record<string, FieldSchema>>;
  readonly compiled: ReadonlyMap<string, CompiledFieldSchema>;
  readonly fieldNames: readonly string[];
}

interface ParsedFieldSchema {
  readonly manifest: FieldSchema;
  readonly compiled: CompiledFieldSchema;
}

interface ParseManifestOptions {
  readonly requireVersion: boolean;
}

type CompiledFieldSchema =
  | CompiledStringFieldSchema
  | CompiledIntegerFieldSchema
  | CompiledBooleanFieldSchema
  | CompiledArrayFieldSchema
  | CompiledObjectFieldSchema;

interface CompiledStringFieldSchema {
  type: "string";
  required: boolean;
  format?: StringFieldFormat;
  maxLength?: number;
  maxBytes?: number;
  minLength?: number;
  enumValues?: ReadonlySet<string>;
  notInEnumValues?: ReadonlySet<string>;
  lowercase: boolean;
  noControlChars: boolean;
  noInlineCapsuleMaterial: boolean;
  noInlineIdentityMaterial: boolean;
  noInlineMaterial: boolean;
  forbiddenSchemePrefix: boolean;
  trimmed: boolean;
}

interface CompiledIntegerFieldSchema {
  type: "integer";
  required: boolean;
  minimum?: number;
  maximum?: number;
  sentinelValues?: ReadonlySet<number>;
}

interface CompiledBooleanFieldSchema {
  type: "boolean";
  required: boolean;
}

interface CompiledArrayFieldSchema {
  type: "array";
  required: boolean;
  items: CompiledFieldSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems: boolean;
  dedupItems: boolean;
  uniqueBy?: readonly string[];
}

interface CompiledObjectFieldSchema {
  type: "object";
  required: boolean;
  fields: ReadonlyMap<string, CompiledFieldSchema>;
  fieldNames: readonly string[];
  crossFieldRules: readonly CrossFieldRule[];
}

type FieldValidationResult =
  | {
      readonly ok: true;
      readonly value: CapabilityValue;
    }
  | {
      readonly ok: false;
    };

type RawJsonValue = PlainJson | typeof INVALID_RAW_JSON;

type RawCapabilityRequestParseResult =
  | {
      readonly ok: true;
      readonly value: PlainJson;
      readonly rawStringTokens: ReadonlyMap<string, string>;
      readonly rawNumberTokens: ReadonlyMap<string, string>;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

interface RawJsonScanner {
  readonly text: string;
  index: number;
  duplicateKey: boolean;
  readonly rawNumberTokens: Map<string, string>;
  readonly rawStringTokens: Map<string, string>;
}

interface RawJsonStringToken {
  readonly value: string;
  readonly rawToken: string;
}

const SUPPORTED_MANIFEST_VERSION = 1;
const INVALID_RAW_JSON = Symbol("invalidRawJson");
const MANIFEST_FIELDS = new Set([
  "capability",
  "crossFieldRules",
  "defaultRegistry",
  "fields",
  "version",
]);
const STRING_SCHEMA_FIELDS = new Set([
  "enum",
  "format",
  "lowercase",
  "maxBytes",
  "maxLength",
  "minLength",
  "notInEnum",
  "forbiddenSchemePrefix",
  "noInlineCapsuleMaterial",
  "noControlChars",
  "noInlineIdentityMaterial",
  "noInlineMaterial",
  "noInlineSecrets",
  "nonEmpty",
  "required",
  "trimmed",
  "type",
]);
const INTEGER_SCHEMA_FIELDS = new Set(["maximum", "minimum", "required", "sentinelValues", "type"]);
const BOOLEAN_SCHEMA_FIELDS = new Set(["required", "type"]);
const ARRAY_SCHEMA_FIELDS = new Set([
  "items",
  "dedupItems",
  "maxItems",
  "minItems",
  "required",
  "type",
  "uniqueBy",
  "uniqueItems",
]);
const OBJECT_SCHEMA_FIELDS = new Set(["crossFieldRules", "fields", "required", "type"]);
const CROSS_FIELD_RULE_FIELDS = new Set(["control", "integer", "sentinel", "target", "type"]);
export function loadCapabilityManifest(raw: unknown): CapabilityManifestLoadResult {
  try {
    const normalized = safeNormalize(raw);

    if (!normalized.ok) {
      return rejectManifestLoad(`Invalid manifest: ${normalized.reason}`);
    }

    const errors: CapabilityRejection[] = [];
    const parsed = parseManifest(normalized.value, [], errors, { requireVersion: true });

    if (parsed === undefined || errors.length > 0 || parsed.manifest.version !== SUPPORTED_MANIFEST_VERSION) {
      return rejectManifestLoad(formatManifestLoadReason(errors));
    }

    const manifest = Object.freeze(
      parsed.manifest.defaultRegistry === undefined
        ? {
            capability: parsed.manifest.capability,
            version: SUPPORTED_MANIFEST_VERSION,
            fields: parsed.manifest.fields,
            crossFieldRules: parsed.manifest.crossFieldRules,
          }
        : {
            capability: parsed.manifest.capability,
            version: SUPPORTED_MANIFEST_VERSION,
            defaultRegistry: parsed.manifest.defaultRegistry,
            fields: parsed.manifest.fields,
            crossFieldRules: parsed.manifest.crossFieldRules,
          },
    ) satisfies LoadedCapabilityManifest;

    return {
      ok: true,
      manifest,
    };
  } catch {
    return rejectManifestLoad("Capability manifest loading failed.");
  }
}

export function compileCapabilityValidator(manifest: CapabilityManifest): CapabilityValidator {
  const compiled = compileManifest(manifest);

  if (!compiled.ok) {
    return () => reject(compiled.rejections);
  }

  return (input: unknown): CapabilityValidationResult => {
    try {
      let normalizedValue: PlainJson;
      let rawStringTokens: ReadonlyMap<string, string> | undefined;
      let rawNumberTokens: ReadonlyMap<string, string> | undefined;

      if (typeof input === "string") {
        const parsed = parseRawCapabilityRequest(input);

        if (!parsed.ok) {
          return reject([
            {
              message: `Invalid JSON request: ${parsed.reason}`,
              path: "",
            },
          ]);
        }

        normalizedValue = parsed.value;
        rawStringTokens = parsed.rawStringTokens;
        rawNumberTokens = parsed.rawNumberTokens;
      } else {
        const normalized = safeNormalize(input);

        if (!normalized.ok) {
          return reject([
            {
              message: `Invalid untrusted input: ${normalized.reason}`,
              path: "",
            },
          ]);
        }

        normalizedValue = normalized.value;
      }

      const value = validateInput(normalizedValue, compiled.value, rawStringTokens, rawNumberTokens);

      if (!value.ok) {
        return reject(value.rejections);
      }

      return {
        ok: true,
        value: value.value,
      };
    } catch {
      return reject([{ message: "Capability manifest validation failed.", path: "" }]);
    }
  };
}

export function defaultCapabilityRegistry(): CapabilityManifestRegistry {
  return new Map(Object.entries(DEFAULT_CAPABILITY_MANIFESTS));
}

function compileManifest(input: unknown):
  | {
      readonly ok: true;
      readonly value: CompiledManifest;
    }
  | {
      readonly ok: false;
      readonly rejections: readonly CapabilityRejection[];
    } {
  try {
    const normalized = safeNormalize(input);

    if (!normalized.ok) {
      return reject([
        {
          message: `Invalid manifest: ${normalized.reason}`,
          path: "",
        },
      ]);
    }

    const errors: CapabilityRejection[] = [];
    const manifest = parseManifest(normalized.value, [], errors, { requireVersion: false });

    if (manifest === undefined || errors.length > 0) {
      return reject(errors);
    }

    return {
      ok: true,
      value: manifest.compiled,
    };
  } catch {
    return reject([{ message: "Capability manifest compilation failed.", path: "" }]);
  }
}

function parseManifest(
  value: PlainJson,
  path: Path,
  errors: CapabilityRejection[],
  options: ParseManifestOptions,
): ParsedManifest | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected capability manifest object.");
    return undefined;
  }

  const errorStart = errors.length;
  rejectUnknownFields(value, MANIFEST_FIELDS, path, errors);

  const capability = readRequiredString(value, "capability", [...path, "capability"], errors);
  const version = options.requireVersion
    ? readRequiredManifestVersion(value, "version", [...path, "version"], errors)
    : readOptionalManifestVersion(value, "version", [...path, "version"], errors);
  const defaultRegistry = readOptionalDefaultRegistry(
    value,
    "defaultRegistry",
    [...path, "defaultRegistry"],
    errors,
  );
  const fieldsValue = readRequiredProperty(value, "fields", [...path, "fields"], errors);
  const rulesValue = readRequiredProperty(value, "crossFieldRules", [...path, "crossFieldRules"], errors);

  const fields =
    fieldsValue === undefined
      ? undefined
      : parseManifestFields(fieldsValue, [...path, "fields"], errors);
  const crossFieldRules =
    rulesValue === undefined
      ? undefined
      : parseCrossFieldRules(rulesValue, [...path, "crossFieldRules"], fields?.compiled, errors);

  if (capability !== undefined && capability.length === 0) {
    addError(errors, [...path, "capability"], "Expected non-empty capability name.");
  }

  if (
    errors.length > errorStart ||
    capability === undefined ||
    capability.length === 0 ||
    fields === undefined ||
    crossFieldRules === undefined
  ) {
    return undefined;
  }

  const manifest = Object.freeze(
    version === undefined
      ? defaultRegistry === undefined
        ? {
            capability,
            crossFieldRules,
            fields: fields.manifest,
          }
        : {
            capability,
            defaultRegistry,
            crossFieldRules,
            fields: fields.manifest,
          }
      : defaultRegistry === undefined
        ? {
            capability,
            version,
            crossFieldRules,
            fields: fields.manifest,
          }
        : {
            capability,
            version,
            defaultRegistry,
            crossFieldRules,
            fields: fields.manifest,
          },
  );

  const compiled = Object.freeze({
    capability,
    crossFieldRules,
    fieldNames: fields.fieldNames,
    fields: fields.compiled,
  });

  return {
    compiled,
    manifest,
  };
}

function parseManifestFields(
  value: PlainJson,
  path: Path,
  errors: CapabilityRejection[],
): ParsedManifestFields | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected fields object.");
    return undefined;
  }

  const fieldNames = Object.keys(value).sort(compareStrings);
  const fields = new Map<string, CompiledFieldSchema>();
  const manifestFields: Record<string, FieldSchema> = {};
  const errorStart = errors.length;

  for (let index = 0; index < fieldNames.length; index += 1) {
    const fieldName = fieldNames[index];

    if (fieldName === undefined) {
      continue;
    }

    if (fieldName.length === 0) {
      addError(errors, [...path, fieldName], "Expected non-empty field name.");
      continue;
    }

    const schema = parseFieldSchema(value[fieldName], [...path, fieldName], errors);

    if (schema !== undefined) {
      fields.set(fieldName, schema.compiled);
      Object.defineProperty(manifestFields, fieldName, {
        configurable: true,
        enumerable: true,
        value: schema.manifest,
        writable: true,
      });
    }
  }

  if (errors.length > errorStart) {
    return undefined;
  }

  return {
    compiled: fields,
    fieldNames: Object.freeze(Array.from(fields.keys()).sort(compareStrings)),
    manifest: Object.freeze(manifestFields),
  };
}

function parseFieldSchema(
  value: PlainJson | undefined,
  path: Path,
  errors: CapabilityRejection[],
): ParsedFieldSchema | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected field schema object.");
    return undefined;
  }

  const schemaType = readRequiredString(value, "type", [...path, "type"], errors);
  const required = readRequiredBoolean(value, "required", [...path, "required"], errors);

  if (schemaType === undefined || required === undefined) {
    return undefined;
  }

  switch (schemaType) {
    case "string":
      return parseStringFieldSchema(value, required, path, errors);
    case "integer":
      return parseIntegerFieldSchema(value, required, path, errors);
    case "boolean":
      return parseBooleanFieldSchema(value, required, path, errors);
    case "array":
      return parseArrayFieldSchema(value, required, path, errors);
    case "object":
      return parseObjectFieldSchema(value, required, path, errors);
    default:
      addError(errors, [...path, "type"], "Unknown field schema type.");
      return undefined;
  }
}

function parseStringFieldSchema(
  value: JsonRecord,
  required: boolean,
  path: Path,
  errors: CapabilityRejection[],
): ParsedFieldSchema | undefined {
  const errorStart = errors.length;
  rejectUnknownFields(value, STRING_SCHEMA_FIELDS, path, errors);

  const format = readOptionalStringFormat(value, "format", [...path, "format"], errors);
  const maxLength = readOptionalSafeInteger(
    value,
    "maxLength",
    [...path, "maxLength"],
    0,
    Number.MAX_SAFE_INTEGER,
    errors,
  );
  const maxBytes = readOptionalSafeInteger(
    value,
    "maxBytes",
    [...path, "maxBytes"],
    0,
    Number.MAX_SAFE_INTEGER,
    errors,
  );
  const minLength = readOptionalSafeInteger(
    value,
    "minLength",
    [...path, "minLength"],
    0,
    Number.MAX_SAFE_INTEGER,
    errors,
  );
  const enumValues = readOptionalStringEnum(value, "enum", [...path, "enum"], errors);
  const notInEnumValues = readOptionalStringEnum(value, "notInEnum", [...path, "notInEnum"], errors);
  const lowercaseValue = readOptionalBoolean(value, "lowercase", [...path, "lowercase"], errors);
  const noControlCharsValue = readOptionalBoolean(
    value,
    "noControlChars",
    [...path, "noControlChars"],
    errors,
  );
  const noInlineCapsuleMaterialValue = readOptionalBoolean(
    value,
    "noInlineCapsuleMaterial",
    [...path, "noInlineCapsuleMaterial"],
    errors,
  );
  const noInlineIdentityMaterialValue = readOptionalBoolean(
    value,
    "noInlineIdentityMaterial",
    [...path, "noInlineIdentityMaterial"],
    errors,
  );
  const noInlineMaterialValue = readOptionalBoolean(
    value,
    "noInlineMaterial",
    [...path, "noInlineMaterial"],
    errors,
  );
  const noInlineSecretsValue = readOptionalBoolean(
    value,
    "noInlineSecrets",
    [...path, "noInlineSecrets"],
    errors,
  );
  const nonEmptyValue = readOptionalBoolean(value, "nonEmpty", [...path, "nonEmpty"], errors);
  const trimmedValue = readOptionalBoolean(value, "trimmed", [...path, "trimmed"], errors);
  const forbiddenSchemePrefixValue = readOptionalBoolean(
    value,
    "forbiddenSchemePrefix",
    [...path, "forbiddenSchemePrefix"],
    errors,
  );
  const lowercase = lowercaseValue ?? false;
  const noControlChars = noControlCharsValue ?? false;
  const noInlineCapsuleMaterial = noInlineCapsuleMaterialValue ?? false;
  const noInlineIdentityMaterial = noInlineIdentityMaterialValue ?? false;
  const noInlineMaterial = (noInlineMaterialValue ?? false) || (noInlineSecretsValue ?? false);
  const forbiddenSchemePrefix = forbiddenSchemePrefixValue ?? false;
  const trimmed = trimmedValue ?? false;
  const effectiveMinLength = nonEmptyValue === true && (minLength === undefined || minLength < 1) ? 1 : minLength;

  if (errors.length > errorStart) {
    return undefined;
  }

  const compiled: CompiledStringFieldSchema = {
    lowercase,
    noControlChars,
    noInlineCapsuleMaterial,
    noInlineIdentityMaterial,
    noInlineMaterial,
    forbiddenSchemePrefix,
    required,
    trimmed,
    type: "string",
  };
  const manifest: {
    type: "string";
    required: boolean;
    maxLength?: number;
    maxBytes?: number;
    minLength?: number;
    enum?: readonly string[];
    notInEnum?: readonly string[];
    lowercase?: boolean;
    noControlChars?: boolean;
    noInlineCapsuleMaterial?: boolean;
    noInlineIdentityMaterial?: boolean;
    noInlineMaterial?: boolean;
    noInlineSecrets?: boolean;
    nonEmpty?: boolean;
    trimmed?: boolean;
    forbiddenSchemePrefix?: boolean;
    format?: StringFieldFormat;
  } = {
    required,
    type: "string",
  };

  if (format !== undefined) {
    compiled.format = format;
    manifest.format = format;
  }
  if (maxLength !== undefined) {
    compiled.maxLength = maxLength;
    manifest.maxLength = maxLength;
  }
  if (maxBytes !== undefined) {
    compiled.maxBytes = maxBytes;
    manifest.maxBytes = maxBytes;
  }
  if (effectiveMinLength !== undefined) {
    compiled.minLength = effectiveMinLength;
  }
  if (minLength !== undefined) {
    manifest.minLength = minLength;
  }
  if (enumValues !== undefined) {
    compiled.enumValues = new Set(enumValues);
    manifest.enum = Object.freeze([...enumValues]);
  }
  if (notInEnumValues !== undefined) {
    compiled.notInEnumValues = new Set(notInEnumValues);
    manifest.notInEnum = Object.freeze([...notInEnumValues]);
  }
  if (lowercaseValue !== undefined) {
    manifest.lowercase = lowercaseValue;
  }
  if (noControlCharsValue !== undefined) {
    manifest.noControlChars = noControlCharsValue;
  }
  if (noInlineCapsuleMaterialValue !== undefined) {
    manifest.noInlineCapsuleMaterial = noInlineCapsuleMaterialValue;
  }
  if (noInlineIdentityMaterialValue !== undefined) {
    manifest.noInlineIdentityMaterial = noInlineIdentityMaterialValue;
  }
  if (noInlineMaterialValue !== undefined) {
    manifest.noInlineMaterial = noInlineMaterialValue;
  }
  if (noInlineSecretsValue !== undefined) {
    manifest.noInlineSecrets = noInlineSecretsValue;
  }
  if (nonEmptyValue !== undefined) {
    manifest.nonEmpty = nonEmptyValue;
  }
  if (trimmedValue !== undefined) {
    manifest.trimmed = trimmedValue;
  }
  if (forbiddenSchemePrefixValue !== undefined) {
    manifest.forbiddenSchemePrefix = forbiddenSchemePrefixValue;
  }

  return {
    compiled,
    manifest: Object.freeze(manifest),
  };
}

function parseIntegerFieldSchema(
  value: JsonRecord,
  required: boolean,
  path: Path,
  errors: CapabilityRejection[],
): ParsedFieldSchema | undefined {
  const errorStart = errors.length;
  rejectUnknownFields(value, INTEGER_SCHEMA_FIELDS, path, errors);

  const minimum = readOptionalSafeInteger(
    value,
    "minimum",
    [...path, "minimum"],
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
    errors,
  );
  const maximum = readOptionalSafeInteger(
    value,
    "maximum",
    [...path, "maximum"],
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
    errors,
  );
  const sentinelValues = readOptionalSafeIntegerArray(
    value,
    "sentinelValues",
    [...path, "sentinelValues"],
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
    errors,
  );

  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    addError(errors, path, "minimum must be less than or equal to maximum.");
  }

  if (errors.length > errorStart) {
    return undefined;
  }

  const compiled: CompiledIntegerFieldSchema = {
    required,
    type: "integer",
  };
  const manifest: {
    type: "integer";
    required: boolean;
    minimum?: number;
    maximum?: number;
    sentinelValues?: readonly number[];
  } = {
    required,
    type: "integer",
  };

  if (minimum !== undefined) {
    compiled.minimum = minimum;
    manifest.minimum = minimum;
  }
  if (maximum !== undefined) {
    compiled.maximum = maximum;
    manifest.maximum = maximum;
  }
  if (sentinelValues !== undefined) {
    compiled.sentinelValues = new Set(sentinelValues);
    manifest.sentinelValues = sentinelValues;
  }

  return {
    compiled,
    manifest: Object.freeze(manifest),
  };
}

function parseBooleanFieldSchema(
  value: JsonRecord,
  required: boolean,
  path: Path,
  errors: CapabilityRejection[],
): ParsedFieldSchema | undefined {
  const errorStart = errors.length;
  rejectUnknownFields(value, BOOLEAN_SCHEMA_FIELDS, path, errors);

  if (errors.length > errorStart) {
    return undefined;
  }

  const schema = Object.freeze({
    required,
    type: "boolean",
  } satisfies BooleanFieldSchema);

  return {
    compiled: schema,
    manifest: schema,
  };
}

function parseArrayFieldSchema(
  value: JsonRecord,
  required: boolean,
  path: Path,
  errors: CapabilityRejection[],
): ParsedFieldSchema | undefined {
  const errorStart = errors.length;
  rejectUnknownFields(value, ARRAY_SCHEMA_FIELDS, path, errors);

  const itemValue = readRequiredProperty(value, "items", [...path, "items"], errors);
  const items =
    itemValue === undefined ? undefined : parseFieldSchema(itemValue, [...path, "items"], errors);
  const minItems = readOptionalSafeInteger(
    value,
    "minItems",
    [...path, "minItems"],
    0,
    Number.MAX_SAFE_INTEGER,
    errors,
  );
  const maxItems = readOptionalSafeInteger(
    value,
    "maxItems",
    [...path, "maxItems"],
    0,
    Number.MAX_SAFE_INTEGER,
    errors,
  );
  const uniqueItemsValue = readOptionalBoolean(value, "uniqueItems", [...path, "uniqueItems"], errors);
  const uniqueItems = uniqueItemsValue ?? false;
  const dedupItemsValue = readOptionalBoolean(value, "dedupItems", [...path, "dedupItems"], errors);
  const dedupItems = dedupItemsValue ?? false;
  const uniqueBy = readOptionalUniqueBy(value, "uniqueBy", [...path, "uniqueBy"], errors);

  if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
    addError(errors, path, "minItems must be less than or equal to maxItems.");
  }

  if (uniqueBy !== undefined && items !== undefined) {
    validateUniqueByFields(items.compiled, uniqueBy, [...path, "uniqueBy"], errors);
  }

  if (errors.length > errorStart || items === undefined) {
    return undefined;
  }

  const compiled: CompiledArrayFieldSchema = {
    items: items.compiled,
    required,
    type: "array",
    dedupItems,
    uniqueItems,
  };
  const manifest: {
    type: "array";
    required: boolean;
    items: FieldSchema;
    minItems?: number;
    maxItems?: number;
    dedupItems?: boolean;
    uniqueItems?: boolean;
    uniqueBy?: readonly string[];
  } = {
    items: items.manifest,
    required,
    type: "array",
  };

  if (minItems !== undefined) {
    compiled.minItems = minItems;
    manifest.minItems = minItems;
  }
  if (maxItems !== undefined) {
    compiled.maxItems = maxItems;
    manifest.maxItems = maxItems;
  }
  if (uniqueItemsValue !== undefined) {
    manifest.uniqueItems = uniqueItemsValue;
  }
  if (dedupItemsValue !== undefined) {
    manifest.dedupItems = dedupItemsValue;
  }
  if (uniqueBy !== undefined) {
    compiled.uniqueBy = uniqueBy;
    manifest.uniqueBy = uniqueBy;
  }

  return {
    compiled,
    manifest: Object.freeze(manifest),
  };
}

function validateUniqueByFields(
  items: CompiledFieldSchema,
  uniqueBy: readonly string[],
  path: Path,
  errors: CapabilityRejection[],
): void {
  if (items.type !== "object") {
    addError(errors, path, "uniqueBy requires object array items.");
    return;
  }

  for (let index = 0; index < uniqueBy.length; index += 1) {
    const fieldName = uniqueBy[index];

    if (fieldName === undefined) {
      continue;
    }

    const field = items.fields.get(fieldName);

    if (field === undefined) {
      addError(errors, [...path, String(index)], "uniqueBy field must reference an item object field.");
      continue;
    }

    if (!field.required) {
      addError(errors, [...path, String(index)], "uniqueBy field must reference a required item field.");
    }
  }
}

function parseObjectFieldSchema(
  value: JsonRecord,
  required: boolean,
  path: Path,
  errors: CapabilityRejection[],
): ParsedFieldSchema | undefined {
  const errorStart = errors.length;
  rejectUnknownFields(value, OBJECT_SCHEMA_FIELDS, path, errors);

  const fieldsValue = readRequiredProperty(value, "fields", [...path, "fields"], errors);
  const fields =
    fieldsValue === undefined
      ? undefined
      : parseManifestFields(fieldsValue, [...path, "fields"], errors);
  const crossFieldRulesValue = hasOwn(value, "crossFieldRules") ? value.crossFieldRules : undefined;
  const crossFieldRules =
    crossFieldRulesValue === undefined
      ? Object.freeze([])
      : parseCrossFieldRules(
          crossFieldRulesValue,
          [...path, "crossFieldRules"],
          fields?.compiled,
          errors,
        );

  if (errors.length > errorStart || fields === undefined || crossFieldRules === undefined) {
    return undefined;
  }

  const compiled: CompiledObjectFieldSchema = {
    crossFieldRules,
    fieldNames: fields.fieldNames,
    fields: fields.compiled,
    required,
    type: "object",
  };
  const manifest = Object.freeze(
    crossFieldRulesValue === undefined
      ? {
          fields: fields.manifest,
          required,
          type: "object",
        }
      : {
          crossFieldRules,
          fields: fields.manifest,
          required,
          type: "object",
        },
  ) satisfies ObjectFieldSchema;

  return {
    compiled,
    manifest,
  };
}

function parseCrossFieldRules(
  value: PlainJson,
  path: Path,
  fields: ReadonlyMap<string, CompiledFieldSchema> | undefined,
  errors: CapabilityRejection[],
): readonly CrossFieldRule[] | undefined {
  if (!Array.isArray(value)) {
    addError(errors, path, "Expected cross-field rules array.");
    return undefined;
  }

  const rules: CrossFieldRule[] = [];
  const errorStart = errors.length;

  for (let index = 0; index < value.length; index += 1) {
    const rule = parseCrossFieldRule(value[index], [...path, String(index)], fields, errors);

    if (rule !== undefined) {
      rules.push(rule);
    }
  }

  if (errors.length > errorStart) {
    return undefined;
  }

  return Object.freeze(rules);
}

function parseCrossFieldRule(
  value: PlainJson | undefined,
  path: Path,
  fields: ReadonlyMap<string, CompiledFieldSchema> | undefined,
  errors: CapabilityRejection[],
): CrossFieldRule | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected cross-field rule object.");
    return undefined;
  }

  const errorStart = errors.length;
  rejectUnknownFields(value, CROSS_FIELD_RULE_FIELDS, path, errors);

  const typeValue = readRequiredString(value, "type", [...path, "type"], errors);
  const control = readRequiredString(value, "control", [...path, "control"], errors);
  const target = readRequiredString(value, "target", [...path, "target"], errors);
  const integer = readOptionalString(value, "integer", [...path, "integer"], errors);
  const sentinel = readOptionalSafeInteger(
    value,
    "sentinel",
    [...path, "sentinel"],
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
    errors,
  );

  if (errors.length > errorStart || typeValue === undefined || control === undefined || target === undefined) {
    return undefined;
  }

  switch (typeValue) {
    case "requireNonEmptyArrayWhenTrue": {
      if (integer !== undefined) {
        addError(errors, [...path, "integer"], "integer is not supported by this cross-field rule.");
      }
      if (sentinel !== undefined) {
        addError(errors, [...path, "sentinel"], "sentinel is not supported by this cross-field rule.");
      }
      validateBooleanControlField(fields, control, [...path, "control"], errors);
      validateArrayTargetField(fields, target, [...path, "target"], errors);
      if (errors.length > errorStart) {
        return undefined;
      }
      return Object.freeze({
        control,
        target,
        type: "requireNonEmptyArrayWhenTrue",
      });
    }
    case "requireEmptyArrayWhenFalse": {
      if (integer !== undefined) {
        addError(errors, [...path, "integer"], "integer is not supported by this cross-field rule.");
      }
      if (sentinel !== undefined) {
        addError(errors, [...path, "sentinel"], "sentinel is not supported by this cross-field rule.");
      }
      validateBooleanControlField(fields, control, [...path, "control"], errors);
      validateArrayTargetField(fields, target, [...path, "target"], errors);
      if (errors.length > errorStart) {
        return undefined;
      }
      return Object.freeze({
        control,
        target,
        type: "requireEmptyArrayWhenFalse",
      });
    }
    case "forbidIntegerSentinelAndCidrCoversAllUnlessTrue": {
      if (integer === undefined) {
        addError(errors, [...path, "integer"], "integer field is required for this cross-field rule.");
      }
      if (sentinel === undefined) {
        addError(errors, [...path, "sentinel"], "sentinel is required for this cross-field rule.");
      }
      validateBooleanControlField(fields, control, [...path, "control"], errors);
      validateIntegerRuleField(fields, integer, [...path, "integer"], errors);
      validateCIDRTargetField(fields, target, [...path, "target"], errors);
      if (errors.length > errorStart || integer === undefined || sentinel === undefined) {
        return undefined;
      }
      return Object.freeze({
        control,
        integer,
        sentinel,
        target,
        type: "forbidIntegerSentinelAndCidrCoversAllUnlessTrue",
      });
    }
    default:
      addError(errors, [...path, "type"], "Unknown cross-field rule type.");
      return undefined;
  }
}

function validateBooleanControlField(
  fields: ReadonlyMap<string, CompiledFieldSchema> | undefined,
  control: string,
  path: Path,
  errors: CapabilityRejection[],
): void {
  if (fields === undefined) {
    return;
  }

  const controlField = fields.get(control);

  if (controlField === undefined || controlField.type !== "boolean") {
    addError(errors, path, "Control field must reference a boolean field.");
  }
}

function validateArrayTargetField(
  fields: ReadonlyMap<string, CompiledFieldSchema> | undefined,
  target: string,
  path: Path,
  errors: CapabilityRejection[],
): void {
  if (fields === undefined) {
    return;
  }

  const targetField = fields.get(target);

  if (targetField === undefined || targetField.type !== "array") {
    addError(errors, path, "Target field must reference an array field.");
  }
}

function validateIntegerRuleField(
  fields: ReadonlyMap<string, CompiledFieldSchema> | undefined,
  integer: string | undefined,
  path: Path,
  errors: CapabilityRejection[],
): void {
  if (integer === undefined || fields === undefined) {
    return;
  }

  const integerField = fields.get(integer);

  if (integerField === undefined || integerField.type !== "integer") {
    addError(errors, path, "integer must reference an integer field.");
  }
}

function validateCIDRTargetField(
  fields: ReadonlyMap<string, CompiledFieldSchema> | undefined,
  target: string,
  path: Path,
  errors: CapabilityRejection[],
): void {
  if (fields === undefined) {
    return;
  }

  const targetField = fields.get(target);

  if (targetField === undefined || targetField.type !== "string" || targetField.format !== "cidrLiteral") {
    addError(errors, path, "Target field must reference a cidrLiteral string field.");
  }
}

function parseRawCapabilityRequest(raw: string): RawCapabilityRequestParseResult {
  const scanner: RawJsonScanner = {
    duplicateKey: false,
    index: 0,
    rawNumberTokens: new Map<string, string>(),
    rawStringTokens: new Map<string, string>(),
    text: raw,
  };

  const value = scanRawJsonValue(scanner, []);

  if (value === INVALID_RAW_JSON) {
    return rejectRawCapabilityRequest("malformed JSON");
  }

  skipRawJsonWhitespace(scanner);

  if (scanner.index !== scanner.text.length) {
    return rejectRawCapabilityRequest("trailing data");
  }

  if (scanner.duplicateKey) {
    return rejectRawCapabilityRequest("duplicate object key");
  }

  return {
    ok: true,
    rawNumberTokens: new Map(scanner.rawNumberTokens),
    rawStringTokens: new Map(scanner.rawStringTokens),
    value,
  };
}

function scanRawJsonValue(scanner: RawJsonScanner, path: Path): RawJsonValue {
  skipRawJsonWhitespace(scanner);

  const char = peekRawJson(scanner);

  if (char === "{") {
    return scanRawJsonObject(scanner, path);
  }
  if (char === "[") {
    return scanRawJsonArray(scanner, path);
  }
  if (char === "\"") {
    const token = consumeRawJsonString(scanner);

    if (token === undefined) {
      return INVALID_RAW_JSON;
    }

    scanner.rawStringTokens.set(formatPath(path), token.rawToken);
    return token.value;
  }
  if (char === "t") {
    return consumeRawJsonLiteral(scanner, "true") ? true : INVALID_RAW_JSON;
  }
  if (char === "f") {
    return consumeRawJsonLiteral(scanner, "false") ? false : INVALID_RAW_JSON;
  }
  if (char === "n") {
    return consumeRawJsonLiteral(scanner, "null") ? null : INVALID_RAW_JSON;
  }

  return scanRawJsonNumber(scanner, path);
}

function scanRawJsonObject(scanner: RawJsonScanner, path: Path): RawJsonValue {
  if (!consumeRawJsonChar(scanner, "{")) {
    return INVALID_RAW_JSON;
  }

  skipRawJsonWhitespace(scanner);

  const output: Record<string, PlainJson> = {};
  const seen = new Set<string>();

  if (consumeRawJsonChar(scanner, "}")) {
    return Object.freeze(output);
  }

  for (;;) {
    skipRawJsonWhitespace(scanner);

    const key = consumeRawJsonString(scanner);

    if (key === undefined) {
      return INVALID_RAW_JSON;
    }

    if (seen.has(key.value)) {
      scanner.duplicateKey = true;
    } else {
      seen.add(key.value);
    }

    skipRawJsonWhitespace(scanner);

    if (!consumeRawJsonChar(scanner, ":")) {
      return INVALID_RAW_JSON;
    }

    const child = scanRawJsonValue(scanner, [...path, key.value]);

    if (child === INVALID_RAW_JSON) {
      return INVALID_RAW_JSON;
    }

    Object.defineProperty(output, key.value, {
      configurable: true,
      enumerable: true,
      value: child,
      writable: true,
    });

    skipRawJsonWhitespace(scanner);

    if (consumeRawJsonChar(scanner, "}")) {
      return Object.freeze(output);
    }

    if (!consumeRawJsonChar(scanner, ",")) {
      return INVALID_RAW_JSON;
    }
  }
}

function scanRawJsonArray(scanner: RawJsonScanner, path: Path): RawJsonValue {
  if (!consumeRawJsonChar(scanner, "[")) {
    return INVALID_RAW_JSON;
  }

  skipRawJsonWhitespace(scanner);

  const output: PlainJson[] = [];

  if (consumeRawJsonChar(scanner, "]")) {
    return Object.freeze(output);
  }

  for (;;) {
    const child = scanRawJsonValue(scanner, [...path, String(output.length)]);

    if (child === INVALID_RAW_JSON) {
      return INVALID_RAW_JSON;
    }

    output.push(child);
    skipRawJsonWhitespace(scanner);

    if (consumeRawJsonChar(scanner, "]")) {
      return Object.freeze(output);
    }

    if (!consumeRawJsonChar(scanner, ",")) {
      return INVALID_RAW_JSON;
    }
  }
}

function consumeRawJsonString(scanner: RawJsonScanner): RawJsonStringToken | undefined {
  if (!consumeRawJsonChar(scanner, "\"")) {
    return undefined;
  }

  const tokenStart = scanner.index - 1;
  const rawStart = scanner.index;
  let escaped = false;

  while (scanner.index < scanner.text.length) {
    const char = scanner.text.charAt(scanner.index);

    if (escaped) {
      escaped = false;
      scanner.index += 1;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      scanner.index += 1;
      continue;
    }

    if (char === "\"") {
      const rawToken = scanner.text.slice(rawStart, scanner.index);
      scanner.index += 1;

      try {
        const parsed = JSON.parse(scanner.text.slice(tokenStart, scanner.index)) as unknown;

        if (typeof parsed !== "string") {
          return undefined;
        }

        return {
          rawToken,
          value: parsed,
        };
      } catch {
        return undefined;
      }
    }

    scanner.index += 1;
  }

  return undefined;
}

function scanRawJsonNumber(scanner: RawJsonScanner, path: Path): RawJsonValue {
  const start = scanner.index;

  while (scanner.index < scanner.text.length) {
    const char = scanner.text.charAt(scanner.index);

    if (
      char !== "-" &&
      char !== "+" &&
      char !== "." &&
      char !== "e" &&
      char !== "E" &&
      !isAsciiDigitCode(char.charCodeAt(0))
    ) {
      break;
    }

    scanner.index += 1;
  }

  if (scanner.index === start) {
    return INVALID_RAW_JSON;
  }

  try {
    const parsed = JSON.parse(scanner.text.slice(start, scanner.index)) as unknown;

    if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
      return INVALID_RAW_JSON;
    }

    scanner.rawNumberTokens.set(formatPath(path), scanner.text.slice(start, scanner.index));
    return parsed;
  } catch {
    return INVALID_RAW_JSON;
  }
}

function consumeRawJsonLiteral(scanner: RawJsonScanner, literal: string): boolean {
  if (!scanner.text.startsWith(literal, scanner.index)) {
    return false;
  }

  scanner.index += literal.length;
  return true;
}

function consumeRawJsonChar(scanner: RawJsonScanner, char: string): boolean {
  if (peekRawJson(scanner) !== char) {
    return false;
  }

  scanner.index += 1;
  return true;
}

function skipRawJsonWhitespace(scanner: RawJsonScanner): void {
  while (scanner.index < scanner.text.length) {
    const char = scanner.text.charAt(scanner.index);

    if (char !== " " && char !== "\n" && char !== "\r" && char !== "\t") {
      return;
    }

    scanner.index += 1;
  }
}

function peekRawJson(scanner: RawJsonScanner): string | undefined {
  return scanner.text.at(scanner.index);
}

function rejectRawCapabilityRequest(
  reason: string,
): Extract<RawCapabilityRequestParseResult, { readonly ok: false }> {
  return {
    ok: false,
    reason,
  };
}

function validateInput(
  value: PlainJson,
  manifest: CompiledManifest,
  rawStringTokens: ReadonlyMap<string, string> | undefined,
  rawNumberTokens: ReadonlyMap<string, string> | undefined,
):
  | {
      readonly ok: true;
      readonly value: CapabilityRecord;
    }
  | {
      readonly ok: false;
      readonly rejections: readonly CapabilityRejection[];
    } {
  if (!isRecord(value)) {
    return reject([{ message: "Expected capability input object.", path: "" }]);
  }

  const errors: CapabilityRejection[] = [];
  const output: Record<string, CapabilityValue> = {};

  rejectUnknownFields(value, new Set(manifest.fieldNames), [], errors);

  for (let index = 0; index < manifest.fieldNames.length; index += 1) {
    const fieldName = manifest.fieldNames[index];

    if (fieldName === undefined) {
      continue;
    }

    const schema = manifest.fields.get(fieldName);

    if (schema === undefined) {
      addError(errors, [fieldName], "Unknown manifest field.");
      continue;
    }

    if (!hasOwn(value, fieldName)) {
      if (schema.required) {
        addError(errors, [fieldName], "Required field is missing.");
      }
      continue;
    }

    const result = validateField(
      value[fieldName],
      schema,
      [fieldName],
      errors,
      rawStringTokens,
      rawNumberTokens,
    );

    if (result.ok) {
      Object.defineProperty(output, fieldName, {
        configurable: true,
        enumerable: true,
        value: result.value,
        writable: true,
      });
    }
  }

  if (errors.length > 0) {
    return reject(errors);
  }

  applyCrossFieldRules(output, manifest.crossFieldRules, [], errors);

  if (errors.length > 0) {
    return reject(errors);
  }

  return {
    ok: true,
    value: Object.freeze(output),
  };
}

function validateField(
  value: PlainJson | undefined,
  schema: CompiledFieldSchema,
  path: Path,
  errors: CapabilityRejection[],
  rawStringTokens: ReadonlyMap<string, string> | undefined,
  rawNumberTokens: ReadonlyMap<string, string> | undefined,
): FieldValidationResult {
  if (value === undefined) {
    addError(errors, path, "Required field is missing.");
    return { ok: false };
  }

  switch (schema.type) {
    case "string":
      return validateStringField(value, schema, path, errors, rawStringTokens);
    case "integer":
      return validateIntegerField(value, schema, path, errors, rawNumberTokens);
    case "boolean":
      return validateBooleanField(value, path, errors);
    case "array":
      return validateArrayField(value, schema, path, errors, rawStringTokens, rawNumberTokens);
    case "object":
      return validateObjectField(value, schema, path, errors, rawStringTokens, rawNumberTokens);
  }
}

function validateStringField(
  value: PlainJson,
  schema: CompiledStringFieldSchema,
  path: Path,
  errors: CapabilityRejection[],
  rawStringTokens: ReadonlyMap<string, string> | undefined,
): FieldValidationResult {
  if (typeof value !== "string") {
    addError(errors, path, "Expected string.");
    return { ok: false };
  }

  const errorStart = errors.length;

  if (schema.noInlineMaterial && containsInlineServiceMaterial(value)) {
    addError(errors, path, "Inline material is not allowed.");
  }

  if (schema.noInlineCapsuleMaterial && containsInlineCapsuleMaterial(value)) {
    addError(errors, path, "Inline capsule material is not allowed.");
  }

  if (schema.noInlineIdentityMaterial && containsInlineIdentityMaterial(value)) {
    addError(errors, path, "Inline identity material is not allowed.");
  }

  if (schema.forbiddenSchemePrefix && hasInlineReferenceScheme(value)) {
    addError(errors, path, "Forbidden scheme prefix is not allowed.");
  }

  if (schema.noControlChars && containsControlCharacter(value)) {
    addError(errors, path, "Control characters are not allowed.");
  }

  if (schema.trimmed && goTrimSpace(value) !== value) {
    addError(errors, path, "String must be trimmed.");
  }

  let normalized = value;

  if (schema.format !== undefined) {
    const formatted = normalizeStringFormat(value, schema.format, rawStringTokens?.get(formatPath(path)));

    if (formatted === undefined) {
      addError(errors, path, "String does not match required format.");
    } else {
      normalized = formatted;
    }
  }

  if (schema.lowercase) {
    normalized = asciiLowercase(normalized);
  }

  if (schema.maxLength !== undefined && normalized.length > schema.maxLength) {
    addError(errors, path, "String exceeds maxLength.");
  }

  if (schema.maxBytes !== undefined && utf8ByteLength(normalized) > schema.maxBytes) {
    addError(errors, path, "String exceeds maxBytes.");
  }

  if (schema.minLength !== undefined && utf8ByteLength(normalized) < schema.minLength) {
    addError(errors, path, "String is shorter than minLength.");
  }

  if (schema.enumValues !== undefined && !schema.enumValues.has(normalized)) {
    addError(errors, path, "String is not in the allowed enum.");
  }

  if (schema.notInEnumValues !== undefined && schema.notInEnumValues.has(normalized)) {
    addError(errors, path, "String is in the blocked enum.");
  }

  if (errors.length > errorStart) {
    return { ok: false };
  }

  return {
    ok: true,
    value: normalized,
  };
}

function validateIntegerField(
  value: PlainJson,
  schema: CompiledIntegerFieldSchema,
  path: Path,
  errors: CapabilityRejection[],
  rawNumberTokens: ReadonlyMap<string, string> | undefined,
): FieldValidationResult {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    addError(errors, path, "Expected safe integer.");
    return { ok: false };
  }

  const errorStart = errors.length;
  const rawToken = rawNumberTokens?.get(formatPath(path));

  if (rawToken !== undefined && !isRawIntegerLiteral(rawToken)) {
    addError(errors, path, "Expected integer JSON literal.");
  }

  const isSentinel = schema.sentinelValues?.has(value) ?? false;

  if (!isSentinel) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      addError(errors, path, "Integer is below minimum.");
    }

    if (schema.maximum !== undefined && value > schema.maximum) {
      addError(errors, path, "Integer is above maximum.");
    }
  }

  if (errors.length > errorStart) {
    return { ok: false };
  }

  return {
    ok: true,
    value,
  };
}

function validateBooleanField(
  value: PlainJson,
  path: Path,
  errors: CapabilityRejection[],
): FieldValidationResult {
  if (typeof value !== "boolean") {
    addError(errors, path, "Expected boolean.");
    return { ok: false };
  }

  return {
    ok: true,
    value,
  };
}

function validateArrayField(
  value: PlainJson,
  schema: CompiledArrayFieldSchema,
  path: Path,
  errors: CapabilityRejection[],
  rawStringTokens: ReadonlyMap<string, string> | undefined,
  rawNumberTokens: ReadonlyMap<string, string> | undefined,
): FieldValidationResult {
  if (!Array.isArray(value)) {
    addError(errors, path, "Expected array.");
    return { ok: false };
  }

  const errorStart = errors.length;

  if (schema.minItems !== undefined && value.length < schema.minItems) {
    addError(errors, path, "Array contains fewer than minItems.");
  }

  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    addError(errors, path, "Array contains more than maxItems.");
  }

  const output: CapabilityValue[] = [];
  const seenItems = new Map<string, number>();
  const seenDedupItems = new Map<string, number>();
  const seenUniqueBy = new Map<string, number>();

  for (let index = 0; index < value.length; index += 1) {
    const itemPath = [...path, String(index)];
    const result = validateField(value[index], schema.items, itemPath, errors, rawStringTokens, rawNumberTokens);

    if (!result.ok) {
      continue;
    }

    if (schema.uniqueItems) {
      const key = uniqueValueKey(result.value);
      const previousIndex = seenItems.get(key);

      if (previousIndex !== undefined) {
        addError(
          errors,
          itemPath,
          `Duplicate array item also appears at ${formatPath([...path, String(previousIndex)])}.`,
        );
      } else {
        seenItems.set(key, index);
      }
    }

    if (schema.dedupItems) {
      const key = uniqueValueKey(result.value);

      if (seenDedupItems.has(key)) {
        continue;
      }

      seenDedupItems.set(key, index);
    }

    if (schema.uniqueBy !== undefined) {
      const keys = uniqueByValueKeys(result.value, schema.uniqueBy);

      if (keys === undefined) {
        addError(errors, itemPath, "uniqueBy requires object array items with all key fields present.");
      } else {
        for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
          const key = keys[keyIndex];

          if (key === undefined) {
            continue;
          }

          const previousIndex = seenUniqueBy.get(key);

          if (previousIndex !== undefined) {
            addError(
              errors,
              itemPath,
              `Duplicate array item key also appears at ${formatPath([...path, String(previousIndex)])}.`,
            );
          } else {
            seenUniqueBy.set(key, index);
          }
        }
      }
    }

    output.push(result.value);
  }

  if (errors.length > errorStart) {
    return { ok: false };
  }

  return {
    ok: true,
    value: Object.freeze(output),
  };
}

function validateObjectField(
  value: PlainJson,
  schema: CompiledObjectFieldSchema,
  path: Path,
  errors: CapabilityRejection[],
  rawStringTokens: ReadonlyMap<string, string> | undefined,
  rawNumberTokens: ReadonlyMap<string, string> | undefined,
): FieldValidationResult {
  if (!isRecord(value)) {
    addError(errors, path, "Expected object.");
    return { ok: false };
  }

  const errorStart = errors.length;
  const output: Record<string, CapabilityValue> = {};

  rejectUnknownFields(value, new Set(schema.fieldNames), path, errors);

  for (let index = 0; index < schema.fieldNames.length; index += 1) {
    const fieldName = schema.fieldNames[index];

    if (fieldName === undefined) {
      continue;
    }

    const field = schema.fields.get(fieldName);

    if (field === undefined) {
      addError(errors, [...path, fieldName], "Unknown manifest field.");
      continue;
    }

    if (!hasOwn(value, fieldName)) {
      if (field.required) {
        addError(errors, [...path, fieldName], "Required field is missing.");
      }
      continue;
    }

    const result = validateField(
      value[fieldName],
      field,
      [...path, fieldName],
      errors,
      rawStringTokens,
      rawNumberTokens,
    );

    if (result.ok) {
      Object.defineProperty(output, fieldName, {
        configurable: true,
        enumerable: true,
        value: result.value,
        writable: true,
      });
    }
  }

  if (errors.length > errorStart) {
    return { ok: false };
  }

  applyCrossFieldRules(output, schema.crossFieldRules, path, errors);

  if (errors.length > errorStart) {
    return { ok: false };
  }

  return {
    ok: true,
    value: Object.freeze(output),
  };
}

function applyCrossFieldRules(
  value: CapabilityRecord,
  rules: readonly CrossFieldRule[],
  path: Path,
  errors: CapabilityRejection[],
): void {
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];

    if (rule === undefined) {
      continue;
    }

    switch (rule.type) {
      case "requireNonEmptyArrayWhenTrue": {
        const control = value[rule.control];
        const target = value[rule.target];

        if (typeof control !== "boolean" || !Array.isArray(target)) {
          addError(errors, [...path, rule.target], "Cross-field rule references invalid fields.");
          break;
        }
        if (control && target.length === 0) {
          addError(
            errors,
            [...path, rule.target],
            `${rule.target} must be non-empty when ${rule.control} is true.`,
          );
        }
        break;
      }
      case "requireEmptyArrayWhenFalse": {
        const control = value[rule.control];
        const target = value[rule.target];

        if (typeof control !== "boolean" || !Array.isArray(target)) {
          addError(errors, [...path, rule.target], "Cross-field rule references invalid fields.");
          break;
        }
        if (!control && target.length !== 0) {
          addError(
            errors,
            [...path, rule.target],
            `${rule.target} must be empty when ${rule.control} is false.`,
          );
        }
        break;
      }
      case "forbidIntegerSentinelAndCidrCoversAllUnlessTrue": {
        const integer = value[rule.integer];
        const target = value[rule.target];
        const enabled = hasOwn(value, rule.control) ? value[rule.control] : false;

        if (typeof integer !== "number" || typeof target !== "string" || typeof enabled !== "boolean") {
          addError(errors, [...path, rule.target], "Cross-field rule references invalid fields.");
          break;
        }

        if (integer === rule.sentinel && cidrLiteralCoversAll(target) && !enabled) {
          addError(
            errors,
            [...path, rule.target],
            `${rule.integer} ${rule.sentinel} with ${rule.target} covering all sources requires ${rule.control} true.`,
          );
        }
        break;
      }
    }
  }
}

function readRequiredProperty(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: CapabilityRejection[],
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

function readRequiredString(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: CapabilityRejection[],
): string | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (typeof child !== "string") {
    addError(errors, path, "Expected string.");
    return undefined;
  }

  return child;
}

function readRequiredBoolean(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: CapabilityRejection[],
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

function readRequiredManifestVersion(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: CapabilityRejection[],
): 1 | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  return parseManifestVersion(child, path, errors);
}

function readOptionalManifestVersion(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: CapabilityRejection[],
): 1 | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }

  return parseManifestVersion(value[key], path, errors);
}

function readOptionalDefaultRegistry(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: CapabilityRejection[],
): false | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }

  if (value[key] !== false) {
    addError(errors, path, "defaultRegistry may only be false when present.");
    return undefined;
  }

  return false;
}

function parseManifestVersion(
  value: PlainJson | undefined,
  path: Path,
  errors: CapabilityRejection[],
): 1 | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    addError(errors, path, "Expected supported manifest version integer.");
    return undefined;
  }

  if (value !== SUPPORTED_MANIFEST_VERSION) {
    addError(errors, path, "Unsupported manifest version.");
    return undefined;
  }

  return SUPPORTED_MANIFEST_VERSION;
}

function readOptionalString(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: CapabilityRejection[],
): string | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }

  const child = value[key];

  if (typeof child !== "string") {
    addError(errors, path, "Expected string.");
    return undefined;
  }

  return child;
}

function readOptionalBoolean(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: CapabilityRejection[],
): boolean | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }

  const child = value[key];

  if (typeof child !== "boolean") {
    addError(errors, path, "Expected boolean.");
    return undefined;
  }

  return child;
}

function readOptionalSafeInteger(
  value: JsonRecord,
  key: string,
  path: Path,
  minimum: number,
  maximum: number,
  errors: CapabilityRejection[],
): number | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }

  const child = value[key];

  if (
    typeof child !== "number" ||
    !Number.isSafeInteger(child) ||
    child < minimum ||
    child > maximum
  ) {
    addError(errors, path, "Expected safe integer within bounds.");
    return undefined;
  }

  return child;
}

function readOptionalSafeIntegerArray(
  value: JsonRecord,
  key: string,
  path: Path,
  minimum: number,
  maximum: number,
  errors: CapabilityRejection[],
): readonly number[] | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }

  const child = value[key];

  if (!Array.isArray(child) || child.length === 0) {
    addError(errors, path, "Expected non-empty safe integer array.");
    return undefined;
  }

  const seen = new Set<number>();
  const values: number[] = [];
  const errorStart = errors.length;

  for (let index = 0; index < child.length; index += 1) {
    const item = child[index];
    const itemPath = [...path, String(index)];

    if (
      typeof item !== "number" ||
      !Number.isSafeInteger(item) ||
      item < minimum ||
      item > maximum
    ) {
      addError(errors, itemPath, "Expected safe integer within bounds.");
      continue;
    }

    if (seen.has(item)) {
      addError(errors, itemPath, "Duplicate safe integer value.");
      continue;
    }

    seen.add(item);
    values.push(item);
  }

  if (errors.length > errorStart) {
    return undefined;
  }

  return Object.freeze(values);
}

function readOptionalStringEnum(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: CapabilityRejection[],
): readonly string[] | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }

  const child = value[key];

  if (!Array.isArray(child) || child.length === 0) {
    addError(errors, path, "Expected non-empty string enum array.");
    return undefined;
  }

  const seen = new Set<string>();
  const values: string[] = [];

  for (let index = 0; index < child.length; index += 1) {
    const item = child[index];

    if (typeof item !== "string") {
      addError(errors, [...path, String(index)], "Expected string enum value.");
      continue;
    }

    if (seen.has(item)) {
      addError(errors, [...path, String(index)], "Duplicate enum value.");
      continue;
    }

    seen.add(item);
    values.push(item);
  }

  return Object.freeze(values);
}

function readOptionalUniqueBy(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: CapabilityRejection[],
): readonly string[] | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }

  const child = value[key];

  if (!Array.isArray(child) || child.length === 0) {
    addError(errors, path, "Expected non-empty uniqueBy field array.");
    return undefined;
  }

  const seen = new Set<string>();
  const values: string[] = [];

  for (let index = 0; index < child.length; index += 1) {
    const item = child[index];

    if (typeof item !== "string" || item.length === 0) {
      addError(errors, [...path, String(index)], "Expected non-empty uniqueBy field name.");
      continue;
    }

    if (seen.has(item)) {
      addError(errors, [...path, String(index)], "Duplicate uniqueBy field name.");
      continue;
    }

    seen.add(item);
    values.push(item);
  }

  return Object.freeze(values);
}

function readOptionalStringFormat(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: CapabilityRejection[],
): StringFieldFormat | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }

  const child = value[key];

  if (typeof child !== "string") {
    addError(errors, path, "Expected string format.");
    return undefined;
  }

  if (!isStringFieldFormat(child)) {
    addError(errors, path, "Unknown string format.");
    return undefined;
  }

  return child;
}

function rejectUnknownFields(
  value: JsonRecord,
  allowed: ReadonlySet<string>,
  path: Path,
  errors: CapabilityRejection[],
): void {
  const keys = Object.keys(value).sort(compareStrings);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && !allowed.has(key)) {
      addError(errors, [...path, key], "Unknown field.");
    }
  }
}

function isStringFieldFormat(value: string): value is StringFieldFormat {
  return (
    value === "hostnameRFC1123" ||
    value === "hostnameLabel" ||
    value === "ipLiteral" ||
    value === "hostnameOrIp" ||
    value === "posixUsername" ||
    value === "posixAccountName" ||
    value === "groupName" ||
    value === "systemdUnitName" ||
    value === "absolutePath" ||
    value === "rfc3339Instant" ||
    value === "capsuleId" ||
    value === "capsuleVersion" ||
    value === "sriIntegrity" ||
    value === "bundleRefString" ||
    value === "bundleVersionString" ||
    value === "didPlcOrWeb" ||
    value === "atprotoHandle" ||
    value === "keyReference" ||
    value === "cidrLiteral" ||
    value === "networkInterfaceName"
  );
}

function normalizeStringFormat(
  value: string,
  format: StringFieldFormat,
  rawToken?: string,
): string | undefined {
  switch (format) {
    case "hostnameRFC1123":
      return isHostnameRFC1123(value) ? value : undefined;
    case "hostnameLabel":
      return isHostnameLabel(value) ? value : undefined;
    case "ipLiteral":
      return canonicalizeIPLiteral(value);
    case "cidrLiteral":
      return canonicalizeCIDRLiteral(value);
    case "networkInterfaceName":
      return isNetworkInterfaceName(value) ? value : undefined;
    case "hostnameOrIp": {
      const ip = canonicalizeIPLiteral(value);

      if (ip !== undefined) {
        return ip;
      }

      return isAgentHostname(value) ? asciiLowercase(value) : undefined;
    }
    case "posixUsername":
    case "posixAccountName":
    case "groupName":
      return isPOSIXName(value) ? value : undefined;
    case "systemdUnitName":
      return isSystemdUnitName(value) ? value : undefined;
    case "absolutePath":
      return isCanonicalAbsolutePath(value) ? value : undefined;
    case "rfc3339Instant":
      return isRFC3339Instant(value, rawToken) ? value : undefined;
    case "capsuleId":
      return isCapsuleID(value) ? value : undefined;
    case "capsuleVersion":
      return isCapsuleVersion(value) ? value : undefined;
    case "sriIntegrity":
      return isValidSRI(value) ? value : undefined;
    case "bundleRefString":
      return isBundleRefString(value) ? value : undefined;
    case "bundleVersionString":
      return isBundleVersionString(value) ? value : undefined;
    case "didPlcOrWeb":
      return isSupportedDID(value) ? value : undefined;
    case "atprotoHandle":
      return isDomainHandle(value) ? value : undefined;
    case "keyReference":
      return isKeyReference(value) ? value : undefined;
  }
}

interface ParsedRFC3339Instant {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly nanosecond: number;
  readonly offsetSeconds: number;
}

interface ParsedFixedDigits {
  readonly value: number;
  readonly next: number;
}

function isRFC3339Instant(value: string, rawToken: string | undefined): boolean {
  const token = rawToken ?? value;

  if (containsChar(token, 92)) {
    return false;
  }

  const parsed = parseRFC3339InstantToken(token);

  return parsed !== undefined && !isZeroRFC3339Instant(parsed);
}

function parseRFC3339InstantToken(value: string): ParsedRFC3339Instant | undefined {
  let index = 0;

  const year = readFixedDigits(value, index, 4);

  if (year === undefined || value.charAt(year.next) !== "-") {
    return undefined;
  }

  index = year.next + 1;

  const month = readFixedDigits(value, index, 2);

  if (month === undefined || value.charAt(month.next) !== "-") {
    return undefined;
  }

  index = month.next + 1;

  const day = readFixedDigits(value, index, 2);

  if (day === undefined || value.charAt(day.next) !== "T") {
    return undefined;
  }

  index = day.next + 1;

  const hour = readFixedDigits(value, index, 2);

  if (hour === undefined || value.charAt(hour.next) !== ":") {
    return undefined;
  }

  index = hour.next + 1;

  const minute = readFixedDigits(value, index, 2);

  if (minute === undefined || value.charAt(minute.next) !== ":") {
    return undefined;
  }

  index = minute.next + 1;

  const second = readFixedDigits(value, index, 2);

  if (second === undefined) {
    return undefined;
  }

  index = second.next;

  let nanosecond = 0;
  const fractionMarker = value.charAt(index);

  if (fractionMarker === "." || fractionMarker === ",") {
    index += 1;

    const fraction = readRFC3339Fraction(value, index);

    if (fraction === undefined) {
      return undefined;
    }

    nanosecond = fraction.nanosecond;
    index = fraction.next;
  }

  const offset = readRFC3339Offset(value, index);

  if (offset === undefined || offset.next !== value.length) {
    return undefined;
  }

  if (
    month.value < 1 ||
    month.value > 12 ||
    day.value < 1 ||
    day.value > daysInMonth(year.value, month.value) ||
    hour.value > 23 ||
    minute.value > 59 ||
    second.value > 59
  ) {
    return undefined;
  }

  return {
    day: day.value,
    hour: hour.value,
    minute: minute.value,
    month: month.value,
    nanosecond,
    offsetSeconds: offset.offsetSeconds,
    second: second.value,
    year: year.value,
  };
}

function readRFC3339Fraction(
  value: string,
  start: number,
): { readonly nanosecond: number; readonly next: number } | undefined {
  let index = start;
  let digits = 0;
  let nanosecond = 0;

  while (index < value.length) {
    const code = value.charCodeAt(index);

    if (!isAsciiDigitCode(code)) {
      break;
    }

    if (digits < 9) {
      nanosecond = nanosecond * 10 + code - 48;
    }

    digits += 1;
    index += 1;
  }

  if (digits === 0) {
    return undefined;
  }

  while (digits < 9) {
    nanosecond *= 10;
    digits += 1;
  }

  return {
    nanosecond,
    next: index,
  };
}

function readRFC3339Offset(
  value: string,
  start: number,
): { readonly offsetSeconds: number; readonly next: number } | undefined {
  const marker = value.charAt(start);

  if (marker === "Z") {
    return {
      next: start + 1,
      offsetSeconds: 0,
    };
  }

  if (marker !== "+" && marker !== "-") {
    return undefined;
  }

  const hour = readFixedDigits(value, start + 1, 2);

  if (hour === undefined || value.charAt(hour.next) !== ":") {
    return undefined;
  }

  const minute = readFixedDigits(value, hour.next + 1, 2);

  if (minute === undefined || hour.value > 24 || minute.value > 60) {
    return undefined;
  }

  const sign = marker === "+" ? 1 : -1;

  return {
    next: minute.next,
    offsetSeconds: sign * ((hour.value * 60 + minute.value) * 60),
  };
}

function readFixedDigits(value: string, start: number, width: number): ParsedFixedDigits | undefined {
  let parsed = 0;

  for (let index = 0; index < width; index += 1) {
    const code = value.charCodeAt(start + index);

    if (!isAsciiDigitCode(code)) {
      return undefined;
    }

    parsed = parsed * 10 + code - 48;
  }

  return {
    next: start + width,
    value: parsed,
  };
}

function isZeroRFC3339Instant(value: ParsedRFC3339Instant): boolean {
  if (value.nanosecond !== 0) {
    return false;
  }

  const localSeconds =
    daysFromCivil(value.year, value.month, value.day) * 86_400 +
    value.hour * 3_600 +
    value.minute * 60 +
    value.second;
  const utcSeconds = localSeconds - value.offsetSeconds;
  const zeroSeconds = daysFromCivil(1, 1, 1) * 86_400;

  return utcSeconds === zeroSeconds;
}

function daysFromCivil(year: number, month: number, day: number): number {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const monthPrime = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * monthPrime + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;

  return era * 146_097 + dayOfEra;
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isCapsuleID(value: string): boolean {
  if (
    utf8ByteLength(value) > 255 ||
    goTrimSpace(value) !== value ||
    containsControlCharacter(value) ||
    containsInlineCapsuleMaterial(value) ||
    hasInlineReferenceScheme(value)
  ) {
    return false;
  }

  return isReverseDNSCapsuleID(value) || isOpaqueCapsuleID(value);
}

function isCapsuleVersion(value: string): boolean {
  if (
    utf8ByteLength(value) > 128 ||
    goTrimSpace(value) !== value ||
    containsControlCharacter(value) ||
    containsInlineCapsuleMaterial(value) ||
    hasInlineReferenceScheme(value)
  ) {
    return false;
  }

  return isCapsuleVersionPattern(value);
}

function isBundleRefString(value: string): boolean {
  if (value.length === 0 || value.length > 256 || !isAsciiAlphaNumericCode(value.charCodeAt(0))) {
    return false;
  }

  for (let index = 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (!isBundleRefCode(code)) {
      return false;
    }
  }

  return true;
}

function isBundleVersionString(value: string): boolean {
  if (value.length === 0 || value.length > 128 || !isAsciiAlphaNumericCode(value.charCodeAt(0))) {
    return false;
  }

  for (let index = 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (!isBundleVersionCode(code)) {
      return false;
    }
  }

  return true;
}

const DID_PLC_PREFIX = "did:plc:";
const DID_WEB_PREFIX = "did:web:";
const MAX_ATPROTO_HANDLE_BYTES = 253;
const MAX_DID_BYTES = 2048;
const MAX_KEY_REFERENCE_BYTES = 2048;
const INLINE_REFERENCE_SCHEMES = Object.freeze(["data", "inline", "literal"]);

function isSupportedDID(value: string): boolean {
  if (utf8ByteLength(value) > MAX_DID_BYTES || goTrimSpace(value) !== value) {
    return false;
  }

  return isDIDPlc(value) || isDIDWeb(value);
}

function isDIDPlc(value: string): boolean {
  if (!value.startsWith(DID_PLC_PREFIX)) {
    return false;
  }

  const identifier = value.slice(DID_PLC_PREFIX.length);

  if (identifier.length !== 24) {
    return false;
  }

  for (let index = 0; index < identifier.length; index += 1) {
    const code = identifier.charCodeAt(index);

    if (!isAsciiLowercaseCode(code) && (code < 50 || code > 55)) {
      return false;
    }
  }

  return true;
}

function isDIDWeb(value: string): boolean {
  if (!value.startsWith(DID_WEB_PREFIX)) {
    return false;
  }

  const identifier = value.slice(DID_WEB_PREFIX.length);

  if (
    identifier.length === 0 ||
    identifier.includes("/") ||
    identifier.includes("?") ||
    identifier.includes("#") ||
    containsControlCharacter(identifier)
  ) {
    return false;
  }

  const segments = identifier.split(":");
  const host = segments[0];

  if (host === undefined || !isDomainHandle(host)) {
    return false;
  }

  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];

    if (
      segment === undefined ||
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      !isDIDWebPathSegment(segment)
    ) {
      return false;
    }
  }

  return true;
}

function isDIDWebPathSegment(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (
      isAsciiAlphaNumericCode(code) ||
      code === 46 ||
      code === 95 ||
      code === 126 ||
      code === 45
    ) {
      continue;
    }

    if (
      code === 37 &&
      index + 2 < value.length &&
      isAsciiHexCode(value.charCodeAt(index + 1)) &&
      isAsciiHexCode(value.charCodeAt(index + 2))
    ) {
      index += 2;
      continue;
    }

    return false;
  }

  return true;
}

function isDomainHandle(value: string): boolean {
  if (
    utf8ByteLength(value) < 3 ||
    utf8ByteLength(value) > MAX_ATPROTO_HANDLE_BYTES ||
    goTrimSpace(value) !== value ||
    goSimpleLowercase(value) !== value ||
    value.includes("://") ||
    value.includes("/") ||
    value.includes(":") ||
    value.endsWith(".")
  ) {
    return false;
  }

  const labels = value.split(".");

  if (labels.length < 2) {
    return false;
  }

  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index];

    if (label === undefined || !isDomainHandleLabel(label)) {
      return false;
    }
  }

  const topLevelLabel = labels[labels.length - 1];

  return topLevelLabel !== undefined && topLevelLabel.length >= 2 && !isAllAsciiDigits(topLevelLabel);
}

function isDomainHandleLabel(value: string): boolean {
  if (value.length === 0 || value.length > 63) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (index === 0 || index === value.length - 1) {
      if (!isAsciiLowerAlphaNumericCode(code)) {
        return false;
      }
    } else if (!isAsciiLowerAlphaNumericCode(code) && code !== 45) {
      return false;
    }
  }

  return true;
}

function isKeyReference(value: string): boolean {
  return (
    value.length > 0 &&
    !containsInlineIdentityMaterial(value) &&
    utf8ByteLength(value) <= MAX_KEY_REFERENCE_BYTES &&
    isReferenceSyntax(value)
  );
}

function isReferenceSyntax(value: string): boolean {
  if (goTrimSpace(value) !== value || containsControlCharacter(value)) {
    return false;
  }

  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index);

    if (codePoint === undefined) {
      return false;
    }

    switch (codePoint) {
      case 0x20:
      case 0x09:
      case 0x0a:
      case 0x0d:
      case 0x0b:
      case 0x0c:
      case 0x3c:
      case 0x3e:
      case 0x7b:
      case 0x7d:
      case 0x60:
      case 0x22:
      case 0x27:
        return false;
      default:
        break;
    }

    index += codePoint > 0xffff ? 2 : 1;
  }

  const separator = value.indexOf("://");

  if (separator === -1) {
    return isOpaqueKeyReference(value);
  }

  if (separator <= 0 || separator === value.length - 3) {
    return false;
  }

  const scheme = goSimpleLowercase(value.slice(0, separator));

  return isReferenceScheme(scheme) && !isInlineReferenceScheme(scheme) && value.slice(separator + 3).length > 0;
}

function isOpaqueKeyReference(value: string): boolean {
  if (value.length === 0 || value.length > 256 || !isAsciiAlphaNumericCode(value.charCodeAt(0))) {
    return false;
  }

  for (let index = 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (
      !isAsciiAlphaNumericCode(code) &&
      code !== 46 &&
      code !== 95 &&
      code !== 58 &&
      code !== 64 &&
      code !== 45
    ) {
      return false;
    }
  }

  return true;
}

function isReferenceScheme(value: string): boolean {
  if (value.length === 0 || !isAsciiLowercaseCode(value.charCodeAt(0))) {
    return false;
  }

  for (let index = 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (!isAsciiLowerAlphaNumericCode(code) && code !== 43 && code !== 46 && code !== 45) {
      return false;
    }
  }

  return true;
}

function isInlineReferenceScheme(value: string): boolean {
  for (let index = 0; index < INLINE_REFERENCE_SCHEMES.length; index += 1) {
    if (value === INLINE_REFERENCE_SCHEMES[index]) {
      return true;
    }
  }

  return false;
}

function isAllAsciiDigits(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    if (!isAsciiDigitCode(value.charCodeAt(index))) {
      return false;
    }
  }

  return true;
}

function isReverseDNSCapsuleID(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  let labelStart = 0;
  let labelCount = 0;

  for (let index = 0; index <= value.length; index += 1) {
    if (index < value.length && value.charCodeAt(index) !== 46) {
      continue;
    }

    if (!isReverseDNSCapsuleLabel(value, labelStart, index)) {
      return false;
    }

    labelCount += 1;
    labelStart = index + 1;
  }

  return labelCount >= 2;
}

function isReverseDNSCapsuleLabel(value: string, start: number, end: number): boolean {
  const length = end - start;

  if (length <= 0 || length > 63) {
    return false;
  }

  for (let index = start; index < end; index += 1) {
    const code = value.charCodeAt(index);

    if (index === start || index === end - 1) {
      if (!isAsciiLowerAlphaNumericCode(code)) {
        return false;
      }
    } else if (!isAsciiLowerAlphaNumericCode(code) && code !== 45) {
      return false;
    }
  }

  return true;
}

function isOpaqueCapsuleID(value: string): boolean {
  if (value.length < 3 || value.length > 160 || !isAsciiAlphaNumericCode(value.charCodeAt(0))) {
    return false;
  }

  for (let index = 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (!isOpaqueCapsuleIDCode(code)) {
      return false;
    }
  }

  return true;
}

function isCapsuleVersionPattern(value: string): boolean {
  if (value.length === 0 || value.length > 128 || !isAsciiAlphaNumericCode(value.charCodeAt(0))) {
    return false;
  }

  for (let index = 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (!isCapsuleVersionCode(code)) {
      return false;
    }
  }

  return true;
}

function isValidSRI(value: string): boolean {
  const separator = value.indexOf("-");

  if (separator === -1 || value.indexOf("-", separator + 1) !== -1) {
    return false;
  }

  const algorithm = value.slice(0, separator);
  const digest = value.slice(separator + 1);
  const expectedLength = sriDigestLength(algorithm);

  if (expectedLength === undefined || !isSRIDigestToken(digest)) {
    return false;
  }

  const decodedLength = digest.includes("=")
    ? decodedPaddedBase64Length(digest)
    : decodedRawBase64Length(digest);

  return decodedLength === expectedLength;
}

function sriDigestLength(algorithm: string): number | undefined {
  switch (algorithm) {
    case "sha256":
      return 32;
    case "sha384":
      return 48;
    case "sha512":
      return 64;
    default:
      return undefined;
  }
}

function isSRIDigestToken(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  let padding = 0;

  for (let index = value.length - 1; index >= 0 && value.charCodeAt(index) === 61; index -= 1) {
    padding += 1;
  }

  if (padding > 2) {
    return false;
  }

  for (let index = 0; index < value.length - padding; index += 1) {
    if (base64Digit(value.charCodeAt(index)) === undefined) {
      return false;
    }
  }

  for (let index = value.length - padding; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) {
      return false;
    }
  }

  return true;
}

function decodedPaddedBase64Length(value: string): number | undefined {
  if (value.length === 0 || value.length % 4 !== 0) {
    return undefined;
  }

  let padding = 0;

  if (value.endsWith("==")) {
    padding = 2;
  } else if (value.endsWith("=")) {
    padding = 1;
  }

  const unpaddedLength = value.length - padding;

  for (let index = 0; index < unpaddedLength; index += 1) {
    if (base64Digit(value.charCodeAt(index)) === undefined) {
      return undefined;
    }
  }

  for (let index = unpaddedLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) {
      return undefined;
    }
  }

  if (padding > 0 && unpaddedLength < 2) {
    return undefined;
  }

  return (value.length / 4) * 3 - padding;
}

function decodedRawBase64Length(value: string): number | undefined {
  if (value.length === 0 || value.length % 4 === 1) {
    return undefined;
  }

  for (let index = 0; index < value.length; index += 1) {
    if (base64Digit(value.charCodeAt(index)) === undefined) {
      return undefined;
    }
  }

  const fullQuanta = Math.floor(value.length / 4);
  const remainder = value.length % 4;

  if (remainder === 0) {
    return fullQuanta * 3;
  }
  if (remainder === 2) {
    return fullQuanta * 3 + 1;
  }
  return fullQuanta * 3 + 2;
}

function base64Digit(code: number): number | undefined {
  if (code >= 65 && code <= 90) {
    return code - 65;
  }
  if (code >= 97 && code <= 122) {
    return code - 71;
  }
  if (code >= 48 && code <= 57) {
    return code + 4;
  }
  if (code === 43) {
    return 62;
  }
  if (code === 47) {
    return 63;
  }
  return undefined;
}

function isPOSIXName(value: string): boolean {
  if (value.length === 0 || value.length > 32) {
    return false;
  }

  const first = value.charCodeAt(0);

  if (!isAsciiLowercaseCode(first) && first !== 95) {
    return false;
  }

  for (let index = 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (!isAsciiLowercaseCode(code) && !isAsciiDigitCode(code) && code !== 95 && code !== 45) {
      return false;
    }
  }

  return !containsInlineKeyMaterial(value);
}

function containsInlineKeyMaterial(value: string): boolean {
  const lower = asciiLowercase(value);

  return containsDataURLPattern(lower) || containsPEMBlockPattern(lower) || containsLongBase64Run(value);
}

function containsDataURLPattern(value: string): boolean {
  for (let start = value.indexOf("data:"); start !== -1; start = value.indexOf("data:", start + 1)) {
    if (start === 0 || !isAsciiRegexWordCode(value.charCodeAt(start - 1))) {
      return true;
    }
  }

  return false;
}

function containsPEMBlockPattern(value: string): boolean {
  for (let start = value.indexOf("-----begin"); start !== -1; start = value.indexOf("-----begin", start + 1)) {
    const afterIndex = start + "-----begin".length;

    if (afterIndex >= value.length || !isAsciiRegexWordCode(value.charCodeAt(afterIndex))) {
      return true;
    }
  }

  return false;
}

const SYSTEMD_UNIT_SUFFIXES = Object.freeze([
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
]);
const MAX_SYSTEMD_UNIT_NAME_LENGTH = 256;
const FORBIDDEN_INLINE_REFERENCE_SCHEMES = Object.freeze(["data", "inline", "literal"]);
const SERVICE_PRIVATE_MATERIAL_TOKENS = Object.freeze([
  Object.freeze(["private", "key"]),
  Object.freeze(["openssh", "private", "key"]),
  Object.freeze(["age", "secret", "key"]),
  Object.freeze(["xprv"]),
  Object.freeze(["seed", "phrase"]),
  Object.freeze(["mnemonic"]),
  Object.freeze(["recovery", "phrase"]),
]) satisfies readonly (readonly string[])[];
const SERVICE_SECRET_ASSIGNMENT_TOKENS = Object.freeze([
  Object.freeze(["private", "key"]),
  Object.freeze(["api", "key"]),
  Object.freeze(["access", "token"]),
  Object.freeze(["refresh", "token"]),
  Object.freeze(["password"]),
  Object.freeze(["secret"]),
]) satisfies readonly (readonly string[])[];

function isSystemdUnitName(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_SYSTEMD_UNIT_NAME_LENGTH ||
    value.charCodeAt(0) === 46 ||
    containsConsecutiveDots(value) ||
    hasInlineReferenceScheme(value) ||
    containsInlineServiceMaterial(value)
  ) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    if (!isSystemdUnitNameCode(value.charCodeAt(index))) {
      return false;
    }
  }

  const prefix = systemdUnitPrefix(value);

  if (prefix === undefined || prefix.length === 0 || prefix.charCodeAt(0) === 46) {
    return false;
  }

  for (let index = 0; index < prefix.length; index += 1) {
    if (!isSystemdUnitNameCode(prefix.charCodeAt(index))) {
      return false;
    }
  }

  return true;
}

function systemdUnitPrefix(value: string): string | undefined {
  for (let index = 0; index < SYSTEMD_UNIT_SUFFIXES.length; index += 1) {
    const suffix = SYSTEMD_UNIT_SUFFIXES[index];

    if (suffix !== undefined && value.endsWith(suffix)) {
      return value.slice(0, value.length - suffix.length);
    }
  }

  return undefined;
}

function containsConsecutiveDots(value: string): boolean {
  for (let index = 1; index < value.length; index += 1) {
    if (value.charCodeAt(index - 1) === 46 && value.charCodeAt(index) === 46) {
      return true;
    }
  }

  return false;
}

function hasInlineReferenceScheme(value: string): boolean {
  const colon = value.indexOf(":");

  if (colon <= 0) {
    return false;
  }

  const scheme = asciiLowercase(value.slice(0, colon));

  for (let index = 0; index < FORBIDDEN_INLINE_REFERENCE_SCHEMES.length; index += 1) {
    if (scheme === FORBIDDEN_INLINE_REFERENCE_SCHEMES[index]) {
      return true;
    }
  }

  return false;
}

function containsInlineServiceMaterial(value: string): boolean {
  const lower = asciiLowercase(value);

  if (lower.includes("-----begin") || containsLongHexRun(value) || containsLongBase64Run(value)) {
    return true;
  }

  for (let index = 0; index < SERVICE_PRIVATE_MATERIAL_TOKENS.length; index += 1) {
    const token = SERVICE_PRIVATE_MATERIAL_TOKENS[index];

    if (token !== undefined && containsBoundedToken(lower, token)) {
      return true;
    }
  }

  for (let index = 0; index < SERVICE_SECRET_ASSIGNMENT_TOKENS.length; index += 1) {
    const token = SERVICE_SECRET_ASSIGNMENT_TOKENS[index];

    if (token !== undefined && containsSecretAssignmentToken(lower, token)) {
      return true;
    }
  }

  return false;
}

function containsInlineCapsuleMaterial(value: string): boolean {
  const lower = asciiLowercase(value);

  return (
    lower.includes("-----begin") ||
    containsCapsulePrivateKeyPattern(lower) ||
    containsCapsuleSecretAssignment(lower) ||
    containsSeedWordsPattern(lower) ||
    containsLongHexRun(value) ||
    containsLongBase64Run(value)
  );
}

function containsInlineIdentityMaterial(value: string): boolean {
  const lower = asciiLowercase(value);

  return (
    containsControlCharacter(value) ||
    containsPEMBlockPattern(lower) ||
    containsCapsulePrivateKeyPattern(lower) ||
    containsIdentitySecretAssignment(lower, value) ||
    containsSeedWordsPattern(lower) ||
    containsLongHexRun(value) ||
    containsLongBase64Run(value)
  );
}

function containsCapsulePrivateKeyPattern(value: string): boolean {
  return (
    containsBoundedToken(value, ["private", "key"]) ||
    containsOpenSSHPrivateKeyPattern(value) ||
    containsBoundedLiteral(value, "age-secret-key") ||
    containsBoundedLiteral(value, "xprv") ||
    containsBoundedToken(value, ["seed", "phrase"]) ||
    containsBoundedLiteral(value, "mnemonic") ||
    containsBoundedToken(value, ["recovery", "phrase"])
  );
}

function containsCapsuleSecretAssignment(value: string): boolean {
  return (
    containsSecretAssignmentToken(value, ["private", "key"]) ||
    containsSecretAssignmentToken(value, ["api", "key"]) ||
    containsSecretAssignmentToken(value, ["access", "token"]) ||
    containsSecretAssignmentToken(value, ["refresh", "token"]) ||
    containsSecretAssignmentToken(value, ["password"]) ||
    containsSecretAssignmentToken(value, ["secret"])
  );
}

function containsIdentitySecretAssignment(lower: string, original: string): boolean {
  return (
    containsIdentitySecretAssignmentToken(lower, original, ["private", "key"]) ||
    containsIdentitySecretAssignmentToken(lower, original, ["api", "key"]) ||
    containsIdentitySecretAssignmentToken(lower, original, ["access", "token"]) ||
    containsIdentitySecretAssignmentToken(lower, original, ["refresh", "token"]) ||
    containsIdentitySecretAssignmentToken(lower, original, ["password"]) ||
    containsIdentitySecretAssignmentToken(lower, original, ["secret"])
  );
}

function containsOpenSSHPrivateKeyPattern(value: string): boolean {
  let start = value.indexOf("openssh");

  while (start !== -1) {
    const before = start === 0 ? undefined : value.charCodeAt(start - 1);
    let offset = start + "openssh".length;

    if (before !== undefined && isAsciiRegexWordCode(before)) {
      start = value.indexOf("openssh", start + 1);
      continue;
    }

    const firstSpace = readAsciiRegexWhitespaceRun(value, offset);

    if (firstSpace !== undefined && value.startsWith("private", firstSpace)) {
      offset = firstSpace + "private".length;
      const secondSpace = readAsciiRegexWhitespaceRun(value, offset);

      if (secondSpace !== undefined && value.startsWith("key", secondSpace)) {
        offset = secondSpace + "key".length;
        const after = offset >= value.length ? undefined : value.charCodeAt(offset);

        if (after === undefined || !isAsciiRegexWordCode(after)) {
          return true;
        }
      }
    }

    start = value.indexOf("openssh", start + 1);
  }

  return false;
}

function readAsciiRegexWhitespaceRun(value: string, start: number): number | undefined {
  if (start >= value.length || !isAsciiRegexWhitespaceCode(value.charCodeAt(start))) {
    return undefined;
  }

  let offset = start;

  while (offset < value.length && isAsciiRegexWhitespaceCode(value.charCodeAt(offset))) {
    offset += 1;
  }

  return offset;
}

function containsBoundedLiteral(value: string, literal: string): boolean {
  let start = value.indexOf(literal);

  while (start !== -1) {
    const before = start === 0 ? undefined : value.charCodeAt(start - 1);
    const afterIndex = start + literal.length;
    const after = afterIndex >= value.length ? undefined : value.charCodeAt(afterIndex);

    if (
      (before === undefined || !isAsciiRegexWordCode(before)) &&
      (after === undefined || !isAsciiRegexWordCode(after))
    ) {
      return true;
    }

    start = value.indexOf(literal, start + 1);
  }

  return false;
}

function containsSeedWordsPattern(value: string): boolean {
  let start = 0;

  while (start < value.length) {
    if (!isAsciiLetterCode(value.charCodeAt(start))) {
      start += 1;
      continue;
    }

    const before = start === 0 ? undefined : value.charCodeAt(start - 1);

    if (before !== undefined && isAsciiRegexWordCode(before)) {
      start = skipAsciiLetters(value, start);
      continue;
    }

    let offset = start;
    let words = 0;

    for (;;) {
      const wordEnd = skipAsciiLetters(value, offset);
      const wordLength = wordEnd - offset;

      if (wordLength < 3 || wordLength > 12) {
        break;
      }

      words += 1;
      const after = wordEnd >= value.length ? undefined : value.charCodeAt(wordEnd);

      if (words >= 12 && (after === undefined || !isAsciiRegexWordCode(after))) {
        return true;
      }

      const nextWord = readAsciiRegexWhitespaceRun(value, wordEnd);

      if (nextWord === undefined || nextWord >= value.length || !isAsciiLetterCode(value.charCodeAt(nextWord))) {
        break;
      }

      offset = nextWord;
    }

    start = skipAsciiLetters(value, start);
  }

  return false;
}

function skipAsciiLetters(value: string, start: number): number {
  let offset = start;

  while (offset < value.length && isAsciiLetterCode(value.charCodeAt(offset))) {
    offset += 1;
  }

  return offset;
}

function containsIdentitySecretAssignmentToken(
  lower: string,
  original: string,
  token: readonly string[],
): boolean {
  const first = token[0];

  if (first === undefined) {
    return false;
  }

  let start = lower.indexOf(first);

  while (start !== -1) {
    const before = start === 0 ? undefined : lower.charCodeAt(start - 1);
    let afterIndex = matchSeparatedToken(lower, token, start);

    while (
      afterIndex !== undefined &&
      afterIndex < lower.length &&
      isAsciiRegexWhitespaceCode(lower.charCodeAt(afterIndex))
    ) {
      afterIndex += 1;
    }

    const delimiter = afterIndex === undefined || afterIndex >= lower.length
      ? undefined
      : lower.charCodeAt(afterIndex);

    if (
      afterIndex !== undefined &&
      (before === undefined || !isAsciiRegexWordCode(before)) &&
      (delimiter === 58 || delimiter === 61)
    ) {
      const nextIndex = afterIndex + 1;

      if (delimiter !== 58 || !original.startsWith("//", nextIndex)) {
        return true;
      }
    }

    start = lower.indexOf(first, start + 1);
  }

  return false;
}

function containsBoundedToken(value: string, token: readonly string[]): boolean {
  const first = token[0];

  if (first === undefined) {
    return false;
  }

  let start = value.indexOf(first);

  while (start !== -1) {
    const matchEnd = matchSeparatedToken(value, token, start);
    const before = start === 0 ? undefined : value.charCodeAt(start - 1);
    const after = matchEnd === undefined || matchEnd >= value.length ? undefined : value.charCodeAt(matchEnd);

    if (
      matchEnd !== undefined &&
      (before === undefined || !isAsciiRegexWordCode(before)) &&
      (after === undefined || !isAsciiRegexWordCode(after))
    ) {
      return true;
    }

    start = value.indexOf(first, start + 1);
  }

  return false;
}

function containsSecretAssignmentToken(value: string, token: readonly string[]): boolean {
  const first = token[0];

  if (first === undefined) {
    return false;
  }

  let start = value.indexOf(first);

  while (start !== -1) {
    const before = start === 0 ? undefined : value.charCodeAt(start - 1);
    let afterIndex = matchSeparatedToken(value, token, start);

    while (
      afterIndex !== undefined &&
      afterIndex < value.length &&
      isAsciiRegexWhitespaceCode(value.charCodeAt(afterIndex))
    ) {
      afterIndex += 1;
    }

    const after = afterIndex === undefined || afterIndex >= value.length ? undefined : value.charCodeAt(afterIndex);

    if (
      afterIndex !== undefined &&
      (before === undefined || !isAsciiRegexWordCode(before)) &&
      (after === 58 || after === 61)
    ) {
      return true;
    }

    start = value.indexOf(first, start + 1);
  }

  return false;
}

function matchSeparatedToken(value: string, token: readonly string[], start: number): number | undefined {
  let offset = start;

  for (let index = 0; index < token.length; index += 1) {
    const segment = token[index];

    if (segment === undefined || !value.startsWith(segment, offset)) {
      return undefined;
    }

    offset += segment.length;

    if (index + 1 < token.length && offset < value.length && isServiceTokenSeparatorCode(value.charCodeAt(offset))) {
      offset += 1;
    }
  }

  return offset;
}

function containsLongHexRun(value: string): boolean {
  let runLength = 0;

  for (let index = 0; index < value.length; index += 1) {
    if (isAsciiHexCode(value.charCodeAt(index))) {
      runLength += 1;

      if (runLength >= 32) {
        return true;
      }
    } else {
      runLength = 0;
    }
  }

  return false;
}

function containsLongBase64Run(value: string): boolean {
  let standardRunLength = 0;
  let urlRunLength = 0;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (isAsciiAlphaNumericCode(code) || code === 43 || code === 47) {
      standardRunLength += 1;

      if (standardRunLength >= 48) {
        return true;
      }
    } else {
      standardRunLength = 0;
    }

    if (isAsciiAlphaNumericCode(code) || code === 95 || code === 45) {
      urlRunLength += 1;

      if (urlRunLength >= 48) {
        return true;
      }
    } else {
      urlRunLength = 0;
    }
  }

  return false;
}

function isCanonicalAbsolutePath(value: string): boolean {
  if (value.length === 0 || value.charCodeAt(0) !== 47 || value === "/" || value.endsWith("/")) {
    return false;
  }

  let segmentStart = 1;

  for (let index = 1; index <= value.length; index += 1) {
    if (index < value.length && value.charCodeAt(index) !== 47) {
      continue;
    }

    const segment = value.slice(segmentStart, index);

    if (segment.length === 0 || segment === "." || segment === ".." || containsChar(segment, 0)) {
      return false;
    }

    segmentStart = index + 1;
  }

  return true;
}

function canonicalizeIPLiteral(value: string): string | undefined {
  if (value.length === 0 || containsChar(value, 37)) {
    return undefined;
  }

  const ipv4 = parseIPv4Literal(value);

  if (ipv4 !== undefined) {
    return formatIPv4Octets(ipv4);
  }

  return canonicalizeIPv6Literal(value);
}

function canonicalizeCIDRLiteral(value: string): string | undefined {
  if (value.length === 0 || goTrimSpace(value) !== value) {
    return undefined;
  }

  const separator = value.lastIndexOf("/");

  if (separator < 0) {
    return undefined;
  }

  const address = value.slice(0, separator);
  const bits = parseNetipPrefixBits(value.slice(separator + 1));

  if (bits === undefined) {
    return undefined;
  }

  const ipv4 = parseIPv4Literal(address);

  if (ipv4 !== undefined) {
    if (bits < 0 || bits > 32) {
      return undefined;
    }

    return `${formatIPv4Octets(maskIPv4Octets(ipv4, bits))}/${bits}`;
  }

  const ipv6 = parseIPv6LiteralGroups(address);

  if (ipv6 === undefined || bits < 0 || bits > 128) {
    return undefined;
  }

  return `${formatIPv6Groups(maskIPv6Groups(ipv6, bits))}/${bits}`;
}

function cidrLiteralCoversAll(value: string): boolean {
  const canonical = canonicalizeCIDRLiteral(value);

  return canonical === "0.0.0.0/0" || canonical === "::/0";
}

function isNetworkInterfaceName(value: string): boolean {
  if (value.length === 0 || utf8ByteLength(value) > 15 || goTrimSpace(value) !== value) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (index === 0) {
      if (!isAsciiAlphaNumericCode(code)) {
        return false;
      }
      continue;
    }

    if (
      !isAsciiAlphaNumericCode(code) &&
      code !== 46 &&
      code !== 58 &&
      code !== 95 &&
      code !== 45
    ) {
      return false;
    }
  }

  return true;
}

function parseIPv4Literal(value: string): readonly [number, number, number, number] | undefined {
  const parts = value.split(".");

  if (parts.length !== 4) {
    return undefined;
  }

  const octets: number[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];

    if (part === undefined) {
      return undefined;
    }

    const octet = parseIPv4Octet(part);

    if (octet === undefined) {
      return undefined;
    }

    octets.push(octet);
  }

  const first = octets[0];
  const second = octets[1];
  const third = octets[2];
  const fourth = octets[3];

  if (first === undefined || second === undefined || third === undefined || fourth === undefined) {
    return undefined;
  }

  return [first, second, third, fourth];
}

function parseIPv4Octet(value: string): number | undefined {
  if (value.length === 0 || (value.length > 1 && value.charCodeAt(0) === 48)) {
    return undefined;
  }

  let parsed = 0;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code < 48 || code > 57) {
      return undefined;
    }

    parsed = parsed * 10 + code - 48;

    if (parsed > 255) {
      return undefined;
    }
  }

  return parsed;
}

function parseNetipPrefixBits(value: string): number | undefined {
  if (value.length === 0) {
    return undefined;
  }

  const first = value.charCodeAt(0);

  if (value.length > 1 && (first < 49 || first > 57)) {
    return undefined;
  }

  let parsed = 0;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (!isAsciiDigitCode(code)) {
      return undefined;
    }

    parsed = parsed * 10 + code - 48;

    if (parsed > Number.MAX_SAFE_INTEGER) {
      return undefined;
    }
  }

  return parsed;
}

function maskIPv4Octets(
  octets: readonly [number, number, number, number],
  bits: number,
): readonly [number, number, number, number] {
  const output = [octets[0], octets[1], octets[2], octets[3]] satisfies [number, number, number, number];
  let remaining = bits;

  for (let index = 0; index < output.length; index += 1) {
    const octet = output[index];

    if (octet === undefined) {
      return output;
    }

    if (remaining >= 8) {
      remaining -= 8;
      continue;
    }

    if (remaining <= 0) {
      output[index] = 0;
      continue;
    }

    output[index] = octet & (0xff << (8 - remaining));
    remaining = 0;
  }

  return output;
}

function canonicalizeIPv6Literal(value: string): string | undefined {
  const groups = parseIPv6LiteralGroups(value);

  return groups === undefined ? undefined : formatIPv6Groups(groups);
}

function parseIPv6LiteralGroups(value: string): readonly number[] | undefined {
  if (!containsChar(value, 58)) {
    return undefined;
  }

  const doubleColon = value.indexOf("::");

  if (doubleColon !== -1 && value.indexOf("::", doubleColon + 2) !== -1) {
    return undefined;
  }

  if (doubleColon === -1) {
    const groups = parseIPv6GroupSequence(value, true);

    return groups !== undefined && groups.length === 8 ? groups : undefined;
  }

  const left = parseIPv6GroupSequence(value.slice(0, doubleColon), false);
  const right = parseIPv6GroupSequence(value.slice(doubleColon + 2), true);

  if (left === undefined || right === undefined || left.length + right.length >= 8) {
    return undefined;
  }

  const groups = [
    ...left,
    ...repeatNumber(0, 8 - left.length - right.length),
    ...right,
  ];

  return groups.length === 8 ? Object.freeze(groups) : undefined;
}

function parseIPv6GroupSequence(value: string, allowEmbeddedIPv4Tail: boolean): readonly number[] | undefined {
  if (value.length === 0) {
    return Object.freeze([]);
  }

  const tokens = value.split(":");
  const groups: number[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === undefined || token.length === 0) {
      return undefined;
    }

    if (containsChar(token, 46)) {
      if (!allowEmbeddedIPv4Tail || index !== tokens.length - 1) {
        return undefined;
      }

      const octets = parseIPv4Literal(token);

      if (octets === undefined) {
        return undefined;
      }

      groups.push(octets[0] * 256 + octets[1], octets[2] * 256 + octets[3]);
      continue;
    }

    const group = parseIPv6HexGroup(token);

    if (group === undefined) {
      return undefined;
    }

    groups.push(group);
  }

  return Object.freeze(groups);
}

function parseIPv6HexGroup(value: string): number | undefined {
  if (value.length === 0 || value.length > 4) {
    return undefined;
  }

  let parsed = 0;

  for (let index = 0; index < value.length; index += 1) {
    const digit = parseHexDigit(value.charCodeAt(index));

    if (digit === undefined) {
      return undefined;
    }

    parsed = parsed * 16 + digit;
  }

  return parsed;
}

function maskIPv6Groups(groups: readonly number[], bits: number): readonly number[] {
  const output = groups.slice();
  let remaining = bits;

  for (let index = 0; index < output.length; index += 1) {
    const group = output[index];

    if (group === undefined) {
      return Object.freeze(output);
    }

    if (remaining >= 16) {
      remaining -= 16;
      continue;
    }

    if (remaining <= 0) {
      output[index] = 0;
      continue;
    }

    output[index] = group & (0xffff << (16 - remaining));
    remaining = 0;
  }

  return Object.freeze(output);
}

function parseHexDigit(code: number): number | undefined {
  if (code >= 48 && code <= 57) {
    return code - 48;
  }

  if (code >= 65 && code <= 70) {
    return code - 55;
  }

  if (code >= 97 && code <= 102) {
    return code - 87;
  }

  return undefined;
}

function formatIPv6Groups(groups: readonly number[]): string {
  if (isIPv4MappedIPv6(groups)) {
    const sixth = groups[6];
    const seventh = groups[7];

    if (sixth === undefined || seventh === undefined) {
      return groups.map(formatIPv6Group).join(":");
    }

    return `::ffff:${formatIPv4Octets([
      Math.floor(sixth / 256),
      sixth % 256,
      Math.floor(seventh / 256),
      seventh % 256,
    ])}`;
  }

  const run = findBestIPv6ZeroRun(groups);

  if (run === undefined) {
    return groups.map(formatIPv6Group).join(":");
  }

  const before = groups.slice(0, run.start).map(formatIPv6Group).join(":");
  const after = groups.slice(run.start + run.length).map(formatIPv6Group).join(":");

  if (before.length === 0 && after.length === 0) {
    return "::";
  }

  if (before.length === 0) {
    return `::${after}`;
  }

  if (after.length === 0) {
    return `${before}::`;
  }

  return `${before}::${after}`;
}

function isIPv4MappedIPv6(groups: readonly number[]): boolean {
  return (
    groups.length === 8 &&
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  );
}

function findBestIPv6ZeroRun(
  groups: readonly number[],
): { readonly start: number; readonly length: number } | undefined {
  let bestStart = -1;
  let bestLength = 0;
  let currentStart = -1;
  let currentLength = 0;

  for (let index = 0; index <= groups.length; index += 1) {
    const group = groups[index];

    if (group === 0) {
      if (currentStart === -1) {
        currentStart = index;
        currentLength = 0;
      }

      currentLength += 1;
      continue;
    }

    if (currentLength >= 2 && currentLength > bestLength) {
      bestStart = currentStart;
      bestLength = currentLength;
    }

    currentStart = -1;
    currentLength = 0;
  }

  return bestStart === -1 ? undefined : { length: bestLength, start: bestStart };
}

function formatIPv6Group(value: number): string {
  return value.toString(16);
}

function formatIPv4Octets(octets: readonly [number, number, number, number]): string {
  return `${octets[0]}.${octets[1]}.${octets[2]}.${octets[3]}`;
}

function repeatNumber(value: number, count: number): readonly number[] {
  const output: number[] = [];

  for (let index = 0; index < count; index += 1) {
    output.push(value);
  }

  return Object.freeze(output);
}

function containsChar(value: string, code: number): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === code) {
      return true;
    }
  }

  return false;
}

function isAgentHostname(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 253 ||
    value !== value.trim() ||
    value.endsWith(".") ||
    containsConsecutiveDots(value) ||
    containsAnyChar(value, ":/?#[]@") ||
    containsControlCharacter(value)
  ) {
    return false;
  }

  const labels = value.split(".");

  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index];

    if (label === undefined || !isAgentHostnameLabel(label)) {
      return false;
    }
  }

  return true;
}

function isAgentHostnameLabel(value: string): boolean {
  if (value.length === 0 || value.length > 63) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (index === 0 || index === value.length - 1) {
      if (!isAsciiAlphaNumericCode(code)) {
        return false;
      }
    } else if (!isAsciiAlphaNumericCode(code) && code !== 45) {
      return false;
    }
  }

  return true;
}

function containsAnyChar(value: string, chars: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (chars.includes(value.charAt(index))) {
      return true;
    }
  }

  return false;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code <= 31 || code === 127) {
      return true;
    }
  }

  return false;
}

function goTrimSpace(value: string): string {
  let start = 0;
  let end = value.length;

  while (start < end) {
    const codePoint = value.codePointAt(start);

    if (codePoint === undefined || !isGoUnicodeSpaceCodePoint(codePoint)) {
      break;
    }

    start += codePoint > 0xffff ? 2 : 1;
  }

  while (end > start) {
    const codePoint = codePointBefore(value, end);

    if (codePoint === undefined || !isGoUnicodeSpaceCodePoint(codePoint)) {
      break;
    }

    end -= codePoint > 0xffff ? 2 : 1;
  }

  return value.slice(start, end);
}

function codePointBefore(value: string, end: number): number | undefined {
  if (end <= 0 || end > value.length) {
    return undefined;
  }

  const last = value.charCodeAt(end - 1);

  if (last >= 0xdc00 && last <= 0xdfff && end >= 2) {
    const first = value.charCodeAt(end - 2);

    if (first >= 0xd800 && first <= 0xdbff) {
      return (first - 0xd800) * 0x400 + (last - 0xdc00) + 0x10000;
    }
  }

  return last;
}

function isGoUnicodeSpaceCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0b ||
    codePoint === 0x0c ||
    codePoint === 0x0d ||
    codePoint === 0x20 ||
    codePoint === 0x85 ||
    codePoint === 0xa0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000
  );
}

function utf8ByteLength(value: string): number {
  let length = 0;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code <= 0x7f) {
      length += 1;
    } else if (code <= 0x7ff) {
      length += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);

      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 4;
        index += 1;
      } else {
        length += 3;
      }
    } else {
      length += 3;
    }
  }

  return length;
}

function isHostnameRFC1123(value: string): boolean {
  if (value.length === 0 || value.length > 253) {
    return false;
  }

  const labels = value.split(".");

  if (labels.length === 0 || isAllNumericDottedQuad(labels)) {
    return false;
  }

  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index];

    if (label === undefined || label.length === 0 || label.length > 63) {
      return false;
    }

    for (let charIndex = 0; charIndex < label.length; charIndex += 1) {
      const code = label.charCodeAt(charIndex);

      if (charIndex === 0 || charIndex === label.length - 1) {
        if (!isAsciiAlphaNumericCode(code)) {
          return false;
        }
      } else if (!isAsciiAlphaNumericCode(code) && code !== 45) {
        return false;
      }
    }
  }

  return true;
}

function isAllNumericDottedQuad(labels: readonly string[]): boolean {
  if (labels.length !== 4) {
    return false;
  }

  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index];

    if (label === undefined || label.length === 0) {
      return false;
    }

    for (let charIndex = 0; charIndex < label.length; charIndex += 1) {
      const code = label.charCodeAt(charIndex);

      if (code < 48 || code > 57) {
        return false;
      }
    }
  }

  return true;
}

function isHostnameLabel(value: string): boolean {
  if (value.length === 0 || value.length > 63) {
    return false;
  }

  if (value.charCodeAt(0) === 45 || value.charCodeAt(value.length - 1) === 45) {
    return false;
  }

  let allNumeric = true;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code >= 97 && code <= 122) {
      allNumeric = false;
    } else if (code >= 48 && code <= 57) {
      continue;
    } else if (code === 45) {
      allNumeric = false;
    } else {
      return false;
    }
  }

  return !allNumeric;
}

function asciiLowercase(value: string): string {
  let output = "";
  let changed = false;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code >= 65 && code <= 90) {
      output += String.fromCharCode(code + 32);
      changed = true;
    } else {
      output += value.charAt(index);
    }
  }

  return changed ? output : value;
}

function goSimpleLowercase(value: string): string {
  let output = "";
  let changed = false;

  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index);

    if (codePoint === undefined) {
      break;
    }

    const current = String.fromCodePoint(codePoint);
    const lower = codePoint === 0x0130 ? "i" : current.toLowerCase();

    if (lower !== current) {
      changed = true;
    }

    output += lower;
    index += codePoint > 0xffff ? 2 : 1;
  }

  return changed ? output : value;
}

function isAsciiAlphaNumericCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

function isAsciiLetterCode(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiLowercaseCode(code: number): boolean {
  return code >= 97 && code <= 122;
}

function isAsciiLowerAlphaNumericCode(code: number): boolean {
  return isAsciiDigitCode(code) || isAsciiLowercaseCode(code);
}

function isAsciiDigitCode(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isAsciiHexCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 70) ||
    (code >= 97 && code <= 102)
  );
}

function isAsciiRegexWordCode(code: number): boolean {
  return isAsciiAlphaNumericCode(code) || code === 95;
}

function isServiceTokenSeparatorCode(code: number): boolean {
  return code === 45 || code === 95 || isAsciiRegexWhitespaceCode(code);
}

function isAsciiRegexWhitespaceCode(code: number): boolean {
  return code === 9 || code === 10 || code === 12 || code === 13 || code === 32;
}

function isSystemdUnitNameCode(code: number): boolean {
  return isAsciiAlphaNumericCode(code) || code === 58 || code === 46 || code === 95 || code === 64 || code === 45;
}

function isOpaqueCapsuleIDCode(code: number): boolean {
  return isAsciiAlphaNumericCode(code) || code === 46 || code === 95 || code === 58 || code === 45;
}

function isCapsuleVersionCode(code: number): boolean {
  return isAsciiAlphaNumericCode(code) || code === 46 || code === 43 || code === 95 || code === 45;
}

function isBundleRefCode(code: number): boolean {
  return isAsciiAlphaNumericCode(code) || code === 46 || code === 95 || code === 58 || code === 64 || code === 47 || code === 45;
}

function isBundleVersionCode(code: number): boolean {
  return isAsciiAlphaNumericCode(code) || code === 46 || code === 43 || code === 95 || code === 45;
}

function uniqueValueKey(value: CapabilityValue): string {
  if (Array.isArray(value)) {
    const parts: string[] = [];

    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];

      if (item !== undefined) {
        parts.push(uniqueValueKey(item));
      }
    }

    return `a:[${parts.join(",")}]`;
  }

  if (isCapabilityObject(value)) {
    const keys = Object.keys(value).sort(compareStrings);
    const parts: string[] = [];

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key !== undefined) {
        const item = value[key];

        if (item !== undefined) {
          parts.push(`${key}:${uniqueValueKey(item)}`);
        }
      }
    }

    return `o:{${parts.join(",")}}`;
  }

  return `${typeof value}:${String(value)}`;
}

function isRawIntegerLiteral(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  let index = 0;

  if (value.charCodeAt(0) === 45) {
    index = 1;
  }

  if (index >= value.length) {
    return false;
  }

  for (; index < value.length; index += 1) {
    if (!isAsciiDigitCode(value.charCodeAt(index))) {
      return false;
    }
  }

  return true;
}

function uniqueByValueKeys(value: CapabilityValue, uniqueBy: readonly string[]): readonly string[] | undefined {
  if (!isCapabilityObject(value)) {
    return undefined;
  }

  const parts: string[] = [];

  for (let index = 0; index < uniqueBy.length; index += 1) {
    const fieldName = uniqueBy[index];

    if (fieldName === undefined) {
      continue;
    }

    const item = value[fieldName];

    if (item === undefined) {
      return undefined;
    }

    parts.push(`${fieldName}:${uniqueValueKey(item)}`);
  }

  return Object.freeze(parts);
}

function isRecord(value: PlainJson | undefined): value is JsonRecord {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCapabilityObject(value: CapabilityValue): value is CapabilityObject {
  return typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: JsonRecord | CapabilityRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function addError(errors: CapabilityRejection[], path: Path, message: string): void {
  errors.push({
    message,
    path: formatPath(path),
  });
}

function reject(
  rejections: readonly CapabilityRejection[],
): Extract<CapabilityValidationResult, { readonly ok: false }> {
  return {
    ok: false,
    rejections,
  };
}

function rejectManifestLoad(reason: string): Extract<CapabilityManifestLoadResult, { readonly ok: false }> {
  return {
    ok: false,
    reason,
  };
}

function formatManifestLoadReason(errors: readonly CapabilityRejection[]): string {
  if (errors.length === 0) {
    return "Invalid capability manifest.";
  }

  const messages: string[] = [];

  for (let index = 0; index < errors.length; index += 1) {
    const error = errors[index];

    if (error === undefined) {
      continue;
    }

    messages.push(error.path.length === 0 ? error.message : `${error.path}: ${error.message}`);
  }

  return messages.length === 0 ? "Invalid capability manifest." : messages.join("; ");
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
