import { defineManifest } from '../../../core/manifest'

/**
 * The stock reads (SCM-190, SCM-191, SCM-280; A2 SCR-060, SCR-064; PLAN §4.7 end check) and the warehouse screens'
 * reads (reads-contract.ts: hides, lots with their trace, the ledger as the Movements grid shows it, why a figure is what
 * it is). Office only. Stock belongs to a site and its company: the handlers filter with scopeWhere() and check a named
 * record with can() (`record`); values also need the cost grain.
 */
export const manifest = defineManifest({
  'GET /inventory/stock': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/stock/card': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/stock/reconciliation': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/stock/explain': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/hides': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/hides/:hideId': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/lots': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/lots/:lotId': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/ledger': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/ledger/counts': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
  'GET /inventory/ledger/:moveId': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
})
