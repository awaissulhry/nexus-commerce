/**
 * Admin Routes
 * 
 * Protected endpoints for administrative operations:
 * - Data validation and repair
 * - Batch operations
 * - System diagnostics
 */

import type { FastifyInstance } from 'fastify'
import { DataValidationService } from '../services/sync/data-validation.service.js'
import { BatchRepairService } from '../services/sync/batch-repair.service.js'
import prisma from '../db.js'

// RB.1 — entities tracked by /admin/recycle-bin. Each maps to a Prisma
// model that carries a `deletedAt` column. The same list drives the
// /admin/recycle-bin summary endpoint, the purge endpoint, and (via the
// frontend) the housekeeping UI rows.
type RecycleBinEntity = 'product' | 'order' | 'inboundShipment' | 'shipment' | 'purchaseOrder'

const RECYCLE_BIN_ENTITIES: ReadonlyArray<{
  key: RecycleBinEntity
  label: string
  /** Path the operator follows from the housekeeping summary to view bin rows. */
  href: string
}> = [
  { key: 'product',         label: 'Products',          href: '/products?deleted=true' },
  { key: 'order',           label: 'Orders',            href: '/orders?deleted=true' },
  { key: 'inboundShipment', label: 'Inbound shipments', href: '/fulfillment/inbound?deleted=true' },
  { key: 'shipment',        label: 'Outbound shipments',href: '/fulfillment/outbound/shipments?deleted=true' },
  { key: 'purchaseOrder',   label: 'Purchase orders',   href: '/fulfillment/purchase-orders?deleted=true' },
]

function modelDelegate(key: RecycleBinEntity) {
  switch (key) {
    case 'product':         return prisma.product
    case 'order':           return prisma.order
    case 'inboundShipment': return prisma.inboundShipment
    case 'shipment':        return prisma.shipment
    case 'purchaseOrder':   return prisma.purchaseOrder
  }
}

