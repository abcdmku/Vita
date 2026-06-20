import assert from "node:assert/strict";
import { test } from "node:test";

import {
  validateEnrollment,
  validateRecoveryAttempt,
  validateRotation,
} from "../src/recovery-key.ts";
import type {
  RecoveryAttempt,
  RecoveryAttemptValidationResult,
  RecoveryEnrollment,
  RecoveryEnrollmentValidationResult,
  RecoveryKeyValidationError,
  RecoveryQuorum,
  RecoveryRotation,
  RecoveryRotationValidationResult,
} from "../src/recovery-key.ts";
import type {
  RecoveryKeyEnrollment,
  RecoveryKeyRef,
} from "../src/backup-model.ts";

type ValidationResult =
  | RecoveryAttemptValidationResult
  | RecoveryEnrollmentValidationResult
  | RecoveryRotationValidationResult;

test("valid N-of-M recovery-key enrollment validates", () => {
  const enrollment = validRecoveryEnrollment();
  const result = validateEnrollment(enrollment);

  if (!result.ok) {
    assert.fail(`expected recovery enrollment to validate: ${JSON.stringify(result.errors)}`);
  }

  assert.deepEqual(result.enrollment, enrollment);
  assert.equal(result.value, result.enrollment);
});

test("threshold greater than share count is rejected", () => {
  const enrollment = validRecoveryEnrollment({
    quorum: {
      shares: [recoveryShare(1), recoveryShare(2)],
      threshold: 3,
    },
  });

  assert.equal(rejectedPaths(validateEnrollment(enrollment)).includes("quorum/threshold"), true);
});

test("rotation preserving threshold validates and unapproved threshold lowering rejects", () => {
  const oldEnrollment = validRecoveryEnrollment();
  const newEnrollment = validRecoveryEnrollment({
    id: "enrollment:alice-recovery-rotated",
    quorum: {
      shares: [recoveryShare(4), recoveryShare(5), recoveryShare(6)],
      threshold: 2,
    },
    recoveryKeyRef: {
      handle: "rk_handle_alice_rotated",
      id: "rk:alice-rotated",
    },
  });
  const preservingRotation: RecoveryRotation = {
    newEnrollment,
    oldEnrollment,
  };
  const preservingResult = validateRotation(preservingRotation);

  if (!preservingResult.ok) {
    assert.fail(`expected threshold-preserving rotation to validate: ${JSON.stringify(preservingResult.errors)}`);
  }

  assert.deepEqual(preservingResult.rotation, preservingRotation);

  const loweredThreshold = validRecoveryEnrollment({
    quorum: {
      shares: [recoveryShare(7), recoveryShare(8), recoveryShare(9)],
      threshold: 1,
    },
  });

  assert.equal(
    rejectedPaths(
      validateRotation({
        newEnrollment: loweredThreshold,
        oldEnrollment,
      }),
    ).includes("ownerApprovedThresholdChange"),
    true,
  );

  const approvedLowering = validateRotation({
    newEnrollment: loweredThreshold,
    oldEnrollment,
    ownerApprovedThresholdChange: true,
  });

  if (!approvedLowering.ok) {
    assert.fail(`expected owner-approved threshold change to validate: ${JSON.stringify(approvedLowering.errors)}`);
  }
});

test("recovery attempt accepts quorum-satisfying share set and rejects below quorum", () => {
  const quorum = validQuorum();
  const validAttempt: RecoveryAttempt = {
    presentedShareRefs: [recoveryShare(1), recoveryShare(2)],
    quorum,
  };
  const validResult = validateRecoveryAttempt(validAttempt);

  if (!validResult.ok) {
    assert.fail(`expected quorum-satisfying attempt to validate: ${JSON.stringify(validResult.errors)}`);
  }

  assert.deepEqual(validResult.attempt, validAttempt);

  assert.equal(
    rejectedPaths(
      validateRecoveryAttempt({
        presentedShareRefs: [recoveryShare(1)],
        quorum,
      }),
    ).includes("presentedShareRefs"),
    true,
  );
});

