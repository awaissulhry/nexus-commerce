/**
 * UM-series (P5) — unified marketing mutation path.
 *
 * Generalizes ads-mutation.service across channels. Every operator/rule
 * write to a MarketingCampaign flows through here:
 *   1. capture payloadBefore from the current row
 *   2. optimistic local update (cockpit reflects immediately)
 *   3. CampaignAction audit row (channelResponseStatus=PENDING)
 *   4. OutboundSyncQueue row (targetChannel + MKT_* syncType + grace window)
 * A worker/drain later picks up the row, checks the write gate, and (live)
 * dispatches through adapterFor(channel).applyMutation — or (sandbox) just
 * finalizes the audit without an external call.
 *
 * The 5-min grace window (holdUntil) lets an operator cancel before the
 * external write fires; cancel reverts the optimistic local change.
 */

import type { MktChannel } from '@prisma/client'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { publishMarketingEvent } from '../marketing-events.service.js'
import { checkMarketingWriteGate } from './marketing-write-gate.js'
import { adapterFor } from './adapters/types.js'
// Ensure the channel adapters self-register.
import './adapters/amazon.adapter.js'
import './adapters/internal.adapter.js'
import './adapters/ebay.adapter.js'
import './adapters/stub-adapters.js'

const GRACE_PERIOD_MS = Number(process.env.NEXUS_MARKETING_GRACE_MS ?? 5 * 60 * 1000)

export type MktSyncType =
  | 'MKT_BUDGET_UPDATE'
  | 'MKT_STATE_UPDATE' // pause / resume
  | 'MKT_BID_UPDATE'
  | 'MKT_LAUNCH' // INTERNAL content push / outreach kick

export interface EnqueueArgs {
  campaignId: string
  syncType: MktSyncType
  /** New values, e.g. { budgetCents } | { status } | { bidCents }. */
  payload: Record<string, unknown>
  userId?: string | null
  /** Skip the grace window (apply now) — used by automated drains/tests. */
  applyImmediately?: boolean
}

export interface EnqueueResult {
  queueId: string
  actionId: string
  campaign: { id: string; status: string; budgetCents: number | null }
}

/** Resolve the representative link (externalId/marketplace/connection). */
async function primaryLink(campaignId: string) {
  return prisma.marketingCampaignLink.findFirst({
    where: { campaignId },
    orderBy: { marketplace: 'asc' },
  })
}

export async function enqueueCampaignMutation(args: EnqueueArgs): Promise<EnqueueResult> {
  const campaign = await prisma.marketingCampaign.findUnique({ where: { id: args.campaignId } })
  if (!campaign) throw new Error(`campaign ${args.campaignId} not found`)
  const link = await primaryLink(args.campaignId)

  const payloadBefore = {
    status: campaign.status,
    budgetCents: campaign.budgetCents,
  }

  // Optimistic local update so the cockpit reflects the change at once.
  const localData: Record<string, unknown> = {}
  if (args.syncType === 'MKT_STATE_UPDATE' && typeof args.payload.status === 'string') {
    localData.status = args.payload.status
  }
  if (args.syncType === 'MKT_BUDGET_UPDATE' && typeof args.payload.budgetCents === 'number') {
    localData.budgetCents = args.payload.budgetCents
  }
  const updated = Object.keys(localData).length
    ? await prisma.marketingCampaign.update({ where: { id: campaign.id }, data: localData as never })
    : campaign

  const holdUntil = args.applyImmediately ? new Date() : new Date(Date.now() + GRACE_PERIOD_MS)
  const valueCents =
    typeof args.payload.budgetCents === 'number' ? (args.payload.budgetCents as number) : 0

  const queueRow = await prisma.outboundSyncQueue.create({
    data: {
      targetChannel: channelToSyncChannel(campaign.channel),
      targetRegion: link?.marketplace ?? campaign.primaryMarketplace ?? null,
      syncStatus: 'PENDING',
      syncType: args.syncType,
      externalListingId: link?.externalId ?? null,
      holdUntil,
      payload: {
        campaignId: campaign.id,
        channel: campaign.channel,
        marketplace: link?.marketplace ?? campaign.primaryMarketplace ?? null,
        externalId: link?.externalId ?? null,
        valueCents,
        ...args.payload,
      },
    },
  })

  const action = await prisma.campaignAction.create({
    data: {
      campaignId: campaign.id,
      userId: args.userId ?? null,
      channel: campaign.channel,
      actionType: args.syncType,
      entityType: 'CAMPAIGN',
      entityId: link?.externalId ?? campaign.id,
      payloadBefore,
      payloadAfter: { ...payloadBefore, ...localData },
      outboundQueueId: queueRow.id,
      channelResponseStatus: 'PENDING',
    },
  })

  publishMarketingEvent({
    type: 'campaign.mutated',
    campaignId: campaign.id,
    channel: campaign.channel,
    action: args.syncType === 'MKT_STATE_UPDATE' ? 'status' : 'updated',
    ts: Date.now(),
  })

  return {
    queueId: queueRow.id,
    actionId: action.id,
    campaign: { id: updated.id, status: updated.status, budgetCents: updated.budgetCents },
  }
}

