import { z } from 'zod'
import { OVERHEAD_BASES } from '../costing/overhead-rules/rules'
import { defineEvent } from '../events/define'
import { WORK_CENTRE_KINDS } from '../product/routing/operations'

/**
 * The events of the cost rates (B-W2b-419; FIN-005, FIN-007; apps/factory-api modules/costing/{cost-per-minute,overhead-rules}).
 * Context `cost-rates`, its own module folder (the costing events file is W1's and W2a's). The office screens that may see
 * costs (costing.view) refetch what they show, with their viewer's grains: ids, kinds, bases and states only, never a figure.
 *
 *   cost_per_minute.changed   a department's cost-per-minute calculation was made, corrected, removed, or applied as its
 *                             labour rate (applying also emits labour_rate.created for the rate it writes)
 *   overhead_rule.changed     an overhead absorption rule was added, corrected, ended by the rule after it, or archived
 */

/** What happened to a cost-per-minute calculation. */
export const CALC_CHANGES = ['created', 'updated', 'removed', 'applied'] as const
export type CalcChange = (typeof CALC_CHANGES)[number]

/** What happened to an overhead rule. */
export const OVERHEAD_RULE_CHANGES = ['created', 'updated', 'ended', 'archived'] as const
export type OverheadRuleChange = (typeof OVERHEAD_RULE_CHANGES)[number]

const kind = z.enum(WORK_CENTRE_KINDS)

export const events = [
  defineEvent({
    type: 'cost_per_minute.changed',
    context: 'cost-rates',
    description: "A department's cost-per-minute calculation was made, corrected, removed, or applied as its labour rate.",
    payload: z.strictObject({ calcId: z.uuid(), workCentreKind: kind, change: z.enum(CALC_CHANGES), labourRateId: z.uuid().nullable() }),
    live: { permission: 'costing.view', fields: ['calcId', 'workCentreKind', 'change'] },
  }),
  defineEvent({
    type: 'overhead_rule.changed',
    context: 'cost-rates',
    description: 'An overhead absorption rule was added, corrected, ended by the rule after it, or archived.',
    payload: z.strictObject({ ruleId: z.uuid(), basis: z.enum(OVERHEAD_BASES), workCentreKind: kind.nullable(), change: z.enum(OVERHEAD_RULE_CHANGES) }),
    live: { permission: 'costing.view', fields: ['ruleId', 'basis', 'workCentreKind', 'change'] },
  }),
] as const
