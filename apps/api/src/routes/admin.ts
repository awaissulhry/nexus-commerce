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
import { auditSalesDrift } from '../services/revenue/drift-audit.service.js'
import { syncFinancialEvents } from '../services/amazon-financial-events.service.js'
import { refreshSalesAggregates } from '../services/sales-aggregate.service.js'
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

  /**
   * DA-RT.13 — GET /admin/sales-drift/audit?lookbackDays=7
   *
   * Operator HTTP read of the same 3-way drift comparison the nightly
   * sales-drift-detector cron runs. Returns every (day, marketplace)
   * window in the lookback with its 3 store sums + the driftPairs[]
   * breakdown identifying which pair(s) disagree beyond tolerance.
   *
   * Use this instead of grepping Railway logs after the cron fires —
   * `windows` includes both drifting AND in-tolerance entries so you
   * can verify "everything is fine" without ambiguity. `driftedCount`
   * matches the cron's outputSummary.
   *
   * Query param: lookbackDays (default 7, min 1, max 90). Today is
   * always excluded — intraday drift is expected.
   */
  app.get<{ Querystring: { lookbackDays?: string } }>(
    '/admin/sales-drift/audit',
    async (request, reply) => {
      try {
        const raw = Number(request.query.lookbackDays ?? 7)
        const lookbackDays =
          Number.isFinite(raw) ? Math.min(90, Math.max(1, Math.trunc(raw))) : 7
        const audit = await auditSalesDrift({ lookbackDays })
        return reply.send(audit)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return reply.status(500).send({ error: message })
      }
    },
  )

  /**
   * DA-RT.13 — GET /admin/sales-drift/window?day=YYYY-MM-DD&marketplace=ES
   *
   * Per-order drill-down into a single (day, marketplace) drift window.
   * Surfaces both bucketing strategies so the operator can pinpoint
   * which orders are TZ-misbucketed or NULL-purchaseDate-fallback-shifted:
   *
   *   - ordersByPurchaseDate: rows whose Order.purchaseDate, bucketed
   *     in Europe/Rome, lands on the queried day. Matches the
   *     drift-audit endpoint's Order-side sum exactly.
   *   - ordersByCreatedAt: rows whose Order.createdAt, bucketed
   *     in Europe/Rome, lands on the queried day. Matches the
   *     aggregate cron's COALESCE(purchaseDate, createdAt) bucket
   *     for the subset where purchaseDate is NULL.
   *   - aggregateRow: the DailySalesAggregate row(s) for that
   *     (day, marketplace) so operator can see if it's stale vs
   *     what the Order table now reports.
   *
   * Diff the two order lists to find the offending rows:
   *   - Order in `byPurchaseDate` not in `byCreatedAt` → bucketed by
   *     purchaseDate on this day, but createdAt is on a different
   *     day. Standard non-issue.
   *   - Order in `byCreatedAt` not in `byPurchaseDate` AND
   *     purchaseDate IS NULL → COALESCE fallback. Aggregate sees it
   *     on this day, Order-side query excludes it. DA-RT bug.
   *   - aggregateRow.grossRevenue doesn't match SUM of either list
   *     → aggregate is stale; needs refresh.
   */
  app.get<{
    Querystring: { day?: string; marketplace?: string }
  }>('/admin/sales-drift/window', async (request, reply) => {
    try {
      const day = request.query.day
      const marketplace = request.query.marketplace
      if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        return reply.status(400).send({ error: 'day must be YYYY-MM-DD' })
      }
      if (!marketplace) {
        return reply.status(400).send({ error: 'marketplace required' })
      }

      const ordersByPurchaseDate = await prisma.$queryRaw<Array<{
        id: string
        channelOrderId: string | null
        purchaseDate: Date | null
        createdAt: Date
        totalPrice: number | null
        status: string
        romeDayPurchase: Date | null
        romeDayCreated: Date
      }>>`
        SELECT
          id, "channelOrderId", "purchaseDate", "createdAt",
          "totalPrice"::float, "status",
          date_trunc('day', "purchaseDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Rome')::date AS "romeDayPurchase",
          date_trunc('day', "createdAt"    AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Rome')::date AS "romeDayCreated"
        FROM "Order"
        WHERE "deletedAt" IS NULL
          AND "channel" = 'AMAZON'
          AND "marketplace" = ${marketplace}
          AND "status" != 'CANCELLED'
          AND date_trunc('day', "purchaseDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Rome')::date = ${day}::date
        ORDER BY "purchaseDate"
      `

      const ordersByCreatedAt = await prisma.$queryRaw<Array<{
        id: string
        channelOrderId: string | null
        purchaseDate: Date | null
        createdAt: Date
        totalPrice: number | null
        status: string
      }>>`
        SELECT
          id, "channelOrderId", "purchaseDate", "createdAt",
          "totalPrice"::float, "status"
        FROM "Order"
        WHERE "deletedAt" IS NULL
          AND "channel" = 'AMAZON'
          AND "marketplace" = ${marketplace}
          AND "status" != 'CANCELLED'
          AND date_trunc('day',
                COALESCE("purchaseDate", "createdAt") AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Rome'
              )::date = ${day}::date
        ORDER BY "createdAt"
      `

      const aggregateRows = await prisma.$queryRaw<Array<{
        day: Date
        marketplace: string | null
        sku: string
        grossRevenue: number
        unitsSold: number
      }>>`
        SELECT "day", "marketplace", "sku",
               "grossRevenue"::float, "unitsSold"::int
        FROM "DailySalesAggregate"
        WHERE "channel" = 'AMAZON'
          AND "marketplace" = ${marketplace}
          AND "day" = ${day}::date
      `

      const aggregateTotal = aggregateRows.reduce(
        (s, r) => s + Number(r.grossRevenue),
        0,
      )

      return reply.send({
        day,
        marketplace,
        ordersByPurchaseDate,
        ordersByCreatedAt,
        aggregateRows,
        aggregateTotal,
        purchaseDateTotal: ordersByPurchaseDate.reduce(
          (s, r) => s + Number(r.totalPrice ?? 0),
          0,
        ),
        createdAtTotal: ordersByCreatedAt.reduce(
          (s, r) => s + Number(r.totalPrice ?? 0),
          0,
        ),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return reply.status(500).send({ error: message })
    }
  })

  /**
   * DA-RT.15 — POST /admin/sales-drift/fix-line-total-orderitems
   *
   * One-shot migration for OrderItem rows where the ingest stored
   * Amazon's ItemPrice.Amount (line total across all units) as
   * `price` while keeping `quantity = QuantityOrdered`. Downstream
   * `SUM(price * quantity)` then double-counts. The ingest itself
   * is fixed in DA-RT.15; this endpoint repairs the historical
   * rows so they line up with the new ingest's per-unit semantics.
   *
   * Scope (defensive): only touches rows where
   *   - quantity > 1
   *   - the parent Order has totalPrice > 0
   *   - the row's `price * quantity` overshoots the proportional
   *     share of the Order's totalPrice by more than 1% — i.e. the
   *     row was demonstrably double-counted, not already correct.
   *
   * Idempotent: running twice on the same rows is a no-op because
   * after the first run `price * quantity` equals the share.
   *
   * Query param: dryRun=true (default) returns the count + sample
   *   without writing. dryRun=false applies the fix.
   */
  app.post<{ Querystring: { dryRun?: string } }>(
    '/admin/sales-drift/fix-line-total-orderitems',
    async (request, reply) => {
      try {
        const dryRun = request.query.dryRun !== 'false'
        // Find rows where qty > 1 AND (price * qty) overshoots the
        // order's totalPrice by >1%. These are the smoking-gun rows.
        const candidates = await prisma.$queryRaw<Array<{
          id: string
          orderId: string
          channelOrderId: string | null
          sku: string
          quantity: number
          price: number
          orderTotal: number
          newPrice: number
        }>>`
          SELECT
            oi.id, oi."orderId", o."channelOrderId", oi.sku, oi.quantity,
            oi.price::float AS price,
            o."totalPrice"::float AS "orderTotal",
            (oi.price / oi.quantity)::float AS "newPrice"
          FROM "OrderItem" oi
          JOIN "Order" o ON o.id = oi."orderId"
          WHERE oi.quantity > 1
            AND oi.price IS NOT NULL
            AND oi.price > 0
            AND o."totalPrice" > 0
            AND ABS((oi.price * oi.quantity) - o."totalPrice") > GREATEST(1, o."totalPrice" * 0.01)
          ORDER BY o."purchaseDate" DESC NULLS LAST
        `

        if (dryRun) {
          return reply.send({
            dryRun: true,
            candidateCount: candidates.length,
            sample: candidates.slice(0, 20),
          })
        }

        // Apply the fix in a single transaction. Per-row update so
        // each row's `newPrice = price / quantity` is computed
        // correctly even with mixed quantities.
        let updated = 0
        for (const c of candidates) {
          await prisma.orderItem.update({
            where: { id: c.id },
            data: { price: c.newPrice },
          })
          updated += 1
        }
        return reply.send({ dryRun: false, updated })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return reply.status(500).send({ error: message })
      }
    },
  )

  /**
   * DA-RT.14 — POST /admin/sales-drift/refresh-aggregate?days=30
   *
   * Re-runs the sales-aggregate UPSERT over a window so historical
   * DailySalesAggregate rows align with the current SQL bucket
   * expression. Necessary after DA-RT.14 (TZ-direction fix) — old
   * aggregate rows were built with the buggy expression and need
   * to be rewritten to match what the audit endpoint now expects.
   *
   * Synchronous; refreshSalesAggregates with a 30-day window is
   * usually seconds for ~hundreds of rows, longer for larger
   * catalogs. Window is end-inclusive on today.
   *
   * Query param: days (default 30, min 1, max 90).
   */
  app.post<{ Querystring: { days?: string } }>(
    '/admin/sales-drift/refresh-aggregate',
    async (request, reply) => {
      try {
        const raw = Number(request.query.days ?? 30)
        const days =
          Number.isFinite(raw) ? Math.min(90, Math.max(1, Math.trunc(raw))) : 30
        const to = new Date()
        const from = new Date(to.getTime() - (days - 1) * 86_400_000)
        const result = await refreshSalesAggregates({ from, to })
        return reply.send({
          days,
          from: from.toISOString().slice(0, 10),
          to: to.toISOString().slice(0, 10),
          ...result,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return reply.status(500).send({ error: message })
      }
    },
  )

  /**
   * DA-RT.13 — POST /admin/sales-drift/backfill-financial-events?days=7
   *
   * One-shot backfill of Amazon FinancialTransaction (Store C) over a
   * configurable window. The default amazon-financial-sync cron only
   * pulls yesterday — without a backfill, the 3-way drift audit can't
   * compare Store C against the existing 7-day Order/Aggregate windows.
   *
   * Synchronous on the request thread — pagination + ~0.5 req/s
   * limiter means a 7-day window takes seconds, not minutes. For
   * windows >30 days expect 1-2 minutes; bump the client timeout.
   *
   * Query param: days (default 7, min 1, max 60).
   */
  app.post<{ Querystring: { days?: string } }>(
    '/admin/sales-drift/backfill-financial-events',
    async (request, reply) => {
      try {
        const raw = Number(request.query.days ?? 7)
        const days =
          Number.isFinite(raw) ? Math.min(60, Math.max(1, Math.trunc(raw))) : 7

        const now = new Date()
        const end = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000)

        const summary = await syncFinancialEvents(start, end)
        return reply.send({ days, ...summary })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return reply.status(500).send({ error: message })
      }
    },
  )

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
