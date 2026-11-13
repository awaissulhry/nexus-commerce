import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * Approvals and buying follow-ups (B-W2b-377; follow-ups XF5:03, XF5:05, XF5:06). A module folder of its own (the event
 * guard wants `src/<module>/events.ts`); apps/factory-api's modules/inventory/receiving/tolerance-hold.ts,
 * modules/purchasing/reminders/chase.ts and modules/purchasing/suppliers/document-types.ts emit them in the command that makes
 * the change.
 *
 *   inventory.receipt_held        a receipt waits OPEN: lines beyond their delivery tolerance each ask a yes (RECEIPT_OVER_TOLERANCE)
 *   inventory.receipt_released    the last held line of a waiting receipt got its yes: the worker posts it as the receiver
 *   purchase_order.chase_recorded a CHASE reminder of an order's revision was written (by hand, or by the daily run while the
 *                                 company's automatic reminders are on)
 *   supplier_document.typed       a supplier's document (a vault file) was given, changed or cleared its document type
 *
 * Ids, codes and counts only: no quantity, no price, no person's words.
 */
export const events = [
  defineEvent({
    type: 'inventory.receipt_held',
    context: 'buying-followups',
    description: 'A goods receipt waits OPEN: lines beyond their delivery tolerance each wait for a yes before it is posted.',
    payload: z.strictObject({ receiptId: z.uuid(), number: z.string(), purchaseOrderId: z.uuid(), lines: z.number().int().min(1) }),
    live: { permission: 'inventory.stock.view', fields: ['receiptId', 'number', 'purchaseOrderId'] },
  }),
  defineEvent({
    type: 'inventory.receipt_released',
    context: 'buying-followups',
    description: 'Every held line of a waiting goods receipt got its yes: the receipt is posted for the person who recorded it.',
    payload: z.strictObject({ receiptId: z.uuid(), number: z.string(), purchaseOrderId: z.uuid() }),
    live: { permission: 'inventory.stock.view', fields: ['receiptId', 'number', 'purchaseOrderId'] },
  }),
  defineEvent({
    type: 'purchase_order.chase_recorded',
    context: 'buying-followups',
    description: "A chase reminder of a purchase order's current revision was written, by hand or by the daily run.",
    payload: z.strictObject({ purchaseOrderId: z.uuid(), number: z.string(), revision: z.number().int().min(1), reminderId: z.uuid(), automatic: z.boolean() }),
    live: { permission: 'purchasing.view', fields: ['purchaseOrderId', 'number', 'revision', 'automatic'] },
  }),
  defineEvent({
    type: 'supplier_document.typed',
    context: 'buying-followups',
    description: "A supplier's document was given, changed or cleared its document type (what the vault and the PO gate match).",
    payload: z.strictObject({ fileId: z.uuid(), partyId: z.uuid(), documentTypeCode: z.string().nullable() }),
    live: { permission: 'parties.view', fields: ['fileId', 'partyId', 'documentTypeCode'] },
  }),
] as const
