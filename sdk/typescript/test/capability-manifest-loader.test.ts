import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  TIMESYNC_MANIFEST,
  compileCapabilityValidator,
  loadCapabilityManifest,
} from "../src/capability-manifest.ts";
import type {
  CapabilityManifest,
  CapabilityValidationResult,
  FieldSchema,
} from "../src/capability-manifest.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TIMESYNC_JSON_PATH = resolve(REPO_ROOT, "schema", "capabilities", "timesync.json");

test("loads timesync JSON and matches the committed generated export", () => {
  const manifest = loadTimesyncManifest();

  assert.deepEqual(manifest, TIMESYNC_MANIFEST);
  assert.equal(Object.hasOwn(manifest, "defaultRegistry"), false);
  assert.equal(Object.isFrozen(TIMESYNC_MANIFEST.fields.desired), true);

  const desired = TIMESYNC_MANIFEST.fields.desired;

  if (desired === undefined || desired.type !== "object") {
    assert.fail("expected desired to be an object field");
  }

  assert.equal(Object.isFrozen(desired.fields.servers), true);

  const servers = desired.fields.servers;

  if (servers === undefined || servers.type !== "array") {
    assert.fail("expected desired.servers to be an array field");
  }

  assert.equal(Object.isFrozen(servers.items), true);

  const rules = desired.crossFieldRules;

  if (rules === undefined) {
    assert.fail("expected desired cross-field rules");
  }

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];

    if (rule === undefined) {
      assert.fail("expected cross-field rule");
    }

    assert.equal(Object.isFrozen(rule), true);
  }
});

test("loaded timesync manifest validates the migrated full-request corpus", () => {
  const loadedValidator = compileCapabilityValidator(loadTimesyncManifest());
  const generatedValidator = compileCapabilityValidator(TIMESYNC_MANIFEST);
  const cases: readonly {
    readonly name: string;
    readonly input: unknown;
    readonly expectedOk: boolean;
    readonly expectedPaths?: readonly string[];
  }[] = [
    {
      expectedOk: true,
      input: {
        desired: {
          enabled: true,
          servers: ["pool.ntp.org", "time.cloudflare.com"],
        },
      },
      name: "hostnames accept",
    },
    {
      expectedOk: true,
      input: {
        desired: {
          enabled: false,
          servers: [],
        },
      },
      name: "disabled with absent servers effect",
    },
    {
      expectedOk: true,
      input: {
        desired: {
          enabled: true,
          servers: ["10.0.0.1"],
        },
      },
      name: "IPv4 literals accept",
    },
    {
      expectedOk: true,
      input: {
        desired: {
          enabled: true,
          servers: ["::1"],
        },
      },
      name: "IPv6 literals accept",
    },
    {
      expectedOk: false,
      expectedPaths: ["desired/servers/0"],
      input: {
        desired: {
          enabled: true,
          servers: ["host\n"],
        },
      },
      name: "trailing newline rejects",
    },
    {
      expectedOk: false,
      expectedPaths: ["desired/servers/0"],
      input: {
        desired: {
          enabled: true,
        servers: ["K.example"],
        },
      },
      name: "Unicode case-folding hostname rejects",
    },
    {
      expectedOk: false,
      expectedPaths: ["desired/servers"],
      input: {
        desired: {
          enabled: true,
          servers: [],
        },
      },
      name: "enabled requires non-empty servers",
    },
    {
      expectedOk: false,
      expectedPaths: ["desired/servers"],
      input: {
        desired: {
          enabled: false,
          servers: ["pool.ntp.org"],
        },
      },
      name: "disabled requires empty servers",
    },
    {
      expectedOk: false,
      expectedPaths: ["desired/servers/1"],
      input: {
        desired: {
          enabled: true,
          servers: ["A.ORG", "a.org"],
        },
      },
      name: "case-insensitive server dedupe",
    },
    {
      expectedOk: false,
      expectedPaths: ["desired/enabled"],
      input: {
        desired: {
          servers: [],
        },
      },
      name: "absent enabled rejects",
    },
    {
      expectedOk: false,
      expectedPaths: ["desired/extra"],
      input: {
        desired: {
          enabled: false,
          extra: true,
          servers: [],
        },
      },
      name: "unknown input key rejects",
    },
    {
      expectedOk: true,
      input: {
        desired: {
          enabled: true,
          servers: [`pool.${"A".repeat(48)}.org`],
        },
      },
      name: "base64ish hostname accepts",
    },
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];

    if (item === undefined) {
      assert.fail("expected corpus case");
    }

    const loaded = loadedValidator(item.input);
    const generated = generatedValidator(item.input);
    assert.deepEqual(loaded, generated, item.name);
    assert.equal(loaded.ok, item.expectedOk, item.name);

    if (!item.expectedOk) {
      assert.deepEqual(rejectedPaths(loaded), item.expectedPaths, item.name);
    }
  }

  const canonical = loadedValidator({
    desired: {
      enabled: true,
      servers: ["A.ORG"],
    },
  });

  if (!canonical.ok) {
    assert.fail(`expected uppercase hostname to validate: ${JSON.stringify(canonical.rejections)}`);
  }

  assert.deepEqual(canonical.value, {
    desired: {
      enabled: true,
      servers: ["a.org"],
    },
  });
});

