import assert from "node:assert/strict";
import { test } from "node:test";

import {
  validateBackupPolicy,
  validateRecoveryKeyEnrollment,
} from "../src/backup-model.ts";
import type {
  BackupModelValidationError,
  BackupPolicy,
  BackupPolicyValidationResult,
  RecoveryKeyEnrollment,
  RecoveryKeyEnrollmentValidationResult,
} from "../src/backup-model.ts";

const validPolicy: BackupPolicy = {
  createdAt: "2026-06-20T10:15:30Z",
  enabled: true,
  id: "backup:daily-main",
  recoveryKeyRef: {
    handle: "rk_handle_alice_primary",
    id: "rk:alice-primary",
    keyStoreRef: "keystore:local-tpm",
  },
  retentionDays: 30,
  schedule: {
    cadence: "daily",
    interval: 1,
    startAt: "2026-06-20T11:00:00Z",
  },
  target: {
    bucketRef: "bucket:node-backups",
    credentialRef: "credential:s3-backup-writer",
    kind: "remote-object",
  },
};

const validEnrollment: RecoveryKeyEnrollment = {
  credentialRef: "credential:owner-passkey",
  enrolledAt: "2026-06-20T10:20:00Z",
  expiresAt: "2027-06-20T10:20:00Z",
  id: "enrollment:alice-recovery",
  recoveryKeyRef: {
    handle: "rk_handle_alice_primary",
    id: "rk:alice-primary",
  },
  status: "active",
  subjectRef: "identity:owner-alice",
};

test("valid backup policy validates", () => {
  const result = validateBackupPolicy(validPolicy);

  if (!result.ok) {
    assert.fail(`expected validation to pass: ${JSON.stringify(result.errors)}`);
  }

  assert.deepEqual(result.policy, validPolicy);
  assert.equal(result.value, result.policy);
});

test("valid recovery-key enrollment validates", () => {
  const result = validateRecoveryKeyEnrollment(validEnrollment);

  if (!result.ok) {
    assert.fail(`expected validation to pass: ${JSON.stringify(result.errors)}`);
  }

  assert.deepEqual(result.enrollment, validEnrollment);
  assert.equal(result.value, result.enrollment);
});

test("missing and wrong-type fields are rejected with precise paths", () => {
  const invalidPolicy = {
    createdAt: "2026-06-20T10:15:30Z",
    id: "",
    retentionDays: "30",
    schedule: {
      cadence: "daily",
      startAt: "2026-06-20T11:00:00Z",
    },
    target: {
      credentialRef: 42,
      kind: "remote-object",
    },
  };

  assert.deepEqual(
    rejectedPaths(validateBackupPolicy(invalidPolicy)),
    [
      "id",
      "retentionDays",
      "schedule/interval",
      "target/bucketRef",
      "target/credentialRef",
    ],
  );

  const invalidEnrollment = {
    credentialRef: "credential:owner-passkey",
    enrolledAt: "2026-06-20T10:20:00Z",
    recoveryKeyRef: {
      handle: "rk_handle_alice_primary",
    },
    subjectRef: false,
  };

  assert.deepEqual(
    rejectedPaths(validateRecoveryKeyEnrollment(invalidEnrollment)),
    ["id", "recoveryKeyRef/id", "subjectRef"],
  );
});

test("inlined key material fields are rejected", () => {
  assert.equal(
    rejectedPaths(
      validateRecoveryKeyEnrollment({
        ...validEnrollment,
        keyMaterial: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
      }),
    ).includes("keyMaterial"),
    true,
  );

  assert.equal(
    rejectedPaths(
      validateRecoveryKeyEnrollment({
        ...validEnrollment,
        recoveryKeyRef: {
          ...validEnrollment.recoveryKeyRef,
          seedPhrase: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        },
      }),
    ).includes("recoveryKeyRef/seedPhrase"),
    true,
  );
});

