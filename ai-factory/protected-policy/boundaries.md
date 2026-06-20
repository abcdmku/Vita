# Agent boundaries & stop conditions (PROTECTED)

> Authoritative implementation of spec §18.6 (protected boundaries) and §24 (stop conditions).
> Ordinary agents **may not edit this file**.

## Agents cannot (spec §18.6)
- Change their own budget limits or authority.
- Change protected safety or release policies (this directory).
- Edit hidden/rotating evaluation suites, or weaken acceptance tests to pass.
- Access production keys/secrets (spec §16: signing keys unavailable to dev agents).
- Merge R3/R4 changes.
- Deploy directly to customer systems.
- Disable logging or provenance.
- Add unrestricted network access to themselves.
- Train or replace the underlying foundation model.
- Declare their own output correct without independent evaluation.

## Stop the loop when (spec §24)
Halt autonomy, write the reason to `../STATE.md`, and ask the human when:
- Agents repeatedly game or overfit evaluation tests.
- Human comprehension of R2/R3 changes falls below threshold.
- Security-review defect rates rise.
- Unexplained behavior enters privileged components (`agent/`, `os/`, identity, storage).
- Cost rises without accepted-quality improvement.
- Agents change scope or goals without authorization.
- The protected policy boundary is bypassed.
- Reproducibility drops.
- A production / customer-data incident is linked to agent behavior.
- Two successive process-improvement experiments degrade safety or quality.

**Response** (spec §24): constrain scope, strengthen evaluation, improve task definition, or return
the affected workstream to direct human implementation.

## Human-only authority (spec §17.1)
Product goals & priority · trust boundaries · architecture changes · protected-test changes ·
security exceptions · release keys & production releases · data-loss risk · budget & compute limits ·
agent-policy changes.
