import assert from "node:assert/strict";
import { test } from "node:test";

import { previewCapsuleChange } from "../src/capsule-preview.ts";
import type {
  CapsuleChangePreview,
  CapsuleChangeRejectionCode,
  CapsuleChangeRejectionSource,
} from "../src/capsule-preview.ts";
import type {
  CapsuleEntry,
  CapsuleIntegrity,
  CapsuleRegistry,
} from "../../../sdk/typescript/src/capsule-registry-model.ts";

const SHA256_EMPTY = "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";
const SHA256_ONES = sri256(1);
const SHA256_TWOS = sri256(2);
const SHA256_THREES = sri256(3);
const SHA384_ZERO =
  "sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

test("identical capsule registries produce an empty valid diff", () => {
  const registry = validRegistry();
  const preview = previewCapsuleChange(registry, registry);

  if (!preview.valid) {
    assert.fail(`expected valid preview: ${formatRejections(preview.rejections)}`);
  }

  assert.equal(preview.valid, true);
  assert.equal(preview.integrityChanged, false);
  assert.deepEqual(preview.rejections, []);
  assert.deepEqual(preview.diff, {
    downgraded: {},
    installed: {},
    removed: {},
    stateChanged: {},
    upgraded: {},
  });
});

test("installed, removed, upgraded, downgraded, and state changes are classified by capsule id", () => {
  const current: CapsuleRegistry = [
    capsule("com.vita.notes", "1.2.3", SHA256_EMPTY, "installed"),
    capsule("com.vita.search", "2.0.0", SHA256_ONES, "installed"),
    capsule("com.vita.camera", "5.4.0", SHA256_TWOS, "disabled"),
    capsule("com.vita.mail", "3.1.0", SHA256_THREES, "installed"),
  ];
  const desired: CapsuleRegistry = [
    capsule("com.vita.notes", "1.10.0", SHA256_EMPTY, "disabled"),
    capsule("com.vita.search", "1.9.0", SHA256_ONES, "installed"),
    capsule("com.vita.mail", "3.1.0", SHA256_THREES, "disabled"),
    capsule("com.vita.calendar", "0.1.0", SHA384_ZERO, "installed"),
  ];

  const preview = previewCapsuleChange(current, desired);

  if (!preview.valid) {
    assert.fail(`expected valid preview: ${formatRejections(preview.rejections)}`);
  }

  assert.equal(preview.valid, true);
  assert.equal(preview.integrityChanged, false);
  assert.deepEqual(Object.keys(preview.diff.installed), ["com.vita.calendar"]);
  assert.deepEqual(Object.keys(preview.diff.removed), ["com.vita.camera"]);
  assert.deepEqual(Object.keys(preview.diff.upgraded), ["com.vita.notes"]);
  assert.deepEqual(Object.keys(preview.diff.downgraded), ["com.vita.search"]);
  assert.deepEqual(Object.keys(preview.diff.stateChanged), [
    "com.vita.mail",
    "com.vita.notes",
  ]);

  assert.deepEqual(preview.diff.installed["com.vita.calendar"], {
    after: {
      id: "com.vita.calendar",
      integrity: SHA384_ZERO,
      state: "installed",
      version: "0.1.0",
    },
    id: "com.vita.calendar",
    kind: "installed",
  });
  assert.deepEqual(preview.diff.removed["com.vita.camera"], {
    before: {
      id: "com.vita.camera",
      integrity: SHA256_TWOS,
      state: "disabled",
      version: "5.4.0",
    },
    id: "com.vita.camera",
    kind: "removed",
  });
  assert.deepEqual(preview.diff.upgraded["com.vita.notes"], {
    id: "com.vita.notes",
    kind: "upgraded",
    newVersion: "1.10.0",
    oldVersion: "1.2.3",
  });
  assert.deepEqual(preview.diff.downgraded["com.vita.search"], {
    id: "com.vita.search",
    kind: "downgraded",
    newVersion: "1.9.0",
    oldVersion: "2.0.0",
  });
  assert.deepEqual(preview.diff.stateChanged["com.vita.notes"], {
    id: "com.vita.notes",
    kind: "stateChanged",
    newState: "disabled",
    oldState: "installed",
  });
});

test("same-version integrity changes mark a suspicious re-pin", () => {
  const current = [capsule("com.vita.notes", "1.2.3", SHA256_EMPTY, "installed")];
  const desired = [capsule("com.vita.notes", "1.2.3", SHA256_ONES, "installed")];
  const versionChanged = [capsule("com.vita.notes", "1.2.4", SHA256_TWOS, "installed")];

  const preview = previewCapsuleChange(current, desired);
  const upgradedPreview = previewCapsuleChange(current, versionChanged);

  assert.equal(preview.valid, true);
  assert.equal(upgradedPreview.valid, true);

  if (!preview.valid || !upgradedPreview.valid) {
    assert.fail("expected valid previews");
  }

  assert.equal(preview.integrityChanged, true);
  assert.equal(upgradedPreview.integrityChanged, false);
});

test("invalid current or desired registries return typed rejections with no diff", () => {
  const invalidCurrent = mutableRegistry();
  delete invalidCurrent[0]?.integrity;

  const invalidDesired = mutableRegistry();
  invalidDesired[1] = {
    ...invalidDesired[1],
    id: invalidDesired[0]?.id,
  };

  const currentPreview = previewCapsuleChange(invalidCurrent, validRegistry());
  const desiredPreview = previewCapsuleChange(validRegistry(), invalidDesired);

  assertInvalidPreview(currentPreview, "current", "INVALID_CURRENT_REGISTRY");
  assertInvalidPreview(desiredPreview, "desired", "INVALID_DESIRED_REGISTRY");
});

