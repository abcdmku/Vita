import { app, backup, defineSystem } from "../typescript/src/define-system.ts";

export default defineSystem(({ device, data }) => ({
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
      publicAccess: true,
      memory: device.memoryGB >= 16 ? "2GiB" : "1GiB",
    }),

    app("local-search", {
      accelerator: device.ai.bestAvailable({
        prefer: ["npu", "gpu", "cpu"],
        requireFallback: "cpu",
      }),
      dataAccess: [data.files.readOnly()],
    }),
  ],

  backups: [backup.usb({ schedule: "daily" })],
}));
