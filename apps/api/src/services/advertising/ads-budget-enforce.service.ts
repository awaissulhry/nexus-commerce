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
 *
 * ADS AUTONOMY W1-6 — the ads strategy's market cap (AdsStrategy, `monthlySpendCapCents` on the market row) is a
 * STANDING monthly stop: it binds every month, with or without a budget plan (marketCaps below):
 *   · the cap that stops a market is the lower of this month's plan (when its Stop Over Spend is on) and the strategy's;
 *     pacing paces the plan's envelope, never above the strategy's cap;
 *   · a floor lands at the strategy's stop bid for that campaign (the lower across its products), else the 2¢ floor;
 *   · floors carry this engine's own `bidsSuppressedBy`, and only those are ever given back: rank's, dayparting's, the
 *     retail guard's and a person's floors are never lifted here, and they never lift this engine's (they hold for
 *     an owner that is not theirs);
 *   · given back when the market is under its stop cap again: on the 1st (month-to-date spend starts again from 0),
 *     or at once when the cap is raised or removed, or Stop Over Spend is switched off — a market whose cap is gone
 *     still gets its floors back.
 * W1-6b — a CATEGORY or PRODUCT cap of the strategy floors, on its own, every ad group holding a product under it once
 * that scope's month-to-date spend reaches it (ads-strategy/spend.ts; the safer rule: the other products sharing the
 * ad group stop too). The ad group carries the floor's owner (AdGroup.bidsSuppressedBy, suppressAdGroupBids), so a
 * campaign restore by any engine leaves it floored, and it is given back by the same rules: on the 1st, or when the
 * cap is raised or removed.
 * Month-to-date spend is Amazon's daily campaign report (AmazonAdsDailyPerformance, entityType CAMPAIGN): whole days,
 * yesterday's requested at 01:15 UTC (ads-report-create) and stored once Amazon has built it (polled every 10 minutes,
 * ingested every 15). Today's spend is never in it, so a cap is seen as reached the morning after the spend that
 * reached it, and the market can pass its cap by up to about a day of spend (`spendThrough` says which day it covers).
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { updateCampaignWithSync, type AdsActor } from './ads-mutation.service.js'
import { suppressCampaignBids, restoreCampaignBids, suppressAdGroupBids, restoreAdGroupBids } from './ads-bid-suppression.service.js'
import { currentMonth } from './ads-budget-manager.service.js'
import { EXCLUDE_AMS_DAILY } from '../ads-core/ams-daily.js'
import { budgetDayStart } from '@nexus/shared/ads-budget-day'
import { allowChange, nothingHeld, openEngineGuard, readEnginePosture, type EngineGuardReport, type EngineGuardWords, type EnginePosture } from './ads-engine-guard.js'
import { adsMode } from './ads-api-client.js'
import { envEnabled } from '../../utils/env-flag.js'
import type { AutomationLevel } from '../automation/automation-levels.js'
import { DEFAULT_STOP_BID_CENTS } from './ads-strategy/fields.js'
import { capMarkets } from './ads-strategy/load.js'
import { openStrategy, stopBidsIn, strategySourceWords, type StrategyView } from './ads-strategy/effective.js'
import { adGroupFloorDecisions, scopeCapsThisMonth, type ScopeCap } from './ads-strategy/spend.js'

const FLOOR_CENTS = 100 // €1/day — Amazon's minimum campaign budget
/** Actor prefix this engine stamps on Campaign.bidsSuppressedBy when it suppresses. */
const BUDGET_ACTOR_PREFIX = 'automation:budget-'

