# ADR 0001: Debian 13 "trixie" Base Userland

## Status

Accepted.

## Context

The product is a TypeScript-first operating environment on a hardened Linux substrate, not a new kernel or general-purpose Linux distribution. Spec section 5 sets the base userland baseline as Debian 13.5 "trixie", rebuilt as immutable product images with security patches and an exact release bill of materials. Section 7 places this immutable Debian-based root filesystem below the Go system agent and TypeScript control plane.

Alternatives considered were a custom Linux distribution, a rolling base such as Arch, Ubuntu LTS, and NixOS as the user-visible OS model. A custom distribution would expand the platform burden beyond v1. Rolling bases reduce reproducibility. Ubuntu remains relevant for vendor host editions, especially AI systems, but is not the native image baseline. Nix is retained for pinned internal build toolchains, not as the user configuration surface.

## Decision

Use Debian 13.5 "trixie" as the native image base userland for v1. Rebuild it into signed, immutable product images and keep systemd from Debian 13 as the init/service manager baseline. Users and packages do not administer the base distribution directly.

## Consequences

This gives the project a stable, widely understood Linux userland while preserving the product promise that Linux remains an implementation detail. The trade-off is that product releases must own image rebuilds, security patch intake, SBOMs, lockfiles, and compatibility testing instead of delegating updates to an end-user distribution workflow. Hardware or vendor stacks that do not fit the native baseline use the host-edition model until qualified.
