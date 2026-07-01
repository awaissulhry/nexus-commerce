/**
 * Phase 6 Task 2 — Control-tower aggregation + delta-preview endpoints.
 *
 * GET /api/inventory-sync/control-tower
 *   Aggregates all active ChannelListings → ControlTowerRow[] via
 *   buildControlTowerRows(). Returns paginated rows + per-status summary.
 *
 * GET /api/inventory-sync/control-tower/:sku/delta
 *   Read-only preview of what the next FBM push would set for a given
 *   listing (no writes, no push, no stock mutation).
 */
import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import {
  buildControlTowerRows,
  type ControlTowerSkuInput,
  type ControlTowerStatus,
} from '../services/control-tower.service.js'
import { computeAvailableToPublish } from '../services/available-to-publish.service.js'

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

export default async function controlTowerRoutes(app: FastifyInstance): Promise<void> {
  // ─── Endpoint 1 ─────────────────────────────────────────────────────────────
  // GET /api/inventory-sync/control-tower?filter=&page=&pageSize=
  app.get('/inventory-sync/control-tower', async (req, reply) => {
    reply.header('Cache-Control', 'private, max-age=15')
    const q = req.query as { filter?: string; status?: string; channel?: string; page?: string; pageSize?: string }

    const page = Math.max(1, parseInt(q.page ?? '1', 10) || 1)
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(q.pageSize ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE),
    )
    const filter = (q.filter ?? '').trim().toLowerCase()
    const statusFilter = (q.status ?? '').trim().toUpperCase()
    const channelFilter = (q.channel ?? '').trim().toUpperCase()

    try {
      // 1. Fetch all active ChannelListings with their product SKU.
      const listings = await prisma.channelListing.findMany({
        where: { listingStatus: 'ACTIVE' },
        select: {
          id: true,
          channel: true,
          marketplace: true,
          lastSyncStatus: true,
          lastSyncedAt: true,
          quantity: true,
          productId: true,
          fulfillmentMethod: true,
          product: { select: { sku: true } },
        },
      })

      if (listings.length === 0) {
        return reply.send({ rows: [], total: 0, summary: {}, page, pageSize })
      }

      const listingIds = listings.map((l) => l.id)

      // 2. Open OutboundSyncQueue rows for these listings.
      //    Fetch rows that are actionable: in-flight (PENDING/IN_PROGRESS),
      //    explicitly failed, or dead-lettered.
      const queueRows = await prisma.outboundSyncQueue.findMany({
        where: {
          channelListingId: { in: listingIds },
          OR: [
            { syncStatus: { in: ['PENDING', 'IN_PROGRESS', 'FAILED'] } },
            { isDead: true },
          ],
        },
        select: {
          channelListingId: true,
          targetChannel: true,
          syncStatus: true,
          isDead: true,
        },
      })

      // Build a lookup: listingId → { channel, marketplace }
      const listingById = new Map(
        listings.map((l) => [l.id, { channel: l.channel, marketplace: l.marketplace }]),
      )

      // 3. Find productIds with any StockLevel where available < 0.
      const productIds = [...new Set(listings.map((l) => l.productId))]
      const negativeStockRows = await prisma.stockLevel.findMany({
        where: {
          productId: { in: productIds },
          available: { lt: 0 },
        },
        select: { productId: true },
        distinct: ['productId'],
      })
      const negativeProductIds = new Set(negativeStockRows.map((r) => r.productId))

      // 4. Group listings by productId/sku.
      type ListingRecord = (typeof listings)[number]
      const byProduct = new Map<string, { sku: string; productId: string; rows: ListingRecord[] }>()
      for (const l of listings) {
        const existing = byProduct.get(l.productId)
        if (existing) {
          existing.rows.push(l)
        } else {
          byProduct.set(l.productId, { sku: l.product.sku, productId: l.productId, rows: [l] })
        }
      }

      // 5. Build ControlTowerSkuInput[] and call the pure shaper.
      //    clampedChannels: [] — clamp events are ephemeral SSE signals;
      //    Task 5's live banner overlays them client-side, so we pass an empty
      //    array here rather than trying to materialise them from the DB.
      const inputs: ControlTowerSkuInput[] = []
      for (const { sku, productId, rows: productListings } of byProduct.values()) {
        const listingIdsForProduct = new Set(productListings.map((l) => l.id))

        const productQueueRows = queueRows
          .filter((qr) => qr.channelListingId != null && listingIdsForProduct.has(qr.channelListingId))
          .map((qr) => {
            const meta = listingById.get(qr.channelListingId!)
            return {
              channel: meta?.channel ?? String(qr.targetChannel),
              marketplace: meta?.marketplace ?? null,
              syncStatus: String(qr.syncStatus),
              isDead: qr.isDead,
            }
          })

        inputs.push({
          sku,
          productId,
          listings: productListings.map((l) => ({
            channel: l.channel,
            marketplace: l.marketplace,
            lastSyncStatus: l.lastSyncStatus,
            lastSyncedAt: l.lastSyncedAt,
            quantity: l.quantity,
          })),
          queueRows: productQueueRows,
          clampedChannels: [], // see comment above
          negativeAvailable: negativeProductIds.has(productId),
        })
      }

      // Apply optional SKU filter before building rows (cheaper than post-filter).
      const filteredInputs = filter
        ? inputs.filter((i) => i.sku.toLowerCase().includes(filter))
        : inputs

      const allRows = buildControlTowerRows(filteredInputs)

      // 6. Summary: per-status counts across all rows' worstStatus.
      const summary: Record<string, number> = {}
      for (const row of allRows) {
        summary[row.worstStatus] = (summary[row.worstStatus] ?? 0) + 1
      }

      // 7. Apply status + channel filters (summary already computed over allRows above).
      let displayRows = allRows
      if (statusFilter) {
        displayRows = displayRows.filter((row) => row.worstStatus === statusFilter)
      }
      if (channelFilter) {
        displayRows = displayRows.filter((row) =>
          row.channels.some((ch) => ch.channel === channelFilter),
        )
      }

      // 8. Paginate.
      const total = displayRows.length
      const offset = (page - 1) * pageSize
      const pagedRows = displayRows.slice(offset, offset + pageSize)

      return reply.send({ rows: pagedRows, total, summary, page, pageSize })
    } catch (err: any) {
      logger.error('[control-tower] aggregation failed', { message: err?.message ?? String(err) })
      return reply.status(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ─── Endpoint 2 ─────────────────────────────────────────────────────────────
  // GET /api/inventory-sync/control-tower/:sku/delta?channel=&marketplace=
  app.get('/inventory-sync/control-tower/:sku/delta', async (req, reply) => {
    reply.header('Cache-Control', 'private, max-age=10')
    const { sku } = req.params as { sku: string }
    const q = req.query as { channel?: string; marketplace?: string }
    const channel = (q.channel ?? '').toUpperCase()
    // Normalise an empty ?marketplace= to "omitted" (null) — otherwise Prisma
    // filters on marketplace="" and returns a spurious 404.
    const marketplace = q.marketplace?.trim() || null

    if (!channel) {
      return reply.status(400).send({ error: 'channel query param is required' })
    }

    try {
      // Resolve the active listing for this sku + channel + marketplace.
      const listing = await prisma.channelListing.findFirst({
        where: {
          listingStatus: 'ACTIVE',
          channel,
          marketplace: marketplace ?? undefined,
          product: { sku },
        },
        select: {
          id: true,
          channel: true,
          marketplace: true,
          quantity: true,
          stockBuffer: true,
          fulfillmentMethod: true,
          productId: true,
          product: { select: { sku: true } },
        },
      })

      if (!listing) {
        return reply.status(404).send({
          error: `No active listing found for sku=${sku} channel=${channel} marketplace=${marketplace ?? 'any'}`,
        })
      }

      // FBA detection: if this listing's fulfillmentMethod is FBA, Amazon owns
      // the published quantity entirely — our warehouse stock doesn't drive it.
      const isFba = listing.fulfillmentMethod === 'FBA'
      if (isFba) {
        return reply.send({
          sku,
          channel: listing.channel,
          marketplace: listing.marketplace,
          currentPublishedQty: listing.quantity ?? null,
          fbaManaged: true,
          note: 'FBA listing — published quantity is owned by Amazon FBA; no FBM delta applies.',
        })
      }

      // Compute warehouse available: sum StockLevel.available across WAREHOUSE
      // locations for this product.
      const warehouseStockRows = await prisma.stockLevel.findMany({
        where: {
          productId: listing.productId,
          location: { type: 'WAREHOUSE' },
        },
        select: { available: true },
      })
      const warehouseAvailable = warehouseStockRows.reduce((sum, r) => sum + r.available, 0)

      const stockBuffer = listing.stockBuffer ?? 0
      const result = computeAvailableToPublish({
        fulfillmentMethod: 'FBM',
        warehouseAvailable,
        fbaSellable: 0,
        stockBuffer,
      })

      const currentPublishedQty = listing.quantity ?? null
      const targetQty = result.available
      const wouldClamp = (currentPublishedQty ?? 0) > targetQty

      return reply.send({
        sku,
        channel: listing.channel,
        marketplace: listing.marketplace,
        currentPublishedQty,
        targetQty,
        wouldClamp,
        warehouseAvailable,
        stockBuffer,
        fbaManaged: false,
      })
    } catch (err: any) {
      logger.error('[control-tower/delta] failed', { sku, message: err?.message ?? String(err) })
      return reply.status(500).send({ error: err?.message ?? String(err) })
    }
  })
}
