/**
 * AX3.3 — Amazon DSP + DSP Plus (Performance+ / Brand+) scaffolding.
 *
 * DSP Plus is Amazon's AI-driven programmatic: Performance+ (lower-funnel,
 * conversion/ROAS, real-time first-party bidding) and Brand+ (upper-funnel,
 * reach/brand-lift across Fire TV, Twitch, Freevee, 3P). The DSP API is a
 * separate surface that needs a DSP advertiser entitlement; this builds the
 * full local model + builder so a brand can plan/launch DSP Plus campaigns,
 * link AMC audiences (AX3.4), and pick inventory — sandbox-safe until the DSP
 * entitlement + creds are wired (live create plugs into createDspCampaign).
 *
 * DSP campaigns are stored as Campaign rows (type 'DSP', adProduct
 * 'AMAZON_DSP') with the DSP Plus config under dynamicBidding.dsp — no new
 * table needed.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

export type DspMode = 'PERFORMANCE_PLUS' | 'BRAND_PLUS'
export const DSP_CHANNELS: Record<DspMode, string[]> = {
  PERFORMANCE_PLUS: ['Amazon.com', 'Fire TV', 'Twitch', 'Amazon Music', 'Third-party sites', 'Amazon Fresh'],
  BRAND_PLUS: ['Fire TV', 'Twitch', 'Freevee', 'Amazon.com', 'Third-party publishers'],
}
export const DSP_OBJECTIVES: Record<DspMode, Array<{ key: string; label: string }>> = {
  PERFORMANCE_PLUS: [{ key: 'ROAS', label: 'Maximize ROAS' }, { key: 'CPA', label: 'Target CPA' }, { key: 'CONVERSIONS', label: 'Maximize conversions' }, { key: 'NTB', label: 'New-to-brand growth' }],
  BRAND_PLUS: [{ key: 'REACH', label: 'Maximize reach' }, { key: 'AWARENESS', label: 'Brand awareness' }, { key: 'VIDEO_VIEWS', label: 'Video views' }, { key: 'CONSIDERATION', label: 'Consideration' }],
}

export interface DspConfig { mode: DspMode; objective: string; channels: string[]; audienceId: string | null; audienceName?: string | null; creativeNote?: string | null; targetValue?: number | null }
export interface NewDspCampaign { name: string; mode: DspMode; objective: string; marketplace?: string; dailyBudgetEur: number; channels?: string[]; audienceId?: string; creativeNote?: string; targetValue?: number; createdBy?: string }

export async function createDspCampaign(input: NewDspCampaign): Promise<{ id: string; mode: string; externalCampaignId: string | null }> {
  let audienceName: string | null = null
  if (input.audienceId) audienceName = (await prisma.adAudience.findUnique({ where: { id: input.audienceId }, select: { name: true } }))?.name ?? null
  const dsp: DspConfig = {
    mode: input.mode, objective: input.objective,
    channels: input.channels?.length ? input.channels : DSP_CHANNELS[input.mode],
    audienceId: input.audienceId ?? null, audienceName, creativeNote: input.creativeNote ?? null, targetValue: input.targetValue ?? null,
  }
  // Live DSP create plugs in here (separate DSP API + entitlement); sandbox
  // returns a stub id so the full plan/launch flow exercises end-to-end.
  const externalCampaignId = `sb-dsp-${Math.random().toString(36).slice(2, 10)}`
  const campaign = await prisma.campaign.create({
    data: {
      name: input.name, type: 'DSP', adProduct: 'AMAZON_DSP', status: 'ENABLED',
      marketplace: input.marketplace ?? 'IT', externalCampaignId,
      dailyBudget: input.dailyBudgetEur, biddingStrategy: input.mode === 'PERFORMANCE_PLUS' ? 'AUTO_FOR_SALES' : 'LEGACY_FOR_SALES',
      startDate: new Date(), lastSyncStatus: 'PENDING',
      dynamicBidding: { dsp } as never,
    },
  })
  await prisma.advertisingActionLog.create({ data: { userId: input.createdBy ?? null, actionType: 'create_dsp_campaign', entityType: 'CAMPAIGN', entityId: campaign.id, payloadBefore: {}, payloadAfter: dsp as never, amazonResponseStatus: 'SUCCESS' } }).catch(() => {})
  logger.info('[AX3.3] createDspCampaign', { id: campaign.id, mode: input.mode, objective: input.objective })
  return { id: campaign.id, mode: input.mode, externalCampaignId }
}

export async function listDspCampaigns() {
  const rows = await prisma.campaign.findMany({
    where: { type: 'DSP' }, orderBy: { createdAt: 'desc' }, take: 500,
    select: { id: true, name: true, status: true, marketplace: true, dailyBudget: true, impressions: true, clicks: true, spend: true, sales: true, dynamicBidding: true, createdAt: true },
  })
  const items = rows.map((r) => {
    const dsp = ((r.dynamicBidding as { dsp?: DspConfig })?.dsp) ?? null
    return {
      id: r.id, name: r.name, status: r.status, marketplace: r.marketplace,
      dailyBudget: r.dailyBudget, impressions: r.impressions, clicks: r.clicks, spend: r.spend, sales: r.sales,
      mode: dsp?.mode ?? null, objective: dsp?.objective ?? null, channels: dsp?.channels ?? [], audienceName: dsp?.audienceName ?? null,
    }
  })
  return { items, count: items.length }
}
