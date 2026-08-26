/**
 * RPT.11 — total-sales context: TACoS, the ad-vs-organic split, and wasted spend.
 *
 * Everything before this reported advertising in isolation, which cannot answer
 * the only question that matters at the top: is the advertising growing the
 * business, or just renting sales it would have made anyway? ACOS compares spend
 * to *attributed* sales; TACoS compares it to ALL sales, and the gap between the
 * two is the story.
 *
 * ── Two honesty constraints, both measured rather than assumed ──────────────
 *
 * 1. **COGS coverage is partial, and the caveat COUNTS it rather than claiming it.**
 *    This comment used to state that 0 of 362 products carried a cost price and that every
 *    ProductProfitDaily row had cogsCents = 0. Re-measured 2026-08-26: `Product.costPrice` is
 *    still unset on all 338 products, but 260 of 859 ProductProfitDaily rows now DO carry a
 *    non-zero COGS. A hardcoded count is a clock reading — it was right when written and wrong
 *    within weeks — so the coverage is counted per request and the caveat sentence is built from
 *    the answer. Waste itself stays *spend that produced no attributed sales* until coverage is
 *    complete; overstating it would be exactly the confident wrong number this series exists to
 *    prevent.
 *
 * 1b. 🔴 **RPX — this service aggregated the AMS DUPLICATES.** `AmazonAdsDailyPerformance` holds
 *    659 rows Amazon Marketing Stream wrote to the daily grain before AX2.3 stopped it, marked
 *    `reportRunId = 'ams-stream'` and excluded at read time by five other services. This was a
 *    sixth consumer that never adopted the guard, so every figure it returned for Italy was
 *    inflated. Measured on prod before the fix, last 90 days: IT ad spend €6,298.39 → €4,981.03
 *    (−26.4%) and IT ad sales €15,138.40 → €11,794.07 (−28.4%); DE, FR and ES were untouched
 *    because the stream only ever wrote IT rows (21 May – 27 Jul). ACOS, TACoS and the ad share
 *    all moved with them. The guard now comes from `excludeAmsDailySql` in ads-core/ams-daily,
 *    so the marker has ONE definition across the Prisma and SQL forms.
 *
 * 2. **Naive waste is a misleading headline.** "Any click with no sale" over the
 *    last 30 days measures €2,051 of €2,285 — 90% — which is nonsense: sales
 *    attribute over a 7-DAY WINDOW, so recent clicks have not had time to
 *    convert, and a single click with no sale is sampling, not waste. This
 *    excludes the unmatured tail and requires sustained clicks before calling
 *    spend wasted. Measured effect: 56% → 19.5%. The threshold is returned in the
 *    payload so the number is never a black box.
 */
import prisma from '../../db.js'
import { excludeAmsDailySql } from '../ads-core/ams-daily.js'

/** Amazon attributes sales over 7 days, so the last 7 days cannot be judged yet. */
const ATTRIBUTION_DAYS = 7
/** Clicks a term must accumulate before zero sales counts as waste rather than sampling. */
const DEFAULT_MIN_CLICKS = 5

export interface MarketContext {
  marketplace: string
  adSpend: number
  adSales: number
  totalSales: number
  /** spend ÷ attributed sales */
  acos: number | null
  /** spend ÷ TOTAL sales — the number that says what advertising costs the business */
  tacos: number | null
  /** share of total revenue attributable to ads */
  adShare: number | null
}

export interface WastedTerm {
  query: string
  marketplace: string
  clicks: number
  spend: number
}

/** One ISO week of the same four figures the totals are built from. */
export interface BusinessWeek {
  /** Monday of the ISO week, `YYYY-MM-DD`. */
  weekStart: string
  adSpend: number
  adSales: number
  totalSales: number
  tacos: number | null
  adShare: number | null
  /**
   * The week is not fully covered by BOTH feeds yet, or it is clipped by the requested
   * window. A partial week plotted solid beside complete ones reads as a collapse in the
   * business rather than a collapse in the calendar, so the client draws it hollow.
   */
  partial: boolean
}

