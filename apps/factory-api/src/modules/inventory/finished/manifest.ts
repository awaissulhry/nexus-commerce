import { defineManifest } from '../../../core/manifest'

/**
 * Finished goods on hand (B-W2a-12; GAP-003). Office only, read only: inventory.stock.view, and the moves are filtered
 * with scopeWhere() by their company and site (`record`). Garments go into finished goods from the work order record
 * (modules/production/completion, production.finish).
 */
export const manifest = defineManifest({
  'GET /inventory/finished': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
})
