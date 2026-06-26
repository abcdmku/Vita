import { safeNormalize } from "../safe-normalize.ts";
import type { PlainJsonObject } from "../safe-normalize.ts";
import type { ShellComposedLayout, ShellResolvedSurface } from "../shell/index.ts";
import type { Rect, WindowPlacement } from "../wm/policy.ts";
import {
  CompositorDriver,
  compositorWindowPlacement,
  defaultNativeCompositorSurfaceColor,
  encodeNativeCompositorCommand,
} from "./index.ts";
import type {
  CompositorPort,
  CompositorRect,
  CompositorSurfaceKind,
  CompositorSurfaceSize,
  CompositorWindowPlacement,
} from "./index.ts";

export interface SmokeBufferSurfaceRequest {
  readonly textureId: string;
  readonly windowId: string;
  readonly width: number;
  readonly height: number;
}

export interface SmokeBufferSurface {
  readonly width: number;
  readonly height: number;
  readonly rgbaHex: string;
}

export interface SmokeBufferSurfaceSource {
  readonly readBufferSurface: (
    request: SmokeBufferSurfaceRequest,
  ) => SmokeBufferSurface | undefined;
}

export interface SmokeCompositorCommandStreamOptions {
  readonly bufferSurfaceSource?: SmokeBufferSurfaceSource;
}

interface ResolvedSmokeBufferSurface {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly rgbaHex: string;
}

type BufferSurfaceReader = (request: SmokeBufferSurfaceRequest) => unknown;

const BUFFER_SURFACE_FIELDS = Object.freeze(["height", "rgbaHex", "width"]);
const SMOKE_WINDOWS = Object.freeze([
  Object.freeze({
    id: "files",
    rect: rect(86, 96, 420, 280),
    zIndex: 1,
  }),
  Object.freeze({
    id: "terminal",
    rect: rect(690, 235, 470, 260),
    zIndex: 2,
  }),
  Object.freeze({
    id: "notes",
    rect: rect(252, 410, 360, 230),
    zIndex: 3,
  }),
]);
const U32_MAX = 0xffff_ffff;

export class SmokeCompositorLayoutError extends Error {
  readonly code = "INVALID_SMOKE_COMPOSITOR_LAYOUT";
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = "SmokeCompositorLayoutError";
    this.path = path;
  }
}

export async function buildSmokeCompositorCommandStream(
  options: SmokeCompositorCommandStreamOptions,
): Promise<string> {
  const windows = smokeWindowPlacements();
  const buffers = resolveSmokeBufferSurfaces(options.bufferSurfaceSource, windows);
  const lines: string[] = [];
  const driver = new CompositorDriver(new SmokeBufferCompositorPort(lines, buffers));
  const result = await driver.reconcile({
    shell: smokeShellLayout(),
    windows,
  });

  if (!result.ok) {
    throw new SmokeCompositorLayoutError(
      result.error.path,
      `${result.error.code}: ${result.error.message}`,
    );
  }

  return lines.join("");
}

export function createDeterministicSmokeBufferSurfaceSource(): SmokeBufferSurfaceSource {
  return Object.freeze({
    readBufferSurface(request: SmokeBufferSurfaceRequest): SmokeBufferSurface {
      return Object.freeze({
        height: request.height,
        rgbaHex: patternedRgbaHex(request),
        width: request.width,
      });
    },
  });
}

export function smokeShellLayout(): ShellComposedLayout {
  const panel = shellSurface({
    id: "surface:panel",
    layer: "panel",
    order: 0,
    rect: rect(0, 0, 1280, 42),
    role: "panel",
  });
  const desktop = shellSurface({
    children: Object.freeze([panel]),
    id: "surface:desktop",
    layer: "desktop",
    order: 0,
    rect: rect(0, 0, 1280, 720),
    role: "desktop",
  });

  return Object.freeze({
    configId: "vita.smoke.driver-layout",
    css: Object.freeze({
      rules: Object.freeze([]),
      text: "",
    }),
    revision: "PSD-520",
    root: desktop,
    surfaces: Object.freeze([
      desktop,
      panel,
    ]),
  });
}

export function smokeWindowPlacements(): readonly CompositorWindowPlacement[] {
  return Object.freeze(SMOKE_WINDOWS.map((window) =>
    smokeWindow(window.id, window.rect, window.zIndex)
  ));
}

class SmokeBufferCompositorPort implements CompositorPort {
  readonly #lines: string[];
  readonly #buffers: ReadonlyMap<string, ResolvedSmokeBufferSurface>;

  constructor(
    lines: string[],
    buffers: ReadonlyMap<string, ResolvedSmokeBufferSurface>,
  ) {
    this.#lines = lines;
    this.#buffers = buffers;
  }

