/**
 * RT.2 — instant-lane enqueue helper for OutboundSyncQueue creators.
 *
 * Before RT.2, a dozen row-creation sites (flat-file saves, listing
 * activation, bulk actions, catalog routes…) inserted PENDING rows and relied
 * solely on the 60s autopilot drain — even with the BullMQ lane live, their
 * pushes waited for the next cron tick. This helper pairs every created row
 * with an instant-lane job whose delay honors the row's OWN holdUntil (so
 * each site's grace-window semantics are preserved exactly), falling back to
 * the drain cron when workers are off or Redis is unreachable (addJobSafely
 * is bounded + circuit-broken and never hangs the caller).
 *
 * Two shapes:
 *   - enqueueOutboundRowsInstant(db, rows)  — createMany + fire (non-tx callers)
 *   - fireOutboundJobs(entries)             — fire-only, for callers that
 *     already created rows (and hold their ids), or that must fire post-commit.
 *
 * createMany cannot return ids, so rows are stamped with a per-call
 * payload.enqueueBatch tag and re-read by it. Batch-tag re-read is exact
 * (unique uuid per call), unlike ordering heuristics.
 */

import { randomUUID } from 'crypto'
import type { Prisma } from '@prisma/client'
import { sellingRisk } from '@nexus/shared/listing-risk'
import { whereCoordinate, type ListingCoordinate } from '../lib/listing-coordinate.js'
import { outboundSyncQueue, addJobSafely } from '../lib/queue.js'
import { logger } from '../utils/logger.js'

/** Capture before deletion: Listings Items is keyed by seller SKU, never ASIN. */
export function sellerSkuForDelist(
  listing: { product: { sku: string | null }; offers?: Array<{ sku: string; fulfillmentMethod: string; isActive: boolean }> },
  offerScope: 'FBM' | 'FBA' | 'all' = 'all',
): string | null {
  const skus = [...new Set((listing.offers ?? [])
    .filter(offer => offer.isActive && (offerScope === 'all' || offer.fulfillmentMethod === offerScope))
    .map(offer => offer.sku).filter(sku => typeof sku === 'string' && sku.trim()))]
  if (skus.length > 1) return null // Naming a coordinate cannot choose one of two seller identities.
  return skus[0] ?? (listing.product.sku?.trim() ? listing.product.sku : null)
}

export type DelistSkippedCoordinate = ListingCoordinate & { externalListingId: string | null; reason: string }

