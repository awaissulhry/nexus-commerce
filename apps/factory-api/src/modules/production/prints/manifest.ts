import { defineManifest } from '../../../core/manifest'

/**
 * "Print again" and the print sheet (owb- order workflow, S3 ss2; settle L3): production.print.start; never the floor, never a
 * partner. The handler checks the order with can() over its company and customer (`record`).
 */
export const manifest = defineManifest({
  'POST /production/orders/:orderId/prints': { audiences: ['office'], permission: 'production.print.start', scope: 'record' },
  'GET /production/orders/:orderId/print-sheet': { audiences: ['office'], permission: 'production.print.start', scope: 'record' },
})
