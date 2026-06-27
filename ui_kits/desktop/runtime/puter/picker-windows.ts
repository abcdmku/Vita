// Puter compat — the puter.ui.* PICKER windows (open/save file, directory, font, color).
//
// A real Puter app's file/font/color dialogs are `puter.ui.*` postMessage calls the ui-broker routes.
// This module turns those routed calls into REAL picker windows in the multi-window shell that browse
// the api_origin fs and resolve with the user's selection — so Notepad's Open/Save actually load/write
// files instead of being no-ops.
//
// Two seams keep this layer testable + decoupled:
//   - `PickerFsClient`: browses the api_origin fs (list a dir, stat a path) AS the requesting app, over
//     the SAME loopback HTTP the app uses, with the app's OWN token. Because the api_origin gates every
//     fs call on that token's grants, the picker can never read beyond what the app may read.
//   - `PickerUi`: renders the actual window (an fs-browser list / a font or color chooser) and resolves
//     with the user's pick. The shell injects a DOM implementation; tests inject a scripted one.
//
// CAPABILITY GATING (the security contract): each app is confined to a fs SCOPE — a root path it may
// browse. `resolveScopeRoot` derives it (default: the whole store root "/", or a per-app override). The
// picker REFUSES to return or navigate to any path outside that root (fail-closed), so an app cannot
// pick a file outside its granted scope even if it forges a path. The ui-broker additionally denies the
// picker entirely to an app lacking the fs.read/fs.write capability (see gateFs in ui-broker.ts).
//
// No DOM, no node here — pure orchestration over the injected seams (house style).

import type { PuterAppSession } from "./capability.ts";
import { basename, dirname, normalizePath } from "./store.ts";
import type {
  BrokerSinks,
  ColorPickerOptions,
  DirectoryPickerOptions,
  FontPickerOptions,
  OpenFilePickerOptions,
  PickedFsEntry,
  SaveFilePickerInput,
} from "./ui-broker.ts";

// ---------------------------------------------------------------------------------------------
// Seams.
// ---------------------------------------------------------------------------------------------

// One fs entry as the api_origin reports it (the store's FsEntry shape — a subset is enough here).
export interface PickerFsEntry {
  readonly name: string;
  readonly path: string;
  readonly is_dir: boolean;
  readonly size: number;
  readonly modified: number;
  readonly created: number;
  readonly uid: string;
}

// Browse the api_origin fs as a specific app session. Every call carries the app's token so the
// api_origin enforces the app's grants; this client never bypasses that gate.
export interface PickerFsClient {
  // List the entries directly under `dirPath` (already scope-validated by the caller). Throws/returns []
  // for a non-existent or non-readable dir.
  readdir(session: PuterAppSession, dirPath: string): Promise<readonly PickerFsEntry[]>;
  // Stat a single path (used to resolve a save destination's existing entry). undefined if absent.
  stat(session: PuterAppSession, path: string): Promise<PickerFsEntry | undefined>;
  // Ensure a directory exists (used so a save into a fresh subdir works). Best-effort.
  mkdirp(session: PuterAppSession, dirPath: string): Promise<void>;
  // Write bytes/text at `path`. Returns the resulting entry. Used by showSaveFilePicker.
  write(session: PuterAppSession, path: string, content: Uint8Array | string): Promise<PickerFsEntry>;
}

// What the user chose in an open/save/dir picker window. The UI resolves with a path (or null on
// cancel). For a multi-select open, an array of paths.
export type PickerChoice =
  | { readonly kind: "open"; readonly paths: readonly string[] }
  | { readonly kind: "save"; readonly path: string }
  | { readonly kind: "directory"; readonly paths: readonly string[] }
  | { readonly kind: "cancel" };

// Render a fs-browser picker window and resolve with the user's choice. `mode` shapes the title +
// affordances. `root` is the scope root the window must not let the user climb above. `listDir` lets
// the window lazily list directories as the user navigates (already scope-clamped by the caller).
export interface PickerUiOpenRequest {
  readonly mode: "open" | "save" | "directory";
  readonly title: string;
  readonly root: string;
  readonly startDir: string;
  readonly multiple: boolean;
  readonly suggestedName?: string;
  readonly accept?: string;
  // List a directory's children (the window calls this on navigation). The implementation clamps to root.
  listDir(dirPath: string): Promise<readonly PickerFsEntry[]>;
}

