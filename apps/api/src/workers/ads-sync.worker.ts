/**
 * AD.2 — BullMQ consumer for the ads-sync queue.
 *
 * Reads an OutboundSyncQueue row by id (from job.data.queueId), parses
 * its payload, and dispatches to ads-api-client's update* methods. In
 * sandbox mode these short-circuit; in live mode (AD.4) they call
 * Amazon Ads API after passing through ads-write-gate.
 *
 * Grace-period semantics: the mutation service enqueues jobs with a
 * 5-min delay. The worker re-checks syncStatus on entry; if the row
 * was CANCELLED during the grace window, we skip without calling the
 * API.
 *
 * Idempotency: jobId is "ads-sync:<queueRowId>" so a duplicate enqueue
 * for the same row collapses to one job (BullMQ deduplicates on jobId).
 */

import { Worker, type Job } from 'bullmq'
import prisma from '../db.js'
import { redis } from '../lib/queue.js'
import { logger } from '../utils/logger.js'
import {
  updateCampaign,
  updateAdGroup,
  updateTarget,
  adsMode,
  type ClientContext,
  type AdsRegion,
} from '../services/advertising/ads-api-client.js'
import {
  checkAdsWriteGate,
  logGateDeny,
  recordSuccessfulWrite,
} from '../services/advertising/ads-write-gate.js'

interface AdsJobData {
  queueId: string
  syncType: string
}

interface AdMutationPayload {
  entityType: 'CAMPAIGN' | 'AD_GROUP' | 'AD_TARGET'
  entityId: string
  externalId: string | null
  marketplace: string | null
  fieldChanges: Array<{ field: string; oldValue: string | null; newValue: string | null }>
  actor: string
  reason: string | null
}

/**
 * Estimate the spend impact of a payload for the write-gate value cap.
 * Conservative — picks the largest numeric newValue across fieldChanges.
 * Bid changes are cents per click (small); budget changes are EUR units
 * (need ×100). The worker uses this to gate value-cap denials.
 */
function estimatePayloadValueCents(payload: AdMutationPayload): number {
  let maxCents = 0
  for (const c of payload.fieldChanges) {
    if (c.newValue == null) continue
    const n = Number(c.newValue)
    if (!Number.isFinite(n)) continue
    if (c.field === 'dailyBudget') {
      // Stored as EUR (Campaign.dailyBudget is Decimal(10,2) EUR units)
      maxCents = Math.max(maxCents, Math.round(n * 100))
    } else {
      // Bids stored as cents already.
      maxCents = Math.max(maxCents, Math.round(n))
    }
  }
  return maxCents
}

function regionFor(marketplace: string | null): AdsRegion {
  // EU is overwhelmingly the right answer for Xavia. NA/FE only when
  // an AmazonAdsConnection explicitly carries that region.
  if (!marketplace) return 'EU'
  if (['US', 'CA', 'MX', 'BR'].includes(marketplace)) return 'NA'
  if (['JP', 'AU', 'SG', 'IN'].includes(marketplace)) return 'FE'
  return 'EU'
}

async function resolveProfileId(marketplace: string | null): Promise<string | null> {
  // In sandbox we use synthetic profile ids; in live we look up the
  // active AmazonAdsConnection for the marketplace.
  if (adsMode() === 'sandbox') {
    if (marketplace === 'DE') return 'SANDBOX-PROFILE-DE-002'
    return 'SANDBOX-PROFILE-IT-001'
  }
  if (!marketplace) return null
  const conn = await prisma.amazonAdsConnection.findFirst({
    where: { marketplace, isActive: true, mode: 'production' },
    select: { profileId: true },
  })
  return conn?.profileId ?? null
}

function patchFromChanges(payload: AdMutationPayload): {
  state?: 'enabled' | 'paused' | 'archived'
  dailyBudget?: number
  defaultBid?: number
  bid?: number
} {
  const out: Record<string, unknown> = {}
  for (const c of payload.fieldChanges) {
    if (!c.newValue) continue
    if (c.field === 'status') {
      out.state = c.newValue.toLowerCase()
    } else if (c.field === 'dailyBudget') {
      out.dailyBudget = Number(c.newValue)
    } else if (c.field === 'defaultBid') {
      // Stored as cents in OutboundSyncQueue; Amazon expects EUR units.
      out.defaultBid = Number(c.newValue) / 100
    } else if (c.field === 'bid') {
      out.bid = Number(c.newValue) / 100
    }
  }
  return out
}

