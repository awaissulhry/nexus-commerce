import { z } from 'zod'
import { defineEvent, livePartyId } from '../events/define'
import { WORK_ORDER_CHANGE_KINDS } from './rules'

/**
 * B-SA-041 (sales page plan, lead picks P6', R1; 13-backend B4b; review C-5: ONE event list, these and production's
 * floor_note_posted — no sales_order.changed, order_change.step_changed, workorder.change_* or production.change_seen): the
 * life of a WorkOrderChange (factory-db order-apply.prisma). apps/factory-api's modules/production/work-order-changes emits
 * them in the command that makes the move; Accept (B-SA-042) emits `proposed` in its own command.
 *
 *   work_order_change.proposed   an accepted change of a sales order (or an office's own) proposed a change of one of its
 *                                work orders, held for a person who manages it
 *   work_order_change.applied    it was carried out on the work order (a draft's cells, Lower to the order, the unit
 *                                cancelled, or a new DRAFT made: madeWorkOrderId)
 *   work_order_change.declined   it was left as is, with words
 *   work_order_change.stale      what it carried out was put back (the request withdrawn or refused, the amendment undone)
 *
 * The wall: each names ONE customer (`partyId`, the order's; livePartyId: the office's live screens send it only to people who
 * reach that customer) and never in the live fields; ids, the kind and the status only — never a person, a figure or words.
 * Live: the office's order screens (orders.view) re-read the order's "Still to do" and its production part; B-SA-004c: the work
 * order screens (workorders.view) too. OFFICE ONLY: the portal is never told (portal/notifications/live.ts
 * PARTNER_LIVE_EVENTS does not list them).
 */

// B-SA-004c: and the production office's work order screens (workorders.view, `also`): the change is read by the order's readers
// OR its work order's (modules/production/work-order-changes read.ts), so a production person without orders.view is sent a new
// proposal live too. Each permission with its own grants: a person limited to some customers still gets only theirs (`partyId`).
const live = { permission: 'orders.view', also: 'workorders.view', fields: ['changeId', 'salesOrderId', 'workOrderId', 'kind'] } as const

const payload = {
  changeId: z.uuid(),
  salesOrderId: z.uuid(),
  /** The work order it changes (null: a MAKE_MORE that makes a new DRAFT). */
  workOrderId: z.uuid().nullable(),
  partyId: livePartyId(),
  kind: z.enum(WORK_ORDER_CHANGE_KINDS),
}

export const workOrderChangeProposed = defineEvent({
  type: 'work_order_change.proposed',
  context: 'order-apply',
  description: 'An accepted change of a sales order proposed a change of one of its work orders, held for a person who manages it.',
  payload: z.strictObject({ ...payload, requestId: z.uuid().nullable(), amendmentId: z.uuid().nullable(), hasExtra: z.boolean() }),
  live,
})

export const workOrderChangeApplied = defineEvent({
  type: 'work_order_change.applied',
  context: 'order-apply',
  description: 'A proposed change of a work order was carried out (its cells set or lowered, its unit cancelled, or a new draft made).',
  payload: z.strictObject({ ...payload, madeWorkOrderId: z.uuid().nullable() }),
  live,
})

export const workOrderChangeDeclined = defineEvent({
  type: 'work_order_change.declined',
  context: 'order-apply',
  description: 'A proposed change of a work order was left as is, with words.',
  payload: z.strictObject(payload),
  live,
})

export const workOrderChangeStale = defineEvent({
  type: 'work_order_change.stale',
  context: 'order-apply',
  description: 'A proposed change of a work order is no longer needed: what it carried out was put back before it was applied.',
  payload: z.strictObject(payload),
  live,
})

export const events = [workOrderChangeProposed, workOrderChangeApplied, workOrderChangeDeclined, workOrderChangeStale] as const
