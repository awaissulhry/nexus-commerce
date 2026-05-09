/**
 * SR.2 — Serial number tracking service.
 *
 * Public surface:
 *   createSerialInTx(tx, args)
 *     Inbound-receive helper. Inserts a SerialNumber row inside the
 *     caller's outer tx so the serial, its origin StockMovement, and
 *     the optional lot link all roll back together.
 *
 *   bulkCreateSerials(args)
 *     Convenience for receiving N units at once with sequential or
 *     scanned serials. Validates uniqueness up front so the transaction
 *     rolls back cleanly on collision.
 *
 *   reserveSerial(serialNumberId, args)
 *     AVAILABLE → RESERVED transition. Records currentOrderId/
 *     currentShipmentId so trace lookups light up the order on this
 *     unit.
 *
 *   shipSerial(serialNumberId, args)
 *     RESERVED|AVAILABLE → SHIPPED transition. Sets shippedAt.
 *
 *   returnSerial(serialNumberId, args)
 *     SHIPPED → RETURNED transition. Operator decides next:
 *     restoreSerial sends back to AVAILABLE; disposeSerial flags
 *     DISPOSED.
 *
 *   restoreSerial / disposeSerial
 *     RETURNED → AVAILABLE | DISPOSED.
 *
 *   traceSerial(serialNumberId)
 *     Full forward + backward chain — every movement that touched
 *     this unit, plus the originating receive movement.
 *
 * Recall integration: when a unit's lot has an OPEN recall, the FEFO
 * pickLotsForConsume already excludes that lot — so serials inherit
 * the same suppression without separate logic. Trace surfaces the
 * recall flag for visibility.
 */

import type { Prisma } from '@prisma/client'
import prisma from '../db.js'

type Tx = Prisma.TransactionClient

export type SerialStatus = 'AVAILABLE' | 'RESERVED' | 'SHIPPED' | 'RETURNED' | 'DISPOSED'

export interface CreateSerialArgs {
  productId: string
  variationId?: string | null
  serialNumber: string
  lotId?: string | null
  locationId?: string | null
  receivedAt?: Date
  manufacturerRef?: string | null
  notes?: string | null
}

export async function createSerialInTx(tx: Tx, args: CreateSerialArgs) {
  if (!args.serialNumber?.trim()) {
    throw new Error('createSerial: serialNumber is required')
  }
  return tx.serialNumber.create({
    data: {
      productId: args.productId,
      variationId: args.variationId ?? null,
      serialNumber: args.serialNumber.trim(),
      lotId: args.lotId ?? null,
      locationId: args.locationId ?? null,
      receivedAt: args.receivedAt ?? new Date(),
      manufacturerRef: args.manufacturerRef ?? null,
      notes: args.notes ?? null,
      status: 'AVAILABLE',
    },
  })
}

export async function createSerial(args: CreateSerialArgs) {
  return prisma.$transaction(async (tx) => createSerialInTx(tx, args))
}

export interface BulkCreateSerialsArgs {
  productId: string
  variationId?: string | null
  serialNumbers: string[]
  lotId?: string | null
  locationId?: string | null
  manufacturerRef?: string | null
}

export async function bulkCreateSerials(args: BulkCreateSerialsArgs) {
  const trimmed = args.serialNumbers.map((s) => s.trim()).filter(Boolean)
  if (trimmed.length === 0) {
    throw new Error('bulkCreateSerials: serialNumbers is empty')
  }
  // Up-front uniqueness check both within batch and against existing rows.
  const setSeen = new Set<string>()
  for (const s of trimmed) {
    if (setSeen.has(s)) {
      throw new Error(`bulkCreateSerials: duplicate within batch: ${s}`)
    }
    setSeen.add(s)
  }
  const existing = await prisma.serialNumber.findMany({
    where: { productId: args.productId, serialNumber: { in: trimmed } },
    select: { serialNumber: true },
  })
  if (existing.length > 0) {
    throw new Error(
      `bulkCreateSerials: already-exists for productId — ${existing.slice(0, 5).map((e) => e.serialNumber).join(', ')}` +
      (existing.length > 5 ? ` +${existing.length - 5} more` : ''),
    )
  }

  return prisma.$transaction(async (tx) => {
    const created = []
    for (const s of trimmed) {
      created.push(await createSerialInTx(tx, {
        productId: args.productId,
        variationId: args.variationId,
        serialNumber: s,
        lotId: args.lotId,
        locationId: args.locationId,
        manufacturerRef: args.manufacturerRef,
      }))
    }
    return { created }
  })
}

