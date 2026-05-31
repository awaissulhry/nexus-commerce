/**
 * AME.4 — ad-metric reconciliation + self-heal.
 *
 * AME.1–3 made every DISPLAYED ad number derive live from
 * AmazonAdsDailyPerformance (campaign detail, by-product, trends), so the
 * surfaces are correct by construction. This service closes the loop:
 *
 *   • REPORT — account spend (authoritative CAMPAIGN rows) vs Σ attributed
 *     (PRODUCT_AD rows), both EUR-normalised; data-freshness per marketplace.
 *     Surfaces drift + stale-sync so "always accurate" is provable, not assumed.
 *   • SELF-HEAL — recompute the stale stored Campaign.spend/sales/acos/roas
 *     columns from the daily table. Those columns are vestigial for the rebuilt
 *     surfaces but the plain `/advertising/campaigns` list still returns them;
 *     healing keeps every reader honest (defence in depth). Bulk, idempotent.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { microsToCents, toEurCents } from './ads-metrics-math.js'
import { getFxRate } from '../fx-rate.service.js'

// A.3 — Amazon ad report data keeps restating for up to ~72h: impressions/
// clicks/cost firm up as invalid-traffic validation runs (up to 3 days) and
// conversions/sales settle even later. So a date is only AUTHORITATIVE once
// it's outside this window; data inside it is the current best estimate but
// may still move. The truth layer reports both, and never treats in-window
// movement as "drift".
export const RESTATEMENT_WINDOW_HOURS = Number(process.env.NEXUS_ADS_RESTATEMENT_HOURS ?? 72)

/**
 * The UTC day-floor boundary separating settled (authoritative) report dates
 * from provisional ones. A daily-perf row is settled iff its date < this. Pure
 * + exported for unit testing. e.g. now=2026-05-31T02:00Z, hours=72 →
 * 2026-05-28 (rows dated 05-27 and earlier are settled; 05-28+ provisional).
 */
export function settledCutoffDay(now: Date, hours: number = RESTATEMENT_WINDOW_HOURS): Date {
  const d = new Date(now.getTime() - hours * 3_600_000)
  d.setUTCHours(0, 0, 0, 0)
  return d
}

export interface ReconcileReport {
  windowDays: number
  accountSpendCents: number          // authoritative CAMPAIGN spend (EUR), full window
  attributedProductAdCents: number   // Σ PRODUCT_AD spend (EUR)
  variancePct: number | null         // (productAd − account) / account
  dataThrough: string | null         // newest daily-perf date across markets
  // A.3 — restatement truth layer.
  restatementWindowHours: number
  settledThrough: string | null      // newest date OUTSIDE the restatement window (authoritative boundary)
  settledSpendCents: number          // CAMPAIGN spend on settled dates (final)
  provisionalSpendCents: number      // CAMPAIGN spend still inside the restatement window (may move)
  staleMarketplaces: Array<{ marketplace: string; lastDate: string; daysStale: number }>
  healed: boolean
  campaignsHealed: number
  storedSpendDriftCentsBefore: number // Σ |stored − live| before heal
}

async function eurRate(fx: Map<string, number>, ccy: string | null | undefined): Promise<number> {
  const c = ccy || 'EUR'
  if (!fx.has(c)) fx.set(c, c === 'EUR' ? 1 : await getFxRate(prisma, c, 'EUR'))
  return fx.get(c)!
}

