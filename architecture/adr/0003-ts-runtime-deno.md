# ADR 0003: Deno 2.8 TypeScript Runtime

## Status

Accepted.

## Context

The product surface is TypeScript: system configuration, automations, policies, apps, and controller code are expressed as typed TypeScript. Spec section 5 sets Deno 2.8 as the primary first-party TypeScript runtime and permission-broker client. Section 8 requires deterministic, no-I/O planning for configuration files; plans are type-checked, schema-validated, converted to canonical signed plans, evaluated against policy, and applied transactionally through the Go agent.

Alternatives considered were Node.js, Bun, browser-only execution, and a custom TypeScript runtime. Node.js 24 LTS remains the compatibility target for packages and OCI apps, but Node-style unrestricted host access is not the trusted runtime model. Bun is optional for development and tests, not a privileged runtime. A custom runtime would add avoidable security and compatibility work.

## Decision

Use Deno 2.8 as the first-party TypeScript runtime and permission-broker client for the controller, desired-state evaluator, events, automations, package catalog, and PDS module management. Planning execution must remain deterministic and no-I/O, and host mutation must flow through validated plans to the Go agent.

## Consequences

Deno aligns with default-deny permissions, TypeScript-first execution, Node/npm compatibility where allowed, and permission-broker integration noted in spec section 29. The trade-off is that package compatibility must be mediated by lockfiles, mirrors, permission declarations, and sandbox policy rather than assuming arbitrary npm behavior works unchanged.
