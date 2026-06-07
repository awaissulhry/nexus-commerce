/**
 * DP.1 — Orders-sourced dayparting demand intelligence.
 *
 * The Amazon Marketing Stream hourly ad table (AmazonAdsHourlyPerformance) is
 * dormant on prod, so the real hour-of-day signal comes from the orders we
 * already ingest. This aggregates Order ⨝ OrderItem into a weekday × hour grid
 * in Europe/Rome wall-clock — per channel, market, and (optionally) product —
 * then surfaces the peak/trough hours and a contiguous "bid up here" window the
 * operator can push straight into an AdSchedule (AX.9).
 *
 * Channel-parameterized by design: `channel` defaults to AMAZON, but the SQL
 * casts the OrderChannel enum to text so a later eBay/Shopify pass is additive
 * UI only — no service change.
 *
 * TZ correctness: Prisma DateTime maps to a Postgres `timestamp` (no zone). A
 * single `AT TIME ZONE 'Europe/Rome'` INVERTS the conversion (documented trap);
 * the correct read is the double-cast `… AT TIME ZONE 'UTC' AT TIME ZONE
 * 'Europe/Rome'`, matching the dashboard + CD.12 heatmaps.
 */

import { Prisma } from '@prisma/client'
import prisma from '../../db.js'

export type DaypartMetric = 'revenue' | 'orders' | 'units'

export interface OrdersDaypartingOpts {
  channel?: string                  // OrderChannel value as text; default 'AMAZON'
  marketplace?: string | string[]   // IT/DE/FR/ES…; omit = all markets
  productId?: string                 // scope to one product (OrderItem.productId)
  productIds?: string[]              // scope to a product family (parent + variants); rolls up children
  sku?: string                       // scope to one SKU (OrderItem.sku)
  skus?: string[]                    // RD.10g — scope to a family's SKUs; the RELIABLE key (matched OR'd with productIds, since OrderItem.productId is often null while sales are SKU-keyed)
  from?: Date                        // explicit range start (inclusive)
  to?: Date                          // explicit range end (exclusive)
  windowDays?: number                // alternative to from/to; default 90
  metric?: DaypartMetric             // drives index + peak/trough detection; default 'revenue'
  timezone?: string                  // RM1 — IANA tz to bucket day×hour in; default Europe/Rome (IT). Pass the market's tz for non-IT.
}

export interface DaypartBucket { orders: number; units: number; revenueCents: number }
export interface DaypartProfile extends DaypartBucket { key: number; index: number | null }
export interface RecommendedWindow { days: number[]; startHour: number; endHour: number }

export interface OrdersDaypartingResult {
  timezone: string
  channel: string
  metric: DaypartMetric
  from: string
  to: string
  totals: DaypartBucket
  grid: DaypartBucket[][]            // [dow 0=Sun..6=Sat][hour 0..23]
  hourProfile: DaypartProfile[]      // length 24, key = hour
  weekdayProfile: DaypartProfile[]   // length 7,  key = dow (0=Sun..6=Sat)
  peakHours: number[]                // metric index ≥ 1.2
  troughHours: number[]              // metric index < 0.6
  recommendedWindow: RecommendedWindow | null
  hasData: boolean
  currencyNote: string               // revenue is EUR-only (non-EUR markets excluded)
}

// Index thresholds match ads-dayparting-intel.service.ts (bid-up ≥1.2, bid-down <0.6).
const PEAK = 1.2
const TROUGH = 0.6

const metricOf = (b: DaypartBucket, m: DaypartMetric): number =>
  m === 'revenue' ? b.revenueCents : m === 'orders' ? b.orders : b.units

interface Row { dow: number; hour: number; orders: bigint; units: bigint; cents: bigint }

