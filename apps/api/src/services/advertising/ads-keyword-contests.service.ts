/**
 * ACR.2.3 — account-wide keyword contests: who else of ours is bidding this term.
 *
 * `detectKeywordConflicts` (RC3.2) answers "who contests MY campaign's keywords" and needs a
 * campaign to stand on. The Family Cockpit then answered the same question inside one portfolio
 * and found the thing that matters: **`Xavia GALE IT` has no internal contest at all.** All 13
 * of GALE's contested pairs are against the pre-portfolio campaigns living in OTHER portfolios
 * (`IT_Gale`, `Moss_Jacket`, `Auto_FBM_Gale_Misano_Moss`…). A per-campaign view and a
 * per-portfolio view both structurally cannot show that — each one is inside one of the boxes.
 *
 * So this is the account lens on the same question, and it is the one that makes the
 * consolidation work visible: measured on prod, IT holds **294 contested (term × match) pairs
 * across 6 portfolios, 127 of them spanning two or more portfolios**.
 *
 * ── What is deliberately shared with RC3.2, and what is not ──────────────────────────────────
 * `pickChampion` is imported, not reimplemented. It was aligned to the rank engine's
 * `[acos ?? +∞, −spend]` ordering in ACR.4 precisely so the manual and automatic paths cannot
 * name different winners, and a second copy of that ladder here would re-open the 83-keyword
 * divergence ACR.2.5 recorded. Its ladder is not touched.
 *
 * What differs from RC3.2 is only the SCOPE of the scan and the source of the numbers: RC3.2
 * reads the lifetime counters denormalised onto `AdTarget`, while this reads the AD_TARGET
 * grain of `AmazonAdsDailyPerformance` over a real 30-day window — the grain ACR.2.2 backfilled
 * and which now carries 31 days. A lifetime counter and a 30-day window disagree by
 * construction on any campaign older than a month, and the contest is a question about now.
 *
 * ── Negativity ──────────────────────────────────────────────────────────────────────────────
 * `isNegative`, never `expressionType`. 1,068 targets are stored as `expressionType = 'EXACT'`
 * with `isNegative = true`; filtering on the match-type string would rank negative keywords
 * against positives as contenders for the same auction, which is exactly the defect that
 * manufactured 90 phantom conflicts in the first consolidation analysis (ACR.2.4).
 *
 * Read-only. Every resolution stays a gated write on the existing endpoints.
 */
import prisma from '../../db.js'
import { pickChampion, tosBiasOf, acosOf, cvrOf, type Contender } from './keyword-conflicts.service.js'
import { contestFlags, NO_PORTFOLIO } from './ads-contest-flags.js'

export interface ContestContender extends Contender {
  /** Amazon's external portfolio id, or null for campaigns in no portfolio. */
  portfolioId: string | null
  portfolioName: string
}

export interface KeywordContest {
  term: string
  matchType: string
  contenders: ContestContender[]
  championId: string
  championReason: string
  /** The contest the Family Cockpit could not see: contenders sitting in different portfolios. */
  crossPortfolio: boolean
  portfolios: number
  /** At least one contender sits in no portfolio at all — the pre-portfolio campaigns. */
  unportfolioed: boolean
  /** Two or more contenders carry a positive top-of-search bias — they are bidding for one slot. */
  bothTop: boolean
  /** Contenders that actually took impressions in the window. The rest are dormant claims. */
  activeContenders: number
  /**
   * False when NO contender has spend, sales or impressions — the engine's ordering ties
   * across the board and the champion is a bid tie-break. Computed from the contenders, never
   * from `championReason`'s wording, so rewording the reason cannot silently drop the warning.
   */
  championHasEvidence: boolean
  spend30dCents: number
  sales30dCents: number
  impressions30d: number
}

export interface ContestBoard {
  marketplace: string
  windowDays: number
  /** Days of AD_TARGET-grain data actually present in the window — the honest denominator. */
  daysWithData: number
  totals: {
    contested: number
    crossPortfolio: number
    portfolios: number
    unportfolioedCampaigns: boolean
    campaigns: number
    spend30dCents: number
    /** Spend on contested terms by contenders the champion rule does NOT pick. */
    challengerSpend30dCents: number
  }
  contests: KeywordContest[]
  notes: string[]
}

type Row = {
  term: string; match: string; campaign_id: string; campaign: string; status: string
  portfolio_id: string | null; portfolio_name: string | null
  dynamic_bidding: unknown; bid_cents: number
  target_ids: string[]
  impressions: bigint; clicks: bigint; spend_c: bigint; sales_c: bigint; orders: bigint
}

