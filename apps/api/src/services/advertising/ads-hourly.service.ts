/**
 * E2 — the one definition of "hourly demand for these campaigns".
 *
 * Extracted verbatim from the dayparting heatmap route so window-fit reads the SAME numbers the
 * grid draws. This query is subtle in ways that were each a real defect once — whole weeks so every
 * weekday gets equal samples, boundaries from the DATABASE clock in the display timezone, today
 * excluded because it is partial, buckets floored at zero because ~3% of Marketing Stream rows are
 * negative restatements, and ratios derived AFTER flooring. A second copy would lose one of those
 * within a month, and the two surfaces would quietly disagree about when the account sells.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../db.js'

export interface HourlyCell {
  dow: number; hour: number
  costCents: number; salesCents: number
  orders: number; impressions: number; clicks: number
  acos: number | null; roas: number | null
}
export interface HourlyResult {
  cells: HourlyCell[]
  restatedCells: number
  meta: { from_day: Date; to_day: Date; days: bigint; first_day: Date | null; last_day: Date | null } | undefined
}

export const TZ_ALLOWED = new Set(['Europe/Rome', 'Europe/London', 'Europe/Madrid', 'Europe/Paris', 'Europe/Berlin', 'America/Los_Angeles', 'America/New_York', 'UTC'])

/** Whole weeks, clamped. The window is always a multiple of 7 days so weekday samples are equal. */
export function resolveWeeks(weeksRaw: unknown, windowDaysRaw?: unknown): { weeks: number; windowDays: number } {
  const raw = weeksRaw != null ? Number(weeksRaw) : Math.floor(Number(windowDaysRaw ?? 56) / 7)
  const weeks = Math.max(1, Math.min(26, Number.isFinite(raw) ? Math.floor(raw) : 8))
  return { weeks, windowDays: weeks * 7 }
}

