// Vita Package Manager — the META PLANE: the capability-gated control plane for PERMISSIONS.
//
// This is requirement (5): a meta-API that lets the OWNER (through the Package Manager app, and ONLY it)
//   - read any installed package's RAW SOURCE (browse tree + read file) and EDIT it (write → rebuild),
//   - read REQUESTED vs GRANTED capabilities and GRANT / REVOKE / RESTRICT each (the real grant store),
//   - read a package's AUDIT log (capability invocations + denials).
//
// It is mounted on the api_origin behind /meta/* and gated on the `meta` capability, exactly the way
// /control/* is gated on `control`. The security model (why one app can't tamper with another's source
// or grants):
//   - `meta` is DEFAULT-DENY: an app only holds it if the platform DECLARED it for that app's id, and
//     the platform declares `meta` for EXACTLY the Package Manager app id. An ordinary app's grant set
//     never contains `meta`, so its very first /meta/* call is denied CAP_DENIED / 403 by the gate
//     before any handler runs. (Proven by the meta-plane tests + the ondevice gate enforcement.)
//   - `meta` is NON-ESCALATING: the grant-write endpoint REFUSES to add `meta` (or `control`) to any
//     package's grants — so a meta-holder cannot mint another meta-holder or privilege-escalate an app
//     into the permission control plane. The owner's Package Manager is the single root of this plane.
//   - the registry's source port CONFINES every path to the target package's own source dir, so even a
//     valid meta call cannot read/write outside the named package (no cross-package source access).
//
// On a source EDIT (write), the meta-plane invokes an injected `rebuild(pkgId, digest)` hook so the
// change TAKES EFFECT on the running app (the open-source-on-device property: what runs IS the source;
// there is no hidden compiled artifact). The harness hook re-reads + re-serves the source; on-device it
// triggers the capsule rebuild/rerun.

import type { PuterCapabilityRegistry, PuterCapability } from "../capability.ts";
import type { ApiRequest, ApiResponse } from "../api-origin.ts";
import { parseJsonBody } from "../api-origin.ts";
import type { AppGrantRegistry } from "../permission-model.ts";
import type { AuditLog } from "./audit-log.ts";
import {
  PackageRegistryError,
  type InstalledPackage,
  type PackageRegistry,
  type RequestedCapability,
} from "./package-registry.ts";

// The capabilities the owner may GRANT through the meta-plane. Deliberately EXCLUDES `meta` and
// `control` — the permission control plane is not itself grantable to a managed package (non-escalation).
const GRANTABLE: readonly RequestedCapability[] = Object.freeze(["fs.read", "fs.write", "kv.read", "kv.write", "ui", "auth"]);

// The rebuild/rerun hook the meta-plane calls after a source edit, so the change takes effect on the
// running app. Returns a short status string for the UI. On-device: trigger the capsule rebuild. Harness:
// re-read the source (proving what runs IS the edited source). MUST NOT throw for a normal edit.
export type RebuildHook = (pkgId: string, digest: string) => Promise<{ readonly ok: boolean; readonly status: string }>;

export interface MetaPlaneDeps {
  readonly packages: PackageRegistry;
  // The REAL platform grant store the broker enforces. Granting/revoking here changes enforcement LIVE:
  // a revoked capability is denied (CAP_DENIED / 403) on the package's very next gated call.
  readonly grants: AppGrantRegistry;
  readonly audit: AuditLog;
  // The capability registry — used to MINT the gate effect of a grant change (re-declare is enough for
  // the broker; sessions read the live grant store each call). Kept for future per-session revocation.
  readonly capabilities?: PuterCapabilityRegistry;
  readonly rebuild?: RebuildHook;
}

// The meta-plane surface mounted on the api_origin. `handle` is async (source/rebuild are async-shaped).
export interface MetaPlane {
  // True for any /meta/* path this plane owns (so the api_origin can route to it).
  owns(path: string): boolean;
  // Handle a /meta/* request. The api_origin gates it on `meta` BEFORE calling this (so a handler only
  // runs for a meta-holder); this dispatches to the concrete endpoint.
  handle(req: ApiRequest, method: string, path: string): Promise<ApiResponse>;
}

const TEXT = (s: string): Uint8Array => new TextEncoder().encode(s);
const JSON_CT = "application/json";

