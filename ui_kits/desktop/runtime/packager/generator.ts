// Vita app PACKAGER — the GENERATOR (Phase D, v1). THE CORE.
//
// `generateApp(entry, pkg, loader?)` turns an OS-allowed npm package into a registerable VitaApp:
//
//   • kind "cmd"  (or auto + a package.json `bin`) -> a CMD APP: a VitaApp whose mount() renders a
//     Terminal-style surface scoped to the package's command. It routes commands through the host's
//     exec port (the same optional `exec` seam the first-party Terminal probes); when no exec backend
//     is wired it falls back to a deterministic in-app resolver and prints an HONEST banner ("no exec
//     backend wired"). stdin is the input line; stdout/stderr are the scrollback.
//
//   • kind "desktop" (or auto + a UI entry) -> a DESKTOP APP: a VitaApp whose manifest comes from the
//     package.json (id/title/icon) and whose mount() loads the package's UI into ctx.surface.root,
//     following the "Vita-packageable UI" convention (see below). A plain web/HTML entry gets a generic
//     fallback host (honest placeholder in v1 — the real webview load is the offline-install layer).
//
//   • kind "auto" -> introspect: a `bin` => cmd, else a UI entry (vita.ui / a default mount / a VitaApp
//     default export / vita.web|browser) => desktop.
//
// THE "VITA-PACKAGEABLE UI" CONVENTION (what a UI package exports), in priority order:
//   1. `export default { manifest, mount }`  — a full VitaApp. Registered as-is (capabilities reconciled
//      with the catalog grant). The package is already a first-class Vita app.
//   2. `export default function mount(root, host?) {}` OR `export function <vita.ui>(root, host?) {}`
//      — the SIMPLE path: paint into the desktop-provided element, optionally return a cleanup. The
//      package need not import the Vita SDK.
//   3. `vita.web` / package.json `browser` — a plain HTML/web entry, hosted by the generic web fallback
//      (placeholder in v1; the real offline webview load is the next layer).
//
// Capability mapping: the generated app's manifest.capabilities = the catalog entry's capabilities
// (the OS allowlist is authoritative). A VitaApp default export's own declared capabilities are
// INTERSECTED with the catalog grant (a package can never widen what the OS allowed).
//
// HONEST STUBS (v1): there is no real offline install and no out-of-process exec transport. The module
// loader seam (PackagerModuleLoader) is where the real "SRI-verify -> offline unpack -> mount into a
// capsule -> return the module namespace" goes; v1 is handed an in-repo loader (no network). cmd apps
// with no host exec port stay built-in-only and SAY SO. Nothing here fakes a network install.

import {
  createTerminalAppViewModel,
} from "../../viewmodels/apps/terminal-app.ts";
import type {
  TerminalCommandRequest,
  TerminalCommandResolver,
  TerminalCommandResult,
  TerminalScrollbackLine,
} from "../../viewmodels/apps/terminal-app.ts";
import {
  defineApp,
  isVitaApp,
} from "../app-sdk.ts";
import type {
  AppCapability,
  AppContext,
  AppManifest,
  VitaApp,
} from "../app-sdk.ts";
import type {
  WmElement,
} from "../window-manager.ts";
import type {
  PackageJsonLike,
  PackagerCatalogEntry,
  PackagerError,
  PackagerErrorCode,
  PackagerGenerateResult,
  PackagerGeneratedKind,
  PackagerModuleLoader,
  PackagerModuleNamespace,
  PackagerSurfaceRootLike,
  VitaPackageMount,
} from "./types.ts";

const INPUT_ID = "vita-pkg-cmd-input";
const SCROLLBACK_ID = "vita-pkg-cmd-scrollback";

// ---------------------------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------------------------

// Generate a registerable VitaApp from an OS-allowed package. Async because the module loader (the
// offline-install hook) may be async. Fail-closed: a package that is off-spec for its catalog entry, or
// exposes no resolvable surface, returns an error result rather than a half-app.
export async function generateApp(
  entry: PackagerCatalogEntry,
  pkg: PackageJsonLike,
  loader?: PackagerModuleLoader,
): Promise<PackagerGenerateResult> {
  // The catalog entry is the OS allowlist authority; the package.json must match it exactly (v1 pins an
  // exact version). This is the integrity boundary between "what the OS allowed" and "what was loaded".
  if (pkg.name !== entry.name) {
    return reject("NAME_MISMATCH", `package name "${pkg.name}" does not match catalog entry "${entry.name}".`, "/name");
  }
  if (pkg.version !== entry.version) {
    return reject(
      "VERSION_MISMATCH",
      `package version "${pkg.version}" does not match catalog-pinned "${entry.version}".`,
      "/version",
    );
  }

  const kind = resolveKind(entry, pkg);

  if (kind === undefined) {
    return reject("NO_SURFACE", `package "${entry.name}" exposes neither a bin nor a UI entry; cannot generate an app.`, "/");
  }

  if (kind === "cmd") {
    return accept(generateCmdApp(entry, pkg), entry, "cmd", /*backendWired*/ false);
  }

  return generateDesktopApp(entry, pkg, loader);
}

