import { safeNormalize } from "./safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "./safe-normalize.ts";

/**
 * Additive ADR 0007 proof-of-concept for a deliberately closed capability-manifest
 * dialect. Cross-field invariants are limited to the rule union below; a capability
 * that needs a different invariant requires a governance-reviewed dialect extension,
 * not an embedded expression language.
 *
 * TIMESYNC server validation in this PoC is intentionally hostname-only. The agent
 * capability also accepts IP literals, but IP parsing and canonical dedupe are the
 * format-canonicalization surface ADR 0007 says must be generated/shared rather than
 * hand-written twice. This file therefore rejects IP literals and does not implement
 * IPv4 or IPv6 parsing.
 *
 * The lowercase primitive is ASCII-only by contract: A-Z map to a-z and every other
 * code point is left unchanged. That avoids JS/Go Unicode case-folding drift.
 */

export type StringFieldFormat = "hostnameRFC1123";

export interface StringFieldSchema {
  readonly type: "string";
  readonly required: boolean;
  readonly maxLength?: number;
  readonly enum?: readonly string[];
  readonly lowercase?: boolean;
  readonly noInlineSecrets?: boolean;
  readonly format?: StringFieldFormat;
}

export interface IntegerFieldSchema {
  readonly type: "integer";
  readonly required: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
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
}

export type FieldSchema =
  | StringFieldSchema
  | IntegerFieldSchema
  | BooleanFieldSchema
  | ArrayFieldSchema;

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
    };

export interface CapabilityManifest {
  readonly capability: string;
  readonly version?: 1;
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
  | readonly CapabilityValue[];

export type CapabilityRecord = Readonly<Record<string, CapabilityValue>>;

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

export { TIMESYNC_MANIFEST } from "./generated/capability-manifests.generated.ts";

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
  | CompiledArrayFieldSchema;

interface CompiledStringFieldSchema {
  type: "string";
  required: boolean;
  format?: StringFieldFormat;
  maxLength?: number;
  enumValues?: ReadonlySet<string>;
  lowercase: boolean;
  noInlineSecrets: boolean;
}

interface CompiledIntegerFieldSchema {
  type: "integer";
  required: boolean;
  minimum?: number;
  maximum?: number;
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
}

type FieldValidationResult =
  | {
      readonly ok: true;
      readonly value: CapabilityValue;
    }
  | {
      readonly ok: false;
    };

const SUPPORTED_MANIFEST_VERSION = 1;
const MANIFEST_FIELDS = new Set(["capability", "crossFieldRules", "fields", "version"]);
const STRING_SCHEMA_FIELDS = new Set([
  "enum",
  "format",
  "lowercase",
  "maxLength",
  "noInlineSecrets",
  "required",
  "type",
]);
const INTEGER_SCHEMA_FIELDS = new Set(["maximum", "minimum", "required", "type"]);
const BOOLEAN_SCHEMA_FIELDS = new Set(["required", "type"]);
const ARRAY_SCHEMA_FIELDS = new Set([
  "items",
  "maxItems",
  "minItems",
  "required",
  "type",
  "uniqueItems",
]);
const CROSS_FIELD_RULE_FIELDS = new Set(["control", "target", "type"]);
const DATA_URL_PATTERN = /data:/iu;
const PEM_BLOCK_PATTERN = /-----BEGIN/iu;
const LONG_BASE64_OR_BASE64URL_PATTERN = /[A-Za-z0-9+/_-]{48,}/u;

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

    const manifest = Object.freeze({
      capability: parsed.manifest.capability,
      version: SUPPORTED_MANIFEST_VERSION,
      fields: parsed.manifest.fields,
      crossFieldRules: parsed.manifest.crossFieldRules,
    } satisfies LoadedCapabilityManifest);

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
      const normalized = safeNormalize(input);

      if (!normalized.ok) {
        return reject([
          {
            message: `Invalid untrusted input: ${normalized.reason}`,
            path: "",
          },
        ]);
      }

