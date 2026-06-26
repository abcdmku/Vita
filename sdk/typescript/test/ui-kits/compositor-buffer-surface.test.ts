import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SmokeCompositorLayoutError,
  buildSmokeCompositorCommandStream,
  smokeWindowPlacements,
} from "../../src/compositor-bridge/smoke-layout.ts";
import type {
  SmokeBufferSurface,
  SmokeBufferSurfaceRequest,
  SmokeBufferSurfaceSource,
} from "../../src/compositor-bridge/smoke-layout.ts";

// These are the flat-palette placeholder colors the bridge used to emit for app
// windows (defaultNativeCompositorSurfaceColor / WINDOW_COLOR_PALETTE). The real
// buffer-surface smoke path must NOT emit any of them for a window.
const FLAT_WINDOW_PALETTE = Object.freeze([
  "e6edf2ff",
  "f5d36cff",
  "79b8ffff",
  "c586c0ff",
  "92b66fff",
  "f08c6cff",
]);
const WINDOW_TEXTURES = Object.freeze([
  Object.freeze({ height: 280, id: "texture-files", width: 420 }),
  Object.freeze({ height: 260, id: "texture-terminal", width: 470 }),
  Object.freeze({ height: 230, id: "texture-notes", width: 360 }),
]);
const SHELL_SURFACES = Object.freeze(["surface:desktop", "surface:panel"]);

interface BufferRegistration {
  readonly width: number;
  readonly height: number;
  readonly rgbaHex: string;
}

test("real smoke path carries the injected framebuffer through CompositorWindowPlacement.content", () => {
  const placements = smokeWindowPlacements(solidSource(new Map([
    ["texture-files", "0a141eff"],
    ["texture-terminal", "28323cff"],
    ["texture-notes", "46505aff"],
  ])));

  // The buffer-surface source is plumbed into placement construction, not a
  // side-channel: every window placement carries real pixel content.
  for (let index = 0; index < WINDOW_TEXTURES.length; index += 1) {
    const expected = WINDOW_TEXTURES[index];

    if (expected === undefined) {
      continue;
    }

    const placement = placements.find((candidate) => candidate.textureId === expected.id);
    assert.notEqual(placement, undefined, `missing placement for ${expected.id}`);
    assert.notEqual(placement?.content, undefined, `placement ${expected.id} has no content`);
    assert.equal(placement?.content?.width, expected.width);
    assert.equal(placement?.content?.height, expected.height);
  }
});

test("real smoke path emits buffer surfaces with the injected pixels, never a flat palette window fill", async () => {
  const injected = new Map([
    ["texture-files", "0a141eff"],
    ["texture-terminal", "28323cff"],
    ["texture-notes", "46505aff"],
  ]);
  const stream = await buildSmokeCompositorCommandStream({
    bufferSurfaceSource: solidSource(injected),
  });
  const registrations = parseBufferSurfaceRegistrations(stream);

  for (let index = 0; index < WINDOW_TEXTURES.length; index += 1) {
    const window = WINDOW_TEXTURES[index];
    const rgba = window === undefined ? undefined : injected.get(window.id);

    if (window === undefined || rgba === undefined) {
      assert.fail("missing window fixture");
    }

    // Placeholder is GONE for real windows: no flat `registerSurface <texture>`.
    assert.equal(
      stream.includes(`registerSurface ${window.id}`),
      false,
      `${window.id} still emits a flat registerSurface fill`,
    );

    // The emitted buffer payload is the injected real pixels, byte-for-byte.
    const registration = registrations.get(window.id);
    if (registration === undefined) {
      assert.fail(`missing buffer registration for ${window.id}`);
    }
    assert.equal(registration.width, window.width);
    assert.equal(registration.height, window.height);
    assert.equal(registration.rgbaHex, solidRgbaBuffer(window.width, window.height, rgba));
  }

  // No window pixel equals any flat palette placeholder color.
  for (let index = 0; index < FLAT_WINDOW_PALETTE.length; index += 1) {
    const palette = FLAT_WINDOW_PALETTE[index];

    if (palette !== undefined) {
      assert.equal(stream.includes(palette), false, `stream still uses placeholder ${palette}`);
    }
  }

  // Shell chrome keeps its existing flat-color registerSurface fills.
  for (let index = 0; index < SHELL_SURFACES.length; index += 1) {
    const shellId = SHELL_SURFACES[index];

    if (shellId !== undefined) {
      assert.equal(
        stream.includes(`registerSurface ${shellId} `),
        true,
        `shell surface ${shellId} lost its flat registerSurface`,
      );
      assert.equal(
        stream.includes(`registerBufferSurface ${shellId}`),
        false,
        `shell surface ${shellId} should not be a buffer surface`,
      );
    }
  }

  assert.equal(stream.endsWith("present\n"), true);
});

test("changing the injected framebuffer changes the emitted payload byte-for-byte", async () => {
  const baseline = await buildSmokeCompositorCommandStream({
    bufferSurfaceSource: solidSource(new Map([
      ["texture-files", "0a141eff"],
      ["texture-terminal", "28323cff"],
      ["texture-notes", "46505aff"],
    ])),
  });
  const mutated = await buildSmokeCompositorCommandStream({
    bufferSurfaceSource: solidSource(new Map([
      ["texture-files", "ff0000ff"],
      ["texture-terminal", "00ff00ff"],
      ["texture-notes", "0000ffff"],
    ])),
  });

  assert.notEqual(baseline, mutated, "emitted stream did not change with injected bytes");

  const baselineFiles = parseBufferSurfaceRegistrations(baseline).get("texture-files");
  const mutatedFiles = parseBufferSurfaceRegistrations(mutated).get("texture-files");
  assert.notEqual(baselineFiles, undefined);
  assert.notEqual(mutatedFiles, undefined);
  // Same geometry, different pixel bytes — proves the data flows from the source.
  assert.equal(baselineFiles?.width, mutatedFiles?.width);
  assert.equal(baselineFiles?.height, mutatedFiles?.height);
  assert.notEqual(baselineFiles?.rgbaHex, mutatedFiles?.rgbaHex);
  assert.equal(mutatedFiles?.rgbaHex, solidRgbaBuffer(420, 280, "ff0000ff"));
});

test("real smoke path fails closed when no buffer-surface source is supplied", async () => {
  await assert.rejects(
    () => buildSmokeCompositorCommandStream({}),
    (error: unknown): boolean =>
      error instanceof SmokeCompositorLayoutError &&
      error.path === "/bufferSurfaceSource",
  );
});

test("real smoke path fails closed when a window has no buffer-surface content", async () => {
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

    if (parts[0] !== "registerBufferSurface") {
      continue;
    }

    const id = parts[1];
    const widthText = parts[2];
    const heightText = parts[3];
    const rgbaHex = parts[4];

    if (id === undefined || widthText === undefined || heightText === undefined || rgbaHex === undefined) {
      assert.fail("buffer registration is missing fields");
    }
    assert.equal(parts[5], undefined, "buffer registration contains unexpected fields");

    const width = Number(widthText);
    const height = Number(heightText);
    assert.equal(Number.isSafeInteger(width), true, "buffer registration width is invalid");
    assert.equal(Number.isSafeInteger(height), true, "buffer registration height is invalid");
    registrations.set(id, Object.freeze({ height, rgbaHex, width }));
  }

  return registrations;
}

function solidRgbaBuffer(width: number, height: number, rgba: string): string {
  return rgba.repeat(width * height);
}
