/**
 * Amazon FBA inventory sync — getInventorySummaries → Product.totalStock.
 *
 * Two entry points:
 *   - syncFBAInventory()              — full sweep of every FBA SKU
 *   - syncFBAInventoryForSkus(skus)   — bounded refresh for specific SKUs
 *
 * Critical safety property: SKUs absent from the SP-API response are
 * NOT zeroed. The endpoint covers FBA only; MFN/FBM SKUs simply don't
 * appear in the response, and zeroing them would silently delete the
 * merchant's MFN inventory ledger. We update only the SKUs Amazon
 * reports back.
 *
 * What we write to Product.totalStock: `fulfillableQuantity` — the
 * units Amazon will actually ship today. This intentionally excludes
 * inbound (in-flight to the FC) and reserved (stuck in pending orders),
 * matching the "what can I sell right now" semantics the /products
 * grid exposes. The richer breakdown lives in the per-row return value
 * for callers that want it (cron logging, dashboard tiles).
 */

import prisma from '../db.js'
import { AmazonService, FBAInventoryRow } from './marketplaces/amazon.service.js'
import { logger } from '../utils/logger.js'

const amazonService = new AmazonService()

interface SyncSummary {
  startedAt: Date
  completedAt: Date
  durationMs: number
  marketplaceId: string
  rowsFetched: number
  productsUpdated: number
  productsUnchanged: number
  skusNotFoundInDb: number
  errors: Array<{ sku: string; error: string }>
  // First few unmatched SKUs for diagnostics (full list would flood logs)
  unmatchedSampleSkus: string[]
}

export class AmazonInventoryService {
  isConfigured(): boolean {
    return amazonService.isConfigured()
  }

  /** Full FBA sweep — call this from the 15-min cron. */
  async syncFBAInventory(options: { marketplaceId?: string } = {}): Promise<SyncSummary> {
    const startedAt = new Date()
    const marketplaceId =
      options.marketplaceId ??
      process.env.AMAZON_MARKETPLACE_ID ??
      'APJ6JRA9NG5V4'

    const summary: SyncSummary = {
      startedAt,
      completedAt: startedAt,
      durationMs: 0,
      marketplaceId,
      rowsFetched: 0,
      productsUpdated: 0,
      productsUnchanged: 0,
      skusNotFoundInDb: 0,
      errors: [],
      unmatchedSampleSkus: [],
    }

    let rows: FBAInventoryRow[]
    try {
      rows = await amazonService.fetchFBAInventory({ marketplaceId })
      summary.rowsFetched = rows.length
    } catch (err) {
      summary.errors.push({
        sku: 'FETCH',
        error: err instanceof Error ? err.message : String(err),
      })
      logger.error('amazon-inventory: fetch failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      summary.completedAt = new Date()
      summary.durationMs = summary.completedAt.getTime() - startedAt.getTime()
      return summary
    }

    await this.applyRows(rows, summary)

    summary.completedAt = new Date()
    summary.durationMs = summary.completedAt.getTime() - startedAt.getTime()
    logger.info('amazon-inventory: sync complete', {
      marketplaceId,
      durationMs: summary.durationMs,
      rowsFetched: summary.rowsFetched,
      productsUpdated: summary.productsUpdated,
      productsUnchanged: summary.productsUnchanged,
      skusNotFoundInDb: summary.skusNotFoundInDb,
      errorCount: summary.errors.length,
    })
    return summary
  }

  /** Bounded refresh for specific SKUs — useful from a webhook handler
   *  ("Amazon told me SKU X just changed") or from manual ops. SP-API
   *  caps sellerSkus per call at 50; we don't chunk here because a
   *  caller passing >50 SKUs is almost always doing a full sweep
   *  anyway — use syncFBAInventory for that. */
  async syncFBAInventoryForSkus(
    sellerSkus: string[],
    options: { marketplaceId?: string } = {},
  ): Promise<SyncSummary> {
    const startedAt = new Date()
    const marketplaceId =
      options.marketplaceId ??
      process.env.AMAZON_MARKETPLACE_ID ??
      'APJ6JRA9NG5V4'

    const summary: SyncSummary = {
      startedAt,
      completedAt: startedAt,
      durationMs: 0,
      marketplaceId,
      rowsFetched: 0,
      productsUpdated: 0,
      productsUnchanged: 0,
      skusNotFoundInDb: 0,
      errors: [],
      unmatchedSampleSkus: [],
    }

    if (sellerSkus.length === 0) {
      summary.completedAt = new Date()
      return summary
    }

    let rows: FBAInventoryRow[]
    try {
      rows = await amazonService.fetchFBAInventory({
        marketplaceId,
        sellerSkus: sellerSkus.slice(0, 50),
      })
      summary.rowsFetched = rows.length
    } catch (err) {
      summary.errors.push({
        sku: 'FETCH',
        error: err instanceof Error ? err.message : String(err),
      })
      summary.completedAt = new Date()
      summary.durationMs = summary.completedAt.getTime() - startedAt.getTime()
      return summary
    }

    await this.applyRows(rows, summary)
    summary.completedAt = new Date()
    summary.durationMs = summary.completedAt.getTime() - startedAt.getTime()
    return summary
  }

  // ── internals ────────────────────────────────────────────────────────

  /** Look up local Product by SKU first, ASIN as fallback for the case
   *  where Amazon's SKU drifted from ours but the ASIN matches. Update
   *  totalStock only if it actually changed (saves a write + an updatedAt
   *  bump that would invalidate the 30s grid poll cache for nothing). */
  private async applyRows(rows: FBAInventoryRow[], summary: SyncSummary): Promise<void> {
    for (const row of rows) {
      try {
        let product = await prisma.product.findUnique({
          where: { sku: row.sku },
          select: { id: true, totalStock: true },
        })

        if (!product && row.asin) {
          const byAsin = await prisma.product.findFirst({
            where: { amazonAsin: row.asin },
            select: { id: true, totalStock: true },
          })
          product = byAsin
        }

        if (!product) {
          summary.skusNotFoundInDb++
          if (summary.unmatchedSampleSkus.length < 10) {
            summary.unmatchedSampleSkus.push(row.sku)
          }
          continue
        }

        if (product.totalStock === row.fulfillableQuantity) {
          summary.productsUnchanged++
          continue
        }

        await prisma.product.update({
          where: { id: product.id },
          data: { totalStock: row.fulfillableQuantity },
        })
        summary.productsUpdated++
      } catch (err) {
        summary.errors.push({
          sku: row.sku,
          error: err instanceof Error ? err.message : String(err),
        })
        logger.warn('amazon-inventory: per-SKU update failed', {
          sku: row.sku,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }
}

export const amazonInventoryService = new AmazonInventoryService()
