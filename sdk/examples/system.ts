import { app, backup, defineSystem } from "../typescript/src/define-system.ts";
import type { SystemAuthor } from "../typescript/src/define-system.ts";

export const exampleState: SystemAuthor = ({ device, data }) => ({
  identity: {
    passkeysRequired: true,
  },

  storage: {
    dataVolume: {
      encryption: "required",
      snapshots: "hourly",
    },
  },

  apps: [
    app("atproto-pds", {
      allowedCapabilities: ["network.public"],
      publicAccess: true,
      memory: device.memoryGB >= 16 ? "2GiB" : "1GiB",
    }),

    app("local-search", {
      allowedCapabilities: ["data.files.read-only"],
      accelerator: device.ai.bestAvailable({
        prefer: ["npu", "gpu", "cpu"],
        requireFallback: "cpu",
      }),
      dataAccess: [data.files.readOnly()],
    }),
  ],

  backups: [backup.usb({ schedule: "daily" })],
});

export default defineSystem(exampleState);
