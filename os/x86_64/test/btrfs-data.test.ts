import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const buildAndBootPath = fileURLToPath(new URL("../build-and-boot.mjs", import.meta.url));
const varMountUrl = new URL("../verity-overlay/usr/lib/systemd/system/var.mount", import.meta.url);
const btrfsMarkerUrl = new URL(
  "../verity-overlay/usr/lib/vita/luks/vita-btrfs-marker.sh",
  import.meta.url,
);

test("ext4 fallback synthesizes when VITA_BTRFS unset", async () => {
  const result = runBuildAndBootDryRun({
    VITA_VERITY: "1",
    VITA_LUKS: "1",
    VITA_BTRFS: undefined,
  });
  const output = combinedOutput(result);

  assert.equal(result.status, 0, output);
  assert.match(output, /\/var data filesystem: ext4; unit Type=ext4 Options=nofail,x-systemd\.device-timeout=5s,x-systemd\.growfs/u);
  assert.match(output, /\$ mkfs\.ext4 -F -L vita-data \/dev\/mapper\/<build mapper>/u);
  assert.doesNotMatch(output, /mkfs\.btrfs/u);
  assert.doesNotMatch(output, /--package=btrfs-progs/u);

  const committedVarMount = await readFile(varMountUrl, "utf8");
  assert.match(committedVarMount, /^What=\/dev\/mapper\/vita-data$/mu);
  assert.match(committedVarMount, /^Type=ext4$/mu);
  assert.match(committedVarMount, /^Options=nofail,x-systemd\.device-timeout=5s,x-systemd\.growfs$/mu);
});

test("VITA_BTRFS selects mkfs.btrfs and a btrfs mapper-backed /var unit", async () => {
  const result = runBuildAndBootDryRun({
    VITA_VERITY: "1",
    VITA_LUKS: "1",
    VITA_BTRFS: "1",
  });
  const output = combinedOutput(result);

  assert.equal(result.status, 0, output);
  assert.match(output, /--package=btrfs-progs/u);
  assert.match(output, /\/var data filesystem: btrfs; unit Type=btrfs Options=nofail,x-systemd\.device-timeout=5s/u);
  assert.doesNotMatch(output, /Type=btrfs Options=[^\n]*x-systemd\.growfs/u);
  assert.match(output, /\$ mkfs\.btrfs -f -L vita-data \/dev\/mapper\/<build mapper>/u);

  const markerScript = await readFile(btrfsMarkerUrl, "utf8");
  assert.match(markerScript, /^fstype="\$\(findmnt -n -o FSTYPE --target \/var\)"/mu);
  assert.match(markerScript, /^echo "VITA-BTRFS: fstype=btrfs onMapper=OK status=OK"$/mu);
  assert.match(markerScript, /^if \[ "\$source_real" != "\$mapper_real" \]; then$/mu);
});

test("VITA_BTRFS without VITA_LUKS fails closed", () => {
  const result = runBuildAndBootDryRun({
    VITA_VERITY: "1",
    VITA_LUKS: undefined,
    VITA_BTRFS: "1",
  });
  const output = combinedOutput(result);

  assert.notEqual(result.status, 0, output);
  assert.match(output, /VITA_BTRFS=1 requires VITA_LUKS=1/u);
  assert.doesNotMatch(output, /mkfs\.btrfs/u);
});

type EnvOverrides = Readonly<Record<string, string | undefined>>;

function runBuildAndBootDryRun(overrides: EnvOverrides): SpawnSyncReturns<string> {
  const result = spawnSync(
    process.execPath,
    [
      buildAndBootPath,
      "--dry-run",
      "--mode=smoke",
      "--mkosi=native",
      "--no-boot",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: envWith({
        VITA_BTRFS: undefined,
        VITA_BOOT_DEBUG: undefined,
        VITA_CEF: undefined,
        VITA_INCREMENTAL: "0",
        VITA_INPUT_SELFTEST: undefined,
        VITA_LUKS: undefined,
        VITA_SB_NONCE: undefined,
        VITA_SECURE_BOOT: undefined,
        VITA_VERITY: undefined,
        VITA_VERIFY: undefined,
        ...overrides,
      }),
    },
  );
  if (result.error !== undefined) {
    assert.fail(result.error.message);
  }
  return result;
}

function envWith(overrides: EnvOverrides): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[name];
    } else {
      env[name] = value;
    }
  }
  return env;
}

function combinedOutput(result: SpawnSyncReturns<string>): string {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}
