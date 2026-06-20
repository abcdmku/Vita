# The Vita AI Factory

This directory is the **process** that builds the product. The product spec describes a
human/AI engineering organization (spec §17–§24); this is its concrete implementation in the repo.

## Cast

- **Human (you).** Owns intent, authority, trust boundaries, budgets, release keys, and all R2+
  approvals (spec §17.1).
- **Orchestrator — Claude Code.** Plans, decomposes, authors task contracts, dispatches workers,
  verifies, integrates by risk class, runs the process-improvement loop. Contract: [../CLAUDE.md](../CLAUDE.md).
- **Grunt workers — GPT-5.5 (xhigh) via Codex.** Implement one task contract each. Contract:
  [../AGENTS.md](../AGENTS.md).

## The loop (spec §18.1)

```
Human-approved objective
  → Orchestrator authors task contract  (task-contracts/queue/<id>.md, status: ready)
  → Worker implements in branch task/<id>   (npm run dispatch -- <id>)
  → Automated build / tests / acceptance command
  → Orchestrator verifies + reviews against the rubric (evaluation/rubric.md)
  → Integrate by risk class (R0/R1 by orchestrator; R2+ by human)
  → Lessons + status recorded (STATE.md, memory/)
```

## Directories

| Path | What |
|---|---|
| `task-contracts/queue/` | Contracts ready or waiting to be built |
| `task-contracts/done/` | Completed + integrated contracts |
| `task-contracts/failed/` | Failed attempts + retained failure reports (spec §18.4) |
| `task-contracts/SCHEMA.md`, `schema.ts`, `TEMPLATE.md` | The work-item contract definition |
| `roles/` | Pod / specialist role definitions (spec §17.2) |
| `protected-policy/` | Risk classes, boundaries, protected paths — **agents may not edit** |
| `evaluation/` | Scoring rubric for judging candidate solutions |
| `prompts/` | Reusable dispatch prompt fragments |
| `memory/` | Durable factory lessons (separate from Claude's personal memory) |
| `STATE.md` | The live cursor: current phase, what's in flight, what's next |

## Operating it

```bash
npm run ready              # list ready/unblocked contracts
npm run dispatch -- P0-001 # send one contract to a GPT-5.5 worker
npm run tick               # one orchestration tick (used by the self-paced loop)
npm run auth:check         # confirm a worker can actually run
```