// ---------------------------------------------------------------------------------------------
// Kind resolution (auto-introspection).
// ---------------------------------------------------------------------------------------------

// Resolve the surface kind. The catalog `kind` wins when it is explicit ("cmd"/"desktop"). For "auto"
// (or an explicit kind we still validate against the package), introspect: a `bin` => cmd, a UI entry
// => desktop. Returns undefined when neither can be determined (NO_SURFACE).
function resolveKind(entry: PackagerCatalogEntry, pkg: PackageJsonLike): PackagerGeneratedKind | undefined {
  if (entry.kind === "cmd") return "cmd";
  if (entry.kind === "desktop") return "desktop";

  // auto — let the package.json + vita meta decide. A bin is the strongest cmd signal.
  if (hasBin(pkg)) return "cmd";
  if (hasUiEntry(pkg)) return "desktop";

  // A vita.kind hint is the last tiebreaker for auto.
  if (pkg.vita?.kind === "cmd") return "cmd";
  if (pkg.vita?.kind === "desktop") return "desktop";

  return undefined;
}

function hasBin(pkg: PackageJsonLike): boolean {
  const bin = pkg.bin;

  if (typeof bin === "string") return bin.length > 0;
  if (bin !== null && typeof bin === "object") return Object.keys(bin).length > 0;

  return false;
}

function hasUiEntry(pkg: PackageJsonLike): boolean {
  return (
    typeof pkg.vita?.ui === "string" ||
    typeof pkg.vita?.web === "string" ||
    typeof pkg.module === "string" ||
    typeof pkg.main === "string" ||
    typeof pkg.browser === "string"
  );
}

// ---------------------------------------------------------------------------------------------
// CMD app generation — a Terminal-style surface scoped to the package's command.
// ---------------------------------------------------------------------------------------------

function generateCmdApp(entry: PackagerCatalogEntry, pkg: PackageJsonLike): VitaApp {
  const commandName = primaryBinName(pkg);
  const manifest = baseManifest(entry, pkg, "💻");

  return defineApp({
    manifest: Object.freeze({
      ...manifest,
      // A cmd app gets no settings form in v1.
    }),
    mount(ctx: AppContext): (() => void) | void {
      return mountCmdSurface(ctx, commandName);
    },
  });
}

// The cmd surface: a scrollback + an input line, driven by the terminal view-model. Commands route
// through the host exec port when present, else a built-in resolver runs the command name as an
// in-process echo of its args (honest: the real out-of-process exec is not wired in v1).
function mountCmdSurface(ctx: AppContext, commandName: string): () => void {
  const root = ctx.surface.root;
  const execPort = readExecPort(ctx.host);
  const hasBackend = execPort !== undefined;
  const resolver = createCmdResolver(commandName, execPort);
  const viewModel = createTerminalAppViewModel({
    initialScrollback: cmdBanner(commandName, hasBackend),
    promptLabel: `${commandName} $`,
    resolver,
  });
  let disposed = false;

  root.style.cssText =
    "display:flex;flex-direction:column;height:100%;background:var(--surface);color:var(--text);" +
    "font:13px/1.55 var(--font-mono,ui-monospace,monospace)";
  root.innerHTML = cmdShell(commandName);
  ctx.window.setBadge(hasBackend ? "shell" : "no exec backend");
  renderScroll();
  focusInput();

  function inputEl(): (WmElement & { value?: string }) | null {
    return (root.querySelector?.(`#${INPUT_ID}`) as (WmElement & { value?: string }) | null) ?? null;
  }

  function fieldValue(): string {
    const value = inputEl()?.value;

    return typeof value === "string" ? value : "";
  }

  function setField(value: string): void {
    const input = inputEl();

    if (input !== null) input.value = value;
  }

  function focusInput(): void {
    try {
      (inputEl() as unknown as { focus?: () => void } | null)?.focus?.();
    } catch {
      // a surface that cannot focus is still usable via clicks; ignore.
    }
  }

  function renderScroll(): void {
    if (disposed) return;

    const state = viewModel.snapshot();
    const scroll = root.querySelector?.(`#${SCROLLBACK_ID}`) ?? null;

    if (scroll !== null) {
      scroll.innerHTML = renderScrollback(state.scrollback);
      scrollToBottom(scroll);
    }
  }

  function runCommand(rawInput: string): void {
    if (rawInput.length > 0) viewModel.type(rawInput);
    viewModel.submit();
    setField("");
    renderScroll();
    focusInput();
  }

  const onKeyDown = (event: unknown): void => {
    if (readKey(event) === "Enter") {
      preventDefault(event);
      runCommand(fieldValue());
    }
  };

  root.addEventListener("keydown", onKeyDown as never);

  const onClick = (): void => focusInput();

  root.addEventListener("click", onClick as never);

  const offClose = ctx.on("close", () => cleanup());

  function cleanup(): void {
    if (disposed) return;
    disposed = true;
    root.removeEventListener?.("keydown", onKeyDown as never);
    root.removeEventListener?.("click", onClick as never);
    offClose();
  }

  return cleanup;
}

