---
id: PX-000
title: <short imperative title>
status: draft
phase: 0
pod: <pod-name>
risk_class: R1
fr: []
depends_on: []
target_paths:
  - <path/the/worker/may/touch>
acceptance_command: "<exact command that must pass>"
allowed_network: false
budget_minutes: 30
artifacts:
  - <deliverable>
---

## Objective
<Precisely what to build.>

## User value
<Why it matters; tie to a spec requirement (§15) or definition of success (§28).>

## Non-goals
<What is explicitly out of scope.>

## Dependencies
<What must exist first and why. List contract ids in `depends_on` too.>

## Acceptance tests
<The exact runnable checks. Restate `acceptance_command`. Add manual steps if any.
Do NOT put hidden/rotating evaluation cases here.>

## Performance & security constraints
<Relevant NFRs from spec §16, or "none beyond defaults".>

## Hardware profiles
<x86_64 / arm64 / low-memory / offline / no-accelerator / migration, or n/a.>

## Allowed tools & network
<Restate allowed_network. Any tool grants.>

## Required artifacts
<The deliverable list (matches frontmatter `artifacts`).>

## Rollback plan
<How to safely undo if this regresses.>

## Definition of done
- [ ] Acceptance command passes on a clean run.
- [ ] Tests prove the behavior.
- [ ] Diff stays within `target_paths`.
- [ ] No protected path touched; no secrets committed.
- [ ] Worker report filed.
