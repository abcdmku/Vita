import { err, hasJsonKey, isJsonObject, ok, safeSnapshotJson, type JsonObject, type JsonValue, type Result } from "./safe-json.ts";

export const fpsBudget = 60;
export const schemaVersion = 1;

export type EngineName = "cef" | "wpe";
export type EngineState = "measured" | "unavailable" | "not-run" | "error";
export type EngineStatus = "pass" | "fail" | "unavailable" | "not-run";
export type TextureMode = "shared-texture" | "cpu-readback" | "unavailable";
export type VerdictEngine = EngineName | "none" | "pending";

export interface TargetInfo {
  readonly os: string;
  readonly gpu: string;
  readonly vmware3d: boolean;
  readonly driver: string;
}

export interface TextureDimensions {
  readonly width: number;
  readonly height: number;
}

export interface TextureEvidence {
  readonly mode: TextureMode;
  readonly handleKind: string;
  readonly dimensions: TextureDimensions;
  readonly reusedAcrossMotionFrames: boolean;
  readonly acceleratedPaintEvents: number;
}

export interface MotionEvidence {
  readonly compositedFrames: number;
  readonly durationMs: number;
  readonly webPaintEventsBefore: number;
  readonly webPaintEventsAfter: number;
  readonly contentTextureIdChanges: number;
  readonly cpuReadbackFramesDuringMotion: number;
}

export interface ScreenshotEvidence {
  readonly path: string;
  readonly sha256?: string;
}

export interface EngineRun {
  readonly engine: EngineName;
  readonly state: EngineState;
  readonly timestamp: string;
  readonly target: TargetInfo;
  readonly texture: TextureEvidence;
  readonly motion: MotionEvidence;
  readonly frameTimesMs: readonly number[];
  readonly screenshot: ScreenshotEvidence;
  readonly notes: readonly string[];
}

export interface SpikeReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly budgetFps: number;
  readonly runs: readonly EngineRun[];
  readonly notes: readonly string[];
}

export interface HistogramBucket {
  readonly label: string;
  readonly minInclusiveMs: number;
  readonly maxExclusiveMs: number | null;
  readonly count: number;
}

export interface FrameTimeSummary {
  readonly minMs: number;
  readonly p50Ms: number;
  readonly p90Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly histogram: readonly HistogramBucket[];
}

export interface RunEvaluation {
  readonly engine: EngineName;
  readonly status: EngineStatus;
  readonly fps: number;
  readonly noRepaintDuringMotion: boolean;
  readonly sharedTextureReused: boolean;
  readonly frameTime: FrameTimeSummary;
  readonly reasons: readonly string[];
}

export interface ReportEvaluation {
  readonly verdict: VerdictEngine;
  readonly recommendedEngine: VerdictEngine;
  readonly runs: readonly RunEvaluation[];
  readonly reasons: readonly string[];
}

const allowedTopKeys = ["schemaVersion", "generatedAt", "budgetFps", "runs", "notes"] as const;
const allowedRunKeys = ["engine", "state", "timestamp", "target", "texture", "motion", "frameTimesMs", "screenshot", "notes"] as const;
const allowedTargetKeys = ["os", "gpu", "vmware3d", "driver"] as const;
const allowedTextureKeys = ["mode", "handleKind", "dimensions", "reusedAcrossMotionFrames", "acceleratedPaintEvents"] as const;
const allowedDimensionsKeys = ["width", "height"] as const;
const allowedMotionKeys = [
  "compositedFrames",
  "durationMs",
  "webPaintEventsBefore",
  "webPaintEventsAfter",
  "contentTextureIdChanges",
  "cpuReadbackFramesDuringMotion"
] as const;
const allowedScreenshotKeys = ["path", "sha256"] as const;

function hasOnlyKeys(value: JsonObject, allowed: readonly string[], path: string): Result<void> {
  const keys = Reflect.ownKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) {
      return err(`${path}: key enumeration changed`);
    }
    if (typeof key !== "string") {
      return err(`${path}: symbol keys are rejected`);
    }
    if (!allowed.includes(key)) {
      return err(`${path}: unexpected key ${key}`);
    }
  }
  return ok(undefined);
}

