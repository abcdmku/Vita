// SAMPLES barrel — the two in-repo allowed packages wired into a ready catalog + loader, proving the
// packager end-to-end with no network. `add <pkg>` in the real OS resolves the catalog + an
// offline-install loader; here the catalog is these two entries and the loader is in-memory.

import {
  createPackagerCatalog,
} from "../catalog.ts";
import {
  inMemoryModuleLoader,
} from "../loader.ts";
import type {
  PackagerCatalog,
  PackagerModuleLoader,
} from "../types.ts";
import {
  clockCatalogEntry,
  clockModuleNamespace,
  clockPackageJson,
  CLOCK_PACKAGE_NAME,
} from "./clock-package.ts";
import {
  echoCatalogEntry,
  echoPackageJson,
  ECHO_PACKAGE_NAME,
} from "./echo-package.ts";

export {
  CLOCK_PACKAGE_NAME,
  clockCatalogEntry,
  clockModuleNamespace,
  clockPackageJson,
  mount as clockMount,
} from "./clock-package.ts";
export {
  ECHO_PACKAGE_NAME,
  echoCatalogEntry,
  echoPackageJson,
} from "./echo-package.ts";

// The sample catalog: both allowed packages.
export function sampleCatalog(): PackagerCatalog {
  return createPackagerCatalog([clockCatalogEntry, echoCatalogEntry]);
}

// The sample offline-install loader: only the clock ships a loadable JS module (the echo bin has none).
export function sampleModuleLoader(): PackagerModuleLoader {
  return inMemoryModuleLoader({
    [CLOCK_PACKAGE_NAME]: clockModuleNamespace,
  });
}

// The package.json the loader/generator reads for each sample (keyed by name) — what an offline install
// would have unpacked.
export const SAMPLE_PACKAGE_JSON = Object.freeze({
  [CLOCK_PACKAGE_NAME]: clockPackageJson,
  [ECHO_PACKAGE_NAME]: echoPackageJson,
});
