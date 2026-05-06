/**
 * H.2 (Inbound) — receiving service.
 *
 * Extracts the receive flow + adds the discrepancy / attachment / QC
 * release / state-machine surface. Routes delegate here so the same
 * logic is reachable from REST and from internal callers (cron, bulk
 * ops, future supplier portal).
 *
 * State machine (InboundStatus transitions):
 *
 *   DRAFT ───► SUBMITTED ───► IN_TRANSIT ───► ARRIVED ───► RECEIVING
 *      │           │              │              │            │
 *      │           │              │              │            ▼
 *      │           │              │              │     PARTIALLY_RECEIVED
 *      │           │              │              │            │
 *      │           │              │              │            ▼
 *      │           │              │              │       RECEIVED ──► RECONCILED ──► CLOSED
 *      ▼           ▼              ▼              ▼
 *      ─────────────── CANCELLED ────────────────
 *
 * Auto-transitions:
 *  - RECEIVING / PARTIALLY_RECEIVED → RECEIVED when every item has
 *    quantityReceived ≥ quantityExpected (after a receive batch).
 *  - RECEIVING / ARRIVED → PARTIALLY_RECEIVED when some items have
 *    quantityReceived > 0 but not all met (after a receive batch).
 *  - RECEIVED → RECONCILED when every discrepancy is RESOLVED, DISPUTED,
 *    or WAIVED.
 *
 * Manual transitions (for the operator):
 *  - DRAFT → SUBMITTED, CANCELLED
 *  - SUBMITTED → IN_TRANSIT, CANCELLED
 *  - IN_TRANSIT → ARRIVED, CANCELLED
 *  - ARRIVED → RECEIVING, CANCELLED
 *  - RECEIVED / RECONCILED → CLOSED
 *  - * (non-terminal) → CANCELLED
 *
 * Terminal: CLOSED, CANCELLED. No re-open.
 */

import prisma from '../db.js'
import type { InboundStatus, Prisma } from '@prisma/client'
import { applyStockMovement } from './stock-movement.service.js'

// ─── State machine ──────────────────────────────────────────────────

const ALLOWED_MANUAL_TRANSITIONS: Record<string, InboundStatus[]> = {
  DRAFT:               ['SUBMITTED', 'CANCELLED'],
  SUBMITTED:           ['IN_TRANSIT', 'DRAFT', 'CANCELLED'],
  IN_TRANSIT:          ['ARRIVED', 'CANCELLED'],
  ARRIVED:             ['RECEIVING', 'CANCELLED'],
  RECEIVING:           ['CANCELLED'],
  PARTIALLY_RECEIVED:  ['CANCELLED'],
  RECEIVED:            ['CLOSED', 'RECONCILED'],
  RECONCILED:          ['CLOSED'],
  CLOSED:              [],
  CANCELLED:           [],
}

export class InvalidTransitionError extends Error {
  constructor(public from: string, public to: string) {
    super(`Invalid transition: ${from} → ${to}`)
    this.name = 'InvalidTransitionError'
  }
}

export class NotFoundError extends Error {
  constructor(what: string, id: string) {
    super(`${what} not found: ${id}`)
    this.name = 'NotFoundError'
  }
}

// ─── Receive ────────────────────────────────────────────────────────

interface ReceiveItemInput {
  itemId: string
  quantityReceived: number
  qcStatus?: string
  qcNotes?: string
  idempotencyKey?: string
  notes?: string
  /** Append-only — pushed onto InboundShipmentItem.photoUrls */
  photoUrls?: string[]
}

interface ReceiveArgs {
  shipmentId: string
  items: ReceiveItemInput[]
  actor?: string
  receivedById?: string
}

