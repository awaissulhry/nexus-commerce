import type { FastifyPluginAsync } from 'fastify'
import { Prisma } from '@prisma/client'
import prisma from '../db.js'
import {
  resolveWarehouseForOrder,
  previewRouting,
} from '../services/order-routing.service.js'
import {
  createCycleCount,
  startCycleCount,
  recordCount,
  reconcileItem,
  ignoreItem,
  completeCycleCount,
  cancelCycleCount,
} from '../services/cycle-count.service.js'
import { applyStockMovement, listStockMovements } from '../services/stock-movement.service.js'
import { refreshSalesAggregates } from '../services/sales-aggregate.service.js'
import { resolveAtp, DEFAULT_LEAD_TIME_DAYS } from '../services/atp.service.js'
import { resolveStockForChannel, type ChannelLocationSource } from '../services/atp-channel.service.js'
import {
  bulkPersistRecommendationsIfChanged,
  attachPoToRecommendation,
  dismissRecommendation,
  bulkDismissRecommendations,
  getRecommendationHistory,
  getRecommendationById,
  type RecommendationInput,
  type Urgency,
  type VelocitySource,
} from '../services/replenishment-recommendation.service.js'
import {
  computeRecommendation,
  dailyDemandStdDev,
  type ConstraintCode,
} from '../services/replenishment-math.service.js'
import {
  promoteUrgency,
  type Urgency as PromotedUrgencyTier,
} from '../services/replenishment-urgency.service.js'
import {
  findApplicableEvent,
  shouldPromoteForPrep,
  bumpUrgencyOneTier,
} from '../services/event-prep.service.js'
import {
  recomputeAllLeadTimeStats,
  recomputeLeadTimeStatsForSupplier,
  getLeadTimeStatsStatus,
} from '../services/lead-time-stats.service.js'
import { getLeadTimeStatsCronStatus } from '../jobs/lead-time-stats.job.js'
import {
  runStockoutSweep,
  getStockoutSummary,
  listStockoutEvents,
} from '../services/stockout-detector.service.js'
import { getStockoutDetectorCronStatus } from '../jobs/stockout-detector.job.js'
import {
  rolloutChallenger,
  pinSkuToModel,
  promoteToChampion,
  ensureDefaultChampionAssignments,
  getModelsActive,
} from '../services/forecast-routing.service.js'
import {
  adjustDemandForSubstitution,
  loadSubstitutionLinks,
  listSubstitutionsForProduct,
  createSubstitution,
  updateSubstitution,
  deleteSubstitution,
} from '../services/substitution.service.js'
import {
  loadShippingProfilesForSuppliers,
  optimizeContainerFill,
  freightCostForLine,
  normalizeDimsToCm,
  normalizeWeightToGrams,
  cbmFromDims,
  getShippingProfile,
  putShippingProfile,
  type PackItem,
  type ShippingMode,
} from '../services/container-pack.service.js'
import {
  projectWeeklyCashFlow,
  type OpenPo,
  type SpeculativeRec,
} from '../services/cash-flow.service.js'
import {
  ingestRestockReportForMarketplace,
  ingestRestockReportsForAllMarketplaces,
  loadLatestRowsForCohort,
  getLatestRowForSku,
  getStatusSummary as getFbaRestockStatus,
  compareRecommendations as compareFbaRestock,
  DEFAULT_STALE_DAYS as FBA_RESTOCK_STALE_DAYS,
  eligibleMarketplaceCodes,
} from '../services/fba-restock.service.js'
import {
  rankSuppliers,
  loadCandidatesForProduct,
  setPreferredSupplier,
} from '../services/supplier-comparison.service.js'
import { amazonMarketplaceId } from '../services/categories/marketplace-ids.js'
import { getFbaRestockCronStatus } from '../jobs/fba-restock-ingestion.job.js'
import {
  runAutoPoSweep,
  getAutoPoStatus,
} from '../services/auto-po.service.js'
import { getAutoPoCronStatus } from '../jobs/auto-po-replenishment.job.js'
import {
  transitionPo,
  getPoAuditTrail,
  type WorkflowTransition,
} from '../services/po-workflow.service.js'
import {
  ingestSalesTrafficForDay,
  ingestAllAmazonMarketplaces,
} from '../services/sales-report-ingest.service.js'
import {
  generateForecastForSeries,
  generateForecastsForAll,
} from '../services/forecast.service.js'
import {
  getAccuracyForSku,
  getAccuracyAggregate,
  backfillForecastAccuracy,
} from '../services/forecast-accuracy.service.js'
import {
  renderFactoryPoPdf,
  type FactoryPoInput,
  type FactoryPoProductGroup,
  type FactoryPoVariantLine,
} from '../services/factory-po-pdf.service.js'
import {
  receiveItems as inboundReceiveItems,
  releaseQcHold as inboundReleaseQcHold,
  recordDiscrepancy as inboundRecordDiscrepancy,
  updateDiscrepancyStatus as inboundUpdateDiscrepancyStatus,
  addAttachment as inboundAddAttachment,
  appendItemPhoto as inboundAppendItemPhoto,
  transitionShipmentStatus as inboundTransitionStatus,
  InvalidTransitionError,
  NotFoundError,
} from '../services/inbound.service.js'
import {
  isCloudinaryConfigured,
  uploadBufferToCloudinary,
} from '../services/cloudinary.service.js'
import {
  createInboundShipmentPlan as fbaCreateInboundShipmentPlan,
  getInboundShipmentLabels as fbaGetLabels,
  putInboundShipmentTransport as fbaPutTransport,
  isFbaInboundConfigured,
  type FbaShipmentType,
} from '../services/fba-inbound.service.js'
import {
  runFbaStatusPoll,
  getFbaStatusPollStatus,
} from '../jobs/fba-status-poll.job.js'
import {
  publishInboundEvent,
  subscribeInboundEvents,
  getListenerCount,
} from '../services/inbound-events.service.js'
import {
  listCarriers as listInboundCarriers,
  validateTrackingFormat,
} from '../services/carriers.service.js'
import { renderInboundDiscrepancyPdf } from '../services/inbound-discrepancy-pdf.service.js'

// ─────────────────────────────────────────────────────────────────────
// FULFILLMENT B.3–B.9 — full domain API surface
//
// Stock         GET  /fulfillment/stock-overview
//               GET  /fulfillment/stock                       (paginated, filterable)
//               GET  /fulfillment/stock/:productId/movements  (audit log)
//               POST /fulfillment/stock/:productId/adjust     (manual +/-)
//
// Outbound      GET  /fulfillment/shipments
//               POST /fulfillment/shipments                   (create from order)
//               GET  /fulfillment/shipments/:id
//               POST /fulfillment/shipments/:id/print-label   (Sendcloud stub)
//               POST /fulfillment/shipments/:id/mark-shipped  (push tracking)
//               POST /fulfillment/shipments/bulk-create       (from order ids[])
//               POST /fulfillment/shipments/bulk-print        (multi-label PDF)
//
// Inbound       GET  /fulfillment/inbound
//               POST /fulfillment/inbound                     (create draft)
//               GET  /fulfillment/inbound/:id
//               POST /fulfillment/inbound/:id/receive         (mark items received → stock)
//               POST /fulfillment/inbound/:id/close
//
// FBA           POST /fulfillment/fba/plan-shipment           (Send-to-Amazon plan)
//               POST /fulfillment/fba/create-shipment         (commit plan to FBA)
//               GET  /fulfillment/fba/shipments
//               POST /fulfillment/fba/shipments/:id/labels    (FNSKU + carton labels)
//               POST /fulfillment/fba/shipments/:id/transport (ASN + booking)
//
// Suppliers     GET  /fulfillment/suppliers
//               POST /fulfillment/suppliers
//               GET  /fulfillment/suppliers/:id
//               PATCH /fulfillment/suppliers/:id
//
// POs           GET  /fulfillment/purchase-orders
//               POST /fulfillment/purchase-orders             (draft)
//               GET  /fulfillment/purchase-orders/:id
//               POST /fulfillment/purchase-orders/:id/submit  (status DRAFT→SUBMITTED)
//               POST /fulfillment/purchase-orders/:id/receive (creates InboundShipment)
//
// Manufacturing GET  /fulfillment/work-orders
//               POST /fulfillment/work-orders
//               POST /fulfillment/work-orders/:id/complete    (output → stock)
//
// Returns       Moved to returns.routes.ts (R0.2). Mounted at the same
//               /fulfillment/returns/* paths.
//
// Replenishment GET  /fulfillment/replenishment               (suggestions)
//               POST /fulfillment/replenishment/:productId/draft-po (one-click)
//
// Carriers      GET  /fulfillment/carriers
//               POST /fulfillment/carriers/:code/connect
//               POST /fulfillment/carriers/:code/disconnect
//
// Index         GET  /fulfillment/overview                    (dashboard tiles)
// ─────────────────────────────────────────────────────────────────────

function safeNum(v: unknown, fallback?: number): number | undefined {
  if (v == null) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/**
 * H.0a — recompute PurchaseOrderItem.quantityReceived as
 * SUM(InboundShipmentItem.quantityReceived WHERE purchaseOrderItemId = X).
 * Idempotent. Driven from current state so re-runs converge.
 */
async function syncPoiQuantityReceived(purchaseOrderItemId: string): Promise<void> {
  const sum = await prisma.inboundShipmentItem.aggregate({
    where: { purchaseOrderItemId },
    _sum: { quantityReceived: true },
  })
  await prisma.purchaseOrderItem.update({
    where: { id: purchaseOrderItemId },
    data: { quantityReceived: sum._sum.quantityReceived ?? 0 },
  })
}

/**
 * H.0a — auto-transition PurchaseOrder.status based on aggregate
 * received vs ordered across all line items.
 *
 * Rules:
 *   - CANCELLED is terminal — never auto-transition out of it.
 *   - 0 received total → leave status untouched (DRAFT/SUBMITTED/CONFIRMED stays).
 *   - 0 < received < ordered → PARTIAL.
 *   - received >= ordered → RECEIVED.
 *   - Never auto-downgrade — a re-receive with a lower number must
 *     not slip a RECEIVED PO back to PARTIAL. Operator-driven reversals
 *     should be explicit.
 */
const PO_STATUS_ORDER: Record<string, number> = {
  DRAFT: 0,
  SUBMITTED: 1,
  CONFIRMED: 2,
  PARTIAL: 3,
  RECEIVED: 4,
  CANCELLED: -1,
}

async function maybeTransitionPoStatus(poId: string): Promise<void> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: { items: { select: { quantityOrdered: true, quantityReceived: true } } },
  })
  if (!po || po.status === 'CANCELLED') return

  let totalOrdered = 0
  let totalReceived = 0
  for (const it of po.items) {
    totalOrdered += it.quantityOrdered
    totalReceived += it.quantityReceived ?? 0
  }
  if (totalReceived === 0) return

  const next: 'PARTIAL' | 'RECEIVED' =
    totalReceived >= totalOrdered ? 'RECEIVED' : 'PARTIAL'

  if (PO_STATUS_ORDER[next] <= PO_STATUS_ORDER[po.status]) return

  await prisma.purchaseOrder.update({
    where: { id: poId },
    data: { status: next, version: { increment: 1 } },
  })
}

function generatePoNumber(): string {
  const d = new Date()
  const yymmdd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `PO-${yymmdd}-${rand}`
}

