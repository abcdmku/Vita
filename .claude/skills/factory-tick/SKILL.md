---
name: factory-tick
description: Run one Vita AI-factory orchestration tick — read state, triage, plan-if-dry, dispatch a GPT-5.5 worker, verify independently, integrate by risk class, record. Use this for each iteration of the autonomous OS-build loop (and whenever asked to "advance the build" or "do a tick").
---

# Factory tick

One tick advances Vita by one verified increment. You are the orchestrator (see
[CLAUDE.md](../../../CLAUDE.md)); workers are GPT-5.5 (xhigh) via Codex. Do the steps in order.
Keep the tick small — one slice landed and proven beats five half-built.

## 1. Read state
- `npm run ready` (or `node tools/loop/tick.mjs`) — shows worker auth, ready/blocked/failed counts.
- Read `ai-factory/STATE.md` (the cursor) and the active phase in the spec §21.

## 2. Triage
- Any `failed/*.report.md` to learn from? Fold the lesson into the next contract or STATE.md.
- Any `task/<id>` branches awaiting your review/integration? Finish those first.
- Fewer than ~3 ready contracts? Go to step 3. Else step 4.

## 3. Plan if dry
Invoke `author-task-contract` to decompose the next vertical slice of the active phase into ready
contracts. Declare dependency edges (`depends_on`) before dispatching. Mark `ready` only when the
ready-checklist (CLAUDE.md §4) passes.

## 4. Dispatch
- Pick the highest-priority unblocked `ready` contract (lowest id wins ties).
- `npm run dispatch -- <id>` → runs GPT-5.5 on branch `task/<id>`, runs the acceptance command,
  commits the worker diff, writes `ai-factory/task-contracts/<id>.result.json`, returns to `main`.
- **R2–R4**: dispatch is the same, but per spec §18.4 run **two** independent attempts
  (re-dispatch creates a fresh branch tip) and judge with `ai-factory/evaluation/rubric.md`.
- If worker auth is MISSING: set `OPENAI_API_KEY` / `codex login`, or (R0/R1 only) implement the
  contract yourself, then continue at step 5.

## 5. Verify independently (never trust the worker's word — spec §18.6)
- Read `<id>.result.json` and the worker report `<id>.worker.md`.
- Re-run the acceptance command yourself: `git checkout task/<id>` → run it → `git checkout main`.
- Read the diff (`git diff main..task/<id>`). Confirm: does exactly the contract, stays in
  `target_paths`, touches no protected path, weakens no test, no secrets.
- Score against `ai-factory/evaluation/rubric.md`. Below threshold → send back (new contract that
  references `failed/<id>.report.md`).

## 6. Integrate by risk class
- **R0 / R1**: bring **only product files** to main — `git checkout task/<id> -- <the contract's
  target_paths>` — so factory artifacts stay out of product history; then `git mv queue/<id>.md
  done/` and flip its `status` to `done`; commit (message references the contract id + worker). The
  `task/<id>` branch persists as the audit trail. (`*.worker.md` / `*.result.json` are gitignored
  factory artifacts, never product code.)
- **R2 / R3 / R4**: do **not** merge. Surface a summary + evidence to the human and stop on that
  contract; record "awaiting human approval" in STATE.md. Move to `done/` only after the human's
  approval is recorded.
- On FAIL: move `queue/<id>.md` → `failed/`, keep `<id>.worker.md` as `failed/<id>.report.md`,
  keep the branch for inspection.

## 7. Record + reschedule
- Update `ai-factory/STATE.md`: what advanced, what failed + why, phase-exit-gate progress, next up.
- Write a durable lesson to memory if something non-obvious was learned.
- If any stop condition fired (spec §24 / `protected-policy/boundaries.md`), HALT the loop and ask
  the human. Otherwise schedule the next tick (CLAUDE.md §7): short wait if watching a dispatch,
  long if idle-planning.