export async function reconcileAdMetrics(
  opts: { windowDays?: number; heal?: boolean } = {},
): Promise<ReconcileReport> {
  const windowDays = Math.max(1, Math.min(180, opts.windowDays ?? 30))
  const heal = opts.heal ?? false
  const since = new Date()
  since.setUTCDate(since.getUTCDate() - windowDays)
  since.setUTCHours(0, 0, 0, 0)
  const fx = new Map<string, number>()

  // Account (authoritative) + attributed (product-ad) spend, EUR-normalised.
  const [acctRows, paRows] = await Promise.all([
    prisma.amazonAdsDailyPerformance.groupBy({ by: ['currencyCode'], where: { entityType: 'CAMPAIGN', date: { gte: since } }, _sum: { costMicros: true } }),
    prisma.amazonAdsDailyPerformance.groupBy({ by: ['currencyCode'], where: { entityType: 'PRODUCT_AD', date: { gte: since } }, _sum: { costMicros: true } }),
  ])
  let accountSpendCents = 0
  for (const r of acctRows) accountSpendCents += toEurCents(microsToCents(r._sum.costMicros), await eurRate(fx, r.currencyCode))
  let attributedProductAdCents = 0
  for (const r of paRows) attributedProductAdCents += toEurCents(microsToCents(r._sum.costMicros), await eurRate(fx, r.currencyCode))

  // A.3 — split account spend into settled (authoritative, outside the
  // restatement window) vs provisional (still inside it, may move). settled =
  // [since, cutoffDay); provisional = the remainder of the full-window total.
  const cutoffDay = settledCutoffDay(new Date())
  const settledRows = await prisma.amazonAdsDailyPerformance.groupBy({
    by: ['currencyCode'],
    where: { entityType: 'CAMPAIGN', date: { gte: since, lt: cutoffDay } },
    _sum: { costMicros: true },
  })
  let settledSpendCents = 0
  for (const r of settledRows) settledSpendCents += toEurCents(microsToCents(r._sum.costMicros), await eurRate(fx, r.currencyCode))
  const provisionalSpendCents = Math.max(0, accountSpendCents - settledSpendCents)
  const settledThroughRow = await prisma.amazonAdsDailyPerformance.aggregate({
    where: { entityType: 'CAMPAIGN', date: { lt: cutoffDay } },
    _max: { date: true },
  })
  const settledThrough = settledThroughRow._max.date ? settledThroughRow._max.date.toISOString().slice(0, 10) : null

  // Freshness per marketplace (latest CAMPAIGN daily date).
  const fresh = await prisma.amazonAdsDailyPerformance.groupBy({ by: ['marketplace'], where: { entityType: 'CAMPAIGN' }, _max: { date: true } })
  const today = new Date(); today.setUTCHours(0, 0, 0, 0)
  let dataThrough: string | null = null
  const staleMarketplaces: ReconcileReport['staleMarketplaces'] = []
  for (const f of fresh) {
    if (!f._max.date) continue
    const ds = f._max.date.toISOString().slice(0, 10)
    if (!dataThrough || ds > dataThrough) dataThrough = ds
    const daysStale = Math.round((today.getTime() - f._max.date.getTime()) / 86_400_000)
    if (daysStale > 2) staleMarketplaces.push({ marketplace: f.marketplace, lastDate: ds, daysStale })
  }

  // Self-heal the stored Campaign.spend/sales/acos/roas from the daily table.
  let campaignsHealed = 0
  let storedSpendDriftCentsBefore = 0
  if (heal) {
    const liveRows = await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['localEntityId'],
      where: { entityType: 'CAMPAIGN', localEntityId: { not: null }, date: { gte: since } },
      _sum: { costMicros: true, sales7dCents: true, sales14dCents: true, impressions: true, clicks: true },
    })
    const campaigns = await prisma.campaign.findMany({ select: { id: true, spend: true } })
    const storedSpend = new Map(campaigns.map((c) => [c.id, Math.round(Number(c.spend ?? 0) * 100)]))
    for (const r of liveRows) {
      const cid = r.localEntityId
      if (!cid || !storedSpend.has(cid)) continue
      const liveSpend = microsToCents(r._sum.costMicros)
      const liveSales = (r._sum.sales7dCents ?? 0) + (r._sum.sales14dCents ?? 0)
      storedSpendDriftCentsBefore += Math.abs((storedSpend.get(cid) ?? 0) - liveSpend)
      await prisma.campaign.update({
        where: { id: cid },
        data: {
          spend: liveSpend / 100,
          sales: liveSales / 100,
          impressions: r._sum.impressions ?? 0,
          clicks: r._sum.clicks ?? 0,
          acos: liveSales > 0 ? liveSpend / liveSales : null,
          roas: liveSpend > 0 ? liveSales / liveSpend : null,
        },
      })
      campaignsHealed += 1
    }
    logger.info('[ads-reconcile] self-heal complete', { campaignsHealed, storedSpendDriftCentsBefore })
  }

  return {
    windowDays,
    accountSpendCents,
    attributedProductAdCents,
    variancePct: accountSpendCents > 0 ? Math.round(((attributedProductAdCents - accountSpendCents) / accountSpendCents) * 1000) / 10 : null,
    dataThrough,
    restatementWindowHours: RESTATEMENT_WINDOW_HOURS,
    settledThrough,
    settledSpendCents,
    provisionalSpendCents,
    staleMarketplaces,
    healed: heal,
    campaignsHealed,
    storedSpendDriftCentsBefore,
  }
}

