import { defineManifest } from '../../../core/manifest'

/**
 * Receiving goods on the floor (B-W1-33; SCM-113, SCM-116, SCM-117, SCM-247, SCM-259, SCM-268; A2 SCR-092): a floor
 * device at its own site (can() pins it, row-level security too) with inventory.receive (the receiving floor role
 * holds it); printing tags also needs print.labels (the handler checks it). Every write needs an Idempotency-Key. The
 * office records receipts through /inventory/receipts.
 */
export const manifest = defineManifest({
  'GET /inventory/receiving/orders': { audiences: ['floor'], permission: 'inventory.receive', scope: 'record' },
  'GET /inventory/receiving/orders/:orderId': { audiences: ['floor'], permission: 'inventory.receive', scope: 'record' },
  'POST /inventory/receiving/orders/:orderId/receipts': { audiences: ['floor'], permission: 'inventory.receive', scope: 'record' },
  'GET /inventory/receiving/receipts/:receiptId': { audiences: ['floor'], permission: 'inventory.receive', scope: 'record' },
  'POST /inventory/receiving/receipts/:receiptId/tags': { audiences: ['floor'], permission: 'inventory.receive', scope: 'record' },
})
