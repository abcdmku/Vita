// Vita VITA_VERITY app-persistence wiring — config + dry-run verification (no VM boot).
//
// CONTEXT: the headless boot proved persistence on the rw-ROOT path (a plain, non-verity smoke image
// where var.mount is nofail-skipped and /var/lib/vita/apps falls back to /var on the writable root). A
// production VITA_VERITY build must instead put the api_origin store (/var/lib/vita/apps), the owner
// token (/var/lib/vita/owner), and the TLS material (/var/lib/vita/tls) on the DEDICATED, writable
// vita-data partition — separate from the verity-protected read-only root. The read-only verity root and
// the writable data partition coexist via the existing var.mount / data-partition mechanism.
//
// This suite asserts the WIRING that makes that true, statically (the byte-deterministic image-layout
// planner) and against the committed overlays + units, WITHOUT booting a VM:
//   1. all three persistence paths live UNDER /var (the data-partition mount point), so a single
//      var.mount moves the whole tree onto vita-data;
//   2. the image-layout planner places vita-data at MountPoint=/var via var.mount → /dev/mapper/vita-data;
//   3. tmpfiles creates all three subtrees under /var/lib/vita;
//   4. the platform, owner-token, and selftest units bind var.mount (RequiresMountsFor) so the data
//      partition is mounted before any of those paths is opened on a verity build;
//   5. the verity overlay ships var.mount (so VITA_VERITY mounts vita-data at /var) while the smoke
//      profile does NOT ship it from the same overlay (the rw-root fallback is preserved);
//   6. the build derives the verity partition layout + ships the verity overlay + a read-only root with
//      NO systemd.volatile=overlay (which would shadow the persistent /var) on a VITA_VERITY dry-run, and
//      ships NEITHER on a plain smoke dry-run.
//
// The actual reboot-survival proof is the VITA_VERITY boot (owner boot-verifies separately); this suite
// is the static gate that the wiring is correct before that boot.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BUILD_AND_BOOT = fileURLToPath(new URL("../build-and-boot.mjs", import.meta.url));

// The three persistence paths the platform server owns on the data partition (api_origin store, owner
// token, TLS material). All MUST be under /var so a single var.mount relocates them to vita-data.
const DATA_MOUNT_POINT = "/var";
const PERSISTENCE_PATHS = Object.freeze({
  apps: "/var/lib/vita/apps", // APPS_ROOT — the fs+kv api_origin store
  owner: "/var/lib/vita/owner", // the minted network-face owner bearer token
  tls: "/var/lib/vita/tls", // owner-provided (or self-signed) network-face TLS material
});

const platformUnitUrl = new URL(
  "../mode-overlay/usr/lib/systemd/system/vita-platform.service",
  import.meta.url,
);
const ownerTokenUnitUrl = new URL(
  "../mode-overlay/usr/lib/systemd/system/vita-owner-token.service",
  import.meta.url,
);
const selftestUnitUrl = new URL(
  "../mode-overlay/usr/lib/systemd/system/vita-platform-selftest.service",
  import.meta.url,
);
const appsTmpfilesUrl = new URL("../mode-overlay/usr/lib/tmpfiles.d/vita-apps.conf", import.meta.url);
const verityVarMountUrl = new URL(
  "../verity-overlay/usr/lib/systemd/system/var.mount",
  import.meta.url,
);
const verityDropInUrl = new URL(
  "../verity-overlay/usr/lib/systemd/system/local-fs.target.d/10-vita-var.conf",
  import.meta.url,
);
const imageLayoutModuleUrl = new URL("../image-layout.mjs", import.meta.url);

test("all three platform persistence paths live under /var (the data-partition mount point)", () => {
  for (const [name, path] of Object.entries(PERSISTENCE_PATHS)) {
    assert.ok(
      path.startsWith(`${DATA_MOUNT_POINT}/`),
      `${name} persistence path ${path} must be under ${DATA_MOUNT_POINT} so var.mount relocates it to vita-data`,
    );
  }
});

