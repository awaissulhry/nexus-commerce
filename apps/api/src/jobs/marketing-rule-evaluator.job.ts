/**
 * UM-series (P6) — marketing-domain AutomationRule trigger context
 * builders + cron tick. Mirrors advertising-rule-evaluator.job.ts.
 *
 * Triggers (domain='marketing'):
 *   MKT_ACOS_BREACH        — a campaign's ACOS exceeds the rule threshold
 *                            (operators pair with mkt_pause_campaign or
 *                            mkt_adjust_budget deltaPct<0)
 *   MKT_UNDERPACING        — an ACTIVE campaign with budget but ~no spend
 *                            (delivery stalled / opportunity to push)
 *   MKT_CRON_TICK          — generic heartbeat context (time-based rules)
 *
 * Context carries { campaignId, campaign:{...}, marketplace } so handlers
 * resolve the target and the conditions DSL can match on metrics. Rules
 * are dryRun=true by default; the engine enforces per-rule caps.
 *
 * Side-effect import registers the mkt_* action handlers.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { evaluateAllRulesForTrigger } from '../services/automation-rule.service.js'
import cron from 'node-cron'
import '../services/marketing/marketing-action-handlers.js'

const ACOS_BREACH_DEFAULT = Number(process.env.NEXUS_MKT_ACOS_BREACH ?? 0.5) // 50%
const UNDERPACE_MIN_BUDGET_CENTS = Number(process.env.NEXUS_MKT_UNDERPACE_MIN_BUDGET_CENTS ?? 500)

interface MktContext {
  marketplace: string | null
  campaignId: string
  campaign: {
    id: string
    name: string
    channel: string
    status: string
    acos: number | null
    roas: number | null
    spendCents: number
    salesCents: number
    budgetCents: number | null
  }
}

function toCtx(c: {
  id: string; name: string; channel: string; status: string
  acos: unknown; roas: unknown; spendCents: number; salesCents: number
  budgetCents: number | null; primaryMarketplace: string | null
}): MktContext {
  return {
    marketplace: c.primaryMarketplace,
    campaignId: c.id,
    campaign: {
      id: c.id, name: c.name, channel: c.channel, status: c.status,
      acos: c.acos != null ? Number(c.acos) : null,
      roas: c.roas != null ? Number(c.roas) : null,
      spendCents: c.spendCents, salesCents: c.salesCents, budgetCents: c.budgetCents,
    },
  }
}

const SELECT = {
  id: true, name: true, channel: true, status: true, acos: true, roas: true,
  spendCents: true, salesCents: true, budgetCents: true, primaryMarketplace: true,
} as const

// ── MKT_ACOS_BREACH ───────────────────────────────────────────────────────
async function buildAcosBreachContexts(): Promise<MktContext[]> {
  const rows = await prisma.marketingCampaign.findMany({
    where: { status: 'ACTIVE', acos: { gte: ACOS_BREACH_DEFAULT } },
    select: SELECT,
    take: 1000,
  })
  return rows.map(toCtx)
}

// ── MKT_UNDERPACING — active, has budget, ~no spend ───────────────────────
async function buildUnderpacingContexts(): Promise<MktContext[]> {
  const rows = await prisma.marketingCampaign.findMany({
    where: { status: 'ACTIVE', budgetCents: { gte: UNDERPACE_MIN_BUDGET_CENTS }, spendCents: { lte: 0 } },
    select: SELECT,
    take: 1000,
  })
  return rows.map(toCtx)
}

async function scopeAndRun(trigger: string, contexts: MktContext[]): Promise<{ evaluations: number; matches: number }> {
  let evaluations = 0
  let matches = 0
  for (const ctx of contexts) {
    const rules = await prisma.automationRule.findMany({
      where: {
        domain: 'marketing',
        trigger,
        enabled: true,
        OR: [{ scopeMarketplace: null }, { scopeMarketplace: ctx.marketplace }],
      },
      select: { id: true },
    })
    if (rules.length === 0) continue
    const results = await evaluateAllRulesForTrigger({ domain: 'marketing', trigger, context: ctx })
    evaluations += results.length
    matches += results.filter((r) => r.matched).length
  }
  return { evaluations, matches }
}

export interface MktTickSummary {
  acosBreachContexts: number
  underpacingContexts: number
  totalEvaluations: number
  totalMatches: number
  durationMs: number
}

let lastSummary: string | null = null

export async function runMarketingRuleEvaluatorOnce(): Promise<MktTickSummary> {
  const startedAt = Date.now()
  const [acos, underpace] = await Promise.all([buildAcosBreachContexts(), buildUnderpacingContexts()])
  let totalEvaluations = 0
  let totalMatches = 0
  for (const [trigger, contexts] of [
    ['MKT_ACOS_BREACH', acos],
    ['MKT_UNDERPACING', underpace],
  ] as Array<[string, MktContext[]]>) {
    const r = await scopeAndRun(trigger, contexts)
    totalEvaluations += r.evaluations
    totalMatches += r.matches
  }
  // Generic time-based rules get a single tick context.
  const tickRules = await prisma.automationRule.count({ where: { domain: 'marketing', trigger: 'MKT_CRON_TICK', enabled: true } })
  if (tickRules > 0) {
    const r = await evaluateAllRulesForTrigger({ domain: 'marketing', trigger: 'MKT_CRON_TICK', context: { marketplace: null, ts: startedAt } })
    totalEvaluations += r.length
    totalMatches += r.filter((x) => x.matched).length
  }
  const summary: MktTickSummary = {
    acosBreachContexts: acos.length,
    underpacingContexts: underpace.length,
    totalEvaluations,
    totalMatches,
    durationMs: Date.now() - startedAt,
  }
  lastSummary = `acos=${acos.length} underpace=${underpace.length} evals=${totalEvaluations} matches=${totalMatches} durationMs=${summary.durationMs}`
  return summary
}

export async function runMarketingRuleEvaluatorCron(): Promise<void> {
  try {
    await recordCronRun('marketing-rule-evaluator', async () => {
      const summary = await runMarketingRuleEvaluatorOnce()
      logger.info('marketing-rule-evaluator cron: completed', { summary })
      return lastSummary ?? 'no-summary'
    })
  } catch (err) {
    logger.error('marketing-rule-evaluator cron: failure', { error: err instanceof Error ? err.message : String(err) })
  }
}

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export function startMarketingRuleEvaluatorCron(): void {
  if (scheduledTask) {
    logger.warn('marketing-rule-evaluator cron already started')
    return
  }
  // Every 15 min — matches the advertising/replenishment evaluators.
  scheduledTask = cron.schedule('*/15 * * * *', () => void runMarketingRuleEvaluatorCron())
  logger.info('marketing-rule-evaluator cron scheduled (*/15 * * * *)')
}
