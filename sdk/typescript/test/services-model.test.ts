import assert from "node:assert/strict";
import { test } from "node:test";

import { validateServicesConfig } from "../src/services-model.ts";
import type {
  Result,
  ServiceEntry,
  ServicesConfig,
  ValidationError,
} from "../src/services-model.ts";

test("a valid services config validates", () => {
  const config = validConfig();
  const result = validateServicesConfig(config);

  if (!result.ok) {
    assert.fail(`expected services config to validate: ${JSON.stringify(result.errors)}`);
  }

  assert.deepEqual(result.config, config);
  assert.equal(result.value, result.config);
});

test("an explicit empty services array validates", () => {
  const result = validateServicesConfig({ services: [] });

  if (!result.ok) {
    assert.fail(`expected empty services array to validate: ${JSON.stringify(result.errors)}`);
  }

  assert.deepEqual(result.config.services, []);
});

test("an absent services field is rejected", () => {
  assert.deepEqual(rejectedPaths(validateServicesConfig({})), ["services"]);
});

test("systemd unit names require recognized suffixes and valid prefixes", () => {
  const maxLengthName = `${"svc.".repeat(61)}svcx.service`;
  const tooLongName = `${"svc.".repeat(61)}svcx1.service`;

  assert.equal(validateServicesConfig({ services: [{ name: "ssh.service", enabled: true }] }).ok, true);
  assert.equal(validateServicesConfig({ services: [{ name: "backup.timer", enabled: false }] }).ok, true);
  assert.equal(maxLengthName.length, 256);
  assert.equal(validateServicesConfig({ services: [{ name: maxLengthName, enabled: true }] }).ok, true);
  assert.equal(tooLongName.length, 257);

  const malformedNames = [
    "ssh",
    ".",
    ".service",
    "etc/ssh.service",
    "etc\\ssh.service",
    "ssh..service",
    "ssh service.service",
    "ssh!.service",
    "data:application.service",
    "-----BEGIN.service",
    `${"A".repeat(48)}.service`,
    tooLongName,
  ];

  for (let index = 0; index < malformedNames.length; index += 1) {
    const name = malformedNames[index];

    if (name === undefined) {
      assert.fail("expected malformed name fixture");
    }

    assert.deepEqual(
      rejectedPaths(validateServicesConfig({ services: [{ name, enabled: true }] })),
      ["services/0/name"],
      `${name} must reject`,
    );
  }
});

test("enabled must be present and boolean", () => {
  assert.deepEqual(
    rejectedPaths(validateServicesConfig({ services: [{ name: "ssh.service" }] })),
    ["services/0/enabled"],
  );

  for (const enabled of ["true", 1, null]) {
    assert.deepEqual(
      rejectedPaths(validateServicesConfig({ services: [{ name: "ssh.service", enabled }] })),
      ["services/0/enabled"],
    );
  }
});

test("duplicate service names are rejected", () => {
  const config = mutableConfig();
  config.services.push({ name: "ssh.service", enabled: false });

  assert.deepEqual(rejectedPaths(validateServicesConfig(config)), ["services/2/name"]);
});

test("unknown envelope and entry keys are rejected", () => {
  assert.deepEqual(
    rejectedPaths(validateServicesConfig({ services: [], extra: true })),
    ["extra"],
  );

  assert.deepEqual(
    rejectedPaths(
      validateServicesConfig({
        services: [{ name: "ssh.service", enabled: true, mode: "manual" }],
      }),
    ),
    ["services/0/mode"],
  );
});

test("hostile and partial inputs fail closed through safeNormalize without throwing", () => {
  const cyclic: Record<string, unknown> = {
    services: [],
  };
  cyclic.self = cyclic;

  const accessor: Record<string, unknown> = {};
  let getterReads = 0;
  Object.defineProperty(accessor, "services", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("getter should not be read");
    },
  });

  const methodShadowed = mutableConfig();
  const shadowedServices = [...methodShadowed.services];
  Object.defineProperty(shadowedServices, "map", {
    enumerable: true,
    value() {
      return [];
    },
  });
  methodShadowed.services = shadowedServices;

  const hostileIterator = mutableConfig();
  const iteratorServices = [...hostileIterator.services];
  let iteratorReads = 0;
  Object.defineProperty(iteratorServices, Symbol.iterator, {
    enumerable: true,
    get() {
      iteratorReads += 1;
      throw new Error("iterator should not be read");
    },
  });
  hostileIterator.services = iteratorServices;

  const inputs: readonly unknown[] = [
    undefined,
    null,
    "services",
    [],
    {},
    {
      services: [{}],
    },
    cyclic,
    accessor,
    new Date(),
    new Map(),
    new Proxy({}, {}),
    methodShadowed,
    hostileIterator,
  ];

  for (let index = 0; index < inputs.length; index += 1) {
    assertRejected(inputs[index]);
  }

  assert.equal(getterReads, 0);
  assert.equal(iteratorReads, 0);
});

function validConfig(): ServicesConfig {
  return {
    services: [
      {
        enabled: true,
        name: "ssh.service",
      },
      {
        enabled: false,
        name: "backup.timer",
      },
    ],
  };
}

function mutableConfig(): MutableServicesConfig {
  return {
    services: validConfig().services.map((service) => ({
      enabled: service.enabled,
      name: service.name,
    })),
  };
}

function rejectedPaths(result: Result): readonly string[] {
  if (result.ok) {
    assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
  }

  return result.errors.map((error) => error.path).sort();
}

function assertRejected(value: unknown): void {
  let errors: readonly ValidationError[] | undefined;

  assert.doesNotThrow(() => {
    const result = validateServicesConfig(value);

    if (result.ok) {
      assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
    }

    errors = result.errors;
  });

  assert.notEqual(errors, undefined);
}

interface MutableServicesConfig extends Record<string, unknown> {
  services: ServiceEntry[];
}
