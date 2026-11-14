import { defineManifest } from '../../../core/manifest'

/**
 * Shipment holds (B-W2b-386; LOG-017, FIN-079): office only. A shipment belongs to a company, a site and a party, so the
 * handlers check each record with can() and filter the list with scopeWhere() (`record`). Releasing a money hold (credit,
 * deposit, balance before shipping) or one the system placed also needs shipping.holds.release (checked in the handler).
 */
export const manifest = defineManifest({
  'GET /shipping/shipments/:shipmentId/holds': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/holds': { audiences: ['office'], permission: 'shipping.holds.manage', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/holds/:holdId/release': { audiences: ['office'], permission: 'shipping.holds.manage', scope: 'record' },
  'POST /shipping/holds': { audiences: ['office'], permission: 'shipping.holds.manage', scope: 'record' },
  'GET /shipping/holds': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
})
