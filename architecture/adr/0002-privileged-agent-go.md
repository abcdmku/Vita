# ADR 0002: Go Privileged System Agent

## Status

Accepted.

## Context

Spec section 3.4 says the privileged core must be small: TypeScript produces declarative desired-state plans, and a narrow privileged Go agent validates and applies approved host operations. Section 5 sets the privileged-agent baseline to Go 1.26.4, with static builds where practical and patch updates through the release train. Section 7.1 places the Go system agent in the trusted computing base and says untrusted workloads may not access the system-agent socket directly.

Alternatives considered were a TypeScript/Node or Deno privileged daemon, Rust, shell-driven orchestration, and direct systemd or package-manager access from the controller. TypeScript is the product surface but is not the enforcement boundary for privileged host mutation. Rust would be viable but is not the specified baseline. Shell orchestration and arbitrary command execution would widen the trusted surface and conflict with the capability model.

## Decision

Implement the privileged system agent in Go 1.26, pinned to the spec baseline release train, with narrow typed capabilities for storage, networking, updates, workloads, identity, and hardware discovery. The agent rejects arbitrary commands and applies only validated, policy-approved transactions from the control plane.

## Consequences

The security boundary is clearer: TypeScript can express intent, while Go owns constrained host mutation. This reduces the amount of privileged code reviewers must audit. The trade-off is an explicit Go/TypeScript API boundary, generated clients, and additional testing for transaction semantics, rollback, and policy enforcement.