function required(value: JsonObject, key: string, path: string): Result<JsonValue> {
  if (!hasJsonKey(value, key)) {
    return err(`${path}: missing ${key}`);
  }
  const field = value[key];
  if (field === undefined) {
    return err(`${path}: missing ${key}`);
  }
  return ok(field);
}

function optional(value: JsonObject, key: string): JsonValue | undefined {
  if (!hasJsonKey(value, key)) {
    return undefined;
  }
  return value[key];
}

function readString(value: JsonValue, path: string): Result<string> {
  return typeof value === "string" && value.length > 0 ? ok(value) : err(`${path}: expected non-empty string`);
}

function readBoolean(value: JsonValue, path: string): Result<boolean> {
  return typeof value === "boolean" ? ok(value) : err(`${path}: expected boolean`);
}

function readNonNegativeInteger(value: JsonValue, path: string): Result<number> {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? ok(value) : err(`${path}: expected non-negative integer`);
}

function readPositiveNumber(value: JsonValue, path: string): Result<number> {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? ok(value) : err(`${path}: expected positive number`);
}

function readEngine(value: JsonValue, path: string): Result<EngineName> {
  return value === "cef" || value === "wpe" ? ok(value) : err(`${path}: expected cef or wpe`);
}

function readEngineState(value: JsonValue, path: string): Result<EngineState> {
  if (value === "measured" || value === "unavailable" || value === "not-run" || value === "error") {
    return ok(value);
  }
  return err(`${path}: invalid engine state`);
}

function readTextureMode(value: JsonValue, path: string): Result<TextureMode> {
  if (value === "shared-texture" || value === "cpu-readback" || value === "unavailable") {
    return ok(value);
  }
  return err(`${path}: invalid texture mode`);
}

function readObject(value: JsonValue, path: string): Result<JsonObject> {
  return isJsonObject(value) ? ok(value) : err(`${path}: expected object`);
}

function readNumberArray(value: JsonValue, path: string): Result<readonly number[]> {
  if (!Array.isArray(value)) {
    return err(`${path}: expected array`);
  }
  const numbers: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "number" || !Number.isFinite(item) || item <= 0) {
      return err(`${path}[${index}]: expected positive finite number`);
    }
    numbers.push(item);
  }
  return ok(numbers);
}

function readStringArray(value: JsonValue, path: string): Result<readonly string[]> {
  if (!Array.isArray(value)) {
    return err(`${path}: expected array`);
  }
  const strings: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string") {
      return err(`${path}[${index}]: expected string`);
    }
    strings.push(item);
  }
  return ok(strings);
}

function decodeDimensions(value: JsonValue, path: string): Result<TextureDimensions> {
  const object = readObject(value, path);
  if (!object.ok) {
    return object;
  }
  const keys = hasOnlyKeys(object.value, allowedDimensionsKeys, path);
  if (!keys.ok) {
    return keys;
  }
  const width = required(object.value, "width", path);
  if (!width.ok) {
    return width;
  }
  const height = required(object.value, "height", path);
  if (!height.ok) {
    return height;
  }
  const decodedWidth = readNonNegativeInteger(width.value, `${path}.width`);
  if (!decodedWidth.ok) {
    return decodedWidth;
  }
  const decodedHeight = readNonNegativeInteger(height.value, `${path}.height`);
  if (!decodedHeight.ok) {
    return decodedHeight;
  }
  return ok({ width: decodedWidth.value, height: decodedHeight.value });
}

