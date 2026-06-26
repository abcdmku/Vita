# ADR 0016: First-Party App Packages for Desktop Apps

## Status
Proposed.

## Context
[ADR-0013](0013-desktop-hydration.md) decides that the flagship desktop UI package is a swappable
desktop shell package, not a hard-coded shell. [ADR-0014](0014-cef-live-render.md) decides that the
live desktop and web surfaces render through CEF and are presented by the compositor. [ADR-0015](0015-desktop-host-bridge.md)
decides that the host-side `DesktopHost` proxy is the browser-process counterparty that enforces
package capabilities before any backend adapter runs.

The next desktop slices need the same framing for apps. Files, Terminal, Settings, Browser, Mail,
Text-Editor, and Activity-Monitor must not become baked-in branches inside the desktop shell. They
need to install, list, launch, stop, and swap through the same separable package model that the
desktop UI already uses.

The existing shape to mirror is `sdk/typescript/src/desktop-sdk/ui-package.ts`:

- `DesktopCapability` and `DesktopCapabilityGrant` at `ui-package.ts:25-39`.
- `DesktopUiPackageManifest` at `ui-package.ts:43-49`.
- `DesktopHost.launchApp(app)` and `DesktopHost.stopApp(appId)` at `ui-package.ts:130-131`.
- `DesktopHost.emitLauncherIntent` at `ui-package.ts:138`.

The existing app surface shape is `WebAppDescriptor` in `sdk/typescript/src/appshell/index.ts:85`:
`surfaceKind: "web"` with `WebviewRuntimeRef` `{ url, partition }`.

## Decision
Desktop apps are separable first-party packages. The desktop shell loads and displays app package
metadata, but the shell does not own app implementation code. First-party apps and third-party apps
use the same package contract, the same host launch seam, and the same host-side capability
enforcement.

The SDK foundation will be implemented later, not in this ADR slice. The decided SDK home is
`sdk/typescript/src/desktop-sdk/app-package.ts`, exported from `sdk/typescript/src/desktop-sdk/index.ts`.

## AppPackageManifest Shape
The SDK home is `sdk/typescript/src/desktop-sdk/app-package.ts`, exported from
`sdk/typescript/src/desktop-sdk/index.ts`.

`AppPackageManifest` mirrors `DesktopUiPackageManifest` for app packages and reuses the same
`DesktopSdkCompatibility`, `DesktopCapabilityGrant`, and `DesktopCapability` vocabulary:

```ts
export interface AppPackageManifest {
  readonly id: string;
  readonly version: string;
  readonly sdkVersion: DesktopSdkCompatibility;
  readonly entry: string;
  readonly capabilityGrants: readonly DesktopCapabilityGrant[];
}
```

Field decisions:

- `id` is the stable app package and app identity used by the registry, launcher, host proxy, and
  `DesktopHost.stopApp(appId)`.
- `version` is the app package version.
- `sdkVersion` is `DesktopSdkCompatibility`, matching `DesktopUiPackageManifest`.
- `entry` is the CEF-rendered web-app HTML/CSS/TS bundle entry, analogous to `DESKTOP_UI_ENTRY` in
  `ui_kits/desktop/package.ts`.
- `capabilityGrants: readonly DesktopCapabilityGrant[]` declares the app package's requested
  desktop capabilities using the same `DesktopCapability` union as desktop UI packages.

Each app package implements the app-package analogue of `DesktopUiPackage`:

```ts
export interface AppPackage {
  readonly manifest: AppPackageManifest;
  descriptor(): WebAppDescriptor;
}
```

`descriptor()` returns the launch descriptor for the package. For first-party desktop apps it must
return a `WebAppDescriptor` with `surfaceKind: "web"` and `runtime.url` resolved from
`manifest.entry`; `runtime.partition` is a stable package-scoped partition. Window hints remain on
the descriptor and are interpreted by the app host and WM, not by the shell.

## App Loader / Host / Window Lifecycle
Apps launch through the existing `DesktopHost.launchApp(app)` seam and stop through
`DesktopHost.stopApp(appId)`. The host returns the existing `DesktopAppLaunch` and `DesktopAppStop`
records, including `surfaceId`, `windowId`, `textureId`, and `intents`.

Lifecycle:

1. The app registry or launcher resolves an installed `AppPackage`.
2. The host loads the package manifest and obtains its `WebAppDescriptor`.
3. `DesktopHost.launchApp(app)` sends that descriptor to the ADR-0015 host proxy.
4. Per ADR-0015 / PSD-340, the host proxy routes `launchApp` to `capsule.execute` and `stopApp` to
   `capsule.stop`.
5. The app host opens the CEF webview from the descriptor's `surfaceKind: "web"` and
   `WebviewRuntimeRef` for `runtime.url` with the package partition, producing a web surface.
6. The WM windows the app on the compositor multi-surface stacking seam from PSD-304, including
   `raise_surface`, `set_z`, and per-surface placement.
7. `DesktopHost.stopApp(appId)` stops the capsule/webview binding and removes the windowed surface.

Apps are therefore windowed app surfaces, not shell subviews. The shell can show dock, launcher, and
registry state, but it does not special-case first-party app code.

