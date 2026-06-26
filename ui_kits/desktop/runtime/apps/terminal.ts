// Terminal — a REAL dark terminal surface mounted into a managed window's body.
//
// VitaApp (see app-sdk.ts): this is NOT a file listing. It renders a live scrollback region plus a
// prompt + a real text input line, and drives the terminal view-model (viewmodels/apps/terminal-app.ts)
// which keeps scrollback and command history. Commands run through the host's command/exec port WHEN
// ONE EXISTS; today the DesktopHost bridge exposes no exec capability, so we fall back to the
// deterministic built-in resolver (clear / echo / help) and print an HONEST banner saying no shell
// backend is wired yet. The UI (prompt, echo, history ↑/↓, scrollback, scroll-to-bottom) is fully
// real and interactive — only out-of-process command execution is stubbed, and we say so plainly.
//
// Design note: the DOM <input> is the authoritative edit surface, so the view-model's input buffer is
// kept empty and only set transiently at submit time (`type(value)` from empty → `submit()`). History
// recall (↑/↓) is driven by a local cursor over the view-model's command history and written straight
// into the field. This avoids needing a buffer-reset the view-model does not expose, while keeping the
// view-model the source of truth for scrollback + history.
//
// Token-driven dark theme (var(--surface)/var(--text)/var(--hairline)/var(--accent)). Listeners are
// removed on window close via the returned cleanup (and `on("close")`).

import type {
  DesktopHost,
} from "../../../../sdk/typescript/src/desktop-sdk/index.ts";
import {
  createTerminalAppViewModel,
  createTerminalBuiltInResolver,
} from "../../viewmodels/apps/terminal-app.ts";
import type {
  TerminalCommandRequest,
  TerminalCommandResolver,
  TerminalCommandResult,
  TerminalScrollbackLine,
} from "../../viewmodels/apps/terminal-app.ts";
import {
  defineApp,
} from "../app-sdk.ts";
import type {
  AppContext,
  VitaApp,
} from "../app-sdk.ts";
import type {
  WmElement,
} from "../window-manager.ts";

const INPUT_ID = "vita-terminal-input";
const SCROLLBACK_ID = "vita-terminal-scrollback";

// A shell/exec capability is not part of the typed DesktopHost contract yet. We probe for an optional
// `exec` port the same defensive way activity.ts probes `metrics`; when absent we stay built-in-only.
interface ExecPortLike {
  exec(request: { readonly command: string; readonly args: readonly string[] }): Promise<unknown>;
}

export const terminalApp: VitaApp = defineApp({
  manifest: Object.freeze({
    capabilities: Object.freeze([] as const),
    icon: "⌨️",
    id: "vita.app.terminal",
    title: "Terminal",
    window: "managed",
  }),
  mount(ctx: AppContext) {
    const root = ctx.surface.root;
    const execPort = readExecPort(ctx.host);
    const hasBackend = execPort !== undefined;
    const resolver = hasBackend ? createExecResolver(execPort) : createTerminalBuiltInResolver();
    const viewModel = createTerminalAppViewModel({
      initialScrollback: bootBanner(hasBackend),
      resolver,
    });
    let disposed = false;
    // Local history cursor over viewModel.snapshot().history: null = editing a fresh line.
    let historyCursor: number | null = null;

    root.style.cssText =
      "display:flex;flex-direction:column;height:100%;background:var(--surface);color:var(--text);" +
      "font:13px/1.55 var(--font-mono,ui-monospace,monospace)";
    root.innerHTML = shell();
    ctx.window.setBadge(hasBackend ? "shell" : "no shell backend");
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

      const prompt = root.querySelector?.("[data-vita-terminal-prompt]") ?? null;

      if (prompt !== null) prompt.textContent = state.promptLabel;
    }

    function runCommand(rawInput: string): void {
      // The view-model buffer is empty here (fresh construct or post-submit). Seed it with the exact
      // field value, then submit so the echo + resolver run against precisely what the user typed.
      if (rawInput.length > 0) viewModel.type(rawInput);
      viewModel.submit();
      historyCursor = null;
      setField("");
      renderScroll();
      focusInput();
    }

    function recallHistory(direction: -1 | 1): void {
      const history = viewModel.snapshot().history;

      if (history.length === 0) return;

      if (direction === -1) {
        historyCursor = historyCursor === null
          ? history.length - 1
          : Math.max(0, historyCursor - 1);
        setField(history[historyCursor] ?? "");
        return;
      }

      if (historyCursor === null) return;

      const next = historyCursor + 1;

      if (next >= history.length) {
        historyCursor = null;
        setField("");
        return;
      }

      historyCursor = next;
      setField(history[historyCursor] ?? "");
    }

    // Delegated keydown on the surface root: Enter submits, ArrowUp/ArrowDown walk history.
    const onKeyDown = (event: unknown): void => {
      const key = readKey(event);

      if (key === "Enter") {
        preventDefault(event);
        runCommand(fieldValue());
        return;
      }
      if (key === "ArrowUp") {
        preventDefault(event);
        recallHistory(-1);
        return;
      }
      if (key === "ArrowDown") {
        preventDefault(event);
        recallHistory(1);
        return;
      }
      // Any other edit resets the history cursor so the user is back on a fresh line conceptually.
      if (key !== undefined && key.length === 1) historyCursor = null;
    };

    root.addEventListener("keydown", onKeyDown as never);

    // Clicking anywhere in the surface refocuses the input so the terminal feels alive.
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
  },
});

