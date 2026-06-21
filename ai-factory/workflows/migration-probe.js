export const meta = {
  name: 'migration-probe',
  description: 'Adversarial manifest≡agent verification of a capability migration (parameterized by args)',
  phases: [
    { title: 'Probe', detail: 'parallel adversarial probes: stricter / looser / conformance-integrity' },
    { title: 'Synthesize', detail: 'confirm + dedupe into a verdict' },
  ],
}

// args = { cap, opName, branch, agentDir, manifestFiles:[...], conformanceFiles:[...], realEntrypoint }
const A = args || {}
const cap = A.cap, branch = A.branch, agentDir = A.agentDir || `agent/capabilities/${cap}`
const manifestFiles = (A.manifestFiles || []).join('\n  ')
const conformanceFiles = (A.conformanceFiles || []).join('\n  ')
const realEntrypoint = A.realEntrypoint || `transport.DecodeJSONRequest[${cap}.ApplyRequest] + Validate()`

const SETUP = `You are verifying the Vita "${cap}" capability MIGRATION on git branch ${branch}.
A language-neutral capability MANIFEST must validate /apply requests IDENTICALLY to the real Go agent validator
("manifest≡agent" — neither stricter NOR looser; any divergence = a preview≠apply bug).

Read the migration artifacts (Bash, from the branch):
  ${manifestFiles ? 'git show ' + branch + ':' + manifestFiles.split('\n  ').join('\n  git show ' + branch + ':') : '(list via: git show ' + branch + ' --stat)'}
  ${conformanceFiles}
Read the AUTHORITATIVE agent validator (ground truth) — list + read every Go file:
  ls ${agentDir}/    then  git show main:${agentDir}/<file>.go  for each
The conformance MUST drive the REAL entrypoint: ${realEntrypoint} (verify it is real, not stubbed —
the transport decoder is at main:agent/transport/server.go). The manifest dialect semantics:
  git show main:sdk/typescript/src/capability-manifest.ts  and  git show main:agent/internal/capmanifest/capmanifest.go
KNOWN PARITY TRAPS to check explicitly: (1) the weak existing noInlineSecrets is LOOSER than the agent's
service-grade scanner — flag any reuse; (2) whole-object uniqueItems where dedup-by-a-sub-field is meant is
LOOSER; (3) Go BYTE length vs UTF-16 .length; (4) Go unicode TrimSpace vs ASCII; (5) runtime/stateful rules
(clock skew, cursor non-regression) must NOT be in the manifest (stricter).
Work strictly from the code, with file:line citations. No speculation.`

const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['findings', 'summary'],
  properties: {
    summary: { type: 'string' },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['title', 'severity', 'evidence', 'concreteInput'],
      properties: {
        title: { type: 'string' }, severity: { type: 'string', enum: ['blocking', 'minor', 'note'] },
        evidence: { type: 'string', description: 'file:line from BOTH the agent validator and the manifest/corpus' },
        concreteInput: { type: 'string', description: 'an exact JSON /apply request demonstrating the divergence, or "n/a"' },
      } } },
  },
}

const PROBES = [
  { key: 'stricter', lens: `find every input the AGENT ACCEPTS but the MANIFEST REJECTS (manifest STRICTER — the #1 bug class: an extra noInlineSecrets/length/charset/uniqueItems/required the agent lacks). For each: the exact accepted-by-agent JSON + the agent line accepting it + the manifest rule rejecting it.` },
  { key: 'looser', lens: `find every input the AGENT REJECTS but the MANIFEST ACCEPTS (manifest LOOSER — missing a rule: a cross-field, a dedup-by-sub-field, a presence/required, a format edge). For each: the exact rejected-by-agent JSON + the agent line rejecting it + why the manifest accepts it.` },
  { key: 'conformance', lens: `judge CONFORMANCE INTEGRITY: (1) ≥15 meaningful vectors? (2) does the Go test drive the REAL ${realEntrypoint} (not a stub/partial decode bypassing transport)? (3) does TS assert the manifest agrees? (4) any WRONG blessed expectation (corpus says accept/reject but the agent does the opposite)? (5) any revealing edge-case vector omitted/weakened so a divergence stays hidden? Cite the test code per point.` },
]

phase('Probe')
const probeResults = await parallel(PROBES.map((p) => () =>
  agent(`${SETUP}\n\nYOUR LENS: ${p.lens}`, { label: `probe:${p.key}`, phase: 'Probe', schema: FINDINGS_SCHEMA })))

phase('Synthesize')
const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdict', 'blockingCount', 'rationale', 'blockingFindings'],
  properties: {
    verdict: { type: 'string', enum: ['approve', 'revise'] },
    blockingCount: { type: 'integer' },
    rationale: { type: 'string' },
    blockingFindings: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['title', 'fix', 'concreteInput'],
      properties: { title: { type: 'string' }, fix: { type: 'string' }, concreteInput: { type: 'string' } } } },
  },
}
const verdict = await agent(
  `${SETUP}\n\nThree adversarial probes reported on the ${cap} migration. Independently CONFIRM each BLOCKING finding against the code (a probe may be wrong — verify before accepting), discard the unconfirmed, dedupe. "revise" only if ≥1 BLOCKING manifest≢agent or conformance-integrity finding is CONFIRMED.\n\nPROBE RESULTS:\n${JSON.stringify(probeResults, null, 2)}`,
  { label: 'synthesize', phase: 'Synthesize', schema: VERDICT_SCHEMA, effort: 'high' })
return verdict
