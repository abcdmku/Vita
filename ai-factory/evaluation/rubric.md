# Evaluation rubric

> Used by the orchestrator (and judge agents for R2–R4 parallel candidates) to score a worker's
> result before integration. Implements spec §23 (agents optimized for *accepted outcomes*, not
> output volume). **Lines of code is not a metric.**

Score each dimension 0–3 (0 = fails, 1 = weak, 2 = solid, 3 = excellent). A change is integrable
only if it has **no 0**, meets the gate notes, and clears the per-risk threshold.

| # | Dimension | What "3" looks like |
|---|---|---|
| 1 | **Correctness** | Acceptance command passes cleanly; behavior matches the contract; edge cases handled. |
| 2 | **Scope fidelity** | Does exactly the contract; honors non-goals; diff stays in `target_paths`. |
| 3 | **Tests** | Behavior is proven by tests; deterministic; no weakened/disabled existing tests. |
| 4 | **Security** | No new privileged surface; least privilege; no secrets; sandbox/permission rules upheld (spec §7.1, §9.3). |
| 5 | **Comprehensibility** | A human reviewer understands the diff quickly; clear naming; right comment density (spec §23 comprehension score). |
| 6 | **Maintainability / reuse** | Shared types not duplicated; fits existing structure; no needless complexity. |
| 7 | **Determinism / reproducibility** | Same inputs → same output; pinned deps; no hidden I/O in plan code (spec §8.2). |
| 8 | **Provenance** | Linked to task id + worker session; commit references the contract. |

## Gate notes
- Any **R3/R4** touch with a `< 3` on Security or Comprehensibility is **not** integrable — send back.
- A change that **weakens or games a test** scores 0 on Tests and is rejected outright (stop-condition signal, spec §24).
- Ties between parallel candidates break toward **lower privileged surface**, then **higher comprehensibility**, then **lower cost**.

## Thresholds
| Risk | Minimum total (of 24) | Hard requirements |
|---|---|---|
| R0 | 16 | no 0 |
| R1 | 18 | Correctness ≥ 2, Tests ≥ 2 |
| R2 | 20 | Security ≥ 2, Tests ≥ 2 |
| R3 | 22 | Security = 3, Comprehensibility ≥ 2, Tests ≥ 2 |
| R4 | n/a | human-only; rubric informs the proposal, does not authorize merge |
