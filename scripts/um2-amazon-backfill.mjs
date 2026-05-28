#!/usr/bin/env node
// UM.2 — Amazon read-only shadow backfill (Unified Marketing OS, P2).
//
// One-shot DB→DB migration. Mirrors the shipped Amazon advertising data
// (legacy Campaign + AmazonAdsDailyPerformance) into the new unified
// MarketingCampaign tables so the cockpit (P3) and analytics (P14) read a
// channel-agnostic store. Legacy stays AUTHORITATIVE for Amazon writes
// until the P8 cutover — this only populates the shadow.
//
// Mapping mirrors apps/api/src/services/marketing/adapters/amazon.adapter.ts
// (normalizeCampaign / normalizeMetric). Keep the two in sync.
//
//   Campaign            → MarketingCampaign (channel=AMAZON) + AmazonAdsCampaignDetail
//   Campaign.marketplace + linkedMarketplaces → MarketingCampaignLink (one per market)
//   AmazonAdsDailyPerformance → CampaignMetric (+ costEurCents via FxRate)
//
// Idempotent: --apply does a delete-then-insert scoped to channel=AMAZON
// (P2 is the only writer of AMAZON marketing rows during shadow). Re-running
// is safe and converges.
//
// Usage:
//   node scripts/um2-amazon-backfill.mjs            # dry-run + parity preview
//   node scripts/um2-amazon-backfill.mjs --apply    # write the shadow
//   node scripts/um2-amazon-backfill.mjs --apply --limit 100

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import { PrismaClient } from '@prisma/client'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const limFlag = argv.findIndex((a) => a === '--limit')
const limit = limFlag >= 0 && argv[limFlag + 1] ? parseInt(argv[limFlag + 1], 10) : null

const prisma = new PrismaClient()

const SURFACE_BY_TYPE = { SP: 'SP', SB: 'SB', SD: 'SD' }
const STATUS_MAP = { ENABLED: 'ACTIVE', PAUSED: 'PAUSED', ARCHIVED: 'ENDED', DRAFT: 'DRAFT' }

const toCents = (d) => (d == null ? null : Math.round(parseFloat(d.toString()) * 100))

// ── FX: build EUR→cur rate lookup (latest asOf per pair) for costEurCents ──
async function buildFx() {
  const rates = await prisma.fxRate.findMany({
    where: { fromCurrency: 'EUR' },
    orderBy: { asOf: 'desc' },
  })
  const latest = new Map() // toCurrency → rate (first seen = latest)
  for (const r of rates) {
    if (!latest.has(r.toCurrency)) latest.set(r.toCurrency, parseFloat(r.rate.toString()))
  }
  return latest
}

// costMicros (in `currency`) → EUR cents, using frozen latest rate.
function costEurCents(costMicros, currency, fx) {
  const curCents = Number(costMicros) / 10000 // micros → cents
  if (currency === 'EUR') return BigInt(Math.round(curCents))
  const rate = fx.get(currency)
  if (!rate || rate <= 0) return null // no FX → leave null (surfaced as a warning)
  return BigInt(Math.round(curCents / rate))
}

// Map raw SP-API marketplaceId → short code ('A1PA6795UKMFR9' → 'DE') so
// the cockpit shows friendly market labels. Rows already holding a code
// pass through. Mirrors amazon-backfill.service.ts.
async function buildMarketCodeMap() {
  const rows = await prisma.marketplace.findMany({
    where: { channel: 'AMAZON', marketplaceId: { not: null } },
    select: { code: true, marketplaceId: true },
  })
  const map = new Map()
  for (const r of rows) if (r.marketplaceId) map.set(r.marketplaceId, r.code)
  return map
}
const normMarket = (m, map) => map.get(m) ?? m

