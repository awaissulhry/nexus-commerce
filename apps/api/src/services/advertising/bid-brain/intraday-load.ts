/**
 * BID BRAIN BB-17 — the intraday brakes' reads (intraday.ts decides). For the campaigns the brain owns in one market, a
 * fixed set of small queries whatever the number of campaigns (no N+1), summed in SQL so only a few rows per campaign cross
 * the wire (Neon cost). Nothing here writes.
 *
 *   campaign grain   AmazonAdsHourlyPerformance CAMPAIGN rows (the Marketing Stream, UTC hours, as the spend guard and the
 *                    money brain read them): today per hour with the newest arrival; the last 28 complete days per hour
 *                    (the spend curve, and the 1-day sales curve — the grain's 7d-named columns hold 1-day conversions,
 *                    design F2); the last 14 complete days per day (the planned day's median)
 *   placement grain  the last two UTC hours per placement lane, today and the same hours of the days before (BB-16,
 *                    ams-grain.service.ts loadPlacementHours: only those hours), and the days the grain capped
 *   money plan       the money brain's newest plan of today per product in the market (AdsBrainBudgetDecision): each
 *                    campaign's expected spend — the day's planned spend where it has one
 *   budget           Campaign.dailyBudget now (after any ladder rung of today)
 *   settings         the Owner's VALUE overrides of the intraday settings (brain/settings.ts: campaign > product > the
 *                    brain's default), a campaign's product being the one family all its ad groups advertise
 * NEXUS_BID_BRAIN_INTRADAY=off reads nothing. A failed read is logged and leaves the brakes out (the run decides as
 * without them): never a brake on data that could not be read.
 */
import { Prisma } from '@prisma/client'
import { marketLimitsOf } from '@nexus/shared/ads-market-limits'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { MANAGED_PLACEMENTS } from '../ads-placement-math.js'
import { loadPlacementHours } from '../ams-grain.service.js'
import { resolveBrainSettings, type OverrideRow } from '../brain/settings.js'
import type { MarketRows } from './facts.js'
import { laneOf } from './plan-hour.js'
import {
  campaignBrakes, CPC_DAYS, CURVE_DAYS, INTRADAY_SETTING_KEYS, intradayClock, intradayMode, PLANNED_DAYS, STREAM_SILENT_HOURS, thresholdsOf,
  type CampaignBrakes, type CampaignHours, type IntradayRun, type LaneWindow, type PoolHours,
} from './intraday.js'

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const cents = (micros: bigint | number | null | undefined) => Number(micros ?? 0) / 10_000
const dayOf = (d: Date) => d.toISOString().slice(0, 10)
const shift = (day: string, by: number) => dayOf(new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS))
const zeros = () => Array.from({ length: 24 }, () => 0)

/** Each campaign's product for the settings: the one family every ad group of it advertises (null: none, or several). */
export function campaignProducts(m: Pick<MarketRows, 'adGroups'>, campaignIds: readonly string[]): Map<string, string | null> {
  const families = new Map<string, Set<string>>()
  for (const g of m.adGroups.values()) {
    if (!campaignIds.includes(g.campaignId)) continue
    const set = families.get(g.campaignId) ?? new Set<string>()
    for (const f of g.families) set.add(f)
    families.set(g.campaignId, set)
  }
  return new Map(campaignIds.map((id) => { const f = families.get(id); return [id, f && f.size === 1 ? [...f][0] : null] }))
}

/** The money brain's expected spend today per campaign (its newest plan of today per product; the higher of two). */
async function moneyPlanSpend(market: string, day: string, campaignIds: readonly string[]): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<Array<{ campaignId: string; expected: number | null }>>(Prisma.sql`
    SELECT c ->> 'campaignId' AS "campaignId",
           CASE WHEN jsonb_typeof(c -> 'expectedSpendCents') = 'number' THEN (c ->> 'expectedSpendCents')::float8 END AS expected
      FROM (SELECT DISTINCT ON (d."productId") d.plan FROM "AdsBrainBudgetDecision" d
             WHERE d.marketplace = ${market} AND d.day = ${day}::date
             ORDER BY d."productId", d."createdAt" DESC) p
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p.plan -> 'campaigns') = 'array' THEN p.plan -> 'campaigns' ELSE '[]'::jsonb END) c
     WHERE c ->> 'campaignId' = ANY(${[...campaignIds]}::text[])`)
  const out = new Map<string, number>()
  for (const r of rows) if (r.expected != null && r.expected > 0) out.set(r.campaignId, Math.max(out.get(r.campaignId) ?? 0, Number(r.expected)))
  return out
}