test("loadCapabilityManifest rejects malformed manifests without throwing", () => {
  const cases: readonly {
    readonly name: string;
    readonly raw: unknown;
  }[] = [
    {
      name: "unknown field type",
      raw: manifestWith({
        fields: {
          enabled: {
            required: true,
            type: "maybe",
          },
        },
      }),
    },
    {
      name: "unknown schema key",
      raw: manifestWith({
        fields: {
          enabled: {
            extra: true,
            required: true,
            type: "boolean",
          },
        },
      }),
    },
    {
      name: "raw pattern key is rejected",
      raw: manifestWith({
        fields: {
          name: {
            pattern: "^[a-z]+$",
            required: true,
            type: "string",
          },
        },
      }),
    },
    {
      name: "unknown string format is rejected",
      raw: manifestWith({
        fields: {
          name: {
            format: "dnsName",
            required: true,
            type: "string",
          },
        },
      }),
    },
    {
      name: "cross-field rule references missing control",
      raw: manifestWith({
        fields: {
          servers: arrayOfStringsField(),
        },
        crossFieldRules: [
          {
            control: "enabled",
            target: "servers",
            type: "requireNonEmptyArrayWhenTrue",
          },
        ],
      }),
    },
    {
      name: "cross-field rule references non-boolean control",
      raw: manifestWith({
        fields: {
          enabled: arrayOfStringsField(),
          servers: arrayOfStringsField(),
        },
        crossFieldRules: [
          {
            control: "enabled",
            target: "servers",
            type: "requireNonEmptyArrayWhenTrue",
          },
        ],
      }),
    },
    {
      name: "unknown top-level key",
      raw: {
        ...manifestWith({}),
        extra: true,
      },
    },
    {
      name: "unsupported version",
      raw: {
        ...manifestWith({}),
        version: 2,
      },
    },
    {
      name: "defaultRegistry true is rejected",
      raw: {
        ...manifestWith({}),
        defaultRegistry: true,
      },
    },
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];

    if (item === undefined) {
      assert.fail("expected malformed case");
    }

    assert.doesNotThrow(() => {
      const result = loadCapabilityManifest(item.raw);
      assert.equal(result.ok, false, item.name);
    }, item.name);
  }
});

test("loadCapabilityManifest fails closed for hostile manifest input", () => {
  const accessorManifest: Record<string, unknown> = {
    capability: "demo.hostile",
    crossFieldRules: [],
    version: 1,
  };
  let getterReads = 0;

  Object.defineProperty(accessorManifest, "fields", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("getter should not be invoked");
    },
  });

  assert.doesNotThrow(() => {
    assert.equal(loadCapabilityManifest(accessorManifest).ok, false);
  });
  assert.equal(getterReads, 0);

  const cyclic: Record<string, unknown> = manifestWith({});
  cyclic.self = cyclic;

  assert.doesNotThrow(() => {
    assert.equal(loadCapabilityManifest(cyclic).ok, false);
    assert.equal(
      loadCapabilityManifest({
        ...manifestWith({}),
        hasOwnProperty: "shadowed",
      }).ok,
      false,
    );
  });
});

test("loadCapabilityManifest preserves special field names as own data keys", () => {
  const fields: Record<string, unknown> = {};

  Object.defineProperty(fields, "__proto__", {
    configurable: true,
    enumerable: true,
    value: booleanField(),
    writable: true,
  });
  Object.defineProperty(fields, "constructor", {
    configurable: true,
    enumerable: true,
    value: booleanField(),
    writable: true,
  });

  const result = loadCapabilityManifest(
    manifestWith({
      fields,
    }),
  );

  if (!result.ok) {
    assert.fail(`expected special field names to load: ${result.reason}`);
  }

  assert.equal(Object.hasOwn(result.manifest.fields, "__proto__"), true);
  assert.equal(Object.hasOwn(result.manifest.fields, "constructor"), true);
  assert.deepEqual(Object.keys(result.manifest.fields).sort(), ["__proto__", "constructor"]);
});

function readTimesyncManifestJson(): unknown {
  return JSON.parse(readFileSync(TIMESYNC_JSON_PATH, "utf8"));
}

function loadTimesyncManifest(): CapabilityManifest {
  const result = loadCapabilityManifest(readTimesyncManifestJson());

  if (!result.ok) {
    assert.fail(`expected timesync manifest to load: ${result.reason}`);
  }

  return result.manifest;
}

function manifestWith(
  overrides: Readonly<{
    capability?: string;
    version?: number;
    fields?: Readonly<Record<string, unknown>>;
    crossFieldRules?: readonly unknown[];
  }>,
): Record<string, unknown> {
  return {
    capability: overrides.capability ?? "demo.manifest",
    version: overrides.version ?? 1,
    fields: overrides.fields ?? {
      enabled: booleanField(),
      servers: arrayOfStringsField(),
    },
    crossFieldRules: overrides.crossFieldRules ?? [],
  };
}

function booleanField(): FieldSchema {
  return {
    required: true,
    type: "boolean",
  };
}

function arrayOfStringsField(): FieldSchema {
  return {
    items: {
      required: true,
      type: "string",
    },
    required: true,
    type: "array",
  };
}

function rejectedPaths(result: CapabilityValidationResult): readonly string[] {
  if (result.ok) {
    assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
  }

  return result.rejections.map((rejection) => rejection.path).sort();
}
