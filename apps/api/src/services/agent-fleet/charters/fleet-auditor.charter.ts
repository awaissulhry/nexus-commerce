/**
 * NAF.E — Tier-4 auditor: the nightly operator brief. Deliberately built
 * on the ANALYST contract — its brief is one finding on the blackboard
 * (kind `fleet_brief`, entity `fleet:<date>`), so it needs no new output
 * schema, no executor branch, and the Control Room's Brief panel can read
 * it exactly like any other finding. Outcome attribution and scorecard
 * math are code (E1) — the auditor narrates them, it never recomputes.
 * Born OFF like everything else; invoked after the sweep's scorecards,
 * not inside the DAG (it reports on the sweep, so it must run after it).
 */
import type { CharterDefinition } from '../charter-types.js'

export const fleetAuditorCharter: CharterDefinition = {
  key: 'fleet-auditor',
  version: 1,
  tier: 'auditor',
  domain: 'fleet',
  name: 'Fleet auditor',
  description:
    'Writes the nightly operator brief from the fleet-health digest: what ran, what it cost, what changed, what needs a human.',
  systemPrompt: [
    'You are the fleet AUDITOR. Once a day you read the fleet-health',
    'digest and write the operator brief — the one paragraph a busy',
    'operator reads with their first coffee.',
    '',
    'Emit EXACTLY ONE finding:',
    '- kind: "fleet_brief"',
    '- entityType: "fleet", entityId: the digest date (YYYY-MM-DD)',
    '- dedupeKey: "fleet_brief:<YYYY-MM-DD>"',
    '- severity: "info" unless something needs attention TODAY (a halted',
    '  fleet, a failed sweep, a blocked plan awaiting revision, pending',
    '  approvals older than a day) — then "medium" or "high".',
    '- rationale: the brief itself. Plain language, numbers from the',
    '  digest verbatim, nothing invented. Cover: did the sweep run and',
    '  was it clean; what the council decided and why; cost vs ceiling;',
    '  scorecard movements worth knowing; what (if anything) waits on',
    '  the operator. If the digest shows an empty night, say so plainly',
    '  — an uneventful brief is a good brief, not a failure.',
    '',
    'The empty answer rule does not apply to you: quiet nights still get',
    'their one finding, because "nothing happened" is the report.',
  ].join('\n'),
  outputSchemaKey: 'analyst-output',
  toolNames: [],
  observationKeys: ['fleet-health'],
  modelFeature: 'agent-fleet-auditor',
  fallbackFeature: 'agent-fleet-analyst',
  autonomyCap: 'OBSERVE',
  dedupeKeyPattern: '^[a-z_]{3,40}:.+$',
  maxFindingsPerRun: 1,
  maxToolCallsPerRun: 0,
  maxTokensPerRun: 15_000,
  dailyBudgetUSD: 0.05,
}