// The cmd resolver. The package's command name is implied — the user types ARGS (like a real bin
// prompt). `clear`/`help` stay built-in. When a host exec port exists we surface an HONEST "not
// sync-bridged" error for real execution (the view-model resolver seam is synchronous; a real exec
// transport is async — same honest limitation the first-party Terminal documents). With no exec port,
// the command echoes its args as stdout so the surface is demonstrably live without faking a shell.
function createCmdResolver(commandName: string, execPort: ExecPortLike | undefined): TerminalCommandResolver {
  return Object.freeze({
    resolve(request: TerminalCommandRequest): TerminalCommandResult {
      const typed = request.rawInput.trim();

      if (typed === "" ) {
        return outputResult(Object.freeze([]));
      }
      if (typed === "clear") {
        return Object.freeze({ kind: "clear" as const, ok: true as const });
      }
      if (typed === "help") {
        return outputResult(Object.freeze([
          textLine("output", `${commandName} <args> — runs the packaged command. Built-ins: clear, help.`),
        ]));
      }

      if (execPort !== undefined) {
        // A real exec backend is present but the sync resolver seam can't await it (honest).
        return Object.freeze({
          error: errorOf(
            "EXEC_NOT_BRIDGED",
            "host exec port is present but not yet sync-bridged to the packaged command surface.",
            "/packager/cmd/exec",
          ),
          lines: Object.freeze([
            textLine("error", `exec backend present but not yet sync-bridged: ${commandName} ${typed}`),
          ]),
          ok: false as const,
        });
      }

      // No exec backend wired — echo the args so the surface is live, and stay honest about it.
      return outputResult(Object.freeze([
        textLine("output", `${commandName}: ${typed}`),
        textLine("output", "(no exec backend wired — output is a local echo; real execution lands with the capsule exec transport.)"),
      ]));
    },
  });
}

function cmdBanner(commandName: string, hasBackend: boolean): readonly TerminalScrollbackLine[] {
  const lines: TerminalScrollbackLine[] = [
    Object.freeze({ kind: "output", text: `Vita packaged command: ${commandName}` }),
  ];

  lines.push(Object.freeze(hasBackend
    ? { kind: "output", text: "Connected to the host exec port (sync bridge pending)." }
    : { kind: "output", text: "No exec backend is wired yet — type args; output is a local echo (try: help)." }));

  return Object.freeze(lines);
}

// ---------------------------------------------------------------------------------------------
// DESKTOP app generation — load the package UI into the managed window surface.
// ---------------------------------------------------------------------------------------------

