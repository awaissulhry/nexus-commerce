/**
 * ACR.6 — the Family Cockpit: one portfolio, everything that governs it, in one read.
 *
 * This is the surface the whole engagement was opened for. The operator's words, day one:
 * "I have three jackets... how could we run campaigns so all of them show on the first page?
 * For each portfolio, how could we automate harvesting, negating, and promoting the keywords,
 * or managing the budget of them all? I must have proper control over each and everything."
 *
 * The Control Room answers that ACCOUNT-wide. This answers it for ONE family — a portfolio —
 * because that is the unit the operator actually thinks in: the GALE jackets, the AIRMESH
 * jackets, each with its own products, its own keyword set, its own budget, its own automation
 * posture.
 *
 * Composition, not invention: every number here comes from a service that already exists
 * (coverage scoreboard with the family lens, proposal pricing with the family filter, champion
 * rule from keyword-conflicts — the one aligned with the rank engine), and every CONTROL the
 * UI offers is an endpoint that already exists (per-campaign allowlist, campaign PATCH,
 * portfolio PATCH). This service adds no write path of its own.
 *
 * Where per-family control does NOT exist yet in an engine (harvest/negate rules are
 * marketplace-scoped, not portfolio-scoped), the cockpit says so explicitly rather than
 * pretending — a control surface that implies control it doesn't have is worse than none.
 */
import prisma from '../../db.js'
import { getCoverageScoreboard, type CoverageScoreboard } from './ads-coverage.service.js'
import { pricePendingProposals, type ProposalPricing } from './ads-proposal-pricing.service.js'
import { pickChampion, type Contender } from './keyword-conflicts.service.js'

export interface FamilyCampaign {
  id: string
  name: string
  status: string
  marketplace: string | null
  dailyBudgetEur: number
  /** Automation may write to this campaign (the write-gate allowlist). The toggle is live. */
  liveWritesEnabled: boolean
  minBidCents: number | null
  maxBidCents: number | null
  deliveryStatus: string | null
  deliveryReasons: string[]
  /** Rank/dayparting schedules attached to this campaign (enabled count). */
  schedules: number
  spend30dCents: number
  sales30dCents: number
  acos30d: number | null
}

export interface FamilyProduct {
  productId: string
  sku: string | null
  name: string | null
  asin: string | null
  ads: number
}

export interface FamilyContest {
  term: string
  matchType: string
  contenders: Array<{
    campaignId: string
    campaignName: string
    targets: number
    impressions30d: number
    clicks30d: number
    spend30dCents: number
    sales30dCents: number
  }>
  /** The aligned champion (same ordering the rank engine acts on). */
  championCampaignId: string
  championReason: string
}

export interface FamilyCockpit {
  portfolio: {
    externalPortfolioId: string
    name: string
    state: string | null
    marketplace: string | null
    budgetAmountCents: number | null
    budgetPolicy: string | null
    inBudget: boolean | null
    lastSyncedAt: string | null
  }
  campaigns: FamilyCampaign[]
  products: FamilyProduct[]
  totals: {
    campaigns: number
    enabled: number
    allowlisted: number
    spend30dCents: number
    sales30dCents: number
    acos30d: number | null
    dailyBudgetEur: number
  }
  /** Coverage through the family lens: our side = this family's ASINs only. */
  coverage: CoverageScoreboard | null
  /** Terms two or more of THIS family's campaigns bid — with the engine-aligned champion. */
  contests: FamilyContest[]
  /** Pending rule proposals that resolve into this family, priced. */
  proposals: ProposalPricing | null
  automation: {
    /** Engines whose scope includes these campaigns, with the honest scoping statement. */
    notes: string[]
    schedulesEnabled: number
    schedulesTotal: number
  }
}

