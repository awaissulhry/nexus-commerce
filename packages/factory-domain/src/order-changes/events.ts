import { z } from 'zod'
import { defineEvent } from '../events/define'
import { ORDER_FREEZE_ACTIONS, ORDER_FREEZE_FIELDS, ORDER_FREEZE_STAGES } from '../sales/order-changes/freeze'

/**
 * Order changes (B-W2b-309; SAL-190, SAL-218, SAL-219, SAL-221, SAL-248, SAL-306). apps/factory-api's modules/sales/
 * order-changes and customer-materials emit them in the command that makes the change. Their own module folder (the event
 * guard wants src/<module>/events.ts): the code is factory-domain sales/order-changes and sales/customer-materials. A change
 * itself is W2a's `sales_order.amended`; its extra deposit W1's `deposit_request.created`; the request for a new yes the
 * engine's `approval.requested`; a receipt from the customer W1's `inventory.receipt_posted` (no purchase order).
 *
 *   order_freeze_rule.changed     a company's freeze rule was made, switched off or on, or its action or words changed
 *   sales_order.change_priced     an amendment carried its price (its parts and fee), an extra deposit, a request for a yes
 *   sales_order.change_decided    the new yes after an edit was given or refused (the approver's decision on the order)
 *   customer_material.changed     an order's customer-supplied materials were planned from the BOM or counted again
 *
 * Reach the office's order screens (orders.view): ids, numbers, what changed; never a price, never a person.
 */

const order = { permission: 'orders.view', fields: ['orderId', 'number'] } as const

export const FREEZE_RULE_CHANGES = ['MADE', 'CHANGED'] as const
export const CHANGE_DECISIONS = ['APPROVED', 'REJECTED'] as const
export const MATERIAL_CHANGES = ['PLANNED', 'RECOUNTED'] as const

export const events = [
  defineEvent({
    type: 'order_freeze_rule.changed',
    context: 'order-changes',
    description: "A company's rule of what freezes on its orders at a production stage was made, switched off or on, or its action or words changed.",
    payload: z.strictObject({
      ruleId: z.uuid(),
      companyId: z.uuid(),
      field: z.enum(ORDER_FREEZE_FIELDS),
      frozenFrom: z.enum(ORDER_FREEZE_STAGES),
      action: z.enum(ORDER_FREEZE_ACTIONS),
      active: z.boolean(),
      change: z.enum(FREEZE_RULE_CHANGES),
    }),
    live: { permission: 'orders.view', fields: ['ruleId', 'companyId', 'field', 'frozenFrom', 'action', 'active', 'change'] },
  }),
  defineEvent({
    type: 'sales_order.change_priced',
    context: 'order-changes',
    description: 'A change of a sales order carried its price (its parts and a fee), and it may ask an extra deposit and a yes again.',
    payload: z.strictObject({
      orderId: z.uuid(),
      number: z.string(),
      amendmentId: z.uuid(),
      revision: z.number().int().min(1),
      hasFee: z.boolean(),
      depositRequestId: z.uuid().nullable(),
      reapprovalTaskId: z.uuid().nullable(),
    }),
    live: order,
  }),
  defineEvent({
    type: 'sales_order.change_decided',
    context: 'order-changes',
    description: 'The yes asked again after a sales order was changed was given or refused.',
    payload: z.strictObject({ orderId: z.uuid(), number: z.string(), amendmentId: z.uuid().nullable(), revision: z.number().int().min(1).nullable(), taskId: z.uuid(), decision: z.enum(CHANGE_DECISIONS) }),
    live: order,
  }),
  defineEvent({
    type: 'customer_material.changed',
    context: 'order-changes',
    description: "A sales order's customer-supplied materials were planned from the BOM, or counted again from the customer's own stock.",
    payload: z.strictObject({ orderId: z.uuid(), number: z.string(), change: z.enum(MATERIAL_CHANGES), rows: z.number().int().min(0) }),
    live: order,
  }),
] as const
