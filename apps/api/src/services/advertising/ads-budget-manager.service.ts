/**
 * AX3.10 + BM.B2 — Budget Manager.
 *
 * Monthly budget per (marketplace, optional tag) with auto-pacing +
 * stop-over-spend guards and an optional per-day allocation calendar (for
 * tentpole events). Spend is read live from AmazonAdsDailyPerformance and
 * compared to budget + the expected pace-to-date, so operators see at a
 * glance whether each market is on/over/under budget. Only the plan is
 * stored (AdBudgetPlan); spend is never duplicated.
 *
 * BM.B2 enriches each row with the daily spend series (sparklines), the
 * previous month + next month figures, a month-end forecast at current
 * pace, and the per-campaign budget-limit plumbing the "More" view edits.
 * Rows are unioned across plans AND spend, so a market with spend but no
 * plan still surfaces (id=null → the UI offers to create one).
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { budgetDayStart } from '@nexus/shared/ads-budget-day'
import { EXCLUDE_AMS_DAILY } from '../ads-core/ams-daily.js'

export interface SpendSlice {
  month: string
  budgetCents: number
  spendCents: number | null
  pct: number | null
  daily: number[] // cents per day, index 0 = day 1
}
export interface BudgetPlanRow {
  id: string | null // null = no plan yet for this (marketplace, month) — spend-only row
  marketplace: string
  tag: string | null
  month: string
  monthlyBudgetCents: number
  autoPacing: boolean
  stopOverSpend: boolean
  calendar: Array<{ day: number; pct: number }>
  /** CM-30 — campaigns in this market with their own Min/Max Budget (`Campaign.minBudgetCents` / `maxBudgetCents`). */
  campaignLimitCount: number
  // this month
  spendCents: number | null
  pct: number | null // spend / budget
  expectedPct: number // pace-to-date over COMPLETE days (elapsedDays / daysInMonth, or calendar-weighted) — AM-17
  status: 'on-track' | 'over' | 'under' | 'no-budget'
  daily: number[] // this-month daily spend (cents), length = dayOfMonth
  forecastSpendCents: number | null // projected month-end spend: spend over the complete days ÷ those days × daysInMonth
  projectedOverspend: boolean // forecast > budget
  // last month
  lastMonth: SpendSlice
  // next month
  nextMonthBudgetCents: number | null
}
export interface BudgetManagerResult {
  month: string
  prevMonth: string
  nextMonth: string
  daysInMonth: number
  dayOfMonth: number
  /**
   * AM-17 — the complete budget days pace and forecast count: days before today (today is unfinished and has no daily
   * report yet), and never past the last day the daily report covers. 0 = nothing to project from yet.
   */
  elapsedDays: number
  /** AM-17 — the last day of this month the daily report covers ('YYYY-MM-DD'), or null when it covers none yet. */
  dataThrough: string | null
  /** AM-17 — when a budget day starts and ends (`@nexus/shared/ads-budget-day`), stated so the screen can say it. */
  dayBoundary: string
  rows: BudgetPlanRow[]
  totals: { budgetCents: number; spendCents: number; pct: number | null; lastMonthSpendCents: number; nextMonthBudgetCents: number }
}

interface CampaignLimit { campaignId: string; minCents?: number | null; maxCents?: number | null }

/** AM-17 — the budget day, as the enforcement engine and the write gate read it (`@nexus/shared/ads-budget-day`). */
export const BUDGET_DAY_BOUNDARY = '00:00–24:00 UTC'

function monthBounds(month: string, now: Date = new Date()): { start: Date; end: Date; daysInMonth: number; dayOfMonth: number; completeDays: number } {
  const [y, m] = month.split('-').map(Number)
  const start = new Date(Date.UTC(y, m - 1, 1))
  const end = new Date(Date.UTC(y, m, 1))
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  // AM-17 — today's BUDGET day, the same boundary the enforcement engine uses (00:00–24:00 UTC in every market).
  const today = budgetDayStart(now)
  const sameMonth = today.getUTCFullYear() === y && today.getUTCMonth() === m - 1
  const dayOfMonth = sameMonth ? today.getUTCDate() : daysInMonth
  // Complete days: before today in this month; all of a past month; none of a future one.
  const completeDays = sameMonth ? dayOfMonth - 1 : today.getTime() >= end.getTime() ? daysInMonth : 0
  return { start, end, daysInMonth, dayOfMonth, completeDays }
}

