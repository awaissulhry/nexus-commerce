/**
 * BM.B3 — Budget Manager enforcement engine (dry-run safe).
 *
 * Turns the AdBudgetPlan autoPacing / stopOverSpend flags (BM.B1) from inert
 * toggles into action, per (marketplace, month):
 *   - Auto Pacing: paces the REMAINING monthly envelope across the remaining
 *     days (calendar-weighted for tentpole events), distributed over the
 *     market's enabled campaigns proportional to their current daily budget,
 *     clamped to each campaign's min/max (BM.B2) + Amazon's €1 floor.
 *   - Stop Over Spend: once month-to-date spend ≥ the cap, suppress delivery
 *     by flooring bids to ~2¢ — NEVER pausing — via the shared no-pause
 *     suppression service; restore the prior bids when back under cap.
 *
 * computeBudgetEnforcement() is pure (preview, what the UI shows). apply()
 * writes through the already-gated + sandbox-safe ads-mutation + suppression
 * services. The cron runs DRY-RUN unless NEXUS_BUDGET_ENFORCE_APPLY=1, and
 * even then the ads-mutation layer short-circuits outside live mode — two
 * independent gates, honouring [[feedback_no_pause_use_low_bids]].
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { updateCampaignWithSync, type AdsActor } from './ads-mutation.service.js'
import { suppressCampaignBids, restoreCampaignBids } from './ads-bid-suppression.service.js'
import { currentMonth } from './ads-budget-manager.service.js'

const FLOOR_CENTS = 100 // €1/day — Amazon's minimum campaign budget

interface CampaignLimit { campaignId: string; minCents?: number | null; maxCents?: number | null }

export interface CampaignDecision {
  id: string; name: string
  currentDailyCents: number
  targetDailyCents: number | null // null when autoPacing is off
  deltaCents: number
  clamp: 'min' | 'max' | 'floor' | null
  suppress: boolean // floor bids now (cap reached, not yet suppressed)
  restore: boolean // restore bids now (back under cap, currently suppressed)
  currentlySuppressed: boolean
}
export interface PlanDecision {
  marketplace: string; month: string
  capCents: number; mtdSpendCents: number; remainingBudgetCents: number
  remainingDays: number; dayOfMonth: number; daysInMonth: number
  autoPacing: boolean; stopOverSpend: boolean; capReached: boolean
  todayTargetCents: number | null
  campaigns: CampaignDecision[]
}
export interface EnforcementResult {
  month: string
  plans: PlanDecision[]
  totals: { plans: number; budgetChanges: number; suppressing: number; restoring: number; netDeltaCents: number }
}

function bounds(month: string) {
  const [y, m] = month.split('-').map(Number)
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const now = new Date()
  const sameMonth = now.getUTCFullYear() === y && now.getUTCMonth() === m - 1
  const dayOfMonth = sameMonth ? now.getUTCDate() : daysInMonth
  return { daysInMonth, dayOfMonth, start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) }
}

export async function computeBudgetEnforcement(opts: { month?: string } = {}): Promise<EnforcementResult> {
  const month = opts.month ?? currentMonth()
  const { daysInMonth, dayOfMonth, start, end } = bounds(month)
  const remainingDays = Math.max(1, daysInMonth - dayOfMonth + 1)

  const plans = await prisma.adBudgetPlan.findMany({ where: { month, tag: null, OR: [{ autoPacing: true }, { stopOverSpend: true }] } })
  if (plans.length === 0) return { month, plans: [], totals: { plans: 0, budgetChanges: 0, suppressing: 0, restoring: 0, netDeltaCents: 0 } }

  const spendRows = await prisma.amazonAdsDailyPerformance.groupBy({ by: ['marketplace'], where: { entityType: 'CAMPAIGN', date: { gte: start, lt: end } }, _sum: { costMicros: true } })
  const mtdByMkt = new Map(spendRows.map((r) => [r.marketplace, Math.round(Number(r._sum.costMicros ?? 0) / 10_000)]))

  const planDecisions: PlanDecision[] = []
  let budgetChanges = 0, suppressing = 0, restoring = 0, netDelta = 0

  for (const p of plans) {
    const cap = p.monthlyBudgetCents
    const mtd = mtdByMkt.get(p.marketplace) ?? 0
    const remainingBudget = Math.max(0, cap - mtd)
    const capReached = cap > 0 && mtd >= cap
    const cal = ((p.calendar as unknown as Array<{ day: number; pct: number }>) ?? [])
    const limByCamp = new Map(((p.campaignLimits as unknown as CampaignLimit[]) ?? []).map((l) => [l.campaignId, l]))

    // Today's whole-market target: calendar-weighted share of the remaining
    // envelope (so a tentpole day pulls forward), else an even daily split.
    let todayTarget: number | null = null
    if (p.autoPacing) {
      if (cal.length) {
        const rem = cal.filter((c) => c.day >= dayOfMonth)
        const sumRem = rem.reduce((s, c) => s + c.pct, 0) || 1
        const todayW = cal.find((c) => c.day === dayOfMonth)?.pct ?? 100 / daysInMonth
        todayTarget = Math.round(remainingBudget * (todayW / sumRem))
      } else {
        todayTarget = Math.round(remainingBudget / remainingDays)
      }
    }

    const camps = await prisma.campaign.findMany({ where: { marketplace: p.marketplace, status: 'ENABLED' }, select: { id: true, name: true, dailyBudget: true, bidsSuppressedAt: true } })
    const curById = new Map(camps.map((c) => [c.id, Math.round(Number(c.dailyBudget ?? 0) * 100)]))
    const curTotal = camps.reduce((s, c) => s + (curById.get(c.id) ?? 0), 0)

    const decisions: CampaignDecision[] = camps.map((c) => {
      const cur = curById.get(c.id) ?? 0
      let target: number | null = null
      let clamp: CampaignDecision['clamp'] = null
      if (p.autoPacing && todayTarget != null) {
        const share = curTotal > 0 ? cur / curTotal : camps.length ? 1 / camps.length : 0
        let t = Math.round(todayTarget * share)
        const lim = limByCamp.get(c.id)
        const minC = lim?.minCents ?? FLOOR_CENTS
        const maxC = lim?.maxCents ?? null
        if (t < minC) { t = minC; clamp = 'min' }
        if (maxC != null && t > maxC) { t = maxC; clamp = 'max' }
        if (t < FLOOR_CENTS) { t = FLOOR_CENTS; clamp = 'floor' }
        target = t
      }
      const currentlySuppressed = !!c.bidsSuppressedAt
      const suppress = p.stopOverSpend && capReached && !currentlySuppressed
      const restore = p.stopOverSpend && !capReached && currentlySuppressed
      return { id: c.id, name: c.name, currentDailyCents: cur, targetDailyCents: target, deltaCents: target != null ? target - cur : 0, clamp, suppress, restore, currentlySuppressed }
    })

    for (const d of decisions) {
      if (d.targetDailyCents != null && d.deltaCents !== 0) { budgetChanges++; netDelta += d.deltaCents }
      if (d.suppress) suppressing++
      if (d.restore) restoring++
    }
    planDecisions.push({ marketplace: p.marketplace, month, capCents: cap, mtdSpendCents: mtd, remainingBudgetCents: remainingBudget, remainingDays, dayOfMonth, daysInMonth, autoPacing: p.autoPacing, stopOverSpend: p.stopOverSpend, capReached, todayTargetCents: todayTarget, campaigns: decisions })
  }

  return { month, plans: planDecisions, totals: { plans: planDecisions.length, budgetChanges, suppressing, restoring, netDeltaCents: netDelta } }
}

export async function applyBudgetEnforcement(opts: { month?: string; actor?: AdsActor; dryRun?: boolean } = {}): Promise<{ dryRun: boolean; budgetApplied: number; suppressed: number; restored: number; failed: number; result: EnforcementResult }> {
  const result = await computeBudgetEnforcement({ month: opts.month })
  const dryRun = opts.dryRun ?? true
  const actor: AdsActor = opts.actor ?? 'automation:budget-manager'
  let budgetApplied = 0, suppressed = 0, restored = 0, failed = 0

  if (!dryRun) {
    for (const plan of result.plans) {
      for (const d of plan.campaigns) {
        try {
          if (d.targetDailyCents != null && d.deltaCents !== 0) {
            const r = await updateCampaignWithSync({ campaignId: d.id, patch: { dailyBudget: d.targetDailyCents / 100 }, actor, reason: `budget pacing: ${plan.marketplace} ${plan.month} → €${(d.targetDailyCents / 100).toFixed(2)}/day` })
            if (r.ok) budgetApplied++; else failed++
          }
          if (d.suppress) { await suppressCampaignBids(d.id, { actor, reason: `stop over spend: ${plan.marketplace} cap €${(plan.capCents / 100).toFixed(2)} reached` }); suppressed++ }
          else if (d.restore) { await restoreCampaignBids(d.id, { actor, reason: `stop over spend: ${plan.marketplace} back under cap` }); restored++ }
        } catch (e) { failed++; logger.warn('[budget-enforce] apply failed', { campaignId: d.id, error: (e as Error).message }) }
      }
    }
  }

  logger.info(`[budget-enforce] ${dryRun ? 'dry-run' : 'applied'}`, { month: result.month, plans: result.totals.plans, budgetApplied, suppressed, restored, failed })
  return { dryRun, budgetApplied, suppressed, restored, failed, result }
}
