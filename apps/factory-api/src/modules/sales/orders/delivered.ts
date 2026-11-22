import { z } from 'zod'
import type { FactoryClient } from '@nexus/factory-db' // B-OS-003
import { businessDate as businessDateSchema, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { DELIVERED_VIAS } from '@nexus/factory-domain/shipping/pod/rules'
// B-OS-003 (order shipments tab): how each journey ended, by hand or by the carrier, and what came back (one rule, pure).
import { deliveryWayOf, type EndEvent } from '@nexus/factory-domain/shipping/pod/rules'
import { isTestLabel } from '@nexus/factory-domain/shipping/test-mode/rules'
import { SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { FILES_READ } from '@nexus/factory-domain/auth/permissions/catalogue' // B-SA-0xxb / F-SA-266b
import { dueDateOf } from '@nexus/factory-domain/sales/terms/terms'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { officeContextOf } from './access'
import { officeOrder } from './moves'
import { instalmentsOfOrder } from './schedule'
import { asDay, dayOrNull } from './store'
// B-OP-043 (order page N6, lines-derived): an order's shipments through their lines.
import { shipmentsOfOrderWhere } from '../../shipping/shipments/orders-of'

/**
 * Delivered moves the order (B-W2b-398; LOG-067 "Delivered status driving terms"; design sales.orders record › Shipments,
 * "Delivered (W2b, from carrier)"). factory-domain's salesOrderMachine moves a SHIPPED order to DELIVERED (the system, from
 * followMoves, the fact from store.ts moveFactsOf) once every shipment that left arrived: at least one DELIVERED, none
 * still travelling (SHIPPED) — the …_delivery_customs_w2b_guards trigger asks the same, sets deliveredAt only in that move
 * and never changes it.
 *
 *   the move     moves.ts followOrder (shipment.status_changed → DELIVERED, the worker): `deliveredMoveInCommand` gives the
 *                order's delivery time — the last shipment's arrival as the carrier said it, never in the future — and the
 *                terms that run from delivery start: each OPEN "on delivery" step of the payment schedule (ON_DELIVERY,
 *                no day yet) gets its due day, the delivery day plus its instalment's days (and the month's end when the
 *                terms say so: sales/terms dueDateOf), in the order the terms list them; those steps fall due with the
 *                goods' invoice, which reads the order's deliveredAt for anything counted from delivery
 *   the read     GET /sales/orders/:orderId/deliveries (orders.view): each shipment's arrival, how it came (the carrier's
 *                tracking or a status typed by a person), its proof of delivery (who signed, when, an image: downloaded
 *                from the shipment with shipping.view; B-SA-0xxb: its file id with files.read on the shipment, for the
 *                thread's ONE viewer), the order's delivery time and the steps that run from it
 */

export interface DeliveredMove {
  readonly deliveredAt: Date
  /** The "on delivery" steps that got their due day. */
  readonly steps: readonly { readonly id: string; readonly seq: number; readonly dueDate: BusinessDate }[]
}

/**
 * Inside the order's follow command (its row locked): the order's delivery time and the due days of its OPEN on-delivery
 * steps that have none (each written, with an audit row on the order). Call it in the move SHIPPED → DELIVERED.
 */
export async function deliveredMoveInCommand(tools: CommandTools, order: { readonly id: string; readonly companyId: string; readonly paymentTermsId: string | null }): Promise<DeliveredMove> {
  const { tx, now } = tools
  // B-OP-043 (order page N6): the order's shipments made for it or carrying its garments (factory_order_shipments' set).
  const arrived = await tx.shipment.findMany({ where: { ...shipmentsOfOrderWhere(order.id), status: 'DELIVERED' }, select: { deliveredAt: true } })
  const last = Math.max(0, ...arrived.map((row) => row.deliveredAt?.getTime() ?? 0))
  const deliveredAt = last > 0 && last <= now.getTime() ? new Date(last) : now
  const day = businessDate(deliveredAt)
  const open = await tx.salesOrderMilestone.findMany({ where: { orderId: order.id, kind: 'ON_DELIVERY', status: 'OPEN' }, select: { id: true, seq: true, dueDate: true }, orderBy: { seq: 'asc' } })
  const onDelivery = ((await instalmentsOfOrder(tx, order.paymentTermsId)) ?? []).filter((item) => item.from === 'DELIVERY')
  const steps: { id: string; seq: number; dueDate: BusinessDate }[] = []
  for (const [index, step] of open.entries()) {
    if (step.dueDate !== null) continue
    const item = onDelivery[index]
    const dueDate = item ? dueDateOf(day, item) : day
    await tx.salesOrderMilestone.update({ where: { id: step.id }, data: { dueDate: asDay(dueDate), updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    steps.push({ id: step.id, seq: step.seq, dueDate })
  }
  if (steps.length > 0) {
    tools.audit({ action: 'orders.deliveryTerms', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, after: { deliveredAt: toUtcIso(deliveredAt), steps: steps.map(({ seq, dueDate }) => ({ seq, dueDate })) } })
  }
  return { deliveredAt, steps }
}

const iso = (date: Date | null): string | null => (date === null ? null : toUtcIso(date))

/** GET /sales/orders/:orderId/deliveries (orders.view). */
export async function getDeliveries(caller: CommandCaller, orderId: string) {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId)
  return caller.withClient(async (db) => {
    const head = await db.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { id: true, number: true, status: true, deliveredAt: true } })
    const shipments = await db.shipment.findMany({
      // B-OP-043: made for it or carrying its garments.
      where: { ...shipmentsOfOrderWhere(order.id), status: { in: ['SHIPPED', 'DELIVERED', 'RETURNED'] } },
      select: { id: true, number: true, status: true, siteId: true, partyId: true, companyId: true, carrierName: true, shippedAt: true, deliveredAt: true, podSignedBy: true, podAt: true, podFileId: true, /* B-OS-003 */ transportBy: true, returnedAt: true, carrierReturnReceivedAt: true, expectedDeliveryAt: true },
      orderBy: { number: 'asc' },
    })
    const facts = await deliveryFactsOf(db, shipments) // B-OS-003: one read per kind, for every shipment at once (H3-B9)
    // ---- B-SA-0xxb / F-SA-266b: the proof's file itself (its id, name and type), for a reader who may read the shipment's files
    // (files.read over the shipment's company, site and customer): the order page opens it in the thread's ONE viewer, not a download.
    const actor = actorOf(context)
    const podIds = shipments.flatMap((shipment) => (shipment.podFileId && can(actor, FILES_READ, { companyId: shipment.companyId, siteId: shipment.siteId, partyId: shipment.partyId }) ? [shipment.podFileId] : []))
    const podFiles = new Map((podIds.length > 0 ? await db.storedFile.findMany({ where: { id: { in: podIds }, recordType: 'Shipment', status: 'AVAILABLE' }, select: { id: true, recordId: true, originalName: true, contentType: true, sizeBytes: true } }) : []).map((file) => [file.id, file]))
    const podFileOf = (shipment: { readonly id: string; readonly podFileId: string | null }) => {
      const file = shipment.podFileId ? podFiles.get(shipment.podFileId) : undefined
      return file && file.recordId === shipment.id ? { id: file.id, name: file.originalName, contentType: file.contentType, sizeBytes: Number(file.sizeBytes) } : null
    }
    // ---- end B-SA-0xxb
    const rows = []
    for (const shipment of shipments) {
      const pod = shipment.podSignedBy || shipment.podAt || shipment.podFileId ? { signedBy: shipment.podSignedBy, signedAt: iso(shipment.podAt), image: shipment.podFileId !== null, file: podFileOf(shipment) /* B-SA-0xxb */ } : null
      // B-OS-003: how it came (the carrier, typed, collected), by hand with its words, what the carrier said later.
      const way = deliveryWayOf({ status: shipment.status, transportBy: shipment.transportBy, carrierLabelled: facts.labelled.has(shipment.id), events: facts.events.get(shipment.id) ?? [] })
      rows.push({
        id: shipment.id,
        number: shipment.number,
        status: shipment.status,
        carrierName: shipment.carrierName,
        shippedAt: iso(shipment.shippedAt),
        deliveredAt: iso(shipment.deliveredAt),
        deliveredVia: way.deliveredVia,
        pod,
        openProblems: facts.problems.get(shipment.id) ?? 0,
        /** The reader may open the shipment and download its proof (shipping.view there). */
        mayOpen: can(actor, SHIPPING_VIEW, { companyId: shipment.companyId, siteId: shipment.siteId, partyId: shipment.partyId }),
        // ── B-OS-003 ──
        byHand: way.byHand,
        carrierLater: way.carrierLater,
        returned: shipment.status === 'RETURNED' ? { at: iso(shipment.returnedAt), received: shipment.carrierReturnReceivedAt !== null } : null,
        expectedDeliveryAt: iso(shipment.expectedDeliveryAt),
        etaByHand: shipment.expectedDeliveryAt !== null && facts.typedEtas.get(shipment.id) === shipment.expectedDeliveryAt.getTime(),
        // ── end B-OS-003 ──
      })
    }
    const steps = await db.salesOrderMilestone.findMany({ where: { orderId: order.id, kind: 'ON_DELIVERY' }, select: { id: true, seq: true, status: true, dueDate: true }, orderBy: { seq: 'asc' } })
    return {
      order: { id: head.id, number: head.number, status: head.status, deliveredAt: iso(head.deliveredAt) },
      shipments: rows,
      steps: steps.map((step) => ({ id: step.id, seq: step.seq, status: step.status, dueDate: dayOrNull(step.dueDate) })),
    }
  })
}

// ── B-OS-003 (order shipments tab; H3-B1, H3-B9, O6; 13-backend §1) ──
interface DeliveryFacts {
  /** Each shipment's DELIVERED and RETURNED events. */
  readonly events: ReadonlyMap<string, EndEvent[]>
  /** The shipments whose parcels carry a carrier's label (a TEST label is not one). */
  readonly labelled: ReadonlySet<string>
  /** Each shipment's open tracking problems. */
  readonly problems: ReadonlyMap<string, number>
  /** The expected arrival last typed by a person (B-OS-016's shipping.etaTyped audit row), as a time. */
  readonly typedEtas: ReadonlyMap<string, number>
}

/** What the deliveries read needs of every shipment, one read per kind (never a query per shipment). */
async function deliveryFactsOf(db: FactoryClient, shipments: readonly { readonly id: string }[]): Promise<DeliveryFacts> {
  const ids = shipments.map((shipment) => shipment.id)
  if (ids.length === 0) return { events: new Map(), labelled: new Set(), problems: new Map(), typedEtas: new Map() }
  const ends = await db.trackingEvent.findMany({ where: { shipmentId: { in: ids }, status: { in: ['DELIVERED', 'RETURNED'] } }, select: { id: true, shipmentId: true, status: true, source: true, description: true, recordedAt: true }, orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }] })
  const events = new Map<string, EndEvent[]>()
  for (const { shipmentId, ...event } of ends) events.set(shipmentId, [...(events.get(shipmentId) ?? []), event])
  const parcels = await db.parcel.findMany({ where: { shipmentId: { in: ids }, OR: [{ trackingNumber: { not: null } }, { carrierParcelId: { not: null } }] }, select: { shipmentId: true, carrierParcelId: true } })
  const labelled = new Set(parcels.filter((parcel) => !isTestLabel(parcel.carrierParcelId)).map((parcel) => parcel.shipmentId))
  const open = await db.trackingException.groupBy({ by: ['shipmentId'], where: { shipmentId: { in: ids }, resolvedAt: null }, _count: { _all: true } })
  const problems = new Map(open.map((row) => [row.shipmentId, row._count._all]))
  const typed = await db.auditLog.findMany({ where: { recordType: 'Shipment', recordId: { in: ids }, action: 'shipping.etaTyped' }, select: { recordId: true, after: true }, orderBy: [{ at: 'desc' }, { id: 'desc' }] })
  const typedEtas = new Map<string, number>()
  for (const row of typed) {
    if (typedEtas.has(row.recordId)) continue
    const after = row.after !== null && typeof row.after === 'object' && !Array.isArray(row.after) ? (row.after as Record<string, unknown>) : {}
    const time = typeof after.expectedDeliveryAt === 'string' ? Date.parse(after.expectedDeliveryAt) : Number.NaN
    typedEtas.set(row.recordId, time)
  }
  return { events, labelled, problems, typedEtas }
}
// ── end B-OS-003 ──

