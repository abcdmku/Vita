# ADR 0006: Package Isolation Baseline

## Status

Accepted.

## Context

Spec section 5 makes AppArmor, seccomp, namespaces, and cgroup v2 mandatory for all non-core workloads. Section 7.1 marks community npm packages, user scripts, imported containers, third-party apps, AI-generated code, development environments, and parsers as untrusted by default, and it forbids untrusted workloads from direct access to the system-agent socket. Section 9.3 requires lockfiles, forbids remote imports in production artifacts, denies lifecycle scripts by default, and denies native Node-API addons, FFI, and unrestricted subprocess permissions in TypeScript sandboxes.

Alternatives considered were relying only on Deno permissions, trusting npm package metadata, running apps as ordinary host services, and using containers as the sole isolation boundary. Deno permissions are necessary but not sufficient as a host boundary. Package metadata is not an enforcement layer. Ordinary host services and container-only isolation do not cover the complete workload model.

## Decision

Use a layered package isolation baseline: Deno permission sandboxes for TypeScript, Wasmtime/WASI for WASM components, rootless OCI for container workloads, optional microVMs for high-risk code, and host controls from AppArmor, seccomp, namespaces, and cgroup v2 for all non-core workloads. TypeScript sandboxes must not run lifecycle scripts, native addons, FFI, or unrestricted subprocesses.

## Consequences

The platform can run first-party services, verified apps, community packages, and imported workloads without granting them ambient host authority. The trade-off is stricter package contracts, more compatibility testing, and explicit permission design for data, network, resources, backup hooks, and migrations. Some npm packages will require adaptation or rejection instead of running unchanged.
