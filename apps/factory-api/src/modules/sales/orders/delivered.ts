import { z } from 'zod'
import { businessDate as businessDateSchema, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { DELIVERED_VIAS } from '@nexus/factory-domain/shipping/pod/rules'
import { SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { dueDateOf } from '@nexus/factory-domain/sales/terms/terms'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { deliveredViaOf } from '../../shipping/pod/pod'
import { officeContextOf } from './access'
import { officeOrder } from './moves'
import { instalmentsOfOrder } from './schedule'
import { asDay, dayOrNull } from './store'

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
 *                from the shipment with shipping.view), the order's delivery time and the steps that run from it
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
  const arrived = await tx.shipment.findMany({ where: { salesOrderId: order.id, status: 'DELIVERED' }, select: { deliveredAt: true } })
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
      where: { salesOrderId: order.id, status: { in: ['SHIPPED', 'DELIVERED', 'RETURNED'] } },
      select: { id: true, number: true, status: true, siteId: true, partyId: true, companyId: true, carrierName: true, shippedAt: true, deliveredAt: true, podSignedBy: true, podAt: true, podFileId: true },
      orderBy: { number: 'asc' },
    })
    const rows = []
    for (const shipment of shipments) {
      const open = await db.trackingException.count({ where: { shipmentId: shipment.id, resolvedAt: null } })
      const pod = shipment.podSignedBy || shipment.podAt || shipment.podFileId ? { signedBy: shipment.podSignedBy, signedAt: iso(shipment.podAt), image: shipment.podFileId !== null } : null
      rows.push({
        id: shipment.id,
        number: shipment.number,
        status: shipment.status,
        carrierName: shipment.carrierName,
        shippedAt: iso(shipment.shippedAt),
        deliveredAt: iso(shipment.deliveredAt),
        deliveredVia: shipment.status === 'DELIVERED' ? await deliveredViaOf(db, shipment.id) : null,
        pod,
        openProblems: open,
        /** The reader may open the shipment and download its proof (shipping.view there). */
        mayOpen: can(actorOf(context), SHIPPING_VIEW, { companyId: shipment.companyId, siteId: shipment.siteId, partyId: shipment.partyId }),
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
          pod: output({ signedBy: z.string().nullable(), signedAt: instant().nullable(), image: z.boolean() }).nullable(),
          openProblems: z.number().int(),
          mayOpen: z.boolean(),
        }),
      ),
      steps: z.array(output({ id: id(), seq: z.number().int(), status: z.string(), dueDate: businessDateSchema().nullable() })),
    }),
  },
})
