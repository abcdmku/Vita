// Vita dev-loop — TS→browser-JS type stripping (node-only helper).
//
// The New App page imports the SAME scaffold generator the node/tests use (scaffold.ts) so there is ONE
// source of truth for the generated app shape. The browser cannot run TS, so the harness serves
// scaffold.ts with its TYPES STRIPPED (no transform, no downlevel — just type erasure, byte positions
// preserved). Uses node's built-in `module.stripTypeScriptTypes` (node ≥ 22.13). No external deps.

import { stripTypeScriptTypes } from "node:module";

// Strip TypeScript type syntax from `source`, returning runnable JS. `mode: "strip"` only erases types
// (it does not transform enums/namespaces/param-properties — scaffold.ts uses none of those). Imports of
// TYPE-only symbols (`import type`) are removed; value imports/exports are preserved.
export function stripTypesToJs(source: string): string {
  return stripTypeScriptTypes(source, { mode: "strip" });
}
