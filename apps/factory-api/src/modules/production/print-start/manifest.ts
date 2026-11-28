import { defineManifest } from '../../../core/manifest'

/**
 * "Print and start the work" (owb- order workflow, S3 ss2; settle L3): production.print.start (Sales; the Owner by every(); never the
 * floor, never a partner, the designer only by the per-person offer). The handler checks the order with can() over its company and
 * customer (`record`): another customer's order answers as an unknown one.
 */
export const manifest = defineManifest({
  'GET /production/orders/:orderId/print-start': { audiences: ['office'], permission: 'production.print.start', scope: 'record' },
  'POST /production/orders/:orderId/print-and-start': { audiences: ['office'], permission: 'production.print.start', scope: 'record' },
})
