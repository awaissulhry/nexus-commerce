/**
 * L.2 — Lot tracking service.
 *
 * Public surface:
 *   createLotInTx(tx, args)
 *     Inbound-receive helper. Inserts a Lot row inside the caller's
 *     outer transaction so the lot, its origin StockMovement, and any
 *     paired StockCostLayer all roll back together if anything fails.
 *
 *   traceLotForward(lotId)
 *     Returns every StockMovement where lotId matches — i.e. which
 *     orders / shipments / returns touched this manufacturing batch.
 *     Powers the recall workflow's "affected orders" report.
 *
 *   traceLotBackward(lotId)
 *     Returns the origin: receive movement, inbound shipment, PO.
 *     Powers "where did this batch come from" lookups when a supplier
 *     issues a recall and we need to know if we ever received it.
 *
 *   pickLotsForConsume(args)
 *     FEFO selection plan: returns (lotId, qty) pairs in
 *     expiresAt ASC, receivedAt ASC order until the requested quantity
 *     is covered. Caller can iterate the plan and call applyStockMovement
 *     per lot. Pure read; no DB writes.
 *
 *   decrementLotInTx(tx, lotId, qty)
 *     Drop unitsRemaining by qty inside the caller's tx. Throws if
 *     decrement would breach the unitsRemaining >= 0 CHECK or exceed
 *     the current remaining count.
 */

import type { Prisma } from '@prisma/client'
import prisma from '../db.js'

type Tx = Prisma.TransactionClient

export interface CreateLotArgs {
  productId: string
  variationId?: string | null
  lotNumber: string
  unitsReceived: number
  receivedAt?: Date
  expiresAt?: Date | null
  /** Backward-trace links. All optional; populate whichever is known
   *  at the receive site. */
  originPoId?: string | null
  originInboundShipmentId?: string | null
  originStockMovementId?: string | null
  supplierLotRef?: string | null
  notes?: string | null
}

export async function createLotInTx(tx: Tx, args: CreateLotArgs) {
  if (!args.lotNumber?.trim()) {
    throw new Error('createLot: lotNumber is required')
  }
  if (args.unitsReceived <= 0) {
    throw new Error('createLot: unitsReceived must be > 0')
  }
  return tx.lot.create({
    data: {
      productId: args.productId,
      variationId: args.variationId ?? null,
      lotNumber: args.lotNumber.trim(),
      unitsReceived: args.unitsReceived,
      unitsRemaining: args.unitsReceived,
      receivedAt: args.receivedAt ?? new Date(),
      expiresAt: args.expiresAt ?? null,
      originPoId: args.originPoId ?? null,
      originInboundShipmentId: args.originInboundShipmentId ?? null,
      originStockMovementId: args.originStockMovementId ?? null,
      supplierLotRef: args.supplierLotRef ?? null,
      notes: args.notes ?? null,
    },
  })
}

export async function createLot(args: CreateLotArgs) {
  return prisma.$transaction(async (tx) => createLotInTx(tx, args))
}

/**
 * Forward trace — every movement that touched this lot. Used by the
 * recall workflow to enumerate orders / shipments / returns.
 */
export async function traceLotForward(lotId: string) {
  const lot = await prisma.lot.findUnique({
    where: { id: lotId },
    include: {
      product: { select: { id: true, sku: true, name: true } },
      variation: { select: { id: true, sku: true } },
    },
  })
  if (!lot) return null

  const movements = await prisma.stockMovement.findMany({
    where: { lotId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, createdAt: true, change: true, balanceAfter: true,
      reason: true, referenceType: true, referenceId: true,
      orderId: true, shipmentId: true, returnId: true,
      locationId: true, actor: true, notes: true,
    },
  })

  // Group by reference for the affected-orders summary.
  const orderIds = Array.from(new Set(movements.map((m) => m.orderId).filter((x): x is string => !!x)))
  const shipmentIds = Array.from(new Set(movements.map((m) => m.shipmentId).filter((x): x is string => !!x)))
  const returnIds = Array.from(new Set(movements.map((m) => m.returnId).filter((x): x is string => !!x)))

  return { lot, movements, affected: { orderIds, shipmentIds, returnIds } }
}

