import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NODE_CONFIG_MANIFEST,
  TIMESYNC_MANIFEST,
  compileCapabilityValidator,
} from "../src/capability-manifest.ts";
import type {
  CapabilityManifest,
  CapabilityValidationResult,
} from "../src/capability-manifest.ts";

const validateTimesync = compileCapabilityValidator(TIMESYNC_MANIFEST);
const validateNodeConfig = compileCapabilityValidator(NODE_CONFIG_MANIFEST);

test("TIMESYNC manifest accepts valid enabled hostname config", () => {
  const result = validateTimesync({
    enabled: true,
    servers: ["pool.ntp.org", "time.cloudflare.com"],
  });

  if (!result.ok) {
    assert.fail(`expected timesync config to validate: ${JSON.stringify(result.rejections)}`);
  }

  assert.deepEqual(result.value, {
    enabled: true,
    servers: ["pool.ntp.org", "time.cloudflare.com"],
  });
});

test("TIMESYNC cross-field rules enforce enabled and servers together", () => {
  assert.deepEqual(
    rejectedPaths(validateTimesync({ enabled: true, servers: [] })),
    ["servers"],
  );

  assert.deepEqual(
    rejectedPaths(validateTimesync({ enabled: false, servers: ["pool.ntp.org"] })),
    ["servers"],
  );

  const disabled = validateTimesync({ enabled: false, servers: [] });

  if (!disabled.ok) {
    assert.fail(`expected disabled empty-server config to validate: ${JSON.stringify(disabled.rejections)}`);
  }

  assert.deepEqual(disabled.value, {
    enabled: false,
    servers: [],
  });
});

test("TIMESYNC rejects malformed hostnames and out-of-scope IP literals", () => {
  const tooLongHostname = Array.from({ length: 128 }, () => "a").join(".");

  for (const server of [
    "bad host",
    "bad_host",
    "-bad.example",
    "bad-.example",
    "10.0.0.1",
    "::1",
    "host\n",
    "K.example",
    "İ.example",
  ]) {
    assert.deepEqual(
      rejectedPaths(validateTimesync({ enabled: true, servers: [server] })),
      ["servers/0"],
      `${server} must reject`,
    );
  }

  assert.equal(
    rejectedPaths(validateTimesync({ enabled: true, servers: [tooLongHostname] })).includes("servers/0"),
    true,
    "hostname over 253 chars must reject",
  );
});

test("TIMESYNC lowercases hosts before return and case-insensitive uniqueness", () => {
  const canonical = validateTimesync({ enabled: true, servers: ["A.ORG"] });

  if (!canonical.ok) {
    assert.fail(`expected uppercase hostname to validate: ${JSON.stringify(canonical.rejections)}`);
  }

  assert.deepEqual(canonical.value, {
    enabled: true,
    servers: ["a.org"],
  });

  assert.deepEqual(
    rejectedPaths(validateTimesync({ enabled: true, servers: ["A.ORG", "a.org"] })),
    ["servers/1"],
  );
});

test("TIMESYNC rejects absent required fields and unknown keys", () => {
  assert.deepEqual(
    rejectedPaths(validateTimesync({ servers: [] })),
    ["enabled"],
  );

  assert.deepEqual(
    rejectedPaths(validateTimesync({ enabled: false, servers: [], extra: true })),
    ["extra"],
  );
});

test("object fields validate nested full-request shape", () => {
  const result = validateNodeConfig({
    desired: {
      mode: "normal",
      remoteAccess: "disabled",
    },
  });

  if (!result.ok) {
    assert.fail(`expected node.config request to validate: ${JSON.stringify(result.rejections)}`);
  }

  assert.deepEqual(result.value, {
    desired: {
      mode: "normal",
      remoteAccess: "disabled",
    },
  });

  assert.deepEqual(
    rejectedPaths(validateNodeConfig({ desired: { mode: "normal" } })),
    ["desired/remoteAccess"],
  );
  assert.deepEqual(
    rejectedPaths(validateNodeConfig({ desired: { mode: "normal", remoteAccess: "disabled", extra: true } })),
    ["desired/extra"],
  );
});

