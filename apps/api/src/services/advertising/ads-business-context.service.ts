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
 * 1. **There is no COGS in this database.** 0 of 362 products carry a cost price
 *    and every ProductProfitDaily row has cogsCents = 0. The reporting re-study
 *    claimed we could beat BidX's "wasted ad spend" figure by computing it from
 *    real margin — that claim is false in practice today. So waste here is
 *    strictly *spend that produced no attributed sales*, and it says so. When
 *    costs are loaded this becomes margin-aware; until then, overstating it would
 *    be exactly the kind of confident wrong number this whole series exists to
 *    prevent.
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

export interface BusinessContext {
  window: { from: string; to: string }
  currency: string
  totals: MarketContext
  byMarket: MarketContext[]
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
}): Promise<BusinessContext> {
  const started = Date.now()
  const minClicks = Math.max(1, opts.minClicks ?? DEFAULT_MIN_CLICKS)

  // Waste is judged only over days old enough to have converted.
  const maturedTo = new Date(`${opts.to}T00:00:00Z`)
  maturedTo.setUTCDate(maturedTo.getUTCDate() - ATTRIBUTION_DAYS)
  const maturedToIso = maturedTo.toISOString().slice(0, 10)

  const [adRows, salesRows, wasteRow, topRows] = await Promise.all([
    // Ad spend and attributed sales, campaign grain so nothing double-counts.
    prisma.$queryRawUnsafe<Array<{ marketplace: string; spend: number; sales: number }>>(`
      SELECT "marketplace",
             SUM("costMicros")::numeric / 1000000.0 AS spend,
             SUM(COALESCE("sales7dCents", 0))::numeric / 100.0 AS sales
      FROM "AmazonAdsDailyPerformance"
      WHERE "entityType" = 'CAMPAIGN' AND "date" >= $1::date AND "date" <= $2::date
      GROUP BY 1`, opts.from, opts.to),

    // TOTAL sales — every order, advertised or not. Amazon only; see caveats.
    prisma.$queryRawUnsafe<Array<{ marketplace: string; total: number }>>(`
      SELECT "marketplace", SUM("grossRevenue")::numeric AS total
      FROM "DailySalesAggregate"
      WHERE "channel" = 'AMAZON' AND "day" >= $1::date AND "day" <= $2::date
      GROUP BY 1`, opts.from, opts.to),

    prisma.$queryRawUnsafe<Array<{ wasted: number; terms: number; examined: number }>>(`
      WITH term AS (
        SELECT "query", "marketplace",
               SUM("clicks")::int AS clicks,
               SUM("costMicros") / 1000000.0 AS cost,
               SUM(COALESCE("sales7dCents", 0)) AS sales_cents
        FROM "AmazonAdsSearchTerm"
        WHERE "date" >= $1::date AND "date" <= $2::date
        GROUP BY 1, 2
      )
      SELECT COALESCE(SUM(cost) FILTER (WHERE sales_cents = 0 AND clicks >= ${minClicks}), 0)::numeric AS wasted,
             COUNT(*) FILTER (WHERE sales_cents = 0 AND clicks >= ${minClicks})::int AS terms,
             COALESCE(SUM(cost), 0)::numeric AS examined
      FROM term`, opts.from, maturedToIso),

    prisma.$queryRawUnsafe<Array<{ query: string; marketplace: string; clicks: number; spend: number }>>(`
      SELECT "query", "marketplace", SUM("clicks")::int AS clicks,
             SUM("costMicros")::numeric / 1000000.0 AS spend
      FROM "AmazonAdsSearchTerm"
      WHERE "date" >= $1::date AND "date" <= $2::date
      GROUP BY 1, 2
      HAVING SUM(COALESCE("sales7dCents", 0)) = 0 AND SUM("clicks") >= ${minClicks}
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

  const w = wasteRow[0]
  const wastedAmount = num(w?.wasted)
  const examined = num(w?.examined)

  const caveats: string[] = [
    'Total sales come from Amazon’s sales-and-traffic feed, so TACoS covers Amazon only — eBay and Shopify revenue is not included.',
    `Wasted spend means clicks that produced NO attributed sales. It is not margin-based: no product in this catalogue currently carries a cost price, so true profit cannot be computed yet.`,
    `Judged only to ${maturedToIso} — the last ${ATTRIBUTION_DAYS} days are excluded because sales attribute over a ${ATTRIBUTION_DAYS}-day window and recent clicks have not had time to convert.`,
  ]
  // An ad-attributed share above 100% is a real signal, not a rounding artefact:
  // Amazon credits a click for 7 days, so a sale can be attributed in a window
  // whose order landed outside it.
  if (totals.adShare != null && totals.adShare > 1) {
    caveats.push('Ad-attributed sales exceed total sales in this window — Amazon’s 7-day attribution can credit a sale to a click made before the window began. Widen the range for a stable read.')
  }

  return {
    window: { from: opts.from, to: opts.to },
    currency: 'EUR',
    totals,
    byMarket,
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
