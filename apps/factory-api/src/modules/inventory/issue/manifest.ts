import { defineManifest } from '../../../core/manifest'

/**
 * Picking and issuing to a work order (B-W1-39; SCM-215, SCM-194, SCM-216; A2 SCR-093): the office and a floor device
 * (its own site only: can() pins it, row-level security too) with inventory.issue; an over-issue also needs
 * inventory.issue.over (the handler checks it: the office only). The office reverses any issue or return with
 * inventory.reverse. A floor write needs an Idempotency-Key. Handlers check each work order with can() and filter the
 * list with scopeWhere() (`record`). B-W2a-58 (Picking & kits, SCR-237): the office's pick lists across work orders
 * (inventory.stock.view) and Create pick lists (inventory.reserve: the reservations module's own command per work order).
 */
export const manifest = defineManifest({
  'GET /inventory/picking/work-orders': { audiences: ['office', 'floor'], permission: 'inventory.issue', scope: 'record' },
  'GET /inventory/picking/work-orders/:workOrderId': { audiences: ['office', 'floor'], permission: 'inventory.issue', scope: 'record' },
  'POST /inventory/picking/work-orders/:workOrderId/issue': { audiences: ['office', 'floor'], permission: 'inventory.issue', scope: 'record' },
  'POST /inventory/picking/work-orders/:workOrderId/return': { audiences: ['office', 'floor'], permission: 'inventory.issue', scope: 'record' },
  'POST /inventory/picking/issues/:issueId/undo': { audiences: ['office', 'floor'], permission: 'inventory.issue', scope: 'record' },
  'POST /inventory/picking/moves/:moveId/reverse': { audiences: ['office'], permission: 'inventory.reverse', scope: 'record' },
  'GET /inventory/picking/pick-lists': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/picking/pick-lists/sheet': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'POST /inventory/picking/pick-lists': { audiences: ['office'], permission: 'inventory.reserve', scope: 'record' },
})
