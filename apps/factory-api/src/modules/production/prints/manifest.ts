import { defineManifest } from '../../../core/manifest'

/**
 * "Print again" and the print sheet (owb- order workflow, S3 ss2; settle L3): production.print.start; never the floor, never a
 * partner. The handler checks the order with can() over its company and customer (`record`).
 */
export const manifest = defineManifest({
  'POST /production/orders/:orderId/prints': { audiences: ['office'], permission: 'production.print.start', scope: 'record' },
  'GET /production/orders/:orderId/print-sheet': { audiences: ['office'], permission: 'production.print.start', scope: 'record' },
  // owb-ss2b (settle L8, design § 5f): Place the scan code — production.print.start OR the Factory designer ON the order (orders.view.own
  // + S2's isOnOrder). The manifest takes ONE right, so it asks a signed-in office person; the handler checks the order (else 404).
  'GET /production/orders/:orderId/placements': { audiences: ['office'], permission: 'signed-in', scope: 'record' },
  'PUT /production/orders/:orderId/placements/:salesOrderLineId': { audiences: ['office'], permission: 'signed-in', scope: 'record' },
})