/** GET /sales/orders/:orderId/deliveries: codes and times only (no money); the signer is the customer's person. */
export const deliveriesContract = defineContract({
  params: input({ orderId: id() }),
  response: {
    200: output({
      order: output({ id: id(), number: z.string(), status: z.string(), deliveredAt: instant().nullable() }),
      shipments: z.array(
        output({
          id: id(),
          number: z.string(),
          status: z.string(),
          carrierName: z.string().nullable(),
          shippedAt: instant().nullable(),
          deliveredAt: instant().nullable(),
          deliveredVia: z.enum(DELIVERED_VIAS).nullable(),
          // B-SA-0xxb / F-SA-266b: `file` — the proof's own file for a reader with files.read on the shipment (null: none, or not this reader's).
          pod: output({ signedBy: z.string().nullable(), signedAt: instant().nullable(), image: z.boolean(), file: output({ id: id(), name: z.string(), contentType: z.string(), sizeBytes: z.number().int() }).nullable() }).nullable(),
          openProblems: z.number().int(),
          mayOpen: z.boolean(),
          // ── B-OS-003 (order shipments tab; 13-backend §1): `deliveredVia` COLLECTED when the customer's own carrier collected it ──
          /** Moved to DELIVERED or RETURNED by a person: the words typed with it, and whether it overrode a carrier's labels; null otherwise. */
          byHand: output({ reason: z.string().nullable(), overrode: z.boolean() }).nullable(),
          /** Moved by hand, then the carrier reported later: what it said last ("the carrier later said…"); null otherwise. */
          carrierLater: z.enum(['DELIVERED', 'RETURNED']).nullable(),
          /** Came back: when, and whether its garments were received back into stock; null when it did not come back. */
          returned: output({ at: instant().nullable(), received: z.boolean() }).nullable(),
          expectedDeliveryAt: instant().nullable(),
          /** The expected arrival was typed by a person (no carrier feed tracks it). */
          etaByHand: z.boolean(),
          // ── end B-OS-003 ──
        }),
      ),
      steps: z.array(output({ id: id(), seq: z.number().int(), status: z.string(), dueDate: businessDateSchema().nullable() })),
    }),
  },
})