export interface CampaignDecision {
  id: string; name: string
  currentDailyCents: number
  targetDailyCents: number | null // null when autoPacing is off
  deltaCents: number
  clamp: 'min' | 'max' | 'floor' | null
  suppress: boolean // floor bids now (cap reached, not yet suppressed)
  restore: boolean // restore bids now (back under cap, currently suppressed)
  currentlySuppressed: boolean
  /** W1-6 — when `suppress`: the bid the floor lands at (the ads strategy's stop bid, else 2¢) and where it comes from. */
  stopBidCents?: number
  stopBidFrom?: string
}
/** W1-6b — an ad group a category or product cap floors on its own, or whose own floor this engine gives back. */
export interface AdGroupDecision {
  id: string; name: string; campaignId: string
  suppress: boolean
  restore: boolean
  /** The owner of its own floor now (null: not floored on its own). */
  ownFloorBy: string | null
  /** The reached caps that cover one of its products; the first is named in the reason. */
  reachedBy: Array<{ level: 'category' | 'product'; label: string; capCents: number; spendCents: number; from: string }>
  stopBidCents?: number
  stopBidFrom?: string
}
/** W1-6b — a category or product cap of the market with its scope's spend this month. */
export interface ScopeCapDecision { level: 'category' | 'product'; scopeId: string; label: string; capCents: number; spendCents: number; reached: boolean; from: string }
export interface PlanDecision {
  marketplace: string; month: string
  /** The cap pacing paces and the screens show: the plan's, lowered to the ads strategy's when that is lower (W1-6). */
  capCents: number; mtdSpendCents: number; remainingBudgetCents: number
  remainingDays: number; dayOfMonth: number; daysInMonth: number
  /** `stopOverSpend`: a stop is in force this month — the plan's switch, or the ads strategy's cap (always a stop). */
  autoPacing: boolean; stopOverSpend: boolean
  /** The cap where bids drop is reached (with no stop in force: the plan's cap). */
  capReached: boolean
  todayTargetCents: number | null
  campaigns: CampaignDecision[]
  /** W1-6 — this month's budget plan cap and the ads strategy's market cap (null: none, or a cap of 0 — no cap). */
  planCapCents: number | null
  strategyCap: { cents: number; from: string } | null
  /** W1-6 — where bids drop (null: no stop in force) and which cap that is. */
  stopCapCents: number | null
  stopBy: 'plan' | 'strategy' | null
  /** W1-6 — the last day the month-to-date spend covers ('YYYY-MM-DD'; null: no report this month yet). Never today. */
  spendThrough: string | null
  /** W1-6b — the market's category and product caps with their scopes' spend (Sponsored Products ads only). */
  scopeCaps: ScopeCapDecision[]
  /** W1-6b — the last day the per-product spend covers, and the spend of ads Nexus cannot tie to a product (no cap). */
  productSpendThrough: string | null
  unattributedSpendCents: number
  /** W1-6b — ad groups floored on their own: to floor now, to give back, or holding their floor. */
  adGroups: AdGroupDecision[]
}
export interface EnforcementResult {
  month: string
  plans: PlanDecision[]
  /** `adGroupsSuppressing` / `adGroupsRestoring` (W1-6b): ad groups a category or product cap floors, or gives back. */
  totals: { plans: number; budgetChanges: number; suppressing: number; restoring: number; netDeltaCents: number; adGroupsSuppressing: number; adGroupsRestoring: number }
}

function bounds(month: string) {
  const [y, m] = month.split('-').map(Number)
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const today = budgetDayStart(new Date()) // 3d — today's budget day (ads-budget-day.ts), the same in every market
  const sameMonth = today.getUTCFullYear() === y && today.getUTCMonth() === m - 1
  const dayOfMonth = sameMonth ? today.getUTCDate() : daysInMonth
  return { daysInMonth, dayOfMonth, start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) }
}

/** W1-6 — the caps of ONE market this month (pure). */
export interface MarketCaps {
  /** What pacing paces and the screens call the cap: the plan's, lowered to the strategy's when that is lower; the strategy's alone without a plan. */
  capCents: number | null
  /** Where bids drop: the plan's cap while its Stop Over Spend is on, the strategy's always — the lower binds. Null: no stop. */
  stopCapCents: number | null
  stopBy: 'plan' | 'strategy' | null
  /** The envelope Auto Pacing divides (Auto Pacing on only), never above the strategy's cap. */
  pacingCapCents: number | null
}

