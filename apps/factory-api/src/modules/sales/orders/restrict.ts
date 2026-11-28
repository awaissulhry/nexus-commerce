import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { ORDERS_MANAGE } from '@nexus/factory-domain/sales/orders/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { officeContextOf } from './access'
import { orderView } from './contract'
import { officeOrder, recordAfter } from './moves'
import { lockOrder } from './store'
import type { OrderView } from './views'

/**
 * owb-of1 step 4 (order workflow, plan.md § 5k "Restrict", R23: a Restricted order's baskets open on the floor only to a worker given
 * them by name; settle L6: Restrict = orders.manage, Sales and the Owner, no new permission): POST /sales/orders/:orderId/restrict
 * { version, restricted } — restricts the order on the floor, or opens it to its departments again. ONE command on the order: its
 * row locked at the version the caller read, `floorRestricted` with when and by whom (the last change; the order read says
 * `restricted: { by, at }` while it stands), one audit row `orders.restrict` and `sales_order.floor_restricted`. The floor lock that
 * reads it is S3's and S5's. The partner never reads the columns (the base's hiddenColumns). Asked as it already is: nothing is
 * written, the order is answered as it is.
 */

export const RESTRICT_ENDED_WORDS = Object.freeze({
  en: 'This order is closed or withdrawn: nothing is made for it any more, so there is nothing to restrict on the floor.',
  it: 'Questo ordine è chiuso o ritirato: non si produce più nulla, quindi non c’è niente da limitare in reparto.',
})

export const restrictOrderContract = defineContract({
  params: input({ orderId: id() }),
  body: input({ version: z.number().int().min(1), restricted: z.boolean() }),
  response: { 200: output({ order: orderView }) },
})

/** POST /sales/orders/:orderId/restrict (see the file's head). */
export async function restrictOrder(caller: CommandCaller, orderId: string, body: { readonly version: number; readonly restricted: boolean }, idempotencyKey?: string): Promise<{ order: OrderView }> {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  const now = await caller.withClient((client) => client.salesOrder.findUnique({ where: { id: order.id }, select: { floorRestricted: true } }))
  if (now?.floorRestricted === body.restricted) return { order: await recordAfter(caller, order.id) }
  await command(caller, { name: 'orders.restrict', idempotencyKey, input: { orderId: order.id, ...body } }, async (tools) => {
    const locked = await lockOrder(tools.tx, order.id, body.version)
    if (locked.status === 'CLOSED' || locked.status === 'CANCELLED') throw new InvalidStateError(RESTRICT_ENDED_WORDS.en)
    const before = await tools.tx.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { floorRestricted: true } })
    await tools.tx.salesOrder.update({
      where: { id: order.id },
      data: { floorRestricted: body.restricted, floorRestrictedAt: tools.now, floorRestrictedById: context.actorId, updatedAt: tools.now, version: { increment: 1 } },
      select: { id: true },
    })
    tools.audit({ action: 'orders.restrict', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, before: { floorRestricted: before.floorRestricted }, after: { floorRestricted: body.restricted } })
    tools.emit({ type: 'sales_order.floor_restricted', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, restricted: body.restricted, partyId: order.partyId } })
    return { orderId: order.id, restricted: body.restricted }
  })
  return { order: await recordAfter(caller, order.id) }
}