function decodeTarget(value: JsonValue, path: string): Result<TargetInfo> {
  const object = readObject(value, path);
  if (!object.ok) {
    return object;
  }
  const keys = hasOnlyKeys(object.value, allowedTargetKeys, path);
  if (!keys.ok) {
    return keys;
  }
  const os = required(object.value, "os", path);
  const gpu = required(object.value, "gpu", path);
  const vmware3d = required(object.value, "vmware3d", path);
  const driver = required(object.value, "driver", path);
  if (!os.ok) {
    return os;
  }
  if (!gpu.ok) {
    return gpu;
  }
  if (!vmware3d.ok) {
    return vmware3d;
  }
  if (!driver.ok) {
    return driver;
  }
  const decodedOs = readString(os.value, `${path}.os`);
  const decodedGpu = readString(gpu.value, `${path}.gpu`);
  const decodedVmware3d = readBoolean(vmware3d.value, `${path}.vmware3d`);
  const decodedDriver = readString(driver.value, `${path}.driver`);
  if (!decodedOs.ok) {
    return decodedOs;
  }
  if (!decodedGpu.ok) {
    return decodedGpu;
  }
  if (!decodedVmware3d.ok) {
    return decodedVmware3d;
  }
  if (!decodedDriver.ok) {
    return decodedDriver;
  }
  return ok({ os: decodedOs.value, gpu: decodedGpu.value, vmware3d: decodedVmware3d.value, driver: decodedDriver.value });
}

function decodeTexture(value: JsonValue, path: string): Result<TextureEvidence> {
  const object = readObject(value, path);
  if (!object.ok) {
    return object;
  }
  const keys = hasOnlyKeys(object.value, allowedTextureKeys, path);
  if (!keys.ok) {
    return keys;
  }
  const mode = required(object.value, "mode", path);
  const handleKind = required(object.value, "handleKind", path);
  const dimensions = required(object.value, "dimensions", path);
  const reused = required(object.value, "reusedAcrossMotionFrames", path);
  const acceleratedPaintEvents = required(object.value, "acceleratedPaintEvents", path);
  if (!mode.ok) {
    return mode;
  }
  if (!handleKind.ok) {
    return handleKind;
  }
  if (!dimensions.ok) {
    return dimensions;
  }
  if (!reused.ok) {
    return reused;
  }
  if (!acceleratedPaintEvents.ok) {
    return acceleratedPaintEvents;
  }
  const decodedMode = readTextureMode(mode.value, `${path}.mode`);
  const decodedHandleKind = readString(handleKind.value, `${path}.handleKind`);
  const decodedDimensions = decodeDimensions(dimensions.value, `${path}.dimensions`);
  const decodedReused = readBoolean(reused.value, `${path}.reusedAcrossMotionFrames`);
  const decodedPaintEvents = readNonNegativeInteger(acceleratedPaintEvents.value, `${path}.acceleratedPaintEvents`);
  if (!decodedMode.ok) {
    return decodedMode;
  }
  if (!decodedHandleKind.ok) {
    return decodedHandleKind;
  }
  if (!decodedDimensions.ok) {
    return decodedDimensions;
  }
  if (!decodedReused.ok) {
    return decodedReused;
  }
  if (!decodedPaintEvents.ok) {
    return decodedPaintEvents;
  }
  return ok({
    mode: decodedMode.value,
    handleKind: decodedHandleKind.value,
    dimensions: decodedDimensions.value,
    reusedAcrossMotionFrames: decodedReused.value,
    acceleratedPaintEvents: decodedPaintEvents.value
  });
}