/**
 * W1-6 — which cap stops a market and which one pacing paces, from this month's plan and the ads strategy's market cap.
 * A cap of 0 (or less) is NO cap, in the plan and in the strategy alike: the Budget Manager has always read a €0 month
 * as "no budget set" (#357), and the same number must not mean the opposite on two screens. An immediate stop is a
 * stop (suppress-campaign), never a cap of 0.
 */
export function marketCaps(
  plan: { monthlyBudgetCents: number; autoPacing: boolean; stopOverSpend: boolean } | null,
  strategyCents: number | null,
): MarketCaps {
  const planCap = plan && plan.monthlyBudgetCents > 0 ? plan.monthlyBudgetCents : null
  const strategyCapCents = strategyCents != null && strategyCents > 0 ? strategyCents : null
  const lower = (...caps: Array<number | null>) => {
    const set = caps.filter((c): c is number => c != null)
    return set.length ? Math.min(...set) : null
  }
  const planStop = plan?.stopOverSpend ? planCap : null
  const stopCapCents = lower(planStop, strategyCapCents)
  return {
    capCents: lower(planCap, strategyCapCents),
    stopCapCents,
    stopBy: stopCapCents == null ? null : strategyCapCents != null && strategyCapCents <= (planStop ?? Number.POSITIVE_INFINITY) ? 'strategy' : 'plan',
    pacingCapCents: plan?.autoPacing && planCap != null ? lower(planCap, strategyCapCents) : null,
  }
}

const isBudgetFloor = (by: string | null | undefined) => (by ?? '').startsWith(BUDGET_ACTOR_PREFIX)

const capWords = (c: ScopeCap) => strategySourceWords({ level: c.level, strategyId: c.strategyId, scopeId: c.scopeId, label: c.label, version: c.version })

/**
 * W1-6b — the market's ad groups a category or product cap floors, and this engine's own ad-group floors it gives back.
 * With no reached cap only the ad groups floored on their own are read (this engine's are given back, the others
 * shown); with one, every ad group of the market's enabled campaigns is resolved once (its products' caps).
 */
async function adGroupFloors(marketplace: string, view: StrategyView | null, reached: ReadonlyMap<string, ScopeCap>): Promise<AdGroupDecision[]> {
  const groups = await prisma.adGroup.findMany({
    where: { campaign: { marketplace, status: 'ENABLED' }, ...(reached.size ? {} : { bidsSuppressedAt: { not: null } }) },
    select: { id: true, name: true, campaignId: true, bidsSuppressedAt: true, bidsSuppressedBy: true },
    orderBy: { id: 'asc' },
  })
  if (!groups.length) return []
  const effective = reached.size && view ? await view.forAdGroups(groups.map((g) => g.id)) : new Map()
  const decided = adGroupFloorDecisions(
    groups.map((g) => ({ id: g.id, caps: effective.get(g.id)?.values.monthlyCaps ?? [], ownFloor: g.bidsSuppressedAt ? { by: g.bidsSuppressedBy } : null })),
    reached,
    isBudgetFloor,
  )
  const due = decided.filter((d) => d.suppress).map((d) => d.id)
  const stops = new Map<string, { cents: number; from: string | null }>()
  for (const id of due) {
    const e = effective.get(id)
    const source = e?.resolved.fields.get('stop')?.source
    stops.set(id, e?.values.stop && source ? { cents: e.values.stop.bidCents, from: strategySourceWords(source) } : { cents: DEFAULT_STOP_BID_CENTS, from: null })
  }
  const byId = new Map(groups.map((g) => [g.id, g]))
  return decided.filter((d) => d.suppress || d.restore || byId.get(d.id)!.bidsSuppressedAt).map((d) => {
    const g = byId.get(d.id)!
    const stop = stops.get(d.id)
    return {
      id: d.id, name: g.name, campaignId: g.campaignId, suppress: d.suppress, restore: d.restore, ownFloorBy: g.bidsSuppressedAt ? g.bidsSuppressedBy : null,
      reachedBy: d.reachedBy.map((c) => ({ level: c.level, label: c.label, capCents: c.capCents, spendCents: c.spendCents, from: capWords(c) })),
      ...(stop ? { stopBidCents: stop.cents, ...(stop.from ? { stopBidFrom: stop.from } : {}) } : {}),
    }
  })
}

