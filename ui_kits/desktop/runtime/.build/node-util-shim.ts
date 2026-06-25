// Browser/CEF-surface shim for the Node-only `node:util` `types` namespace.
//
// The `@vita/desktop-sdk` loader, `safe-normalize`, and `shell` modules call
// `types.isProxy(value)` (a Node-only reflection API with no browser equivalent —
// a Proxy is intentionally undetectable from script in the browser). The in-surface
// runtime runs inside the CEF-rendered DOM / a plain browser where `node:util` does
// not resolve, so this shim is substituted at bundle time via the build import map.
//
// Degrade safely: report `isProxy() === false`. The SDK uses `isProxy` only to
// reject hostile Proxy inputs as an extra hardening layer; the surface already
// trusts the single enforcement point (the host proxy in the control-plane context,
// ADR 0013 §4), so failing this check open in-surface does not widen the trust
// boundary — capability gating still happens host-side across the bridge.
//
// This file is OFFLINE and dependency-free (Vita rule: no remote imports).

export interface NodeUtilTypesShim {
  isProxy(value: unknown): boolean;
}

export const types: NodeUtilTypesShim = Object.freeze({
  isProxy(_value: unknown): boolean {
    return false;
  },
});

export default Object.freeze({ types });
