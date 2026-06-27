// Package Manager meta-API tests — the supporting capability-gated control plane for PERMISSIONS.
//
// Proves, against the REAL platform service + gate + broker + file-backed store:
//   1. LIST installed packages with source location, version, requested + granted caps.
//   2. SOURCE TRANSPARENCY + EDIT: browse the raw tree, read a file, EDIT it → the change is served back
//      (what runs IS the source; no compiled blob).
//   3. PERMISSIONS: requested vs granted; REVOKE a capability → the package's NEXT data-plane call is
//      denied CAP_DENIED / 403 (fail-closed, enforced by the same broker the OS uses).
//   4. AUDIT: capability invocations + DENIALS are visible per package.
//   5. META-CAPABILITY SECURITY: an ordinary app (no `meta` grant) calling /meta/* is denied 403, and a
//      meta-holder cannot grant `meta` (or `control`) to a managed package (non-escalation). One app
//      cannot read another app's source or alter another app's grants.
//   6. DISABLE / ENABLE (kill control).
//
// Run: node --experimental-strip-types --test sdk/typescript/test/ui-kits/puter-pkgmgr.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { startPuterPlatformService } from "../../../../ui_kits/desktop/runtime/puter/server/service.ts";
import type { PuterCapability } from "../../../../ui_kits/desktop/runtime/puter/capability.ts";
import { createAuditLog } from "../../../../ui_kits/desktop/runtime/puter/pkgmgr/audit-log.ts";
import { createMetaPlane } from "../../../../ui_kits/desktop/runtime/puter/pkgmgr/meta-plane.ts";
import { createPackageRegistry } from "../../../../ui_kits/desktop/runtime/puter/pkgmgr/package-registry.ts";
import { nodeSourceFs } from "../../../../ui_kits/desktop/runtime/puter/pkgmgr/node-source-fs.ts";
import { materializeSamples } from "../../../../ui_kits/desktop/runtime/puter/pkgmgr/samples.ts";

const PKGMGR_APP_ID = "vita.pkgmgr";
const PKGMGR_GRANTS: readonly PuterCapability[] = ["meta", "ui", "auth"];

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "vita-pkgmgr-test-"));
}

