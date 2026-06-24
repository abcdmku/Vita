export type FilesGrantAccess = "read-only" | "read-write";
export type FilesRole = "owner" | "household-member";

// A per-role grant entry may additionally be "forbidden": the role has NO access
// at all (denied even read), distinct from a read-only role. Forbidden is valid
// only inside a shared grant's roles map, never as a flat grant access.
export type FilesRoleAccess = FilesGrantAccess | "forbidden";

export type FilesGrantRoles = Readonly<Record<FilesRole, FilesRoleAccess>>;

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
