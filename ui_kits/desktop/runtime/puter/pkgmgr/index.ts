// Vita Package Manager — public barrel.
//
// The Package Manager makes Vita's core differentiator real: every installed package is OPEN raw TS/JS,
// built + run ON the machine (no compiled blob), so the owner can INSPECT + EDIT its actual source AND
// view + ALTER its permissions, with the capability model protecting against malicious behavior.
//
// This barrel exports the SUPPORTING capability-gated meta-API + its backing model. The Puter app UI
// (the `Package Manager.app` web app) consumes the /meta/* surface this exposes.
//
// Pieces:
//   - audit-log.ts        the per-package capability activity stream (invocations + denials)
//   - package-registry.ts the installed-package source-of-truth (source location, version, requested caps)
//   - node-source-fs.ts   the node:fs SourceFsPort (real on-disk source trees, confined per package)
//   - meta-plane.ts       the capability-gated /meta/* control plane for PERMISSIONS

export {
  createAuditLog,
} from "./audit-log.ts";
export type {
  AuditEntry,
  AuditLog,
  AuditLogOptions,
  AuditRecordInput,
} from "./audit-log.ts";

export {
  contentDigest,
  createPackageRegistry,
  PackageRegistryError,
} from "./package-registry.ts";
export type {
  InstalledPackage,
  PackageRegistry,
  PackageRegistryDeps,
  RequestedCapability,
  SourceFsPort,
  SourceNode,
} from "./package-registry.ts";

export {
  nodeSourceFs,
} from "./node-source-fs.ts";

export {
  createMetaPlane,
} from "./meta-plane.ts";
export type {
  MetaPlane,
  MetaPlaneDeps,
  RebuildHook,
} from "./meta-plane.ts";
