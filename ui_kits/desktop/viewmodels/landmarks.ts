export type LandmarkRole = "banner" | "nav" | "main" | "complementary" | "contentinfo";

export interface LandmarkRegionInput {
  readonly focusId?: string;
  readonly id: string;
  readonly label?: string;
  readonly role: LandmarkRole;
}

export interface LandmarksOptions {
  readonly landmarks?: readonly LandmarkRegionInput[];
}

export interface LandmarkRegion {
  readonly focusId: string;
  readonly id: string;
  readonly label: string;
  readonly role: LandmarkRole;
}

export interface LandmarkSkipLink {
  readonly id: string;
  readonly label: string;
  readonly role: LandmarkRole;
  readonly targetId: string;
}

export interface LandmarksState {
  readonly landmarks: readonly LandmarkRegion[];
  readonly skipLinks: readonly LandmarkSkipLink[];
}

export interface LandmarksViewModel {
  focusTarget(landmarkId: unknown): string | null;
  landmarks(): readonly LandmarkRegion[];
  list(): readonly LandmarkRegion[];
  orderedLandmarks(): readonly LandmarkRegion[];
  skipLinks(): readonly LandmarkSkipLink[];
  snapshot(): LandmarksState;
}

type NormalizeResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
    };

const OPTION_FIELDS = Object.freeze(["landmarks"]);
const LANDMARK_FIELDS = Object.freeze(["focusId", "id", "label", "role"]);

const EMPTY_LANDMARKS_STATE: LandmarksState = Object.freeze({
  landmarks: Object.freeze([]),
  skipLinks: Object.freeze([]),
});

export function createLandmarksViewModel(options?: LandmarksOptions): LandmarksViewModel;
export function createLandmarksViewModel(landmarks: readonly LandmarkRegionInput[]): LandmarksViewModel;
export function createLandmarksViewModel(input?: unknown): LandmarksViewModel;
export function createLandmarksViewModel(input: unknown = Object.freeze({})): LandmarksViewModel {
  return new DesktopLandmarksViewModel(input);
}

export const createLandmarkNavigationViewModel = createLandmarksViewModel;

class DesktopLandmarksViewModel implements LandmarksViewModel {
  readonly #state: LandmarksState;

  constructor(input: unknown) {
    const normalized = Array.isArray(input) ? normalizeLandmarks(input) : normalizeLandmarksOptions(input);

    this.#state = normalized.ok ? stateFor(normalized.value) : EMPTY_LANDMARKS_STATE;
  }

  snapshot(): LandmarksState {
    return this.#state;
  }

  landmarks(): readonly LandmarkRegion[] {
    return this.#state.landmarks;
  }

  list(): readonly LandmarkRegion[] {
    return this.#state.landmarks;
  }

  orderedLandmarks(): readonly LandmarkRegion[] {
    return this.#state.landmarks;
  }

  skipLinks(): readonly LandmarkSkipLink[] {
    return this.#state.skipLinks;
  }

  focusTarget(landmarkId: unknown): string | null {
    if (typeof landmarkId !== "string" || landmarkId.length === 0) {
      return null;
    }

    for (let index = 0; index < this.#state.landmarks.length; index += 1) {
      const landmark = this.#state.landmarks[index];

      if (landmark !== undefined && landmark.id === landmarkId) {
        return landmark.focusId;
      }
    }

    return null;
  }
}

function normalizeLandmarksOptions(input: unknown): NormalizeResult<readonly LandmarkRegion[]> {
  const object = snapshotObject(input, OPTION_FIELDS);

  if (!object.ok) {
    return reject();
  }

  if (!object.value.has("landmarks")) {
    return accept(Object.freeze([]) as readonly LandmarkRegion[]);
  }

  return normalizeLandmarks(object.value.get("landmarks"));
}

function normalizeLandmarks(input: unknown): NormalizeResult<readonly LandmarkRegion[]> {
  const array = snapshotArray(input);

  if (!array.ok) {
    return reject();
  }

  const landmarks: LandmarkRegion[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < array.value.length; index += 1) {
    const raw = array.value[index];
    const normalized = normalizeLandmark(raw);

    if (!normalized.ok || seen.has(normalized.value.id)) {
      return reject();
    }

    seen.add(normalized.value.id);
    landmarks.push(normalized.value);
  }

  return accept(Object.freeze(landmarks));
}

