/**
 * Cycle count service. Powers structured physical-inventory count
 * sessions with per-item variance reconciliation. Variances apply
 * via the existing applyStockMovement primitive (reason=
 * INVENTORY_COUNT, referenceType=CycleCount) so the StockMovement
 * audit trail explains every count-driven adjustment.
 *
 * Lifecycle:
 *   create()   → DRAFT (snapshot every active StockLevel at the
 *                location into CycleCountItem rows)
 *   start()    → IN_PROGRESS (operator starts entering counts)
 *   recordCount() per item → COUNTED
 *   reconcileItem() per item → RECONCILED (variance applied)
 *   ignoreItem() per item → IGNORED (operator declined)
 *   complete() → COMPLETED (only when every item is RECONCILED or IGNORED)
 *   cancel() at any non-terminal state → CANCELLED
 *
 * Snapshot vs. live: counts are computed against expectedQuantity
 * snapshotted at start time, NOT against current StockLevel. This
 * means concurrent stock writes during the count don't invalidate
 * the operator's variance — they're cleanly recorded as separate
 * StockMovement rows.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { applyStockMovement } from './stock-movement.service.js'

export interface CreateCycleCountInput {
  locationId: string
  notes?: string
  createdBy?: string
}

/**
 * Create a DRAFT cycle count + snapshot every (product, variation)
 * with non-zero StockLevel at the given location into items. The
 * operator can then start the session.
 */
export async function createCycleCount(input: CreateCycleCountInput) {
  // Validate location exists
  const location = await prisma.stockLocation.findUnique({
    where: { id: input.locationId },
    select: { id: true, code: true, name: true },
  })
  if (!location) {
    throw new Error(`Location not found: ${input.locationId}`)
  }

  // Snapshot stock levels at this location. We include rows with
  // quantity=0 too — operators sometimes find phantom stock that
  // SHOULD be zero but isn't, and we want those captured.
  const stockLevels = await prisma.stockLevel.findMany({
    where: { locationId: input.locationId },
    select: {
      productId: true,
      variationId: true,
      quantity: true,
    },
  })

  if (stockLevels.length === 0) {
    throw new Error(
      `No stock levels at location ${location.code}; nothing to count.`,
    )
  }

  // Bulk-resolve SKUs.
  const productIds = Array.from(new Set(stockLevels.map((s) => s.productId)))
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, sku: true },
  })
  const skuByProduct = new Map(products.map((p) => [p.id, p.sku] as const))

  return await prisma.$transaction(async (tx) => {
    const count = await tx.cycleCount.create({
      data: {
        locationId: input.locationId,
        status: 'DRAFT',
        notes: input.notes ?? null,
        createdBy: input.createdBy ?? null,
      },
    })
    await tx.cycleCountItem.createMany({
      data: stockLevels.map((sl) => ({
        cycleCountId: count.id,
        productId: sl.productId,
        variationId: sl.variationId,
        sku: skuByProduct.get(sl.productId) ?? '(unknown)',
        expectedQuantity: sl.quantity,
        status: 'PENDING' as const,
      })),
    })
    return count
  })
}

export async function startCycleCount(
  id: string,
  startedByUserId?: string,
) {
  const count = await prisma.cycleCount.findUnique({
    where: { id },
    select: { id: true, status: true },
  })
  if (!count) throw new Error(`Cycle count not found: ${id}`)
  if (count.status !== 'DRAFT') {
    throw new Error(
      `Cannot start cycle count from status ${count.status} (expected DRAFT)`,
    )
  }
  return prisma.cycleCount.update({
    where: { id },
    data: {
      status: 'IN_PROGRESS',
      startedAt: new Date(),
      startedByUserId: startedByUserId ?? null,
    },
  })
}

export async function recordCount(args: {
  itemId: string
  countedQuantity: number
  countedByUserId?: string
  notes?: string
}) {
  if (!Number.isInteger(args.countedQuantity) || args.countedQuantity < 0) {
    throw new Error('countedQuantity must be a non-negative integer')
  }
  const item = await prisma.cycleCountItem.findUnique({
    where: { id: args.itemId },
    include: {
      cycleCount: { select: { status: true } },
    },
  })
  if (!item) throw new Error(`Cycle count item not found: ${args.itemId}`)
  if (item.cycleCount.status !== 'IN_PROGRESS') {
    throw new Error(
      `Can only record counts on IN_PROGRESS sessions (got ${item.cycleCount.status})`,
    )
  }
  if (item.status === 'RECONCILED') {
    throw new Error('Item already reconciled; cannot re-record.')
  }
  return prisma.cycleCountItem.update({
    where: { id: args.itemId },
    data: {
      countedQuantity: args.countedQuantity,
      countedAt: new Date(),
      countedByUserId: args.countedByUserId ?? null,
      notes: args.notes ?? item.notes,
      status: 'COUNTED',
    },
  })
}

