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

const API_BASE = process.env.EBAY_API_BASE ?? 'https://api.ebay.com'

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
  const conns = await prisma.channelConnection.findMany({ where: { channelType: 'EBAY', isActive: true } })
  report.connections = conns.length

  for (const conn of conns) {
    let token: string
    try {
      token = await auth.getValidToken(conn.id)
    } catch (e) {
      report.errors.push(`conn ${conn.id}: token ${(e as Error).message}`)
      continue
    }
    let offset = 0
    const limit = 100
    for (let page = 0; page < 20; page++) {
      let res: Response
      try {
        res = await fetch(`${API_BASE}/sell/marketing/v1/ad_campaign?limit=${limit}&offset=${offset}`, {
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        })
      } catch (e) {
        report.errors.push(`conn ${conn.id}: fetch ${(e as Error).message}`)
        break
      }
      if (res.status === 403) {
        report.errors.push(`conn ${conn.id}: 403 — token likely missing sell.marketing scope (re-authorize)`)
        break
      }
      if (!res.ok) {
        report.errors.push(`conn ${conn.id}: HTTP ${res.status}`)
        break
      }
      const body = (await res.json()) as { campaigns?: EbayAdCampaignDTO[]; total?: number }
      const campaigns = body.campaigns ?? []
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
      if (campaigns.length < limit) break
      offset += limit
    }
  }
  logger.info('[UM][ebay-marketing] sync complete', report)
  return report
}
