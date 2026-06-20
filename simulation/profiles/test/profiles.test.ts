import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REQUIRED_PROFILES,
  coversRequiredProfiles,
  validateSimulationProfiles,
  type SimulationFailureTest,
  type SimulationHealthCheck,
  type SimulationProfile,
  type SimulationProfileValidationError,
} from "../src/profiles.ts";

test("valid profile set validates and required coverage reports missing profiles", () => {
  const result = validateSimulationProfiles(validProfileSet());

  if (!result.ok) {
    assert.fail(formatErrors(result.errors));
  }

  assert.equal(result.ok, true);

  assert.deepEqual(profileKinds(result.profiles), Array.from(REQUIRED_PROFILES));
  assert.deepEqual(coversRequiredProfiles(result.profiles), { ok: true, missing: [] });

  const partialCoverage = coversRequiredProfiles(["low-memory", "offline"]);

  assert.equal(partialCoverage.ok, false);
  assert.deepEqual(partialCoverage.missing, [
    "no-accelerator",
    "architecture-migration",
    "power-loss",
    "network-partition",
  ]);
});

test("unknown profile kind and partial profile are rejected with precise paths", () => {
  const unknownKind = validProfileSet() as unknown[];
  unknownKind[0] = {
    kind: "solar-flare",
    expectedHealthChecks: [],
    failureTests: [],
  };

  assertPath(reject(unknownKind), "0/kind");

  const partial = [
    {
      kind: "architecture-migration",
      from: "x86_64",
    },
  ];

  const errors = reject(partial);

  assertPath(errors, "0/expectedHealthChecks");
  assertPath(errors, "0/failureTests");
  assertPath(errors, "0/to");
});

test("partial low-memory profile fails closed without throwing", () => {
  const errors = reject([{ kind: "low-memory" }]);

  assertPath(errors, "0/expectedHealthChecks");
  assertPath(errors, "0/failureTests");
  assertPath(errors, "0/memoryMiB");
});

test("cyclic input is rejected without throwing", () => {
  const cyclic = validProfileSet() as unknown as Record<string, unknown>[];
  const first = cyclic[0];

  assert.notEqual(first, undefined);

  if (first !== undefined) {
    first.self = cyclic;
  }

  assertPath(reject(cyclic), "0/self");
});

test("method-shadowed arrays are rejected without throwing", () => {
  const profiles = validProfileSet() as unknown as Record<string, unknown>;

  profiles.some = () => true;
  profiles.includes = () => true;
  profiles.find = () => ({ kind: "low-memory" });

  const errors = reject(profiles);

  assertPath(errors, "some");
});

test("hostile iterators are rejected without throwing", () => {
  const profiles = validProfileSet();

  Object.defineProperty(profiles, Symbol.iterator, {
    value: function* hostile() {
      yield { kind: "low-memory" };
    },
  });

  assertPath(reject(profiles), "Symbol(Symbol.iterator)");
});

test("throwing getters are rejected without throwing", () => {
  const profiles = validProfileSet() as unknown as Record<string, unknown>[];
  const first = profiles[0];

  assert.notEqual(first, undefined);

  if (first !== undefined) {
    Object.defineProperty(first, "memoryMiB", {
      enumerable: true,
      get() {
        throw new Error("getter should not escape validation");
      },
    });
  }

  assertPath(reject(profiles), "0/memoryMiB");
});

test("throwing proxy input is rejected without throwing", () => {
  const proxy = new Proxy(validProfileSet(), {
    get(target, key, receiver) {
      if (key === "length") {
        throw new Error("length should not escape validation");
      }

      return Reflect.get(target, key, receiver);
    },
  });

  assertPath(reject(proxy), "");
});

function validProfileSet(): SimulationProfile[] {
  return [
    {
      kind: "low-memory",
      memoryMiB: 512,
      expectedHealthChecks: healthChecks(),
      failureTests: failureTests("memory pressure"),
    },
    {
      kind: "offline",
      durationSeconds: 300,
      expectedHealthChecks: healthChecks(),
      failureTests: failureTests("vendor services blocked"),
    },
    {
      kind: "no-accelerator",
      accelerators: ["gpu", "npu"],
      expectedHealthChecks: healthChecks(),
      failureTests: failureTests("accelerator unavailable"),
    },
    {
      kind: "architecture-migration",
      from: "x86_64",
      to: "arm64",
      expectedHealthChecks: healthChecks(),
      failureTests: failureTests("post-migration verification"),
    },
    {
      kind: "power-loss",
      cycles: 10,
      outageSeconds: 30,
      expectedHealthChecks: healthChecks(),
      failureTests: failureTests("forced power cycle"),
    },
    {
      kind: "network-partition",
      partitionCount: 2,
      durationSeconds: 120,
      expectedHealthChecks: healthChecks(),
      failureTests: failureTests("peer node partition"),
    },
  ];
}

function healthChecks(): SimulationHealthCheck[] {
  return [
    {
      name: "service-ready",
      type: "lifecycle",
      target: "service.ready",
      intervalSeconds: 5,
      timeoutSeconds: 1,
    },
  ];
}

function failureTests(fault: string): SimulationFailureTest[] {
  return [
    {
      name: "fault-recovery",
      fault,
      expectedHealth: "service-ready",
      timeoutSeconds: 60,
    },
  ];
}

function reject(value: unknown): readonly SimulationProfileValidationError[] {
  let result: ReturnType<typeof validateSimulationProfiles> | undefined;

  assert.doesNotThrow(() => {
    result = validateSimulationProfiles(value);
  });

  assert.notEqual(result, undefined);

  if (result === undefined || result.ok) {
    assert.fail(`expected validation to fail: ${JSON.stringify(result)}`);
  }

  return result.errors;
}

function assertPath(
  errors: readonly SimulationProfileValidationError[],
  path: string,
): void {
  let found = false;

  for (let index = 0; index < errors.length; index += 1) {
    if (errors[index]?.path === path) {
      found = true;
      break;
    }
  }

  assert.equal(found, true, `expected ${path} in ${formatErrors(errors)}`);
}

function profileKinds(profiles: readonly SimulationProfile[]): string[] {
  const kinds: string[] = [];

  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index];

    if (profile !== undefined) {
      kinds[kinds.length] = profile.kind;
    }
  }

  return kinds;
}

function formatErrors(errors: readonly SimulationProfileValidationError[]): string {
  const formatted: string[] = [];

  for (let index = 0; index < errors.length; index += 1) {
    const error = errors[index];

    if (error !== undefined) {
      formatted[formatted.length] = `${error.path}: ${error.message}`;
    }
  }

  return formatted.join("\n");
}
