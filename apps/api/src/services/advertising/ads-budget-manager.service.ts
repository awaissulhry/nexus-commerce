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
  campaignLimitCount: number
  // this month
  spendCents: number | null
  pct: number | null // spend / budget
  expectedPct: number // pace-to-date (day / daysInMonth, or calendar-weighted)
  status: 'on-track' | 'over' | 'under' | 'no-budget'
  daily: number[] // this-month daily spend (cents), length = dayOfMonth
  forecastSpendCents: number | null // projected month-end spend at current pace
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
  rows: BudgetPlanRow[]
  totals: { budgetCents: number; spendCents: number; pct: number | null; lastMonthSpendCents: number; nextMonthBudgetCents: number }
}

interface CampaignLimit { campaignId: string; minCents?: number | null; maxCents?: number | null }

function monthBounds(month: string): { start: Date; end: Date; daysInMonth: number; dayOfMonth: number } {
  const [y, m] = month.split('-').map(Number)
  const start = new Date(Date.UTC(y, m - 1, 1))
  const end = new Date(Date.UTC(y, m, 1))
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const now = new Date()
  const sameMonth = now.getUTCFullYear() === y && now.getUTCMonth() === m - 1
  const dayOfMonth = sameMonth ? now.getUTCDate() : daysInMonth
  return { start, end, daysInMonth, dayOfMonth }
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

export async function analyzeBudgetManager(opts: { month?: string } = {}): Promise<BudgetManagerResult> {
  const month = opts.month ?? currentMonth()
  const prevMonth = shiftMonth(month, -1)
  const nextMonth = shiftMonth(month, 1)
  const { start, end, daysInMonth, dayOfMonth } = monthBounds(month)
  const prev = monthBounds(prevMonth)

  const [plans, prevPlans, nextPlans, spendRows] = await Promise.all([
    prisma.adBudgetPlan.findMany({ where: { month }, orderBy: [{ marketplace: 'asc' }, { tag: 'asc' }] }),
    prisma.adBudgetPlan.findMany({ where: { month: prevMonth } }),
    prisma.adBudgetPlan.findMany({ where: { month: nextMonth } }),
    // Daily spend across last month + this month, grouped per (marketplace, date),
    // so we can build both sparkline series in one pass.
    prisma.amazonAdsDailyPerformance.groupBy({
      by: ['marketplace', 'date'],
      where: { entityType: 'CAMPAIGN', date: { gte: prev.start, lt: end } },
      _sum: { costMicros: true },
    }),
  ])

  // Build per-marketplace daily arrays for this + previous month.
  interface MktSpend { thisDaily: number[]; prevDaily: number[]; thisTotal: number; prevTotal: number }
  const spend = new Map<string, MktSpend>()
  const ensure = (mkt: string): MktSpend => {
    let s = spend.get(mkt)
    if (!s) { s = { thisDaily: Array(daysInMonth).fill(0), prevDaily: Array(prev.daysInMonth).fill(0), thisTotal: 0, prevTotal: 0 }; spend.set(mkt, s) }
    return s
  }
  for (const r of spendRows) {
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

  // Calendar-weighted expected pace: sum of pct for days 1..dayOfMonth ÷ 100,
  // falling back to even daily split when no calendar is set.
  const evenExpected = daysInMonth > 0 ? dayOfMonth / daysInMonth : 0

  const buildMarketRow = (marketplace: string): BudgetPlanRow => {
    const p = thisTagNullByMkt.get(marketplace) ?? null
    const s = spend.get(marketplace)
    const monthlyBudgetCents = p?.monthlyBudgetCents ?? 0
    const calendar = ((p?.calendar as Array<{ day: number; pct: number }>) ?? [])
    const limits = ((p?.campaignLimits as unknown as CampaignLimit[]) ?? [])
    const spendCents = s?.thisTotal ?? 0
    const pct = monthlyBudgetCents > 0 ? spendCents / monthlyBudgetCents : null
    const expectedPct = calendar.length
      ? calendar.filter((c) => c.day <= dayOfMonth).reduce((acc, c) => acc + c.pct, 0) / 100
      : evenExpected
    let status: BudgetPlanRow['status'] = 'on-track'
    if (monthlyBudgetCents <= 0) status = 'no-budget'
    else if (pct != null && pct > expectedPct + 0.1) status = 'over'
    else if (pct != null && pct < expectedPct - 0.1) status = 'under'
    const forecastSpendCents = dayOfMonth > 0 ? Math.round((spendCents / dayOfMonth) * daysInMonth) : null
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
      campaignLimitCount: limits.length,
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
      campaignLimitCount: ((p.campaignLimits as unknown as CampaignLimit[]) ?? []).length,
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
    totals: { budgetCents, spendCents, pct: budgetCents > 0 ? spendCents / budgetCents : null, lastMonthSpendCents, nextMonthBudgetCents },
  }
}

// ── Per-marketplace campaign list + limits (the "More" view) ───────────────

export interface BmCampaignRow { id: string; name: string; status: string; dailyBudgetCents: number; minCents: number | null; maxCents: number | null }
export async function listBudgetManagerCampaigns(opts: { marketplace: string; month: string }): Promise<{ marketplace: string; month: string; planId: string | null; campaigns: BmCampaignRow[] }> {
  const plan = await prisma.adBudgetPlan.findFirst({ where: { marketplace: opts.marketplace, month: opts.month, tag: null } })
  const limByCamp = new Map(((plan?.campaignLimits as unknown as CampaignLimit[]) ?? []).map((l) => [l.campaignId, l]))
  const camps = await prisma.campaign.findMany({
    where: { marketplace: opts.marketplace, status: { not: 'ARCHIVED' } },
    select: { id: true, name: true, status: true, dailyBudget: true },
    orderBy: { name: 'asc' },
  })
  return {
    marketplace: opts.marketplace, month: opts.month, planId: plan?.id ?? null,
    campaigns: camps.map((c) => {
      const l = limByCamp.get(c.id)
      return { id: c.id, name: c.name, status: c.status, dailyBudgetCents: Math.round(Number(c.dailyBudget ?? 0) * 100), minCents: l?.minCents ?? null, maxCents: l?.maxCents ?? null }
    }),
  }
}

/** Upsert a single campaign's min/max limit on the (marketplace, month) plan,
 *  creating the plan on demand so the operator can set limits before budget. */
export async function setCampaignLimit(opts: { marketplace: string; month: string; campaignId: string; minCents: number | null; maxCents: number | null; createdBy?: string }) {
  let plan = await prisma.adBudgetPlan.findFirst({ where: { marketplace: opts.marketplace, month: opts.month, tag: null } })
  if (!plan) plan = await prisma.adBudgetPlan.create({ data: { marketplace: opts.marketplace, tag: null, month: opts.month, createdBy: opts.createdBy ?? null } })
  const limits = ((plan.campaignLimits as unknown as CampaignLimit[]) ?? []).filter((l) => l.campaignId !== opts.campaignId)
  if (opts.minCents != null || opts.maxCents != null) limits.push({ campaignId: opts.campaignId, minCents: opts.minCents, maxCents: opts.maxCents })
  await prisma.adBudgetPlan.update({ where: { id: plan.id }, data: { campaignLimits: limits as never } })
  return { ok: true, planId: plan.id, count: limits.length }
}

// ── Plan CRUD ──────────────────────────────────────────────────────────────

export interface UpsertBudgetPlan { id?: string; marketplace: string; tag?: string | null; month: string; monthlyBudgetCents?: number; autoPacing?: boolean; stopOverSpend?: boolean; calendar?: Array<{ day: number; pct: number }>; campaignLimits?: CampaignLimit[]; createdBy?: string }
export async function upsertBudgetPlan(input: UpsertBudgetPlan) {
  if (input.id) {
    const data: Record<string, unknown> = {}
    for (const k of ['monthlyBudgetCents', 'autoPacing', 'stopOverSpend'] as const) if (input[k] !== undefined) data[k] = input[k]
    if (input.calendar !== undefined) data.calendar = input.calendar as never
    if (input.campaignLimits !== undefined) data.campaignLimits = input.campaignLimits as never
    return prisma.adBudgetPlan.update({ where: { id: input.id }, data })
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