export interface BusinessContext {
  window: { from: string; to: string }
  currency: string
  /** Markets the caller asked for; empty means every market. */
  marketplaces: string[]
  totals: MarketContext
  byMarket: MarketContext[]
  /** ISO-weekly series over the window, oldest first. Empty when the window holds no rows. */
  series: BusinessWeek[]
  /**
   * The last day BOTH feeds cover. Every week ending after it is `partial`, and this is the
   * date the client names when it says so.
   */
  completeThrough: string | null
  wasted: {
    amount: number
    terms: number
    /** Share of the spend examined, so the figure is never read without scale. */
    pctOfSpend: number
    minClicks: number
    /** The matured window waste is judged over — never includes the last 7 days. */
    maturedTo: string
    top: WastedTerm[]
  }
  caveats: string[]
  elapsedMs: number
}

const num = (v: unknown): number => {
  if (v == null) return 0
  const n = typeof v === 'bigint' ? Number(v) : Number(v as number)
  return Number.isFinite(n) ? n : 0
}
const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null)

export async function businessContext(opts: {
  from: string
  to: string
  minClicks?: number
  /** Restrict every figure to these markets. Empty / omitted = all of them. */
  marketplaces?: string[]
}): Promise<BusinessContext> {
  const started = Date.now()
  const minClicks = Math.max(1, opts.minClicks ?? DEFAULT_MIN_CLICKS)

  /**
   * Market codes are interpolated, not bound, because the weekly series needs the same
   * predicate inside three different statements. They are whitelisted to the shape a
   * marketplace code actually has first — anything else is dropped rather than escaped, so
   * nothing a caller sends can reach the SQL.
   */
  const marketFilter = (opts.marketplaces ?? []).filter((m) => /^[A-Z]{2,12}$/.test(m))
  const marketIn = (alias: string) =>
    (marketFilter.length ? ` AND ${alias}."marketplace" IN (${marketFilter.map((m) => `'${m}'`).join(', ')})` : '')

  // Waste is judged only over days old enough to have converted.
  const maturedTo = new Date(`${opts.to}T00:00:00Z`)
  maturedTo.setUTCDate(maturedTo.getUTCDate() - ATTRIBUTION_DAYS)
  const maturedToIso = maturedTo.toISOString().slice(0, 10)

  const [adRows, salesRows, wasteRow, topRows] = await Promise.all([
    // Ad spend and attributed sales, campaign grain so nothing double-counts.
    prisma.$queryRawUnsafe<Array<{ marketplace: string; spend: number; sales: number }>>(`
      SELECT p."marketplace",
             SUM(p."costMicros")::numeric / 1000000.0 AS spend,
             SUM(COALESCE(p."sales7dCents", 0))::numeric / 100.0 AS sales
      FROM "AmazonAdsDailyPerformance" p
      WHERE p."entityType" = 'CAMPAIGN' AND p."date" >= $1::date AND p."date" <= $2::date
        AND ${excludeAmsDailySql('p')}${marketIn('p')}
      GROUP BY 1`, opts.from, opts.to),

    // TOTAL sales — every order, advertised or not. Amazon only; see caveats.
    prisma.$queryRawUnsafe<Array<{ marketplace: string; total: number }>>(`
      SELECT s."marketplace", SUM(s."grossRevenue")::numeric AS total
      FROM "DailySalesAggregate" s
      WHERE s."channel" = 'AMAZON' AND s."day" >= $1::date AND s."day" <= $2::date${marketIn('s')}
      GROUP BY 1`, opts.from, opts.to),

    prisma.$queryRawUnsafe<Array<{ wasted: number; terms: number; examined: number }>>(`
      WITH term AS (
        SELECT t."query", t."marketplace",
               SUM(t."clicks")::int AS clicks,
               SUM(t."costMicros") / 1000000.0 AS cost,
               SUM(COALESCE(t."sales7dCents", 0)) AS sales_cents
        FROM "AmazonAdsSearchTerm" t
        WHERE t."date" >= $1::date AND t."date" <= $2::date${marketIn('t')}
        GROUP BY 1, 2
      )
      SELECT COALESCE(SUM(cost) FILTER (WHERE sales_cents = 0 AND clicks >= ${minClicks}), 0)::numeric AS wasted,
             COUNT(*) FILTER (WHERE sales_cents = 0 AND clicks >= ${minClicks})::int AS terms,
             COALESCE(SUM(cost), 0)::numeric AS examined
      FROM term`, opts.from, maturedToIso),

    prisma.$queryRawUnsafe<Array<{ query: string; marketplace: string; clicks: number; spend: number }>>(`
      SELECT t."query", t."marketplace", SUM(t."clicks")::int AS clicks,
             SUM(t."costMicros")::numeric / 1000000.0 AS spend
      FROM "AmazonAdsSearchTerm" t
      WHERE t."date" >= $1::date AND t."date" <= $2::date${marketIn('t')}
      GROUP BY 1, 2
      HAVING SUM(COALESCE(t."sales7dCents", 0)) = 0 AND SUM(t."clicks") >= ${minClicks}
      ORDER BY 4 DESC LIMIT 10`, opts.from, maturedToIso),
  ])

  const markets = new Map<string, MarketContext>()
  const get = (m: string) => {
    let e = markets.get(m)
    if (!e) {
      e = { marketplace: m, adSpend: 0, adSales: 0, totalSales: 0, acos: null, tacos: null, adShare: null }
      markets.set(m, e)
    }
    return e
  }
  for (const r of adRows) {
    const e = get(r.marketplace)
    e.adSpend += num(r.spend)
    e.adSales += num(r.sales)
  }
  for (const r of salesRows) get(r.marketplace).totalSales += num(r.total)

  const finish = (e: MarketContext) => {
    e.acos = ratio(e.adSpend, e.adSales)
    e.tacos = ratio(e.adSpend, e.totalSales)
    e.adShare = ratio(e.adSales, e.totalSales)
    return e
  }

  const byMarket = [...markets.values()].map(finish).sort((a, b) => b.totalSales - a.totalSales)
  const totals = finish(byMarket.reduce(
    (t, m) => ({ ...t, adSpend: t.adSpend + m.adSpend, adSales: t.adSales + m.adSales, totalSales: t.totalSales + m.totalSales }),
    { marketplace: 'ALL', adSpend: 0, adSales: 0, totalSales: 0, acos: null, tacos: null, adShare: null } as MarketContext,
  ))

  /**
   * The ISO-weekly series, built from the SAME two feeds and the same predicates as the
   * totals above — one definition of TACoS, so the headline and the chart cannot disagree.
   *
   * `DATE_TRUNC('week', ...)` is applied to a `date` column, not a timestamp, so no timezone
   * enters the grouping. Both sides are FULL OUTER joined: a week with spend and no sales is a
   * real week, and dropping it would flatter the trend.
   */
  /**
   * 🔴 The COGS caveat is MEASURED, never asserted.
   *
   * This service used to state as fact that "no product in this catalogue currently carries a
   * cost price" and that "every ProductProfitDaily row has cogsCents = 0". Both were true when
   * it was written and one of them has since stopped being: measured 2026-08-26, 260 of 859
   * `ProductProfitDaily` rows carry a non-zero COGS, while `Product.costPrice` is still unset
   * on all 338 products. A caveat that hardcodes a count is a clock reading, and a stale one
   * understates what the platform can now do. So the coverage is counted per request and the
   * sentence is built from what came back.
   */
  const [weekRows, boundsRow, cogsRow] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ week: string; spend: number; sales: number; total: number }>>(`
      WITH ad AS (
        SELECT DATE_TRUNC('week', p."date")::date AS wk,
               SUM(p."costMicros")::numeric / 1000000.0 AS spend,
               SUM(COALESCE(p."sales7dCents", 0))::numeric / 100.0 AS sales
        FROM "AmazonAdsDailyPerformance" p
        WHERE p."entityType" = 'CAMPAIGN' AND p."date" >= $1::date AND p."date" <= $2::date
          AND ${excludeAmsDailySql('p')}${marketIn('p')}
        GROUP BY 1
      ), tot AS (
        SELECT DATE_TRUNC('week', s."day")::date AS wk, SUM(s."grossRevenue")::numeric AS total
        FROM "DailySalesAggregate" s
        WHERE s."channel" = 'AMAZON' AND s."day" >= $1::date AND s."day" <= $2::date${marketIn('s')}
        GROUP BY 1
      )
      SELECT TO_CHAR(COALESCE(ad.wk, tot.wk), 'YYYY-MM-DD') AS week,
             COALESCE(ad.spend, 0) AS spend, COALESCE(ad.sales, 0) AS sales,
             COALESCE(tot.total, 0) AS total
      FROM ad FULL OUTER JOIN tot ON ad.wk = tot.wk
      ORDER BY 1`, opts.from, opts.to),

    // How far each feed actually reaches inside the window. A week is only complete when BOTH do.
    prisma.$queryRawUnsafe<Array<{ ad_max: string | null; sales_max: string | null }>>(`
      SELECT (SELECT TO_CHAR(MAX(p."date"), 'YYYY-MM-DD') FROM "AmazonAdsDailyPerformance" p
              WHERE p."entityType" = 'CAMPAIGN' AND p."date" <= $1::date
                AND ${excludeAmsDailySql('p')}${marketIn('p')}) AS ad_max,
             (SELECT TO_CHAR(MAX(s."day"), 'YYYY-MM-DD') FROM "DailySalesAggregate" s
              WHERE s."channel" = 'AMAZON' AND s."day" <= $1::date${marketIn('s')}) AS sales_max`,
      opts.to),

    prisma.$queryRawUnsafe<Array<{ rows: number; with_cogs: number }>>(`
      SELECT COUNT(*)::int AS rows,
             COUNT(*) FILTER (WHERE "cogsCents" IS NOT NULL AND "cogsCents" <> 0)::int AS with_cogs
      FROM "ProductProfitDaily"`),
  ])

  const adMax = boundsRow[0]?.ad_max ?? null
  const salesMax = boundsRow[0]?.sales_max ?? null
  const completeThrough = adMax && salesMax ? (adMax < salesMax ? adMax : salesMax) : (adMax ?? salesMax)

  const series: BusinessWeek[] = weekRows.map((r) => {
    const spend = num(r.spend)
    const sales = num(r.sales)
    const total = num(r.total)
    // The Monday plus six days is the week's last day; compared as ISO strings, which sort.
    const end = new Date(`${r.week}T00:00:00Z`)
    end.setUTCDate(end.getUTCDate() + 6)
    const endIso = end.toISOString().slice(0, 10)
    return {
      weekStart: r.week,
      adSpend: spend,
      adSales: sales,
      totalSales: total,
      tacos: ratio(spend, total),
      adShare: ratio(sales, total),
      partial: r.week < opts.from || endIso > opts.to || (completeThrough != null && endIso > completeThrough),
    }
  })

  const w = wasteRow[0]
  const wastedAmount = num(w?.wasted)
  const examined = num(w?.examined)

  const cogsRows = num(cogsRow[0]?.rows)
  const cogsWith = num(cogsRow[0]?.with_cogs)
  const cogsCoverage = cogsRows === 0
    ? 'No cost-of-goods rows exist at all, so true profit cannot be computed.'
    : cogsWith === 0
      ? `Cost of goods is missing on all ${cogsRows.toLocaleString('en-GB')} profit rows, so true profit cannot be computed.`
      : `Cost of goods is present on ${cogsWith.toLocaleString('en-GB')} of ${cogsRows.toLocaleString('en-GB')} profit rows, so a margin-based figure would cover only part of the catalogue.`

  const caveats: string[] = [
    'Total sales come from Amazon’s sales-and-traffic feed, so TACoS covers Amazon only — eBay and Shopify revenue is not included.',
    `Wasted spend means clicks that produced NO attributed sales — it is not margin-based. ${cogsCoverage}`,
    `Judged only to ${maturedToIso} — the last ${ATTRIBUTION_DAYS} days are excluded because sales attribute over a ${ATTRIBUTION_DAYS}-day window and recent clicks have not had time to convert.`,
  ]
  // An ad-attributed share above 100% is a real signal, not a rounding artefact:
  // Amazon credits a click for 7 days, so a sale can be attributed in a window
  // whose order landed outside it.
  if (totals.adShare != null && totals.adShare > 1) {
    caveats.push('Ad-attributed sales exceed total sales in this window — Amazon’s 7-day attribution can credit a sale to a click made before the window began. Widen the range for a stable read.')
  }

  if (series.some((p) => p.partial)) {
    caveats.push(`Weeks not yet covered by both feeds are marked partial and drawn hollow${completeThrough ? ` — both reach ${completeThrough}` : ''}.`)
  }

  return {
    window: { from: opts.from, to: opts.to },
    currency: 'EUR',
    marketplaces: marketFilter,
    totals,
    byMarket,
    series,
    completeThrough,
    wasted: {
      amount: wastedAmount,
      terms: num(w?.terms),
      pctOfSpend: examined > 0 ? wastedAmount / examined : 0,
      minClicks,
      maturedTo: maturedToIso,
      top: topRows.map((r) => ({
        query: r.query, marketplace: r.marketplace, clicks: num(r.clicks), spend: num(r.spend),
      })),
    },
    caveats,
    elapsedMs: Date.now() - started,
  }
}
