import { defineManifest } from '../../../core/manifest'

/**
 * Split one order into several shipments (B-W2b-386; LOG-005): office only; the handlers check the shipment with can()
 * (`record`).
 */
export const manifest = defineManifest({
  'GET /shipping/shipments/:shipmentId/split': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/split': { audiences: ['office'], permission: 'shipping.manage', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/split-by-rule': { audiences: ['office'], permission: 'shipping.manage', scope: 'record' },
})
