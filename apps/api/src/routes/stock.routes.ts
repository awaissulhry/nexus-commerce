import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { applyStockMovement, listStockMovements } from '../services/stock-movement.service.js'
import {
  reserveStock,
  releaseReservation,
  transferStock,
} from '../services/stock-level.service.js'
import { amazonInventoryService } from '../services/amazon-inventory.service.js'

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
  // Adjust the quantity of a specific StockLevel row. Body:
  //   { change: number, notes?: string, reason?: string }
  // change is signed: +5 to add, -3 to remove. Reason defaults to
  // MANUAL_ADJUSTMENT.
  fastify.patch('/stock/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = (request.body ?? {}) as { change?: number; notes?: string; reason?: string }
      const change = Number(body.change)
      if (!Number.isFinite(change) || change === 0) {
        return reply.code(400).send({ error: 'change must be a non-zero number' })
      }
      const sl = await prisma.stockLevel.findUnique({
        where: { id },
        select: { productId: true, variationId: true, locationId: true },
      })
      if (!sl) return reply.code(404).send({ error: 'StockLevel not found' })

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