test("TIMESYNC rejects inline key material", () => {
  for (const server of [
    "-----BEGIN PRIVATE KEY-----",
    "pool.ntp.orgdata:text/plain,SGVsbG8=",
    `pool.${"A".repeat(48)}.org`,
  ]) {
    assert.equal(
      rejectedPaths(validateTimesync({ enabled: true, servers: [server] })).includes("servers/0"),
      true,
      `${server} must reject`,
    );
  }
});

test("dialect field rules reject each violation", () => {
  const validate = compileCapabilityValidator(FIELD_RULE_MANIFEST);

  const cases: readonly [unknown, readonly string[]][] = [
    [withFieldOverrides({ name: "abcde" }), ["name"]],
    [withFieldOverrides({ host: "bad_host" }), ["host"]],
    [withFieldOverrides({ mode: "auto" }), ["mode"]],
    [withFieldOverrides({ count: 0 }), ["count"]],
    [withFieldOverrides({ count: 4 }), ["count"]],
    [withFieldOverrides({ count: 1.5 }), ["count"]],
    [withFieldOverrides({ flag: "true" }), ["flag"]],
    [withFieldOverrides({ tags: [] }), ["tags"]],
    [withFieldOverrides({ tags: ["a", "b", "c"] }), ["tags"]],
    [withFieldOverrides({ tags: ["a", "a"] }), ["tags/1"]],
    [withFieldOverrides({ tags: [1] }), ["tags/0"]],
    [withFieldOverrides({ label: "Mixed1" }), ["label"]],
    [withFieldOverrides({ note: "prefixdata:text/plain,hello" }), ["note"]],
    [withFieldOverrides({ note: `prefix${"A".repeat(47)}_suffix` }), ["note"]],
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];

    if (item === undefined) {
      assert.fail("expected field-rule case");
    }

    const [input, expectedPaths] = item;
    assert.deepEqual(rejectedPaths(validate(input)), expectedPaths);
  }
});

test("dialect lowercase primitive canonicalizes returned values", () => {
  const validate = compileCapabilityValidator(FIELD_RULE_MANIFEST);
  const result = validate(withFieldOverrides({ label: "MiXeD" }));

  if (!result.ok) {
    assert.fail(`expected lowercase field to validate: ${JSON.stringify(result.rejections)}`);
  }

  assert.equal(result.value.label, "mixed");
});

test("dialect lowercase primitive is ASCII-only", () => {
  const validate = compileCapabilityValidator(LOWERCASE_MANIFEST);
  const result = validate({ value: "İKABC" });

  if (!result.ok) {
    assert.fail(`expected ASCII-only lowercase field to validate: ${JSON.stringify(result.rejections)}`);
  }

  assert.equal(result.value.value, "İKabc");
});

test("integer fields use JS float64 JSON number semantics", () => {
  const validate = compileCapabilityValidator(INTEGER_ZERO_MANIFEST);
  const underflow = validate(JSON.parse('{"count":1e-1000}'));

  if (!underflow.ok) {
    assert.fail(`expected underflowed integer to validate: ${JSON.stringify(underflow.rejections)}`);
  }

  assert.equal(underflow.value.count, 0);
  assert.deepEqual(rejectedPaths(validate(JSON.parse('{"count":1e400}'))), [""]);
});

test("dialect cross-field rules reject each violation", () => {
  const validate = compileCapabilityValidator(CROSS_FIELD_RULE_MANIFEST);

  assert.deepEqual(
    rejectedPaths(validate({ enabled: true, servers: [] })),
    ["servers"],
  );

  assert.deepEqual(
    rejectedPaths(validate({ enabled: false, servers: ["pool.ntp.org"] })),
    ["servers"],
  );

  assert.equal(validate({ enabled: true, servers: ["pool.ntp.org"] }).ok, true);
  assert.equal(validate({ enabled: false, servers: [] }).ok, true);
});

