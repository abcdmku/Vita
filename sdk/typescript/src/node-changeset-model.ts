import { validateAccountsConfig } from "./accounts-model.ts";
import { validateCapsuleRegistry } from "./capsule-registry-model.ts";
import { validateNodeConfig } from "./node-config-model.ts";
import { safeNormalize } from "./safe-normalize.ts";
import { validateServicesConfig } from "./services-model.ts";
import type {
  AccountsConfig,
  ValidationError as AccountsConfigValidationError,
} from "./accounts-model.ts";
import type {
  CapsuleRegistry,
  CapsuleRegistryValidationError,
} from "./capsule-registry-model.ts";
import type {
  NodeConfig,
  ValidationError as NodeConfigValidationError,
} from "./node-config-model.ts";
import type { PlainJson, PlainJsonObject } from "./safe-normalize.ts";
import type {
  ServicesConfig,
  ValidationError as ServicesConfigValidationError,
} from "./services-model.ts";

export interface NodeChangeSet {
  readonly nodeConfig?: NodeConfig;
  readonly services?: ServicesConfig;
  readonly accounts?: AccountsConfig;
  readonly capsules?: CapsuleRegistry;
}

export type NodeChangeSetSection =
  | "accounts"
  | "capsules"
  | "nodeConfig"
  | "services";

export interface NodeChangeSetEnvelopeRejection {
  readonly path: string;
  readonly message: string;
}

export interface NodeChangeSetRejections {
  readonly envelope?: readonly NodeChangeSetEnvelopeRejection[];
  readonly accounts?: readonly AccountsConfigValidationError[];
  readonly capsules?: readonly CapsuleRegistryValidationError[];
  readonly nodeConfig?: readonly NodeConfigValidationError[];
  readonly services?: readonly ServicesConfigValidationError[];
}

export type NodeChangeSetValidationResult =
  | {
      readonly ok: true;
      readonly changeSet: NodeChangeSet;
      readonly sectionsPresent: readonly NodeChangeSetSection[];
    }
  | {
      readonly ok: false;
      readonly rejections: NodeChangeSetRejections;
    };

export type Result = NodeChangeSetValidationResult;

type JsonRecord = PlainJsonObject;
type Path = readonly string[];

const SECTION_KEYS: readonly NodeChangeSetSection[] = Object.freeze([
  "accounts",
  "capsules",
  "nodeConfig",
  "services",
]);
const NODE_CHANGE_SET_FIELDS: ReadonlySet<string> = new Set<string>(SECTION_KEYS);

export function validateNodeChangeSet(input: unknown): NodeChangeSetValidationResult {
  try {
    const normalized = safeNormalize(input);

    if (!normalized.ok) {
      return reject({
        envelope: [
          {
            path: "",
            message: `Invalid untrusted input: ${normalized.reason}`,
          },
        ],
      });
    }

    return parseNodeChangeSet(normalized.value);
  } catch {
    return reject({
      envelope: [
        {
          path: "",
          message: "Node change-set validation failed.",
        },
      ],
    });
  }
}

function parseNodeChangeSet(value: PlainJson): NodeChangeSetValidationResult {
  if (!isRecord(value)) {
    return reject({
      envelope: [
        {
          path: "",
          message: "Expected node change-set object.",
        },
      ],
    });
  }

  const envelopeRejections: NodeChangeSetEnvelopeRejection[] = [];
  rejectUnknownFields(value, NODE_CHANGE_SET_FIELDS, [], envelopeRejections);

  const sectionsPresent = collectSectionsPresent(value);

  if (sectionsPresent.length === 0) {
    addEnvelopeRejection(
      envelopeRejections,
      [],
      "Expected at least one change-set section.",
    );
  }

  const rejections: NodeChangeSetRejectionsBuilder = {};
  const changeSetBuilder: NodeChangeSetBuilder = {};

  if (envelopeRejections.length > 0) {
    rejections.envelope = Object.freeze(envelopeRejections);
  }

  if (hasOwn(value, "accounts")) {
    const result = validateAccountsConfig(value.accounts);

    if (result.ok) {
      changeSetBuilder.accounts = result.config;
    } else {
      rejections.accounts = result.errors;
    }
  }

  if (hasOwn(value, "capsules")) {
    const result = validateCapsuleRegistry(value.capsules);

    if (result.ok) {
      changeSetBuilder.capsules = result.registry;
    } else {
      rejections.capsules = result.errors;
    }
  }

  if (hasOwn(value, "nodeConfig")) {
    const result = validateNodeConfig(value.nodeConfig);

    if (result.ok) {
      changeSetBuilder.nodeConfig = result.config;
    } else {
      rejections.nodeConfig = result.errors;
    }
  }

  if (hasOwn(value, "services")) {
    const result = validateServicesConfig(value.services);

    if (result.ok) {
      changeSetBuilder.services = result.config;
    } else {
      rejections.services = result.errors;
    }
  }

  if (hasRejections(rejections)) {
    return reject(Object.freeze(rejections));
  }

  return {
    ok: true,
    changeSet: Object.freeze(changeSetBuilder),
    sectionsPresent: Object.freeze(sectionsPresent),
  };
}

function collectSectionsPresent(value: JsonRecord): NodeChangeSetSection[] {
  const sectionsPresent: NodeChangeSetSection[] = [];

  for (let index = 0; index < SECTION_KEYS.length; index += 1) {
    const key = SECTION_KEYS[index];

    if (key !== undefined && hasOwn(value, key)) {
      sectionsPresent.push(key);
    }
  }

  return sectionsPresent;
}

function rejectUnknownFields(
  value: JsonRecord,
  allowed: ReadonlySet<string>,
  path: Path,
  rejections: NodeChangeSetEnvelopeRejection[],
): void {
  const keys = Object.keys(value).sort(compareStrings);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && !allowed.has(key)) {
      addEnvelopeRejection(rejections, [...path, key], "Unknown field.");
    }
  }
}

function hasRejections(rejections: NodeChangeSetRejections): boolean {
  return (
    rejections.envelope !== undefined ||
    rejections.accounts !== undefined ||
    rejections.capsules !== undefined ||
    rejections.nodeConfig !== undefined ||
    rejections.services !== undefined
  );
}

function isRecord(value: PlainJson): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function addEnvelopeRejection(
  rejections: NodeChangeSetEnvelopeRejection[],
  path: Path,
  message: string,
): void {
  rejections.push({
    message,
    path: formatPath(path),
  });
}

function reject(
  rejections: NodeChangeSetRejections,
): Extract<NodeChangeSetValidationResult, { readonly ok: false }> {
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

interface NodeChangeSetBuilder {
  nodeConfig?: NodeConfig;
  services?: ServicesConfig;
  accounts?: AccountsConfig;
  capsules?: CapsuleRegistry;
}

interface NodeChangeSetRejectionsBuilder {
  envelope?: readonly NodeChangeSetEnvelopeRejection[];
  accounts?: readonly AccountsConfigValidationError[];
  capsules?: readonly CapsuleRegistryValidationError[];
  nodeConfig?: readonly NodeConfigValidationError[];
  services?: readonly ServicesConfigValidationError[];
}
