// Minimal ambient declaration of the Deno global surface used by the on-device entrypoint (P1-030).
//
// WHY THIS EXISTS — it keeps the diff os-only while restoring typecheck coverage of main.ts:
//   - On-device, main.ts runs under the REAL pinned Deno runtime (/usr/lib/vita/deno). `deno check`
//     (see os/x86_64/ts-overlay/deno.json) is the AUTHORITATIVE typecheck, validated against Deno's
//     real lib — that is the check that matters and it is wired as this overlay's acceptance command.
//   - The repo-wide Node `tsc` lane (root tsconfig.json: include "os/**/*.ts") ALSO compiles this
//     file. Node has no `Deno` global, so without this declaration the Node lane fails on the three
//     `Deno.*` references in main.ts. Round 1 fixed that by EXCLUDING the overlay from the Node lane
//     via a root tsconfig edit — but that (a) edited a root file (scope) and (b) dropped the
//     entrypoint from the Node lane entirely (coverage). This file fixes both with an os-local change:
//     it supplies just enough of the `Deno` namespace for Node tsc to keep the entrypoint IN its lane,
//     while `deno check` remains the real, lib-accurate gate.
//
// SAFETY OF DECLARATION MERGING — the signatures below are a strict SUBSET of Deno's own, with
// IDENTICAL shapes for the members main.ts touches. TypeScript merges this ambient `namespace Deno`
// with Deno's built-in one; because the overlapping members are structurally identical, `deno check`
// accepts the merge (verified on Deno 2.8.3). It is deliberately MINIMAL: it declares only the three
// members main.ts uses, so it cannot mask a typo on some other Deno API — any such use would surface
// as a Node-lane error here AND be caught authoritatively by `deno check`.
//
// Keep in sync: if main.ts starts using another Deno API, add its (subset, exact) signature here so
// the Node lane keeps compiling; `deno check` is what guarantees the signature is correct.

declare namespace Deno {
  /** Process/runtime version triplet. Only `deno` is read here. */
  const version: {
    readonly deno: string;
  };

  /** Synchronously write text to a file, optionally appending. Subset of Deno's WriteFileOptions. */
  function writeTextFileSync(
    path: string | URL,
    data: string,
    options?: { append?: boolean },
  ): void;

  /** Terminate the process with the given exit code. */
  function exit(code?: number): never;
}
