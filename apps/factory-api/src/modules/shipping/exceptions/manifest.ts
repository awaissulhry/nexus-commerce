import { defineManifest } from '../../../core/manifest'

/**
 * Tracking problems (B-W2b-398; LOG-063): office only. The shipment's company, site and party are checked with can() in the
 * handlers (`record`); the list filters with scopeWhere(). Resolving is shipping.manage, as every write on a shipment.
 */
export const manifest = defineManifest({
  'GET /shipping/shipments/:shipmentId/tracking-problems': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'GET /shipping/tracking-problems': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/tracking-problems/:exceptionId/resolve': { audiences: ['office'], permission: 'shipping.manage', scope: 'record' },
})
