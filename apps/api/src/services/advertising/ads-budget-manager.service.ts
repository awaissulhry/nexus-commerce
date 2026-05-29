/**
 * AX3.10 — Budget Manager.
 *
 * Monthly budget per (marketplace, optional tag) with auto-pacing +
 * stop-over-spend guards and an optional per-day allocation calendar (for
 * tentpole events). Spend is read live from AmazonAdsDailyPerformance and
 * compared to budget + the expected pace-to-date, so operators see at a
 * glance whether each market is on/over/under budget. Only the plan is
 * stored (AdBudgetPlan); spend is never duplicated.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

export interface BudgetPlanRow {
  id: string; marketplace: string; tag: string | null; month: string
  monthlyBudgetCents: number; autoPacing: boolean; stopOverSpend: boolean
  calendar: Array<{ day: number; pct: number }>
  spendCents: number | null // null when tag-level (needs campaign tagging)
  pct: number | null // spend / budget
  expectedPct: number // pace-to-date (day / daysInMonth, or calendar-weighted)
  status: 'on-track' | 'over' | 'under' | 'no-budget'
}
export interface BudgetManagerResult {
  month: string; daysInMonth: number; dayOfMonth: number
  rows: BudgetPlanRow[]
  totals: { budgetCents: number; spendCents: number; pct: number | null }
}

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

export async function analyzeBudgetManager(opts: { month?: string } = {}): Promise<BudgetManagerResult> {
  const month = opts.month ?? currentMonth()
  const { start, end, daysInMonth, dayOfMonth } = monthBounds(month)

  const [plans, spendRows] = await Promise.all([
    prisma.adBudgetPlan.findMany({ where: { month }, orderBy: [{ marketplace: 'asc' }, { tag: 'asc' }] }),
    prisma.amazonAdsDailyPerformance.groupBy({ by: ['marketplace'], where: { entityType: 'CAMPAIGN', date: { gte: start, lt: end } }, _sum: { costMicros: true } }),
  ])
  const spendByMkt = new Map(spendRows.map((r) => [r.marketplace, Math.round(Number(r._sum.costMicros ?? 0) / 10_000)]))

  // Calendar-weighted expected pace: sum of pct for days 1..dayOfMonth ÷ 100,
  // falling back to even daily split when no calendar is set.
  const evenExpected = daysInMonth > 0 ? dayOfMonth / daysInMonth : 0

  const rows: BudgetPlanRow[] = plans.map((p) => {
    const calendar = (p.calendar as Array<{ day: number; pct: number }>) ?? []
    const spendCents = p.tag ? null : (spendByMkt.get(p.marketplace) ?? 0)
    const pct = p.monthlyBudgetCents > 0 && spendCents != null ? spendCents / p.monthlyBudgetCents : null
    const expectedPct = calendar.length
      ? calendar.filter((c) => c.day <= dayOfMonth).reduce((s, c) => s + c.pct, 0) / 100
      : evenExpected
    let status: BudgetPlanRow['status'] = 'on-track'
    if (p.monthlyBudgetCents <= 0) status = 'no-budget'
    else if (pct != null && pct > expectedPct + 0.1) status = 'over'
    else if (pct != null && pct < expectedPct - 0.1) status = 'under'
    return { id: p.id, marketplace: p.marketplace, tag: p.tag, month: p.month, monthlyBudgetCents: p.monthlyBudgetCents, autoPacing: p.autoPacing, stopOverSpend: p.stopOverSpend, calendar, spendCents, pct, expectedPct, status }
  })

  const budgetCents = rows.reduce((s, r) => s + r.monthlyBudgetCents, 0)
  const spendCents = rows.reduce((s, r) => s + (r.spendCents ?? 0), 0)
  return { month, daysInMonth, dayOfMonth, rows, totals: { budgetCents, spendCents, pct: budgetCents > 0 ? spendCents / budgetCents : null } }
}

export interface UpsertBudgetPlan { id?: string; marketplace: string; tag?: string | null; month: string; monthlyBudgetCents?: number; autoPacing?: boolean; stopOverSpend?: boolean; calendar?: Array<{ day: number; pct: number }>; createdBy?: string }
export async function upsertBudgetPlan(input: UpsertBudgetPlan) {
  if (input.id) {
    const data: Record<string, unknown> = {}
    for (const k of ['monthlyBudgetCents', 'autoPacing', 'stopOverSpend'] as const) if (input[k] !== undefined) data[k] = input[k]
    if (input.calendar !== undefined) data.calendar = input.calendar as never
    return prisma.adBudgetPlan.update({ where: { id: input.id }, data })
  }
  const plan = await prisma.adBudgetPlan.create({
    data: { marketplace: input.marketplace, tag: input.tag ?? null, month: input.month, monthlyBudgetCents: input.monthlyBudgetCents ?? 0, autoPacing: input.autoPacing ?? false, stopOverSpend: input.stopOverSpend ?? false, calendar: (input.calendar ?? []) as never, createdBy: input.createdBy ?? null },
  })
  logger.info('[AX3.10] upsertBudgetPlan create', { id: plan.id, marketplace: plan.marketplace, month: plan.month })
  return plan
}

export async function deleteBudgetPlan(id: string) {
  return prisma.adBudgetPlan.delete({ where: { id } }).catch(() => null)
}