export interface PickerUi {
  // Open a browse window; resolve when the user confirms or cancels.
  browse(request: PickerUiOpenRequest): Promise<PickerChoice>;
  // Open a font chooser; resolve with the family string (or null on cancel).
  pickFont(options: { readonly defaultFont: string }): Promise<string | null>;
  // Open a color chooser; resolve with the color string (or null on cancel).
  pickColor(options: { readonly defaultColor: string }): Promise<string | null>;
}

export interface PickerSinksDeps {
  readonly fs: PickerFsClient;
  readonly ui: PickerUi;
  // The base the picker builds absolute read/write URLs from (so the SDK's FSItem can parse them).
  // e.g. "http://127.0.0.1:7700/api". The FSItem's read()/write() actually go by PATH, so this is only
  // for the URL the constructor parses.
  readonly apiOrigin: string;
  // Resolve the fs SCOPE root for an app session. Default: "/" (the whole store). Override to confine an
  // app to a subtree (e.g. `/apps/<id>`), which the picker then cannot escape. Pure.
  readonly resolveScopeRoot?: (session: PuterAppSession) => string;
  // Default font/color when the app supplies none.
  readonly defaultFont?: string;
  readonly defaultColor?: string;
}

// The just-the-pickers slice of BrokerSinks (so the shell can spread it into its full sinks object).
export type PickerSinks = Pick<
  BrokerSinks,
  "showOpenFilePicker" | "showSaveFilePicker" | "showDirectoryPicker" | "showFontPicker" | "showColorPicker"
>;

// ---------------------------------------------------------------------------------------------
// Scope helpers (pure). The capability-confinement core: a path is in-scope iff it is the root or a
// descendant of it. Climbing out (..) is already rejected by normalizePath; this adds the per-app root.
// ---------------------------------------------------------------------------------------------

export function defaultScopeRoot(): string {
  return "/";
}

// True iff `path` is within (== or under) `root`. Both are normalized first.
export function isWithinScope(root: string, path: string): boolean {
  const r = normalizePath(root);
  const p = normalizePath(path);

  if (r === "/") return true; // whole store
  return p === r || p.startsWith(`${r}/`);
}

// Clamp a requested dir to the scope: if it escapes, fall back to the root. Throws nothing (fail-safe).
export function clampToScope(root: string, path: string): string {
  try {
    const p = normalizePath(path);

    return isWithinScope(root, p) ? p : normalizePath(root);
  } catch {
    return normalizePath(root);
  }
}

// Build the SDK-facing PickedFsEntry from a browsed fs entry + the api origin. Pure. The read/write URLs
// are absolute + parseable (the SDK's FSItem parses them); .read()/.write() use the path at runtime.
export function toPickedFsEntry(entry: PickerFsEntry, apiOrigin: string): PickedFsEntry {
  const base = apiOrigin.replace(/\/$/u, "");
  const enc = encodeURIComponent(entry.path);
  // A parseable absolute URL with a signature param so the SDK's FSItem URL-parse + signature read work.
  const readUrl = `${absoluteBase(base)}/read?file=${enc}&signature=local&expires=0`;
  const writeUrl = `${absoluteBase(base)}/batch?path=${enc}&signature=local&expires=0`;

  return Object.freeze({
    created: entry.created,
    is_dir: entry.is_dir,
    metadata_url: `${absoluteBase(base)}/stat?path=${enc}`,
    modified: entry.modified,
    name: entry.name,
    path: entry.path,
    read_url: readUrl,
    size: entry.size,
    uid: entry.uid,
    write_url: writeUrl,
  });
}

