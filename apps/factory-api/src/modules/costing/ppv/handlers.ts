import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { postForEvent, reverseForEvent } from './actions'

/**
 * The worker's half of the purchase price variance (B-W2b-407; FIN-031), in the event's tenant's system context, keyed by
 * the event (a repeated event or a retried job takes nothing twice; the variances' own keys make sure of it too):
 *
 *   inventory.receipt_posted       a company that takes its variance at the RECEIPT: the receipt's lines (a customer's own
 *                                  goods never: CUSTOMER_SUPPLIED)
 *   supplier_invoice.approved      a company that takes it at the INVOICE: the invoice's goods lines
 *   inventory.receipt_reversed     the receipt's live variances taken back
 *   supplier_invoice.voided        the invoice's live variances taken back
 * Nothing is written while the company's figures for the accountant are off (GATE-ACCOUNTANT), and a document whose
 * variance waits (no standard, no rate) is posted later by POST /costing/ppv/post.
 *
 * Listed in background.ts (B-W2b-407's line).
 */
export function ppvHandlers(): EventHandler[] {
  return [
    defineHandler({
      name: 'costing.purchasePriceVariance',
      events: ['inventory.receipt_posted', 'supplier_invoice.approved', 'inventory.receipt_reversed', 'supplier_invoice.voided'],
      async handle(event, { caller }) {
        if (event.type === 'inventory.receipt_posted') {
          await postForEvent(caller, { receiptId: (event.payload as { receiptId: string }).receiptId }, event.eventId)
        } else if (event.type === 'supplier_invoice.approved') {
          await postForEvent(caller, { supplierInvoiceId: (event.payload as { supplierInvoiceId: string }).supplierInvoiceId }, event.eventId)
        } else if (event.type === 'inventory.receipt_reversed') {
          await reverseForEvent(caller, { receiptId: (event.payload as { receiptId: string }).receiptId }, event.eventId, 'The goods receipt was reversed.')
        } else {
          await reverseForEvent(caller, { supplierInvoiceId: (event.payload as { supplierInvoiceId: string }).supplierInvoiceId }, event.eventId, 'The supplier invoice was voided.')
        }
      },
    }),
  ]
}