async function generateDesktopApp(
  entry: PackagerCatalogEntry,
  pkg: PackageJsonLike,
  loader: PackagerModuleLoader | undefined,
): Promise<PackagerGenerateResult> {
  // 1. Try to load the package's JS module namespace (the offline-install hook). Absent loader / absent
  //    module => fall through to the web/HTML fallback host.
  let namespace: PackagerModuleNamespace | undefined;

  if (loader !== undefined) {
    try {
      namespace = await loader.load(entry, pkg);
    } catch {
      return reject("MODULE_LOAD_FAILED", `module loader failed closed for "${entry.name}".`, "/loader");
    }
  }

  if (namespace !== undefined) {
    // 1a. A full VitaApp default export — register it, reconciling capabilities with the catalog grant.
    const exportedApp = readVitaAppExport(namespace);

    if (exportedApp !== undefined) {
      return accept(reconcileVitaApp(exportedApp, entry, pkg), entry, "desktop", /*backendWired*/ true);
    }

    // 1b. A `mount(root, host?)` function (vita.ui-named export or default) — the simple convention.
    const mountFn = readMountExport(namespace, pkg.vita?.ui);

    if (mountFn !== undefined) {
      return accept(desktopAppFromMount(entry, pkg, mountFn), entry, "desktop", /*backendWired*/ true);
    }

    // The package shipped a module but nothing usable. If it ALSO declares a web entry, fall through;
    // otherwise this is a bad UI export.
    if (!hasWebEntry(pkg)) {
      return reject(
        "BAD_UI_EXPORT",
        `package "${entry.name}" loaded a module but exports neither a VitaApp default nor a mount(root) function (expected export: ${pkg.vita?.ui ?? "default"}).`,
        "/exports",
      );
    }
  }

  // 2. Web/HTML fallback host (plain web entry, or no JS module at all). Honest placeholder in v1.
  if (hasWebEntry(pkg) || entry.kind === "desktop") {
    return accept(desktopWebFallbackApp(entry, pkg), entry, "desktop", /*backendWired*/ false);
  }

  return reject("NO_SURFACE", `package "${entry.name}" exposes no loadable UI and no web entry.`, "/");
}

// A desktop app from the simple mount(root, host?) convention. The desktop hands the package the
// surface root + a narrow host view; the returned cleanup (if any) runs on window close.
function desktopAppFromMount(entry: PackagerCatalogEntry, pkg: PackageJsonLike, mountFn: VitaPackageMount): VitaApp {
  const capabilities = entry.capabilities;
  const title = resolveTitle(entry, pkg);

  return defineApp({
    manifest: baseManifest(entry, pkg, "📦"),
    mount(ctx: AppContext): (() => void) | void {
      let cleanup: (() => void) | void;

      try {
        cleanup = mountFn(ctx.surface.root as unknown as PackagerSurfaceRootLike, Object.freeze({ capabilities, title }));
      } catch {
        // A package mount that throws must not take down the desktop — show an honest error surface.
        ctx.surface.root.innerHTML = errorSurface(`${title} failed to start.`, "The packaged UI threw during mount.");
        return undefined;
      }

      const off = ctx.on("close", () => {
        try {
          cleanup?.();
        } catch {
          // best-effort cleanup
        }
      });

      return () => {
        try {
          cleanup?.();
        } finally {
          off();
        }
      };
    },
  });
}

// The generic web/HTML fallback host. v1 renders an honest placeholder that names the entry it WOULD
// load and where the real webview/offline-install hook plugs in. It never fakes a loaded page.
function desktopWebFallbackApp(entry: PackagerCatalogEntry, pkg: PackageJsonLike): VitaApp {
  const title = resolveTitle(entry, pkg);
  const webEntry = pkg.vita?.web ?? pkg.browser ?? "(unspecified web entry)";

  return defineApp({
    manifest: baseManifest(entry, pkg, "🌐"),
    mount(ctx: AppContext): void {
      ctx.window.setBadge("web (not loaded)");
      ctx.surface.root.style.cssText =
        "display:flex;align-items:center;justify-content:center;height:100%;padding:24px;" +
        "background:var(--surface);color:var(--text);text-align:center";
      ctx.surface.root.innerHTML =
        `<div style="max-width:420px">` +
        `<div style="font-size:28px;margin-bottom:10px">🌐</div>` +
        `<div style="font-weight:600;margin-bottom:6px">${escapeHtml(title)}</div>` +
        `<div style="color:var(--text-secondary);font-size:13px;line-height:1.6">` +
        `Web entry <code>${escapeHtml(webEntry)}</code> would load here once the offline-install + ` +
        `capsule webview hook is wired. v1 generates the app and registers it; the real page load is the next layer.` +
        `</div></div>`;
    },
  });
}

