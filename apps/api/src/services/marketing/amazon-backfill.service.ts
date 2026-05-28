/**
 * UM-series (P3.1) — Amazon read-only shadow backfill, in-process service.
 *
 * The callable twin of scripts/um2-amazon-backfill.mjs so the backfill can
 * run ON the API server (which holds the prod DB credentials) via a gated
 * trigger endpoint — the same pattern the AD-series uses for its sync/
 * ingest triggers. Mirrors Campaign / AmazonAdsDailyPerformance → the new
 * MarketingCampaign tables; legacy stays authoritative until the P8 cutover.
 *
 * Idempotent: delete-then-insert scoped to channel=AMAZON (this is the only
 * writer of AMAZON marketing rows during the shadow phase). Publishes
 * marketing events on completion so any open cockpit refreshes live.
 *
 * Mapping kept in lockstep with amazon.adapter.ts (normalizeCampaign /
 * normalizeMetric) and the standalone script.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { publishMarketingEvent } from '../marketing-events.service.js'

const SURFACE_BY_TYPE: Record<string, 'SP' | 'SB' | 'SD'> = { SP: 'SP', SB: 'SB', SD: 'SD' }
const STATUS_MAP: Record<string, string> = {
  ENABLED: 'ACTIVE',
  PAUSED: 'PAUSED',
  ARCHIVED: 'ENDED',
  DRAFT: 'DRAFT',
}

function toCents(d: { toString(): string } | null | undefined): number | null {
  if (d == null) return null
  return Math.round(parseFloat(d.toString()) * 100)
}

/** Build EUR→cur latest-rate lookup for costEurCents normalization. */
async function buildFx(): Promise<Map<string, number>> {
  const rates = await prisma.fxRate.findMany({
    where: { fromCurrency: 'EUR' },
    orderBy: { asOf: 'desc' },
  })
  const latest = new Map<string, number>()
  for (const r of rates) {
    if (!latest.has(r.toCurrency)) latest.set(r.toCurrency, parseFloat(r.rate.toString()))
  }
  return latest
}

function costEurCents(costMicros: bigint, currency: string, fx: Map<string, number>): bigint | null {
  const curCents = Number(costMicros) / 10000
  if (currency === 'EUR') return BigInt(Math.round(curCents))
  const rate = fx.get(currency)
  if (!rate || rate <= 0) return null
  return BigInt(Math.round(curCents / rate))
}

/**
 * Some legacy Campaign rows store the raw SP-API marketplaceId
 * (e.g. 'A1PA6795UKMFR9') in .marketplace instead of the short code
 * ('DE'). Build an id→code map from the Marketplace reference table so
 * the cockpit shows friendly market labels. Rows already holding a short
 * code pass through unchanged.
 */
async function buildMarketCodeMap(): Promise<Map<string, string>> {
  const rows = await prisma.marketplace.findMany({
    where: { channel: 'AMAZON', marketplaceId: { not: null } },
    select: { code: true, marketplaceId: true },
  })
  const map = new Map<string, string>()
  for (const r of rows) if (r.marketplaceId) map.set(r.marketplaceId, r.code)
  return map
}

const normMarket = (m: string, map: Map<string, string>): string => map.get(m) ?? m

export interface BackfillReport {
  apply: boolean
  source: { campaigns: number; metrics: number; fxPairs: number }
  written: { campaigns: number; links: number; metrics: number }
  skippedDupLinks: number
  fxMissing: number
  parity: { campaignsOk: boolean; metricsOk: boolean; costOk: boolean; ok: boolean } | null
}

/**
 * Run the Amazon shadow backfill. apply=false returns the plan without
 * writing. Returns a parity report when apply=true.
 */
