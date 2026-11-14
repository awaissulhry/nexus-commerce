import { defineManifest } from '../../../core/manifest'

/**
 * A manual carrier or our own van (B-W2b-390; LOG-122): office only. A shipment belongs to a company, a site and a party, so
 * the handlers check it with can() (`record`). Reading needs shipping.view; every write shipping.manage.
 */
export const manifest = defineManifest({
  'GET /shipping/shipments/:shipmentId/own-transport': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'PUT /shipping/shipments/:shipmentId/own-transport': { audiences: ['office'], permission: 'shipping.manage', scope: 'record' },
  'PUT /shipping/shipments/:shipmentId/own-transport/tracking': { audiences: ['office'], permission: 'shipping.manage', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/own-transport/events': { audiences: ['office'], permission: 'shipping.manage', scope: 'record' },
})
