import { defineManifest } from '../../../core/manifest'

/**
 * The shipping notice to the customer (B-W2b-398; LOG-061): office only. The shipment's company, site and party are checked
 * with can() in the handlers (`record`). Send again reaches the customer: shipping.manage, as the shipment's tracking link.
 */
export const manifest = defineManifest({
  'GET /shipping/shipments/:shipmentId/notice': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/notice': { audiences: ['office'], permission: 'shipping.manage', scope: 'record' },
})
