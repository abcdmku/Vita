import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MODULE_FILE = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCHEMA_DIR = path.join(ROOT_DIR, "schema", "capabilities");
const GENERATED_FILE = path.join(
  ROOT_DIR,
  "sdk",
  "typescript",
  "src",
  "generated",
  "capability-manifests.generated.ts",
);
const LOADER_MODULE = path.join(ROOT_DIR, "sdk", "typescript", "src", "capability-manifest.ts");
const ROOT_DIR_WITH_SEPARATOR = `${ROOT_DIR}${path.sep}`;
const PREFERRED_KEY_ORDER = [
  "capability",
  "version",
  "defaultRegistry",
  "fields",
  "crossFieldRules",
  "desired",
  "mode",
  "remoteAccess",
  "enabled",
  "servers",
  "items",
  "format",
  "lowercase",
  "maxLength",
  "noInlineSecrets",
  "required",
  "type",
  "maxItems",
  "minItems",
  "uniqueItems",
  "control",
  "target",
];

registerTypeScriptStripHook();

export async function generateCapabilityManifestsSource() {
  const manifests = await readCapabilityManifests();
  const sources = manifests.map((manifest) => manifest.sourcePath).join(", ");
  const lines = [
    `// DO NOT EDIT — generated from ${sources}`,
    "",
    'import type { CapabilityManifest } from "../capability-manifest.ts";',
    "",
  ];

  for (let index = 0; index < manifests.length; index += 1) {
    const manifest = manifests[index];

    if (manifest === undefined) {
      continue;
    }

    lines.push(
      `export const ${manifest.constantName} = ${formatFrozenValue(manifest.value, 0)} satisfies CapabilityManifest;`,
      "",
    );
  }

  lines.push(
    `export const DEFAULT_CAPABILITY_MANIFESTS = ${formatDefaultManifestRegistry(manifests)} satisfies Readonly<Record<string, CapabilityManifest>>;`,
    "",
  );

  return `${lines.join("\n")}\n`;
}

export async function writeCapabilityManifests() {
  const source = await generateCapabilityManifestsSource();
  await mkdir(path.dirname(GENERATED_FILE), { recursive: true });
  await writeFile(GENERATED_FILE, source, "utf8");
}

async function readCapabilityManifests() {
  const entries = (await readdir(SCHEMA_DIR))
    .filter((entry) => entry.endsWith(".json"))
    .sort(compareStrings);
  const loadCapabilityManifest = await loadManifestLoader();
  const manifests = [];

  if (entries.length === 0) {
    throw new Error(`No capability manifests found in ${relativePath(SCHEMA_DIR)}.`);
  }

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (entry === undefined) {
      continue;
    }

    const filePath = path.join(SCHEMA_DIR, entry);
    const raw = JSON.parse(await readFile(filePath, "utf8"));
    const loaded = loadCapabilityManifest(raw);

    if (!loaded.ok) {
      throw new Error(`${relativePath(filePath)}: ${loaded.reason}`);
    }

    manifests.push({
      constantName: constantNameForManifest(entry),
      sourcePath: relativePath(filePath),
      value: loaded.manifest,
    });
  }

  return manifests;
}

async function loadManifestLoader() {
  const module = await import(pathToFileURL(LOADER_MODULE).href);

  if (typeof module.loadCapabilityManifest !== "function") {
    throw new Error("capability-manifest.ts does not export loadCapabilityManifest.");
  }

  return module.loadCapabilityManifest;
}

function formatFrozenValue(value, depth) {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "Object.freeze([])";
    }

    const childIndent = indent(depth + 1);
    const currentIndent = indent(depth);
    const items = value.map((item) => `${childIndent}${formatFrozenValue(item, depth + 1)},`);

    return `Object.freeze([\n${items.join("\n")}\n${currentIndent}])`;
  }

  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort(compareManifestKeys);

    if (keys.length === 0) {
      return "Object.freeze({})";
    }

    const childIndent = indent(depth + 1);
    const currentIndent = indent(depth);
    const entries = keys.map((key) => {
      const formattedKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? key : JSON.stringify(key);

      return `${childIndent}${formattedKey}: ${formatFrozenValue(value[key], depth + 1)},`;
    });

    return `Object.freeze({\n${entries.join("\n")}\n${currentIndent}})`;
  }

  throw new Error("Capability manifests must contain only JSON data.");
}

function constantNameForManifest(fileName) {
  const stem = fileName.slice(0, -".json".length);
  const normalized = stem.replace(/[^A-Za-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");

  if (normalized.length === 0) {
    throw new Error(`Cannot derive constant name for ${fileName}.`);
  }

  return `${normalized.toUpperCase()}_MANIFEST`;
}

function formatDefaultManifestRegistry(manifests) {
  const entries = manifests
    .filter((manifest) => manifest.value.defaultRegistry !== false)
    .sort((left, right) => compareStrings(left.value.capability, right.value.capability));

  if (entries.length === 0) {
    return "Object.freeze({})";
  }

  const lines = entries.map((manifest) =>
    `  ${JSON.stringify(manifest.value.capability)}: ${manifest.constantName},`
  );

  return `Object.freeze({\n${lines.join("\n")}\n})`;
}

function compareManifestKeys(left, right) {
  const leftIndex = PREFERRED_KEY_ORDER.indexOf(left);
  const rightIndex = PREFERRED_KEY_ORDER.indexOf(right);
  const leftRank = leftIndex === -1 ? PREFERRED_KEY_ORDER.length : leftIndex;
  const rightRank = rightIndex === -1 ? PREFERRED_KEY_ORDER.length : rightIndex;

  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  return compareStrings(left, right);
}

function indent(depth) {
  return "  ".repeat(depth);
}

function relativePath(filePath) {
  return path.relative(ROOT_DIR, filePath).replaceAll(path.sep, "/");
}

function compareStrings(left, right) {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function isCliEntrypoint() {
  const entrypoint = process.argv[1];

  if (entrypoint === undefined) {
    return false;
  }

  return path.normalize(path.resolve(process.cwd(), entrypoint)).toLowerCase() ===
    path.normalize(MODULE_FILE).toLowerCase();
}

function registerTypeScriptStripHook() {
  registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith("file:") || !url.endsWith(".ts")) {
        return nextLoad(url, context);
      }

      const filePath = fileURLToPath(url);

      if (!isRepoLocalPath(filePath)) {
        return nextLoad(url, context);
      }

      return {
        format: "module",
        shortCircuit: true,
        source: stripTypeScriptTypes(readFileSync(filePath, "utf8"), {
          mode: "strip",
        }),
      };
    },
  });
}

function isRepoLocalPath(filePath) {
  const normalized = path.normalize(filePath);

  return normalized === ROOT_DIR || normalized.startsWith(ROOT_DIR_WITH_SEPARATOR);
}

if (isCliEntrypoint()) {
  if (process.argv.includes("--stdout")) {
    process.stdout.write(await generateCapabilityManifestsSource());
  } else {
    await writeCapabilityManifests();
  }
}