export async function computeBudgetEnforcement(opts: { month?: string } = {}): Promise<EnforcementResult> {
  const month = opts.month ?? currentMonth()
  const { daysInMonth, dayOfMonth, start, end } = bounds(month)
  const remainingDays = Math.max(1, daysInMonth - dayOfMonth + 1)
  const empty: EnforcementResult = { month, plans: [], totals: { plans: 0, budgetChanges: 0, suppressing: 0, restoring: 0, netDeltaCents: 0, adGroupsSuppressing: 0, adGroupsRestoring: 0 } }

  // W1-6 — three things put a market in the run: a plan with Auto Pacing or Stop Over Spend, an ads strategy cap (a
  // standing stop, no plan needed; W1-6b: the market's, a category's or a product's), or floors this engine set — on a
  // campaign or on an ad group — where no cap is in force any more (given back).
  const [plans, strategyMarketList, ownFloors, ownGroupFloors] = await Promise.all([
    prisma.adBudgetPlan.findMany({ where: { month, tag: null } }),
    capMarkets(),
    prisma.campaign.findMany({ where: { status: 'ENABLED', bidsSuppressedAt: { not: null }, bidsSuppressedBy: { startsWith: BUDGET_ACTOR_PREFIX }, marketplace: { not: null } }, select: { marketplace: true }, distinct: ['marketplace'] }),
    prisma.adGroup.findMany({ where: { bidsSuppressedAt: { not: null }, bidsSuppressedBy: { startsWith: BUDGET_ACTOR_PREFIX }, campaign: { status: 'ENABLED', marketplace: { not: null } } }, select: { campaign: { select: { marketplace: true } } } }),
  ])
  const planByMkt = new Map(plans.map((p) => [p.marketplace, p]))
  const strategyMarkets = new Set(strategyMarketList)
  const markets = [...new Set([
    ...plans.filter((p) => p.autoPacing || p.stopOverSpend).map((p) => p.marketplace),
    ...strategyMarkets,
    ...ownFloors.map((c) => c.marketplace as string),
    ...ownGroupFloors.map((g) => g.campaign.marketplace as string),
  ])].sort()
  if (markets.length === 0) return empty

  // W1-6 — `_max.date`: the last day the month-to-date spend covers (the daily report arrives the next morning).
  // AA-W2-2b — without the Marketing Stream's duplicate daily rows, as the Budget Manager reads it (AM-18): the two
  // screens and the cap stop agree on what was spent.
  const spendRows = await prisma.amazonAdsDailyPerformance.groupBy({ by: ['marketplace'], where: { entityType: 'CAMPAIGN', date: { gte: start, lt: end }, ...EXCLUDE_AMS_DAILY }, _sum: { costMicros: true }, _max: { date: true } })
  const mtdByMkt = new Map(spendRows.map((r) => [r.marketplace, Math.round(Number(r._sum.costMicros ?? 0) / 10_000)]))
  const throughByMkt = new Map(spendRows.map((r) => [r.marketplace, r._max.date ? new Date(r._max.date).toISOString().slice(0, 10) : null]))

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
  let budgetChanges = 0, suppressing = 0, restoring = 0, netDelta = 0, adGroupsSuppressing = 0, adGroupsRestoring = 0

  for (const marketplace of markets) {
    const p = planByMkt.get(marketplace) ?? null
    // The strategy is opened for a market with a cap, and for any market where a floor is due (its stop bid).
    let view: StrategyView | null = strategyMarkets.has(marketplace) ? await openStrategy(marketplace) : null
    // A strategy cap of 0 is no cap (marketCaps): not shown as one either.
    const strategyCap = view?.forMarket().values.monthlyCaps.find((c) => c.source.level === 'market' && c.monthlySpendCapCents > 0) ?? null
    const caps = marketCaps(p, strategyCap?.monthlySpendCapCents ?? null)
    const cap = caps.capCents ?? 0
    const mtd = mtdByMkt.get(marketplace) ?? 0
    const remainingBudget = Math.max(0, cap - mtd)
    const stopNow = caps.stopCapCents != null && mtd >= caps.stopCapCents
    const capReached = caps.stopCapCents != null ? stopNow : cap > 0 && mtd >= cap
    const cal = ((p?.calendar as unknown as Array<{ day: number; pct: number }>) ?? [])

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
    const pacingNeeded = caps.pacingCapCents != null && cap > 0 && projectedCents > cap

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

    // CM-30 — each campaign's own Min/Max Budget (the columns the grid and the Budget Manager both write, and the write
    // gate enforces), not the per-month copy the plan used to keep: a target outside them was refused at the gate anyway.
    const camps = await prisma.campaign.findMany({ where: { marketplace, status: 'ENABLED' }, select: { id: true, name: true, dailyBudget: true, bidsSuppressedAt: true, bidsSuppressedBy: true, minBudgetCents: true, maxBudgetCents: true } })
    // BID BRAIN pre-go-live — the brain's own Min-bid floor mark on a campaign it owns is no stop: over the cap, the stop
    // is declared over it (suppressCampaignBids lands it), never skipped as "already floored" and lost at the hour's end.
    const { brainOwnedCampaignIds } = await import('./bid-brain/live.js')
    const { isPlanFloorMark } = await import('./bid-brain/facts.js')
    const brainOwned = await brainOwnedCampaignIds(camps.filter((c) => c.bidsSuppressedAt && isPlanFloorMark(c.bidsSuppressedBy)).map((c) => c.id))
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
        const minC = c.minBudgetCents ?? FLOOR_CENTS
        const maxC = c.maxBudgetCents ?? null
        if (t < minC) { t = minC; clamp = 'min' }
        if (maxC != null && t > maxC) { t = maxC; clamp = 'max' }
        if (t < FLOOR_CENTS) { t = FLOOR_CENTS; clamp = 'floor' }
        target = t
      }
      const currentlySuppressed = !!c.bidsSuppressedAt && !brainOwned.has(c.id)
      // Only this engine's own suppressions may be restored. `bidsSuppressedAt` is shared
      // state — the rank engine's Min-bid windows, dayparting and the retail guard all set
      // it — so "suppressed and under cap" is not evidence that budget enforcement did it.
      // Without this the cron lifted 33 live Min-bid suppressions every time it ran, which
      // is the no-pause mechanism being fought by another engine on the same field. A null
      // owner predates the column and is read as NOT MINE, so legacy rows are left alone.
      // W1-6 — given back whenever the market is under its stop cap: also when no stop is in force any more (the
      // cap removed, Stop Over Spend switched off, last month's plan gone), so a floor never outlives its cap.
      const suppress = stopNow && !currentlySuppressed
      const restore = !stopNow && currentlySuppressed && isBudgetFloor(c.bidsSuppressedBy)
      return { id: c.id, name: c.name, currentDailyCents: cur, targetDailyCents: target, deltaCents: target != null ? target - cur : 0, clamp, suppress, restore, currentlySuppressed }
    })

    const due = decisions.filter((d) => d.suppress).map((d) => d.id)
    if (due.length && !view) view = await openStrategy(marketplace)
    const floors = await stopBidsIn(view, due)
    for (const d of decisions) {
      const stop = floors.get(d.id)
      if (stop) { d.stopBidCents = stop.cents; if (stop.source) d.stopBidFrom = strategySourceWords(stop.source) }
      if (d.targetDailyCents != null && d.deltaCents !== 0) { budgetChanges++; netDelta += d.deltaCents }
      if (d.suppress) suppressing++
      if (d.restore) restoring++
    }
    // W1-6b — the category and product caps: each scope's spend this month, and the ad groups they floor or give back.
    const scope = view ? await scopeCapsThisMonth(view, start, end) : null
    const adGroups = await adGroupFloors(marketplace, view, scope?.reached ?? new Map())
    for (const g of adGroups) {
      if (g.suppress) adGroupsSuppressing++
      if (g.restore) adGroupsRestoring++
    }
    planDecisions.push({
      marketplace, month, capCents: cap, mtdSpendCents: mtd, remainingBudgetCents: remainingBudget, remainingDays, dayOfMonth, daysInMonth,
      autoPacing: caps.pacingCapCents != null, stopOverSpend: caps.stopCapCents != null, capReached, todayTargetCents: todayTarget, campaigns: decisions,
      planCapCents: p && p.monthlyBudgetCents > 0 ? p.monthlyBudgetCents : null,
      strategyCap: strategyCap ? { cents: strategyCap.monthlySpendCapCents, from: strategySourceWords(strategyCap.source) } : null,
      stopCapCents: caps.stopCapCents, stopBy: caps.stopBy, spendThrough: throughByMkt.get(marketplace) ?? null,
      scopeCaps: (scope?.caps ?? []).map((c) => ({ level: c.level, scopeId: c.scopeId, label: c.label, capCents: c.capCents, spendCents: c.spendCents, reached: c.reached, from: capWords(c) })),
      productSpendThrough: scope?.spendThrough ?? null,
      unattributedSpendCents: scope?.unattributedCents ?? 0,
      adGroups,
    })
  }

  return { month, plans: planDecisions, totals: { plans: planDecisions.length, budgetChanges, suppressing, restoring, netDeltaCents: netDelta, adGroupsSuppressing, adGroupsRestoring } }
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
export async function applyBudgetEnforcement(opts: { month?: string; actor?: AdsActor; dryRun?: boolean } = {}): Promise<{ dryRun: boolean; budgetApplied: number; suppressed: number; restored: number; failed: number; adGroupsSuppressed: number; adGroupsRestored: number; result: EnforcementResult; guard?: EngineGuardReport }> {
  const result = await computeBudgetEnforcement({ month: opts.month })
  const dryRun = opts.dryRun ?? true
  const actor: AdsActor = opts.actor ?? 'automation:budget-manager'
  let budgetApplied = 0, suppressed = 0, restored = 0, failed = 0, adGroupsSuppressed = 0, adGroupsRestored = 0
  const guard = !dryRun && result.plans.length ? await openEngineGuard('budget-enforce') : null

  if (guard) {
    for (const plan of result.plans) {
      for (const d of plan.campaigns) {
        const paces = d.targetDailyCents != null && d.deltaCents !== 0
        if (!paces && !d.suppress && !d.restore) continue
        // W1-6 — the market's own "most actions per run" (the ads strategy) counts this campaign's changes too.
        const permit = guard.permit({ market: plan.marketplace })
        const held = nothingHeld()
        let writes = 0
        try {
          if (paces && allowChange(true, permit, held, 'forward')) {
            const r = await updateCampaignWithSync({ campaignId: d.id, patch: { dailyBudget: d.targetDailyCents! / 100 }, actor, reason: `budget pacing: ${plan.marketplace} ${plan.month} → €${(d.targetDailyCents! / 100).toFixed(2)}/day` })
            if (r.ok) { budgetApplied++; writes++ } else failed++
          }
          if (d.suppress && allowChange(true, permit, held, 'floor')) { writes += await suppressCampaignBids(d.id, { actor, floorCents: d.stopBidCents ?? null, reason: stopReason(plan, d) }); suppressed++ }
          else if (d.restore && allowChange(true, permit, held, 'restore')) { writes += await restoreCampaignBids(d.id, { actor, reason: plan.stopCapCents == null ? `stop over spend: ${plan.marketplace} has no monthly cap in force any more` : `stop over spend: ${plan.marketplace} back under cap` }); restored++ }
        } catch (e) { failed++; logger.warn('[budget-enforce] apply failed', { campaignId: d.id, error: (e as Error).message }) }
        guard.settle(permit, writes, held)
      }
      // W1-6b — after the campaigns: the ad groups a category or product cap floors, and the ones it gives back. An ad
      // group asks for its permit once, like a campaign; a give-back inside a campaign floored by anyone only hands its
      // memory over to that floor (restoreAdGroupBids).
      for (const g of plan.adGroups) {
        if (!g.suppress && !g.restore) continue
        const permit = guard.permit({ market: plan.marketplace })
        const held = nothingHeld()
        let writes = 0
        try {
          if (g.suppress && allowChange(true, permit, held, 'floor')) { writes += await suppressAdGroupBids(g.id, { actor, floorCents: g.stopBidCents ?? null, reason: adGroupStopReason(plan, g) }); adGroupsSuppressed++ }
          else if (g.restore && allowChange(true, permit, held, 'restore')) { writes += await restoreAdGroupBids(g.id, { actor, reason: `stop over spend: ${plan.marketplace} ad group ${g.name} — no category or product cap of it is reached any more` }); adGroupsRestored++ }
        } catch (e) { failed++; logger.warn('[budget-enforce] ad group apply failed', { adGroupId: g.id, error: (e as Error).message }) }
        guard.settle(permit, writes, held)
      }
    }
  }

  logger.info(`[budget-enforce] ${dryRun ? 'dry-run' : 'applied'}`, { month: result.month, plans: result.totals.plans, budgetApplied, suppressed, restored, adGroupsSuppressed, adGroupsRestored, failed })
  return { dryRun, budgetApplied, suppressed, restored, failed, adGroupsSuppressed, adGroupsRestored, result, ...(guard ? { guard: guard.report() } : {}) }
}