// Stand up the real local-desktop service with the meta plane mounted + the samples materialized. Returns
// the api base url, the meta token, the per-sample tokens, and a teardown.
async function harness(): Promise<{
  apiBase: string;
  metaToken: string;
  sampleTokens: Record<string, string>;
  appsRoot: string;
  close: () => Promise<void>;
}> {
  const appsRoot = freshDir();
  const samples = materializeSamples(appsRoot);
  const audit = createAuditLog();
  const registry = createPackageRegistry({ fs: nodeSourceFs, seed: samples.packages });

  const service = await startPuterPlatformService({
    appsRoot,
    audit,
    appGrants: { [PKGMGR_APP_ID]: PKGMGR_GRANTS, ...samples.grants },
    faces: { localHost: "127.0.0.1", localPort: 0 },
    metaPlaneFactory: ({ capabilities, grants }) => createMetaPlane({ audit, capabilities, grants, packages: registry }),
    mode: "local-desktop",
    storeAppId: PKGMGR_APP_ID,
  });

  const metaHandle = service.mintApp({ appId: PKGMGR_APP_ID, grants: PKGMGR_GRANTS, instanceId: "pkgmgr-0001" });
  const sampleTokens: Record<string, string> = {};

  for (const pkg of samples.packages) {
    const grants = samples.grants[pkg.id] ?? [];
    const handle = service.mintApp({ appId: pkg.id, grants, instanceId: `${pkg.id}-0001` });

    sampleTokens[pkg.id] = handle.token;
  }

  const apiBase = `${service.localUrl}/api`;

  return {
    apiBase,
    appsRoot,
    close: async () => { await service.close(); rmSync(appsRoot, { force: true, recursive: true }); },
    metaToken: metaHandle.token,
    sampleTokens,
  };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

// ============================================ tests =============================================

test("LIST: meta returns installed packages with source location + caps", async () => {
  const h = await harness();

  try {
    const res = await fetch(`${h.apiBase}/meta/packages`, { headers: bearer(h.metaToken) });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { packages: Array<Record<string, unknown>> };
    const ids = body.packages.map((p) => p.id).sort();

    assert.deepEqual(ids, ["com.acme.tracker", "com.vita.notes"]);

    const notes = body.packages.find((p) => p.id === "com.vita.notes")!;

    assert.equal(notes.version, "1.0.0");
    assert.equal(notes.compiled, false);
    assert.match(String(notes.sourceDir), /com\.vita\.notes[\\/]source$/u);
    assert.deepEqual(notes.requested, ["fs.read", "fs.write", "kv.read", "kv.write"]);
    assert.deepEqual(notes.granted, ["fs.read", "fs.write", "kv.read", "kv.write"]);

    // The tracker shows the requested>granted GAP (granted a restricted read-only subset).
    const tracker = body.packages.find((p) => p.id === "com.acme.tracker")!;

    assert.deepEqual([...(tracker.requested as string[])].sort(), ["auth", "fs.read", "fs.write", "kv.read", "kv.write"]);
    assert.deepEqual([...(tracker.granted as string[])].sort(), ["fs.read", "kv.read"]);
  } finally {
    await h.close();
  }
});

test("SOURCE: browse the raw tree + read a file (no compiled blob)", async () => {
  const h = await harness();

  try {
    const tree = await (await fetch(`${h.apiBase}/meta/packages/com.vita.notes/source?path=/`, { headers: bearer(h.metaToken) })).json() as { nodes: Array<{ name: string; kind: string }> };
    const names = tree.nodes.map((n) => n.name).sort();

    assert.deepEqual(names, ["README.md", "main.ts", "style.css"]);

    const file = await (await fetch(`${h.apiBase}/meta/packages/com.vita.notes/source/file?path=/main.ts`, { headers: bearer(h.metaToken) })).json() as { content: string; digest: string };

    assert.match(file.content, /hello from com\.vita\.notes v1/u);
    assert.ok(file.digest.length > 0);
  } finally {
    await h.close();
  }
});

test("EDIT: writing source takes effect (the change is served back + on disk)", async () => {
  const h = await harness();

  try {
    const newSource = "export function greeting(): string { return \"EDITED hello v2\"; }\n";
    const post = await fetch(`${h.apiBase}/meta/packages/com.vita.notes/source/file`, {
      method: "POST",
      headers: { ...bearer(h.metaToken), "content-type": "application/json" },
      body: JSON.stringify({ path: "/main.ts", content: newSource }),
    });

    assert.equal(post.status, 200);
    const result = (await post.json()) as { success: boolean; digest: string; rebuilt: boolean };

    assert.equal(result.success, true);
    assert.equal(result.rebuilt, true);

    // Re-READ through the meta-API: the edited source is what's served back (open-source-on-device).
    const reread = await (await fetch(`${h.apiBase}/meta/packages/com.vita.notes/source/file?path=/main.ts`, { headers: bearer(h.metaToken) })).json() as { content: string };

    assert.equal(reread.content, newSource);

    // And it's the real on-disk source (no hidden artifact): the file on disk IS the edit.
    const onDisk = readFileSync(join(h.appsRoot, "com.vita.notes", "source", "main.ts"), "utf8");

    assert.equal(onDisk, newSource);
  } finally {
    await h.close();
  }
});

test("PERMISSIONS + FAIL-CLOSED: revoke fs.read → the package's next read is denied 403", async () => {
  const h = await harness();
  const trackerToken = h.sampleTokens["com.acme.tracker"]!;

  try {
    // Before revoke: the tracker HOLDS fs.read, so a readdir succeeds.
    const before = await fetch(`${h.apiBase}/readdir`, {
      method: "POST",
      headers: { ...bearer(trackerToken), "content-type": "application/json" },
      body: JSON.stringify({ path: "/" }),
    });

    assert.equal(before.status, 200);

    // Read the grants view: requested vs granted.
    const grants = await (await fetch(`${h.apiBase}/meta/packages/com.acme.tracker/grants`, { headers: bearer(h.metaToken) })).json() as { requested: string[]; granted: string[] };

    assert.ok(grants.granted.includes("fs.read"));

    // REVOKE fs.read through the meta-API.
    const revoke = await fetch(`${h.apiBase}/meta/packages/com.acme.tracker/grants`, {
      method: "POST",
      headers: { ...bearer(h.metaToken), "content-type": "application/json" },
      body: JSON.stringify({ capability: "fs.read", action: "revoke" }),
    });

    assert.equal(revoke.status, 200);

    // After revoke: the SAME tracker token's next read is DENIED CAP_DENIED / 403 (fail-closed, LIVE).
    const after = await fetch(`${h.apiBase}/readdir`, {
      method: "POST",
      headers: { ...bearer(trackerToken), "content-type": "application/json" },
      body: JSON.stringify({ path: "/" }),
    });

    assert.equal(after.status, 403);
    const err = (await after.json()) as { code: string };

    assert.equal(err.code, "CAP_DENIED");

    // The grants view now reflects the revoke.
    const grantsAfter = await (await fetch(`${h.apiBase}/meta/packages/com.acme.tracker/grants`, { headers: bearer(h.metaToken) })).json() as { granted: string[] };

    assert.ok(!grantsAfter.granted.includes("fs.read"));
  } finally {
    await h.close();
  }
});

test("AUDIT: capability invocations + denials are visible per package", async () => {
  const h = await harness();
  const trackerToken = h.sampleTokens["com.acme.tracker"]!;

  try {
    // Drive an ALLOWED call (tracker holds kv.read) and a DENIED call (tracker lacks fs.write).
    await fetch(`${h.apiBase}/drivers/call`, {
      method: "POST",
      headers: { ...bearer(trackerToken), "content-type": "application/json" },
      body: JSON.stringify({ interface: "puter-kvstore", method: "get", args: { key: "x" } }),
    });
    const denied = await fetch(`${h.apiBase}/mkdir`, {
      method: "POST",
      headers: { ...bearer(trackerToken), "content-type": "application/json" },
      body: JSON.stringify({ path: "/evil" }),
    });

    assert.equal(denied.status, 403);

    const audit = await (await fetch(`${h.apiBase}/meta/packages/com.acme.tracker/audit`, { headers: bearer(h.metaToken) })).json() as {
      denialCount: number;
      entries: Array<{ capability: string; outcome: string; code?: string }>;
    };

    assert.ok(audit.denialCount >= 1, "at least one denial recorded");
    assert.ok(audit.entries.some((e) => e.outcome === "allow" && e.capability === "kv.read"), "the allowed kv.read is logged");
    const denyEntry = audit.entries.find((e) => e.outcome === "deny" && e.capability === "fs.write");

    assert.ok(denyEntry !== undefined, "the denied fs.write is logged");
    assert.equal(denyEntry?.code, "CAP_DENIED");
  } finally {
    await h.close();
  }
});

test("META SECURITY: an ordinary app (no `meta` grant) is denied 403 on /meta/*", async () => {
  const h = await harness();
  // The tracker app has no `meta` capability — its /meta/* call must be denied before any handler runs.
  const trackerToken = h.sampleTokens["com.acme.tracker"]!;

  try {
    const res = await fetch(`${h.apiBase}/meta/packages`, { headers: bearer(trackerToken) });

    assert.equal(res.status, 403);
    const err = (await res.json()) as { code: string };

    assert.equal(err.code, "CAP_DENIED");

    // And with NO token at all → 401 (unauthenticated), never a leak.
    const noTok = await fetch(`${h.apiBase}/meta/packages`);

    assert.equal(noTok.status, 401);
  } finally {
    await h.close();
  }
});

test("META NON-ESCALATION: the meta plane refuses to grant `meta`/`control` to a managed package", async () => {
  const h = await harness();

  try {
    for (const cap of ["meta", "control"]) {
      const res = await fetch(`${h.apiBase}/meta/packages/com.vita.notes/grants`, {
        method: "POST",
        headers: { ...bearer(h.metaToken), "content-type": "application/json" },
        body: JSON.stringify({ capability: cap, action: "grant" }),
      });

      assert.equal(res.status, 403, `granting ${cap} must be refused`);
      const err = (await res.json()) as { code: string };

      assert.equal(err.code, "capability_not_grantable");
    }

    // And granting a capability the package never REQUESTED is refused (the requested set is the ceiling).
    const notReq = await fetch(`${h.apiBase}/meta/packages/com.acme.tracker/grants`, {
      method: "POST",
      headers: { ...bearer(h.metaToken), "content-type": "application/json" },
      // notes requested fs.write; tracker requested it too — pick something tracker did request to grant,
      // then verify granting an un-requested cap to notes is refused. notes did NOT request `auth`.
      body: JSON.stringify({ capability: "auth", action: "grant" }),
    });

    // tracker DID request auth, so this should SUCCEED — use notes (which did not request auth) for refusal.
    assert.equal(notReq.status, 200);

    const refuse = await fetch(`${h.apiBase}/meta/packages/com.vita.notes/grants`, {
      method: "POST",
      headers: { ...bearer(h.metaToken), "content-type": "application/json" },
      body: JSON.stringify({ capability: "auth", action: "grant" }),
    });

    assert.equal(refuse.status, 409);
    const refuseErr = (await refuse.json()) as { code: string };

    assert.equal(refuseErr.code, "capability_not_requested");
  } finally {
    await h.close();
  }
});

test("SOURCE CONFINEMENT: a traversal path cannot escape the package's source dir", async () => {
  const h = await harness();

  try {
    const res = await fetch(`${h.apiBase}/meta/packages/com.vita.notes/source/file?path=${encodeURIComponent("/../../com.acme.tracker/source/main.ts")}`, {
      headers: bearer(h.metaToken),
    });

    // The confinement throws → meta plane maps to a non-2xx (one package cannot read another's source).
    assert.ok(res.status >= 400, `escaping read must fail, got ${res.status}`);
  } finally {
    await h.close();
  }
});

test("DISABLE/ENABLE: a package can be killed and re-enabled", async () => {
  const h = await harness();

  try {
    const disable = await fetch(`${h.apiBase}/meta/packages/com.acme.tracker/disable`, { method: "POST", headers: bearer(h.metaToken) });

    assert.equal(disable.status, 200);
    const d = (await disable.json()) as { package: { state: string } };

    assert.equal(d.package.state, "disabled");

    // A disabled package's source cannot be edited.
    const edit = await fetch(`${h.apiBase}/meta/packages/com.acme.tracker/source/file`, {
      method: "POST",
      headers: { ...bearer(h.metaToken), "content-type": "application/json" },
      body: JSON.stringify({ path: "/main.ts", content: "x" }),
    });

    assert.equal(edit.status, 409);

    const enable = await fetch(`${h.apiBase}/meta/packages/com.acme.tracker/enable`, { method: "POST", headers: bearer(h.metaToken) });

    assert.equal(enable.status, 200);
    const e = (await enable.json()) as { package: { state: string } };

    assert.equal(e.package.state, "installed");
  } finally {
    await h.close();
  }
});
