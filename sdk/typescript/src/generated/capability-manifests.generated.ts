// DO NOT EDIT — generated from schema/capabilities/timesync.json

import type { CapabilityManifest } from "../capability-manifest.ts";

export const TIMESYNC_MANIFEST = Object.freeze({
  capability: "time.sync",
  version: 1,
  fields: Object.freeze({
    enabled: Object.freeze({
      required: true,
      type: "boolean",
    }),
    servers: Object.freeze({
      items: Object.freeze({
        lowercase: true,
        maxLength: 253,
        noInlineSecrets: true,
        pattern: "^(?![0-9]+(?:\\.[0-9]+){3}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$",
        required: true,
        type: "string",
      }),
      required: true,
      type: "array",
      maxItems: 8,
      uniqueItems: true,
    }),
  }),
  crossFieldRules: Object.freeze([
    Object.freeze({
      type: "requireNonEmptyArrayWhenTrue",
      control: "enabled",
      target: "servers",
    }),
    Object.freeze({
      type: "requireEmptyArrayWhenFalse",
      control: "enabled",
      target: "servers",
    }),
  ]),
}) satisfies CapabilityManifest;

