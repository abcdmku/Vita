import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { safeNormalize as upstreamSafeNormalize } from "../../../../../../../sdk/typescript/src/safe-normalize.ts";
import { safeNormalize as vendoredSafeNormalize } from "./vita/safe-normalize.ts";

type NormalizeResult = ReturnType<typeof vendoredSafeNormalize>;

interface NormalizeCase {
  readonly name: string;
  readonly value: unknown;
  readonly ok: boolean;
}

const VENDORED_HEADER = Buffer.from(
  "// Vendored from sdk/typescript/src/safe-normalize.ts\n",
  "utf8",
);

test("vendored safeNormalize matches upstream on plain and exotic inputs", () => {
  const proxyTraps: string[] = [];
  const proxy = new Proxy(
    { ok: true },
    {
      get() {
        proxyTraps.push("get");
        throw new Error("proxy get trap");
      },
      getOwnPropertyDescriptor() {
        proxyTraps.push("getOwnPropertyDescriptor");
        throw new Error("proxy descriptor trap");
      },
      getPrototypeOf() {
        proxyTraps.push("getPrototypeOf");
        throw new Error("proxy prototype trap");
      },
      ownKeys() {
        proxyTraps.push("ownKeys");
        throw new Error("proxy ownKeys trap");
      },
    },
  );

  const accessorProperty: Record<string, unknown> = {};
  let accessorReads = 0;
  Object.defineProperty(accessorProperty, "value", {
    enumerable: true,
    get() {
      accessorReads += 1;
      throw new Error("getter should not run");
    },
  });

  const nullProto = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(nullProto, "name", {
    configurable: true,
    enumerable: true,
    value: "vita",
    writable: true,
  });

  const cases: readonly NormalizeCase[] = Object.freeze([
    Object.freeze({
      name: "Proxy rejects",
      ok: false,
      value: proxy,
    }),
    Object.freeze({
      name: "accessor-property rejects",
      ok: false,
      value: accessorProperty,
    }),
    Object.freeze({
      name: "Date rejects",
      ok: false,
      value: new Date(0),
    }),
    Object.freeze({
      name: "Map rejects",
      ok: false,
      value: new Map<string, unknown>([["name", "vita"]]),
    }),
    Object.freeze({
      name: "plain object accepts",
      ok: true,
      value: Object.freeze({
        enabled: true,
        nested: Object.freeze(["value", 1, null]),
      }),
    }),
    Object.freeze({
      name: "null-prototype object accepts",
      ok: true,
      value: nullProto,
    }),
  ]);

  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];

    if (item === undefined) {
      continue;
    }

    const vendored = normalize(vendoredSafeNormalize, item.value);
    const upstream = normalize(upstreamSafeNormalize, item.value);

    assert.deepEqual(vendored, upstream, item.name);
    assert.equal(vendored.ok, item.ok, item.name);
    assert.equal(upstream.ok, item.ok, item.name);
  }

  assert.deepEqual(proxyTraps, []);
  assert.equal(accessorReads, 0);
});

test("vendored safeNormalize body is byte-identical to upstream except header", () => {
  const vendored = readFileSync(
    fileURLToPath(new URL("./vita/safe-normalize.ts", import.meta.url)),
  );
  const upstream = readFileSync(
    fileURLToPath(
      new URL("../../../../../../../sdk/typescript/src/safe-normalize.ts", import.meta.url),
    ),
  );

  assert.equal(
    vendored.subarray(0, VENDORED_HEADER.length).equals(VENDORED_HEADER),
    true,
  );
  assert.equal(Buffer.compare(vendored.subarray(VENDORED_HEADER.length), upstream), 0);
});

function normalize(
  fn: (value: unknown) => NormalizeResult,
  value: unknown,
): NormalizeResult {
  let result: NormalizeResult | undefined;

  assert.doesNotThrow(() => {
    result = fn(value);
  });

  if (result === undefined) {
    assert.fail("safeNormalize returned undefined");
  }

  return result;
}