export function currentMonth(): string {
  const n = new Date()
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}`
}
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

const toCents = (micros: bigint | number | null | undefined) => Math.round(Number(micros ?? 0) / 10_000)

export async function analyzeBudgetManager(opts: { month?: string; now?: Date } = {}): Promise<BudgetManagerResult> {
  const month = opts.month ?? currentMonth()
  const prevMonth = shiftMonth(month, -1)
  const nextMonth = shiftMonth(month, 1)
  const { start, end, daysInMonth, dayOfMonth, completeDays } = monthBounds(month, opts.now)
  const prev = monthBounds(prevMonth, opts.now)

  const [plans, prevPlans, nextPlans, spendRows, boundedRows] = await Promise.all([
    prisma.adBudgetPlan.findMany({ where: { month }, orderBy: [{ marketplace: 'asc' }, { tag: 'asc' }] }),
    prisma.adBudgetPlan.findMany({ where: { month: prevMonth } }),
    prisma.adBudgetPlan.findMany({ where: { month: nextMonth } }),
    // Daily spend across last month + this month, grouped per (marketplace, date),
    // so we can build both sparkline series in one pass.
    // AM-18 — without the Marketing Stream's duplicate daily rows (`EXCLUDE_AMS_DAILY`), like every other spend
    // read: the months that hold them (2026-05-21 → 07-27) were inflated here, or showed a raw marketplace id row.
    prisma.amazonAdsDailyPerformance.groupBy({
      by: ['marketplace', 'date'],
      where: { entityType: 'CAMPAIGN', date: { gte: prev.start, lt: end }, ...EXCLUDE_AMS_DAILY },
      _sum: { costMicros: true },
    }),
    // CM-30 — how many campaigns per market carry their own Min/Max Budget (the one store, see setCampaignLimit).
    prisma.campaign.groupBy({
      by: ['marketplace'],
      where: { status: { not: 'ARCHIVED' }, OR: [{ minBudgetCents: { not: null } }, { maxBudgetCents: { not: null } }] },
      _count: { _all: true },
    }),
  ])
  const boundedByMkt = new Map(boundedRows.map((r) => [r.marketplace ?? '', r._count._all]))

  // Build per-marketplace daily arrays for this + previous month.
  interface MktSpend { thisDaily: number[]; prevDaily: number[]; thisTotal: number; prevTotal: number }
  const spend = new Map<string, MktSpend>()
  let lastReportedDom = 0 // the newest day of THIS month any market's daily report covers
  const ensure = (mkt: string): MktSpend => {
    let s = spend.get(mkt)
    if (!s) { s = { thisDaily: Array(daysInMonth).fill(0), prevDaily: Array(prev.daysInMonth).fill(0), thisTotal: 0, prevTotal: 0 }; spend.set(mkt, s) }
    return s
  }
  for (const r of spendRows) {
    const d0 = new Date(r.date)
    if (d0 >= start && d0 < end) lastReportedDom = Math.max(lastReportedDom, d0.getUTCDate())
    const cents = toCents(r._sum.costMicros)
    if (!cents) continue
    const d = new Date(r.date)
    const dom = d.getUTCDate() // 1-based
    const s = ensure(r.marketplace)
    if (d >= start) { s.thisDaily[dom - 1] = (s.thisDaily[dom - 1] ?? 0) + cents; s.thisTotal += cents }
    else { s.prevDaily[dom - 1] = (s.prevDaily[dom - 1] ?? 0) + cents; s.prevTotal += cents }
  }

  const prevPlanByMkt = new Map(prevPlans.filter((p) => !p.tag).map((p) => [p.marketplace, p]))
  const nextPlanByMkt = new Map(nextPlans.filter((p) => !p.tag).map((p) => [p.marketplace, p]))
  const thisTagNullByMkt = new Map(plans.filter((p) => !p.tag).map((p) => [p.marketplace, p]))

  // AM-17 — pace and forecast count COMPLETE days only. Today (UTC budget day) used to count as an elapsed day with
  // no spend, so the month-end forecast came out (d−1)/d too low — half on day 2, −20 % on day 5 — which could hide a
  // projected overspend, and the expected pace ran a day ahead of the data. Now: days before today, and never past the
  // last day the daily report covers (it arrives the next morning).
  const elapsedDays = Math.min(completeDays, lastReportedDom)
  // Calendar-weighted expected pace: sum of pct for days 1..elapsedDays ÷ 100,
  // falling back to even daily split when no calendar is set.
  const evenExpected = daysInMonth > 0 ? elapsedDays / daysInMonth : 0

  const buildMarketRow = (marketplace: string): BudgetPlanRow => {
    const p = thisTagNullByMkt.get(marketplace) ?? null
    const s = spend.get(marketplace)
    const monthlyBudgetCents = p?.monthlyBudgetCents ?? 0
    const calendar = ((p?.calendar as Array<{ day: number; pct: number }>) ?? [])
    const spendCents = s?.thisTotal ?? 0
    const pct = monthlyBudgetCents > 0 ? spendCents / monthlyBudgetCents : null
    const expectedPct = calendar.length
      ? calendar.filter((c) => c.day <= elapsedDays).reduce((acc, c) => acc + c.pct, 0) / 100
      : evenExpected
    let status: BudgetPlanRow['status'] = 'on-track'
    if (monthlyBudgetCents <= 0) status = 'no-budget'
    else if (pct != null && pct > expectedPct + 0.1) status = 'over'
    else if (pct != null && pct < expectedPct - 0.1) status = 'under'
    const spentOverElapsed = (s?.thisDaily ?? []).slice(0, elapsedDays).reduce((acc, v) => acc + (v ?? 0), 0)
    const forecastSpendCents = elapsedDays > 0 ? Math.round((spentOverElapsed / elapsedDays) * daysInMonth) : null
    const prevPlan = prevPlanByMkt.get(marketplace)
    const prevBudget = prevPlan?.monthlyBudgetCents ?? 0
    const prevSpend = s?.prevTotal ?? 0
    return {
      id: p?.id ?? null,
      marketplace,
      tag: null,
      month,
      monthlyBudgetCents,
      autoPacing: p?.autoPacing ?? false,
      stopOverSpend: p?.stopOverSpend ?? false,
      calendar,
      campaignLimitCount: boundedByMkt.get(marketplace) ?? 0,
      spendCents,
      pct,
      expectedPct,
      status,
      daily: (s?.thisDaily ?? Array(daysInMonth).fill(0)).slice(0, Math.max(1, dayOfMonth)),
      forecastSpendCents,
      projectedOverspend: monthlyBudgetCents > 0 && forecastSpendCents != null && forecastSpendCents > monthlyBudgetCents,
      lastMonth: {
        month: prevMonth,
        budgetCents: prevBudget,
        spendCents: prevSpend,
        pct: prevBudget > 0 ? prevSpend / prevBudget : null,
        daily: s?.prevDaily ?? Array(prev.daysInMonth).fill(0),
      },
      nextMonthBudgetCents: nextPlanByMkt.has(marketplace) ? (nextPlanByMkt.get(marketplace)!.monthlyBudgetCents) : null,
    }
  }

  // Row set = every marketplace that has a plan (any of the 3 months) OR spend.
  const marketplaces = new Set<string>([
    ...thisTagNullByMkt.keys(), ...prevPlanByMkt.keys(), ...nextPlanByMkt.keys(), ...spend.keys(),
  ])
  const rows: BudgetPlanRow[] = [...marketplaces].sort().map(buildMarketRow)

  // Preserve any tag-level plans as extra rows (spend left null — needs campaign
  // tagging to attribute). Rare; keeps data visible without bloating the common path.
  for (const p of plans.filter((pl) => pl.tag)) {
    rows.push({
      id: p.id, marketplace: p.marketplace, tag: p.tag, month, monthlyBudgetCents: p.monthlyBudgetCents,
      autoPacing: p.autoPacing, stopOverSpend: p.stopOverSpend,
      calendar: ((p.calendar as Array<{ day: number; pct: number }>) ?? []),
      campaignLimitCount: 0, // CM-30 — limits belong to campaigns, counted on the market row
      spendCents: null, pct: null, expectedPct: evenExpected, status: p.monthlyBudgetCents <= 0 ? 'no-budget' : 'on-track',
      daily: [], forecastSpendCents: null, projectedOverspend: false,
      lastMonth: { month: prevMonth, budgetCents: 0, spendCents: null, pct: null, daily: [] },
      nextMonthBudgetCents: null,
    })
  }

  const budgetCents = rows.reduce((acc, r) => acc + r.monthlyBudgetCents, 0)
  const spendCents = rows.reduce((acc, r) => acc + (r.spendCents ?? 0), 0)
  const lastMonthSpendCents = rows.reduce((acc, r) => acc + (r.lastMonth.spendCents ?? 0), 0)
  const nextMonthBudgetCents = rows.reduce((acc, r) => acc + (r.nextMonthBudgetCents ?? 0), 0)
  return {
    month, prevMonth, nextMonth, daysInMonth, dayOfMonth, rows,
    elapsedDays,
    dataThrough: lastReportedDom > 0 ? `${month}-${String(lastReportedDom).padStart(2, '0')}` : null,
    dayBoundary: BUDGET_DAY_BOUNDARY,
    totals: { budgetCents, spendCents, pct: budgetCents > 0 ? spendCents / budgetCents : null, lastMonthSpendCents, nextMonthBudgetCents },
  }
}

// ── Per-marketplace campaign list + limits (the "More" view) ───────────────
//
// CM-30 — ONE store for a campaign's minimum and maximum daily budget: `Campaign.minBudgetCents` / `maxBudgetCents`, the
// columns the Campaigns grid's Min/Max Budget cell writes (`PATCH /campaigns/:id/guardrails`) and the write gate
// enforces. The Budget Manager kept its own copy per month in `AdBudgetPlan.campaignLimits` (JSON), read only by Auto
// Pacing: a limit set on one screen did not appear on the other, and pacing could aim at a budget the gate then refused.
// Both screens and the pacer now read and write the columns. The JSON is no longer read for limits; a value still held
// there for a month (and not yet in the columns) is shown as `oldMonthLimit`, so nothing he set disappears unseen.

export interface BmCampaignRow {
  id: string; name: string; status: string; dailyBudgetCents: number
  /** The campaign's own Min/Max Budget (cents) — the same numbers as the Campaigns grid. */
  minCents: number | null; maxCents: number | null
  /** CM-30 — a limit saved only on this month's plan by the older Budget Manager, not in use; null when none. */
  oldMonthLimit: { minCents: number | null; maxCents: number | null } | null
}
export async function listBudgetManagerCampaigns(opts: { marketplace: string; month: string }): Promise<{ marketplace: string; month: string; planId: string | null; campaigns: BmCampaignRow[] }> {
  const plan = await prisma.adBudgetPlan.findFirst({ where: { marketplace: opts.marketplace, month: opts.month, tag: null } })
  const oldByCamp = new Map(((plan?.campaignLimits as unknown as CampaignLimit[]) ?? []).map((l) => [l.campaignId, l]))
  const camps = await prisma.campaign.findMany({
    where: { marketplace: opts.marketplace, status: { not: 'ARCHIVED' } },
    select: { id: true, name: true, status: true, dailyBudget: true, minBudgetCents: true, maxBudgetCents: true },
    orderBy: { name: 'asc' },
  })
  return {
    marketplace: opts.marketplace, month: opts.month, planId: plan?.id ?? null,
    campaigns: camps.map((c) => {
      const old = oldByCamp.get(c.id)
      const hasOwn = c.minBudgetCents != null || c.maxBudgetCents != null
      const oldSet = old && (old.minCents != null || old.maxCents != null)
      return {
        id: c.id, name: c.name, status: c.status, dailyBudgetCents: Math.round(Number(c.dailyBudget ?? 0) * 100),
        minCents: c.minBudgetCents ?? null, maxCents: c.maxBudgetCents ?? null,
        oldMonthLimit: oldSet && !hasOwn ? { minCents: old.minCents ?? null, maxCents: old.maxCents ?? null } : null,
      }
    }),
  }
}

/**
 * CM-30 — the same rule the grid's Min/Max Budget cell answers to (`PATCH /campaigns/:id/guardrails`): each side empty
 * or at least €1 (100 cents, Amazon's own minimum daily budget), and the minimum not above the maximum. Null = fine.
 */
export function budgetBoundsProblem(minCents: number | null, maxCents: number | null): string | null {
  for (const [label, v] of [['minimum', minCents], ['maximum', maxCents]] as const) {
    if (v != null && (!Number.isFinite(v) || v < 100)) return `The ${label} daily budget must be at least €1.00 (Amazon's own minimum), or empty for none.`
  }
  if (minCents != null && maxCents != null && minCents > maxCents) {
    return `The minimum daily budget (€${(minCents / 100).toFixed(2)}) is above the maximum (€${(maxCents / 100).toFixed(2)}).`
  }
  return null
}

