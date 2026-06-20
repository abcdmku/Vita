import assert from "node:assert/strict";
import { test } from "node:test";

import { safeNormalize } from "../src/safe-normalize.ts";
import type {
  PlainJson,
  PlainJsonObject,
  SafeNormalizeOptions,
  SafeNormalizeResult,
} from "../src/safe-normalize.ts";

test("valid nested plain data normalizes to a frozen deep clone", () => {
  const source = {
    enabled: true,
    meta: {
      count: 2,
      flags: [true, false, null],
    },
    name: "vita",
    services: [
      {
        id: "search",
        memory: "1GiB",
      },
    ],
  };
  const result = safeNormalize(source);

  if (!result.ok) {
    assert.fail(result.reason);
  }

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    enabled: true,
    meta: {
      count: 2,
      flags: [true, false, null],
    },
    name: "vita",
    services: [
      {
        id: "search",
        memory: "1GiB",
      },
    ],
  });

  assert.equal(Object.isFrozen(result.value), true);
  const clone = assertObject(result.value);
  const meta = assertObject(clone.meta);
  const flags = assertArray(meta.flags);
  const services = assertArray(clone.services);
  const firstService = services[0];

  if (firstService === undefined) {
    assert.fail("expected first service");
  }

  assert.equal(Object.isFrozen(meta), true);
  assert.equal(Object.isFrozen(flags), true);
  assert.equal(Object.isFrozen(services), true);
  assert.equal(Object.isFrozen(firstService), true);

  source.name = "changed";
  source.meta.count = 99;
  source.meta.flags[0] = false;
  const mutableService = source.services[0];

  if (mutableService === undefined) {
    assert.fail("expected source service");
  }

  mutableService.id = "changed";

  assert.deepEqual(result.value, {
    enabled: true,
    meta: {
      count: 2,
      flags: [true, false, null],
    },
    name: "vita",
    services: [
      {
        id: "search",
        memory: "1GiB",
      },
    ],
  });
});

test("adversarial inputs reject without throwing", () => {
  class Box {
    readonly value = 1;
  }

  const getterObject: Record<string, unknown> = {};
  let getterReads = 0;
  Object.defineProperty(getterObject, "value", {
    enumerable: true,
    get() {
      getterReads += 1;

      if (getterReads > 1) {
        throw new Error("getter read twice");
      }

      return "flipped";
    },
  });

  const methodShadowedArray = [1, 2, 3];
  Object.defineProperty(methodShadowedArray, "map", {
    enumerable: true,
    value() {
      return [];
    },
  });

  const hostileIterator = [1, 2, 3];
  let iteratorReads = 0;
  Object.defineProperty(hostileIterator, Symbol.iterator, {
    enumerable: true,
    get() {
      iteratorReads += 1;
      throw new Error("iterator read");
    },
  });

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  const adversarialInputs: readonly unknown[] = [
    undefined,
    null,
    "text",
    42,
    false,
    getterObject,
    new Date(),
    new Map(),
    new Set(),
    new Proxy({}, {}),
    new Box(),
    methodShadowedArray,
    hostileIterator,
    cyclic,
    {
      handler: () => "nope",
    },
    {
      marker: Symbol("nope"),
    },
    {
      value: Number.POSITIVE_INFINITY,
    },
    {
      value: Number.NaN,
    },
  ];

  for (let index = 0; index < adversarialInputs.length; index += 1) {
    assertRejected(adversarialInputs[index]);
  }

  assert.equal(getterReads, 0);
  assert.equal(iteratorReads, 0);
});

test("accessor properties are rejected without a second read", () => {
  const input: Record<string, unknown> = {};
  let getterReads = 0;
  Object.defineProperty(input, "flipping", {
    enumerable: true,
    get() {
      getterReads += 1;

      if (getterReads > 1) {
        throw new Error("second getter read");
      }

      return getterReads;
    },
  });

  assertRejected(input);
  assert.equal(getterReads, 0);
});

test("catch returns a static rejection when the thrown error has a hostile message getter", () => {
  const originalGetPrototypeOf = Object.getPrototypeOf;
  const hostileError = new Error("hidden");
  Object.defineProperty(hostileError, "message", {
    configurable: true,
    get() {
      throw new Error("message getter read");
    },
  });
  const throwingGetPrototypeOf: typeof Object.getPrototypeOf = () => {
    throw hostileError;
  };

  Object.getPrototypeOf = throwingGetPrototypeOf;

  try {
    let result: SafeNormalizeResult | undefined;

    assert.doesNotThrow(() => {
      result = safeNormalize({ value: true });
    });
    assert.equal(result?.ok, false);
  } finally {
    Object.getPrototypeOf = originalGetPrototypeOf;
  }
});

test("wide objects reject on node budget before descriptor walking", () => {
  const wide: Record<string, unknown> = {};

  for (let index = 0; index < 20; index += 1) {
    wide[`key${index}`] = index;
  }

  const originalGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  let descriptorReads = 0;
  const countingGetOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor = (
    target,
    propertyKey,
  ) => {
    if (target === wide) {
      descriptorReads += 1;
    }

    return originalGetOwnPropertyDescriptor(target, propertyKey);
  };

  Object.getOwnPropertyDescriptor = countingGetOwnPropertyDescriptor;

  try {
    assertRejected(wide, { maxNodes: 3 });
    assert.equal(descriptorReads, 0);
  } finally {
    Object.getOwnPropertyDescriptor = originalGetOwnPropertyDescriptor;
  }
});

test("hostile proxy traps are not invoked before rejection", () => {
  const traps: string[] = [];
  const proxy = new Proxy(
    {},
    {
      get() {
        traps.push("get");
        throw new Error("get trap");
      },
      getOwnPropertyDescriptor() {
        traps.push("getOwnPropertyDescriptor");
        throw new Error("descriptor trap");
      },
      getPrototypeOf() {
        traps.push("getPrototypeOf");
        throw new Error("prototype trap");
      },
      ownKeys() {
        traps.push("ownKeys");
        throw new Error("ownKeys trap");
      },
    },
  );

  assertRejected(proxy);
  assert.deepEqual(traps, []);
});

test("bigint is rejected by default and can be explicitly encoded as a string", () => {
  assertRejected({ id: 1n });

  const result = safeNormalize({ id: 1n }, { bigint: "string" });

  if (!result.ok) {
    assert.fail(result.reason);
  }

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { id: "1" });
});

function assertRejected(value: unknown, opts?: SafeNormalizeOptions): void {
  let result: SafeNormalizeResult | undefined;

  assert.doesNotThrow(() => {
    result = safeNormalize(value, opts);
  });
  assert.equal(result?.ok, false);
}

function assertObject(value: PlainJson | undefined): PlainJsonObject {
  if (!isPlainJsonObjectValue(value)) {
    assert.fail("expected object");
  }

  return value;
}

function assertArray(value: PlainJson | undefined): readonly PlainJson[] {
  if (!isPlainJsonArrayValue(value)) {
    assert.fail("expected array");
  }

  return value;
}

function isPlainJsonObjectValue(value: PlainJson | undefined): value is PlainJsonObject {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function isPlainJsonArrayValue(value: PlainJson | undefined): value is readonly PlainJson[] {
  return Array.isArray(value);
}
