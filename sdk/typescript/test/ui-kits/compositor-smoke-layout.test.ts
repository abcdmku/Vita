import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  SmokeCompositorLayoutError,
  buildSmokeCompositorCommandStream,
} from "../../src/compositor-bridge/smoke-layout.ts";
import type {
  SmokeBufferSurface,
  SmokeBufferSurfaceRequest,
  SmokeBufferSurfaceSource,
} from "../../src/compositor-bridge/smoke-layout.ts";

const generatorUrl = new URL("../../../../os/x86_64/compositor-smoke-layout.mjs", import.meta.url);
const oldWindowRgba = Object.freeze([
  "e6edf2ff",
  "1f232cff",
  "fcebb3ff",
]);
const injectedWindowRgba = Object.freeze(new Map<string, string>([
  ["texture-files", "0a141eff"],
  ["texture-terminal", "28323cff"],
  ["texture-notes", "46505aff"],
]));

test("smoke compositor generator no longer carries the solid-fill placeholder colors", async () => {
  const source = await readFile(generatorUrl, "utf8");

  assert.doesNotMatch(source, /\bcolors\s*:/u);
  assert.doesNotMatch(source, /\bNativeCompositorPort\b/u);
  for (let index = 0; index < oldWindowRgba.length; index += 1) {
    const rgba = oldWindowRgba[index];

    if (rgba !== undefined) {
      assert.equal(source.includes(rgba), false, `generator still embeds ${rgba}`);
    }
  }
});

test("smoke compositor window textures come from the injected buffer-surface source", async () => {
  const stream = await buildSmokeCompositorCommandStream({
    bufferSurfaceSource: solidSource(injectedWindowRgba),
  });
  const registrations = parseBufferSurfaceRegistrations(stream);

  assert.equal(stream.includes("registerSurface texture-files"), false);
  assert.equal(stream.includes("registerSurface texture-terminal"), false);
  assert.equal(stream.includes("registerSurface texture-notes"), false);
  for (let index = 0; index < oldWindowRgba.length; index += 1) {
    const rgba = oldWindowRgba[index];

    if (rgba !== undefined) {
      assert.equal(stream.includes(rgba), false, `stream still uses placeholder ${rgba}`);
    }
  }

  assertInjectedRegistration(registrations, "texture-files", 420, 280, "0a141eff");
  assertInjectedRegistration(registrations, "texture-terminal", 470, 260, "28323cff");
  assertInjectedRegistration(registrations, "texture-notes", 360, 230, "46505aff");
  assert.equal(stream.endsWith("present\n"), true);
});

test("smoke compositor fails closed when buffer-surface content is absent", async () => {
  await assert.rejects(
    () => buildSmokeCompositorCommandStream({}),
    (error: unknown): boolean =>
      error instanceof SmokeCompositorLayoutError &&
      error.path === "/bufferSurfaceSource",
  );

  await assert.rejects(
    () => buildSmokeCompositorCommandStream({
      bufferSurfaceSource: Object.freeze({
        readBufferSurface(): undefined {
          return undefined;
        },
      }),
    }),
    (error: unknown): boolean =>
      error instanceof SmokeCompositorLayoutError &&
      error.path === "/bufferSurfaces/texture-files" &&
      error.message.includes("Missing injected buffer surface"),
  );
});

interface BufferRegistration {
  readonly width: number;
  readonly height: number;
  readonly rgbaHex: string;
}

function solidSource(pixels: ReadonlyMap<string, string>): SmokeBufferSurfaceSource {
  return Object.freeze({
    readBufferSurface(request: SmokeBufferSurfaceRequest): SmokeBufferSurface | undefined {
      const rgba = pixels.get(request.textureId);

      if (rgba === undefined) {
        return undefined;
      }

      return Object.freeze({
        height: request.height,
        rgbaHex: solidRgbaBuffer(request.width, request.height, rgba),
        width: request.width,
      });
    },
  });
}

function parseBufferSurfaceRegistrations(stream: string): ReadonlyMap<string, BufferRegistration> {
  const registrations = new Map<string, BufferRegistration>();
  const lines = stream.trimEnd().split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (line === undefined) {
      continue;
    }

    const parts = line.split(" ");
    const command = parts[0];

    if (command !== "registerBufferSurface") {
      continue;
    }

    const id = parts[1];
    const widthText = parts[2];
    const heightText = parts[3];
    const rgbaHex = parts[4];
    const extra = parts[5];

    if (id === undefined) {
      assert.fail("buffer registration missing id");
    }
    if (widthText === undefined) {
      assert.fail("buffer registration missing width");
    }
    if (heightText === undefined) {
      assert.fail("buffer registration missing height");
    }
    if (rgbaHex === undefined) {
      assert.fail("buffer registration missing RGBA payload");
    }
    assert.equal(extra, undefined, "buffer registration contains unexpected fields");

    const width = Number(widthText);
    const height = Number(heightText);
    assert.equal(Number.isSafeInteger(width), true, "buffer registration width is invalid");
    assert.equal(Number.isSafeInteger(height), true, "buffer registration height is invalid");
    registrations.set(id, Object.freeze({
      height,
      rgbaHex,
      width,
    }));
  }

  return registrations;
}

function assertInjectedRegistration(
  registrations: ReadonlyMap<string, BufferRegistration>,
  id: string,
  width: number,
  height: number,
  rgba: string,
): void {
  const registration = registrations.get(id);

  if (registration === undefined) {
    assert.fail(`missing buffer registration for ${id}`);
  }
  assert.equal(registration.width, width);
  assert.equal(registration.height, height);
  assert.equal(registration.rgbaHex, solidRgbaBuffer(width, height, rgba));
}

function solidRgbaBuffer(width: number, height: number, rgba: string): string {
  return rgba.repeat(width * height);
}
