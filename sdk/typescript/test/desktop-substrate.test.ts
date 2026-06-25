import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_DESKTOP_SUBSTRATE_DESCRIPTOR,
  DESKTOP_PACKAGE_CLASS,
  DESKTOP_SUBSTRATE_INTERFACE_ID,
  DESKTOP_SUBSTRATE_VERSION,
  buildDesktopInstallPlan,
  buildDesktopLaunchPlan,
  buildDesktopStopPlan,
  desktopPackageToSessionRegistration,
  formatDesktopPackageMarker,
  readDesktopSessionHeartbeatThroughSubstrate,
  validateDesktopPackageManifest,
  validateDesktopSessionHeartbeat,
  validateDesktopSessionHeartbeatObservation,
  validateDesktopSubstrateDescriptor,
} from "../src/desktop-substrate.ts";
import type {
  DesktopCapsuleRegistryEntry,
  DesktopPackageManifest,
  DesktopSubstrateValidationError,
  DesktopSubstrateValidationResult,
} from "../src/desktop-substrate.ts";
import {
  DESKTOP_STUB_REGISTRATION,
  runDesktopStubSession,
} from "../../../packages/desktop-stub/src/session.ts";

const STUB_MANIFEST_PATH = fileURLToPath(
  new URL("../../../packages/desktop-stub/manifest.json", import.meta.url),
);

test("default substrate descriptor defines the headless-safe desktop seam", () => {
  const result = validateDesktopSubstrateDescriptor(DEFAULT_DESKTOP_SUBSTRATE_DESCRIPTOR);

  if (!result.ok) {
    assert.fail(formatErrors(result.errors));
  }

  assert.equal(result.value.interfaceId, DESKTOP_SUBSTRATE_INTERFACE_ID);
  assert.equal(result.value.version, DESKTOP_SUBSTRATE_VERSION);
  assert.equal(result.value.headlessSafe, true);
  assert.deepEqual(result.value.operations, ["discover", "launch", "stop", "heartbeat"]);
  assert.deepEqual(result.value.capabilities, [
    "capsule.registry",
    "capsule.execute",
    "capsule.lifecycle",
    "desktop.session",
  ]);
});

test("desktop stub manifest is a separable desktop package over capsule install launch stop", () => {
  const manifestInput = readStubManifestObject();
  const result = validateDesktopPackageManifest(manifestInput);

  if (!result.ok) {
    assert.fail(formatErrors(result.errors));
  }

  const manifest = result.value;
  assert.equal(manifest.packageClass, DESKTOP_PACKAGE_CLASS);
  assert.equal(manifest.id, "com.vita.desktop.stub");
  assert.equal(Object.hasOwn(manifestInput, "scripts"), false);
  assert.equal(Object.hasOwn(manifestInput, "lifecycle"), false);
  assert.deepEqual(manifest.security.capabilities, []);
  assert.equal(manifest.security.unprivileged, true);
  assert.equal(manifest.security.dynamicUser, true);
  assert.equal(manifest.security.network, "none");
  assert.deepEqual(manifest.session.heartbeatChannel, {
    capability: "capsule.execute",
    kind: "agentd.capsule-health",
  });

  assert.deepEqual(desktopPackageToSessionRegistration(manifest), DESKTOP_STUB_REGISTRATION);

  const existing = Object.freeze([
    Object.freeze({
      id: "constructor",
      integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      state: "installed",
      version: "1.0.0",
    }),
  ]) satisfies readonly DesktopCapsuleRegistryEntry[];
  const install = buildDesktopInstallPlan(manifest, existing);
  const launch = buildDesktopLaunchPlan(manifest);
  const stop = buildDesktopStopPlan(manifest);

  assert.equal(install.operations[0]?.capability, "capsule.registry");
  assert.deepEqual(
    install.operations[0]?.request.desired.capsules.map((entry) => entry.id),
    ["constructor", "com.vita.desktop.stub"],
  );
  assert.deepEqual(launch.operations[0]?.request.desired, {
    id: manifest.capsule.id,
    integrity: manifest.capsule.integrity,
    version: manifest.capsule.version,
  });
  assert.deepEqual(stop.operations[0]?.request.desired, {
    id: manifest.capsule.id,
    op: "stop",
  });

  assert.equal(
    formatDesktopPackageMarker({
      heartbeat: true,
      headlessBoundary: true,
      installed: true,
      launched: true,
      packageClass: "desktop",
    }),
    "VITA-DESKTOP-PKG: class=desktop installed=OK launched=OK heartbeat=OK headless-boundary=OK status=OK",
  );
});

test("desktop stub session registers, emits one heartbeat, and exits stopped", () => {
  const emitted: string[] = [];
  const result = runDesktopStubSession({
    emit: (line) => {
      emitted[emitted.length] = line;
    },
    nonce: () => "stub-test-nonce",
    now: () => "2026-06-24T00:00:00.000Z",
  });

  assert.equal(result.registration.packageClass, "desktop");
  assert.equal(result.registration.packageId, "com.vita.desktop.stub");
  assert.equal(result.stopped, true);
  assert.deepEqual(emitted, [result.heartbeatLine]);
  assert.equal(
    result.heartbeatLine,
    "VITA-DESKTOP-HEARTBEAT: id=com.vita.desktop.stub session=stub-session sequence=1 " +
      "timestamp=2026-06-24T00:00:00.000Z nonce=stub-test-nonce state=running status=OK",
  );

  const heartbeat = validateDesktopSessionHeartbeat(result.heartbeat);
  if (!heartbeat.ok) {
    assert.fail(formatErrors(heartbeat.errors));
  }
  assert.equal(heartbeat.value.timestamp, "2026-06-24T00:00:00.000Z");
  assert.equal(heartbeat.value.nonce, "stub-test-nonce");
});

