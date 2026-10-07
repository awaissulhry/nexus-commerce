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
import { EXCLUDE_AMS_DAILY } from '../ads-core/ams-daily.js'

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
 * How many daily-performance rows the copy holds at once: one page read, one page written.
 *
 * The copy used to read the whole table in one findMany (every ~70-column row, with its Decimal, BigInt and Date
 * objects), map it to a second array and send one createMany. Under Prisma 7's driver adapter all of that sits in the
 * V8 heap. At 74,870 rows (2026-10-07) it filled the scheduler's ~2 GB heap at 03:20 every night: the process spent
 * half an hour in garbage collection, missed every cron after it, and died "JavaScript heap out of memory".
 *
 * A page of 1,000 rows keeps the job's memory flat whatever the table's size, and one page is one INSERT
 * (1,000 rows x 25 columns stays under Postgres's bind-parameter limit).
 */
export const PERF_PAGE_ROWS = 1_000

/** Only the columns the copy writes, plus the id it pages on: the other ~45 columns are never read. */
const PERF_COPY_SELECT = {
  id: true,
  marketplace: true,
  date: true,
  entityType: true,
  entityId: true,
  localEntityId: true,
  impressions: true,
  clicks: true,
  costMicros: true,
  currencyCode: true,
  sales7dCents: true,
  sales14dCents: true,
  sales30dCents: true,
  orders7d: true,
  units7d: true,
  ntbOrders14d: true,
  viewableImpressions: true,
  detailPageViews7d: true,
  acos7d: true,
  roas7d: true,
  reportRunId: true,
  reportedAt: true,
} as const

/**
 * One page of the copy's source, in id order after `afterId`. Keyset paging (not offset), so each page costs the same
 * however deep the copy is.
 */
function readPerfPage(afterId: string | null, take: number) {
  return prisma.amazonAdsDailyPerformance.findMany({
    where: { ...EXCLUDE_AMS_DAILY, ...(afterId ? { id: { gt: afterId } } : {}) },
    orderBy: { id: 'asc' },
    take,
    select: PERF_COPY_SELECT,
  })
}

type PerfCopyRow = Awaited<ReturnType<typeof readPerfPage>>[number]

/** One source row as its CampaignMetric row. Unchanged mapping; `eur` is its costEurCents (null when no FX rate). */
function toCampaignMetricRow(p: PerfCopyRow, eur: bigint | null, extToNew: ReadonlyMap<string, string>) {
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
}

/**
 * Run the Amazon shadow backfill. apply=false returns the plan without
 * writing. Returns a parity report when apply=true.
 *
 * `pageRows` is for tests; the job and the endpoint use PERF_PAGE_ROWS.
 */
export async function backfillAmazonShadow(opts: { apply: boolean; pageRows?: number }): Promise<BackfillReport> {
  const { apply } = opts
  const pageRows = Math.max(1, Math.floor(opts.pageRows ?? PERF_PAGE_ROWS))
  const campaigns = await prisma.campaign.findMany({ orderBy: { createdAt: 'asc' } })
  // AX-IE.1 — exclude the AMS daily rows, for the same reason AX2.3 excludes them
  // from every console aggregate: the daily grain is owned by the report pipeline,
  // and Marketing Stream used to write a SECOND parallel set for the same
  // campaign-days under profileId 'ams'.
  //
  // They mattered here specifically because the destination key is narrower than
  // the source key — AmazonAdsDailyPerformance is unique on
  // (profileId, adProduct, entityType, entityId, date) but CampaignMetric is unique
  // on (channel, entityType, entityId, date). Two rows differing only by profileId
  // therefore collapsed, and `skipDuplicates` dropped whichever arrived second.
  // Measured: 616 of 25,192 rows, ALL of them profileId collisions, and the loser
  // was arbitrary — e.g. campaign 139838320481420 on 2026-06-06 had an 'ams' row at
  // cost 0 against the real IT row at EUR 4.79, so a day's spend could land as zero.
  // Excluding them makes the copy both correct and exactly parity-checkable.
  //
  // Counted here, read later in pages (PERF_PAGE_ROWS) — never held whole.
  const perfCount = await prisma.amazonAdsDailyPerformance.count({ where: { ...EXCLUDE_AMS_DAILY } })
  const fx = await buildFx()
  const marketCodes = await buildMarketCodeMap()
  logger.info(
    `[UM][backfill] apply=${apply} source: ${campaigns.length} campaigns, ${perfCount} perf, ${fx.size} fx`,
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
  // What was read and copied, page by page: the parity check compares the copy against exactly these rows.
  let sourceMetrics = perfCount
  let srcCost = 0n
  if (apply) {
    sourceMetrics = 0
    let afterId: string | null = null
    for (;;) {
      const page = await readPerfPage(afterId, pageRows)
      if (page.length === 0) break
      const data = page.map((p) => {
        srcCost += p.costMicros
        const eur = costEurCents(p.costMicros, p.currencyCode, fx)
        if (eur === null && p.currencyCode !== 'EUR') fxMissing++
        return toCampaignMetricRow(p, eur, extToNew)
      })
      const res = await prisma.campaignMetric.createMany({ data, skipDuplicates: true })
      writtenMetrics += res.count
      sourceMetrics += page.length
      if (page.length < pageRows) break
      afterId = page[page.length - 1].id
    }

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
    writtenMetrics = perfCount
  }

  let parity: BackfillReport['parity'] = null
  if (apply) {
    const [mc, cm, dstAgg] = await Promise.all([
      prisma.marketingCampaign.count({ where: { channel: 'AMAZON' } }),
      prisma.campaignMetric.count({ where: { channel: 'AMAZON' } }),
      prisma.campaignMetric.aggregate({ where: { channel: 'AMAZON' }, _sum: { costMicros: true } }),
    ])
    const dstCost = dstAgg._sum.costMicros ?? 0n
    const campaignsOk = mc === campaigns.length
    const metricsOk = cm === sourceMetrics
    const costOk = srcCost === dstCost
    parity = { campaignsOk, metricsOk, costOk, ok: campaignsOk && metricsOk && costOk }

    // Live-refresh any open cockpit.
    publishMarketingEvent({ type: 'campaign.mutated', campaignId: 'bulk', channel: 'AMAZON', action: 'updated', ts: Date.now() })
    publishMarketingEvent({ type: 'campaign.metrics.refreshed', channel: 'AMAZON', rows: writtenMetrics, ts: Date.now() })
    logger.info(`[UM][backfill] parity ok=${parity.ok} campaigns=${mc} metrics=${cm}`)
  }

  return {
    apply,
    source: { campaigns: campaigns.length, metrics: sourceMetrics, fxPairs: fx.size },
    written: { campaigns: writtenCampaigns, links: writtenLinks, metrics: writtenMetrics },
    skippedDupLinks,
    fxMissing,
    parity,
  }
}
