import { defineManifest } from '../../../core/manifest'

/**
 * The office's shipments (LOG-001, LOG-002, LOG-039; A2 SCR-066, SCR-067): office only (a portal, link or floor
 * session is refused by audience). A shipment belongs to a company, a site and a party, so the handlers check each
 * record with can() and filter the lists with scopeWhere() (`record`).
 */
export const manifest = defineManifest({
  'GET /shipping/ready': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'GET /shipping/shipments': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'GET /shipping/shipments/:shipmentId': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /shipping/shipments': { audiences: ['office'], permission: 'shipping.manage', scope: 'record' },
  'PATCH /shipping/shipments/:shipmentId': { audiences: ['office'], permission: 'shipping.manage', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/lines': { audiences: ['office'], permission: 'shipping.manage', scope: 'record' },
  'PATCH /shipping/shipments/:shipmentId/lines/:lineId': { audiences: ['office'], permission: 'shipping.manage', scope: 'record' },
  'DELETE /shipping/shipments/:shipmentId/lines/:lineId': { audiences: ['office'], permission: 'shipping.manage', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/cancel': { audiences: ['office'], permission: 'shipping.manage', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/packing-list': { audiences: ['office'], permission: 'shipping.pack', scope: 'record' },
  // B-W2a-48 (LOG-004, LOG-012, LOG-105): the backorder, the packing list's versions, the freight charged.
  'GET /shipping/backorders': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'GET /shipping/orders/:salesOrderId/backorder': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'GET /shipping/shipments/:shipmentId/packing-lists': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'PUT /shipping/shipments/:shipmentId/freight': { audiences: ['office'], permission: 'shipping.freight.manage', scope: 'record' },
  'GET /shipping/sites/:siteId/freight-rule': { audiences: ['office'], permission: 'shipping.settings.view', scope: 'record' },
  'PUT /shipping/sites/:siteId/freight-rule': { audiences: ['office'], permission: 'shipping.freight.manage', scope: 'record' },
  // B-W2b-19: the carrier's freight cost (a cost), a carrier return back into finished goods.
  'PUT /shipping/shipments/:shipmentId/freight-cost': { audiences: ['office'], permission: 'shipping.freight.manage', scope: 'record' },
  'GET /shipping/shipments/:shipmentId/carrier-return': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/carrier-return': { audiences: ['office'], permission: 'shipping.manage', scope: 'record' },
})
