import { z } from 'zod'
import { defineEvent } from '../events/define'
import { CAPACITY_UNITS } from '../planning/subcontract-capacity/rules'

/**
 * Work to subcontractors' events (B-W2b-321; PLN-124, PLN-164, PLN-165; the code is factory-domain
 * planning/subcontract-capacity). A module folder of its own, as planning-planned-orders (the event guard wants
 * `src/<module>/events.ts`). apps/factory-api's modules/planning emits them in the command that makes the change:
 *
 *   subcontractor_capacity.changed   a workshop's weekly capacity row was added, changed or removed: the capacity
 *                                    screen's subcontractor rows, the heatmap and the allocation board read again
 *   work_order_operation.outsourced  one operation of a work order went outside to a workshop (with its subcontract order
 *                                    or without one yet) or came back in: the board, the allocation board and the
 *                                    capacity read again
 *   subcontract_order.kit_timed      the planner set when a draft subcontract order's kit must leave
 *
 * Live for planning.view. Ids, kinds and numbers only: no words a person typed, no person, no money.
 */
export const subcontractorCapacityChanged = defineEvent({
  type: 'subcontractor_capacity.changed',
  context: 'planning-subcontract',
  description: "A workshop's weekly capacity row (minutes or garments a week for a kind of work) was added, changed or removed.",
  payload: z.strictObject({
    capacityId: z.uuid(),
    partyId: z.uuid(),
    workCentreKind: z.string().nullable(),
    unit: z.enum(CAPACITY_UNITS),
    change: z.enum(['CREATED', 'EDITED', 'DELETED']),
  }),
  live: { permission: 'planning.view', fields: ['capacityId', 'partyId', 'change'] },
})

export const workOrderOperationOutsourced = defineEvent({
  type: 'work_order_operation.outsourced',
  context: 'planning-subcontract',
  description: 'One operation of a work order went outside to a workshop (with its subcontract order, or before it is made) or came back in.',
  payload: z.strictObject({
    workOrderId: z.uuid(),
    workOrderOperationId: z.uuid(),
    siteId: z.uuid(),
    outsourced: z.boolean(),
    partyId: z.uuid().nullable(),
    subcontractOrderId: z.uuid().nullable(),
  }),
  live: { permission: 'planning.view', fields: ['workOrderId', 'workOrderOperationId', 'siteId', 'outsourced', 'subcontractOrderId'] },
})

export const subcontractOrderKitTimed = defineEvent({
  type: 'subcontract_order.kit_timed',
  context: 'planning-subcontract',
  description: "The planner set when a draft subcontract order's kit must leave for the work to start on time.",
  payload: z.strictObject({
    subcontractOrderId: z.uuid(),
    siteId: z.uuid(),
    kitDueAt: z.string().nullable(),
  }),
  live: { permission: 'planning.view', fields: ['subcontractOrderId', 'siteId'] },
})

export const events = [subcontractorCapacityChanged, workOrderOperationOutsourced, subcontractOrderKitTimed]