export async function backfillAmazonShadow(opts: { apply: boolean }): Promise<BackfillReport> {
  const { apply } = opts
  const campaigns = await prisma.campaign.findMany({ orderBy: { createdAt: 'asc' } })
  const perf = await prisma.amazonAdsDailyPerformance.findMany()
  const fx = await buildFx()
  const marketCodes = await buildMarketCodeMap()
  logger.info(
    `[UM][backfill] apply=${apply} source: ${campaigns.length} campaigns, ${perf.length} perf, ${fx.size} fx`,
  )

  if (apply) {
    await prisma.campaignMetric.deleteMany({ where: { channel: 'AMAZON' } })
    await prisma.marketingCampaign.deleteMany({ where: { channel: 'AMAZON' } })
  }

  const extToNew = new Map<string, string>()
  // MarketingCampaignLink has @@unique([externalId, marketplace]) GLOBALLY.
  // Multi-market legacy campaigns can share an externalCampaignId across
  // rows, and the marketplaceId→code mapping can collapse distinct raw ids
  // to the same code — both would collide. Track used keys and skip dupes.
  const usedLinkKeys = new Set<string>()
  let writtenCampaigns = 0
  let writtenLinks = 0
  let skippedDupLinks = 0

  for (const c of campaigns) {
    const surface = SURFACE_BY_TYPE[c.type] ?? 'SD'
    const rawMarkets = [
      ...(c.marketplace ? [c.marketplace] : []),
      ...c.linkedMarketplaces.filter((m) => m !== c.marketplace),
    ]
    // Map to codes then dedupe within the campaign (two raw ids → one code).
    const marketplaces = [...new Set(rawMarkets.map((m) => normMarket(m, marketCodes)))]
    const primary = c.marketplace ? normMarket(c.marketplace, marketCodes) : marketplaces[0] ?? 'IT'
    // Treat null/undefined/"" externalCampaignId as missing → unique
    // legacy:<id> key. (?? misses ""; many locally-authored/unsynced legacy
    // campaigns carry an empty string, which would collapse every link to
    // "|<market>" and the global dedup would keep only the first — leaving
    // most campaigns with zero links.)
    const externalId =
      c.externalCampaignId && c.externalCampaignId.trim() ? c.externalCampaignId : `legacy:${c.id}`
    const budgetScope = c.budgetScope === 'MULTI_MARKETPLACE' ? 'MULTI_MARKET' : 'SINGLE_MARKET'

    const eligibleMarkets = marketplaces.filter((mkt) => {
      const key = `${externalId}|${mkt}`
      if (usedLinkKeys.has(key)) {
        skippedDupLinks++
        return false
      }
      usedLinkKeys.add(key)
      return true
    })
    const linkData = await Promise.all(
      eligibleMarkets.map(async (mkt) => {
        const conn = await prisma.amazonAdsConnection.findFirst({ where: { marketplace: mkt } })
        return {
          marketplace: mkt,
          connectionId: conn?.id ?? `legacy:amazon:${mkt}`,
          externalId,
          status: STATUS_MAP[c.status] ?? 'DRAFT',
          currency: c.dailyBudgetCurrency,
          deliveryStatus: c.deliveryStatus,
          lastSyncedAt: c.lastSyncedAt,
          lastSyncStatus: c.lastSyncStatus ?? null,
          lastSyncError: c.lastSyncError,
        }
      }),
    )

    if (apply) {
      const created = await prisma.marketingCampaign.create({
        data: {
          channel: 'AMAZON',
          surface,
          objective: 'SALES',
          marketplaces,
          primaryMarketplace: primary,
          budgetScope,
          name: c.name,
          status: (STATUS_MAP[c.status] ?? 'DRAFT') as never,
          startDate: c.startDate,
          endDate: c.endDate,
          budgetCents: toCents(c.dailyBudget),
          budgetKind: 'DAILY',
          currency: c.dailyBudgetCurrency,
          spendCents: toCents(c.spend) ?? 0,
          salesCents: toCents(c.sales) ?? 0,
          acos: c.acos,
          roas: c.roas,
          deliveryStatus: c.deliveryStatus,
          deliveryReasons: c.deliveryReasons,
          lastSyncedAt: c.lastSyncedAt,
          lastSyncStatus: c.lastSyncStatus ?? null,
          lastSyncError: c.lastSyncError,
          metadata: { legacyCampaignId: c.id, source: 'um3-backfill-endpoint' },
          amazonAds: {
            create: {
              adProduct: c.adProduct ?? c.type,
              portfolioId: c.portfolioId,
              bidStrategyJson: c.bidStrategyJson ?? undefined,
              dynamicBidding: c.dynamicBidding ?? undefined,
              tactic: c.tactic,
              costType: c.costType,
              deliveryProfileNative: c.deliveryProfile,
              creativeAssetJson: c.creativeAssetJson ?? undefined,
              brandEntityId: c.brandEntityId,
            },
          },
          links: { create: linkData },
        },
      })
      extToNew.set(externalId, created.id)
    }
    writtenCampaigns++
    writtenLinks += linkData.length
  }

  let writtenMetrics = 0
  let fxMissing = 0
  if (apply) {
    const batch = perf.map((p) => {
      const eur = costEurCents(p.costMicros, p.currencyCode, fx)
      if (eur === null && p.currencyCode !== 'EUR') fxMissing++
      return {
        campaignId: p.entityType === 'CAMPAIGN' ? (extToNew.get(p.entityId) ?? null) : null,
        channel: 'AMAZON' as const,
        marketplace: p.marketplace,
        date: p.date,
        entityType: p.entityType,
        entityId: p.entityId,
        localEntityId: p.localEntityId,
        impressions: p.impressions,
        clicks: p.clicks,
        costMicros: p.costMicros,
        currencyCode: p.currencyCode,
        costEurCents: eur,
        sales7dCents: p.sales7dCents,
        sales14dCents: p.sales14dCents,
        sales30dCents: p.sales30dCents,
        orders7d: p.orders7d,
        units7d: p.units7d,
        ntbOrders14d: p.ntbOrders14d,
        viewableImpressions: p.viewableImpressions,
        detailPageViews7d: p.detailPageViews7d,
        attributionModel: 'amazon-windowed',
        acos7d: p.acos7d,
        roas7d: p.roas7d,
        reportRunId: p.reportRunId,
        reportedAt: p.reportedAt,
      }
    })
    const res = await prisma.campaignMetric.createMany({ data: batch, skipDuplicates: true })
    writtenMetrics = res.count

    // Roll up real spend/sales onto the denormalized campaign columns from
    // the CAMPAIGN-grain metrics (legacy Campaign.spend/sales aggregates are
    // often 0; the truth lives in the daily performance rows). spend =
    // sum(costEurCents) EUR-normalized; sales = sum(sales7dCents). A SINGLE
    // SQL UPDATE...FROM — not 338 concurrent prisma.update() calls, which
    // exhaust prod's pooled Neon connections. The roster + summary read
    // these columns, so this is what makes the cockpit show real numbers.
    await prisma.$executeRawUnsafe(`
      UPDATE "MarketingCampaign" mc
      SET "spendCents" = COALESCE(agg.spend, 0)::int,
          "salesCents" = COALESCE(agg.sales, 0)::int
      FROM (
        SELECT "campaignId",
               SUM("costEurCents") AS spend,
               SUM("sales7dCents") AS sales
        FROM "CampaignMetric"
        WHERE channel = 'AMAZON' AND "entityType" = 'CAMPAIGN' AND "campaignId" IS NOT NULL
        GROUP BY "campaignId"
      ) agg
      WHERE mc.id = agg."campaignId"
    `)
  } else {
    writtenMetrics = perf.length
  }

  let parity: BackfillReport['parity'] = null
  if (apply) {
    const [mc, cm, dstAgg] = await Promise.all([
      prisma.marketingCampaign.count({ where: { channel: 'AMAZON' } }),
      prisma.campaignMetric.count({ where: { channel: 'AMAZON' } }),
      prisma.campaignMetric.aggregate({ where: { channel: 'AMAZON' }, _sum: { costMicros: true } }),
    ])
    const srcCost = perf.reduce((a, p) => a + p.costMicros, 0n)
    const dstCost = dstAgg._sum.costMicros ?? 0n
    const campaignsOk = mc === campaigns.length
    const metricsOk = cm === perf.length
    const costOk = srcCost === dstCost
    parity = { campaignsOk, metricsOk, costOk, ok: campaignsOk && metricsOk && costOk }

    // Live-refresh any open cockpit.
    publishMarketingEvent({ type: 'campaign.mutated', campaignId: 'bulk', channel: 'AMAZON', action: 'updated', ts: Date.now() })
    publishMarketingEvent({ type: 'campaign.metrics.refreshed', channel: 'AMAZON', rows: writtenMetrics, ts: Date.now() })
    logger.info(`[UM][backfill] parity ok=${parity.ok} campaigns=${mc} metrics=${cm}`)
  }

  return {
    apply,
    source: { campaigns: campaigns.length, metrics: perf.length, fxPairs: fx.size },
    written: { campaigns: writtenCampaigns, links: writtenLinks, metrics: writtenMetrics },
    skippedDupLinks,
    fxMissing,
    parity,
  }
}
