/**
 * RPX.3 — the Market share tab: our slice of the WHOLE market, query by query.
 *
 * ── Why this is stronger than what the field ships ─────────────────────────────
 *
 * Every competitor's "share of voice" is some version of our own impressions divided by our own
 * impressions elsewhere. Amazon's Search Query Performance report gives the MARKET's count and
 * ours for the same query — a real denominator — at four stages of the funnel. That is market
 * share, not a mix, and it is the one number a scraper cannot approximate.
 *
 * (The console already learned this the hard way: `analyzeShareOfVoice()` computed a share of our
 * own account's impressions, and against Amazon's own per-query share it ranked our market
 * position BACKWARDS — Spearman −0.24 across 607 market×query pairs. Nothing here divides by us.)
 *
 * ── The three honesty rules this feed forces ──────────────────────────────────
 *
 * 1. **A zero is counted, and an absence is not a zero.** Purchase share is 0.00% when Amazon
 *    counted market purchases and none of them were ours, and null when the market recorded no
 *    purchases at all — 0/0 has no value. Both are returned with their denominator so the client
 *    can render "0 of 132" rather than a bare percentage that could be a rounding artefact.
 *    A `toFixed` on a null would have destroyed that distinction silently.
 *
 * 2. **Coverage varies wildly week to week, so it travels with the trend.** Measured on prod for
 *    Italy: 1,066 query rows in the week of 12 Jul and 8 in the week of 26 Jul. A share computed
 *    over eight rows is not comparable to one computed over a thousand, so weeks far below the
 *    window's median are marked `thin` and the client draws them as a gap rather than averaging
 *    them into the line.
 *
 * 3. **ASIN-level rows only.** The table holds brand-level rows (`asin IS NULL`) beside ASIN-level
 *    ones for the same query and week. Summing both counts the same impressions twice.
 */
import prisma from '../../db.js'

/** A week holding less than this share of the window's median row count cannot be compared. */
const THIN_COVERAGE = 0.25

/** A ratio, or null when the denominator is zero — never a zero standing in for "undefined". */
const share = (ours: number, market: number): number | null => (market > 0 ? ours / market : null)

export interface ShareStage {
  id: 'impressions' | 'clicks' | 'cartAdds' | 'purchases'
  /** Plural noun, for prose: "the market recorded no cart adds". */
  label: string
  /**
   * The stage's name as a share, e.g. "Cart-add share".
   *
   * Declared rather than derived so the funnel card and the chart legend cannot drift: building
   * it client-side from `label` produced "Impressions share" and "Cart adds share" beside a
   * legend that already read "Impression share" and "Cart-add share".
   */
  shareLabel: string
  ours: number
  market: number
  share: number | null
}

export interface ShareWeek {
  week: string
  /** Query rows Amazon delivered for this week. The scale every share below is computed over. */
  rows: number
  impressionShare: number | null
  clickShare: number | null
  cartAddShare: number | null
  purchaseShare: number | null
  /** Coverage too far below the window's median for this week to be compared with the others. */
  thin: boolean
}

export interface ShareQuery {
  query: string
  marketImpressions: number
  ourImpressions: number
  impressionShare: number | null
  ourClicks: number
  marketPurchases: number
  ourPurchases: number
  /** Null when the market recorded no purchases on this query — undefined, not zero. */
  purchaseShare: number | null
}

export interface MarketFreshness {
  marketplace: string
  lastWeek: string | null
  lagDays: number | null
  weeks: number
  queries: number
}

export interface MarketShare {
  marketplace: string
  week: string | null
  weeksHeld: number
  firstWeek: string | null
  lastWeek: string | null
  lagDays: number | null
  freshness: MarketFreshness[]
  /** The four stages for the newest week held. */
  funnel: ShareStage[]
  series: ShareWeek[]
  queries: ShareQuery[]
  coverage: { medianRows: number; thinBelow: number; thinWeeks: string[] }
  caveats: string[]
  elapsedMs: number
}

const n = (v: unknown): number => {
  if (v == null) return 0
  const x = typeof v === 'bigint' ? Number(v) : Number(v as number)
  return Number.isFinite(x) ? x : 0
}