      const value = validateInput(normalized.value, compiled.value);

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
      ? {
          capability,
          crossFieldRules,
          fields: fields.manifest,
        }
      : {
          capability,
          version,
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
  const enumValues = readOptionalStringEnum(value, "enum", [...path, "enum"], errors);
  const lowercaseValue = readOptionalBoolean(value, "lowercase", [...path, "lowercase"], errors);
  const noInlineSecretsValue = readOptionalBoolean(
    value,
    "noInlineSecrets",
    [...path, "noInlineSecrets"],
    errors,
  );
  const lowercase = lowercaseValue ?? false;
  const noInlineSecrets = noInlineSecretsValue ?? false;

  if (errors.length > errorStart) {
    return undefined;
  }

  const compiled: CompiledStringFieldSchema = {
    lowercase,
    noInlineSecrets,
    required,
    type: "string",
  };
  const manifest: {
    type: "string";
    required: boolean;
    maxLength?: number;
    enum?: readonly string[];
    lowercase?: boolean;
    noInlineSecrets?: boolean;
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
  if (enumValues !== undefined) {
    compiled.enumValues = new Set(enumValues);
    manifest.enum = Object.freeze([...enumValues]);
  }
  if (lowercaseValue !== undefined) {
    manifest.lowercase = lowercaseValue;
  }
  if (noInlineSecretsValue !== undefined) {
    manifest.noInlineSecrets = noInlineSecretsValue;
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

  if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
    addError(errors, path, "minItems must be less than or equal to maxItems.");
  }

  if (errors.length > errorStart || items === undefined) {
    return undefined;
  }

  const compiled: CompiledArrayFieldSchema = {
    items: items.compiled,
    required,
    type: "array",
    uniqueItems,
  };
  const manifest: {
    type: "array";
    required: boolean;
    items: FieldSchema;
    minItems?: number;
    maxItems?: number;
    uniqueItems?: boolean;
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

  return {
    compiled,
    manifest: Object.freeze(manifest),
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

  if (fields !== undefined && control !== undefined) {
    const controlField = fields.get(control);

    if (controlField === undefined || controlField.type !== "boolean") {
      addError(errors, [...path, "control"], "Control field must reference a boolean field.");
    }
  }

  if (fields !== undefined && target !== undefined) {
    const targetField = fields.get(target);

    if (targetField === undefined || targetField.type !== "array") {
      addError(errors, [...path, "target"], "Target field must reference an array field.");
    }
  }

  if (errors.length > errorStart || typeValue === undefined || control === undefined || target === undefined) {
    return undefined;
  }

  switch (typeValue) {
    case "requireNonEmptyArrayWhenTrue":
      return Object.freeze({
        control,
        target,
        type: "requireNonEmptyArrayWhenTrue",
      });
    case "requireEmptyArrayWhenFalse":
      return Object.freeze({
        control,
        target,
        type: "requireEmptyArrayWhenFalse",
      });
    default:
      addError(errors, [...path, "type"], "Unknown cross-field rule type.");
      return undefined;
  }
}

function validateInput(value: PlainJson, manifest: CompiledManifest):
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

    const result = validateField(value[fieldName], schema, [fieldName], errors);

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

  applyCrossFieldRules(output, manifest.crossFieldRules, errors);

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
): FieldValidationResult {
  if (value === undefined) {
    addError(errors, path, "Required field is missing.");
    return { ok: false };
  }

  switch (schema.type) {
    case "string":
      return validateStringField(value, schema, path, errors);
    case "integer":
      return validateIntegerField(value, schema, path, errors);
    case "boolean":
      return validateBooleanField(value, path, errors);
    case "array":
      return validateArrayField(value, schema, path, errors);
  }
}

function validateStringField(
  value: PlainJson,
  schema: CompiledStringFieldSchema,
  path: Path,
  errors: CapabilityRejection[],
): FieldValidationResult {
  if (typeof value !== "string") {
    addError(errors, path, "Expected string.");
    return { ok: false };
  }

  const errorStart = errors.length;

  if (schema.noInlineSecrets && containsInlineSecretMaterial(value)) {
    addError(errors, path, "Inline secret material is not allowed.");
  }

  if (schema.format !== undefined && !validateStringFormat(value, schema.format)) {
    addError(errors, path, "String does not match required format.");
  }

  const normalized = schema.lowercase ? asciiLowercase(value) : value;

  if (schema.maxLength !== undefined && normalized.length > schema.maxLength) {
    addError(errors, path, "String exceeds maxLength.");
  }

  if (schema.enumValues !== undefined && !schema.enumValues.has(normalized)) {
    addError(errors, path, "String is not in the allowed enum.");
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
): FieldValidationResult {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    addError(errors, path, "Expected safe integer.");
    return { ok: false };
  }

  const errorStart = errors.length;

  if (schema.minimum !== undefined && value < schema.minimum) {
    addError(errors, path, "Integer is below minimum.");
  }

  if (schema.maximum !== undefined && value > schema.maximum) {
    addError(errors, path, "Integer is above maximum.");
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
  const seen = new Map<string, number>();

  for (let index = 0; index < value.length; index += 1) {
    const itemPath = [...path, String(index)];
    const result = validateField(value[index], schema.items, itemPath, errors);

    if (!result.ok) {
      continue;
    }

    if (schema.uniqueItems) {
      const key = uniqueValueKey(result.value);
      const previousIndex = seen.get(key);

      if (previousIndex !== undefined) {
        addError(
          errors,
          itemPath,
          `Duplicate array item also appears at ${formatPath([...path, String(previousIndex)])}.`,
        );
      } else {
        seen.set(key, index);
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

function applyCrossFieldRules(
  value: CapabilityRecord,
  rules: readonly CrossFieldRule[],
  errors: CapabilityRejection[],
): void {
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];

    if (rule === undefined) {
      continue;
    }

    if (!hasOwn(value, rule.control) || !hasOwn(value, rule.target)) {
      addError(errors, [rule.target], "Cross-field rule references invalid fields.");
      continue;
    }

    const control = value[rule.control];
    const target = value[rule.target];

    if (typeof control !== "boolean" || !Array.isArray(target)) {
      addError(errors, [rule.target], "Cross-field rule references invalid fields.");
      continue;
    }

    switch (rule.type) {
      case "requireNonEmptyArrayWhenTrue":
        if (control && target.length === 0) {
          addError(errors, [rule.target], `${rule.target} must be non-empty when ${rule.control} is true.`);
        }
        break;
      case "requireEmptyArrayWhenFalse":
        if (!control && target.length !== 0) {
          addError(errors, [rule.target], `${rule.target} must be empty when ${rule.control} is false.`);
        }
        break;
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

function containsInlineSecretMaterial(value: string): boolean {
  return (
    DATA_URL_PATTERN.test(value) ||
    PEM_BLOCK_PATTERN.test(value) ||
    LONG_BASE64_OR_BASE64URL_PATTERN.test(value)
  );
}

function isStringFieldFormat(value: string): value is StringFieldFormat {
  return value === "hostnameRFC1123";
}

function validateStringFormat(value: string, format: StringFieldFormat): boolean {
  switch (format) {
    case "hostnameRFC1123":
      return isHostnameRFC1123(value);
  }
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

function isAsciiAlphaNumericCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
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

  return `${typeof value}:${String(value)}`;
}

function isRecord(value: PlainJson | undefined): value is JsonRecord {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
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
