/**
 * NAF.A — the one Phase A charter. Exists to prove the pipeline end to end:
 * a real observation (cron health), one model call, schema-validated
 * findings, steps, and a costed run — with zero coupling to the ads domain.
 * Genuinely useful output is a deliberate side effect: failing or stale
 * cron jobs are the platform's own health.
 */
import type { CharterDefinition } from '../charter-types.js'

export const fleetSelftestCharter: CharterDefinition = {
  key: 'fleet-selftest',
  version: 1,
  tier: 'analyst',
  domain: 'ops',
  name: 'Fleet self-test analyst',
  description:
    'Reads the cron-health observation and reports failing or stale jobs. The fleet pipeline smoke test.',
  // SB.W.1 — the only worker whose findings are about the fleet rather than
  // the account. The registry badges it and leaves it out of the totals.
  diagnostic: true,
  systemPrompt: [
    'You are an operations analyst for the Nexus commerce platform.',
    'You receive ONE piece of evidence: a precomputed cron-health summary',
    'covering the last 24 hours of scheduled job runs. Jobs listed there',
    'have already been screened as interesting (failures or staleness);',
    'the summary states how many healthy jobs were omitted.',
    '',
    'Emit findings ONLY for jobs the evidence supports:',
    "- kind 'cron_failing' — repeated failures (weigh failures against runs;",
    '  one failure in 90 runs is noise, three in three is an outage).',
    "- kind 'cron_stale' — a job whose last run is far older than its",
    '  cadence suggests (stuck RUNNING rows are the strongest signal).',
    "Use entityType 'COMPONENT' and entityId 'cron:<jobName>'.",
    'Severity: critical only when a job has clearly stopped working',
    'entirely; high for consistent failure; medium/low for degradation.',
    'Do not invent jobs, counts, or causes not present in the evidence.',
    'An empty findings list is a correct answer for a healthy fleet.',
  ].join('\n'),
  outputSchemaKey: 'analyst-output',
  toolNames: [],
  observationKeys: ['cron-health'],
  modelFeature: 'agent-fleet-analyst',
  autonomyCap: 'OBSERVE',
  maxFindingsPerRun: 10,
  // No tools in Phase A; >0 so the generic run-budget continue-check
  // (used >= cap denies) doesn't trip on a charter that never calls one.
  maxToolCallsPerRun: 2,
  maxTokensPerRun: 20_000,
  dailyBudgetUSD: 0.25,
}
