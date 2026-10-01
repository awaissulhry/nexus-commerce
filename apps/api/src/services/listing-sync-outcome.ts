/**
 * A listing's own sync status follows its outbound queue (2026-10-01).
 *
 * The writers that queue a row for a listing mark it waiting (`syncStatus: 'PENDING'`, `lastSyncStatus: 'PENDING'`: the
 * price door, the cascades), and nothing marked it again once the row was sent: after a live price test reached Amazon
 * (the queue row SUCCESS, Amazon showing the new price), the listing still read "Pending", and its `lastSyncedAt` stayed
 * empty. The old channel-sync worker wrote IN_SYNC/SUCCESS, but it only builds payloads; the queue's dispatchers send.
 *
 * So each dispatcher records the end of a row here, once the row itself is written:
 *   - `sent` (a real send, not SKIPPED): `lastSyncedAt` now; and when no other row of the listing still waits
 *     (PENDING or IN_PROGRESS), `IN_SYNC` / `SUCCESS` and the last error cleared — one waiting row keeps it PENDING;
 *   - `failed` (no retry left: dead-lettered): `FAILED` with the error — whatever else waits, the listing has a failure;
 *   - a skip, a retry or a deferral ahead records nothing: the row's own status says why.
 * Never the listing's `version`: these are status fields, and an open editor's compare-and-set must not see a conflict
 * each time a row is sent. Best effort: a failure here is logged and never fails the dispatch, which already happened.
 */
import type { Prisma } from '@prisma/client'
import { logger } from '../utils/logger.js'
import { addJobSafely, readCacheQueue } from '../lib/queue.js'

/** The caller's client (the dispatcher's own): this module imports no database, so it adds no import to a worker. */
type Db = { channelListing: { updateMany: (args: { where: Prisma.ChannelListingWhereInput; data: Prisma.ChannelListingUpdateManyMutationInput }) => Promise<{ count: number }> } }

export interface ListingSyncOutcome {
  channelListingId: string | null | undefined
  productId?: string | null
  outcome: 'sent' | 'failed'
  error?: string | null
}

/** Rows that still have to reach the channel: the listing is not in sync while one of them exists. */
const STILL_WAITING: Prisma.OutboundSyncQueueWhereInput = { syncStatus: { in: ['PENDING', 'IN_PROGRESS'] } }

export async function recordListingSyncOutcome(db: Db, input: ListingSyncOutcome): Promise<void> {
  const id = input.channelListingId
  if (!id) return
  try {
    const now = new Date()
    let changed = 0
    if (input.outcome === 'sent') {
      const inSync = await db.channelListing.updateMany({
        where: { id, outboundSyncQueue: { none: STILL_WAITING } },
        data: { syncStatus: 'IN_SYNC', lastSyncStatus: 'SUCCESS', lastSyncedAt: now, lastSyncError: null },
      })
      changed = inSync.count
      if (!changed) {
        // Another row of this listing still waits: the send is recorded, the listing stays PENDING.
        changed = (await db.channelListing.updateMany({ where: { id }, data: { lastSyncedAt: now } })).count
      }
    } else {
      changed = (await db.channelListing.updateMany({
        where: { id },
        data: { syncStatus: 'FAILED', lastSyncStatus: 'FAILED', lastSyncError: (input.error ?? 'The channel refused the change.').slice(0, 2000) },
      })).count
    }
    // The product read cache carries each listing's lastSyncStatus (the grids' sync chip): the same debounced refresh job
    // a product event enqueues (`product-event.service.ts`); a skipped add is healed by the 15-minute reconcile.
    if (changed && input.productId) {
      void addJobSafely(readCacheQueue, 'refresh', { productId: input.productId }, { jobId: `cache:refresh:${input.productId}`, delay: 2000 }).catch(() => {})
    }
  } catch (error) {
    logger.warn('listing sync outcome not recorded', { channelListingId: id, outcome: input.outcome, error: error instanceof Error ? error.message : String(error) })
  }
}