// Ensure the URL base is absolute so `new URL(...)` in the SDK never throws on a path-only origin. If
// the configured apiOrigin is relative (e.g. "/api"), anchor it to a benign absolute origin — the URL
// is only parsed for its signature, never fetched (FSItem read/write go by path).
function absoluteBase(base: string): string {
  if (/^https?:\/\//iu.test(base)) return base;

  const path = base.startsWith("/") ? base : `/${base}`;

  return `http://127.0.0.1${path}`;
}

// ---------------------------------------------------------------------------------------------
// The picker sinks.
// ---------------------------------------------------------------------------------------------

export function createPickerSinks(deps: PickerSinksDeps): PickerSinks {
  const { fs, ui } = deps;
  const resolveRoot = deps.resolveScopeRoot ?? defaultScopeRoot;
  const defaultFont = deps.defaultFont ?? "System UI";
  const defaultColor = deps.defaultColor ?? "#5b9dff";

  // A scope-clamped directory lister bound to one app session: the window can only ever see entries the
  // app is allowed to (the api_origin token gate) AND within its scope root (the clamp).
  function scopedListDir(session: PuterAppSession, root: string): (dirPath: string) => Promise<readonly PickerFsEntry[]> {
    return async (dirPath: string): Promise<readonly PickerFsEntry[]> => {
      const dir = clampToScope(root, dirPath);
      const entries = await fs.readdir(session, dir);

      // Belt-and-braces: drop anything that somehow resolved out of scope.
      return entries.filter((e) => isWithinScope(root, e.path));
    };
  }

  async function entryFor(session: PuterAppSession, path: string, fallbackName: string): Promise<PickerFsEntry> {
    const stat = await fs.stat(session, path);

    if (stat !== undefined) return stat;

    // A freshly-written/selected path the stat missed — synthesize a minimal entry.
    const now = Math.floor(Date.now() / 1000);

    return Object.freeze({ created: now, is_dir: false, modified: now, name: fallbackName, path, size: 0, uid: `picked-${path.length}-${now.toString(16)}` });
  }

  return Object.freeze({
    async showColorPicker(_session: PuterAppSession, options: ColorPickerOptions): Promise<string | null> {
      return ui.pickColor({ defaultColor: options.defaultColor ?? defaultColor });
    },
    async showDirectoryPicker(session: PuterAppSession, options: DirectoryPickerOptions): Promise<readonly PickedFsEntry[] | null> {
      const root = normalizePath(resolveRoot(session));
      const choice = await ui.browse({
        listDir: scopedListDir(session, root),
        mode: "directory",
        multiple: options.multiple === true,
        root,
        startDir: root,
        title: "Select Folder",
      });

      if (choice.kind !== "directory" || choice.paths.length === 0) return null;

      const picked: PickedFsEntry[] = [];

      for (const p of choice.paths) {
        if (!isWithinScope(root, p)) continue; // fail-closed: never return an out-of-scope dir
        const entry = await entryFor(session, p, basename(p));

        picked.push(toPickedFsEntry({ ...entry, is_dir: true }, deps.apiOrigin));
      }

      return picked.length === 0 ? null : Object.freeze(picked);
    },
    async showFontPicker(_session: PuterAppSession, options: FontPickerOptions): Promise<string | null> {
      return ui.pickFont({ defaultFont: options.defaultFont ?? defaultFont });
    },
    async showOpenFilePicker(session: PuterAppSession, options: OpenFilePickerOptions): Promise<readonly PickedFsEntry[] | null> {
      const root = normalizePath(resolveRoot(session));
      const choice = await ui.browse({
        listDir: scopedListDir(session, root),
        mode: "open",
        multiple: options.multiple === true,
        root,
        startDir: root,
        title: "Open File",
        ...(options.accept === undefined ? {} : { accept: options.accept }),
      });

      if (choice.kind !== "open" || choice.paths.length === 0) return null;

      const picked: PickedFsEntry[] = [];

      for (const p of choice.paths) {
        if (!isWithinScope(root, p)) continue; // fail-closed
        const entry = await entryFor(session, p, basename(p));

        picked.push(toPickedFsEntry(entry, deps.apiOrigin));
      }

      return picked.length === 0 ? null : Object.freeze(picked);
    },
    async showSaveFilePicker(session: PuterAppSession, input: SaveFilePickerInput): Promise<PickedFsEntry | null> {
      const root = normalizePath(resolveRoot(session));
      const choice = await ui.browse({
        listDir: scopedListDir(session, root),
        mode: "save",
        multiple: false,
        root,
        startDir: root,
        title: "Save File",
        ...(input.suggestedName === undefined ? {} : { suggestedName: input.suggestedName }),
      });

      if (choice.kind !== "save") return null;

      const dest = normalizePath(choice.path);

      // Fail-closed: refuse to write outside the app's scope even if the UI returns one.
      if (!isWithinScope(root, dest)) return null;

      // Ensure the parent dir exists, then write the content the app supplied.
      await fs.mkdirp(session, dirname(dest));
      const written = await fs.write(session, dest, input.content);

      return toPickedFsEntry(written, deps.apiOrigin);
    },
  });
}
