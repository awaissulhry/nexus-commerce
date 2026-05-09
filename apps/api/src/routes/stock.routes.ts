import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { applyStockMovement, listStockMovements } from '../services/stock-movement.service.js'
import {
  reserveStock,
  releaseReservation,
  transferStock,
} from '../services/stock-level.service.js'
import { amazonInventoryService } from '../services/amazon-inventory.service.js'
import { resolveAtp } from '../services/atp.service.js'
import { resolveAtpAcrossChannels } from '../services/atp-channel.service.js'
import { getReservationSweepStatus } from '../jobs/reservation-sweep.job.js'
import * as abcService from '../services/abc-classification.service.js'
import { listLayers, recomputeWac } from '../services/cost-layers.service.js'
import {
  computeYearEndValuation,
  readYearEndSnapshot,
  snapshotYearEndValuation,
} from '../services/year-end-snapshot.service.js'
import {
  createLot,
  traceLotForward,
  traceLotBackward,
  openRecall,
  closeRecall,
  listRecalls,
  getRecall,
  releaseReservationsForRecall,
} from '../services/lot.service.js'
import {
  createSerial,
  bulkCreateSerials,
  reserveSerial,
  shipSerial,
  returnSerial,
  restoreSerial,
  disposeSerial,
  traceSerial,
} from '../services/serial.service.js'
import * as shopifyLocations from '../services/shopify-locations.service.js'
import { ShopifyService } from '../services/marketplaces/shopify.service.js'
import {
  createMCFShipment,
  syncMCFStatus,
  cancelMCFShipment,
  listMCFShipments,
  unconfiguredAdapter as mcfUnconfiguredAdapter,
  type MCFAdapter,
} from '../services/amazon-mcf.service.js'
import {
  getPanEuSnapshot,
  getAgedInventory,
  getUnfulfillable,
} from '../services/fba-pan-eu.service.js'

// S.24 — production adapter resolves to either the wired SP-API
// client (when AMAZON_MCF_LIVE=1) or the unconfigured stub.
function resolveMCFAdapter(): MCFAdapter {
  if (process.env.AMAZON_MCF_LIVE === '1') {
    // TODO: wire the real SP-API MCF adapter (pre-flight commit).
    // Until then we return the stub so the route surfaces a clear
    // 'not configured' error instead of crashing.
  }
  return mcfUnconfiguredAdapter
}

// ─────────────────────────────────────────────────────────────────────
// H.2 — Stock API surface for /fulfillment/stock rebuild.
//
//   GET    /api/stock                 — paginated StockLevel list
//   GET    /api/stock/locations       — every StockLocation + summary
//   GET    /api/stock/movements       — audit log with filters
//   PATCH  /api/stock/:id             — adjust quantity at a StockLevel
//   POST   /api/stock/transfer        — between locations
//   POST   /api/stock/reserve         — allocate to an order
//   POST   /api/stock/release/:rid    — release a reservation
//   POST   /api/stock/sync            — manual FBA cron trigger
//
// The legacy /api/fulfillment/stock endpoints stay live for the current
// /fulfillment/stock UI; Commit 3 swaps the page over to /api/stock.
// ─────────────────────────────────────────────────────────────────────

