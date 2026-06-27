// Vita app PACKAGER — in-repo module loader (Phase D, v1).
//
// >>> THIS IS THE OFFLINE-INSTALL / CAPSULE HOOK (v1 placeholder) <<<
//
// The generator never imports a package directly — it asks a PackagerModuleLoader for the already
// installed module namespace. v1 ships THIS loader: a pure, in-memory map from package name -> module
// namespace, populated from the in-repo sample packages (no network, no disk, no capsule). It proves
// the generator end-to-end without faking an install.
//
// The PRODUCTION loader replaces this with: SRI-verify the locked tarball -> offline unpack (no
// lifecycle scripts) -> mount into a sandboxed ts/WASM/OCI capsule -> return the capsule-scoped module
// namespace. The generator is agnostic to which loader it is handed, so swapping this out is the only
// change needed when that deeper layer lands. Capability grants still come from the catalog entry.

import type {
  PackageJsonLike,
  PackagerCatalogEntry,
  PackagerModuleLoader,
  PackagerModuleNamespace,
} from "./types.ts";

// Build an in-memory loader over a name -> module-namespace map. A package name not in the map (e.g. a
// pure-bin cmd package, or a plain web package with no JS module) loads as `undefined`, which the
// generator handles (cmd surface / web fallback). Re-validates the name against the catalog entry so a
// mismatched lookup fails closed rather than returning the wrong module.
export function inMemoryModuleLoader(
  modules: Readonly<Record<string, PackagerModuleNamespace>>,
): PackagerModuleLoader {
  return Object.freeze({
    load(entry: PackagerCatalogEntry, pkg: PackageJsonLike): PackagerModuleNamespace | undefined {
      if (entry.name !== pkg.name) return undefined;

      return modules[entry.name];
    },
  });
}