export async function receiveItems(args: ReceiveArgs) {
  const { shipmentId, items, actor, receivedById } = args
  const shipment = await prisma.inboundShipment.findUnique({
    where: { id: shipmentId },
    include: { items: true },
  })
  if (!shipment) throw new NotFoundError('InboundShipment', shipmentId)

  const reasonMap: Record<string, any> = {
    SUPPLIER:      'SUPPLIER_DELIVERY',
    MANUFACTURING: 'MANUFACTURING_OUTPUT',
    FBA:           'FBA_TRANSFER_OUT',
    TRANSFER:      'INBOUND_RECEIVED',
  }
  const reason = reasonMap[shipment.type] ?? 'INBOUND_RECEIVED'
  const sign = shipment.type === 'FBA' ? -1 : 1

  for (const upd of items) {
    const orig = shipment.items.find((it) => it.id === upd.itemId)
    if (!orig) continue

    const target = Number(upd.quantityReceived)
    if (!Number.isFinite(target) || target < 0) continue
    const delta = target - orig.quantityReceived

    if (delta === 0) {
      // QC + photo append still allowed without stock churn.
      const data: Prisma.InboundShipmentItemUpdateInput = {}
      if (upd.qcStatus !== undefined) data.qcStatus = upd.qcStatus ?? null
      if (upd.qcNotes !== undefined) data.qcNotes = upd.qcNotes ?? null
      if (upd.photoUrls && upd.photoUrls.length > 0) {
        data.photoUrls = { push: upd.photoUrls }
      }
      if (Object.keys(data).length > 0) {
        await prisma.inboundShipmentItem.update({ where: { id: orig.id }, data })
      }
      continue
    }

    // Idempotency dedupe.
    if (upd.idempotencyKey) {
      const existing = await prisma.inboundReceipt.findFirst({
        where: { inboundShipmentItemId: orig.id, idempotencyKey: upd.idempotencyKey },
        select: { id: true },
      })
      if (existing) continue
    }

    // QC PASS or unset = stock; FAIL/HOLD = log event but no stock.
    let stockMovementId: string | null = null
    if ((!upd.qcStatus || upd.qcStatus === 'PASS') && orig.productId) {
      const mv = await applyStockMovement({
        productId: orig.productId,
        warehouseId: shipment.warehouseId ?? undefined,
        change: sign * delta,
        reason,
        referenceType: 'InboundShipment',
        referenceId: shipment.id,
        actor: actor ?? 'inbound-receive',
      })
      stockMovementId = mv.id
    }

    const itemUpdate: Prisma.InboundShipmentItemUpdateInput = {
      quantityReceived: target,
      qcStatus: upd.qcStatus ?? null,
      qcNotes: upd.qcNotes ?? null,
    }
    if (upd.photoUrls && upd.photoUrls.length > 0) {
      itemUpdate.photoUrls = { push: upd.photoUrls }
    }

    await prisma.$transaction([
      prisma.inboundReceipt.create({
        data: {
          inboundShipmentItemId: orig.id,
          quantity: delta,
          qcStatus: upd.qcStatus ?? null,
          qcNotes: upd.qcNotes ?? null,
          notes: upd.notes ?? null,
          idempotencyKey: upd.idempotencyKey ?? null,
          stockMovementId,
          receivedBy: actor ?? 'inbound-receive',
        },
      }),
      prisma.inboundShipmentItem.update({
        where: { id: orig.id },
        data: itemUpdate,
      }),
    ])
  }

  // Update shipment cursor + auto-transition status if appropriate.
  await prisma.inboundShipment.update({
    where: { id: shipmentId },
    data: {
      arrivedAt: shipment.arrivedAt ?? new Date(),
      receivedById: receivedById ?? shipment.receivedById,
      version: { increment: 1 },
    },
  })

  // PO propagation (H.0a)
  await syncPoState(shipmentId)

  // Auto-transition (RECEIVING → PARTIALLY_RECEIVED → RECEIVED → RECONCILED)
  await maybeAutoTransition(shipmentId)

  return prisma.inboundShipment.findUnique({
    where: { id: shipmentId },
    include: { items: true },
  })
}

// ─── PO propagation (H.0a moved here so receive paths share it) ────