export async function adminRoutes(app: FastifyInstance) {
  const validationService = new DataValidationService()
  const repairService = new BatchRepairService()

  /**
   * GET /admin/validation/report
   * Get comprehensive validation report for all products
   */
  app.get('/admin/validation/report', async (request, reply) => {
    try {
      const report = await validationService.validateAllProducts()

      return reply.send({
        success: true,
        data: report,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return reply.status(500).send({
        success: false,
        error: message,
      })
    }
  })

  /**
   * GET /admin/validation/product/:productId
   * Validate a specific product
   */
  app.get<{ Params: { productId: string } }>(
    '/admin/validation/product/:productId',
    async (request, reply) => {
      try {
        const { productId } = request.params
        const report = await validationService.validateProduct(productId)

        return reply.send({
          success: true,
          data: report,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return reply.status(500).send({
          success: false,
          error: message,
        })
      }
    }
  )

  /**
   * POST /admin/repair/all
   * Run all batch repair operations
   */
  app.post('/admin/repair/all', async (request, reply) => {
    try {
      const result = await repairService.repairAll()

      return reply.send({
        success: true,
        data: result,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return reply.status(500).send({
        success: false,
        error: message,
      })
    }
  })

  /**
   * POST /admin/repair/orphaned-variations
   * Remove variations without products
   */
  app.post('/admin/repair/orphaned-variations', async (request, reply) => {
    try {
      const result = await repairService.repairOrphanedVariations()

      return reply.send({
        success: true,
        data: result,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return reply.status(500).send({
        success: false,
        error: message,
      })
    }
  })

  /**
   * POST /admin/repair/missing-themes
   * Infer and set variation themes for products
   */
  app.post('/admin/repair/missing-themes', async (request, reply) => {
    try {
      const result = await repairService.repairMissingVariationThemes()

      return reply.send({
        success: true,
        data: result,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return reply.status(500).send({
        success: false,
        error: message,
      })
    }
  })

  /**
   * POST /admin/repair/missing-attributes
   * Populate variation attributes from legacy fields
   */
  app.post('/admin/repair/missing-attributes', async (request, reply) => {
    try {
      const result = await repairService.repairMissingVariationAttributes()

      return reply.send({
        success: true,
        data: result,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return reply.status(500).send({
        success: false,
        error: message,
      })
    }
  })

  /**
   * POST /admin/repair/product-status
   * Ensure all products have valid status
   */
  app.post('/admin/repair/product-status', async (request, reply) => {
    try {
      const result = await repairService.repairProductStatus()

      return reply.send({
        success: true,
        data: result,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return reply.status(500).send({
        success: false,
        error: message,
      })
    }
  })

  /**
   * POST /admin/repair/channel-listings
   * Fix inconsistent channel listings
   */
  app.post('/admin/repair/channel-listings', async (request, reply) => {
    try {
      const result = await repairService.repairInconsistentChannelListings()

      return reply.send({
        success: true,
        data: result,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return reply.status(500).send({
        success: false,
        error: message,
      })
    }
  })

  /**
   * GET /admin/health
   * System health check
   */
  app.get('/admin/health', async (request, reply) => {
    try {
      const report = await validationService.validateAllProducts()

      const health = {
        status: 'healthy',
        timestamp: new Date(),
        issues: {
          orphanedVariants: report.orphanedVariants,
          inconsistentThemes: report.inconsistentThemes,
          missingAttributes: report.missingAttributes,
          invalidChannelListings: report.invalidChannelListings,
        },
        totalIssues:
          report.orphanedVariants +
          report.inconsistentThemes +
          report.missingAttributes +
          report.invalidChannelListings,
      }

      if (health.totalIssues > 0) {
        health.status = 'warning'
      }

      return reply.send(health)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return reply.status(500).send({
        status: 'unhealthy',
        error: message,
      })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // RB.1 — Recycle bin housekeeping. Powers /admin/recycle-bin.
  //
  // GET  /admin/recycle-bin/summary
  //   → { entities: [{ key, label, href, count, oldestDeletedAt }, ...] }
  //
  // POST /admin/recycle-bin/purge
  //   body: { entity: RecycleBinEntity, olderThanDays: number }
  //   → { entity, purged }
  //
  // Purge is destructive — it hard-deletes rows where deletedAt is
  // BOTH non-null AND older than the requested cutoff. No automatic
  // cron runs this (operator preference); the housekeeping page is the
  // only invocation path.
  // ═══════════════════════════════════════════════════════════════════
  app.get('/admin/recycle-bin/summary', async (_request, reply) => {
    try {
      const entities = await Promise.all(
        RECYCLE_BIN_ENTITIES.map(async ({ key, label, href }) => {
          const where = { deletedAt: { not: null } }
          const [count, oldest] = await Promise.all([
            // @ts-expect-error — discriminated delegate, count() shape varies
            modelDelegate(key).count({ where }),
            // @ts-expect-error — same
            modelDelegate(key).findFirst({
              where,
              select: { deletedAt: true },
              orderBy: { deletedAt: 'asc' },
            }),
          ])
          return {
            key,
            label,
            href,
            count,
            oldestDeletedAt: oldest?.deletedAt ?? null,
          }
        }),
      )
      return reply.send({ entities })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return reply.status(500).send({ error: message })
    }
  })

  app.post('/admin/recycle-bin/purge', async (request, reply) => {
    try {
      const body = request.body as { entity?: RecycleBinEntity; olderThanDays?: number }
      const entity = body?.entity
      const olderThanDays = Number(body?.olderThanDays)
      if (!entity || !RECYCLE_BIN_ENTITIES.some((e) => e.key === entity)) {
        return reply.code(400).send({ error: 'entity required (product|order|inboundShipment|shipment|purchaseOrder)' })
      }
      if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
        return reply.code(400).send({ error: 'olderThanDays must be >= 0' })
      }
      const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)
      const delegate = modelDelegate(entity)
      // @ts-expect-error — discriminated delegate, deleteMany shape varies
      const result = await delegate.deleteMany({
        where: { deletedAt: { not: null, lt: cutoff } },
      })
      return reply.send({ entity, purged: result.count, cutoff: cutoff.toISOString() })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return reply.status(500).send({ error: message })
    }
  })
}