export async function getAccountKeywordContests(args: {
  marketplace?: string
  windowDays?: number
  limit?: number
  crossPortfolioOnly?: boolean
} = {}): Promise<ContestBoard> {
  const marketplace = args.marketplace ?? 'IT'
  const windowDays = Math.max(7, Math.min(90, args.windowDays ?? 30))
  const limit = Math.max(10, Math.min(500, args.limit ?? 150))

  const rows = await prisma.$queryRawUnsafe<Row[]>(`
    SELECT LOWER(t."expressionValue") AS term,
           REPLACE(t."expressionType", '_', '') AS match,
           c.id AS campaign_id, c.name AS campaign, c.status::text AS status,
           c."portfolioId" AS portfolio_id, pf.name AS portfolio_name,
           c."dynamicBidding" AS dynamic_bidding,
           MAX(t."bidCents") AS bid_cents,
           ARRAY_AGG(DISTINCT t.id) AS target_ids,
           COALESCE(SUM(d.impressions), 0) AS impressions,
           COALESCE(SUM(d.clicks), 0) AS clicks,
           -- micros → cents: 1 EUR = 1,000,000 micros = 100 cents.
           COALESCE(SUM(d."costMicros") / 10000, 0) AS spend_c,
           COALESCE(SUM(d."sales7dCents"), 0) AS sales_c,
           COALESCE(SUM(d."orders7d"), 0) AS orders
    FROM "AdTarget" t
    JOIN "AdGroup" g ON g.id = t."adGroupId"
    JOIN "Campaign" c ON c.id = g."campaignId"
    LEFT JOIN "AmazonAdsPortfolio" pf ON pf."externalPortfolioId" = c."portfolioId"
    -- The campaign's ASINs are fetched SEPARATELY, below. Joining AdProductAd here would fan
    -- each (target × day) row out once per product ad in the ad group and inflate every SUM by
    -- the ad count — a silent multiplication, since the shape of the result looks unchanged.
    --
    -- AD_TARGET grain. The join is on the EXTERNAL id: AmazonAdsDailyPerformance.entityId
    -- holds Amazon's id, and localEntityId is not populated for targets.
    LEFT JOIN "AmazonAdsDailyPerformance" d
      ON d."entityType" = 'AD_TARGET' AND d."entityId" = t."externalTargetId"
     AND d.date > now() - ($1 || ' days')::interval
    WHERE c.marketplace = $2
      AND t.kind = 'KEYWORD'
      AND t."isNegative" = false
      AND t.status = 'ENABLED'
      AND t."expressionValue" IS NOT NULL
    GROUP BY 1, 2, 3, 4, 5, 6, 7, 8`, String(windowDays), marketplace)

  const grain = await prisma.$queryRawUnsafe<{ days: bigint; first: Date | null; last: Date | null }[]>(`
    SELECT COUNT(DISTINCT date) AS days, MIN(date) AS first, MAX(date) AS last
    FROM "AmazonAdsDailyPerformance"
    WHERE "entityType" = 'AD_TARGET' AND date > now() - ($1 || ' days')::interval`, String(windowDays))
  const daysWithData = Number(grain[0]?.days ?? 0)
  // Read the range rather than assert it. The previous note hardcoded "the grain began
  // accumulating on 2026-07-28" — true of the two-day state ACR.2.2 measured, and false the
  // moment its backfill landed 29 more. It then sat next to "covers 29 of the last 30 days",
  // which it directly contradicts: a grain starting 07-28 could show at most nine.
  // toISOString, not String(): a Date stringifies to "Tue Jul 07 2026 …" in the server locale,
  // and slice(0,10) then yields "Tue Jul 07" — a label, not a date an operator can sort or paste.
  const grainFirst = grain[0]?.first ? grain[0].first.toISOString().slice(0, 10) : null
  const grainLast = grain[0]?.last ? grain[0].last.toISOString().slice(0, 10) : null

  // One contest per (term × match). Match type is part of the key on purpose: the same word
  // held as EXACT by one campaign and BROAD by another is not the same auction.
  // ASINs per campaign, in their own query — see the fan-out note in the SQL above.
  const campaignIds = [...new Set(rows.map((r) => r.campaign_id))]
  const asinByCampaign = new Map<string, string[]>()
  if (campaignIds.length) {
    const ads = await prisma.adProductAd.findMany({
      where: { adGroup: { campaignId: { in: campaignIds } }, asin: { not: null } },
      select: { asin: true, adGroup: { select: { campaignId: true } } },
    })
    for (const a of ads) {
      const cid = a.adGroup?.campaignId
      if (!cid || !a.asin) continue
      const list = asinByCampaign.get(cid) ?? []
      if (!list.includes(a.asin)) list.push(a.asin)
      asinByCampaign.set(cid, list)
    }
  }

  // Keyed on a NUL, which cannot occur in a keyword or a match type — and term/match are then
  // read back off the ROWS, never parsed out of the key. Joining on a space and splitting it
  // back would shred every multi-word term, which is every term that matters on this board.
  const byKey = new Map<string, Row[]>()
  for (const r of rows) {
    const k = `${r.term}\u0000${r.match}`
    const a = byKey.get(k) ?? []
    a.push(r)
    byKey.set(k, a)
  }

  const contests: KeywordContest[] = []
  const allCampaigns = new Set<string>()
  const allPortfolios = new Set<string>()
  for (const group of byKey.values()) {
    if (group.length < 2) continue // one campaign holding a term is not a contest
    const { term, match: matchType } = group[0]!
    const contenders: ContestContender[] = group.map((r) => {
      const spendCents = Number(r.spend_c)
      const salesCents = Number(r.sales_c)
      const clicks = Number(r.clicks)
      const orders = Number(r.orders)
      return {
        campaignId: r.campaign_id,
        campaignName: r.campaign,
        status: r.status,
        isMine: true, // account-wide: every contender is ours, which is the whole point
        targetIds: r.target_ids ?? [],
        asins: asinByCampaign.get(r.campaign_id) ?? [],
        bidCents: Number(r.bid_cents ?? 0),
        impressions: Number(r.impressions),
        clicks,
        spendCents,
        salesCents,
        orders,
        acos: acosOf(spendCents, salesCents),
        cvr: cvrOf(orders, clicks),
        tosBias: tosBiasOf(r.dynamic_bidding),
        portfolioId: r.portfolio_id,
        portfolioName: r.portfolio_name ?? 'No portfolio',
      }
    })
    // Strongest evidence first inside the contest, so the champion is not buried mid-list.
    contenders.sort((a, b) => b.spendCents - a.spendCents || b.impressions - a.impressions)

    const champ = pickChampion(contenders)
    const flags = contestFlags(contenders)
    for (const c of contenders) { allCampaigns.add(c.campaignId); allPortfolios.add(c.portfolioId ?? NO_PORTFOLIO) }

    contests.push({
      term,
      matchType,
      contenders,
      championId: champ.championId,
      championReason: champ.reason,
      // Every flag below comes from ads-contest-flags.ts, which is unit-tested. In particular
      // `championHasEvidence` is derived from the contenders and NOT from championReason's
      // wording — the UI used to detect "no evidence" by string-matching that prose.
      crossPortfolio: flags.crossPortfolio,
      portfolios: flags.portfolios,
      unportfolioed: flags.unportfolioed,
      bothTop: flags.bothTop,
      activeContenders: flags.activeContenders,
      championHasEvidence: flags.hasEvidence,
      spend30dCents: contenders.reduce((s, c) => s + c.spendCents, 0),
      sales30dCents: contenders.reduce((s, c) => s + c.salesCents, 0),
      impressions30d: contenders.reduce((s, c) => s + c.impressions, 0),
    })
  }

  // Cross-portfolio first — those are the ones no existing surface can show — then by the money
  // actually moving through the contest.
  contests.sort((a, b) =>
    Number(b.crossPortfolio) - Number(a.crossPortfolio) ||
    b.spend30dCents - a.spend30dCents ||
    b.impressions30d - a.impressions30d)

  const crossPortfolio = contests.filter((c) => c.crossPortfolio).length
  const challengerSpend = contests.reduce(
    (s, c) => s + c.contenders.filter((x) => x.campaignId !== c.championId).reduce((t, x) => t + x.spendCents, 0), 0)

  const notes: string[] = []
  if (daysWithData === 0) {
    notes.push(
      'No AD_TARGET-grain rows in the window, so every contest below is decided on bids alone. ' +
      'Champions read "highest bid, no traffic yet" — that is the absence of evidence, not a verdict.')
  } else if (daysWithData < windowDays) {
    notes.push(
      `AD_TARGET grain covers ${daysWithData} of the last ${windowDays} days` +
      (grainFirst && grainLast ? ` (${grainFirst} → ${grainLast})` : '') + '.')
  }
  if (crossPortfolio > 0) {
    notes.push(
      `${crossPortfolio} of ${contests.length} contests span two or more portfolios. ` +
      'These are invisible from a campaign page and from a family cockpit alike — both sit inside one of the boxes.')
  }
  const tied = contests.filter((c) => !c.championHasEvidence).length
  if (tied > 0) {
    notes.push(
      `${tied} contests have no performance signal at all, so the engine's ordering ties and the champion is decided by bid. ` +
      'Retiring a loser on that basis is a coin toss — these are the rows to leave alone.')
  }

  const filtered = args.crossPortfolioOnly ? contests.filter((c) => c.crossPortfolio) : contests

  return {
    marketplace,
    windowDays,
    daysWithData,
    totals: {
      contested: contests.length,
      crossPortfolio,
      // Real portfolios only. The no-portfolio bucket is counted separately rather than
      // folded in as a seventh "portfolio", which is what makes "6 portfolios" mean six.
      portfolios: [...allPortfolios].filter((p) => p !== NO_PORTFOLIO).length,
      unportfolioedCampaigns: allPortfolios.has(NO_PORTFOLIO),
      campaigns: allCampaigns.size,
      spend30dCents: contests.reduce((s, c) => s + c.spend30dCents, 0),
      challengerSpend30dCents: challengerSpend,
    },
    contests: filtered.slice(0, limit),
    notes,
  }
}
