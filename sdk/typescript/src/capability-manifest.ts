import { safeNormalize } from "./safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "./safe-normalize.ts";

/**
 * Additive ADR 0007 proof-of-concept for a deliberately closed capability-manifest
 * dialect. Cross-field invariants are limited to the rule union below; a capability
 * that needs a different invariant requires a governance-reviewed dialect extension,
 * not an embedded expression language.
 *
 * The `hostnameOrIp` format approximates the agent's Go `netip.ParseAddr` + hostname
 * normalization. Exact Go-netip parity is precisely what ADR 0007's generated/shared
 * validators are meant to deliver; this PoC keeps the drift visible as motivation for
 * the ADR rather than claiming a second handwritten implementation is authoritative.
 */

export type StringFormat = "hostnameOrIp";

export interface StringFieldSchema {
  readonly type: "string";
  readonly required: boolean;
  readonly pattern?: string;
  readonly maxLength?: number;
  readonly enum?: readonly string[];
  readonly noInlineSecrets?: boolean;
  readonly format?: StringFormat;
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
  readonly fields: Readonly<Record<string, FieldSchema>>;
  readonly crossFieldRules: readonly CrossFieldRule[];
}

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

type JsonRecord = PlainJsonObject;
type Path = readonly string[];

interface CompiledManifest {
  readonly capability: string;
  readonly fields: ReadonlyMap<string, CompiledFieldSchema>;
  readonly fieldNames: readonly string[];
  readonly crossFieldRules: readonly CrossFieldRule[];
}

type CompiledFieldSchema =
  | CompiledStringFieldSchema
  | CompiledIntegerFieldSchema
  | CompiledBooleanFieldSchema
  | CompiledArrayFieldSchema;

interface CompiledStringFieldSchema {
  type: "string";
  required: boolean;
  pattern?: RegExp;
  maxLength?: number;
  enumValues?: ReadonlySet<string>;
  noInlineSecrets: boolean;
  format?: StringFormat;
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

const MANIFEST_FIELDS = new Set(["capability", "crossFieldRules", "fields"]);
const STRING_SCHEMA_FIELDS = new Set([
  "enum",
  "format",
  "maxLength",
  "noInlineSecrets",
  "pattern",
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
const CROSS_FIELD_RULE_TYPES = new Set([
  "requireEmptyArrayWhenFalse",
  "requireNonEmptyArrayWhenTrue",
]);
const MAX_TIMESYNC_SERVERS = 8;
const MAX_HOSTNAME_LENGTH = 253;
const HOSTNAME_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;
const CONTROL_CHARACTER_PATTERN = /[\x00-\x1f\x7f]/u;
const DATA_URL_PATTERN = /data:/iu;
const PEM_BLOCK_PATTERN = /-----BEGIN/iu;
const LONG_BASE64_OR_BASE64URL_PATTERN = /[A-Za-z0-9+/_-]{48,}/u;
const IPV4_OCTET_PATTERN = /^[0-9]{1,3}$/u;
const IPV6_GROUP_PATTERN = /^[0-9A-Fa-f]{1,4}$/u;

export const TIMESYNC_MANIFEST = Object.freeze({
  capability: "time.sync",
  fields: Object.freeze({
    enabled: Object.freeze({
      required: true,
      type: "boolean",
    }),
    servers: Object.freeze({
      items: Object.freeze({
        format: "hostnameOrIp",
        maxLength: MAX_HOSTNAME_LENGTH,
        noInlineSecrets: true,
        required: true,
        type: "string",
      }),
      maxItems: MAX_TIMESYNC_SERVERS,
      required: true,
      type: "array",
      uniqueItems: true,
    }),
  }),
  crossFieldRules: Object.freeze([
    Object.freeze({
      control: "enabled",
      target: "servers",
      type: "requireNonEmptyArrayWhenTrue",
    }),
    Object.freeze({
      control: "enabled",
      target: "servers",
      type: "requireEmptyArrayWhenFalse",
    }),
  ]),
} satisfies CapabilityManifest);

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
    const manifest = parseManifest(normalized.value, [], errors);

    if (manifest === undefined || errors.length > 0) {
      return reject(errors);
    }

    return {
      ok: true,
      value: manifest,
    };
  } catch {
    return reject([{ message: "Capability manifest compilation failed.", path: "" }]);
  }
}

function parseManifest(
  value: PlainJson,
  path: Path,
  errors: CapabilityRejection[],
): CompiledManifest | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected capability manifest object.");
    return undefined;
  }

  const errorStart = errors.length;
  rejectUnknownFields(value, MANIFEST_FIELDS, path, errors);

  const capability = readRequiredString(value, "capability", [...path, "capability"], errors);
  const fieldsValue = readRequiredProperty(value, "fields", [...path, "fields"], errors);
  const rulesValue = readRequiredProperty(value, "crossFieldRules", [...path, "crossFieldRules"], errors);

  const fields = fieldsValue === undefined ? undefined : parseManifestFields(fieldsValue, [...path, "fields"], errors);
  const crossFieldRules =
    rulesValue === undefined
      ? undefined
      : parseCrossFieldRules(rulesValue, [...path, "crossFieldRules"], fields, errors);

  if (
    errors.length > errorStart ||
    capability === undefined ||
    capability.length === 0 ||
    fields === undefined ||
    crossFieldRules === undefined
  ) {
    if (capability !== undefined && capability.length === 0) {
      addError(errors, [...path, "capability"], "Expected non-empty capability name.");
    }
    return undefined;
  }

  return Object.freeze({
    capability,
    crossFieldRules,
    fieldNames: Object.freeze(Array.from(fields.keys()).sort(compareStrings)),
    fields,
  });
}

