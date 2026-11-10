import { z } from 'zod'
import { defineEvent } from '../events/define'
import { CHANGE_ORDER_STATUSES, CHANGE_REQUEST_SOURCES, CHANGE_REQUEST_STATUSES } from '../product/changes/rules'

/**
 * Change requests and change orders (B-W2b-226; PRD-169, PRD-170, PRD-175; the code is factory-domain product/changes). A
 * module folder of its own, as product-lifecycle (the event guard wants `src/<module>/events.ts`). apps/factory-api's
 * modules/product/changes emits them in the command that makes the change; the notification centre's rules
 * (modules/product/changes/notices.ts) tell the people PRD-175 names.
 *
 *   change_request.raised     a change request was raised (office, floor, customer, sample round, supplier)
 *   change_request.changed    a change request was taken up, reviewed, accepted, rejected, changed, put in or taken out of a
 *                             change order, or done (its change order released)
 *   change_order.changed      a change order was written, changed, submitted, decided by one approver, approved, rejected,
 *                             released or cancelled; `approverIds` names the approvers just asked (submitted, or named while
 *                             it waits)
 *
 * Live on the changes screens for product.changes.view. Ids, numbers and states only: no person, no money.
 */
export const REQUEST_CHANGES = ['UPDATED', 'TAKEN_UP', 'IN_REVIEW', 'ACCEPTED', 'REJECTED', 'LINKED', 'UNLINKED', 'DONE'] as const
export const ORDER_CHANGES = ['CREATED', 'UPDATED', 'REVISION_LINKED', 'LINES_CHANGED', 'REQUESTS_CHANGED', 'APPROVERS_CHANGED', 'SUBMITTED', 'APPROVAL_DECIDED', 'APPROVED', 'REJECTED', 'RELEASED', 'CANCELLED'] as const

const live = { permission: 'product.changes.view' } as const

export const events = [
  defineEvent({
    type: 'change_request.raised',
    context: 'product-changes',
    description: 'A change request was raised for a style: from the office, the floor (a spec problem), a customer, a sample round or a supplier.',
    payload: z.strictObject({ changeRequestId: z.uuid(), number: z.string().nullable(), styleId: z.uuid(), source: z.enum(CHANGE_REQUEST_SOURCES), workOrderId: z.uuid().nullable() }),
    live: { ...live, fields: ['changeRequestId', 'number', 'styleId', 'source'] },
  }),
  defineEvent({
    type: 'change_request.changed',
    context: 'product-changes',
    description: 'A change request was taken up, reviewed, accepted, rejected, changed, put in or taken out of a change order, or done.',
    payload: z.strictObject({ changeRequestId: z.uuid(), number: z.string(), styleId: z.uuid(), status: z.enum(CHANGE_REQUEST_STATUSES), changeOrderId: z.uuid().nullable(), change: z.enum(REQUEST_CHANGES) }),
    live: { ...live, fields: ['changeRequestId', 'number', 'status', 'change'] },
  }),
  defineEvent({
    type: 'change_order.changed',
    context: 'product-changes',
    description: 'A change order was written, changed, submitted, decided by an approver, approved, rejected, released or cancelled.',
    payload: z.strictObject({
      changeOrderId: z.uuid(),
      number: z.string(),
      styleId: z.uuid(),
      status: z.enum(CHANGE_ORDER_STATUSES),
      change: z.enum(ORDER_CHANGES),
      approverIds: z.array(z.uuid()).max(10),
    }),
    live: { ...live, fields: ['changeOrderId', 'number', 'status', 'change'] },
  }),
] as const
