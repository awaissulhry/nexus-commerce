/**
 * ACR.2.2 — the coverage scoreboard: how much of page one do we own, per keyword.
 *
 * The question this whole programme exists to answer, finally answerable because the SQP repair
 * (ACR.2.1) put our own impression counts back into the stored weeks.
 *
 * The measurement that reframed the goal: on `giacca moto estiva uomo`, **ten** of our ASINs
 * already appear on the SERP — and together they hold 0.19% of 1.1M impressions. Multi-product
 * presence is the status quo; share is the gap. So every row here leads with share and treats
 * "how many of ours are on the page" as context rather than the objective.
 *
 * ── The one thing this must never do ────────────────────────────────────────────────────────
 * A week the fixed parser has not re-read still stores `impressionsBrand = 0` for every row.
 * Rendering that as "0% share" would be the same defect as a €0 true profit: a number meaning
 * UNMEASURED presented as one meaning ZERO — and here it would read as "we are invisible on
 * this term", which is a conclusion an operator would act on.
 *
 * So each week carries `measured`. A week where no row in the entire week has a non-zero
 * `impressionsBrand` is reported as UNMEASURED and its shares are null, not 0. That test is
 * deliberately whole-week: a genuine zero on one term is ordinary, but an entire week of exact
 * zeros across hundreds of terms and every ASIN does not occur naturally — it is the fingerprint
 * of the pre-fix parser.
 */
import prisma from '../../db.js'

export interface CoverageRow {
  term: string
  marketImpressions: number
  /** null when the week is unmeasured — see the docblock. Never 0 in that case. */
  ourImpressions: number | null
  /** Fraction 0..1 of page-one impressions we hold. null when unmeasured. */
  share: number | null
  /** How many of OUR ASINs appear on this SERP. Context, not the objective. */
  ourAsins: number
  /** Non-negative keyword targets we hold this exact term with, in this marketplace. */
  targets: number
  marketPurchases: number
  ourPurchases: number | null
}

export interface CoverageWeek {
  startDate: string
  rows: number
  /** False when the fixed parser has never re-read this week — its shares are null. */
  measured: boolean
}

export interface CoverageScoreboard {
  marketplace: string
  week: string | null
  weeks: CoverageWeek[]
  measured: boolean
  /** Pooled across every term in the week — the honest single number. Never an average of ratios. */
  totals: {
    terms: number
    marketImpressions: number
    ourImpressions: number | null
    share: number | null
    marketPurchases: number
    ourPurchases: number | null
  }
  rows: CoverageRow[]
  /** Big markets we hold almost none of. The actionable half of the board. */
  headroom: CoverageRow[]
  notes: string[]
}

const MIN_MARKET_IMPRESSIONS = 1_000
const HEADROOM_MIN_MARKET = 5_000
const HEADROOM_MAX_SHARE = 0.005 // half a percent

/** Marketplaces with any SQP rows, newest activity first. */
export async function coverageMarketplaces(): Promise<string[]> {
  const rows = await prisma.searchQueryPerformance.groupBy({
    by: ['marketplace'],
    _max: { startDate: true },
  })
  return rows
    .sort((a, b) => (b._max.startDate?.getTime() ?? 0) - (a._max.startDate?.getTime() ?? 0))
    .map((r) => r.marketplace)
}