// ── AF.3 — target-accuracy reconcile ───────────────────────────────────────
// Structural correctness of the keyword/target data, independent of metrics.
// Surfaces the failure modes this engagement closed so any regression is
// provable: duplicate campaign rows (the marketplace-split bug), campaigns
// that have negatives but ZERO positives (the NaN-bidCents drop symptom), and
// per-marketplace coverage. A manual ad group (externalAdGroupId set) with no
// positive keyword is the real tell; AUTO ad groups legitimately have none.
export interface TargetAccuracyReport {
  totalCampaigns: number
  duplicateExternalIds: number
  duplicateSamples: Array<{ externalCampaignId: string; copies: number }>
  manualCampaignsMissingPositives: number
  missingPositiveSamples: Array<{ id: string; name: string; marketplace: string; negatives: number }>
  // zeroBidPositives = all non-negative targets at €0. zeroBidEnabledPositives
  // = the ones that are also ENABLED — the real defect (an enabled keyword/
  // target with no bid won't serve). Archived/paused €0 targets are benign.
  totals: { positives: number; negatives: number; zeroBidPositives: number; zeroBidEnabledPositives: number }
  byMarketplace: Array<{ marketplace: string; campaigns: number; positives: number; negatives: number }>
}

export async function reconcileTargetAccuracy(): Promise<TargetAccuracyReport> {
  const campaigns = await prisma.campaign.findMany({
    where: { externalCampaignId: { not: null } },
    select: {
      id: true, name: true, marketplace: true, externalCampaignId: true,
      adGroups: { select: { externalAdGroupId: true, targetingType: true, targets: { select: { isNegative: true, bidCents: true, status: true } } } },
    },
  })

  // Duplicate externalCampaignId rows (should be 0 after the dedupe).
  const byExt = new Map<string, number>()
  for (const c of campaigns) byExt.set(c.externalCampaignId!, (byExt.get(c.externalCampaignId!) ?? 0) + 1)
  const dupes = [...byExt.entries()].filter(([, n]) => n > 1)

  let positives = 0, negatives = 0, zeroBidPositives = 0, zeroBidEnabledPositives = 0
  const missingPos: TargetAccuracyReport['missingPositiveSamples'] = []
  const mkt = new Map<string, { campaigns: number; positives: number; negatives: number }>()

  for (const c of campaigns) {
    let cPos = 0, cNeg = 0
    let hasManualAdGroup = false
    for (const ag of c.adGroups) {
      if (ag.targetingType !== 'AUTO' && ag.externalAdGroupId) hasManualAdGroup = true
      for (const t of ag.targets) {
        if (t.isNegative) { cNeg++ } else { cPos++; if (!t.bidCents || t.bidCents <= 0) { zeroBidPositives++; if (t.status === 'ENABLED') zeroBidEnabledPositives++ } }
      }
    }
    positives += cPos; negatives += cNeg
    const m = mkt.get(c.marketplace) ?? { campaigns: 0, positives: 0, negatives: 0 }
    m.campaigns++; m.positives += cPos; m.negatives += cNeg; mkt.set(c.marketplace, m)
    // Flag: a manual campaign with negatives but no positives (the original bug's footprint).
    if (hasManualAdGroup && cPos === 0 && cNeg > 0) missingPos.push({ id: c.id, name: c.name, marketplace: c.marketplace, negatives: cNeg })
  }

  return {
    totalCampaigns: campaigns.length,
    duplicateExternalIds: dupes.length,
    duplicateSamples: dupes.slice(0, 10).map(([externalCampaignId, copies]) => ({ externalCampaignId, copies })),
    manualCampaignsMissingPositives: missingPos.length,
    missingPositiveSamples: missingPos.slice(0, 20),
    totals: { positives, negatives, zeroBidPositives, zeroBidEnabledPositives },
    byMarketplace: [...mkt.entries()].map(([marketplace, v]) => ({ marketplace, ...v })).sort((a, b) => b.campaigns - a.campaigns),
  }
}
