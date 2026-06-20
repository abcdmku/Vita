import assert from "node:assert/strict";
import { test } from "node:test";

import { previewBackupChange } from "../src/backup-preview.ts";
import type {
  BackupChangePreview,
  BackupPreviewSide,
} from "../src/backup-preview.ts";
import type { BackupPolicy } from "../../../sdk/typescript/src/backup-model.ts";

function validPolicy(overrides: Partial<BackupPolicy> = {}): BackupPolicy {
  return {
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
    ...overrides,
  };
}

test("identical policies produce an empty diff without weakening retention", () => {
  const preview = previewBackupChange(validPolicy(), validPolicy());

  assert.equal(preview.valid, true);

  if (!preview.valid) {
    assert.fail("expected valid preview");
  }

  assert.equal(preview.weakensRetention, false);
  assert.deepEqual(preview.rejections, []);
  assert.deepEqual(preview.diff, {
    retention: {
      count: null,
      maxAgeDays: null,
    },
    schedule: null,
    targets: {
      added: [],
      removed: [],
    },
  });
});

test("shorter retention marks the preview as weakening coverage", () => {
  const preview = previewBackupChange(
    validPolicy({ retentionDays: 30 }),
    validPolicy({ retentionDays: 14 }),
  );

  assert.equal(preview.valid, true);

  if (!preview.valid) {
    assert.fail("expected valid preview");
  }

  assert.equal(preview.weakensRetention, true);
  assert.deepEqual(preview.diff.retention, {
    count: null,
    maxAgeDays: {
      current: 30,
      desired: 14,
    },
  });
});

test("longer retention does not mark the preview as weakening coverage", () => {
  const preview = previewBackupChange(
    validPolicy({ retentionDays: 14 }),
    validPolicy({ retentionDays: 30 }),
  );

  assert.equal(preview.valid, true);

  if (!preview.valid) {
    assert.fail("expected valid preview");
  }

  assert.equal(preview.weakensRetention, false);
  assert.deepEqual(preview.diff.retention.maxAgeDays, {
    current: 14,
    desired: 30,
  });
});

test("added and removed targets plus schedule changes are classified", () => {
  const current = validPolicy({
    target: {
      deviceRef: "disk:backup-a",
      kind: "attached-disk",
    },
  });
  const desired = validPolicy({
    schedule: {
      cadence: "weekly",
      interval: 1,
      startAt: "2026-06-21T02:00:00Z",
    },
    target: {
      bucketRef: "bucket:node-backups",
      credentialRef: "credential:s3-backup-writer",
      kind: "remote-object",
    },
  });

  const preview = previewBackupChange(current, desired);

  assert.equal(preview.valid, true);

  if (!preview.valid) {
    assert.fail("expected valid preview");
  }

  assert.deepEqual(preview.diff.schedule, {
    current: {
      cadence: "daily",
      interval: 1,
      startAt: "2026-06-20T11:00:00Z",
    },
    desired: {
      cadence: "weekly",
      interval: 1,
      startAt: "2026-06-21T02:00:00Z",
    },
  });
  assert.deepEqual(preview.diff.targets, {
    added: [
      {
        bucketRef: "bucket:node-backups",
        credentialRef: "credential:s3-backup-writer",
        kind: "remote-object",
      },
    ],
    removed: [
      {
        deviceRef: "disk:backup-a",
        kind: "attached-disk",
      },
    ],
  });
});

test("invalid current or desired policies return typed rejections with no diff", () => {
  const invalidCurrent = validPolicy() as unknown as Record<string, unknown>;
  delete invalidCurrent["retentionDays"];

  const invalidDesired = validPolicy({
    schedule: {
      cadence: "daily",
      interval: 32,
      startAt: "2026-06-20T11:00:00Z",
    },
  });

  for (const [current, desired, side] of [
    [invalidCurrent, validPolicy(), "current"],
    [validPolicy(), invalidDesired, "desired"],
  ] as const) {
    const preview = previewBackupChange(current, desired);

    assertInvalidPreview(preview, side);
    assert.equal(preview.weakensRetention, false);
    assert.ok(preview.rejections.length > 0);
    assert.ok(preview.rejections.every((rejection) => rejection.side === side));
  }
});

test("hostile input fails closed without throwing", () => {
  const hostileCurrent = validPolicy() as unknown as Record<string, unknown>;
  Object.defineProperty(hostileCurrent, "schedule", {
    enumerable: true,
    get() {
      assert.fail("accessor properties must not be invoked");
    },
  });

  const methodShadowedDesired = validPolicy() as unknown as Record<string, unknown>;
  const target = methodShadowedDesired["target"];

  if (target === undefined || target === null || typeof target !== "object") {
    assert.fail("expected target object");
  }

  Object.defineProperty(target, "forEach", {
    enumerable: true,
    value() {
      assert.fail("shadowed methods must not be invoked");
    },
  });

  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;

  assert.doesNotThrow(() => previewBackupChange(hostileCurrent, validPolicy()));
  assert.doesNotThrow(() => previewBackupChange(validPolicy(), methodShadowedDesired));
  assert.doesNotThrow(() => previewBackupChange(cyclic, cyclic));

  assertInvalidPreview(previewBackupChange(hostileCurrent, validPolicy()), "current");
  assertInvalidPreview(previewBackupChange(validPolicy(), methodShadowedDesired), "desired");

  const cyclicPreview = previewBackupChange(cyclic, cyclic);
  assert.equal(cyclicPreview.valid, false);

  if (cyclicPreview.valid) {
    assert.fail("expected invalid preview");
  }

  assert.deepEqual(rejectionSides(cyclicPreview), ["current", "desired"]);
});

test("preview output does not surface recovery-key references or rejected key material", () => {
  const secretText = "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----";
  const invalidDesired = {
    ...validPolicy(),
    recoveryKeyRef: {
      handle: secretText,
      id: "rk:alice-primary",
    },
  };

  const validPreviewText = JSON.stringify(previewBackupChange(validPolicy(), validPolicy()));
  const invalidPreviewText = JSON.stringify(previewBackupChange(validPolicy(), invalidDesired));

  assert.equal(validPreviewText.includes("rk:alice-primary"), false);
  assert.equal(validPreviewText.includes("rk_handle_alice_primary"), false);
  assert.equal(invalidPreviewText.includes(secretText), false);
  assert.equal(invalidPreviewText.includes("PRIVATE KEY"), false);
});

function assertInvalidPreview(
  preview: BackupChangePreview,
  side: Exclude<BackupPreviewSide, "preview">,
): void {
  assert.equal(preview.valid, false);

  if (preview.valid) {
    assert.fail("expected invalid preview");
  }

  assert.equal(preview.diff, undefined);
  assert.ok(preview.rejections.some((rejection) => rejection.side === side));
}

function rejectionSides(preview: BackupChangePreview): readonly BackupPreviewSide[] {
  const sides = new Set<BackupPreviewSide>();

  for (let index = 0; index < preview.rejections.length; index += 1) {
    const rejection = preview.rejections[index];

    if (rejection !== undefined) {
      sides.add(rejection.side);
    }
  }

  return Object.freeze([...sides].sort(compareStrings));
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}