function safeNum(v: unknown, fallback?: number): number | undefined {
  if (v == null) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

const stockRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /api/stock ──────────────────────────────────────────────
  // Paginated, filtered StockLevel list joined with product + location.
  // Supported filters:
  //   locationCode       'IT-MAIN' | 'AMAZON-EU-FBA' | ...
  //   status             'IN_STOCK' | 'LOW' | 'CRITICAL' | 'OUT_OF_STOCK'
  //   search             SKU, product name, ASIN
  //   page, pageSize
  fastify.get('/stock', async (request, reply) => {
    try {
      const q = request.query as any
      const page = Math.max(1, Math.floor(safeNum(q.page, 1) ?? 1))
      const pageSize = Math.min(200, Math.max(1, Math.floor(safeNum(q.pageSize, 50) ?? 50)))
      const skip = (page - 1) * pageSize

      const where: any = {}

      if (q.locationCode) {
        const loc = await prisma.stockLocation.findUnique({
          where: { code: q.locationCode },
          select: { id: true },
        })
        if (!loc) {
          return { items: [], total: 0, page, pageSize, totalPages: 0 }
        }
        where.locationId = loc.id
      }

      if (q.status === 'OUT_OF_STOCK') where.quantity = 0
      else if (q.status === 'CRITICAL') where.quantity = { gt: 0, lte: 5 }
      else if (q.status === 'LOW') where.quantity = { gt: 5, lte: 15 }
      else if (q.status === 'IN_STOCK') where.quantity = { gt: 15 }

      if (q.search?.trim()) {
        const s = q.search.trim()
        where.product = {
          OR: [
            { sku: { contains: s, mode: 'insensitive' } },
            { name: { contains: s, mode: 'insensitive' } },
            { amazonAsin: { contains: s, mode: 'insensitive' } },
          ],
        }
      }

      const [total, rows] = await Promise.all([
        prisma.stockLevel.count({ where }),
        prisma.stockLevel.findMany({
          where,
          include: {
            location: { select: { id: true, code: true, name: true, type: true } },
            product: {
              select: {
                id: true, sku: true, name: true, amazonAsin: true,
                lowStockThreshold: true, costPrice: true, basePrice: true,
                abcClass: true,
                images: { select: { url: true }, take: 1 },
              },
            },
            variation: {
              select: { id: true, sku: true, variationAttributes: true },
            },
          },
          orderBy: [{ quantity: 'asc' }, { lastUpdatedAt: 'desc' }],
          skip,
          take: pageSize,
        }),
      ])

      return {
        items: rows.map((r) => ({
          id: r.id,
          quantity: r.quantity,
          reserved: r.reserved,
          available: r.available,
          reorderThreshold: r.reorderThreshold,
          // T.32 — surface EOQ alongside threshold so at-reorder rows
          // show "ROP 12 · +50" inline; operator can decide before
          // opening the drawer.
          reorderQuantity: r.reorderQuantity,
          syncStatus: r.syncStatus,
          lastUpdatedAt: r.lastUpdatedAt,
          lastSyncedAt: r.lastSyncedAt,
          location: r.location,
          product: {
            ...r.product,
            costPrice: r.product.costPrice == null ? null : Number(r.product.costPrice),
            basePrice: r.product.basePrice == null ? null : Number(r.product.basePrice),
            thumbnailUrl: r.product.images?.[0]?.url ?? null,
          },
          variation: r.variation,
        })),
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock] list failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── GET /api/stock/sync-status ───────────────────────────────────
  // Sync engine health, derived from observable signals — no separate
  // tracking table. Powers the sync indicator badge in the page header.
  //
  //   amazonFbaCron   — last successful reconciliation (any delta) +
  //                     whether the cron is currently configured
  //   reservationSweep — in-process state from the sweep job
  //   outboundQueue   — counts of QUANTITY_UPDATE rows by syncStatus
  //                     (PENDING / SYNCING / FAILED) — proves the
  //                     Phase 13 cascade fan-out is draining
  //   recentReconciliations — last 24h count for trend signal
  fastify.get('/stock/sync-status', async (_request, reply) => {
    try {
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000)

      const [
        lastFbaReconciliation,
        recentReconciliationCount,
        outboundQueueByStatus,
        oldestPendingOutbound,
      ] = await Promise.all([
        prisma.stockMovement.findFirst({
          where: { reason: 'SYNC_RECONCILIATION', actor: 'system:amazon-inventory-cron' },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true, change: true },
        }),
        prisma.stockMovement.count({
          where: { reason: 'SYNC_RECONCILIATION', createdAt: { gte: since24h } },
        }),
        prisma.outboundSyncQueue.groupBy({
          by: ['syncStatus'],
          where: { syncType: 'QUANTITY_UPDATE' },
          _count: { syncStatus: true },
        }),
        prisma.outboundSyncQueue.findFirst({
          where: { syncType: 'QUANTITY_UPDATE', syncStatus: 'PENDING' },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
      ])

      const outboundCounts: Record<string, number> = {}
      for (const r of outboundQueueByStatus) {
        outboundCounts[r.syncStatus] = r._count.syncStatus
      }

      // T.2/T.1 — surface Pan-EU + eBay configuration health so the
      // SyncIndicator can warn the operator when an integration is
      // wired but disabled (silent failure mode).
      const panEuLive = process.env.AMAZON_FBA_PAN_EU_LIVE === '1'
      const ebayCredsPresent = !!(
        process.env.EBAY_APP_ID && process.env.EBAY_CERT_ID &&
        process.env.EBAY_DEV_ID && process.env.EBAY_TOKEN
      )
      const ebayRealApi = process.env.NEXUS_EBAY_REAL_API === 'true'

      return {
        amazonFbaCron: {
          configured: amazonInventoryService.isConfigured(),
          enabled: process.env.NEXUS_ENABLE_AMAZON_INVENTORY_CRON === '1',
          lastReconciliationAt: lastFbaReconciliation?.createdAt ?? null,
          lastReconciliationDelta: lastFbaReconciliation?.change ?? null,
        },
        panEu: {
          enabledIntent: panEuLive,
          adapterWired: false, // adapter is the unconfigured stub today
          // When intent is set but the adapter isn't wired, the cron
          // silently skips. This flag lets the UI warn explicitly.
          silentSkipRisk: panEuLive,
        },
        ebay: {
          credentialsConfigured: ebayCredsPresent,
          realApiEnabled: ebayRealApi,
          // The dangerous combo: creds present but real-API opt-in
          // not set. eBay sync attempts will fail-loud in production
          // (T.1 — better than silent overselling).
          silentDriftRisk: ebayCredsPresent && !ebayRealApi,
        },
        reservationSweep: getReservationSweepStatus(),
        outboundQueue: {
          pending: outboundCounts.PENDING ?? 0,
          syncing: outboundCounts.SYNCING ?? 0,
          failed: outboundCounts.FAILED ?? 0,
          synced: outboundCounts.SYNCED ?? 0,
          oldestPendingAt: oldestPendingOutbound?.createdAt ?? null,
        },
        recentReconciliationCount,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/sync-status] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── GET /api/stock/insights ──────────────────────────────────────
  // Three smart-feature roll-ups consumed by the Insights panel on
  // /fulfillment/stock. Each category caps results to a small N so the
  // panel stays scannable; the user clicks through to the drawer or
  // /fulfillment/replenishment for the full list.
  //
  //   stockoutRisk    — products at zero, plus products with
  //                     daysOfStock < leadTime + 7 (when sales data exists)
  //   allocationGaps  — one location has a healthy surplus while another
  //                     is at zero or critical (transfer candidate)
  //   syncConflicts   — recent SYNC_RECONCILIATION movements (last 24h)
  //                     where the FBA cron found a delta vs Nexus
  fastify.get('/stock/insights', async (_request, reply) => {
    try {
      const STOCKOUT_LIMIT = 10
      const ALLOC_LIMIT = 8
      const CONFLICT_LIMIT = 10
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000)

      // ── Stockout risk ───────────────────────────────────────────
      // Pull buyables at risk: totalStock=0 OR totalStock <= threshold.
      // When DailySalesAggregate has signal we'd refine to days-of-stock
      // < leadTime+7, but with zero rows in the aggregate today the
      // threshold-based heuristic carries the load.
      const atRisk = await prisma.product.findMany({
        where: {
          isParent: false,
          status: { not: 'INACTIVE' },
          OR: [
            { totalStock: 0 },
            { totalStock: { gt: 0, lte: 5 } },
          ],
        },
        select: {
          id: true, sku: true, name: true, amazonAsin: true,
          totalStock: true, lowStockThreshold: true, costPrice: true,
          images: { select: { url: true }, take: 1 },
        },
        orderBy: [{ totalStock: 'asc' }, { name: 'asc' }],
        take: STOCKOUT_LIMIT,
      })

      // ── Allocation gaps ─────────────────────────────────────────
      // Find products with ≥2 locations where one is at ≤ 5 units and
      // another has > 4× the threshold. Strong signal that a transfer
      // would rebalance without touching reorder cadence.
      const productsWithMultipleLocations = await prisma.stockLevel.groupBy({
        by: ['productId'],
        having: { productId: { _count: { gt: 1 } } },
        _count: { productId: true },
      })
      const candidateProductIds = productsWithMultipleLocations.map((p) => p.productId)

      const allocationGaps: Array<{
        productId: string; sku: string; name: string; thumbnailUrl: string | null
        surplusLocation: { id: string; code: string; quantity: number }
        deficitLocation: { id: string; code: string; quantity: number }
        suggestedTransfer: number
      }> = []

      if (candidateProductIds.length > 0) {
        const productsWithLevels = await prisma.product.findMany({
          where: { id: { in: candidateProductIds } },
          select: {
            id: true, sku: true, name: true, lowStockThreshold: true,
            images: { select: { url: true }, take: 1 },
            stockLevels: {
              include: { location: { select: { id: true, code: true } } },
            },
          },
          take: 200,
        })

        for (const p of productsWithLevels) {
          if (p.stockLevels.length < 2) continue
          const sorted = [...p.stockLevels].sort((a, b) => b.quantity - a.quantity)
          const surplus = sorted[0]
          const deficit = sorted[sorted.length - 1]
          if (deficit.quantity > 5) continue
          if (surplus.quantity <= 4 * p.lowStockThreshold) continue
          // Suggest a transfer that brings deficit up to threshold
          // without dropping surplus below 2× threshold (cap to half
          // the surplus when in doubt).
          const targetLift = p.lowStockThreshold - deficit.quantity
          const safeSurplusGive = Math.max(0, surplus.quantity - 2 * p.lowStockThreshold)
          const suggested = Math.min(targetLift, safeSurplusGive, Math.floor(surplus.quantity / 2))
          if (suggested <= 0) continue
          allocationGaps.push({
            productId: p.id,
            sku: p.sku,
            name: p.name,
            thumbnailUrl: p.images?.[0]?.url ?? null,
            surplusLocation: { id: surplus.location.id, code: surplus.location.code, quantity: surplus.quantity },
            deficitLocation: { id: deficit.location.id, code: deficit.location.code, quantity: deficit.quantity },
            suggestedTransfer: suggested,
          })
          if (allocationGaps.length >= ALLOC_LIMIT) break
        }
      }

      // ── Sync conflicts ──────────────────────────────────────────
      // Recent SYNC_RECONCILIATION rows from the FBA cron — these mean
      // Amazon's getInventorySummaries returned a fulfillableQuantity
      // that disagreed with our cached StockLevel. The change column
      // is the delta (positive = Amazon had more units than we knew).
      const conflicts = await prisma.stockMovement.findMany({
        where: {
          reason: 'SYNC_RECONCILIATION',
          createdAt: { gte: since24h },
        },
        select: {
          id: true, productId: true, change: true,
          quantityBefore: true, balanceAfter: true,
          notes: true, createdAt: true, locationId: true,
          location: { select: { code: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: CONFLICT_LIMIT,
      })

      // Resolve product info for the conflict rows in one batched query
      // (StockMovement has productId but no Prisma `product` relation).
      const conflictProductIds = Array.from(new Set(conflicts.map((c) => c.productId)))
      const productsForConflicts = conflictProductIds.length === 0
        ? []
        : await prisma.product.findMany({
            where: { id: { in: conflictProductIds } },
            select: { id: true, sku: true, name: true, amazonAsin: true },
          })
      const productById = new Map(productsForConflicts.map((p) => [p.id, p]))

      return {
        stockoutRisk: atRisk.map((p) => ({
          ...p,
          costPrice: p.costPrice == null ? null : Number(p.costPrice),
          thumbnailUrl: p.images?.[0]?.url ?? null,
        })),
        allocationGaps,
        syncConflicts: conflicts.map((c) => {
          const p = productById.get(c.productId)
          return {
            id: c.id,
            productId: c.productId,
            sku: p?.sku ?? null,
            name: p?.name ?? null,
            asin: p?.amazonAsin ?? null,
            locationCode: c.location?.code ?? null,
            change: c.change,
            quantityBefore: c.quantityBefore,
            balanceAfter: c.balanceAfter,
            notes: c.notes,
            createdAt: c.createdAt,
          }
        }),
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/insights] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── GET /api/stock/by-product ────────────────────────────────────
  // Pivoted view: one row per product with stockLevels[] nested for
  // every location. Powers the matrix + cards views which need the
  // per-location breakdown alongside each product. Search + status
  // filters apply at the product level; locationCode is intentionally
  // ignored here (matrix shows all locations as columns).
  fastify.get('/stock/by-product', async (request, reply) => {
    try {
      const q = request.query as any
      const page = Math.max(1, Math.floor(safeNum(q.page, 1) ?? 1))
      const pageSize = Math.min(200, Math.max(1, Math.floor(safeNum(q.pageSize, 50) ?? 50)))
      const skip = (page - 1) * pageSize

      const where: any = { isParent: false }

      if (q.status === 'OUT_OF_STOCK') where.totalStock = 0
      else if (q.status === 'CRITICAL') where.totalStock = { gt: 0, lte: 5 }
      else if (q.status === 'LOW') where.totalStock = { gt: 5, lte: 15 }
      else if (q.status === 'IN_STOCK') where.totalStock = { gt: 15 }

      if (q.search?.trim()) {
        const s = q.search.trim()
        where.OR = [
          { sku: { contains: s, mode: 'insensitive' } },
          { name: { contains: s, mode: 'insensitive' } },
          { amazonAsin: { contains: s, mode: 'insensitive' } },
        ]
      }

      const [total, products, locations] = await Promise.all([
        prisma.product.count({ where }),
        prisma.product.findMany({
          where,
          select: {
            id: true, sku: true, name: true, amazonAsin: true,
            totalStock: true, lowStockThreshold: true,
            costPrice: true, basePrice: true,
            images: { select: { url: true }, take: 1 },
            stockLevels: {
              select: {
                id: true, locationId: true,
                quantity: true, reserved: true, available: true,
                lastUpdatedAt: true,
              },
            },
          },
          orderBy: [{ totalStock: 'asc' }, { name: 'asc' }],
          skip,
          take: pageSize,
        }),
        prisma.stockLocation.findMany({
          where: { isActive: true },
          select: { id: true, code: true, name: true, type: true },
          orderBy: [{ type: 'asc' }, { code: 'asc' }],
        }),
      ])

      return {
        locations,
        products: products.map((p) => ({
          id: p.id,
          sku: p.sku,
          name: p.name,
          amazonAsin: p.amazonAsin,
          totalStock: p.totalStock,
          lowStockThreshold: p.lowStockThreshold,
          costPrice: p.costPrice == null ? null : Number(p.costPrice),
          basePrice: p.basePrice == null ? null : Number(p.basePrice),
          thumbnailUrl: p.images?.[0]?.url ?? null,
          stockLevels: p.stockLevels.map((sl) => ({
            id: sl.id,
            locationId: sl.locationId,
            quantity: sl.quantity,
            reserved: sl.reserved,
            available: sl.available,
            lastUpdatedAt: sl.lastUpdatedAt,
          })),
        })),
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/by-product] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── GET /api/stock/kpis ──────────────────────────────────────────
  // Roll-ups for the KPI strip on /fulfillment/stock. All numbers are
  // product-level (not per-StockLevel) for the "how many SKUs are in
  // trouble" framing — Riccione + FBA together count once per product.
  fastify.get('/stock/kpis', async (_request, reply) => {
    try {
      const buyables = await prisma.product.findMany({
        where: { isParent: false },
        select: { id: true, totalStock: true, lowStockThreshold: true, costPrice: true },
      })

      let totalStockUnits = 0
      let totalStockValueCents = 0
      let stockouts = 0
      let critical = 0
      let low = 0
      let healthy = 0
      for (const p of buyables) {
        totalStockUnits += p.totalStock
        if (p.costPrice != null) {
          totalStockValueCents += p.totalStock * Math.round(Number(p.costPrice) * 100)
        }
        if (p.totalStock === 0) stockouts++
        else if (p.totalStock <= 5) critical++
        else if (p.totalStock <= p.lowStockThreshold) low++
        else healthy++
      }

      const reservedAgg = await prisma.stockLevel.aggregate({
        _sum: { reserved: true, available: true },
      })

      const activeLocations = await prisma.stockLocation.count({ where: { isActive: true } })

      return {
        totalStockUnits,
        totalStockValue: Math.round(totalStockValueCents) / 100,
        totalReserved: reservedAgg._sum.reserved ?? 0,
        totalAvailable: reservedAgg._sum.available ?? 0,
        stockouts,
        critical,
        low,
        healthy,
        totalSkus: buyables.length,
        activeLocations,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/kpis] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── GET /api/stock/locations ────────────────────────────────────
  // Every location + roll-up: total quantity, reserved, available,
  // SKU count. Powers the location selector in the rebuilt page.
  fastify.get('/stock/locations', async (_request, reply) => {
    try {
      const locations = await prisma.stockLocation.findMany({
        orderBy: [{ type: 'asc' }, { code: 'asc' }],
        include: {
          _count: { select: { stockLevels: true } },
        },
      })

      // One aggregate per location — cheap (1 query per location).
      const summaries = await Promise.all(
        locations.map(async (loc) => {
          const agg = await prisma.stockLevel.aggregate({
            where: { locationId: loc.id },
            _sum: { quantity: true, reserved: true, available: true },
          })
          return {
            id: loc.id,
            code: loc.code,
            name: loc.name,
            type: loc.type,
            isActive: loc.isActive,
            servesMarketplaces: loc.servesMarketplaces,
            warehouseId: loc.warehouseId,
            skuCount: loc._count.stockLevels,
            totalQuantity: agg._sum.quantity ?? 0,
            totalReserved: agg._sum.reserved ?? 0,
            totalAvailable: agg._sum.available ?? 0,
          }
        }),
      )

      return { locations: summaries }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/locations] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── GET /api/stock/product/:productId ────────────────────────────
  // One-shot bundle for the multi-location drawer. Returns:
  //   - product header
  //   - per-location StockLevel breakdown
  //   - per-channel listing sync status
  //   - recent movements (last 50)
  //   - sales velocity (last 30d totals + 90d daily history)
  //   - ATP (lead time + open inbound)
  //   - active reservations
  fastify.get('/stock/product/:productId', async (request, reply) => {
    try {
      const { productId } = request.params as { productId: string }

      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: {
          id: true,
          sku: true,
          name: true,
          amazonAsin: true,
          totalStock: true,
          lowStockThreshold: true,
          basePrice: true,
          costPrice: true,
          // S.20 — costing method + rolling WAC for the drawer header
          costingMethod: true,
          weightedAvgCostCents: true,
          images: { select: { url: true }, take: 1 },
        },
      })
      if (!product) return reply.code(404).send({ error: 'Product not found' })

      // S.20 — layer history (top 30 by recency) attached to the
      // bundle so the drawer renders without a second roundtrip.
      const costLayers = await listLayers(productId, 30)

      const [stockLevels, channelListings, movements, atpMap] = await Promise.all([
        prisma.stockLevel.findMany({
          where: { productId },
          include: {
            location: { select: { id: true, code: true, name: true, type: true, isActive: true } },
            reservations: {
              where: { releasedAt: null, consumedAt: null },
              orderBy: { createdAt: 'desc' },
            },
          },
          orderBy: { quantity: 'desc' },
        }),
        prisma.channelListing.findMany({
          where: { productId },
          select: {
            id: true, channel: true, marketplace: true, listingStatus: true,
            syncStatus: true, lastSyncedAt: true, lastSyncStatus: true, lastSyncError: true,
            quantity: true, stockBuffer: true, externalListingId: true,
          },
          orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }],
        }),
        listStockMovements({ productId, limit: 50 }),
        resolveAtp({ products: [{ id: product.id, sku: product.sku }] }),
      ])

      // Sales velocity: aggregate DailySalesAggregate for the last 90 days.
      const ninetyDaysAgo = new Date()
      ninetyDaysAgo.setUTCDate(ninetyDaysAgo.getUTCDate() - 90)
      ninetyDaysAgo.setUTCHours(0, 0, 0, 0)
      const sales = await prisma.dailySalesAggregate.findMany({
        where: { sku: product.sku, day: { gte: ninetyDaysAgo } },
        select: { day: true, unitsSold: true, grossRevenue: true, ordersCount: true, channel: true },
        orderBy: { day: 'asc' },
      })

      // Roll up by day across channels
      const dailyMap = new Map<string, { units: number; revenueCents: number; orders: number }>()
      for (const s of sales) {
        const key = s.day.toISOString().slice(0, 10)
        const cur = dailyMap.get(key) ?? { units: 0, revenueCents: 0, orders: 0 }
        cur.units += s.unitsSold
        cur.revenueCents += Math.round(Number(s.grossRevenue) * 100)
        cur.orders += s.ordersCount
        dailyMap.set(key, cur)
      }
      const dailyHistory = Array.from(dailyMap.entries())
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([day, v]) => ({
          day,
          units: v.units,
          revenue: v.revenueCents / 100,
          orders: v.orders,
        }))

      const last30Cutoff = new Date()
      last30Cutoff.setUTCDate(last30Cutoff.getUTCDate() - 30)
      const last30 = sales.filter((s) => s.day >= last30Cutoff)
      const last30Units = last30.reduce((acc, s) => acc + s.unitsSold, 0)
      const last30Revenue = last30.reduce((acc, s) => acc + Number(s.grossRevenue), 0)
      const avgDailyUnits = last30Units / 30
      const totalAvailable = stockLevels.reduce((acc, sl) => acc + sl.available, 0)
      const daysOfStock =
        avgDailyUnits > 0
          ? Math.floor(totalAvailable / avgDailyUnits)
          : null

      const atp = atpMap.get(product.id)

      return {
        product: {
          ...product,
          basePrice: product.basePrice == null ? null : Number(product.basePrice),
          costPrice: product.costPrice == null ? null : Number(product.costPrice),
          thumbnailUrl: product.images?.[0]?.url ?? null,
        },
        stockLevels: stockLevels.map((sl) => ({
          id: sl.id,
          location: sl.location,
          quantity: sl.quantity,
          reserved: sl.reserved,
          available: sl.available,
          reorderThreshold: sl.reorderThreshold,
          lastUpdatedAt: sl.lastUpdatedAt,
          lastSyncedAt: sl.lastSyncedAt,
          syncStatus: sl.syncStatus,
          activeReservations: sl.reservations.length,
        })),
        channelListings,
        movements,
        salesVelocity: {
          last30Units,
          last30Revenue,
          avgDailyUnits: Math.round(avgDailyUnits * 100) / 100,
          daysOfStock,
          totalAvailable,
          dailyHistory,
        },
        atp: atp ?? null,
        // S.26 — per-channel ATP rollup. byLocation comes from the
        // resolveAtp call above (it computes the per-row breakdown
        // we feed back here). Empty when the product has no
        // ChannelListings.
        atpPerChannel: atp ? await resolveAtpAcrossChannels({
          productId: product.id,
          byLocation: atp.byLocation as any,
        }) : [],
        // S.20 — costing surface
        costing: {
          method: product.costingMethod,
          weightedAvgCostCents: product.weightedAvgCostCents,
          layers: costLayers,
        },
        reservations: stockLevels.flatMap((sl) =>
          sl.reservations.map((r) => ({
            ...r,
            quantity: r.quantity,
            location: { id: sl.location.id, code: sl.location.code },
          })),
        ),
        // L.10 — active lots for this product, FEFO-ordered. Includes
        // any OPEN recall so the drawer can flag recalled batches
        // even though they're suppressed from FEFO consume. Capped at
        // 50 — products with more lots than that need the dedicated
        // /api/stock/lots endpoint with filters.
        lots: await prisma.lot.findMany({
          where: { productId, unitsRemaining: { gt: 0 } },
          orderBy: [{ expiresAt: 'asc' }, { receivedAt: 'asc' }],
          take: 50,
          select: {
            id: true, lotNumber: true, receivedAt: true, expiresAt: true,
            unitsReceived: true, unitsRemaining: true, supplierLotRef: true,
            recalls: {
              where: { status: 'OPEN' },
              select: { id: true, reason: true, openedAt: true },
              take: 1,
            },
          },
        }),
        // SR.4 — serial-tracked units for this product. Surfaced in
        // the drawer when present; empty for products without serials.
        // Capped at 50 + summary counts so the drawer doesn't
        // serialize 1000s of rows for high-volume products.
        serials: await prisma.serialNumber.findMany({
          where: { productId },
          orderBy: [{ status: 'asc' }, { receivedAt: 'desc' }],
          take: 50,
          select: {
            id: true, serialNumber: true, status: true, receivedAt: true,
            currentOrderId: true, manufacturerRef: true,
            lot: { select: { id: true, lotNumber: true } },
          },
        }),
        serialCounts: await prisma.serialNumber.groupBy({
          by: ['status'],
          where: { productId },
          _count: { _all: true },
        }).then((rows: Array<{ status: string; _count: { _all: number } }>) => Object.fromEntries(rows.map((r) => [r.status, r._count._all]))),
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/product/:id] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── GET /api/stock/transfers ────────────────────────────────────
  // S.13 — surface completed inter-location transfers as a list.
  // Each transfer shows up in StockMovement as a pair: TRANSFER_OUT
  // at the source + TRANSFER_IN at the destination, linked via the
  // IN row's referenceId pointing at the OUT row's id (set by
  // stock-level.service.transferStock). We collapse the pair so each
  // transfer renders as a single row with from/to/quantity/timestamps.
  fastify.get('/stock/transfers', async (request, reply) => {
    try {
      const q = request.query as any
      const limit = Math.min(200, Math.max(1, Math.floor(safeNum(q.limit, 100) ?? 100)))

      // Pull TRANSFER_IN rows (the canonical "destination" event); each
      // referenceId points at its paired OUT. Joining lets us return
      // both sides in one row to the client. Ordering by createdAt DESC
      // surfaces the most recent transfers first.
      const inRows = await prisma.stockMovement.findMany({
        where: { reason: 'TRANSFER_IN' as any },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          productId: true,
          change: true,
          createdAt: true,
          actor: true,
          notes: true,
          referenceId: true,
          fromLocationId: true,
          toLocationId: true,
          fromLocation: { select: { id: true, code: true, name: true, type: true } },
          toLocation:   { select: { id: true, code: true, name: true, type: true } },
        },
      })

      // Resolve sibling OUT rows + product info in two batched queries.
      const outIds = inRows.map((r) => r.referenceId).filter((v): v is string => !!v)
      const productIds = Array.from(new Set(inRows.map((r) => r.productId)))
      const [outRows, products] = await Promise.all([
        outIds.length === 0
          ? Promise.resolve([])
          : prisma.stockMovement.findMany({
              where: { id: { in: outIds } },
              select: { id: true, createdAt: true, actor: true, change: true },
            }),
        prisma.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, sku: true, name: true, amazonAsin: true,
            images: { select: { url: true }, take: 1 } },
        }),
      ])
      const outById = new Map(outRows.map((r) => [r.id, r]))
      const productById = new Map(products.map((p) => [p.id, p]))

      const transfers = inRows.map((r) => {
        const sibling = r.referenceId ? outById.get(r.referenceId) : null
        const p = productById.get(r.productId)
        return {
          id: r.id,
          siblingOutId: r.referenceId ?? null,
          quantity: r.change,
          createdAt: r.createdAt,
          startedAt: sibling?.createdAt ?? r.createdAt,
          actor: r.actor ?? sibling?.actor ?? null,
          notes: r.notes,
          from: r.fromLocation,
          to: r.toLocation ?? null,
          product: p ? {
            id: p.id, sku: p.sku, name: p.name, amazonAsin: p.amazonAsin,
            thumbnailUrl: p.images?.[0]?.url ?? null,
          } : null,
          // Status today is always COMPLETED — transferStock fires both
          // halves synchronously. A future TransferShipment table would
          // add IN_TRANSIT state; the API shape is forward-compatible.
          status: 'COMPLETED' as const,
        }
      })

      return { transfers, count: transfers.length }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/transfers] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── GET /api/stock/reservations ─────────────────────────────────
  // S.13 — surface every StockReservation row (active + settled) so
  // operators can see the full lifecycle without drilling into a
  // product drawer first. Status filter:
  //   active    — releasedAt IS NULL AND consumedAt IS NULL
  //   consumed  — consumedAt IS NOT NULL
  //   released  — releasedAt IS NOT NULL
  //   all       — no filter (default)
  // Each row includes StockLevel.location + Product so the table can
  // render SKU, location code, and stock context in one query.
  fastify.get('/stock/reservations', async (request, reply) => {
    try {
      const q = request.query as any
      const status = (q.status as string | undefined) ?? 'all'
      const limit = Math.min(200, Math.max(1, Math.floor(safeNum(q.limit, 100) ?? 100)))

      const where: any = {}
      if (status === 'active') {
        where.releasedAt = null
        where.consumedAt = null
      } else if (status === 'consumed') {
        where.consumedAt = { not: null }
      } else if (status === 'released') {
        where.releasedAt = { not: null }
      }

      const [rows, productMap] = await Promise.all([
        prisma.stockReservation.findMany({
          where,
          orderBy: [{ consumedAt: 'desc' }, { releasedAt: 'desc' }, { createdAt: 'desc' }],
          take: limit,
          include: {
            stockLevel: {
              select: {
                productId: true,
                quantity: true,
                reserved: true,
                available: true,
                location: { select: { id: true, code: true, name: true, type: true } },
              },
            },
          },
        }),
        // Product join is separate because StockReservation has no
        // direct relation to Product — it goes via StockLevel. Doing a
        // batched findMany keeps the per-row work cheap.
        Promise.resolve(null),
      ])

      const productIds = Array.from(new Set(rows.map((r) => r.stockLevel.productId)))
      const products = productIds.length === 0
        ? []
        : await prisma.product.findMany({
            where: { id: { in: productIds } },
            select: {
              id: true, sku: true, name: true, amazonAsin: true,
              images: { select: { url: true }, take: 1 },
            },
          })
      const productById = new Map(products.map((p) => [p.id, p]))

      const now = new Date()
      const reservations = rows.map((r) => {
        const p = productById.get(r.stockLevel.productId)
        const live = r.releasedAt == null && r.consumedAt == null
        const expired = live && r.expiresAt < now
        const ttlMs = live ? r.expiresAt.getTime() - now.getTime() : null
        return {
          id: r.id,
          quantity: r.quantity,
          reason: r.reason,
          orderId: r.orderId,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
          releasedAt: r.releasedAt,
          consumedAt: r.consumedAt,
          status: r.consumedAt
            ? 'consumed' as const
            : r.releasedAt
              ? 'released' as const
              : expired
                ? 'expired' as const
                : 'active' as const,
          ttlMs,
          location: r.stockLevel.location,
          stockLevel: {
            quantity: r.stockLevel.quantity,
            reserved: r.stockLevel.reserved,
            available: r.stockLevel.available,
          },
          product: p ? {
            id: p.id, sku: p.sku, name: p.name, amazonAsin: p.amazonAsin,
            thumbnailUrl: p.images?.[0]?.url ?? null,
          } : null,
        }
      })

      return { reservations, count: reservations.length, status }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/reservations] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── GET /api/stock/analytics/turnover ───────────────────────────
  // S.14 — stock turnover ratio + Days-of-Inventory (DoH).
  //
  // Definitions (industry standard):
  //   COGS over period   = Σ (unitsSold × costPrice) per product, summed
  //   Avg inventory value = (current totalStock × costPrice) — single
  //                         snapshot today (we don't yet track historical
  //                         StockLevel snapshots; would refine to
  //                         (begin + end) / 2 once we do)
  //   Turnover ratio     = COGS / Avg inventory value, annualized
  //                      = (cogsInWindow / windowDays) × 365 / avgInvValue
  //   Days of Inventory  = 365 / turnoverRatio
  //                      ≈ avgInvValue × windowDays / cogsInWindow
  //
  // Per-product rows return null for turnover/DoH when avg inventory
  // is zero (can't divide) or COGS is zero (not selling — DoH is
  // effectively infinite).
  //
  // Sales window default 30 days; supports 7/30/60/90/180/365 via
  // `days` query param. Cap at 365 to keep DailySalesAggregate scans
  // bounded.
  fastify.get('/stock/analytics/turnover', async (request, reply) => {
    try {
      const q = request.query as any
      const requestedDays = safeNum(q.days, 30) ?? 30
      const days = Math.min(365, Math.max(1, Math.floor(requestedDays)))
      const windowStart = new Date()
      windowStart.setUTCDate(windowStart.getUTCDate() - days)
      windowStart.setUTCHours(0, 0, 0, 0)

      // Pull every buyable + their cost. Variants would inflate this
      // count; we keep `isParent=false` matching how /api/stock works.
      const products = await prisma.product.findMany({
        where: { isParent: false },
        select: {
          id: true, sku: true, name: true, amazonAsin: true,
          totalStock: true, costPrice: true,
          images: { select: { url: true }, take: 1 },
        },
      })

      const skus = products.map((p) => p.sku)
      const sales = skus.length === 0
        ? []
        : await prisma.dailySalesAggregate.findMany({
            where: {
              sku: { in: skus },
              day: { gte: windowStart },
            },
            select: { sku: true, channel: true, marketplace: true,
              unitsSold: true, grossRevenue: true, ordersCount: true },
          })

      // Index sales by SKU for the per-product roll-up.
      const salesBySku = new Map<string, { units: number; revenueCents: number }>()
      const salesByChannel = new Map<string, { channel: string; marketplace: string; units: number; revenueCents: number; orders: number }>()
      for (const s of sales) {
        const cur = salesBySku.get(s.sku) ?? { units: 0, revenueCents: 0 }
        cur.units += s.unitsSold
        cur.revenueCents += Math.round(Number(s.grossRevenue) * 100)
        salesBySku.set(s.sku, cur)
        const channelKey = `${s.channel}_${s.marketplace}`
        const ch = salesByChannel.get(channelKey) ?? {
          channel: s.channel, marketplace: s.marketplace,
          units: 0, revenueCents: 0, orders: 0,
        }
        ch.units += s.unitsSold
        ch.revenueCents += Math.round(Number(s.grossRevenue) * 100)
        ch.orders += s.ordersCount
        salesByChannel.set(channelKey, ch)
      }

      // Per-product roll-up. cogsCents = unitsSold × costPrice (in cents).
      // avgInventoryValueCents = current totalStock × costPrice. Single
      // snapshot today; future commits can refine with begin/end avg.
      let totalUnitsSold = 0
      let totalCogsCents = 0
      let totalCurrentInvValueCents = 0
      const byProduct = products.map((p) => {
        const sale = salesBySku.get(p.sku) ?? { units: 0, revenueCents: 0 }
        const costCents = p.costPrice == null ? 0 : Math.round(Number(p.costPrice) * 100)
        const cogsCents = sale.units * costCents
        const currentInvValueCents = p.totalStock * costCents
        totalUnitsSold += sale.units
        totalCogsCents += cogsCents
        totalCurrentInvValueCents += currentInvValueCents

        const turnoverRatio = currentInvValueCents > 0
          ? (cogsCents / days) * 365 / currentInvValueCents
          : null
        const daysOfInventory = (turnoverRatio != null && turnoverRatio > 0)
          ? 365 / turnoverRatio
          : (sale.units > 0 ? null : Infinity)

        return {
          productId: p.id,
          sku: p.sku,
          name: p.name,
          amazonAsin: p.amazonAsin,
          thumbnailUrl: p.images?.[0]?.url ?? null,
          unitsSold: sale.units,
          revenueCents: sale.revenueCents,
          costPriceCents: costCents,
          totalStock: p.totalStock,
          currentInventoryValueCents: currentInvValueCents,
          cogsCents,
          turnoverRatio: turnoverRatio == null ? null : Math.round(turnoverRatio * 100) / 100,
          // Cap reported DoH at 9999 so the UI doesn't render Infinity.
          daysOfInventory: daysOfInventory == null
            ? null
            : daysOfInventory === Infinity
              ? null
              : Math.min(9999, Math.round(daysOfInventory)),
        }
      })

      // Overall numbers across the catalog.
      const overallTurnoverRatio = totalCurrentInvValueCents > 0
        ? (totalCogsCents / days) * 365 / totalCurrentInvValueCents
        : null
      const overallDoh = (overallTurnoverRatio != null && overallTurnoverRatio > 0)
        ? Math.min(9999, Math.round(365 / overallTurnoverRatio))
        : null

      return {
        windowDays: days,
        windowStart: windowStart.toISOString(),
        overall: {
          unitsSold: totalUnitsSold,
          cogsCents: totalCogsCents,
          currentInventoryValueCents: totalCurrentInvValueCents,
          turnoverRatio: overallTurnoverRatio == null ? null : Math.round(overallTurnoverRatio * 100) / 100,
          daysOfInventory: overallDoh,
          productsTracked: products.length,
        },
        byProduct,
        byChannel: Array.from(salesByChannel.values()).sort((a, b) => b.units - a.units),
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/analytics/turnover] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── GET /api/stock/analytics/eoq ─────────────────────────────────
  // S.19 — Economic Order Quantity (EOQ) + Reorder Point (ROP)
  // recommendations per StockLevel. The classical Wilson formula:
  //
  //   EOQ = sqrt( 2 × annualDemand × orderCost / annualHoldingCost )
  //   ROP = leadTimeDays × dailyDemand + safetyStock
  //   safetyStock = Z × σ_demand × sqrt(leadTimeDays)
  //
  // Inputs sourced as follows:
  //   annualDemand   = (unitsSold in window) × 365 / windowDays
  //   orderCost      = Product.orderingCostCents (fallback €25)
  //   holdingCost    = costPrice × Product.carryingCostPctYear
  //                    (fallback 25% per year, industry common)
  //   leadTimeDays   = Product.leadTimeDays fallback 14d (DEFAULT_LEAD_TIME_DAYS)
  //   serviceLevel   = Product.serviceLevelPercent (fallback 95%)
  //                    Z-score: 90%=1.28, 95%=1.65, 97.5%=1.96, 99%=2.33
  //
  // Returns per-product current StockLevel.reorderThreshold +
  // StockLevel.reorderQuantity alongside the recommendation, so the
  // operator can see what would change at a glance.
  fastify.get('/stock/analytics/eoq', async (request, reply) => {
    try {
      const q = request.query as any
      const days = Math.min(365, Math.max(7, Math.floor(safeNum(q.days, 90) ?? 90)))
      const cutoff = new Date()
      cutoff.setUTCDate(cutoff.getUTCDate() - days)

      // Pull all StockLevel rows + their product cost / cost params.
      const levels = await prisma.stockLevel.findMany({
        include: {
          product: {
            select: {
              id: true, sku: true, name: true, amazonAsin: true,
              costPrice: true,
              orderingCostCents: true,
              carryingCostPctYear: true,
              serviceLevelPercent: true,
              // leadTimeDays lives on Supplier (per supplier-product
              // relationship), not Product. The atp.service has the
              // resolution chain; here we use a flat default and let
              // operators tune via Product overrides later.
              images: { select: { url: true }, take: 1 },
            },
          },
          location: { select: { id: true, code: true, name: true, type: true } },
        },
      })
      if (levels.length === 0) {
        return { windowDays: days, recommendations: [], generatedAt: new Date() }
      }

      // Sales aggregate keyed by SKU for the window. Single query.
      const skus = Array.from(new Set(levels.map((l) => l.product.sku)))
      const sales = await prisma.dailySalesAggregate.findMany({
        where: { sku: { in: skus }, day: { gte: cutoff } },
        select: { sku: true, day: true, unitsSold: true },
      })
      // Per-SKU: total units + per-day map (for σ).
      const totalBySku = new Map<string, number>()
      const perDayBySku = new Map<string, Map<string, number>>()
      for (const s of sales) {
        totalBySku.set(s.sku, (totalBySku.get(s.sku) ?? 0) + s.unitsSold)
        if (!perDayBySku.has(s.sku)) perDayBySku.set(s.sku, new Map())
        const dayKey = s.day.toISOString().slice(0, 10)
        const m = perDayBySku.get(s.sku)!
        m.set(dayKey, (m.get(dayKey) ?? 0) + s.unitsSold)
      }

      // Z-score from service level (linear interp for the standard
      // 90/95/97.5/99 levels; clamp outside).
      function zFromServiceLevel(pct: number): number {
        if (pct <= 90) return 1.28
        if (pct <= 95) return 1.65
        if (pct <= 97.5) return 1.96
        return 2.33
      }

      const DEFAULT_ORDER_COST_CENTS = 2500       // €25 per PO
      const DEFAULT_CARRYING_PCT = 0.25            // 25% per year
      const DEFAULT_SERVICE_LEVEL = 95
      const DEFAULT_LEAD_TIME = 14

      const recommendations = levels.map((sl) => {
        const p = sl.product
        const totalUnits = totalBySku.get(p.sku) ?? 0
        const annualDemand = totalUnits === 0 ? 0 : (totalUnits * 365) / days
        const dailyDemand = totalUnits / days
        const costCents = p.costPrice == null ? 0 : Math.round(Number(p.costPrice) * 100)
        const orderCostCents = p.orderingCostCents ?? DEFAULT_ORDER_COST_CENTS
        const carryingPct = p.carryingCostPctYear == null
          ? DEFAULT_CARRYING_PCT
          : Number(p.carryingCostPctYear) / 100
        const annualHoldingCostCents = costCents * carryingPct
        const leadTimeDays = DEFAULT_LEAD_TIME
        const serviceLevel = p.serviceLevelPercent == null
          ? DEFAULT_SERVICE_LEVEL
          : Number(p.serviceLevelPercent)
        const z = zFromServiceLevel(serviceLevel)

        // EOQ — only meaningful when we have demand AND holding cost.
        let recommendedEoq: number | null = null
        if (annualDemand > 0 && annualHoldingCostCents > 0) {
          const eoq = Math.sqrt((2 * annualDemand * orderCostCents) / annualHoldingCostCents)
          recommendedEoq = Math.max(1, Math.round(eoq))
        }

        // σ_demand: stddev of daily units. With sparse aggregates we
        // approximate σ via simple variance over the window. Days
        // with no sales count as 0 (correct: no sale = no demand).
        let stddev = 0
        if (totalUnits > 0) {
          const days_ = perDayBySku.get(p.sku) ?? new Map()
          const mean = dailyDemand
          let acc = 0
          // Walk the entire window length, defaulting missing days to 0
          for (let i = 0; i < days; i++) {
            const d = new Date(cutoff)
            d.setUTCDate(d.getUTCDate() + i)
            const key = d.toISOString().slice(0, 10)
            const u = days_.get(key) ?? 0
            acc += (u - mean) ** 2
          }
          stddev = Math.sqrt(acc / days)
        }
        const safetyStock = totalUnits > 0
          ? Math.ceil(z * stddev * Math.sqrt(leadTimeDays))
          : 0
        const recommendedRop = totalUnits > 0
          ? Math.ceil(leadTimeDays * dailyDemand + safetyStock)
          : null

        return {
          stockLevelId: sl.id,
          productId: p.id,
          sku: p.sku,
          name: p.name,
          amazonAsin: p.amazonAsin,
          thumbnailUrl: p.images?.[0]?.url ?? null,
          location: sl.location,
          currentQuantity: sl.quantity,
          currentReorderThreshold: sl.reorderThreshold,
          currentReorderQuantity: sl.reorderQuantity,
          inputs: {
            unitsSoldInWindow: totalUnits,
            annualDemand: Math.round(annualDemand * 100) / 100,
            dailyDemand: Math.round(dailyDemand * 1000) / 1000,
            costCents,
            orderCostCents,
            carryingPct,
            annualHoldingCostCents: Math.round(annualHoldingCostCents),
            leadTimeDays,
            serviceLevel,
            z,
            stddev: Math.round(stddev * 100) / 100,
          },
          recommendation: {
            eoq: recommendedEoq,
            rop: recommendedRop,
            safetyStock,
          },
        }
      })

      // Sort: gap-from-recommendation first (rows where current
      // setting is most off get attention), with no-recommendation
      // rows sinking to the bottom.
      recommendations.sort((a, b) => {
        const ag = a.recommendation.rop != null && a.currentReorderThreshold != null
          ? Math.abs(a.recommendation.rop - a.currentReorderThreshold)
          : -1
        const bg = b.recommendation.rop != null && b.currentReorderThreshold != null
          ? Math.abs(b.recommendation.rop - b.currentReorderThreshold)
          : -1
        return bg - ag
      })

      return { windowDays: days, generatedAt: new Date(), recommendations }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/analytics/eoq] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── POST /api/stock/analytics/eoq/apply ─────────────────────────
  // S.19 — apply a recommendation back to the StockLevel row
  // (reorderThreshold + reorderQuantity). Body is an array so the
  // operator can apply multiple rows at once. No StockMovement is
  // emitted; threshold updates aren't quantity changes.
  fastify.post<{
    Body: { items: Array<{ stockLevelId: string; reorderThreshold?: number | null; reorderQuantity?: number | null }> }
  }>('/stock/analytics/eoq/apply', async (request, reply) => {
    try {
      const items = request.body?.items ?? []
      if (!Array.isArray(items) || items.length === 0) {
        return reply.code(400).send({ error: 'items required (non-empty array)' })
      }
      let applied = 0
      const errors: Array<{ stockLevelId: string; error: string }> = []
      for (const it of items) {
        try {
          const data: any = {}
          if (it.reorderThreshold !== undefined) {
            const v = it.reorderThreshold
            if (v !== null && (!Number.isFinite(Number(v)) || Number(v) < 0)) {
              throw new Error('reorderThreshold must be null or a non-negative integer')
            }
            data.reorderThreshold = v === null ? null : Math.floor(Number(v))
          }
          if (it.reorderQuantity !== undefined) {
            const v = it.reorderQuantity
            if (v !== null && (!Number.isFinite(Number(v)) || Number(v) < 0)) {
              throw new Error('reorderQuantity must be null or a non-negative integer')
            }
            data.reorderQuantity = v === null ? null : Math.floor(Number(v))
          }
          if (Object.keys(data).length === 0) continue
          await prisma.stockLevel.update({ where: { id: it.stockLevelId }, data })
          applied++
        } catch (err: any) {
          errors.push({ stockLevelId: it.stockLevelId, error: err?.message ?? String(err) })
        }
      }
      return { applied, requested: items.length, errors }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/analytics/eoq/apply] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── GET /api/stock/analytics/abc ─────────────────────────────────
  // S.16 — read the materialized ABC snapshot. Cheap because the
  // recompute happens weekly via the abc-classification cron; this
  // endpoint just reads Product.abcClass for the band counts +
  // returns top-N samples per band for the analytics card.
  fastify.get('/stock/analytics/abc', async (_request, reply) => {
    try {
      const snapshot = await abcService.getSnapshot({ perBandLimit: 10 })
      return snapshot
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/analytics/abc] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── POST /api/stock/analytics/abc/recompute ──────────────────────
  // S.16 — force a full recompute. Useful in development and during
  // catalog migrations; production normally relies on the weekly cron.
  fastify.post('/stock/analytics/abc/recompute', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        windowDays?: number
        metric?: 'revenue' | 'units' | 'margin'
        bandA?: number
        bandB?: number
      }
      const result = await abcService.recompute(body)
      return result
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/analytics/abc/recompute] failed')
      return reply.code(400).send({ error: error?.message ?? String(error) })
    }
  })

  // ── GET /api/stock/analytics/dead-stock ─────────────────────────
  // S.15 — dead-stock + slow-moving identification.
  //
  // Two thresholds:
  //   `days`  — products with *no* operator-driven StockMovement in
  //             the last N days qualify as dead stock. Default 90.
  //   `slow`  — products with movements but unitsSold/day below this
  //             velocity over the same window are slow-moving.
  //
  // We exclude migration-only reasons (PARENT_PRODUCT_CLEANUP,
  // STOCKLEVEL_BACKFILL, SYNC_RECONCILIATION) when checking for
  // "movement" — backfills don't represent operator activity, and
  // the FBA reconciliation cron writes a row even when nothing
  // physically moved. Counting them would mask actual deadness.
  //
  // Returns SKUs with totalStock > 0 only — zero-stock isn't
  // "dead stock", it's just absent inventory.
  fastify.get('/stock/analytics/dead-stock', async (request, reply) => {
    try {
      const q = request.query as any
      const days = Math.min(365, Math.max(7, Math.floor(safeNum(q.days, 90) ?? 90)))
      const slowVelocity = Math.max(0, safeNum(q.slow, 0.1) ?? 0.1)

      const cutoff = new Date()
      cutoff.setUTCDate(cutoff.getUTCDate() - days)

      // Products with positive stock — only candidates for dead/slow.
      const products = await prisma.product.findMany({
        where: { isParent: false, totalStock: { gt: 0 } },
        select: {
          id: true, sku: true, name: true, amazonAsin: true,
          totalStock: true, costPrice: true,
          images: { select: { url: true }, take: 1 },
        },
      })
      if (products.length === 0) {
        return { windowDays: days, slowVelocityThreshold: slowVelocity, dead: [], slow: [] }
      }
      const productIds = products.map((p) => p.id)

      // Last *operator-driven* movement per product. groupBy with max
      // would be cleaner but Prisma doesn't accept WHERE on groupBy
      // easily for the reason filter; do a findMany then reduce.
      const movements = await prisma.stockMovement.findMany({
        where: {
          productId: { in: productIds },
          reason: {
            notIn: ['PARENT_PRODUCT_CLEANUP', 'STOCKLEVEL_BACKFILL', 'SYNC_RECONCILIATION'] as any,
          },
        },
        orderBy: { createdAt: 'desc' },
        select: { productId: true, createdAt: true, reason: true },
      })
      const lastMovementByProduct = new Map<string, { createdAt: Date; reason: string }>()
      for (const m of movements) {
        if (!lastMovementByProduct.has(m.productId)) {
          lastMovementByProduct.set(m.productId, { createdAt: m.createdAt, reason: m.reason })
        }
      }

      // Sales over the window — used to label SLOW vs DEAD when
      // movement exists but velocity is low.
      const skus = products.map((p) => p.sku)
      const sales = await prisma.dailySalesAggregate.findMany({
        where: { sku: { in: skus }, day: { gte: cutoff } },
        select: { sku: true, unitsSold: true },
      })
      const unitsBySku = new Map<string, number>()
      for (const s of sales) {
        unitsBySku.set(s.sku, (unitsBySku.get(s.sku) ?? 0) + s.unitsSold)
      }

      const dead: any[] = []
      const slow: any[] = []
      const now = Date.now()
      for (const p of products) {
        const last = lastMovementByProduct.get(p.id)
        const lastMs = last ? last.createdAt.getTime() : 0
        const daysSince = last ? Math.floor((now - lastMs) / 86400000) : null
        const costCents = p.costPrice == null ? 0 : Math.round(Number(p.costPrice) * 100)
        const valueAtRiskCents = p.totalStock * costCents
        const unitsSoldInWindow = unitsBySku.get(p.sku) ?? 0
        const dailyVelocity = unitsSoldInWindow / days
        const row = {
          productId: p.id,
          sku: p.sku,
          name: p.name,
          amazonAsin: p.amazonAsin,
          thumbnailUrl: p.images?.[0]?.url ?? null,
          totalStock: p.totalStock,
          costPriceCents: costCents,
          valueAtRiskCents,
          unitsSoldInWindow,
          dailyVelocity: Math.round(dailyVelocity * 1000) / 1000,
          daysSinceLastMovement: daysSince,
          lastMovementReason: last?.reason ?? null,
        }
        // DEAD: no operator-driven movement in window. lastMs===0
        // covers products that have never had a movement (e.g.
        // initial seed). daysSince > days means past the threshold.
        if (last == null || daysSince! >= days) {
          dead.push(row)
        } else if (dailyVelocity < slowVelocity) {
          slow.push(row)
        }
      }

      // Sort by value at risk (biggest hit first); ties by days-since.
      dead.sort((a, b) => b.valueAtRiskCents - a.valueAtRiskCents
        || (b.daysSinceLastMovement ?? 9999) - (a.daysSinceLastMovement ?? 9999))
      slow.sort((a, b) => b.valueAtRiskCents - a.valueAtRiskCents
        || a.dailyVelocity - b.dailyVelocity)

      return {
        windowDays: days,
        slowVelocityThreshold: slowVelocity,
        dead,
        slow,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/analytics/dead-stock] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── GET /api/stock/year-end-valuation ────────────────────────────
  // T.8 — Italian "rimanenze finali" closing-stock valuation.
  //
  // Returns the inventory value at a point in time, broken down by:
  //   - location (Riccione / FBA / others)
  //   - costing method (FIFO / LIFO / WAC) per Codice Civile Art. 2426
  //   - currency mix (T.6: EUR-equivalent vs original currency)
  //   - VAT treatment (T.7: net vs gross capitalised)
  //
  // Source: open StockCostLayer rows (unitsRemaining > 0) joined to
  // their products. Each layer's contribution is unitsRemaining ×
  // unitCost, converted to EUR-net at exchangeRateOnReceive.
  //
  // Limitations (documented for the accountant):
  //   - asOf=now is the only supported point-in-time today; historical
  //     reconstruction requires replaying StockMovement consumes back
  //     from `now` to `asOf`. Tracked as a follow-up: a
  //     YearEndSnapshot table materialised by a Dec-31 cron will give
  //     true year-end fixity.
  //   - Layers without exchangeRateOnReceive (legacy EUR-only rows)
  //     are reported in EUR at face value — same behaviour as before
  //     T.6, no regression.
  //   - vatRate when null is treated as "unknown VAT" and reported
  //     in the `unknownVat` bucket so the accountant can reconcile.
  //
  // Query params:
  //   year (optional, defaults to current year — informational label)
  //   locationId (optional, filter to one location)
  fastify.get('/stock/year-end-valuation', async (request, reply) => {
    try {
      const q = request.query as any
      const currentYear = new Date().getUTCFullYear()
      const year = Math.floor(safeNum(q.year, currentYear) ?? currentYear)
      const locationFilter = typeof q.locationId === 'string' && q.locationId.length > 0
        ? q.locationId
        : null

      // T.8 part 2 — when the operator queries a closed year, prefer
      // the persisted snapshot (point-in-time fixity for tax filings).
      // Fall back to live compute only when no snapshot exists.
      // Location filter forces live compute since snapshots are
      // captured at the all-locations level.
      if (year < currentYear && !locationFilter) {
        const snapshot = await readYearEndSnapshot(year)
        if (snapshot) return snapshot
      }

      const live = await computeYearEndValuation({
        year,
        asOf: new Date(),
        locationId: locationFilter ?? undefined,
      })
      return live
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/year-end-valuation] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── POST /api/stock/year-end-valuation/snapshot ──────────────────
  // T.8 part 2 — manual trigger for the year-end snapshot. Body:
  //   { year: number, notes?: string }
  // Idempotent: re-running for the same year overwrites the prior
  // snapshot (snapshotAt updates, asOf stays Dec 31 23:59:59 UTC of
  // the year). Operators use this to backfill missed years or to
  // refresh a snapshot after a late ECB rate correction.
  fastify.post<{
    Body: { year?: number; notes?: string | null }
  }>('/stock/year-end-valuation/snapshot', async (request, reply) => {
    try {
      const body = request.body ?? {}
      const currentYear = new Date().getUTCFullYear()
      const year = Math.floor(safeNum(body.year, currentYear) ?? currentYear)
      if (!Number.isFinite(year) || year < 2000 || year > currentYear + 1) {
        return reply.code(400).send({ error: `year must be in [2000, ${currentYear + 1}]` })
      }
      const result = await snapshotYearEndValuation(year, { notes: body.notes ?? null })
      return result
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/year-end-valuation/snapshot] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── GET /api/stock/lots ──────────────────────────────────────────
  // L.3 — list lots. Filters:
  //   productId (string)        — restrict to one product
  //   expiringWithinDays (int)  — only lots with expiresAt within N days
  //   activeOnly (bool, default true) — unitsRemaining > 0
  //   limit (int, default 100, max 500)
  // Returns lots in (expiresAt ASC NULLS LAST, receivedAt ASC) order.
  fastify.get('/stock/lots', async (request, reply) => {
    try {
      const q = request.query as any
      const productId = typeof q.productId === 'string' ? q.productId : undefined
      const expiringWithinDays = q.expiringWithinDays != null
        ? Math.max(0, Math.min(3650, Math.floor(safeNum(q.expiringWithinDays, 0) ?? 0)))
        : null
      const activeOnly = q.activeOnly !== '0' && q.activeOnly !== 'false'
      const limit = Math.min(500, Math.max(1, Math.floor(safeNum(q.limit, 100) ?? 100)))

      const where: any = {}
      if (productId) where.productId = productId
      if (activeOnly) where.unitsRemaining = { gt: 0 }
      if (expiringWithinDays != null) {
        const cutoff = new Date(Date.now() + expiringWithinDays * 86400_000)
        where.expiresAt = { not: null, lte: cutoff }
      }

      const lots = await prisma.lot.findMany({
        where,
        orderBy: [{ expiresAt: 'asc' }, { receivedAt: 'asc' }],
        take: limit,
        include: {
          product: { select: { id: true, sku: true, name: true, amazonAsin: true } },
          variation: { select: { id: true, sku: true } },
        },
      })
      return { items: lots, total: lots.length, limit }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/lots] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── GET /api/stock/lots/:id/trace ────────────────────────────────
  // L.3 — full forward + backward trace for a single lot. Drives the
  // recall workflow's affected-orders report.
  //   direction=forward|backward|both (default 'both')
  fastify.get<{
    Params: { id: string }
    Querystring: { direction?: 'forward' | 'backward' | 'both' }
  }>('/stock/lots/:id/trace', async (request, reply) => {
    try {
      const { id } = request.params
      const direction = request.query.direction ?? 'both'
      const result: any = { lotId: id }
      if (direction === 'forward' || direction === 'both') {
        result.forward = await traceLotForward(id)
      }
      if (direction === 'backward' || direction === 'both') {
        result.backward = await traceLotBackward(id)
      }
      if (!result.forward && !result.backward) {
        return reply.code(404).send({ error: 'Lot not found' })
      }
      return result
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/lots/:id/trace] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── POST /api/stock/lots ─────────────────────────────────────────
  // L.3 — manual lot creation. Inbound-receive endpoints already pass
  // lot info to createLot directly; this endpoint covers backfill /
  // standalone receives the operator records by hand.
  fastify.post<{
    Body: {
      productId: string
      variationId?: string | null
      lotNumber: string
      unitsReceived: number
      receivedAt?: string
      expiresAt?: string | null
      originPoId?: string | null
      originInboundShipmentId?: string | null
      supplierLotRef?: string | null
      notes?: string | null
    }
  }>('/stock/lots', async (request, reply) => {
    try {
      const b = request.body
      if (!b?.productId || !b?.lotNumber?.trim() || !(b.unitsReceived > 0)) {
        return reply.code(400).send({ error: 'productId, lotNumber, unitsReceived (>0) are required' })
      }
      const lot = await createLot({
        productId: b.productId,
        variationId: b.variationId ?? null,
        lotNumber: b.lotNumber,
        unitsReceived: b.unitsReceived,
        receivedAt: b.receivedAt ? new Date(b.receivedAt) : undefined,
        expiresAt: b.expiresAt ? new Date(b.expiresAt) : null,
        originPoId: b.originPoId ?? null,
        originInboundShipmentId: b.originInboundShipmentId ?? null,
        supplierLotRef: b.supplierLotRef ?? null,
        notes: b.notes ?? null,
      })
      return lot
    } catch (error: any) {
      // Unique violation = lotNumber already exists for this product.
      if (error?.code === 'P2002') {
        return reply.code(409).send({ error: `Lot number already exists for this product` })
      }
      fastify.log.error({ err: error }, '[stock/lots POST] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── GET /api/stock/serials ───────────────────────────────────────
  // SR.3 — list with filters: productId, status, lotId, locationId, search
  fastify.get('/stock/serials', async (request, reply) => {
    try {
      const q = request.query as any
      const limit = Math.min(500, Math.max(1, Math.floor(safeNum(q.limit, 100) ?? 100)))
      const where: any = {}
      if (typeof q.productId === 'string') where.productId = q.productId
      if (typeof q.status === 'string' && q.status !== 'ALL') where.status = q.status
      if (typeof q.lotId === 'string') where.lotId = q.lotId
      if (typeof q.locationId === 'string') where.locationId = q.locationId
      if (typeof q.search === 'string' && q.search.trim()) {
        where.serialNumber = { contains: q.search.trim(), mode: 'insensitive' }
      }
      const items = await prisma.serialNumber.findMany({
        where, take: limit,
        orderBy: [{ status: 'asc' }, { receivedAt: 'desc' }],
        include: {
          product: { select: { id: true, sku: true, name: true } },
          lot: { select: { id: true, lotNumber: true } },
          location: { select: { id: true, code: true, name: true } },
        },
      })
      return { items, total: items.length, limit }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/serials] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.get<{ Params: { id: string } }>('/stock/serials/:id/trace', async (request, reply) => {
    try {
      const trace = await traceSerial(request.params.id)
      if (!trace) return reply.code(404).send({ error: 'Serial not found' })
      return trace
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/serials/:id/trace] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post<{
    Body: {
      productId: string
      variationId?: string | null
      serialNumber?: string
      serialNumbers?: string[]
      lotId?: string | null
      locationId?: string | null
      manufacturerRef?: string | null
      notes?: string | null
    }
  }>('/stock/serials', async (request, reply) => {
    try {
      const b = request.body
      if (!b?.productId) return reply.code(400).send({ error: 'productId required' })

      // Bulk path: array of serials in one call (typical at receive)
      if (b.serialNumbers && Array.isArray(b.serialNumbers)) {
        if (b.serialNumbers.length === 0) {
          return reply.code(400).send({ error: 'serialNumbers cannot be empty' })
        }
        const r = await bulkCreateSerials({
          productId: b.productId,
          variationId: b.variationId ?? null,
          serialNumbers: b.serialNumbers,
          lotId: b.lotId ?? null,
          locationId: b.locationId ?? null,
          manufacturerRef: b.manufacturerRef ?? null,
        })
        return r
      }

      // Single path
      if (!b.serialNumber?.trim()) {
        return reply.code(400).send({ error: 'serialNumber or serialNumbers required' })
      }
      const created = await createSerial({
        productId: b.productId,
        variationId: b.variationId ?? null,
        serialNumber: b.serialNumber,
        lotId: b.lotId ?? null,
        locationId: b.locationId ?? null,
        manufacturerRef: b.manufacturerRef ?? null,
        notes: b.notes ?? null,
      })
      return created
    } catch (error: any) {
      if (error?.code === 'P2002') {
        return reply.code(409).send({ error: 'Serial number already exists for this product' })
      }
      fastify.log.error({ err: error }, '[stock/serials POST] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post<{
    Params: { id: string }
    Body: { action: 'reserve' | 'ship' | 'return' | 'restore' | 'dispose'; orderId?: string; shipmentId?: string; returnId?: string; notes?: string }
  }>('/stock/serials/:id/transition', async (request, reply) => {
    try {
      const { action, ...args } = request.body
      let result
      switch (action) {
        case 'reserve': result = await reserveSerial(request.params.id, args); break
        case 'ship': result = await shipSerial(request.params.id, args); break
        case 'return': result = await returnSerial(request.params.id, args); break
        case 'restore': result = await restoreSerial(request.params.id); break
        case 'dispose': result = await disposeSerial(request.params.id, args); break
        default:
          return reply.code(400).send({ error: `Unknown action: ${action}` })
      }
      return result
    } catch (error: any) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('not found')) return reply.code(404).send({ error: msg })
      if (msg.includes('cannot transition')) return reply.code(409).send({ error: msg })
      fastify.log.error({ err: error }, '[stock/serials/:id/transition] failed')
      return reply.code(500).send({ error: msg })
    }
  })

  // ── GET /api/stock/recalls ───────────────────────────────────────
  // L.4 — list recalls. Defaults to OPEN-only so the dashboard surfaces
  // what needs attention. Pass status=CLOSED for history; status=ALL
  // for everything.
  fastify.get('/stock/recalls', async (request, reply) => {
    try {
      const q = request.query as any
      const statusRaw = typeof q.status === 'string' ? q.status.toUpperCase() : 'OPEN'
      const status = (['OPEN', 'CLOSED', 'ALL'] as const).includes(statusRaw)
        ? (statusRaw as 'OPEN' | 'CLOSED' | 'ALL')
        : 'OPEN'
      const productId = typeof q.productId === 'string' ? q.productId : undefined
      const limit = Math.min(500, Math.max(1, Math.floor(safeNum(q.limit, 100) ?? 100)))
      const items = await listRecalls({ status, productId, limit })
      return { items, total: items.length, limit, status }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/recalls] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── POST /api/stock/recalls ──────────────────────────────────────
  // L.4 — open a recall. Idempotent: if an OPEN recall already exists
  // for the lot, returns it with alreadyOpen=true (HTTP 200, not 409 —
  // the operator's intent succeeded, the recall just predates this call).
  fastify.post<{
    Body: { lotId: string; reason: string; openedBy?: string | null; notes?: string | null }
  }>('/stock/recalls', async (request, reply) => {
    try {
      const b = request.body
      if (!b?.lotId || !b?.reason?.trim()) {
        return reply.code(400).send({ error: 'lotId and reason are required' })
      }
      const lot = await prisma.lot.findUnique({ where: { id: b.lotId }, select: { id: true } })
      if (!lot) return reply.code(404).send({ error: 'Lot not found' })
      const result = await openRecall({
        lotId: b.lotId,
        reason: b.reason,
        openedBy: b.openedBy ?? null,
        notes: b.notes ?? null,
      })
      return result
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/recalls POST] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── GET /api/stock/recalls/:id ───────────────────────────────────
  // L.7 — single recall fetch. Removes the L.6 detail-page workaround
  // that listed all recalls and filtered by id client-side.
  fastify.get<{ Params: { id: string } }>('/stock/recalls/:id', async (request, reply) => {
    try {
      const recall = await getRecall(request.params.id)
      if (!recall) return reply.code(404).send({ error: 'Recall not found' })
      return recall
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/recalls/:id] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── POST /api/stock/recalls/:id/release-reservations ─────────────
  // L.15 — operator-initiated bulk release of every open reservation
  // on the recalled lot's product. Conservative: reservations don't
  // carry lotId so we release all on the product (better to over-
  // release than over-ship potentially-recalled units). Operator
  // confirms before calling.
  fastify.post<{
    Params: { id: string }
    Body: { actor?: string | null }
  }>('/stock/recalls/:id/release-reservations', async (request, reply) => {
    try {
      const result = await releaseReservationsForRecall({
        recallId: request.params.id,
        actor: request.body?.actor ?? null,
      })
      return result
    } catch (error: any) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('not found')) return reply.code(404).send({ error: msg })
      fastify.log.error({ err: error }, '[stock/recalls/:id/release-reservations] failed')
      return reply.code(500).send({ error: msg })
    }
  })

  // ── POST /api/stock/recalls/:id/close ────────────────────────────
  // L.4 — close an open recall. The recalled lot is NOT auto-restocked
  // — the operator decides whether to dispose remaining units, return
  // them to the supplier, or accept them back into the FEFO pool.
  fastify.post<{
    Params: { id: string }
    Body: { closedBy?: string | null; notes?: string | null }
  }>('/stock/recalls/:id/close', async (request, reply) => {
    try {
      const b = request.body ?? {}
      const result = await closeRecall({
        recallId: request.params.id,
        closedBy: b.closedBy ?? null,
        notes: b.notes ?? null,
      })
      return result
    } catch (error: any) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('not found')) return reply.code(404).send({ error: msg })
      fastify.log.error({ err: error }, '[stock/recalls/:id/close] failed')
      return reply.code(500).send({ error: msg })
    }
  })

  // ── GET /api/stock/fba-pan-eu ────────────────────────────────────
  // S.25 — single-shot dashboard read. Returns per-FC totals + top
  // aged sellable + top unfulfillable so the page renders with one
  // fetch.
  fastify.get('/stock/fba-pan-eu', async (_request, reply) => {
    try {
      const snapshot = await getPanEuSnapshot()
      return snapshot
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/fba-pan-eu] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── GET /api/stock/fba-pan-eu/aged ───────────────────────────────
  // S.25 — drill into aged-inventory rows past a configurable
  // threshold. UI default 180 days (LTSF warning band); 365 critical.
  fastify.get('/stock/fba-pan-eu/aged', async (request, reply) => {
    try {
      const q = request.query as any
      const thresholdDays = safeNum(q.days, 180) ?? 180
      const limit = safeNum(q.limit, 100) ?? 100
      const rows = await getAgedInventory({ thresholdDays, limit })
      return { thresholdDays, rows }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/fba-pan-eu/aged] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── GET /api/stock/fba-pan-eu/unfulfillable ─────────────────────
  fastify.get('/stock/fba-pan-eu/unfulfillable', async (request, reply) => {
    try {
      const q = request.query as any
      const limit = safeNum(q.limit, 100) ?? 100
      const rows = await getUnfulfillable({ limit })
      return { rows }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/fba-pan-eu/unfulfillable] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── GET /api/stock/mcf ──────────────────────────────────────────
  // S.24 — list MCF shipments. ?status=active filters to non-terminal
  // rows; ?status=COMPLETE filters to a specific Amazon status.
  fastify.get('/stock/mcf', async (request, reply) => {
    try {
      const q = request.query as { status?: string; limit?: string }
      const limit = q.limit ? Math.min(500, Math.max(1, parseInt(q.limit, 10) || 100)) : 100
      const list = await listMCFShipments({ status: q.status, limit })
      return { shipments: list, status: q.status ?? 'all' }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/mcf] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── POST /api/stock/mcf/create ─────────────────────────────────
  fastify.post<{
    Body: {
      orderId: string
      shippingSpeed?: 'Standard' | 'Expedited' | 'Priority' | 'ScheduledDelivery'
      marketplaceId?: string
      comment?: string
      items?: Array<{ sku: string; quantity: number }>
    }
  }>('/stock/mcf/create', async (request, reply) => {
    try {
      const body = request.body ?? ({} as any)
      if (!body.orderId) return reply.code(400).send({ error: 'orderId required' })
      const adapter = resolveMCFAdapter()
      const r = await createMCFShipment(adapter, body)
      return r
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/mcf/create] failed')
      return reply.code(400).send({ error: error?.message ?? String(error) })
    }
  })

  // ── POST /api/stock/mcf/:id/sync ───────────────────────────────
  // Operator-initiated status pull (cron does the same poll every 15 min).
  fastify.post<{ Params: { id: string } }>('/stock/mcf/:id/sync', async (request, reply) => {
    try {
      const { id } = request.params
      const shipment = await prisma.mCFShipment.findUnique({ where: { id } })
      if (!shipment) return reply.code(404).send({ error: 'shipment not found' })
      const r = await syncMCFStatus(resolveMCFAdapter(), shipment.amazonFulfillmentOrderId)
      return r
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/mcf/:id/sync] failed')
      return reply.code(400).send({ error: error?.message ?? String(error) })
    }
  })

  // ── POST /api/stock/mcf/:id/cancel ─────────────────────────────
  fastify.post<{
    Params: { id: string }
    Body: { reason?: string }
  }>('/stock/mcf/:id/cancel', async (request, reply) => {
    try {
      const { id } = request.params
      const reason = request.body?.reason
      const shipment = await prisma.mCFShipment.findUnique({ where: { id } })
      if (!shipment) return reply.code(404).send({ error: 'shipment not found' })
      const r = await cancelMCFShipment(resolveMCFAdapter(), shipment.amazonFulfillmentOrderId, reason)
      return r
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/mcf/:id/cancel] failed')
      return reply.code(400).send({ error: error?.message ?? String(error) })
    }
  })

  // ── GET /api/stock/shopify-locations ─────────────────────────────
  // S.22 — list Nexus StockLocation rows mapped to Shopify locations.
  // Includes per-location SKU count + total quantity for the upcoming
  // S.23 settings UI.
  fastify.get('/stock/shopify-locations', async (_request, reply) => {
    try {
      const list = await shopifyLocations.listShopifyLocationsWithStock()
      return { locations: list }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/shopify-locations] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── POST /api/stock/shopify-locations/discover ───────────────────
  // S.22 — pull every Shopify location + upsert as StockLocation.
  // Idempotent (per-row unique partial index on externalChannel +
  // externalLocationId; safe to call concurrently).
  fastify.post('/stock/shopify-locations/discover', async (_request, reply) => {
    try {
      // Lazy-construct the Shopify client. The discovery service
      // accepts a thin shape with just `makeRequest`; ShopifyService
      // exposes that via the public makeRequestPublic shim.
      let svc: { makeRequest: (m: 'GET', p: string) => Promise<unknown> } | null = null
      try {
        const inner = new ShopifyService()
        svc = { makeRequest: (m, p) => inner.makeRequestPublic(m, p) }
      } catch (err) {
        fastify.log.warn({ err }, '[shopify-locations/discover] Shopify not configured')
      }
      const summary = await shopifyLocations.discoverShopifyLocations(svc)
      return summary
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/shopify-locations/discover] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── PATCH /api/stock/shopify-locations/:id ──────────────────────
  // S.22 — toggle isActive on a Shopify-mapped StockLocation. The
  // operator hits this from the S.23 settings UI to disable a
  // Shopify location without unmapping it.
  fastify.patch<{
    Params: { id: string }
    Body: { isActive?: boolean }
  }>('/stock/shopify-locations/:id', async (request, reply) => {
    try {
      const { id } = request.params
      const body = request.body ?? {}
      if (body.isActive === undefined) {
        return reply.code(400).send({ error: 'isActive required (boolean)' })
      }
      const r = await shopifyLocations.setShopifyLocationActive({ id, isActive: !!body.isActive })
      return r
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/shopify-locations/:id PATCH] failed')
      return reply.code(400).send({ error: error?.message ?? String(error) })
    }
  })

  // ── GET /api/stock/cost-layers/:productId ───────────────────────
  // S.20 — surface the per-product cost-layer history. FIFO depletes
  // oldest first; LIFO newest first; WAC uses the rolling
  // Product.weightedAvgCostCents but layers are still maintained for
  // audit. The drawer renders this list so operators can see what
  // each unit cost when it arrived.
  fastify.get('/stock/cost-layers/:productId', async (request, reply) => {
    try {
      const { productId } = request.params as { productId: string }
      const q = request.query as any
      const limit = Math.min(500, Math.max(1, Math.floor(safeNum(q.limit, 100) ?? 100)))
      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: {
          id: true, sku: true, name: true,
          costingMethod: true, weightedAvgCostCents: true,
          costPrice: true,
        },
      })
      if (!product) return reply.code(404).send({ error: 'Product not found' })
      const layers = await listLayers(productId, limit)
      return {
        product: {
          ...product,
          costPriceCents: product.costPrice == null ? null : Math.round(Number(product.costPrice) * 100),
        },
        layers,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/cost-layers/:id] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── POST /api/stock/cost-layers/:productId/recompute-wac ───────
  // S.20 — admin recompute the weighted-average cost for a product.
  // Useful after a backfill repair, a method switch, or a manual
  // layer edit. Returns the new WAC in cents.
  fastify.post('/stock/cost-layers/:productId/recompute-wac', async (request, reply) => {
    try {
      const { productId } = request.params as { productId: string }
      const wac = await recomputeWac(productId)
      return { productId, weightedAvgCostCents: wac }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/cost-layers/:id/recompute-wac] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── GET /api/stock/movements ────────────────────────────────────
  fastify.get('/stock/movements', async (request, reply) => {
    try {
      const q = request.query as any
      const movements = await listStockMovements({
        productId: q.productId,
        variationId: q.variationId,
        warehouseId: q.warehouseId,
        limit: safeNum(q.limit, 100) ?? 100,
      })
      return { movements, count: movements.length }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/movements] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── PATCH /api/stock/:id ─────────────────────────────────────────
  // Two operations on a StockLevel row, exposed via one endpoint:
  //   { change: number, notes?, reason? }      → quantity adjustment
  //   { reorderThreshold: number | null }       → threshold update (no audit)
  // The two are mutually exclusive — pick one. `change` is signed:
  // +5 to add, -3 to remove. Reason defaults to MANUAL_ADJUSTMENT.
  fastify.patch('/stock/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = (request.body ?? {}) as {
        change?: number
        notes?: string
        reason?: string
        reorderThreshold?: number | null
      }

      const sl = await prisma.stockLevel.findUnique({
        where: { id },
        select: { productId: true, variationId: true, locationId: true },
      })
      if (!sl) return reply.code(404).send({ error: 'StockLevel not found' })

      // Threshold-only update — no audit row, simple field write.
      if (body.reorderThreshold !== undefined) {
        const t = body.reorderThreshold
        if (t !== null && (!Number.isFinite(Number(t)) || Number(t) < 0)) {
          return reply.code(400).send({ error: 'reorderThreshold must be null or a non-negative integer' })
        }
        const updated = await prisma.stockLevel.update({
          where: { id },
          data: { reorderThreshold: t === null ? null : Math.floor(Number(t)) },
          select: { id: true, reorderThreshold: true },
        })
        return { ok: true, stockLevel: updated }
      }

      // Quantity-change path.
      const change = Number(body.change)
      if (!Number.isFinite(change) || change === 0) {
        return reply.code(400).send({ error: 'change must be a non-zero number, or pass reorderThreshold' })
      }

      const movement = await applyStockMovement({
        productId: sl.productId,
        variationId: sl.variationId ?? undefined,
        locationId: sl.locationId,
        change,
        reason: (body.reason as any) ?? 'MANUAL_ADJUSTMENT',
        notes: body.notes,
        actor: 'manual-adjust',
      })
      return { ok: true, movement }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/:id] adjust failed')
      return reply.code(400).send({ error: error?.message ?? String(error) })
    }
  })

  // ── POST /api/stock/bulk-transfer ───────────────────────────────
  // S.21 — move N units from each (productId × fromLocationId) row
  // to a single destination. Body shape:
  //   { toLocationId, items: [{ productId, fromLocationId, quantity }] }
  // Each item runs through transferStock; results are aggregated so
  // the operator sees per-row success/failure. Idempotency is left to
  // transferStock (each transfer creates fresh OUT/IN audit rows).
  fastify.post('/stock/bulk-transfer', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        toLocationId?: string
        items?: Array<{
          productId: string
          fromLocationId: string
          quantity: number
          notes?: string
        }>
      }
      if (!body.toLocationId || !Array.isArray(body.items) || body.items.length === 0) {
        return reply.code(400).send({ error: 'toLocationId and items[] required' })
      }
      let succeeded = 0
      let failed = 0
      const errors: Array<{ productId: string; fromLocationId: string; error: string }> = []
      for (const it of body.items) {
        const qty = Number(it.quantity)
        if (!it.productId || !it.fromLocationId || !Number.isFinite(qty) || qty <= 0) {
          failed++
          errors.push({ productId: it.productId, fromLocationId: it.fromLocationId, error: 'invalid item' })
          continue
        }
        if (it.fromLocationId === body.toLocationId) {
          failed++
          errors.push({ productId: it.productId, fromLocationId: it.fromLocationId, error: 'from === to' })
          continue
        }
        try {
          await transferStock({
            productId: it.productId,
            fromLocationId: it.fromLocationId,
            toLocationId: body.toLocationId,
            quantity: qty,
            notes: it.notes,
            actor: 'bulk-transfer',
          })
          succeeded++
        } catch (err: any) {
          failed++
          errors.push({
            productId: it.productId,
            fromLocationId: it.fromLocationId,
            error: err?.message ?? String(err),
          })
        }
      }
      return { succeeded, failed, errors, requested: body.items.length }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/bulk-transfer] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── POST /api/stock/bulk-import ─────────────────────────────────
  // S.21 — apply a parsed CSV upload as bulk stock adjustments.
  // Body shape (post-parse — the frontend handles file → JSON):
  //   {
  //     dryRun: boolean,
  //     locationCode: string,    // e.g. 'IT-MAIN'
  //     items: [{ sku, change, notes? }]
  //   }
  // The dryRun flag returns the same response shape (per-item
  // resolved productId + would-be balance) without calling
  // applyStockMovement — the frontend uses this for the preview step.
  fastify.post('/stock/bulk-import', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        dryRun?: boolean
        locationCode?: string
        items?: Array<{ sku: string; change: number; notes?: string }>
      }
      const dryRun = !!body.dryRun
      const locationCode = body.locationCode ?? 'IT-MAIN'
      const items = Array.isArray(body.items) ? body.items : []
      if (items.length === 0) {
        return reply.code(400).send({ error: 'items[] required (non-empty)' })
      }
      if (items.length > 5000) {
        return reply.code(400).send({ error: 'items capped at 5000 per upload' })
      }

      const location = await prisma.stockLocation.findUnique({
        where: { code: locationCode },
        select: { id: true, code: true },
      })
      if (!location) return reply.code(404).send({ error: `Location ${locationCode} not found` })

      // Resolve every SKU in one batched query.
      const skus = Array.from(new Set(items.map((it) => it.sku)))
      const products = await prisma.product.findMany({
        where: { sku: { in: skus } },
        select: { id: true, sku: true, totalStock: true },
      })
      const productBySku = new Map(products.map((p) => [p.sku, p]))

      const results: Array<{
        sku: string
        change: number
        productId: string | null
        currentTotal: number | null
        wouldBeTotal: number | null
        applied: boolean
        error: string | null
      }> = []

      for (const it of items) {
        const change = Number(it.change)
        if (!it.sku || !Number.isFinite(change) || change === 0) {
          results.push({ sku: it.sku, change, productId: null, currentTotal: null, wouldBeTotal: null, applied: false, error: 'invalid sku/change (must be non-zero number)' })
          continue
        }
        const p = productBySku.get(it.sku)
        if (!p) {
          results.push({ sku: it.sku, change, productId: null, currentTotal: null, wouldBeTotal: null, applied: false, error: 'sku not found' })
          continue
        }
        const wouldBe = p.totalStock + change
        if (wouldBe < 0) {
          results.push({ sku: it.sku, change, productId: p.id, currentTotal: p.totalStock, wouldBeTotal: wouldBe, applied: false, error: 'would drive totalStock negative' })
          continue
        }
        if (dryRun) {
          results.push({ sku: it.sku, change, productId: p.id, currentTotal: p.totalStock, wouldBeTotal: wouldBe, applied: false, error: null })
          continue
        }
        try {
          await applyStockMovement({
            productId: p.id,
            locationId: location.id,
            change,
            reason: 'MANUAL_ADJUSTMENT',
            referenceType: 'BulkImport',
            actor: 'bulk-import',
            notes: it.notes ?? '[bulk-import]',
          })
          results.push({ sku: it.sku, change, productId: p.id, currentTotal: p.totalStock, wouldBeTotal: wouldBe, applied: true, error: null })
        } catch (err: any) {
          results.push({ sku: it.sku, change, productId: p.id, currentTotal: p.totalStock, wouldBeTotal: wouldBe, applied: false, error: err?.message ?? String(err) })
        }
      }

      const succeeded = results.filter((r) => r.applied).length
      const failed = results.filter((r) => r.error != null).length
      return { dryRun, succeeded, failed, total: items.length, results }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/bulk-import] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── POST /api/stock/transfer ─────────────────────────────────────
  fastify.post('/stock/transfer', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        productId?: string
        variationId?: string
        fromLocationId?: string
        toLocationId?: string
        quantity?: number
        notes?: string
      }
      if (!body.productId || !body.fromLocationId || !body.toLocationId) {
        return reply.code(400).send({ error: 'productId, fromLocationId, toLocationId required' })
      }
      const quantity = Number(body.quantity)
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return reply.code(400).send({ error: 'quantity must be > 0' })
      }
      const result = await transferStock({
        productId: body.productId,
        variationId: body.variationId,
        fromLocationId: body.fromLocationId,
        toLocationId: body.toLocationId,
        quantity,
        notes: body.notes,
        actor: 'manual-transfer',
      })
      return { ok: true, ...result }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/transfer] failed')
      return reply.code(400).send({ error: error?.message ?? String(error) })
    }
  })

  // ── POST /api/stock/reserve ──────────────────────────────────────
  fastify.post('/stock/reserve', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        productId?: string
        variationId?: string
        locationId?: string
        quantity?: number
        orderId?: string
        reason?: 'PENDING_ORDER' | 'MANUAL_HOLD' | 'PROMOTION'
        ttlMs?: number
      }
      if (!body.productId || !body.locationId) {
        return reply.code(400).send({ error: 'productId, locationId required' })
      }
      const quantity = Number(body.quantity)
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return reply.code(400).send({ error: 'quantity must be > 0' })
      }
      const reservation = await reserveStock({
        productId: body.productId,
        variationId: body.variationId,
        locationId: body.locationId,
        quantity,
        orderId: body.orderId,
        reason: body.reason,
        ttlMs: body.ttlMs,
        actor: 'manual-reserve',
      })
      return { ok: true, reservation }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/reserve] failed')
      return reply.code(400).send({ error: error?.message ?? String(error) })
    }
  })

  // ── POST /api/stock/release/:reservationId ───────────────────────
  fastify.post('/stock/release/:reservationId', async (request, reply) => {
    try {
      const { reservationId } = request.params as { reservationId: string }
      const updated = await releaseReservation(reservationId, {
        actor: 'manual-release',
      })
      return { ok: true, reservation: updated }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/release] failed')
      return reply.code(400).send({ error: error?.message ?? String(error) })
    }
  })

  // ── POST /api/stock/sync ─────────────────────────────────────────
  // Manual trigger for the FBA inventory sweep — useful when the
  // operator just received units at FBA and wants the StockLevel
  // updated immediately without waiting for the 15-min cron.
  fastify.post('/stock/sync', async (_request, reply) => {
    try {
      if (!amazonInventoryService.isConfigured()) {
        return reply.code(503).send({ error: 'Amazon SP-API not configured' })
      }
      const summary = await amazonInventoryService.syncFBAInventory()
      return { ok: true, summary }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/sync] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })
}

export default stockRoutes