export async function getCoverageScoreboard(args: {
  marketplace?: string
  week?: string
  limit?: number
  /**
   * ACR.6 — the family lens. `asins` scopes OUR side of every number to one family's products
   * (the market side is the whole query market either way — that is what share is measured
   * against). `campaignIds` scopes the keyword-held counts to the family's own campaigns, so
   * "kws" answers "does THIS family bid this term", not "does anyone".
   */
  asins?: string[]
  campaignIds?: string[]
}): Promise<CoverageScoreboard> {
  const marketplace = args.marketplace ?? 'IT'
  const limit = Math.max(10, Math.min(500, args.limit ?? 100))
  const asinFilter = args.asins?.length
    ? `AND s.asin IN (${args.asins.map((a) => `'${a.replace(/'/g, "''")}'`).join(',')})`
    : ''
  const campFilter = args.campaignIds?.length
    ? `AND c.id IN (${args.campaignIds.map((a) => `'${a.replace(/'/g, "''")}'`).join(',')})`
    : ''

  const weekRows = await prisma.$queryRawUnsafe<{ week: string; rows: bigint; ours: bigint }[]>(`
    SELECT "startDate"::text AS week, COUNT(*) AS rows, SUM("impressionsBrand") AS ours
    FROM "SearchQueryPerformance"
    WHERE marketplace = $1
    GROUP BY 1 ORDER BY 1 DESC
  `, marketplace)

  const weeks: CoverageWeek[] = weekRows.map((w) => ({
    startDate: w.week.slice(0, 10),
    rows: Number(w.rows),
    measured: Number(w.ours) > 0,
  }))

  // Default to the newest MEASURED week, not simply the newest — landing an operator on a week
  // of nulls by default would make the board look broken on its first render.
  const week = args.week ?? weeks.find((w) => w.measured)?.startDate ?? weeks[0]?.startDate ?? null
  const chosen = weeks.find((w) => w.startDate === week)
  const measured = chosen?.measured ?? false

  if (!week) {
    return {
      marketplace, week: null, weeks, measured: false,
      totals: { terms: 0, marketImpressions: 0, ourImpressions: null, share: null, marketPurchases: 0, ourPurchases: null },
      rows: [], headroom: [],
      notes: [`No Search Query Performance data for ${marketplace}.`],
    }
  }

  const raw = await prisma.$queryRawUnsafe<{
    term: string; market_impr: bigint; our_impr: bigint; our_asins: bigint
    market_buys: bigint; our_buys: bigint; targets: bigint
  }[]>(`
    SELECT s."searchQuery" AS term,
           /**
            * MAX, not SUM. SQP rows are per (term, ASIN) and the market-level columns
            * (impressionsTotal, clicksTotal, purchasesTotal…) carry the QUERY total duplicated
            * identically on every ASIN row — verified 2026-08-05: giacca moto estiva uomo holds
            * 10 rows each reading 110,506, distinct_totals = 1. Summing them multiplied the
            * market by the number of OUR ASINs on the term, which understated every multi-ASIN
            * share by that factor (0.19% published where the truth was 1.88%) — and punished
            * exactly the terms where coverage is strongest. Brand columns are per-ASIN counts,
            * so those are the ones that SUM.
            */
           MAX(s."impressionsTotal") AS market_impr,
           SUM(s."impressionsBrand") AS our_impr,
           COUNT(DISTINCT s.asin) FILTER (WHERE s."impressionsBrand" > 0) AS our_asins,
           MAX(s."purchasesTotal") AS market_buys,
           SUM(s."purchasesBrand") AS our_buys,
           -- Negativity is isNegative, NOT the match type. Measured 2026-08-05: 1,068 targets
           -- are stored as expressionType 'EXACT' with isNegative = true, and only 20 rows in the
           -- whole table use 'NEGATIVE_EXACT'. Filtering on the match-type string therefore counts
           -- 2,034 NEGATIVE keywords as coverage — a term we have explicitly excluded ourselves
           -- from would have read as a term we hold. Negative-exact has three spellings in this
           -- table (EXACT, _EXACT, NEGATIVE_EXACT), so the boolean is the only safe discriminator.
           (SELECT COUNT(DISTINCT t.id) FROM "AdTarget" t
              JOIN "AdGroup" g ON g.id = t."adGroupId"
              JOIN "Campaign" c ON c.id = g."campaignId"
            WHERE LOWER(t."expressionValue") = LOWER(s."searchQuery")
              AND c.marketplace = $1 AND t.kind = 'KEYWORD'
              AND t."isNegative" = false ${campFilter}) AS targets
    FROM "SearchQueryPerformance" s
    WHERE s.marketplace = $1 AND s."startDate" = $2::date ${asinFilter}
    GROUP BY 1
    HAVING SUM(s."impressionsTotal") >= ${MIN_MARKET_IMPRESSIONS}
    ORDER BY SUM(s."impressionsTotal") DESC
    LIMIT ${limit}
  `, marketplace, week)

  const rows: CoverageRow[] = raw.map((r) => {
    const marketImpressions = Number(r.market_impr)
    const ourImpressions = measured ? Number(r.our_impr) : null
    return {
      term: r.term,
      marketImpressions,
      ourImpressions,
      share: ourImpressions != null && marketImpressions > 0 ? ourImpressions / marketImpressions : null,
      ourAsins: Number(r.our_asins),
      targets: Number(r.targets),
      marketPurchases: Number(r.market_buys),
      ourPurchases: measured ? Number(r.our_buys) : null,
    }
  })

  // Pooled over the WHOLE week, not just the returned page — a total that changes when you
  // change the row limit is not a total.
  // Pooled the same way: per-term market totals once each (inner MAX), our counts summed.
  const pooled = await prisma.$queryRawUnsafe<{
    terms: bigint; market_impr: bigint; our_impr: bigint; market_buys: bigint; our_buys: bigint
  }[]>(`
    SELECT COUNT(*) AS terms,
           SUM(m) AS market_impr, SUM(o) AS our_impr,
           SUM(mb) AS market_buys, SUM(ob) AS our_buys
    FROM (
      SELECT MAX("impressionsTotal") AS m, SUM("impressionsBrand") AS o,
             MAX("purchasesTotal") AS mb, SUM("purchasesBrand") AS ob
      FROM "SearchQueryPerformance" s
      WHERE marketplace = $1 AND "startDate" = $2::date ${asinFilter}
      GROUP BY "searchQuery"
    ) x
  `, marketplace, week)
  const t = pooled[0]
  const marketImpr = Number(t?.market_impr ?? 0)
  const ourImpr = measured ? Number(t?.our_impr ?? 0) : null

  const headroom = rows
    .filter((r) => r.marketImpressions >= HEADROOM_MIN_MARKET && (r.share ?? 1) <= HEADROOM_MAX_SHARE)
    .sort((a, b) => b.marketImpressions - a.marketImpressions)
    .slice(0, 25)

  const notes: string[] = []
  if (!measured) {
    notes.push(
      `Week of ${week} has not been re-read since the parser fix, so our own counts are still absent. ` +
      'Shares read "—" rather than 0% — a zero here would say we are invisible on these terms, which is not what the data shows; it is what the data lacks.',
    )
  }
  const unmeasuredWeeks = weeks.filter((w) => !w.measured).length
  if (measured && unmeasuredWeeks > 0) {
    notes.push(`${unmeasuredWeeks} of ${weeks.length} stored weeks are still unmeasured and are marked in the week picker.`)
  }
  const untargeted = rows.filter((r) => r.targets === 0 && r.marketImpressions >= HEADROOM_MIN_MARKET)
  if (untargeted.length > 0) {
    const biggest = untargeted[0]
    notes.push(
      `${untargeted.length} terms above ${HEADROOM_MIN_MARKET.toLocaleString('en-IE')} impressions have no keyword at all — ` +
      `the largest is "${biggest.term}" at ${biggest.marketImpressions.toLocaleString('en-IE')}.`,
    )
  }
  const multiAsin = rows.filter((r) => r.ourAsins > 1).length
  if (measured && multiAsin > 0) {
    notes.push(
      `${multiAsin} terms already show more than one of our ASINs on the same page. ` +
      'Presence is not the constraint here; share is.',
    )
  }

  return {
    marketplace,
    week,
    weeks,
    measured,
    totals: {
      terms: Number(t?.terms ?? 0),
      marketImpressions: marketImpr,
      ourImpressions: ourImpr,
      share: ourImpr != null && marketImpr > 0 ? ourImpr / marketImpr : null,
      marketPurchases: Number(t?.market_buys ?? 0),
      ourPurchases: measured ? Number(t?.our_buys ?? 0) : null,
    },
    rows,
    headroom,
    notes,
  }
}
