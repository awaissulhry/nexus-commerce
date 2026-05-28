/**
 * UM-series (P10) — live delegation hooks for the Internal adapter.
 *
 * These fire ONLY when NEXUS_MARKETING_WRITES_INTERNAL=1 (the adapter
 * gates on it). They are intentionally thin and self-contained: they
 * record launch intent + emit a marketing event, rather than reaching
 * deep into the MC channel-publish / RV review-send services. Wiring the
 * full pipelines (channel-publish.service.ts publish fan-out; the reviews/
 * request mailer honoring EmailSuppression) is the operator-prioritized
 * extension — kept behind the gate so nothing fires until that wiring +
 * the env flag are both in place.
 */

import type { ContentPushDetail, OutreachDetail } from '@prisma/client'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { publishMarketingEvent } from '../../marketing-events.service.js'

export async function publishContentPush(detail: ContentPushDetail): Promise<void> {
  // Record the launch on the campaign metadata + audit; the real publish
  // fan-out (Amazon JSON_LISTINGS_FEED / eBay picture set / Shopify pool)
  // is delegated to channel-publish.service in the gated extension.
  logger.info('[UM][INTERNAL] content push launch (intent recorded)', {
    campaignId: detail.campaignId,
    contentType: detail.contentType,
    targets: detail.targetRefs,
  })
  await prisma.campaignAction.create({
    data: {
      campaignId: detail.campaignId,
      channel: 'INTERNAL',
      actionType: 'MKT_LAUNCH',
      entityType: 'CONTENT',
      entityId: detail.campaignId,
      payloadBefore: {},
      payloadAfter: { contentType: detail.contentType, targets: detail.targetRefs },
      channelResponseStatus: 'SUCCESS',
      channelResponseId: `content:${detail.campaignId}`,
    },
  })
  publishMarketingEvent({ type: 'campaign.mutated', campaignId: detail.campaignId, channel: 'INTERNAL', action: 'updated', ts: Date.now() })
}

export async function sendOutreach(detail: OutreachDetail): Promise<void> {
  // Resolve audience size (CustomerSegment) for the record; the actual
  // send (honoring EmailSuppression) is delegated to the RV pipeline in
  // the gated extension.
  let audience = 0
  if (detail.segmentId) {
    const seg = await prisma.customerSegment.findUnique({ where: { id: detail.segmentId }, select: { customerCount: true } })
    audience = seg?.customerCount ?? 0
  }
  logger.info('[UM][INTERNAL] outreach launch (intent recorded)', {
    campaignId: detail.campaignId,
    mode: detail.mode,
    segmentId: detail.segmentId,
    audience,
  })
  await prisma.campaignAction.create({
    data: {
      campaignId: detail.campaignId,
      channel: 'INTERNAL',
      actionType: 'MKT_LAUNCH',
      entityType: 'OUTREACH',
      entityId: detail.campaignId,
      payloadBefore: {},
      payloadAfter: { mode: detail.mode, segmentId: detail.segmentId, audience },
      channelResponseStatus: 'SUCCESS',
      channelResponseId: `outreach:${detail.campaignId}`,
    },
  })
  publishMarketingEvent({ type: 'campaign.mutated', campaignId: detail.campaignId, channel: 'INTERNAL', action: 'updated', ts: Date.now() })
}