  registerSurface(
    id: string,
    kind: CompositorSurfaceKind,
    size: CompositorSurfaceSize,
  ): void {
    if (kind === "window") {
      const buffer = this.#buffers.get(id);

      if (buffer === undefined) {
        throw new SmokeCompositorLayoutError(
          `/bufferSurfaces/${pathToken(id)}`,
          `Missing injected buffer surface for '${id}'.`,
        );
      }
      if (buffer.width !== size.width || buffer.height !== size.height) {
        throw new SmokeCompositorLayoutError(
          `/bufferSurfaces/${pathToken(id)}`,
          `Injected buffer surface '${id}' dimensions do not match compositor placement.`,
        );
      }

      this.#lines.push(
        `registerBufferSurface ${id} ${buffer.width} ${buffer.height} ${buffer.rgbaHex}\n`,
      );
      return;
    }

    this.#lines.push(encodeNativeCompositorCommand({
      height: size.height,
      id,
      rgba: defaultNativeCompositorSurfaceColor({ id, kind, size }),
      type: "registerSurface",
      width: size.width,
    }));
  }

  updatePlacement(
    id: string,
    rectValue: CompositorRect,
    z: number,
    visible: boolean,
  ): void {
    this.#lines.push(encodeNativeCompositorCommand({
      height: rectValue.height,
      id,
      type: "updatePlacement",
      visible,
      width: rectValue.width,
      x: rectValue.x,
      y: rectValue.y,
      z,
    }));
  }

  removeSurface(id: string): void {
    this.#lines.push(encodeNativeCompositorCommand({
      id,
      type: "removeSurface",
    }));
  }

  present(): void {
    this.#lines.push(encodeNativeCompositorCommand({
      type: "present",
    }));
  }
}

function resolveSmokeBufferSurfaces(
  source: SmokeBufferSurfaceSource | undefined,
  windows: readonly CompositorWindowPlacement[],
): ReadonlyMap<string, ResolvedSmokeBufferSurface> {
  const readBufferSurface = normalizeBufferSurfaceSource(source);
  const output = new Map<string, ResolvedSmokeBufferSurface>();

  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];

    if (window === undefined) {
      continue;
    }

    const request = Object.freeze({
      height: window.rect.height,
      textureId: window.textureId,
      width: window.rect.width,
      windowId: window.windowId,
    });
    const path = `/bufferSurfaces/${pathToken(window.textureId)}`;
    const value = readBufferSurface(request);

    if (value === undefined) {
      throw new SmokeCompositorLayoutError(
        path,
        `Missing injected buffer surface for '${window.textureId}'.`,
      );
    }

    output.set(window.textureId, normalizeBufferSurface(value, request, path));
  }

  return output;
}

function normalizeBufferSurfaceSource(
  source: SmokeBufferSurfaceSource | undefined,
): BufferSurfaceReader {
  if (source === undefined || source === null || typeof source !== "object") {
    throw new SmokeCompositorLayoutError(
      "/bufferSurfaceSource",
      "Smoke compositor layout requires an injected buffer-surface source.",
    );
  }

  const descriptor = Object.getOwnPropertyDescriptor(source, "readBufferSurface");
  const candidate: unknown = descriptor?.value;

  if (
    descriptor === undefined ||
    !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
    !isBufferSurfaceReader(candidate)
  ) {
    throw new SmokeCompositorLayoutError(
      "/bufferSurfaceSource/readBufferSurface",
      "Smoke buffer-surface source must expose a data-property readBufferSurface function.",
    );
  }

  return (request): unknown => candidate.call(source, request);
}

function isBufferSurfaceReader(
  value: unknown,
): value is (this: SmokeBufferSurfaceSource, request: SmokeBufferSurfaceRequest) => unknown {
  return typeof value === "function";
}

function normalizeBufferSurface(
  value: unknown,
  request: SmokeBufferSurfaceRequest,
  path: string,
): ResolvedSmokeBufferSurface {
  const normalized = safeNormalize(value, {
    maxDepth: 2,
    maxNodes: 8,
  });

  if (!normalized.ok) {
    throw new SmokeCompositorLayoutError(path, normalized.reason);
  }
  if (!isPlainJsonObject(normalized.value)) {
    throw new SmokeCompositorLayoutError(path, "Expected a plain data object.");
  }

  rejectUnknownFields(normalized.value, BUFFER_SURFACE_FIELDS, path);
  const width = readRequiredU32(normalized.value, "width", `${path}/width`);
  const height = readRequiredU32(normalized.value, "height", `${path}/height`);
  const rgbaHex = readRequiredRgbaHex(normalized.value, "rgbaHex", `${path}/rgbaHex`);

  if (width !== request.width || height !== request.height) {
    throw new SmokeCompositorLayoutError(
      path,
      `Injected buffer surface '${request.textureId}' dimensions do not match compositor placement.`,
    );
  }

  const expectedLength = expectedRgbaHexLength(width, height, `${path}/rgbaHex`);
  if (rgbaHex.length !== expectedLength) {
    throw new SmokeCompositorLayoutError(
      `${path}/rgbaHex`,
      `Injected buffer surface '${request.textureId}' RGBA length does not match dimensions.`,
    );
  }

  return Object.freeze({
    height,
    id: request.textureId,
    rgbaHex: rgbaHex.toLowerCase(),
    width,
  });
}

