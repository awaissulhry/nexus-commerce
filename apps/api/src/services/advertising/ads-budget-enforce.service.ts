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
import { budgetDayStart } from '@nexus/shared/ads-budget-day'
import { allowChange, nothingHeld, openEngineGuard, readEnginePosture, type EngineGuardReport, type EngineGuardWords, type EnginePosture } from './ads-engine-guard.js'
import { adsMode } from './ads-api-client.js'
import { envEnabled } from '../../utils/env-flag.js'
import type { AutomationLevel } from '../automation/automation-levels.js'

const FLOOR_CENTS = 100 // €1/day — Amazon's minimum campaign budget
/** Actor prefix this engine stamps on Campaign.bidsSuppressedBy when it suppresses. */
const BUDGET_ACTOR_PREFIX = 'automation:budget-'

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
  const today = budgetDayStart(new Date()) // 3d — today's budget day (ads-budget-day.ts), the same in every market
  const sameMonth = today.getUTCFullYear() === y && today.getUTCMonth() === m - 1
  const dayOfMonth = sameMonth ? today.getUTCDate() : daysInMonth
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

  // Month-to-date spend PER CAMPAIGN. Pacing used to divide the envelope in proportion to
  // each campaign's nominal daily budget, which is not a measure of what it consumes: this
  // account carries ~EUR 1,956/day of budget against ~EUR 92/day of spend, so budgets are
  // ~21x actual use and rank the campaigns almost arbitrarily. Scaling them all by one
  // factor left idle campaigns untouched and crushed the ones actually delivering —
  // measured on 2026-08-05, 13 of 54 spending campaigns would have been capped BELOW their
  // current spend, EUR 60.52/day of a EUR 92/day account. Share now follows spend.
  const campSpendRows = await prisma.amazonAdsDailyPerformance.groupBy({
    by: ['localEntityId'],
    where: { entityType: 'CAMPAIGN', date: { gte: start, lt: end }, localEntityId: { not: null } },
    _sum: { costMicros: true },
  })
  const mtdByCamp = new Map(campSpendRows.map((r) => [r.localEntityId as string, Math.round(Number(r._sum.costMicros ?? 0) / 10_000)]))

  const planDecisions: PlanDecision[] = []
  let budgetChanges = 0, suppressing = 0, restoring = 0, netDelta = 0

  for (const p of plans) {
    const cap = p.monthlyBudgetCents
    const mtd = mtdByMkt.get(p.marketplace) ?? 0
    const remainingBudget = Math.max(0, cap - mtd)
    const capReached = cap > 0 && mtd >= cap
    const cal = ((p.calendar as unknown as Array<{ day: number; pct: number }>) ?? [])
    const limByCamp = new Map(((p.campaignLimits as unknown as CampaignLimit[]) ?? []).map((l) => [l.campaignId, l]))

    // CORRECTIVE, not prescriptive. Pacing exists to stop a cap being breached, so it may
    // only act when the month is actually heading past it. Rewriting every daily budget to
    // the pacing target regardless meant a cap bound hardest when it was least needed:
    // on 2026-08-05 this account was EUR 367 into a EUR 4,000 month — 91% under, projecting
    // ~EUR 2,850 — and pacing still proposed cutting 82 campaigns by EUR 1,826/day.
    //
    // A daily budget is a CEILING, not a target. Leaving it above the pacing line costs
    // nothing while spend is under it, and preserves the headroom a campaign needs on the
    // days it converts.
    const daysElapsed = Math.max(1, dayOfMonth)
    const projectedCents = cap > 0 ? Math.round(mtd + (mtd / daysElapsed) * remainingDays) : 0
    const pacingNeeded = p.autoPacing && cap > 0 && projectedCents > cap

    // Today's whole-market target: calendar-weighted share of the remaining
    // envelope (so a tentpole day pulls forward), else an even daily split.
    let todayTarget: number | null = null
    if (pacingNeeded) {
      if (cal.length) {
        const rem = cal.filter((c) => c.day >= dayOfMonth)
        const sumRem = rem.reduce((s, c) => s + c.pct, 0) || 1
        const todayW = cal.find((c) => c.day === dayOfMonth)?.pct ?? 100 / daysInMonth
        todayTarget = Math.round(remainingBudget * (todayW / sumRem))
      } else {
        todayTarget = Math.round(remainingBudget / remainingDays)
      }
    }

    const camps = await prisma.campaign.findMany({ where: { marketplace: p.marketplace, status: 'ENABLED' }, select: { id: true, name: true, dailyBudget: true, bidsSuppressedAt: true, bidsSuppressedBy: true } })
    const curById = new Map(camps.map((c) => [c.id, Math.round(Number(c.dailyBudget ?? 0) * 100)]))
    const curTotal = camps.reduce((s, c) => s + (curById.get(c.id) ?? 0), 0)
    const spendTotal = camps.reduce((s, c) => s + (mtdByCamp.get(c.id) ?? 0), 0)

    const decisions: CampaignDecision[] = camps.map((c) => {
      const cur = curById.get(c.id) ?? 0
      let target: number | null = null
      let clamp: CampaignDecision['clamp'] = null
      if (pacingNeeded && todayTarget != null) {
        // Share of SPEND, falling back to share of budget only when the marketplace has no
        // spend at all this month (a fresh month, or a market that has not delivered yet) —
        // otherwise a campaign that consumes nothing would claim budget from one that does.
        const campMtd = mtdByCamp.get(c.id) ?? 0
        const share = spendTotal > 0
          ? campMtd / spendTotal
          : curTotal > 0 ? cur / curTotal : camps.length ? 1 / camps.length : 0
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
      // Only this engine's own suppressions may be restored. `bidsSuppressedAt` is shared
      // state — the rank engine's Min-bid windows, dayparting and the retail guard all set
      // it — so "suppressed and under cap" is not evidence that budget enforcement did it.
      // Without this the cron lifted 33 live Min-bid suppressions every time it ran, which
      // is the no-pause mechanism being fought by another engine on the same field. A null
      // owner predates the column and is read as NOT MINE, so legacy rows are left alone.
      const suppressedByBudget = (c.bidsSuppressedBy ?? '').startsWith(BUDGET_ACTOR_PREFIX)
      const suppress = p.stopOverSpend && capReached && !currentlySuppressed
      const restore = p.stopOverSpend && !capReached && currentlySuppressed && suppressedByBudget
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

/**
 * 1d — a live run honours the account dial and this engine's caps (ads-engine-guard.ts), asked once per campaign
 * before its first write:
 *   auto     pacing, floors and restores, inside the caps; a restore is never refused by a cap, only counted.
 *   suggest  no pacing and no new floor; it still restores the bids it floored (its own state).
 *   stopped  only the floor. Pacing and restores are NOT attempted: both change Nexus's own copy before the gate,
 *            which refuses them while stopped (a pacing write is never a suppression, a restore raises bids) — Nexus
 *            would show the restored bids while Amazon stays at 2¢. Not calling them keeps `bidsSuppressedAt` set, so
 *            the first run after Resume restores.
 */
export async function applyBudgetEnforcement(opts: { month?: string; actor?: AdsActor; dryRun?: boolean } = {}): Promise<{ dryRun: boolean; budgetApplied: number; suppressed: number; restored: number; failed: number; result: EnforcementResult; guard?: EngineGuardReport }> {
  const result = await computeBudgetEnforcement({ month: opts.month })
  const dryRun = opts.dryRun ?? true
  const actor: AdsActor = opts.actor ?? 'automation:budget-manager'
  let budgetApplied = 0, suppressed = 0, restored = 0, failed = 0
  const guard = !dryRun && result.plans.length ? await openEngineGuard('budget-enforce') : null

  if (guard) {
    for (const plan of result.plans) {
      for (const d of plan.campaigns) {
        const paces = d.targetDailyCents != null && d.deltaCents !== 0
        if (!paces && !d.suppress && !d.restore) continue
        const permit = guard.permit()
        const held = nothingHeld()
        let writes = 0
        try {
          if (paces && allowChange(true, permit, held, 'forward')) {
            const r = await updateCampaignWithSync({ campaignId: d.id, patch: { dailyBudget: d.targetDailyCents! / 100 }, actor, reason: `budget pacing: ${plan.marketplace} ${plan.month} → €${(d.targetDailyCents! / 100).toFixed(2)}/day` })
            if (r.ok) { budgetApplied++; writes++ } else failed++
          }
          if (d.suppress && allowChange(true, permit, held, 'floor')) { writes += await suppressCampaignBids(d.id, { actor, reason: `stop over spend: ${plan.marketplace} cap €${(plan.capCents / 100).toFixed(2)} reached` }); suppressed++ }
          else if (d.restore && allowChange(true, permit, held, 'restore')) { writes += await restoreCampaignBids(d.id, { actor, reason: `stop over spend: ${plan.marketplace} back under cap` }); restored++ }
        } catch (e) { failed++; logger.warn('[budget-enforce] apply failed', { campaignId: d.id, error: (e as Error).message }) }
        guard.settle(permit, writes, held)
      }
    }
  }

  logger.info(`[budget-enforce] ${dryRun ? 'dry-run' : 'applied'}`, { month: result.month, plans: result.totals.plans, budgetApplied, suppressed, restored, failed })
  return { dryRun, budgetApplied, suppressed, restored, failed, result, ...(guard ? { guard: guard.report() } : {}) }
}

/** 1d — what enforcement still does under the dial, for its run summary. */
export const BUDGET_ENFORCE_DIAL_WORDS: EngineGuardWords = {
  suggest: 'no pacing and no new floors; it still restores bids it floored over the cap',
  stopped: 'only bid floors land when a cap is reached; restores and budget pacing wait for Resume',
}

/**
 * AM-8 — the engine's mode, read EXACTLY as its tick reads it: the lower of the server env (applies only with
 * NEXUS_BUDGET_ENFORCE_APPLY exactly '1', otherwise it computes and never applies) and this business's switch.
 * `jobs/ad-budget-enforce.job.ts` calls this, and so does the Budget Manager, so the screen and the engine can never
 * say two different things again.
 */
export async function budgetEnforceGate(): Promise<{ mode: AutomationLevel; note: string | null }> {
  const { engineMode } = await import('../automation/engine-switch.service.js')
  const gate = await engineMode('budget-enforce', process.env.NEXUS_BUDGET_ENFORCE_APPLY === '1' ? 'AUTO' : 'OBSERVE')
  return { mode: gate.mode, note: gate.note }
}

/** AM-8 — what the Budget Manager says about the engine: its real mode now, and one sentence for every label. */
export interface BudgetEnforceMode {
  /** The engine's own gate (`budgetEnforceGate`): OFF stands down, OBSERVE computes only, AUTO applies. */
  mode: AutomationLevel
  /** Why the gate is below AUTO, when this business's switch lowered it. */
  switchNote: string | null
  /** The Amazon ads crons are scheduled on this server (NEXUS_ENABLE_AMAZON_ADS_CRON); without them nothing runs. */
  scheduled: boolean
  /** NEXUS_AMAZON_ADS_MODE: in sandbox an applied change stays in Nexus and never reaches Amazon. */
  adsWriteMode: 'live' | 'sandbox'
  /** The account dial a live run honours (ads-engine-guard.ts). */
  posture: EnginePosture
  /** True when a run now writes budgets or bid floors to Amazon. */
  live: boolean
  /** Short label: Live · Sandbox · Suggest only · Stopped · Observe only · Off. */
  label: string
  /** One plain sentence: what the engine does now. */
  sentence: string
}

/**
 * AM-8 — the engine's REAL mode at runtime: its own gate (`budgetEnforceGate`), whether the ads crons are scheduled,
 * the ads write mode and the account dial a live run honours (`readEnginePosture`, the read the run itself makes).
 * Read from this process's env and this business's rows; nothing is assumed.
 */
export async function budgetEnforceMode(): Promise<BudgetEnforceMode> {
  const [gate, dial] = await Promise.all([budgetEnforceGate(), readEnginePosture()])
  const scheduled = envEnabled('NEXUS_ENABLE_AMAZON_ADS_CRON')
  const writeMode = adsMode()
  const base = { mode: gate.mode, switchNote: gate.note, scheduled, adsWriteMode: writeMode, posture: dial.posture }
  const off = (sentence: string): BudgetEnforceMode => ({ ...base, live: false, label: 'Off', sentence })
  if (!scheduled) return off('Off: the Amazon ads crons are not scheduled on this server (NEXUS_ENABLE_AMAZON_ADS_CRON), so Auto Pacing and Stop Over Spend change nothing.')
  if (gate.mode === 'OFF') return off(`Off for this business (${gate.note ?? 'switched off'}): Auto Pacing and Stop Over Spend change nothing.`)
  if (gate.mode === 'OBSERVE') {
    const why = gate.note ?? 'NEXUS_BUDGET_ENFORCE_APPLY is not 1 on this server'
    return { ...base, live: false, label: 'Observe only', sentence: `Observe only (${why}): every 30 minutes the engine works out what it would change and applies nothing.` }
  }
  if (writeMode === 'sandbox') {
    return { ...base, live: false, label: 'Sandbox', sentence: 'Applies every 30 minutes, but Amazon ads writes are in sandbox (NEXUS_AMAZON_ADS_MODE): the changes stay in Nexus and never reach Amazon.' }
  }
  if (dial.posture === 'suggest') {
    return { ...base, live: false, label: 'Suggest only', sentence: `Live, but ${dial.why}: it writes nothing new and only gives back bids it floored.` }
  }
  if (dial.posture === 'stopped') {
    return { ...base, live: true, label: 'Stopped', sentence: `Live but stopped (${dial.why}): when a cap is reached bids still drop to about €0.02; budget pacing and restores wait for Resume.` }
  }
  return {
    ...base, live: true, label: 'Live',
    sentence: 'Live: every 30 minutes it changes campaign daily budgets on Amazon when a market is projected over its monthly cap, and drops bids to about €0.02 when the cap is reached. Nothing is paused.',
  }
}
