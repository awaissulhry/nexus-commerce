/**
 * AC-5 — coordination with the parallel Rule-Setting session's HARVEST + NEGATE engine.
 * The Autopilot does NOT run its own harvest/negate; it (1) PROVISIONS the established
 * advertising AutomationRule (trigger SEARCH_TERM_CONVERTING / SEARCH_TERM_WASTING, scoped to the
 * plan's campaigns, with goal-derived thresholds), and (2) MIRRORS that engine's decisions into
 * our unified AutopilotDecision feed (source='rule-setting') in real time. All best-effort +
 * defensive so it never breaks the cron if the other session's shape shifts.
 *
 * CONTRACT to confirm with the Rule-Setting session:
 *  - conditions use the {metric, op, value} group shape their RuleBuilder produces.
 *  - campaign scope is carried as `actions[0].campaignIds` (+ scopeMarketplace). If their
 *    evaluator expects a different scoping field, tell us and we align here.
 *  - rules we create are tagged `createdBy='autopilot'` + name-prefixed "Autopilot ·".
 */
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { GOAL_PRESETS, type Goal } from './presets.js'

type LinkRef = { module: 'harvest' | 'negate'; ruleId: string }
interface PlanLike {
  id: string; name: string; marketplace: string; goal: string; autonomy: string
  campaignIds: unknown; modules: unknown; linkedRuleIds: unknown
}

const moduleOn = (modules: Record<string, { on?: boolean }> | undefined, k: string): boolean => modules?.[k]?.on !== false // default ON

// goal → harvest/negate thresholds (mirrors the RuleBuilder condition defaults).
function thresholds(goal: Goal) {
  const h = GOAL_PRESETS[goal].harvest
  const minOrders = h === 'aggressive' ? 1 : h === 'medium' ? 2 : 3
  const minNegSpendEur = h === 'aggressive' ? 10 : h === 'medium' ? 20 : 30
  return { minOrders, minNegSpendEur }
}

function ruleConfig(module: 'harvest' | 'negate', plan: PlanLike, campaignIds: string[]) {
  const goal = plan.goal as Goal
  const t = thresholds(goal)
  const control = plan.autonomy === 'AUTO' ? 'automate' : 'manual'
  const base = { domain: 'advertising', enabled: plan.autonomy !== 'OFF', dryRun: plan.autonomy !== 'AUTO', scopeMarketplace: plan.marketplace, createdBy: 'autopilot' as const }
  if (module === 'harvest') {
    return {
      ...base,
      name: `Autopilot · Harvest — ${plan.name}`,
      trigger: 'SEARCH_TERM_CONVERTING',
      conditions: [{ match: 'all', lookback: 'Last 60 Days', exclude: 'Last 3 Days', conditions: [{ metric: 'PPC Orders', op: 'gte', value: String(t.minOrders) }] }],
      actions: [{ type: 'keyword-harvesting', control, campaignIds }],
    }
  }
  return {
    ...base,
    name: `Autopilot · Negate — ${plan.name}`,
    trigger: 'SEARCH_TERM_WASTING',
    conditions: [{ match: 'all', lookback: 'Last 60 Days', exclude: 'Last 3 Days', conditions: [{ metric: 'Sales', op: 'eq', value: '0' }, { metric: 'Spend', op: 'gte', value: String(t.minNegSpendEur) }] }],
    actions: [{ type: 'negative-targeting', control, campaignIds }],
  }
}

/** Ensure the plan's harvest/negate AutomationRules exist + reflect its goal/autonomy. Returns links. */
export async function syncLinkedRules(plan: PlanLike): Promise<LinkRef[]> {
  const modules = (plan.modules ?? {}) as Record<string, { on?: boolean }>
  const campaignIds = Array.isArray(plan.campaignIds) ? (plan.campaignIds as string[]) : []
  const linked = (Array.isArray(plan.linkedRuleIds) ? plan.linkedRuleIds : []) as LinkRef[]
  const byModule = new Map(linked.map((l) => [l.module, l.ruleId]))
  const out: LinkRef[] = []
  for (const module of ['harvest', 'negate'] as const) {
    const want = moduleOn(modules, module)
    const existing = byModule.get(module)
    const cfg = ruleConfig(module, plan, campaignIds)
    try {
      if (want) {
        if (existing) {
          await prisma.automationRule.update({ where: { id: existing }, data: { enabled: cfg.enabled, dryRun: cfg.dryRun, conditions: cfg.conditions, actions: cfg.actions } })
          out.push({ module, ruleId: existing })
        } else {
          const created = await prisma.automationRule.create({ data: cfg })
          out.push({ module, ruleId: created.id })
        }
      } else if (existing) {
        await prisma.automationRule.update({ where: { id: existing }, data: { enabled: false } })
        out.push({ module, ruleId: existing }) // keep the link, just disabled
      }
    } catch (e) {
      logger.warn('[autopilot] syncLinkedRules failed', { planId: plan.id, module, error: (e as Error).message })
      if (existing) out.push({ module, ruleId: existing })
    }
  }
  return out
}

/** Mirror the harvest/negate engine's pending suggestions into our feed (source='rule-setting'). */
export async function mirrorRuleDecisions(plan: PlanLike, links: LinkRef[]): Promise<number> {
  if (!links.length) return 0
  const ruleIds = links.map((l) => l.ruleId)
  const moduleByRule = new Map(links.map((l) => [l.ruleId, l.module]))
  try {
    const suggs = await prisma.adsRuleSuggestion.findMany({ where: { ruleId: { in: ruleIds }, status: 'pending' }, orderBy: { createdAt: 'desc' }, take: 200 })
    // refresh: drop our prior mirrored proposals, re-insert the current pending set.
    await prisma.autopilotDecision.deleteMany({ where: { planId: plan.id, source: 'rule-setting', status: 'PROPOSED' } })
    if (!suggs.length) return 0
    await prisma.autopilotDecision.createMany({
      data: suggs.map((s) => {
        const module = (moduleByRule.get(s.ruleId) ?? 'harvest') as 'harvest' | 'negate'
        return {
          planId: plan.id, cycle: 'slow', module, campaignId: s.entityType === 'CAMPAIGN' ? s.entityId : null,
          action: module === 'harvest' ? 'HARVEST' : 'NEGATE',
          after: s.proposedAction as object,
          reason: `${s.entityName ?? s.entityId}${s.trigger ? ` · ${s.trigger}` : ''}`,
          status: 'PROPOSED', source: 'rule-setting', executionId: s.executionId ?? null,
        }
      }),
    })
    return suggs.length
  } catch (e) {
    logger.warn('[autopilot] mirrorRuleDecisions failed', { planId: plan.id, error: (e as Error).message })
    return 0
  }
}
