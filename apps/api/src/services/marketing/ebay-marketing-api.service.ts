/**
 * UM-series (P9 live) — eBay Promoted Listings (Marketing API) client.
 *
 * Reuses the existing eBay OAuth (EbayAuthService.getValidToken on the
 * connected ChannelConnection) — the SAME credentials the listing/orders
 * features use. The only prerequisite is the `sell.marketing` scope, which
 * is now in the consent list (ebay-auth.service); the operator re-authorizes
 * once so their token carries it.
 *
 * pullEbayCampaigns reads GET /sell/marketing/v1/ad_campaign per active eBay
 * connection and upserts EbayCampaign (the existing model) — the UM.9 eBay
 * backfill then mirrors those into MarketingCampaign. Writes (pause / set
 * bid % / budget) are gated by NEXUS_MARKETING_WRITES_EBAY (handled in the
 * adapter); this module is the read/sync side.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { EbayAuthService } from '../ebay-auth.service.js'
import { fetchCampaigns } from './ebay-ads-api.service.js'
import { listActiveConnections } from '../connection-resolver.service.js'

interface EbayAdCampaignDTO {
  campaignId: string
  campaignName: string
  campaignStatus: string // RUNNING | PAUSED | ENDED | SCHEDULED | ...
  fundingStrategy?: { fundingModel?: string; bidPercentage?: string }
  budget?: { daily?: { amount?: { value?: string; currency?: string } } }
  marketplaceId?: string // EBAY_IT ...
  startDate?: string
  endDate?: string
}

export interface EbaySyncReport {
  connections: number
  pulled: number
  upserted: number
  skipped: number
  errors: string[]
}

/**
 * Pull Promoted Listings campaigns from eBay for every active eBay
 * ChannelConnection and upsert into EbayCampaign. Idempotent (upsert on
 * channelConnectionId+externalCampaignId). Returns a sync report.
 */
export async function syncEbayCampaigns(): Promise<EbaySyncReport> {
  const auth = new EbayAuthService()
  const report: EbaySyncReport = { connections: 0, pulled: 0, upserted: 0, skipped: 0, errors: [] }
  // MAP.3 — already meant EVERY account; through the resolver so "active" has one
  // definition. This one was already multi-account correct.
  const conns = await listActiveConnections('EBAY')
  report.connections = conns.length

  for (const conn of conns) {
    let token: string
    try {
      token = await auth.getValidToken(conn.id)
    } catch (e) {
      report.errors.push(`conn ${conn.id}: token ${(e as Error).message}`)
      continue
    }
    // E8.0-2 — this used to run its own raw fetch/pagination loop (up to 20
    // pages per connection) straight at eBay, with NO quota accounting, while
    // drawing on the very same Marketing "Ads" 10k/day pool the E2 client
    // budgets. Reuse the metered client so every call is counted once.
    let campaigns: EbayAdCampaignDTO[]
    try {
      campaigns = (await fetchCampaigns(token)) as unknown as EbayAdCampaignDTO[]
    } catch (e) {
      const msg = (e as Error).message
      report.errors.push(
        msg.includes('403')
          ? `conn ${conn.id}: 403 — token likely missing sell.marketing scope (re-authorize)`
          : `conn ${conn.id}: ${msg}`,
      )
      continue
    }
    report.pulled += campaigns.length

    for (const c of campaigns) {
      if (!c.campaignId) { report.skipped++; continue }
      const advanced = c.fundingStrategy?.fundingModel === 'COST_PER_CLICK'
      const dailyVal = c.budget?.daily?.amount?.value
      await prisma.ebayCampaign.upsert({
        where: { channelConnectionId_externalCampaignId: { channelConnectionId: conn.id, externalCampaignId: c.campaignId } },
        create: {
          channelConnectionId: conn.id,
          externalCampaignId: c.campaignId,
          marketplace: c.marketplaceId ?? conn.marketplace ?? 'EBAY_IT',
          name: c.campaignName ?? c.campaignId,
          fundingStrategy: advanced ? 'ADVANCED' : 'STANDARD',
          bidPercentage: c.fundingStrategy?.bidPercentage ? c.fundingStrategy.bidPercentage : null,
          dailyBudget: dailyVal ?? null,
          budgetCurrency: c.budget?.daily?.amount?.currency ?? 'EUR',
          status: c.campaignStatus ?? 'DRAFT',
          startDate: c.startDate ? new Date(c.startDate) : new Date(),
          endDate: c.endDate ? new Date(c.endDate) : null,
        },
        update: {
          name: c.campaignName ?? c.campaignId,
          fundingStrategy: advanced ? 'ADVANCED' : 'STANDARD',
          bidPercentage: c.fundingStrategy?.bidPercentage ?? null,
          dailyBudget: dailyVal ?? null,
          status: c.campaignStatus ?? 'DRAFT',
          endDate: c.endDate ? new Date(c.endDate) : null,
        },
      })
      report.upserted++
    }
  }
  logger.info('[UM][ebay-marketing] sync complete', report)
  return report
}
