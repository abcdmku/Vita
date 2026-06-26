import { sign as signEd25519 } from "node:crypto";

import { canonicalizeCatalogBytes } from "../../src/catalog-canonical.ts";
import type {
  CatalogPayload,
  SignedCatalogManifest,
  TrustedCatalogKeys,
} from "../../src/catalog-manifest.ts";

export const TEST_CATALOG_KEY_ID = "vita-catalog-test-ed25519";

export const TEST_CATALOG_PUBLIC_KEY_PEM = [
  "-----BEGIN PUBLIC KEY-----",
  "MCowBQYDK2VwAyEAiJdoWWD0+W52BosRhgcBSATW3ZK3K62ERjF5cNrK+rs=",
  "-----END PUBLIC KEY-----",
  "",
].join("\n");

// TEST ONLY - NOT A RELEASE KEY (§16: real key owner-held).
const TEST_CATALOG_PRIVATE_KEY_PEM = [
  "-----BEGIN PRIVATE KEY-----",
  "MC4CAQAwBQYDK2VwBCIEIGJItzG8E/HeQoiDoMMyKZtN61sBKpUtHkisofUPsTER",
  "-----END PRIVATE KEY-----",
  "",
].join("\n");

export const TEST_CATALOG_TRUSTED_KEYS: TrustedCatalogKeys = Object.freeze({
  [TEST_CATALOG_KEY_ID]: TEST_CATALOG_PUBLIC_KEY_PEM,
});

export function signCatalog(
  catalog: CatalogPayload,
  keyId = TEST_CATALOG_KEY_ID,
): SignedCatalogManifest {
  const signature = signCatalogBytes(canonicalizeCatalogBytes(catalog));

  return {
    catalog,
    signature: {
      algorithm: "ed25519",
      keyId,
      value: Buffer.from(signature).toString("base64"),
    },
  };
}

export function signCatalogBytes(bytes: Uint8Array): Uint8Array {
  return signEd25519(null, bytes, TEST_CATALOG_PRIVATE_KEY_PEM);
}