async function transitionStatus(
  serialNumberId: string,
  expected: SerialStatus[],
  next: SerialStatus,
  patch: Partial<Prisma.SerialNumberUpdateInput> = {},
) {
  const sn = await prisma.serialNumber.findUnique({ where: { id: serialNumberId } })
  if (!sn) throw new Error(`Serial ${serialNumberId} not found`)
  if (!expected.includes(sn.status as SerialStatus)) {
    throw new Error(`Serial ${sn.serialNumber} is ${sn.status} — cannot transition to ${next}`)
  }
  return prisma.serialNumber.update({
    where: { id: serialNumberId },
    data: { status: next, ...patch },
  })
}

export async function reserveSerial(
  serialNumberId: string,
  args: { orderId?: string | null; shipmentId?: string | null } = {},
) {
  return transitionStatus(serialNumberId, ['AVAILABLE'], 'RESERVED', {
    currentOrderId: args.orderId ?? null,
    currentShipmentId: args.shipmentId ?? null,
  })
}

export async function shipSerial(
  serialNumberId: string,
  args: { orderId?: string | null; shipmentId?: string | null } = {},
) {
  return transitionStatus(serialNumberId, ['AVAILABLE', 'RESERVED'], 'SHIPPED', {
    currentOrderId: args.orderId ?? null,
    currentShipmentId: args.shipmentId ?? null,
    shippedAt: new Date(),
  })
}

export async function returnSerial(
  serialNumberId: string,
  args: { returnId?: string | null } = {},
) {
  return transitionStatus(serialNumberId, ['SHIPPED'], 'RETURNED', {
    lastReturnId: args.returnId ?? null,
    returnedAt: new Date(),
  })
}

export async function restoreSerial(serialNumberId: string) {
  return transitionStatus(serialNumberId, ['RETURNED'], 'AVAILABLE', {
    currentOrderId: null,
    currentShipmentId: null,
  })
}

export async function disposeSerial(serialNumberId: string, args: { notes?: string | null } = {}) {
  return transitionStatus(serialNumberId, ['AVAILABLE', 'RETURNED'], 'DISPOSED', {
    disposedAt: new Date(),
    notes: args.notes ?? undefined,
  })
}

export async function traceSerial(serialNumberId: string) {
  const serial = await prisma.serialNumber.findUnique({
    where: { id: serialNumberId },
    include: {
      product: { select: { id: true, sku: true, name: true } },
      lot: {
        select: {
          id: true, lotNumber: true,
          recalls: { where: { status: 'OPEN' }, select: { id: true, reason: true } },
        },
      },
    },
  })
  if (!serial) return null

  const movements = await prisma.stockMovement.findMany({
    where: { serialNumberId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, createdAt: true, change: true, reason: true,
      orderId: true, shipmentId: true, returnId: true,
      actor: true, notes: true,
    },
  })

  return {
    serial,
    movements,
    lotRecalled: serial.lot ? serial.lot.recalls.length > 0 : false,
  }
}

/**
 * Find an AVAILABLE serial for the given product (FIFO by receivedAt).
 * Used by ship workflows that need to allocate a specific unit.
 */
export async function findNextAvailableSerial(args: {
  productId: string
  variationId?: string | null
  locationId?: string | null
}) {
  return prisma.serialNumber.findFirst({
    where: {
      productId: args.productId,
      ...(args.variationId !== undefined ? { variationId: args.variationId } : {}),
      ...(args.locationId !== undefined ? { locationId: args.locationId } : {}),
      status: 'AVAILABLE',
      // Inherit lot recall: skip serials whose lot has an OPEN recall.
      OR: [
        { lotId: null },
        { lot: { recalls: { none: { status: 'OPEN' } } } },
      ],
    },
    orderBy: { receivedAt: 'asc' },
  })
}