/**
 * Backward trace — where did this lot come from. Returns the origin
 * StockMovement (the receive), the inbound shipment ref, and the PO ref.
 * Used when a supplier issues a recall and we need to confirm we received
 * the affected batch.
 */
export async function traceLotBackward(lotId: string) {
  const lot = await prisma.lot.findUnique({
    where: { id: lotId },
    include: {
      originMovement: {
        select: {
          id: true, createdAt: true, change: true, reason: true,
          referenceType: true, referenceId: true, actor: true, notes: true,
        },
      },
      product: { select: { id: true, sku: true, name: true } },
    },
  })
  if (!lot) return null
  return {
    lot,
    originReceiveMovement: lot.originMovement,
    originPoId: lot.originPoId,
    originInboundShipmentId: lot.originInboundShipmentId,
    supplierLotRef: lot.supplierLotRef,
  }
}

export interface PickLotsArgs {
  productId: string
  variationId?: string | null
  /** Quantity required from lots. Plan returns at most this many units;
   *  if total available < required, the plan is short and the caller
   *  must decide whether to allow non-lot stock to cover the rest. */
  quantity: number
}

export interface LotPickEntry {
  lotId: string
  lotNumber: string
  qty: number
  expiresAt: Date | null
  receivedAt: Date
}

export interface LotPickPlan {
  entries: LotPickEntry[]
  /** Sum of entries[].qty. <= requested quantity. */
  totalAllocated: number
  /** Requested quantity minus totalAllocated. Caller decides what to
   *  do with the remainder (allow non-lot consume, fail, etc). */
  shortfall: number
}

/**
 * FEFO pick plan — pure read. Picks lots in expiresAt ASC, receivedAt
 * ASC order until the requested quantity is covered or all lots with
 * remaining stock are consumed. Lots without expiresAt sort to the
 * end (treated as "never expire", picked only after dated lots).
 *
 * L.4 — lots with an OPEN recall are excluded so recalled units stop
 * being allocated as soon as the recall opens. They stay queryable for
 * the affected-orders report but never enter the consume plan.
 */
export async function pickLotsForConsume(args: PickLotsArgs): Promise<LotPickPlan> {
  const { productId, variationId, quantity } = args
  if (quantity <= 0) {
    return { entries: [], totalAllocated: 0, shortfall: 0 }
  }
  const available = await prisma.lot.findMany({
    where: {
      productId,
      ...(variationId !== undefined ? { variationId } : {}),
      unitsRemaining: { gt: 0 },
      // L.4 — exclude lots with any OPEN recall.
      recalls: { none: { status: 'OPEN' } },
    },
    orderBy: [
      // Postgres orders NULLs last by default for ASC, which matches
      // FEFO semantics: dated lots first, undated trailing.
      { expiresAt: 'asc' },
      { receivedAt: 'asc' },
    ],
    select: {
      id: true, lotNumber: true, unitsRemaining: true,
      expiresAt: true, receivedAt: true,
    },
  })

  const entries: LotPickEntry[] = []
  let remaining = quantity
  for (const lot of available) {
    if (remaining <= 0) break
    const take = Math.min(remaining, lot.unitsRemaining)
    entries.push({
      lotId: lot.id,
      lotNumber: lot.lotNumber,
      qty: take,
      expiresAt: lot.expiresAt,
      receivedAt: lot.receivedAt,
    })
    remaining -= take
  }
  const totalAllocated = entries.reduce((s, e) => s + e.qty, 0)
  return { entries, totalAllocated, shortfall: quantity - totalAllocated }
}

