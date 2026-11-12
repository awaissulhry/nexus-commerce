import { defineManifest } from '../../../core/manifest'

/**
 * Goods without a purchase order (B-W2b-300; SCM-122; design floor.receive › "Goods without a PO"). The goods-in tablet takes
 * them in at its own site (inventory.receive; can() pins the device's site, row-level security too); the office reads them
 * (inventory.stock.view over the receipt's site) and the buyer or the warehouse decides (inventory.unplanned.decide: the
 * handlers check it over the receipt's company and site). Every write needs an Idempotency-Key and is ONE command.
 */
export const manifest = defineManifest({
  'GET /inventory/receiving/unplanned/start': { audiences: ['floor'], permission: 'inventory.receive', scope: 'record' },
  'GET /inventory/receiving/unplanned/items': { audiences: ['floor'], permission: 'inventory.receive', scope: 'record' },
  'POST /inventory/receiving/unplanned': { audiences: ['floor'], permission: 'inventory.receive', scope: 'record' },
  'GET /inventory/receiving/unplanned/:receiptId': { audiences: ['floor'], permission: 'inventory.receive', scope: 'record' },
  'GET /inventory/unplanned/:receiptId': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'POST /inventory/unplanned/:receiptId/order': { audiences: ['office'], permission: 'inventory.unplanned.decide', scope: 'record' },
  'POST /inventory/unplanned/:receiptId/return': { audiences: ['office'], permission: 'inventory.unplanned.decide', scope: 'record' },
  'POST /inventory/unplanned/:receiptId/buyer': { audiences: ['office'], permission: 'inventory.unplanned.decide', scope: 'record' },
})