export default terminalApp;

function bootBanner(hasBackend: boolean): readonly TerminalScrollbackLine[] {
  const lines: TerminalScrollbackLine[] = [
    Object.freeze({ kind: "output", text: "Vita Terminal" }),
  ];

  if (hasBackend) {
    lines.push(Object.freeze({ kind: "output", text: "Connected to the host command port." }));
  } else {
    lines.push(Object.freeze({
      kind: "output",
      text: "No shell backend is wired yet — built-in commands only (try: help).",
    }));
  }

  return Object.freeze(lines);
}

// Adapt an optional host exec port into the terminal resolver contract. This path is only used when
// the host actually exposes `exec`; until then the built-in resolver runs. Because the view-model's
// resolver seam is synchronous and a real exec transport is async, non-built-in commands surface an
// HONEST "not bridged yet" error rather than faking output — built-ins stay local and responsive.
function createExecResolver(_port: ExecPortLike): TerminalCommandResolver {
  const builtIn = createTerminalBuiltInResolver();

  return Object.freeze({
    resolve(request: TerminalCommandRequest): TerminalCommandResult {
      if (
        request.commandName === "" ||
        request.commandName === "clear" ||
        request.commandName === "echo" ||
        request.commandName === "help"
      ) {
        return builtIn.resolve(request) as TerminalCommandResult;
      }

      return Object.freeze({
        error: Object.freeze({
          code: "EXEC_NOT_BRIDGED",
          message: "host exec port is not bridged to the terminal yet.",
          path: "/terminal/exec",
        }),
        lines: Object.freeze([
          Object.freeze({
            kind: "error" as const,
            text: `exec backend present but not yet sync-bridged: ${request.commandName}`,
          }),
        ]),
        ok: false as const,
      });
    },
  });
}

function readExecPort(host: DesktopHost): ExecPortLike | undefined {
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

function shell(): string {
  return (
    `<div id="${SCROLLBACK_ID}" style="flex:1;overflow:auto;padding:12px 14px;white-space:pre-wrap;` +
    `word-break:break-word"></div>` +
    `<div style="display:flex;align-items:center;gap:8px;padding:8px 14px;` +
    `border-top:1px solid var(--hairline);background:var(--surface-raised)">` +
    `<span data-vita-terminal-prompt style="color:var(--accent);user-select:none">vita:~$</span>` +
    `<input id="${INPUT_ID}" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" ` +
    `aria-label="Terminal input" ` +
    `style="flex:1;border:0;outline:0;background:transparent;color:var(--text);` +
    `font:inherit;caret-color:var(--accent)" /></div>`
  );
}

function renderScrollback(lines: readonly TerminalScrollbackLine[]): string {
  if (lines.length === 0) {
    return `<div style="color:var(--text-faint)">Type a command and press Enter.</div>`;
  }

  return lines.map((line) => {
    if (line.kind === "input") {
      return (
        `<div><span style="color:var(--accent)">vita:~$ </span>` +
        `<span style="color:var(--text)">${escapeHtml(line.text)}</span></div>`
      );
    }

    const color = line.kind === "error" ? "#f87171" : "var(--text-secondary)";

    return `<div style="color:${color}">${escapeHtml(line.text)}</div>`;
  }).join("");
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
