/**
 * Amazon sheet gaps — the live-sync hint of the product sheet and the Matrix (`listing.values_changed`, design-sync §1.B).
 *
 * The SHARED write services call `announceListingValues` after a write that changes what a person sees on a listing
 * (Mode, Qty, Buffer, sync state, fulfilment, price, offer, ASIN), so every screen that writes through them is covered
 * without a call of its own. It never announces a write that is not there: inside the content transaction
 * (`inDatabaseTransaction`) it waits for COMMIT — a rollback, or a savepoint that rolled back, drops it — and outside one
 * it runs after the current tick. Calls in one transaction with the same fields and reason share ONE read.
 *
 * One read (version + family root), then one event per family root. A refresh hint on the ephemeral lane: never awaited,
 * never thrown — a dropped one costs an open screen its next re-read, not a wrong value.
 */
import type { EventPayload } from '@nexus/events'
import prisma from '../db.js'
import { afterDatabaseCommitBatch } from '../lib/database-context.js'
import { logger } from '../utils/logger.js'
import { publishListingEvent } from './listing-events.service.js'

export type ListingValueField = EventPayload<'listing.values_changed'>['fields'][number]

/** The catalogue's cap on listings per event; a larger family is announced in slices. */
const LISTINGS_PER_EVENT = 500

const warn = (error: unknown, detail: Record<string, unknown> = {}) =>
  logger.warn('listing values: change not announced', { ...detail, error: error instanceof Error ? error.message : String(error) })

export function announceListingValues(listingIds: string[], fields: ListingValueField[], reason?: string): void {
  try {
    const ids = [...new Set(listingIds.filter((id) => typeof id === 'string' && id.length > 0))]
    const named = [...new Set(fields)]
    if (ids.length === 0 || named.length === 0) return
    const key = `listing.values_changed:${[...named].sort().join(',')}:${reason ?? ''}`
    void afterDatabaseCommitBatch(key, ids, async (committed) => {
      setImmediate(() => { void publishValues(committed, named, reason) })
    }).catch((error) => warn(error))
  } catch (error) {
    warn(error)
  }
}

async function publishValues(ids: string[], fields: ListingValueField[], reason?: string): Promise<void> {
  try {
    const rows = await prisma.channelListing.findMany({
      where: { id: { in: ids } },
      select: { id: true, productId: true, version: true, product: { select: { parentId: true } } },
    })
    const families = new Map<string, Array<{ listingId: string; productId: string; version: number }>>()
    for (const row of rows ?? []) {
      const root = row.product?.parentId ?? row.productId
      families.set(root, [...(families.get(root) ?? []), { listingId: row.id, productId: row.productId, version: row.version }])
    }
    for (const [productId, listings] of families) {
      for (let i = 0; i < listings.length; i += LISTINGS_PER_EVENT) {
        try {
          publishListingEvent({
            type: 'listing.values_changed', productId, listings: listings.slice(i, i + LISTINGS_PER_EVENT), fields,
            ...(reason ? { reason } : {}), ts: Date.now(),
          })
        } catch (error) {
          warn(error, { productId })
        }
      }
    }
  } catch (error) {
    warn(error, { listings: ids.length })
  }
}