function decodeMotion(value: JsonValue, path: string): Result<MotionEvidence> {
  const object = readObject(value, path);
  if (!object.ok) {
    return object;
  }
  const keys = hasOnlyKeys(object.value, allowedMotionKeys, path);
  if (!keys.ok) {
    return keys;
  }

  const compositedFrames = required(object.value, "compositedFrames", path);
  const durationMs = required(object.value, "durationMs", path);
  const webPaintEventsBefore = required(object.value, "webPaintEventsBefore", path);
  const webPaintEventsAfter = required(object.value, "webPaintEventsAfter", path);
  const contentTextureIdChanges = required(object.value, "contentTextureIdChanges", path);
  const cpuReadbackFramesDuringMotion = required(object.value, "cpuReadbackFramesDuringMotion", path);
  if (!compositedFrames.ok) {
    return compositedFrames;
  }
  if (!durationMs.ok) {
    return durationMs;
  }
  if (!webPaintEventsBefore.ok) {
    return webPaintEventsBefore;
  }
  if (!webPaintEventsAfter.ok) {
    return webPaintEventsAfter;
  }
  if (!contentTextureIdChanges.ok) {
    return contentTextureIdChanges;
  }
  if (!cpuReadbackFramesDuringMotion.ok) {
    return cpuReadbackFramesDuringMotion;
  }

  const decodedFrames = readNonNegativeInteger(compositedFrames.value, `${path}.compositedFrames`);
  const decodedDuration = readPositiveNumber(durationMs.value, `${path}.durationMs`);
  const decodedPaintBefore = readNonNegativeInteger(webPaintEventsBefore.value, `${path}.webPaintEventsBefore`);
  const decodedPaintAfter = readNonNegativeInteger(webPaintEventsAfter.value, `${path}.webPaintEventsAfter`);
  const decodedTextureChanges = readNonNegativeInteger(contentTextureIdChanges.value, `${path}.contentTextureIdChanges`);
  const decodedCpuReadback = readNonNegativeInteger(cpuReadbackFramesDuringMotion.value, `${path}.cpuReadbackFramesDuringMotion`);
  if (!decodedFrames.ok) {
    return decodedFrames;
  }
  if (!decodedDuration.ok) {
    return decodedDuration;
  }
  if (!decodedPaintBefore.ok) {
    return decodedPaintBefore;
  }
  if (!decodedPaintAfter.ok) {
    return decodedPaintAfter;
  }
  if (!decodedTextureChanges.ok) {
    return decodedTextureChanges;
  }
  if (!decodedCpuReadback.ok) {
    return decodedCpuReadback;
  }
  return ok({
    compositedFrames: decodedFrames.value,
    durationMs: decodedDuration.value,
    webPaintEventsBefore: decodedPaintBefore.value,
    webPaintEventsAfter: decodedPaintAfter.value,
    contentTextureIdChanges: decodedTextureChanges.value,
    cpuReadbackFramesDuringMotion: decodedCpuReadback.value
  });
}

function decodeScreenshot(value: JsonValue, path: string): Result<ScreenshotEvidence> {
  const object = readObject(value, path);
  if (!object.ok) {
    return object;
  }
  const keys = hasOnlyKeys(object.value, allowedScreenshotKeys, path);
  if (!keys.ok) {
    return keys;
  }
  const imagePath = required(object.value, "path", path);
  if (!imagePath.ok) {
    return imagePath;
  }
  const decodedPath = readString(imagePath.value, `${path}.path`);
  if (!decodedPath.ok) {
    return decodedPath;
  }
  const sha256 = optional(object.value, "sha256");
  if (sha256 === undefined) {
    return ok({ path: decodedPath.value });
  }
  const decodedSha256 = readString(sha256, `${path}.sha256`);
  if (!decodedSha256.ok) {
    return decodedSha256;
  }
  return ok({ path: decodedPath.value, sha256: decodedSha256.value });
}

