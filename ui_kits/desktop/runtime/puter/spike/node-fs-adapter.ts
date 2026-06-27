// node:fs adapter — maps node's fs to the store's injected `NodeFsStoreDeps.fs` shape, so store.ts
// carries NO static node import (keeps the browser bundle clean). Harness/on-device only.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";

import type { NodeFsStoreDeps } from "../store.ts";

export const nodeFsAdapter: NodeFsStoreDeps["fs"] = Object.freeze({
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync(p: string): Uint8Array {
    return new Uint8Array(readFileSync(p));
  },
  readFileSyncText(p: string): string {
    return readFileSync(p, "utf8");
  },
  rmSync,
  statSync(p: string): { isDirectory(): boolean; size: number; mtimeMs: number; birthtimeMs: number } {
    const st = statSync(p);

    return { birthtimeMs: st.birthtimeMs, isDirectory: () => st.isDirectory(), mtimeMs: st.mtimeMs, size: st.size };
  },
  writeFileSync(p: string, data: Uint8Array | string): void {
    writeFileSync(p, data);
  },
});
