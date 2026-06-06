/**
 * B — live campaign-settings sync from Amazon (v3).
 *
 * The v1 unified export refreshes budget/strategy/state every 6h and carries NO
 * placement bids at all — so "Adjust bids by placement" shows null/0 and edits made
 * on Amazon take up to 6h to appear. This pulls each campaign's CURRENT settings
 * straight from the v3 campaigns API (dynamicBidding = strategy + placementBidding %,
 * budget, state) and writes them through NON-DESTRUCTIVELY: a field is updated only
 * when Amazon actually returned it, so a partial response can never zero a good value.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { listCampaignsV3, type AdsRegion, type V3CampaignSettings } from './ads-api-client.js'

const STATE_MAP: Record<string, 'ENABLED' | 'PAUSED' | 'ARCHIVED'> = { enabled: 'ENABLED', paused: 'PAUSED', archived: 'ARCHIVED' }

function mapStrategy(raw?: string): 'AUTO_FOR_SALES' | 'LEGACY_FOR_SALES' | 'MANUAL' | null {
  if (!raw) return null
  const s = raw.toUpperCase()
  if (s.includes('AUTO')) return 'AUTO_FOR_SALES'
  if (s.includes('MANUAL')) return 'MANUAL'
  if (s.includes('LEGACY')) return 'LEGACY_FOR_SALES'
  return null
}

export async function syncCampaignSettingsFromAmazon(
  opts?: { profileId?: string },
): Promise<{ profiles: number; campaigns: number; updated: number; placementsFilled: number; sampleShape?: unknown; errors: string[] }> {
  const conns = await prisma.amazonAdsConnection.findMany({
    where: opts?.profileId ? { profileId: opts.profileId } : {},
    select: { profileId: true, region: true, marketplace: true },
  })
  let campaigns = 0, updated = 0, placementsFilled = 0
  let sampleShape: unknown
  const errors: string[] = []

  for (const conn of conns) {
    const region: AdsRegion = conn.region === 'NA' || conn.region === 'FE' ? (conn.region as AdsRegion) : 'EU'
    let list: Awaited<ReturnType<typeof listCampaignsV3>> = []
    try {
      list = await listCampaignsV3({ profileId: conn.profileId, region })
    } catch (e) {
      errors.push(`${conn.profileId}: ${(e as Error).message.slice(0, 160)}`)
      continue
    }
    if (!sampleShape && list[0]) sampleShape = list[0]

    for (const c of list) {
      if (!c.campaignId) continue
      campaigns++
      const existing = await prisma.campaign.findFirst({ where: { externalCampaignId: c.campaignId }, select: { id: true, dynamicBidding: true } })
      if (!existing) continue

      const data: Record<string, unknown> = {}
      // dynamicBidding (strategy + placement bids) — merge so we don't drop keys
      // (e.g. our own maxBidChangePct guard) Amazon doesn't echo back.
      if (c.dynamicBidding && (c.dynamicBidding.strategy || c.dynamicBidding.placementBidding)) {
        const prev = (existing.dynamicBidding ?? {}) as Record<string, unknown>
        data.dynamicBidding = { ...prev, ...c.dynamicBidding }
        if ((c.dynamicBidding.placementBidding?.length ?? 0) > 0) placementsFilled++
      }
      if (typeof c.budget?.budget === 'number') data.dailyBudget = c.budget.budget
      const st = c.state ? STATE_MAP[c.state.toLowerCase()] : undefined
      if (st) data.status = st
      const strat = mapStrategy(c.dynamicBidding?.strategy)
      if (strat) data.biddingStrategy = strat

      if (Object.keys(data).length > 0) {
        try { await prisma.campaign.update({ where: { id: existing.id }, data }); updated++ } catch (e) { errors.push(`update ${c.campaignId}: ${(e as Error).message.slice(0, 120)}`) }
      }
    }
  }

  logger.info('[settings-sync] done', { profiles: conns.length, campaigns, updated, placementsFilled, errors: errors.length })
  return { profiles: conns.length, campaigns, updated, placementsFilled, sampleShape, errors }
}

// Map one v3 record onto a non-destructive update patch (only present fields).
function patchFromV3(c: V3CampaignSettings, prevDynamic: unknown): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  if (c.dynamicBidding && (c.dynamicBidding.strategy || c.dynamicBidding.placementBidding)) {
    data.dynamicBidding = { ...((prevDynamic ?? {}) as Record<string, unknown>), ...c.dynamicBidding }
  }
  if (typeof c.budget?.budget === 'number') data.dailyBudget = c.budget.budget
  const st = c.state ? STATE_MAP[c.state.toLowerCase()] : undefined
  if (st) data.status = st
  const strat = mapStrategy(c.dynamicBidding?.strategy)
  if (strat) data.biddingStrategy = strat
  return data
}

/** B (on-open) — refresh ONE campaign's settings live from Amazon. Resolves the
 *  campaign's account by marketplace, fetches just that campaign via the v3
 *  campaignIdFilter, and writes it through non-destructively. */
export async function syncOneCampaignSettings(campaignId: string): Promise<{ ok: boolean; placementBids?: number; error?: string }> {
  const camp = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { id: true, externalCampaignId: true, marketplace: true, dynamicBidding: true } })
  if (!camp?.externalCampaignId) return { ok: false, error: 'no_external_id' }
  const conn = await prisma.amazonAdsConnection.findFirst({ where: { marketplace: camp.marketplace }, select: { profileId: true, region: true } })
  if (!conn) return { ok: false, error: 'no_connection_for_marketplace' }
  const region: AdsRegion = conn.region === 'NA' || conn.region === 'FE' ? (conn.region as AdsRegion) : 'EU'
  let list: V3CampaignSettings[] = []
  try { list = await listCampaignsV3({ profileId: conn.profileId, region }, { campaignIds: [camp.externalCampaignId] }) } catch (e) { return { ok: false, error: (e as Error).message.slice(0, 160) } }
  const c = list.find((x) => x.campaignId === camp.externalCampaignId) ?? list[0]
  if (!c) return { ok: false, error: 'not_found_on_amazon' }
  const data = patchFromV3(c, camp.dynamicBidding)
  if (Object.keys(data).length > 0) await prisma.campaign.update({ where: { id: camp.id }, data })
  return { ok: true, placementBids: c.dynamicBidding?.placementBidding?.length ?? 0 }
}
