import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createInMemoryControllerApi,
  dispatchControllerRequest,
} from "../src/dispatcher.ts";
import { normalize } from "../../../sdk/typescript/src/plan.ts";
import type { ControllerApiDispatchResult } from "../src/contracts.ts";
import type { DesiredState } from "../../../sdk/typescript/src/plan.ts";

test("overview and node health route through the dispatcher", () => {
  const api = createInMemoryControllerApi();

  const overview = dispatchControllerRequest(api, {
    method: "getOverview",
  });

  assert.equal(overview.ok, true);

  if (!overview.ok || overview.method !== "getOverview") {
    assert.fail(`expected overview response: ${JSON.stringify(overview)}`);
  }

  assert.equal(overview.response.nodeCount, 1);
  assert.deepEqual(overview.response.health, {
    healthy: 1,
    degraded: 0,
    offline: 0,
  });
  assert.deepEqual(overview.response.protection, {
    protected: 1,
    warnings: 0,
    unprotected: 0,
  });
  assert.equal(overview.response.exposure.publicServices, 1);

  const health = dispatchControllerRequest(api, {
    method: "getNodeHealth",
    params: {
      nodeId: "node-1",
    },
  });

  assert.equal(health.ok, true);

  if (!health.ok || health.method !== "getNodeHealth") {
    assert.fail(`expected node health response: ${JSON.stringify(health)}`);
  }

  assert.equal(health.response.nodeId, "node-1");
  assert.equal(health.response.status, "healthy");
  assert.equal(health.response.uptimeSeconds, 86_400);
  assert.equal(health.response.capabilities.memoryGB, 32);
  assert.equal(health.response.capabilities.architecture, "x86_64");
  assert.deepEqual(
    health.response.capabilities.accelerators.map((accelerator) => accelerator.kind),
    ["intel.npu", "nvidia.cuda"],
  );
});

test("previewPlan returns validation, diff, and explanation for a valid desired state", () => {
  const api = createInMemoryControllerApi();
  const desiredState: DesiredState = {
    identity: {
      owner: {
        id: "did:example:alice",
        displayName: "Alice",
      },
      passkeysRequired: true,
    },
    storage: {
      dataVolume: {
        encryption: "required",
        snapshots: "daily",
        quotaGiB: 256,
      },
    },
    apps: [
      {
        id: "atproto-pds",
        version: "1.0.0",
        config: {
          allowedCapabilities: ["network.public"],
          publicAccess: true,
          memory: "2GiB",
        },
      },
    ],
    backups: [
      {
        id: "usb-main",
        target: "usb",
        schedule: "daily",
        retentionDays: 30,
      },
    ],
  };

  const preview = dispatchControllerRequest(api, {
    method: "previewPlan",
    params: {
      desiredState,
    },
  });

  assert.equal(preview.ok, true);

  if (!preview.ok || preview.method !== "previewPlan") {
    assert.fail(`expected preview response: ${JSON.stringify(preview)}`);
  }

  assert.equal(preview.response.ok, true);

  if (!preview.response.ok) {
    assert.fail(`expected plan preview to pass: ${JSON.stringify(preview.response.validation)}`);
  }

  assert.equal(preview.response.validation.ok, true);
  assert.ok(preview.response.diff.changes.length > 0);
  assert.equal(
    preview.response.diff.changes.some((change) => change.path === "apps/atproto-pds"),
    true,
  );
  assert.match(preview.response.explanation, /Canonical plan v1/);
  assert.match(preview.response.explanation, /atproto-pds/);
});

test("previewPlan returns a typed validation error for overprivileged input without throwing", () => {
  const api = createInMemoryControllerApi();
  const desiredState: DesiredState = {
    apps: [
      {
        id: "public-dashboard",
        config: {
          publicAccess: true,
        },
      },
    ],
  };

  let preview: ControllerApiDispatchResult | undefined;

  assert.doesNotThrow(() => {
    preview = dispatchControllerRequest(api, {
      method: "previewPlan",
      params: {
        desiredState,
      },
    });
  });

  assert.notEqual(preview, undefined);

  if (preview === undefined || !preview.ok || preview.method !== "previewPlan") {
    assert.fail(`expected preview response: ${JSON.stringify(preview)}`);
  }

  assert.equal(preview.response.ok, false);

  if (preview.response.ok) {
    assert.fail(`expected plan preview to fail: ${JSON.stringify(preview.response)}`);
  }

  assert.equal(preview.response.error.code, "VALIDATION_FAILED");
  assert.deepEqual(
    preview.response.validation.errors.map((error) => error.path),
    ["apps/0/config/publicAccess"],
  );
});

test("dispatcher rejects malformed currentPlan without throwing", () => {
  const cyclicConfig: Record<string, unknown> = {};
  cyclicConfig.self = cyclicConfig;
  const cyclicPlan = {
    ...normalize({}),
    apps: [
      {
        id: "cycle",
        config: cyclicConfig,
      },
    ],
  };

  const throwingConfig: Record<string, unknown> = {};
  Object.defineProperty(throwingConfig, "boom", {
    enumerable: true,
    get() {
      throw new Error("boom");
    },
  });
  const throwingPlan = {
    ...normalize({}),
    apps: [
      {
        id: "throws",
        config: throwingConfig,
      },
    ],
  };

  assertPreviewCurrentPlanRejectsWithoutThrow(cyclicPlan);
  assertPreviewCurrentPlanRejectsWithoutThrow(throwingPlan);
});

function assertPreviewCurrentPlanRejectsWithoutThrow(currentPlan: unknown): void {
  const api = createInMemoryControllerApi();
  let preview: ControllerApiDispatchResult | undefined;

  assert.doesNotThrow(() => {
    preview = dispatchControllerRequest(api, {
      method: "previewPlan",
      params: {
        desiredState: {},
        currentPlan,
      },
    });
  });

  assert.notEqual(preview, undefined);

  if (preview === undefined || preview.ok) {
    assert.fail(`expected invalid currentPlan to fail: ${JSON.stringify(preview)}`);
  }

  assert.equal(preview.error.code, "INVALID_PARAMS");
  assert.match(preview.error.message, /currentPlan/);
}

test("dispatcher rejects unknown methods with a typed error", () => {
  const api = createInMemoryControllerApi();

  const result = dispatchControllerRequest(api, {
    method: "applyPlan",
    params: {},
  });

  assert.equal(result.ok, false);

  if (result.ok) {
    assert.fail(`expected unknown method to fail: ${JSON.stringify(result)}`);
  }

  assert.equal(result.error.code, "UNKNOWN_METHOD");
  assert.match(result.error.message, /applyPlan/);
});
