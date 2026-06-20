# Work-item contract schema

Every unit of work is a contract — a single Markdown file in `queue/<id>.md` with YAML frontmatter
(machine fields) and a Markdown body (human prose). It implements spec §18.2. A contract may not be
dispatched until `status: ready`.

## File name & id
`<PHASE>-<NNN>.md`, e.g. `P0-001.md`, `P1-014.md`. The id is stable and referenced by branch
(`task/P0-001`), commit messages, and provenance.

## Frontmatter (machine-readable)

```yaml
id: P0-001                 # stable id, matches filename
title: Short imperative title
status: draft              # draft | ready | in_progress | in_review | done | failed
phase: 0                   # spec §21 phase number
pod: go-agent              # owning pod (see ai-factory/roles/)
risk_class: R1             # R0 | R1 | R2 | R3 | R4  (see protected-policy/risk-classes.md)
fr: [FR-005]               # related functional requirement ids (spec §15), or []
depends_on: [P0-000]       # contract ids that must be done first, or []
target_paths:              # the ONLY paths the worker may modify
  - agent/cmd
  - agent/capabilities
acceptance_command: "go test ./agent/..."   # exact command the worker must make pass
allowed_network: false     # true only when the task genuinely needs network
budget_minutes: 30         # soft compute/time budget
artifacts:                 # required deliverables (files/outputs)
  - agent/cmd/health.go
  - tests for the health endpoint
```

## Body (human-readable) — required sections

The body must fill every section of [TEMPLATE.md](TEMPLATE.md):

1. **Objective** — what to build, precisely.
2. **User value** — why it matters (ties to a spec requirement / definition of success §28).
3. **Non-goals** — what is explicitly out of scope.
4. **Dependencies** — what must exist first and why.
5. **Acceptance tests** — the exact, runnable checks (the `acceptance_command` plus any manual
   verification). Hidden/rotating evaluation cases are NOT placed here (spec §18.4).
6. **Performance & security constraints** — relevant NFRs (spec §16).
7. **Hardware profiles** — which profiles apply (x86-64, arm64, low-memory, offline, no-accel), or
   "n/a".
8. **Allowed tools & network** — restate `allowed_network` and any tool grants.
9. **Required artifacts** — the deliverable list.
10. **Rollback plan** — how to undo this safely if it regresses.
11. **Definition of done** — the checklist that, when fully ticked, means done.

## Lifecycle
`draft` → (orchestrator completes + ready-checklist passes) → `ready` → (dispatched) →
`in_progress` → (acceptance passes) → `in_review` → (integrated by risk class) → `done`.
A failed attempt → `failed`, with the worker report kept in `failed/<id>.report.md`.

See `schema.ts` for the same shape as a TypeScript type used by tooling.