async function dispatchToAmazon(
  payload: AdMutationPayload,
  ctx: ClientContext,
): Promise<{ ok: boolean; rawResponse: unknown; error: string | null }> {
  const patch = patchFromChanges(payload)
  if (!payload.externalId) {
    // Local-only entity (locally drafted, not yet pushed to Amazon).
    // For AD.2 we treat this as a no-op success — AD.4 wires the
    // create-campaign-from-draft flow.
    return { ok: true, rawResponse: { skipped: 'no_external_id' }, error: null }
  }
  try {
    if (payload.entityType === 'CAMPAIGN') {
      const res = await updateCampaign(ctx, payload.externalId, patch)
      return { ok: res.ok, rawResponse: res.rawResponse, error: null }
    }
    if (payload.entityType === 'AD_GROUP') {
      const res = await updateAdGroup(ctx, payload.externalId, patch)
      return { ok: res.ok, rawResponse: res.rawResponse, error: null }
    }
    if (payload.entityType === 'AD_TARGET') {
      const res = await updateTarget(ctx, payload.externalId, patch)
      return { ok: res.ok, rawResponse: res.rawResponse, error: null }
    }
    return { ok: false, rawResponse: null, error: `unknown_entity_type:${payload.entityType}` }
  } catch (err) {
    return {
      ok: false,
      rawResponse: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function processAdsSyncJob(job: Job<AdsJobData>): Promise<{ status: string; queueId: string }> {
  const { queueId } = job.data
  logger.debug('[ads-sync.worker] processing', { jobId: job.id, queueId })

  const row = await prisma.outboundSyncQueue.findUnique({
    where: { id: queueId },
  })
  if (!row) {
    logger.warn('[ads-sync.worker] queue row not found', { queueId })
    return { status: 'NOT_FOUND', queueId }
  }
  // Grace-period skip.
  if ((row.syncStatus as string) === 'CANCELLED') {
    logger.info('[ads-sync.worker] skipping cancelled', { queueId })
    return { status: 'CANCELLED', queueId }
  }
  if (row.syncStatus !== 'PENDING') {
    return { status: 'SKIPPED', queueId }
  }

  await prisma.outboundSyncQueue.update({
    where: { id: queueId },
    data: { syncStatus: 'IN_PROGRESS' },
  })

  const payload = row.payload as unknown as AdMutationPayload
  const marketplace = payload?.marketplace ?? null

  // AD.4 — Two-key live-write gate. In sandbox mode the gate passes
  // through; in live mode it enforces env flag + per-connection
  // writesEnabledAt + value-cap.
  const payloadValueCents = estimatePayloadValueCents(payload)
  const gate = await checkAdsWriteGate({ marketplace, payloadValueCents })
  if (gate.allowed === false) {
    logGateDeny({ queueId, marketplace, payloadValueCents }, gate.reason, gate.deniedAt)
    await prisma.outboundSyncQueue.update({
      where: { id: queueId },
      data: {
        syncStatus: 'SKIPPED',
        errorMessage: `[ADS-WRITE-GATE-DENY] ${gate.deniedAt}: ${gate.reason}`,
        errorCode: 'WRITE_GATE_DENIED',
        syncedAt: new Date(),
      },
    })
    return { status: 'SKIPPED', queueId }
  }

  const profileId =
    gate.mode === 'live'
      ? gate.profileId
      : await resolveProfileId(marketplace)
  if (!profileId) {
    await prisma.outboundSyncQueue.update({
      where: { id: queueId },
      data: {
        syncStatus: 'FAILED',
        errorMessage: 'no_active_ads_connection_for_marketplace',
        errorCode: 'NO_CONNECTION',
        retryCount: { increment: 1 },
      },
    })
    return { status: 'FAILED', queueId }
  }

  const ctx: ClientContext = { profileId, region: regionFor(marketplace) }
  const result = await dispatchToAmazon(payload, ctx)
  if (result.ok) {
    await prisma.outboundSyncQueue.update({
      where: { id: queueId },
      data: {
        syncStatus: 'SUCCESS',
        syncedAt: new Date(),
        errorMessage: null,
      },
    })
    // AD.4 — mark the linked AdvertisingActionLog row as SUCCESS.
    await prisma.advertisingActionLog
      .updateMany({
        where: { outboundQueueId: queueId, amazonResponseStatus: 'PENDING' },
        data: {
          amazonResponseStatus: 'SUCCESS',
          amazonResponseId:
            typeof (result.rawResponse as { documentId?: unknown })?.documentId === 'string'
              ? ((result.rawResponse as { documentId: string }).documentId)
              : null,
        },
      })
      .catch(() => {
        /* audit-update failure must not break the worker */
      })
    if (gate.mode === 'live') {
      await recordSuccessfulWrite(marketplace)
    }
    return { status: 'SUCCESS', queueId }
  }
  // Failure path: bump retryCount; if at max, mark dead.
  const nextRetry = row.retryCount + 1
  await prisma.outboundSyncQueue.update({
    where: { id: queueId },
    data: {
      syncStatus: nextRetry >= row.maxRetries ? 'FAILED' : 'PENDING',
      isDead: nextRetry >= row.maxRetries,
      diedAt: nextRetry >= row.maxRetries ? new Date() : null,
      errorMessage: result.error,
      errorCode: 'AMAZON_API_ERROR',
      retryCount: nextRetry,
      nextRetryAt:
        nextRetry < row.maxRetries
          ? new Date(Date.now() + Math.pow(2, nextRetry) * 60 * 1000)
          : null,
    },
  })
  // AD.4 — mark the linked AdvertisingActionLog as FAILED only on
  // terminal failure (so retryable transients don't pollute the audit).
  if (nextRetry >= row.maxRetries) {
    await prisma.advertisingActionLog
      .updateMany({
        where: { outboundQueueId: queueId, amazonResponseStatus: 'PENDING' },
        data: { amazonResponseStatus: 'FAILED' },
      })
      .catch(() => {
        /* swallow */
      })
  }
  return { status: 'FAILED', queueId }
}

let worker: Worker | null = null

export function initializeAdsSyncWorker(): Worker {
  if (worker) {
    logger.warn('[ads-sync.worker] already initialized')
    return worker
  }
  logger.info('[ads-sync.worker] initializing')
  worker = new Worker('ads-sync', processAdsSyncJob, {
    connection: redis.connection,
    // Lower than outbound-sync's 5 — Amazon Ads API has stricter
    // per-account rate limits than SP-API.
    concurrency: 2,
  })
  worker.on('failed', (job, err) => {
    logger.warn('[ads-sync.worker] job failed', {
      jobId: job?.id,
      queueId: job?.data?.queueId,
      error: err.message,
    })
  })
  worker.on('error', (err) => {
    logger.error('[ads-sync.worker] worker error', {
      error: err instanceof Error ? err.message : String(err),
    })
  })
  return worker
}

export function stopAdsSyncWorker(): void {
  if (worker) {
    void worker.close()
    worker = null
  }
}

// Exposed for tests + the manual /api/advertising/cron/drain-ads-sync
// endpoint (mounts under cron triggers).
export async function drainAdsSyncOnce(limit = 50): Promise<{ processed: number; results: Array<{ status: string; queueId: string }> }> {
  const candidates = await prisma.outboundSyncQueue.findMany({
    where: {
      syncType: { in: ['AD_BID_UPDATE', 'AD_BUDGET_UPDATE', 'AD_ENTITY_STATE_UPDATE', 'AD_BIDDING_STRATEGY_UPDATE'] },
      syncStatus: 'PENDING',
      OR: [{ holdUntil: null }, { holdUntil: { lte: new Date() } }],
    },
    take: limit,
    orderBy: { createdAt: 'asc' },
    select: { id: true, syncType: true },
  })
  const results: Array<{ status: string; queueId: string }> = []
  for (const c of candidates) {
    const fakeJob = { id: `manual-${c.id}`, data: { queueId: c.id, syncType: c.syncType } } as unknown as Job<AdsJobData>
    results.push(await processAdsSyncJob(fakeJob))
  }
  return { processed: results.length, results }
}