test("hostile capsule inputs fail closed without executing untrusted accessors or methods", () => {
  const accessorCurrent = mutableRegistry();
  let accessorReads = 0;
  Object.defineProperty(accessorCurrent[0], "version", {
    enumerable: true,
    get() {
      accessorReads += 1;
      throw new Error("accessor must not be invoked");
    },
  });

  const methodShadowedDesired = mutableRegistry();
  let mapCalls = 0;
  let someCalls = 0;
  let forEachCalls = 0;
  Object.defineProperty(methodShadowedDesired, "map", {
    enumerable: true,
    value() {
      mapCalls += 1;
      throw new Error("shadowed map must not be invoked");
    },
  });
  Object.defineProperty(methodShadowedDesired, "some", {
    enumerable: true,
    value() {
      someCalls += 1;
      throw new Error("shadowed some must not be invoked");
    },
  });
  Object.defineProperty(methodShadowedDesired, "forEach", {
    enumerable: true,
    value() {
      forEachCalls += 1;
      throw new Error("shadowed forEach must not be invoked");
    },
  });

  const hostileIteratorDesired = mutableRegistry();
  let iteratorReads = 0;
  Object.defineProperty(hostileIteratorDesired, Symbol.iterator, {
    enumerable: true,
    get() {
      iteratorReads += 1;
      throw new Error("iterator must not be read");
    },
  });

  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;

  const previews = [
    previewCapsuleChange(accessorCurrent, validRegistry()),
    previewCapsuleChange(validRegistry(), methodShadowedDesired),
    previewCapsuleChange(validRegistry(), hostileIteratorDesired),
    previewCapsuleChange(cyclic, cyclic),
  ];

  assert.equal(accessorReads, 0);
  assert.equal(mapCalls, 0);
  assert.equal(someCalls, 0);
  assert.equal(forEachCalls, 0);
  assert.equal(iteratorReads, 0);

  for (let index = 0; index < previews.length; index += 1) {
    const preview = previews[index];

    if (preview !== undefined) {
      assert.equal(preview.valid, false);
      assert.equal(preview.diff, null);
      assert.equal(preview.integrityChanged, false);
      assert.ok(preview.rejections.length > 0);
    }
  }

  assert.deepEqual(rejectionCodes(previews[0]), ["INVALID_CURRENT_REGISTRY"]);
  assert.deepEqual(rejectionCodes(previews[1]), ["INVALID_DESIRED_REGISTRY"]);
  assert.deepEqual(rejectionCodes(previews[2]), ["INVALID_DESIRED_REGISTRY"]);
  assert.deepEqual(rejectionCodes(previews[3]), [
    "INVALID_CURRENT_REGISTRY",
    "INVALID_DESIRED_REGISTRY",
  ]);
});

function validRegistry(): CapsuleRegistry {
  return [
    capsule("com.vita.notes", "1.2.3", SHA256_EMPTY, "installed"),
    capsule("com.vita.search", "2.0.0", SHA384_ZERO, "disabled"),
  ];
}

function mutableRegistry(): MutableCapsuleEntryInput[] {
  return validRegistry().map((entry) => ({
    id: entry.id,
    integrity: entry.integrity,
    state: entry.state,
    version: entry.version,
  }));
}

function capsule(
  id: string,
  version: string,
  integrity: CapsuleIntegrity,
  state: CapsuleEntry["state"],
): CapsuleEntry {
  return {
    id,
    integrity,
    state,
    version,
  };
}

function assertInvalidPreview(
  preview: CapsuleChangePreview,
  source: CapsuleChangeRejectionSource,
  code: CapsuleChangeRejectionCode,
): void {
  assert.equal(preview.valid, false);

  if (preview.valid) {
    assert.fail("expected invalid preview");
  }

  assert.equal(preview.diff, null);
  assert.equal(preview.integrityChanged, false);
  assert.ok(preview.rejections.length > 0);
  assert.equal(preview.rejections[0]?.source, source);
  assert.equal(preview.rejections[0]?.code, code);
}

function rejectionCodes(preview: CapsuleChangePreview | undefined): readonly CapsuleChangeRejectionCode[] {
  if (preview === undefined) {
    assert.fail("expected preview");
  }

  const output: CapsuleChangeRejectionCode[] = [];

  for (let index = 0; index < preview.rejections.length; index += 1) {
    const rejection = preview.rejections[index];

    if (rejection !== undefined) {
      output[output.length] = rejection.code;
    }
  }

  return output;
}

function formatRejections(
  rejections: readonly {
    readonly source: string;
    readonly code: string;
    readonly path: string;
    readonly message: string;
  }[],
): string {
  return rejections
    .map((rejection) => `${rejection.source}:${rejection.code}:${rejection.path}: ${rejection.message}`)
    .join("\n");
}

function sri256(byte: number): CapsuleIntegrity {
  return `sha256-${Buffer.alloc(32, byte).toString("base64")}`;
}

interface MutableCapsuleEntryInput extends Record<string, unknown> {
  id?: unknown;
  version?: unknown;
  integrity?: unknown;
  state?: unknown;
}