/** The cascade captures its targets BEFORE deletion; only its jobs have no FKs. */
export async function enqueueDelistCascade(
  tx: Prisma.TransactionClient,
  productIds: string[],
  channelAction: 'unpublish' | 'delete',
  actor: string,
) {
  const liveListings = await tx.channelListing.findMany({
    where: {
      productId: { in: productIds },
      // D6: do not widen this predicate until the Wave 4 approval.
      listingStatus: { in: ['ACTIVE', 'INACTIVE'] },
      externalListingId: { not: null },
    },
    select: {
      id: true, productId: true, channel: true, region: true, marketplace: true,
      channelConnectionId: true, aliasKey: true, externalListingId: true, externalParentId: true,
      fulfillmentMethod: true, product: { select: { sku: true, parentId: true } },
      offers: { select: { sku: true, fulfillmentMethod: true, isActive: true } },
    },
  })
  const holdUntil = new Date(Date.now() + 5 * 60_000)
  const syncType = channelAction === 'unpublish' ? 'UNPUBLISH_LISTING' : 'DELETE_LISTING'
  const channelSkipped: DelistSkippedCoordinate[] = []
  const data: Prisma.OutboundSyncQueueCreateManyInput[] = []
  const ebayTargets = new Map<string, { coordinates: ListingCoordinate[] }>()
  for (const listing of liveListings) {
    const coordinate: ListingCoordinate = {
      productId: listing.productId, channel: listing.channel, marketplace: listing.marketplace,
      channelConnectionId: listing.channelConnectionId, aliasKey: listing.aliasKey,
    }
    whereCoordinate(coordinate) // Missing is refused; explicit nullable account stays null.
    const skip = (reason: string) => channelSkipped.push({ ...coordinate, externalListingId: listing.externalListingId, reason })
    if (!['AMAZON', 'EBAY', 'SHOPIFY'].includes(listing.channel)) {
      skip(listing.channel === 'ETSY' ? 'Etsy presence is read-only through Wave 4. The listing stays live.'
        : 'This channel has no delist adapter. The listing stays live.')
      continue
    }
    if (!sellingRisk(listing)) continue
    // Removing one variation cannot end its entire shared ItemID. These guards
    // must run while the products/listings still exist, never after FK cascade.
    if (listing.channel === 'EBAY' && listing.product.parentId) {
      skip('This is a variation child. Ending the shared eBay ItemID is refused; the listing stays live.')
      continue
    }
    let sharedItemIdRefs: string[] = []
    if (listing.channel === 'EBAY') {
      const refs = await tx.channelListing.findMany({
        where: { channel: 'EBAY', externalListingId: listing.externalListingId, productId: { notIn: productIds } },
        select: { id: true },
      })
      const members = await tx.sharedListingMembership.findMany({
        where: { itemId: listing.externalListingId, status: 'ACTIVE', OR: [{ productId: null }, { productId: { notIn: productIds } }] },
        select: { id: true },
      })
      sharedItemIdRefs = [...refs.map(row => row.id), ...members.map(row => row.id)]
      if (sharedItemIdRefs.length) {
        skip('Other local coordinates still reference this eBay ItemID. Ending the shared listing is refused; it stays live.')
        continue
      }
    }
    const coordinates = [{ ...coordinate }]
    if (listing.channel === 'EBAY') {
      const key = JSON.stringify([listing.externalListingId, listing.channelConnectionId, listing.marketplace === 'UK' ? 'GB' : listing.marketplace])
      const existing = ebayTargets.get(key)
      if (existing) { existing.coordinates.push(coordinate); continue }
      ebayTargets.set(key, { coordinates })
    }
    data.push({
      productId: null, channelListingId: null,
      targetChannel: listing.channel as 'AMAZON' | 'EBAY' | 'SHOPIFY',
      targetRegion: listing.region ?? listing.marketplace,
      externalListingId: listing.externalListingId, syncStatus: 'PENDING', syncType, holdUntil,
      payload: {
        ...coordinate, channelListingId: listing.id, source: 'products-bulk-hard-delete', actor, channelAction,
        region: listing.region, externalListingId: listing.externalListingId, externalParentId: listing.externalParentId,
        sellerSku: sellerSkuForDelist(listing), fulfillmentMethod: listing.fulfillmentMethod,
        isVariationChild: Boolean(listing.product.parentId), sharedItemIdRefs, coordinates,
      },
    })
  }
  const entries = data.length ? await tx.outboundSyncQueue.createManyAndReturn({
    data, select: { id: true, productId: true, syncType: true, holdUntil: true },
  }) : []
  return { entries, channelCascadeEnqueued: entries.length, channelSkipped }
}


/** Cancel only held cascade jobs; the same CAS competes with the worker. */
export async function cancelDelistCascade(
  db: { $transaction<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> },
  queueIds: string[],
  actor: string,
): Promise<string[]> {
  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    const now = new Date()
    const where = {
      id: { in: queueIds }, syncStatus: 'PENDING' as const,
      retryCount: 0, createdAt: { gt: new Date(now.getTime() - 5 * 60_000) },
      syncType: { in: ['UNPUBLISH_LISTING', 'DELETE_LISTING'] },
      holdUntil: { gt: now }, payload: { path: ['source'], equals: 'products-bulk-hard-delete' },
    }
    const candidates = await tx.outboundSyncQueue.findMany({ where })
    const ids: string[] = []
    for (const row of candidates) {
      const changed = await tx.outboundSyncQueue.updateMany({
        where: { ...where, id: row.id },
        data: { syncStatus: 'CANCELLED', nextRetryAt: null },
      })
      if (!changed.count) continue
      ids.push(row.id)
      const payload = row.payload as Record<string, unknown>
      await tx.productEvent.create({ data: {
        aggregateId: String(payload.channelListingId ?? row.id), aggregateType: 'ChannelListing',
        eventType: 'CHANNEL_DELIST_CANCELLED',
        data: { ...payload, queueId: row.id, delistOutcome: 'NOT_SENT', reason: 'Cancelled during grace period' },
        metadata: { source: 'OPERATOR', userId: actor },
      } })
    }
    return ids
  })
}

export interface OutboundJobEntry {
  id: string
  productId?: string | null
  syncType?: string | null
  holdUntil?: Date | null
}