export function createMetaPlane(deps: MetaPlaneDeps): MetaPlane {
  const { audit, grants, packages } = deps;

  function json(status: number, value: unknown): ApiResponse {
    return Object.freeze({
      body: TEXT(JSON.stringify(value)),
      headers: Object.freeze({
        "access-control-allow-headers": "authorization,content-type",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-origin": "*",
        "content-type": JSON_CT,
      }),
      status,
    });
  }

  function error(status: number, code: string, message: string): ApiResponse {
    return json(status, { code, error: { code, message }, message, success: false });
  }

  function mapErr(err: unknown): ApiResponse {
    if (err instanceof PackageRegistryError) return error(err.status, err.code, err.message);

    return error(500, "internal_error", err instanceof Error ? err.message : "meta plane error");
  }

  // Project an installed package + its live granted set + its denial count into the UI-facing row.
  function packageView(pkg: InstalledPackage): unknown {
    const granted = grants.grantsFor(pkg.id);

    return {
      id: pkg.id,
      name: pkg.name,
      version: pkg.version,
      kind: pkg.kind,
      description: pkg.description,
      state: pkg.state,
      // The open-source-on-device property, made explicit for the UI.
      sourceDir: pkg.sourceDir,
      entry: pkg.entry,
      compiled: false,
      requested: [...pkg.requested],
      granted: [...granted].filter((c): c is RequestedCapability => (GRANTABLE as readonly string[]).includes(c)),
      denialCount: audit.denialCount(pkg.id),
    };
  }

  // ---- grant alteration (grant / revoke / restrict) ----
  // The request names a capability + an action. We compute the next granted set, REFUSE to add a
  // non-grantable capability (meta/control — non-escalation), then write the REAL grant store. The broker
  // reads the grant store on the package's next call, so the change is enforced LIVE (fail-closed).
  function applyGrantChange(pkgId: string, capability: string, action: string): ApiResponse {
    const pkg = packages.get(pkgId);

    if (pkg === undefined) return error(404, "no_such_package", `no such package: ${pkgId}`);

    if (!(GRANTABLE as readonly string[]).includes(capability)) {
      // Refuse to grant/manage `meta`, `control`, or anything unknown — the permission control plane is
      // not grantable to a managed package, and the gate would deny an unknown capability anyway.
      return error(403, "capability_not_grantable", `capability is not grantable through the meta plane: ${capability}`);
    }

    const cap = capability as RequestedCapability;
    const current = new Set<RequestedCapability>(
      [...grants.grantsFor(pkgId)].filter((c): c is RequestedCapability => (GRANTABLE as readonly string[]).includes(c)),
    );

    if (action === "grant") {
      // The owner may only grant a capability the package actually REQUESTED (no granting beyond the
      // manifest's declared surface — the requested set is the ceiling).
      if (!pkg.requested.includes(cap)) {
        return error(409, "capability_not_requested", `package did not request capability: ${capability}`);
      }

      current.add(cap);
    } else if (action === "revoke" || action === "restrict") {
      // revoke and restrict both remove the capability from the granted set (restrict = revoke a
      // previously-granted write while keeping a sibling read is expressed by the client choosing which
      // capability to revoke, e.g. revoke fs.write but keep fs.read).
      current.delete(cap);
    } else {
      return error(400, "bad_action", `unknown grant action: ${action}`);
    }

    // Write the REAL grant store. declare() REPLACES the package's grant set, so the broker enforces the
    // new set on the very next call. We carry forward any non-grantable caps the platform set (none for
    // ordinary packages, but be defensive) so a UI grant edit never silently drops a platform grant.
    const preserved = [...grants.grantsFor(pkgId)].filter((c) => !(GRANTABLE as readonly string[]).includes(c)) as PuterCapability[];

    grants.declare(pkgId, [...current, ...preserved]);

    return json(200, { success: true, package: packageView(packages.get(pkgId) ?? pkg) });
  }

  function matchPkgRoute(path: string): { id: string; leaf: string; sub: string } | undefined {
    // /meta/packages/:id            → leaf="", sub=""
    // /meta/packages/:id/source     → leaf="source", sub=""
    // /meta/packages/:id/source/file→ leaf="source", sub="file"
    // /meta/packages/:id/grants     → leaf="grants"
    // /meta/packages/:id/audit      → leaf="audit"
    // /meta/packages/:id/disable    → leaf="disable"
    // /meta/packages/:id/enable     → leaf="enable"
    const m = /^\/meta\/packages\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/u.exec(path);

    if (m === null) return undefined;

    return { id: decodeURIComponent(m[1] ?? ""), leaf: m[2] ?? "", sub: m[3] ?? "" };
  }

  async function handleSourceEdit(pkgId: string, req: ApiRequest): Promise<ApiResponse> {
    const body = parseJsonBody(req.body);
    const relPath = typeof body["path"] === "string" ? body["path"] : undefined;
    const content = typeof body["content"] === "string" ? body["content"] : undefined;

    if (relPath === undefined) return error(400, "field_missing", "path is required");
    if (content === undefined) return error(400, "field_missing", "content is required");

    const written = packages.writeSource(pkgId, relPath, content);
    // Trigger rebuild/rerun so the edit takes effect on the running app (open-source-on-device). Default
    // hook is a no-op success when none is injected (the harness re-reads source directly).
    const rebuilt = deps.rebuild !== undefined
      ? await deps.rebuild(pkgId, written.digest)
      : { ok: true, status: "no rebuild hook (source served directly)" };

    return json(200, {
      success: true,
      path: relPath,
      bytes: written.bytes,
      digest: written.digest,
      rebuilt: rebuilt.ok,
      rebuildStatus: rebuilt.status,
    });
  }

  return Object.freeze({
    async handle(req: ApiRequest, method: string, path: string): Promise<ApiResponse> {
      try {
        // GET /meta/packages — list installed packages.
        if (method === "GET" && path === "/meta/packages") {
          return json(200, { packages: packages.list().map(packageView) });
        }

        const route = matchPkgRoute(path);

        if (route === undefined) {
          return error(404, "endpoint_not_found", `no such meta endpoint: ${method} ${path}`);
        }

        // GET /meta/packages/:id — one package's detail.
        if (method === "GET" && route.leaf === "") {
          const pkg = packages.get(route.id);

          if (pkg === undefined) return error(404, "no_such_package", `no such package: ${route.id}`);

          return json(200, packageView(pkg));
        }

        // ---- source: browse / read / edit ----
        if (route.leaf === "source") {
          // GET /meta/packages/:id/source?path=/  — browse the source tree.
          if (method === "GET" && route.sub === "") {
            const rel = req.query["path"] ?? "/";

            return json(200, { id: route.id, path: rel, nodes: packages.browseSource(route.id, rel) });
          }

          // GET /meta/packages/:id/source/file?path=/main.ts — read a raw source file.
          if (method === "GET" && route.sub === "file") {
            const rel = req.query["path"];

            if (rel === undefined || rel === "") return error(400, "field_missing", "path is required");

            const text = packages.readSource(route.id, rel);

            return json(200, { id: route.id, path: rel, content: text, digest: digestOf(text) });
          }

          // POST /meta/packages/:id/source/file { path, content } — EDIT a raw source file → rebuild.
          if (method === "POST" && route.sub === "file") {
            return await handleSourceEdit(route.id, req);
          }
        }

        // ---- grants: read requested vs granted, grant/revoke/restrict ----
        if (route.leaf === "grants") {
          if (method === "GET") {
            const pkg = packages.get(route.id);

            if (pkg === undefined) return error(404, "no_such_package", `no such package: ${route.id}`);

            const granted = grants.grantsFor(route.id);

            return json(200, {
              id: route.id,
              requested: [...pkg.requested],
              granted: [...granted].filter((c): c is RequestedCapability => (GRANTABLE as readonly string[]).includes(c)),
              grantable: [...GRANTABLE],
            });
          }

          // POST /meta/packages/:id/grants { capability, action: grant|revoke|restrict }
          if (method === "POST") {
            const body = parseJsonBody(req.body);
            const capability = typeof body["capability"] === "string" ? body["capability"] : "";
            const action = typeof body["action"] === "string" ? body["action"] : "";

            return applyGrantChange(route.id, capability, action);
          }
        }

        // ---- audit: the per-package activity stream (invocations + denials) ----
        if (route.leaf === "audit" && method === "GET") {
          const pkg = packages.get(route.id);

          if (pkg === undefined) return error(404, "no_such_package", `no such package: ${route.id}`);

          const limit = clampLimit(req.query["limit"]);

          return json(200, {
            id: route.id,
            denialCount: audit.denialCount(route.id),
            entries: audit.forApp(route.id, limit),
          });
        }

        // ---- disable (kill) / enable a package ----
        if (route.leaf === "disable" && method === "POST") {
          const updated = packages.setState(route.id, "disabled");

          if (updated === undefined) return error(404, "no_such_package", `no such package: ${route.id}`);

          return json(200, { success: true, package: packageView(updated) });
        }

        if (route.leaf === "enable" && method === "POST") {
          const updated = packages.setState(route.id, "installed");

          if (updated === undefined) return error(404, "no_such_package", `no such package: ${route.id}`);

          return json(200, { success: true, package: packageView(updated) });
        }

        return error(404, "endpoint_not_found", `no such meta endpoint: ${method} ${path}`);
      } catch (err) {
        return mapErr(err);
      }
    },
    owns(path: string): boolean {
      return path === "/meta/packages" || path.startsWith("/meta/packages/") || path.startsWith("/meta/");
    },
  });
}

function digestOf(text: string): string {
  let h = 2166136261;

  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return (h >>> 0).toString(16).padStart(8, "0");
}

function clampLimit(raw: string | undefined): number {
  const n = Number(raw);

  if (!Number.isFinite(n) || n <= 0) return 200;

  return Math.min(1000, Math.floor(n));
}
