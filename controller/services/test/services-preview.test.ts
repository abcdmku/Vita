import assert from "node:assert/strict";
import { test } from "node:test";

import { previewServicesChange } from "../src/services-preview.ts";
import type {
  ServicesChangePreview,
  ServicesPreviewSide,
} from "../src/services-preview.ts";
import type { ServicesConfig } from "../../../sdk/typescript/src/services-model.ts";

test("identical configs produce an empty diff and no newly enabled services", () => {
  const preview = assertValid(previewServicesChange(validConfig(), validConfig()));

  assert.equal(preview.newlyEnabledCount, 0);
  assert.deepEqual(preview.rejections, []);
  assert.deepEqual(preview.diff, {
    added: {},
    disabled: {},
    enabled: {},
    removed: {},
  });
});

test("enabled disabled added and removed services are classified by name", () => {
  const current: ServicesConfig = {
    services: [
      { enabled: false, name: "ssh.service" },
      { enabled: true, name: "avahi.service" },
      { enabled: true, name: "old.service" },
      { enabled: true, name: "unchanged.service" },
    ],
  };
  const desired: ServicesConfig = {
    services: [
      { enabled: true, name: "ssh.service" },
      { enabled: false, name: "avahi.service" },
      { enabled: true, name: "unchanged.service" },
      { enabled: false, name: "backup.timer" },
      { enabled: true, name: "web.service" },
    ],
  };

  const preview = assertValid(previewServicesChange(current, desired));

  assert.equal(preview.newlyEnabledCount, 2);
  assert.deepEqual(Object.keys(preview.diff.enabled), ["ssh.service", "web.service"]);
  assert.deepEqual(preview.diff.enabled["ssh.service"], {
    after: { enabled: true, name: "ssh.service" },
    before: { enabled: false, name: "ssh.service" },
    kind: "enabled",
    name: "ssh.service",
  });
  assert.deepEqual(preview.diff.enabled["web.service"], {
    after: { enabled: true, name: "web.service" },
    before: null,
    kind: "enabled",
    name: "web.service",
  });
  assert.deepEqual(preview.diff.disabled, {
    "avahi.service": {
      after: { enabled: false, name: "avahi.service" },
      before: { enabled: true, name: "avahi.service" },
      kind: "disabled",
      name: "avahi.service",
    },
  });
  assert.deepEqual(preview.diff.added, {
    "backup.timer": {
      after: { enabled: false, name: "backup.timer" },
      kind: "added",
      name: "backup.timer",
    },
    "web.service": {
      after: { enabled: true, name: "web.service" },
      kind: "added",
      name: "web.service",
    },
  });
  assert.deepEqual(preview.diff.removed, {
    "old.service": {
      before: { enabled: true, name: "old.service" },
      kind: "removed",
      name: "old.service",
    },
  });
});

test("invalid current or desired configs return typed rejections with no diff", () => {
  const invalidCurrent = {
    services: [{ name: "ssh.service" }],
  };
  const invalidDesired = {
    services: [{ enabled: true, name: "ssh" }],
  };

  for (const [current, desired, side] of [
    [invalidCurrent, validConfig(), "current"],
    [validConfig(), invalidDesired, "desired"],
  ] as const) {
    let preview: ServicesChangePreview | undefined;

    assert.doesNotThrow(() => {
      preview = previewServicesChange(current, desired);
    });

    if (preview === undefined) {
      assert.fail("expected preview result");
    }

    assertInvalid(preview, side);
    assert.equal(preview.diff, undefined);
    assert.equal(preview.newlyEnabledCount, 0);
    assert.ok(preview.rejections.length > 0);
    assert.ok(preview.rejections.every((rejection) => rejection.side === side));
  }
});

test("hostile input fails closed without invoking accessor probes", () => {
  let accessorReads = 0;
  const hostileCurrent: Record<string, unknown> = {};
  Object.defineProperty(hostileCurrent, "services", {
    enumerable: true,
    get() {
      accessorReads += 1;
      return [];
    },
  });

  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;

  assert.doesNotThrow(() => previewServicesChange(hostileCurrent, validConfig()));
  assert.doesNotThrow(() => previewServicesChange(validConfig(), cyclic));

  const accessorPreview = previewServicesChange(hostileCurrent, validConfig());
  const cyclicPreview = previewServicesChange(validConfig(), cyclic);

  assert.equal(accessorReads, 0);
  assertInvalid(accessorPreview, "current");
  assertInvalid(cyclicPreview, "desired");
});

function assertValid(
  preview: ServicesChangePreview,
): Extract<ServicesChangePreview, { readonly valid: true }> {
  if (!preview.valid) {
    assert.fail(`expected valid preview: ${JSON.stringify(preview.rejections)}`);
  }

  return preview;
}

function assertInvalid(preview: ServicesChangePreview, side: ServicesPreviewSide): void {
  assert.equal(preview.valid, false);

  if (preview.valid) {
    assert.fail("expected invalid preview");
  }

  assert.ok(preview.rejections.some((rejection) => rejection.side === side));
}

function validConfig(): ServicesConfig {
  return {
    services: [
      { enabled: true, name: "ssh.service" },
      { enabled: false, name: "backup.timer" },
    ],
  };
}
