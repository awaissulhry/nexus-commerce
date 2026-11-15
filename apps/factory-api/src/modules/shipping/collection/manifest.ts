import { defineManifest } from '../../../core/manifest'

/**
 * The customer's own carrier collects (B-W2b-395; LOG-053): office only. A shipment belongs to a company, a site and a party,
 * so the handlers check it with can() (`record`). Reading needs shipping.view; recording the collection shipping.manage.
 */
export const manifest = defineManifest({
  'GET /shipping/shipments/:shipmentId/collection': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'PUT /shipping/shipments/:shipmentId/collection': { audiences: ['office'], permission: 'shipping.manage', scope: 'record' },
  'GET /shipping/shipments/:shipmentId/collection/signature': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
})
