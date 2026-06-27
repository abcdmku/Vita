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
  permits. `WantedBy=multi-user.target` → active in every mode. `APPS_ROOT=/var/lib/vita/apps`.
  **NOTE:** the ExecStart is currently a placeholder; the real binary is wired at integration.
- `vita-kiosk.service` — `cage` (Wayland kiosk compositor) + `chromium --kiosk` pointed at the local
  face. `WantedBy=graphical.target`, `Requires=`/`After=vita-platform.service`. Only the generator's
  `default.target=graphical.target` (desktop mode) activates it; otherwise it is masked.

## Persistence

`/var/lib/vita/apps` lives on the persistent data partition (mounted at `/var` by `var.mount`) and is
created by `tmpfiles.d/vita-apps.conf` before the server starts, in every mode.