function parseManifestFields(
  value: PlainJson,
  path: Path,
  errors: CapabilityRejection[],
): ReadonlyMap<string, CompiledFieldSchema> | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected fields object.");
    return undefined;
  }

  const fieldNames = Object.keys(value).sort(compareStrings);
  const fields = new Map<string, CompiledFieldSchema>();
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
      fields.set(fieldName, schema);
    }
  }

  if (errors.length > errorStart) {
    return undefined;
  }

  return fields;
}

function parseFieldSchema(
  value: PlainJson | undefined,
  path: Path,
  errors: CapabilityRejection[],
): CompiledFieldSchema | undefined {
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
): CompiledStringFieldSchema | undefined {
  const errorStart = errors.length;
  rejectUnknownFields(value, STRING_SCHEMA_FIELDS, path, errors);

  const patternSource = readOptionalString(value, "pattern", [...path, "pattern"], errors);
  const maxLength = readOptionalSafeInteger(value, "maxLength", [...path, "maxLength"], 0, Number.MAX_SAFE_INTEGER, errors);
  const enumValues = readOptionalStringEnum(value, "enum", [...path, "enum"], errors);
  const noInlineSecrets = readOptionalBoolean(value, "noInlineSecrets", [...path, "noInlineSecrets"], errors) ?? false;
  const format = readOptionalStringFormat(value, "format", [...path, "format"], errors);
  const pattern = patternSource === undefined ? undefined : compilePattern(patternSource, [...path, "pattern"], errors);

  if (errors.length > errorStart) {
    return undefined;
  }

  const schema: CompiledStringFieldSchema = {
    noInlineSecrets,
    required,
    type: "string",
  };

  if (pattern !== undefined) {
    schema.pattern = pattern;
  }
  if (maxLength !== undefined) {
    schema.maxLength = maxLength;
  }
  if (enumValues !== undefined) {
    schema.enumValues = enumValues;
  }
  if (format !== undefined) {
    schema.format = format;
  }

  return schema;
}

function parseIntegerFieldSchema(
  value: JsonRecord,
  required: boolean,
  path: Path,
  errors: CapabilityRejection[],
): CompiledIntegerFieldSchema | undefined {
  const errorStart = errors.length;
  rejectUnknownFields(value, INTEGER_SCHEMA_FIELDS, path, errors);

  const minimum = readOptionalSafeInteger(value, "minimum", [...path, "minimum"], Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, errors);
  const maximum = readOptionalSafeInteger(value, "maximum", [...path, "maximum"], Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, errors);

  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    addError(errors, path, "minimum must be less than or equal to maximum.");
  }

  if (errors.length > errorStart) {
    return undefined;
  }

  const schema: CompiledIntegerFieldSchema = {
    required,
    type: "integer",
  };

  if (minimum !== undefined) {
    schema.minimum = minimum;
  }
  if (maximum !== undefined) {
    schema.maximum = maximum;
  }

  return schema;
}

