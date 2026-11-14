import { defineManifest } from '../../../core/manifest'

/**
 * The variances per work order (B-W2b-411; FIN-030; design finance.costing's bridge "biggest reason"): the lines of the
 * work orders' closes. Office only (A1 §2.6); the list is filtered with scopeWhere() over each line's company and site
 * (`record`); every amount money.cost.
 */
export const manifest = defineManifest({
  'GET /costing/variances': { audiences: ['office'], permission: 'costing.view', scope: 'record' },
})
