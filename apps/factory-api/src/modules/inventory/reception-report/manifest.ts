import { defineManifest } from '../../../core/manifest'

/**
 * The reception report of a goods receipt (B-W2b-300; SCM-119). Office only: reading it is inventory.stock.view over the
 * receipt's site; reserving from it is inventory.reserve there (the handler checks it again over the receipt's company and site);
 * sending it to the buyer is an internal note on the purchase order (threads.post over the order, checked by the handler).
 */
export const manifest = defineManifest({
  'GET /inventory/receipts/:receiptId/reception-report': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'POST /inventory/receipts/:receiptId/reception-report/reserve': { audiences: ['office'], permission: 'inventory.reserve', scope: 'record' },
  'POST /inventory/receipts/:receiptId/reception-report/send': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
})