/**
 * The intraday brakes of the campaigns the brain owns in one market at `now` (the database clock, as the spend guard reads
 * it). Undefined: switched off, nothing owned, or the read failed (logged).
 */
export async function loadIntraday(m: MarketRows, campaignIds: readonly string[], now: Date): Promise<IntradayRun | undefined> {
  const mode = intradayMode()
  if (mode === 'off' || !campaignIds.length) return undefined
  try {
    return await readIntraday(m, [...new Set(campaignIds)].sort(), now, mode)
  } catch (err) {
    logger.warn('[bid-brain] intraday brakes could not be read — the run decides without them', { market: m.market, error: err instanceof Error ? err.message : String(err) })
    return undefined
  }
}

async function readIntraday(m: MarketRows, ids: string[], now: Date, mode: 'shadow' | 'on'): Promise<IntradayRun> {
  const clock = intradayClock(now)
  const today = new Date(`${clock.day}T00:00:00Z`)
  const where = { entityType: 'CAMPAIGN', localEntityId: { in: ids } }
  const prevHour = (clock.hour + 23) % 24
  const productOf = campaignProducts(m, ids)
  const products = [...new Set([...productOf.values()].filter((p): p is string => !!p))]
  const [campaigns, todayRows, curveRows, dayRows, grain, plan, overrides] = await Promise.all([
    prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, dailyBudget: true } }),
    prisma.amazonAdsHourlyPerformance.groupBy({ by: ['localEntityId', 'hour'], where: { ...where, date: today }, _sum: { costMicros: true }, _max: { reportedAt: true } }),
    prisma.amazonAdsHourlyPerformance.groupBy({
      by: ['localEntityId', 'hour'], where: { ...where, date: { gte: new Date(today.getTime() - CURVE_DAYS * DAY_MS), lt: today } },
      _sum: { costMicros: true, sales7dCents: true, orders7d: true },
    }),
    prisma.amazonAdsHourlyPerformance.groupBy({ by: ['localEntityId', 'date'], where: { ...where, date: { gte: new Date(today.getTime() - PLANNED_DAYS * DAY_MS), lt: today } }, _sum: { costMicros: true } }),
    loadPlacementHours({ campaignIds: ids, now, timeZone: 'UTC', pastDays: CPC_DAYS + 1, utcHours: [clock.hour, prevHour] }),
    moneyPlanSpend(m.market, clock.day, ids),
    prisma.adsBrainOverride.findMany({
      where: { endedAt: null, kind: 'VALUE', key: { in: [...INTRADAY_SETTING_KEYS] }, OR: [{ scope: 'CAMPAIGN', campaignId: { in: ids } }, ...(products.length ? [{ scope: 'PRODUCT', marketplace: m.market, productId: { in: products } }] : [])] },
      select: { id: true, productId: true, marketplace: true, scope: true, campaignId: true, kind: true, key: true, ref: true, value: true, by: true, reason: true, createdAt: true, endedAt: true },
    }) as Promise<OverrideRow[]>,
  ])
  const run: IntradayRun = { mode, brakes: new Map(), gaps: [], campaigns: ids.length }

  // The feed silent for these campaigns (both grains): no brake judges a day it cannot see.
  let newest: Date | null = grain.lastArrivalAt
  for (const r of todayRows) if (r._max.reportedAt && (!newest || r._max.reportedAt > newest)) newest = r._max.reportedAt
  if (clock.hour >= STREAM_SILENT_HOURS && (!newest || now.getTime() - newest.getTime() > STREAM_SILENT_HOURS * HOUR_MS)) {
    return { ...run, gaps: [`the hourly feed has sent nothing for these campaigns ${newest ? `since ${newest.toISOString().slice(11, 16)} UTC` : 'today'} (${STREAM_SILENT_HOURS} hours or more)`] }
  }

  const hours = new Map<string, CampaignHours & { todayCents: number[]; curveCents: number[]; salesCurveCents: number[]; dailyCents: number[]; lanes: LaneWindow[] }>()
  const of = (id: string) => {
    let h = hours.get(id)
    if (!h) { h = { todayCents: zeros(), curveCents: zeros(), salesCurveCents: zeros(), orders: 0, dailyCents: [], moneyPlanCents: plan.get(id) ?? null, budgetCents: null, lanes: [] }; hours.set(id, h) }
    return h
  }
  for (const id of ids) of(id)
  for (const c of campaigns) {
    const b = c.dailyBudget == null ? null : Math.round(Number(c.dailyBudget) * 100)
    of(c.id).budgetCents = b != null && Number.isFinite(b) && b > 0 ? b : null
  }
  for (const r of todayRows) if (r.localEntityId && hours.has(r.localEntityId)) of(r.localEntityId).todayCents[r.hour] += cents(r._sum.costMicros)
  const pool: PoolHours & { curveCents: number[]; salesCurveCents: number[] } = { curveCents: zeros(), salesCurveCents: zeros(), orders: 0 }
  for (const r of curveRows) {
    if (!r.localEntityId || !hours.has(r.localEntityId)) continue
    const h = of(r.localEntityId)
    const spend = cents(r._sum.costMicros)
    const sales = Number(r._sum.sales7dCents ?? 0)
    const orders = Number(r._sum.orders7d ?? 0)
    h.curveCents[r.hour] += spend; h.salesCurveCents[r.hour] += sales; h.orders += orders
    pool.curveCents[r.hour] += spend; pool.salesCurveCents[r.hour] += sales; pool.orders += orders
  }
  for (const r of dayRows) if (r.localEntityId && hours.has(r.localEntityId)) of(r.localEntityId).dailyCents.push(cents(r._sum.costMicros))

  // The placement windows: this hour and the one before, today and on each of the CPC_DAYS days before.
  const cell = new Map<string, { spendCents: number; clicks: number; late: boolean }>()
  for (const c of grain.cells) {
    if (!(MANAGED_PLACEMENTS as readonly string[]).includes(c.placement)) continue
    cell.set(`${c.campaignId}|${c.placement}|${c.day}|${c.hour}`, { spendCents: c.spendCents, clicks: c.clicks, late: c.lateStart })
  }
  const windowOf = (campaignId: string, placement: string, day: string) => {
    const keys = [`${campaignId}|${placement}|${day}|${clock.hour}`, clock.hour > 0 ? `${campaignId}|${placement}|${day}|${prevHour}` : `${campaignId}|${placement}|${shift(day, -1)}|23`]
    const parts = keys.map((k) => cell.get(k)).filter((x): x is { spendCents: number; clicks: number; late: boolean } => !!x)
    return { spendCents: parts.reduce((n, p) => n + p.spendCents, 0), clicks: parts.reduce((n, p) => n + p.clicks, 0), late: parts.some((p) => p.late) }
  }
  for (const id of ids) {
    for (const placement of MANAGED_PLACEMENTS) {
      const t = windowOf(id, placement, clock.day)
      const past = Array.from({ length: CPC_DAYS }, (_, k) => { const day = shift(clock.day, -(k + 1)); const w = windowOf(id, placement, day); return { day, spendCents: w.spendCents, clicks: w.clicks } })
      if (!t.clicks && !past.some((d) => d.clicks > 0)) continue
      of(id).lanes.push({ lane: laneOf(placement), today: t, past })
    }
  }

  const cappedDays = new Set(grain.cappedDays.filter((d) => d.kind === 'rows').map((d) => d.date))
  const currency = marketLimitsOf(m.market)?.currency ?? 'EUR'
  const brakes = new Map<string, CampaignBrakes>()
  for (const id of ids) {
    const s = resolveBrainSettings({ productId: productOf.get(id) ?? '', market: m.market, campaignId: id, enrolled: false, overrides })
    const t = thresholdsOf(Object.fromEntries(INTRADAY_SETTING_KEYS.map((k) => [k, s.values[k].value])))
    const h = of(id)
    brakes.set(id, campaignBrakes({ ...h, curveCents: h.curveCents.some((x) => x > 0) ? h.curveCents : null, salesCurveCents: h.salesCurveCents.some((x) => x > 0) ? h.salesCurveCents : null }, { pool, t, clock, cappedDays, currency }))
  }
  return { ...run, brakes }
}
