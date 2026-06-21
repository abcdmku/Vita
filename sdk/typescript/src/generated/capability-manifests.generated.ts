// DO NOT EDIT — generated from schema/capabilities/accounts.json, schema/capabilities/backup.json, schema/capabilities/capsule.json, schema/capabilities/hostname.json, schema/capabilities/identity.json, schema/capabilities/network.json, schema/capabilities/node.config.json, schema/capabilities/services.json, schema/capabilities/time.json, schema/capabilities/timesync.json, schema/capabilities/update.json

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

export const BACKUP_MANIFEST = Object.freeze({
  capability: "backup.policy",
  version: 1,
  fields: Object.freeze({
    desired: Object.freeze({
      fields: Object.freeze({
        recoveryKeyRef: Object.freeze({
          fields: Object.freeze({
            handle: Object.freeze({
              format: "backupRef",
              required: true,
              type: "string",
            }),
            id: Object.freeze({
              format: "backupRef",
              required: true,
              type: "string",
            }),
            keyStoreRef: Object.freeze({
              format: "backupRef",
              required: false,
              type: "string",
              nullAsAbsent: true,
            }),
          }),
          required: true,
          type: "object",
        }),
        retention: Object.freeze({
          fields: Object.freeze({
            count: Object.freeze({
              required: true,
              type: "integer",
              maximum: 1000,
              minimum: 1,
            }),
            maxAgeDays: Object.freeze({
              required: true,
              type: "integer",
              maximum: 3650,
              minimum: 1,
            }),
          }),
          required: true,
          type: "object",
        }),
        schedule: Object.freeze({
          fields: Object.freeze({
            cron: Object.freeze({
              format: "cron5OrMacro",
              required: false,
              type: "string",
              nullAsAbsent: true,
            }),
            intervalSeconds: Object.freeze({
              required: false,
              type: "integer",
              maximum: 31536000,
              minimum: 1,
              nullAsAbsent: true,
            }),
          }),
          crossFieldRules: Object.freeze([
            Object.freeze({
              fields: Object.freeze([
                "cron",
                "intervalSeconds",
              ]),
              type: "exactlyOneOf",
            }),
          ]),
          required: true,
          type: "object",
        }),
        targets: Object.freeze({
          items: Object.freeze({
            fields: Object.freeze({
              id: Object.freeze({
                format: "backupRef",
                required: true,
                type: "string",
              }),
            }),
            required: true,
            type: "object",
          }),
          required: true,
          type: "array",
          minItems: 1,
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

export const NETWORK_MANIFEST = Object.freeze({
  capability: "network.policy",
  version: 1,
  fields: Object.freeze({
    desired: Object.freeze({
      fields: Object.freeze({
        allow: Object.freeze({
          items: Object.freeze({
            fields: Object.freeze({
              interface: Object.freeze({
                format: "networkInterfaceName",
                required: true,
                type: "string",
              }),
              port: Object.freeze({
                required: true,
                type: "integer",
                maximum: 65535,
                minimum: 1,
                sentinelValues: Object.freeze([
                  -1,
                ]),
              }),
              proto: Object.freeze({
                required: true,
                type: "string",
                enum: Object.freeze([
                  "tcp",
                  "udp",
                ]),
              }),
              sourceCidr: Object.freeze({
                format: "cidrLiteral",
                required: true,
                type: "string",
              }),
              unsafeWideOpen: Object.freeze({
                required: false,
                type: "boolean",
              }),
            }),
            crossFieldRules: Object.freeze([
              Object.freeze({
                type: "forbidIntegerSentinelAndCidrCoversAllUnlessTrue",
                control: "unsafeWideOpen",
                target: "sourceCidr",
                integer: "port",
                sentinel: -1,
              }),
            ]),
            required: true,
            type: "object",
          }),
          required: true,
          type: "array",
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
  "backup.policy": BACKUP_MANIFEST,
  "capsule.registry": CAPSULE_MANIFEST,
  "hostname.set": HOSTNAME_MANIFEST,
  "identity.attestation": IDENTITY_MANIFEST,
  "network.policy": NETWORK_MANIFEST,
  "node.config": NODE_CONFIG_MANIFEST,
  "services.config": SERVICES_MANIFEST,
  "time.set": TIME_MANIFEST,
  "time.sync": TIMESYNC_MANIFEST,
  "update.plan": UPDATE_MANIFEST,
}) satisfies Readonly<Record<string, CapabilityManifest>>;

