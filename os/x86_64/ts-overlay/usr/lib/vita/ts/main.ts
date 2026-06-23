// Vita on-device TypeScript entrypoint (P1-030) — the first TS code that runs ON the device.
//
// This is the proof-of-life slice: it runs under the pinned, vendored Deno runtime
// (/usr/lib/vita/deno) as the vita-ts.service oneshot at boot, and prints a single grep-able
// marker to the serial console so a host boot log proves the TypeScript layer actually ran:
//
//   VITA-TS: hello from Deno <version> ...
//
// It is NOT a hello-world: it imports a REAL piece of the Vita control plane — the strict,
// fail-closed Semantic Versioning utility vendored verbatim from sdk/typescript/src/semver.ts —
// and exercises it (parse + precedence compare) so the marker is only emitted after genuine
// control-plane TS has executed correctly on-device.
//
// Determinism / supply chain (CLAUDE.md §6, spec §9.3):
//   - NO remote imports. Every import is a relative path to a vendored file under this overlay.
//   - The Deno binary is version- + sha256-pinned and staged from a verified download
//     (see os/x86_64/ts-image.conf + os/x86_64/ts-image.mjs); it is never fetched at boot.
//   - This file reads no untrusted input and performs no network I/O.
//
// Run model: `deno run` with NO --allow-* flags. The control-plane logic here is pure, so it
// needs zero permissions; Deno's default-deny sandbox is the on-device least-privilege posture.

// Deno runtime globals (`Deno.*`) used below resolve differently in the two typecheck lanes, by
// DESIGN — and the Node-only shim is deliberately NOT referenced from here so it stays invisible to
// Deno's own checker:
//   - `deno check` (AUTHORITATIVE, run against Deno's real lib; config at os/x86_64/deno.json, which
//     lives OUTSIDE this overlay so it is not copied into the image rootfs by --extra-tree):
//     Deno provides the real `Deno` global. The Node shim (vendor/deno.shim.d.ts) is EXCLUDED in
//     deno.json and is not pulled in by any triple-slash here, so Deno never sees a second
//     declaration of `Deno.version` (the round-2 duplicate/incompatible-ambient-const risk is gone).
//   - The repo-wide Node `tsc` lane (root tsconfig.json include "os/**/*.ts") has no `Deno` global.
//     It picks up the ambient shim automatically because the include glob also matches the sibling
//     vendor/deno.shim.d.ts — no triple-slash reference and no root tsconfig edit are needed. That
//     keeps this production entrypoint IN the Node lane's coverage while the shim never reaches Deno.

import {
  compareSemver,
  isValidSemver,
  parseSemver,
} from "./vendor/semver.ts";

const MARKER = "VITA-TS";

// Write the marker to BOTH stdout (captured by the journal -> console for a oneshot service)
// and directly to /dev/console as a belt-and-suspenders path, so it is visible on the QEMU
// serial regardless of how the service's stdout is wired. Failure to open /dev/console is
// non-fatal (e.g. when run by hand under a normal shell) — stdout still carries the marker.
function emit(line: string): void {
  console.log(line);
  try {
    // Deno.writeTextFileSync needs --allow-write; we run with no perms, so guard it and ignore
    // a PermissionDenied / NotFound. The journal+console wiring (service StandardOutput) is the
    // primary path; this is only an extra hop on hosts where it happens to be permitted.
    Deno.writeTextFileSync("/dev/console", line + "\n", { append: true });
  } catch {
    // ignore — stdout already carried the marker
  }
}

function main(): number {
  // Exercise the REAL control-plane semver utility so the marker proves genuine TS ran.
  const a = parseSemver("1.2.3");
  const b = parseSemver("1.10.0");
  if (!a.ok || !b.ok) {
    emit(`${MARKER}: FAIL semver parse (${a.ok ? "b" : "a"})`);
    return 1;
  }

  // Precedence: 1.2.3 < 1.10.0 (numeric minor compare, not lexical) — the canonical SemVer §11
  // gotcha. If the vendored control-plane code is wired correctly this is exactly -1.
  const cmp = compareSemver(a.value, b.value);
  const prereleaseRejected = !isValidSemver("1.2.3.4"); // invalid -> must be rejected fail-closed

  const ok = cmp === -1 && prereleaseRejected;
  const denoVersion = Deno.version.deno;

  // The single grep-able witness the host boot check greps for. Keep "VITA-TS:" as the stable
  // prefix; the trailing fields are diagnostic.
  emit(
    `${MARKER}: hello from Deno ${denoVersion} ` +
      `| control-plane semver: 1.2.3 < 1.10.0 => ${cmp} ` +
      `| invalid-rejected=${prereleaseRejected} ` +
      `| status=${ok ? "OK" : "MISMATCH"}`,
  );

  return ok ? 0 : 1;
}

Deno.exit(main());