test("desktop session heartbeat is read through the agentd substrate channel", async () => {
  const registration = DESKTOP_STUB_REGISTRATION;
  const executeState = {
    last: {
      dynamicUid: "61123",
      health: "OK",
      id: "com.vita.desktop.stub",
      integrity: "sha256-sPt3ZRLmh4AiIyy5GMMpd6DAPKE/vAP3KdOOr0kAb6w=",
      status: "OK",
      unit: "vita-capsule-com.vita.desktop.stub.service",
      version: "1.0.0",
    },
  };
  const read = await readDesktopSessionHeartbeatThroughSubstrate({
    readCapsuleExecuteState: async () => executeState,
    registration,
  });

  if (!read.ok) {
    assert.fail(read.reason);
  }

  assert.deepEqual(read.heartbeat, {
    capsuleId: "com.vita.desktop.stub",
    dynamicUid: "61123",
    health: "OK",
    integrity: "sha256-sPt3ZRLmh4AiIyy5GMMpd6DAPKE/vAP3KdOOr0kAb6w=",
    packageId: "com.vita.desktop.stub",
    sessionId: "stub-session",
    state: "running",
    unit: "vita-capsule-com.vita.desktop.stub.service",
    version: "1.0.0",
  });
  assert.deepEqual(validateDesktopSessionHeartbeatObservation(registration, executeState), {
    ok: true,
    value: read.heartbeat,
  });

  const unhealthy = await readDesktopSessionHeartbeatThroughSubstrate({
    readCapsuleExecuteState: async () => ({
      last: {
        ...executeState.last,
        health: "FAIL",
      },
    }),
    registration,
  });
  assert.deepEqual(unhealthy, {
    ok: false,
    reason: "heartbeat_unhealthy",
  });
});

test("desktop package validation rejects privilege, partial, unknown, and hostile shapes", () => {
  const invalid = readStubManifestObject();
  invalid["packageClass"] = "ts-service";
  invalid["scripts"] = { start: "deno run src/main.ts" };
  const security = requiredRecord(invalid["security"]);
  security["capabilities"] = ["CAP_SYS_ADMIN"];

  assert.deepEqual(
    rejectedPaths(validateDesktopPackageManifest(invalid)),
    ["packageClass", "scripts", "security/capabilities"],
  );

  const partial = readStubManifestObject();
  delete partial["substrate"];
  assert.deepEqual(rejectedPaths(validateDesktopPackageManifest(partial)), ["substrate"]);

  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  assertRejected(cyclic);

  const accessor: Record<string, unknown> = {};
  let getterReads = 0;
  Object.defineProperty(accessor, "packageClass", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("getter should not be read");
    },
  });
  assertRejected(accessor);
  assert.equal(getterReads, 0);

  const methodShadowed = readStubManifestObject();
  const substrate = requiredRecord(methodShadowed["substrate"]);
  const operations = requiredArray(substrate["operations"]);
  Object.defineProperty(operations, "includes", {
    enumerable: true,
    value() {
      return true;
    },
  });
  assertRejected(methodShadowed);

  const hostileIterator = readStubManifestObject();
  const hostileSubstrate = requiredRecord(hostileIterator["substrate"]);
  const capabilities = requiredArray(hostileSubstrate["capabilities"]);
  let iteratorReads = 0;
  Object.defineProperty(capabilities, Symbol.iterator, {
    enumerable: true,
    get() {
      iteratorReads += 1;
      throw new Error("iterator should not be read");
    },
  });
  assertRejected(hostileIterator);
  assert.equal(iteratorReads, 0);
});

function readStubManifestObject(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(STUB_MANIFEST_PATH, "utf8"));
  return requiredRecord(parsed);
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    assert.fail("expected record fixture");
  }

  return value as Record<string, unknown>;
}

function requiredArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    assert.fail("expected array fixture");
  }

  return value;
}

function rejectedPaths<T>(result: DesktopSubstrateValidationResult<T>): readonly string[] {
  if (result.ok) {
    assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
  }

  return uniqueSortedPaths(result.errors);
}

function assertRejected(value: unknown): void {
  let errors: readonly DesktopSubstrateValidationError[] | undefined;

  assert.doesNotThrow(() => {
    const result = validateDesktopPackageManifest(value);

    if (result.ok) {
      assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
    }

    errors = result.errors;
  });

  assert.notEqual(errors, undefined);
}

function uniqueSortedPaths(errors: readonly DesktopSubstrateValidationError[]): readonly string[] {
  return [...new Set(errors.map((error) => error.path))].sort();
}

function formatErrors(errors: readonly DesktopSubstrateValidationError[]): string {
  return errors.map((error) => `${error.path}: ${error.message}`).join("\n");
}
