import assert from "node:assert/strict";
import { test } from "node:test";

import { validatePackageContract } from "../src/package-contract.ts";
import type { PackageClass, PackageContract } from "../src/package-contract.ts";
import {
  dataAppTemplate,
  staticSiteTemplate,
  tsServiceTemplate,
} from "../templates/index.ts";

const templates = [
  {
    name: "ts-service",
    contract: tsServiceTemplate,
    packageClass: "ts-service",
  },
  {
    name: "static-site",
    contract: staticSiteTemplate,
    packageClass: "ui-extension",
  },
  {
    name: "data-app",
    contract: dataAppTemplate,
    packageClass: "ts-service",
  },
] as const satisfies readonly {
  readonly name: string;
  readonly contract: PackageContract;
  readonly packageClass: PackageClass;
}[];

const inlineSecretFields = [
  "value",
  "plaintext",
  "secret",
  "token",
  "password",
  "privateKey",
  "data",
] as const;

function assertValidPackageContract(name: string, contract: PackageContract): void {
  const result = validatePackageContract(contract);

  if (!result.ok) {
    assert.fail(
      `${name} template failed validation:\n${result.errors
        .map((error) => `${error.path}: ${error.message}`)
        .join("\n")}`,
    );
  }

  assert.equal(result.ok, true);
}

test("starter templates validate and use the expected package classes", () => {
  for (const template of templates) {
    assertValidPackageContract(template.name, template.contract);
    assert.equal(template.contract.packageClass, template.packageClass);
  }

  const ids = templates.map((template) => template.contract.identity.id);

  assert.equal(new Set(ids).size, templates.length);
});

test("starter templates encode the expected data volume shapes", () => {
  const servedAssetsVolume = staticSiteTemplate.data.volumes.find(
    (volume) => volume.name === "served-assets",
  );

  assert.ok(servedAssetsVolume);
  assert.equal(servedAssetsVolume.access, "read-only");
  assert.equal(servedAssetsVolume.class, "cache");
  assert.equal(servedAssetsVolume.persistence, "ephemeral");

  assert.equal(
    dataAppTemplate.data.volumes.some(
      (volume) => volume.persistence === "persistent" && volume.backup,
    ),
    true,
  );
});

test("starter templates keep secret requirements referenced only", () => {
  for (const template of templates) {
    assertValidPackageContract(template.name, template.contract);

    for (const secret of template.contract.secrets) {
      for (const field of inlineSecretFields) {
        assert.equal(
          Object.prototype.hasOwnProperty.call(secret, field),
          false,
          `${template.name} secret ${secret.name} must not embed ${field}`,
        );
      }
    }
  }
});
