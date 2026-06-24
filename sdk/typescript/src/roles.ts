// Household roles (spec §11) — the single TypeScript source of truth for the
// CLOSED six-role set, mirroring agent/identity/roles/roles.go. The set is exactly
// these six values, no more, no fewer:
//
//   owner, administrator, member, restricted-member, guest, service
//
// `member` is the spec §11 name for the role P1-073 shipped as "household-member".
// There is NO role hierarchy: a role's access is always exactly what each grant
// lists for it (see files-grant.ts). The runtime never asserts its own role — the
// privileged Go agent binds principal -> role from the authenticated peer
// identity; this union only types the role VOCABULARY used in agentd's grant
// config and any tooling that mirrors it.

/**
 * One of the six closed spec §11 household roles. This is the canonical TS role
 * union; `FilesRole` (files-grant.ts) re-exports it without redefining the
 * literals, so the two never drift.
 */
export type Role =
  | "owner"
  | "administrator"
  | "member"
  | "restricted-member"
  | "guest"
  | "service";

/**
 * The six roles in the same deterministic order as Go's `roles.AllRoles()`
 * (owner first, service last). A `readonly` tuple so callers cannot mutate the
 * canonical set.
 */
export const ALL_ROLES = Object.freeze([
  "owner",
  "administrator",
  "member",
  "restricted-member",
  "guest",
  "service",
] as const) satisfies readonly Role[];

/**
 * The least-privileged role: a principal with no configured binding is a guest
 * (a stranger, no household access) — never owner, never a household role by
 * absence. Mirrors Go's `roles.DefaultRole`.
 */
export const DEFAULT_ROLE: Role = "guest";

/**
 * Closed-set membership test. Returns true only for one of the six roles —
 * "household-member", "", case variants, and any 7th value are rejected (no
 * aliasing, no case-folding).
 */
export function isRole(value: string): value is Role {
  for (const role of ALL_ROLES) {
    if (role === value) {
      return true;
    }
  }
  return false;
}