function decodeRun(value: JsonValue, path: string): Result<EngineRun> {
  const object = readObject(value, path);
  if (!object.ok) {
    return object;
  }
  const keys = hasOnlyKeys(object.value, allowedRunKeys, path);
  if (!keys.ok) {
    return keys;
  }

  const engine = required(object.value, "engine", path);
  const state = required(object.value, "state", path);
  const timestamp = required(object.value, "timestamp", path);
  const target = required(object.value, "target", path);
  const texture = required(object.value, "texture", path);
  const motion = required(object.value, "motion", path);
  const frameTimesMs = required(object.value, "frameTimesMs", path);
  const screenshot = required(object.value, "screenshot", path);
  const notes = required(object.value, "notes", path);
  if (!engine.ok) {
    return engine;
  }
  if (!state.ok) {
    return state;
  }
  if (!timestamp.ok) {
    return timestamp;
  }
  if (!target.ok) {
    return target;
  }
  if (!texture.ok) {
    return texture;
  }
  if (!motion.ok) {
    return motion;
  }
  if (!frameTimesMs.ok) {
    return frameTimesMs;
  }
  if (!screenshot.ok) {
    return screenshot;
  }
  if (!notes.ok) {
    return notes;
  }

  const decodedEngine = readEngine(engine.value, `${path}.engine`);
  const decodedState = readEngineState(state.value, `${path}.state`);
  const decodedTimestamp = readString(timestamp.value, `${path}.timestamp`);
  const decodedTarget = decodeTarget(target.value, `${path}.target`);
  const decodedTexture = decodeTexture(texture.value, `${path}.texture`);
  const decodedMotion = decodeMotion(motion.value, `${path}.motion`);
  const decodedFrameTimes = readNumberArray(frameTimesMs.value, `${path}.frameTimesMs`);
  const decodedScreenshot = decodeScreenshot(screenshot.value, `${path}.screenshot`);
  const decodedNotes = readStringArray(notes.value, `${path}.notes`);
  if (!decodedEngine.ok) {
    return decodedEngine;
  }
  if (!decodedState.ok) {
    return decodedState;
  }
  if (!decodedTimestamp.ok) {
    return decodedTimestamp;
  }
  if (!decodedTarget.ok) {
    return decodedTarget;
  }
  if (!decodedTexture.ok) {
    return decodedTexture;
  }
  if (!decodedMotion.ok) {
    return decodedMotion;
  }
  if (!decodedFrameTimes.ok) {
    return decodedFrameTimes;
  }
  if (!decodedScreenshot.ok) {
    return decodedScreenshot;
  }
  if (!decodedNotes.ok) {
    return decodedNotes;
  }

  return ok({
    engine: decodedEngine.value,
    state: decodedState.value,
    timestamp: decodedTimestamp.value,
    target: decodedTarget.value,
    texture: decodedTexture.value,
    motion: decodedMotion.value,
    frameTimesMs: decodedFrameTimes.value,
    screenshot: decodedScreenshot.value,
    notes: decodedNotes.value
  });
}

export function decodeReport(value: unknown): Result<SpikeReport> {
  const snapshot = safeSnapshotJson(value);
  if (!snapshot.ok) {
    return snapshot;
  }
  const object = readObject(snapshot.value, "$");
  if (!object.ok) {
    return object;
  }
  const keys = hasOnlyKeys(object.value, allowedTopKeys, "$");
  if (!keys.ok) {
    return keys;
  }

  const version = required(object.value, "schemaVersion", "$");
  const generatedAt = required(object.value, "generatedAt", "$");
  const budget = required(object.value, "budgetFps", "$");
  const runs = required(object.value, "runs", "$");
  const notes = required(object.value, "notes", "$");
  if (!version.ok) {
    return version;
  }
  if (!generatedAt.ok) {
    return generatedAt;
  }
  if (!budget.ok) {
    return budget;
  }
  if (!runs.ok) {
    return runs;
  }
  if (!notes.ok) {
    return notes;
  }

  if (version.value !== schemaVersion) {
    return err("$.schemaVersion: unsupported schema version");
  }
  const decodedGeneratedAt = readString(generatedAt.value, "$.generatedAt");
  const decodedBudget = readPositiveNumber(budget.value, "$.budgetFps");
  const decodedNotes = readStringArray(notes.value, "$.notes");
  if (!decodedGeneratedAt.ok) {
    return decodedGeneratedAt;
  }
  if (!decodedBudget.ok) {
    return decodedBudget;
  }
  if (!decodedNotes.ok) {
    return decodedNotes;
  }
  if (!Array.isArray(runs.value)) {
    return err("$.runs: expected array");
  }

  const decodedRuns: EngineRun[] = [];
  for (let index = 0; index < runs.value.length; index += 1) {
    const run = runs.value[index];
    if (run === undefined) {
      return err(`$.runs[${index}]: missing run`);
    }
    const decoded = decodeRun(run, `$.runs[${index}]`);
    if (!decoded.ok) {
      return decoded;
    }
    decodedRuns.push(decoded.value);
  }

  return ok({
    schemaVersion,
    generatedAt: decodedGeneratedAt.value,
    budgetFps: decodedBudget.value,
    runs: decodedRuns,
    notes: decodedNotes.value
  });
}

