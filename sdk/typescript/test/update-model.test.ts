import test from "node:test";
import assert from "node:assert/strict";

import {
  validateUpdateConfig,
  validateUpdatePlan,
  validatePlanAgainstConfig,
} from "../src/update-model.ts";

function validConfig(): unknown {
  return {
    slots: [
      { id: "a", active: true, bootable: true, version: "1.2.0" },
      { id: "b", active: false, bootable: true, version: "1.1.0" },
    ],
    policy: { automaticRollback: true, maxFailedBoots: 3 },
  };
}

function validPlan(): unknown {
  return {
    targetSlot: "b",
    bundle: { ref: "vita-os@1.3.0", integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", version: "1.3.0" },
  };
}

test("a well-formed update config validates", () => {
  const result = validateUpdateConfig(validConfig());
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.config.slots.length, 2);
});

test("a well-formed update plan validates", () => {
  assert.equal(validateUpdatePlan(validPlan()).ok, true);
});

test("slots must be exactly {a, b}", () => {
  const one = validConfig() as { slots: unknown[] };
  one.slots = [{ id: "a", active: true, bootable: true, version: "1.0.0" }];
  assert.equal(validateUpdateConfig(one).ok, false);

  const wrongId = validConfig() as { slots: { id: string }[] };
  wrongId.slots[1]!.id = "c";
  assert.equal(validateUpdateConfig(wrongId).ok, false);

  const three = validConfig() as { slots: unknown[] };
  three.slots = [
    { id: "a", active: true, bootable: true, version: "1" },
    { id: "b", active: false, bootable: true, version: "1" },
    { id: "a", active: false, bootable: true, version: "1" },
  ];
  assert.equal(validateUpdateConfig(three).ok, false);
});

test("exactly one slot must be active", () => {
  const none = validConfig() as { slots: { active: boolean }[] };
  none.slots[0]!.active = false;
  assert.equal(validateUpdateConfig(none).ok, false);

  const both = validConfig() as { slots: { active: boolean }[] };
  both.slots[1]!.active = true;
  assert.equal(validateUpdateConfig(both).ok, false);
});

test("a plan targeting the ACTIVE slot is rejected (A/B safety)", () => {
  const configResult = validateUpdateConfig(validConfig());
  const planActive = validatePlan_with("a");
  const planInactive = validatePlan_with("b");
  assert.ok(configResult.ok && planActive.ok && planInactive.ok);
  if (configResult.ok && planActive.ok && planInactive.ok) {
    assert.equal(validatePlanAgainstConfig(configResult.config, planActive.plan).length, 1);
    assert.equal(validatePlanAgainstConfig(configResult.config, planInactive.plan).length, 0);
  }
});

function validatePlan_with(targetSlot: string) {
  const plan = validPlan() as { targetSlot: string };
  plan.targetSlot = targetSlot;
  return validateUpdatePlan(plan);
}

test("malformed SRI integrity is rejected", () => {
  const plan = validPlan() as { bundle: { integrity: string } };
  plan.bundle.integrity = "not-an-sri";
  assert.equal(validateUpdatePlan(plan).ok, false);
});

test("out-of-range maxFailedBoots is rejected", () => {
  for (const value of [0, 11, 2.5, -1]) {
    const config = validConfig() as { policy: { maxFailedBoots: number } };
    config.policy.maxFailedBoots = value;
    assert.equal(validateUpdateConfig(config).ok, false, `maxFailedBoots=${value} must reject`);
  }
});

test("missing required fields are rejected fail-closed", () => {
  for (const missing of ["slots", "policy"]) {
    const config = validConfig() as Record<string, unknown>;
    delete config[missing];
    assert.equal(validateUpdateConfig(config).ok, false);
  }
  const plan = validPlan() as Record<string, unknown>;
  delete plan.bundle;
  assert.equal(validateUpdatePlan(plan).ok, false);
});

test("unknown fields are rejected", () => {
  const config = validConfig() as Record<string, unknown>;
  config.extra = 1;
  assert.equal(validateUpdateConfig(config).ok, false);
});

test("hostile and partial untrusted inputs fail closed without throwing", () => {
  for (const input of [undefined, null, 7, "x", [], {}]) {
    assert.equal(validateUpdateConfig(input).ok, false);
    assert.equal(validateUpdatePlan(input).ok, false);
  }
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(validateUpdateConfig(cyclic).ok, false);
});
