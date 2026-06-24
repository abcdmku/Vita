export type FilesGrantAccess = "read-only" | "read-write";
export type FilesRole = "owner" | "household-member";

export type FilesGrantRoles = Readonly<Record<FilesRole, FilesGrantAccess>>;

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
