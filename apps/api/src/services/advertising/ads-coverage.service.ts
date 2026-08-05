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
import {
  resolveRestWeight, topMixOf, resolvePositionBasis, positionWeightedScore,
} from './ads-position-weight.js'

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

  // ── ACR.2.2b · position ────────────────────────────────────────────────────────────────────
  /**
   * Amazon's own top-of-search impression share for the campaigns holding this term
   * (impression-weighted, 30d). **null means UNMEASURED, never zero** — see `tosIsMeasured`
   * on the board: `topOfSearchIS` is NULL on all 3,552 placement rows in every market, so this
   * reads "—" everywhere until the fixed ingest lands a night.
   */
  tosIS: number | null
  /** Our paid SEARCH impressions in the window, split by page position. Detail-page ads excluded. */
  topImpressions: number
  restImpressions: number
  /** Fraction of our paid search impressions that sat in top-of-search. null when we bought none. */
  topMix: number | null
  /** `share`, re-expressed in top-of-search-equivalent units. See POSITION WEIGHT in the docblock. */
  pwScore: number | null
  /** Why `pwScore` is null, when it is — so the column never reads as a measured zero. */
  positionBasis: 'measured' | 'no-paid-impressions' | 'no-holding-campaign' | 'unmeasured-week'
}

/**
 * The account's OWN measured position weight, not an industry constant.
 *
 * A percentage point of share at the top of the page is worth more than one further down, and
 * how much more is measurable from our own placement report: the ratio of rest-of-search CTR to
 * top-of-search CTR. Measured IT/90d on 2026-08-05 — top 3.784%, rest 0.482% — the ratio is
 * **0.127**, i.e. a rest-of-search impression is worth about an eighth of a top one to us.
 *
 * Returned with its inputs so the number on screen can be audited rather than trusted.
 */
export interface PositionWeight {
  restWeight: number
  topCtr: number | null
  restCtr: number | null
  topImpressions: number
  restImpressions: number
  windowDays: number
  /** 'measured' from our own report; 'fallback' when there is not enough traffic to divide. */
  basis: 'measured' | 'fallback'
}

const POSITION_WINDOW_DAYS = 90
/** Placement mix is read over 30 days — recent enough to describe how the term serves NOW. */
const COVERAGE_POSITION_WINDOW_DAYS = 30
const PLACEMENT_TOP = 'Top of Search on-Amazon'
const PLACEMENT_REST = 'Other on-Amazon'

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
  /** ACR.2.2b — the measured weight behind every `pwScore`, with its inputs. */
  positionWeight: PositionWeight
  /**
   * False while `AmazonAdsPlacementReport.topOfSearchIS` is null everywhere. The ToS-IS column
   * then renders "—" and says why, rather than a column of zeroes that would read as
   * "we never reach the top of the page".
   */
  tosIsMeasured: boolean
  /** Pooled position-weighted score for the week, on the same denominator as `totals.share`. */
  pwTotal: number | null
  /** ACR Stage 5 — which ad products actually produced our presence. See `AdTypeMix`. */
  adTypeMix: AdTypeMix
}

/**
 * ACR Stage 5 — presence attributed to the ad product that bought it.
 *
 * The scoreboard's `share` answers "how much of page one do we hold". It cannot answer "with
 * what", because it is computed from SQP's `impressionsBrand`, which is Amazon's brand-level
 * total with no ad-product dimension at all. Stacking — the whole point of Stage 5 — is only
 * measurable against our OWN performance data, so that is where this comes from.
 *
 * **SD is deliberately not attributed per term, and this is not a gap to fix later.** Sponsored
 * Display is not search-driven: it targets products, categories and audiences, and Amazon
 * reports no search term for it. Splitting a term's presence into SP/SB/SD would require
 * inventing the SD half. It is reported at the marketplace level instead, where it is true.
 *
 * Baseline measured 2026-08-05: SP is 100% of everything, because all 19 SB/SD campaigns are
 * paused with €0.00 lifetime spend. That is the point — this is the instrument that makes the
 * stacking hypothesis falsifiable once they run.
 */
export interface AdTypeMix {
  /** Marketplace-wide paid impressions in the window, by ad product. */
  byAdProduct: Array<{
    adProduct: 'SPONSORED_PRODUCTS' | 'SPONSORED_BRANDS' | 'SPONSORED_DISPLAY'
    impressions: number
    clicks: number
    costEur: number
    /** Fraction 0..1 of our paid impressions in the window. */
    shareOfOurImpressions: number
    /** False for SD: it has no search term, so it can never appear in a per-term row. */
    searchAttributable: boolean
    /** True when this ad product delivered nothing in the window — dormant, not broken. */
    dormant: boolean
  }>
  windowDays: number
  /** How many ad products actually delivered. 1 = no stacking is happening at all. */
  activeAdProducts: number
}