test("image-layout planner places vita-data at /var via var.mount → /dev/mapper/vita-data", async () => {
  const moduleValue: unknown = await import(imageLayoutModuleUrl.href);
  const planImageLayout = (moduleValue as { planImageLayout: (input?: unknown) => unknown }).planImageLayout;
  assert.equal(typeof planImageLayout, "function");
  const plan = planImageLayout() as {
    partitions: readonly { id: string; mountPoint: string | null; filesystem: string; growable: boolean }[];
    systemd: { mounts: readonly { unit: string; what: string; where: string; type: string }[] };
  };

  const data = plan.partitions.find((partition) => partition.id === "data");
  assert.ok(data !== undefined, "data partition must be declared");
  assert.equal(data.mountPoint, DATA_MOUNT_POINT);
  assert.equal(data.filesystem, "ext4");
  assert.equal(data.growable, true);

  const varMount = plan.systemd.mounts.find((mount) => mount.unit === "var.mount");
  assert.ok(varMount !== undefined, "var.mount must be planned for the data partition");
  assert.equal(varMount.where, DATA_MOUNT_POINT);
  assert.equal(varMount.what, "/dev/mapper/vita-data");
  assert.equal(varMount.type, "ext4");
});

test("tmpfiles creates apps, owner, and tls under /var/lib/vita on the data partition", async () => {
  const text = await readFile(appsTmpfilesUrl, "utf8");
  // The parent must be created first, then each persistence subtree. group vita-agent lets the platform
  // DynamicUser write via the group while the tree is not world-writable.
  assert.match(text, /^d \/var\/lib\/vita 0750 root vita-agent -$/mu);
  assert.match(text, /^d \/var\/lib\/vita\/apps 0770 root vita-agent -$/mu);
  assert.match(text, /^d \/var\/lib\/vita\/owner 0750 root vita-agent -$/mu);
  assert.match(text, /^d \/var\/lib\/vita\/tls 0750 root vita-agent -$/mu);
});

test("platform unit binds var.mount for ALL THREE persistence subtrees and reads them from /var", async () => {
  const text = await readFile(platformUnitUrl, "utf8");
  const requiresMountsFor = matchDirective(text, "RequiresMountsFor");
  assert.ok(requiresMountsFor !== null, "vita-platform.service must declare RequiresMountsFor");
  const boundPaths = new Set(requiresMountsFor.split(/\s+/u).filter((token) => token.length > 0));
  for (const [name, path] of Object.entries(PERSISTENCE_PATHS)) {
    assert.ok(
      boundPaths.has(path),
      `vita-platform.service RequiresMountsFor must bind the ${name} path ${path} so the data partition mounts before it is opened`,
    );
  }

  // The env + sandbox grants reference exactly the /var persistence paths (so under verity they resolve on
  // the data partition; under smoke they resolve on the rw root — same path text either way).
  assert.match(text, /^Environment=APPS_ROOT=\/var\/lib\/vita\/apps$/mu);
  assert.match(text, /^Environment=VITA_APPS_ROOT=\/var\/lib\/vita\/apps$/mu);
  assert.match(text, /^Environment=VITA_OWNER_TOKEN_FILE=\/var\/lib\/vita\/owner\/owner\.token$/mu);
  assert.match(text, /^Environment=VITA_TLS_CERT=\/var\/lib\/vita\/tls\/net\.crt$/mu);
  assert.match(text, /^Environment=VITA_TLS_KEY=\/var\/lib\/vita\/tls\/net\.key$/mu);
  // The Deno sandbox must be able to read all three and write the apps store on the data partition.
  assert.match(text, /--allow-read=[^\n]*\/var\/lib\/vita\/apps/u);
  assert.match(text, /--allow-read=[^\n]*\/var\/lib\/vita\/tls/u);
  assert.match(text, /--allow-read=[^\n]*\/var\/lib\/vita\/owner/u);
  assert.match(text, /--allow-write=[^\n]*\/var\/lib\/vita\/apps/u);
  assert.match(text, /^ReadWritePaths=\/var\/lib\/vita\/apps$/mu);
});

test("owner-token + selftest units bind var.mount so they touch the data partition after it mounts", async () => {
  const ownerText = await readFile(ownerTokenUnitUrl, "utf8");
  // The owner-token oneshot writes /var/lib/vita/owner; it must wait for the data partition.
  assert.equal(matchDirective(ownerText, "RequiresMountsFor"), "/var/lib/vita");
  assert.match(ownerText, /^Before=vita-platform\.service$/mu);
  assert.match(ownerText, /^ReadWritePaths=\/var\/lib\/vita$/mu);

  const selftestText = await readFile(selftestUnitUrl, "utf8");
  // The selftest writes the bootmark directly under /var/lib/vita/apps, so it must bind the mount too.
  assert.equal(matchDirective(selftestText, "RequiresMountsFor"), "/var/lib/vita/apps");
  assert.match(selftestText, /^ReadWritePaths=\/var\/lib\/vita\/apps$/mu);
});

