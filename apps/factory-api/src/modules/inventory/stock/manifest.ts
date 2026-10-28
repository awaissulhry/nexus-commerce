import { defineManifest } from '../../../core/manifest'

/**
 * The stock reads (SCM-190, SCM-191, SCM-280; A2 SCR-060, SCR-064; PLAN §4.7 end check). Office only. Stock belongs to
 * a site and its company: the handlers filter with scopeWhere() and check a named site with can() (`record`); values
 * also need the cost grain.
 */
export const manifest = defineManifest({
  'GET /inventory/stock': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/stock/card': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/stock/reconciliation': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
})
