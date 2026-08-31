/**
 * AC-3 — AI Control / Autopilot Conductor cron. Every 15 min, for each enabled AutopilotPlan,
 * gather per-campaign signals, run the pure Conductor, and record its proposed actions as
 * AutopilotDecision rows (the live SSE feed + audit). **SUGGEST/dry-run only — zero live writes.**
 * AUTO application (behind the write-gate) lands in a later phase. Harvest/Negate are NOT produced
 * here — they are delegated to the Rule-Setting session (provisioned + read by AC-5).
 * See docs/ai-control-autopilot-spec.md.
 */
import cron from '../lib/cron/clustered.js'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { runConductorCycle, type PlanModules } from '../services/advertising/autopilot/conductor.js'
import { DEFAULT_GUARDRAILS, type CampaignSignals, type Goal, type Guardrails } from '../services/advertising/autopilot/presets.js'
import { syncLinkedRules, mirrorRuleDecisions } from '../services/advertising/autopilot/coordination.js'
import { applyPlanActions } from '../services/advertising/autopilot/apply.js'
import { suppressDismissed, DISMISS_SUPPRESSION_MS } from '../services/advertising/autopilot/decisions.js'
import { mutedKeys } from '../services/advertising/ads-suggestions.service.js'
import { microsToCents } from '../services/ads-core/metrics-math.js'
import { ruleWindowBounds } from '@nexus/shared/data-vintage'

/** Assemble per-campaign signals from Campaign aggregates + AdTarget perf roll-up. */
export async function gatherSignals(campaignIds: string[]): Promise<CampaignSignals[]> {
  if (!campaignIds.length) return []
  // ADX — spend/sales/clicks/orders came from AdTarget's stored aggregates, which are 0
  // across all 5,204 targets and will stay 0: the only writer, ads-metrics-ingest, was
  // deliberately retired in H.2e (2026-05-18). So every signal this function produced
  // was zero, across 1,341 autopilot runs, and the conductor has been planning against
  // an account that looked completely idle.
  //
  // Performance now comes from AmazonAdsDailyPerformance at CAMPAIGN grain — already
  // populated, already the level these signals are consumed at, and no dependency on
  // the target-grain ingest. AdTarget is still read, but only for bidCents, which is
  // genuine entity state from structure sync rather than a performance roll-up.
  const { since, until } = ruleWindowBounds(14) // excludes the provisional D-0/D-1 tail
  const [campaigns, targets, perf] = await Promise.all([
    prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true, dailyBudget: true, trueProfitMarginPct: true, deliveryReasons: true, impressions: true } }),
    prisma.adTarget.findMany({ where: { isNegative: false, adGroup: { campaignId: { in: campaignIds } } }, select: { bidCents: true, adGroup: { select: { campaignId: true } } } }),
    prisma.amazonAdsDailyPerformance.groupBy({
      by: ['localEntityId'],
      where: { entityType: 'CAMPAIGN', localEntityId: { in: campaignIds }, date: { gte: since, lte: until } },
      _sum: { costMicros: true, sales7dCents: true, clicks: true, orders7d: true },
    }),
  ])
  const agg = new Map<string, { spend: number; sales: number; clicks: number; orders: number; bidSum: number; bidN: number }>()
  const blank = () => ({ spend: 0, sales: 0, clicks: 0, orders: 0, bidSum: 0, bidN: 0 })
  for (const p of perf) {
    if (!p.localEntityId) continue
    const a = agg.get(p.localEntityId) ?? blank()
    a.spend = microsToCents(p._sum.costMicros)
    a.sales = p._sum.sales7dCents ?? 0
    a.clicks = p._sum.clicks ?? 0
    a.orders = p._sum.orders7d ?? 0
    agg.set(p.localEntityId, a)
  }
  // Average current bid stays a target-level read — it is entity state, not performance.
  for (const t of targets) {
    const cid = t.adGroup?.campaignId
    if (!cid) continue
    const a = agg.get(cid) ?? blank()
    if ((t.bidCents ?? 0) > 0) { a.bidSum += t.bidCents; a.bidN += 1 }
    agg.set(cid, a)
  }
  return campaigns.map((c) => {
    const a = agg.get(c.id) ?? blank()
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
      // SG.8 — a dismissal from the Suggestions tab must STICK. This branch deletes and
      // re-proposes every tick, so without suppression a dismissed proposal would return in
      // 15 minutes. Fingerprint = module|campaignId|action (the family tabs' proposedKey
      // semantics — the VALUE may wobble tick to tick; the identity is what was dismissed).
      // Expired dismissals are pruned first, which is exactly what lets a proposal return
      // after the window — the suggestions re-propose sweep's 7-day behaviour.
      // SUGGEST-only on purpose: AUTO is delegated autonomy — an old snooze must not veto it.
      await prisma.autopilotDecision.deleteMany({
        where: { planId: plan.id, status: 'DISMISSED', at: { lt: new Date(Date.now() - DISMISS_SUPPRESSION_MS) } },
      })
      const dismissed = await prisma.autopilotDecision.findMany({
        where: { planId: plan.id, status: 'DISMISSED' },
        select: { module: true, campaignId: true, action: true },
      })
      // SG.9 — and campaigns the operator muted from the A.I. Bids tab: "stop suggesting
      // changes for this campaign". The campaign keeps running; only the proposing stops.
      const muted = await mutedKeys('ai')
      const fresh = suppressDismissed(result.actions, dismissed)
        .filter((a) => !muted.has(`CAMPAIGN|${a.campaignId}`))
      // SUGGEST/dry-run: record fresh proposals (NO live writes).
      if (fresh.length) {
        await prisma.autopilotDecision.createMany({
          data: fresh.map((a) => ({
            planId: plan.id, cycle: 'fast', module: a.module, campaignId: a.campaignId, action: a.action,
            before: (a.beforeCents != null ? { cents: a.beforeCents } : a.before ?? undefined) as object | undefined,
            after: (a.afterCents != null ? { cents: a.afterCents } : a.after ?? undefined) as object | undefined,
            reason: a.reason, status: 'PROPOSED', source: 'autopilot',
          })),
        })
      }
      decisions += fresh.length
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
