import { defineManifest } from '../../../core/manifest'

/**
 * Carrier services (B-W2b-400; LOG-041, LOG-042, Q20): office only. A shipment belongs to a company, a site and a party, a
 * site and a Sendcloud connection to a company, so the handlers check them with can() (`record`). Values also need the price
 * grain (in the handler; the contract's marking drops them for anyone else); choosing a service for live use asks a fresh
 * step-up (in the handler).
 */
export const manifest = defineManifest({
  'GET /shipping/shipments/:shipmentId/booking': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'PUT /shipping/shipments/:shipmentId/services': { audiences: ['office'], permission: 'shipping.manage', scope: 'record' },
  'PUT /shipping/shipments/:shipmentId/parcels/:parcelId/value': { audiences: ['office'], permission: 'shipping.manage', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/parcel-values/by-rule': { audiences: ['office'], permission: 'shipping.manage', scope: 'record' },
  'GET /shipping/sites/:siteId/insurance': { audiences: ['office'], permission: 'shipping.settings.view', scope: 'record' },
  'PUT /shipping/sites/:siteId/insurance': { audiences: ['office'], permission: 'shipping.settings.manage', scope: 'record' },
  'GET /shipping/carrier-services': { audiences: ['office'], permission: 'shipping.settings.view', scope: 'record' },
  'PUT /shipping/carrier-services/:accountId': { audiences: ['office'], permission: 'shipping.settings.manage', scope: 'record' },
})
