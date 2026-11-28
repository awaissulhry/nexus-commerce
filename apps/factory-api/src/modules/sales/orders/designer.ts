import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { ORDERS_MANAGE } from '@nexus/factory-domain/sales/orders/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { assertSees, officeContextOf } from './access'
import { putPeopleOnOrder } from './people-writer'

/**
 * owb-of1 (order workflow, plan.md § 5f "Give the graphics to the designer"; lead S2 ask 2026-11-28 for web A's bulk act):
 * POST /sales/orders/designer { orderIds (1–100 orders), userId (an active office person) } → { added } — puts one person (the
 * designer) on each order through the ONE people writer (people-writer.ts putPeopleOnOrder: a follow row, reason ADDED, kept not
 * doubled), so the designer sees them (on-the-order.ts) and is told their news. orders.manage over EVERY order, all or nothing:
 * an order the caller may not see is 404 ("Sales order not found."), one it sees but may not manage is 403 — checked before
 * anything is written. ONE command, one audit row per order (`orders.designer.give`: who was given it, and whether they were new).
 * `added` = how many orders the person is new on.
 */

export const GIVE_DESIGNER_MAX = 100

export const NOT_AN_OFFICE_PERSON = Object.freeze({
  en: 'Give the orders to an active person of the office.',
  it: 'Affida gli ordini a una persona attiva dell’ufficio.',
})

export const giveToDesignerContract = defineContract({
  body: input({ orderIds: z.array(id()).min(1).max(GIVE_DESIGNER_MAX), userId: id() }),
  response: { 200: output({ added: z.number().int() }) },
})

/** POST /sales/orders/designer (see the file's head). */
export async function giveToDesigner(caller: CommandCaller, body: { readonly orderIds: readonly string[]; readonly userId: string }, idempotencyKey?: string): Promise<{ added: number }> {
  const context = officeContextOf(caller)
  const ids = [...new Set(body.orderIds)]
  const orders = await caller.withClient(async (client) => {
    const rows = await client.salesOrder.findMany({ where: { id: { in: ids } }, select: { id: true, companyId: true, partyId: true } })
    for (const orderId of ids) await assertSees(client, context, ORDERS_MANAGE, rows.find((row) => row.id === orderId) ?? null, { salesOrderId: orderId })
    return rows
  })
  const outcome = await command(caller, { name: 'orders.designer.give', idempotencyKey, input: { orderIds: ids, userId: body.userId } }, async (tools) => {
    const person = await tools.tx.user.findFirst({ where: { id: body.userId, status: 'ACTIVE', audience: 'OFFICE' }, select: { id: true } })
    if (!person) throw new ValidationError(NOT_AN_OFFICE_PERSON.en, [{ path: 'body/userId', message: NOT_AN_OFFICE_PERSON.en }])
    let added = 0
    for (const order of orders) {
      const isNew = (await putPeopleOnOrder(tools, { salesOrderId: order.id, userIds: [person.id], byUserId: context.actorId })) > 0
      if (isNew) added += 1
      tools.audit({ action: 'orders.designer.give', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, after: { userId: person.id, added: isNew } })
    }
    return added
  })
  return { added: outcome.result }
}
