import { defineManifest } from '../../../core/manifest'

/**
 * Goods receipts against a purchase order (B-W1-32; SCM-113, SCM-116, SCM-117, SCM-121, SCM-247; A2 SCR-061, 062, 063):
 * the office in W1. Recording needs inventory.receive over the order's company and site, reversing inventory.reverse
 * over the receipt's; the reads inventory.stock.view (the expected lines inventory.receive). Handlers check each record
 * with can() and filter the lists with scopeWhere() (`record`). The floor's receiving screen is B-W1-33.
 */
export const manifest = defineManifest({
  'GET /inventory/receipts': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/receipts/expected': { audiences: ['office'], permission: 'inventory.receive', scope: 'record' },
  'GET /inventory/receipts/:receiptId': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/receipts/:receiptId/lots': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'POST /inventory/receipts': { audiences: ['office'], permission: 'inventory.receive', scope: 'record' },
  'POST /inventory/receipts/:receiptId/reverse': { audiences: ['office'], permission: 'inventory.reverse', scope: 'record' },
})