test("hostile input fails closed without invoking accessors", () => {
  const hostile: Record<string, unknown> = {
    servers: [],
  };
  let getterReads = 0;

  Object.defineProperty(hostile, "enabled", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("getter should not be invoked");
    },
  });

  assert.doesNotThrow(() => {
    const result = validateTimesync(hostile);
    assert.equal(result.ok, false);
  });
  assert.equal(getterReads, 0);
});

test("cyclic and method-shadowing inputs fail closed", () => {
  const cyclic: Record<string, unknown> = {
    enabled: true,
    servers: ["pool.ntp.org"],
  };
  cyclic.self = cyclic;

  assert.doesNotThrow(() => {
    assert.equal(validateTimesync(cyclic).ok, false);
    assert.equal(
      validateTimesync({
        enabled: true,
        servers: ["pool.ntp.org"],
        hasOwnProperty: "shadowed",
      }).ok,
      false,
    );
  });
});

const FIELD_RULE_MANIFEST = Object.freeze({
  capability: "demo.fields",
  fields: Object.freeze({
    count: Object.freeze({
      maximum: 3,
      minimum: 1,
      required: true,
      type: "integer",
    }),
    flag: Object.freeze({
      required: true,
      type: "boolean",
    }),
    label: Object.freeze({
      enum: Object.freeze(["mixed"]),
      lowercase: true,
      required: true,
      type: "string",
    }),
    host: Object.freeze({
      format: "hostnameRFC1123",
      lowercase: true,
      maxLength: 253,
      required: true,
      type: "string",
    }),
    mode: Object.freeze({
      enum: Object.freeze(["on", "off"]),
      required: true,
      type: "string",
    }),
    name: Object.freeze({
      maxLength: 4,
      required: true,
      type: "string",
    }),
    note: Object.freeze({
      noInlineSecrets: true,
      required: true,
      type: "string",
    }),
    tags: Object.freeze({
      items: Object.freeze({
        required: true,
        type: "string",
      }),
      maxItems: 2,
      minItems: 1,
      required: true,
      type: "array",
      uniqueItems: true,
    }),
  }),
  crossFieldRules: Object.freeze([]),
} satisfies CapabilityManifest);

const CROSS_FIELD_RULE_MANIFEST = Object.freeze({
  capability: "demo.cross",
  fields: Object.freeze({
    enabled: Object.freeze({
      required: true,
      type: "boolean",
    }),
    servers: Object.freeze({
      items: Object.freeze({
        format: "hostnameRFC1123",
        lowercase: true,
        required: true,
        type: "string",
      }),
      maxItems: 8,
      required: true,
      type: "array",
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

const LOWERCASE_MANIFEST = Object.freeze({
  capability: "demo.lowercase",
  fields: Object.freeze({
    value: Object.freeze({
      lowercase: true,
      required: true,
      type: "string",
    }),
  }),
  crossFieldRules: Object.freeze([]),
} satisfies CapabilityManifest);

const INTEGER_ZERO_MANIFEST = Object.freeze({
  capability: "demo.integer-zero",
  fields: Object.freeze({
    count: Object.freeze({
      maximum: 0,
      minimum: 0,
      required: true,
      type: "integer",
    }),
  }),
  crossFieldRules: Object.freeze([]),
} satisfies CapabilityManifest);

function withFieldOverrides(overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    count: 2,
    flag: true,
    host: "valid.example",
    label: "mixed",
    mode: "on",
    name: "abcd",
    note: "public-note",
    tags: ["a"],
    ...overrides,
  };
}

function rejectedPaths(result: CapabilityValidationResult): readonly string[] {
  if (result.ok) {
    assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
  }

  return result.rejections.map((rejection) => rejection.path).sort();
}
