// Minimal type surface required by the vendored agent client.
export type JsonPrimitive = string | number | boolean | null;

export type CanonicalJsonValue =
  | JsonPrimitive
  | CanonicalJsonObject
  | readonly CanonicalJsonValue[];

export interface CanonicalJsonObject {
  readonly [key: string]: CanonicalJsonValue;
}
