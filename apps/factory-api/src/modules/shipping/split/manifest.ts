import { defineManifest } from '../../../core/manifest'

/**
 * Split one order into several shipments (B-W2b-386; LOG-005): office only; the handlers check the shipment with can()
 * (`record`).
 */
// owb- (order workflow, S3 ss1 step 1.1; settle L3): the PLAN routes ask shipping.view here (the manifest takes one right) and
// shipping.plan OR shipping.manage in their handler (../access.ts mayPlanShipments), over each shipment's company, site and customer.
export const manifest = defineManifest({
  'GET /shipping/shipments/:shipmentId/split': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/split': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/split-by-rule': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
})
