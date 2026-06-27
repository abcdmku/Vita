# Vita ⇄ Puter desktop integration — HANDOFF & PLAN

**Status: IN PROGRESS — paused at capsule-packaging. Resume in a FRESH session** (the originating
session degraded: build agents started dying on spawn with 0-byte transcripts = resource sprawl; a
clean session fixes it). Owner decision 2026-06-27 (memory `vita-puter-desktop-adopt`): adopt the real
Puter desktop as Vita's desktop, Vita stays the secure host, Puter as a hardened OCI capsule, FORKED +
REBRANDED to Vita, backed by Vita's REAL storage. Branch: **`feat/vita-puter-desktop`** (worktree
`C:\Users\Borg\vita-puter-build`, base `main` @ 92122d8).

## Spike result — GO (proven, with evidence)
- Real Puter **v2.5.1** (github HEAD `9846108`) runs **fully OFFLINE** as a single owner, renders, and
  **persists files across a backend restart**. Orchestrator-verified screenshot: `scratchpad/puter-offline.png`.
- Built tree in **WSL Ubuntu**: `/home/borg/puter-spike/puter` — `node_modules` 974M with **prebuilt**
  native `.node` (better-sqlite3/bcrypt/sharp), `dist/` built. Single Node process, **port 4100**, SQLite +
  in-process fauxqs(S3) + dynalite(KV). Zero non-loopback connections in steady state.
- **Data dir**: `volatile/runtime/` (`puter-database.sqlite` + `fauxqs-s3-data` file blobs + `puter-ddb` KV).
- Single-owner offline config: `database.engine=sqlite, disable_temp_users=true, captcha.enabled=false,
  providers.ollama.enabled=false, env=dev, domain=puter.localhost`.

## Done so far (in `/home/borg/puter-spike/puter`, NOT yet committed to git — it's the WSL build tree)
- **Offline GUI patch APPLIED** (`src/gui/src/index.js`, `js.puter.com`→0): prod bundle `js.puter.com/v2/`
  → local `/puter.js/v2/`; guarded the unconditional `challenges.cloudflare.com/turnstile` await. Reference
  diff: `scratchpad/patched-index.js`.
- **Rebrand (PARTIAL)** — 5 source patches (log: `/home/borg/puter-spike/vita-rebrand.patchlog`;
  `.vita-orig` backups beside each): UIDesktop logo tooltip, `globals.js` root_dirname, `definitions.js`
  process name, `initgui.js` tab-title fallback, `en.js` welcome/tagline → all Puter→Vita. "Personal
  Internet Computer" = 0 in the bundle.
- ⚠️ **The dist GUI bundle needs a REBUILD** after these source patches (`dist/gui.js` still showed Vita=0
  → rebuild so the Vita strings land: rebuild the GUI per Puter's build, then re-verify offline render).
- Worktree has an untracked `forks/` dir (start of the patch-set capture) — commit it.

## ENVIRONMENT GOTCHAS (critical — these cost hours)
- **WSL: always `wsl -d Ubuntu`.** The DEFAULT distro is `docker-desktop` (busybox, NO bash) → plain
  `wsl bash` fails with "bash: not found".
- **Node 22**, not 24. Ubuntu has v22.22.1; the prebuilt `.node` ABI targets Node 22 (the spike report's
  "Node 24" was wrong). Bake Node 22 into the OCI image; verify `node -e "require('better-sqlite3')"` in the
  rootfs before sealing.
- **WSL quoting:** do NOT use `wsl -d Ubuntu bash -c "...nested quotes/parens..."` (mangled through
  PowerShell→wsl→bash). Write a `.sh` file and run it, or run commands directly: `wsl -d Ubuntu <cmd> <args>`.
- **Agents dying mid-run** = Anthropic API **`529 Overloaded`** (TRANSIENT server-side overload on long heavy
  agent runs) — NOT local resource exhaustion (an earlier misdiagnosis). They do real work then get killed by
  the 529. Mitigate: retry when the API is healthier; prefer SHORTER agent runs (one stage each) over one giant
  multi-stage agent, so a 529 loses less; the main loop survives (only the heavy subagents 529). Do NOT
  `SendMessage` an agent right after spawning — it corrupts the spawn (killed one separately).

## Remaining plan (staged — resume here)
1. **Finish the rebrand:** rebuild the GUI bundle so the source patches land; verify Vita branding shows +
   the welcome window reads Vita (or is disabled); favicon/title; write `forks/puter/PATCHES.md`.
2. **Package OCI `RootDirectory=` capsule** (ADR-0010 — NOT ts-service Deno sandbox §9.3, NOT crun/microVM):
   rootfs = minimal base + Node 22 + the built rebranded Puter tree (node_modules INCLUDED → sealed image runs
   no npm/lifecycle scripts, §9.3 satisfied). Entrypoint `node dist/src/backend/index.js`.
3. **Real Vita storage:** `volatile/runtime/` → a Vita persistent `/var` volume via `StateDirectory`, owned by
   a **STABLE per-capsule uid/gid** (NOT DynamicUser ephemeral — ADR-0009 ownership caveat) so data persists
   across reboot. (All 3 stores: sqlite + fauxqs blobs + ddb.)
4. **Net/hardening:** loopback-only netns (S2); `RestrictAddressFamilies` allow AF_INET loopback (kiosk→4100);
   cgroup `MemoryMax ~1GB` (idle RSS ~387MB), CPUQuota, TasksMax; seccomp allow `pkey_alloc` (Node/V8).
5. **Kiosk:** `vita-kiosk` cage+chromium → `http://localhost:4100`; `*.puter.localhost`→127.0.0.1
   (`--host-resolver-rules`); retire our custom shell from the kiosk path.
6. **Owner auto-login (offline):** seed the owner session token into the kiosk browser
   `localStorage['auth_token']`+`['auth_token_v2']` (GUI reads these — `globals.js:63-64`) from Vita's owner
   token / a fixed owner → no login screen.
7. **Boot-verify:** build desktop image, boot VMware GPU (`vita.mode=desktop`, FRESH folder
   `C:\Users\Borg\vita-vmware\Vita-OS-puter\`); confirm Vita-branded desktop renders + owner auto-logged-in +
   a file created in Files persists across reboot. Screenshot `C:\Users\Borg\vita-vmware\vita-puter-desktop.png`.
8. **NEXT (separate stage):** route Puter fs/kv through Vita's capability-gated control plane (agentd) — the
   owner's "real backend, depth-2" (the OS security model governs the desktop's data).

## Risks
- §9.3 native-module vs sealed image — vendor prebuilt `node_modules`; verify linux-x64 `.node` ABI vs baked Node 22.
- GUI offline patch = per-Puter-version-bump maintenance (document in `forks/puter/PATCHES.md`; consider upstreaming an offline flag).
- DynamicUser↔persistent-volume ownership (ADR-0009 #4) — use a stable uid.
- AGPL: Puter is now FORKED (modified) → mods must be shared if distributed; personal use is fine. Keep it an
  isolated capsule + documented patch set; expose source per AGPL §13.

## Key paths
- Branch/worktree: `feat/vita-puter-desktop` @ `C:\Users\Borg\vita-puter-build` (base main 92122d8).
- Rebranded Puter (WSL Ubuntu): `/home/borg/puter-spike/puter`; patchlog `/home/borg/puter-spike/vita-rebrand.patchlog`.
- Offline patch ref: `scratchpad/patched-index.js`. Spike screenshot: `scratchpad/puter-offline.png`.
