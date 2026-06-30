/**
 * P5.2 — eBay inventory read-back → ChannelStockEvent
 *
 * Polls eBay's Inventory API for each active eBay listing and feeds
 * the observed quantity into the existing recordChannelStockEvent
 * pipeline (CS.1).  That pipeline handles drift classification,
 * ≤1u auto-apply, and REVIEW_NEEDED routing — this service adds
 * NO new healing logic of its own.
 *
 * Design constraints:
 *   - Read-only: we never write to eBay here.
 *   - Bounded: at most NEXUS_EBAY_READBACK_MAX listings per run (default 200).
 *   - Per-SKU try/catch: one 404/timeout does not abort the sweep.
 *   - Idempotent: channelEventId is hour-bucketed; re-runs in the same
 *     clock-hour dedup via the (channel, channelEventId) unique index.
 */

import prisma from '../db.js'
import { EbayService } from './marketplaces/ebay.service.js'
import { recordChannelStockEvent } from './channel-stock-event.service.js'
import { logger } from '../utils/logger.js'

const DEFAULT_MAX_SKUS = 200

// ---------------------------------------------------------------------------
// Pure helpers — exported so they can be unit-tested without DB/network
// ---------------------------------------------------------------------------

/**
 * Build the idempotency key for a readback observation.
 * Format: `ebay-readback:<sku>:<YYYY-MM-DDTHH>` (ISO-8601 hour bucket).
 * Two calls in the same clock-hour produce the same key → the second
 * insert is a no-op via the unique index.
 */
export function ebayReadbackEventId(sku: string, d: Date): string {
  return `ebay-readback:${sku}:${d.toISOString().slice(0, 13)}`
}

/**
 * Extract the current published quantity from a raw eBay inventory item
 * response object.  Returns the quantity as a non-negative integer, or
 * null if the field is absent, non-numeric, or negative.
 */
export function extractEbayPublishedQty(item: unknown): number | null {
  const raw =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (item as any)?.availability?.shipToLocationAvailability?.quantity
  if (raw === undefined || raw === null) return null
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null
  return n
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface ReadBackResult {
  checked: number
  recorded: number
  errors: number
  capped: boolean
}

/**
 * Sweep all active eBay listings, GET each SKU from eBay, and feed the
 * observed quantity into recordChannelStockEvent.
 */
export async function readBackEbayInventory(
  opts: { maxSkus?: number } = {},
): Promise<ReadBackResult> {
  const cap =
    opts.maxSkus ??
    (process.env.NEXUS_EBAY_READBACK_MAX
      ? Number.parseInt(process.env.NEXUS_EBAY_READBACK_MAX, 10)
      : DEFAULT_MAX_SKUS)

  const listings = await prisma.channelListing.findMany({
    where: { channel: 'EBAY', listingStatus: 'ACTIVE' },
    select: {
      id: true,
      productId: true,
      product: { select: { sku: true } },
    },
  })

  const capped = listings.length > cap
  if (capped) {
    logger.warn('ebay-readback: active listings exceed cap; truncating', {
      total: listings.length,
      cap,
    })
  }
  const batch = capped ? listings.slice(0, cap) : listings

  const ebay = new EbayService()
  let checked = 0
  let recorded = 0
  let errors = 0
  const now = new Date()

  for (const listing of batch) {
    const sku = listing.product?.sku
    if (!sku) {
      logger.warn('ebay-readback: listing has no SKU, skipping', {
        listingId: listing.id,
        productId: listing.productId,
      })
      continue
    }

    checked++

    try {
      const item = await ebay.getPublishedInventoryItem(sku)
      if (item === null) {
        // 404 — item not on eBay; skip silently
        logger.debug('ebay-readback: SKU not found on eBay, skipping', { sku })
        continue
      }

      const qty = extractEbayPublishedQty(item)
      if (qty === null) {
        logger.warn('ebay-readback: could not extract valid qty, skipping', {
          sku,
          availability: (item as Record<string, unknown>).availability,
        })
        continue
      }

      await recordChannelStockEvent({
        channel: 'EBAY',
        sku,
        channelReportedQty: qty,
        channelEventId: ebayReadbackEventId(sku, now),
        rawPayload: item,
      })

      recorded++
    } catch (err) {
      errors++
      logger.error('ebay-readback: per-SKU error', {
        sku,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  logger.info('ebay-readback: sweep complete', {
    checked,
    recorded,
    errors,
    capped,
  })

  return { checked, recorded, errors, capped }
}
