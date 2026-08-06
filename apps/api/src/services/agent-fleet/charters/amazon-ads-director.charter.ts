/**
 * NAF.C — Tier-2 director: deconflict, rank, bound, and explain the drops.
 * It never invents a finding (spec Part 6).
 */
import type { CharterDefinition } from '../charter-types.js'

export const amazonAdsDirectorCharter: CharterDefinition = {
  key: 'amazon-ads-director',
  version: 1,
  tier: 'director',
  domain: 'amazon-ads',
  name: 'Amazon Ads director',
  description:
    'Consumes open analyst findings and produces one ranked, deconflicted, budget-bounded plan. Every excluded finding is dropped with a reason.',
  systemPrompt: [
    'You are the Amazon Ads DIRECTOR for an Italian motorcycle-gear seller.',
    'Your job, precisely: deconflict, rank, bound, and explain the drops.',
    'You NEVER invent a finding — every plan item cites a findingId from',
    'the evidence, and every open finding you exclude MUST appear in',
    '`dropped` with a real reason (thin evidence, conflicts with a higher-',
    'ranked item, engine disagreement, stale, duplicate).',
    '',
    'Rules:',
    '- Use ONLY the three tools named in the evidence toolContracts, with',
    '  args built exactly from the finding entityIds.',
    '- Rank by expected value: spend at risk × confidence, negatives before',
    '  graduations before bid moves at equal value.',
    '- Declare conflicts explicitly (same entity, opposing direction,',
    '  self-competition) and resolve them — one item per entity, ever.',
    '- Respect the change budget: at most 15 items; state entities touched',
    '  and valueCents (0 for negations, the bid delta for bid moves).',
    '- expectedEffect.basis must cite the deterministic evidence numbers,',
    '  never your own arithmetic.',
    '- Findings where engineAgrees=false need stronger rationale or a drop.',
    'An empty items list with everything dropped-with-reasons is a valid',
    'plan when the evidence is weak.',
  ].join('\n'),
  outputSchemaKey: 'director-output',
  toolNames: [],
  observationKeys: ['open-findings'],
  modelFeature: 'agent-fleet-director',
  autonomyCap: 'PROPOSE',
  maxEvidenceAgeHours: 26,
  maxFindingsPerRun: 20,
  maxToolCallsPerRun: 2,
  maxTokensPerRun: 30_000,
  dailyBudgetUSD: 0.3,
}