export function parseReportJson(text: string): Result<SpikeReport> {
  try {
    return decodeReport(JSON.parse(text) as unknown);
  } catch (caught) {
    return err(`invalid JSON (${caught instanceof Error ? caught.message : "unknown error"})`);
  }
}

function percentile(sorted: readonly number[], rank: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const rawIndex = Math.ceil((rank / 100) * sorted.length) - 1;
  const index = Math.min(Math.max(rawIndex, 0), sorted.length - 1);
  const value = sorted[index];
  return value === undefined ? 0 : value;
}

export function summarizeFrameTimes(frameTimesMs: readonly number[]): FrameTimeSummary {
  if (frameTimesMs.length === 0) {
    return {
      minMs: 0,
      p50Ms: 0,
      p90Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
      histogram: [
        { label: "<=8.33ms", minInclusiveMs: 0, maxExclusiveMs: 8.33, count: 0 },
        { label: "8.33-16.67ms", minInclusiveMs: 8.33, maxExclusiveMs: 16.67, count: 0 },
        { label: "16.67-20ms", minInclusiveMs: 16.67, maxExclusiveMs: 20, count: 0 },
        { label: "20-33.33ms", minInclusiveMs: 20, maxExclusiveMs: 33.33, count: 0 },
        { label: ">33.33ms", minInclusiveMs: 33.33, maxExclusiveMs: null, count: 0 }
      ]
    };
  }
  const sorted = [...frameTimesMs].sort((left, right) => left - right);
  const min = sorted[0] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;
  const buckets = [
    { label: "<=8.33ms", minInclusiveMs: 0, maxExclusiveMs: 8.33, count: 0 },
    { label: "8.33-16.67ms", minInclusiveMs: 8.33, maxExclusiveMs: 16.67, count: 0 },
    { label: "16.67-20ms", minInclusiveMs: 16.67, maxExclusiveMs: 20, count: 0 },
    { label: "20-33.33ms", minInclusiveMs: 20, maxExclusiveMs: 33.33, count: 0 },
    { label: ">33.33ms", minInclusiveMs: 33.33, maxExclusiveMs: null, count: 0 }
  ];

  for (let index = 0; index < frameTimesMs.length; index += 1) {
    const value = frameTimesMs[index];
    if (value === undefined) {
      continue;
    }
    for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex += 1) {
      const bucket = buckets[bucketIndex];
      if (bucket === undefined) {
        continue;
      }
      const belowMax = bucket.maxExclusiveMs === null || value < bucket.maxExclusiveMs;
      if (value >= bucket.minInclusiveMs && belowMax) {
        buckets[bucketIndex] = { ...bucket, count: bucket.count + 1 };
        break;
      }
    }
  }

  return {
    minMs: min,
    p50Ms: percentile(sorted, 50),
    p90Ms: percentile(sorted, 90),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    maxMs: max,
    histogram: buckets
  };
}

export function measuredFps(run: EngineRun): number {
  if (run.motion.durationMs <= 0) {
    return 0;
  }
  return (run.motion.compositedFrames * 1000) / run.motion.durationMs;
}