async function syncPoState(shipmentId: string) {
  const items = await prisma.inboundShipmentItem.findMany({
    where: { inboundShipmentId: shipmentId, purchaseOrderItemId: { not: null } },
    select: { purchaseOrderItemId: true },
  })
  const poiIds = Array.from(new Set(items.map((it) => it.purchaseOrderItemId!).filter(Boolean)))
  if (poiIds.length === 0) return

  for (const poiId of poiIds) {
    const sum = await prisma.inboundShipmentItem.aggregate({
      where: { purchaseOrderItemId: poiId },
      _sum: { quantityReceived: true },
    })
    await prisma.purchaseOrderItem.update({
      where: { id: poiId },
      data: { quantityReceived: sum._sum.quantityReceived ?? 0 },
    })
  }
  const pois = await prisma.purchaseOrderItem.findMany({
    where: { id: { in: poiIds } },
    select: { purchaseOrderId: true },
  })
  const poIds = new Set(pois.map((p) => p.purchaseOrderId))
  const ORDER: Record<string, number> = { DRAFT: 0, SUBMITTED: 1, CONFIRMED: 2, PARTIAL: 3, RECEIVED: 4, CANCELLED: -1 }
  for (const poId of poIds) {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: poId },
      include: { items: { select: { quantityOrdered: true, quantityReceived: true } } },
    })
    if (!po || po.status === 'CANCELLED') continue
    let totalOrdered = 0, totalReceived = 0
    for (const it of po.items) {
      totalOrdered += it.quantityOrdered
      totalReceived += it.quantityReceived ?? 0
    }
    if (totalReceived === 0) continue
    const next: 'PARTIAL' | 'RECEIVED' = totalReceived >= totalOrdered ? 'RECEIVED' : 'PARTIAL'
    if (ORDER[next] <= ORDER[po.status]) continue
    await prisma.purchaseOrder.update({
      where: { id: poId },
      data: { status: next, version: { increment: 1 } },
    })
  }
}

// ─── Auto-status transitions ────────────────────────────────────────

const STATUS_ORDER: Record<string, number> = {
  DRAFT: 0, SUBMITTED: 1, IN_TRANSIT: 2, ARRIVED: 3,
  RECEIVING: 4, PARTIALLY_RECEIVED: 5, RECEIVED: 6,
  RECONCILED: 7, CLOSED: 8, CANCELLED: -1,
}

export async function maybeAutoTransition(shipmentId: string) {
  const ship = await prisma.inboundShipment.findUnique({
    where: { id: shipmentId },
    include: {
      items: { select: { quantityExpected: true, quantityReceived: true } },
      discrepancies: { select: { status: true } },
    },
  })
  if (!ship) return
  if (ship.status === 'CLOSED' || ship.status === 'CANCELLED') return

  const totalReceived = ship.items.reduce((a, it) => a + it.quantityReceived, 0)
  const allMet = ship.items.length > 0 && ship.items.every((it) => it.quantityReceived >= it.quantityExpected)
  const openDiscrepancies = ship.discrepancies.some(
    (d) => d.status === 'REPORTED' || d.status === 'ACKNOWLEDGED',
  )

  // Target status by rules. Discrepancies-closed RECONCILED only
  // applies when there's at least one discrepancy on file (otherwise
  // RECONCILED is meaningless and we stop at RECEIVED).
  let next: InboundStatus | null = null
  if (allMet) {
    next = openDiscrepancies || ship.discrepancies.length === 0 ? 'RECEIVED' : 'RECONCILED'
  } else if (totalReceived > 0) {
    next = 'PARTIALLY_RECEIVED'
  }

  if (!next || next === ship.status) return
  // No-downgrade.
  if (STATUS_ORDER[next] <= STATUS_ORDER[ship.status]) return

  await prisma.inboundShipment.update({
    where: { id: shipmentId },
    data: { status: next, version: { increment: 1 } },
  })
}

// ─── Manual transitions ─────────────────────────────────────────────

