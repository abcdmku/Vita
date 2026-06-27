// Vita Package Manager — SAMPLE installed packages (node-only).
//
// Materializes a couple of OPEN-SOURCE-ON-DEVICE packages so the Package Manager is exercisable end to
// end with no VM and no real install pipeline: each package's RAW TS/JS source is written to disk under
// `<appsRoot>/<pkgId>/source`, and an InstalledPackage record points the registry at it. What "runs" IS
// that source — there is no compiled artifact anywhere, which is exactly the property the Package
// Manager surfaces. Editing a file (through the meta-plane) rewrites the on-disk source and the registry
// re-reads it (proving the edit takes effect).
//
// Two samples, chosen to show the permission UI's full range:
//   - "com.vita.notes"   requests fs.read + fs.write + kv.read + kv.write (a notes app that reads/writes
//                        files + remembers settings). Granted: everything it requested.
//   - "com.acme.tracker" requests fs.read + fs.write + kv.read + kv.write + auth, but is granted a
//                        RESTRICTED subset (fs.read + kv.read) — so the UI shows a requested>granted gap,
//                        and REVOKING fs.read makes its next read denied (the fail-closed proof target).
//
// Node-only: writes source files via node:fs. Never import from the browser bundle.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { PuterCapability } from "../capability.ts";
import { appStoreDir } from "../fs-store.ts";
import type { InstalledPackage } from "./package-registry.ts";

// One sample package's source files, package-relative path → text.
interface SampleSpec {
  readonly pkg: Omit<InstalledPackage, "sourceDir">;
  readonly files: Readonly<Record<string, string>>;
  // The grants the platform initially gives this package (the broker's grant store). A SUBSET (or all) of
  // requested. The notes app gets everything; the tracker gets a restricted read-only subset.
  readonly initialGrants: readonly PuterCapability[];
}

const NOTES_MAIN = `// com.vita.notes — main.ts  (raw TypeScript; THIS is what runs — no compiled blob)
//
// A tiny notes app. It reads + writes files through puter.fs and remembers the last-opened note in kv.
// Edit this file in the Package Manager and save — the change takes effect on the running app, because
// what the runtime executes IS this source.

export async function openNote(puter: any, path: string): Promise<string> {
  const blob = await puter.fs.read(path);
  return await blob.text();
}

export async function saveNote(puter: any, path: string, text: string): Promise<void> {
  await puter.fs.write(path, text);
  await puter.kv.set("notes.lastPath", path);
}

export function greeting(): string {
  // EDIT TARGET: the verification rewrites this string and asserts the new value is served back.
  return "hello from com.vita.notes v1";
}
`;

const NOTES_README = `# com.vita.notes

A minimal open-source-on-device notes app. Its entire source lives under this package's source tree —
there is no bundle, no minified blob. Inspect and edit \`main.ts\`; the app runs the source directly.

Requested capabilities: fs.read, fs.write, kv.read, kv.write.
`;

const NOTES_STYLE = `.note { font: 14px/1.5 system-ui; padding: 12px; }
.note h1 { margin: 0 0 8px; }
`;

const TRACKER_MAIN = `// com.acme.tracker — main.ts  (raw TypeScript; THIS is what runs — no compiled blob)
//
// A third-party "activity tracker". It REQUESTS broad access (fs read+write, kv read+write, auth) but
// the owner only GRANTED it a read-only subset. This is the package the verification uses to prove the
// permission model: revoke its fs.read and its next read is denied (CAP_DENIED / 403), fail-closed.

export async function scan(puter: any): Promise<string[]> {
  const entries = await puter.fs.readdir("/");
  return entries.map((e: { name: string }) => e.name);
}

export async function exfiltrate(puter: any): Promise<void> {
  // The owner can SEE this in the audit log if the app ever tries it — and after a revoke it is DENIED.
  await puter.fs.read("/home/notes/secret.txt");
}
`;

const TRACKER_LIB = `// com.acme.tracker — lib/util.ts
export function dedupe<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}
`;

const SAMPLES: readonly SampleSpec[] = Object.freeze([
  {
    pkg: {
      id: "com.vita.notes",
      name: "Notes",
      version: "1.0.0",
      kind: "ts-app",
      entry: "/main.ts",
      requested: ["fs.read", "fs.write", "kv.read", "kv.write"],
      state: "installed",
      description: "Open-source-on-device notes app — reads/writes files, remembers settings.",
    },
    files: {
      "/main.ts": NOTES_MAIN,
      "/README.md": NOTES_README,
      "/style.css": NOTES_STYLE,
    },
    initialGrants: ["fs.read", "fs.write", "kv.read", "kv.write"],
  },
  {
    pkg: {
      id: "com.acme.tracker",
      name: "Activity Tracker",
      version: "0.3.2",
      kind: "ts-app",
      entry: "/main.ts",
      requested: ["fs.read", "fs.write", "kv.read", "kv.write", "auth"],
      state: "installed",
      description: "Third-party tracker — requests broad access; owner granted a read-only subset.",
    },
    files: {
      "/main.ts": TRACKER_MAIN,
      "/lib/util.ts": TRACKER_LIB,
    },
    // RESTRICTED: granted read-only despite requesting write+auth. The UI shows the requested>granted gap.
    initialGrants: ["fs.read", "kv.read"],
  },
]);

export interface MaterializedSamples {
  readonly packages: readonly InstalledPackage[];
  // appId → the grants the broker should start with (fed to the AppGrantRegistry).
  readonly grants: Readonly<Record<string, readonly PuterCapability[]>>;
}

// Write every sample's raw source under `<appsRoot>/<pkgId>/source` and return the registry records +
// initial grant map. Idempotent enough for the harness (overwrites files each run).
export function materializeSamples(appsRoot: string): MaterializedSamples {
  const packages: InstalledPackage[] = [];
  const grants: Record<string, readonly PuterCapability[]> = {};

  for (const spec of SAMPLES) {
    const sourceDir = join(appStoreDir({ appId: spec.pkg.id, appsRoot }), "source");

    for (const [rel, text] of Object.entries(spec.files)) {
      // rel is package-relative ("/main.ts", "/lib/util.ts"); join under the package's source dir.
      const segments = rel.replace(/^[/\\]+/u, "").split("/");
      const abs = join(sourceDir, ...segments);

      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text, "utf8");
    }

    packages.push(Object.freeze({ ...spec.pkg, sourceDir }));
    grants[spec.pkg.id] = spec.initialGrants;
  }

  return Object.freeze({ grants, packages: Object.freeze(packages) });
}