test("reference values reject embedded key material", () => {
  const pemBlock = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";
  const longHexSecret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const longBase64Secret = "VGhpcy1sb29rcy1saWtlLWtleS1tYXRlcmlhbC1hbmQtaXMtbG9uZy1lbm91Z2g=";

  assert.equal(
    rejectedPaths(
      validateRecoveryKeyEnrollment({
        ...validEnrollment,
        recoveryKeyRef: {
          ...validEnrollment.recoveryKeyRef,
          handle: pemBlock,
        },
      }),
    ).includes("recoveryKeyRef/handle"),
    true,
  );

  assert.equal(
    rejectedPaths(
      validateRecoveryKeyEnrollment({
        ...validEnrollment,
        recoveryKeyRef: {
          ...validEnrollment.recoveryKeyRef,
          id: `rk:${longHexSecret}`,
        },
      }),
    ).includes("recoveryKeyRef/id"),
    true,
  );

  assert.equal(
    rejectedPaths(
      validateRecoveryKeyEnrollment({
        ...validEnrollment,
        credentialRef: `credential:${longBase64Secret}`,
      }),
    ).includes("credentialRef"),
    true,
  );

  assert.equal(
    rejectedPaths(
      validateRecoveryKeyEnrollment({
        ...validEnrollment,
        recoveryKeyRef: {
          ...validEnrollment.recoveryKeyRef,
          handle: "seed phrase abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        },
      }),
    ).includes("recoveryKeyRef/handle"),
    true,
  );
});

test("opaque references must use reference syntax", () => {
  assert.equal(
    rejectedPaths(
      validateRecoveryKeyEnrollment({
        ...validEnrollment,
        credentialRef: "correct horse battery staple",
      }),
    ).includes("credentialRef"),
    true,
  );
});

test("schedule and retention bounds are enforced", () => {
  assert.deepEqual(
    rejectedPaths(
      validateBackupPolicy({
        ...validPolicy,
        retentionDays: 0,
        schedule: {
          ...validPolicy.schedule,
          interval: 32,
        },
      }),
    ),
    ["retentionDays", "schedule/interval"],
  );

  assert.deepEqual(
    rejectedPaths(
      validateBackupPolicy({
        ...validPolicy,
        retentionDays: 3651,
        schedule: {
          cadence: "monthly",
          interval: 13,
          startAt: "2026-06-20T11:00:00Z",
        },
      }),
    ),
    ["retentionDays", "schedule/interval"],
  );
});

test("date-time fields require ISO-8601 values with a timezone", () => {
  assert.equal(
    rejectedPaths(
      validateBackupPolicy({
        ...validPolicy,
        createdAt: "June 20, 2026 10:15:30",
      }),
    ).includes("createdAt"),
    true,
  );

  assert.equal(
    rejectedPaths(
      validateBackupPolicy({
        ...validPolicy,
        schedule: {
          ...validPolicy.schedule,
          startAt: "2026-02-30T11:00:00Z",
        },
      }),
    ).includes("schedule/startAt"),
    true,
  );

  assert.equal(
    rejectedPaths(
      validateRecoveryKeyEnrollment({
        ...validEnrollment,
        enrolledAt: "2026-06-20T10:20:00",
      }),
    ).includes("enrolledAt"),
    true,
  );
});

test("hostile untrusted input is rejected through safeNormalize without throwing", () => {
  const getterObject: Record<string, unknown> = {};
  let getterReads = 0;
  Object.defineProperty(getterObject, "id", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("getter should not be invoked");
    },
  });

  const methodShadowedArray = [validEnrollment];
  Object.defineProperty(methodShadowedArray, "map", {
    enumerable: true,
    value() {
      return [];
    },
  });

  const hostileIterator = [validPolicy];
  let iteratorReads = 0;
  Object.defineProperty(hostileIterator, Symbol.iterator, {
    enumerable: true,
    get() {
      iteratorReads += 1;
      throw new Error("iterator should not be invoked");
    },
  });

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  assertRejectsWithoutThrow(validateBackupPolicy, getterObject);
  assertRejectsWithoutThrow(validateBackupPolicy, methodShadowedArray);
  assertRejectsWithoutThrow(validateRecoveryKeyEnrollment, hostileIterator);
  assertRejectsWithoutThrow(validateRecoveryKeyEnrollment, cyclic);

  assert.equal(getterReads, 0);
  assert.equal(iteratorReads, 0);
});

function rejectedPaths(
  result: BackupPolicyValidationResult | RecoveryKeyEnrollmentValidationResult,
): readonly string[] {
  if (result.ok) {
    assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
  }

  return result.errors.map((error) => error.path).sort();
}

function assertRejectsWithoutThrow(
  validate: (value: unknown) => BackupPolicyValidationResult | RecoveryKeyEnrollmentValidationResult,
  value: unknown,
): void {
  let errors: readonly BackupModelValidationError[] | undefined;

  assert.doesNotThrow(() => {
    const result = validate(value);

    if (result.ok) {
      assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
    }

    errors = result.errors;
  });

  assert.notEqual(errors, undefined);
}