function parseBooleanFieldSchema(
  value: JsonRecord,
  required: boolean,
  path: Path,
  errors: CapabilityRejection[],
): CompiledBooleanFieldSchema | undefined {
  const errorStart = errors.length;
  rejectUnknownFields(value, BOOLEAN_SCHEMA_FIELDS, path, errors);

  if (errors.length > errorStart) {
    return undefined;
  }

  return {
    required,
    type: "boolean",
  };
}

function parseArrayFieldSchema(
  value: JsonRecord,
  required: boolean,
  path: Path,
  errors: CapabilityRejection[],
): CompiledArrayFieldSchema | undefined {
  const errorStart = errors.length;
  rejectUnknownFields(value, ARRAY_SCHEMA_FIELDS, path, errors);

  const itemValue = readRequiredProperty(value, "items", [...path, "items"], errors);
  const items = itemValue === undefined ? undefined : parseFieldSchema(itemValue, [...path, "items"], errors);
  const minItems = readOptionalSafeInteger(value, "minItems", [...path, "minItems"], 0, Number.MAX_SAFE_INTEGER, errors);
  const maxItems = readOptionalSafeInteger(value, "maxItems", [...path, "maxItems"], 0, Number.MAX_SAFE_INTEGER, errors);
  const uniqueItems = readOptionalBoolean(value, "uniqueItems", [...path, "uniqueItems"], errors) ?? false;

  if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
    addError(errors, path, "minItems must be less than or equal to maxItems.");
  }

  if (errors.length > errorStart || items === undefined) {
    return undefined;
  }

  const schema: CompiledArrayFieldSchema = {
    items,
    required,
    type: "array",
    uniqueItems,
  };

  if (minItems !== undefined) {
    schema.minItems = minItems;
  }
  if (maxItems !== undefined) {
    schema.maxItems = maxItems;
  }

  return schema;
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

  if (typeValue !== undefined && !CROSS_FIELD_RULE_TYPES.has(typeValue)) {
    addError(errors, [...path, "type"], "Unknown cross-field rule type.");
  }

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

  if (typeValue === "requireNonEmptyArrayWhenTrue") {
    return {
      control,
      target,
      type: "requireNonEmptyArrayWhenTrue",
    };
  }

  if (typeValue === "requireEmptyArrayWhenFalse") {
    return {
      control,
      target,
      type: "requireEmptyArrayWhenFalse",
    };
  }

  return undefined;
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

    const child = value[fieldName];
    const result = validateField(child, schema, [fieldName], errors);

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
  let normalized = value;

  if (schema.noInlineSecrets && containsInlineSecretMaterial(value)) {
    addError(errors, path, "Inline secret material is not allowed.");
  }

  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    addError(errors, path, "String exceeds maxLength.");
  }

  if (schema.pattern !== undefined && !schema.pattern.test(value)) {
    addError(errors, path, "String does not match required pattern.");
  }

  if (schema.enumValues !== undefined && !schema.enumValues.has(value)) {
    addError(errors, path, "String is not in the allowed enum.");
  }

  if (schema.format === "hostnameOrIp") {
    const formatted = normalizeHostnameOrIp(value);

    if (formatted === undefined) {
      addError(errors, path, "Expected RFC-1123 hostname or IP literal.");
    } else {
      normalized = formatted;
    }
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
): ReadonlySet<string> | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }

  const child = value[key];

  if (!Array.isArray(child) || child.length === 0) {
    addError(errors, path, "Expected non-empty string enum array.");
    return undefined;
  }

  const values = new Set<string>();

  for (let index = 0; index < child.length; index += 1) {
    const item = child[index];

    if (typeof item !== "string") {
      addError(errors, [...path, String(index)], "Expected string enum value.");
      continue;
    }

    if (values.has(item)) {
      addError(errors, [...path, String(index)], "Duplicate enum value.");
      continue;
    }

    values.add(item);
  }

  return values;
}