export function evaluateRun(run: EngineRun, budget = fpsBudget): RunEvaluation {
  const reasons: string[] = [];
  const fps = measuredFps(run);
  const noRepaintDuringMotion = run.motion.webPaintEventsAfter === run.motion.webPaintEventsBefore;
  const sharedTextureReused =
    run.texture.mode === "shared-texture" &&
    run.texture.reusedAcrossMotionFrames &&
    run.motion.contentTextureIdChanges === 0 &&
    run.motion.cpuReadbackFramesDuringMotion === 0;

  if (run.state === "unavailable") {
    reasons.push(`${run.engine}: engine or shared-texture backend unavailable`);
  } else if (run.state === "not-run") {
    reasons.push(`${run.engine}: run pending`);
  } else if (run.state === "error") {
    reasons.push(`${run.engine}: native spike reported an error`);
  }
  if (run.texture.mode !== "shared-texture") {
    reasons.push(`${run.engine}: normal path did not use a shared texture`);
  }
  if (run.texture.handleKind === "none") {
    reasons.push(`${run.engine}: no importable GPU handle was observed`);
  }
  if (!run.texture.reusedAcrossMotionFrames) {
    reasons.push(`${run.engine}: content texture was not reused across compositor motion`);
  }
  if (!noRepaintDuringMotion) {
    reasons.push(`${run.engine}: web content repainted during compositor-only motion`);
  }
  if (run.motion.contentTextureIdChanges !== 0) {
    reasons.push(`${run.engine}: content texture id changed during motion`);
  }
  if (run.motion.cpuReadbackFramesDuringMotion !== 0) {
    reasons.push(`${run.engine}: CPU readback occurred during motion`);
  }
  if (fps < budget) {
    reasons.push(`${run.engine}: ${fps.toFixed(1)}fps is below ${budget}fps budget`);
  }

  const status = reasons.length === 0 ? "pass" : run.state === "unavailable" ? "unavailable" : run.state === "not-run" ? "not-run" : "fail";
  return {
    engine: run.engine,
    status,
    fps,
    noRepaintDuringMotion,
    sharedTextureReused,
    frameTime: summarizeFrameTimes(run.frameTimesMs),
    reasons
  };
}

export function evaluateReport(report: SpikeReport): ReportEvaluation {
  const evaluations = report.runs.map((run) => evaluateRun(run, report.budgetFps));
  const cef = evaluations.find((run) => run.engine === "cef");
  const wpe = evaluations.find((run) => run.engine === "wpe");
  const pending = evaluations.some((run) => run.status === "not-run");
  const reasons: string[] = [];

  let recommendedEngine: VerdictEngine = "none";
  if (cef?.status === "pass") {
    recommendedEngine = "cef";
  } else if (wpe?.status === "pass") {
    recommendedEngine = "wpe";
  } else if (pending) {
    recommendedEngine = "pending";
  }

  if (recommendedEngine === "none") {
    for (let index = 0; index < evaluations.length; index += 1) {
      const run = evaluations[index];
      if (run === undefined) {
        continue;
      }
      reasons.push(...run.reasons);
    }
  } else if (recommendedEngine === "pending") {
    reasons.push("VMware GPU measurement run is pending");
  }

  return {
    verdict: recommendedEngine,
    recommendedEngine,
    runs: evaluations,
    reasons
  };
}

export function createPendingReport(generatedAt: string): SpikeReport {
  const baseRun = (engine: EngineName): EngineRun => ({
    engine,
    state: "not-run",
    timestamp: generatedAt,
    target: {
      os: "pending-vmware-target",
      gpu: "pending-vmware-3d",
      vmware3d: false,
      driver: "pending"
    },
    texture: {
      mode: "unavailable",
      handleKind: "none",
      dimensions: { width: 0, height: 0 },
      reusedAcrossMotionFrames: false,
      acceleratedPaintEvents: 0
    },
    motion: {
      compositedFrames: 0,
      durationMs: 1,
      webPaintEventsBefore: 0,
      webPaintEventsAfter: 0,
      contentTextureIdChanges: 0,
      cpuReadbackFramesDuringMotion: 0
    },
    frameTimesMs: [],
    screenshot: {
      path: "artifacts/pending.png"
    },
    notes: ["Run this spike on the VMware Workstation Pro GPU target with CEF_ROOT or WPE WebKit installed."]
  });

  return {
    schemaVersion,
    generatedAt,
    budgetFps: fpsBudget,
    runs: [baseRun("cef"), baseRun("wpe")],
    notes: ["No GPU target was available in the authoring environment."]
  };
}