export async function getFamilyCockpit(externalPortfolioId: string): Promise<FamilyCockpit | null> {
  const portfolio = await prisma.amazonAdsPortfolio.findFirst({
    where: { externalPortfolioId },
    orderBy: { updatedAt: 'desc' },
  })
  if (!portfolio) return null

  const conn = await prisma.amazonAdsConnection.findFirst({
    where: { profileId: portfolio.profileId },
    select: { marketplace: true },
  })
  const marketplace = conn?.marketplace ?? null

  const campaigns = await prisma.campaign.findMany({
    where: { portfolioId: externalPortfolioId },
    select: {
      id: true, name: true, status: true, marketplace: true, dailyBudget: true,
      liveBidWritesEnabled: true, minBidCents: true, maxBidCents: true,
      deliveryStatus: true, deliveryReasons: true, externalCampaignId: true,
    },
    orderBy: [{ status: 'asc' }, { name: 'asc' }],
  })
  const campaignIds = campaigns.map((c) => c.id)
  const extIds = campaigns.map((c) => c.externalCampaignId).filter((x): x is string => !!x)

  const [perf, schedules, ads] = await Promise.all([
    extIds.length
      ? prisma.$queryRawUnsafe<{ id: string; spend: bigint; sales: bigint }[]>(`
        SELECT "entityId" AS id, COALESCE(SUM("costMicros")/10000,0) AS spend, COALESCE(SUM("sales7dCents"),0) AS sales
        FROM "AmazonAdsDailyPerformance"
        WHERE "entityType" = 'CAMPAIGN' AND date > now() - interval '30 days'
          AND "entityId" IN (${extIds.map((x) => `'${x.replace(/'/g, "''")}'`).join(',')})
        GROUP BY 1`)
      : Promise.resolve([]),
    campaignIds.length
      ? prisma.adSchedule.groupBy({
        by: ['campaignId', 'enabled'],
        where: { campaignId: { in: campaignIds } },
        _count: { _all: true },
      })
      : Promise.resolve([]),
    campaignIds.length
      ? prisma.adProductAd.findMany({
        where: { adGroup: { campaignId: { in: campaignIds } } },
        select: {
          productId: true, asin: true,
          product: { select: { sku: true, name: true } },
        },
      })
      : Promise.resolve([]),
  ])

  const perfBy = new Map(perf.map((r) => [r.id, { spend: Number(r.spend), sales: Number(r.sales) }]))
  const schedBy = new Map<string, { on: number; total: number }>()
  for (const s of schedules) {
    const r = schedBy.get(s.campaignId) ?? { on: 0, total: 0 }
    r.total += s._count._all
    if (s.enabled) r.on += s._count._all
    schedBy.set(s.campaignId, r)
  }

  const familyCampaigns: FamilyCampaign[] = campaigns.map((c) => {
    const p = c.externalCampaignId ? perfBy.get(c.externalCampaignId) : undefined
    const spend = p?.spend ?? 0
    const sales = p?.sales ?? 0
    return {
      id: c.id, name: c.name, status: c.status, marketplace: c.marketplace,
      dailyBudgetEur: Number(c.dailyBudget ?? 0),
      liveWritesEnabled: c.liveBidWritesEnabled,
      minBidCents: c.minBidCents, maxBidCents: c.maxBidCents,
      deliveryStatus: c.deliveryStatus, deliveryReasons: c.deliveryReasons ?? [],
      schedules: schedBy.get(c.id)?.on ?? 0,
      spend30dCents: spend, sales30dCents: sales,
      acos30d: sales > 0 ? spend / sales : null,
    }
  })

  // Products: one row per product, ads counted. ASIN comes from AdProductAd.asin.
  const prodMap = new Map<string, FamilyProduct>()
  for (const a of ads) {
    const key = a.productId ?? a.asin ?? 'unknown'
    const r = prodMap.get(key) ?? {
      productId: a.productId ?? '', sku: a.product?.sku ?? null,
      name: a.product?.name ?? null, asin: a.asin ?? null, ads: 0,
    }
    r.ads += 1
    if (!r.asin && a.asin) r.asin = a.asin
    prodMap.set(key, r)
  }
  const products = [...prodMap.values()].sort((a, b) => b.ads - a.ads)
  const familyAsins = [...new Set(products.map((p) => p.asin).filter((x): x is string => !!x))]

  // ── Coverage through the family lens ────────────────────────────────────
  const coverage = marketplace && familyAsins.length
    ? await getCoverageScoreboard({ marketplace, limit: 100, asins: familyAsins, campaignIds }).catch(() => null)
    : null

  // ── Contested terms within the family, championed by the engine's rule ──
  const contests: FamilyContest[] = []
  if (campaignIds.length > 1) {
    const rows = await prisma.$queryRawUnsafe<{
      term: string; match: string; campaign_id: string; campaign: string
      targets: bigint; impressions: bigint; clicks: bigint; spend_c: bigint; sales_c: bigint
    }[]>(`
      SELECT LOWER(t."expressionValue") AS term,
             REPLACE(t."expressionType", '_', '') AS match,
             c.id AS campaign_id, c.name AS campaign,
             COUNT(DISTINCT t.id) AS targets,
             COALESCE(SUM(d.impressions),0) AS impressions,
             COALESCE(SUM(d.clicks),0) AS clicks,
             COALESCE(SUM(d."costMicros")/10000,0) AS spend_c,
             COALESCE(SUM(d."sales7dCents"),0) AS sales_c
      FROM "AdTarget" t
      JOIN "AdGroup" g ON g.id = t."adGroupId"
      JOIN "Campaign" c ON c.id = g."campaignId"
      LEFT JOIN "AmazonAdsDailyPerformance" d
        ON d."entityType" = 'AD_TARGET' AND d."entityId" = t."externalTargetId"
       AND d.date > now() - interval '30 days'
      WHERE c.id IN (${campaignIds.map((x) => `'${x}'`).join(',')})
        AND t.kind = 'KEYWORD' AND t."isNegative" = false AND t.status = 'ENABLED'
      GROUP BY 1,2,3,4`)

    const byKey = new Map<string, typeof rows>()
    for (const r of rows) {
      const k = `${r.term}|${r.match}`
      const arr = byKey.get(k) ?? []
      arr.push(r)
      byKey.set(k, arr)
    }
    for (const [key, group] of byKey) {
      const perCamp = new Map<string, (typeof rows)[number]>()
      for (const r of group) {
        const prev = perCamp.get(r.campaign_id)
        if (prev) {
          prev.targets += r.targets; prev.impressions += r.impressions
          prev.clicks += r.clicks; prev.spend_c += r.spend_c; prev.sales_c += r.sales_c
        } else perCamp.set(r.campaign_id, { ...r })
      }
      if (perCamp.size < 2) continue
      const [term, matchType] = key.split('|')
      const contenders = [...perCamp.values()].map((r) => ({
        campaignId: r.campaign_id, campaignName: r.campaign,
        targets: Number(r.targets), impressions30d: Number(r.impressions),
        clicks30d: Number(r.clicks), spend30dCents: Number(r.spend_c), sales30dCents: Number(r.sales_c),
      }))
      const champ = pickChampion(contenders.map((c): Contender => ({
        campaignId: c.campaignId, campaignName: c.campaignName, status: 'ENABLED',
        asins: [], isMine: true, targetIds: [], bidCents: 0,
        impressions: c.impressions30d, clicks: c.clicks30d, spendCents: c.spend30dCents,
        salesCents: c.sales30dCents, orders: c.sales30dCents > 0 ? 1 : 0,
        acos: c.sales30dCents > 0 ? c.spend30dCents / c.sales30dCents : null,
        cvr: null, tosBias: 0,
      })))
      contests.push({
        term, matchType, contenders,
        championCampaignId: champ.championId, championReason: champ.reason,
      })
    }
    contests.sort((a, b) => b.contenders.length - a.contenders.length
      || b.contenders.reduce((x, c) => x + c.spend30dCents, 0) - a.contenders.reduce((x, c) => x + c.spend30dCents, 0))
  }

  // ── Proposals scoped to the family, priced ──────────────────────────────
  const proposals = campaignIds.length
    ? await pricePendingProposals(10, { campaignIds }).catch(() => null)
    : null

  const spend30 = familyCampaigns.reduce((a, c) => a + c.spend30dCents, 0)
  const sales30 = familyCampaigns.reduce((a, c) => a + c.sales30dCents, 0)
  const schedOn = familyCampaigns.reduce((a, c) => a + c.schedules, 0)
  const schedTotal = [...schedBy.values()].reduce((a, r) => a + r.total, 0)

  return {
    portfolio: {
      externalPortfolioId,
      name: portfolio.name,
      state: portfolio.state,
      marketplace,
      budgetAmountCents: portfolio.budgetAmount != null ? Math.round(Number(portfolio.budgetAmount) * 100) : null,
      budgetPolicy: portfolio.budgetPolicy,
      inBudget: portfolio.inBudget,
      lastSyncedAt: portfolio.lastSyncedAt?.toISOString() ?? null,
    },
    campaigns: familyCampaigns,
    products,
    totals: {
      campaigns: familyCampaigns.length,
      enabled: familyCampaigns.filter((c) => c.status === 'ENABLED').length,
      allowlisted: familyCampaigns.filter((c) => c.liveWritesEnabled).length,
      spend30dCents: spend30,
      sales30dCents: sales30,
      acos30d: sales30 > 0 ? spend30 / sales30 : null,
      dailyBudgetEur: familyCampaigns.filter((c) => c.status === 'ENABLED').reduce((a, c) => a + c.dailyBudgetEur, 0),
    },
    coverage,
    contests,
    proposals,
    automation: {
      schedulesEnabled: schedOn,
      schedulesTotal: schedTotal,
      /**
       * The honest scoping statements. Harvest/negate/promote rules are marketplace-scoped
       * today — there is no per-portfolio dial in the engine — so the cockpit SAYS that
       * instead of drawing a control that would silently govern nothing.
       */
      notes: [
        'Bid, budget and rank engines act only on campaigns whose live-writes switch below is ON — that switch is this family’s hard boundary, enforced at the write gate.',
        'Harvest, negate and promote rules are marketplace-scoped today, not portfolio-scoped: a rule that matches will act across the whole marketplace. Their proposals for this family appear below; per-family rule scoping is a planned engine change.',
        'Rank & dayparting schedules are per-campaign and listed per row — manage them on the Rank & Dayparting page.',
      ],
    },
  }
}
