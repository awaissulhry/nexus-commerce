/**
 * AC-3 — AI Control / Autopilot Conductor cron. Every 15 min, for each enabled AutopilotPlan,
 * gather per-campaign signals, run the pure Conductor, and record its proposed actions as
 * AutopilotDecision rows (the live SSE feed + audit). **SUGGEST/dry-run only — zero live writes.**
 * AUTO application (behind the write-gate) lands in a later phase. Harvest/Negate are NOT produced
 * here — they are delegated to the Rule-Setting session (provisioned + read by AC-5).
 * See docs/ai-control-autopilot-spec.md.
 */
import cron from 'node-cron'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { runConductorCycle, type PlanModules } from '../services/advertising/autopilot/conductor.js'
import { DEFAULT_GUARDRAILS, type CampaignSignals, type Goal, type Guardrails } from '../services/advertising/autopilot/presets.js'
import { syncLinkedRules, mirrorRuleDecisions } from '../services/advertising/autopilot/coordination.js'
import { applyPlanActions } from '../services/advertising/autopilot/apply.js'

/** Assemble per-campaign signals from Campaign aggregates + AdTarget perf roll-up. */
export async function gatherSignals(campaignIds: string[]): Promise<CampaignSignals[]> {
  if (!campaignIds.length) return []
  const [campaigns, targets] = await Promise.all([
    prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true, dailyBudget: true, trueProfitMarginPct: true, deliveryReasons: true, impressions: true } }),
    prisma.adTarget.findMany({ where: { isNegative: false, adGroup: { campaignId: { in: campaignIds } } }, select: { spendCents: true, salesCents: true, clicks: true, ordersCount: true, bidCents: true, adGroup: { select: { campaignId: true } } } }),
  ])
  const agg = new Map<string, { spend: number; sales: number; clicks: number; orders: number; bidSum: number; bidN: number }>()
  for (const t of targets) {
    const cid = t.adGroup?.campaignId
    if (!cid) continue
    const a = agg.get(cid) ?? { spend: 0, sales: 0, clicks: 0, orders: 0, bidSum: 0, bidN: 0 }
    a.spend += t.spendCents ?? 0; a.sales += t.salesCents ?? 0; a.clicks += t.clicks ?? 0; a.orders += t.ordersCount ?? 0
    if ((t.bidCents ?? 0) > 0) { a.bidSum += t.bidCents; a.bidN += 1 }
    agg.set(cid, a)
  }
  return campaigns.map((c) => {
    const a = agg.get(c.id) ?? { spend: 0, sales: 0, clicks: 0, orders: 0, bidSum: 0, bidN: 0 }
    // trueProfitMarginPct may be stored as a fraction (0.35) or a percent (35) — normalize to percent.
    const rawMargin = c.trueProfitMarginPct != null ? Number(c.trueProfitMarginPct) : null
    const marginPct = rawMargin == null ? null : rawMargin <= 1.5 ? rawMargin * 100 : rawMargin
    return {
      campaignId: c.id,
      spendCents: a.spend, salesCents: a.sales, clicks: a.clicks, orders: a.orders,
      impressions: c.impressions ?? 0,
      dailyBudgetCents: Math.round(Number(c.dailyBudget) * 100),
      currentBidCents: a.bidN > 0 ? Math.round(a.bidSum / a.bidN) : 0,
      daysOfSupply: null,            // enrichment follow-up (FbaStorageAge → DoS)
      marginPct,
      tosImpressionSharePct: null,   // enrichment follow-up (placement report)
      deliveryOutOfBudget: Array.isArray(c.deliveryReasons) && c.deliveryReasons.includes('OUT_OF_BUDGET'),
      acos1hPct: null,               // enrichment follow-up (AMS hourly)
    }
  })
}

