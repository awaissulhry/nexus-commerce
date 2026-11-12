import { defineManifest } from '../../../core/manifest'

/**
 * "Why is it this number" (B-W2b-314; SCM-191; design warehouse.stock st-why, warehouse.moves mv-why). Office only, read
 * only: inventory.stock.view at the figure's site (the handler checks it with can() and reads inside scopeWhere(), `record`).
 */
export const manifest = defineManifest({
  'GET /inventory/why': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
})
