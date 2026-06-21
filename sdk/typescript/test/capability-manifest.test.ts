import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TIMESYNC_MANIFEST,
  compileCapabilityValidator,
} from "../src/capability-manifest.ts";
import type {
  CapabilityManifest,
  CapabilityValidationResult,
} from "../src/capability-manifest.ts";

const validateTimesync = compileCapabilityValidator(TIMESYNC_MANIFEST);

test("TIMESYNC manifest accepts valid enabled config", () => {
  const result = validateTimesync({
    enabled: true,
    servers: ["pool.ntp.org", "10.0.0.1"],
  });

  if (!result.ok) {
    assert.fail(`expected timesync config to validate: ${JSON.stringify(result.rejections)}`);
  }

  assert.deepEqual(result.value, {
    enabled: true,
    servers: ["pool.ntp.org", "10.0.0.1"],
  });
});

test("TIMESYNC hostnameOrIp format accepts the reviewed corpus", () => {
  const result = validateTimesync({
    enabled: true,
    servers: [
      "::ffff:192.0.2.1",
      "2001:db8::1",
      "::1",
      "10.0.0.1",
      "pool.ntp.org",
    ],
  });

  if (!result.ok) {
    assert.fail(`expected hostname/IP corpus to validate: ${JSON.stringify(result.rejections)}`);
  }

  assert.deepEqual(result.value.servers, [
    "::ffff:192.0.2.1",
    "2001:db8::1",
    "::1",
    "10.0.0.1",
    "pool.ntp.org",
  ]);
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

test("TIMESYNC rejects malformed hosts, duplicates, absent fields, and unknown keys", () => {
  assert.deepEqual(
    rejectedPaths(validateTimesync({ enabled: true, servers: ["bad_host"] })),
    ["servers/0"],
  );

  assert.deepEqual(
    rejectedPaths(validateTimesync({ enabled: true, servers: ["Pool.NTP.Org", "pool.ntp.org"] })),
    ["servers/1"],
  );

  assert.deepEqual(
    rejectedPaths(validateTimesync({ servers: [] })),
    ["enabled"],
  );

  assert.deepEqual(
    rejectedPaths(validateTimesync({ enabled: false, servers: [], extra: true })),
    ["extra"],
  );
});

test("TIMESYNC rejects inline key material and mid-string data/base64url blobs", () => {
  const longBase64Url = "A".repeat(47) + "_";

  for (const server of [
    "-----BEGIN PRIVATE KEY-----",
    "pool.ntp.orgdata:text/plain,SGVsbG8=",
    `pool.${longBase64Url}.org`,
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
    [withFieldOverrides({ name: "abc1" }), ["name"]],
    [withFieldOverrides({ name: "abcde" }), ["name"]],
    [withFieldOverrides({ mode: "auto" }), ["mode"]],
    [withFieldOverrides({ count: 0 }), ["count"]],
    [withFieldOverrides({ count: 4 }), ["count"]],
    [withFieldOverrides({ count: 1.5 }), ["count"]],
    [withFieldOverrides({ flag: "true" }), ["flag"]],
    [withFieldOverrides({ tags: [] }), ["tags"]],
    [withFieldOverrides({ tags: ["a", "b", "c"] }), ["tags"]],
    [withFieldOverrides({ tags: ["a", "a"] }), ["tags/1"]],
    [withFieldOverrides({ tags: [1] }), ["tags/0"]],
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
    mode: Object.freeze({
      enum: Object.freeze(["on", "off"]),
      required: true,
      type: "string",
    }),
    name: Object.freeze({
      maxLength: 4,
      pattern: "^[a-z]+$",
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
        format: "hostnameOrIp",
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

function withFieldOverrides(overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    count: 2,
    flag: true,
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
