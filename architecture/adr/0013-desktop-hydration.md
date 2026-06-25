# ADR 0013: Binding & Hydration Architecture for the Flagship Desktop UI Package

## Status
Proposed (2026-06-25).

## Context
`ui_kits/desktop/` is the flagship, **swappable** desktop UI package, loaded through the `@vita/desktop-sdk` loader
(which fails closed to a known-good fallback on any mount error — `sdk/typescript/src/desktop-sdk/loader.ts`). Its ONLY
legal dependency is `@vita/desktop-sdk`; ADR 0003/0006 + `protected-policy/boundaries.md` forbid remote imports and heavy
deps. So: **vanilla TS + a tiny reactive core only — no framework, no remote dep.**

Already exists: the static design screens (`index.html` + Shell/Files/Settings/Activity/Notifications/Lock/Tiling, CSS-var
tokens + vendored lucide), and **headless deterministic view-models** at `ui_kits/desktop/viewmodels/*.ts` (each: a factory
taking an injected `Pick<DesktopHost, …>` port subset, a frozen `snapshot()`, and action methods returning frozen
discriminated-union results — fail-closed on missing/denied ports). The package entry `package.ts` implements
`DesktopUiPackage.mount(host)/unmount()`.

**The gap:** nothing turns rendered DOM events into view-model actions, reflects state back into the DOM, or owns the
in-surface lifecycle. **Runtime topology (load-bearing):** two TS contexts — (1) host/control-plane (runs `package.ts`,
where the SDK `DesktopHost` proxy physically lives) and (2) in-surface (the CEF-rendered DOM + view-models). View-models
call `host.launchApp(...)` in context (2) but the proxy is in (1) → we need a **host bridge** that forwards `DesktopHost`
calls across the CEF↔host channel, plain-JSON, fail-closed.

## Decision
A four-layer in-surface runtime — **host bridge → view-models → reactive core → binder** — plus a per-screen hydration
registry, shipped in the package, depending only on `@vita/desktop-sdk` types.

### 1. Binding convention (declarative, framework-free)
Screens carry behavior in **data attributes only** (no inline JS):
- `data-vita-action="<verb>"` — event source; optional `data-vita-event` (default `click`/`input`/`keydown` per element)
  + `data-vita-arg`/`data-vita-arg-*` for static payload. The binder attaches **one delegated listener per event type per
  screen root** and resolves the nearest `[data-vita-action]` ancestor — O(event-types) listeners, survives list re-render.
- `data-vita-bind-<sink>="<path>"` — reflection target. Sinks: `-text` (textContent), `-class` (`"<class>:<stateBool>"`),
  `-attr-<name>`, `-list` (keyed list region). `<path>` is a dotted accessor into the frozen view-model state.
A screen declares its wiring once in a colocated **manifest** mapping `verb → (vm,args,ev) => …` and `path → sink`. HTML
attributes are anchors; the manifest is the typed contract.

### 2. State → DOM reflection (minimal reactive, no vdom)
`runtime/reactive.ts` (~40 lines): `store<T>(initial)` with `get()/set(next)/subscribe(fn)`; `set` reference-compares
(snapshots are frozen + replaced wholesale → ref-inequality == change) and notifies synchronously. The binder subscribes
once per screen; on notify it writes only registered `[data-vita-bind-*]` nodes: text (write-if-changed), class toggle
(`classList.toggle` — exactly how `.v-seg b.on`/`.v-sw.on`/`.v-dtile.on` work), and **keyed list reconcile** (key existing
nodes by `data-vita-key`, reuse+patch matches, append new, remove stale — flat lists only, no recursion). Theme applies
`screenClassName` (class sink) + accent/variant as inline CSS custom props on the root (`root.style.setProperty("--accent",…)`).

### 3. Lifecycle (mirrors the loader fail-closed/rollback)
Host-context lifecycle is unchanged (`package.ts` mount/unmount + loader rollback). New **in-surface** lifecycle
(`runtime/bootstrap.ts`), strictly ordered + fail-closed per step: (1) engine renders entry HTML (static screen is usable
inert before TS runs — the in-surface analogue of the known-good fallback); (2) connect host bridge (`createSurfaceHost()`;
on no channel → a **degraded host** whose required methods return `{ok:false}` and optional ports are absent → screen stays
inert, view-models already fail-closed); (3) instantiate view-models with the bridged port subset (per-screen; a failing
factory aborts only that screen); (4) hydrate (build action/bind maps, delegated listeners, capture bound nodes, push
`snapshot()`, one reflection pass, `lucide.createIcons()` for new nodes); (5) reactive updates (event → action → new frozen
state → `store.set` → reflect; listener has a top-level try/catch routing errors to the screen's error sink, never throws
past); (6) unmount: idempotent `dispose()` (guarded by a `mounted` flag) removes listeners + unsubscribes; the host-side
`unmount()` stopping the web app drives CEF teardown → `dispose()` in `beforeunload`.