const fulfillmentRoutes: FastifyPluginAsync = async (fastify) => {
  // ═══════════════════════════════════════════════════════════════════
  // OVERVIEW — dashboard tiles for /fulfillment index page
  // ═══════════════════════════════════════════════════════════════════
  fastify.get('/fulfillment/overview', async (_request, reply) => {
    try {
      reply.header('Cache-Control', 'private, max-age=30')

      const [
        pendingShipments,
        readyToPick,
        inTransit,
        deliveredToday,
        openInbound,
        receivingNow,
        lowStockCount,
        outOfStockCount,
        pendingReturns,
        inspectingReturns,
        replenishmentCritical,
        openWorkOrders,
        totalSuppliers,
        defaultWarehouse,
        activePoCount,
        // O.81: overdue pending orders — shipByDate has passed but no
        // active shipment exists yet. Drives the alert-ribbon row at
        // the top of the overview so operators see at-risk volume
        // before drilling into outbound.
        overduePending,
      ] = await Promise.all([
        prisma.shipment.count({ where: { status: { in: ['DRAFT', 'READY_TO_PICK'] as any } } }),
        prisma.shipment.count({ where: { status: 'READY_TO_PICK' as any } }),
        prisma.shipment.count({ where: { status: 'IN_TRANSIT' as any } }),
        prisma.shipment.count({
          where: {
            status: 'DELIVERED' as any,
            deliveredAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          },
        }),
        prisma.inboundShipment.count({ where: { status: { in: ['DRAFT', 'IN_TRANSIT', 'ARRIVED', 'RECEIVING'] as any } } }),
        prisma.inboundShipment.count({ where: { status: 'RECEIVING' as any } }),
        prisma.product.count({ where: { totalStock: { gt: 0, lte: 5 }, isParent: false } }),
        prisma.product.count({ where: { totalStock: 0, isParent: false } }),
        prisma.return.count({ where: { status: { in: ['REQUESTED', 'AUTHORIZED', 'IN_TRANSIT'] as any } } }),
        prisma.return.count({ where: { status: 'INSPECTING' as any } }),
        prisma.product.count({ where: { totalStock: 0, isParent: false } }),
        prisma.workOrder.count({ where: { status: { in: ['PLANNED', 'IN_PROGRESS'] as any } } }),
        prisma.supplier.count({ where: { isActive: true } }),
        prisma.warehouse.findFirst({ where: { isDefault: true } }),
        // R.7 — active POs (pre-terminal states needing operator attention)
        prisma.purchaseOrder.count({
          where: {
            status: { in: ['DRAFT', 'REVIEW', 'APPROVED', 'SUBMITTED'] as any },
          },
        }),
        // O.81: pending orders past their ship-by deadline.
        prisma.order.count({
          where: {
            status: { in: ['PENDING', 'PROCESSING'] as any[] },
            shipByDate: { lt: new Date() },
            shipments: { none: { status: { not: 'CANCELLED' as any } } },
          },
        }),
      ])

      return {
        outbound: { pendingShipments, readyToPick, inTransit, deliveredToday, overduePending },
        inbound: { openInbound, receivingNow, openWorkOrders },
        stock: { lowStock: lowStockCount, outOfStock: outOfStockCount },
        returns: { pending: pendingReturns, inspecting: inspectingReturns },
        replenishment: { critical: replenishmentCritical },
        purchaseOrders: { active: activePoCount },
        suppliers: { active: totalSuppliers },
        defaultWarehouse,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fulfillment/overview] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // STOCK
  // ═══════════════════════════════════════════════════════════════════

  // Legacy endpoint kept for backwards compatibility with current
  // /fulfillment/stock client; new client uses /fulfillment/stock.
  fastify.get('/fulfillment/stock-overview', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'private, max-age=30')
      const q = request.query as any
      const limit = Math.min(safeNum(q.limit, 500) ?? 500, 1000)
      const where: any = { parentId: null }
      if (q.fulfillment === 'FBA' || q.fulfillment === 'FBM') where.fulfillmentChannel = q.fulfillment
      if (q.lowStock === '1' || q.lowStock === 'true') where.totalStock = { lte: 5 }
      if (q.q?.trim()) {
        const s = q.q.trim()
        where.OR = [
          { sku: { contains: s, mode: 'insensitive' } },
          { name: { contains: s, mode: 'insensitive' } },
        ]
      }
      const rows = await prisma.product.findMany({
        where,
        select: {
          id: true, sku: true, name: true, totalStock: true, lowStockThreshold: true,
          fulfillmentChannel: true, amazonAsin: true, isParent: true,
        },
        orderBy: { totalStock: 'asc' },
        take: limit,
      })
      return { items: rows, count: rows.length }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fulfillment/stock-overview] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.get('/fulfillment/stock', async (request, reply) => {
    try {
      const q = request.query as any
      const page = Math.max(1, Math.floor(safeNum(q.page, 1) ?? 1))
      const pageSize = Math.min(200, Math.max(1, Math.floor(safeNum(q.pageSize, 50) ?? 50)))
      const skip = (page - 1) * pageSize

      const where: any = { isParent: false }
      if (q.fulfillment === 'FBA' || q.fulfillment === 'FBM') where.fulfillmentChannel = q.fulfillment
      if (q.lowStock === 'true') where.totalStock = { gt: 0, lte: 5 }
      if (q.outOfStock === 'true') where.totalStock = 0
      if (q.search?.trim()) {
        const s = q.search.trim()
        where.OR = [
          { sku: { contains: s, mode: 'insensitive' } },
          { name: { contains: s, mode: 'insensitive' } },
          { amazonAsin: { contains: s, mode: 'insensitive' } },
        ]
      }

      const sortBy = (q.sortBy ?? 'totalStock') as string
      const sortDir = (q.sortDir === 'desc' ? 'desc' : 'asc') as 'asc' | 'desc'
      const orderBy =
        sortBy === 'sku' ? { sku: sortDir } :
        sortBy === 'name' ? { name: sortDir } :
        sortBy === 'updatedAt' ? { updatedAt: sortDir } :
        { totalStock: sortDir }

      const [total, rows] = await Promise.all([
        prisma.product.count({ where }),
        prisma.product.findMany({
          where,
          select: {
            id: true, sku: true, name: true, totalStock: true, lowStockThreshold: true,
            fulfillmentChannel: true, fulfillmentMethod: true, amazonAsin: true,
            basePrice: true, costPrice: true, updatedAt: true,
            images: { select: { url: true }, take: 1 },
            channelListings: {
              select: { channel: true, marketplace: true, listingStatus: true, quantity: true, stockBuffer: true },
            },
          },
          orderBy,
          skip,
          take: pageSize,
        }),
      ])

      return {
        items: rows.map((r) => ({
          ...r,
          basePrice: r.basePrice == null ? null : Number(r.basePrice),
          costPrice: r.costPrice == null ? null : Number(r.costPrice),
          thumbnailUrl: r.images?.[0]?.url ?? null,
          channelCount: r.channelListings?.length ?? 0,
          listings: r.channelListings,
        })),
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fulfillment/stock] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.get('/fulfillment/stock/:productId/movements', async (request, reply) => {
    try {
      const { productId } = request.params as { productId: string }
      const q = request.query as any
      const movements = await listStockMovements({
        productId,
        limit: safeNum(q.limit, 100) ?? 100,
      })
      return { movements, count: movements.length }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fulfillment/stock/:id/movements] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/stock/:productId/adjust', async (request, reply) => {
    try {
      const { productId } = request.params as { productId: string }
      const body = (request.body ?? {}) as { change?: number; reason?: string; notes?: string; warehouseId?: string }
      const change = Number(body.change)
      if (!Number.isFinite(change) || change === 0) {
        return reply.code(400).send({ error: 'change must be a non-zero number' })
      }
      const movement = await applyStockMovement({
        productId,
        change,
        reason: 'MANUAL_ADJUSTMENT',
        warehouseId: body.warehouseId,
        notes: body.notes,
        actor: 'manual-adjust',
      })
      return { ok: true, movement }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fulfillment/stock/:id/adjust] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // CYCLE COUNT — physical inventory reconciliation
  // ═══════════════════════════════════════════════════════════════════
  //
  // Workflow:
  //   POST   /fulfillment/cycle-counts
  //     Create a DRAFT count + snapshot every StockLevel at the
  //     given location into items.
  //   GET    /fulfillment/cycle-counts
  //     List sessions, filterable by status.
  //   GET    /fulfillment/cycle-counts/:id
  //     Single session with all items joined to product names.
  //   POST   /fulfillment/cycle-counts/:id/start
  //     DRAFT → IN_PROGRESS.
  //   PATCH  /fulfillment/cycle-counts/:id/items/:itemId
  //     Body { countedQuantity, notes? } → status COUNTED.
  //   POST   /fulfillment/cycle-counts/:id/items/:itemId/reconcile
  //     Apply variance via applyStockMovement → status RECONCILED.
  //   POST   /fulfillment/cycle-counts/:id/items/:itemId/ignore
  //     Mark IGNORED without applying variance.
  //   POST   /fulfillment/cycle-counts/:id/complete
  //     Close the session (requires all items RECONCILED or IGNORED).
  //   POST   /fulfillment/cycle-counts/:id/cancel
  //     Abort an in-progress session.

  fastify.get('/fulfillment/cycle-counts', async (request, reply) => {
    try {
      const q = request.query as { status?: string; limit?: string }
      const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 200)
      const where: Prisma.CycleCountWhereInput = {}
      if (q.status && q.status !== 'all') where.status = q.status
      const counts = await prisma.cycleCount.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: {
          location: { select: { id: true, code: true, name: true } },
          items: { select: { status: true } },
        },
      })
      const items = counts.map((c) => {
        const counts = { PENDING: 0, COUNTED: 0, RECONCILED: 0, IGNORED: 0 } as Record<string, number>
        for (const i of c.items) counts[i.status] = (counts[i.status] ?? 0) + 1
        return {
          ...c,
          itemTotals: counts,
          totalItems: c.items.length,
          items: undefined, // strip the array; counts are enough for the list
        }
      })
      return reply.send({ success: true, counts: items })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      fastify.log.error({ err }, '[cycle-counts GET] failed')
      return reply.code(500).send({ success: false, error: msg })
    }
  })

  fastify.post<{
    Body: { locationId?: string; notes?: string; createdBy?: string }
  }>('/fulfillment/cycle-counts', async (request, reply) => {
    try {
      const b = request.body ?? {}
      if (!b.locationId) {
        return reply.code(400).send({ error: 'locationId required' })
      }
      const count = await createCycleCount({
        locationId: b.locationId,
        notes: b.notes,
        createdBy: b.createdBy,
      })
      return reply.code(201).send({ success: true, count })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('not found')) return reply.code(404).send({ error: msg })
      if (msg.includes('No stock levels')) return reply.code(409).send({ error: msg })
      fastify.log.error({ err }, '[cycle-counts POST] failed')
      return reply.code(500).send({ success: false, error: msg })
    }
  })

  fastify.get<{ Params: { id: string } }>(
    '/fulfillment/cycle-counts/:id',
    async (request, reply) => {
      try {
        const { id } = request.params
        const count = await prisma.cycleCount.findUnique({
          where: { id },
          include: {
            location: { select: { id: true, code: true, name: true } },
            items: { orderBy: { sku: 'asc' } },
          },
        })
        if (!count) {
          return reply.code(404).send({ error: 'Cycle count not found' })
        }
        // Join product names for the items.
        const productIds = Array.from(new Set(count.items.map((i) => i.productId)))
        const products = productIds.length > 0
          ? await prisma.product.findMany({
              where: { id: { in: productIds } },
              select: { id: true, name: true },
            })
          : []
        const nameById = new Map(products.map((p) => [p.id, p.name] as const))
        return reply.send({
          success: true,
          count: {
            ...count,
            items: count.items.map((it) => ({
              ...it,
              productName: nameById.get(it.productId) ?? null,
              variance:
                it.countedQuantity != null
                  ? it.countedQuantity - it.expectedQuantity
                  : null,
            })),
          },
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        fastify.log.error({ err }, '[cycle-counts/:id GET] failed')
        return reply.code(500).send({ success: false, error: msg })
      }
    },
  )

  fastify.post<{ Params: { id: string }; Body: { userId?: string } }>(
    '/fulfillment/cycle-counts/:id/start',
    async (request, reply) => {
      try {
        const { id } = request.params
        const updated = await startCycleCount(id, request.body?.userId)
        return reply.send({ success: true, count: updated })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('not found')) return reply.code(404).send({ error: msg })
        if (msg.includes('Cannot start')) return reply.code(409).send({ error: msg })
        return reply.code(500).send({ error: msg })
      }
    },
  )

  fastify.patch<{
    Params: { id: string; itemId: string }
    Body: { countedQuantity?: number; notes?: string; userId?: string }
  }>('/fulfillment/cycle-counts/:id/items/:itemId', async (request, reply) => {
    try {
      const { itemId } = request.params
      const b = request.body ?? {}
      if (b.countedQuantity == null) {
        return reply.code(400).send({ error: 'countedQuantity required' })
      }
      const updated = await recordCount({
        itemId,
        countedQuantity: b.countedQuantity,
        countedByUserId: b.userId,
        notes: b.notes,
      })
      return reply.send({ success: true, item: updated })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('not found')) return reply.code(404).send({ error: msg })
      if (msg.includes('Can only record') || msg.includes('already reconciled') || msg.includes('non-negative')) {
        return reply.code(409).send({ error: msg })
      }
      return reply.code(500).send({ error: msg })
    }
  })

  fastify.post<{
    Params: { id: string; itemId: string }
    Body: { userId?: string }
  }>('/fulfillment/cycle-counts/:id/items/:itemId/reconcile', async (request, reply) => {
    try {
      const { itemId } = request.params
      const updated = await reconcileItem({
        itemId,
        reconciledByUserId: request.body?.userId,
      })
      return reply.send({ success: true, item: updated })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('not found')) return reply.code(404).send({ error: msg })
      if (msg.includes('Can only reconcile') || msg.includes('no counted') || msg.includes('not IN_PROGRESS')) {
        return reply.code(409).send({ error: msg })
      }
      fastify.log.error({ err }, '[cycle-counts reconcile] failed')
      return reply.code(500).send({ error: msg })
    }
  })

  fastify.post<{
    Params: { id: string; itemId: string }
    Body: { userId?: string; notes?: string }
  }>('/fulfillment/cycle-counts/:id/items/:itemId/ignore', async (request, reply) => {
    try {
      const { itemId } = request.params
      const updated = await ignoreItem({
        itemId,
        reconciledByUserId: request.body?.userId,
        notes: request.body?.notes,
      })
      return reply.send({ success: true, item: updated })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('not found')) return reply.code(404).send({ error: msg })
      if (msg.includes('already reconciled')) return reply.code(409).send({ error: msg })
      return reply.code(500).send({ error: msg })
    }
  })

  fastify.post<{ Params: { id: string }; Body: { userId?: string } }>(
    '/fulfillment/cycle-counts/:id/complete',
    async (request, reply) => {
      try {
        const { id } = request.params
        const updated = await completeCycleCount(id, request.body?.userId)
        return reply.send({ success: true, count: updated })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('not found')) return reply.code(404).send({ error: msg })
        if (msg.includes('Can only complete') || msg.includes('still pending')) {
          return reply.code(409).send({ error: msg })
        }
        return reply.code(500).send({ error: msg })
      }
    },
  )

  fastify.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/fulfillment/cycle-counts/:id/cancel',
    async (request, reply) => {
      try {
        const { id } = request.params
        const updated = await cancelCycleCount({
          id,
          reason: request.body?.reason,
        })
        return reply.send({ success: true, count: updated })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('not found')) return reply.code(404).send({ error: msg })
        if (msg.includes('Cannot cancel')) return reply.code(409).send({ error: msg })
        return reply.code(500).send({ error: msg })
      }
    },
  )

  // ═══════════════════════════════════════════════════════════════════
  // OUTBOUND SHIPMENTS
  // ═══════════════════════════════════════════════════════════════════

  fastify.get('/fulfillment/shipments', async (request, reply) => {
    try {
      const q = request.query as any
      const page = Math.max(1, safeNum(q.page, 1) ?? 1)
      const pageSize = Math.min(200, safeNum(q.pageSize, 50) ?? 50)
      const where: any = {}
      if (q.status && q.status !== 'ALL') where.status = q.status
      if (q.carrierCode) where.carrierCode = q.carrierCode
      if (q.search?.trim()) {
        where.OR = [
          { trackingNumber: { contains: q.search.trim(), mode: 'insensitive' } },
          { sendcloudParcelId: { contains: q.search.trim(), mode: 'insensitive' } },
        ]
      }
      const [total, items] = await Promise.all([
        prisma.shipment.count({ where }),
        prisma.shipment.findMany({
          where,
          include: { items: true, warehouse: { select: { code: true, name: true } } },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
      ])
      return { items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fulfillment/shipments] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // O.62: Cmd+K shipment search. Returns a lean payload (no items,
  // no warehouse) shaped for the global command palette: id +
  // tracking + status + channel/marketplace + customer + ship-by so
  // operators can hop straight to the shipment from anywhere.
  // Searches across:
  //   • tracking number
  //   • sendcloud parcel id
  //   • channel order id (Amazon "123-1234567-…", eBay, Shopify name)
  //   • customer name / email
  //   • shipment items SKU
  // Capped at 12 hits because the palette UX wants instant scrolling.
  fastify.get('/fulfillment/shipments/search', async (request, reply) => {
    try {
      const q = request.query as { q?: string; limit?: string }
      const term = (q.q ?? '').trim()
      if (term.length < 2) return { items: [] }
      const limit = Math.min(20, Math.max(1, Number(q.limit ?? 12) || 12))
      const items = await prisma.shipment.findMany({
        where: {
          OR: [
            { trackingNumber: { contains: term, mode: 'insensitive' } },
            { sendcloudParcelId: { contains: term, mode: 'insensitive' } },
            { items: { some: { sku: { contains: term, mode: 'insensitive' } } } },
            {
              order: {
                OR: [
                  { channelOrderId: { contains: term, mode: 'insensitive' } },
                  { customerName: { contains: term, mode: 'insensitive' } },
                  { customerEmail: { contains: term, mode: 'insensitive' } },
                ],
              },
            },
          ],
        },
        select: {
          id: true,
          orderId: true,
          status: true,
          carrierCode: true,
          trackingNumber: true,
          createdAt: true,
          order: {
            select: {
              channel: true,
              marketplace: true,
              channelOrderId: true,
              customerName: true,
              shipByDate: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      })
      return { items }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fulfillment/shipments/search] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.get('/fulfillment/shipments/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const shipment = await prisma.shipment.findUnique({
      where: { id },
      include: { items: true, warehouse: true },
    })
    if (!shipment) return reply.code(404).send({ error: 'Shipment not found' })
    return shipment
  })

  fastify.post('/fulfillment/shipments', async (request, reply) => {
    try {
      const body = request.body as { orderId: string; warehouseId?: string; carrierCode?: string }
      if (!body.orderId) return reply.code(400).send({ error: 'orderId is required' })

      const order = await prisma.order.findUnique({
        where: { id: body.orderId },
        include: { items: true },
      })
      if (!order) return reply.code(404).send({ error: 'Order not found' })

      const warehouseId = body.warehouseId ?? (await prisma.warehouse.findFirst({ where: { isDefault: true } }))?.id

      const shipment = await prisma.shipment.create({
        data: {
          orderId: order.id,
          warehouseId,
          carrierCode: (body.carrierCode as any) ?? 'SENDCLOUD',
          status: 'DRAFT',
          items: {
            create: order.items.map((it) => ({
              orderItemId: it.id,
              productId: it.productId,
              sku: it.sku,
              quantity: it.quantity,
            })),
          },
        },
        include: { items: true },
      })
      return shipment
    } catch (error: any) {
      fastify.log.error({ err: error }, '[POST /fulfillment/shipments] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/shipments/:id/print-label', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const shipment = await prisma.shipment.findUnique({
        where: { id },
        include: {
          warehouse: true,
          order: {
            include: {
              items: {
                include: {
                  product: {
                    select: {
                      sku: true,
                      hsCode: true,
                      countryOfOrigin: true,
                      weightValue: true,
                      weightUnit: true,
                    },
                  },
                },
              },
            },
          },
        },
      })
      if (!shipment) return reply.code(404).send({ error: 'Shipment not found' })
      if (!shipment.order) {
        return reply.code(400).send({ error: 'Shipment has no order; cannot print label.' })
      }

      const order = shipment.order

      // CR.4: shared inputs that every carrier branch needs. Pulled
      // out of the Sendcloud-specific path so AMAZON_BUY_SHIPPING +
      // MANUAL can reuse the address normalization + weight resolver
      // + customs item map without duplication.

      // O.17: address preflight. Errors block (any carrier rejects on
      // bad address); warnings logged but don't block.
      {
        const { validateAddress, extractAddressFromOrder } = await import('../services/address-validation/index.js')
        const validation = validateAddress(extractAddressFromOrder(order))
        const errors = validation.issues.filter((i) => i.severity === 'error')
        if (errors.length > 0) {
          return reply.code(400).send({
            error: 'Address validation failed',
            code: 'ADDRESS_INVALID',
            issues: validation.issues,
          })
        }
        const warnings = validation.issues.filter((i) => i.severity === 'warning')
        if (warnings.length > 0) {
          fastify.log.warn({ shipmentId: id, warnings }, '[print-label] address warnings')
        }
      }

      const ship = order.shippingAddress as any
      // The address blob arrives in two shapes — Amazon-PascalCase
      // (AddressLine1, City, ...) and generic camelCase (addressLine1,
      // city, ...). Normalize once for all carriers.
      const addr = {
        name: order.customerName || 'Customer',
        address: ship?.AddressLine1 ?? ship?.addressLine1 ?? ship?.street ?? '',
        address_2: ship?.AddressLine2 ?? ship?.addressLine2 ?? undefined,
        city: ship?.City ?? ship?.city ?? '',
        postal_code: ship?.PostalCode ?? ship?.postalCode ?? '',
        country: ship?.CountryCode ?? ship?.countryCode ?? ship?.country ?? 'IT',
        country_state: ship?.StateOrRegion ?? ship?.stateOrProvince ?? ship?.state ?? undefined,
        telephone: ship?.Phone ?? ship?.phone ?? undefined,
        email: order.customerEmail || undefined,
      }

      // Weight: prefer operator-entered shipment.weightGrams (from the
      // pack station — O.13), else aggregate from product weights, else
      // default 1.5 kg as a reasonable motorcycle-gear baseline.
      let weightKg: number
      if (shipment.weightGrams && shipment.weightGrams > 0) {
        weightKg = shipment.weightGrams / 1000
      } else {
        const summed = order.items.reduce((acc, it) => {
          const w = it.product?.weightValue ? Number(it.product.weightValue) : 0
          const factor = it.product?.weightUnit === 'g' ? 0.001 : 1 // assume kg otherwise
          return acc + w * factor * it.quantity
        }, 0)
        weightKg = summed > 0 ? summed : 1.5
      }

      // CR.4 — branch on carrierCode. Default fall-through is SENDCLOUD
      // for backward compat with the O.8 contract.
      const carrierCode = shipment.carrierCode ?? 'SENDCLOUD'

      // ── MANUAL ──────────────────────────────────────────────────
      // No live carrier integration; operator pastes a tracking number
      // separately. Mark LABEL_PRINTED so the rest of the pipeline
      // (pack/ship transitions, channel pushback once a tracking
      // number is set manually) treats this shipment as ready to ship.
      // No Sendcloud / Amazon round-trip; no labelUrl set.
      if (carrierCode === 'MANUAL') {
        const updated = await prisma.shipment.update({
          where: { id },
          data: {
            status: 'LABEL_PRINTED',
            labelPrintedAt: new Date(),
            version: { increment: 1 },
          },
        })
        await prisma.trackingEvent.create({
          data: {
            shipmentId: id,
            occurredAt: new Date(),
            code: 'ANNOUNCED',
            description: 'Manual carrier — operator will paste tracking number',
            source: 'MANUAL',
          },
        })
        return {
          ...updated,
          _hint: 'No label generated. Open the shipment drawer and paste the carrier-issued tracking number to push it to the channel.',
        }
      }

      // ── AMAZON_BUY_SHIPPING ────────────────────────────────────
      // Only valid for AMAZON-channel orders. Pulls the operator's
      // ship-from address from the bound Warehouse (was hardcoded
      // Riccione before CR.4 — broken for any other warehouse).
      // amazonOrderId from order.channelOrderId; itemList from the
      // order items, mapping our internal id → Amazon's OrderItemId
      // which lives in amazonMetadata.OrderItemId.
      if (carrierCode === 'AMAZON_BUY_SHIPPING') {
        if (order.channel !== 'AMAZON') {
          return reply.code(400).send({
            error: 'Amazon Buy Shipping is only valid for Amazon-channel orders.',
            code: 'BUY_SHIPPING_WRONG_CHANNEL',
          })
        }
        const wh = shipment.warehouse
        if (!wh || !wh.addressLine1 || !wh.city || !wh.postalCode || !wh.country) {
          return reply.code(400).send({
            error: 'Bound warehouse has no address. Set ship-from in /fulfillment/stock.',
            code: 'WAREHOUSE_ADDRESS_MISSING',
          })
        }

        const itemList = order.items.map((it) => {
          const meta = it.amazonMetadata as any
          // Prefer Amazon's OrderItemId from the metadata; fall back to
          // our internal id only if missing (rare — pre-O.x rows).
          return {
            orderItemId: meta?.OrderItemId ?? meta?.orderItemId ?? it.id,
            quantity: it.quantity,
          }
        })

        const buyShipping = await import('../services/amazon-pushback/buy-shipping.js')
        let purchased
        try {
          // For Buy Shipping we go straight to createShipment with the
          // cheapest-eligible service. Caller-driven service selection
          // (rate-compare → bind via PATCH /service → print-label) is
          // wired in CR.13; today the rules engine sets carrierCode +
          // serviceCode upfront, and we honor serviceCode if present.
          const eligibility = await buyShipping.getEligibleShippingServices({
            amazonOrderId: order.channelOrderId,
            itemList,
            shipFromAddress: {
              name: wh.name,
              addressLine1: wh.addressLine1,
              addressLine2: wh.addressLine2 ?? undefined,
              city: wh.city,
              postalCode: wh.postalCode,
              countryCode: wh.country,
            },
            weightGrams: Math.round(weightKg * 1000),
          })
          if (eligibility.length === 0) {
            return reply.code(400).send({
              error: 'No eligible Amazon Buy Shipping services for this order.',
              code: 'NO_ELIGIBLE_SERVICES',
            })
          }
          // Honor pre-bound serviceCode if present, else cheapest.
          const chosen = shipment.serviceCode
            ? eligibility.find((s) => s.shippingServiceOfferId === shipment.serviceCode) ?? eligibility[0]
            : eligibility.reduce((a, b) => (a.rate.amount <= b.rate.amount ? a : b))
          purchased = await buyShipping.createShipment(
            {
              amazonOrderId: order.channelOrderId,
              itemList,
              shipFromAddress: {
                name: wh.name,
                addressLine1: wh.addressLine1,
                addressLine2: wh.addressLine2 ?? undefined,
                city: wh.city,
                postalCode: wh.postalCode,
                countryCode: wh.country,
              },
              weightGrams: Math.round(weightKg * 1000),
            },
            chosen.shippingServiceOfferId,
          )
        } catch (e: any) {
          fastify.log.warn({ err: e, shipmentId: id }, '[print-label] Buy Shipping rejected')
          return reply.code(502).send({
            error: `Amazon Buy Shipping: ${e?.message ?? String(e)}`,
            code: 'BUY_SHIPPING_FAILED',
          })
        }

        const updated = await prisma.shipment.update({
          where: { id },
          data: {
            status: 'LABEL_PRINTED',
            trackingNumber: purchased.trackingId,
            // Amazon doesn't expose a public tracking URL for Buy
            // Shipping pre-pickup; the tracking page on Seller Central
            // requires auth. Leave trackingUrl null until carrier
            // status returns a public deeplink.
            trackingUrl: null,
            // Buy Shipping returns base64 PDF, not a hosted URL. We
            // store a data: URL so the existing print flow can stream
            // it; CR.16 will move this to S3 with a presigned URL.
            labelUrl: purchased.labelData
              ? `data:application/pdf;base64,${purchased.labelData}`
              : null,
            serviceCode: purchased.shippingServiceId,
            serviceName: purchased.carrierName,
            costCents: Math.round(purchased.rate.amount * 100),
            currencyCode: purchased.rate.currencyCode,
            labelPrintedAt: new Date(),
            version: { increment: 1 },
          },
        })

        await prisma.trackingEvent.create({
          data: {
            shipmentId: id,
            occurredAt: new Date(),
            code: 'ANNOUNCED',
            description: `Buy Shipping label purchased (${purchased.carrierName})`,
            source: 'AMAZON_BUY_SHIPPING',
          },
        })

        const { auditLogService } = await import('../services/audit-log.service.js')
        void auditLogService.write({
          entityType: 'Shipment',
          entityId: id,
          action: 'print-label',
          before: { status: shipment.status },
          after: {
            status: 'LABEL_PRINTED',
            trackingNumber: purchased.trackingId,
            carrierCode: 'AMAZON_BUY_SHIPPING',
          },
          metadata: {
            dryRun: purchased.dryRun ?? false,
            carrier: purchased.carrierName,
            costCents: Math.round(purchased.rate.amount * 100),
            weightKg,
            country: addr.country,
          },
        })

        return updated
      }

      // ── SENDCLOUD (default) ─────────────────────────────────────
      // O.8: real Sendcloud call (replaces the B.4 stub). The
      // sendcloud module returns mock data when
      // NEXUS_ENABLE_SENDCLOUD_REAL=false (the default), so this path
      // works end-to-end in dryRun mode without ever touching
      // Sendcloud. resolveCredentials() throws SendcloudError with a
      // clean 400 message if the carrier isn't connected.
      const sendcloud = await import('../services/sendcloud/index.js')
      let creds
      try {
        creds = await sendcloud.resolveCredentials()
      } catch (e: any) {
        if (e instanceof sendcloud.SendcloudError) {
          return reply.code(e.status).send({ error: e.message, code: e.code })
        }
        throw e
      }

      // Parcel items for customs declaration. Sendcloud uses these for
      // international shipments + ignores for domestic. HS code +
      // country-of-origin live on Product (per schema comment 1746).
      const parcelItems = order.items.map((it) => ({
        description: it.product?.sku ?? it.sku,
        quantity: it.quantity,
        weight: '0.100', // per-line weight rarely matters for our use
        value: Number(it.price).toFixed(2),
        hs_code: it.product?.hsCode ?? undefined,
        origin_country: it.product?.countryOfOrigin ?? undefined,
        sku: it.sku,
      }))

      // Service map lookup: which Sendcloud shipping_method to use for
      // this (channel, marketplace). Returns null when no rule maps —
      // Sendcloud auto-picks based on dimensions + destination.
      const serviceId = await sendcloud.resolveServiceMap(order.channel, order.marketplace)

      // CR.11: sender_address from the bound Warehouse. Sendcloud
      // uses the integration default when omitted; passing an explicit
      // ID lets multi-warehouse operators ship from the right origin.
      const senderId = shipment.warehouse?.sendcloudSenderId ?? undefined

      const input = {
        ...addr,
        weight: weightKg.toFixed(3),
        order_number: order.channelOrderId,
        total_order_value: Number(order.totalPrice).toFixed(2),
        total_order_value_currency: order.currencyCode ?? 'EUR',
        shipment: serviceId ? { id: serviceId } : undefined,
        sender_address: senderId,
        parcel_items: parcelItems.length > 0 ? parcelItems : undefined,
        external_reference: shipment.id,
        request_label: true,
      }

      let parcel
      try {
        parcel = await sendcloud.createParcel(creds, input)
      } catch (e: any) {
        if (e instanceof sendcloud.SendcloudError) {
          fastify.log.warn({ err: e, shipmentId: id }, '[print-label] Sendcloud rejected')
          return reply.code(502).send({
            error: `Sendcloud: ${e.message}`,
            code: e.code,
          })
        }
        throw e
      }

      const labelUrl = parcel.label?.normal_printer?.[0] ?? null

      const updated = await prisma.shipment.update({
        where: { id },
        data: {
          status: 'LABEL_PRINTED',
          sendcloudParcelId: String(parcel.id),
          trackingNumber: parcel.tracking_number,
          trackingUrl: parcel.tracking_url,
          labelUrl,
          serviceCode: parcel.shipment?.name ?? null,
          serviceName: parcel.shipment?.name ?? null,
          labelPrintedAt: new Date(),
          version: { increment: 1 },
        },
      })

      // CR.3: bump Carrier.lastUsedAt so the marketplace UI's "active"
      // sort surfaces recently-used carriers first. Fire-and-forget;
      // a counter blip shouldn't fail label-print.
      void prisma.carrier
        .updateMany({
          where: { code: 'SENDCLOUD' },
          data: { lastUsedAt: new Date() },
        })
        .catch(() => { /* */ })

      // Seed the timeline with the initial ANNOUNCED event so the
      // drawer / branded tracking page have something to render before
      // the first carrier scan webhook arrives.
      await prisma.trackingEvent.create({
        data: {
          shipmentId: id,
          occurredAt: new Date(),
          code: 'ANNOUNCED',
          description: 'Label generated, awaiting carrier pickup',
          source: 'SENDCLOUD',
          carrierRawCode: String(parcel.status?.id ?? ''),
        },
      })

      // O.39: audit. Includes mode (real vs dryRun) so post-incident
      // forensics can distinguish "we sent this to Sendcloud" from
      // "we mocked this in dryRun".
      const { auditLogService } = await import('../services/audit-log.service.js')
      const mode = sendcloud.getSendcloudMode()
      void auditLogService.write({
        entityType: 'Shipment',
        entityId: id,
        action: 'print-label',
        before: { status: shipment.status },
        after: {
          status: 'LABEL_PRINTED',
          sendcloudParcelId: String(parcel.id),
          trackingNumber: parcel.tracking_number,
        },
        metadata: { dryRun: mode.dryRun, env: mode.env, weightKg, country: addr.country, carrierCode: 'SENDCLOUD' },
      })

      return updated
    } catch (error: any) {
      fastify.log.error({ err: error }, '[print-label] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── O.21: Public branded tracking ──────────────────────────────────
  // GET /api/public/track/:trackingNumber — no auth, rate-limited.
  // Powers the customer-facing /track/[number] page so direct-channel
  // (Shopify, Woo) customers can follow their package without an
  // account. Marketplace customers (Amazon, eBay) keep using the
  // marketplace's own tracking — this surface is for direct sales.
  //
  // Returns: minimal PII-safe payload with status, ETA, last scan,
  // and the timeline. Customer-facing — no order ID, no SKUs, no
  // pricing. The carrier event descriptions are operator-facing and
  // may need translation; v0 surfaces them as-is.
  fastify.get('/api/public/track/:trackingNumber', async (request, reply) => {
    try {
      const { trackingNumber } = request.params as { trackingNumber: string }
      if (!trackingNumber || trackingNumber.length < 6 || trackingNumber.length > 64) {
        return reply.code(400).send({ error: 'Invalid tracking number' })
      }
      const shipment = await prisma.shipment.findFirst({
        where: { trackingNumber },
        select: {
          id: true,
          status: true,
          carrierCode: true,
          trackingNumber: true,
          trackingUrl: true,
          shippedAt: true,
          deliveredAt: true,
          order: {
            select: {
              latestDeliveryDate: true,
              shippingAddress: true,
            },
          },
          trackingEvents: {
            orderBy: { occurredAt: 'desc' },
            take: 30,
            select: {
              id: true,
              occurredAt: true,
              code: true,
              description: true,
              location: true,
            },
          },
        },
      })
      if (!shipment) return reply.code(404).send({ error: 'Tracking number not found' })

      // City-only PII — full address would be over-disclosure on a
      // public URL. Customer already knows their own city; we surface
      // it so they can confirm the carrier is heading to the right
      // place.
      const ship = shipment.order?.shippingAddress as any
      const destCity = ship?.City ?? ship?.city ?? null

      reply.header('Cache-Control', 'public, max-age=300') // 5 min
      return {
        trackingNumber: shipment.trackingNumber,
        carrier: shipment.carrierCode,
        carrierTrackingUrl: shipment.trackingUrl,
        status: shipment.status,
        shippedAt: shipment.shippedAt,
        deliveredAt: shipment.deliveredAt,
        estimatedDelivery: shipment.order?.latestDeliveryDate ?? null,
        destinationCity: destCity,
        events: shipment.trackingEvents,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[public/track] failed')
      return reply.code(500).send({ error: 'Tracking unavailable' })
    }
  })

  // ── O.37: pack slip print ──────────────────────────────────────────
  // GET /api/fulfillment/shipments/:id/pack-slip.html — server-rendered
  // printable HTML pack slip. Operator opens in a new tab + Cmd+P.
  // Contains: Xavia branding, order #, ship-to, line items with
  // quantities + SKUs, weight + dimensions, carrier/service, barcode-
  // friendly tracking. Designed to print on standard A4 with the line
  // items as a table the picker uses to verify before sealing the box.
  fastify.get('/fulfillment/shipments/:id/pack-slip.html', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const shipment = await prisma.shipment.findUnique({
        where: { id },
        include: {
          items: true,
          warehouse: { select: { code: true, name: true } },
          order: {
            select: {
              channelOrderId: true,
              channel: true,
              customerName: true,
              shippingAddress: true,
              currencyCode: true,
            },
          },
        },
      })
      if (!shipment) return reply.code(404).send({ error: 'Shipment not found' })

      const ship = (shipment.order?.shippingAddress ?? {}) as any
      const escape = (s: string) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[c]!)

      const html = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8" />
<title>Pack slip · ${escape(shipment.order?.channelOrderId ?? shipment.id)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: Inter, -apple-system, sans-serif; color: #0f172a; padding: 0; margin: 0; }
  .header { display: flex; justify-content: space-between; align-items: start; border-bottom: 2px solid #0f172a; padding-bottom: 12px; margin-bottom: 18px; }
  .brand { font-size: 28px; font-weight: 700; }
  .meta { text-align: right; font-size: 12px; color: #475569; }
  .meta .order-id { font-size: 14px; color: #0f172a; font-weight: 600; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 18px; }
  .block h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #64748b; margin: 0 0 4px 0; }
  .block p { margin: 0; line-height: 1.4; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 12px; }
  th { text-align: left; background: #f1f5f9; padding: 8px; border-bottom: 1px solid #cbd5e1; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #475569; }
  td { padding: 10px 8px; border-bottom: 1px solid #e2e8f0; }
  td.qty, th.qty { text-align: center; width: 80px; }
  td.sku { font-family: ui-monospace, monospace; font-size: 12px; }
  td.check { width: 40px; }
  .check-box { width: 14px; height: 14px; border: 1.5px solid #94a3b8; display: inline-block; vertical-align: middle; }
  .footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #e2e8f0; display: flex; justify-content: space-between; font-size: 11px; color: #64748b; }
  .tracking { font-family: ui-monospace, monospace; font-weight: 600; color: #0f172a; }
  @media print {
    body { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  }
</style>
</head>
<body>
  <div class="header">
    <div>
      <div class="brand">Xavia</div>
      <div style="font-size:11px;color:#64748b;margin-top:4px;">Pack slip · ${escape(shipment.order?.channel ?? '')}</div>
    </div>
    <div class="meta">
      <div class="order-id">#${escape(shipment.order?.channelOrderId ?? shipment.id.slice(0, 8))}</div>
      <div>Shipment ${escape(shipment.id.slice(0, 12))}</div>
      ${shipment.warehouse ? `<div>${escape(shipment.warehouse.code)}</div>` : ''}
      <div>${new Date().toLocaleDateString('it-IT')}</div>
    </div>
  </div>

  <div class="grid">
    <div class="block">
      <h3>Ship to</h3>
      <p><strong>${escape(shipment.order?.customerName ?? 'Customer')}</strong></p>
      <p>${escape(ship.AddressLine1 ?? ship.addressLine1 ?? ship.street ?? '')}</p>
      ${ship.AddressLine2 || ship.addressLine2 ? `<p>${escape(ship.AddressLine2 ?? ship.addressLine2)}</p>` : ''}
      <p>${escape(ship.PostalCode ?? ship.postalCode ?? '')} ${escape(ship.City ?? ship.city ?? '')}</p>
      <p>${escape(ship.StateOrRegion ?? ship.stateOrProvince ?? ship.state ?? '')} ${escape(ship.CountryCode ?? ship.countryCode ?? ship.country ?? '')}</p>
    </div>
    <div class="block">
      <h3>Shipment</h3>
      <p>Carrier: <strong>${escape(shipment.carrierCode)}</strong></p>
      ${shipment.serviceName ? `<p>Service: ${escape(shipment.serviceName)}</p>` : ''}
      ${shipment.weightGrams ? `<p>Weight: ${(shipment.weightGrams / 1000).toFixed(2)} kg</p>` : ''}
      ${shipment.lengthCm && shipment.widthCm && shipment.heightCm ? `<p>Box: ${shipment.lengthCm} × ${shipment.widthCm} × ${shipment.heightCm} cm</p>` : ''}
      ${shipment.trackingNumber ? `<p>Tracking: <span class="tracking">${escape(shipment.trackingNumber)}</span></p>` : ''}
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th class="check">✓</th>
        <th>Item</th>
        <th class="sku">SKU</th>
        <th class="qty">Qty</th>
      </tr>
    </thead>
    <tbody>
      ${shipment.items.map((it) => `
        <tr>
          <td class="check"><span class="check-box"></span></td>
          <td>${escape(it.sku)}</td>
          <td class="sku">${escape(it.sku)}</td>
          <td class="qty">${it.quantity}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>

  <div class="footer">
    <div>Total ${shipment.items.reduce((n, i) => n + i.quantity, 0)} unit(s) · ${shipment.items.length} SKU(s)</div>
    <div>Picker initials: ____________</div>
  </div>
</body>
</html>`

      reply
        .header('Content-Type', 'text/html; charset=utf-8')
        .header('Cache-Control', 'no-store')
        .send(html)
    } catch (error: any) {
      fastify.log.error({ err: error }, '[shipments/:id/pack-slip] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── O.36: holds queue — release shipment from ON_HOLD ──────────────
  // POST /api/fulfillment/shipments/:id/release — operator clears the
  // hold (after review) and the shipment transitions back to DRAFT.
  fastify.post('/fulfillment/shipments/:id/release', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const shipment = await prisma.shipment.findUnique({ where: { id } })
      if (!shipment) return reply.code(404).send({ error: 'Shipment not found' })
      if (shipment.status !== ('ON_HOLD' as any)) {
        return reply.code(400).send({ error: `Shipment is not on hold (status: ${shipment.status})` })
      }
      const updated = await prisma.shipment.update({
        where: { id },
        data: {
          status: 'DRAFT',
          heldAt: null,
          heldReason: null,
          version: { increment: 1 },
        },
      })
      const { publishOutboundEvent } = await import('../services/outbound-events.service.js')
      publishOutboundEvent({ type: 'shipment.updated', shipmentId: id, status: 'DRAFT', ts: Date.now() })
      // O.39: audit log — fail-open per the service contract.
      const { auditLogService } = await import('../services/audit-log.service.js')
      void auditLogService.write({
        entityType: 'Shipment',
        entityId: id,
        action: 'release',
        before: { status: 'ON_HOLD', heldReason: shipment.heldReason },
        after: { status: 'DRAFT' },
      })
      return updated
    } catch (error: any) {
      fastify.log.error({ err: error }, '[shipments/:id/release] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // POST /api/fulfillment/shipments/:id/hold — operator puts a draft
  // on hold manually (e.g., suspect address, fraud check, customer
  // contacted us). Body { reason: string } persists the reason.
  fastify.post('/fulfillment/shipments/:id/hold', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as { reason?: string }
      const shipment = await prisma.shipment.findUnique({ where: { id } })
      if (!shipment) return reply.code(404).send({ error: 'Shipment not found' })
      if (['LABEL_PRINTED', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED'].includes(shipment.status)) {
        return reply.code(400).send({
          error: `Cannot hold a shipment in status ${shipment.status}. Void the label first if needed.`,
        })
      }
      const heldReason = body.reason?.trim() || 'Manually held by operator'
      const updated = await prisma.shipment.update({
        where: { id },
        data: {
          status: 'ON_HOLD' as any,
          heldAt: new Date(),
          heldReason,
          version: { increment: 1 },
        },
      })
      const { publishOutboundEvent } = await import('../services/outbound-events.service.js')
      publishOutboundEvent({ type: 'shipment.updated', shipmentId: id, status: 'ON_HOLD', ts: Date.now() })
      const { auditLogService } = await import('../services/audit-log.service.js')
      void auditLogService.write({
        entityType: 'Shipment',
        entityId: id,
        action: 'hold',
        before: { status: shipment.status },
        after: { status: 'ON_HOLD', heldReason },
      })
      return updated
    } catch (error: any) {
      fastify.log.error({ err: error }, '[shipments/:id/hold] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── O.40: bulk hold + bulk release ─────────────────────────────────
  // Power-user paths for the holds queue. Same eligibility gates as
  // the single endpoints, applied per-shipment with a per-row outcome
  // returned to the caller.
  fastify.post('/fulfillment/shipments/bulk-hold', async (request, reply) => {
    try {
      const body = request.body as { shipmentIds?: string[]; reason?: string }
      const ids = Array.isArray(body.shipmentIds) ? body.shipmentIds : []
      if (ids.length === 0) return reply.code(400).send({ error: 'shipmentIds[] required' })
      if (ids.length > 200) return reply.code(400).send({ error: 'Max 200 shipments per call' })
      const reason = body.reason?.trim() || 'Bulk-held by operator'
      const heldAt = new Date()

      const before = await prisma.shipment.findMany({
        where: { id: { in: ids } },
        select: { id: true, status: true },
      })
      const eligibleIds = before
        .filter((s) => !['LABEL_PRINTED', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'ON_HOLD'].includes(s.status))
        .map((s) => s.id)

      if (eligibleIds.length === 0) {
        return { held: 0, skipped: ids.length }
      }

      const result = await prisma.shipment.updateMany({
        where: { id: { in: eligibleIds } },
        data: { status: 'ON_HOLD' as any, heldAt, heldReason: reason, version: { increment: 1 } },
      })

      // Bus + audit (per-row).
      const { publishOutboundEvent } = await import('../services/outbound-events.service.js')
      const { auditLogService } = await import('../services/audit-log.service.js')
      for (const sid of eligibleIds) {
        publishOutboundEvent({ type: 'shipment.updated', shipmentId: sid, status: 'ON_HOLD', ts: Date.now() })
      }
      void auditLogService.writeMany(
        eligibleIds.map((sid) => {
          const prev = before.find((b) => b.id === sid)
          return {
            entityType: 'Shipment',
            entityId: sid,
            action: 'hold',
            before: { status: prev?.status },
            after: { status: 'ON_HOLD', heldReason: reason },
            metadata: { bulk: true },
          }
        }),
      )
      return { held: result.count, skipped: ids.length - eligibleIds.length }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[shipments/bulk-hold] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/shipments/bulk-release', async (request, reply) => {
    try {
      const body = request.body as { shipmentIds?: string[] }
      const ids = Array.isArray(body.shipmentIds) ? body.shipmentIds : []
      if (ids.length === 0) return reply.code(400).send({ error: 'shipmentIds[] required' })
      if (ids.length > 200) return reply.code(400).send({ error: 'Max 200 shipments per call' })

      const before = await prisma.shipment.findMany({
        where: { id: { in: ids }, status: 'ON_HOLD' as any },
        select: { id: true, heldReason: true },
      })
      const eligibleIds = before.map((s) => s.id)
      if (eligibleIds.length === 0) {
        return { released: 0, skipped: ids.length }
      }

      const result = await prisma.shipment.updateMany({
        where: { id: { in: eligibleIds } },
        data: { status: 'DRAFT', heldAt: null, heldReason: null, version: { increment: 1 } },
      })

      const { publishOutboundEvent } = await import('../services/outbound-events.service.js')
      const { auditLogService } = await import('../services/audit-log.service.js')
      for (const sid of eligibleIds) {
        publishOutboundEvent({ type: 'shipment.updated', shipmentId: sid, status: 'DRAFT', ts: Date.now() })
      }
      void auditLogService.writeMany(
        eligibleIds.map((sid) => {
          const prev = before.find((b) => b.id === sid)
          return {
            entityType: 'Shipment',
            entityId: sid,
            action: 'release',
            before: { status: 'ON_HOLD', heldReason: prev?.heldReason },
            after: { status: 'DRAFT' },
            metadata: { bulk: true },
          }
        }),
      )
      return { released: result.count, skipped: ids.length - eligibleIds.length }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[shipments/bulk-release] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── O.32: SSE event stream ──────────────────────────────────────────
  // GET /api/fulfillment/outbound/events — long-lived text/event-stream
  // connection that pushes shipment events to subscribed browsers.
  // Hooked from the Sendcloud webhook (O.7) + tracking-pushback retry
  // job (O.12) so a real-world transition (Sendcloud-reported delivery,
  // channel ack from Amazon/eBay/Woo) auto-refreshes every open Pending
  // tab within ~200ms of the server-side write.
  //
  // Pattern matches /api/listings/events (S.4): heartbeat every 25s
  // keeps the connection alive past most proxy idle timeouts; client
  // EventSource auto-reconnects on transient drops.
  fastify.get('/fulfillment/outbound/events', async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    reply.raw.write(
      `event: ping\ndata: ${JSON.stringify({ ts: Date.now(), connected: true })}\n\n`,
    )

    const { subscribeOutboundEvents } = await import('../services/outbound-events.service.js')
    const send = (event: any) => {
      try {
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      } catch {
        // Connection dead — cleanup runs in the close handler.
      }
    }

    const unsubscribe = subscribeOutboundEvents(send)
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: heartbeat ${Date.now()}\n\n`)
      } catch {
        // ignore
      }
    }, 25_000)

    request.raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })

    await new Promise(() => {})
  })

  // ── O.31: Outbound analytics ────────────────────────────────────────
  // GET /api/fulfillment/outbound/analytics?days=30
  // Aggregates: orders shipped, time-to-ship percentiles (median /
  // p95 / p99), late rate, average shipping cost, per-carrier
  // breakdown, daily trend. Powers the analytics dashboard page.
  fastify.get('/fulfillment/outbound/analytics', async (request, reply) => {
    try {
      const q = request.query as { days?: string }
      const days = Math.min(365, Math.max(1, Number(q.days) || 30))
      const since = new Date(Date.now() - days * 86_400_000)

      // Pull shipped shipments in window with the fields we need.
      const shipments = await prisma.shipment.findMany({
        where: {
          shippedAt: { gte: since },
        },
        select: {
          id: true,
          carrierCode: true,
          status: true,
          costCents: true,
          weightGrams: true,
          shippedAt: true,
          deliveredAt: true,
          createdAt: true,
          // O.56: picker performance source fields. pickedBy + packedBy
          // are operator strings captured at the picked / packed
          // transitions; createdAt → packedAt is the cycle the
          // leaderboard ranks.
          pickedBy: true,
          packedBy: true,
          packedAt: true,
          order: { select: { purchaseDate: true, shipByDate: true, channel: true, marketplace: true } },
        },
      })

      // Time-to-ship in hours (purchaseDate → shippedAt).
      const timeToShipHours: number[] = []
      // Late count: shipment where shippedAt > shipByDate.
      let lateCount = 0
      let onTimeCount = 0
      let totalCostCents = 0
      let costsCounted = 0
      const byCarrier: Record<string, { count: number; totalCostCents: number; lateCount: number }> = {}
      const byChannel: Record<string, number> = {}
      // O.72: per-channel + per-marketplace SLA. Channel-level alone
      // misses that Amazon-IT-Prime is much stricter than Shopify;
      // an aggregate "5% late rate" can hide an Amazon-Prime-only
      // crisis. Marketplace key = "AMAZON:IT" / "EBAY:DE" / etc.,
      // falling back to "AMAZON:?" when marketplace is null.
      const byChannelSLA: Record<
        string,
        { count: number; lateCount: number; onTimeCount: number; sumHours: number; samples: number }
      > = {}
      const byMarketplaceSLA: Record<
        string,
        { count: number; lateCount: number; onTimeCount: number; channel: string; marketplace: string | null }
      > = {}
      // Daily trend — yyyy-mm-dd → ships
      const dailyShips: Record<string, number> = {}

      for (const s of shipments) {
        if (s.shippedAt && s.order?.purchaseDate) {
          timeToShipHours.push(
            (s.shippedAt.getTime() - s.order.purchaseDate.getTime()) / 3_600_000,
          )
        }
        if (s.shippedAt && s.order?.shipByDate) {
          if (s.shippedAt.getTime() > s.order.shipByDate.getTime()) lateCount++
          else onTimeCount++
        }
        if (s.costCents != null) {
          totalCostCents += s.costCents
          costsCounted++
        }
        const cc = s.carrierCode as string
        if (!byCarrier[cc]) byCarrier[cc] = { count: 0, totalCostCents: 0, lateCount: 0 }
        byCarrier[cc].count++
        if (s.costCents != null) byCarrier[cc].totalCostCents += s.costCents
        if (s.shippedAt && s.order?.shipByDate && s.shippedAt > s.order.shipByDate) {
          byCarrier[cc].lateCount++
        }
        if (s.order?.channel) {
          const k = s.order.channel as string
          byChannel[k] = (byChannel[k] ?? 0) + 1
          // O.72: SLA by channel. Same gating as the global lateCount
          // (need both shippedAt + shipByDate to compute on-time vs
          // late); count tallies all shipped regardless.
          if (!byChannelSLA[k]) byChannelSLA[k] = { count: 0, lateCount: 0, onTimeCount: 0, sumHours: 0, samples: 0 }
          byChannelSLA[k].count++
          if (s.shippedAt && s.order?.shipByDate) {
            if (s.shippedAt.getTime() > s.order.shipByDate.getTime()) byChannelSLA[k].lateCount++
            else byChannelSLA[k].onTimeCount++
          }
          if (s.shippedAt && s.order?.purchaseDate) {
            byChannelSLA[k].sumHours += (s.shippedAt.getTime() - s.order.purchaseDate.getTime()) / 3_600_000
            byChannelSLA[k].samples++
          }
          // O.72: marketplace breakdown — surfaces Amazon-IT vs
          // Amazon-DE divergence inside one channel.
          const mpKey = `${k}:${s.order?.marketplace ?? '?'}`
          if (!byMarketplaceSLA[mpKey]) {
            byMarketplaceSLA[mpKey] = {
              count: 0,
              lateCount: 0,
              onTimeCount: 0,
              channel: k,
              marketplace: s.order?.marketplace ?? null,
            }
          }
          byMarketplaceSLA[mpKey].count++
          if (s.shippedAt && s.order?.shipByDate) {
            if (s.shippedAt.getTime() > s.order.shipByDate.getTime()) byMarketplaceSLA[mpKey].lateCount++
            else byMarketplaceSLA[mpKey].onTimeCount++
          }
        }
        if (s.shippedAt) {
          const day = s.shippedAt.toISOString().slice(0, 10)
          dailyShips[day] = (dailyShips[day] ?? 0) + 1
        }
      }

      const sortedTimes = [...timeToShipHours].sort((a, b) => a - b)
      const pct = (p: number) =>
        sortedTimes.length === 0
          ? null
          : sortedTimes[Math.min(sortedTimes.length - 1, Math.floor(sortedTimes.length * p))]
      const totalShippedWithSlA = lateCount + onTimeCount
      const lateRate = totalShippedWithSlA > 0 ? lateCount / totalShippedWithSlA : null

      // Build daily series sorted ascending; fill gaps with 0 so the
      // chart renders a continuous line.
      const trend: Array<{ date: string; ships: number }> = []
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10)
        trend.push({ date: d, ships: dailyShips[d] ?? 0 })
      }

      // O.56: picker performance aggregation. For each non-null
      // packedBy operator, accumulate count + cycle-time samples
      // (createdAt → packedAt, in minutes). pickedBy is captured
      // separately but currently most operators do pick + pack as
      // one step, so packedBy is the dominant signal; merging both
      // would double-count when they're the same person.
      const byPicker: Record<string, { count: number; cycleMinutes: number[] }> = {}
      for (const s of shipments) {
        const who = s.packedBy ?? s.pickedBy
        if (!who) continue
        if (!byPicker[who]) byPicker[who] = { count: 0, cycleMinutes: [] }
        byPicker[who].count++
        if (s.packedAt) {
          const cycle = (s.packedAt.getTime() - s.createdAt.getTime()) / 60_000
          if (cycle > 0 && cycle < 24 * 60 * 7) {
            // Cap at 7 days to filter out shipments held for special
            // reasons that would skew medians.
            byPicker[who].cycleMinutes.push(cycle)
          }
        }
      }
      const pickersOut = Object.entries(byPicker).map(([who, v]) => {
        const sorted = [...v.cycleMinutes].sort((a, b) => a - b)
        const median = sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)]
        return {
          operator: who,
          count: v.count,
          medianCycleMinutes: median,
          samples: sorted.length,
        }
      }).sort((a, b) => b.count - a.count)

      const carriersOut = Object.entries(byCarrier).map(([code, v]) => ({
        carrierCode: code,
        count: v.count,
        totalCostCents: v.totalCostCents,
        avgCostCents: v.count > 0 ? Math.round(v.totalCostCents / v.count) : null,
        lateCount: v.lateCount,
        lateRate: v.count > 0 ? v.lateCount / v.count : null,
      })).sort((a, b) => b.count - a.count)

      // O.38: cost-savings + reliability insights. Compares carriers
      // against the cheapest one with material volume; flags any
      // carrier whose late-rate is materially worse than the median.
      const insights: Array<{
        kind: 'cost' | 'reliability'
        severity: 'info' | 'warning'
        message: string
        carrierCode?: string
        savingsCentsPerMonth?: number
      }> = []
      const carriersWithVolume = carriersOut.filter(
        (c) => c.count >= 5 && c.avgCostCents != null,
      )
      if (carriersWithVolume.length >= 2) {
        const cheapest = carriersWithVolume.reduce((a, b) =>
          (a.avgCostCents ?? Infinity) < (b.avgCostCents ?? Infinity) ? a : b,
        )
        for (const c of carriersWithVolume) {
          if (c.carrierCode === cheapest.carrierCode) continue
          if (c.avgCostCents == null || cheapest.avgCostCents == null) continue
          const delta = c.avgCostCents - cheapest.avgCostCents
          if (delta < 50) continue // <€0.50 — noise
          // Project monthly savings if everything currently going
          // through `c` shifted to `cheapest`. Assumes the cheaper
          // carrier can absorb (won't always be true, but the insight
          // is "explore this", not "do this blindly").
          const monthlyShips = (c.count / days) * 30
          const savingsCentsPerMonth = Math.round(monthlyShips * delta)
          if (savingsCentsPerMonth >= 1000) {
            // ≥ €10/mo — worth surfacing
            insights.push({
              kind: 'cost',
              severity: savingsCentsPerMonth >= 5000 ? 'warning' : 'info',
              message: `Switch ${c.carrierCode} → ${cheapest.carrierCode}: avg €${(delta / 100).toFixed(2)}/shipment cheaper, projected savings ~€${(savingsCentsPerMonth / 100).toFixed(0)}/month at current volume.`,
              carrierCode: c.carrierCode,
              savingsCentsPerMonth,
            })
          }
        }
        // Reliability insight: any carrier with > 8% late rate when
        // median is sub-3%.
        const lateRates = carriersWithVolume
          .map((c) => c.lateRate)
          .filter((v): v is number => v != null)
          .sort((a, b) => a - b)
        const medianLate = lateRates.length
          ? lateRates[Math.floor(lateRates.length / 2)]
          : 0
        for (const c of carriersWithVolume) {
          if (c.lateRate != null && c.lateRate > 0.08 && c.lateRate > medianLate * 2) {
            insights.push({
              kind: 'reliability',
              severity: 'warning',
              message: `${c.carrierCode} is running ${(c.lateRate * 100).toFixed(0)}% late vs ${(medianLate * 100).toFixed(0)}% median. Consider routing more orders away from it.`,
              carrierCode: c.carrierCode,
            })
          }
        }
      }

      return {
        windowDays: days,
        totals: {
          shipped: shipments.length,
          totalCostCents,
          avgCostCents: costsCounted > 0 ? Math.round(totalCostCents / costsCounted) : null,
        },
        timeToShipHours: {
          median: pct(0.5),
          p95: pct(0.95),
          p99: pct(0.99),
          count: sortedTimes.length,
        },
        sla: {
          onTime: onTimeCount,
          late: lateCount,
          lateRate,
        },
        byCarrier: carriersOut,
        byChannel,
        // O.72: SLA dimensions. byChannelSLA arrays are sorted by
        // count desc so the table renders busy channels first.
        byChannelSLA: Object.entries(byChannelSLA)
          .map(([channel, v]) => ({
            channel,
            count: v.count,
            lateCount: v.lateCount,
            onTimeCount: v.onTimeCount,
            lateRate: v.onTimeCount + v.lateCount > 0 ? v.lateCount / (v.onTimeCount + v.lateCount) : null,
            avgTimeToShipHours: v.samples > 0 ? v.sumHours / v.samples : null,
          }))
          .sort((a, b) => b.count - a.count),
        byMarketplaceSLA: Object.values(byMarketplaceSLA)
          .map((v) => ({
            channel: v.channel,
            marketplace: v.marketplace,
            count: v.count,
            lateCount: v.lateCount,
            onTimeCount: v.onTimeCount,
            lateRate: v.onTimeCount + v.lateCount > 0 ? v.lateCount / (v.onTimeCount + v.lateCount) : null,
          }))
          .sort((a, b) => b.count - a.count),
        byPicker: pickersOut,
        trend,
        insights,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[outbound/analytics] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── O.29: Multi-package — split shipment ────────────────────────────
  // POST /api/fulfillment/shipments/:id/split { items: [{ shipmentItemId,
  // quantity }] } — moves the specified quantities to a new sibling
  // shipment for the same order. Used for orders that need multiple
  // packages (e.g., helmet + jacket = 2 boxes). Both shipments share
  // the order; tracking/labels are independent.
  fastify.post('/fulfillment/shipments/:id/split', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as {
        items?: Array<{ shipmentItemId?: string; quantity?: number }>
      }
      if (!body.items?.length) {
        return reply.code(400).send({ error: 'items[] required' })
      }
      const shipment = await prisma.shipment.findUnique({
        where: { id },
        include: { items: true },
      })
      if (!shipment) return reply.code(404).send({ error: 'Shipment not found' })
      // Only allow splitting before label is printed.
      if (['LABEL_PRINTED', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED'].includes(shipment.status)) {
        return reply.code(400).send({
          error: 'Cannot split a shipment after the label is printed. Void the label first.',
        })
      }
      if (!shipment.orderId) {
        return reply.code(400).send({ error: 'Shipment has no order; cannot split.' })
      }

      // Validate the requested splits and decide what to move vs decrement.
      const moves: Array<{ source: typeof shipment.items[number]; takeQty: number }> = []
      for (const req of body.items) {
        if (!req.shipmentItemId || !req.quantity || req.quantity <= 0) {
          return reply.code(400).send({ error: 'Each items[] entry needs shipmentItemId + positive quantity' })
        }
        const src = shipment.items.find((it) => it.id === req.shipmentItemId)
        if (!src) {
          return reply.code(400).send({ error: `Shipment item ${req.shipmentItemId} not in this shipment` })
        }
        if (req.quantity > src.quantity) {
          return reply.code(400).send({
            error: `Cannot move ${req.quantity} of ${src.sku}; shipment only has ${src.quantity}`,
          })
        }
        moves.push({ source: src, takeQty: req.quantity })
      }

      // Atomic split: create new sibling + decrement / delete source items.
      const newShipment = await prisma.$transaction(async (tx) => {
        const created = await tx.shipment.create({
          data: {
            orderId: shipment.orderId,
            warehouseId: shipment.warehouseId,
            carrierCode: shipment.carrierCode,
            status: 'DRAFT',
            items: {
              create: moves.map((m) => ({
                orderItemId: m.source.orderItemId,
                productId: m.source.productId,
                sku: m.source.sku,
                quantity: m.takeQty,
              })),
            },
          },
          include: { items: true },
        })
        for (const m of moves) {
          if (m.takeQty === m.source.quantity) {
            // Full take — remove the source line entirely.
            await tx.shipmentItem.delete({ where: { id: m.source.id } })
          } else {
            // Partial — decrement the source quantity.
            await tx.shipmentItem.update({
              where: { id: m.source.id },
              data: { quantity: m.source.quantity - m.takeQty },
            })
          }
        }
        // Bump source version since its items changed.
        await tx.shipment.update({
          where: { id: shipment.id },
          data: { version: { increment: 1 } },
        })
        return created
      })

      return { ok: true, source: { id: shipment.id }, created: newShipment }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[shipments/:id/split] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── O.18: Customs preflight ────────────────────────────────────────
  // For international shipments, surfaces what will be declared on the
  // commercial invoice (HS codes, origin countries, declared values)
  // and flags issues that would cause carrier rejection (missing HS,
  // missing origin). Shopify/Sendcloud generate the actual customs
  // form server-side — this preflight is the operator-visible review
  // that catches gaps before the print-label round-trip.
  const EU_COUNTRIES = new Set([
    'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU',
    'IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE',
  ])
  fastify.get('/fulfillment/shipments/:id/customs-preflight', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const shipment = await prisma.shipment.findUnique({
        where: { id },
        include: {
          order: {
            include: {
              items: {
                include: {
                  product: {
                    select: {
                      sku: true,
                      hsCode: true,
                      countryOfOrigin: true,
                      // O.71: weight master so we can compute expected
                      // grams and flag scale errors / mispacked items.
                      weightValue: true,
                      weightUnit: true,
                    },
                  },
                },
              },
            },
          },
        },
      })
      if (!shipment) return reply.code(404).send({ error: 'Shipment not found' })
      if (!shipment.order) return reply.code(400).send({ error: 'Shipment has no order' })

      const ship = shipment.order.shippingAddress as any
      const destCountry = (ship?.CountryCode ?? ship?.countryCode ?? ship?.country ?? '')
        .toString()
        .toUpperCase()
      // Italy → other EU = no customs declaration needed; Italy → non-EU
      // (or anywhere outside Italy when warehouse country ≠ destination)
      // is "international" for customs purposes. v0 assumes Riccione
      // (Italy) as the warehouse; future multi-warehouse support
      // computes this against shipment.warehouse.country.
      const isIntraEU = EU_COUNTRIES.has(destCountry)
      const isInternational = !isIntraEU

      const lines = shipment.order.items.map((it) => ({
        sku: it.sku,
        productSku: it.product?.sku ?? null,
        // O.66: include productId so the drawer can deep-link to the
        // edit page when an HS code or origin country is missing.
        productId: it.productId,
        quantity: it.quantity,
        unitPrice: Number(it.price),
        totalValue: Number(it.price) * it.quantity,
        hsCode: it.product?.hsCode ?? null,
        originCountry: it.product?.countryOfOrigin ?? null,
      }))

      const issues: Array<{ sku: string; severity: 'error' | 'warning'; code: string; message: string }> = []
      if (isInternational) {
        for (const l of lines) {
          if (!l.hsCode) {
            issues.push({
              sku: l.sku,
              severity: 'error',
              code: 'HS_CODE_MISSING',
              message: `${l.sku} has no HS code — carrier will reject international shipment`,
            })
          }
          if (!l.originCountry) {
            issues.push({
              sku: l.sku,
              severity: 'warning',
              code: 'ORIGIN_COUNTRY_MISSING',
              message: `${l.sku} has no country of origin — defaults may be misapplied`,
            })
          }
        }
      }

      const totalValue = lines.reduce((sum, l) => sum + l.totalValue, 0)

      // O.71: weight check. Sum the master weight × quantity per item
      // (normalising the per-product weightUnit to grams) and compare
      // against the operator-declared shipment.weightGrams. Flags
      // mismatches that often mean the operator put the wrong items
      // in the box, used a stale tare on the scale, or the master
      // weight is wrong. Skips when:
      //   • the shipment hasn't been weighed yet (weightGrams null) —
      //     pack station hasn't run; nothing to compare
      //   • any item lacks weightValue — would understate expected
      //     and create false alerts; flagged separately as a warning
      const UNIT_TO_GRAMS: Record<string, number> = {
        g: 1,
        kg: 1000,
        oz: 28.3495,
        lb: 453.592,
      }
      let expectedGrams = 0
      let anyMissingWeight = false
      for (const it of shipment.order.items) {
        const v = it.product?.weightValue
        const u = (it.product?.weightUnit ?? '').toLowerCase()
        if (v == null || !UNIT_TO_GRAMS[u]) {
          anyMissingWeight = true
          continue
        }
        expectedGrams += Number(v) * UNIT_TO_GRAMS[u] * it.quantity
      }
      const declaredGrams = shipment.weightGrams ?? null
      let weightCheck: {
        expectedGrams: number | null
        declaredGrams: number | null
        missingWeightMaster: boolean
        variancePct: number | null
        severity: 'ok' | 'warning' | 'error' | 'pending'
      } = {
        expectedGrams: anyMissingWeight ? null : Math.round(expectedGrams),
        declaredGrams,
        missingWeightMaster: anyMissingWeight,
        variancePct: null,
        severity: 'pending',
      }
      if (declaredGrams != null && !anyMissingWeight && expectedGrams > 0) {
        const variance = Math.abs(declaredGrams - expectedGrams) / expectedGrams
        weightCheck.variancePct = Math.round(variance * 1000) / 10
        // ≤10% = expected drift (packaging, tape). >20% = error
        // (likely wrong items packed). 10–20% = warning.
        if (variance <= 0.1) weightCheck.severity = 'ok'
        else if (variance <= 0.2) weightCheck.severity = 'warning'
        else weightCheck.severity = 'error'
      }

      return {
        shipmentId: id,
        destinationCountry: destCountry || null,
        isInternational,
        isIntraEU,
        currency: shipment.order.currencyCode ?? 'EUR',
        totalValue,
        lines,
        issues,
        weightCheck,
        ready: isInternational ? !issues.some((i) => i.severity === 'error') : true,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[customs-preflight] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // O.13: pack station — capture weight + dimensions + scan-verify
  // result and transition the shipment from PICKED/READY_TO_PICK/DRAFT
  // to PACKED. The pack-station page (apps/web/src/app/fulfillment/
  // outbound/pack/[shipmentId]) calls this on save.
  fastify.post('/fulfillment/shipments/:id/pack', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as {
        weightGrams?: number
        lengthCm?: number
        widthCm?: number
        heightCm?: number
        packedBy?: string
        notes?: string
        // Scan-verify result. UI sends one entry per OrderItem and we
        // record nothing here — the verification gate is enforced
        // client-side; the server just trusts the operator's pack
        // confirmation. Future commit can require a server-side
        // attestation (signed scan log) if audit demands it.
        verifiedSkus?: string[]
      }

      const shipment = await prisma.shipment.findUnique({ where: { id } })
      if (!shipment) return reply.code(404).send({ error: 'Shipment not found' })

      // Allow re-packing PACKED shipments (operator updates measurements
      // after weighing again) but reject post-LABEL_PRINTED — once a
      // label exists the dimensions are committed to the carrier.
      const allowed = ['DRAFT', 'READY_TO_PICK', 'PICKED', 'PACKED']
      if (!allowed.includes(shipment.status)) {
        return reply.code(400).send({
          error: `Cannot pack a shipment in status ${shipment.status}. Void the label first if you need to repack.`,
        })
      }

      const data: any = {
        status: 'PACKED',
        packedAt: shipment.packedAt ?? new Date(),
        version: { increment: 1 },
      }
      if (typeof body.weightGrams === 'number' && body.weightGrams > 0) {
        data.weightGrams = body.weightGrams
      }
      if (typeof body.lengthCm === 'number' && body.lengthCm > 0) data.lengthCm = body.lengthCm
      if (typeof body.widthCm === 'number' && body.widthCm > 0) data.widthCm = body.widthCm
      if (typeof body.heightCm === 'number' && body.heightCm > 0) data.heightCm = body.heightCm
      if (body.packedBy) data.packedBy = body.packedBy
      if (body.notes != null) data.notes = body.notes

      const updated = await prisma.shipment.update({ where: { id }, data })
      return updated
    } catch (error: any) {
      fastify.log.error({ err: error }, '[shipments/:id/pack] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── O.28: Rate shopping ────────────────────────────────────────────
  // Returns available shipping services (Sendcloud + Buy Shipping if
  // enabled) sorted ascending by rate so the drawer's compare panel
  // shows the cheapest first. Operator picks one; PATCH below binds
  // the chosen carrier + service to the shipment row.
  fastify.get('/fulfillment/shipments/:id/rates', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const shipment = await prisma.shipment.findUnique({
        where: { id },
        include: {
          warehouse: true,
          order: {
            select: {
              shippingAddress: true,
              channel: true,
              channelOrderId: true,
              items: { select: { id: true, quantity: true, amazonMetadata: true } },
            },
          },
        },
      })
      if (!shipment) return reply.code(404).send({ error: 'Shipment not found' })
      if (!shipment.order) return reply.code(400).send({ error: 'Shipment has no order' })

      const ship = shipment.order.shippingAddress as any
      const country = (ship?.CountryCode ?? ship?.countryCode ?? ship?.country ?? 'IT')
        .toString()
        .toUpperCase()
      const weightKg = (shipment.weightGrams ?? 1500) / 1000

      const sendcloud = await import('../services/sendcloud/index.js')
      const rates: Array<{
        source: 'SENDCLOUD' | 'AMAZON_BUY_SHIPPING'
        carrier: string
        serviceName: string
        serviceCode: string
        priceEur: number
        estimatedDays?: number
      }> = []

      // CR.13 — pull each carrier's preferences once so we can skip
      // those opted-out of rate-shop. Single read; carriers are <10
      // rows for a single-account install. Default = include.
      const carrierPrefs = await prisma.carrier.findMany({
        select: { code: true, preferences: true },
      })
      const includeSendcloud = (() => {
        const p = carrierPrefs.find((c) => c.code === 'SENDCLOUD')?.preferences as any
        return p?.includeInRateShop !== false // default true when unset
      })()
      const includeBuyShipping = (() => {
        const p = carrierPrefs.find((c) => c.code === 'AMAZON_BUY_SHIPPING')?.preferences as any
        return p?.includeInRateShop !== false
      })()

      if (includeSendcloud) {
        try {
          const creds = await sendcloud.resolveCredentials()
          const methods = await sendcloud.listShippingMethods(creds, { weightKg, toCountry: country })
          for (const m of methods) {
            rates.push({
              source: 'SENDCLOUD',
              carrier: m.carrier,
              serviceName: m.name,
              serviceCode: String(m.id),
              priceEur: m.price,
            })
          }
        } catch {
          // Sendcloud unconnected or unavailable — skip but keep going so
          // Buy Shipping rates still surface for Amazon orders.
        }
      }

      // CR.4: Buy Shipping is only relevant for Amazon orders. Pre-CR.4
      // this passed empty amazonOrderId + empty itemList + hardcoded
      // Riccione ship-from, which Amazon's MFN API rejects in real
      // mode. Now: real channelOrderId + real itemList (Amazon
      // OrderItemId from amazonMetadata) + warehouse-derived
      // shipFromAddress. Skip silently if the warehouse is not bound
      // or has no address — UI shows Sendcloud rates only.
      if (includeBuyShipping && shipment.order.channel === 'AMAZON' && process.env.NEXUS_ENABLE_AMAZON_BUY_SHIPPING) {
        const wh = shipment.warehouse
        if (wh && wh.addressLine1 && wh.city && wh.postalCode && wh.country) {
          try {
            const buyShipping = await import('../services/amazon-pushback/buy-shipping.js')
            const itemList = shipment.order.items.map((it) => {
              const meta = it.amazonMetadata as any
              return {
                orderItemId: meta?.OrderItemId ?? meta?.orderItemId ?? it.id,
                quantity: it.quantity,
              }
            })
            const services = await buyShipping.getEligibleShippingServices({
              amazonOrderId: shipment.order.channelOrderId,
              itemList,
              shipFromAddress: {
                name: wh.name,
                addressLine1: wh.addressLine1,
                addressLine2: wh.addressLine2 ?? undefined,
                city: wh.city,
                postalCode: wh.postalCode,
                countryCode: wh.country,
              },
              weightGrams: shipment.weightGrams ?? Math.round(weightKg * 1000),
            })
            for (const s of services) {
              rates.push({
                source: 'AMAZON_BUY_SHIPPING',
                carrier: s.carrierName,
                serviceName: s.shippingServiceName,
                serviceCode: s.shippingServiceOfferId,
                priceEur: s.rate.amount,
              })
            }
          } catch (err: any) {
            fastify.log.warn({ err, shipmentId: id }, '[shipments/:id/rates] Buy Shipping rate fetch failed')
          }
        }
      }

      rates.sort((a, b) => a.priceEur - b.priceEur)
      return { rates, weightKg, destinationCountry: country }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[shipments/:id/rates] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // O.28: bind operator's chosen carrier + service to the shipment.
  // Caller picks from the rates response above. Rejects post-
  // LABEL_PRINTED — once a label exists the carrier is committed.
  fastify.patch('/fulfillment/shipments/:id/service', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as {
        carrierCode?: string
        serviceCode?: string
        serviceName?: string
      }
      const shipment = await prisma.shipment.findUnique({ where: { id } })
      if (!shipment) return reply.code(404).send({ error: 'Shipment not found' })
      if (['LABEL_PRINTED', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED'].includes(shipment.status)) {
        return reply.code(400).send({
          error: 'Cannot change service after label printed. Void the label first.',
        })
      }
      const updated = await prisma.shipment.update({
        where: { id },
        data: {
          ...(body.carrierCode ? { carrierCode: body.carrierCode as any } : {}),
          ...(body.serviceCode != null ? { serviceCode: body.serviceCode } : {}),
          ...(body.serviceName != null ? { serviceName: body.serviceName } : {}),
          version: { increment: 1 },
        },
      })
      return updated
    } catch (error: any) {
      fastify.log.error({ err: error }, '[shipments/:id/service] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── O.34: void label ────────────────────────────────────────────────
  // POST /api/fulfillment/shipments/:id/void-label — cancels the
  // Sendcloud parcel + resets the Shipment to PACKED so operator can
  // re-pack / re-rate / re-print. Refused after the carrier has
  // accepted the parcel (Sendcloud rejects with a clear reason).
  fastify.post('/fulfillment/shipments/:id/void-label', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const shipment = await prisma.shipment.findUnique({ where: { id } })
      if (!shipment) return reply.code(404).send({ error: 'Shipment not found' })
      if (!['LABEL_PRINTED'].includes(shipment.status)) {
        return reply.code(400).send({
          error: `Cannot void from status ${shipment.status}. Only LABEL_PRINTED labels can be voided.`,
        })
      }
      if (!shipment.sendcloudParcelId) {
        return reply.code(400).send({ error: 'No Sendcloud parcel to void.' })
      }

      const sendcloud = await import('../services/sendcloud/index.js')
      let creds
      try {
        creds = await sendcloud.resolveCredentials()
      } catch (e: any) {
        if (e instanceof sendcloud.SendcloudError) {
          return reply.code(e.status).send({ error: e.message, code: e.code })
        }
        throw e
      }

      const result = await sendcloud.voidParcel(creds, Number(shipment.sendcloudParcelId))
      if (result.ok === false) {
        const reason = (result as { ok: false; reason: string }).reason
        // Audit the failed attempt — operator may want to see the
        // history of "we tried to void, Sendcloud said no".
        const { auditLogService } = await import('../services/audit-log.service.js')
        void auditLogService.write({
          entityType: 'Shipment',
          entityId: id,
          action: 'void-label-failed',
          metadata: { reason },
        })
        return reply.code(502).send({ error: `Sendcloud refused: ${reason}` })
      }

      // Reset shipment for a fresh print. Keep the order link, items,
      // weight + dimensions; clear the parcel-specific fields.
      const updated = await prisma.shipment.update({
        where: { id },
        data: {
          status: shipment.weightGrams ? 'PACKED' : 'DRAFT',
          sendcloudParcelId: null,
          trackingNumber: null,
          trackingUrl: null,
          labelUrl: null,
          labelPrintedAt: null,
          serviceCode: null,
          serviceName: null,
          version: { increment: 1 },
        },
      })

      const { publishOutboundEvent } = await import('../services/outbound-events.service.js')
      publishOutboundEvent({ type: 'shipment.updated', shipmentId: id, status: updated.status, ts: Date.now() })
      const { auditLogService } = await import('../services/audit-log.service.js')
      void auditLogService.write({
        entityType: 'Shipment',
        entityId: id,
        action: 'void-label',
        before: {
          status: 'LABEL_PRINTED',
          sendcloudParcelId: shipment.sendcloudParcelId,
          trackingNumber: shipment.trackingNumber,
        },
        after: { status: updated.status },
      })

      return updated
    } catch (error: any) {
      fastify.log.error({ err: error }, '[shipments/:id/void-label] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── O.34: re-print label (existing label PDF, no Sendcloud call) ───
  // The labelUrl is already stored; this endpoint exists so the UI
  // has a uniform "Reprint" button (vs. opening the URL directly,
  // which works but breaks the operator workflow when the URL has
  // expired or the printer needs the PDF streamed). Future commit
  // can stream the PDF via fetchLabelPdf for expired-URL recovery;
  // today this just returns the stored URL.
  fastify.post('/fulfillment/shipments/:id/reprint-label', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const shipment = await prisma.shipment.findUnique({
        where: { id },
        select: { labelUrl: true, status: true },
      })
      if (!shipment) return reply.code(404).send({ error: 'Shipment not found' })
      if (!shipment.labelUrl) {
        return reply.code(400).send({ error: 'No label has been printed yet.' })
      }
      return { labelUrl: shipment.labelUrl, status: shipment.status }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[shipments/:id/reprint-label] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/shipments/:id/mark-shipped', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const before = await prisma.shipment.findUnique({
        where: { id },
        select: { status: true, trackingNumber: true },
      })
      if (!before) return reply.code(404).send({ error: 'Shipment not found' })
      const updated = await prisma.shipment.update({
        where: { id },
        data: { status: 'SHIPPED', shippedAt: new Date(), version: { increment: 1 } },
      })
      // O.39: audit.
      const { auditLogService } = await import('../services/audit-log.service.js')
      void auditLogService.write({
        entityType: 'Shipment',
        entityId: id,
        action: 'mark-shipped',
        before: { status: before.status },
        after: { status: 'SHIPPED', shippedAt: updated.shippedAt },
      })
      // Channel pushback fires from the O.7 webhook handler when
      // Sendcloud reports the actual carrier scan; this endpoint just
      // records operator intent ("we shipped it manually").
      return updated
    } catch (error: any) {
      fastify.log.error({ err: error }, '[mark-shipped] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/shipments/bulk-create', async (request, reply) => {
    try {
      const body = request.body as { orderIds?: string[]; warehouseId?: string; carrierCode?: string }
      const orderIds = Array.isArray(body.orderIds) ? body.orderIds : []
      if (orderIds.length === 0) return reply.code(400).send({ error: 'orderIds[] required' })
      if (orderIds.length > 200) return reply.code(400).send({ error: 'Max 200 orders per bulk create' })

      // Caller-supplied warehouse wins; otherwise the routing engine
      // (OrderRoutingRule rules) decides per-order.
      const explicitWarehouseId = body.warehouseId ?? null

      let created = 0
      const errors: Array<{ orderId: string; reason: string }> = []
      const routingByOrder: Record<string, { warehouseId: string | null; source: string; ruleName: string | null }> = {}
      for (const oid of orderIds) {
        try {
          const existing = await prisma.shipment.findFirst({ where: { orderId: oid, status: { not: 'CANCELLED' } } })
          if (existing) { errors.push({ orderId: oid, reason: 'shipment already exists' }); continue }
          const order = await prisma.order.findUnique({ where: { id: oid }, include: { items: true } })
          if (!order) { errors.push({ orderId: oid, reason: 'order not found' }); continue }

          // Per-order routing: explicit override > rule match > default.
          let resolvedWarehouseId: string | null = explicitWarehouseId
          let routingSource = 'EXPLICIT_OVERRIDE'
          let routingRuleName: string | null = null
          if (!explicitWarehouseId) {
            const shippingCountry =
              (order.shippingAddress as any)?.country ?? null
            const routing = await resolveWarehouseForOrder({
              channel: order.channel,
              marketplace: order.marketplace,
              shippingCountry,
            })
            resolvedWarehouseId = routing.warehouseId
            routingSource = routing.source
            routingRuleName = routing.ruleName
          }
          routingByOrder[oid] = {
            warehouseId: resolvedWarehouseId,
            source: routingSource,
            ruleName: routingRuleName,
          }

          // O.16: shipping rules — decide carrier + service from
          // operator-defined rules. Caller-supplied carrierCode wins
          // (explicit override); otherwise the rules engine picks;
          // otherwise fall back to SENDCLOUD as the original default.
          let resolvedCarrier = (body.carrierCode as any) ?? null
          let resolvedService: string | null = null
          // O.36: hold-for-review state. Set when the matching rule's
          // actions.holdForReview = true.
          let holdForReview = false
          let holdReason: string | null = null
          if (!body.carrierCode) {
            const { applyShippingRules } = await import('../services/shipping-rules/applier.js')
            const dest = (order.shippingAddress as any)?.country
              ?? (order.shippingAddress as any)?.CountryCode
              ?? null
            const applied = await applyShippingRules({
              channel: order.channel,
              marketplace: order.marketplace,
              destinationCountry: typeof dest === 'string' ? dest : null,
              weightGrams: null, // unknown until pack station
              orderTotalCents: Math.round(Number(order.totalPrice) * 100),
              itemCount: order.items.length,
              isPrime: order.isPrime ?? null,
              hasHazmat: false,
              skus: order.items.map((it) => it.sku),
            })
            if (applied?.actions.preferCarrierCode) {
              resolvedCarrier = applied.actions.preferCarrierCode as any
              resolvedService = applied.actions.preferServiceCode ?? null
            }
            if (applied?.actions.holdForReview) {
              holdForReview = true
              holdReason = `Auto-held by rule "${applied.ruleName}"`
            }
          }
          await prisma.shipment.create({
            data: {
              orderId: oid,
              warehouseId: resolvedWarehouseId,
              carrierCode: resolvedCarrier ?? 'SENDCLOUD',
              serviceCode: resolvedService,
              status: holdForReview ? ('ON_HOLD' as any) : 'DRAFT',
              heldAt: holdForReview ? new Date() : null,
              heldReason: holdReason,
              items: {
                create: order.items.map((it) => ({
                  orderItemId: it.id, productId: it.productId, sku: it.sku, quantity: it.quantity,
                })),
              },
            },
          })
          created++
        } catch (e: any) {
          errors.push({ orderId: oid, reason: e?.message ?? String(e) })
        }
      }
      return { created, errors, routing: routingByOrder }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[bulk-create shipments] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // O.69: bulk-create preflight. Operators want to know "if I click
  // Bulk create on these 30 orders, how many will succeed vs fail
  // for missing master data" *before* the call. Walks the selected
  // orders + their items + product master and returns a readiness
  // report: per-order flags for already-has-shipment, customs gaps
  // (international + missing HS code), missing-address. The bulk-
  // create endpoint catches all of these too, but at-create the
  // operator gets a post-mortem; this gives them a pre-flight.
  fastify.post(
    '/fulfillment/outbound/preflight-bulk',
    async (request, reply) => {
      try {
        const body = request.body as { orderIds?: string[] }
        const orderIds = Array.isArray(body.orderIds) ? body.orderIds : []
        if (orderIds.length === 0) {
          return reply.code(400).send({ error: 'orderIds[] required' })
        }
        if (orderIds.length > 200) {
          return reply.code(400).send({ error: 'Max 200 orders' })
        }
        const orders = await prisma.order.findMany({
          where: { id: { in: orderIds } },
          select: {
            id: true,
            channelOrderId: true,
            shippingAddress: true,
            shipments: {
              where: { status: { not: 'CANCELLED' as any } },
              select: { id: true },
            },
            items: {
              select: {
                sku: true,
                product: { select: { hsCode: true, countryOfOrigin: true } },
              },
            },
          },
        })
        const reports = orders.map((o) => {
          const ship = o.shippingAddress as any
          const country = (ship?.CountryCode ?? ship?.countryCode ?? ship?.country ?? '')
            .toString()
            .toUpperCase()
          const isInternational = country !== '' && !EU_COUNTRIES.has(country)
          const issues: Array<{ severity: 'error' | 'warning'; code: string }> = []
          if (o.shipments.length > 0) {
            issues.push({ severity: 'error', code: 'SHIPMENT_EXISTS' })
          }
          if (!ship || (!ship.AddressLine1 && !ship.addressLine1 && !ship.street)) {
            issues.push({ severity: 'error', code: 'MISSING_ADDRESS' })
          }
          if (isInternational) {
            const noHs = o.items.filter((it) => !it.product?.hsCode).length
            const noOrigin = o.items.filter((it) => !it.product?.countryOfOrigin).length
            if (noHs > 0) {
              issues.push({ severity: 'error', code: 'CUSTOMS_HS_MISSING' })
            }
            if (noOrigin > 0) {
              issues.push({ severity: 'warning', code: 'CUSTOMS_ORIGIN_MISSING' })
            }
          }
          const ready = issues.every((i) => i.severity !== 'error')
          return {
            orderId: o.id,
            channelOrderId: o.channelOrderId,
            country: country || null,
            isInternational,
            ready,
            issues,
          }
        })
        const errors = reports.filter((r) => !r.ready).length
        const warnings = reports.filter((r) =>
          r.issues.some((i) => i.severity === 'warning'),
        ).length
        return {
          total: orders.length,
          ready: reports.filter((r) => r.ready).length,
          errors,
          warnings,
          missing: orderIds.filter((id) => !orders.find((o) => o.id === id)),
          orders: reports,
        }
      } catch (error: any) {
        fastify.log.error({ err: error }, '[outbound/preflight-bulk] failed')
        return reply.code(500).send({ error: error?.message ?? String(error) })
      }
    },
  )

  // ── O.4: Pending-shipment aggregation ─────────────────────────────────
  // The cornerstone read for /fulfillment/outbound. Returns orders that
  // need a shipment created (status ∈ PENDING|PROCESSING, no active
  // shipment yet) decorated with ship-by urgency buckets. Replaces the
  // "go look at /orders, then create shipment, then come back" two-step
  // operators have been doing.
  //
  // Filters: channel[], marketplace[], urgency[], warehouse, search.
  // Sort: ship-by-asc (default), value-desc, age-desc.
  // Counts: overdue/today/tomorrow/this-week/later/unknown + per-channel.
  fastify.get('/fulfillment/outbound/pending-orders', async (request, reply) => {
    try {
      const q = request.query as any
      const page = Math.max(1, safeNum(q.page, 1) ?? 1)
      const pageSize = Math.min(200, safeNum(q.pageSize, 50) ?? 50)
      const sort = (q.sort as string) || 'ship-by-asc'

      const channelList: string[] | undefined = q.channel
        ? String(q.channel).split(',').map((s: string) => s.trim()).filter(Boolean)
        : undefined
      const marketplaceList: string[] | undefined = q.marketplace
        ? String(q.marketplace).split(',').map((s: string) => s.trim()).filter(Boolean)
        : undefined
      const urgencyList: string[] | undefined = q.urgency
        ? String(q.urgency).split(',').map((s: string) => s.trim().toUpperCase()).filter(Boolean)
        : undefined

      // ── Urgency window math (UTC-anchored). Buckets:
      //   OVERDUE   shipByDate < now
      //   TODAY     now ≤ shipByDate < now + 24h
      //   TOMORROW  +24h ≤ shipByDate < +48h
      //   THIS_WEEK +48h ≤ shipByDate < +7d
      //   LATER     shipByDate ≥ +7d
      //   UNKNOWN   shipByDate IS NULL
      const now = new Date()
      const inHrs = (h: number) => new Date(now.getTime() + h * 3_600_000)
      const t24 = inHrs(24)
      const t48 = inHrs(48)
      const t7d = inHrs(24 * 7)

      const where: any = {
        status: { in: ['PENDING', 'PROCESSING'] as any[] },
        // Exclude orders that already have an active shipment. Cancelled
        // shipments don't count — operator may have voided + needs to
        // re-create from scratch.
        shipments: { none: { status: { not: 'CANCELLED' as any } } },
      }
      if (channelList?.length) where.channel = { in: channelList as any }
      if (marketplaceList?.length) where.marketplace = { in: marketplaceList }
      if (q.search?.trim()) {
        const s = q.search.trim()
        where.OR = [
          { channelOrderId: { contains: s, mode: 'insensitive' } },
          { customerName: { contains: s, mode: 'insensitive' } },
          { customerEmail: { contains: s, mode: 'insensitive' } },
          { items: { some: { sku: { contains: s, mode: 'insensitive' } } } },
        ]
      }
      // Urgency is ANDed with the existing where via a discriminated OR.
      if (urgencyList?.length) {
        const urgencyClauses: any[] = []
        for (const u of urgencyList) {
          if (u === 'OVERDUE') urgencyClauses.push({ shipByDate: { lt: now } })
          else if (u === 'TODAY') urgencyClauses.push({ shipByDate: { gte: now, lt: t24 } })
          else if (u === 'TOMORROW') urgencyClauses.push({ shipByDate: { gte: t24, lt: t48 } })
          else if (u === 'THIS_WEEK') urgencyClauses.push({ shipByDate: { gte: t48, lt: t7d } })
          else if (u === 'LATER') urgencyClauses.push({ shipByDate: { gte: t7d } })
          else if (u === 'UNKNOWN') urgencyClauses.push({ shipByDate: null })
        }
        // AND with existing search OR (if any) by nesting under AND.
        const prevOR = where.OR
        delete where.OR
        where.AND = [
          ...(prevOR ? [{ OR: prevOR }] : []),
          { OR: urgencyClauses },
        ]
      }

      // Sort. Postgres sorts NULLs last for ASC by default in Prisma 5+.
      let orderBy: any = [{ shipByDate: 'asc' }, { purchaseDate: 'asc' }]
      if (sort === 'value-desc') orderBy = [{ totalPrice: 'desc' }, { shipByDate: 'asc' }]
      else if (sort === 'age-desc') orderBy = [{ purchaseDate: 'asc' }, { shipByDate: 'asc' }]

      const [total, items] = await Promise.all([
        prisma.order.count({ where }),
        prisma.order.findMany({
          where,
          orderBy,
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            channel: true,
            marketplace: true,
            channelOrderId: true,
            status: true,
            customerName: true,
            customerEmail: true,
            shippingAddress: true,
            purchaseDate: true,
            shipByDate: true,
            earliestShipDate: true,
            latestDeliveryDate: true,
            fulfillmentLatency: true,
            isPrime: true,
            totalPrice: true,
            currencyCode: true,
            createdAt: true,
            items: {
              select: { id: true, sku: true, quantity: true, productId: true, price: true },
            },
          },
        }),
      ])

      // Decorate each row with derived urgency + line-item totals, and
      // serialize Decimal → number to keep the wire shape JSON-safe
      // (D.2 lesson — see TECH_DEBT.md on Decimal+gzip).
      const classifyUrgency = (d: Date | null | undefined): string => {
        if (!d) return 'UNKNOWN'
        const t = d.getTime()
        if (t < now.getTime()) return 'OVERDUE'
        if (t < t24.getTime()) return 'TODAY'
        if (t < t48.getTime()) return 'TOMORROW'
        if (t < t7d.getTime()) return 'THIS_WEEK'
        return 'LATER'
      }
      const decorated = items.map((o) => {
        const totalQuantity = o.items.reduce((n, it) => n + it.quantity, 0)
        return {
          ...o,
          totalPrice: Number(o.totalPrice),
          items: o.items.map((it) => ({ ...it, price: Number(it.price) })),
          itemCount: o.items.length,
          totalQuantity,
          urgency: classifyUrgency(o.shipByDate),
        }
      })

      // Counts — cheap aggregate queries against the same base where
      // (minus the urgency filter so the count chips reflect "of all
      // pending orders matching channel/search, how many overdue?").
      const baseWhere: any = { ...where }
      delete baseWhere.AND
      delete baseWhere.OR
      // Re-apply non-urgency clauses
      if (q.search?.trim()) {
        const s = q.search.trim()
        baseWhere.OR = [
          { channelOrderId: { contains: s, mode: 'insensitive' } },
          { customerName: { contains: s, mode: 'insensitive' } },
          { customerEmail: { contains: s, mode: 'insensitive' } },
          { items: { some: { sku: { contains: s, mode: 'insensitive' } } } },
        ]
      }

      const [overdue, today, tomorrow, thisWeek, later, unknown, byChannelRows] =
        await Promise.all([
          prisma.order.count({ where: { ...baseWhere, shipByDate: { lt: now } } }),
          prisma.order.count({ where: { ...baseWhere, shipByDate: { gte: now, lt: t24 } } }),
          prisma.order.count({ where: { ...baseWhere, shipByDate: { gte: t24, lt: t48 } } }),
          prisma.order.count({ where: { ...baseWhere, shipByDate: { gte: t48, lt: t7d } } }),
          prisma.order.count({ where: { ...baseWhere, shipByDate: { gte: t7d } } }),
          prisma.order.count({ where: { ...baseWhere, shipByDate: null } }),
          prisma.order.groupBy({
            by: ['channel'],
            where: baseWhere,
            _count: { _all: true },
          }),
        ])

      const byChannel: Record<string, number> = {}
      for (const row of byChannelRows) byChannel[row.channel as string] = row._count._all

      return {
        items: decorated,
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        counts: { overdue, today, tomorrow, thisWeek, later, unknown, byChannel },
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[outbound/pending-orders] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── O.5: Outbound order detail (drawer) ──────────────────────────────
  // Single-order full detail for the outbound surface drawer. Returns
  // line items + product joins (for image/name) + every shipment that
  // has touched this order. Distinct from the global /orders/:id read
  // because we shape this payload around outbound's needs (urgency,
  // Prime, all metadata blobs) and we keep the surface area scoped.
  fastify.get('/fulfillment/outbound/orders/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const order = await prisma.order.findUnique({
        where: { id },
        include: {
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  sku: true,
                  name: true,
                  // ProductImage has no sortOrder — sort by createdAt
                  // (matches insert order) and take the first.
                  images: { select: { url: true }, orderBy: { createdAt: 'asc' }, take: 1 },
                },
              },
            },
          },
          shipments: {
            include: {
              items: { select: { id: true, sku: true, quantity: true } },
              warehouse: { select: { code: true, name: true } },
              // O.20: tracking timeline. Order DESC so the drawer
              // renders most-recent first; size cap because timelines
              // can grow to dozens of events on slow international
              // routes (every depot scan = one row).
              trackingEvents: {
                orderBy: { occurredAt: 'desc' },
                take: 50,
                select: {
                  id: true,
                  occurredAt: true,
                  code: true,
                  description: true,
                  location: true,
                  source: true,
                },
              },
            },
            orderBy: { createdAt: 'asc' },
          },
          // O.49: surfaces O.39's AuditLog entries. We pull rows
          // tagged entityType='Shipment' for any shipment on this
          // order so the drawer can render an "Activity" feed
          // (print-label / void / hold / release / mark-shipped /
          // auto-cancel-from-order). Capped at 50 most-recent for
          // payload size; hot orders won't accrue more than a
          // handful in practice.
        },
      })
      if (!order) return reply.code(404).send({ error: 'Order not found' })

      // O.49: pull AuditLog rows for every shipment on this order.
      // Single query keyed on the shipment ID set; merged into the
      // shipment objects on the response.
      const shipmentIds = order.shipments.map((s) => s.id)
      const auditRows = shipmentIds.length > 0
        ? await prisma.auditLog.findMany({
            where: { entityType: 'Shipment', entityId: { in: shipmentIds } },
            orderBy: { createdAt: 'desc' },
            take: 50,
            select: {
              id: true,
              entityId: true,
              action: true,
              // O.51: include before/after so the drawer can render
              // the actual state change ("PACKED → LABEL_PRINTED")
              // instead of just the verb.
              before: true,
              after: true,
              metadata: true,
              userId: true,
              createdAt: true,
            },
          })
        : []
      const auditByShipment = new Map<string, typeof auditRows>()
      for (const a of auditRows) {
        const list = auditByShipment.get(a.entityId) ?? []
        list.push(a)
        auditByShipment.set(a.entityId, list)
      }

      // O.60: existing returns for this order. Drives the drawer's
      // "View N returns" deep-link so the operator doesn't accidentally
      // open a duplicate RMA when one is already in flight. Lean
      // payload — the returns surface owns the full read.
      const returns = await prisma.return.findMany({
        where: { orderId: id },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          rmaNumber: true,
          status: true,
          refundStatus: true,
          refundCents: true,
          currencyCode: true,
          channel: true,
          isFbaReturn: true,
          createdAt: true,
        },
      })

      // Decimal → number on the wire (D.2 lesson). Only fields the
      // drawer reads; preserves channel metadata blobs verbatim.
      return {
        ...order,
        totalPrice: Number(order.totalPrice),
        items: order.items.map((it) => ({
          ...it,
          price: Number(it.price),
          product: it.product
            ? {
                id: it.product.id,
                sku: it.product.sku,
                name: it.product.name,
                imageUrl: it.product.images[0]?.url ?? null,
              }
            : null,
        })),
        shipments: order.shipments.map((s) => ({
          ...s,
          // O.49: per-shipment audit log entries (most-recent first).
          activity: auditByShipment.get(s.id) ?? [],
        })),
        returns,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[outbound/orders/:id] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // Order routing rules — CRUD for OrderRoutingRule. Powers the
  // ── O.16: Shipping rules CRUD ──────────────────────────────────────
  // Distinct from OrderRoutingRule (which decides warehouse): these
  // rules decide carrier + service + insurance + signature + packaging
  // when a shipment is created. The applier (services/shipping-rules/
  // applier.ts) is invoked from bulk-create-shipments below.
  fastify.get('/fulfillment/shipping-rules', async (_request, reply) => {
    try {
      const rules = await prisma.shippingRule.findMany({
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      })
      return { items: rules }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[shipping-rules] list failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/shipping-rules', async (request, reply) => {
    try {
      const body = request.body as {
        name?: string
        description?: string
        priority?: number
        isActive?: boolean
        conditions?: any
        actions?: any
      }
      if (!body.name?.trim()) return reply.code(400).send({ error: 'name is required' })
      const created = await prisma.shippingRule.create({
        data: {
          name: body.name.trim(),
          description: body.description ?? null,
          priority: typeof body.priority === 'number' ? body.priority : 100,
          isActive: body.isActive ?? true,
          conditions: body.conditions ?? {},
          actions: body.actions ?? {},
        },
      })
      return created
    } catch (error: any) {
      fastify.log.error({ err: error }, '[shipping-rules] create failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.patch('/fulfillment/shipping-rules/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as Partial<{
        name: string
        description: string | null
        priority: number
        isActive: boolean
        conditions: any
        actions: any
      }>
      const updated = await prisma.shippingRule.update({
        where: { id },
        data: {
          ...(body.name != null ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(typeof body.priority === 'number' ? { priority: body.priority } : {}),
          ...(typeof body.isActive === 'boolean' ? { isActive: body.isActive } : {}),
          ...(body.conditions !== undefined ? { conditions: body.conditions } : {}),
          ...(body.actions !== undefined ? { actions: body.actions } : {}),
        },
      })
      return updated
    } catch (error: any) {
      fastify.log.error({ err: error }, '[shipping-rules] update failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ── O.57: rules simulator ──────────────────────────────────────────
  // POST /api/fulfillment/shipping-rules/simulate
  //   Body: { context | orderId }
  // Operator either passes a real orderId (we build the context from
  // the Order) or a hand-rolled context. Returns the first matching
  // rule (mirrors applyShippingRules' first-match-wins semantics) +
  // every rule that was evaluated, so operator can see which rules
  // came before the match. No audit / triggerCount bump (this is a
  // dry simulation).
  fastify.post('/fulfillment/shipping-rules/simulate', async (request, reply) => {
    try {
      const body = request.body as {
        orderId?: string
        context?: {
          channel?: string
          marketplace?: string | null
          destinationCountry?: string | null
          weightGrams?: number | null
          orderTotalCents?: number | null
          itemCount?: number
          isPrime?: boolean | null
          hasHazmat?: boolean
          skus?: string[]
        }
      }

      let ctx: any
      if (body.orderId) {
        const o = await prisma.order.findUnique({
          where: { id: body.orderId },
          include: { items: { select: { sku: true } } },
        })
        if (!o) return reply.code(404).send({ error: 'Order not found' })
        const ship = (o.shippingAddress ?? {}) as any
        const dest = ship.country ?? ship.CountryCode ?? ship.countryCode ?? null
        ctx = {
          channel: o.channel,
          marketplace: o.marketplace,
          destinationCountry: typeof dest === 'string' ? dest : null,
          weightGrams: null,
          orderTotalCents: Math.round(Number(o.totalPrice) * 100),
          itemCount: o.items.length,
          isPrime: o.isPrime ?? null,
          hasHazmat: false,
          skus: o.items.map((i) => i.sku),
        }
      } else if (body.context) {
        ctx = {
          channel: body.context.channel ?? 'AMAZON',
          marketplace: body.context.marketplace ?? null,
          destinationCountry: body.context.destinationCountry ?? null,
          weightGrams: body.context.weightGrams ?? null,
          orderTotalCents: body.context.orderTotalCents ?? null,
          itemCount: body.context.itemCount ?? 1,
          isPrime: body.context.isPrime ?? null,
          hasHazmat: body.context.hasHazmat ?? false,
          skus: body.context.skus ?? [],
        }
      } else {
        return reply.code(400).send({ error: 'Provide either orderId or context' })
      }

      const { matchConditions } = (
        await import('../services/shipping-rules/applier.js')
      ).__test as any

      // Walk active rules in priority order; record per-rule decision.
      const rules = await prisma.shippingRule.findMany({
        where: { isActive: true },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, name: true, priority: true, conditions: true, actions: true },
      })
      const trace: Array<{
        ruleId: string
        ruleName: string
        priority: number
        matched: boolean
      }> = []
      let matched: typeof rules[number] | null = null
      for (const r of rules) {
        const ok = matchConditions((r.conditions ?? {}) as any, ctx)
        trace.push({
          ruleId: r.id,
          ruleName: r.name,
          priority: r.priority,
          matched: ok,
        })
        if (ok && !matched) {
          matched = r
          // Continue the trace so operator can see what would have
          // matched at lower priority — useful for "is my rule shadowed
          // by an earlier rule I forgot about?" debugging.
        }
      }

      return {
        context: ctx,
        matchedRule: matched
          ? {
              ruleId: matched.id,
              ruleName: matched.name,
              priority: matched.priority,
              actions: matched.actions,
            }
          : null,
        trace,
        rulesEvaluated: rules.length,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[shipping-rules/simulate] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.delete('/fulfillment/shipping-rules/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      await prisma.shippingRule.delete({ where: { id } })
      return { ok: true }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[shipping-rules] delete failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // /fulfillment/routing-rules admin page and is consumed by
  // resolveWarehouseForOrder() when bulk-create-shipments runs.
  fastify.get('/fulfillment/routing-rules', async (_request, reply) => {
    try {
      const rules = await prisma.orderRoutingRule.findMany({
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
        include: {
          warehouse: { select: { id: true, code: true, name: true } },
        },
      })
      const warehouses = await prisma.warehouse.findMany({
        where: { isActive: true },
        select: { id: true, code: true, name: true, isDefault: true },
        orderBy: [{ isDefault: 'desc' }, { code: 'asc' }],
      })
      return reply.send({ success: true, rules, warehouses })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      fastify.log.error({ err }, '[routing-rules GET] failed')
      return reply.code(500).send({ success: false, error: msg })
    }
  })

  fastify.post<{
    Body: {
      name?: string
      priority?: number
      channel?: string | null
      marketplace?: string | null
      shippingCountry?: string | null
      warehouseId?: string
      isActive?: boolean
      notes?: string | null
    }
  }>('/fulfillment/routing-rules', async (request, reply) => {
    try {
      const b = request.body ?? {}
      if (!b.name?.trim()) {
        return reply.code(400).send({ error: 'name required' })
      }
      if (!b.warehouseId) {
        return reply.code(400).send({ error: 'warehouseId required' })
      }
      const rule = await prisma.orderRoutingRule.create({
        data: {
          name: b.name.trim(),
          priority: b.priority ?? 100,
          channel: b.channel ?? null,
          marketplace: b.marketplace ?? null,
          shippingCountry: b.shippingCountry ?? null,
          warehouseId: b.warehouseId,
          isActive: b.isActive ?? true,
          notes: b.notes ?? null,
        },
      })
      return reply.code(201).send({ success: true, rule })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      fastify.log.error({ err }, '[routing-rules POST] failed')
      return reply.code(500).send({ success: false, error: msg })
    }
  })

  fastify.patch<{
    Params: { id: string }
    Body: {
      name?: string
      priority?: number
      channel?: string | null
      marketplace?: string | null
      shippingCountry?: string | null
      warehouseId?: string
      isActive?: boolean
      notes?: string | null
    }
  }>('/fulfillment/routing-rules/:id', async (request, reply) => {
    try {
      const { id } = request.params
      const b = request.body ?? {}
      const data: any = {}
      if (typeof b.name === 'string') data.name = b.name.trim()
      if (typeof b.priority === 'number') data.priority = b.priority
      if ('channel' in b) data.channel = b.channel ?? null
      if ('marketplace' in b) data.marketplace = b.marketplace ?? null
      if ('shippingCountry' in b) data.shippingCountry = b.shippingCountry ?? null
      if (typeof b.warehouseId === 'string') data.warehouseId = b.warehouseId
      if (typeof b.isActive === 'boolean') data.isActive = b.isActive
      if ('notes' in b) data.notes = b.notes ?? null
      const updated = await prisma.orderRoutingRule.update({
        where: { id },
        data,
      })
      return reply.send({ success: true, rule: updated })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('Record to update not found')) {
        return reply.code(404).send({ error: 'Rule not found' })
      }
      fastify.log.error({ err }, '[routing-rules PATCH] failed')
      return reply.code(500).send({ success: false, error: msg })
    }
  })

  fastify.delete<{ Params: { id: string } }>(
    '/fulfillment/routing-rules/:id',
    async (request, reply) => {
      try {
        const { id } = request.params
        await prisma.orderRoutingRule.delete({ where: { id } })
        return reply.send({ success: true })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('Record to delete does not exist')) {
          return reply.code(404).send({ error: 'Rule not found' })
        }
        return reply.code(500).send({ success: false, error: msg })
      }
    },
  )

  // Routing dry-run — operator types in match criteria, server returns
  // which rule (if any) would assign the warehouse.
  fastify.post<{
    Body: {
      channel?: string | null
      marketplace?: string | null
      shippingCountry?: string | null
    }
  }>('/fulfillment/routing-rules/preview', async (request, reply) => {
    try {
      const b = request.body ?? {}
      const result = await previewRouting({
        channel: b.channel ?? null,
        marketplace: b.marketplace ?? null,
        shippingCountry: b.shippingCountry ?? null,
      })
      return reply.send({ success: true, ...result })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ success: false, error: msg })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // PICK LIST — operations execution Tier-1
  // ═══════════════════════════════════════════════════════════════════
  //
  // GET /fulfillment/pick-list?warehouseId=X&status=READY_TO_PICK
  //   ?status accepts comma-separated values; defaults to
  //    DRAFT,READY_TO_PICK so newly-created shipments show up too.
  //   Returns shipments grouped by warehouse, each with its line
  //   items joined to StockLevel (so the picker sees WHERE the SKU
  //   is stocked + how many are on the shelf at that location).
  //
  // POST /fulfillment/pick-list/:shipmentId/picked
  //   Marks a shipment status → PICKED, captures pickedAt + pickedBy.
  //   Used by the "Mark picked" button per row on the page.
  //
  // The pick list is the highest-leverage operations execution surface
  // we ship — pre-this, pickers walked the warehouse with printed
  // order summaries, looked up SKU locations from memory, and the
  // process didn't scale past one or two warehouses. Best-in-class
  // (Linnworks/Cin7) ships zone-aware wave picking; this is the
  // foundation for that.

  fastify.get<{
    Querystring: { warehouseId?: string; status?: string; limit?: string }
  }>('/fulfillment/pick-list', async (request, reply) => {
    try {
      const q = request.query
      const limit = Math.min(Math.max(Number(q.limit ?? 100), 1), 500)
      const statuses =
        q.status && q.status.length > 0
          ? q.status
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : ['DRAFT', 'READY_TO_PICK']

      const where: Prisma.ShipmentWhereInput = {
        status: { in: statuses as any },
      }
      if (q.warehouseId) where.warehouseId = q.warehouseId

      const shipments = await prisma.shipment.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        take: limit,
        include: {
          warehouse: { select: { id: true, code: true, name: true } },
          order: { select: { id: true, channel: true, channelOrderId: true, customerName: true } },
          items: true,
        },
      })

      // Bulk-resolve product details + per-warehouse stock levels.
      const productIds = Array.from(
        new Set(
          shipments
            .flatMap((s) => s.items.map((i) => i.productId))
            .filter((p): p is string => !!p),
        ),
      )
      const warehouseIds = Array.from(
        new Set(shipments.map((s) => s.warehouseId).filter((w): w is string => !!w)),
      )
      const products = productIds.length > 0
        ? await prisma.product.findMany({
            where: { id: { in: productIds } },
            select: { id: true, sku: true, name: true, weightValue: true, weightUnit: true },
          })
        : []
      const stockLocations = warehouseIds.length > 0
        ? await prisma.stockLocation.findMany({
            where: { warehouseId: { in: warehouseIds } },
            select: { id: true, code: true, name: true, warehouseId: true },
          })
        : []
      const productById = new Map(products.map((p) => [p.id, p] as const))

      // Per-warehouse stock-level rows for the items we care about.
      // One bulk fetch keyed by (locationId, productId).
      const locationsByWarehouse = new Map<string, string[]>()
      for (const loc of stockLocations) {
        if (!loc.warehouseId) continue
        const arr = locationsByWarehouse.get(loc.warehouseId) ?? []
        arr.push(loc.id)
        locationsByWarehouse.set(loc.warehouseId, arr)
      }
      const locationById = new Map(stockLocations.map((l) => [l.id, l]))
      const allLocationIds = stockLocations.map((l) => l.id)
      const stockLevels =
        allLocationIds.length > 0 && productIds.length > 0
          ? await prisma.stockLevel.findMany({
              where: {
                locationId: { in: allLocationIds },
                productId: { in: productIds },
              },
              select: { locationId: true, productId: true, quantity: true, available: true },
            })
          : []
      // Index: (warehouseId, productId) → first matching StockLevel + location
      const stockKey = (whId: string, pid: string) => `${whId}::${pid}`
      const stockByKey = new Map<
        string,
        { quantity: number; available: number; locationCode: string }
      >()
      for (const sl of stockLevels) {
        const loc = locationById.get(sl.locationId)
        if (!loc?.warehouseId) continue
        // Pick the first non-zero location per (wh, product). If none
        // are non-zero, picker still sees the location code so they
        // know where to look.
        const k = stockKey(loc.warehouseId, sl.productId)
        const existing = stockByKey.get(k)
        if (!existing || (sl.available > existing.available)) {
          stockByKey.set(k, {
            quantity: sl.quantity,
            available: sl.available,
            locationCode: loc.code,
          })
        }
      }

      // Group shipments by warehouse.
      const byWarehouse = new Map<
        string,
        {
          warehouseId: string
          code: string
          name: string
          shipments: typeof shipments
        }
      >()
      const NO_WAREHOUSE_KEY = '__no_warehouse__'
      for (const s of shipments) {
        const key = s.warehouseId ?? NO_WAREHOUSE_KEY
        if (!byWarehouse.has(key)) {
          byWarehouse.set(key, {
            warehouseId: s.warehouseId ?? '',
            code: s.warehouse?.code ?? 'UNASSIGNED',
            name: s.warehouse?.name ?? 'No warehouse assigned',
            shipments: [],
          })
        }
        byWarehouse.get(key)!.shipments.push(s)
      }

      // Build response with denormalised item info.
      const responseWarehouses = Array.from(byWarehouse.values()).map((w) => ({
        warehouseId: w.warehouseId || null,
        code: w.code,
        name: w.name,
        shipmentCount: w.shipments.length,
        shipments: w.shipments.map((s) => ({
          shipmentId: s.id,
          status: s.status,
          orderId: s.orderId,
          orderRef: s.order?.channelOrderId ?? s.orderId ?? '',
          orderChannel: s.order?.channel ?? null,
          customerName: s.order?.customerName ?? null,
          createdAt: s.createdAt,
          carrierCode: s.carrierCode,
          weightGrams: s.weightGrams,
          itemCount: s.items.length,
          totalUnits: s.items.reduce((sum, it) => sum + it.quantity, 0),
          items: s.items
            .map((it) => {
              const product = it.productId ? productById.get(it.productId) : null
              const stock =
                s.warehouseId && it.productId
                  ? stockByKey.get(stockKey(s.warehouseId, it.productId))
                  : null
              return {
                shipmentItemId: it.id,
                productId: it.productId,
                sku: it.sku,
                productName: product?.name ?? null,
                weightValue: product?.weightValue ?? null,
                weightUnit: product?.weightUnit ?? null,
                quantity: it.quantity,
                location: stock
                  ? {
                      locationCode: stock.locationCode,
                      onHand: stock.quantity,
                      available: stock.available,
                    }
                  : null,
              }
            })
            // Pick-path optimisation: sort items by location code (zone
            // → aisle → bin), with unlocated items at the end so the
            // picker walks the known shelves first.
            .sort((a, b) => {
              const aLoc = a.location?.locationCode ?? '￿'
              const bLoc = b.location?.locationCode ?? '￿'
              return aLoc.localeCompare(bLoc)
            }),
        })),
      }))

      const totals = {
        warehouses: responseWarehouses.length,
        shipments: shipments.length,
        items: shipments.reduce((s, sh) => s + sh.items.length, 0),
        units: shipments.reduce(
          (s, sh) => s + sh.items.reduce((u, it) => u + it.quantity, 0),
          0,
        ),
      }

      return reply.send({
        success: true,
        warehouses: responseWarehouses,
        totals,
        statusFilter: statuses,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      fastify.log.error({ err }, '[fulfillment/pick-list] failed')
      return reply.code(500).send({ success: false, error: message })
    }
  })

  fastify.post<{
    Params: { id: string }
    Body: { pickedBy?: string }
  }>('/fulfillment/pick-list/:id/picked', async (request, reply) => {
    try {
      const { id } = request.params
      const body = request.body ?? {}
      const updated = await prisma.shipment.update({
        where: { id },
        data: {
          status: 'PICKED',
          pickedAt: new Date(),
          pickedBy: body.pickedBy ?? null,
          version: { increment: 1 },
        },
      })
      return reply.send({ success: true, shipment: updated })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      fastify.log.error({ err }, '[pick-list/:id/picked] failed')
      return reply.code(500).send({ success: false, error: message })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // INBOUND SHIPMENTS
  // ═══════════════════════════════════════════════════════════════════

  fastify.get('/fulfillment/inbound', async (request, reply) => {
    try {
      const q = request.query as any
      const where: any = {}
      if (q.type && q.type !== 'ALL') where.type = q.type
      // H.3: status accepts comma-separated multi-select.
      if (q.status && q.status !== 'ALL') {
        const statuses = String(q.status).split(',').map((s) => s.trim()).filter(Boolean)
        if (statuses.length === 1) where.status = statuses[0]
        else if (statuses.length > 1) where.status = { in: statuses }
      }
      // H.3: search across reference / trackingNumber / carrierCode +
      // any item.sku containing the term.
      if (q.search?.trim()) {
        const s = q.search.trim()
        where.OR = [
          { reference: { contains: s, mode: 'insensitive' } },
          { trackingNumber: { contains: s, mode: 'insensitive' } },
          { carrierCode: { contains: s, mode: 'insensitive' } },
          { fbaShipmentId: { contains: s, mode: 'insensitive' } },
          { asnNumber: { contains: s, mode: 'insensitive' } },
          { purchaseOrder: { poNumber: { contains: s, mode: 'insensitive' } } },
          { items: { some: { sku: { contains: s, mode: 'insensitive' } } } },
        ]
      }

      // H.5: delayed filter — shipments past expectedAt in non-terminal
      // status. Compounds with type/status/search filters.
      if (q.delayed === 'true') {
        where.expectedAt = { lt: new Date() }
        const nonTerminal = ['DRAFT', 'SUBMITTED', 'IN_TRANSIT', 'ARRIVED', 'RECEIVING', 'PARTIALLY_RECEIVED']
        if (where.status) {
          // Caller already filtered by status — intersect rather than overwrite.
          // (Most common case: q.delayed=true alone, no status filter.)
        } else {
          where.status = { in: nonTerminal as any }
        }
      }

      // H.3: pagination + sort.
      const page = Math.max(1, Math.floor(safeNum(q.page, 1) ?? 1))
      const pageSize = Math.min(200, Math.max(1, Math.floor(safeNum(q.pageSize, 50) ?? 50)))
      const skip = (page - 1) * pageSize
      const sortBy = (q.sortBy ?? 'createdAt') as string
      const sortDir = (q.sortDir === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc'
      const orderBy =
        sortBy === 'expectedAt' ? { expectedAt: sortDir } :
        sortBy === 'status'     ? { status: sortDir } :
        sortBy === 'type'       ? { type: sortDir } :
        sortBy === 'updatedAt'  ? { updatedAt: sortDir } :
        { createdAt: sortDir }

      const [total, items] = await Promise.all([
        prisma.inboundShipment.count({ where }),
        prisma.inboundShipment.findMany({
          where,
          include: {
            items: true,
            warehouse: { select: { code: true, name: true } },
            purchaseOrder: { select: { poNumber: true, supplierId: true } },
            workOrder: { select: { id: true, productId: true, quantity: true } },
            _count: { select: { attachments: true, discrepancies: true } },
          },
          orderBy,
          skip,
          take: pageSize,
        }),
      ])
      return {
        items,
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fulfillment/inbound] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // H.3 — KPI strip for /fulfillment/inbound. Counts driven by the
  // post-H.2 status taxonomy + open discrepancies. Computed in one
  // groupBy round-trip + two scalar counts.
  fastify.get('/fulfillment/inbound/kpis', async (_request, reply) => {
    try {
      const now = Date.now()
      const weekFromNow = new Date(now + 7 * 86400_000)

      const [byStatus, byType, openDiscCount, arrivingThisWeek, delayedCount, qcQueueCount] = await Promise.all([
        prisma.inboundShipment.groupBy({
          by: ['status'],
          _count: { status: true },
        }),
        prisma.inboundShipment.groupBy({
          by: ['type'],
          _count: { type: true },
        }),
        prisma.inboundDiscrepancy.count({
          where: { status: { in: ['REPORTED', 'ACKNOWLEDGED'] } },
        }),
        prisma.inboundShipment.count({
          where: {
            expectedAt: { gte: new Date(), lte: weekFromNow },
            status: { in: ['SUBMITTED', 'IN_TRANSIT'] },
          },
        }),
        // H.5 — shipments past expected arrival in non-terminal status.
        prisma.inboundShipment.count({
          where: {
            expectedAt: { lt: new Date() },
            status: { in: ['DRAFT', 'SUBMITTED', 'IN_TRANSIT', 'ARRIVED', 'RECEIVING', 'PARTIALLY_RECEIVED'] },
          },
        }),
        // H.12 — items currently in QC quarantine (FAIL or HOLD) on
        // any non-CLOSED shipment. CLOSED shipments are excluded
        // because their QC dispositions are historical.
        prisma.inboundShipmentItem.count({
          where: {
            qcStatus: { in: ['FAIL', 'HOLD'] },
            inboundShipment: { status: { not: 'CLOSED' } },
          },
        }),
      ])

      const statusCounts: Record<string, number> = {}
      for (const r of byStatus) statusCounts[r.status] = r._count.status
      const typeCounts: Record<string, number> = {}
      for (const r of byType) typeCounts[r.type] = r._count.type

      const openStatuses = ['DRAFT', 'SUBMITTED', 'IN_TRANSIT', 'ARRIVED', 'RECEIVING', 'PARTIALLY_RECEIVED', 'RECEIVED']
      const openShipments = openStatuses.reduce((a, s) => a + (statusCounts[s] ?? 0), 0)

      return {
        openShipments,
        inTransit: statusCounts.IN_TRANSIT ?? 0,
        arrivingThisWeek,
        delayed: delayedCount,
        openDiscrepancies: openDiscCount,
        qcQueueCount,
        statusCounts,
        typeCounts,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fulfillment/inbound/kpis] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // H.14 — SSE stream of inbound events. Long-lived GET; keeps a
  // single open connection per client. We send a comment line
  // every 25s so middleware (Railway proxy, Cloudflare etc.) can't
  // close idle connections. EventSource auto-reconnects on its own,
  // so a transient drop is invisible to the operator.
  fastify.get('/fulfillment/inbound/events', async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      // Tell proxies not to buffer (Cloudflare honours this; Railway's
      // Envoy passes it through).
      'X-Accel-Buffering': 'no',
    })
    // Initial hello so the client knows the stream is live.
    reply.raw.write(`event: ping\ndata: ${JSON.stringify({ ts: Date.now(), connected: true })}\n\n`)

    const send = (event: any) => {
      try {
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      } catch {
        // If write throws, the connection is dead — cleanup runs in close handler.
      }
    }

    const unsubscribe = subscribeInboundEvents(send)
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: heartbeat ${Date.now()}\n\n`)
      } catch {
        // ignore
      }
    }, 25_000)

    request.raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })

    // Keep handler alive by returning a never-resolving promise.
    // Fastify will tear down when the connection closes.
    await new Promise(() => {})
  })

  fastify.get('/fulfillment/inbound/events/stats', async () => {
    return { listenerCount: getListenerCount() }
  })

  // H.15 — server-side inbound carrier registry. Frontend pulls
  // this on load instead of duplicating the hardcoded map. PDFs +
  // emails (when added) can resolveTrackingUrl(...) directly.
  fastify.get('/fulfillment/carriers/inbound', async () => {
    return { items: listInboundCarriers() }
  })

  fastify.post('/fulfillment/carriers/inbound/validate-tracking', async (request) => {
    const body = request.body as { carrierCode?: string; trackingNumber?: string }
    return validateTrackingFormat(body.carrierCode, body.trackingNumber)
  })

  // H.12 — QC queue. Cross-shipment view of items currently in
  // FAIL/HOLD on non-CLOSED shipments. The existing release-hold
  // endpoint stays as the action surface; this just lists what's
  // in the queue with enough context for the operator to decide.
  fastify.get('/fulfillment/inbound/qc-queue', async (_request, reply) => {
    try {
      const items = await prisma.inboundShipmentItem.findMany({
        where: {
          qcStatus: { in: ['FAIL', 'HOLD'] },
          inboundShipment: { status: { not: 'CLOSED' } },
        },
        include: {
          inboundShipment: {
            select: {
              id: true,
              type: true,
              status: true,
              reference: true,
              expectedAt: true,
              warehouseId: true,
            },
          },
        },
        orderBy: [
          { inboundShipment: { expectedAt: 'asc' } },
          { id: 'asc' },
        ],
      })

      const productIds = Array.from(new Set(items.map((i) => i.productId).filter((x): x is string => !!x)))
      const products = productIds.length > 0
        ? await prisma.product.findMany({
            where: { id: { in: productIds } },
            select: { id: true, name: true },
          })
        : []
      const nameById = new Map(products.map((p) => [p.id, p.name]))

      return {
        count: items.length,
        items: items.map((it) => ({
          itemId: it.id,
          sku: it.sku,
          productId: it.productId,
          productName: it.productId ? (nameById.get(it.productId) ?? null) : null,
          quantityExpected: it.quantityExpected,
          quantityReceived: it.quantityReceived,
          qcStatus: it.qcStatus,
          qcNotes: it.qcNotes,
          // Photos uploaded during the receive flow — surfaced so the
          // QC supervisor can review damage evidence before deciding
          // pass vs scrap.
          photoUrls: it.photoUrls ?? [],
          shipment: {
            id: it.inboundShipment.id,
            type: it.inboundShipment.type,
            status: it.inboundShipment.status,
            reference: it.inboundShipment.reference,
            expectedAt: it.inboundShipment.expectedAt,
          },
        })),
      }
    } catch (err: any) {
      fastify.log.error({ err }, '[fulfillment/inbound/qc-queue] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.get('/fulfillment/inbound/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const shipment = await prisma.inboundShipment.findUnique({
      where: { id },
      include: {
        items: { include: { discrepancies: true, receipts: { orderBy: { receivedAt: 'desc' } } } },
        warehouse: true,
        purchaseOrder: true,
        workOrder: true,
        // H.1 additions — full bundle for the detail surface.
        attachments: { orderBy: { uploadedAt: 'desc' } },
        discrepancies: { where: { inboundShipmentItemId: null }, orderBy: { reportedAt: 'desc' } },
      },
    })
    if (!shipment) return reply.code(404).send({ error: 'Inbound shipment not found' })

    // H.11 — landed cost summary. Goods = sum of (unitCostCents *
    // quantityExpected) — using expected, not received, so the
    // landed cost is the planned figure regardless of receive
    // progress. Operators with cost variance use the discrepancy
    // surface to track actuals.
    const goodsCents = shipment.items.reduce((sum, it) => {
      return sum + (it.unitCostCents ?? 0) * it.quantityExpected
    }, 0)
    const shippingCents = shipment.shippingCostCents ?? 0
    const customsCents = shipment.customsCostCents ?? 0
    const dutiesCents = shipment.dutiesCostCents ?? 0
    const insuranceCents = shipment.insuranceCostCents ?? 0
    const totalCents = goodsCents + shippingCents + customsCents + dutiesCents + insuranceCents

    return {
      ...shipment,
      landedCost: {
        currencyCode: shipment.currencyCode,
        exchangeRate: shipment.exchangeRate,
        goodsCents,
        shippingCents,
        customsCents,
        dutiesCents,
        insuranceCents,
        totalCents,
      },
    }
  })

  // H.11 — patch costs. Updates shipment-level cost fields and/or
  // per-line unitCostCents in a single call. Empty body is a no-op
  // (returns the unchanged shipment). Pass `null` to clear a field.
  fastify.patch('/fulfillment/inbound/:id/costs', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as {
        currencyCode?: string
        exchangeRate?: number | null
        shippingCostCents?: number | null
        customsCostCents?: number | null
        dutiesCostCents?: number | null
        insuranceCostCents?: number | null
        items?: Array<{ id: string; unitCostCents: number | null }>
      }
      const existing = await prisma.inboundShipment.findUnique({ where: { id } })
      if (!existing) return reply.code(404).send({ error: 'Inbound shipment not found' })

      const data: any = {}
      if (body.currencyCode !== undefined) data.currencyCode = body.currencyCode
      if (body.exchangeRate !== undefined) data.exchangeRate = body.exchangeRate
      if (body.shippingCostCents !== undefined) data.shippingCostCents = body.shippingCostCents
      if (body.customsCostCents !== undefined) data.customsCostCents = body.customsCostCents
      if (body.dutiesCostCents !== undefined) data.dutiesCostCents = body.dutiesCostCents
      if (body.insuranceCostCents !== undefined) data.insuranceCostCents = body.insuranceCostCents

      if (Object.keys(data).length > 0) {
        await prisma.inboundShipment.update({ where: { id }, data })
      }

      if (body.items && body.items.length > 0) {
        // updateMany doesn't support per-row values; loop with bounded
        // concurrency. Item count per shipment is small (<100) so
        // sequential is fine.
        for (const it of body.items) {
          await prisma.inboundShipmentItem.update({
            where: { id: it.id },
            data: { unitCostCents: it.unitCostCents },
          })
        }
      }

      publishInboundEvent({ type: 'inbound.updated', shipmentId: id, reason: 'costs', ts: Date.now() })
      return { ok: true }
    } catch (err: any) {
      fastify.log.error({ err }, '[inbound/:id/costs] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // H.16 — compliance update. Per-line lot/expiry on
  // InboundShipmentItem; HS code + countryOfOrigin live on Product
  // and are updated via the existing /api/products PATCH.
  fastify.patch('/fulfillment/inbound/:id/compliance', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as {
        items?: Array<{
          id: string
          lotNumber?: string | null
          expiryDate?: string | null
        }>
      }
      const existing = await prisma.inboundShipment.findUnique({ where: { id } })
      if (!existing) return reply.code(404).send({ error: 'Inbound shipment not found' })

      if (body.items && body.items.length > 0) {
        for (const it of body.items) {
          const data: any = {}
          if (it.lotNumber !== undefined) data.lotNumber = it.lotNumber
          if (it.expiryDate !== undefined) {
            data.expiryDate = it.expiryDate ? new Date(it.expiryDate) : null
          }
          if (Object.keys(data).length > 0) {
            await prisma.inboundShipmentItem.update({ where: { id: it.id }, data })
          }
        }
      }

      publishInboundEvent({ type: 'inbound.updated', shipmentId: id, reason: 'compliance', ts: Date.now() })
      return { ok: true }
    } catch (err: any) {
      fastify.log.error({ err }, '[inbound/:id/compliance] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // H.17 — inbound discrepancy report PDF. Generates a one-page
  // report of every discrepancy on the shipment for the operator
  // to forward to the supplier. Email automation isn't wired yet
  // (no email infra — TECH_DEBT entry); operator downloads + sends
  // via their own mail client.
  fastify.get('/fulfillment/inbound/:id/discrepancies/report.pdf', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const shipment = await prisma.inboundShipment.findUnique({
        where: { id },
        include: {
          items: { select: { id: true, sku: true, productId: true } },
          discrepancies: { orderBy: { reportedAt: 'asc' } },
          purchaseOrder: { include: { supplier: { select: { name: true } } } },
        },
      })
      if (!shipment) return reply.code(404).send({ error: 'Inbound shipment not found' })

      // Pull line-level discrepancies separately so we can resolve
      // SKU + product name per row.
      const lineDiscs = await prisma.inboundDiscrepancy.findMany({
        where: { inboundShipmentItemId: { in: shipment.items.map((i) => i.id) } },
        orderBy: { reportedAt: 'asc' },
      })
      const allDiscs = [...shipment.discrepancies, ...lineDiscs].sort((a, b) => a.reportedAt.getTime() - b.reportedAt.getTime())

      const itemById = new Map(shipment.items.map((i) => [i.id, i]))
      const productIds = Array.from(new Set(shipment.items.map((i) => i.productId).filter((x): x is string => !!x)))
      const products = productIds.length > 0
        ? await prisma.product.findMany({
            where: { id: { in: productIds } },
            select: { id: true, name: true },
          })
        : []
      const productNameById = new Map(products.map((p) => [p.id, p.name]))

      const brandSettings = await prisma.brandSettings.findFirst().catch(() => null)
      const brand = {
        name: brandSettings?.brandName ?? 'Nexus Commerce',
        addressLines: [
          brandSettings?.addressLine1,
          [brandSettings?.postalCode, brandSettings?.city].filter(Boolean).join(' '),
          brandSettings?.country,
        ].filter((s): s is string => !!s && s.trim().length > 0),
        logoUrl: brandSettings?.logoUrl ?? null,
      }

      const pdf = await renderInboundDiscrepancyPdf({
        brand,
        shipment: {
          id: shipment.id,
          reference: shipment.reference,
          type: shipment.type,
          status: shipment.status,
          expectedAt: shipment.expectedAt,
          arrivedAt: shipment.arrivedAt,
          supplierName: shipment.purchaseOrder?.supplier?.name ?? null,
        },
        discrepancies: allDiscs.map((d) => {
          const item = d.inboundShipmentItemId ? itemById.get(d.inboundShipmentItemId) : null
          return {
            reasonCode: d.reasonCode,
            status: d.status,
            reportedAt: d.reportedAt,
            reportedBy: d.reportedBy,
            description: d.description,
            expectedValue: d.expectedValue,
            actualValue: d.actualValue,
            quantityImpact: d.quantityImpact,
            costImpactCents: d.costImpactCents,
            sku: item?.sku ?? null,
            productName: item?.productId ? (productNameById.get(item.productId) ?? null) : null,
          }
        }),
        currencyCode: shipment.currencyCode ?? 'EUR',
      })

      reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="discrepancy-report-${shipment.reference ?? shipment.id}.pdf"`)
        .send(pdf)
    } catch (err: any) {
      fastify.log.error({ err }, '[inbound/:id/discrepancies/report.pdf] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // H.16 — recall lookup. Given a lot number, return every
  // InboundShipmentItem that received it, with shipment + product
  // context. Critical for safety-recall responses on motorcycle gear
  // (helmets, body armor) where the recall scope is "this lot".
  fastify.get('/fulfillment/inbound/lots/:lotNumber', async (request, reply) => {
    try {
      const { lotNumber } = request.params as { lotNumber: string }
      if (!lotNumber.trim()) return reply.code(400).send({ error: 'lotNumber required' })

      const items = await prisma.inboundShipmentItem.findMany({
        where: { lotNumber: lotNumber.trim() },
        include: {
          inboundShipment: {
            select: {
              id: true,
              type: true,
              status: true,
              reference: true,
              expectedAt: true,
              arrivedAt: true,
            },
          },
        },
        orderBy: { id: 'asc' },
      })

      const productIds = Array.from(new Set(items.map((i) => i.productId).filter((x): x is string => !!x)))
      const products = productIds.length > 0
        ? await prisma.product.findMany({
            where: { id: { in: productIds } },
            select: { id: true, name: true, sku: true },
          })
        : []
      const byId = new Map(products.map((p) => [p.id, p]))

      return {
        lotNumber: lotNumber.trim(),
        count: items.length,
        items: items.map((it) => ({
          itemId: it.id,
          sku: it.sku,
          productName: it.productId ? (byId.get(it.productId)?.name ?? null) : null,
          quantityExpected: it.quantityExpected,
          quantityReceived: it.quantityReceived,
          expiryDate: it.expiryDate,
          shipment: it.inboundShipment,
        })),
      }
    } catch (err: any) {
      fastify.log.error({ err }, '[inbound/lots/:lotNumber] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.post('/fulfillment/inbound', async (request, reply) => {
    try {
      const body = request.body as {
        type?: 'FBA' | 'SUPPLIER' | 'MANUFACTURING' | 'TRANSFER'
        warehouseId?: string
        purchaseOrderId?: string
        workOrderId?: string
        fbaShipmentId?: string
        reference?: string
        expectedAt?: string
        notes?: string
        // H.1 additions
        asnNumber?: string
        asnFileUrl?: string
        carrierCode?: string
        trackingNumber?: string
        trackingUrl?: string
        currencyCode?: string
        exchangeRate?: number
        shippingCostCents?: number
        customsCostCents?: number
        dutiesCostCents?: number
        insuranceCostCents?: number
        createdById?: string
        items?: Array<{
          productId?: string
          sku: string
          quantityExpected: number
          purchaseOrderItemId?: string
          // H.1
          unitCostCents?: number
        }>
      }
      if (!body.type) return reply.code(400).send({ error: 'type is required' })
      const items = Array.isArray(body.items) ? body.items : []

      const warehouseId = body.warehouseId ?? (await prisma.warehouse.findFirst({ where: { isDefault: true } }))?.id

      const shipment = await prisma.inboundShipment.create({
        data: {
          type: body.type,
          status: 'DRAFT',
          warehouseId,
          purchaseOrderId: body.purchaseOrderId ?? null,
          workOrderId: body.workOrderId ?? null,
          fbaShipmentId: body.fbaShipmentId ?? null,
          reference: body.reference ?? null,
          expectedAt: body.expectedAt ? new Date(body.expectedAt) : null,
          notes: body.notes ?? null,
          // H.1 — pass-through. defaults handle currencyCode + photoUrls.
          asnNumber: body.asnNumber ?? null,
          asnFileUrl: body.asnFileUrl ?? null,
          carrierCode: body.carrierCode ?? null,
          trackingNumber: body.trackingNumber ?? null,
          trackingUrl: body.trackingUrl ?? null,
          ...(body.currencyCode ? { currencyCode: body.currencyCode } : {}),
          exchangeRate: body.exchangeRate != null ? body.exchangeRate : null,
          shippingCostCents: body.shippingCostCents ?? null,
          customsCostCents: body.customsCostCents ?? null,
          dutiesCostCents: body.dutiesCostCents ?? null,
          insuranceCostCents: body.insuranceCostCents ?? null,
          createdById: body.createdById ?? null,
          items: {
            create: items.map((it) => ({
              productId: it.productId ?? null,
              sku: it.sku,
              quantityExpected: it.quantityExpected,
              purchaseOrderItemId: it.purchaseOrderItemId ?? null,
              unitCostCents: it.unitCostCents ?? null,
            })),
          },
        },
        include: { items: true },
      })
      publishInboundEvent({ type: 'inbound.created', shipmentId: shipment.id, ts: Date.now() })
      return shipment
    } catch (error: any) {
      fastify.log.error({ err: error }, '[POST /fulfillment/inbound] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // Receive inbound items. H.0b — event-log idempotent flow,
  // refactored in H.2 to delegate to inbound.service. Body shape
  // unchanged for backwards compat; new optional photoUrls per item
  // appends to the cached InboundShipmentItem.photoUrls array.
  // H.10a — cross-shipment scan-receive. Returns every open
  // InboundShipmentItem matching a SKU so the bulk-receive UI can
  // route the scan to the right shipment without the operator
  // having to look it up. "Open" = parent shipment not in
  // RECEIVED/RECONCILED/CLOSED/CANCELLED, AND quantityReceived <
  // quantityExpected. Sorted by (expectedAt asc, createdAt asc) so
  // the oldest open shipment ranks first — that's almost always
  // what the operator wants when there's ambiguity.
  fastify.get('/fulfillment/inbound/receive-candidates', async (request, reply) => {
    const q = request.query as { sku?: string }
    const sku = (q.sku ?? '').trim()
    if (!sku) return reply.code(400).send({ error: 'sku query param required' })

    const TERMINAL = ['RECEIVED', 'RECONCILED', 'CLOSED', 'CANCELLED']

    const candidates = await prisma.inboundShipmentItem.findMany({
      where: {
        sku,
        inboundShipment: { status: { notIn: TERMINAL as any } },
      },
      include: {
        inboundShipment: {
          select: {
            id: true,
            reference: true,
            type: true,
            status: true,
            expectedAt: true,
            createdAt: true,
            warehouseId: true,
          },
        },
      },
      orderBy: [
        { inboundShipment: { expectedAt: 'asc' } },
        { inboundShipment: { createdAt: 'asc' } },
      ],
    })

    const open = candidates.filter((c) => c.quantityReceived < c.quantityExpected)

    // Resolve product names in one extra query so the UI can show
    // "SKU + product name" without a second roundtrip per row.
    const productIds = Array.from(new Set(open.map((c) => c.productId).filter((x): x is string => !!x)))
    const products = productIds.length > 0
      ? await prisma.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, name: true },
        })
      : []
    const nameById = new Map(products.map((p) => [p.id, p.name]))

    return {
      sku,
      count: open.length,
      candidates: open.map((c) => ({
        itemId: c.id,
        sku: c.sku,
        productName: c.productId ? (nameById.get(c.productId) ?? null) : null,
        productId: c.productId,
        quantityExpected: c.quantityExpected,
        quantityReceived: c.quantityReceived,
        remaining: c.quantityExpected - c.quantityReceived,
        shipment: {
          id: c.inboundShipment.id,
          reference: c.inboundShipment.reference,
          type: c.inboundShipment.type,
          status: c.inboundShipment.status,
          expectedAt: c.inboundShipment.expectedAt,
        },
      })),
    }
  })

  fastify.post('/fulfillment/inbound/:id/receive', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as {
        items?: Array<{
          itemId: string
          quantityReceived: number
          qcStatus?: string
          qcNotes?: string
          idempotencyKey?: string
          notes?: string
          photoUrls?: string[]
        }>
        actor?: string
        receivedById?: string
      }
      const items = Array.isArray(body.items) ? body.items : []
      const updated = await inboundReceiveItems({
        shipmentId: id,
        items,
        actor: body.actor ?? 'inbound-receive',
        receivedById: body.receivedById,
      })
      publishInboundEvent({ type: 'inbound.received', shipmentId: id, ts: Date.now() })
      return updated
    } catch (error: any) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message })
      fastify.log.error({ err: error }, '[inbound/:id/receive] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // H.2 — explicit state machine transition. Auto-transitions still
  // happen on receive + discrepancy resolution; this endpoint is for
  // operator-driven moves (DRAFT→SUBMITTED, SUBMITTED→IN_TRANSIT, etc.).
  fastify.post('/fulfillment/inbound/:id/transition', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as { status?: string; actor?: string }
      if (!body.status) return reply.code(400).send({ error: 'status required' })
      const updated = await inboundTransitionStatus({
        shipmentId: id,
        newStatus: body.status as any,
        actor: body.actor,
      })
      return updated
    } catch (error: any) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message })
      if (error instanceof InvalidTransitionError) return reply.code(409).send({ error: error.message })
      fastify.log.error({ err: error }, '[inbound/:id/transition] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // H.2 — release QC HOLD/FAIL units to stock. Default releases the
  // full held quantity; pass `quantity` for a partial release (rest
  // stays excluded from inventory).
  // QC scrap — terminal disposition for items that failed inspection
  // and will NOT be received into stock. Distinct from FAIL (transient)
  // and HOLD (pending decision). Sets qcStatus=SCRAPPED + appends a
  // reason to qcNotes. Does NOT mutate stock — the item was never
  // received via release-hold, so there's nothing to deduct.
  //
  // Use case: supplier sent damaged goods, supplier credit requested,
  // line item is dead. Photos uploaded earlier remain on photoUrls
  // for supplier-claim audit.
  fastify.post<{
    Params: { id: string; itemId: string }
    Body: { reason?: string; actor?: string }
  }>('/fulfillment/inbound/:id/items/:itemId/scrap', async (request, reply) => {
    try {
      const { id, itemId } = request.params
      const body = request.body ?? {}
      const item = await prisma.inboundShipmentItem.findUnique({
        where: { id: itemId },
        select: { id: true, inboundShipmentId: true, qcStatus: true, qcNotes: true },
      })
      if (!item) {
        return reply.code(404).send({ error: 'Item not found' })
      }
      if (item.inboundShipmentId !== id) {
        return reply
          .code(400)
          .send({ error: 'Item does not belong to this shipment' })
      }
      if (item.qcStatus === 'SCRAPPED') {
        // Idempotent: already scrapped, return current state
        return reply.send({ success: true, item, alreadyScrapped: true })
      }

      const reason = body.reason?.trim() ?? null
      const actor = body.actor?.trim() ?? null
      const noteSuffix = reason
        ? `\n[SCRAPPED ${new Date().toISOString()}${actor ? ` by ${actor}` : ''}] ${reason}`
        : `\n[SCRAPPED ${new Date().toISOString()}${actor ? ` by ${actor}` : ''}]`
      const newNotes = item.qcNotes ? item.qcNotes + noteSuffix : noteSuffix.trim()

      const updated = await prisma.inboundShipmentItem.update({
        where: { id: itemId },
        data: {
          qcStatus: 'SCRAPPED',
          qcNotes: newNotes,
        },
      })
      return reply.send({ success: true, item: updated })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      fastify.log.error({ err }, '[inbound/:id/items/:id/scrap] failed')
      return reply.code(500).send({ error: message })
    }
  })

  fastify.post('/fulfillment/inbound/:id/items/:itemId/release-hold', async (request, reply) => {
    try {
      const { id, itemId } = request.params as { id: string; itemId: string }
      const body = request.body as { quantity?: number; actor?: string }
      const mv = await inboundReleaseQcHold({
        shipmentId: id,
        itemId,
        quantity: body.quantity,
        actor: body.actor,
      })
      return { ok: true, movement: mv }
    } catch (error: any) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message })
      fastify.log.error({ err: error }, '[inbound/:id/items/:id/release-hold] failed')
      return reply.code(400).send({ error: error?.message ?? String(error) })
    }
  })

  // H.7 — multipart upload: receives a binary file (camera capture or
  // gallery pick), uploads to Cloudinary in inbound/{shipmentId}/items/
  // {itemId}/, then appends the secure URL to InboundShipmentItem.
  // photoUrls. Server-mediated (vs client-direct) to keep the
  // Cloudinary credentials off the wire and to stamp the folder
  // structure server-side.
  fastify.post('/fulfillment/inbound/:id/items/:itemId/upload-photo', async (request, reply) => {
    try {
      const { id, itemId } = request.params as { id: string; itemId: string }
      if (!isCloudinaryConfigured()) {
        return reply.code(503).send({ error: 'Cloudinary not configured (CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET)' })
      }
      const data = await (request as any).file?.()
      if (!data) {
        return reply.code(400).send({ error: 'multipart file required' })
      }
      const buffer = await data.toBuffer()
      if (buffer.length > 10 * 1024 * 1024) {
        return reply.code(413).send({ error: 'file too large (max 10MB)' })
      }
      // Confirm the item belongs to the shipment before uploading —
      // saves a wasted Cloudinary upload if the path is wrong.
      const item = await prisma.inboundShipmentItem.findUnique({
        where: { id: itemId },
        select: { id: true, inboundShipmentId: true },
      })
      if (!item) return reply.code(404).send({ error: 'item not found' })
      if (item.inboundShipmentId !== id) {
        return reply.code(400).send({ error: 'item does not belong to this shipment' })
      }
      const result = await uploadBufferToCloudinary(buffer, {
        folder: `inbound/${id}/items/${itemId}`,
      })
      const updated = await inboundAppendItemPhoto({ shipmentItemId: itemId, url: result.url })
      return { ok: true, url: result.url, photoUrls: updated.photoUrls }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[inbound/:id/items/:id/upload-photo] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // H.2 — append a photo URL to an item's proof gallery. Cloudinary
  // direct-uploads from the frontend POST the resulting URL here.
  fastify.post('/fulfillment/inbound/:id/items/:itemId/photos', async (request, reply) => {
    try {
      const { itemId } = request.params as { id: string; itemId: string }
      const body = request.body as { url?: string }
      if (!body.url) return reply.code(400).send({ error: 'url required' })
      const item = await inboundAppendItemPhoto({ shipmentItemId: itemId, url: body.url })
      return item
    } catch (error: any) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message })
      fastify.log.error({ err: error }, '[inbound/:id/items/:id/photos] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // H.2 — register an attachment uploaded to Cloudinary. Body:
  //   { kind, url, filename?, contentType?, sizeBytes?, uploadedBy? }
  // kind is one of PHOTO|INVOICE|PACKING|CUSTOMS|ASN|OTHER.
  fastify.post('/fulfillment/inbound/:id/attachments', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as any
      if (!body.kind || !body.url) return reply.code(400).send({ error: 'kind + url required' })
      const att = await inboundAddAttachment({
        shipmentId: id,
        kind: body.kind,
        url: body.url,
        filename: body.filename,
        contentType: body.contentType,
        sizeBytes: body.sizeBytes,
        uploadedBy: body.uploadedBy,
      })
      return att
    } catch (error: any) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message })
      fastify.log.error({ err: error }, '[inbound/:id/attachments] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // H.2 — record a discrepancy (ship-level or line-level).
  fastify.post('/fulfillment/inbound/:id/discrepancies', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as any
      if (!body.reasonCode) return reply.code(400).send({ error: 'reasonCode required' })
      const d = await inboundRecordDiscrepancy({
        shipmentId: id,
        itemId: body.itemId,
        reasonCode: body.reasonCode,
        expectedValue: body.expectedValue,
        actualValue: body.actualValue,
        quantityImpact: body.quantityImpact,
        costImpactCents: body.costImpactCents,
        description: body.description,
        photoUrls: body.photoUrls,
        reportedBy: body.reportedBy,
      })
      return d
    } catch (error: any) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message })
      fastify.log.error({ err: error }, '[inbound/:id/discrepancies] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // H.2 — update discrepancy status. Triggers maybeAutoTransition so
  // RECEIVED → RECONCILED happens once everything's resolved.
  fastify.patch('/fulfillment/inbound/discrepancies/:did', async (request, reply) => {
    try {
      const { did } = request.params as { did: string }
      const body = request.body as { status?: string; resolutionNotes?: string; actor?: string }
      if (!body.status) return reply.code(400).send({ error: 'status required' })
      const valid = ['REPORTED', 'ACKNOWLEDGED', 'RESOLVED', 'DISPUTED', 'WAIVED']
      if (!valid.includes(body.status)) return reply.code(400).send({ error: `status must be one of ${valid.join(', ')}` })
      const updated = await inboundUpdateDiscrepancyStatus({
        discrepancyId: did,
        status: body.status as any,
        resolutionNotes: body.resolutionNotes,
        actor: body.actor,
      })
      return updated
    } catch (error: any) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message })
      fastify.log.error({ err: error }, '[inbound/discrepancies/:id PATCH] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // /close kept as a convenience alias for transition→CLOSED.
  fastify.post('/fulfillment/inbound/:id/close', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const updated = await inboundTransitionStatus({
        shipmentId: id,
        newStatus: 'CLOSED' as any,
      })
      return updated
    } catch (error: any) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message })
      if (error instanceof InvalidTransitionError) return reply.code(409).send({ error: error.message })
      fastify.log.error({ err: error }, '[inbound/:id/close] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // FBA Send-to-Amazon (B.6 scaffold)
  // ═══════════════════════════════════════════════════════════════════

  // H.8a — real SP-API createInboundShipmentPlan. v0 endpoint
  // (deprecated but functional; 2024-03-20 multi-step flow lands in
  // a future migration — see TECH_DEBT). Returns Amazon-issued
  // shipment plans grouped by destination FC. 503 with a clear
  // message when SP-API isn't configured rather than silently
  // falling back to a stub.
  fastify.post('/fulfillment/fba/plan-shipment', async (request, reply) => {
    try {
      const body = request.body as {
        items?: Array<{ sku: string; quantity: number; asin?: string; condition?: string; quantityInCase?: number }>
        labelPrepPreference?: 'SELLER_LABEL' | 'AMAZON_LABEL_ONLY' | 'AMAZON_LABEL_PREFERRED'
      }
      const items = Array.isArray(body.items) ? body.items : []
      if (items.length === 0) return reply.code(400).send({ error: 'items[] required' })

      if (!isFbaInboundConfigured()) {
        return reply.code(503).send({
          error: 'SP-API not configured. Set AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET, AMAZON_REFRESH_TOKEN, AMAZON_MARKETPLACE_ID.',
        })
      }

      const result = await fbaCreateInboundShipmentPlan({
        items: items.map((it) => ({
          sellerSku: it.sku,
          quantity: it.quantity,
          asin: it.asin,
          condition: it.condition as any,
          quantityInCase: it.quantityInCase,
        })),
        labelPrepPreference: body.labelPrepPreference,
      })

      // Return a shape compatible with the existing UI wizard. The
      // legacy stub returned { planId, shipmentPlans[] } where
      // shipmentPlans[i] = { shipmentId, destinationFC, items[] }.
      // We map Amazon's PascalCase response onto the same lowercase
      // keys so the wizard doesn't need to change in this commit.
      return {
        planId: `PLAN-${result.shipmentPlans.map((p) => p.ShipmentId).join('-')}`,
        shipmentPlans: result.shipmentPlans.map((p) => ({
          shipmentId: p.ShipmentId,
          destinationFC: p.DestinationFulfillmentCenterId,
          labelPrepType: p.LabelPrepType,
          shipToAddress: p.ShipToAddress,
          items: p.Items.map((it) => ({
            sku: it.SellerSKU,
            quantity: it.Quantity,
            fnsku: it.FulfillmentNetworkSKU ?? null,
            prepDetails: it.PrepDetailsList ?? [],
          })),
        })),
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fba/plan-shipment] failed')
      // Surface the SP-API error message intact — operator-facing UI
      // benefits from seeing "InvalidSellerSKU" etc. rather than a
      // generic 500.
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/fba/create-shipment', async (request, reply) => {
    try {
      const body = request.body as {
        shipmentId: string // from plan
        destinationFC: string
        name?: string
        items: Array<{ productId?: string; sku: string; quantity: number; fnsku?: string }>
      }
      if (!body.shipmentId || !body.destinationFC) {
        return reply.code(400).send({ error: 'shipmentId + destinationFC required' })
      }

      const fbaShipment = await prisma.fBAShipment.create({
        data: {
          shipmentId: body.shipmentId,
          name: body.name ?? null,
          status: 'WORKING',
          destinationFC: body.destinationFC,
          items: {
            create: body.items
              .filter((it) => it.productId)
              .map((it) => ({
                productId: it.productId!,
                quantitySent: it.quantity,
                quantityReceived: 0,
              })),
          },
        },
        include: { items: true },
      })

      // Mirror as InboundShipment (type=FBA) so it shows in /fulfillment/inbound
      await prisma.inboundShipment.create({
        data: {
          type: 'FBA',
          status: 'DRAFT',
          fbaShipmentId: fbaShipment.shipmentId,
          reference: `Send-to-Amazon ${body.shipmentId}`,
          items: {
            create: body.items.map((it) => ({
              productId: it.productId ?? null,
              sku: it.sku,
              quantityExpected: it.quantity,
            })),
          },
        },
      })

      return fbaShipment
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fba/create-shipment] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.get('/fulfillment/fba/shipments', async (_request, reply) => {
    try {
      const items = await prisma.fBAShipment.findMany({
        include: { items: true },
        orderBy: { createdAt: 'desc' },
        take: 200,
      })
      return { items, total: items.length }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fba/shipments] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // H.8b — real SP-API getLabels. The :id param accepts EITHER the
  // local FBAShipment.id (cuid) OR the Amazon-issued shipmentId
  // (FBA-prefixed). Local lookup first to resolve to the Amazon ID;
  // if not found, treat :id as the Amazon ID directly so operators
  // can hit the route with whatever they have.
  //
  // Body (all optional):
  //   pageType   PackageLabel_A4_4 (default) | _Letter_4 | _Thermal | …
  //   labelType  BARCODE_2D (default — FNSKU unit labels)
  //              | UNIQUE (carton labels)
  //              | PALLET (pallet labels)
  //   numberOfPackages, packageLabelsToPrint, numberOfPallets
  //
  // Response: { downloadUrl } — Amazon-hosted temp URL (minutes TTL)
  // pointing at the labels PDF. Frontend renders as a download link.
  fastify.post('/fulfillment/fba/shipments/:id/labels', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = (request.body ?? {}) as {
        pageType?: any; labelType?: any
        numberOfPackages?: number; packageLabelsToPrint?: string[]; numberOfPallets?: number
      }
      if (!isFbaInboundConfigured()) {
        return reply.code(503).send({
          error: 'SP-API not configured. Set AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET, AMAZON_REFRESH_TOKEN, AMAZON_MARKETPLACE_ID.',
        })
      }
      // Resolve to the Amazon-issued shipmentId. Local FBAShipment.id
      // (cuid) → Amazon shipmentId via the row; if no row, assume the
      // operator passed Amazon's ID directly.
      let amazonShipmentId = id
      const local = await prisma.fBAShipment.findUnique({
        where: { id },
        select: { shipmentId: true },
      }).catch(() => null)
      if (local?.shipmentId) amazonShipmentId = local.shipmentId

      const result = await fbaGetLabels({
        shipmentId: amazonShipmentId,
        pageType: body.pageType,
        labelType: body.labelType,
        numberOfPackages: body.numberOfPackages,
        packageLabelsToPrint: body.packageLabelsToPrint,
        numberOfPallets: body.numberOfPallets,
      })
      return {
        ok: true,
        downloadUrl: result.downloadUrl,
        // Pre-H.8b clients used `labelsUrl` — keep alias for backwards compat.
        labelsUrl: result.downloadUrl,
        shipmentId: amazonShipmentId,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fba/shipments/:id/labels] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/fba/shipments/:id/transport', async (request, reply) => {
    try {
      if (!isFbaInboundConfigured()) {
        return reply.code(503).send({
          error: 'SP-API not configured (set AMAZON_LWA_* + AMAZON_MARKETPLACE_ID)',
        })
      }
      const { id } = request.params as { id: string }
      const body = request.body as {
        shipmentType?: FbaShipmentType
        carrierName?: string
        trackingIds?: string[]
        proNumber?: string
      }

      // :id may be FBAShipment.id (cuid) or the Amazon shipmentId
      // directly. Resolve to Amazon shipmentId for the SP-API call.
      const local = await prisma.fBAShipment.findUnique({ where: { id } }).catch(() => null)
      const amazonShipmentId = local?.shipmentId ?? id
      if (!amazonShipmentId) {
        return reply.code(400).send({ error: 'shipmentId required' })
      }

      const shipmentType: FbaShipmentType = body.shipmentType ?? 'SP'

      const result = await fbaPutTransport({
        shipmentId: amazonShipmentId,
        shipmentType,
        ...(shipmentType === 'SP'
          ? {
              smallParcel: {
                carrierName: body.carrierName ?? 'OTHER',
                trackingIds: body.trackingIds ?? [],
              },
            }
          : {
              ltl: {
                carrierName: body.carrierName ?? 'OTHER',
                proNumber: body.proNumber ?? '',
              },
            }),
      })

      // No local persistence yet — FBAShipment lacks transport fields.
      // H.8d (status polling) will reconcile state from Amazon as
      // source of truth, which avoids drift between two writers.

      return {
        ok: true,
        transportStatus: result.transportStatus,
        shipmentId: amazonShipmentId,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fba/shipments/:id/transport] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // H.8d — FBA status polling. POST trigger for manual reconcile;
  // GET returns the cron's last-run snapshot. The cron itself runs
  // every 15 min from index.ts on startup.
  fastify.post('/fulfillment/fba/poll-status', async (_request, reply) => {
    try {
      if (!isFbaInboundConfigured()) {
        return reply.code(503).send({
          error: 'SP-API not configured (set AMAZON_LWA_* + AMAZON_MARKETPLACE_ID)',
        })
      }
      const result = await runFbaStatusPoll()
      return { ok: true, ...result }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fba/poll-status] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.get('/fulfillment/fba/poll-status', async () => {
    return { ok: true, ...getFbaStatusPollStatus() }
  })

  // ═══════════════════════════════════════════════════════════════════
  // SUPPLIERS + PURCHASE ORDERS
  // ═══════════════════════════════════════════════════════════════════

  fastify.get('/fulfillment/suppliers', async (request, reply) => {
    const q = request.query as any
    const where: any = {}
    if (q.search?.trim()) where.name = { contains: q.search.trim(), mode: 'insensitive' }
    if (q.activeOnly === 'true') where.isActive = true
    const items = await prisma.supplier.findMany({
      where,
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: true, purchaseOrders: true } } },
    })
    return { items, total: items.length }
  })

  fastify.get('/fulfillment/suppliers/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const supplier = await prisma.supplier.findUnique({
      where: { id },
      include: {
        products: { include: { } as any },
        purchaseOrders: { take: 20, orderBy: { createdAt: 'desc' } },
      },
    })
    if (!supplier) return reply.code(404).send({ error: 'Supplier not found' })
    return supplier
  })

  // H.13 — supplier scorecard. Aggregates from PurchaseOrder +
  // InboundShipment + InboundShipmentItem over a rolling window
  // (default 365 days). Metrics:
  //   - leadTimeDays — avg/median/max of (createdAt → first inbound
  //     shipment for that PO arriving) in days. Only POs with at
  //     least one arrived inbound count.
  //   - onTimePercent — arrivedAt <= expectedAt / total arrived.
  //   - defectRate — (FAIL + HOLD items) / total received items.
  //   - openPOs — non-terminal POs.
  //   - spend — sum of PurchaseOrder.totalCents (all-time, since
  //     totals don't change after submit).
  fastify.get('/fulfillment/suppliers/:id/scorecard', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const q = request.query as { windowDays?: string }
      const windowDays = Math.max(1, Math.min(3650, Number(q.windowDays) || 365))
      const since = new Date(Date.now() - windowDays * 86400_000)

      const supplier = await prisma.supplier.findUnique({ where: { id }, select: { id: true, name: true, leadTimeDays: true, defaultCurrency: true } })
      if (!supplier) return reply.code(404).send({ error: 'Supplier not found' })

      // POs in window with their inbound shipments + items.
      const pos = await prisma.purchaseOrder.findMany({
        where: { supplierId: id, createdAt: { gte: since } },
        include: {
          inboundShipments: {
            include: {
              items: { select: { qcStatus: true, quantityReceived: true, quantityExpected: true } },
            },
          },
        },
      })

      // Lead time: createdAt → earliest arrived inbound shipment.
      const leadDaysList: number[] = []
      let onTimeArrived = 0
      let totalArrived = 0
      let failHoldUnits = 0
      let receivedUnits = 0

      for (const po of pos) {
        const arrived = po.inboundShipments.filter((s) => s.arrivedAt != null)
        if (arrived.length > 0) {
          const earliest = arrived.reduce((acc, s) => acc.arrivedAt! < s.arrivedAt! ? acc : s)
          const leadMs = earliest.arrivedAt!.getTime() - po.createdAt.getTime()
          if (leadMs > 0) leadDaysList.push(leadMs / 86400_000)
        }
        for (const ship of arrived) {
          totalArrived++
          if (ship.expectedAt && ship.arrivedAt && ship.arrivedAt.getTime() <= ship.expectedAt.getTime()) {
            onTimeArrived++
          }
          for (const it of ship.items) {
            receivedUnits += it.quantityReceived
            if (it.qcStatus === 'FAIL' || it.qcStatus === 'HOLD') {
              failHoldUnits += it.quantityReceived
            }
          }
        }
      }

      const sortedLead = [...leadDaysList].sort((a, b) => a - b)
      const median = sortedLead.length === 0 ? null
        : sortedLead.length % 2 === 0
          ? (sortedLead[sortedLead.length / 2 - 1] + sortedLead[sortedLead.length / 2]) / 2
          : sortedLead[(sortedLead.length - 1) / 2]
      const avg = sortedLead.length === 0 ? null : sortedLead.reduce((s, x) => s + x, 0) / sortedLead.length
      const max = sortedLead.length === 0 ? null : sortedLead[sortedLead.length - 1]

      const openPOs = await prisma.purchaseOrder.count({
        where: { supplierId: id, status: { notIn: ['CLOSED', 'CANCELLED'] as any } },
      })
      const spendCents = pos.reduce((sum, p) => sum + (p.totalCents ?? 0), 0)

      return {
        supplierId: id,
        supplierName: supplier.name,
        windowDays,
        since: since.toISOString(),
        leadTime: {
          stated: supplier.leadTimeDays,
          observedAvgDays: avg,
          observedMedianDays: median,
          observedMaxDays: max,
          sampleCount: leadDaysList.length,
        },
        onTime: {
          arrivedCount: totalArrived,
          onTimeCount: onTimeArrived,
          percent: totalArrived === 0 ? null : (onTimeArrived / totalArrived) * 100,
        },
        defectRate: {
          totalUnitsReceived: receivedUnits,
          failHoldUnits,
          percent: receivedUnits === 0 ? null : (failHoldUnits / receivedUnits) * 100,
        },
        openPOs,
        spend: {
          totalCents: spendCents,
          currencyCode: supplier.defaultCurrency ?? 'EUR',
          poCount: pos.length,
        },
      }
    } catch (err: any) {
      fastify.log.error({ err }, '[suppliers/:id/scorecard] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.post('/fulfillment/suppliers', async (request, reply) => {
    try {
      const body = request.body as any
      if (!body.name) return reply.code(400).send({ error: 'name required' })
      const created = await prisma.supplier.create({ data: body })
      return created
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.patch('/fulfillment/suppliers/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as any
      const updated = await prisma.supplier.update({ where: { id }, data: body })
      return updated
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.get('/fulfillment/purchase-orders', async (request, reply) => {
    try {
      const q = request.query as any
      const where: any = {}
      // H.4: status accepts comma-separated multi-select. Used by the
      // create-inbound modal to limit the PO picker to in-flight POs
      // (SUBMITTED, CONFIRMED, PARTIAL).
      if (q.status && q.status !== 'ALL') {
        const statuses = String(q.status).split(',').map((s) => s.trim()).filter(Boolean)
        if (statuses.length === 1) where.status = statuses[0]
        else if (statuses.length > 1) where.status = { in: statuses }
      }
      if (q.supplierId) where.supplierId = q.supplierId
      const items = await prisma.purchaseOrder.findMany({
        where,
        include: {
          supplier: { select: { id: true, name: true } },
          warehouse: { select: { code: true } },
          items: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      })
      return { items, total: items.length }
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.get('/fulfillment/purchase-orders/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const po = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: { supplier: true, warehouse: true, items: true, inboundShipments: true },
    })
    if (!po) return reply.code(404).send({ error: 'PO not found' })
    return po
  })

  // R.7 — workflow state machine. submit-for-review / approve / send /
  // acknowledge / cancel. Auto-advance through REVIEW when
  // BrandSettings.requireApprovalForPo=false (Xavia default).
  fastify.post('/fulfillment/purchase-orders/:id/transition', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = (request.body ?? {}) as {
        transition?: WorkflowTransition
        userId?: string
        reason?: string
      }
      if (!body.transition) {
        return reply.code(400).send({ error: 'transition required' })
      }
      const r = await transitionPo({
        poId: id,
        transition: body.transition,
        userId: body.userId ?? null,
        cancelReason: body.reason ?? null,
      })
      return r
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      if (/not found/i.test(msg)) return reply.code(404).send({ error: msg })
      if (/not allowed/i.test(msg)) return reply.code(409).send({ error: msg })
      fastify.log.error({ err }, '[purchase-orders/:id/transition] failed')
      return reply.code(500).send({ error: msg })
    }
  })

  // R.7 — chronological audit trail for a PO. Lists every state
  // transition with its timestamp + user (when known).
  fastify.get('/fulfillment/purchase-orders/:id/audit', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const trail = await getPoAuditTrail(id)
      if (trail.length === 0) return reply.code(404).send({ error: 'PO not found' })
      return { id, trail }
    } catch (err: any) {
      fastify.log.error({ err }, '[purchase-orders/:id/audit] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // F.6 — Factory-ready PDF for a PO. Renders letterhead with company
  // branding (BrandSettings), per-product groups with images and Size×
  // Color matrix when applicable, totals, and a signature block.
  // Streams the PDF as application/pdf so the browser can preview or
  // download. Filename: factory-po-<poNumber>.pdf.
  fastify.get('/fulfillment/purchase-orders/:id/factory.pdf', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const po = await prisma.purchaseOrder.findUnique({
        where: { id },
        include: {
          supplier: true,
          items: true,
        },
      })
      if (!po) return reply.code(404).send({ error: 'PO not found' })

      // Constraint #3 — Robust dual-architecture resolution. The codebase
      // carries two parent/child shapes:
      //   * ProductVariation: master Product → many ProductVariation rows
      //     (typical Amazon parent ASIN with size/color variants)
      //   * Hub-and-spoke (Phase 31): master Product → child Product rows
      //     via parentId (legacy pattern still in use for some catalogs)
      // SKUs may exist in either space; in pathological cases, the same
      // SKU could exist in BOTH (data drift). We resolve in this order:
      //   1. ProductVariation (canonical for new data)
      //   2. Child Product → parent Product (hub-and-spoke fallback)
      //   3. Standalone Product (no parent)
      //   4. Orphan (productId null or both lookups miss)
      // When step 1 + step 2/3 both match, we log a warning so data drift
      // is observable rather than silent.
      //
      // Two batched queries up front: variants by SKU (step 1) and products
      // by id+parentId chain (steps 2-3). Parents that aren't directly on
      // po.items get pulled in a second query.
      const itemProductIds = po.items
        .map((it) => it.productId)
        .filter((id): id is string => !!id)
      const itemSkus = po.items.map((it) => it.sku)

      const productSelect = {
        id: true,
        sku: true,
        name: true,
        productType: true,
        brand: true,
        parentId: true,
        isParent: true,
        images: {
          where: { type: 'MAIN' as const },
          select: { url: true },
          take: 1,
        },
      } as const

      const [variants, directProducts] = await Promise.all([
        prisma.productVariation.findMany({
          where: { sku: { in: itemSkus } },
          select: {
            sku: true,
            productId: true,
            variationAttributes: true,
            product: { select: productSelect },
          },
        }),
        prisma.product.findMany({
          where: { id: { in: itemProductIds } },
          select: productSelect,
        }),
      ])

      const variantBySku = new Map(variants.map((v) => [v.sku, v]))
      const productById = new Map(directProducts.map((p) => [p.id, p]))

      // Pull parent products for any hub-and-spoke children whose parents
      // aren't already loaded. Without this, a SKU's parent would fall
      // through to the child as the group identity (image / name / brand
      // come from the child instead of the parent product family).
      const missingParentIds = directProducts
        .map((p) => p.parentId)
        .filter(
          (pid): pid is string => !!pid && !productById.has(pid),
        )
      if (missingParentIds.length > 0) {
        const parents = await prisma.product.findMany({
          where: { id: { in: [...new Set(missingParentIds)] } },
          select: productSelect,
        })
        for (const p of parents) productById.set(p.id, p)
      }

      // Detect SKUs that exist in BOTH spaces — data drift. Log + flag
      // for observability without blocking the render.
      const dualSpaceSkus: string[] = []
      for (const item of po.items) {
        if (variantBySku.has(item.sku) && productById.has(item.productId ?? '')) {
          dualSpaceSkus.push(item.sku)
        }
      }
      if (dualSpaceSkus.length > 0) {
        fastify.log.warn(
          { skus: dualSpaceSkus, poId: id, poNumber: po.poNumber },
          'factory-pdf: SKUs found in both ProductVariation and Product spaces; preferring variant lookup',
        )
      }

      // Centralized resolver — always returns a group identity. This is
      // the single source of truth for "which group does this PO line
      // belong to"; the upsertGroup loop just picks up whatever this
      // returns.
      type ResolvedGroupIdentity = {
        groupKey: string
        productId: string
        productName: string
        productType: string | null
        brand: string | null
        imageUrl: string | null
      }
      const resolveGroupIdentity = (
        item: (typeof po.items)[number],
      ): ResolvedGroupIdentity => {
        // 1. ProductVariation (canonical)
        const variant = variantBySku.get(item.sku)
        if (variant) {
          const parent = variant.product
          return {
            groupKey: parent.id,
            productId: parent.id,
            productName: parent.name,
            productType: parent.productType ?? null,
            brand: parent.brand ?? null,
            imageUrl: parent.images[0]?.url ?? null,
          }
        }
        // 2 + 3. Direct product lookup (hub-and-spoke + standalone)
        const product = item.productId ? productById.get(item.productId) : null
        if (product) {
          const parent = product.parentId
            ? productById.get(product.parentId) ?? product
            : product
          return {
            groupKey: parent.id,
            productId: parent.id,
            productName: parent.name,
            productType: parent.productType ?? null,
            brand: parent.brand ?? null,
            imageUrl: parent.images[0]?.url ?? null,
          }
        }
        // 4. Orphan
        return {
          groupKey: `__orphan_${item.sku}`,
          productId: `__orphan_${item.sku}`,
          productName: `Unknown product (SKU: ${item.sku})`,
          productType: null,
          brand: null,
          imageUrl: null,
        }
      }

      const groupMap = new Map<string, FactoryPoProductGroup>()
      for (const item of po.items) {
        const identity = resolveGroupIdentity(item)
        const variant = variantBySku.get(item.sku)
        const line: FactoryPoVariantLine = {
          sku: item.sku,
          quantity: item.quantityOrdered,
          variationAttributes: variant
            ? (variant.variationAttributes as Record<string, string> | null)
            : null,
        }
        const existing = groupMap.get(identity.groupKey)
        if (existing) {
          existing.lines.push(line)
        } else {
          groupMap.set(identity.groupKey, {
            productId: identity.productId,
            productName: identity.productName,
            productType: identity.productType,
            brand: identity.brand,
            imageUrl: identity.imageUrl,
            lines: [line],
          })
        }
      }

      const groups = Array.from(groupMap.values())
      const totalUnits = po.items.reduce(
        (acc, it) => acc + it.quantityOrdered,
        0,
      )

      // BrandSettings — single-row pattern; create empty default if none.
      let brand = await prisma.brandSettings.findFirst()
      if (!brand) brand = await prisma.brandSettings.create({ data: {} })

      const input: FactoryPoInput = {
        poNumber: po.poNumber,
        status: po.status,
        expectedDeliveryDate: po.expectedDeliveryDate,
        notes: po.notes,
        createdAt: po.createdAt,
        brand: {
          companyName: brand.companyName,
          addressLines: brand.addressLines,
          taxId: brand.taxId,
          contactEmail: brand.contactEmail,
          contactPhone: brand.contactPhone,
          websiteUrl: brand.websiteUrl,
          logoUrl: brand.logoUrl,
          signatureBlockText: brand.signatureBlockText,
          defaultPoNotes: brand.defaultPoNotes,
        },
        supplier: po.supplier
          ? {
              id: po.supplier.id,
              name: po.supplier.name,
              contactName: po.supplier.contactName,
              email: po.supplier.email,
              phone: po.supplier.phone,
            }
          : null,
        groups,
        totalUnits,
      }

      const buffer = await renderFactoryPoPdf(input)

      reply
        .header('Content-Type', 'application/pdf')
        .header(
          'Content-Disposition',
          `inline; filename="factory-po-${po.poNumber}.pdf"`,
        )
        .header('Cache-Control', 'no-store')
      return reply.send(buffer)
    } catch (error: any) {
      fastify.log.error({ err: error }, '[purchase-orders/factory.pdf] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/purchase-orders', async (request, reply) => {
    try {
      const body = request.body as {
        supplierId?: string
        warehouseId?: string
        expectedDeliveryDate?: string
        notes?: string
        items?: Array<{ productId?: string; sku: string; supplierSku?: string; quantityOrdered: number; unitCostCents?: number }>
      }
      const items = Array.isArray(body.items) ? body.items : []
      if (items.length === 0) return reply.code(400).send({ error: 'items[] required' })
      const totalCents = items.reduce((s, it) => s + (it.unitCostCents ?? 0) * it.quantityOrdered, 0)
      const warehouseId = body.warehouseId ?? (await prisma.warehouse.findFirst({ where: { isDefault: true } }))?.id

      const po = await prisma.purchaseOrder.create({
        data: {
          poNumber: generatePoNumber(),
          supplierId: body.supplierId ?? null,
          warehouseId,
          status: 'DRAFT',
          expectedDeliveryDate: body.expectedDeliveryDate ? new Date(body.expectedDeliveryDate) : null,
          notes: body.notes ?? null,
          totalCents,
          items: {
            create: items.map((it) => ({
              productId: it.productId ?? null,
              sku: it.sku,
              supplierSku: it.supplierSku ?? null,
              quantityOrdered: it.quantityOrdered,
              unitCostCents: it.unitCostCents ?? 0,
            })),
          },
        },
        include: { items: true },
      })
      return po
    } catch (error: any) {
      fastify.log.error({ err: error }, '[POST /fulfillment/purchase-orders] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/purchase-orders/:id/submit', async (request, reply) => {
    const { id } = request.params as { id: string }
    const updated = await prisma.purchaseOrder.update({
      where: { id },
      data: { status: 'SUBMITTED', version: { increment: 1 } },
    })
    return updated
  })

  fastify.post('/fulfillment/purchase-orders/:id/receive', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const po = await prisma.purchaseOrder.findUnique({
        where: { id },
        include: { items: true },
      })
      if (!po) return reply.code(404).send({ error: 'PO not found' })

      // Create an InboundShipment (type=SUPPLIER) tied to this PO.
      // H.0a — thread purchaseOrderItemId per row so the receive flow
      // can propagate quantities back to the PO without a sku rematch.
      const inbound = await prisma.inboundShipment.create({
        data: {
          type: 'SUPPLIER',
          status: 'DRAFT',
          warehouseId: po.warehouseId,
          purchaseOrderId: po.id,
          reference: `Receipt for ${po.poNumber}`,
          items: {
            create: po.items.map((it) => ({
              productId: it.productId,
              sku: it.sku,
              quantityExpected: it.quantityOrdered - (it.quantityReceived ?? 0),
              purchaseOrderItemId: it.id,
              // H.1 — thread expected per-unit cost from the PO line so
              // landed-cost variance can be computed at receive time.
              unitCostCents: it.unitCostCents ?? null,
            })),
          },
          // H.1 — propagate the PO's currency to the inbound. PO defaults
          // to EUR; if the operator set USD/GBP/CNY there, the inbound
          // mirrors so cost columns are interpreted consistently.
          currencyCode: po.currencyCode ?? 'EUR',
        },
        include: { items: true },
      })
      return { inboundShipmentId: inbound.id, items: inbound.items }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[po/:id/receive] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // WORK ORDERS (in-house manufacturing)
  // ═══════════════════════════════════════════════════════════════════

  fastify.get('/fulfillment/work-orders', async (request, reply) => {
    const q = request.query as any
    const where: any = {}
    if (q.status && q.status !== 'ALL') where.status = q.status
    const items = await prisma.workOrder.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
    return { items, total: items.length }
  })

  fastify.post('/fulfillment/work-orders', async (request, reply) => {
    try {
      const body = request.body as { productId: string; quantity: number; notes?: string }
      if (!body.productId || !body.quantity) return reply.code(400).send({ error: 'productId + quantity required' })
      const created = await prisma.workOrder.create({
        data: {
          productId: body.productId,
          quantity: body.quantity,
          status: 'PLANNED',
          notes: body.notes ?? null,
        },
      })
      return created
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/work-orders/:id/complete', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as { actualQuantity?: number; costCents?: number; notes?: string }
      const wo = await prisma.workOrder.findUnique({ where: { id } })
      if (!wo) return reply.code(404).send({ error: 'WorkOrder not found' })

      const qty = body.actualQuantity ?? wo.quantity
      const updated = await prisma.workOrder.update({
        where: { id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          quantity: qty,
          costCents: body.costCents ?? wo.costCents,
          notes: body.notes ?? wo.notes,
        },
      })

      // Stock the produced units via StockMovement
      if (qty > 0) {
        await applyStockMovement({
          productId: wo.productId,
          change: qty,
          reason: 'MANUFACTURING_OUTPUT',
          referenceType: 'WorkOrder',
          referenceId: wo.id,
          actor: 'work-order-complete',
        })
      }
      return updated
    } catch (error: any) {
      fastify.log.error({ err: error }, '[work-orders/:id/complete] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // REPLENISHMENT — velocity-driven suggestions
  // ═══════════════════════════════════════════════════════════════════

  fastify.get('/fulfillment/replenishment', async (request, reply) => {
    try {
      const q = request.query as any
      const window = Math.min(90, Math.max(7, safeNum(q.window, 30) ?? 30))
      const since = new Date(Date.now() - window * 24 * 60 * 60 * 1000)
      since.setUTCHours(0, 0, 0, 0)
      // F.1 — Optional marketplace filter. When set, velocity is per-marketplace
      // (Amazon DE alone, eBay IT alone, etc.); when absent, all marketplaces sum.
      const marketplaceFilter =
        typeof q.marketplace === 'string' && q.marketplace.length > 0
          ? q.marketplace.toUpperCase()
          : null
      // F.1 — Optional channel filter. Same pattern.
      const channelFilter =
        typeof q.channel === 'string' && q.channel.length > 0
          ? q.channel.toUpperCase()
          : null

      // Pull all non-parent products. R.4 adds the per-product
      // economics overrides (servicLevel / orderingCost / carryingCost).
      const products = await prisma.product.findMany({
        where: { isParent: false, status: { not: 'INACTIVE' } },
        select: {
          id: true, sku: true, name: true, totalStock: true, lowStockThreshold: true,
          fulfillmentChannel: true, basePrice: true, costPrice: true,
          serviceLevelPercent: true, orderingCostCents: true, carryingCostPctYear: true,
          // R.13 — productType drives event-prep applicability
          productType: true,
          // R.19 — physical attrs for container/freight optimization
          dimLength: true, dimWidth: true, dimHeight: true, dimUnit: true,
          weightValue: true, weightUnit: true,
        },
        take: 1000,
      })

      // R.13 — load active future RetailEvents once per request.
      // Cap at 90-day horizon (matches the existing upcoming-events
      // banner). Filtered to active + lift > 1 (events with no
      // incremental demand never need prep).
      //
      // R.13 channel/marketplace scope: when the request narrows the
      // view to a specific channel or marketplace, drop events that
      // don't apply there. Mirrors the forecast-signals service's
      // (null OR equal) match shape — events with channel/marketplace
      // = null apply broadly. Without this filter, an Amazon IT
      // promo would surface on the eBay DE filtered view.
      const eventHorizon = new Date()
      eventHorizon.setUTCDate(eventHorizon.getUTCDate() + 90)
      const eventWhere: Prisma.RetailEventWhereInput = {
        isActive: true,
        startDate: { gte: new Date(), lte: eventHorizon },
        expectedLift: { gt: 1 },
      }
      const eventScopeAnd: Prisma.RetailEventWhereInput[] = []
      if (channelFilter) {
        eventScopeAnd.push({
          OR: [{ channel: null }, { channel: channelFilter }],
        })
      }
      if (marketplaceFilter) {
        eventScopeAnd.push({
          OR: [{ marketplace: null }, { marketplace: marketplaceFilter }],
        })
      }
      if (eventScopeAnd.length > 0) eventWhere.AND = eventScopeAnd
      const retailEvents = await prisma.retailEvent.findMany({
        where: eventWhere,
        select: {
          id: true, name: true, startDate: true, endDate: true,
          productType: true, channel: true, marketplace: true,
          expectedLift: true, prepLeadTimeDays: true, isActive: true,
        },
      })
      const retailEventsLite = retailEvents.map((e) => ({
        ...e,
        expectedLift: Number(e.expectedLift),
      }))

      // F.1 — Read pre-aggregated demand from DailySalesAggregate instead of
      // GroupBy-ing the live OrderItem table. The aggregate is keyed by SKU
      // (not productId), so the join key here is sku — matches the data layer
      // and lets per-marketplace rows aggregate naturally.
      const skus = products.map((p) => p.sku)
      const sold = await prisma.dailySalesAggregate.groupBy({
        by: ['sku'],
        where: {
          sku: { in: skus },
          day: { gte: since },
          ...(channelFilter ? { channel: channelFilter } : {}),
          ...(marketplaceFilter ? { marketplace: marketplaceFilter } : {}),
        },
        _sum: { unitsSold: true },
      })
      const soldBySku = new Map<string, number>()
      for (const r of sold) soldBySku.set(r.sku, r._sum.unitsSold ?? 0)

      // R.2 — per-(sku, channel, marketplace) velocity for the
      // channelCover[] breakdown. Same date window as the global
      // groupBy. Ignores channel/marketplace filters: even with a
      // filter active, the drawer should still show the full per-
      // channel breakdown so operators can see which specific
      // channel is driving the urgency.
      const soldByChannel = await prisma.dailySalesAggregate.groupBy({
        by: ['sku', 'channel', 'marketplace'],
        where: { sku: { in: skus }, day: { gte: since } },
        _sum: { unitsSold: true },
      })
      const channelVelocityBySku = new Map<
        string,
        Array<{ channel: string; marketplace: string; unitsSold: number }>
      >()
      for (const r of soldByChannel) {
        const arr = channelVelocityBySku.get(r.sku) ?? []
        arr.push({
          channel: r.channel,
          marketplace: r.marketplace,
          unitsSold: r._sum.unitsSold ?? 0,
        })
        channelVelocityBySku.set(r.sku, arr)
      }

      // Pull replenishment rules (overrides) + supplier lead times
      const rules = await prisma.replenishmentRule.findMany({
        where: { productId: { in: products.map((p) => p.id) } },
      })
      const rulesByProduct = new Map(rules.map((r) => [r.productId, r]))

      // R.4 — daily-resolution sales rows for σ calculation. Same
      // window as soldBySku above. Group by (sku, day) and stash so
      // per-product σ is one in-memory pass per SKU.
      const dailyRows = await prisma.dailySalesAggregate.groupBy({
        by: ['sku', 'day'],
        where: {
          sku: { in: skus },
          day: { gte: since },
          ...(channelFilter ? { channel: channelFilter } : {}),
          ...(marketplaceFilter ? { marketplace: marketplaceFilter } : {}),
        },
        _sum: { unitsSold: true },
      })
      const dailyBySku = new Map<string, number[]>()
      // R.17 — also build a dated series keyed by SKU. The substitution
      // adjuster needs (day, units) pairs because windows are date-
      // ranged. dailyBySku stays a numbers-only series for the σ calc.
      const dailySeriesBySku = new Map<string, { day: string; units: number }[]>()
      for (const r of dailyRows) {
        const arr = dailyBySku.get(r.sku) ?? []
        arr.push(r._sum.unitsSold ?? 0)
        dailyBySku.set(r.sku, arr)
        const dateArr = dailySeriesBySku.get(r.sku) ?? []
        dateArr.push({ day: r.day.toISOString().slice(0, 10), units: r._sum.unitsSold ?? 0 })
        dailySeriesBySku.set(r.sku, dateArr)
      }

      // R.17 — substitution links for the cohort + stockout windows
      // for the affected primaries. Loaded once per request; each
      // suggestion's adjuster call is in-memory only.
      const productIdsAll = products.map((p) => p.id)
      const subLinks = await loadSubstitutionLinks(productIdsAll)
      // Need stockout windows for any product that's a primary for
      // someone in our cohort, since their substitutes might be ours.
      const primaryIdsForStockouts = subLinks.affectedPrimaryIds
      const stockoutWindows = primaryIdsForStockouts.length > 0
        ? await prisma.stockoutEvent.findMany({
            where: {
              productId: { in: primaryIdsForStockouts },
              startedAt: { gte: since },
            },
            select: { productId: true, startedAt: true, endedAt: true },
          })
        : []
      // Map primary product → SKU so the substitute-side calc can
      // resolve substitute series via SKU. Both ends of every link
      // need a SKU lookup since dailySeriesBySku is keyed by SKU.
      const productIdToSku = new Map(products.map((p) => [p.id, p.sku]))

      // R.4 — supplier-product rows for the preferred suppliers.
      // Provides MOQ + case pack + a tighter unit cost than
      // Product.costPrice for the EOQ formula.
      const supplierIds = [...new Set(rules.map((r) => r.preferredSupplierId).filter(Boolean) as string[])]
      const supplierProducts = supplierIds.length > 0
        ? await prisma.supplierProduct.findMany({
            where: {
              supplierId: { in: supplierIds },
              productId: { in: products.map((p) => p.id) },
            },
            select: { productId: true, supplierId: true, costCents: true, currencyCode: true, moq: true, casePack: true },
          })
        : []
      const supplierProductByKey = new Map(
        supplierProducts.map((sp) => [`${sp.supplierId}:${sp.productId}`, sp]),
      )

      // R.15 — load FX rates for any non-EUR supplier currency in
      // this cohort. One indexed query per currency, small N.
      const cohortCurrencies = [
        ...new Set(
          supplierProducts
            .map((sp) => (sp.currencyCode ?? 'EUR').toUpperCase())
            .filter((c) => c !== 'EUR'),
        ),
      ]
      const fxRates = new Map<string, number>()
      if (cohortCurrencies.length > 0) {
        for (const ccy of cohortCurrencies) {
          const row = await prisma.fxRate.findFirst({
            where: { fromCurrency: 'EUR', toCurrency: ccy },
            orderBy: { asOf: 'desc' },
            select: { rate: true },
          })
          if (row) fxRates.set(ccy, Number(row.rate))
        }
      }

      // R.11 — supplier σ_LT for the safety-stock formula's LT-variance
      // term. Computed nightly by lead-time-stats.job; null when the
      // supplier doesn't have ≥3 PO receives in the last 365 days
      // (collapses safetyStock back to deterministic-LT behavior).
      const supplierStats = supplierIds.length > 0
        ? await prisma.supplier.findMany({
            where: { id: { in: supplierIds } },
            select: { id: true, leadTimeStdDevDays: true },
          })
        : []
      const supplierSigmaLtById = new Map(
        supplierStats.map((s) => [s.id, s.leadTimeStdDevDays != null ? Number(s.leadTimeStdDevDays) : null]),
      )

      // F.2 — Resolve per-product lead time + open inbound stock in two
      // batched queries (see atp.service.ts). The urgency formula now
      // uses effectiveStock = on-hand + inboundWithinLeadTime, so a SKU
      // with a 200-unit PO arriving in 5 days no longer fires a
      // false-positive CRITICAL when current stock is low.
      // R.2 — pass totalStock so legacy products without StockLevel
      // rows get a synthesized fallback row (UI flags amber).
      const atpByProduct = await resolveAtp({
        products: products.map((p) => ({ id: p.id, sku: p.sku, totalStock: p.totalStock })),
      })

      // F.4 — Pre-fetch ReplenishmentForecast rows for the entire visible
      // horizon (max lead time among the products) in one query, then
      // sum per-(sku, horizonDay) inline. Forecasts are scoped to the
      // active channel/marketplace filters so multi-marketplace SKUs
      // sum only the relevant marketplace's forecast.
      //
      // Two summary metrics per SKU:
      //   forecastedDemandLeadTime — sum over (today, today+leadTime+safety)
      //   forecastedDemand30d      — sum over the next 30 days (UI surface)
      // Plus lower80 / upper80 confidence bands for the lead-time horizon.
      const today = new Date()
      today.setUTCHours(0, 0, 0, 0)
      const horizonEnd = new Date(today)
      horizonEnd.setUTCDate(horizonEnd.getUTCDate() + 90) // 90-day cap
      const forecasts = await prisma.replenishmentForecast.findMany({
        where: {
          sku: { in: skus },
          horizonDay: { gte: today, lte: horizonEnd },
          ...(channelFilter ? { channel: channelFilter } : {}),
          ...(marketplaceFilter ? { marketplace: marketplaceFilter } : {}),
        },
        select: {
          sku: true,
          horizonDay: true,
          forecastUnits: true,
          lower80: true,
          upper80: true,
        },
      })
      // Index by SKU; each row is one (sku, horizonDay) point. We sum
      // per-SKU at the right slices in the suggestions loop below.
      const forecastsBySku = new Map<
        string,
        Array<{ horizonDay: Date; units: number; lower: number; upper: number }>
      >()
      for (const f of forecasts) {
        const arr = forecastsBySku.get(f.sku) ?? []
        arr.push({
          horizonDay: f.horizonDay,
          units: Number(f.forecastUnits),
          lower: Number(f.lower80),
          upper: Number(f.upper80),
        })
        forecastsBySku.set(f.sku, arr)
      }

      const suggestions = products.map((p) => {
        const rule = rulesByProduct.get(p.id)
        const atp = atpByProduct.get(p.id)
        const unitsSold = soldBySku.get(p.sku) ?? 0
        const trailingVelocity = unitsSold / window // units per day, trailing
        const safetyDays = rule?.safetyStockDays ?? 7
        const leadTimeDays = atp?.leadTimeDays ?? DEFAULT_LEAD_TIME_DAYS
        const inboundWithinLeadTime = atp?.inboundWithinLeadTime ?? 0
        const totalOpenInbound = atp?.totalOpenInbound ?? 0
        // R.18 — reservation-aware ATP. Pre-R.18 the math used
        // p.totalStock (Product-level cached total from FBA sync)
        // which did NOT subtract StockLevel.reserved; pending orders
        // ate stock invisibly. R.2 plumbed atp.totalAvailable which
        // sums StockLevel.available (= q - reserved per schema
        // CHECK constraint). Switching here makes urgency,
        // daysOfStockLeft, and needsReorder all reservation-aware.
        // Falls back to p.totalStock if ATP couldn't resolve.
        const effectiveStock = (atp?.totalAvailable ?? p.totalStock) + inboundWithinLeadTime

        // F.4 — Sum forecast over the relevant horizon. Falls back to
        // trailing velocity × days when no forecast row exists yet
        // (cold start before the first forecast worker run).
        const seriesForecasts = forecastsBySku.get(p.sku) ?? []
        const horizonWindowDays = leadTimeDays + safetyDays
        let forecastedDemandLeadTime = 0
        let forecastedLower = 0
        let forecastedUpper = 0
        let forecastedDemand30d = 0
        const horizonCutoffMs =
          today.getTime() + horizonWindowDays * 86400000
        const thirtyDayCutoffMs = today.getTime() + 30 * 86400000
        for (const f of seriesForecasts) {
          const ms = f.horizonDay.getTime()
          if (ms < horizonCutoffMs) {
            forecastedDemandLeadTime += f.units
            forecastedLower += f.lower
            forecastedUpper += f.upper
          }
          if (ms < thirtyDayCutoffMs) {
            forecastedDemand30d += f.units
          }
        }
        const hasForecast = seriesForecasts.length > 0
        const forecastVelocity = hasForecast
          ? forecastedDemand30d / 30
          : trailingVelocity
        // Velocity used for urgency / reorder-point math: prefer
        // forecast-derived value, fall back to trailing.
        const velocity = forecastVelocity

        // R.4 — replace the simple inline math with the composed
        // service. demandStdDev computed from per-day rows; cost
        // basis prefers SupplierProduct.costCents (more accurate)
        // and falls back to Product.costPrice (cents = €*100).
        // R.17 — apply substitution-aware demand adjustment to the
        // dated daily series before σ_d. Cold-start SKUs (no forecast)
        // also get the adjustment applied to trailing velocity.
        const datedSeriesRaw = dailySeriesBySku.get(p.sku) ?? []
        const linksForThisProduct = [
          ...(subLinks.byPrimary.get(p.id) ?? []),
          ...(subLinks.bySubstitute.get(p.id) ?? []),
        ]
        const datedSeriesAdjusted =
          linksForThisProduct.length > 0
            ? adjustDemandForSubstitution({
                productId: p.id,
                ownSeries: datedSeriesRaw,
                links: linksForThisProduct,
                substituteSeries: new Map(
                  linksForThisProduct
                    .filter((l) => l.primaryProductId === p.id)
                    .map((l) => {
                      const subSku = productIdToSku.get(l.substituteProductId) ?? ''
                      return [l.substituteProductId, dailySeriesBySku.get(subSku) ?? []] as const
                    }),
                ),
                stockoutWindows: stockoutWindows.map((w) => ({
                  productId: w.productId,
                  startedAt: w.startedAt,
                  endedAt: w.endedAt,
                })),
                now: today,
              })
            : datedSeriesRaw
        const dailySeries = datedSeriesAdjusted.map((p) => p.units)
        const demandStdDev = dailyDemandStdDev(dailySeries)
        // R.17 — capture rawVelocity (pre-substitution trailing) for
        // the audit drawer + fall-back-to-adjusted velocity if there's
        // no forecast (forecast keeps raw input by design — see R.17
        // design defaults).
        const rawVelocity = trailingVelocity
        const adjustedTrailingVelocity =
          datedSeriesAdjusted.length > 0
            ? datedSeriesAdjusted.reduce((s, p) => s + p.units, 0) / window
            : trailingVelocity
        const substitutionAdjustedDelta =
          linksForThisProduct.length > 0
            ? Number((adjustedTrailingVelocity - rawVelocity).toFixed(2))
            : 0
        const sp = rule?.preferredSupplierId
          ? supplierProductByKey.get(`${rule.preferredSupplierId}:${p.id}`)
          : null
        const unitCostCents =
          sp?.costCents ??
          (p.costPrice != null ? Math.round(Number(p.costPrice) * 100) : null)
        const moq = sp?.moq ?? 1
        const casePack = sp?.casePack ?? null

        const supplierSigmaLt = rule?.preferredSupplierId
          ? supplierSigmaLtById.get(rule.preferredSupplierId) ?? null
          : null
        // R.15 — supplier-currency cost path. SupplierProduct.currencyCode
        // is authoritative when present; fall back to "EUR" for legacy
        // products that only have Product.costPrice.
        const supplierCurrency = (sp?.currencyCode ?? 'EUR').toUpperCase()
        const fxRateUsed =
          supplierCurrency !== 'EUR' ? fxRates.get(supplierCurrency) ?? null : null
        const math = computeRecommendation({
          velocity,
          demandStdDev,
          leadTimeDays,
          unitCostCents,
          unitCostCurrency: supplierCurrency,
          fxRate: fxRateUsed,
          servicePercent: p.serviceLevelPercent != null ? Number(p.serviceLevelPercent) : null,
          orderingCostCents: p.orderingCostCents,
          carryingCostPctYear: p.carryingCostPctYear != null ? Number(p.carryingCostPctYear) : null,
          moq,
          casePack,
          // R.11 — σ_LT (null = deterministic-LT fallback)
          leadTimeStdDevDays: supplierSigmaLt,
          ruleReorderPoint: rule?.reorderPoint,
          ruleReorderQuantity: rule?.reorderQuantity,
        })
        const reorderPoint = math.reorderPoint
        const reorderQuantity = math.reorderQuantity
        const daysOfStockLeft =
          velocity > 0 ? Math.floor(effectiveStock / velocity) : Infinity

        let globalUrgency: PromotedUrgencyTier = 'LOW'
        if (effectiveStock === 0 && velocity > 0) globalUrgency = 'CRITICAL'
        else if (daysOfStockLeft <= leadTimeDays / 2) globalUrgency = 'CRITICAL'
        else if (daysOfStockLeft <= leadTimeDays) globalUrgency = 'HIGH'
        else if (effectiveStock <= reorderPoint) globalUrgency = 'MEDIUM'
        else globalUrgency = 'LOW'

        const needsReorder = effectiveStock <= reorderPoint && velocity > 0

        // R.2 — per-channel days-of-cover. For each (channel,
        // marketplace) tuple this product sold on, resolve which
        // location pool serves it and divide its available units by
        // the channel-specific velocity. Headline urgency is still
        // global (changes ship in R.4); this gives the drawer
        // visibility into which channels are at risk.
        const isFba = p.fulfillmentChannel === 'FBA'
        const channelCover = (channelVelocityBySku.get(p.sku) ?? [])
          .map((v) => {
            const stock = resolveStockForChannel({
              byLocation: atp?.byLocation ?? [],
              channel: v.channel,
              marketplace: v.marketplace,
              fulfillmentMethod:
                v.channel === 'AMAZON' ? (isFba ? 'FBA' : 'FBM') : null,
            })
            const channelVelocity = v.unitsSold / window
            const daysOfCover =
              channelVelocity > 0
                ? Math.floor(stock.available / channelVelocity)
                : null
            return {
              channel: v.channel,
              marketplace: v.marketplace,
              velocityPerDay: Number(channelVelocity.toFixed(2)),
              available: stock.available,
              locationCode: stock.locationCode,
              source: stock.source as ChannelLocationSource,
              daysOfCover,
            }
          })
          .sort((a, b) =>
            // Sort: lowest cover first (most urgent), then by channel name
            (a.daysOfCover ?? Number.MAX_SAFE_INTEGER) -
              (b.daysOfCover ?? Number.MAX_SAFE_INTEGER) ||
            a.channel.localeCompare(b.channel),
          )

        // R.14 — promote channel urgency. Headline = MAX(global,
        // worst channel) so a SKU with 200d aggregate cover but 3d
        // cover on Amazon-IT-FBA fires CRITICAL on the channel that
        // actually matters. Strictly tightens — never lowers global.
        const promoted = promoteUrgency({
          globalUrgency,
          channels: channelCover.map((c) => ({
            channel: c.channel,
            marketplace: c.marketplace,
            daysOfCover: c.daysOfCover,
          })),
          leadTimeDays,
        })
        let urgency = promoted.urgency
        let urgencySource: 'GLOBAL' | 'CHANNEL' | 'EVENT' = promoted.source
        const worstChannelKey = promoted.worstChannel
          ? `${promoted.worstChannel.channel}:${promoted.worstChannel.marketplace}`
          : null
        const worstChannelDaysOfCover = promoted.worstChannel?.daysOfCover ?? null

        // R.13 — event-driven prep. Find the most-pressing applicable
        // event (earliest deadline). When the deadline is within
        // lead-time, promote urgency one tier — operator must order
        // NOW or miss the spike.
        const prepEvent = findApplicableEvent({
          events: retailEventsLite,
          productType: p.productType,
          velocity,
        })
        if (prepEvent && shouldPromoteForPrep({
          daysUntilDeadline: prepEvent.daysUntilDeadline,
          leadTimeDays,
        })) {
          const bumped = bumpUrgencyOneTier(urgency)
          // Only flag EVENT as the source when prep actually moved the
          // tier — if global/channel was already CRITICAL, urgency
          // doesn't change and EVENT didn't drive it.
          if (bumped !== urgency) {
            urgency = bumped
            urgencySource = 'EVENT'
          }
        }

        return {
          productId: p.id,
          sku: p.sku,
          name: p.name,
          currentStock: p.totalStock,
          // F.2 — ATP composition for the UI: on-hand + inbound within lead
          // time = effective stock the urgency math actually used.
          inboundWithinLeadTime,
          totalOpenInbound,
          effectiveStock,
          openShipments: atp?.openShipments ?? [],
          // R.2 — multi-location stock breakdown (replaces the implicit
          // "currentStock = Product.totalStock" assumption).
          byLocation: atp?.byLocation ?? [],
          totalAvailable: atp?.totalAvailable ?? 0,
          stockSource: atp?.stockSource ?? 'STOCK_LEVEL',
          channelCover,
          unitsSold30d: unitsSold,
          // F.4 — forecast-driven velocity + horizon demand. Trailing
          // velocity is kept as a reference so the UI can show
          // "trailing 30d: X/day" alongside "forecast next 30d: Y/day".
          velocity: Number(velocity.toFixed(2)),
          trailingVelocity: Number(trailingVelocity.toFixed(2)),
          forecastedDemand30d: hasForecast
            ? Number(forecastedDemand30d.toFixed(2))
            : null,
          forecastedDemandLeadTime: hasForecast
            ? Number(forecastedDemandLeadTime.toFixed(2))
            : null,
          forecastedDemandLower80: hasForecast
            ? Number(forecastedLower.toFixed(2))
            : null,
          forecastedDemandUpper80: hasForecast
            ? Number(forecastedUpper.toFixed(2))
            : null,
          forecastSource: hasForecast ? 'FORECAST' : 'TRAILING_VELOCITY',
          daysOfStockLeft: daysOfStockLeft === Infinity ? null : daysOfStockLeft,
          reorderPoint,
          reorderQuantity,
          // R.4 — math snapshot fields for the drawer's "Reorder math"
          // panel. Audit-trail-friendly; carries through to the
          // ReplenishmentRecommendation row.
          safetyStockUnits: math.safetyStockUnits,
          eoqUnits: math.eoqUnits,
          constraintsApplied: math.constraintsApplied,
          unitCostCents,
          // R.19 — exposed so the container-fill rollup can read the
          // case-pack from the same suggestion object.
          casePack,
          servicePercentEffective: math.servicePercent,
          urgency,
          // R.14 — urgency provenance. globalUrgency = what the
          // aggregate said; urgency = max(global, worst-channel).
          // urgencySource flags whether a channel promoted the
          // headline so the UI can render a tooltip.
          globalUrgency,
          urgencySource,
          worstChannelKey,
          worstChannelDaysOfCover,
          // R.11 — σ_LT used for this row's safety-stock calc.
          leadTimeStdDevDays: supplierSigmaLt,
          // R.13 — event-prep recommendation (null when no applicable
          // event or when no incremental demand is expected). prepEventId
          // and prepExtraUnits are top-level for ergonomic UI access.
          prepEvent,
          prepEventId: prepEvent?.eventId ?? null,
          prepExtraUnits: prepEvent?.extraUnitsRecommended ?? null,
          // R.15 — FX context for the EOQ. UI shows native currency
          // total + EUR conversion. Rec audit captures both.
          unitCostCurrency: supplierCurrency,
          fxRateUsed,
          // R.17 — substitution audit
          rawVelocity,
          substitutionAdjustedDelta,
          substitutionLinkCount: linksForThisProduct.length,
          needsReorder,
          // F.2 — surface lead-time provenance so the UI can show
          // "from supplier override" vs "from supplier default" vs "fallback".
          leadTimeDays,
          leadTimeSource: atp?.leadTimeSource ?? 'FALLBACK',
          isManufactured: !!rule?.isManufactured,
          preferredSupplierId: rule?.preferredSupplierId ?? null,
          fulfillmentChannel: p.fulfillmentChannel,
        }
      })

      // Sort: CRITICAL first, then HIGH, MEDIUM, LOW
      const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }
      suggestions.sort((a, b) => order[a.urgency] - order[b.urgency] || (a.daysOfStockLeft ?? 999) - (b.daysOfStockLeft ?? 999))

      // R.19 — landed-cost pass. After EOQ + MOQ + case-pack have
      // settled the recommended qty per SKU, group needsReorder lines
      // by supplier, run optimizeContainerFill where a profile exists,
      // and write back per-line freight + landed cost.
      // Containers are computed only for suppliers that have opted in
      // by setting a SupplierShippingProfile; everyone else degrades
      // gracefully (freightCostPerUnitCents = null, landed = unit).
      const shippingProfiles = await loadShippingProfilesForSuppliers(supplierIds)
      const containerFillBySupplier = new Map<
        string,
        ReturnType<typeof optimizeContainerFill>
      >()
      if (shippingProfiles.size > 0) {
        const supplierItemMap = new Map<string, PackItem[]>()
        for (const s of suggestions) {
          if (!s.preferredSupplierId || !s.needsReorder) continue
          const profile = shippingProfiles.get(s.preferredSupplierId)
          if (!profile) continue
          const product = products.find((pp) => pp.id === s.productId)
          if (!product) continue
          // Resolve effective dims/weight: variant overrides not in
          // scope here — Product row carries the master dims for v1.
          const dims = normalizeDimsToCm({
            length: product.dimLength != null ? Number(product.dimLength) : null,
            width: product.dimWidth != null ? Number(product.dimWidth) : null,
            height: product.dimHeight != null ? Number(product.dimHeight) : null,
            unit: product.dimUnit,
          })
          const grams = normalizeWeightToGrams({
            value: product.weightValue != null ? Number(product.weightValue) : null,
            unit: product.weightUnit,
          })
          if (!dims || grams == null) continue
          const cbmPerUnit = cbmFromDims(dims.l, dims.w, dims.h)
          const kgPerUnit = grams / 1000
          const arr = supplierItemMap.get(s.preferredSupplierId) ?? []
          arr.push({
            productId: s.productId,
            sku: s.sku,
            unitsQty: s.reorderQuantity,
            cbmPerUnit,
            kgPerUnit,
            unitCostCents: s.unitCostCents ?? 0,
            urgency: s.urgency as PackItem['urgency'],
            casePack: s.casePack ?? null,
          })
          supplierItemMap.set(s.preferredSupplierId, arr)
        }
        for (const [supplierId, items] of supplierItemMap) {
          const profile = shippingProfiles.get(supplierId)
          if (!profile) continue
          const fill = optimizeContainerFill({ items, profile })
          containerFillBySupplier.set(supplierId, fill)
          // Convert profile freight cost to EUR cents matching R.15.
          // For now we assume profile.currencyCode == EUR; non-EUR
          // freight currencies can reuse fxRates from earlier.
          const profileCcy = (profile.currencyCode ?? 'EUR').toUpperCase()
          const profileFx = profileCcy !== 'EUR' ? fxRates.get(profileCcy) ?? null : null
          for (const it of items) {
            const native = fill.perLineFreightCents.get(it.productId) ?? 0
            const eurCents = profileFx ? Math.round(native / profileFx) : native
            const perUnit = it.unitsQty > 0 ? Math.round(eurCents / it.unitsQty) : 0
            const sug = suggestions.find((x) => x.productId === it.productId)
            if (sug) {
              ;(sug as any).freightCostPerUnitCents = perUnit
              ;(sug as any).landedCostPerUnitCents = (sug.unitCostCents ?? 0) + perUnit
            }
          }
        }
      }

      // R.8 — Amazon FBA Restock cross-check. Bulk-load latest rows
      // for the cohort across every eligible marketplace, then walk
      // suggestions and attach { amazonRecommendedQty, amazonDeltaPct,
      // amazonReportAsOf } so the persistence layer + UI can render
      // divergence. Lookup keyed by (sku, marketplaceId) where
      // marketplaceId is derived from the suggestion's
      // fulfillmentChannel + marketplace context. For v1 we only
      // cross-check FBA-fulfilled items (fulfillmentChannel === 'FBA')
      // since the Restock report is FBA-only.
      const fbaSuggestions = suggestions.filter((s) => s.fulfillmentChannel === 'FBA')
      const fbaSkus = fbaSuggestions.map((s) => s.sku)
      const fbaMarketplaceIds = eligibleMarketplaceCodes().map((c) => amazonMarketplaceId(c))
      const fbaRows =
        fbaSkus.length > 0
          ? await loadLatestRowsForCohort({
              skus: fbaSkus,
              marketplaceIds: fbaMarketplaceIds,
              staleDays: FBA_RESTOCK_STALE_DAYS,
            }).catch((err) => {
              fastify.log.warn({ err }, '[replenishment] fba-restock cross-check failed')
              return new Map() as Awaited<ReturnType<typeof loadLatestRowsForCohort>>
            })
          : (new Map() as Awaited<ReturnType<typeof loadLatestRowsForCohort>>)
      // Resolve the marketplace for each FBA suggestion. The list
      // route already constrained on marketplaceFilter (when set);
      // when omitted, prefer IT (Xavia primary) and fall back to any
      // fresh row for that SKU across the eligible marketplaces.
      const preferredMarketplaceId = marketplaceFilter
        ? amazonMarketplaceId(marketplaceFilter)
        : amazonMarketplaceId('IT')
      for (const s of fbaSuggestions) {
        let row = fbaRows.get(`${s.sku}:${preferredMarketplaceId}`)
        if (!row) {
          for (const mp of fbaMarketplaceIds) {
            const candidate = fbaRows.get(`${s.sku}:${mp}`)
            if (candidate) { row = candidate; break }
          }
        }
        const cmp = compareFbaRestock({
          ourQty: s.reorderQuantity,
          amazonQty: row?.recommendedReplenishmentQty ?? null,
          asOf: row?.asOf ?? null,
        })
        ;(s as any).amazonRecommendedQty = row?.recommendedReplenishmentQty ?? null
        ;(s as any).amazonDeltaPct = cmp.deltaPct
        ;(s as any).amazonReportAsOf = row?.asOf ?? null
        ;(s as any).amazonStatus = cmp.status
      }

      // R.3 — persist recommendations (diff-aware: only writes rows
      // for products whose urgency / qty / stock / needsReorder
      // actually changed vs the current ACTIVE row). Failure to
      // persist must not block the page render — service logs +
      // returns prev id when individual writes fail.
      const recommendationInputs: RecommendationInput[] = suggestions.map((s) => ({
        productId: s.productId,
        sku: s.sku,
        velocity: s.velocity,
        velocitySource: s.forecastSource as VelocitySource,
        leadTimeDays: s.leadTimeDays,
        leadTimeSource: s.leadTimeSource,
        safetyDays: rulesByProduct.get(s.productId)?.safetyStockDays ?? 7,
        totalAvailable: s.totalAvailable,
        inboundWithinLeadTime: s.inboundWithinLeadTime,
        effectiveStock: s.effectiveStock,
        reorderPoint: s.reorderPoint,
        reorderQuantity: s.reorderQuantity,
        daysOfStockLeft: s.daysOfStockLeft,
        urgency: s.urgency as Urgency,
        needsReorder: s.needsReorder,
        preferredSupplierId: s.preferredSupplierId,
        isManufactured: s.isManufactured,
        // R.4 — math snapshot
        safetyStockUnits: s.safetyStockUnits,
        eoqUnits: s.eoqUnits,
        constraintsApplied: s.constraintsApplied,
        unitCostCents: s.unitCostCents,
        // R.14 — urgency provenance
        urgencySource: s.urgencySource,
        worstChannelKey: s.worstChannelKey,
        worstChannelDaysOfCover: s.worstChannelDaysOfCover,
        // R.11 — σ_LT
        leadTimeStdDevDays: s.leadTimeStdDevDays,
        // R.13 — event prep
        prepEventId: s.prepEventId,
        prepExtraUnits: s.prepExtraUnits,
        // R.15 — FX
        unitCostCurrency: s.unitCostCurrency,
        fxRateUsed: s.fxRateUsed,
        // R.17 — substitution audit
        rawVelocity: s.rawVelocity,
        substitutionAdjustedDelta: s.substitutionAdjustedDelta,
        // R.19 — landed-cost audit
        freightCostPerUnitCents: (s as any).freightCostPerUnitCents ?? null,
        landedCostPerUnitCents: (s as any).landedCostPerUnitCents ?? null,
        // R.8 — Amazon FBA Restock cross-check audit
        amazonRecommendedQty: (s as any).amazonRecommendedQty ?? null,
        amazonDeltaPct: (s as any).amazonDeltaPct ?? null,
        amazonReportAsOf: (s as any).amazonReportAsOf ?? null,
      }))
      const recIdsByProduct = await bulkPersistRecommendationsIfChanged(
        recommendationInputs,
      ).catch((err) => {
        fastify.log.warn({ err }, '[replenishment] persist failed — continuing without ids')
        return new Map<string, string>()
      })

      // Attach recommendationId to each suggestion so the UI can
      // round-trip it back when creating a PO.
      const suggestionsWithRecId = suggestions.map((s) => ({
        ...s,
        recommendationId: recIdsByProduct.get(s.productId) ?? null,
      }))

      const counts = {
        critical: suggestionsWithRecId.filter((s) => s.urgency === 'CRITICAL').length,
        high: suggestionsWithRecId.filter((s) => s.urgency === 'HIGH').length,
        medium: suggestionsWithRecId.filter((s) => s.urgency === 'MEDIUM').length,
        low: suggestionsWithRecId.filter((s) => s.urgency === 'LOW').length,
      }

      // R.19 — supplier-level container fill summary. UI renders the
      // ContainerFillCard from this. Empty when no supplier has a
      // shipping profile.
      const suppliersById = supplierIds.length > 0
        ? new Map(
            (
              await prisma.supplier.findMany({
                where: { id: { in: supplierIds } },
                select: { id: true, name: true },
              })
            ).map((s) => [s.id, s.name]),
          )
        : new Map<string, string>()
      const containerFill = Array.from(containerFillBySupplier.entries()).map(
        ([supplierId, fill]) => ({
          supplierId,
          supplierName: suppliersById.get(supplierId) ?? supplierId,
          mode: fill.mode,
          totalCbm: fill.totalCbm,
          totalKg: fill.totalKg,
          fillPercentByCbm: fill.fillPercentByCbm,
          fillPercentByWeight: fill.fillPercentByWeight,
          freightCostCents: fill.freightCostCents,
          topUpSuggestions: fill.topUpSuggestions,
        }),
      )

      return {
        suggestions: suggestionsWithRecId,
        counts,
        window,
        // F.1 — surface the active filters so the UI can render them
        // without re-parsing the query string.
        filter: {
          channel: channelFilter,
          marketplace: marketplaceFilter,
        },
        // R.19 — per-supplier container fill (only suppliers with profiles).
        containerFill,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fulfillment/replenishment] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // F.1 — Manual recompute. Re-aggregates OrderItem rows in the given
  // window into DailySalesAggregate. Useful after order corrections
  // (refunds, cancellations) when waiting for the nightly job is too slow.
  // Defaults: last 7 days. Window cap: 365 days per call.
  fastify.post('/fulfillment/replenishment/refresh-aggregates', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        from?: string
        to?: string
        days?: number
        overrideReportSources?: boolean
      }
      const days = body.days
        ? Math.min(365, Math.max(1, Math.floor(body.days)))
        : null
      const now = new Date()
      let to: Date
      let from: Date
      if (body.from && body.to) {
        from = new Date(body.from)
        to = new Date(body.to)
      } else if (days != null) {
        to = now
        from = new Date(now.getTime() - (days - 1) * 86400000)
      } else {
        to = now
        from = new Date(now.getTime() - 6 * 86400000) // last 7 days inclusive
      }
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        return reply.code(400).send({ error: 'Invalid from/to dates' })
      }

      const result = await refreshSalesAggregates({
        from,
        to,
        overrideReportSources: !!body.overrideReportSources,
      })
      return {
        ok: true,
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
        ...result,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[replenishment/refresh-aggregates] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // F.3 — Manual sales-report ingest trigger. Without a date range,
  // ingests yesterday for every active Amazon marketplace. With
  // marketplace + day, runs the single-marketplace path. Useful for
  // dev/test (no cron required) and for catch-up after API outages.
  //
  // Without SP-API credentials this endpoint will surface the auth
  // failure as a 500 with the SP-API error message in the body —
  // exactly what the cron would log. NOT a runtime crash.
  fastify.post('/fulfillment/sales-reports/ingest', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        marketplace?: string
        day?: string
        skipIfReportExists?: boolean
      }

      const day = body.day ? new Date(body.day) : (() => {
        const d = new Date()
        d.setUTCHours(0, 0, 0, 0)
        d.setUTCDate(d.getUTCDate() - 1) // default: yesterday
        return d
      })()
      if (Number.isNaN(day.getTime())) {
        return reply.code(400).send({ error: 'Invalid day (expected YYYY-MM-DD)' })
      }

      if (body.marketplace) {
        const result = await ingestSalesTrafficForDay({
          marketplaceCode: body.marketplace,
          day,
          skipIfReportExists: !!body.skipIfReportExists,
        })
        return { ok: true, single: result }
      }
      const results = await ingestAllAmazonMarketplaces(day)
      return { ok: true, results }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[sales-reports/ingest] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // F.5 — Upcoming retail events for the banner. Returns events whose
  // window overlaps with the next 90 days, sorted by startDate ASC. Each
  // event carries a `prepDeadline` derived from startDate − prepLeadTimeDays
  // so the UI can render "Black Friday in 47 days — last day to PO: Oct 13".
  fastify.get('/fulfillment/replenishment/upcoming-events', async (_request, reply) => {
    try {
      const today = new Date()
      today.setUTCHours(0, 0, 0, 0)
      const horizonEnd = new Date(today)
      horizonEnd.setUTCDate(horizonEnd.getUTCDate() + 90)

      const events = await prisma.retailEvent.findMany({
        where: {
          isActive: true,
          startDate: { lte: horizonEnd },
          endDate: { gte: today },
        },
        orderBy: { startDate: 'asc' },
        take: 20,
      })

      const annotated = events.map((e) => {
        const prepDeadline = new Date(e.startDate)
        prepDeadline.setUTCDate(
          prepDeadline.getUTCDate() - e.prepLeadTimeDays,
        )
        const daysUntilStart = Math.ceil(
          (e.startDate.getTime() - today.getTime()) / 86400000,
        )
        const daysUntilDeadline = Math.ceil(
          (prepDeadline.getTime() - today.getTime()) / 86400000,
        )
        return {
          id: e.id,
          name: e.name,
          startDate: e.startDate.toISOString().slice(0, 10),
          endDate: e.endDate.toISOString().slice(0, 10),
          channel: e.channel,
          marketplace: e.marketplace,
          productType: e.productType,
          expectedLift: Number(e.expectedLift),
          prepLeadTimeDays: e.prepLeadTimeDays,
          prepDeadline: prepDeadline.toISOString().slice(0, 10),
          daysUntilStart,
          daysUntilDeadline,
          description: e.description,
        }
      })
      return { events: annotated }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[replenishment/upcoming-events] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // F.5.1 — Facets for /fulfillment/replenishment filter dropdowns.
  // Replaces the hardcoded ['IT','DE','FR','ES','UK','GLOBAL'] list
  // with the seller's actual marketplace/channel presence (distinct
  // values from ACTIVE ChannelListings). Cheap query, cached at the
  // edge if needed; for now we hit it once per page load.
  //
  // Returns sorted unique strings — channel + marketplace separately
  // because the page exposes them as two dropdowns.
  fastify.get('/fulfillment/facets', async (_request, reply) => {
    try {
      const [mkts, channels] = await Promise.all([
        prisma.channelListing.findMany({
          where: { listingStatus: 'ACTIVE' },
          select: { marketplace: true },
          distinct: ['marketplace'],
        }),
        prisma.channelListing.findMany({
          where: { listingStatus: 'ACTIVE' },
          select: { channel: true },
          distinct: ['channel'],
        }),
      ])
      const marketplaces = Array.from(
        new Set(mkts.map((r) => r.marketplace).filter(Boolean)),
      ).sort()
      const channelList = Array.from(
        new Set(channels.map((r) => r.channel).filter(Boolean)),
      ).sort()
      reply.send({ marketplaces, channels: channelList })
    } catch (error) {
      fastify.log.error({ err: error }, '[fulfillment/facets] failed')
      reply.code(500).send({ error: 'Failed to fetch facets' })
    }
  })

  // R.1 — Per-SKU forecast accuracy. Drawer card + per-product
  // dashboards. Returns rolling MAPE, MAE, band calibration, plus a
  // by-regime breakdown so we can compare HOLT_WINTERS vs
  // TRAILING_MEAN_FALLBACK head-to-head on the same SKU.
  fastify.get('/fulfillment/replenishment/forecast-accuracy', async (request, reply) => {
    try {
      const q = request.query as { sku?: string; channel?: string; marketplace?: string; windowDays?: string }
      if (!q.sku) return reply.code(400).send({ error: 'sku required' })
      const windowDays = Math.max(1, Math.min(365, Number(q.windowDays) || 30))
      const result = await getAccuracyForSku({
        sku: q.sku,
        channel: q.channel,
        marketplace: q.marketplace,
        windowDays,
      })
      return result
    } catch (err: any) {
      fastify.log.error({ err }, '[replenishment/forecast-accuracy] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // R.1 — aggregate accuracy. Powers the workspace "Forecast health"
  // card. groupBy=regime is the head-to-head model comparison; channel
  // / marketplace are also available for future drilldowns.
  fastify.get('/fulfillment/replenishment/forecast-accuracy/aggregate', async (request, reply) => {
    try {
      const q = request.query as { windowDays?: string; groupBy?: string }
      const windowDays = Math.max(1, Math.min(365, Number(q.windowDays) || 30))
      const groupBy = (q.groupBy === 'regime' || q.groupBy === 'channel' || q.groupBy === 'marketplace')
        ? q.groupBy
        : 'none'
      const result = await getAccuracyAggregate({ windowDays, groupBy })
      return result
    } catch (err: any) {
      fastify.log.error({ err }, '[replenishment/forecast-accuracy/aggregate] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // R.1 — manual backfill. One-shot at deploy time so dashboards have
  // numbers from day one (cron only populates yesterday onward).
  // POST body: { fromDay: 'YYYY-MM-DD', toDay: 'YYYY-MM-DD' }.
  fastify.post('/fulfillment/replenishment/forecast-accuracy/backfill', async (request, reply) => {
    try {
      const body = request.body as { fromDay?: string; toDay?: string }
      if (!body.fromDay || !body.toDay) return reply.code(400).send({ error: 'fromDay + toDay required (YYYY-MM-DD)' })
      const fromDay = new Date(body.fromDay + 'T00:00:00Z')
      const toDay = new Date(body.toDay + 'T00:00:00Z')
      if (Number.isNaN(fromDay.getTime()) || Number.isNaN(toDay.getTime())) {
        return reply.code(400).send({ error: 'fromDay/toDay must be ISO YYYY-MM-DD' })
      }
      const r = await backfillForecastAccuracy({ fromDay, toDay })
      return { ok: true, ...r }
    } catch (err: any) {
      fastify.log.error({ err }, '[replenishment/forecast-accuracy/backfill] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // F.5 — Per-SKU forecast detail. Returns 90 days of point forecasts,
  // confidence bands, signal breakdown, recent (60d) actuals, and any
  // open inbound shipments — enough to render the row-detail drawer's
  // chart + signal panel + shipment list without further API calls.
  fastify.get<{ Params: { productId: string } }>(
    '/fulfillment/replenishment/:productId/forecast-detail',
    async (request, reply) => {
      try {
        const { productId } = request.params
        const q = request.query as any
        const channel =
          typeof q.channel === 'string' && q.channel.length > 0
            ? q.channel.toUpperCase()
            : null
        const marketplace =
          typeof q.marketplace === 'string' && q.marketplace.length > 0
            ? q.marketplace.toUpperCase()
            : null

        const product = await prisma.product.findUnique({
          where: { id: productId },
          select: { id: true, sku: true, name: true, totalStock: true, fulfillmentChannel: true },
        })
        if (!product) return reply.code(404).send({ error: 'Product not found' })

        const today = new Date()
        today.setUTCHours(0, 0, 0, 0)
        const horizonEnd = new Date(today)
        horizonEnd.setUTCDate(horizonEnd.getUTCDate() + 90)
        const historyStart = new Date(today)
        historyStart.setUTCDate(historyStart.getUTCDate() - 60)

        const [forecastRows, historyRows, atpEntry] = await Promise.all([
          prisma.replenishmentForecast.findMany({
            where: {
              sku: product.sku,
              horizonDay: { gte: today, lte: horizonEnd },
              ...(channel ? { channel } : {}),
              ...(marketplace ? { marketplace } : {}),
            },
            orderBy: { horizonDay: 'asc' },
            select: {
              horizonDay: true,
              forecastUnits: true,
              lower80: true,
              upper80: true,
              signals: true,
              model: true,
              generationTag: true,
            },
          }),
          prisma.dailySalesAggregate.findMany({
            where: {
              sku: product.sku,
              day: { gte: historyStart, lt: today },
              ...(channel ? { channel } : {}),
              ...(marketplace ? { marketplace } : {}),
            },
            orderBy: { day: 'asc' },
            select: { day: true, unitsSold: true },
          }),
          resolveAtp({ products: [{ id: product.id, sku: product.sku, totalStock: product.totalStock }] }).then(
            (m) => m.get(product.id) ?? null,
          ),
        ])

        // Aggregate per-day across channels/marketplaces if no filter
        // (frontend usually passes filter; this branch is the catch-all).
        const historyByDay = new Map<string, number>()
        for (const r of historyRows) {
          const key = r.day.toISOString().slice(0, 10)
          historyByDay.set(key, (historyByDay.get(key) ?? 0) + r.unitsSold)
        }
        const forecastByDay = new Map<string, {
          point: number
          lower: number
          upper: number
          signals: any
        }>()
        for (const r of forecastRows) {
          const key = r.horizonDay.toISOString().slice(0, 10)
          const existing = forecastByDay.get(key)
          if (existing) {
            existing.point += Number(r.forecastUnits)
            existing.lower += Number(r.lower80)
            existing.upper += Number(r.upper80)
          } else {
            forecastByDay.set(key, {
              point: Number(r.forecastUnits),
              lower: Number(r.lower80),
              upper: Number(r.upper80),
              signals: r.signals,
            })
          }
        }

        // Build a continuous 60d-history + 90d-forecast series for the chart.
        const series: Array<{
          day: string
          actual: number | null
          forecast: number | null
          lower80: number | null
          upper80: number | null
        }> = []
        const cursor = new Date(historyStart)
        while (cursor < today) {
          const key = cursor.toISOString().slice(0, 10)
          series.push({
            day: key,
            actual: historyByDay.get(key) ?? 0,
            forecast: null,
            lower80: null,
            upper80: null,
          })
          cursor.setUTCDate(cursor.getUTCDate() + 1)
        }
        const forecastCursor = new Date(today)
        for (let i = 0; i < 90; i++) {
          const key = forecastCursor.toISOString().slice(0, 10)
          const f = forecastByDay.get(key)
          series.push({
            day: key,
            actual: null,
            forecast: f?.point ?? null,
            lower80: f?.lower ?? null,
            upper80: f?.upper ?? null,
          })
          forecastCursor.setUTCDate(forecastCursor.getUTCDate() + 1)
        }

        // Signal breakdown — use the most recent forecast row's signals
        // (they're typically constant across the horizon for a given series
        // unless events mid-window). Caller can drill if they want per-day.
        const latestSignals =
          forecastRows.length > 0 ? forecastRows[0].signals : null

        // R.2 — per-(channel, marketplace) days-of-cover for the
        // drawer's channel breakdown panel. 30-day rolling velocity
        // per channel-marketplace, divided by the location-pool
        // available units that channel resolves to.
        const channelWindowDays = 30
        const channelSince = new Date(today)
        channelSince.setUTCDate(channelSince.getUTCDate() - channelWindowDays)
        const channelSold = await prisma.dailySalesAggregate.groupBy({
          by: ['channel', 'marketplace'],
          where: { sku: product.sku, day: { gte: channelSince, lt: today } },
          _sum: { unitsSold: true },
        })
        const isFba = product.fulfillmentChannel === 'FBA'
        const channelCover = channelSold
          .map((row) => {
            const stock = resolveStockForChannel({
              byLocation: atpEntry?.byLocation ?? [],
              channel: row.channel,
              marketplace: row.marketplace,
              fulfillmentMethod:
                row.channel === 'AMAZON' ? (isFba ? 'FBA' : 'FBM') : null,
            })
            const units = row._sum.unitsSold ?? 0
            const velocityPerDay = units / channelWindowDays
            const daysOfCover =
              velocityPerDay > 0
                ? Math.floor(stock.available / velocityPerDay)
                : null
            return {
              channel: row.channel,
              marketplace: row.marketplace,
              velocityPerDay: Number(velocityPerDay.toFixed(2)),
              available: stock.available,
              locationCode: stock.locationCode,
              source: stock.source,
              daysOfCover,
            }
          })
          .sort((a, b) =>
            (a.daysOfCover ?? Number.MAX_SAFE_INTEGER) -
              (b.daysOfCover ?? Number.MAX_SAFE_INTEGER) ||
            a.channel.localeCompare(b.channel),
          )

        // R.4 — pull the latest ACTIVE recommendation so the drawer
        // can show the math snapshot (EOQ, safety stock, constraints)
        // without re-running the math here.
        const latestRec = await prisma.replenishmentRecommendation.findFirst({
          where: { productId: product.id, status: 'ACTIVE' },
          select: {
            id: true,
            urgency: true,
            reorderPoint: true,
            reorderQuantity: true,
            safetyStockUnits: true,
            eoqUnits: true,
            constraintsApplied: true,
            unitCostCents: true,
            velocity: true,
            generatedAt: true,
            // R.14 — urgency provenance
            urgencySource: true,
            worstChannelKey: true,
            worstChannelDaysOfCover: true,
            // R.11 — σ_LT
            leadTimeStdDevDays: true,
            // R.15 — FX audit
            unitCostCurrency: true,
            fxRateUsed: true,
            // R.17 — substitution audit
            rawVelocity: true,
            substitutionAdjustedDelta: true,
            // R.19 — landed-cost audit
            freightCostPerUnitCents: true,
            landedCostPerUnitCents: true,
            // R.8 — Amazon FBA Restock audit
            amazonRecommendedQty: true,
            amazonDeltaPct: true,
            amazonReportAsOf: true,
          },
        })

        // R.17 — substitution links for this product (drawer panel).
        // Flatten the dual-side service result into one array; each
        // row carries primary/substitute objects so the UI can render
        // either side without re-querying.
        const subResult = await listSubstitutionsForProduct(product.id)
        const substitutions = [
          ...subResult.asPrimary.map((r) => ({
            id: r.id,
            primaryProductId: r.primaryProductId,
            substituteProductId: r.substituteProductId,
            substitutionFraction: Number(r.substitutionFraction),
            primary: null,
            substitute: r.substitute,
          })),
          ...subResult.asSubstitute.map((r) => ({
            id: r.id,
            primaryProductId: r.primaryProductId,
            substituteProductId: r.substituteProductId,
            substitutionFraction: Number(r.substitutionFraction),
            primary: r.primary,
            substitute: null,
          })),
        ]

        return {
          product: {
            id: product.id,
            sku: product.sku,
            name: product.name,
            currentStock: product.totalStock,
          },
          atp: atpEntry,
          channelCover,
          recommendation: latestRec,
          model: forecastRows[0]?.model ?? null,
          generationTag: forecastRows[0]?.generationTag ?? null,
          signals: latestSignals,
          series,
          substitutions,
        }
      } catch (error: any) {
        fastify.log.error({ err: error }, '[replenishment/forecast-detail] failed')
        return reply.code(500).send({ error: error?.message ?? String(error) })
      }
    },
  )

  // F.5 — Bulk draft PO. Accepts an array of {productId, quantity,
  // supplierId?, notes?} and groups them into one PO per supplier.
  // Lets the user multi-select 12 SKUs in the grid and one-click
  // "Create POs from selection" without 12 round-trips.
  fastify.post('/fulfillment/replenishment/bulk-draft-po', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        items?: Array<{
          productId: string
          quantity: number
          supplierId?: string | null
          notes?: string | null
          // R.3 — link the resulting PO/WO back to the source rec.
          recommendationId?: string | null
          // R.3 — operator's quantity override (if quantity != suggested).
          quantityOverride?: number | null
          overrideNotes?: string | null
        }>
        notes?: string
        userId?: string
      }
      const items = body.items ?? []
      if (items.length === 0) {
        return reply.code(400).send({ error: 'items[] is required' })
      }

      // Resolve supplierIds + manufactured flag per product via
      // ReplenishmentRule. Items split into two paths:
      //   * Manufactured (rule.isManufactured = true) → one WorkOrder per
      //     item (manufacturing is per-product, not batched by supplier).
      //   * Sourced from a supplier → grouped into one PO per supplier;
      //     items without a resolved supplier land in a single
      //     "no-supplier" PO the user must assign before submitting.
      const productIds = items.map((i) => i.productId)
      const products = await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, sku: true },
      })
      const productById = new Map(products.map((p) => [p.id, p]))

      const rules = await prisma.replenishmentRule.findMany({
        where: { productId: { in: productIds } },
        select: {
          productId: true,
          preferredSupplierId: true,
          isManufactured: true,
        },
      })
      const ruleByProduct = new Map(
        rules.map(
          (r) =>
            [
              r.productId,
              {
                supplierId: r.preferredSupplierId,
                isManufactured: r.isManufactured,
              },
            ] as const,
        ),
      )

      // R.3 — line shape carries the optional source recommendationId
      // + override fields so we can attach PO/WO ids back after create.
      type Line = {
        productId: string
        sku: string
        quantity: number
        notes?: string | null
        recommendationId?: string | null
        quantityOverride?: number | null
        overrideNotes?: string | null
      }
      const grouped = new Map<string, Line[]>()
      const manufactured: Line[] = []
      const skipped: Array<{ productId: string; reason: string }> = []
      for (const item of items) {
        const product = productById.get(item.productId)
        if (!product) {
          skipped.push({ productId: item.productId, reason: 'product not found' })
          continue
        }
        if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
          skipped.push({ productId: item.productId, reason: 'quantity must be > 0' })
          continue
        }
        const rule = ruleByProduct.get(item.productId)
        const line: Line = {
          productId: item.productId,
          sku: product.sku,
          quantity: Math.floor(item.quantity),
          notes: item.notes ?? null,
          recommendationId: item.recommendationId ?? null,
          quantityOverride: item.quantityOverride ?? null,
          overrideNotes: item.overrideNotes ?? null,
        }
        // Manufactured items create a WorkOrder, not a PO line.
        if (rule?.isManufactured) {
          manufactured.push(line)
          continue
        }
        const supplierId = item.supplierId ?? rule?.supplierId ?? null
        const key = supplierId ?? '__no_supplier__'
        const arr = grouped.get(key) ?? []
        arr.push(line)
        grouped.set(key, arr)
      }

      // Pre-fetch supplier contact info so the response carries enough
      // data for the UI to build a "Email supplier" mailto: link without
      // a second round-trip.
      const involvedSupplierIds = [...grouped.keys()].filter(
        (k) => k !== '__no_supplier__',
      )
      const suppliers =
        involvedSupplierIds.length > 0
          ? await prisma.supplier.findMany({
              where: { id: { in: involvedSupplierIds } },
              select: { id: true, name: true, email: true, contactName: true },
            })
          : []
      const supplierById = new Map(suppliers.map((s) => [s.id, s]))

      const createdPos: Array<{
        id: string
        poNumber: string
        supplierId: string | null
        supplierName: string | null
        supplierEmail: string | null
        itemCount: number
        totalUnits: number
      }> = []
      for (const [supplierKey, lineItems] of grouped) {
        const supplierId = supplierKey === '__no_supplier__' ? null : supplierKey
        const supplier = supplierId ? supplierById.get(supplierId) : null
        const totalUnits = lineItems.reduce((acc, li) => acc + li.quantity, 0)
        const po = await prisma.purchaseOrder.create({
          data: {
            poNumber: generatePoNumber(),
            supplierId,
            status: 'DRAFT',
            totalCents: 0,
            notes: body.notes ?? null,
            items: {
              create: lineItems.map((li) => ({
                productId: li.productId,
                sku: li.sku,
                quantityOrdered: li.quantity,
              })),
            },
          },
          select: { id: true, poNumber: true, supplierId: true, _count: { select: { items: true } } },
        })
        createdPos.push({
          id: po.id,
          poNumber: po.poNumber,
          supplierId: po.supplierId,
          supplierName: supplier?.name ?? null,
          supplierEmail: supplier?.email ?? null,
          itemCount: po._count.items,
          totalUnits,
        })

        // R.3 — attach this PO back to every source recommendation
        // that contributed a line to it. Failures don't roll back the
        // PO (audit trail is best-effort, not transactional with
        // PO creation).
        for (const li of lineItems) {
          if (!li.recommendationId) continue
          await attachPoToRecommendation({
            recommendationId: li.recommendationId,
            poId: po.id,
            overrideQuantity: li.quantityOverride ?? null,
            overrideNotes: li.overrideNotes ?? null,
            userId: body.userId ?? null,
          }).catch((err) => {
            fastify.log.warn({ err, recId: li.recommendationId, poId: po.id }, '[replenishment] attach failed')
          })
        }
      }

      // Manufactured items → one WorkOrder per line. WorkOrders have no
      // SKU concept; the productId carries the manufacturing target.
      const createdWorkOrders: Array<{
        id: string
        productId: string
        quantity: number
      }> = []
      for (const line of manufactured) {
        const wo = await prisma.workOrder.create({
          data: {
            productId: line.productId,
            quantity: line.quantity,
            status: 'PLANNED',
            notes: body.notes ?? null,
          },
          select: { id: true, productId: true, quantity: true },
        })
        createdWorkOrders.push(wo)

        if (line.recommendationId) {
          await attachPoToRecommendation({
            recommendationId: line.recommendationId,
            workOrderId: wo.id,
            overrideQuantity: line.quantityOverride ?? null,
            overrideNotes: line.overrideNotes ?? null,
            userId: body.userId ?? null,
          }).catch((err) => {
            fastify.log.warn({ err, recId: line.recommendationId, woId: wo.id }, '[replenishment] attach failed')
          })
        }
      }

      return {
        ok: true,
        createdPos,
        createdWorkOrders,
        itemsAccepted: items.length - skipped.length,
        skipped,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[replenishment/bulk-draft-po] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // F.4 — Manual forecast trigger. Without a body, regenerates forecasts
  // for every series in the catalog. With { sku, channel, marketplace }
  // body, regenerates a single series (useful for debugging a specific
  // SKU's forecast in dev / after a manual data correction).
  fastify.post('/fulfillment/forecast/run', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        sku?: string
        channel?: string
        marketplace?: string
        includeColdStart?: boolean
      }
      if (body.sku && body.channel && body.marketplace) {
        // Resolve productType for category-aware weather elasticity.
        const product = await prisma.product.findFirst({
          where: { sku: body.sku },
          select: { productType: true },
        })
        const variant = !product
          ? await prisma.productVariation.findFirst({
              where: { sku: body.sku },
              select: { product: { select: { productType: true } } },
            })
          : null
        const productType = product?.productType ?? variant?.product.productType ?? null

        const result = await generateForecastForSeries({
          sku: body.sku,
          channel: body.channel.toUpperCase(),
          marketplace: body.marketplace.toUpperCase(),
          productType,
        })
        return { ok: true, single: result }
      }
      const result = await generateForecastsForAll({
        includeColdStart: !!body.includeColdStart,
      })
      return { ok: true, ...result }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[forecast/run] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/replenishment/:productId/draft-po', async (request, reply) => {
    try {
      const { productId } = request.params as { productId: string }
      const body = request.body as {
        quantity?: number
        supplierId?: string
        expectedDeliveryDate?: string
        // R.3 — link the resulting PO back to the source rec.
        recommendationId?: string
        quantityOverride?: number | null
        overrideNotes?: string | null
        userId?: string
      }
      const product = await prisma.product.findUnique({ where: { id: productId }, select: { sku: true } })
      if (!product) return reply.code(404).send({ error: 'Product not found' })
      const supplierId = body.supplierId ?? (await prisma.replenishmentRule.findUnique({ where: { productId } }))?.preferredSupplierId ?? null

      const po = await prisma.purchaseOrder.create({
        data: {
          poNumber: generatePoNumber(),
          supplierId,
          status: 'DRAFT',
          expectedDeliveryDate: body.expectedDeliveryDate ? new Date(body.expectedDeliveryDate) : null,
          totalCents: 0,
          items: {
            create: [{
              productId,
              sku: product.sku,
              quantityOrdered: body.quantity ?? 1,
            }],
          },
        },
        include: { items: true },
      })

      // R.3 — attach back to the source rec when provided.
      if (body.recommendationId) {
        await attachPoToRecommendation({
          recommendationId: body.recommendationId,
          poId: po.id,
          overrideQuantity: body.quantityOverride ?? null,
          overrideNotes: body.overrideNotes ?? null,
          userId: body.userId ?? null,
        }).catch((err) => {
          fastify.log.warn({ err, recId: body.recommendationId, poId: po.id }, '[replenishment] attach failed')
        })
      }

      return po
    } catch (error: any) {
      fastify.log.error({ err: error }, '[replenishment/draft-po] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // R.3 — recommendation history per product. Chronological list of
  // every recommendation we've ever shown for this product, with
  // status + supersession + ACTED transitions. Powers the drawer
  // History mini-section.
  fastify.get('/fulfillment/replenishment/:productId/history', async (request, reply) => {
    try {
      const { productId } = request.params as { productId: string }
      const q = request.query as { limit?: string }
      const limit = Math.max(1, Math.min(500, Number(q.limit) || 50))
      const rows = await getRecommendationHistory(productId, limit)
      return {
        productId,
        history: rows.map((r) => ({
          id: r.id,
          generatedAt: r.generatedAt,
          urgency: r.urgency,
          reorderQuantity: r.reorderQuantity,
          reorderPoint: r.reorderPoint,
          daysOfStockLeft: r.daysOfStockLeft,
          effectiveStock: r.effectiveStock,
          totalAvailable: r.totalAvailable,
          status: r.status,
          supersededAt: r.supersededAt,
          actedAt: r.actedAt,
          resultingPoId: r.resultingPoId,
          resultingWorkOrderId: r.resultingWorkOrderId,
          overrideQuantity: r.overrideQuantity,
          overrideNotes: r.overrideNotes,
          // R.4 — math snapshot fields
          safetyStockUnits: r.safetyStockUnits,
          eoqUnits: r.eoqUnits,
          constraintsApplied: r.constraintsApplied,
          unitCostCents: r.unitCostCents,
        })),
      }
    } catch (err: any) {
      fastify.log.error({ err }, '[replenishment/:productId/history] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // R.3 — single recommendation by id. Useful for forensics + future
  // approval workflow surfaces.
  fastify.get('/fulfillment/replenishment/recommendations/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const row = await getRecommendationById(id)
      if (!row) return reply.code(404).send({ error: 'Recommendation not found' })
      return row
    } catch (err: any) {
      fastify.log.error({ err }, '[replenishment/recommendations/:id] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ── Replenishment saved views — named filter+sort presets ───────────
  fastify.get('/fulfillment/replenishment-views', async (_request, reply) => {
    try {
      const rows = await prisma.replenishmentSavedView.findMany({
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      })
      return reply.send({ success: true, views: rows })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      fastify.log.error({ err }, '[replenishment-views GET] failed')
      return reply.code(500).send({ success: false, error: msg })
    }
  })

  fastify.post<{
    Body: {
      name?: string
      description?: string | null
      filterState?: Record<string, unknown>
      isDefault?: boolean
      createdBy?: string
    }
  }>('/fulfillment/replenishment-views', async (request, reply) => {
    try {
      const b = request.body ?? {}
      if (!b.name?.trim()) {
        return reply.code(400).send({ error: 'name required' })
      }
      if (!b.filterState || typeof b.filterState !== 'object') {
        return reply.code(400).send({ error: 'filterState required' })
      }
      // Only one default at a time; clear others if this one is default.
      if (b.isDefault === true) {
        await prisma.replenishmentSavedView.updateMany({
          where: { isDefault: true },
          data: { isDefault: false },
        })
      }
      const view = await prisma.replenishmentSavedView.create({
        data: {
          name: b.name.trim(),
          description: b.description ?? null,
          filterState: b.filterState as any,
          isDefault: b.isDefault ?? false,
          createdBy: b.createdBy ?? null,
        },
      })
      return reply.code(201).send({ success: true, view })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      fastify.log.error({ err }, '[replenishment-views POST] failed')
      return reply.code(500).send({ success: false, error: msg })
    }
  })

  fastify.patch<{
    Params: { id: string }
    Body: {
      name?: string
      description?: string | null
      filterState?: Record<string, unknown>
      isDefault?: boolean
    }
  }>('/fulfillment/replenishment-views/:id', async (request, reply) => {
    try {
      const { id } = request.params
      const b = request.body ?? {}
      if (b.isDefault === true) {
        await prisma.replenishmentSavedView.updateMany({
          where: { isDefault: true, id: { not: id } },
          data: { isDefault: false },
        })
      }
      const data: any = {}
      if (typeof b.name === 'string') data.name = b.name.trim()
      if ('description' in b) data.description = b.description ?? null
      if (b.filterState && typeof b.filterState === 'object') data.filterState = b.filterState
      if (typeof b.isDefault === 'boolean') data.isDefault = b.isDefault
      const updated = await prisma.replenishmentSavedView.update({
        where: { id },
        data,
      })
      return reply.send({ success: true, view: updated })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('Record to update not found')) {
        return reply.code(404).send({ error: 'View not found' })
      }
      fastify.log.error({ err }, '[replenishment-views PATCH] failed')
      return reply.code(500).send({ success: false, error: msg })
    }
  })

  fastify.delete<{ Params: { id: string } }>(
    '/fulfillment/replenishment-views/:id',
    async (request, reply) => {
      try {
        const { id } = request.params
        await prisma.replenishmentSavedView.delete({ where: { id } })
        return reply.send({ success: true })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('Record to delete does not exist')) {
          return reply.code(404).send({ error: 'View not found' })
        }
        return reply.code(500).send({ success: false, error: msg })
      }
    },
  )

  // R.21 — Bulk-dismiss N recommendations in one call. Body:
  // { recommendationIds: string[], reason?: string, userId?: string }.
  // Returns { succeeded, alreadyTerminal, failed[] } so the operator
  // gets a precise summary (e.g. "Dismissed 47 · 3 already gone · 0 errors").
  fastify.post(
    '/fulfillment/replenishment/recommendations/bulk-dismiss',
    async (request, reply) => {
      try {
        const body = (request.body ?? {}) as {
          recommendationIds?: string[]
          reason?: string
          userId?: string
        }
        if (
          !Array.isArray(body.recommendationIds) ||
          body.recommendationIds.length === 0
        ) {
          return reply.code(400).send({
            error: 'recommendationIds must be a non-empty array',
          })
        }
        if (body.recommendationIds.length > 1000) {
          return reply.code(400).send({
            error: 'Maximum 1000 recommendations per bulk-dismiss call',
          })
        }
        const result = await bulkDismissRecommendations({
          recommendationIds: body.recommendationIds,
          reason: body.reason ?? null,
          userId: body.userId ?? null,
        })
        return result
      } catch (err: any) {
        fastify.log.error(
          { err },
          '[replenishment/recommendations/bulk-dismiss] failed',
        )
        return reply.code(500).send({ error: err?.message ?? String(err) })
      }
    },
  )

  // R.21 — Dismiss a recommendation. Status ACTIVE → DISMISSED.
  // Captures dismissal audit (who + when + reason). Idempotent on a
  // non-ACTIVE row — returns the current state without raising so
  // double-clicks don't error. Body: { reason?: string, userId?: string }.
  fastify.post(
    '/fulfillment/replenishment/recommendations/:id/dismiss',
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string }
        const body = (request.body ?? {}) as {
          reason?: string
          userId?: string
        }
        const result = await dismissRecommendation({
          recommendationId: id,
          reason: body.reason ?? null,
          userId: body.userId ?? null,
        })
        return result
      } catch (err: any) {
        const msg = err?.message ?? String(err)
        if (/not found/i.test(msg)) return reply.code(404).send({ error: msg })
        fastify.log.error(
          { err },
          '[replenishment/recommendations/:id/dismiss] failed',
        )
        return reply.code(500).send({ error: msg })
      }
    },
  )

  // R.6 — auto-PO manual trigger. POST runs the sweep + writes a real
  // run-log row. Body { dryRun: true } previews without creating POs.
  fastify.post('/fulfillment/replenishment/auto-po/run', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { dryRun?: boolean }
      const r = await runAutoPoSweep({ triggeredBy: 'manual', dryRun: !!body.dryRun })
      return r
    } catch (err: any) {
      fastify.log.error({ err }, '[replenishment/auto-po/run] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // R.6 — auto-PO status. Returns the latest run + the global config
  // (default ceilings, urgency floor) so the UI can render an "auto-PO
  // dashboard" without extra calls.
  fastify.get('/fulfillment/replenishment/auto-po/status', async () => {
    return {
      ...await getAutoPoStatus(),
      cron: getAutoPoCronStatus(),
    }
  })

  // R.11 — manual lead-time stats recompute. Useful at deploy time
  // before the 06:00 UTC cron fires, or when debugging "why is σ_LT
  // null for supplier X?".
  fastify.post('/fulfillment/replenishment/lead-time-stats/recompute', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { supplierId?: string }
      if (body.supplierId) {
        const r = await recomputeLeadTimeStatsForSupplier(body.supplierId)
        return { ok: true, supplierId: body.supplierId, ...r }
      }
      const r = await recomputeAllLeadTimeStats()
      return { ok: true, ...r }
    } catch (err: any) {
      fastify.log.error({ err }, '[replenishment/lead-time-stats/recompute] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.get('/fulfillment/replenishment/lead-time-stats/status', async () => {
    return {
      ...await getLeadTimeStatsStatus(),
      cron: getLeadTimeStatsCronStatus(),
    }
  })

  // R.12 — stockout ledger surfaces.
  fastify.get('/fulfillment/replenishment/stockouts/summary', async (request) => {
    const q = request.query as { windowDays?: string }
    const windowDays = Math.max(1, Math.min(365, Number(q.windowDays) || 30))
    return await getStockoutSummary({ windowDays })
  })

  fastify.get('/fulfillment/replenishment/stockouts/events', async (request) => {
    const q = request.query as { status?: 'open' | 'closed' | 'all'; limit?: string }
    const limit = Number(q.limit) || 50
    return await listStockoutEvents({ status: q.status ?? 'all', limit })
  })

  fastify.post('/fulfillment/replenishment/stockouts/sweep', async (_req, reply) => {
    try {
      const r = await runStockoutSweep()
      return { ok: true, ...r }
    } catch (err: any) {
      fastify.log.error({ err }, '[replenishment/stockouts/sweep] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.get('/fulfillment/replenishment/stockouts/status', async () => {
    return { cron: getStockoutDetectorCronStatus() }
  })

  // R.16 — forecast model A/B routing.
  fastify.get('/fulfillment/replenishment/forecast-models/active', async () => {
    return await getModelsActive()
  })

  fastify.post('/fulfillment/replenishment/forecast-models/rollout', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        challengerModelId?: string
        cohortPercent?: number
        expiresAt?: string | null
      }
      if (!body.challengerModelId) return reply.code(400).send({ error: 'challengerModelId required' })
      if (typeof body.cohortPercent !== 'number') return reply.code(400).send({ error: 'cohortPercent (0-100) required' })
      const r = await rolloutChallenger({
        challengerModelId: body.challengerModelId,
        cohortPercent: body.cohortPercent,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        assignedBy: 'manual',
      })
      return { ok: true, ...r }
    } catch (err: any) {
      fastify.log.error({ err }, '[forecast-models/rollout] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.post('/fulfillment/replenishment/forecast-models/pin', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { sku?: string; modelId?: string; cohort?: 'champion' | 'challenger' | 'control' }
      if (!body.sku || !body.modelId || !body.cohort) {
        return reply.code(400).send({ error: 'sku + modelId + cohort required' })
      }
      await pinSkuToModel({ sku: body.sku, modelId: body.modelId, cohort: body.cohort })
      return { ok: true }
    } catch (err: any) {
      fastify.log.error({ err }, '[forecast-models/pin] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.post('/fulfillment/replenishment/forecast-models/promote', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { modelId?: string; retirePreviousChampion?: boolean }
      if (!body.modelId) return reply.code(400).send({ error: 'modelId required' })
      const r = await promoteToChampion({
        modelId: body.modelId,
        retirePreviousChampion: body.retirePreviousChampion,
      })
      return { ok: true, ...r }
    } catch (err: any) {
      fastify.log.error({ err }, '[forecast-models/promote] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.post('/fulfillment/replenishment/forecast-models/seed-champions', async (_req, reply) => {
    try {
      const r = await ensureDefaultChampionAssignments({})
      return { ok: true, ...r }
    } catch (err: any) {
      fastify.log.error({ err }, '[forecast-models/seed-champions] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // R.6 — auto-PO run history. Forensic ledger; latest first.
  fastify.get('/fulfillment/replenishment/auto-po/runs', async (request, reply) => {
    try {
      const q = request.query as { limit?: string }
      const limit = Math.max(1, Math.min(200, Number(q.limit) || 30))
      const rows = await prisma.autoPoRunLog.findMany({
        orderBy: { startedAt: 'desc' },
        take: limit,
      })
      return { items: rows }
    } catch (err: any) {
      fastify.log.error({ err }, '[replenishment/auto-po/runs] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ─── R.17 — substitution links CRUD ───────────────────────────────
  // List substitutions where this product is either side (primary or
  // substitute). Drawer panel renders both sides.
  fastify.get('/fulfillment/replenishment/substitutions/:productId', async (request, reply) => {
    try {
      const { productId } = request.params as { productId: string }
      const r = await listSubstitutionsForProduct(productId)
      const items = [
        ...r.asPrimary.map((row) => ({
          id: row.id,
          primaryProductId: row.primaryProductId,
          substituteProductId: row.substituteProductId,
          substitutionFraction: Number(row.substitutionFraction),
          primary: null,
          substitute: row.substitute,
        })),
        ...r.asSubstitute.map((row) => ({
          id: row.id,
          primaryProductId: row.primaryProductId,
          substituteProductId: row.substituteProductId,
          substitutionFraction: Number(row.substitutionFraction),
          primary: row.primary,
          substitute: null,
        })),
      ]
      return { items }
    } catch (err: any) {
      fastify.log.error({ err }, '[substitutions:list] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // Create. Body accepts either {primaryProductId | primarySku} +
  // {substituteProductId | substituteSku}. SKU paths resolve via
  // Product.sku lookup.
  fastify.post('/fulfillment/replenishment/substitutions', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        primaryProductId?: string
        substituteProductId?: string
        primarySku?: string
        substituteSku?: string
        substitutionFraction?: number
      }
      const skusToResolve: string[] = []
      if (!body.primaryProductId && body.primarySku) skusToResolve.push(body.primarySku)
      if (!body.substituteProductId && body.substituteSku) skusToResolve.push(body.substituteSku)
      const skuToId = new Map<string, string>()
      if (skusToResolve.length > 0) {
        const found = await prisma.product.findMany({
          where: { sku: { in: skusToResolve } },
          select: { id: true, sku: true },
        })
        for (const p of found) skuToId.set(p.sku, p.id)
      }
      const primaryProductId = body.primaryProductId ?? (body.primarySku ? skuToId.get(body.primarySku) : undefined)
      const substituteProductId = body.substituteProductId ?? (body.substituteSku ? skuToId.get(body.substituteSku) : undefined)
      if (!primaryProductId || !substituteProductId) {
        return reply.code(400).send({ error: 'primary + substitute (id or sku) required and must resolve' })
      }
      if (primaryProductId === substituteProductId) {
        return reply.code(400).send({ error: 'primary and substitute must differ' })
      }
      const fraction = body.substitutionFraction ?? 0.5
      if (!(fraction > 0 && fraction <= 1)) {
        return reply.code(400).send({ error: 'substitutionFraction must be in (0, 1]' })
      }
      const created = await createSubstitution({
        primaryProductId,
        substituteProductId,
        substitutionFraction: fraction,
      })
      return { ok: true, item: created }
    } catch (err: any) {
      if (err?.code === 'P2002') {
        return reply.code(409).send({ error: 'substitution already exists' })
      }
      fastify.log.error({ err }, '[substitutions:create] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // Update fraction.
  fastify.patch('/fulfillment/replenishment/substitutions/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = (request.body ?? {}) as { substitutionFraction?: number }
      if (body.substitutionFraction == null) {
        return reply.code(400).send({ error: 'substitutionFraction required' })
      }
      if (!(body.substitutionFraction > 0 && body.substitutionFraction <= 1)) {
        return reply.code(400).send({ error: 'substitutionFraction must be in (0, 1]' })
      }
      const updated = await updateSubstitution(id, { substitutionFraction: body.substitutionFraction })
      return { ok: true, item: updated }
    } catch (err: any) {
      if (err?.code === 'P2025') return reply.code(404).send({ error: 'not found' })
      fastify.log.error({ err }, '[substitutions:update] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // Delete.
  fastify.delete('/fulfillment/replenishment/substitutions/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      await deleteSubstitution(id)
      return { ok: true }
    } catch (err: any) {
      if (err?.code === 'P2025') return reply.code(404).send({ error: 'not found' })
      fastify.log.error({ err }, '[substitutions:delete] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ─── R.9 — multi-supplier comparison ─────────────────────────────
  // Returns ranked alternatives for the product (drawer alternates panel).
  fastify.get('/fulfillment/replenishment/products/:productId/supplier-comparison', async (request, reply) => {
    try {
      const { productId } = request.params as { productId: string }
      const q = request.query as { urgency?: string }
      const urgency = (q.urgency ?? 'MEDIUM').toUpperCase() as
        | 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'

      // Load candidates with FX rates (reuse R.15 path).
      const supplierProductsRaw = await prisma.supplierProduct.findMany({
        where: { productId },
        select: { currencyCode: true },
      })
      const fxCurrencies = [
        ...new Set(
          supplierProductsRaw
            .map((sp) => (sp.currencyCode ?? 'EUR').toUpperCase())
            .filter((c) => c !== 'EUR'),
        ),
      ]
      const fxRates = new Map<string, number>()
      for (const ccy of fxCurrencies) {
        const row = await prisma.fxRate.findFirst({
          where: { fromCurrency: 'EUR', toCurrency: ccy },
          orderBy: { asOf: 'desc' },
          select: { rate: true },
        })
        if (row) fxRates.set(ccy, Number(row.rate))
      }
      const candidates = await loadCandidatesForProduct({ productId, fxRates })
      const ranked = rankSuppliers({ candidates, urgency })
      return { productId, urgency, candidates: ranked }
    } catch (err: any) {
      fastify.log.error({ err }, '[supplier-comparison:get] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // Switch the preferred supplier on a product's ReplenishmentRule.
  fastify.post('/fulfillment/replenishment/products/:productId/preferred-supplier', async (request, reply) => {
    try {
      const { productId } = request.params as { productId: string }
      const body = (request.body ?? {}) as { supplierId?: string }
      if (!body.supplierId) {
        return reply.code(400).send({ error: 'supplierId required' })
      }
      await setPreferredSupplier({ productId, supplierId: body.supplierId })
      return { ok: true }
    } catch (err: any) {
      if (err?.message?.includes('No SupplierProduct row')) {
        return reply.code(400).send({ error: err.message })
      }
      fastify.log.error({ err }, '[supplier-comparison:set-preferred] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ─── R.8 — Amazon FBA Restock Reports ────────────────────────────
  // Manual refresh. Body: { marketplaceCode?: string }; omit to
  // refresh every eligible marketplace.
  fastify.post('/fulfillment/replenishment/fba-restock/refresh', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { marketplaceCode?: string }
      if (body.marketplaceCode) {
        const result = await ingestRestockReportForMarketplace({
          marketplaceCode: body.marketplaceCode,
          triggeredBy: 'manual',
        })
        return { ok: true, results: [result] }
      }
      const results = await ingestRestockReportsForAllMarketplaces('manual')
      return { ok: true, results }
    } catch (err: any) {
      fastify.log.error({ err }, '[fba-restock:refresh] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // Status summary for the page card.
  fastify.get('/fulfillment/replenishment/fba-restock/status', async (_req, reply) => {
    try {
      const summary = await getFbaRestockStatus()
      const cron = getFbaRestockCronStatus()
      return {
        ...summary,
        cron: {
          scheduled: cron.scheduled,
          lastRunAt: cron.lastRunAt,
        },
      }
    } catch (err: any) {
      fastify.log.error({ err }, '[fba-restock:status] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // Drawer drill-down: latest row for one (sku, marketplaceCode).
  fastify.get('/fulfillment/replenishment/fba-restock/by-sku/:sku', async (request, reply) => {
    try {
      const { sku } = request.params as { sku: string }
      const q = request.query as { marketplaceCode?: string }
      const code = (q.marketplaceCode ?? 'IT').toUpperCase()
      const marketplaceId = amazonMarketplaceId(code)
      const row = await getLatestRowForSku({ sku, marketplaceId })
      if (!row) return reply.code(404).send({ error: 'no fresh restock row for this sku/marketplace' })
      return {
        sku: row.sku,
        marketplace: row.marketplace,
        marketplaceCode: row.report?.marketplaceCode ?? code,
        recommendedReplenishmentQty: row.recommendedReplenishmentQty,
        daysOfSupply: row.daysOfSupply == null ? null : Number(row.daysOfSupply),
        recommendedShipDate: row.recommendedShipDate,
        daysToInbound: row.daysToInbound,
        salesPace30dUnits: row.salesPace30dUnits,
        salesShortageUnits: row.salesShortageUnits,
        alertType: row.alertType,
        asOf: row.asOf,
      }
    } catch (err: any) {
      fastify.log.error({ err }, '[fba-restock:by-sku] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ─── R.20 — cash-flow projection ─────────────────────────────────
  // Returns 13 weekly buckets with outflow (committed POs becoming
  // due + speculative needsReorder recs) and inflow (trailing-30d
  // daily revenue × 7). Settings.cashOnHandCents seeds the running
  // balance; null = projection still runs but won't render the
  // running-balance line.
  fastify.get('/fulfillment/replenishment/cash-flow/projection', async (request, reply) => {
    try {
      const q = request.query as { horizonWeeks?: string }
      const horizonWeeks = Math.max(4, Math.min(26, Number(q.horizonWeeks) || 13))
      const today = new Date()
      today.setUTCHours(0, 0, 0, 0)

      // Cash on hand from BrandSettings (single-row).
      const settings = await prisma.brandSettings.findFirst({
        select: { cashOnHandCents: true },
      })
      const cashOnHandCents = settings?.cashOnHandCents ?? null

      // Trailing-30d daily revenue (EUR cents). Pulls from
      // DailySalesAggregate sum × ASP. For v1 we approximate "revenue"
      // as `unitsSold × p.basePrice`; orders table has true revenue
      // but is wider per-row. Trailing mean is robust enough.
      const since = new Date(today)
      since.setUTCDate(since.getUTCDate() - 30)
      const dailyAgg = await prisma.dailySalesAggregate.groupBy({
        by: ['sku'],
        where: { day: { gte: since } },
        _sum: { unitsSold: true },
      })
      const skus = dailyAgg.map((r) => r.sku)
      const productsForRevenue =
        skus.length > 0
          ? await prisma.product.findMany({
              where: { sku: { in: skus } },
              select: { sku: true, basePrice: true },
            })
          : []
      const priceBySku = new Map(productsForRevenue.map((p) => [p.sku, Number(p.basePrice)]))
      let revenueCents30d = 0
      for (const r of dailyAgg) {
        const units = r._sum.unitsSold ?? 0
        const price = priceBySku.get(r.sku) ?? 0
        revenueCents30d += Math.round(units * price * 100)
      }
      const dailyRevenueCents = Math.round(revenueCents30d / 30)

      // Open POs we expect to pay during the horizon.
      const horizonEnd = new Date(today)
      horizonEnd.setUTCDate(horizonEnd.getUTCDate() + horizonWeeks * 7 + 60) // pad for terms
      const openPosRaw = await prisma.purchaseOrder.findMany({
        where: {
          status: { in: ['DRAFT', 'REVIEW', 'APPROVED', 'SUBMITTED', 'ACKNOWLEDGED'] as any },
        },
        select: {
          id: true,
          poNumber: true,
          supplierId: true,
          totalCents: true,
          currencyCode: true,
          expectedDeliveryDate: true,
          createdAt: true,
          supplier: { select: { name: true, paymentTerms: true } },
        },
      })

      // FX-normalize to EUR cents using the latest fx rates per
      // currency (reuses R.15 path).
      const poCurrencies = [...new Set(openPosRaw.map((p) => p.currencyCode).filter((c) => c !== 'EUR'))]
      const poFxRates = new Map<string, number>()
      for (const ccy of poCurrencies) {
        const row = await prisma.fxRate.findFirst({
          where: { fromCurrency: 'EUR', toCurrency: ccy },
          orderBy: { asOf: 'desc' },
          select: { rate: true },
        })
        if (row) poFxRates.set(ccy, Number(row.rate))
      }
      const openPos: OpenPo[] = openPosRaw.map((p) => {
        const fx = p.currencyCode === 'EUR' ? 1 : poFxRates.get(p.currencyCode) ?? 1
        return {
          id: p.id,
          poNumber: p.poNumber,
          supplierId: p.supplierId,
          supplierName: p.supplier?.name ?? null,
          totalCentsEur: Math.round(p.totalCents / fx),
          expectedDeliveryDate: p.expectedDeliveryDate,
          createdAt: p.createdAt,
          paymentTerms: p.supplier?.paymentTerms ?? null,
        }
      })

      // Speculative recs: every active recommendation flagged needsReorder.
      const activeRecs = await prisma.replenishmentRecommendation.findMany({
        where: { status: 'ACTIVE', needsReorder: true },
        select: {
          productId: true,
          sku: true,
          reorderQuantity: true,
          unitCostCents: true,
          landedCostPerUnitCents: true,
          preferredSupplierId: true,
          isManufactured: true,
          leadTimeDays: true,
        },
      })
      const supplierIdsForRecs = [
        ...new Set(activeRecs.map((r) => r.preferredSupplierId).filter(Boolean) as string[]),
      ]
      const supplierMeta =
        supplierIdsForRecs.length > 0
          ? await prisma.supplier.findMany({
              where: { id: { in: supplierIdsForRecs } },
              select: { id: true, name: true, paymentTerms: true },
            })
          : []
      const supplierMetaById = new Map(supplierMeta.map((s) => [s.id, s]))
      const speculativeRecs: SpeculativeRec[] = activeRecs.map((r) => {
        const meta = r.preferredSupplierId ? supplierMetaById.get(r.preferredSupplierId) : null
        return {
          productId: r.productId,
          sku: r.sku,
          unitsRecommended: r.reorderQuantity,
          landedCostPerUnitCentsEur: r.landedCostPerUnitCents ?? r.unitCostCents ?? 0,
          preferredSupplierId: r.preferredSupplierId,
          supplierName: meta?.name ?? null,
          paymentTerms: meta?.paymentTerms ?? null,
          isManufactured: r.isManufactured,
          leadTimeDays: r.leadTimeDays,
        }
      })

      const buckets = projectWeeklyCashFlow({
        today,
        horizonWeeks,
        cashOnHandCents,
        dailyRevenueCents,
        openPos,
        speculativeRecs,
      })
      return {
        cashOnHandCents,
        dailyRevenueCents,
        openPoCount: openPos.length,
        speculativeRecCount: speculativeRecs.length,
        buckets,
      }
    } catch (err: any) {
      fastify.log.error({ err }, '[cash-flow/projection] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // PUT cash on hand. Single-row BrandSettings convention.
  fastify.put('/fulfillment/replenishment/cash-flow/cash-on-hand', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { cashOnHandCents?: number | null }
      if (body.cashOnHandCents != null && (!Number.isFinite(body.cashOnHandCents) || body.cashOnHandCents < 0)) {
        return reply.code(400).send({ error: 'cashOnHandCents must be a non-negative integer or null' })
      }
      const existing = await prisma.brandSettings.findFirst()
      if (existing) {
        await prisma.brandSettings.update({
          where: { id: existing.id },
          data: { cashOnHandCents: body.cashOnHandCents ?? null },
        })
      } else {
        await prisma.brandSettings.create({
          data: { cashOnHandCents: body.cashOnHandCents ?? null },
        })
      }
      return { ok: true, cashOnHandCents: body.cashOnHandCents ?? null }
    } catch (err: any) {
      fastify.log.error({ err }, '[cash-flow/cash-on-hand:put] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ─── R.19 — supplier shipping profiles ───────────────────────────
  fastify.get('/fulfillment/supplier-shipping-profiles/:supplierId', async (request, reply) => {
    try {
      const { supplierId } = request.params as { supplierId: string }
      const profile = await getShippingProfile(supplierId)
      return { profile }
    } catch (err: any) {
      fastify.log.error({ err }, '[supplier-shipping-profile:get] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.put('/fulfillment/supplier-shipping-profiles/:supplierId', async (request, reply) => {
    try {
      const { supplierId } = request.params as { supplierId: string }
      const body = (request.body ?? {}) as {
        mode?: string
        costPerCbmCents?: number | null
        costPerKgCents?: number | null
        fixedCostCents?: number | null
        currencyCode?: string
        containerCapacityCbm?: number | null
        containerMaxWeightKg?: number | null
        notes?: string | null
      }
      const validModes = ['AIR', 'SEA_LCL', 'SEA_FCL_20', 'SEA_FCL_40', 'ROAD']
      if (!body.mode || !validModes.includes(body.mode)) {
        return reply.code(400).send({ error: `mode must be one of ${validModes.join(', ')}` })
      }
      const profile = await putShippingProfile({
        supplierId,
        mode: body.mode as ShippingMode,
        costPerCbmCents: body.costPerCbmCents,
        costPerKgCents: body.costPerKgCents,
        fixedCostCents: body.fixedCostCents,
        currencyCode: body.currencyCode,
        containerCapacityCbm: body.containerCapacityCbm,
        containerMaxWeightKg: body.containerMaxWeightKg,
        notes: body.notes,
      })
      return { ok: true, profile }
    } catch (err: any) {
      fastify.log.error({ err }, '[supplier-shipping-profile:put] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // Container fill snapshot. Reuses the live recommendation list to
  // avoid re-running the engine. Caller supplies supplierId + the
  // candidate items (productId, units). For v1 this just runs
  // optimizeContainerFill against the items as-given; the main
  // /replenishment route already returns containerFill[].
  fastify.post('/fulfillment/replenishment/container-fill', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        supplierId?: string
        items?: Array<{
          productId: string
          unitsQty: number
          casePack?: number | null
          urgency?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
        }>
      }
      if (!body.supplierId || !Array.isArray(body.items) || body.items.length === 0) {
        return reply.code(400).send({ error: 'supplierId + items[] required' })
      }
      const profile = await getShippingProfile(body.supplierId)
      if (!profile) return reply.code(404).send({ error: 'no shipping profile for supplier' })
      const productIds = body.items.map((i) => i.productId)
      const products = await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: {
          id: true, sku: true,
          dimLength: true, dimWidth: true, dimHeight: true, dimUnit: true,
          weightValue: true, weightUnit: true,
        },
      })
      const productById = new Map(products.map((p) => [p.id, p]))
      const packItems: PackItem[] = []
      for (const it of body.items) {
        const p = productById.get(it.productId)
        if (!p) continue
        const dims = normalizeDimsToCm({
          length: p.dimLength != null ? Number(p.dimLength) : null,
          width: p.dimWidth != null ? Number(p.dimWidth) : null,
          height: p.dimHeight != null ? Number(p.dimHeight) : null,
          unit: p.dimUnit,
        })
        const grams = normalizeWeightToGrams({
          value: p.weightValue != null ? Number(p.weightValue) : null,
          unit: p.weightUnit,
        })
        if (!dims || grams == null) continue
        packItems.push({
          productId: p.id,
          sku: p.sku,
          unitsQty: Math.max(0, it.unitsQty || 0),
          cbmPerUnit: cbmFromDims(dims.l, dims.w, dims.h),
          kgPerUnit: grams / 1000,
          unitCostCents: 0,
          urgency: it.urgency ?? 'LOW',
          casePack: it.casePack ?? null,
        })
      }
      const fill = optimizeContainerFill({
        items: packItems,
        profile: {
          mode: profile.mode as ShippingMode,
          costPerCbmCents: profile.costPerCbmCents ?? null,
          costPerKgCents: profile.costPerKgCents ?? null,
          fixedCostCents: profile.fixedCostCents ?? null,
          currencyCode: profile.currencyCode,
          containerCapacityCbm: profile.containerCapacityCbm == null
            ? null : Number(profile.containerCapacityCbm),
          containerMaxWeightKg: profile.containerMaxWeightKg == null
            ? null : Number(profile.containerMaxWeightKg),
        },
      })
      return {
        ok: true,
        mode: fill.mode,
        totalCbm: fill.totalCbm,
        totalKg: fill.totalKg,
        fillPercentByCbm: fill.fillPercentByCbm,
        fillPercentByWeight: fill.fillPercentByWeight,
        freightCostCents: fill.freightCostCents,
        perLineFreightCents: Object.fromEntries(fill.perLineFreightCents),
        topUpSuggestions: fill.topUpSuggestions,
      }
    } catch (err: any) {
      fastify.log.error({ err }, '[container-fill] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // CARRIERS
  // ═══════════════════════════════════════════════════════════════════

  fastify.get('/fulfillment/carriers', async (_request, reply) => {
    try {
      const items = await prisma.carrier.findMany({ orderBy: { code: 'asc' } })
      // Don't expose encrypted creds. CR.8: surface health columns so
      // the marketplace card + drawer can render lastVerifiedAt /
      // lastError without a second API call.
      return {
        items: items.map((c) => ({
          id: c.id,
          code: c.code,
          name: c.name,
          isActive: c.isActive,
          hasCredentials: !!c.credentialsEncrypted,
          defaultServiceMap: c.defaultServiceMap,
          lastUsedAt: c.lastUsedAt,
          lastVerifiedAt: c.lastVerifiedAt,
          lastErrorAt: c.lastErrorAt,
          lastError: c.lastError,
          accountLabel: c.accountLabel,
          mode: c.mode,
          preferences: c.preferences,
          updatedAt: c.updatedAt,
        })),
      }
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/carriers/:code/connect', async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const body = request.body as { publicKey?: string; privateKey?: string; integrationId?: number; defaultServiceMap?: any }

      // CR.2: validate Sendcloud credentials BEFORE persisting. Calls
      // GET /user with the supplied public/private key; on 401/403 we
      // refuse the connect with a 400 + clear reason. dryRun mode
      // (NEXUS_ENABLE_SENDCLOUD_REAL=false) returns ok=true without a
      // network call so local-dev connect flow stays usable. Other
      // carrier codes (AMAZON_BUY_SHIPPING / MANUAL) skip validation
      // — they have no secret to verify.
      if (code === 'SENDCLOUD') {
        if (!body.publicKey || !body.privateKey) {
          return reply.code(400).send({ error: 'publicKey and privateKey are required.', code: 'MISSING_CREDENTIALS' })
        }
        const sendcloud = await import('../services/sendcloud/index.js')
        const verify = await sendcloud.verifyCredentials({
          publicKey: body.publicKey,
          privateKey: body.privateKey,
          integrationId: body.integrationId,
        })
        if (verify.ok === false) {
          return reply.code(400).send({
            error: `Sendcloud rejected the credentials: ${verify.reason}`,
            code: 'CREDENTIAL_VERIFY_FAILED',
            reason: verify.reason,
          })
        }
      }

      // CR.1: encrypt the credential blob at rest with AES-256-GCM.
      // Envelope format documented in apps/api/src/lib/crypto.ts.
      // Empty payloads (AMAZON_BUY_SHIPPING / MANUAL connect with no
      // fields) skip encryption — there's nothing secret to protect
      // and storing an encrypted-empty-JSON would only obscure the row.
      const { encryptSecret } = await import('../lib/crypto.js')
      const hasSecret = !!(body.publicKey || body.privateKey || body.integrationId)
      const credentialsEncrypted = hasSecret
        ? encryptSecret(JSON.stringify({
            publicKey: body.publicKey,
            privateKey: body.privateKey,
            integrationId: body.integrationId,
          }))
        : null
      const existing = await prisma.carrier.findUnique({ where: { code: code as any } })
      const data = {
        code: code as any,
        name: code === 'SENDCLOUD' ? 'Sendcloud' : code === 'AMAZON_BUY_SHIPPING' ? 'Amazon Buy Shipping' : 'Manual',
        isActive: true,
        credentialsEncrypted,
        defaultServiceMap: body.defaultServiceMap ?? null,
      }
      const upserted = existing
        ? await prisma.carrier.update({ where: { code: code as any }, data })
        : await prisma.carrier.create({ data })
      return { ok: true, carrier: { id: upserted.id, code: upserted.code, name: upserted.name, isActive: upserted.isActive } }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[carriers/:code/connect] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // CR.2 — "Test connection" endpoint.
  // CR.8: also persists the result to Carrier.lastVerifiedAt /
  // .lastError / .lastErrorAt so the marketplace card + drawer header
  // can render last-checked timestamps without a separate API call.
  // Read-mostly: only writes when the verification result actually
  // moves the needle (success → set lastVerifiedAt + clear error;
  // failure → set lastError + lastErrorAt).
  fastify.post('/fulfillment/carriers/:code/test', async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      if (code !== 'SENDCLOUD') {
        // Other carrier codes have no live API today — surface a clear
        // status so the UI can disable the Test button rather than
        // returning a misleading "ok".
        return { ok: true, mode: 'no-op', message: `${code} has no test endpoint` }
      }
      const sendcloud = await import('../services/sendcloud/index.js')
      let creds
      try {
        creds = await sendcloud.resolveCredentials()
      } catch (e: any) {
        if (e instanceof sendcloud.SendcloudError) {
          // Persist the failure so the UI shows it next time.
          void prisma.carrier
            .updateMany({
              where: { code: 'SENDCLOUD' },
              data: { lastError: e.message, lastErrorAt: new Date() },
            })
            .catch(() => { /* */ })
          return reply.code(e.status).send({ ok: false, error: e.message, code: e.code })
        }
        throw e
      }
      const result = await sendcloud.verifyCredentials(creds)
      const mode = sendcloud.getSendcloudMode()

      // CR.8: persist health state. dryRun successes count as
      // verifications so the local-dev workflow shows "Verified just
      // now" without flipping NEXUS_ENABLE_SENDCLOUD_REAL.
      if (result.ok === true) {
        void prisma.carrier
          .updateMany({
            where: { code: 'SENDCLOUD' },
            data: { lastVerifiedAt: new Date(), lastError: null, lastErrorAt: null },
          })
          .catch(() => { /* */ })
      } else {
        void prisma.carrier
          .updateMany({
            where: { code: 'SENDCLOUD' },
            data: { lastError: result.reason, lastErrorAt: new Date() },
          })
          .catch(() => { /* */ })
      }

      return { ...result, dryRun: mode.dryRun, env: mode.env }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[carriers/:code/test] failed')
      return reply.code(500).send({ ok: false, error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/carriers/:code/disconnect', async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const body = (request.body ?? {}) as { purge?: boolean }
      const existing = await prisma.carrier.findUnique({ where: { code: code as any } })
      if (!existing) return reply.code(404).send({ error: 'Carrier not connected' })

      // CR.18: by default a soft-disconnect — flips isActive false +
      // nulls credentials, but leaves CarrierServiceMapping rows,
      // PickupSchedule rows, and preferences alone so a reconnect
      // restores the operator's setup. With { purge: true } we sweep
      // dependent rows for a clean slate.
      const swept = body.purge
        ? await prisma.$transaction(async (tx) => {
            const mappingsCount = await tx.carrierServiceMapping.deleteMany({
              where: { carrierId: existing.id },
            })
            // Cancel rather than delete pickups so the operator can see
            // historical bookings + the externalRefs that hit Sendcloud.
            const pickupsCount = await tx.pickupSchedule.updateMany({
              where: { carrierId: existing.id, status: 'ACTIVE' },
              data: { status: 'CANCELLED' },
            })
            await tx.carrier.update({
              where: { code: code as any },
              data: {
                isActive: false,
                credentialsEncrypted: null,
                lastVerifiedAt: null,
                lastError: null,
                lastErrorAt: null,
                preferences: undefined,
              },
            })
            return { mappings: mappingsCount.count, pickupsCancelled: pickupsCount.count }
          })
        : (await prisma.carrier.update({
            where: { code: code as any },
            data: { isActive: false, credentialsEncrypted: null, lastError: null, lastErrorAt: null },
          }), { mappings: 0, pickupsCancelled: 0 })

      return { ok: true, purged: !!body.purge, ...swept }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[carriers/:code/disconnect] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // CR.7 — CARRIER SERVICES + SERVICE MAPPING
  // ═══════════════════════════════════════════════════════════════════

  // GET /fulfillment/carriers/:code/services — live services from the
  // carrier's API + cached CarrierService rows. Today: only SENDCLOUD;
  // calls listShippingMethods with a probe weight + country (operator
  // can override via query). dryRun returns the three Sendcloud mocks.
  // Hits the carrier on every call (no cache). Cache lands in CR.12
  // when the nightly catalog sync ships.
  fastify.get('/fulfillment/carriers/:code/services', async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const q = request.query as { weightKg?: string; toCountry?: string }
      if (code !== 'SENDCLOUD') {
        return { items: [] }
      }
      const sendcloud = await import('../services/sendcloud/index.js')
      let creds
      try {
        creds = await sendcloud.resolveCredentials()
      } catch (e: any) {
        if (e instanceof sendcloud.SendcloudError) {
          return reply.code(e.status).send({ error: e.message, code: e.code })
        }
        throw e
      }
      const methods = await sendcloud.listShippingMethods(creds, {
        weightKg: q.weightKg ? Number(q.weightKg) : 1.5,
        toCountry: (q.toCountry ?? 'IT').toUpperCase(),
      })
      return {
        items: methods.map((m) => ({
          externalId: String(m.id),
          name: m.name,
          carrier: m.carrier,
          minWeightKg: m.minWeightKg,
          maxWeightKg: m.maxWeightKg,
          basePriceEur: m.price,
        })),
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[carriers/:code/services] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // GET /fulfillment/carriers/:code/mappings — list existing channel ×
  // marketplace × warehouse → service mappings for this carrier.
  fastify.get('/fulfillment/carriers/:code/mappings', async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const carrier = await prisma.carrier.findUnique({ where: { code: code as any } })
      if (!carrier) return { items: [] }
      const items = await prisma.carrierServiceMapping.findMany({
        where: { carrierId: carrier.id },
        orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }, { warehouseId: 'asc' }],
        include: {
          service: { select: { name: true, externalId: true, carrierSubName: true, tier: true } },
        },
      })
      return { items }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[carriers/:code/mappings GET] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // POST /fulfillment/carriers/:code/mappings — create or upsert a
  // mapping. Body: { channel, marketplace, warehouseId?, service:
  // { externalId, name, tier?, carrierSubName? } }. Auto-creates the
  // CarrierService row if it doesn't exist (operator picked from the
  // live /services list). Upserts on the (carrier, channel, market,
  // warehouse) tuple via the partial unique indexes from CR.3.
  fastify.post('/fulfillment/carriers/:code/mappings', async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const body = request.body as {
        channel?: string
        marketplace?: string
        warehouseId?: string | null
        tierOverride?: string | null
        service?: { externalId?: string; name?: string; tier?: string; carrierSubName?: string }
      }
      if (!body.channel || !body.service?.externalId || !body.service?.name) {
        return reply.code(400).send({ error: 'channel + service.externalId + service.name required' })
      }
      const carrier = await prisma.carrier.findUnique({ where: { code: code as any } })
      if (!carrier) return reply.code(404).send({ error: 'Carrier not found' })

      // Upsert the CarrierService row keyed on (carrierId, externalId).
      const service = await prisma.carrierService.upsert({
        where: { carrierId_externalId: { carrierId: carrier.id, externalId: body.service.externalId } },
        create: {
          carrierId: carrier.id,
          externalId: body.service.externalId,
          name: body.service.name,
          tier: body.service.tier ?? null,
          carrierSubName: body.service.carrierSubName ?? null,
        },
        update: {
          name: body.service.name,
          tier: body.service.tier ?? null,
          carrierSubName: body.service.carrierSubName ?? null,
        },
      })

      const market = body.marketplace ?? 'GLOBAL'
      const warehouseId = body.warehouseId ?? null

      // Manual upsert because Prisma can't express the partial-unique
      // index from CR.3 (warehouseId NULL vs NOT NULL split). Find by
      // tuple, update or create.
      const existing = await prisma.carrierServiceMapping.findFirst({
        where: { carrierId: carrier.id, channel: body.channel, marketplace: market, warehouseId },
      })
      const saved = existing
        ? await prisma.carrierServiceMapping.update({
            where: { id: existing.id },
            data: { serviceId: service.id, tierOverride: body.tierOverride ?? null },
          })
        : await prisma.carrierServiceMapping.create({
            data: {
              carrierId: carrier.id,
              serviceId: service.id,
              channel: body.channel,
              marketplace: market,
              warehouseId,
              tierOverride: body.tierOverride ?? null,
            },
          })
      return { ok: true, mapping: saved }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[carriers/:code/mappings POST] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // DELETE /fulfillment/carriers/:code/mappings/:id — remove a mapping.
  // Doesn't touch the underlying CarrierService row (other mappings
  // may still point at it).
  fastify.delete('/fulfillment/carriers/:code/mappings/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      await prisma.carrierServiceMapping.delete({ where: { id } })
      return { ok: true }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[carriers/:code/mappings DELETE] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // CR.12 — manual catalog refresh. Runs the same logic as the
  // nightly cron but on demand. Returns counts so the UI can show
  // a toast like "Synced 12 services". Sendcloud-only today.
  fastify.post('/fulfillment/carriers/:code/services/sync', async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      if (code !== 'SENDCLOUD') {
        return { ok: true, mode: 'no-op', message: `${code} has no service catalog` }
      }
      const { runCarrierServiceSync } = await import('../jobs/carrier-service-sync.job.js')
      const result = await runCarrierServiceSync()
      return { ok: true, ...result }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[carriers/:code/services/sync] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // CR.16 — pickup scheduling. PickupSchedule rows; one-time SENDCLOUD
  // pickups dispatch immediately to /pickups, recurring pickups
  // persist for the dispatch cron (later commit) to fire daily.
  fastify.get('/fulfillment/carriers/:code/pickups', async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const carrier = await prisma.carrier.findUnique({ where: { code: code as any } })
      if (!carrier) return { items: [] }
      const items = await prisma.pickupSchedule.findMany({
        where: { carrierId: carrier.id },
        orderBy: [{ status: 'asc' }, { scheduledFor: 'asc' }, { createdAt: 'desc' }],
      })
      return { items }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[carriers/:code/pickups GET] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/carriers/:code/pickups', async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const body = request.body as {
        warehouseId?: string | null
        isRecurring?: boolean
        daysOfWeek?: number | null
        scheduledFor?: string | null
        windowStart?: string | null
        windowEnd?: string | null
        contactName?: string | null
        contactPhone?: string | null
        notes?: string | null
      }
      const carrier = await prisma.carrier.findUnique({ where: { code: code as any } })
      if (!carrier) return reply.code(404).send({ error: 'Carrier not connected' })

      const isRecurring = !!body.isRecurring
      if (!isRecurring && !body.scheduledFor) {
        return reply.code(400).send({ error: 'scheduledFor required for one-time pickup' })
      }
      if (isRecurring && (!body.daysOfWeek || body.daysOfWeek <= 0)) {
        return reply.code(400).send({ error: 'daysOfWeek bitmap required for recurring pickup' })
      }

      const row = await prisma.pickupSchedule.create({
        data: {
          carrierId: carrier.id,
          warehouseId: body.warehouseId ?? null,
          isRecurring,
          daysOfWeek: body.daysOfWeek ?? null,
          scheduledFor: body.scheduledFor ? new Date(body.scheduledFor) : null,
          windowStart: body.windowStart ?? null,
          windowEnd: body.windowEnd ?? null,
          contactName: body.contactName ?? null,
          contactPhone: body.contactPhone ?? null,
          notes: body.notes ?? null,
          status: 'ACTIVE',
        },
      })

      // One-time SENDCLOUD pickups dispatch immediately so the operator
      // sees confirmation. Failures persist as lastDispatchErr.
      if (!isRecurring && code === 'SENDCLOUD') {
        try {
          const sendcloud = await import('../services/sendcloud/index.js')
          const creds = await sendcloud.resolveCredentials()
          let senderAddressId: number | null = null
          if (body.warehouseId) {
            const wh = await prisma.warehouse.findUnique({
              where: { id: body.warehouseId },
              select: { sendcloudSenderId: true },
            })
            senderAddressId = wh?.sendcloudSenderId ?? null
          }
          if (!senderAddressId) {
            const senders = await sendcloud.listSenderAddresses(creds)
            senderAddressId = senders.find((s) => s.isDefault)?.id ?? senders[0]?.id ?? null
          }
          if (!senderAddressId) {
            throw new Error('No Sendcloud sender address available')
          }
          const result = await sendcloud.requestPickup(creds, {
            senderAddressId,
            pickupDate: body.scheduledFor!.slice(0, 10),
            notes: body.notes ?? undefined,
          })
          if (result.ok === true) {
            await prisma.pickupSchedule.update({
              where: { id: row.id },
              data: { externalRef: result.externalRef, lastDispatchAt: new Date() },
            })
          } else {
            await prisma.pickupSchedule.update({
              where: { id: row.id },
              data: { lastDispatchErr: result.reason },
            })
          }
        } catch (err: any) {
          await prisma.pickupSchedule.update({
            where: { id: row.id },
            data: { lastDispatchErr: err?.message ?? String(err) },
          }).catch(() => { /* */ })
        }
      }

      const fresh = await prisma.pickupSchedule.findUnique({ where: { id: row.id } })
      return { ok: true, pickup: fresh }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[carriers/:code/pickups POST] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/carriers/:code/pickups/:id/cancel', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      await prisma.pickupSchedule.update({
        where: { id },
        data: { status: 'CANCELLED' },
      })
      return { ok: true }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[carriers/:code/pickups cancel] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // CR.13 — operator-tunable preferences.
  // PATCH /carriers/:code/preferences
  // Body: partial preferences object. Merges with existing rather
  // than replacing so a single-key update doesn't clobber other
  // toggles.
  fastify.patch('/fulfillment/carriers/:code/preferences', async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const patch = (request.body ?? {}) as Record<string, unknown>
      const existing = await prisma.carrier.findUnique({
        where: { code: code as any },
        select: { preferences: true },
      })
      if (!existing) return reply.code(404).send({ error: 'Carrier not connected' })
      const merged = { ...(existing.preferences as any ?? {}), ...patch }
      const updated = await prisma.carrier.update({
        where: { code: code as any },
        data: { preferences: merged },
      })
      return { ok: true, preferences: updated.preferences }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[carriers/:code/preferences PATCH] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // CR.11 — Sendcloud sender addresses.
  //
  // GET /fulfillment/carriers/:code/sender-addresses
  //
  // Lists the sender addresses configured on the connected Sendcloud
  // account. UI binds Warehouse.sendcloudSenderId to one of these so
  // print-label sends parcels from the right origin (today the print-
  // label flow doesn't pass sender_address — Sendcloud uses the
  // integration default, which is wrong for multi-warehouse setups).
  fastify.get('/fulfillment/carriers/:code/sender-addresses', async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      if (code !== 'SENDCLOUD') return { items: [] }
      const sendcloud = await import('../services/sendcloud/index.js')
      let creds
      try {
        creds = await sendcloud.resolveCredentials()
      } catch (e: any) {
        if (e instanceof sendcloud.SendcloudError) {
          return reply.code(e.status).send({ error: e.message, code: e.code })
        }
        throw e
      }
      const items = await sendcloud.listSenderAddresses(creds)
      return { items }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[carriers/:code/sender-addresses] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // CR.11 — bind a Sendcloud sender_address ID to a warehouse.
  // PATCH /fulfillment/warehouses/:id  body: { sendcloudSenderId: number | null }
  // null clears the binding (warehouse falls back to integration default).
  fastify.patch('/fulfillment/warehouses/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as { sendcloudSenderId?: number | null }
      const data: { sendcloudSenderId?: number | null } = {}
      if (Object.prototype.hasOwnProperty.call(body, 'sendcloudSenderId')) {
        data.sendcloudSenderId = body.sendcloudSenderId ?? null
      }
      const updated = await prisma.warehouse.update({ where: { id }, data })
      return { ok: true, warehouse: updated }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[warehouses/:id PATCH] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // CR.15 — per-carrier performance metrics.
  //
  // GET /fulfillment/carriers/:code/metrics?windowDays=30
  //
  // Computes shipment-volume + cost + on-time stats from raw
  // Shipment + Order rows for the requested window. Bypasses the
  // CarrierMetric cache for now (CR.3 added the table; CR.15 chose
  // live aggregation since the volume is bounded by shipments-in-
  // last-90d which is small for a single-warehouse operator). The
  // metrics-job (later commit) will pre-warm CarrierMetric rows so
  // this endpoint can switch to a cached read when volume grows.
  fastify.get('/fulfillment/carriers/:code/metrics', async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const q = request.query as { windowDays?: string }
      const windowDays = Math.min(365, Math.max(1, Number(q.windowDays ?? 30) || 30))
      const since = new Date(Date.now() - windowDays * 86400000)

      const shipments = await prisma.shipment.findMany({
        where: { carrierCode: code as any, createdAt: { gte: since } },
        select: {
          id: true,
          status: true,
          costCents: true,
          shippedAt: true,
          deliveredAt: true,
          createdAt: true,
          order: { select: { shipByDate: true, marketplace: true } },
        },
      })

      let totalCost = 0
      let costSamples = 0
      let onTime = 0
      let late = 0
      let delivered = 0
      let deliveryHoursSum = 0
      let deliveryHoursSamples = 0
      const byMarket: Record<string, number> = {}

      for (const s of shipments) {
        if (s.costCents != null) {
          totalCost += s.costCents
          costSamples++
        }
        if (s.shippedAt && s.order?.shipByDate) {
          if (s.shippedAt.getTime() > s.order.shipByDate.getTime()) late++
          else onTime++
        }
        if (s.deliveredAt) {
          delivered++
          if (s.shippedAt) {
            deliveryHoursSum += (s.deliveredAt.getTime() - s.shippedAt.getTime()) / 3_600_000
            deliveryHoursSamples++
          }
        }
        const mk = s.order?.marketplace ?? 'unknown'
        byMarket[mk] = (byMarket[mk] ?? 0) + 1
      }

      return {
        carrierCode: code,
        windowDays,
        shipmentCount: shipments.length,
        totalCostCents: totalCost,
        avgCostCents: costSamples > 0 ? Math.round(totalCost / costSamples) : null,
        onTimeCount: onTime,
        lateCount: late,
        lateRate: onTime + late > 0 ? late / (onTime + late) : null,
        deliveredCount: delivered,
        avgDeliveryHours: deliveryHoursSamples > 0 ? Math.round(deliveryHoursSum / deliveryHoursSamples) : null,
        byMarketplace: Object.entries(byMarket).map(([marketplace, count]) => ({ marketplace, count })).sort((a, b) => b.count - a.count),
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[carriers/:code/metrics] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // WAREHOUSE
  // ═══════════════════════════════════════════════════════════════════

  fastify.get('/fulfillment/warehouses', async (_request, reply) => {
    const items = await prisma.warehouse.findMany({ orderBy: [{ isDefault: 'desc' }, { code: 'asc' }] })
    return { items }
  })
}

export default fulfillmentRoutes