/** W1-6b — an action-log reason for an ad-group floor: the reached cap that covers it, and the stop bid's source. */
function adGroupStopReason(plan: PlanDecision, g: AdGroupDecision): string {
  const first = g.reachedBy[0]
  const cap = first ? `${first.level} cap reached (${first.from})${g.reachedBy.length > 1 ? ` and ${g.reachedBy.length - 1} more` : ''}` : 'cap reached'
  return `stop over spend: ${plan.marketplace} ${cap} → ad group ${g.name}${g.stopBidFrom ? ` to ${g.stopBidCents}¢ (${g.stopBidFrom})` : ''}`
}

/** W1-6 — an action-log reason for a floor: which cap was reached, and the stop bid when the ads strategy set it. */
function stopReason(plan: PlanDecision, d: CampaignDecision): string {
  const cap = plan.stopBy === 'strategy' && plan.strategyCap
    ? `${plan.marketplace} monthly cap reached (${plan.strategyCap.from})`
    : `${plan.marketplace} cap €${((plan.stopCapCents ?? plan.capCents) / 100).toFixed(2)} reached`
  return `stop over spend: ${cap}${d.stopBidFrom ? ` → bids to ${d.stopBidCents}¢ (${d.stopBidFrom})` : ''}`
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
  if (!scheduled) return off('Off: the Amazon ads crons are not scheduled on this server (NEXUS_ENABLE_AMAZON_ADS_CRON), so Auto Pacing, Stop Over Spend and the ads strategy\'s monthly caps change nothing.')
  if (gate.mode === 'OFF') return off(`Off for this business (${gate.note ?? 'switched off'}): Auto Pacing, Stop Over Spend and the ads strategy's monthly caps change nothing.`)
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
    return { ...base, live: true, label: 'Stopped', sentence: `Live but stopped (${dial.why}): when a cap is reached bids still drop to about €0.02 (or the ads strategy's stop bid); budget pacing and restores wait for Resume.` }
  }
  return {
    ...base, live: true, label: 'Live',
    sentence: 'Live: every 30 minutes it changes campaign daily budgets on Amazon when a market is projected over its monthly cap, and drops bids to about €0.02 (or the ads strategy\'s stop bid) when a cap is reached — a budget plan\'s with Stop Over Spend on, or the ads strategy\'s monthly cap (a market\'s: every campaign of it; a category\'s or product\'s: every ad group holding it) — until the 1st. Nothing is paused.',
  }
}
