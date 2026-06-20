#!/usr/bin/env node
// One orchestration tick's situational read: what's ready, what's blocked, can workers run.
// `--list` just prints; without it, also suggests the next dispatch.
import { readyContracts, listContracts, QUEUE, DONE, FAILED } from "../lib/contracts.mjs";
import { workerAuth } from "../dispatch/check-auth.mjs";

const listOnly = process.argv.includes("--list");
const queue = listContracts(QUEUE);
const ready = readyContracts();
const done = listContracts(DONE);
const failed = listContracts(FAILED);
const auth = workerAuth();

console.log(`Worker auth : ${auth.ok ? "OK (" + auth.via + ")" : "MISSING — set OPENAI_API_KEY or run `codex login`"}`);
console.log(`Contracts   : ${queue.length} in queue, ${ready.length} ready, ${done.length} done, ${failed.length} failed\n`);

const byStatus = {};
for (const c of queue) byStatus[c.status] = (byStatus[c.status] || 0) + 1;
if (Object.keys(byStatus).length) {
  console.log("Queue by status: " + Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join("  "));
}

if (ready.length === 0) {
  console.log("\nNothing ready & unblocked. Orchestrator: author or unblock contracts for the active phase (see ai-factory/STATE.md).");
  process.exit(0);
}

console.log("\nReady (priority order):");
for (const c of ready) {
  console.log(`  ${c.id}  [${c.risk_class}]  ${c.title}   (pod: ${c.pod})`);
}
if (!listOnly) {
  console.log(`\nNext: npm run dispatch -- ${ready[0].id}`);
}
