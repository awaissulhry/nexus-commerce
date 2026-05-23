/**
 * DA-RT.13 — Shared sales-drift audit helper.
 *
 * Extracts the SQL + merge logic out of sales-drift-detector.job.ts so
 * the cron and the new admin observability endpoint share a single
 * source of truth. Returns the raw 3-way comparison data without
 * publishing events or logging — callers decide what to do with it.
 *
 * Behaviour matches DA-RT.10 exactly:
 *   - Europe/Rome TZ bucketing for day keys
 *   - CANCELLED orders excluded (DA-RT.7 IVA semantics)
 *   - EUR-only headline (non-EUR markets handled by separate FX path)
 *   - financialCents = null when Store C has no rows for the window
 *     (distinct from 0, which is a real settled-€0 day)
 *   - Tolerance + pair-fan-out via the same buildDriftPairs/checkPair
 *     helpers the cron's unit tests cover (sales-drift-compare.test.ts)
 *
 * Callers
 *   - sales-drift-detector.job.ts cron (publishes events + logs warns)
 *   - GET /admin/sales-drift/audit endpoint (operator HTTP read)
 */

import prisma from '../../db.js'
import {
  buildDriftPairs,
  type DriftPair,
  type ThreeWaySums,
} from '../../jobs/_helpers/sales-drift-compare.js'

const OPERATOR_TIMEZONE = 'Europe/Rome'

/** YYYY-MM-DD for the local-tz calendar date of `d`. */
function isoLocalDay(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: OPERATOR_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

export interface DriftAuditWindow {
  /** YYYY-MM-DD (Europe/Rome). */
  day: string
  /** Amazon marketplace code (e.g. 'AMAZON.IT') or null for unscoped. */
  marketplace: string | null
  orderCents: number
  aggregateCents: number
  /** null when Amazon ListFinancialEvents hasn't settled yet. */
  financialCents: number | null
  /** Empty array when all 3 stores agree within tolerance. */
  driftPairs: DriftPair[]
}

export interface DriftAuditResult {
  lookbackDays: number
  /** Inclusive ISO local-day at start of window. */
  dayRangeStart: string
  /** Exclusive ISO local-day at end of window (today). */
  dayRangeEnd: string
  /** All (day, marketplace) windows the queries returned, in
   *  newest-day-first order. Includes both drifting AND in-tolerance
   *  windows so the operator can see "everything is fine" vs "no data". */
  windows: DriftAuditWindow[]
  /** Count of windows with at least one drifting pair. */
  driftedCount: number
  generatedAt: string
}

export interface AuditSalesDriftOptions {
  /** Defaults to 7. Today is always excluded (intraday drift is expected). */
  lookbackDays?: number
}

export async function auditSalesDrift(
  opts: AuditSalesDriftOptions = {},
): Promise<DriftAuditResult> {
  const lookback = opts.lookbackDays && opts.lookbackDays > 0 ? opts.lookbackDays : 7

  const now = new Date()
  const todayIso = isoLocalDay(now)
  const dayRangeEnd = new Date(`${todayIso}T00:00:00Z`)
  const dayRangeStart = new Date(
    dayRangeEnd.getTime() - lookback * 24 * 60 * 60_000,
  )

  const [orderRows, aggregateRows, financialRows] = await Promise.all([
    prisma.$queryRaw<
      Array<{ day: Date; marketplace: string | null; cents: bigint }>
    >`
      SELECT
        date_trunc('day', "purchaseDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Rome')::date AS day,
        "marketplace",
        COALESCE(SUM(ROUND("totalPrice" * 100)), 0)::bigint AS cents
      FROM "Order"
      WHERE "deletedAt" IS NULL
        AND "channel" = 'AMAZON'
        AND "currencyCode" = 'EUR'
        AND "status" != 'CANCELLED'
        AND "purchaseDate" >= ${dayRangeStart}
        AND "purchaseDate" <  ${dayRangeEnd}
      GROUP BY day, "marketplace"
    `,
    prisma.$queryRaw<
      Array<{ day: Date; marketplace: string | null; cents: bigint }>
    >`
      SELECT
        "day",
        "marketplace",
        COALESCE(SUM(ROUND("grossRevenue" * 100)), 0)::bigint AS cents
      FROM "DailySalesAggregate"
      WHERE "channel" = 'AMAZON'
        AND "day" >= ${dayRangeStart}::date
        AND "day" <  ${dayRangeEnd}::date
      GROUP BY "day", "marketplace"
    `,
    prisma.$queryRaw<
      Array<{ day: Date; marketplace: string | null; cents: bigint }>
    >`
      SELECT
        date_trunc('day', o."purchaseDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Rome')::date AS day,
        o."marketplace",
        COALESCE(SUM(ROUND(ft."amount" * 100)), 0)::bigint AS cents
      FROM "FinancialTransaction" ft
      JOIN "Order" o ON o.id = ft."orderId"
      WHERE o."deletedAt" IS NULL
        AND o."channel" = 'AMAZON'
        AND o."currencyCode" = 'EUR'
        AND o."status" != 'CANCELLED'
        AND o."purchaseDate" >= ${dayRangeStart}
        AND o."purchaseDate" <  ${dayRangeEnd}
        AND ft."transactionType" = 'Order'
      GROUP BY day, o."marketplace"
    `,
    // DA-RT.19 — query FinancialTransaction.amount (gross with tax),
    // not .grossRevenue (pre-tax). Order.totalPrice is gross with tax,
    // so the apples-to-apples comparison needs .amount. The .grossRevenue
    // field is still useful for revenue/profit reports where IVA is
    // a pass-through to the tax authority, but for the drift detector
    // we compare operator-facing totals.
  ])

  const merged = new Map<string, ThreeWaySums>()
  const keyFor = (day: Date, mkt: string | null): string =>
    `${day.toISOString().slice(0, 10)}|${mkt ?? 'NULL'}`

  const getOrCreate = (key: string): ThreeWaySums => {
    let existing = merged.get(key)
    if (!existing) {
      existing = { orderCents: 0, aggregateCents: 0, financialCents: null }
      merged.set(key, existing)
    }
    return existing
  }
  for (const r of orderRows) {
    getOrCreate(keyFor(r.day, r.marketplace)).orderCents = Number(r.cents)
  }
  for (const r of aggregateRows) {
    getOrCreate(keyFor(r.day, r.marketplace)).aggregateCents = Number(r.cents)
  }
  for (const r of financialRows) {
    getOrCreate(keyFor(r.day, r.marketplace)).financialCents = Number(r.cents)
  }

  const windows: DriftAuditWindow[] = []
  for (const [key, sums] of merged.entries()) {
    const [day, mktRaw] = key.split('|')
    const driftPairs = buildDriftPairs(sums)
    windows.push({
      day: day ?? '',
      marketplace: mktRaw === 'NULL' ? null : mktRaw ?? null,
      orderCents: sums.orderCents,
      aggregateCents: sums.aggregateCents,
      financialCents: sums.financialCents,
      driftPairs,
    })
  }
  windows.sort((a, b) =>
    a.day === b.day
      ? (a.marketplace ?? '').localeCompare(b.marketplace ?? '')
      : b.day.localeCompare(a.day),
  )

  return {
    lookbackDays: lookback,
    dayRangeStart: isoLocalDay(dayRangeStart),
    dayRangeEnd: todayIso,
    windows,
    driftedCount: windows.filter((w) => w.driftPairs.length > 0).length,
    generatedAt: now.toISOString(),
  }
}