export async function transitionShipmentStatus(args: {
  shipmentId: string
  newStatus: InboundStatus
  actor?: string
}) {
  const ship = await prisma.inboundShipment.findUnique({
    where: { id: args.shipmentId },
    select: { id: true, status: true },
  })
  if (!ship) throw new NotFoundError('InboundShipment', args.shipmentId)

  const allowed = ALLOWED_MANUAL_TRANSITIONS[ship.status] ?? []
  if (!allowed.includes(args.newStatus)) {
    throw new InvalidTransitionError(ship.status, args.newStatus)
  }

  const data: Prisma.InboundShipmentUpdateInput = {
    status: args.newStatus,
    version: { increment: 1 },
  }
  if (args.newStatus === 'CLOSED') data.closedAt = new Date()

  return prisma.inboundShipment.update({ where: { id: args.shipmentId }, data })
}

// ─── QC HOLD release ────────────────────────────────────────────────

export async function releaseQcHold(args: {
  shipmentId: string
  itemId: string
  quantity?: number
  actor?: string
}) {
  const item = await prisma.inboundShipmentItem.findUnique({
    where: { id: args.itemId },
    include: { inboundShipment: true },
  })
  if (!item) throw new NotFoundError('InboundShipmentItem', args.itemId)
  if (item.inboundShipmentId !== args.shipmentId) {
    throw new Error('Item does not belong to this shipment')
  }
  if (item.qcStatus !== 'HOLD' && item.qcStatus !== 'FAIL') {
    throw new Error(`Cannot release QC: item.qcStatus = ${item.qcStatus}`)
  }
  if (!item.productId) {
    throw new Error('Cannot release QC: item has no productId')
  }

  // Determine release quantity. Default to full quantityReceived (the
  // entire HELD batch). For FAIL releases, operator must pass an explicit
  // partial quantity (rest stays excluded).
  const release = Number.isFinite(Number(args.quantity)) && Number(args.quantity) > 0
    ? Math.min(Number(args.quantity), item.quantityReceived)
    : item.quantityReceived
  if (release <= 0) throw new Error('Nothing to release')

  const sign = item.inboundShipment.type === 'FBA' ? -1 : 1
  const reason: any = item.inboundShipment.type === 'FBA' ? 'FBA_TRANSFER_OUT' :
                      item.inboundShipment.type === 'MANUFACTURING' ? 'MANUFACTURING_OUTPUT' :
                      'INBOUND_RECEIVED'

  const mv = await applyStockMovement({
    productId: item.productId,
    warehouseId: item.inboundShipment.warehouseId ?? undefined,
    change: sign * release,
    reason,
    referenceType: 'InboundShipment',
    referenceId: item.inboundShipmentId,
    actor: args.actor ?? 'inbound-qc-release',
    notes: `QC release: ${release} units from ${item.qcStatus} hold`,
  })

  // The StockMovement audit row carries the QC release record. We
  // intentionally do NOT write a fresh InboundReceipt event here —
  // the original receive already logged quantity=delta with
  // qcStatus=HOLD/FAIL, and writing another would inflate
  // SUM(receipts.quantity) past the cached InboundShipmentItem.
  // quantityReceived. The release is provable via the StockMovement
  // referenceId = inboundShipmentId + reason + notes.

  // Update the item's QC state to PASS (full release) or keep tracked
  // as partial via qcNotes.
  if (release === item.quantityReceived) {
    await prisma.inboundShipmentItem.update({
      where: { id: item.id },
      data: {
        qcStatus: 'PASS',
        qcNotes: `Released ${release} units from ${item.qcStatus} hold via QC release`,
      },
    })
  } else {
    await prisma.inboundShipmentItem.update({
      where: { id: item.id },
      data: {
        qcNotes: `Partial release: ${release} of ${item.quantityReceived} (remainder stays ${item.qcStatus})`,
      },
    })
  }

  await maybeAutoTransition(args.shipmentId)
  return mv
}

// ─── Discrepancy CRUD ───────────────────────────────────────────────