/**
 * Decrement a lot's unitsRemaining by qty. Caller passes the outer tx
 * so the decrement rolls back with the surrounding stock movement.
 *
 * Throws if:
 *   - lot not found
 *   - qty < 0
 *   - decrement would breach the DB CHECK (unitsRemaining >= 0)
 *
 * The CHECK is the safety net; this app-layer guard gives a clearer
 * error message at the call site.
 */
/**
 * L.4 — Open a recall on a lot. Idempotent: if an OPEN recall already
 * exists for this lot, returns it instead of creating a duplicate
 * (the partial unique index would reject the second insert anyway,
 * but we surface a clearer error to the caller).
 *
 * Side effect: subsequent FEFO consume picks skip this lot until the
 * recall is closed.
 */
export async function openRecall(args: {
  lotId: string
  reason: string
  openedBy?: string | null
  notes?: string | null
}) {
  if (!args.reason?.trim()) {
    throw new Error('openRecall: reason is required')
  }
  const existing = await prisma.lotRecall.findFirst({
    where: { lotId: args.lotId, status: 'OPEN' },
  })
  if (existing) {
    return { recall: existing, alreadyOpen: true as const }
  }
  const recall = await prisma.lotRecall.create({
    data: {
      lotId: args.lotId,
      reason: args.reason.trim(),
      status: 'OPEN',
      openedBy: args.openedBy ?? null,
      notes: args.notes ?? null,
    },
  })
  return { recall, alreadyOpen: false as const }
}

/**
 * L.4 — Close an open recall. Returns the updated row. Throws if the
 * recall doesn't exist or is already CLOSED.
 */
export async function closeRecall(args: {
  recallId: string
  closedBy?: string | null
  notes?: string | null
}) {
  const existing = await prisma.lotRecall.findUnique({
    where: { id: args.recallId },
  })
  if (!existing) throw new Error(`closeRecall: recall ${args.recallId} not found`)
  if (existing.status === 'CLOSED') {
    return { recall: existing, alreadyClosed: true as const }
  }
  const recall = await prisma.lotRecall.update({
    where: { id: args.recallId },
    data: {
      status: 'CLOSED',
      closedAt: new Date(),
      closedBy: args.closedBy ?? null,
      notes: args.notes ?? existing.notes,
    },
  })
  return { recall, alreadyClosed: false as const }
}

/**
 * L.4 — List recalls. Filter by status (default OPEN-only) so the
 * recall dashboard surface defaults to "what needs attention".
 */
export async function listRecalls(args: {
  status?: 'OPEN' | 'CLOSED' | 'ALL'
  productId?: string
  limit?: number
} = {}) {
  const status = args.status ?? 'OPEN'
  const limit = Math.min(500, Math.max(1, args.limit ?? 100))
  return prisma.lotRecall.findMany({
    where: {
      ...(status === 'ALL' ? {} : { status }),
      ...(args.productId ? { lot: { productId: args.productId } } : {}),
    },
    orderBy: [{ status: 'asc' }, { openedAt: 'desc' }],
    take: limit,
    include: {
      lot: {
        include: {
          product: { select: { id: true, sku: true, name: true } },
        },
      },
    },
  })
}

export async function decrementLotInTx(tx: Tx, lotId: string, qty: number) {
  if (qty <= 0) throw new Error('decrementLot: qty must be > 0')
  const lot = await tx.lot.findUnique({
    where: { id: lotId },
    select: { id: true, unitsRemaining: true, lotNumber: true },
  })
  if (!lot) throw new Error(`decrementLot: lot ${lotId} not found`)
  if (qty > lot.unitsRemaining) {
    throw new Error(
      `decrementLot: lot ${lot.lotNumber} (${lotId}) has ${lot.unitsRemaining} remaining, ` +
      `cannot decrement by ${qty}`,
    )
  }
  return tx.lot.update({
    where: { id: lotId },
    data: { unitsRemaining: lot.unitsRemaining - qty },
  })
}