/** Cancel a still-held mutation and revert the optimistic local change. */
export async function cancelCampaignMutation(queueId: string): Promise<{ cancelled: boolean }> {
  const row = await prisma.outboundSyncQueue.findUnique({ where: { id: queueId } })
  if (!row || row.syncStatus !== 'PENDING') return { cancelled: false }
  if (row.holdUntil && row.holdUntil <= new Date()) return { cancelled: false } // grace elapsed

  const action = await prisma.campaignAction.findFirst({
    where: { outboundQueueId: queueId, channelResponseStatus: 'PENDING' },
  })
  await prisma.$transaction([
    prisma.outboundSyncQueue.update({ where: { id: queueId }, data: { syncStatus: 'CANCELLED' } }),
    ...(action
      ? [
          prisma.marketingCampaign.update({
            where: { id: action.campaignId! },
            data: action.payloadBefore as never,
          }),
          prisma.campaignAction.update({
            where: { id: action.id },
            data: { channelResponseStatus: 'FAILED', rolledBackAt: new Date(), rollbackReason: 'cancelled in grace window' },
          }),
        ]
      : []),
  ])
  if (action?.campaignId) {
    publishMarketingEvent({ type: 'campaign.mutated', campaignId: action.campaignId, channel: action.channel, action: 'updated', ts: Date.now() })
  }
  return { cancelled: true }
}

/**
 * Roll back an already-executed CampaignAction by replaying payloadBefore
 * onto the campaign (post-grace undo — the cancel path covers in-grace).
 * Generalizes advertising/rollback.service across channels. Best-effort
 * local restore + audit; the external channel un-write (when live) is a
 * fresh forward mutation, so we enqueue the reverse rather than mutate
 * the channel directly here.
 */
export async function rollbackCampaignAction(actionId: string): Promise<{ rolledBack: boolean; reason?: string }> {
  const action = await prisma.campaignAction.findUnique({ where: { id: actionId } })
  if (!action) return { rolledBack: false, reason: 'action not found' }
  if (action.rolledBackAt) return { rolledBack: false, reason: 'already rolled back' }
  if (!action.campaignId) return { rolledBack: false, reason: 'no campaign on action' }
  const before = action.payloadBefore as Record<string, unknown>
  await prisma.$transaction([
    prisma.marketingCampaign.update({ where: { id: action.campaignId }, data: before as never }),
    prisma.campaignAction.update({
      where: { id: actionId },
      data: { rolledBackAt: new Date(), rollbackReason: 'operator rollback' },
    }),
  ])
  publishMarketingEvent({ type: 'campaign.mutated', campaignId: action.campaignId, channel: action.channel, action: 'updated', ts: Date.now() })
  return { rolledBack: true }
}

