/**
 * NAF.A — the fleet's artifact contracts (docs/AGENT_FLEET.md Part 5).
 *
 * Every agent output is schema-validated JSON (design law L4): the runtime
 * validates BEFORE persisting, retries once with the Zod error appended to
 * the prompt, then fails the run. It never coerces and never partially
 * accepts — a run whose output fails twice writes nothing to the blackboard.
 * Free text lives only in `rationale`, which code never parses.
 *
 * Shared between apps/api (executor validation) and apps/web (Phase D
 * Control Room rendering) so the two sides cannot drift. Zod 4 idiom —
 * `z.record` takes an explicit key schema, ISO datetimes come from `z.iso`.
 */
import { z } from 'zod'

export const ExpectedEffect = z.object({
  metric: z.enum([
    'acos',
    'tacos',
    'spend',
    'sales',
    'clicks',
    'impressions',
    'conversion_rate',
    'rank',
    'impression_share',
    'profit',
    'units',
  ]),
  direction: z.enum(['increase', 'decrease', 'hold']),
  magnitudePct: z.number().min(0).max(500),
  horizonDays: z.number().int().min(1).max(90),
  /** WHY this number — must cite the deterministic source. */
  basis: z.string().min(8),
  /** What happens if we do nothing. */
  counterfactual: z.string().optional(),
})

export const Finding = z.object({
  entityType: z.enum([
    'CAMPAIGN',
    'AD_GROUP',
    'AD_TARGET',
    'SEARCH_TERM',
    'PRODUCT',
    'ASIN',
    'PORTFOLIO',
    'ACCOUNT',
    'COMPONENT',
    'ROUTE',
  ]),
  entityId: z.string().min(1),
  entityName: z.string().optional(),
  kind: z.string().min(3),
  severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
  confidence: z.number().min(0).max(1),
  observation: z.record(z.string(), z.unknown()),
  /** At least one AgentObservation id. No evidence, no finding. */
  evidenceRefs: z.array(z.string()).min(1),
  dataVintage: z.iso.datetime(),
  proposedTool: z.string().optional(),
  proposedArgs: z.record(z.string(), z.unknown()).optional(),
  expectedEffect: ExpectedEffect.optional(),
  rationale: z.string().min(20).max(1200),
  dedupeKey: z.string().min(3),
  expiresInHours: z.number().int().min(1).max(720),
})

export const AnalystOutput = z.object({
  findings: z.array(Finding).max(50),
  scanned: z.number().int(),
  skipped: z
    .array(z.object({ entityId: z.string(), reason: z.string() }))
    .optional(),
  notes: z.string().max(600).optional(),
})

export const PlanItem = z.object({
  findingId: z.string(),
  rank: z.number().int().min(1),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  expectedEffect: ExpectedEffect,
  dependsOn: z.array(z.string()).default([]),
  reversible: z.boolean(),
})

export const DirectorOutput = z.object({
  headline: z.string().max(140),
  narrative: z.string().min(50).max(3000),
  items: z.array(PlanItem).max(60),
  dropped: z.array(
    z.object({ findingId: z.string(), reason: z.string().min(10) }),
  ),
  conflicts: z.array(
    z.object({
      findingIds: z.array(z.string()).min(2),
      kind: z.enum([
        'same_entity',
        'opposing_direction',
        'budget_contention',
        'self_competition',
        'protected_scope',
      ]),
      resolution: z.string().min(10),
    }),
  ),
  changeBudgetUsed: z.object({
    entities: z.number().int(),
    valueCents: z.number().int(),
  }),
})

export const CriticOutput = z.object({
  verdict: z.enum(['pass', 'revise', 'block']),
  checks: z.array(
    z.object({
      check: z.enum([
        'evidence_sufficient',
        'data_fresh',
        'no_contradiction_with_recent_change',
        'no_double_counting',
        'blast_radius_ok',
        'respects_pins',
        'respects_protected_terms',
        'respects_strategy_constraints',
        'effect_estimate_plausible',
        'reversible',
        'no_self_competition',
        'inventory_supports_spend',
      ]),
      result: z.enum(['pass', 'fail', 'n/a']),
      note: z.string().optional(),
      offendingItems: z.array(z.string()).default([]),
    }),
  ),
  blockedItems: z.array(z.string()).default([]),
  summary: z.string().max(1500),
})

/**
 * The registry the executor resolves `AgentCharter.outputSchemaKey` against.
 * A charter whose key is not here is a compile-time error in the charter
 * file, not a runtime surprise.
 */
export const OUTPUT_SCHEMAS = {
  'analyst-output': AnalystOutput,
  'director-output': DirectorOutput,
  'critic-output': CriticOutput,
} as const

export type OutputSchemaKey = keyof typeof OUTPUT_SCHEMAS

export type ExpectedEffectT = z.infer<typeof ExpectedEffect>
export type FindingT = z.infer<typeof Finding>
export type AnalystOutputT = z.infer<typeof AnalystOutput>
export type PlanItemT = z.infer<typeof PlanItem>
export type DirectorOutputT = z.infer<typeof DirectorOutput>
export type CriticOutputT = z.infer<typeof CriticOutput>
