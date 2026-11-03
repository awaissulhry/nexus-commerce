import { defineManifest } from '../../../core/manifest'

/**
 * Rolls, protector lots and consumables (B-W2b-107; SCM-260, SCM-261, SCM-263). A roll, a lot, a work order and a protector
 * record belong to their site and its company: the handlers check them with can() and filter lists with scopeWhere()
 * (`record`). A roll write needs the ledger permission of the move it posts (receive to tag, issue, transfer, scrap,
 * adjust); describing a roll is inventory.rolls.manage. A floor device works at its own site only.
 */
export const manifest = defineManifest({
  'GET /inventory/rolls': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/rolls/lookup': { audiences: ['office', 'floor'], permission: 'inventory.issue', scope: 'record' },
  'GET /inventory/rolls/:rollId': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'POST /inventory/lots/:lotId/rolls': { audiences: ['office', 'floor'], permission: 'inventory.receive', scope: 'record' },
  'PATCH /inventory/rolls/:rollId': { audiences: ['office'], permission: 'inventory.rolls.manage', scope: 'record' },
  'POST /inventory/rolls/:rollId/issue': { audiences: ['office', 'floor'], permission: 'inventory.issue', scope: 'record' },
  'POST /inventory/rolls/:rollId/return': { audiences: ['office', 'floor'], permission: 'inventory.issue', scope: 'record' },
  'POST /inventory/rolls/:rollId/move': { audiences: ['office', 'floor'], permission: 'inventory.transfer', scope: 'record' },
  'POST /inventory/rolls/:rollId/scrap': { audiences: ['office'], permission: 'inventory.scrap', scope: 'record' },
  'POST /inventory/rolls/:rollId/correct': { audiences: ['office'], permission: 'inventory.adjust', scope: 'record' },
  'GET /inventory/work-orders/:workOrderId/protector-lots': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
  'GET /inventory/protector-lots/work-orders/:workOrderId': { audiences: ['floor'], permission: 'inventory.protectors.record', scope: 'record' },
  'POST /inventory/protector-lots': { audiences: ['office', 'floor'], permission: 'inventory.protectors.record', scope: 'record' },
  'POST /inventory/protector-lots/:rowId/withdraw': { audiences: ['office'], permission: 'inventory.protectors.record', scope: 'record' },
  'GET /inventory/lots/:lotId/protector-recall': { audiences: ['office'], permission: 'quality.lots.view', scope: 'record' },
  'GET /inventory/consumables': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'PUT /inventory/consumables/:itemId/pack': { audiences: ['office'], permission: 'product.materials.manage', scope: 'record' },
})