async function main() {
  console.log(`[um2] mode=${apply ? 'APPLY' : 'DRY-RUN'}${limit ? ` limit=${limit}` : ''}`)

  const campaigns = await prisma.campaign.findMany({
    ...(limit ? { take: limit } : {}),
    orderBy: { createdAt: 'asc' },
  })
  const perf = await prisma.amazonAdsDailyPerformance.findMany()
  const fx = await buildFx()
  const marketCodes = await buildMarketCodeMap()
  console.log(`[um2] source: ${campaigns.length} Campaign, ${perf.length} AmazonAdsDailyPerformance, ${fx.size} FX pairs`)

  // Reset shadow (FK-safe: metrics carry SetNull, but clear explicitly).
  if (apply) {
    const delM = await prisma.campaignMetric.deleteMany({ where: { channel: 'AMAZON' } })
    const delC = await prisma.marketingCampaign.deleteMany({ where: { channel: 'AMAZON' } })
    console.log(`[um2] reset: -${delM.count} metric, -${delC.count} campaign (cascades links/detail)`)
  }

  // externalCampaignId → new MarketingCampaign.id (for CAMPAIGN-grain metric linkage).
  const extToNew = new Map()
  // MarketingCampaignLink @@unique([externalId, marketplace]) is GLOBAL —
  // guard against dupes from shared externalCampaignId + marketplaceId→code
  // collapse.
  const usedLinkKeys = new Set()
  let createdCampaigns = 0
  let createdLinks = 0
  let skippedDupLinks = 0

  for (const c of campaigns) {
    const surface = SURFACE_BY_TYPE[c.type] ?? 'SD'
    const marketplaces = [
      ...new Set(
        [
          ...(c.marketplace ? [c.marketplace] : []),
          ...c.linkedMarketplaces.filter((m) => m !== c.marketplace),
        ].map((m) => normMarket(m, marketCodes)),
      ),
    ]
    const primary = c.marketplace ? normMarket(c.marketplace, marketCodes) : marketplaces[0] ?? 'IT'
    const externalId = c.externalCampaignId ?? `legacy:${c.id}`
    const budgetScope = c.budgetScope === 'MULTI_MARKETPLACE' ? 'MULTI_MARKET' : 'SINGLE_MARKET'

    // Drop links whose (externalId, marketplace) key was already used.
    const eligibleMarkets = marketplaces.filter((mkt) => {
      const key = `${externalId}|${mkt}`
      if (usedLinkKeys.has(key)) {
        skippedDupLinks++
        return false
      }
      usedLinkKeys.add(key)
      return true
    })
    // Resolve a connection per market (sentinel when none).
    const linkData = await Promise.all(
      eligibleMarkets.map(async (mkt) => {
        const conn = await prisma.amazonAdsConnection.findFirst({ where: { marketplace: mkt } })
        return {
          marketplace: mkt,
          connectionId: conn?.id ?? `legacy:amazon:${mkt}`,
          externalId, // Amazon multi-market campaigns share one campaignId across markets
          status: STATUS_MAP[c.status] ?? 'DRAFT',
          currency: c.dailyBudgetCurrency,
          deliveryStatus: c.deliveryStatus,
          lastSyncedAt: c.lastSyncedAt,
          lastSyncStatus: c.lastSyncStatus ?? null,
          lastSyncError: c.lastSyncError,
        }
      })
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
          status: STATUS_MAP[c.status] ?? 'DRAFT',
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
          metadata: { legacyCampaignId: c.id, source: 'um2-backfill' },
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
    createdCampaigns++
    createdLinks += linkData.length
  }

  // ── Mirror metrics ────────────────────────────────────────────────────
  let createdMetrics = 0
  let fxMissing = 0
  if (apply) {
    const batch = []
    for (const p of perf) {
      const eur = costEurCents(p.costMicros, p.currencyCode, fx)
      if (eur === null && p.currencyCode !== 'EUR') fxMissing++
      batch.push({
        campaignId: p.entityType === 'CAMPAIGN' ? (extToNew.get(p.entityId) ?? null) : null,
        channel: 'AMAZON',
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
      })
    }
    // createMany skips the unique-collision rows silently; our reset above
    // guarantees a clean slate so all insert.
    const res = await prisma.campaignMetric.createMany({ data: batch, skipDuplicates: true })
    createdMetrics = res.count

    // Roll up real spend/sales onto MarketingCampaign from CAMPAIGN-grain
    // metrics (legacy Campaign.spend/sales aggregates are often 0). Single
    // SQL UPDATE...FROM — not N concurrent prisma.update() calls.
    await prisma.$executeRawUnsafe(`
      UPDATE "MarketingCampaign" mc
      SET "spendCents" = COALESCE(agg.spend, 0)::int,
          "salesCents" = COALESCE(agg.sales, 0)::int
      FROM (
        SELECT "campaignId", SUM("costEurCents") AS spend, SUM("sales7dCents") AS sales
        FROM "CampaignMetric"
        WHERE channel = 'AMAZON' AND "entityType" = 'CAMPAIGN' AND "campaignId" IS NOT NULL
        GROUP BY "campaignId"
      ) agg
      WHERE mc.id = agg."campaignId"
    `)
  } else {
    createdMetrics = perf.length
  }

  // ── Parity report ───────────────────────────────────────────────────────
  console.log('\n[um2] === PLAN ===')
  console.log(`  MarketingCampaign (AMAZON): ${createdCampaigns}`)
  console.log(`  MarketingCampaignLink:      ${createdLinks}`)
  console.log(`  CampaignMetric:             ${createdMetrics}`)
  if (fxMissing) console.log(`  ⚠ ${fxMissing} non-EUR metric rows had no FX rate → costEurCents=null`)

  if (apply) {
    const mc = await prisma.marketingCampaign.count({ where: { channel: 'AMAZON' } })
    const lc = await prisma.marketingCampaignLink.count()
    const cm = await prisma.campaignMetric.count({ where: { channel: 'AMAZON' } })
    const srcCost = perf.reduce((a, p) => a + p.costMicros, 0n)
    const dstAgg = await prisma.campaignMetric.aggregate({
      where: { channel: 'AMAZON' },
      _sum: { costMicros: true },
    })
    const dstCost = dstAgg._sum.costMicros ?? 0n
    console.log('\n[um2] === PARITY (live counts) ===')
    const okCount = mc === campaigns.length
    const okMetric = cm === perf.length
    const okCost = srcCost === dstCost
    console.log(`  campaigns:  src=${campaigns.length} dst=${mc}  ${okCount ? '✓' : '✗ MISMATCH'}`)
    console.log(`  links:      dst=${lc}`)
    console.log(`  metrics:    src=${perf.length} dst=${cm}  ${okMetric ? '✓' : '✗ MISMATCH'}`)
    console.log(`  costMicros: src=${srcCost} dst=${dstCost}  ${okCost ? '✓' : '✗ MISMATCH'}`)
    const allOk = okCount && okMetric && okCost
    console.log(`\n[um2] PARITY: ${allOk ? 'PASS ✓' : 'FAIL ✗'}`)
    if (!allOk) process.exitCode = 1
  } else {
    console.log('\n[um2] dry-run complete — re-run with --apply to write the shadow.')
  }
}

main()
  .catch((e) => {
    console.error('[um2] ERROR', e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
