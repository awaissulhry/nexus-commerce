/**
 * AD.2 — Operator-write entry point for the Trading Desk.
 *
 * Every PATCH on a Campaign / AdGroup / AdTarget flows through here:
 *   1. UPSERT the local row (operator sees the change immediately)
 *   2. Enqueue an OutboundSyncQueue row with syncType=AD_* and
 *      holdUntil = NOW + 5min (gives a grace window to cancel)
 *   3. Write a CampaignBidHistory audit row (changedBy = "user:<id>"
 *      or "automation:<ruleId>")
 *   4. Add a BullMQ job to adsSyncQueue keyed by the OutboundSyncQueue
 *      row id — the AD.2 worker (ads-sync.worker.ts) consumes it
 *
 * Sandbox-safe: the worker's call to ads-api-client.update* short-
 * circuits in sandbox mode. So even with NEXUS_AMAZON_ADS_MODE unset,
 * an operator can PATCH a campaign, see the OutboundSyncQueue row,
 * undo within 5 min, and see the audit trail — all without touching
 * Amazon.
 *
 * If BullMQ is unavailable (Redis down / not configured in dev), the
 * mutation still succeeds. The OutboundSyncQueue row sits PENDING and
 * the node-cron fallback (existing) drains it on its next tick.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

// Conservative grace window. Operators have 5 min to cancel before
// the worker actually calls Amazon. Override via env for testing.
const GRACE_PERIOD_MS = Number(process.env.NEXUS_ADS_GRACE_MS ?? 5 * 60 * 1000)

export type AdsActor = `user:${string}` | `automation:${string}`

export type AdEntityType = 'CAMPAIGN' | 'AD_GROUP' | 'AD_TARGET'

export type AdSyncType =
  | 'AD_BID_UPDATE'
  | 'AD_BUDGET_UPDATE'
  | 'AD_ENTITY_STATE_UPDATE'
  | 'AD_BIDDING_STRATEGY_UPDATE'

export interface FieldChange {
  field: string
  oldValue: string | null
  newValue: string | null
}

export interface MutationOutcome {
  ok: boolean
  outboundQueueId: string | null
  bidHistoryIds: string[]
  /** AD.4 — id of the AdvertisingActionLog row this mutation wrote. */
  actionLogId: string | null
  error: string | null
}

/**
 * AD.4 — Write a single AdvertisingActionLog row capturing the
 * before/after JSON snapshots. The rollback endpoint walks these to
 * invert each operation. The actor string is stored in `userId` to
 * unify human + automation writes under one column (the audit table
 * needs to round-trip the actor verbatim).
 */
async function writeAdvertisingActionLog(args: {
  actor: AdsActor
  actionType: string
  entityType: 'CAMPAIGN' | 'AD_GROUP' | 'AD_TARGET' | 'RETAIL_EVENT'
  entityId: string
  payloadBefore: object
  payloadAfter: object
  outboundQueueId: string | null
}): Promise<string> {
  const row = await prisma.advertisingActionLog.create({
    data: {
      executionId: null,
      userId: args.actor,
      actionType: args.actionType,
      entityType: args.entityType,
      entityId: args.entityId,
      payloadBefore: args.payloadBefore,
      payloadAfter: args.payloadAfter,
      outboundQueueId: args.outboundQueueId,
      amazonResponseStatus: 'PENDING',
    },
    select: { id: true },
  })
  return row.id
}

interface EnqueueArgs {
  entityType: AdEntityType
  entityId: string
  externalId: string | null
  syncType: AdSyncType
  marketplace: string | null
  fieldChanges: FieldChange[]
  actor: AdsActor
  reason: string | null
  applyImmediately: boolean // when true, holdUntil = NOW (no grace)
}

async function enqueueOutbound(args: EnqueueArgs): Promise<string> {
  const holdUntil = args.applyImmediately
    ? new Date()
    : new Date(Date.now() + GRACE_PERIOD_MS)
  const row = await prisma.outboundSyncQueue.create({
    data: {
      // Campaign-level entities don't tie to a product/channel listing.
      // Leave both FKs null; the worker reads entityType from payload.
      productId: null,
      channelListingId: null,
      targetChannel: 'AMAZON',
      targetRegion: args.marketplace,
      syncStatus: 'PENDING',
      syncType: args.syncType,
      payload: {
        entityType: args.entityType,
        entityId: args.entityId,
        externalId: args.externalId,
        marketplace: args.marketplace,
        fieldChanges: args.fieldChanges,
        actor: args.actor,
        reason: args.reason,
      } as object,
      holdUntil,
      externalListingId: args.externalId,
    },
    select: { id: true },
  })
  return row.id
}