export async function runAutopilotOnce(): Promise<{ plans: number; decisions: number }> {
  const plans = await prisma.autopilotPlan.findMany({ where: { enabled: true, autonomy: { not: 'OFF' } } })
  let decisions = 0
  for (const plan of plans) {
    const ids = Array.isArray(plan.campaignIds) ? (plan.campaignIds as string[]) : []
    const signals = await gatherSignals(ids)
    const result = runConductorCycle({
      goal: plan.goal as Goal,
      guardrails: (plan.guardrails ?? {}) as Partial<Guardrails>,
      modules: (plan.modules ?? {}) as PlanModules,
      signals,
    })
    // Clear this plan's stale autopilot proposals; AUTO then applies, SUGGEST re-records proposals.
    await prisma.autopilotDecision.deleteMany({ where: { planId: plan.id, status: 'PROPOSED', source: 'autopilot' } })
    if (plan.autonomy === 'AUTO') {
      // AUTO: apply live (write-gated + audited). APPLIED/DENIED/SKIPPED rows are kept as history.
      const merged: Guardrails = { ...DEFAULT_GUARDRAILS, ...((plan.guardrails ?? {}) as Partial<Guardrails>) }
      const res = await applyPlanActions({ planId: plan.id, goal: plan.goal as Goal, marketplace: plan.marketplace, guardrails: merged, actions: result.actions, signals })
      if (res.decisions.length) {
        await prisma.autopilotDecision.createMany({ data: res.decisions.map((d) => ({
          planId: plan.id, cycle: 'fast', module: d.module, campaignId: d.campaignId, action: d.action,
          before: (d.before ?? undefined) as object | undefined, after: (d.after ?? undefined) as object | undefined,
          reason: d.reason, status: d.status, source: 'autopilot', executionId: d.executionId ?? null,
        })) })
        decisions += res.decisions.length
      }
    } else if (result.actions.length) {
      // SUGGEST/dry-run: record fresh proposals (NO live writes).
      await prisma.autopilotDecision.createMany({
        data: result.actions.map((a) => ({
          planId: plan.id, cycle: 'fast', module: a.module, campaignId: a.campaignId, action: a.action,
          before: (a.beforeCents != null ? { cents: a.beforeCents } : a.before ?? undefined) as object | undefined,
          after: (a.afterCents != null ? { cents: a.afterCents } : a.after ?? undefined) as object | undefined,
          reason: a.reason, status: 'PROPOSED', source: 'autopilot',
        })),
      })
      decisions += result.actions.length
    }
    // Coordinate with the Rule-Setting session's harvest/negate engine: provision the linked
    // rules for this plan + mirror their pending decisions into our unified feed (real-time sync).
    let links: Awaited<ReturnType<typeof syncLinkedRules>> = []
    try { links = await syncLinkedRules(plan); await mirrorRuleDecisions(plan, links) } catch { /* best-effort coordination */ }
    await prisma.autopilotPlan.update({
      where: { id: plan.id },
      data: { lastEvaluatedAt: new Date(), linkedRuleIds: links as object, ...(result.actions.length ? { lastDecisionAt: new Date() } : {}) },
    })
  }
  logger.info('[autopilot] tick', { plans: plans.length, decisions })
  return { plans: plans.length, decisions }
}

export async function runAutopilotCron(): Promise<void> {
  try { await recordCronRun('ad-autopilot', async () => { const r = await runAutopilotOnce(); return `plans=${r.plans} decisions=${r.decisions}` }) }
  catch (err) { logger.error('ad-autopilot cron failure', { error: err instanceof Error ? err.message : String(err) }) }
}

let task: ReturnType<typeof cron.schedule> | null = null
let running = false
export function startAutopilotCron(): void {
  if (task) return
  task = cron.schedule('*/15 * * * *', () => {
    if (running) { logger.warn('[ad-autopilot] previous tick still in flight — skipping'); return }
    running = true
    void runAutopilotCron().finally(() => { running = false })
  })
  logger.info('ad-autopilot cron scheduled (*/15 * * * *)')
}
