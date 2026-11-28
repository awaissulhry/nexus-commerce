import { defineManifest } from '../../../core/manifest'

/**
 * Consolidate and split (B-OS-011 … B-OS-013, order shipments lane): office only; the handlers check each shipment with can()
 * (`record`), the target too (owb-: shipping.plan or shipping.manage over both), and answer another customer's shipment or order as an
 * unknown one.
 */
// owb- (order workflow, S3 ss1 step 1.1; settle L3): the PLAN routes ask shipping.view here (the manifest takes one right) and
// shipping.plan OR shipping.manage in their handler (../access.ts mayPlanShipments), over each shipment's company, site and customer.
export const manifest = defineManifest({
  'GET /shipping/shipments/:shipmentId/move-targets': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/move': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/merge': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/orders/:salesOrderId/take-off': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
})