// Reconcile a package's own VitaApp default export with the catalog entry: the OS allowlist is
// authoritative, so the effective capabilities are the INTERSECTION of what the package declares and
// what the catalog granted (a package can never widen its grant), and the id/title/icon prefer explicit
// overrides (catalog/vita) then the package's own manifest. mount() is preserved unchanged.
function reconcileVitaApp(app: VitaApp, entry: PackagerCatalogEntry, pkg: PackageJsonLike): VitaApp {
  const granted = new Set<AppCapability>(entry.capabilities);
  const effective = app.manifest.capabilities.filter((capability) => granted.has(capability));
  const manifest: AppManifest = {
    capabilities: Object.freeze(effective),
    icon: entry.icon ?? pkg.vita?.icon ?? app.manifest.icon,
    id: app.manifest.id,
    title: entry.title ?? pkg.vita?.title ?? app.manifest.title,
    window: app.manifest.window ?? "managed",
    ...(app.manifest.config !== undefined ? { config: app.manifest.config } : {}),
  };

  return defineApp({
    manifest,
    mount: app.mount.bind(app),
  });
}

// ---------------------------------------------------------------------------------------------
// Manifest + metadata helpers.
// ---------------------------------------------------------------------------------------------

function baseManifest(entry: PackagerCatalogEntry, pkg: PackageJsonLike, defaultIcon: string): AppManifest {
  return Object.freeze({
    capabilities: Object.freeze([...entry.capabilities]),
    icon: entry.icon ?? pkg.vita?.icon ?? defaultIcon,
    id: appIdFor(entry, pkg),
    title: resolveTitle(entry, pkg),
    window: "managed" as const,
  });
}

