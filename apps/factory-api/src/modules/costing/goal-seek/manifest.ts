import { defineManifest } from '../../../core/manifest'

/**
 * Target price and goal-seek (B-W2b-420; FIN-013; design products.styles › Cost "Target price"). Office only; reads only
 * (costing.view over the sheet's company, checked with can(): `record`). A target sent needs its grain.
 */
export const manifest = defineManifest({
  'GET /costing/cost-sheets/:sheetId/goal-seek': { audiences: ['office'], permission: 'costing.view', scope: 'record' },
})