function shellSurface(input: {
  readonly id: string;
  readonly role: string;
  readonly layer: string;
  readonly order: number;
  readonly rect: Rect;
  readonly children?: readonly ShellResolvedSurface[];
}): ShellResolvedSurface {
  return Object.freeze({
    children: input.children ?? Object.freeze([]),
    componentId: `component:${input.role}`,
    id: input.id,
    path: input.id,
    payload: Object.freeze({}),
    placement: Object.freeze({
      layer: input.layer,
      order: input.order,
      rect: input.rect,
      zone: "center",
    }),
    role: input.role,
    substrate: Object.freeze({}),
  });
}

function smokeWindow(
  id: string,
  windowRect: Rect,
  zIndex: number,
): CompositorWindowPlacement {
  const placement: WindowPlacement = Object.freeze({
    focused: id === "terminal",
    rect: windowRect,
    textureId: `texture-${id}`,
    visible: true,
    windowId: id,
    workspaceId: "main",
    zIndex,
  });

  return compositorWindowPlacement(placement);
}

function patternedRgbaHex(request: SmokeBufferSurfaceRequest): string {
  const seed = fnv1a32(`${request.textureId}:${request.windowId}`);
  const rows: string[] = [];

  for (let y = 0; y < request.height; y += 1) {
    let row = "";

    for (let x = 0; x < request.width; x += 1) {
      row += patternedPixel(seed, x, y, request.width, request.height);
    }

    rows.push(row);
  }

  return rows.join("");
}

function patternedPixel(
  seed: number,
  x: number,
  y: number,
  width: number,
  height: number,
): string {
  if (y < 28) {
    return rgbaHexFromChannels(
      40 + ((seed >>> 16) % 48),
      52 + ((x + (seed >>> 8)) % 44),
      68 + ((seed + y) % 56),
      255,
    );
  }

  if ((x + y + seed) % 37 === 0) {
    return rgbaHexFromChannels(96, 132, 180, 255);
  }

  const xSpan = Math.max(width - 1, 1);
  const ySpan = Math.max(height - 1, 1);
  const red = 24 + Math.trunc((x * 86) / xSpan) + (seed % 19);
  const green = 30 + Math.trunc((y * 72) / ySpan) + ((seed >>> 5) % 23);
  const blue = 46 + Math.trunc(((x + y) * 58) / (xSpan + ySpan)) + ((seed >>> 11) % 29);

  return rgbaHexFromChannels(
    clampByte(red),
    clampByte(green),
    clampByte(blue),
    255,
  );
}

function readRequiredU32(
  value: PlainJsonObject,
  key: string,
  path: string,
): number {
  const child = value[key];

  if (
    typeof child !== "number" ||
    !Number.isSafeInteger(child) ||
    child <= 0 ||
    child > U32_MAX
  ) {
    throw new SmokeCompositorLayoutError(path, "Expected a positive u32 integer.");
  }

  return child;
}

function readRequiredRgbaHex(
  value: PlainJsonObject,
  key: string,
  path: string,
): string {
  const child = value[key];

  if (typeof child !== "string" || child.length === 0 || !/^[0-9a-fA-F]+$/u.test(child)) {
    throw new SmokeCompositorLayoutError(
      path,
      "Expected a non-empty hex RGBA buffer.",
    );
  }

  return child;
}

function rejectUnknownFields(
  value: PlainJsonObject,
  allowedFields: readonly string[],
  path: string,
): void {
  const keys = Object.keys(value).sort(compareStrings);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && !hasField(allowedFields, key)) {
      throw new SmokeCompositorLayoutError(`${path}/${pathToken(key)}`, "Unknown field.");
    }
  }

  for (let index = 0; index < allowedFields.length; index += 1) {
    const field = allowedFields[index];

    if (field !== undefined && !Object.hasOwn(value, field)) {
      throw new SmokeCompositorLayoutError(`${path}/${field}`, "Required field is missing.");
    }
  }
}

function expectedRgbaHexLength(width: number, height: number, path: string): number {
  const pixels = width * height;
  const hexLength = pixels * 8;

  if (!Number.isSafeInteger(hexLength)) {
    throw new SmokeCompositorLayoutError(path, "RGBA buffer length overflowed.");
  }

  return hexLength;
}

function rect(x: number, y: number, width: number, height: number): Rect {
  return Object.freeze({
    height,
    width,
    x,
    y,
  });
}

function rgbaHexFromChannels(red: number, green: number, blue: number, alpha: number): string {
  return (
    red.toString(16).padStart(2, "0") +
    green.toString(16).padStart(2, "0") +
    blue.toString(16).padStart(2, "0") +
    alpha.toString(16).padStart(2, "0")
  );
}

function clampByte(value: number): number {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value;
}

function pathToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function hasField(fields: readonly string[], key: string): boolean {
  for (let index = 0; index < fields.length; index += 1) {
    if (fields[index] === key) {
      return true;
    }
  }

  return false;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;

  return 0;
}

function isPlainJsonObject(value: unknown): value is PlainJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash;
}
