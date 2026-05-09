/**
 * BN.2 — Bin management service.
 *
 * Public surface:
 *   createBin / updateBin / deactivateBin
 *   listBinsForLocation(locationId, { activeOnly? })
 *   moveStockBetweenBins(args)
 *     Atomic transfer of N units between two bins WITHIN the same
 *     StockLocation. StockLevel total unchanged; only the per-bin
 *     ledger shifts. Records a StockMovement with binId set so the
 *     audit trail captures the move.
 *
 *   reconcileStockLevelBins(stockLevelId)
 *     Health helper: verifies sum(binQuantities) == stockLevel.quantity.
 *     Returns { match: boolean, sumOfBins, stockLevelTotal, drift }.
 */

import type { Prisma } from '@prisma/client'
import prisma from '../db.js'

type Tx = Prisma.TransactionClient

export async function createBin(args: {
  locationId: string
  code: string
  name?: string | null
  zone?: string | null
  binType?: string | null
  capacity?: number | null
}) {
  if (!args.code?.trim()) throw new Error('createBin: code is required')
  return prisma.stockBin.create({
    data: {
      locationId: args.locationId,
      code: args.code.trim(),
      name: args.name ?? null,
      zone: args.zone ?? null,
      binType: args.binType ?? null,
      capacity: args.capacity ?? null,
    },
  })
}

export async function updateBin(id: string, patch: {
  name?: string | null
  zone?: string | null
  binType?: string | null
  capacity?: number | null
}) {
  return prisma.stockBin.update({
    where: { id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.zone !== undefined ? { zone: patch.zone } : {}),
      ...(patch.binType !== undefined ? { binType: patch.binType } : {}),
      ...(patch.capacity !== undefined ? { capacity: patch.capacity } : {}),
    },
  })
}

export async function deactivateBin(id: string) {
  // Don't allow deactivating a bin that still has stock; force the
  // operator to move it first.
  const totals = await prisma.stockBinQuantity.aggregate({
    where: { binId: id },
    _sum: { quantity: true },
  })
  if ((totals._sum.quantity ?? 0) > 0) {
    throw new Error('deactivateBin: bin still holds stock — move it first')
  }
  return prisma.stockBin.update({
    where: { id },
    data: { isActive: false },
  })
}

export async function listBinsForLocation(
  locationId: string,
  args: { activeOnly?: boolean } = {},
) {
  return prisma.stockBin.findMany({
    where: {
      locationId,
      ...(args.activeOnly !== false ? { isActive: true } : {}),
    },
    orderBy: [{ zone: 'asc' }, { code: 'asc' }],
    include: {
      _count: { select: { quantities: true } },
    },
  })
}

/**
 * Atomic bin-to-bin transfer within the same StockLocation. The total
 * StockLevel doesn't change; only the per-bin ledger shifts. Records
 * a single StockMovement (reason BIN_TRANSFER) for the audit trail.
 */
export async function moveStockBetweenBins(args: {
  productId: string
  variationId?: string | null
  fromBinId: string
  toBinId: string
  quantity: number
  actor?: string | null
  notes?: string | null
}) {
  if (args.quantity <= 0) throw new Error('moveStockBetweenBins: quantity must be > 0')
  if (args.fromBinId === args.toBinId) {
    throw new Error('moveStockBetweenBins: from and to bins must differ')
  }
  const [fromBin, toBin] = await Promise.all([
    prisma.stockBin.findUnique({ where: { id: args.fromBinId } }),
    prisma.stockBin.findUnique({ where: { id: args.toBinId } }),
  ])
  if (!fromBin || !toBin) throw new Error('moveStockBetweenBins: bin not found')
  if (fromBin.locationId !== toBin.locationId) {
    throw new Error('moveStockBetweenBins: bins must be in the same StockLocation')
  }

  return prisma.$transaction(async (tx) => {
    const sl = await tx.stockLevel.findFirst({
      where: {
        productId: args.productId,
        variationId: args.variationId ?? null,
        locationId: fromBin.locationId,
      },
    })
    if (!sl) throw new Error('moveStockBetweenBins: no StockLevel for this product at the bins\' location')

    const fromQty = await tx.stockBinQuantity.findUnique({
      where: { stockLevelId_binId: { stockLevelId: sl.id, binId: args.fromBinId } },
    })
    if (!fromQty || fromQty.quantity < args.quantity) {
      throw new Error(`moveStockBetweenBins: source bin has ${fromQty?.quantity ?? 0} units, asked for ${args.quantity}`)
    }

    await tx.stockBinQuantity.update({
      where: { id: fromQty.id },
      data: { quantity: fromQty.quantity - args.quantity, lastUpdatedAt: new Date() },
    })

    const existingTo = await tx.stockBinQuantity.findUnique({
      where: { stockLevelId_binId: { stockLevelId: sl.id, binId: args.toBinId } },
    })
    if (existingTo) {
      await tx.stockBinQuantity.update({
        where: { id: existingTo.id },
        data: { quantity: existingTo.quantity + args.quantity, lastUpdatedAt: new Date() },
      })
    } else {
      await tx.stockBinQuantity.create({
        data: { stockLevelId: sl.id, binId: args.toBinId, quantity: args.quantity },
      })
    }

    // Audit movement (zero-net change at StockLevel grain).
    return tx.stockMovement.create({
      data: {
        productId: args.productId,
        variationId: args.variationId ?? null,
        locationId: sl.locationId,
        fromLocationId: sl.locationId,
        toLocationId: sl.locationId,
        change: 0,
        balanceAfter: sl.quantity,
        quantityBefore: sl.quantity,
        reason: 'TRANSFER_OUT', // bin transfer reuses TRANSFER_OUT for now
        referenceType: 'BinTransfer',
        notes: args.notes ?? `Bin transfer ${fromBin.code} → ${toBin.code} (${args.quantity}u)`,
        actor: args.actor ?? null,
        binId: args.toBinId,
      },
    })
  })
}

/**
 * Health helper: sum(binQuantities) for a StockLevel must equal
 * stockLevel.quantity. Drift indicates a missed bin write somewhere.
 */
export async function reconcileStockLevelBins(stockLevelId: string) {
  const sl = await prisma.stockLevel.findUnique({
    where: { id: stockLevelId },
    select: { quantity: true },
  })
  if (!sl) throw new Error('reconcileStockLevelBins: stockLevel not found')
  const sum = await prisma.stockBinQuantity.aggregate({
    where: { stockLevelId },
    _sum: { quantity: true },
  })
  const sumOfBins = sum._sum.quantity ?? 0
  return {
    stockLevelTotal: sl.quantity,
    sumOfBins,
    drift: sl.quantity - sumOfBins,
    // When drift !== 0, sumOfBins typically lags because not every
    // movement has a binId. Bins are an *optional* sub-grain; the
    // invariant we enforce in the health script is "if any bin
    // quantity exists for a StockLevel, the sum must match".
    match: sumOfBins === 0 || sumOfBins === sl.quantity,
  }
}
