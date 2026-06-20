/**
 * Work-item contract — machine shape (spec §18.2).
 * Mirrors SCHEMA.md. Used by tooling in tools/ to parse and validate contracts.
 */

export type RiskClass = "R0" | "R1" | "R2" | "R3" | "R4";

export type ContractStatus =
  | "draft"
  | "ready"
  | "in_progress"
  | "in_review"
  | "done"
  | "failed";

export type HardwareProfile =
  | "x86_64"
  | "arm64"
  | "low-memory"
  | "offline"
  | "no-accelerator"
  | "migration"
  | "n/a";

/** The YAML frontmatter of a contract file. */
export interface ContractMeta {
  id: string; // e.g. "P0-001"
  title: string;
  status: ContractStatus;
  phase: number; // spec §21 phase
  pod: string; // owning pod (ai-factory/roles/)
  risk_class: RiskClass;
  fr: string[]; // related FR ids (spec §15)
  depends_on: string[]; // contract ids
  target_paths: string[]; // the only paths the worker may modify
  acceptance_command: string; // exact command that must pass
  allowed_network: boolean;
  budget_minutes: number;
  artifacts: string[];
}

/** A fully parsed contract: frontmatter + the human prose body. */
export interface Contract extends ContractMeta {
  body: string;
  path: string;
}

/** A contract is dispatchable only when every field is concretely present. */
export function isReady(c: ContractMeta): boolean {
  return (
    c.status === "ready" &&
    c.id.length > 0 &&
    c.title.length > 0 &&
    c.target_paths.length > 0 &&
    c.acceptance_command.trim().length > 0 &&
    c.budget_minutes > 0 &&
    c.artifacts.length > 0
  );
}
