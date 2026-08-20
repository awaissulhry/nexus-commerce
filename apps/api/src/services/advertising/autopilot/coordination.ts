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
  const out: LinkRef[] = []

  // AIAD.2 — sync the rules that already exist. A goal materialization provisions rules in
  // the richer SPW-proven `harvest_and_negate` shape (sources/destinations per scaffold, and
  // possibly SEVERAL per module for Strict-Control multi-product goals). For those, autonomy
  // sync means enabled/dryRun/control ONLY — overwriting their actions with this file's older
  // guessed shape would destroy the graduation destinations. Legacy links keep the old full
  // re-provision behaviour.
  for (const link of linked) {
    const want = moduleOn(modules, link.module)
    try {
      const rule = await prisma.automationRule.findUnique({ where: { id: link.ruleId }, select: { id: true, actions: true } })
      if (!rule) continue // rule deleted → drop the link
      const a0 = (Array.isArray(rule.actions) ? rule.actions[0] : null) as Record<string, unknown> | null
      if (a0?.type === 'harvest_and_negate') {
        const control = plan.autonomy === 'AUTO' ? 'automate' : 'manual'
        const actions = (rule.actions as Array<Record<string, unknown>>).map((a, i) => (i === 0 ? { ...a, control } : a))
        await prisma.automationRule.update({ where: { id: link.ruleId }, data: {
          enabled: want && plan.autonomy !== 'OFF', dryRun: plan.autonomy !== 'AUTO', actions: actions as never,
        } })
      } else {
        const cfg = ruleConfig(link.module, plan, campaignIds)
        await prisma.automationRule.update({ where: { id: link.ruleId }, data: want
          ? { enabled: cfg.enabled, dryRun: cfg.dryRun, conditions: cfg.conditions, actions: cfg.actions }
          : { enabled: false } })
      }
      out.push(link)
    } catch (e) {
      logger.warn('[autopilot] syncLinkedRules failed', { planId: plan.id, module: link.module, error: (e as Error).message })
      out.push(link)
    }
  }

  // Modules that are ON but have no linked rule at all → provision the legacy default shape
  // (pre-materialization plans, e.g. SP Super Wizard AI Control launches).
  const haveModule = new Set(out.map((l) => l.module))
  for (const module of ['harvest', 'negate'] as const) {
    if (haveModule.has(module) || !moduleOn(modules, module)) continue
    try {
      const created = await prisma.automationRule.create({ data: ruleConfig(module, plan, campaignIds) })
      out.push({ module, ruleId: created.id })
    } catch (e) {
      logger.warn('[autopilot] syncLinkedRules create failed', { planId: plan.id, module, error: (e as Error).message })
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
