import { ValidationError } from '@nexus/factory-domain/core/errors'
import { ITEM_RULE_FIELDS, itemRuleProblems, type ItemRulePatch, type ItemRuleValues } from '@nexus/factory-domain/planning/lot-sizing/parameters'
import { PLANNING_STRATEGY_MANAGE } from '@nexus/factory-domain/planning/strategy/permissions'
import type { OfficeContext } from '../../../core/context'
import { assertMayAt } from '../access'
import type { SiteRow } from '../store'

/**
 * The planning rules per item on the item-parameters routes (B-W2b-318; PLN-006, PLN-008, PLN-081, PLN-082;
 * ../settings/items): POST /planning/item-parameters and PATCH /planning/item-parameters/:id take lotSizing, fixedLotQty,
 * lotPeriodDays, planLevel, scrapPct, yieldPct and delayDays beside W2a's fields, in the same command, audited with them.
 * The values follow factory-domain planning/lot-sizing/parameters. A plan level is how a garment is planned: it also asks
 * planning.strategy.manage over the site (B-W2b-319's permission of the production strategy; planner, production manager),
 * so the buyer keeps what it buys by and not how work orders are grouped. The bulk write stays W2a's (its rows never name
 * these fields).
 */

/** The rule fields a body names (undefined: not named). */
export function rulePatchOf(body: Partial<Record<keyof ItemRuleValues, unknown>>): ItemRulePatch {
  const patch: Record<string, unknown> = {}
  for (const key of ITEM_RULE_FIELDS) if (body[key] !== undefined) patch[key] = body[key]
  return patch as ItemRulePatch
}

/** 400 in words when the rules break a rule (the item's kind decides the plan level). */
export function refuseRules(values: ItemRuleValues, itemKind: string): void {
  const problems = itemRuleProblems(values, itemKind)
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The planning rules of the item cannot be saved this way.', problems)
}

/** A change of the plan level asks planning.strategy.manage over the site too (403 otherwise). */
export function assertMayPlanLevel(context: OfficeContext, site: SiteRow, from: ItemRuleValues | null, to: ItemRuleValues): void {
  if ((from?.planLevel ?? null) === to.planLevel) return
  assertMayAt(context, PLANNING_STRATEGY_MANAGE, { companyId: site.companyId, siteId: site.id }, 'Site')
}
