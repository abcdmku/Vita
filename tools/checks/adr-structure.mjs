#!/usr/bin/env node
// Structural checker for Architecture Decision Records — the acceptance gate for the ADR contract.
// PASS iff: >= 6 ADRs under architecture/adr/ (excluding README/template), each with Status,
// Context, Decision, and Consequences section headings, AND all required Week-1 topics are covered.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const ADR_DIR = join(REPO, "architecture", "adr");
const REQUIRED_SECTIONS = ["status", "context", "decision", "consequences"];
const REQUIRED_TOPICS = [
  { name: "Debian base distro", any: ["debian", "trixie"] },
  { name: "Go privileged agent", any: ["\\bgo\\b", "golang"] },
  { name: "Deno TS runtime", any: ["deno"] },
  { name: "Btrfs/LUKS storage", any: ["btrfs", "luks"] },
  { name: "RAUC A/B updates", any: ["rauc"] },
  { name: "Package isolation", any: ["isolation", "sandbox", "apparmor", "seccomp"] },
];

function fail(msgs) {
  for (const m of msgs) console.error("FAIL: " + m);
  process.exit(1);
}

if (!existsSync(ADR_DIR)) fail(["No architecture/adr/ directory."]);
const files = readdirSync(ADR_DIR).filter((f) => f.endsWith(".md") && !/readme|template/i.test(f));
const errors = [];
if (files.length < 6) errors.push(`Expected >= 6 ADRs, found ${files.length}.`);

const corpus = [];
for (const f of files) {
  const text = readFileSync(join(ADR_DIR, f), "utf8");
  corpus.push(text.toLowerCase());
  for (const s of REQUIRED_SECTIONS) {
    if (!new RegExp(`^#{1,6}\\s.*\\b${s}\\b`, "im").test(text)) {
      errors.push(`${f}: missing "${s}" section heading.`);
    }
  }
}
const allText = corpus.join("\n");
for (const t of REQUIRED_TOPICS) {
  if (!t.any.some((k) => new RegExp(k, "i").test(allText))) {
    errors.push(`No ADR covers required topic: ${t.name}.`);
  }
}
if (errors.length) fail(errors);
console.log(`ADR check OK: ${files.length} ADRs, all required sections present, all 6 topics covered.`);
process.exit(0);