/** Process one queued mutation row: gate-check then dispatch (or sandbox-finalize). */
export async function processMarketingSyncRow(queueId: string): Promise<{ status: string; queueId: string }> {
  const row = await prisma.outboundSyncQueue.findUnique({ where: { id: queueId } })
  if (!row || row.syncStatus !== 'PENDING') return { status: 'skipped', queueId }
  if (row.holdUntil && row.holdUntil > new Date()) return { status: 'held', queueId }

  await prisma.outboundSyncQueue.update({ where: { id: queueId }, data: { syncStatus: 'IN_PROGRESS' } })
  const payload = row.payload as Record<string, unknown>
  const channel = payload.channel as MktChannel
  const gate = checkMarketingWriteGate({
    channel,
    marketplace: (payload.marketplace as string) ?? null,
    payloadValueCents: (payload.valueCents as number) ?? 0,
  })

  const finalize = async (status: 'SUCCESS' | 'FAILED', responseId: string | null, error?: string) => {
    await prisma.outboundSyncQueue.update({
      where: { id: queueId },
      data: { syncStatus: status === 'SUCCESS' ? 'SUCCESS' : 'FAILED', syncedAt: new Date(), errorMessage: error ?? null },
    })
    await prisma.campaignAction.updateMany({
      where: { outboundQueueId: queueId, channelResponseStatus: 'PENDING' },
      data: { channelResponseStatus: status, channelResponseId: responseId },
    })
  }

  // Sandbox: finalize the audit without an external call.
  if (gate.mode === 'sandbox') {
    logger.info(`[MKT-SANDBOX] ${channel} ${row.syncType} would apply`, { queueId, payload })
    await finalize('SUCCESS', `sandbox:${queueId}`)
    return { status: 'sandbox-success', queueId }
  }

  // Live: dispatch through the channel adapter.
  const adapter = adapterFor(channel)
  if (!adapter) {
    await finalize('FAILED', null, `no adapter for ${channel}`)
    return { status: 'no-adapter', queueId }
  }
  try {
    const res = await adapter.applyMutation(
      { syncType: row.syncType, externalId: payload.externalId as string, entityType: 'CAMPAIGN', payload },
      { connectionId: '', marketplace: (payload.marketplace as string) ?? '', mode: 'live' },
    )
    await finalize(res.ok ? 'SUCCESS' : 'FAILED', res.channelResponseId ?? null, res.error ?? undefined)
    return { status: res.ok ? 'live-success' : 'live-failed', queueId }
  } catch (err) {
    await finalize('FAILED', null, (err as Error)?.message)
    return { status: 'error', queueId }
  }
}

/** Drain ready MKT_* rows once (manual/cron/sandbox verification). */
export async function drainMarketingSyncOnce(limit = 50): Promise<{ processed: number; results: Array<{ status: string; queueId: string }> }> {
  const candidates = await prisma.outboundSyncQueue.findMany({
    where: {
      syncType: { in: ['MKT_BUDGET_UPDATE', 'MKT_STATE_UPDATE', 'MKT_BID_UPDATE', 'MKT_LAUNCH'] },
      syncStatus: 'PENDING',
      OR: [{ holdUntil: null }, { holdUntil: { lte: new Date() } }],
    },
    take: limit,
    select: { id: true },
  })
  const results = []
  for (const c of candidates) results.push(await processMarketingSyncRow(c.id))
  return { processed: results.length, results }
}

// Map the unified MktChannel to the OutboundSyncQueue SyncChannel enum.
// GOOGLE/META/TIKTOK aren't in SyncChannel yet (added with their adapters,
// P12/P13); fall back to AMAZON for routing only those reach in P5 is none.
function channelToSyncChannel(channel: MktChannel): 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'GOOGLE' | 'META' | 'TIKTOK' {
  switch (channel) {
    case 'EBAY':
      return 'EBAY'
    case 'SHOPIFY':
      return 'SHOPIFY'
    case 'GOOGLE':
      return 'GOOGLE'
    case 'META':
      return 'META'
    case 'TIKTOK':
      return 'TIKTOK'
    default:
      // AMAZON + INTERNAL route to AMAZON sync-channel (INTERNAL never hits
      // an external sync; its launch is handled in-adapter).
      return 'AMAZON'
  }
}
