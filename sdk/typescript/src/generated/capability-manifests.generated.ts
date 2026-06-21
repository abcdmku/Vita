// DO NOT EDIT — generated from schema/capabilities/accounts.json, schema/capabilities/capsule.json, schema/capabilities/hostname.json, schema/capabilities/identity.json, schema/capabilities/node.config.json, schema/capabilities/services.json, schema/capabilities/time.json, schema/capabilities/timesync.json, schema/capabilities/update.json

import type { CapabilityManifest } from "../capability-manifest.ts";

export const ACCOUNTS_MANIFEST = Object.freeze({
  capability: "accounts.config",
  version: 1,
  fields: Object.freeze({
    desired: Object.freeze({
      fields: Object.freeze({
        accounts: Object.freeze({
          items: Object.freeze({
            fields: Object.freeze({
              enabled: Object.freeze({
                required: true,
                type: "boolean",
              }),
              groups: Object.freeze({
                items: Object.freeze({
                  format: "groupName",
                  required: true,
                  type: "string",
                  notInEnum: Object.freeze([
                    "admin",
                    "root",
                    "sudo",
                    "wheel",
                  ]),
                }),
                required: true,
                type: "array",
                dedupItems: true,
              }),
              name: Object.freeze({
                format: "posixAccountName",
                required: true,
                type: "string",
              }),
              primaryGroup: Object.freeze({
                format: "groupName",
                required: true,
                type: "string",
                notInEnum: Object.freeze([
                  "admin",
                  "root",
                  "sudo",
                  "wheel",
                ]),
              }),
              shell: Object.freeze({
                required: true,
                type: "string",
                enum: Object.freeze([
                  "/bin/bash",
                  "/bin/sh",
                  "/usr/bin/bash",
                  "/usr/bin/zsh",
                  "/usr/sbin/nologin",
                  "/bin/false",
                ]),
              }),
              uid: Object.freeze({
                required: true,
                type: "integer",
                maximum: 60000,
                minimum: 1000,
              }),
            }),
            required: true,
            type: "object",
          }),
          required: true,
          type: "array",
          uniqueBy: Object.freeze([
            "name",
            "uid",
          ]),
        }),
      }),
      required: true,
      type: "object",
    }),
  }),
  crossFieldRules: Object.freeze([]),
}) satisfies CapabilityManifest;

export const CAPSULE_MANIFEST = Object.freeze({
  capability: "capsule.registry",
  version: 1,
  fields: Object.freeze({
    desired: Object.freeze({
      fields: Object.freeze({
        capsules: Object.freeze({
          items: Object.freeze({
            fields: Object.freeze({
              version: Object.freeze({
                format: "capsuleVersion",
                required: true,
                type: "string",
                forbiddenSchemePrefix: true,
                maxBytes: 128,
                noControlChars: true,
                noInlineCapsuleMaterial: true,
                trimmed: true,
              }),
              id: Object.freeze({
                format: "capsuleId",
                required: true,
                type: "string",
                forbiddenSchemePrefix: true,
                maxBytes: 255,
                noControlChars: true,
                noInlineCapsuleMaterial: true,
                trimmed: true,
              }),
              integrity: Object.freeze({
                format: "sriIntegrity",
                required: true,
                type: "string",
              }),
              state: Object.freeze({
                required: true,
                type: "string",
                enum: Object.freeze([
                  "installed",
                  "disabled",
                ]),
              }),
            }),
            required: true,
            type: "object",
          }),
          required: true,
          type: "array",
          uniqueBy: Object.freeze([
            "id",
          ]),
        }),
      }),
      required: true,
      type: "object",
    }),
  }),
  crossFieldRules: Object.freeze([]),
}) satisfies CapabilityManifest;

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

export const IDENTITY_MANIFEST = Object.freeze({
  capability: "identity.attestation",
  version: 1,
  fields: Object.freeze({
    desired: Object.freeze({
      fields: Object.freeze({
        did: Object.freeze({
          format: "didPlcOrWeb",
          required: true,
          type: "string",
        }),
        handle: Object.freeze({
          format: "atprotoHandle",
          required: true,
          type: "string",
        }),
        signingKeyRef: Object.freeze({
          fields: Object.freeze({
            handle: Object.freeze({
              format: "keyReference",
              required: true,
              type: "string",
              noInlineIdentityMaterial: true,
            }),
            id: Object.freeze({
              format: "keyReference",
              required: true,
              type: "string",
              noInlineIdentityMaterial: true,
            }),
          }),
          required: true,
          type: "object",
        }),
      }),
      required: true,
      type: "object",
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

export const UPDATE_MANIFEST = Object.freeze({
  capability: "update.plan",
  version: 1,
  fields: Object.freeze({
    desired: Object.freeze({
      fields: Object.freeze({
        bundle: Object.freeze({
          fields: Object.freeze({
            version: Object.freeze({
              format: "bundleVersionString",
              required: true,
              type: "string",
              maxBytes: 128,
            }),
            integrity: Object.freeze({
              format: "sriIntegrity",
              required: true,
              type: "string",
            }),
            ref: Object.freeze({
              format: "bundleRefString",
              required: true,
              type: "string",
              forbiddenSchemePrefix: true,
              maxBytes: 256,
            }),
          }),
          required: true,
          type: "object",
        }),
        targetSlot: Object.freeze({
          required: true,
          type: "string",
          enum: Object.freeze([
            "a",
            "b",
          ]),
        }),
      }),
      required: true,
      type: "object",
    }),
  }),
  crossFieldRules: Object.freeze([]),
}) satisfies CapabilityManifest;

export const DEFAULT_CAPABILITY_MANIFESTS = Object.freeze({
  "accounts.config": ACCOUNTS_MANIFEST,
  "capsule.registry": CAPSULE_MANIFEST,
  "hostname.set": HOSTNAME_MANIFEST,
  "identity.attestation": IDENTITY_MANIFEST,
  "node.config": NODE_CONFIG_MANIFEST,
  "services.config": SERVICES_MANIFEST,
  "time.set": TIME_MANIFEST,
  "time.sync": TIMESYNC_MANIFEST,
  "update.plan": UPDATE_MANIFEST,
}) satisfies Readonly<Record<string, CapabilityManifest>>;

