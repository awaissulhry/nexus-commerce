import { defineManifest } from '../../../core/manifest'

/**
 * Below the minimum (B-W2b-314; SCM-281; design warehouse.stock "Below minimum"). Office only, read only: inventory.stock.view
 * at the site (the handler checks it with can(), `record`). The alert rule is the alerts platform's (LOW_STOCK).
 */
export const manifest = defineManifest({
  'GET /inventory/low-stock': { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' },
})
