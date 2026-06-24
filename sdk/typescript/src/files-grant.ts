import type { Role } from "./roles.ts";

export type FilesGrantAccess = "read-only" | "read-write";

// FilesRole is the closed six-role household set (spec §11), re-exported from the
// single role source (roles.ts) so the literals are never duplicated here. A
// role ABSENT from a shared grant's roles map has NO access (the least-privilege
// default); denial is represented by omission, not by a third access value.
export type FilesRole = Role;
export type { Role };

export type FilesRoleAccess = FilesGrantAccess;

// A shared grant's roles map is PARTIAL over the six roles: a role may be listed
// (read-only / read-write) or simply ABSENT (no access at all, the
// least-privilege default). At least one role must be present (an empty map is
// rejected by agentd), but no specific role is required and there is NO implicit
// hierarchy - each listed role's access is exactly its entry.
export type FilesGrantRoles = Readonly<Partial<Record<FilesRole, FilesRoleAccess>>>;

export interface FilesFlatGrant {
  readonly name: string;
  readonly root: string;
  readonly access: FilesGrantAccess;
  readonly shared?: never;
  readonly roles?: never;
}

export interface FilesSharedGrant {
  readonly name: string;
  readonly root: string;
  readonly access?: never;
  readonly shared?: true;
  readonly roles: FilesGrantRoles;
}

export type FilesGrant = FilesFlatGrant | FilesSharedGrant;

export type FilesOperation = "list" | "read" | "write" | "stat";

export interface FilesRequest {
  readonly op: FilesOperation;
  readonly grant: string;
  readonly path: string;
  readonly data?: string;
}

export type FilesEntryKind = "file" | "dir" | "symlink-skipped";

export interface FilesEntry {
  readonly name: string;
  readonly kind: FilesEntryKind;
  readonly size: number;
  readonly mtime: string;
}

export interface FilesResponse {
  readonly entries?: readonly FilesEntry[];
  readonly data?: string;
  readonly kind?: FilesEntryKind;
  readonly size?: number;
  readonly mtime?: string;
}

export interface FilesErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}
