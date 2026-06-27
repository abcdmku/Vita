// Vita Package Manager — the node:fs-backed SourceFsPort (real on-disk package source trees, node-only).
//
// This is the production adapter the package registry uses to browse/read/EDIT a package's raw source
// under `<appsRoot>/<pkgId>/source`. It statically imports node:fs/node:path — node-only, never imported
// from the browser bundle. The key safety property is `resolveWithin`: every package-relative path is
// resolved against the package's source dir AND CONFINED to it, so neither a malicious package nor a
// crafted meta-API request can read/write outside the package's own source subtree.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import type { SourceFsPort } from "./package-registry.ts";

export const nodeSourceFs: SourceFsPort = Object.freeze({
  exists(absPath: string): boolean {
    return existsSync(absPath);
  },
  isDir(absPath: string): boolean {
    return existsSync(absPath) && statSync(absPath).isDirectory();
  },
  readdir(absPath: string): readonly string[] {
    return readdirSync(absPath);
  },
  readText(absPath: string): string {
    return readFileSync(absPath, "utf8");
  },
  resolveWithin(base: string, relPath: string): string {
    const root = resolve(base);
    // Strip a leading slash so join treats it as relative to root (not absolute).
    const rel = relPath.replace(/^[/\\]+/u, "");
    const candidate = resolve(join(root, rel));

    // CONFINEMENT: the resolved path must be the root itself or strictly under it. Anything else
    // (a `..` climb, an absolute escape) is rejected — a package cannot escape its source subtree.
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      throw new Error(`path escapes the package source root: ${relPath}`);
    }

    return candidate;
  },
  size(absPath: string): number {
    return statSync(absPath).size;
  },
  writeText(absPath: string, content: string): void {
    const dir = dirname(absPath);

    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(absPath, content, "utf8");
  },
});
