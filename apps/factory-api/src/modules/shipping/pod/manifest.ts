import { defineManifest } from '../../../core/manifest'

/**
 * The proof of delivery on the shipment (B-W2b-398; LOG-065): office only. The shipment's company, site and party are
 * checked with can() in the handlers (`record`). Recording it by hand is shipping.manage; reading and downloading it for a
 * dispute shipping.view.
 */
export const manifest = defineManifest({
  'GET /shipping/shipments/:shipmentId/pod': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'PUT /shipping/shipments/:shipmentId/pod': { audiences: ['office'], permission: 'shipping.manage', scope: 'record' },
  'GET /shipping/shipments/:shipmentId/pod/file': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
})
