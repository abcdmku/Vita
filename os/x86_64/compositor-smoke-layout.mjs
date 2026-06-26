#!/usr/bin/env node
// Generate the smoke VM compositor command stream from the TypeScript shell/WM model
// and an injected deterministic buffer-surface source.
// This is build-time verification wiring only; the production OS stays headless.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSmokeCompositorCommandStream,
  createDeterministicSmokeBufferSurfaceSource,
  smokeShellLayout,
  smokeWindowPlacements,
} from "../../sdk/typescript/src/compositor-bridge/smoke-layout.ts";

export {
  buildSmokeCompositorCommandStream,
  createDeterministicSmokeBufferSurfaceSource,
  smokeShellLayout,
  smokeWindowPlacements,
};

export async function writeSmokeCompositorCommandStream(outputPath = process.argv[2]) {
  const commandStream = await buildSmokeCompositorCommandStream({
    bufferSurfaceSource: createDeterministicSmokeBufferSurfaceSource(),
  });

  if (outputPath === undefined) {
    process.stdout.write(commandStream);
  } else {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, commandStream, { encoding: "utf8", mode: 0o644 });
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await writeSmokeCompositorCommandStream();
}
