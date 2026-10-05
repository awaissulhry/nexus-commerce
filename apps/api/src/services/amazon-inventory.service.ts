import { workspaceKey } from '@nexus/database/workspace-context'
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
import { applyStockMovement } from './stock-movement.service.js'
import { logger } from '../utils/logger.js'
import { amazonAccountIdFor, productByOwnSku } from './listings/reported-sku.js'

const FBA_LOCATION_CODE = 'AMAZON-EU-FBA'

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
  async isConfigured(): Promise<boolean> {
    return (await amazonService.isConfigured())
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

  /** H.1 — write FBA fulfillableQuantity into the AMAZON-EU-FBA
   *  StockLevel ledger via the canonical stock-movement service. The
   *  service handles audit-row insertion, totalStock recompute as
   *  SUM(StockLevel), and OutboundSyncQueue fan-out. SKUs absent from
   *  the SP-API response are NOT zeroed (we only iterate `rows` —
   *  StockLevel rows for missing SKUs are untouched), preserving the
   *  pre-H.1 safety contract.
   *
   *  Lookup: a listing's OWN seller SKU on this Amazon account first (S7:
   *  `productByOwnSku` — confirmed, wanted or an old store; two products on
   *  one SKU = skipped and reported, never picked), then SKU-first with ASIN
   *  fallback exactly as before (a listing without its own SKU lands here and
   *  is matched as it always was). Which product the number belongs to is
   *  the only thing that changed; how the FBA number is written did not.
   *  The FBA mirror holds ONE number per product, so a row matched by an own
   *  SKU is written only when no other row of the same sweep lands on that
   *  product (else it is reported, not written): an own SKU never makes one
   *  product's number overwrite another's. Rows matched the old way behave
   *  exactly as before. Delta=0
   *  short-circuit avoids no-op writes (saves a transaction + an
   *  updatedAt bump that would invalidate the 30s grid poll cache for
   *  nothing). */
  private async applyRows(rows: FBAInventoryRow[], summary: SyncSummary): Promise<void> {
    // Resolve the AMAZON-EU-FBA location once per sweep. Created by the
    // H.1 backfill — a missing row is a configuration error worth
    // surfacing loudly rather than silently lazy-creating.
    const fbaLocation = await prisma.stockLocation.findUnique({
      where: { workspace_code: workspaceKey({ code: FBA_LOCATION_CODE }) },
      select: { id: true },
    })
    if (!fbaLocation) {
      const msg = `StockLocation ${FBA_LOCATION_CODE} not found — run H.1 backfill before re-enabling FBA cron`
      summary.errors.push({ sku: 'CONFIG', error: msg })
      logger.error(`amazon-inventory: ${msg}`)
      return
    }

    // S7 — the account the report came from (the fetch used the same default chooser). None resolves → no own-SKU
    // match, so every row is matched exactly as before.
    const accountId = await amazonAccountIdFor()

    // Pass 1 — which product each row belongs to (no write yet).
    const matched: Array<{ row: FBAInventoryRow; productId: string; byOwnSku: boolean }> = []
    for (const row of rows) {
      try {
        const own = await productByOwnSku(prisma, { channel: 'AMAZON', channelConnectionId: accountId, sku: row.sku })
        if (own && own.ambiguous === true) {
          summary.errors.push({ sku: row.sku, error: own.sentence })
          logger.warn('amazon-inventory: seller SKU names more than one product — skipped', { sku: row.sku, productIds: own.productIds })
          continue
        }
        let product: { id: string } | null = own && own.ambiguous === false ? { id: own.productId } : await prisma.product.findUnique({
          where: { workspace_sku: workspaceKey({ sku: row.sku }) },
          select: { id: true },
        })

        if (!product && row.asin) {
          const byAsin = await prisma.product.findFirst({
            where: { amazonAsin: row.asin },
            select: { id: true },
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
        matched.push({ row, productId: product.id, byOwnSku: !!own })
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

    // Pass 2 — write, in the report's order, as before.
    const rowsPerProduct = new Map<string, string[]>()
    for (const m of matched) rowsPerProduct.set(m.productId, [...(rowsPerProduct.get(m.productId) ?? []), m.row.sku])
    for (const { row, productId, byOwnSku } of matched) {
      try {
        const skus = rowsPerProduct.get(productId) ?? []
        if (byOwnSku && skus.length > 1) {
          const error = `FBA units for one product come under ${skus.length} seller SKUs (${skus.join(', ')}). Nexus keeps one FBA number per product, so the number under ${row.sku} was not written.`
          summary.errors.push({ sku: row.sku, error })
          logger.warn('amazon-inventory: own seller SKU shares its product with another row — not written', { sku: row.sku, productId, skus })
          continue
        }

        // Read current FBA quantity for delta calculation.
        const existing = await prisma.stockLevel.findFirst({
          where: {
            productId,
            locationId: fbaLocation.id,
            variationId: null,
          },
          select: { quantity: true },
        })
        const previousQty = existing?.quantity ?? 0
        const newQty = row.fulfillableQuantity
        const delta = newQty - previousQty

        if (delta === 0) {
          summary.productsUnchanged++
          continue
        }

        await applyStockMovement({
          productId,
          locationId: fbaLocation.id,
          change: delta,
          reason: 'SYNC_RECONCILIATION',
          referenceType: 'AmazonFBASync',
          referenceId: row.sku,
          notes: `FBA sweep: fulfillableQuantity ${previousQty} → ${newQty}`,
          actor: 'system:amazon-inventory-cron',
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
