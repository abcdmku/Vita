# ADR 0015: Host-Side DesktopHost Bridge for CEF Surfaces

## Status
Proposed.

## Context
[ADR-0013](0013-desktop-hydration.md) defines the in-surface runtime: `createSurfaceHost(transport)`
turns desktop SDK calls into plain-JSON `SurfaceHostRequest` values. [ADR-0014](0014-cef-live-render.md)
decides that the live flagship desktop is rendered by CEF and composited by the native compositor.

The missing architectural piece is the host counterparty. `ui_kits/desktop/runtime/host-bridge.ts:44`
declares `SurfaceHostMethod`, and `ui_kits/desktop/runtime/host-bridge.ts:180` implements
`createSurfaceHost(transport)`, but nothing in the CEF browser process receives those requests and
returns the `DesktopHostResult`, `ShellResult`, or direct response JSON that the bridge guards expect.
Likewise, `ui_kits/desktop/package.ts:161` has `mount(host: DesktopHost)`, but the live desktop is not
yet handed a backend-wired, package-scoped `DesktopHost`.

`ui_kits/desktop/runtime/bootstrap.ts:67` declares `TRANSPORT_GLOBALS` and probes
`vitaDesktopBridge`, `vitaHostBridge`, `vitaBridge`, and `__vitaDesktopBridge`. This ADR chooses which
global the host will bind and where the backend proxy lives.

## Decision
The live desktop has one host-side `DesktopHost` proxy owned by the CEF browser-process desktop host.
The renderer never talks to capsule, files, settings, launcher, shell, notification, tray, or theme
backends directly. It calls the in-surface `createSurfaceHost(transport)`, which sends
`SurfaceHostRequest` JSON to the browser-process proxy; the proxy validates, enforces package
capabilities, dispatches to a backend adapter, and returns only JSON that matches the renderer-side
guards.

The same proxy shape is used for both lifecycle surfaces:

- The desktop loader passes the package-scoped proxy to `desktopUiPackage.mount(host)` when the
  flagship package is mounted.
- The CEF browser process exposes the renderer channel for each loaded desktop surface, bound to that
  package instance and manifest.

The renderer-supplied request never selects the package identity or grants. The browser-process host
binds each CEF surface to the package instance that launched it.

## Host-Side DesktopHost Owner
The owner is the native desktop host's CEF browser-process module, named here as the host proxy module.
It is not part of `ui_kits/desktop/` and it is not loaded inside the renderer.

Responsibilities:

- Create one package-scoped `DesktopHost` proxy per mounted desktop UI package.
- Pass that proxy to `mount(host: DesktopHost)` for package lifecycle work.
- Own the CEF renderer channel counterparty for `SurfaceHostRequest`.
- Decode only the known `SurfaceHostMethod` values from `host-bridge.ts:44`.
- Re-serialize validated results before returning them to the renderer.
- Fail closed on unknown methods, malformed JSON, unavailable backends, denied grants, and malformed
  backend responses.

## Channel Transport
Channel transport choice: injected `window.vitaDesktopBridge`.

The CEF browser-process desktop host injects one own data property named `vitaDesktopBridge` before the
desktop surface bootstrap runs. It implements the existing `SurfaceHostTransport` shape:

```ts
window.vitaDesktopBridge = {
  package: desktopUiPackageManifestJson,
  request(request: SurfaceHostRequest): unknown | Promise<unknown> {
    // Native binding into the browser-process host proxy.
  },
};
```

This binds to the first name in `bootstrap.ts:67` `TRANSPORT_GLOBALS`: `vitaDesktopBridge`. The other
probed globals remain compatibility aliases only; new host work must publish `vitaDesktopBridge`.

Raw `CefProcessMessage` IPC is not the SDK-visible carrier. If the CEF implementation uses process
messages below the injected binding, that is an implementation detail hidden behind `window.vitaDesktopBridge`.
The visible contract is a host-injected bridge object because `createSurfaceHost` has synchronous SDK
ports (`readTheme`, shell registration, shell preview/apply/rollback/current, notifications, tray) and
async SDK ports (`launchApp`, `stopApp`, files, settings, launcher). The injected binding must preserve
those return shapes instead of exposing an async-only message bus to the SDK.

The wire remains JSON-only. The host proxy accepts and returns only values compatible with
`host-bridge.ts` `snapshotJson`: finite numbers, strings, booleans, null, dense arrays, and plain objects
within `MAX_JSON_DEPTH`; no functions, DOM handles, prototypes, accessors, symbols, native pointers, or
renderer-owned live objects cross the boundary.

## Backend Port Map
The 15 `SurfaceHostMethod` values map to exactly one host backend adapter each:

| `SurfaceHostMethod` | Host backend |
|---|---|
| `registerComponent` | `compositor/shell layout engine` |
| `previewShell` | `compositor/shell layout engine` |
| `applyShell` | `compositor/shell layout engine` |
| `rollbackShell` | `compositor/shell layout engine` |
| `currentShell` | `compositor/shell layout engine` |
| `launchApp` | `capsule.execute` |
| `stopApp` | `capsule.stop` |
| `postNotification` | `shell notification/tray sink` |
| `registerTrayItem` | `shell notification/tray sink` |
| `requestFile` | `files capability` |
| `readSetting` | `settings store` |
| `previewSetting` | `settings store` |
| `applySetting` | `settings store` |
| `emitLauncherIntent` | `launcher` |
| `readTheme` | `theme store` |

Adapter notes:

- `launchApp` calls the capsule execution backend and returns the resulting surface/window/texture IDs.
- `stopApp` calls the capsule stop backend and returns the stopped app/window/surface state.
- `requestFile` calls the files capability backend selected by the validated file grant.
- `readSetting`, `previewSetting`, and `applySetting` call the settings store.
- `emitLauncherIntent` calls the launcher intent sink.
- `postNotification` and `registerTrayItem` call the shell notification/tray sink.
- `registerComponent`, `previewShell`, `applyShell`, `rollbackShell`, and `currentShell` call the
  compositor/shell layout engine.
- `readTheme` calls the theme store.

## Capability Enforcement
The host proxy is the single capability-enforcement point.

For every request, the proxy checks the mounted package manifest's `capabilityGrants` before any backend
adapter runs. It mirrors the renderer bridge's fail-closed posture and the loader's package-scoped host
proxy model. `DEFAULT_PACKAGE_GRANTS` in `host-bridge.ts:110` documents the renderer's default/degraded
package shape; the browser-process proxy must use the package manifest bound by the loader and must not
trust grant claims carried in renderer JSON.

Required checks:

- `launchApp` requires `apps.launch` for the app ID.
- `stopApp` requires `apps.stop` for the app ID.
- `requestFile` requires the file capability implied by the request and its grant.
- `readSetting` requires `settings.read` for the setting key.
- `previewSetting` and `applySetting` require `settings.write` for the setting key.
- `emitLauncherIntent` requires `launcher.launch` for the intent app target when present.
- `postNotification` requires `shell.notifications.post` for the notification ID.
- `registerTrayItem` requires `shell.tray.register` for the tray item ID.
- Shell layout methods are limited to the package-scoped shell/component rights already enforced by the
  desktop loader and shell layout validator.
- `readTheme` is read-only, but still flows through the proxy so the renderer cannot select a backend.

No backend trusts renderer claims. Backends receive only the proxy's validated, re-serialized request
objects and return values are normalized before crossing back to the renderer.

## Slice DAG
Follow-on implementation slices can fan out from this ADR:

| Slice | Scope | Depends on |
|---|---|---|
| PSD-341 host proxy module | Browser-process package-scoped `DesktopHost` proxy, method decoder, result serializer, fail-closed errors | PSD-340 |
| PSD-342 capsule adapter | `launchApp` -> `capsule.execute`, `stopApp` -> `capsule.stop` | PSD-341 |
| PSD-343 files adapter | `requestFile` -> files capability backend | PSD-341 |
| PSD-344 settings/theme adapter | `readSetting`, `previewSetting`, `applySetting` -> settings store; `readTheme` -> theme store | PSD-341 |
| PSD-345 launcher and shell sinks | `emitLauncherIntent` -> launcher; `postNotification`/`registerTrayItem` -> shell notification/tray sink | PSD-341 |
| PSD-346 shell layout adapter | `registerComponent`, `previewShell`, `applyShell`, `rollbackShell`, `currentShell` -> compositor/shell layout engine | PSD-341 |
| PSD-347 CEF channel binding | Inject `window.vitaDesktopBridge` on `vitaDesktopBridge`; bind requests to the browser-process host proxy | PSD-341 |
| PSD-348 bridge conformance tests | End-to-end JSON, method map, capability-denied, malformed response, unknown method, and degraded/fail-closed tests | PSD-342, PSD-343, PSD-344, PSD-345, PSD-346, PSD-347 |

Dependency edges:

- PSD-340 -> PSD-341.
- PSD-341 -> PSD-342, PSD-343, PSD-344, PSD-345, PSD-346, PSD-347.
- PSD-342, PSD-343, PSD-344, PSD-345, PSD-346, PSD-347 -> PSD-348.

## Consequences
The existing renderer bridge remains unchanged. The browser process becomes the only trusted desktop host
counterparty, capability enforcement remains package-scoped and fail-closed, and backend adapters can be
implemented independently behind a stable method map. The injected `vitaDesktopBridge` global closes the
current orphaned transport without changing the JSON wire contract or the `SurfaceHostMethod` set.