/**
 * CM-30 — set one campaign's Min/Max Budget from the Budget Manager: the campaign's own columns, the store the grid
 * writes and the gate enforces (and Auto Pacing keeps to). Audited as `set_campaign_budget_bounds`, like the grid's
 * write. A limit the older Budget Manager kept on this month's plan for the campaign is removed with it, so the two can
 * never disagree again. `month` names that plan only; the limit itself is not per month.
 */
export interface CampaignLimitResult {
  ok: boolean
  campaignId?: string; minCents?: number | null; maxCents?: number | null
  /** When not ok: why, and the HTTP status the route answers with. */
  error?: string; status?: 400 | 404
}
export async function setCampaignLimit(opts: { marketplace: string; month: string; campaignId: string; minCents: number | null; maxCents: number | null; createdBy?: string }): Promise<CampaignLimitResult> {
  const minCents = opts.minCents == null ? null : Math.round(Number(opts.minCents))
  const maxCents = opts.maxCents == null ? null : Math.round(Number(opts.maxCents))
  const problem = budgetBoundsProblem(minCents, maxCents)
  if (problem) return { ok: false, error: problem, status: 400 }
  const c = await prisma.campaign.findUnique({ where: { id: opts.campaignId }, select: { id: true, marketplace: true, minBudgetCents: true, maxBudgetCents: true } })
  if (!c || (c.marketplace && c.marketplace !== opts.marketplace)) return { ok: false, error: `Nexus holds no campaign ${opts.campaignId} in ${opts.marketplace}.`, status: 404 }
  await prisma.campaign.update({ where: { id: c.id }, data: { minBudgetCents: minCents, maxBudgetCents: maxCents } })
  await prisma.advertisingActionLog.create({
    data: {
      userId: opts.createdBy ?? 'user:budget-manager',
      actionType: 'set_campaign_budget_bounds', entityType: 'CAMPAIGN', entityId: c.id,
      payloadBefore: { minBudgetCents: c.minBudgetCents, maxBudgetCents: c.maxBudgetCents },
      payloadAfter: { minBudgetCents: minCents, maxBudgetCents: maxCents }, amazonResponseStatus: 'SUCCESS',
      evidence: { metric: 'operator_guardrail', note: 'Budget bounds set from the Budget Manager; the same columns as the Campaigns grid. Enforced at the write gate, kept to by Auto Pacing. Never pushed to Amazon.' },
    },
  }).catch(() => { /* an audit row must never fail the write it describes */ })
  await forgetOldMonthLimits(c.id)
  return { ok: true, campaignId: c.id, minCents, maxCents }
}

