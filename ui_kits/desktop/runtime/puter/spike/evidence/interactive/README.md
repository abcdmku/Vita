# Interactive UI — real-browser verification evidence

Captured by `spike/verify-interactive.mjs` driving **headless Chrome** (puppeteer-core) against the
real platform service (`spike/serve-interactive.ts`, the same `startPuterPlatformService` the OS image
launches), local-desktop mode, file-backed store. NO VM — on-device boot is verified separately.

- **13/13 checks passed** (`verify-results.json`) — boot, whoami, create file, edit+save note, KV
  counter, theme, and **persistence of all of them across a full page reload**.
- `files-after-reload.png` — the Vita Desk **file manager after a reload**: the created file +
  `notes` folder are present and the (KV-persisted) slate theme is applied. A real, clickable desktop.
- `note-after-reload.png` — the **notes editor after a reload** showing the exact text saved before
  the reload (proves `fs.write` persisted to the store and reloaded).
- `settings.png` — the KV-backed settings (theme + persisted click counter).

This exercises the genuine **browser-only `fs.write` multipart-upload** path the earlier Node-VM shim
could not reach.

Reproduce:
```sh
node --experimental-strip-types ui_kits/desktop/runtime/puter/spike/serve-interactive.ts --port 7681
# in another shell (with puppeteer-core installed + a local Chrome):
CHROME_PATH=<chrome> node ui_kits/desktop/runtime/puter/spike/verify-interactive.mjs \
  http://127.0.0.1:7681/kiosk-entry.html ./shots
```
