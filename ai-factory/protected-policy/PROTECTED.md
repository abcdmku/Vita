# Protected paths (PROTECTED)

> Paths in this list may **not** be modified by the orchestrator or workers. Changes require a
> human, on a human-driven branch. This enforces spec §0.1 (Phase 0 exit gate: "Protected policies
> and tests cannot be changed by ordinary agents") and §18.6.
>
> Tooling (`tools/dispatch`, `tools/loop`) refuses to dispatch a contract whose `target_paths`
> intersect any protected glob, and refuses to integrate a branch that modified one.

## Protected globs
```
ai-factory/protected-policy/**      # this directory: risk classes, boundaries, this list
ai-factory/evaluation/hidden/**     # hidden / rotating evaluation suites (spec §18.4)
release/signing/**                  # signing keys & ceremony material
release/provenance/**               # provenance records (append-only; humans only)
**/*.key
**/*.pem
.env
.env.*
```

## Notes
- Acceptance tests *named in a contract* are public and runnable, but a worker may not weaken or
  delete an existing test to make work pass (spec §18.6). New tests are encouraged.
- `release/sbom/**` and `release/support/**` are not protected (R0/R1), but anything under
  `release/signing/**` and `release/provenance/**` is R4 and protected.
- To change a protected file: a human edits it directly, or approves a proposal an agent filed as
  evidence-only (no merge by the agent).