export async function hourlyCells(opts: {
  campaignIds: string[]; windowDays: number; tz: string
  /**
   * FB.3d (2026-08-21) — an EXPLICIT local date window (`YYYY-MM-DD`, inclusive), for the shared
   * header range picker. When both are present they replace the trailing-weeks window; everything
   * else — DB-clock boundaries, today excluded, zero-flooring, ratios after flooring — is the same
   * code path, which is the whole reason this lives here and not in a second query.
   *
   * `toDay` is clamped to yesterday IN SQL (`LEAST(..., now()::date - 1)`): the in-progress day is
   * partial by definition, and the clamp uses the DATABASE clock in the display timezone for the
   * same reason the weeks path does. ⚠ An arbitrary range loses the whole-weeks guarantee of equal
   * weekday samples (the 11–33% bias DPS.4b measured) — the CALLER must disclose that whenever the
   * resolved span is not a multiple of 7.
   */
  fromDay?: string; toDay?: string
}): Promise<HourlyResult> {
  const { campaignIds: ids, windowDays, tz, fromDay, toDay } = opts
  if (!ids.length) return { cells: [], restatedCells: 0, meta: undefined }
  const camps = await prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, externalCampaignId: true } })
      if (!camps.length) return { cells: [], restatedCells: 0, meta: undefined }
      const localIds = camps.map((c) => c.id)
      const extIds = camps.map((c) => c.externalCampaignId).filter(Boolean) as string[]
      const scope = Prisma.sql`("localEntityId" IN (${Prisma.join(localIds)})${extIds.length ? Prisma.sql` OR "entityId" IN (${Prisma.join(extIds)})` : Prisma.empty})`
      const explicit = !!(fromDay && toDay)
      // The two local-date bounds of the window, inclusive start / inclusive end (end ≤ yesterday).
      const startDay = explicit
        ? Prisma.sql`(${fromDay}::date)`
        : Prisma.sql`((now() AT TIME ZONE ${tz})::date - ${windowDays}::int)`
      const endDay = explicit
        ? Prisma.sql`(LEAST(${toDay}::date, (now() AT TIME ZONE ${tz})::date - 1))`
        : Prisma.sql`((now() AT TIME ZONE ${tz})::date - 1)`
      // Rows converted to local wall-clock and clipped to the window. The coarse `date` bounds keep
      // the index usable; the exact bound is on ts_local, because the window is a LOCAL one.
      const windowed = Prisma.sql`
        SELECT t.ts_local, t."costMicros", t."orders7d", t."sales7dCents", t."impressions", t."clicks"
        FROM (
          SELECT (("date" + (("hour")::text || ' hours')::interval) AT TIME ZONE 'UTC' AT TIME ZONE ${tz}) AS ts_local,
                 "costMicros", "orders7d", "sales7dCents", "impressions", "clicks"
          FROM "AmazonAdsHourlyPerformance"
          WHERE "entityType" = 'CAMPAIGN'
            AND "date" >= (${startDay} - 2)
            AND "date" <= (${endDay} + 2)
            AND ${scope}
        ) t
        WHERE t.ts_local >= (${startDay})::timestamp
          AND t.ts_local <  ((${endDay}) + 1)::timestamp`

      const rows = await prisma.$queryRaw<Array<{ dow: number; hour: number; cost: bigint | null; orders: bigint | null; sales: bigint | null; impressions: bigint | null; clicks: bigint | null }>>`
        SELECT EXTRACT(DOW FROM ts_local)::int AS dow,
               EXTRACT(HOUR FROM ts_local)::int AS hour,
               SUM("costMicros") AS cost, SUM(COALESCE("orders7d", 0)) AS orders,
               SUM(COALESCE("sales7dCents", 0)) AS sales, SUM("impressions") AS impressions, SUM("clicks") AS clicks
        FROM (${windowed}) w
        GROUP BY dow, hour ORDER BY dow, hour`

      // What the window actually resolved to, and how much of it holds data. Marketing Stream is
      // never backfilled, so a 13-week window over a 4-week-old campaign is mostly empty — the UI
      // states this rather than letting the operator read a sparse grid as a real pattern.
      const meta = await prisma.$queryRaw<Array<{ from_day: Date; to_day: Date; days: bigint; first_day: Date | null; last_day: Date | null }>>`
        SELECT ${startDay} AS from_day,
               ${endDay} AS to_day,
               (SELECT COUNT(DISTINCT ts_local::date) FROM (${windowed}) w2) AS days,
               (SELECT MIN(ts_local)::date FROM (${windowed}) w3) AS first_day,
               (SELECT MAX(ts_local)::date FROM (${windowed}) w4) AS last_day`
      const m = meta[0]
      const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null)

      /**
       * DPS.4b — floor every bucket at zero, and say how often that was needed.
       *
       * ~3% of Marketing Stream rows are RESTATEMENTS carrying negative counts (Amazon retracting
       * invalid traffic). When the correction lands inside the window but the original it corrects
       * falls outside it, the bucket nets below zero — measured live: two buckets at −1 impression.
       * A negative impression count is not a fact about any hour, and the grid renders anything ≤ 0
       * as "0", so those buckets silently made the visible cells disagree with the totals.
       *
       * Flooring makes every cell a number you can defend, and `restatedCells` keeps it visible
       * rather than swallowed — silently clamping would be the same class of mistake.
       */
      const floor0 = (n: number) => (n > 0 ? n : 0)
      let restatedCells = 0
      const cells: HourlyCell[] = rows.map((r) => {
        const rawCost = Math.round(Number(r.cost ?? 0n) / 10_000)
        const rawSales = Number(r.sales ?? 0n)
        const rawOrders = Number(r.orders ?? 0n)
        const rawImpr = Number(r.impressions ?? 0n)
        const rawClicks = Number(r.clicks ?? 0n)
        if (rawCost < 0 || rawSales < 0 || rawOrders < 0 || rawImpr < 0 || rawClicks < 0) restatedCells++
        const costCents = floor0(rawCost)
        const salesCents = floor0(rawSales)
        return {
          dow: r.dow, hour: r.hour, costCents, salesCents,
          orders: floor0(rawOrders), impressions: floor0(rawImpr), clicks: floor0(rawClicks),
          // derived AFTER flooring, so a ratio can never be built from a negative component
          acos: salesCents > 0 ? Math.round((costCents / salesCents) * 1000) / 10 : null,
          roas: costCents > 0 ? Math.round((salesCents / costCents) * 100) / 100 : null,
        }
      })
  return { cells, restatedCells, meta: m }
}
