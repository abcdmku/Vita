// Puter compat — the HTTP-backed PickerFsClient (browser).
//
// Browses the LOCAL api_origin over loopback HTTP, AS the requesting app, using the app's OWN bearer
// token. Because every fs endpoint on the api_origin is capability-gated on that token (api-origin.ts),
// this client cannot read or write anything the app itself could not — the picker inherits the app's
// exact fs grants. This is the data path behind the puter.ui.* file/dir pickers.
//
// Browser-only: uses `fetch` + `FormData`/`File` (the same surface the puter.js SDK uses for /batch).
// No node imports — safe to bundle into the shell. Pure transport: it carries no scope logic (the
// scope clamp lives in picker-windows.ts; this only talks to the gated origin).

import type { PuterAppSession } from "./capability.ts";
import type { PickerFsClient, PickerFsEntry } from "./picker-windows.ts";

// The browser globals we touch, modelled structurally so the file typechecks under the spike tsconfig
// (no DOM lib) and stays portable. At runtime the real browser satisfies these.
interface FetchLike {
  (input: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
  }>;
}

interface FormDataCtor {
  new (): FormDataLike;
}

interface FormDataLike {
  append(name: string, value: unknown, filename?: string): void;
}

interface FileCtor {
  new (parts: unknown[], name: string, options?: { type?: string }): unknown;
}

interface BlobCtor {
  new (parts: unknown[], options?: { type?: string }): unknown;
}

export interface PickerFsHttpDeps {
  // The api_origin base, e.g. "/api" or "http://127.0.0.1:7700/api". No trailing slash required.
  readonly apiOrigin: string;
  // Injected for tests; default to the browser globals.
  readonly fetch?: FetchLike;
  readonly FormData?: FormDataCtor;
  readonly File?: FileCtor;
  readonly Blob?: BlobCtor;
}

export function createHttpPickerFsClient(deps: PickerFsHttpDeps): PickerFsClient {
  const base = deps.apiOrigin.replace(/\/$/u, "");
  const g = globalThis as unknown as { fetch?: FetchLike; FormData?: FormDataCtor; File?: FileCtor; Blob?: BlobCtor };
  const doFetch = deps.fetch ?? g.fetch;
  const FormDataImpl = deps.FormData ?? g.FormData;
  const FileImpl = deps.File ?? g.File;
  const BlobImpl = deps.Blob ?? g.Blob;

  if (doFetch === undefined) throw new Error("createHttpPickerFsClient: no fetch available");

  async function postJson(path: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await doFetch(`${base}${path}`, {
      body: JSON.stringify(body),
      headers: { "Content-Type": "text/plain;actually=json" },
      method: "POST",
    });

    if (!res.ok) return undefined;

    try {
      return await res.json();
    } catch {
      return undefined;
    }
  }

  function toEntry(raw: unknown): PickerFsEntry | undefined {
    if (raw === null || typeof raw !== "object") return undefined;
    const o = raw as Record<string, unknown>;
    const path = typeof o["path"] === "string" ? o["path"] : undefined;

    if (path === undefined) return undefined;

    return Object.freeze({
      created: numberOf(o["created"]),
      is_dir: o["is_dir"] === true,
      modified: numberOf(o["modified"]),
      name: typeof o["name"] === "string" ? o["name"] : path.slice(path.lastIndexOf("/") + 1),
      path,
      size: numberOf(o["size"]),
      uid: typeof o["uid"] === "string" ? o["uid"] : `fs-${path}`,
    });
  }

  return Object.freeze({
    async mkdirp(session: PuterAppSession, dirPath: string): Promise<void> {
      if (dirPath === "/" || dirPath === "") return;
      await postJson("/mkdir", { auth_token: session.token, create_missing_ancestors: true, parent: "/", path: dirPath.replace(/^\//u, "") });
    },
    async readdir(session: PuterAppSession, dirPath: string): Promise<readonly PickerFsEntry[]> {
      const result = await postJson("/readdir", { auth_token: session.token, path: dirPath });

      if (!Array.isArray(result)) return [];

      const out: PickerFsEntry[] = [];

      for (const raw of result) {
        const e = toEntry(raw);

        if (e !== undefined) out.push(e);
      }

      return Object.freeze(out);
    },
    async stat(session: PuterAppSession, path: string): Promise<PickerFsEntry | undefined> {
      const result = await postJson("/stat", { auth_token: session.token, path });

      return toEntry(result);
    },
    async write(session: PuterAppSession, path: string, content: Uint8Array | string): Promise<PickerFsEntry> {
      if (FormDataImpl === undefined || FileImpl === undefined) {
        throw new Error("createHttpPickerFsClient: FormData/File unavailable for write");
      }

      const slash = path.lastIndexOf("/");
      const parent = slash <= 0 ? "/" : path.slice(0, slash);
      const name = path.slice(slash + 1);
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      const blobPart = BlobImpl !== undefined ? new BlobImpl([bytes]) : bytes;

      const form = new FormDataImpl();
      const operationId = `op-${name}-${Date.now()}`;

      form.append("operation", JSON.stringify({ name, op: "write", operation_id: operationId, overwrite: true, parent, path: parent }));
      form.append("fileinfo", JSON.stringify({ name, size: bytes.byteLength, type: "text/plain" }));
      form.append(operationId, new FileImpl([blobPart], name, { type: "text/plain" }), name);

      const res = await doFetch(`${base}/batch`, {
        body: form,
        headers: { Authorization: `Bearer ${session.token}` },
        method: "POST",
      });

      // Read back the canonical entry via stat so the returned handle reflects the persisted file.
      const persisted = await this.stat(session, path);

      if (persisted !== undefined) return persisted;

      if (!res.ok) throw new Error(`picker write failed: HTTP ${res.status}`);

      const now = Math.floor(Date.now() / 1000);

      return Object.freeze({ created: now, is_dir: false, modified: now, name, path, size: bytes.byteLength, uid: `written-${path.length}-${now.toString(16)}` });
    },
  });
}

function numberOf(value: unknown): number {
  const n = Number(value);

  return Number.isFinite(n) ? n : 0;
}
