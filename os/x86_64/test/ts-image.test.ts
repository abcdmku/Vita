import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

type CrunStagePin = {
  readonly Version: string;
  readonly Asset: string;
  readonly Url: string;
  readonly Sha256: string;
  readonly binary: string;
  readonly binaryMode: string;
  readonly binaryHostPath: string;
};

type TSImageModule = {
  readonly stageCrun: (pin: CrunStagePin) => Promise<void>;
};

const tsImageModuleUrl = new URL("../ts-image.mjs", import.meta.url);

test("stageCrun fails closed when the local crun artifact hash does not match", async () => {
  const tsImage = await loadTSImageModule();
  const dir = await mkdtemp(join(tmpdir(), "vita-ts-image-test-"));
  const wrongArtifact = join(dir, "crun-wrong");
  const stagedBinary = join(dir, "overlay", "usr", "lib", "vita", "bin", "crun");
  await writeFile(wrongArtifact, "not the pinned crun artifact\n", "utf8");

  const previousCrunBin = process.env["VITA_CRUN_BIN"];
  process.env["VITA_CRUN_BIN"] = wrongArtifact;
  try {
    await assert.rejects(
      () =>
        tsImage.stageCrun({
          Version: "1.21",
          Asset: "crun-1.21-linux-amd64",
          Url: "https://github.com/containers/crun/releases/download/1.21/crun-1.21-linux-amd64",
          Sha256: "322c6c94b33a749ccd9f6f5ad48b0dd976eef559bbcfe15afd507a289dcdbe91",
          binary: "/usr/lib/vita/bin/crun",
          binaryMode: "0755",
          binaryHostPath: stagedBinary,
        }),
      /sha256 MISMATCH/u,
    );

    assert.equal(await fileExists(stagedBinary), false, "wrong-hash crun must not be staged");
  } finally {
    if (previousCrunBin === undefined) {
      delete process.env["VITA_CRUN_BIN"];
    } else {
      process.env["VITA_CRUN_BIN"] = previousCrunBin;
    }
  }
});

async function loadTSImageModule(): Promise<TSImageModule> {
  const moduleValue: unknown = await import(tsImageModuleUrl.href);
  const record = asRecord(moduleValue, "ts-image module");
  const stageCrun = record["stageCrun"];
  assert.equal(typeof stageCrun, "function");
  return {
    stageCrun: (pin: CrunStagePin) => (stageCrun as (pin: CrunStagePin) => Promise<void>)(pin),
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if (hasErrorCode(cause, "ENOENT")) {
      return false;
    }
    throw cause;
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  assert.equal(typeof value, "object", `${label} must be an object`);
  assert.notEqual(value, null, `${label} must not be null`);
  return value as Record<string, unknown>;
}

function hasErrorCode(cause: unknown, code: string): boolean {
  if (typeof cause !== "object" || cause === null || !Object.hasOwn(cause, "code")) {
    return false;
  }
  return (cause as { readonly code?: unknown }).code === code;
}
