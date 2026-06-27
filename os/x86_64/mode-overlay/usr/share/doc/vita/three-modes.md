# Vita OS — three install modes

Vita ships ONE OS image that supports three install modes, selected at boot by the kernel cmdline
parameter `vita.mode=`:

| `vita.mode=` | platform server | local kiosk (cage + chromium) | network TLS face | default target |
|---|---|---|---|---|
| `headless` (default) | yes | **masked** (no display stack) | no | `multi-user.target` |
| `desktop` | yes | **enabled** on the local display | available | `graphical.target` |
| `network` | yes | **masked** (no display stack) | **exposed** | `multi-user.target` |

## How the selection works

`/usr/lib/systemd/system-generators/vita-mode-generator` runs at early boot, reads `vita.mode=` from
`/proc/cmdline`, and:

1. Writes `/run/vita/platform.env` with `VITA_MODE=<mode>` — `vita-platform.service` reads it so the
   server learns which faces to expose from the same cmdline param.
2. In `headless`/`network`, masks `vita-kiosk.service` (symlinks it to `/dev/null` in the generator's
   early dir) so the kiosk + display path never activates and pulls in no display stack.
3. Sets `default.target` → `graphical.target` for `desktop`, else `multi-user.target`.

Any unrecognized or missing value fails open to `headless` (the safe, no-display default).

## Units

- `vita-platform.service` — the Puter-compatible HTTP server. Serves the LOCAL face on
  `http://127.0.0.1:7681` (all modes) and the TLS NETWORK face on the routable NIC when the mode
  permits. `WantedBy=multi-user.target` → active in every mode. `APPS_ROOT=/var/lib/vita/apps`. The
  ExecStart runs the real platform server on the pinned on-device Deno runtime (`server-entry.ts`).
- `vita-kiosk.service` — `cage` (Wayland kiosk compositor) + `chromium --kiosk` pointed at the local
  face. `WantedBy=graphical.target`, `Requires=`/`After=vita-platform.service`. Only the generator's
  `default.target=graphical.target` (desktop mode) activates it; otherwise it is masked.

## Persistence

The platform server keeps three pieces of per-node state, all under `/var/lib/vita`:

- `apps/` — `APPS_ROOT`, the fs+kv `api_origin` store (per-app data);
- `owner/owner.token` — the minted network-face owner bearer secret;
- `tls/` — owner-provided (or self-signed) network-face TLS material.

All three are created by `tmpfiles.d/vita-apps.conf` (parent `0750 root:vita-agent`, then each subtree)
before the server starts, in every mode.

**On a `VITA_VERITY` build** the read-only dm-verity root and a separate **writable `vita-data`
partition** coexist: `var.mount` (shipped only in the verity overlay) mounts `vita-data` at `/var`, so
the whole `/var/lib/vita` tree — and therefore all three persistence paths — lives on the dedicated data
partition, NOT on the measured read-only root. There is no `systemd.volatile=overlay` (it would tmpfs-
shadow `/var`). `vita-platform.service`, `vita-owner-token.service`, and `vita-platform-selftest.service`
all declare `RequiresMountsFor=` over the paths they touch, so the data partition is mounted before any
of those paths is opened. State survives reboot on this partition.

**On a plain (non-`VITA_VERITY`) smoke image** `vita-data` does not exist; `var.mount` is `nofail`-skipped
(its `ConditionPathExists`/by-label device is absent), and the same `/var/lib/vita/*` paths fall back to
`/var` on the writable root. This rw-root fallback is what the headless smoke boot exercises; the verity
boot exercises the data-partition path. The path text is identical either way — only the backing partition
differs — so the server and units are unchanged between profiles.