### 4. SDK-boundary fit
Imports ONLY from `@vita/desktop-sdk` (types + pure helpers like `hasDesktopCapabilityGrant`). View-models get port subsets,
never the whole host, never a global. Capability gating is NOT re-implemented in the surface — it stays in the loader's host
proxy; the surface trusts the proxy as the single enforcement point. The bridge transports **only plain JSON** (matching the
SDK's `PlainJson` discipline) — no functions/DOM/live objects cross the channel.

### 5. Worked example — ⌘K palette (`index.html`)
Static markup gets anchors: search field `data-vita-action="palette.query" data-vita-event="input"`; palette root
`data-vita-action="palette.nav" data-vita-event="keydown"`; results container `data-vita-bind-list="results"` with a
prototype row carrying `data-vita-key` + `data-vita-bind-text="title"`/`"subtitle"` + `data-vita-bind-class="acc:selected"`;
dock `data-vita-bind-list="dock"` with `data-vita-bind-class="on:active"`. Manifest: ports `{package,launchApp,
emitLauncherIntent}`; `vm = createIndexPaletteViewModel(ports)`; actions `palette.query → vm.setQuery(ev.target.value)`,
`palette.nav → vm.moveSelection(±1)|vm.execute()`; binds `results → list`, `highlightedIndex → row active class`. Flow:
CEF paints (inert) → bridge connect → vm → hydrate (initial ranked list) → type → `setQuery` returns new frozen state →
list reconcile → Enter → `await vm.execute()` (grant-checked, traverses the bridge to the proxy which re-validates) → on
`{ok:false}` write the error sink, never throw.

### 6. File / module layout
```
ui_kits/desktop/
  package.ts, *.html, kit.css, viewmodels/*.ts   # exist (HTML gains data-vita-* anchors)
  runtime/         # NEW — in-surface, @vita/desktop-sdk types only
    reactive.ts    # store/subscribe (~40 lines, no deps)
    binder.ts      # delegated listeners; text/class/attr sinks; keyed list reconcile
    host-bridge.ts # createSurfaceHost(): structural DesktopHost over the CEF↔host channel (degraded mode)
    screen.ts      # ScreenModule type { id, selectPorts, createViewModel, actions, binds }
    hydrate.ts     # hydrateScreen(root, screenModule, host) + disposeScreen()
    bootstrap.ts   # surface entry: detect screen → connect → hydrate → dispose
  screens/         # NEW — one tiny manifest module per screen (imports its viewmodel + SDK types only)
    index.ts settings.ts files.ts shell.ts activity.ts notifications.ts lock.ts tiling.ts
```

### 7. Slice breakdown (all R1; tests via the repo TS test lane, no external DOM lib — a minimal hand-rolled DOM stub)
| id | title | scope | depends_on |
|----|-------|-------|-----------|
| PSD-040 | Reactive core | `runtime/reactive.ts` + tests: store/get/set/subscribe, ref-equality notify, unsubscribe | — |
| PSD-041 | Binder + sinks | `runtime/binder.ts`: delegated listeners, text/class/attr sinks, keyed list reconcile; tests on a tiny DOM stub | PSD-040 |
| PSD-042 | Host bridge | `runtime/host-bridge.ts`: structural `DesktopHost` over a channel transport + degraded/fail-closed mode; plain-JSON-only | — |
| PSD-043 | Hydrate/dispose + screen type + bootstrap | `runtime/{screen,hydrate,bootstrap}.ts`: per-screen isolation, idempotent dispose, inert-on-failure | PSD-040,041,042 |
| PSD-044 | Palette+dock screen (worked example) | `screens/index.ts` + `index.html` anchors; e2e: query→rerank, nav, execute→bridge, fail-closed sink | PSD-043 |
| PSD-045 | Theme/Settings screen | `screens/settings.ts` + `Settings.html` anchors: segment/switch toggles, accent CSS-var, setTheme/Accent/Layout | PSD-043 |
| PSD-046 | Remaining screens | `screens/{files,shell,activity,notifications,lock,tiling}.ts` + anchors | PSD-043 |
| PSD-047 | Bootstrap wiring + lucide ownership | append the module `<script>` to each screen; move `lucide.createIcons()` into `hydrate.ts`; inert-without-bridge smoke | PSD-044,045,046 |

## Consequences
Behavior with zero new deps; design HTML stays valid + reviewable; view-models reused verbatim; the SDK boundary stays
singular (enforcement in the proxy). Fail-closed is layered (static render → degraded host → per-screen isolation → loader
rollback). **The host bridge is the one new load-bearing component** — its degraded mode must be tested or a silent channel
failure becomes an inert desktop with no signal. Keyed reconcile is deliberately flat. Unmount correctness depends on CEF
teardown firing `dispose()` (the `mounted` guard makes a missed teardown safe).