function readOptionalStringFormat(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: CapabilityRejection[],
): StringFormat | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }

  const child = value[key];

  if (child !== "hostnameOrIp") {
    addError(errors, path, "Unknown string format.");
    return undefined;
  }

  return child;
}

function compilePattern(
  source: string,
  path: Path,
  errors: CapabilityRejection[],
): RegExp | undefined {
  try {
    return new RegExp(source, "u");
  } catch {
    addError(errors, path, "Invalid regular expression pattern.");
    return undefined;
  }
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

function normalizeHostnameOrIp(value: string): string | undefined {
  if (!isServerToken(value)) {
    return undefined;
  }

  if (isIpv4(value)) {
    return value;
  }

  if (looksLikeDottedQuad(value)) {
    return undefined;
  }

  if (isIpv6(value)) {
    return value.toLowerCase();
  }

  if (isHostname(value)) {
    return value.toLowerCase();
  }

  return undefined;
}

function isServerToken(value: string): boolean {
  return value.length > 0 && value === value.trim() && !CONTROL_CHARACTER_PATTERN.test(value);
}

function isHostname(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_HOSTNAME_LENGTH ||
    value !== value.trim() ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes(":") ||
    value.includes("/") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("[") ||
    value.includes("]") ||
    value.includes("@") ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return false;
  }

  const labels = value.split(".");

  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index];

    if (label === undefined || !HOSTNAME_LABEL_PATTERN.test(label)) {
      return false;
    }
  }

  return true;
}

function isIpv4(value: string): boolean {
  const octets = value.split(".");

  if (octets.length !== 4) {
    return false;
  }

  for (let index = 0; index < octets.length; index += 1) {
    const octet = octets[index];

    if (octet === undefined || !IPV4_OCTET_PATTERN.test(octet)) {
      return false;
    }

    if (octet.length > 1 && octet.startsWith("0")) {
      return false;
    }

    const valueAsNumber = Number(octet);

    if (valueAsNumber < 0 || valueAsNumber > 255) {
      return false;
    }
  }

  return true;
}

function isIpv6(value: string): boolean {
  if (
    value.length === 0 ||
    value.includes("/") ||
    value.includes("[") ||
    value.includes("]") ||
    value.includes("@") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return false;
  }

  let address = value;

  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");

    if (lastColon < 0) {
      return false;
    }

    const ipv4Tail = value.slice(lastColon + 1);

    if (!isIpv4(ipv4Tail)) {
      return false;
    }

    address = `${value.slice(0, lastColon)}:0:0`;
  }

  if (/[^0-9A-Fa-f:]/u.test(address)) {
    return false;
  }

  const compressionParts = address.split("::");

  if (compressionParts.length > 2) {
    return false;
  }

  if (compressionParts.length === 1) {
    const groups = address.split(":");

    return groups.length === 8 && areIpv6Groups(groups);
  }

  const leftPart = compressionParts[0];
  const rightPart = compressionParts[1];

  if (leftPart === undefined || rightPart === undefined) {
    return false;
  }

  const leftGroups = leftPart.length === 0 ? [] : leftPart.split(":");
  const rightGroups = rightPart.length === 0 ? [] : rightPart.split(":");

  if (!areIpv6Groups(leftGroups) || !areIpv6Groups(rightGroups)) {
    return false;
  }

  return leftGroups.length + rightGroups.length < 8;
}

function areIpv6Groups(groups: readonly string[]): boolean {
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];

    if (group === undefined || !IPV6_GROUP_PATTERN.test(group)) {
      return false;
    }
  }

  return true;
}

function looksLikeDottedQuad(value: string): boolean {
  const parts = value.split(".");

  if (parts.length !== 4) {
    return false;
  }

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];

    if (part === undefined || !/^[0-9]+$/u.test(part)) {
      return false;
    }
  }

  return true;
}

function containsInlineSecretMaterial(value: string): boolean {
  return (
    DATA_URL_PATTERN.test(value) ||
    PEM_BLOCK_PATTERN.test(value) ||
    LONG_BASE64_OR_BASE64URL_PATTERN.test(value)
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
