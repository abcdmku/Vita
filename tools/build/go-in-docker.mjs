#!/usr/bin/env node
// Run `go <args>` inside the pinned golang Linux container against a module dir under the cwd.
// Usage: node tools/build/go-in-docker.mjs [--dir <subdir>] <go-args...>
//   e.g. node tools/build/go-in-docker.mjs --dir agent test ./...
//
// This is the canonical Go build/test path for OS-layer code: Linux-native (matches the target),
// reproducible, and independent of the host's Go PATH. The whole cwd (worktree root) is mounted at
// /work and go runs in /work/<subdir>, so acceptance commands work from the dispatch's worktree root.
// A named volume caches the module download cache across runs. spawnSync without a shell avoids
// quoting issues and passes the Windows cwd straight to docker (which handles the drive-letter mount).
import { spawnSync } from "node:child_process";

let args = process.argv.slice(2);
let dir = ".";
if (args[0] === "--dir") {
  dir = args[1] ?? ".";
  args = args.slice(2);
}
if (args.length === 0) {
  console.error("usage: node tools/build/go-in-docker.mjs [--dir <subdir>] <go args>  (e.g. --dir agent test ./...)");
  process.exit(2);
}
const image = process.env.VITA_GO_IMAGE || "golang:1.26";
const cwd = process.cwd();
const workdir = dir === "." ? "/work" : `/work/${dir.replace(/\\/g, "/")}`;

const run = spawnSync(
  "docker",
  [
    "run", "--rm",
    "-v", `${cwd}:/work`,
    "-v", "vita-go-mod-cache:/go/pkg/mod",
    "-w", workdir,
    "-e", "GOFLAGS=-buildvcs=false",
    image,
    "go", ...args,
  ],
  { stdio: "inherit" },
);
if (run.error) {
  console.error(`docker spawn error: ${run.error.message}`);
  process.exit(1);
}
process.exit(run.status ?? 1);
