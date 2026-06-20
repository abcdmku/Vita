# ADR 0005: RAUC A/B Transactional Updates

## Status

Accepted.

## Context

Spec section 5 sets the update framework to RAUC A/B bundles for signed, transactional, offline-capable updates. Section 10.1 defines two immutable dm-verity root slots, Root A and Root B, plus recovery and encrypted mutable data. FR-023 and the release gates require signed updates, rollback evidence, and recovery from failed OS updates. Section 29 notes RAUC signed update bundles and robust boot integration as a source input for the baseline.

Alternatives considered were in-place package updates, OSTree-style image management, custom update logic, and container-only delivery. In-place updates weaken rollback and reproducibility for an immutable appliance. OSTree-style systems are viable but not the selected baseline. Custom update logic would add risk in a safety-critical path. Container-only delivery does not update the base OS, boot artifacts, or recovery environment.

## Decision

Use RAUC A/B signed bundles for native OS updates. Apply updates to the inactive immutable root slot, integrate with boot assessment, and roll back automatically when health checks fail. Keep mutable user and app data outside the root slots in the encrypted data plane.

## Consequences

The update path becomes auditable, transactional, and usable offline, matching the product requirement for automatic rollback. The trade-off is extra image layout discipline, signing operations, boot-state integration, and test coverage for failed updates, interrupted installs, and recovery exports.