async function writeBidHistory(args: {
  entityType: AdEntityType
  entityId: string
  campaignId: string | null
  fieldChanges: FieldChange[]
  actor: AdsActor
  reason: string | null
}): Promise<string[]> {
  const ids: string[] = []
  for (const change of args.fieldChanges) {
    const row = await prisma.campaignBidHistory.create({
      data: {
        entityType: args.entityType,
        entityId: args.entityId,
        campaignId: args.campaignId,
        field: change.field,
        oldValue: change.oldValue,
        newValue: change.newValue,
        changedBy: args.actor,
        reason: args.reason,
      },
      select: { id: true },
    })
    ids.push(row.id)
  }
  return ids
}

async function enqueueBullMQJob(queueRowId: string, syncType: AdSyncType): Promise<void> {
  // Best-effort BullMQ enqueue. If Redis is down or the queue isn't
  // initialized, the row still sits in OutboundSyncQueue and gets
  // drained by the cron fallback. Don't fail the operator's write.
  try {
    const { adsSyncQueue } = await import('../../lib/queue.js')
    await adsSyncQueue.add(
      syncType,
      { queueId: queueRowId, syncType },
      {
        delay: GRACE_PERIOD_MS,
        jobId: `ads-sync:${queueRowId}`,
      },
    )
  } catch (err) {
    logger.warn('[ads-mutation] BullMQ enqueue failed (will fall back to cron drain)', {
      queueRowId,
      syncType,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// ── Update helpers ────────────────────────────────────────────────────

export interface CampaignPatch {
  dailyBudget?: number
  dailyBudgetCurrency?: string
  status?: 'ENABLED' | 'PAUSED' | 'ARCHIVED'
  biddingStrategy?: 'LEGACY_FOR_SALES' | 'AUTO_FOR_SALES' | 'MANUAL'
  endDate?: Date | null
}

export async function updateCampaignWithSync(args: {
  campaignId: string
  patch: CampaignPatch
  actor: AdsActor
  reason?: string | null
  applyImmediately?: boolean
}): Promise<MutationOutcome> {
  const existing = await prisma.campaign.findUnique({
    where: { id: args.campaignId },
    select: {
      id: true,
      externalCampaignId: true,
      marketplace: true,
      dailyBudget: true,
      dailyBudgetCurrency: true,
      status: true,
      biddingStrategy: true,
      endDate: true,
    },
  })
  if (!existing) {
    return { ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'not_found' }
  }

  // Diff: only audit fields the patch actually changes.
  const changes: FieldChange[] = []
  let syncType: AdSyncType = 'AD_BUDGET_UPDATE'
  if (args.patch.dailyBudget != null && Number(existing.dailyBudget) !== args.patch.dailyBudget) {
    changes.push({
      field: 'dailyBudget',
      oldValue: String(existing.dailyBudget),
      newValue: String(args.patch.dailyBudget),
    })
    syncType = 'AD_BUDGET_UPDATE'
  }
  if (args.patch.dailyBudgetCurrency && args.patch.dailyBudgetCurrency !== existing.dailyBudgetCurrency) {
    changes.push({
      field: 'dailyBudgetCurrency',
      oldValue: existing.dailyBudgetCurrency,
      newValue: args.patch.dailyBudgetCurrency,
    })
  }
  if (args.patch.status && args.patch.status !== existing.status) {
    changes.push({
      field: 'status',
      oldValue: existing.status,
      newValue: args.patch.status,
    })
    syncType = 'AD_ENTITY_STATE_UPDATE'
  }
  if (args.patch.biddingStrategy && args.patch.biddingStrategy !== existing.biddingStrategy) {
    changes.push({
      field: 'biddingStrategy',
      oldValue: existing.biddingStrategy,
      newValue: args.patch.biddingStrategy,
    })
    syncType = 'AD_BIDDING_STRATEGY_UPDATE'
  }
  if (args.patch.endDate !== undefined && args.patch.endDate?.toISOString() !== existing.endDate?.toISOString()) {
    changes.push({
      field: 'endDate',
      oldValue: existing.endDate?.toISOString() ?? null,
      newValue: args.patch.endDate?.toISOString() ?? null,
    })
  }
  if (changes.length === 0) {
    return { ok: true, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'no_changes' }
  }

  // Capture payloadBefore snapshot BEFORE we write to local row.
  const payloadBefore = {
    dailyBudget: Number(existing.dailyBudget),
    dailyBudgetCurrency: existing.dailyBudgetCurrency,
    status: existing.status,
    biddingStrategy: existing.biddingStrategy,
    endDate: existing.endDate?.toISOString() ?? null,
  }

  // Local write
  const data: Record<string, unknown> = {}
  if (args.patch.dailyBudget != null) data.dailyBudget = args.patch.dailyBudget
  if (args.patch.dailyBudgetCurrency) data.dailyBudgetCurrency = args.patch.dailyBudgetCurrency
  if (args.patch.status) data.status = args.patch.status
  if (args.patch.biddingStrategy) data.biddingStrategy = args.patch.biddingStrategy
  if (args.patch.endDate !== undefined) data.endDate = args.patch.endDate
  await prisma.campaign.update({ where: { id: args.campaignId }, data })

  const outboundQueueId = await enqueueOutbound({
    entityType: 'CAMPAIGN',
    entityId: args.campaignId,
    externalId: existing.externalCampaignId,
    syncType,
    marketplace: existing.marketplace,
    fieldChanges: changes,
    actor: args.actor,
    reason: args.reason ?? null,
    applyImmediately: args.applyImmediately ?? false,
  })

  const bidHistoryIds = await writeBidHistory({
    entityType: 'CAMPAIGN',
    entityId: args.campaignId,
    campaignId: args.campaignId,
    fieldChanges: changes,
    actor: args.actor,
    reason: args.reason ?? null,
  })

  const payloadAfter = {
    ...payloadBefore,
    ...(args.patch.dailyBudget != null ? { dailyBudget: args.patch.dailyBudget } : {}),
    ...(args.patch.dailyBudgetCurrency ? { dailyBudgetCurrency: args.patch.dailyBudgetCurrency } : {}),
    ...(args.patch.status ? { status: args.patch.status } : {}),
    ...(args.patch.biddingStrategy ? { biddingStrategy: args.patch.biddingStrategy } : {}),
    ...(args.patch.endDate !== undefined ? { endDate: args.patch.endDate?.toISOString() ?? null } : {}),
  }
  const actionLogId = await writeAdvertisingActionLog({
    actor: args.actor,
    actionType: syncType,
    entityType: 'CAMPAIGN',
    entityId: args.campaignId,
    payloadBefore,
    payloadAfter,
    outboundQueueId,
  })

  await enqueueBullMQJob(outboundQueueId, syncType)

  return { ok: true, outboundQueueId, bidHistoryIds, actionLogId, error: null }
}

export interface AdGroupPatch {
  defaultBidCents?: number
  status?: 'ENABLED' | 'PAUSED' | 'ARCHIVED'
}

export async function updateAdGroupWithSync(args: {
  adGroupId: string
  patch: AdGroupPatch
  actor: AdsActor
  reason?: string | null
  applyImmediately?: boolean
}): Promise<MutationOutcome> {
  const existing = await prisma.adGroup.findUnique({
    where: { id: args.adGroupId },
    select: {
      id: true,
      externalAdGroupId: true,
      defaultBidCents: true,
      status: true,
      campaign: { select: { id: true, marketplace: true } },
    },
  })
  if (!existing) {
    return { ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'not_found' }
  }
  const changes: FieldChange[] = []
  let syncType: AdSyncType = 'AD_BID_UPDATE'
  if (args.patch.defaultBidCents != null && args.patch.defaultBidCents !== existing.defaultBidCents) {
    changes.push({
      field: 'defaultBid',
      oldValue: String(existing.defaultBidCents),
      newValue: String(args.patch.defaultBidCents),
    })
    syncType = 'AD_BID_UPDATE'
  }
  if (args.patch.status && args.patch.status !== existing.status) {
    changes.push({
      field: 'status',
      oldValue: existing.status,
      newValue: args.patch.status,
    })
    syncType = 'AD_ENTITY_STATE_UPDATE'
  }
  if (changes.length === 0) {
    return { ok: true, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'no_changes' }
  }

  // Floor clamp on bid — AD.3's automation handler reuses this; same
  // safety belongs in the user path so a slip-up can't zero impressions.
  if (args.patch.defaultBidCents != null && args.patch.defaultBidCents < 5) {
    return {
      ok: false,
      outboundQueueId: null,
      bidHistoryIds: [],
      actionLogId: null,
      error: 'bid_below_floor_5_cents',
    }
  }

  const payloadBefore = {
    defaultBidCents: existing.defaultBidCents,
    status: existing.status,
  }

  const data: Record<string, unknown> = {}
  if (args.patch.defaultBidCents != null) data.defaultBidCents = args.patch.defaultBidCents
  if (args.patch.status) data.status = args.patch.status
  await prisma.adGroup.update({ where: { id: args.adGroupId }, data })

  const outboundQueueId = await enqueueOutbound({
    entityType: 'AD_GROUP',
    entityId: args.adGroupId,
    externalId: existing.externalAdGroupId,
    syncType,
    marketplace: existing.campaign?.marketplace ?? null,
    fieldChanges: changes,
    actor: args.actor,
    reason: args.reason ?? null,
    applyImmediately: args.applyImmediately ?? false,
  })

  const bidHistoryIds = await writeBidHistory({
    entityType: 'AD_GROUP',
    entityId: args.adGroupId,
    campaignId: existing.campaign?.id ?? null,
    fieldChanges: changes,
    actor: args.actor,
    reason: args.reason ?? null,
  })

  const payloadAfter = {
    ...payloadBefore,
    ...(args.patch.defaultBidCents != null ? { defaultBidCents: args.patch.defaultBidCents } : {}),
    ...(args.patch.status ? { status: args.patch.status } : {}),
  }
  const actionLogId = await writeAdvertisingActionLog({
    actor: args.actor,
    actionType: syncType,
    entityType: 'AD_GROUP',
    entityId: args.adGroupId,
    payloadBefore,
    payloadAfter,
    outboundQueueId,
  })

  await enqueueBullMQJob(outboundQueueId, syncType)
  return { ok: true, outboundQueueId, bidHistoryIds, actionLogId, error: null }
}

export interface AdTargetPatch {
  bidCents?: number
  status?: 'ENABLED' | 'PAUSED' | 'ARCHIVED'
}

export async function updateAdTargetWithSync(args: {
  adTargetId: string
  patch: AdTargetPatch
  actor: AdsActor
  reason?: string | null
  applyImmediately?: boolean
}): Promise<MutationOutcome> {
  const existing = await prisma.adTarget.findUnique({
    where: { id: args.adTargetId },
    select: {
      id: true,
      externalTargetId: true,
      bidCents: true,
      status: true,
      adGroup: {
        select: { id: true, campaign: { select: { id: true, marketplace: true } } },
      },
    },
  })
  if (!existing) {
    return { ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'not_found' }
  }
  const changes: FieldChange[] = []
  let syncType: AdSyncType = 'AD_BID_UPDATE'
  if (args.patch.bidCents != null && args.patch.bidCents !== existing.bidCents) {
    changes.push({
      field: 'bid',
      oldValue: String(existing.bidCents),
      newValue: String(args.patch.bidCents),
    })
    syncType = 'AD_BID_UPDATE'
  }
  if (args.patch.status && args.patch.status !== existing.status) {
    changes.push({
      field: 'status',
      oldValue: existing.status,
      newValue: args.patch.status,
    })
    syncType = 'AD_ENTITY_STATE_UPDATE'
  }
  if (changes.length === 0) {
    return { ok: true, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'no_changes' }
  }
  if (args.patch.bidCents != null && args.patch.bidCents < 5) {
    return {
      ok: false,
      outboundQueueId: null,
      bidHistoryIds: [],
      actionLogId: null,
      error: 'bid_below_floor_5_cents',
    }
  }

  const payloadBefore = {
    bidCents: existing.bidCents,
    status: existing.status,
  }

  const data: Record<string, unknown> = {}
  if (args.patch.bidCents != null) data.bidCents = args.patch.bidCents
  if (args.patch.status) data.status = args.patch.status
  await prisma.adTarget.update({ where: { id: args.adTargetId }, data })

  const outboundQueueId = await enqueueOutbound({
    entityType: 'AD_TARGET',
    entityId: args.adTargetId,
    externalId: existing.externalTargetId,
    syncType,
    marketplace: existing.adGroup?.campaign?.marketplace ?? null,
    fieldChanges: changes,
    actor: args.actor,
    reason: args.reason ?? null,
    applyImmediately: args.applyImmediately ?? false,
  })

  const bidHistoryIds = await writeBidHistory({
    entityType: 'AD_TARGET',
    entityId: args.adTargetId,
    campaignId: existing.adGroup?.campaign?.id ?? null,
    fieldChanges: changes,
    actor: args.actor,
    reason: args.reason ?? null,
  })

  const payloadAfter = {
    ...payloadBefore,
    ...(args.patch.bidCents != null ? { bidCents: args.patch.bidCents } : {}),
    ...(args.patch.status ? { status: args.patch.status } : {}),
  }
  const actionLogId = await writeAdvertisingActionLog({
    actor: args.actor,
    actionType: syncType,
    entityType: 'AD_TARGET',
    entityId: args.adTargetId,
    payloadBefore,
    payloadAfter,
    outboundQueueId,
  })

  await enqueueBullMQJob(outboundQueueId, syncType)
  return { ok: true, outboundQueueId, bidHistoryIds, actionLogId, error: null }
}

// ── Bulk target bid update ─────────────────────────────────────────────

export interface BulkBidEntry {
  adTargetId: string
  bidCents: number
}

export interface BulkBidOutcome {
  applied: number
  skipped: number
  failed: number
  outcomes: MutationOutcome[]
  chunks: number
}

// Amazon Ads bulk endpoints limit ~1k entities per call. We chunk
// here so a single operator action (e.g. "bid +20% on 4k keywords")
// translates into 4 sequential OutboundSyncQueue rows + 4 BullMQ
// jobs rather than a single oversized payload.
const AMAZON_BULK_CHUNK = 1000

export async function bulkUpdateAdTargetBids(args: {
  entries: BulkBidEntry[]
  actor: AdsActor
  reason?: string | null
  applyImmediately?: boolean
}): Promise<BulkBidOutcome> {
  const out: BulkBidOutcome = {
    applied: 0,
    skipped: 0,
    failed: 0,
    outcomes: [],
    chunks: 0,
  }
  for (let i = 0; i < args.entries.length; i += AMAZON_BULK_CHUNK) {
    const chunk = args.entries.slice(i, i + AMAZON_BULK_CHUNK)
    out.chunks += 1
    for (const entry of chunk) {
      const outcome = await updateAdTargetWithSync({
        adTargetId: entry.adTargetId,
        patch: { bidCents: entry.bidCents },
        actor: args.actor,
        reason: args.reason ?? null,
        applyImmediately: args.applyImmediately ?? false,
      })
      out.outcomes.push(outcome)
      if (outcome.ok && outcome.outboundQueueId) out.applied += 1
      else if (outcome.ok) out.skipped += 1
      else out.failed += 1
    }
  }
  return out
}

// AD.4 hook — operator cancel within grace window. Flips
// syncStatus=CANCELLED so the BullMQ worker sees it and skips.
export async function cancelPendingMutation(outboundQueueId: string): Promise<{ ok: boolean; error: string | null }> {
  const row = await prisma.outboundSyncQueue.findUnique({
    where: { id: outboundQueueId },
    select: { id: true, syncStatus: true, holdUntil: true },
  })
  if (!row) return { ok: false, error: 'not_found' }
  if (row.syncStatus !== 'PENDING') return { ok: false, error: `not_pending:${row.syncStatus}` }
  if (row.holdUntil && row.holdUntil <= new Date()) {
    return { ok: false, error: 'grace_expired' }
  }
  await prisma.outboundSyncQueue.update({
    where: { id: outboundQueueId },
    data: { syncStatus: 'CANCELLED' },
  })
  return { ok: true, error: null }
}