test("embedded key material is rejected", () => {
  const pemBlock = "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----";
  const enrollment = validRecoveryEnrollment({
    quorum: {
      shares: [
        {
          ...recoveryShare(1),
          handle: pemBlock,
        },
        recoveryShare(2),
        recoveryShare(3),
      ],
      threshold: 2,
    },
  });

  assert.equal(
    rejectedPaths(validateEnrollment(enrollment)).includes("quorum/shares/0/handle"),
    true,
  );

  assert.equal(
    rejectedPaths(
      validateEnrollment({
        ...validRecoveryEnrollment(),
        privateKey: pemBlock,
      }),
    ).includes("privateKey"),
    true,
  );
});

test("hostile untrusted input is rejected through safeNormalize without throwing", () => {
  const accessor: Record<string, unknown> = {};
  let getterReads = 0;
  Object.defineProperty(accessor, "enrollment", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("getter should not be invoked");
    },
  });

  const methodShadowed = {
    ...backupEnrollment(),
    quorum: {
      shares: [recoveryShare(1), recoveryShare(2), recoveryShare(3)],
      threshold: 2,
    },
  };
  Object.defineProperty(methodShadowed.quorum.shares, "map", {
    enumerable: true,
    value() {
      return [];
    },
  });

  const hostileIterator = {
    presentedShareRefs: [recoveryShare(1), recoveryShare(2)],
    quorum: validQuorum(),
  };
  let iteratorReads = 0;
  Object.defineProperty(hostileIterator.presentedShareRefs, Symbol.iterator, {
    enumerable: true,
    get() {
      iteratorReads += 1;
      throw new Error("iterator should not be invoked");
    },
  });

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  assertRejectsWithoutThrow(validateEnrollment, accessor);
  assertRejectsWithoutThrow(validateEnrollment, methodShadowed);
  assertRejectsWithoutThrow(validateRecoveryAttempt, hostileIterator);
  assertRejectsWithoutThrow(validateRotation, cyclic);

  assert.equal(getterReads, 0);
  assert.equal(iteratorReads, 0);
});

function validRecoveryEnrollment(overrides: Partial<RecoveryEnrollment> = {}): RecoveryEnrollment {
  return {
    ...backupEnrollment(),
    quorum: validQuorum(),
    ...overrides,
  };
}

function backupEnrollment(overrides: Partial<RecoveryKeyEnrollment> = {}): RecoveryKeyEnrollment {
  return {
    credentialRef: "credential:owner-passkey",
    enrolledAt: "2026-06-20T10:20:00Z",
    id: "enrollment:alice-recovery",
    recoveryKeyRef: {
      handle: "rk_handle_alice_primary",
      id: "rk:alice-primary",
    },
    status: "active",
    subjectRef: "identity:owner-alice",
    ...overrides,
  };
}

function validQuorum(overrides: Partial<RecoveryQuorum> = {}): RecoveryQuorum {
  return {
    shares: [recoveryShare(1), recoveryShare(2), recoveryShare(3)],
    threshold: 2,
    ...overrides,
  };
}

function recoveryShare(index: number): RecoveryKeyRef {
  return {
    handle: `rk_handle_alice_share_${index}`,
    id: `rk:alice-share-${index}`,
  };
}

function rejectedPaths(result: ValidationResult): readonly string[] {
  if (result.ok) {
    assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
  }

  return result.errors.map((error) => error.path).sort();
}

function assertRejectsWithoutThrow(
  validate: (value: unknown) => ValidationResult,
  value: unknown,
): void {
  let errors: readonly RecoveryKeyValidationError[] | undefined;

  assert.doesNotThrow(() => {
    const result = validate(value);

    if (result.ok) {
      assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
    }

    errors = result.errors;
  });

  assert.notEqual(errors, undefined);
}