## Install / List / Launch Flow
Apps install through the existing separable-package and capsule mechanism, the same path proven for
the desktop package in PSD-001: `packageClass`, `capsule.fetch`, install transaction, then launch and
stop through the host lifecycle. App package installation is transactional and leaves the launcher
with either a validated installed package or no new package.

Apps are listed by the app registry. PSD-361 owns the pure registry/loader view-model that reads the
installed app package metadata and exposes launcher-ready app entries. That registry is a view-model
layer, not a backend privilege boundary.

Apps are launched by the dock and launcher:

- The launcher emits `emitLauncherIntent` through `DesktopHost.emitLauncherIntent` (`ui-package.ts:138`).
- The dock view-model in `ui_kits/desktop/viewmodels/dock.ts` calls `DesktopHost.launchApp(app)` for
  pinned apps.
- The launcher/registry selects an `AppPackage`, obtains its `WebAppDescriptor`, and calls the host
  launch seam.
- The WM windows the launched surface using the PSD-304 placement and stacking seam.

Users can build, ship, install, and swap apps too. Third-party apps implement the same
`AppPackageManifest` and `AppPackage` interface as first-party apps; first-party status changes the
catalog and signing policy, not the runtime launch model.

## Capability Enforcement
Capability enforcement is host-side, package-scoped, and fail-closed. The ADR-0015 host proxy is the
single capability-enforcement point.

For every app request, including `launchApp`, `stopApp`, `requestFile`, `readSetting`,
`previewSetting`, `applySetting`, `emitLauncherIntent`, notification, tray, and future app-facing
desktop ports, the host proxy checks the launched app package's `capabilityGrants` before dispatching
to a backend. If the grant is absent, malformed, or not applicable to the requested resource, the
request fails closed.

No backend trusts renderer claims. The renderer cannot select package identity, grants, capsule
identity, file authority, settings authority, launcher authority, or shell authority. Backends receive
only host-proxy-validated and re-serialized request objects.

Apps are offline by default and remain capability-gated. Package metadata, app entries, and app
bundles must not rely on remote imports, remote assets, or network access. This ADR keeps app packages
consistent with the contract's `allowed_network: false` posture and the ADR-0013/0014/0015 fail-closed
desktop model.

## Slice DAG
Follow-on implementation slices can fan out from this decision:

| Slice | App | Scope | Depends on |
|---|---|---|---|
| PSD-361 | App SDK foundation + registry/loader | Add `app-package.ts`, export it from `desktop-sdk/index.ts`, validate `AppPackageManifest`, and build the pure app registry/loader view-model | ADR-0016, ADR-0015 / PSD-340 |
| PSD-362 | Files | First-party Files `AppPackage`, web entry, manifest, grants, registry fixture, and launch tests | PSD-361, PSD-340, PSD-304 |
| PSD-363 | Terminal | First-party Terminal `AppPackage`, web entry, manifest, grants, registry fixture, and launch tests | PSD-361, PSD-340, PSD-304 |
| PSD-364 | Settings | First-party Settings `AppPackage`, web entry, manifest, grants, registry fixture, and launch tests | PSD-361, PSD-340, PSD-304 |
| PSD-365 | Browser | First-party Browser `AppPackage`, web entry, manifest, grants, registry fixture, and launch tests | PSD-361, PSD-340, PSD-304 |
| PSD-366 | Mail | First-party Mail `AppPackage`, web entry, manifest, grants, registry fixture, and launch tests | PSD-361, PSD-340, PSD-304 |
| PSD-367 | Text-Editor | First-party Text-Editor `AppPackage`, web entry, manifest, grants, registry fixture, and launch tests | PSD-361, PSD-340, PSD-304 |
| PSD-368 | Activity-Monitor | First-party Activity-Monitor `AppPackage`, web entry, manifest, grants, registry fixture, and launch tests | PSD-361, PSD-340, PSD-304 |

Dependency edges:

- ADR-0016 and ADR-0015 / PSD-340 -> PSD-361.
- PSD-361 + PSD-340 + PSD-304 -> PSD-362.
- PSD-361 + PSD-340 + PSD-304 -> PSD-363.
- PSD-361 + PSD-340 + PSD-304 -> PSD-364.
- PSD-361 + PSD-340 + PSD-304 -> PSD-365.
- PSD-361 + PSD-340 + PSD-304 -> PSD-366.
- PSD-361 + PSD-340 + PSD-304 -> PSD-367.
- PSD-361 + PSD-340 + PSD-304 -> PSD-368.

## Consequences
First-party desktop apps are swappable packages rather than shell built-ins. The desktop shell can
render a launcher, dock, and app registry without becoming the owner of app code. App installation and
launching reuse the separable-package and capsule path, app windows reuse the PSD-304 compositor/WM
surface model, and backend access remains behind the ADR-0015 host proxy.

The implementation fan-out is now explicit: one SDK/registry foundation slice, then one independent
slice per first-party app. The main risk is accidental divergence between app-package validation and
desktop UI package validation; PSD-361 must keep the manifest validator aligned with the shape decided
here while preserving host-side fail-closed capability enforcement.