// Generated app id: explicit vita.id, else a stable id derived from the npm package name. A scoped
// name ("@vita/clock") becomes "vita.pkg.vita-clock"; an unscoped name ("cowsay") becomes
// "vita.pkg.cowsay". Deterministic and collision-resistant within the packaged namespace.
export function appIdFor(entry: PackagerCatalogEntry, pkg: PackageJsonLike): string {
  if (typeof pkg.vita?.id === "string" && pkg.vita.id.length > 0) return pkg.vita.id;

  const slug = entry.name
    .replace(/^@/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  return `vita.pkg.${slug.length > 0 ? slug : "app"}`;
}

function resolveTitle(entry: PackagerCatalogEntry, pkg: PackageJsonLike): string {
  if (typeof entry.title === "string" && entry.title.length > 0) return entry.title;
  if (typeof pkg.vita?.title === "string" && pkg.vita.title.length > 0) return pkg.vita.title;

  const lastSegment = entry.name.split("/").at(-1) ?? entry.name;

  return lastSegment.slice(0, 1).toLocaleUpperCase("en-US") + lastSegment.slice(1);
}

function primaryBinName(pkg: PackageJsonLike): string {
  const bin = pkg.bin;

  if (typeof bin === "string") {
    // A string bin uses the package's (unscoped) name as the command name (npm convention).
    return pkg.name.split("/").at(-1) ?? pkg.name;
  }
  if (bin !== null && typeof bin === "object") {
    const first = Object.keys(bin)[0];

    if (typeof first === "string" && first.length > 0) return first;
  }

  return pkg.name.split("/").at(-1) ?? pkg.name;
}

function hasWebEntry(pkg: PackageJsonLike): boolean {
  return typeof pkg.vita?.web === "string" || typeof pkg.browser === "string";
}

// ---------------------------------------------------------------------------------------------
// Module export probing (defensive — packages are untrusted input).
// ---------------------------------------------------------------------------------------------

// Pull a VitaApp out of a module namespace: a `default` export (or the namespace itself) that satisfies
// isVitaApp. Returns undefined when there is no VitaApp.
function readVitaAppExport(namespace: PackagerModuleNamespace): VitaApp | undefined {
  const candidates = [namespace["default"], namespace];

  for (const candidate of candidates) {
    if (isVitaApp(candidate)) return candidate;
  }

  return undefined;
}

// Pull a mount(root, host?) function out of a module namespace, preferring the export named by
// `vita.ui` (default "default"), then a top-level `mount` export. Returns undefined when none is a
// function. A VitaApp default export is NOT treated as a bare mount fn (readVitaAppExport handles it).
function readMountExport(namespace: PackagerModuleNamespace, exportName: string | undefined): VitaPackageMount | undefined {
  const preferred = exportName ?? "default";
  const ordered = [namespace[preferred], namespace["mount"], namespace["default"]];

  for (const candidate of ordered) {
    if (typeof candidate === "function" && !isVitaApp(candidate)) {
      return candidate as VitaPackageMount;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Exec port probe (mirrors the first-party Terminal's defensive `exec` probe).
// ---------------------------------------------------------------------------------------------

interface ExecPortLike {
  exec(request: { readonly command: string; readonly args: readonly string[] }): Promise<unknown>;
}

function readExecPort(host: unknown): ExecPortLike | undefined {
  if (host === null || typeof host !== "object") return undefined;

  try {
    const descriptor = Object.getOwnPropertyDescriptor(host, "exec");
    const value = descriptor?.value;

    if (value !== null && typeof value === "object" && typeof (value as { exec?: unknown }).exec === "function") {
      return value as ExecPortLike;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Rendering helpers (shared cmd surface markup).
// ---------------------------------------------------------------------------------------------

function cmdShell(commandName: string): string {
  return (
    `<div id="${SCROLLBACK_ID}" style="flex:1;overflow:auto;padding:12px 14px;white-space:pre-wrap;` +
    `word-break:break-word"></div>` +
    `<div style="display:flex;align-items:center;gap:8px;padding:8px 14px;` +
    `border-top:1px solid var(--hairline);background:var(--surface-raised)">` +
    `<span style="color:var(--accent);user-select:none">${escapeHtml(commandName)} $</span>` +
    `<input id="${INPUT_ID}" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" ` +
    `aria-label="Command input" ` +
    `style="flex:1;border:0;outline:0;background:transparent;color:var(--text);` +
    `font:inherit;caret-color:var(--accent)" /></div>`
  );
}

function renderScrollback(lines: readonly TerminalScrollbackLine[]): string {
  if (lines.length === 0) {
    return `<div style="color:var(--text-faint)">Type args and press Enter.</div>`;
  }

  return lines.map((line) => {
    if (line.kind === "input") {
      return (
        `<div><span style="color:var(--accent)">$ </span>` +
        `<span style="color:var(--text)">${escapeHtml(line.text)}</span></div>`
      );
    }

    const color = line.kind === "error" ? "#f87171" : "var(--text-secondary)";

    return `<div style="color:${color}">${escapeHtml(line.text)}</div>`;
  }).join("");
}

function errorSurface(heading: string, detail: string): string {
  return (
    `<div style="display:flex;align-items:center;justify-content:center;height:100%;padding:24px;text-align:center">` +
    `<div style="max-width:420px"><div style="font-weight:600;margin-bottom:6px">${escapeHtml(heading)}</div>` +
    `<div style="color:var(--text-secondary);font-size:13px">${escapeHtml(detail)}</div></div></div>`
  );
}

function scrollToBottom(scroll: WmElement): void {
  try {
    const mutable = scroll as unknown as { scrollTop?: number; scrollHeight?: number };

    if (typeof mutable.scrollHeight === "number") mutable.scrollTop = mutable.scrollHeight;
  } catch {
    // non-DOM surface (tests) has no scroll metrics; ignore.
  }
}

function readKey(event: unknown): string | undefined {
  const key = (event as { key?: unknown }).key;

  return typeof key === "string" ? key : undefined;
}

function preventDefault(event: unknown): void {
  try {
    (event as { preventDefault?: () => void }).preventDefault?.();
  } catch {
    // ignore
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// ---------------------------------------------------------------------------------------------
// Terminal result builders (typed against the view-model contract).
// ---------------------------------------------------------------------------------------------

function outputResult(lines: readonly { kind: "output" | "error"; text: string }[]): TerminalCommandResult {
  return Object.freeze({
    kind: "output" as const,
    lines: Object.freeze([...lines]),
    ok: true as const,
  });
}

function textLine(kind: "output" | "error", text: string): { readonly kind: "output" | "error"; readonly text: string } {
  return Object.freeze({ kind, text });
}

function errorOf(code: string, message: string, path: string): { readonly code: string; readonly message: string; readonly path: string } {
  return Object.freeze({ code, message, path });
}

// ---------------------------------------------------------------------------------------------
// Result helpers.
// ---------------------------------------------------------------------------------------------

function accept(
  app: VitaApp,
  entry: PackagerCatalogEntry,
  kind: PackagerGeneratedKind,
  backendWired: boolean,
): PackagerGenerateResult {
  return {
    ok: true,
    value: Object.freeze({
      app,
      backendWired,
      entry,
      kind,
    }),
  };
}

function reject(code: PackagerErrorCode, message: string, path: string): PackagerGenerateResult {
  return {
    error: errorObject(code, message, path),
    ok: false,
  };
}

function errorObject(code: PackagerErrorCode, message: string, path: string): PackagerError {
  return Object.freeze({ code, message, path });
}
