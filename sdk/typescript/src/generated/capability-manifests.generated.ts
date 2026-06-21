// DO NOT EDIT — generated from schema/capabilities/hostname.json, schema/capabilities/timesync.json

import type { CapabilityManifest } from "../capability-manifest.ts";

export const HOSTNAME_MANIFEST = Object.freeze({
  capability: "hostname.set",
  version: 1,
  fields: Object.freeze({
    desired: Object.freeze({
      format: "hostnameLabel",
      maxLength: 63,
      required: true,
      type: "string",
    }),
  }),
  crossFieldRules: Object.freeze([]),
}) satisfies CapabilityManifest;

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
        format: "hostnameRFC1123",
        lowercase: true,
        maxLength: 253,
        noInlineSecrets: true,
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

export const DEFAULT_CAPABILITY_MANIFESTS = Object.freeze({
  "hostname.set": HOSTNAME_MANIFEST,
  "time.sync": TIMESYNC_MANIFEST,
}) satisfies Readonly<Record<string, CapabilityManifest>>;

