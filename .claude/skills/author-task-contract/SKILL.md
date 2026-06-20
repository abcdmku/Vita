---
name: author-task-contract
description: Decompose a slice of the active Vita phase into one or more ready task contracts that satisfy the schema and ready-checklist. Use when the build queue is low on ready work, or when asked to "plan", "break down", or "create tasks" for the OS build.
---

# Author task contract(s)

Turn the next slice of the active phase into dispatch-ready work. A good contract is a **thin
vertical slice** that produces something testable, with an **exact acceptance command** a GPT-5.5
worker can make pass. Schema: [../../../ai-factory/task-contracts/SCHEMA.md](../../../ai-factory/task-contracts/SCHEMA.md);
template: [../../../ai-factory/task-contracts/TEMPLATE.md](../../../ai-factory/task-contracts/TEMPLATE.md).

## 1. Pick the slice
- Read `ai-factory/STATE.md` for the active phase, then the matching phase in spec §21 (and §25 for
  the first 30 days). Choose the next unblocked deliverable.
- Prefer slices that are **portable and testable on this machine now** (TypeScript/Node-native).
  Defer Linux-only work (UKI/RAUC/dm-verity/QEMU/Go-needs-Linux) unless a Linux host/Docker path is
  set up; if you must queue it, set `status: draft` and note the blocker.

## 2. Decompose
- One contract = one slice. If it can't be acceptance-tested in one command, split it.
- Declare `depends_on` edges before anything else. Common edges: deck/app logic depends on data;
  realtime depends on rules; frontend depends on a stable API/socket contract; everything depends on
  the SDK plan model.

## 3. Fill the template
Copy `TEMPLATE.md` to `ai-factory/task-contracts/queue/<PHASE>-<NNN>.md` (e.g. `P1-007.md`).
Fill **every** field concretely:
- `risk_class` per `ai-factory/protected-policy/risk-classes.md` — when unsure, classify **up**.
- `target_paths` = the only paths the worker may touch (spec §19 layout). Never include a protected
  path (`ai-factory/protected-policy/**`, `release/signing/**`, keys).
- `acceptance_command` = exact + runnable. Preferred patterns on this machine:
  - TS unit: `node --experimental-strip-types --test <explicit .test.ts file>` (in-process; no install).
  - Multi-file TS: list the explicit test files (Node 22 directory discovery does not propagate the
    strip-types flag to child processes — pass files explicitly).
  - Docs/ADRs: a small `node` checker that asserts required sections/links exist.
- `allowed_network: false` unless the task genuinely needs it (most don't).
- Write tight Objective / Non-goals / Definition-of-done. Non-goals prevent scope creep.

## 4. Ready-checklist (CLAUDE.md §4)
Set `status: ready` only when objective, user value, non-goals, satisfied dependencies, target
paths, risk class, exact acceptance command, perf/security constraints, hardware profiles, allowed
network, budget, artifacts, rollback, and definition-of-done are all concretely present. Otherwise
leave `status: draft`.

## 5. Verify it parses
Run `npm run ready` and confirm the new contract appears in the ready list (or is correctly shown as
blocked/draft). Then it can be dispatched via `factory-tick`.