export async function aggregateOrdersDayparting(
  opts: OrdersDaypartingOpts = {},
): Promise<OrdersDaypartingResult> {
  const channel = opts.channel ?? 'AMAZON'
  const metric: DaypartMetric = opts.metric ?? 'revenue'
  const to = opts.to ?? new Date()
  const from = opts.from ?? new Date(to.getTime() - (opts.windowDays ?? 90) * 86_400_000)
  const tz = opts.timezone ?? 'Europe/Rome' // RM1 — bucket in the market's local time, not always Rome

  const mkts = opts.marketplace == null ? [] : Array.isArray(opts.marketplace) ? opts.marketplace : [opts.marketplace]
  const hasProductIds = !!(opts.productIds && opts.productIds.length)
  const hasSkus = !!(opts.skus && opts.skus.length)
  const needsItemFilter = !!opts.productId || !!opts.sku || hasProductIds || hasSkus

  // Inner join when scoping to a product/sku (only count buckets where that item
  // actually sold); LEFT join otherwise so item-less orders still count toward `orders`.
  const joinFrag = needsItemFilter
    ? Prisma.sql`JOIN "OrderItem" oi ON oi."orderId" = o.id`
    : Prisma.sql`LEFT JOIN "OrderItem" oi ON oi."orderId" = o.id`
  const mktFrag = mkts.length ? Prisma.sql`AND o."marketplace" IN (${Prisma.join(mkts)})` : Prisma.empty
  // RD.10g — a family is matched by productId OR sku (OR'd together). OrderItem.productId
  // is often null while the whole sales pipeline is SKU-keyed, so SKU is the reliable key;
  // matching both captures every variant's orders without undercounting.
  const orClauses: Prisma.Sql[] = []
  if (hasProductIds) orClauses.push(Prisma.sql`oi."productId" IN (${Prisma.join(opts.productIds as string[])})`)
  if (hasSkus) orClauses.push(Prisma.sql`oi."sku" IN (${Prisma.join(opts.skus as string[])})`)
  if (opts.productId) orClauses.push(Prisma.sql`oi."productId" = ${opts.productId}`)
  if (opts.sku) orClauses.push(Prisma.sql`oi."sku" = ${opts.sku}`)
  const prodFrag = orClauses.length ? Prisma.sql`AND (${Prisma.join(orClauses, ' OR ')})` : Prisma.empty
  const skuFrag = Prisma.empty // folded into prodFrag

  // Single pass: bucket by Rome-local (dow, hour). COALESCE(purchaseDate, createdAt)
  // because purchaseDate is nullable (universal Order-read convention). COUNT(DISTINCT
  // o.id) so a multi-line order counts once. Revenue summed as integer cents, EUR-only.
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT
      EXTRACT(DOW  FROM (COALESCE(o."purchaseDate", o."createdAt") AT TIME ZONE 'UTC' AT TIME ZONE ${tz}))::int AS dow,
      EXTRACT(HOUR FROM (COALESCE(o."purchaseDate", o."createdAt") AT TIME ZONE 'UTC' AT TIME ZONE ${tz}))::int AS hour,
      COUNT(DISTINCT o.id)::bigint                                       AS orders,
      COALESCE(SUM(oi."quantity"), 0)::bigint                            AS units,
      COALESCE(SUM(CASE WHEN COALESCE(o."currencyCode", 'EUR') = 'EUR' THEN ROUND(oi."price" * oi."quantity" * 100) ELSE 0 END), 0)::bigint AS cents
    FROM "Order" o
    ${joinFrag}
    WHERE o."deletedAt" IS NULL
      AND o."status"::text <> 'CANCELLED'
      AND o."cancelledAt" IS NULL
      AND o."channel"::text = ${channel}
      AND COALESCE(o."purchaseDate", o."createdAt") >= ${from}
      AND COALESCE(o."purchaseDate", o."createdAt") <  ${to}
      ${mktFrag}
      ${prodFrag}
      ${skuFrag}
    GROUP BY 1, 2
    ORDER BY 1, 2
  `

  // Fold into a zero-filled grid; Number()-coerce every bigint (no global serializer).
  const grid: DaypartBucket[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ orders: 0, units: 0, revenueCents: 0 })))
  const totals: DaypartBucket = { orders: 0, units: 0, revenueCents: 0 }
  for (const r of rows) {
    const d = Number(r.dow), h = Number(r.hour)
    if (d < 0 || d > 6 || h < 0 || h > 23) continue
    const cell = grid[d][h]
    cell.orders += Number(r.orders)
    cell.units += Number(r.units)
    cell.revenueCents += Number(r.cents)
    totals.orders += Number(r.orders)
    totals.units += Number(r.units)
    totals.revenueCents += Number(r.cents)
  }

  // Hour-of-day profile: sum each hour across all 7 days.
  const hourProfile: DaypartProfile[] = Array.from({ length: 24 }, (_, h) => {
    const b: DaypartBucket = { orders: 0, units: 0, revenueCents: 0 }
    for (let d = 0; d < 7; d++) { b.orders += grid[d][h].orders; b.units += grid[d][h].units; b.revenueCents += grid[d][h].revenueCents }
    return { key: h, ...b, index: null }
  })
  // Weekday profile: sum each day across 24 hours.
  const weekdayProfile: DaypartProfile[] = Array.from({ length: 7 }, (_, d) => {
    const b: DaypartBucket = { orders: 0, units: 0, revenueCents: 0 }
    for (let h = 0; h < 24; h++) { b.orders += grid[d][h].orders; b.units += grid[d][h].units; b.revenueCents += grid[d][h].revenueCents }
    return { key: d, ...b, index: null }
  })

  // index = bucket metric ÷ mean across buckets (null when mean = 0, no divide-by-zero).
  const hourMean = hourProfile.reduce((s, b) => s + metricOf(b, metric), 0) / 24
  for (const b of hourProfile) b.index = hourMean > 0 ? metricOf(b, metric) / hourMean : null
  const wdMean = weekdayProfile.reduce((s, b) => s + metricOf(b, metric), 0) / 7
  for (const b of weekdayProfile) b.index = wdMean > 0 ? metricOf(b, metric) / wdMean : null

  const peakHours = hourProfile.filter((b) => b.index != null && b.index >= PEAK).map((b) => b.key)
  const troughHours = hourProfile.filter((b) => b.index != null && b.index < TROUGH).map((b) => b.key)

  // Longest contiguous run of peak hours (linear 0..23 — real demand peaks are
  // daytime/evening and don't wrap midnight). endHour is EXCLUSIVE to match the
  // cron's `hour >= startHour && hour < endHour` test (ad-dayparting.job.ts).
  let recommendedWindow: RecommendedWindow | null = null
  if (peakHours.length) {
    const isPeak = Array.from({ length: 24 }, (_, h) => peakHours.includes(h))
    let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0
    for (let h = 0; h < 24; h++) {
      if (isPeak[h]) { if (curLen === 0) curStart = h; curLen++; if (curLen > bestLen) { bestLen = curLen; bestStart = curStart } }
      else { curLen = 0 }
    }
    // Deliver on every weekday that isn't a clear trough (or has no signal yet).
    const days = weekdayProfile.filter((d) => d.index == null || d.index >= TROUGH).map((d) => d.key)
    recommendedWindow = { days: days.length ? days : [0, 1, 2, 3, 4, 5, 6], startHour: bestStart, endHour: bestStart + bestLen }
  }

  return {
    timezone: tz,
    channel,
    metric,
    from: from.toISOString(),
    to: to.toISOString(),
    totals,
    grid,
    hourProfile,
    weekdayProfile,
    peakHours,
    troughHours,
    recommendedWindow,
    hasData: totals.orders > 0,
    currencyNote: 'Orders/units count every currency; revenue is EUR-only (non-EUR markets contribute 0 to revenue — use the orders/units metric for them).',
  }
}
