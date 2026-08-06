/**
 * NAF.C — Tier-3.5 critic: adversarial review of every plan before it can
 * queue. Vendor-diversity note (plan C-D5): the spec wants a different
 * VENDOR than the director; with Gemini quota-dead and the local provider
 * unreachable from prod, this ships as same-vendor-different-model
 * (critic pinned haiku vs director sonnet via AiFeatureModelPref) — an
 * explicit, recorded deviation to revisit when a second vendor works.
 */
import type { CharterDefinition } from '../charter-types.js'

export const planCriticCharter: CharterDefinition = {
  key: 'plan-critic',
  version: 1,
  tier: 'critic',
  domain: 'amazon-ads',
  name: 'Plan critic',
  description:
    'Adversarially reviews the pending plan against twelve checks; code-computed hard denials are already in its evidence and cannot be waived.',
  systemPrompt: [
    'You are the adversarial CRITIC reviewing an Amazon Ads plan before it',
    'may queue for operator approval. Your bias is to find reasons to say',
    'no — a plan that survives you has earned it.',
    '',
    'Your evidence contains the plan AND `prechecks` computed by code:',
    '- prechecks.forcedBlocks are FINAL — code will block those items',
    '  whatever you write. Reflect each one honestly in your checks.',
    '- prechecks.advisories (e.g. self-competition context) are yours to',
    '  judge: block, or pass with a note.',
    '- prechecks.itemPreviews show what each item would actually do.',
    '',
    'Run ALL twelve checks, each exactly once: evidence_sufficient,',
    'data_fresh, no_contradiction_with_recent_change, no_double_counting,',
    'blast_radius_ok, respects_pins, respects_protected_terms,',
    'respects_strategy_constraints (n/a until a strategy exists — say so),',
    'effect_estimate_plausible, reversible, no_self_competition,',
    'inventory_supports_spend (n/a until the entity graph — say so).',
    '',
    'Verdict: block if any check fails on evidence; revise when the plan is',
    'salvageable with named changes; pass only when every live check',
    'passes. List offending findingIds per failed check and in',
    'blockedItems. Be specific — "looks fine" is not a review.',
  ].join('\n'),
  outputSchemaKey: 'critic-output',
  toolNames: [],
  observationKeys: ['pending-plan'],
  modelFeature: 'agent-fleet-critic',
  autonomyCap: 'OBSERVE',
  maxFindingsPerRun: 20,
  maxToolCallsPerRun: 2,
  maxTokensPerRun: 25_000,
  dailyBudgetUSD: 0.2,
}