function normalizeLandmark(input: unknown): NormalizeResult<LandmarkRegion> {
  const object = snapshotObject(input, LANDMARK_FIELDS);

  if (!object.ok) {
    return reject();
  }

  const id = stringId(object.value.get("id"));
  const role = landmarkRole(object.value.get("role"));
  const focusIdValue = object.value.get("focusId");
  const labelValue = object.value.get("label");
  const focusId = focusIdValue === undefined ? id : stringId(focusIdValue);
  const label = labelValue === undefined ? roleLabel(role) : stringId(labelValue);

  if (id === null || role === null || focusId === null || label === null) {
    return reject();
  }

  return accept(Object.freeze({
    focusId,
    id,
    label,
    role,
  }));
}

function stateFor(landmarks: readonly LandmarkRegion[]): LandmarksState {
  const frozenLandmarks: LandmarkRegion[] = [];
  const skipLinks: LandmarkSkipLink[] = [];

  for (let index = 0; index < landmarks.length; index += 1) {
    const landmark = landmarks[index];

    if (landmark === undefined) {
      continue;
    }

    const frozen = Object.freeze({
      focusId: landmark.focusId,
      id: landmark.id,
      label: landmark.label,
      role: landmark.role,
    }) satisfies LandmarkRegion;

    frozenLandmarks.push(frozen);
    skipLinks.push(Object.freeze({
      id: frozen.id,
      label: frozen.label,
      role: frozen.role,
      targetId: frozen.focusId,
    }));
  }

  return Object.freeze({
    landmarks: Object.freeze(frozenLandmarks),
    skipLinks: Object.freeze(skipLinks),
  });
}

function snapshotObject(
  input: unknown,
  allowedKeys: readonly string[],
): NormalizeResult<ReadonlyMap<string, unknown>> {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return reject();
    }

    const prototype = Object.getPrototypeOf(input);

    if (prototype !== Object.prototype && prototype !== null) {
      return reject();
    }

    const keys = Reflect.ownKeys(input);
    const output = new Map<string, unknown>();

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === undefined || typeof key === "symbol" || !contains(allowedKeys, key)) {
        return reject();
      }

      const descriptor = Object.getOwnPropertyDescriptor(input, key);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return reject();
      }

      output.set(key, descriptor.value);
    }

    return accept(output);
  } catch {
    return reject();
  }
}

function snapshotArray(input: unknown): NormalizeResult<readonly unknown[]> {
  try {
    if (!Array.isArray(input)) {
      return reject();
    }

    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");

    if (
      lengthDescriptor === undefined ||
      !isDataDescriptor(lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      return reject();
    }

    const length = lengthDescriptor.value;
    const keys = Reflect.ownKeys(input);

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === "length") {
        continue;
      }
      if (key === undefined || typeof key === "symbol" || !isArrayIndexKey(key, length)) {
        return reject();
      }
    }

    const output: unknown[] = [];

    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return reject();
      }

      output.push(descriptor.value);
    }

    return accept(Object.freeze(output));
  } catch {
    return reject();
  }
}

function landmarkRole(input: unknown): LandmarkRole | null {
  switch (input) {
    case "banner":
    case "complementary":
    case "contentinfo":
    case "main":
    case "nav":
      return input;
    default:
      return null;
  }
}

function roleLabel(role: LandmarkRole | null): string | null {
  switch (role) {
    case "banner":
      return "Banner";
    case "complementary":
      return "Complementary";
    case "contentinfo":
      return "Footer";
    case "main":
      return "Main";
    case "nav":
      return "Navigation";
    case null:
      return null;
  }
}

function stringId(input: unknown): string | null {
  return typeof input === "string" && input.length > 0 ? input : null;
}

function contains(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) {
      return true;
    }
  }

  return false;
}

function isArrayIndexKey(key: string, length: number): boolean {
  if (key.length === 0) {
    return false;
  }

  const index = Number(key);

  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function isDataDescriptor(descriptor: PropertyDescriptor): descriptor is PropertyDescriptor & {
  readonly value: unknown;
} {
  return Object.prototype.hasOwnProperty.call(descriptor, "value");
}

function accept<T>(value: T): NormalizeResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function reject<T>(): NormalizeResult<T> {
  return Object.freeze({
    ok: false,
  });
}