export async function recordDiscrepancy(args: {
  shipmentId: string
  itemId?: string
  reasonCode: string
  expectedValue?: string
  actualValue?: string
  quantityImpact?: number
  costImpactCents?: number
  description?: string
  photoUrls?: string[]
  reportedBy?: string
}) {
  const ship = await prisma.inboundShipment.findUnique({
    where: { id: args.shipmentId },
    select: { id: true },
  })
  if (!ship) throw new NotFoundError('InboundShipment', args.shipmentId)
  if (args.itemId) {
    const item = await prisma.inboundShipmentItem.findUnique({
      where: { id: args.itemId },
      select: { inboundShipmentId: true },
    })
    if (!item) throw new NotFoundError('InboundShipmentItem', args.itemId)
    if (item.inboundShipmentId !== args.shipmentId) {
      throw new Error('Item does not belong to this shipment')
    }
  }

  return prisma.inboundDiscrepancy.create({
    data: {
      inboundShipmentId: args.shipmentId,
      inboundShipmentItemId: args.itemId ?? null,
      reasonCode: args.reasonCode,
      expectedValue: args.expectedValue ?? null,
      actualValue: args.actualValue ?? null,
      quantityImpact: args.quantityImpact ?? null,
      costImpactCents: args.costImpactCents ?? null,
      description: args.description ?? null,
      photoUrls: args.photoUrls ?? [],
      reportedBy: args.reportedBy ?? null,
    },
  })
}

export async function updateDiscrepancyStatus(args: {
  discrepancyId: string
  status: 'REPORTED' | 'ACKNOWLEDGED' | 'RESOLVED' | 'DISPUTED' | 'WAIVED'
  resolutionNotes?: string
  actor?: string
}) {
  const d = await prisma.inboundDiscrepancy.findUnique({
    where: { id: args.discrepancyId },
    select: { id: true, inboundShipmentId: true, status: true },
  })
  if (!d) throw new NotFoundError('InboundDiscrepancy', args.discrepancyId)

  const now = new Date()
  const data: Prisma.InboundDiscrepancyUpdateInput = { status: args.status }
  if (args.status === 'ACKNOWLEDGED' && !d.status) data.acknowledgedAt = now
  if (args.status === 'ACKNOWLEDGED') data.acknowledgedAt = now
  if (args.status === 'RESOLVED' || args.status === 'DISPUTED' || args.status === 'WAIVED') {
    data.resolvedAt = now
    if (args.resolutionNotes) data.resolutionNotes = args.resolutionNotes
  }

  const updated = await prisma.inboundDiscrepancy.update({
    where: { id: args.discrepancyId },
    data,
  })

  await maybeAutoTransition(d.inboundShipmentId)
  return updated
}

// ─── Attachments ────────────────────────────────────────────────────

export async function addAttachment(args: {
  shipmentId: string
  kind: string
  url: string
  filename?: string
  contentType?: string
  sizeBytes?: number
  uploadedBy?: string
}) {
  const ship = await prisma.inboundShipment.findUnique({
    where: { id: args.shipmentId },
    select: { id: true },
  })
  if (!ship) throw new NotFoundError('InboundShipment', args.shipmentId)

  return prisma.inboundShipmentAttachment.create({
    data: {
      inboundShipmentId: args.shipmentId,
      kind: args.kind,
      url: args.url,
      filename: args.filename ?? null,
      contentType: args.contentType ?? null,
      sizeBytes: args.sizeBytes ?? null,
      uploadedBy: args.uploadedBy ?? null,
    },
  })
}

export async function appendItemPhoto(args: {
  shipmentItemId: string
  url: string
}) {
  const item = await prisma.inboundShipmentItem.findUnique({
    where: { id: args.shipmentItemId },
    select: { id: true },
  })
  if (!item) throw new NotFoundError('InboundShipmentItem', args.shipmentItemId)

  return prisma.inboundShipmentItem.update({
    where: { id: args.shipmentItemId },
    data: { photoUrls: { push: args.url } },
    select: { id: true, photoUrls: true },
  })
}
