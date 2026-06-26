// SAMPLE allowed package #2 — a CMD package (an echo/cowsay-style bin). It ships a `bin` and NO UI, so
// the packager generates a CMD APP: a Terminal-style surface scoped to the `echo` command. There is no
// JS module to load (a bin is an executable, not an importable module), so the in-memory loader returns
// undefined for it and the generator builds the cmd surface from the package.json alone.
//
// In v1 there is no out-of-process exec transport, so the generated cmd app runs built-in-only and SAYS
// SO (the surface echoes args locally and prints an honest "no exec backend wired" banner). The real
// execution lands with the capsule exec transport — that hook is the next layer.

import type {
  PackageJsonLike,
  PackagerCatalogEntry,
} from "../types.ts";

export const ECHO_PACKAGE_NAME = "@vita/echo";
export const ECHO_PACKAGE_VERSION = "1.0.0";

// The package.json the OS would read. A string `bin` makes the command name the (unscoped) package name
// per npm convention — here "echo".
export const echoPackageJson: PackageJsonLike = Object.freeze({
  bin: "./bin/echo.js",
  description: "Echo its arguments — a packaged command-line tool.",
  name: ECHO_PACKAGE_NAME,
  version: ECHO_PACKAGE_VERSION,
  vita: Object.freeze({
    icon: "📣",
    title: "Echo",
  }),
});

// The catalog allowlist entry. kind "auto" introspects the `bin` to a cmd app.
export const echoCatalogEntry: PackagerCatalogEntry = Object.freeze({
  capabilities: Object.freeze([]),
  // A valid sample SRI (sha256 over the package identity). Production pins the real tarball bytes.
  integrity: "sha256-O76yTTX7AE6CJ2GD7P4wAKBjNUKusn5b3EirY+rshJo=",
  kind: "auto",
  name: ECHO_PACKAGE_NAME,
  version: ECHO_PACKAGE_VERSION,
});