/**
 * CM-30 — once a campaign's Min/Max Budget is set or cleared from either screen, the copies the older Budget Manager
 * kept per month (`AdBudgetPlan.campaignLimits`) are dropped, so a cleared limit is not offered back as an "old" one.
 * A few plan rows per market; only the ones naming the campaign are written.
 */
export async function forgetOldMonthLimits(campaignId: string): Promise<number> {
  const plans = await prisma.adBudgetPlan.findMany({ select: { id: true, campaignLimits: true } })
  let changed = 0
  for (const p of plans) {
    const old = ((p.campaignLimits as unknown as CampaignLimit[]) ?? [])
    if (!Array.isArray(old) || !old.some((l) => l?.campaignId === campaignId)) continue
    await prisma.adBudgetPlan.update({ where: { id: p.id }, data: { campaignLimits: old.filter((l) => l?.campaignId !== campaignId) as never } })
    changed++
  }
  return changed
}

// ── Plan CRUD ──────────────────────────────────────────────────────────────

export interface UpsertBudgetPlan { id?: string; marketplace: string; tag?: string | null; month: string; monthlyBudgetCents?: number; autoPacing?: boolean; stopOverSpend?: boolean; calendar?: Array<{ day: number; pct: number }>; campaignLimits?: CampaignLimit[]; createdBy?: string }
export async function upsertBudgetPlan(input: UpsertBudgetPlan) {
  // Resolve the target row: explicit id, else the existing (marketplace, month, tag)
  // plan — so toggles / next-month edits stay idempotent instead of duplicating.
  let id = input.id
  if (!id) {
    const existing = await prisma.adBudgetPlan.findFirst({ where: { marketplace: input.marketplace, month: input.month, tag: input.tag ?? null } })
    id = existing?.id
  }
  if (id) {
    const data: Record<string, unknown> = {}
    for (const k of ['monthlyBudgetCents', 'autoPacing', 'stopOverSpend'] as const) if (input[k] !== undefined) data[k] = input[k]
    if (input.calendar !== undefined) data.calendar = input.calendar as never
    if (input.campaignLimits !== undefined) data.campaignLimits = input.campaignLimits as never
    return prisma.adBudgetPlan.update({ where: { id }, data })
  }
  const plan = await prisma.adBudgetPlan.create({
    data: { marketplace: input.marketplace, tag: input.tag ?? null, month: input.month, monthlyBudgetCents: input.monthlyBudgetCents ?? 0, autoPacing: input.autoPacing ?? false, stopOverSpend: input.stopOverSpend ?? false, calendar: (input.calendar ?? []) as never, campaignLimits: (input.campaignLimits ?? []) as never, createdBy: input.createdBy ?? null },
  })
  logger.info('[AX3.10] upsertBudgetPlan create', { id: plan.id, marketplace: plan.marketplace, month: plan.month })
  return plan
}

export async function deleteBudgetPlan(id: string) {
  return prisma.adBudgetPlan.delete({ where: { id } }).catch(() => null)
}
