import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createLandmarksViewModel,
} from "../../../../ui_kits/desktop/viewmodels/landmarks.ts";

test("landmarks expose ordered regions and skip-link targets", () => {
  const vm = createLandmarksViewModel({
    landmarks: [
      {
        focusId: "top-heading",
        id: "top",
        label: "Top",
        role: "banner",
      },
      {
        id: "global-nav",
        role: "nav",
      },
      {
        focusId: "main-heading",
        id: "main",
        label: "Content",
        role: "main",
      },
      {
        id: "footer",
        role: "contentinfo",
      },
    ],
  });

  assert.deepEqual(vm.landmarks().map((landmark) => [
    landmark.id,
    landmark.role,
    landmark.focusId,
    landmark.label,
  ]), [
    ["top", "banner", "top-heading", "Top"],
    ["global-nav", "nav", "global-nav", "Navigation"],
    ["main", "main", "main-heading", "Content"],
    ["footer", "contentinfo", "footer", "Footer"],
  ]);
  assert.deepEqual(vm.skipLinks().map((link) => [
    link.id,
    link.role,
    link.targetId,
    link.label,
  ]), [
    ["top", "banner", "top-heading", "Top"],
    ["global-nav", "nav", "global-nav", "Navigation"],
    ["main", "main", "main-heading", "Content"],
    ["footer", "contentinfo", "footer", "Footer"],
  ]);
  assert.equal(vm.focusTarget("main"), "main-heading");
  assert.equal(vm.focusTarget("global-nav"), "global-nav");
  assert.equal(vm.focusTarget("missing"), null);
  assert.deepEqual(vm.snapshot(), vm.snapshot());
});

test("landmarks can be created directly from an ordered region list", () => {
  const vm = createLandmarksViewModel([
    {
      id: "main",
      role: "main",
    },
    {
      focusId: "side-heading",
      id: "side",
      role: "complementary",
    },
  ]);

  assert.deepEqual(vm.skipLinks().map((link) => [link.id, link.targetId]), [
    ["main", "main"],
    ["side", "side-heading"],
  ]);
  assert.equal(vm.focusTarget("side"), "side-heading");
});

test("landmark malformed and hostile input fails closed", () => {
  const empty = createLandmarksViewModel();
  const badRole = createLandmarksViewModel({
    landmarks: [
      {
        id: "main",
        role: "article",
      },
    ],
  });
  const duplicateId = createLandmarksViewModel({
    landmarks: [
      {
        id: "main",
        role: "main",
      },
      {
        id: "main",
        role: "nav",
      },
    ],
  });

  assert.deepEqual(empty.snapshot(), {
    landmarks: [],
    skipLinks: [],
  });
  assert.deepEqual(badRole.snapshot(), {
    landmarks: [],
    skipLinks: [],
  });
  assert.deepEqual(duplicateId.snapshot(), {
    landmarks: [],
    skipLinks: [],
  });

  const shadowedLandmarks = [
    {
      id: "main",
      role: "main",
    },
  ];

  Object.defineProperty(shadowedLandmarks, "forEach", {
    enumerable: true,
    value() {
      assert.fail("shadowed array method must not be called");
    },
  });

  assert.deepEqual(createLandmarksViewModel(shadowedLandmarks).snapshot(), {
    landmarks: [],
    skipLinks: [],
  });

  let reads = 0;
  const hostileLandmark: Record<string, unknown> = {
    id: "main",
    role: "main",
  };

  Object.defineProperty(hostileLandmark, "focusId", {
    enumerable: true,
    get() {
      reads += 1;
      return "main-heading";
    },
  });

  const hostile = createLandmarksViewModel({
    landmarks: [hostileLandmark],
  });

  assert.equal(reads, 0);
  assert.deepEqual(hostile.snapshot(), {
    landmarks: [],
    skipLinks: [],
  });
  assert.equal(hostile.focusTarget("main"), null);
  assert.equal(hostile.focusTarget(null), null);
});
