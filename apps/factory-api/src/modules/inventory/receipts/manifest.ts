import { defineManifest } from '../../../core/manifest'

/**
 * Goods receipts against a purchase order (B-W1-32; SCM-113, SCM-116, SCM-117, SCM-121, SCM-247; A2 SCR-061, 062, 063):
 * the office. Recording needs inventory.receive over the order's company and site, reversing inventory.reverse
 * over the receipt's; the reads inventory.stock.view (the expected lines inventory.receive). Handlers check each record
 * with can() and filter the lists with scopeWhere() (`record`). A goods-in tablet receives through modules/inventory/receiving (B-W1-33).
 * B-W2a-31 adds the delivery note's photos (office and floor), the discrepancies with their photos and the report to the
 * supplier (inventory.discrepancies.manage / .report), and the totals of a tannery hide list import.
 */
export const manifest = defineManifest({
  'GET /inventory/receipts': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/receipts/counts': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/receipts/expected': { audiences: ['office'], permission: 'inventory.receive', scope: 'record' },
  'GET /inventory/receipts/:receiptId': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/receipts/:receiptId/lots': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'POST /inventory/receipts': { audiences: ['office'], permission: 'inventory.receive', scope: 'record' },
  'POST /inventory/receipts/:receiptId/reverse': { audiences: ['office'], permission: 'inventory.reverse', scope: 'record' },
  // B-W2a-31 (SCM-115): the supplier's delivery note photo, office and floor (files.upload checked by the handler for the office).
  'POST /inventory/receipts/:receiptId/ddt-photos': { audiences: ['office', 'floor'], permission: 'inventory.receive', scope: 'record' },
  'POST /inventory/receipts/:receiptId/ddt-photos/:fileId/complete': { audiences: ['office', 'floor'], permission: 'inventory.receive', scope: 'record' },
  // B-W2a-31 (SCM-118): what was wrong with the delivery, its photos, and the report to the supplier.
  'GET /inventory/receipts/:receiptId/discrepancies': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'POST /inventory/receipts/:receiptId/discrepancies': { audiences: ['office'], permission: 'inventory.discrepancies.manage', scope: 'record' },
  'PATCH /inventory/receipts/:receiptId/discrepancies/:discrepancyId': { audiences: ['office'], permission: 'inventory.discrepancies.manage', scope: 'record' },
  'DELETE /inventory/receipts/:receiptId/discrepancies/:discrepancyId': { audiences: ['office'], permission: 'inventory.discrepancies.manage', scope: 'record' },
  'POST /inventory/receipts/:receiptId/discrepancies/:discrepancyId/status': { audiences: ['office'], permission: 'inventory.discrepancies.manage', scope: 'record' },
  'POST /inventory/receipts/:receiptId/discrepancies/:discrepancyId/photos': { audiences: ['office'], permission: 'inventory.discrepancies.manage', scope: 'record' },
  'POST /inventory/receipts/:receiptId/discrepancies/:discrepancyId/photos/:fileId/complete': { audiences: ['office'], permission: 'inventory.discrepancies.manage', scope: 'record' },
  'GET /inventory/receipts/:receiptId/discrepancy-report': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/receipts/:receiptId/discrepancy-report/check': { audiences: ['office'], permission: 'inventory.discrepancies.report', scope: 'record' },
  'POST /inventory/receipts/:receiptId/discrepancy-report': { audiences: ['office'], permission: 'inventory.discrepancies.report', scope: 'record' },
  // B-W2a-31 (SCM-248): a tannery hide list's totals against its order (the import itself: POST /imports, importer inventory.hideList).
  'GET /inventory/receipts/hide-lists/:importId': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
})
