# Factory State (live cursor)

> The orchestrator updates this every tick. It is the single source of "where are we".

## Current phase
**Phase 0 — Charter and AI factory** (spec §21, weeks 0–3, release v0.0).

## Status: READY — loop armed
Factory scaffold, governance, and dispatch machinery are in place. Worker execution is **live**:
`codex login` (ChatGPT subscription) is authenticated; `~/.codex/config.toml` already pins
`gpt-5.5` at `xhigh`. First dispatchable contract: **P0-001** (SDK plan model). No product code
merged yet.

## Phase 0 exit gates (spec §21)
- [ ] One task can pass through spec → test → dual implementation → review → evaluation → merge.
- [ ] Agent sessions are auditable (provenance on every artifact).
- [ ] Protected policies and tests cannot be changed by ordinary agents.
- [ ] Build inputs are pinned.

## In flight
- Ready contracts seeded: P0-001 (SDK plan model), P0-002 (authoring API, blocked on P0-001),
  P0-003 (capability/accelerator types).

## Blocked
- (none)

## Next up
- Dispatch P0-001 (first end-to-end loop proof → Phase 0 exit gate).
- Author Week-1 ADRs (Debian, Go, Deno, Btrfs, RAUC, package isolation) and pod role docs.
- Continue decomposing Phase 0 / Phase 1 into ready contracts as the queue drains.

## Lessons (most recent first)
- (none yet)
