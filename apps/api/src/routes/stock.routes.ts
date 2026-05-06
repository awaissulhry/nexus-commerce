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
          images: { select: { url: true }, take: 1 },
        },
      })
      if (!product) return reply.code(404).send({ error: 'Product not found' })

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
        reservations: stockLevels.flatMap((sl) =>
          sl.reservations.map((r) => ({
            ...r,
            quantity: r.quantity,
            location: { id: sl.location.id, code: sl.location.code },
          })),
        ),
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[stock/product/:id] failed')
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
