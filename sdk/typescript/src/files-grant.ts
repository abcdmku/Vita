export type FilesGrantAccess = "read-only" | "read-write";

export interface FilesGrant {
  readonly name: string;
  readonly root: string;
  readonly access: FilesGrantAccess;
}

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
