# Vita Package Manager

The interactive surface that makes Vita's core differentiator real: **every installed package is OPEN
raw TS/JS, built + run ON the machine — there is no compiled blob. What runs IS the source.** The owner
can INSPECT + EDIT a package's actual source AND view + ALTER its permissions, with the capability model
protecting against malicious behavior.

It is a Puter app (`pkgmgr-app/`) plus a capability-gated **meta-API** on the local api_origin
(`pkgmgr/` + the `/meta/*` mount in `../api-origin.ts`). AGPL-clean: only the vendored Apache-2.0
puter.js is third-party; everything here is Vita's own code.

## What it does

1. **List** installed packages — for each: its on-device raw SOURCE location (emphasized as *not*
   compiled — what runs IS the source), version, and declared (requested) + currently-granted caps.
2. **Source transparency + edit** — browse a package's raw source tree, open + edit a file, save →
   rebuild/rerun so the change TAKES EFFECT on the running app. No hidden compiled artifact.
3. **Permissions** — per package, REQUESTED vs GRANTED capabilities; GRANT / REVOKE / RESTRICT each,
   backed by the **real** capability model (the broker's `AppGrantRegistry`). Fail-closed: a revoked
   capability is denied (`CAP_DENIED` 403) on the package's very next call.
4. **Audit / protect** — an activity view of capability invocations + DENIALS (from the gate's audit
   log), so unexpected/malicious behavior is visible; plus a disable/kill control.
5. **The meta-API** — capability-gated endpoints to read a package's source + read/alter its per-package
   grants + read the audit log. Default-deny; an app cannot read/alter another app's source or grants.

## The meta-capability security model (why one app can't tamper with another's source/grants)

The meta plane is gated on a new `meta` capability, exactly the way `/control/*` is gated on `control`:

- **Default-deny.** An app holds `meta` only if the platform *declared* it for that app id, and the
  platform declares `meta` for *exactly* the Package Manager app id (`vita.pkgmgr`). An ordinary app's
  grant set never contains `meta`, so its first `/meta/*` call is denied `CAP_DENIED` 403 by the same
  gate that guards fs/kv — before any meta handler runs. (Proven: `META SECURITY` test.)
- **Non-escalating.** The grant-write endpoint REFUSES to add `meta` or `control` to any package's
  grants, and only grants a capability the package actually *requested* (the requested set is the
  ceiling). A meta-holder cannot mint another meta-holder. (Proven: `META NON-ESCALATION` test.)
- **Source-confined.** Every source path is resolved against the *target package's own* source dir and
  confined to it — a `..` climb that escapes throws. One package cannot read another's source. (Proven:
  `SOURCE CONFINEMENT` test.)

## Pieces

| File | Role |
|---|---|
| `pkgmgr/package-registry.ts` | installed-package source-of-truth (source location, version, requested caps) + source browse/read/EDIT over an injected fs port (confined per package). |
| `pkgmgr/node-source-fs.ts` | node:fs `SourceFsPort` (real on-disk source trees). |
| `pkgmgr/audit-log.ts` | per-package capability activity stream (invocations + denials); the gate records every decision here. |
| `pkgmgr/meta-plane.ts` | the `/meta/*` handler — list / source / grants / audit / disable, gated on `meta`. |
| `pkgmgr/samples.ts` | two open-source-on-device sample packages (raw source materialized on disk). |
| `pkgmgr/serve-pkgmgr.ts` | stands up the real platform service with the meta plane + samples (browser/manual). |
| `pkgmgr-app/` | the Package Manager web app (Vita's own HTML/CSS/JS; talks to `/meta/*`). |

## Wiring (what's real vs stubbed)

**Real:** the meta-API end to end against the real platform service + the same capability gate + broker
the OS uses + a file-backed store. Grant changes write the **real** `AppGrantRegistry`, so a revoke is
enforced live (the package's next gated call is denied). The audit log is fed by the real gate on every
allow/deny. Source edits write the real on-disk source (no hidden artifact).

**Stub seam (on-device follow-up):** `RebuildHook` — after a source edit the meta plane calls an injected
rebuild hook so the change takes effect on the running app. The harness serves source directly (re-read
proves the edit), so the default hook is a no-op success; on-device this triggers the capsule
rebuild/rerun. The installed-package set is currently seeded from `samples.ts`; on-device it is fed from
the install record / app registry. (These are integration seams, not gaps in the model.)

## Verify

- Unit/integration (strict TS, no browser):
  `node --experimental-strip-types --test sdk/typescript/test/ui-kits/puter-pkgmgr.test.ts`
- Real headless browser (puppeteer-core + Chrome):
  1. `node --experimental-strip-types ui_kits/desktop/runtime/puter/pkgmgr/serve-pkgmgr.ts --port 7690`
  2. `PPTR_DIR=<dir-with-puppeteer-core> CHROME_PATH=<chrome> node ui_kits/desktop/runtime/puter/pkgmgr/verify-pkgmgr.mjs '<READY_JSON>' ./shots`

  The driver lists packages; views + EDITS source and shows the change takes effect; revokes a permission
  and confirms the package's call is denied 403; sees the audit log; disables a package. 14/14 checks.
