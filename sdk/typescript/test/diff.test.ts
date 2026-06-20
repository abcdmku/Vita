import assert from "node:assert/strict";
import { test } from "node:test";

import { diffPlans, renderPlanDiff } from "../src/diff.ts";
import { normalize } from "../src/plan.ts";
import type { CanonicalPlan, DesiredState } from "../src/plan.ts";

const baseState: DesiredState = {
  storage: {
    dataVolume: {
      encryption: "optional",
      snapshots: "daily",
    },
  },
  apps: [
    {
      id: "local-search",
      config: {
        memory: "1GiB",
      },
    },
  ],
  backups: [
    {
      id: "usb-main",
      target: "usb",
      schedule: "daily",
    },
  ],
};

function changedPlanPair(): readonly [CanonicalPlan, CanonicalPlan] {
  return [
    normalize({
      ...baseState,
      apps: [
        ...(baseState.apps ?? []),
        {
          id: "legacy-dashboard",
        },
      ],
    }),
    normalize({
      ...baseState,
      storage: {
        dataVolume: {
          encryption: "required",
          snapshots: "daily",
        },
      },
      apps: [
        ...(baseState.apps ?? []),
        {
          id: "atproto-pds",
          version: "1.0.0",
        },
      ],
    }),
  ];
}

test("identical plans produce an empty diff", () => {
  const plan = normalize(baseState);
  const diff = diffPlans(plan, plan);

  assert.deepEqual(diff.changes, []);
  assert.equal(renderPlanDiff(diff), "");
});

test("added, removed, and changed entries include the expected path and kind", () => {
  const [before, after] = changedPlanPair();
  const diff = diffPlans(before, after);

  assert.deepEqual(
    diff.changes.map((change) => ({ path: change.path, kind: change.kind })),
    [
      { path: "apps/atproto-pds", kind: "added" },
      { path: "apps/legacy-dashboard", kind: "removed" },
      { path: "storage/dataVolume/encryption", kind: "changed" },
    ],
  );

  const added = diff.changes.find((change) => change.path === "apps/atproto-pds");
  const removed = diff.changes.find((change) => change.path === "apps/legacy-dashboard");
  const changed = diff.changes.find(
    (change) => change.path === "storage/dataVolume/encryption",
  );

  if (added?.kind !== "added") {
    assert.fail("expected the atproto-pds app to be an added change");
  }

  if (removed?.kind !== "removed") {
    assert.fail("expected the legacy-dashboard app to be a removed change");
  }

  if (changed?.kind !== "changed") {
    assert.fail("expected storage encryption to be a changed change");
  }

  assert.deepEqual(added.after, {
    id: "atproto-pds",
    version: "1.0.0",
  });
  assert.deepEqual(removed.before, {
    id: "legacy-dashboard",
  });
  assert.equal(changed.before, "optional");
  assert.equal(changed.after, "required");
});

test("plan diffs are deterministic for the same inputs", () => {
  const [before, after] = changedPlanPair();
  const first = diffPlans(before, after);
  const second = diffPlans(before, after);

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(renderPlanDiff(first), renderPlanDiff(second));
});

test("renderPlanDiff is stable and includes every change", () => {
  const [before, after] = changedPlanPair();
  const diff = diffPlans(before, after);
  const rendered = renderPlanDiff(diff);

  assert.equal(
    rendered,
    [
      "+ apps/atproto-pds",
      "- apps/legacy-dashboard",
      "~ storage/dataVolume/encryption: optional -> required",
    ].join("\n"),
  );
  assert.equal(rendered.split("\n").length, diff.changes.length);
});
