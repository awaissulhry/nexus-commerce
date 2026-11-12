import { z } from 'zod'
import { defineEvent } from '../events/define'
import { UNPLANNED_CHANGES } from '../inventory/unplanned/rules'

/**
 * The events of receiving in depth (B-W2b-300; SCM-122, SCM-119; apps/factory-api modules/inventory/{unplanned,reception-report}).
 * Context `inventory-receiving`, its own module folder (as inventory-tasks, B-W2b-292: the inventory events file is other
 * steps'). They reach the office's warehouse screens (inventory.stock.view); never a person, never a quantity or a price.
 *
 *   inventory.unplanned_changed    goods without a purchase order: taken in on the floor (RECEIVED, into the holding place), the
 *                                  buyer asked by a task (BUYER_ASKED), the order named and the goods posted (ORDER_NAMED), or
 *                                  sent back to the supplier (SENT_BACK). A posting also emits inventory.receipt_posted.
 *   inventory.reception_reported   a receipt's reception report was sent to the buyer (an internal note on the purchase order,
 *                                  naming its buyer) and/or its goods reserved for the work orders and orders they serve (the
 *                                  reservations also emit inventory.reserved).
 */
export const events = [
  defineEvent({
    type: 'inventory.unplanned_changed',
    context: 'inventory-receiving',
    description: 'Goods without a purchase order were taken in to a holding place, their buyer asked, their order named (and the goods posted), or the goods sent back.',
    payload: z.strictObject({
      receiptId: z.uuid(),
      number: z.string(),
      change: z.enum(UNPLANNED_CHANGES),
      supplierId: z.uuid(),
      holdingLocationId: z.uuid(),
      /** ORDER_NAMED: the purchase order named. */
      purchaseOrderId: z.uuid().nullable(),
      /** The buyer's task, once asked. */
      buyerTaskId: z.uuid().nullable(),
      lines: z.number().int().min(0),
    }),
    live: { permission: 'inventory.stock.view', fields: ['receiptId', 'number', 'change'] },
  }),
  defineEvent({
    type: 'inventory.reception_reported',
    context: 'inventory-receiving',
    description: "A receipt's reception report was sent to its buyer and/or its goods reserved for the work orders and orders they serve.",
    payload: z.strictObject({
      receiptId: z.uuid(),
      purchaseOrderId: z.uuid(),
      /** The reservations made in this step (none: only sent). */
      reservationIds: z.array(z.uuid()),
      /** The internal note on the purchase order's thread (null: not sent). */
      messageId: z.uuid().nullable(),
    }),
    live: { permission: 'inventory.stock.view', fields: ['receiptId'] },
  }),
] as const