const MIN_MARKET_IMPRESSIONS = 1_000
const HEADROOM_MIN_MARKET = 5_000
const HEADROOM_MAX_SHARE = 0.005 // half a percent

/**
 * Measure the account's own rest-of-search:top-of-search CTR ratio.
 *
 * Detail-page placements are excluded on purpose: they are not page one of a SERP, and their
 * CTR (0.067% against top-of-search's 3.784%) would drag the ratio toward a number that
 * describes a different surface entirely.
 */
export async function measurePositionWeight(marketplace: string): Promise<PositionWeight> {
  const rows = await prisma.$queryRawUnsafe<{ placement: string; impr: bigint; clicks: bigint }[]>(`
    SELECT placement, SUM(impressions) AS impr, SUM(clicks) AS clicks
    FROM "AmazonAdsPlacementReport"
    WHERE marketplace = $1 AND date > now() - ($2 || ' days')::interval
      AND placement IN ($3, $4)
    GROUP BY 1
  `, marketplace, String(POSITION_WINDOW_DAYS), PLACEMENT_TOP, PLACEMENT_REST)

  const find = (p: string) => rows.find((r) => r.placement === p)
  const top = find(PLACEMENT_TOP)
  const rest = find(PLACEMENT_REST)
  const counts = {
    topImpressions: Number(top?.impr ?? 0), topClicks: Number(top?.clicks ?? 0),
    restImpressions: Number(rest?.impr ?? 0), restClicks: Number(rest?.clicks ?? 0),
  }
  // The arithmetic — and, more importantly, its null discipline — lives in
  // ads-position-weight.ts and is unit-tested there. A second copy here is exactly how the
  // two-vocabularies defects in this programme happened.
  const w = resolveRestWeight(counts)
  return {
    restWeight: w.restWeight, topCtr: w.topCtr, restCtr: w.restCtr,
    topImpressions: counts.topImpressions, restImpressions: counts.restImpressions,
    windowDays: POSITION_WINDOW_DAYS,
    basis: w.basis,
  }
}

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
      positionWeight: await measurePositionWeight(marketplace),
      tosIsMeasured: false,
      pwTotal: null,
      // No SQP week means no board; the mix is a property of the board, so it is empty rather
      // than a set of zeroes that would read as "measured, and nothing ran".
      adTypeMix: { byAdProduct: [], windowDays: COVERAGE_POSITION_WINDOW_DAYS, activeAdProducts: 0 },
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

  /**
   * ── POSITION, per term ──────────────────────────────────────────────────────────────────────
   *
   * SQP says how much of page one we hold. It does not say WHERE on page one, and a percentage
   * point at the top is not worth a percentage point at the bottom. The only in-policy source
   * for position is our own placement report, which is per CAMPAIGN — so a term inherits the
   * placement mix of the campaigns that hold it as a keyword.
   *
   * **That is an approximation and the UI says so.** A campaign holding fifty keywords has one
   * placement mix, applied here to all fifty. It is directional, not per-keyword truth. What it
   * is not is invented: every input is a measured impression count from our own account.
   *
   * `topOfSearchIS` is Amazon's authoritative answer to the same question and is carried
   * alongside — currently NULL on every row in every market, so it reads UNMEASURED rather than
   * being quietly replaced by the approximation.
   */
  const placement = await prisma.$queryRawUnsafe<{
    term: string; top_impr: bigint; rest_impr: bigint; is_num: string | null; is_den: bigint
  }[]>(`
    WITH held AS (
      -- Every (term, campaign) pair where we hold the term as a POSITIVE keyword. isNegative,
      -- never the match-type string (ACR.2.4).
      SELECT DISTINCT LOWER(t."expressionValue") AS term, c."externalCampaignId" AS ext
      FROM "AdTarget" t
      JOIN "AdGroup" g ON g.id = t."adGroupId"
      JOIN "Campaign" c ON c.id = g."campaignId"
      WHERE c.marketplace = $1 AND t.kind = 'KEYWORD' AND t."isNegative" = false
        AND c."externalCampaignId" IS NOT NULL ${campFilter}
    ),
    pl AS (
      SELECT p."campaignId" AS ext,
             COALESCE(SUM(p.impressions) FILTER (WHERE p.placement = $3), 0) AS top_impr,
             COALESCE(SUM(p.impressions) FILTER (WHERE p.placement = $4), 0) AS rest_impr,
             -- Impression-weighted, so a campaign with 40k impressions does not carry the same
             -- weight as one with 40. Null ToS-IS rows are excluded from BOTH sides of the
             -- ratio rather than counted as zero.
             COALESCE(SUM(p.impressions * p."topOfSearchIS") FILTER (
               WHERE p.placement = $3 AND p."topOfSearchIS" IS NOT NULL), 0) AS is_num,
             COALESCE(SUM(p.impressions) FILTER (
               WHERE p.placement = $3 AND p."topOfSearchIS" IS NOT NULL), 0) AS is_den
      FROM "AmazonAdsPlacementReport" p
      WHERE p.marketplace = $1 AND p.date > now() - ($2 || ' days')::interval
      GROUP BY 1
    )
    SELECT h.term,
           SUM(pl.top_impr) AS top_impr, SUM(pl.rest_impr) AS rest_impr,
           SUM(pl.is_num) AS is_num, SUM(pl.is_den) AS is_den
    FROM held h JOIN pl ON pl.ext = h.ext
    GROUP BY 1
  `, marketplace, String(COVERAGE_POSITION_WINDOW_DAYS), PLACEMENT_TOP, PLACEMENT_REST)

  const placeByTerm = new Map(placement.map((p) => [p.term, p]))
  const positionWeight = await measurePositionWeight(marketplace)
  const tosIsMeasured = placement.some((p) => Number(p.is_den) > 0)

  const rows: CoverageRow[] = raw.map((r) => {
    const marketImpressions = Number(r.market_impr)
    const ourImpressions = measured ? Number(r.our_impr) : null
    const share = ourImpressions != null && marketImpressions > 0 ? ourImpressions / marketImpressions : null

    const p = placeByTerm.get(r.term.toLowerCase())
    const topImpressions = Number(p?.top_impr ?? 0)
    const restImpressions = Number(p?.rest_impr ?? 0)
    const topMix = topMixOf(topImpressions, restImpressions)
    const isDen = Number(p?.is_den ?? 0)
    const tosIS = isDen > 0 ? Number(p!.is_num) / isDen : null

    // Every branch that yields null says WHY. A blank cell an operator cannot explain is the
    // same failure as a zero that means "unmeasured" — it just fails more quietly.
    const positionBasis = resolvePositionBasis({ share, hasHoldingCampaign: !!p, topMix })

    return {
      term: r.term,
      marketImpressions,
      ourImpressions,
      share,
      ourAsins: Number(r.our_asins),
      targets: Number(r.targets),
      marketPurchases: Number(r.market_buys),
      ourPurchases: measured ? Number(r.our_buys) : null,
      tosIS,
      topImpressions,
      restImpressions,
      topMix,
      pwScore: positionWeightedScore({ share, topMix, restWeight: positionWeight.restWeight, basis: positionBasis }),
      positionBasis,
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
  if (!tosIsMeasured) {
    notes.push(
      'Amazon\u2019s own top-of-search impression share is UNMEASURED: `topOfSearchIS` is null on every ' +
      'placement row in every market. The nightly ingest logged SUCCESS with errors=9 for twelve ' +
      'consecutive nights on a 10-minute poll ceiling; the fix (45 minutes) is deployed and its first ' +
      'run is the next 02:30. Until then the ToS-IS column reads \u201c\u2014\u201d, not 0%.')
  }
  const positionedCount = rows.filter((r) => r.positionBasis === 'measured').length
  if (measured && positionedCount > 0) {
    notes.push(
      `Position is measured on ${positionedCount} of ${rows.length} terms, from the placement mix of the campaigns ` +
      `holding each term. A rest-of-search impression is worth ${(positionWeight.restWeight * 100).toFixed(0)}% of a ` +
      `top-of-search one in this account \u2014 our own measured CTR ratio over ${positionWeight.windowDays} days, not an industry constant.`)
  }
  // ── ACR.2.4b — the board's own scope, stated on the board ──────────────────────────────────
  // "Share of page one: 0.76%" reads as XAVIA's share. Measured 2026-08-05 it is GALE's:
  // SQP carries impressions for 10 of 250 advertised ASINs, and all ten are children of one
  // Amazon parent. Eleven whole families (AIREON, REGAL, VENTRA, MOSS, MISANO, AIRMESH…) have
  // no SQP row at all. The market denominator is the whole query market either way, so every
  // share here is a FLOOR — understated by whatever the unmeasured families hold. A board that
  // knows its numerator covers 4% of the catalogue and does not say so is asserting an
  // account-wide fact from one product's data.
  if (measured && !args.asins?.length) {
    const scope = await prisma.$queryRawUnsafe<{ measured_asins: bigint; advertised: bigint }[]>(`
      SELECT
        (SELECT COUNT(DISTINCT asin) FROM "SearchQueryPerformance"
          WHERE marketplace = $1 AND "startDate" = $2::date AND "impressionsBrand" > 0) AS measured_asins,
        (SELECT COUNT(DISTINCT pa.asin) FROM "AdProductAd" pa
           JOIN "AdGroup" g ON g.id = pa."adGroupId"
           JOIN "Campaign" c ON c.id = g."campaignId"
         WHERE c.marketplace = $1 AND pa.asin IS NOT NULL) AS advertised
    `, marketplace, week)
    const measuredAsins = Number(scope[0]?.measured_asins ?? 0)
    const advertised = Number(scope[0]?.advertised ?? 0)
    if (advertised > 0 && measuredAsins < advertised) {
      notes.push(
        `Scope: our side of every number here comes from ${measuredAsins} of ${advertised} advertised ASINs ` +
        `(${((measuredAsins / advertised) * 100).toFixed(0)}%) — the only ones Amazon has returned Search Query data for. ` +
        'The market side is the whole query market, so these shares are a FLOOR for the account, not its total.',
      )
    }
  }

  const multiAsin = rows.filter((r) => r.ourAsins > 1).length
  if (measured && multiAsin > 0) {
    notes.push(
      `${multiAsin} terms already show more than one of our ASINs on the same page. ` +
      'Presence is not the constraint here; share is.',
    )
  }

  /**
   * ACR Stage 5 — the ad-product split, from our own campaign performance.
   *
   * Read at CAMPAIGN entity level so a campaign is counted once; the same window as the
   * placement mix, so the two describe the same stretch of time.
   */
  const mixRows = await prisma.$queryRawUnsafe<{
    ad_product: string; impr: bigint; clicks: bigint; cost_micros: bigint
  }[]>(`
    SELECT "adProduct" AS ad_product,
           COALESCE(SUM(impressions), 0) AS impr,
           COALESCE(SUM(clicks), 0) AS clicks,
           COALESCE(SUM("costMicros"), 0) AS cost_micros
    FROM "AmazonAdsDailyPerformance"
    WHERE marketplace = $1 AND "entityType" = 'CAMPAIGN'
      AND date > now() - ($2 || ' days')::interval
    GROUP BY 1
  `, marketplace, String(COVERAGE_POSITION_WINDOW_DAYS))

  const AD_PRODUCTS = ['SPONSORED_PRODUCTS', 'SPONSORED_BRANDS', 'SPONSORED_DISPLAY'] as const
  const mixByProduct = new Map(mixRows.map((r) => [r.ad_product, r]))
  const totalMixImpr = mixRows.reduce((s, r) => s + Number(r.impr), 0)
  const adTypeMix: AdTypeMix = {
    windowDays: COVERAGE_POSITION_WINDOW_DAYS,
    // An ad product with zero impressions is dormant, not absent — it still has campaigns.
    activeAdProducts: AD_PRODUCTS.filter((p) => Number(mixByProduct.get(p)?.impr ?? 0) > 0).length,
    byAdProduct: AD_PRODUCTS.map((p) => {
      const r = mixByProduct.get(p)
      const impressions = Number(r?.impr ?? 0)
      return {
        adProduct: p,
        impressions,
        clicks: Number(r?.clicks ?? 0),
        costEur: Number(r?.cost_micros ?? 0) / 1e6,
        shareOfOurImpressions: totalMixImpr > 0 ? impressions / totalMixImpr : 0,
        searchAttributable: p !== 'SPONSORED_DISPLAY',
        dormant: impressions === 0,
      }
    }),
  }

  if (adTypeMix.activeAdProducts === 1) {
    const SHORT: Record<string, string> = { SPONSORED_PRODUCTS: 'SP', SPONSORED_BRANDS: 'SB', SPONSORED_DISPLAY: 'SD' }
    const dormant = adTypeMix.byAdProduct.filter((a) => a.dormant).map((a) => SHORT[a.adProduct] ?? a.adProduct)
    notes.push(
      `Every paid impression in the last ${COVERAGE_POSITION_WINDOW_DAYS} days came from one ad product. ` +
      `${dormant.join(' and ')} delivered nothing, so no slot stacking is happening — ` +
      'SB and SD occupy page-one slots SP cannot bid on.',
    )
  }

  // Pooled position-weighted score, over the rows we could measure position for. Deliberately
  // NOT over every row: mixing in terms with no position evidence would silently treat them as
  // rest-of-search and drag the number down by however many terms we happen not to bid.
  const positioned = rows.filter((r) => r.pwScore != null && r.share != null)
  const pwTotal = positioned.length > 0
    ? positioned.reduce((sum, r) => sum + r.pwScore! * r.marketImpressions, 0) /
      positioned.reduce((sum, r) => sum + r.marketImpressions, 0)
    : null

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
    positionWeight,
    tosIsMeasured,
    pwTotal,
    adTypeMix,
  }
}
