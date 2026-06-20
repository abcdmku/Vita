# Risk classes & merge authority (PROTECTED)

> Authoritative implementation of spec §18.3–§18.4. Ordinary agents (orchestrator and workers)
> **may not edit this file**. Changes require a human.

> ⚠️ **ACTIVE HUMAN OVERRIDE — auto-merge all risk classes.**
> Authorized by the owner on **2026-06-20**: "auto merge everything until I say not to."
> While this banner is present, the orchestrator may auto-merge **R0–R4** without a human-approval
> pause. The quality floor still applies — independent verification, rubric scoring, and the
> stop-conditions in [boundaries.md](boundaries.md) are NOT waived; a change that fails verification
> or trips a stop condition is reported, not merged. **To revert:** the owner says "stop
> auto-merging" (or removes this banner); merge authority then returns to the table below.

## Classes

| Class | Examples | Merge authority |
|---|---|---|
| **R0** | Documentation, formatting, generated SDK examples, generated stubs | Automated after tests pass (orchestrator) |
| **R1** | Isolated UI, non-privileged TS modules | Orchestrator review + owner-style approval |
| **R2** | Controller API, package manager, networking logic | **Human** component-owner approval |
| **R3** | Go system agent, storage, identity, boot, updater | **Two human** approvals incl. security/platform |
| **R4** | Release signing, recovery keys, trust policy, destructive migrations | **Human-only execution**; agents provide proposals + evidence |

## Default classification by area

| Area / path | Default class |
|---|---|
| `product/`, `architecture/adr/`, docs, `sdk/examples/` | R0 |
| `controller/web/`, `controller/design-system/`, isolated `sdk/` modules | R1 |
| `controller/api/`, `runtime/permission-broker/`, `packages/` catalog logic, networking | R2 |
| `agent/`, `storage/` (encryption/snapshots), `runtime/` sandboxing, `os/` boot/updates, identity | R3 |
| `release/signing/`, `release/provenance/`, recovery keys, trust policy, destructive migrations | R4 |

When unsure, classify **up** (higher risk), never down.

## Parallel candidate strategy (R2–R4) — spec §18.4
- At least **two** builders attempt independent solutions.
- Test/eval agents do **not** disclose hidden evaluation cases.
- A judge agent compares behavior, maintainability, security, and cost using
  [../evaluation/rubric.md](../evaluation/rubric.md).
- The winning approach may combine parts **only after interface review**.
- **Failure reports are retained**, not discarded, to prevent repeated dead ends
  (`../task-contracts/failed/`).