export async function reconcileItem(args: {
  itemId: string
  reconciledByUserId?: string
}) {
  const item = await prisma.cycleCountItem.findUnique({
    where: { id: args.itemId },
    include: {
      cycleCount: { select: { status: true, locationId: true, id: true } },
    },
  })
  if (!item) throw new Error(`Cycle count item not found: ${args.itemId}`)
  if (item.status !== 'COUNTED') {
    throw new Error(
      `Can only reconcile COUNTED items (got ${item.status})`,
    )
  }
  if (item.countedQuantity == null) {
    throw new Error('Item has no counted quantity; cannot reconcile.')
  }
  if (item.cycleCount.status !== 'IN_PROGRESS') {
    throw new Error('Cycle count is not IN_PROGRESS.')
  }

  const change = item.countedQuantity - item.expectedQuantity
  let movementId: string | null = null

  if (change !== 0) {
    // Apply via existing primitive — gets us audit row + cascade to
    // ChannelListing for free. The post-commit BullMQ enqueue runs
    // (TECH_DEBT #54 root-cause fix is in lib/queue.ts); cron drains
    // within 60s either way.
    const movement = await applyStockMovement({
      productId: item.productId,
      variationId: item.variationId ?? undefined,
      locationId: item.cycleCount.locationId,
      change,
      reason: 'INVENTORY_COUNT',
      referenceType: 'CycleCount',
      referenceId: item.cycleCount.id,
      actor: args.reconciledByUserId ?? 'cycle-count',
      notes: `Cycle count variance: expected=${item.expectedQuantity} counted=${item.countedQuantity}`,
    })
    movementId = movement?.id ?? null
  } else {
    logger.debug('Cycle count item: zero variance, no StockMovement', {
      itemId: args.itemId,
      productId: item.productId,
    })
  }

  return prisma.cycleCountItem.update({
    where: { id: args.itemId },
    data: {
      status: 'RECONCILED',
      reconciledAt: new Date(),
      reconciledByUserId: args.reconciledByUserId ?? null,
      reconciledMovementId: movementId,
    },
  })
}

export async function ignoreItem(args: {
  itemId: string
  reconciledByUserId?: string
  notes?: string
}) {
  const item = await prisma.cycleCountItem.findUnique({
    where: { id: args.itemId },
    select: { id: true, status: true, notes: true },
  })
  if (!item) throw new Error(`Cycle count item not found: ${args.itemId}`)
  if (item.status === 'RECONCILED') {
    throw new Error('Item already reconciled; cannot ignore.')
  }
  return prisma.cycleCountItem.update({
    where: { id: args.itemId },
    data: {
      status: 'IGNORED',
      reconciledAt: new Date(),
      reconciledByUserId: args.reconciledByUserId ?? null,
      notes: args.notes ?? item.notes,
    },
  })
}

export async function completeCycleCount(
  id: string,
  completedByUserId?: string,
) {
  const count = await prisma.cycleCount.findUnique({
    where: { id },
    include: { items: { select: { status: true } } },
  })
  if (!count) throw new Error(`Cycle count not found: ${id}`)
  if (count.status !== 'IN_PROGRESS') {
    throw new Error(
      `Can only complete IN_PROGRESS sessions (got ${count.status})`,
    )
  }
  const unresolved = count.items.filter(
    (i) => i.status !== 'RECONCILED' && i.status !== 'IGNORED',
  )
  if (unresolved.length > 0) {
    throw new Error(
      `${unresolved.length} item(s) still pending — reconcile or ignore each before completing.`,
    )
  }
  return prisma.cycleCount.update({
    where: { id },
    data: {
      status: 'COMPLETED',
      completedAt: new Date(),
      completedByUserId: completedByUserId ?? null,
    },
  })
}

export async function cancelCycleCount(args: {
  id: string
  reason?: string
}) {
  const count = await prisma.cycleCount.findUnique({
    where: { id: args.id },
    select: { id: true, status: true },
  })
  if (!count) throw new Error(`Cycle count not found: ${args.id}`)
  if (count.status === 'COMPLETED' || count.status === 'CANCELLED') {
    throw new Error(`Cannot cancel from status ${count.status}`)
  }
  return prisma.cycleCount.update({
    where: { id: args.id },
    data: {
      status: 'CANCELLED',
      cancelledAt: new Date(),
      cancelledReason: args.reason ?? null,
    },
  })
}
