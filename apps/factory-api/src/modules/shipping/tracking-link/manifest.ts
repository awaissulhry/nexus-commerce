import { defineManifest, PUBLIC } from '../../../core/manifest'

/**
 * Track an order (B-W2b-170; LOG-062; design links.tracking, SCR-194; warehouse.shipments page.conn "the tracking link").
 *
 * Office: the shipment's company, site and party are checked with can() in the handlers (`record`); making and withdrawing
 * a link changes what the customer can see, so it is shipping.manage, as the shipment's documents link (B-W1-49).
 * Link: a SHIPMENT_TRACK link of a Shipment reads its own tracking page (links.open) and downloads its papers
 * (links.download, evidence only); any other link is the one 404. Partner: "Copy tracking link" on an order the customer
 * sees (portal.salesOrders.view, the party's scope). Public: the search by order reference and postcode (the abuse guard,
 * one answer for a miss).
 */
export const manifest = defineManifest({
  'GET /shipping/shipments/:shipmentId/tracking-links': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/tracking-links': { audiences: ['office'], permission: 'shipping.manage', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/tracking-links/:linkId/revoke': { audiences: ['office'], permission: 'shipping.manage', scope: 'record' },
  'GET /link/tracking': { audiences: ['link'], permission: 'links.open', scope: 'record' },
  'POST /link/tracking/papers/:fileId/download': { audiences: ['link'], permission: 'links.download', scope: 'record' },
  'POST /portal/sales-orders/:orderId/shipments/:shipmentId/tracking-link': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
  'POST /tracking/search': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
})
