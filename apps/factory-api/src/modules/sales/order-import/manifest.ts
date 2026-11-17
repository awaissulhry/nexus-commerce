import { defineManifest } from '../../../core/manifest'

/**
 * The order import's own reads (B-TH-101): office only; the import is the imports engine's (importer `sales.orders`, POST
 * /imports), the handler checks the job's company and the customer with can() (`record`).
 */
export const manifest = defineManifest({
  'GET /sales/order-import/:importId/remembered-mapping': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
})
