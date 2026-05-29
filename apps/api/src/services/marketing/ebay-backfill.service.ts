/**
 * UM-series (P9) — eBay Promoted Listings read-only shadow backfill.
 *
 * Mirrors the Amazon shadow (UM.2): EbayCampaign → MarketingCampaign
 * (channel=EBAY, surface=PROMOTED_LISTINGS) + EbayPromotedDetail + a
 * MarketingCampaignLink per campaign, and one CampaignMetric per campaign
 * (eBay carries aggregate metrics, not a daily series) so eBay shows in
 * cross-channel analytics. Idempotent delete-then-insert scoped channel=EBAY.
 * Legacy EbayCampaign stays authoritative for eBay writes.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { publishMarketingEvent } from '../marketing-events.service.js'
import { normalizeEbayCampaign } from './adapters/ebay.adapter.js'

const toCents = (d: { toString(): string } | null | undefined): number | null =>
  d == null ? null : Math.round(parseFloat(d.toString()) * 100)

async function buildFx(): Promise<Map<string, number>> {
  const rates = await prisma.fxRate.findMany({ where: { fromCurrency: 'EUR' }, orderBy: { asOf: 'desc' } })
  const latest = new Map<string, number>()
  for (const r of rates) if (!latest.has(r.toCurrency)) latest.set(r.toCurrency, parseFloat(r.rate.toString()))
  return latest
}
function costEurCents(cents: number, currency: string, fx: Map<string, number>): bigint | null {
  if (currency === 'EUR') return BigInt(cents)
  const rate = fx.get(currency)
  return rate && rate > 0 ? BigInt(Math.round(cents / rate)) : null
}

export interface EbayBackfillReport {
  apply: boolean
  source: number
  written: { campaigns: number; links: number; metrics: number }
  parity: { ok: boolean; src: number; dst: number } | null
}

export async function backfillEbayShadow(opts: { apply: boolean }): Promise<EbayBackfillReport> {
  const { apply } = opts
  const campaigns = await prisma.ebayCampaign.findMany()
  const fx = await buildFx()
  logger.info(`[UM][ebay-backfill] apply=${apply} source=${campaigns.length}`)

  if (apply) {
    await prisma.campaignMetric.deleteMany({ where: { channel: 'EBAY' } })
    await prisma.marketingCampaign.deleteMany({ where: { channel: 'EBAY' } })
  }

  let writtenCampaigns = 0
  let writtenLinks = 0
  let writtenMetrics = 0

  for (const c of campaigns) {
    const n = normalizeEbayCampaign(c)
    const d = n.detail as Record<string, unknown>
    if (apply) {
      const created = await prisma.marketingCampaign.create({
        data: {
          channel: 'EBAY',
          surface: 'PROMOTED_LISTINGS',
          objective: 'SALES',
          marketplaces: [n.marketplace],
          primaryMarketplace: n.marketplace,
          budgetScope: 'SINGLE_MARKET',
          name: n.name,
          status: n.status as never,
          startDate: c.startDate,
          endDate: c.endDate,
          budgetCents: n.budgetCents ?? null,
          budgetKind: n.budgetKind ?? null,
          currency: n.currency,
          spendCents: (d.spendCents as number) ?? 0,
          salesCents: (d.salesCents as number) ?? 0,
          metadata: { legacyEbayCampaignId: c.id, source: 'um9-ebay-backfill' },
          ebayPromoted: {
            create: {
              fundingStrategy: c.fundingStrategy,
              bidPercentage: c.bidPercentage,
              channelConnectionId: c.channelConnectionId,
            },
          },
          links: {
            create: [
              {
                marketplace: n.marketplace,
                connectionId: c.channelConnectionId,
                externalId: c.externalCampaignId,
                status: n.status,
                currency: n.currency,
              },
            ],
          },
        },
      })
      writtenLinks++
      // One synthetic CAMPAIGN-grain metric carrying the aggregates.
      const spend = (d.spendCents as number) ?? 0
      await prisma.campaignMetric.create({
        data: {
          campaignId: created.id,
          channel: 'EBAY',
          marketplace: n.marketplace,
          date: (c.metricsAt ?? c.updatedAt),
          entityType: 'CAMPAIGN',
          entityId: c.externalCampaignId,
          impressions: c.impressions,
          clicks: c.clicks,
          costMicros: BigInt(spend * 10000),
          currencyCode: n.currency,
          costEurCents: costEurCents(spend, n.currency, fx),
          sales7dCents: (d.salesCents as number) ?? 0,
          attributionModel: 'ebay-reported',
          reportedAt: c.metricsAt ?? c.updatedAt,
        },
      })
      writtenMetrics++
    } else {
      writtenLinks++
      writtenMetrics++
    }
    writtenCampaigns++
  }

  let parity: EbayBackfillReport['parity'] = null
  if (apply) {
    const dst = await prisma.marketingCampaign.count({ where: { channel: 'EBAY' } })
    parity = { ok: dst === campaigns.length, src: campaigns.length, dst }
    publishMarketingEvent({ type: 'campaign.mutated', campaignId: 'bulk', channel: 'EBAY', action: 'updated', ts: Date.now() })
  }
  return { apply, source: campaigns.length, written: { campaigns: writtenCampaigns, links: writtenLinks, metrics: writtenMetrics }, parity }
}