export async function marketShare(opts: {
  marketplace: string
  /** How many of the most recent weeks to return. */
  weeks?: number
  /** How many queries to list, ordered by the market's impressions. */
  queryLimit?: number
}): Promise<MarketShare> {
  const started = Date.now()
  const weeksWanted = Math.max(1, Math.min(52, opts.weeks ?? 8))
  const queryLimit = Math.max(1, Math.min(200, opts.queryLimit ?? 25))
  const market = opts.marketplace

  const [weekRows, freshRows] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{
      week: string; rows: number
      imp_b: number; imp_t: number; clk_b: number; clk_t: number
      cart_b: number; cart_t: number; buy_b: number; buy_t: number
    }>>(`
      SELECT TO_CHAR("startDate", 'YYYY-MM-DD') AS week, COUNT(*)::int AS rows,
             SUM("impressionsBrand")::bigint AS imp_b, SUM("impressionsTotal")::bigint AS imp_t,
             SUM("clicksBrand")::bigint      AS clk_b, SUM("clicksTotal")::bigint      AS clk_t,
             SUM("cartAddsBrand")::bigint    AS cart_b, SUM("cartAddsTotal")::bigint   AS cart_t,
             SUM("purchasesBrand")::bigint   AS buy_b, SUM("purchasesTotal")::bigint   AS buy_t
      FROM "SearchQueryPerformance"
      WHERE "marketplace" = $1 AND "asin" IS NOT NULL
      GROUP BY 1 ORDER BY 1 DESC LIMIT $2`, market, weeksWanted),

    prisma.$queryRawUnsafe<Array<{ marketplace: string; last: Date | null; weeks: number; queries: number }>>(`
      SELECT "marketplace", MAX("startDate") AS last,
             COUNT(DISTINCT "startDate")::int AS weeks, COUNT(DISTINCT "searchQuery")::int AS queries
      FROM "SearchQueryPerformance" WHERE "asin" IS NOT NULL
      GROUP BY 1 ORDER BY 1`),
  ])

  const ordered = [...weekRows].reverse() // oldest first, for the chart
  const counts = ordered.map((r) => n(r.rows)).sort((a, b) => a - b)
  const medianRows = counts.length
    ? (counts.length % 2 ? counts[(counts.length - 1) / 2]
      : (counts[counts.length / 2 - 1] + counts[counts.length / 2]) / 2)
    : 0
  const thinBelow = Math.round(medianRows * THIN_COVERAGE)

  const series: ShareWeek[] = ordered.map((r) => ({
    week: r.week,
    rows: n(r.rows),
    impressionShare: share(n(r.imp_b), n(r.imp_t)),
    clickShare: share(n(r.clk_b), n(r.clk_t)),
    cartAddShare: share(n(r.cart_b), n(r.cart_t)),
    purchaseShare: share(n(r.buy_b), n(r.buy_t)),
    thin: medianRows > 0 && n(r.rows) < thinBelow,
  }))

  const newest = ordered[ordered.length - 1] ?? null
  const funnel: ShareStage[] = newest
    ? [
      { id: 'impressions', label: 'impressions', shareLabel: 'Impression share', ours: n(newest.imp_b), market: n(newest.imp_t), share: share(n(newest.imp_b), n(newest.imp_t)) },
      { id: 'clicks', label: 'clicks', shareLabel: 'Click share', ours: n(newest.clk_b), market: n(newest.clk_t), share: share(n(newest.clk_b), n(newest.clk_t)) },
      { id: 'cartAdds', label: 'cart adds', shareLabel: 'Cart-add share', ours: n(newest.cart_b), market: n(newest.cart_t), share: share(n(newest.cart_b), n(newest.cart_t)) },
      { id: 'purchases', label: 'purchases', shareLabel: 'Purchase share', ours: n(newest.buy_b), market: n(newest.buy_t), share: share(n(newest.buy_b), n(newest.buy_t)) },
    ]
    : []

  const queryRows = newest
    ? await prisma.$queryRawUnsafe<Array<{
      query: string; mkt: number; ours: number; clk: number; buy_t: number; buy_b: number
    }>>(`
      SELECT "searchQuery" AS query,
             SUM("impressionsTotal")::bigint AS mkt, SUM("impressionsBrand")::bigint AS ours,
             SUM("clicksBrand")::bigint AS clk,
             SUM("purchasesTotal")::bigint AS buy_t, SUM("purchasesBrand")::bigint AS buy_b
      FROM "SearchQueryPerformance"
      WHERE "marketplace" = $1 AND "asin" IS NOT NULL AND "startDate" = $2::date
      GROUP BY 1 ORDER BY 2 DESC LIMIT $3`, market, newest.week, queryLimit)
    : []

  const queries: ShareQuery[] = queryRows.map((r) => ({
    query: r.query,
    marketImpressions: n(r.mkt),
    ourImpressions: n(r.ours),
    impressionShare: share(n(r.ours), n(r.mkt)),
    ourClicks: n(r.clk),
    marketPurchases: n(r.buy_t),
    ourPurchases: n(r.buy_b),
    purchaseShare: share(n(r.buy_b), n(r.buy_t)),
  }))

  const today = new Date()
  const freshness: MarketFreshness[] = freshRows.map((r) => ({
    marketplace: r.marketplace,
    lastWeek: r.last ? r.last.toISOString().slice(0, 10) : null,
    lagDays: r.last ? Math.round((today.getTime() - r.last.getTime()) / 86_400_000) : null,
    weeks: n(r.weeks),
    queries: n(r.queries),
  }))
  const mine = freshness.find((f) => f.marketplace === market) ?? null

  const thinWeeks = series.filter((w) => w.thin).map((w) => w.week)
  const caveats: string[] = [
    'Amazon publishes Search Query Performance weekly and roughly ten days in arrears, and it covers only queries where our ASINs appeared — it is not the whole catalogue.',
    'Shares are our count divided by the market’s for the same query. A share of “—” means the market recorded nothing at that stage, so ours has no denominator; 0.00% means the market recorded activity and none of it was ours.',
    'Brand-level rows are excluded: the feed holds an ASIN-level and a brand-level row for the same query-week, and counting both would double every figure here.',
  ]
  if (thinWeeks.length) {
    caveats.push(`${thinWeeks.length === 1 ? 'One week is' : `${thinWeeks.length} weeks are`} below ${thinBelow} query rows against a window median of ${medianRows} and cannot be compared with the rest: ${thinWeeks.join(', ')}.`)
  }
  if (mine?.lagDays != null && mine.lagDays > 21) {
    caveats.push(`This market's newest week is ${mine.lagDays} days old — late even for a weekly feed published in arrears.`)
  }

  return {
    marketplace: market,
    week: newest?.week ?? null,
    weeksHeld: mine?.weeks ?? series.length,
    firstWeek: series[0]?.week ?? null,
    lastWeek: newest?.week ?? null,
    lagDays: mine?.lagDays ?? null,
    freshness,
    funnel,
    series,
    queries,
    coverage: { medianRows, thinBelow, thinWeeks },
    caveats,
    elapsedMs: Date.now() - started,
  }
}