// Structural typing matching the repo's SharedFanoutDeps precedent — accepts
// PrismaClient or a TransactionClient without fighting Prisma's generics.
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
interface OutboundEnqueueDb {
  outboundSyncQueue: { createMany: Function; findMany: Function }
}

/** Read AFTER the purge committed: only surviving queue IDs may be dispatched. */
export async function dispatchCommittedDelistRows(
  db: Pick<OutboundEnqueueDb, 'outboundSyncQueue'>,
  expected: OutboundJobEntry[],
): Promise<{ channelCascadeDispatched: number | null; channelCascadeRetained: number | null; channelCascadePartial: boolean; channelCascadeQueueIds: string[]; channelCascadeDispatchError?: string }> {
  let survivors: Array<OutboundJobEntry & { syncStatus: string }>
  try {
    survivors = expected.length ? await db.outboundSyncQueue.findMany({
      where: { id: { in: expected.map(row => row.id) }, syncType: { in: ['UNPUBLISH_LISTING', 'DELETE_LISTING'] } },
      select: { id: true, productId: true, syncType: true, holdUntil: true, syncStatus: true },
    }) : []
  } catch (error) {
    logger.error('Delist post-commit queue read unavailable', { error: error instanceof Error ? error.message : String(error) })
    return {
      channelCascadeDispatched: null, channelCascadeRetained: null, channelCascadePartial: true,
      channelCascadeQueueIds: expected.map(row => row.id),
      channelCascadeDispatchError: 'DELIST_DISPATCH_EVIDENCE_UNAVAILABLE: Local deletion committed. Delist queue status could not be read; channel removal is not confirmed. You can still cancel using these queue IDs.',
    }
  }
  const pending = survivors.filter(row => row.syncStatus === 'PENDING')
  await fireOutboundJobs(pending, { source: 'products-bulk-hard-delete' })
  return {
    // This is the post-commit pending-row count, never a channel acknowledgement.
    channelCascadeDispatched: pending.length,
    channelCascadeRetained: survivors.length,
    channelCascadePartial: pending.length !== expected.length,
    channelCascadeQueueIds: survivors.map(row => row.id),
  }
}

/** Fire an instant-lane job per entry; delay = max(0, holdUntil − now). */
export async function fireOutboundJobs(
  entries: OutboundJobEntry[],
  opts?: { source?: string },
): Promise<void> {
  const now = Date.now()
  for (const e of entries) {
    try {
      await addJobSafely(
        outboundSyncQueue,
        'sync-job',
        {
          queueId: e.id,
          productId: e.productId ?? undefined,
          syncType: e.syncType ?? 'QUANTITY_UPDATE',
          source: opts?.source ?? 'INSTANT_ENQUEUE',
        },
        {
          delay: Math.max(0, (e.holdUntil?.getTime() ?? now) - now),
          jobId: e.id,
        },
      )
    } catch (err) {
      // The durable row remains. Ordinary pushes have a cron backstop;
      // lifecycle rows are explicitly refused by that dispatcher (D10).
      logger.warn('fireOutboundJobs: enqueue failed; durable row retained', {
        queueId: e.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

/**
 * createMany the rows + fire instant-lane jobs for them. Returns the created
 * entries. `rows` are OutboundSyncQueue create-inputs (payload may be absent).
 */
export async function enqueueOutboundRowsInstant(
  db: OutboundEnqueueDb,
  rows: Array<Record<string, unknown> & { payload?: Record<string, unknown> | null }>,
  opts?: { source?: string; skipDuplicates?: boolean },
): Promise<OutboundJobEntry[]> {
  if (rows.length === 0) return []
  const tag = randomUUID()
  const tagged = rows.map((r) => ({
    ...r,
    payload: { ...((r.payload as Record<string, unknown> | null) ?? {}), enqueueBatch: tag },
  }))
  await db.outboundSyncQueue.createMany({
    data: tagged,
    ...(opts?.skipDuplicates ? { skipDuplicates: true } : {}),
  } as { data: unknown[] })
  const entries = (await db.outboundSyncQueue.findMany({
    where: { payload: { path: ['enqueueBatch'], equals: tag } },
    select: { id: true, productId: true, syncType: true, holdUntil: true },
  })) as OutboundJobEntry[]
  await fireOutboundJobs(entries, { source: opts?.source })
  return entries
}
