/**
 * UM-series (P10) — Internal channel adapter (content push + outreach).
 *
 * channel=INTERNAL campaigns have no external ad platform. They delegate:
 *   CONTENT_PUSH   → the MC channel-publish path (A+/Brand Story/listing copy)
 *   EMAIL/REVIEW   → the RV review-request / email pipeline (honors
 *                    EmailSuppression), targeting a CustomerSegment audience
 *
 * "Spend" is not meaningful here; metrics are sends / publishes / reviews-
 * collected. applyMutation handles a `launch` (kick the publish/outreach)
 * and state changes (pause/resume). Live delegation is gated by
 * NEXUS_MARKETING_WRITES_INTERNAL (see marketing-write-gate); sandbox
 * records intent + returns wouldChange without firing the pipeline.
 *
 * P10 wires the structure + sandbox launch. The deep MC-publish / RV-send
 * delegation is gated behind the env flag so it never fires accidentally;
 * flipping it on is a deliberate operator step (like the other channels).
 */

import type { MktSurface } from '@prisma/client'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import {
  registerAdapter,
  type ChannelAdapter,
  type AdapterCtx,
  type AdapterCapabilities,
  type NormalizedCampaign,
  type NormalizedMetric,
  type NormalizedMutation,
  type MutationResult,
  type DateRange,
} from './types.js'

const CAPABILITIES: AdapterCapabilities = {
  surfaces: ['CONTENT_PUSH', 'EMAIL_OUTREACH', 'REVIEW_OUTREACH'] as MktSurface[],
  supportsKeywords: false,
  supportsNegativeTargets: false,
  supportsAudiences: true, // CustomerSegment
  supportsLifetimeBudget: false,
  supportsDailyBudget: false,
  supportsMultiMarket: true,
  supportsBudgetRebalance: false,
}

function liveEnabled(): boolean {
  return process.env.NEXUS_MARKETING_WRITES_INTERNAL === '1'
}

class InternalAdapter implements ChannelAdapter {
  readonly channel = 'INTERNAL' as const
  readonly capabilities = CAPABILITIES

  async pullCampaigns(_ctx: AdapterCtx): Promise<NormalizedCampaign[]> {
    // INTERNAL campaigns are authored locally (no external source to pull).
    return []
  }

  async pullMetrics(_window: DateRange, _ctx: AdapterCtx): Promise<NormalizedMetric[]> {
    // Sends/publishes/reviews are recorded by the MC/RV pipelines; no
    // external pull. (Surfaced via CampaignMetric.extra in a later pass.)
    return []
  }

  async applyMutation(mutation: NormalizedMutation, ctx: AdapterCtx): Promise<MutationResult> {
    const campaignId = (mutation.payload.campaignId as string) ?? null
    // State changes need no external work for INTERNAL.
    if (mutation.syncType === 'MKT_STATE_UPDATE') {
      return { ok: true, status: 'SUCCESS', externalId: mutation.externalId ?? null }
    }
    // Launch: delegate to the content/outreach pipeline.
    if (mutation.syncType === 'MKT_LAUNCH') {
      if (!campaignId) return { ok: false, status: 'FAILED', error: 'no campaignId' }
      const detail = await prisma.marketingCampaign.findUnique({
        where: { id: campaignId },
        include: { contentPush: true, outreach: true },
      })
      if (!detail) return { ok: false, status: 'FAILED', error: 'campaign not found' }

      if (ctx.mode === 'sandbox' || !liveEnabled()) {
        logger.info('[MKT-SANDBOX][INTERNAL] would launch', {
          campaignId,
          contentType: detail.contentPush?.contentType,
          outreachMode: detail.outreach?.mode,
        })
        return {
          ok: true,
          status: 'SUCCESS',
          externalId: `internal:${campaignId}`,
          wouldChange: {
            kind: detail.contentPush ? 'CONTENT_PUSH' : detail.outreach ? 'OUTREACH' : 'unknown',
            targets: detail.contentPush?.targetRefs ?? [],
            segmentId: detail.outreach?.segmentId ?? null,
          },
        }
      }

      // Live delegation (gated). Kept thin + defensive — the MC publish /
      // RV send services own the heavy lifting and their own gates.
      try {
        if (detail.contentPush) {
          const { publishContentPush } = await import('./internal-delegates.js')
          await publishContentPush(detail.contentPush)
        } else if (detail.outreach) {
          const { sendOutreach } = await import('./internal-delegates.js')
          await sendOutreach(detail.outreach)
        }
        return { ok: true, status: 'SUCCESS', externalId: `internal:${campaignId}` }
      } catch (err) {
        return { ok: false, status: 'FAILED', error: (err as Error)?.message }
      }
    }
    // No budget/bid concepts for INTERNAL.
    return { ok: true, status: 'SUCCESS', wouldChange: { noop: mutation.syncType } }
  }

  async setBudget(_externalId: string, _cents: number, _ctx: AdapterCtx): Promise<MutationResult> {
    return { ok: false, status: 'FAILED', error: 'INTERNAL campaigns have no budget' }
  }
}

export const internalAdapter = new InternalAdapter()
registerAdapter(internalAdapter)
logger.debug('[UM] InternalAdapter registered (content + outreach, P10)')
