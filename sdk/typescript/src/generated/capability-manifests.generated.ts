// DO NOT EDIT — generated from schema/capabilities/hostname.json, schema/capabilities/node.config.json, schema/capabilities/services.json, schema/capabilities/time.json, schema/capabilities/timesync.json

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

export const NODE_CONFIG_MANIFEST = Object.freeze({
  capability: "node.config",
  version: 1,
  fields: Object.freeze({
    desired: Object.freeze({
      fields: Object.freeze({
        mode: Object.freeze({
          required: true,
          type: "string",
          enum: Object.freeze([
            "normal",
            "maintenance",
          ]),
        }),
        remoteAccess: Object.freeze({
          required: true,
          type: "string",
          enum: Object.freeze([
            "disabled",
            "enabled",
          ]),
        }),
      }),
      required: true,
      type: "object",
    }),
  }),
  crossFieldRules: Object.freeze([]),
}) satisfies CapabilityManifest;

export const SERVICES_MANIFEST = Object.freeze({
  capability: "services.config",
  version: 1,
  fields: Object.freeze({
    desired: Object.freeze({
      fields: Object.freeze({
        services: Object.freeze({
          items: Object.freeze({
            fields: Object.freeze({
              enabled: Object.freeze({
                required: true,
                type: "boolean",
              }),
              name: Object.freeze({
                format: "systemdUnitName",
                required: true,
                type: "string",
              }),
            }),
            required: true,
            type: "object",
          }),
          required: true,
          type: "array",
          uniqueBy: Object.freeze([
            "name",
          ]),
        }),
      }),
      required: true,
      type: "object",
    }),
  }),
  crossFieldRules: Object.freeze([]),
}) satisfies CapabilityManifest;

export const TIME_MANIFEST = Object.freeze({
  capability: "time.set",
  version: 1,
  fields: Object.freeze({
    desired: Object.freeze({
      format: "rfc3339Instant",
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
    desired: Object.freeze({
      fields: Object.freeze({
        enabled: Object.freeze({
          required: true,
          type: "boolean",
        }),
        servers: Object.freeze({
          items: Object.freeze({
            format: "hostnameOrIp",
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
      required: true,
      type: "object",
    }),
  }),
  crossFieldRules: Object.freeze([]),
}) satisfies CapabilityManifest;

export const DEFAULT_CAPABILITY_MANIFESTS = Object.freeze({
  "hostname.set": HOSTNAME_MANIFEST,
  "node.config": NODE_CONFIG_MANIFEST,
  "services.config": SERVICES_MANIFEST,
  "time.set": TIME_MANIFEST,
  "time.sync": TIMESYNC_MANIFEST,
}) satisfies Readonly<Record<string, CapabilityManifest>>;