test("verity overlay ships var.mount targeting vita-data at /var, with no volatile overlay", async () => {
  const unitText = await readFile(verityVarMountUrl, "utf8");
  assert.match(unitText, /^What=\/dev\/mapper\/vita-data$/mu);
  assert.match(unitText, /^Where=\/var$/mu);
  assert.match(unitText, /^Type=ext4$/mu);
  // The mount must never fall open to a raw by-label device (a wrong/no key must fail closed).
  assert.doesNotMatch(unitText, /^What=\/dev\/disk\/by-label\/vita-data$/mu);
  // A volatile overlay on / would tmpfs-shadow the persistent /var — it must NOT be present.
  assert.doesNotMatch(unitText, /systemd\.volatile/u);

  // The drop-in pulls var.mount into local-fs with Wants (not Requires) so a nofail-skipped mount on a
  // non-verity image does not fail local-fs.target.
  const dropInText = await readFile(verityDropInUrl, "utf8");
  assert.match(dropInText, /^Wants=var\.mount$/mu);
});

test("VITA_VERITY=1 smoke dry-run derives the data-partition layout + ships the verity overlay (ro root, no volatile)", () => {
  const out = dryRun({ VITA_VERITY: "1", VITA_MKOSI: "native" });
  // The verity build derives the dm-verity hash root + the repart directory that defines vita-data.
  assert.match(out, /--verity=hash/u, "VITA_VERITY=1 must build a dm-verity hash root");
  assert.match(out, /--repart-directory=[^\n]*repart-verity-plain/u, "must point repart at the vita-data layout");
  // It must ship the verity overlay (var.mount + the local-fs drop-in) so /var is the data partition.
  assert.match(out, /--extra-tree=[^\n]*verity-overlay-plain/u, "must ship the verity overlay (var.mount)");
  // The root is mounted read-only and there is NO systemd.volatile=overlay (that would shadow /var).
  assert.match(out, /--kernel-command-line [^\n]*\bro\b/u, "verity root must be read-only");
  assert.doesNotMatch(out, /systemd\.volatile=overlay/u, "verity build must not volatile-overlay / (shadows /var)");
  // The mode overlay (platform + owner-token + tmpfiles) is shipped in every build, verity included.
  assert.match(out, /--extra-tree=[^\n]*mode-overlay/u, "mode overlay (platform persistence) must ship in verity builds");
});

test("plain smoke dry-run keeps the rw-root fallback: NO verity overlay, NO data-partition repart", () => {
  const out = dryRun({ VITA_MKOSI: "native" }); // VITA_VERITY unset → plain smoke
  assert.doesNotMatch(out, /--verity=hash/u, "plain smoke must not build a verity root");
  assert.doesNotMatch(out, /--repart-directory=/u, "plain smoke must not define the vita-data partition");
  assert.doesNotMatch(out, /verity-overlay/u, "plain smoke must NOT ship var.mount (rw-root fallback)");
  // The persistence paths still exist (mode overlay ships everywhere) — they just live on the rw root,
  // which is the documented non-verity fallback (var.mount nofail-skipped, ConditionPathExists unmet).
  assert.match(out, /--extra-tree=[^\n]*mode-overlay/u, "mode overlay still ships (paths fall back to rw root)");
  assert.match(out, /--kernel-command-line [^\n]*\brw\b/u, "plain smoke root is writable");
});

function dryRun(extraEnv: Record<string, string>): string {
  return execFileSync(process.execPath, [BUILD_AND_BOOT, "--mode=smoke", "--dry-run"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    // The dry-run prints the full derived pipeline and runs nothing.
  });
}

function matchDirective(unitText: string, key: string): string | null {
  const match = new RegExp(`^${key}=(.*)$`, "mu").exec(unitText);
  return match === null ? null : (match[1] ?? "").trim();
}
