import { defineManifest } from '../../../core/manifest'

/**
 * Our warehouse first (owb- order workflow, S3 ss1; settles L3, L5). Office: the acts check each shipment with can() (`record`) —
 * arrived and Send on with shipping.manage (pack and send); the customer's label with shipping.plan OR shipping.manage (the
 * manifest takes ONE right: shipping.view here, the handler asks ../access.ts mayPlanShipments); the reads with shipping.view,
 * filtered by scopeWhere(). Partner: the customer's own label, portal.upload over the session's party (`party`); the handler checks
 * the order, the shipment and the file are the party's own.
 */
export const manifest = defineManifest({
  'GET /shipping/warehouse-legs': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'GET /shipping/our-warehouses': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/arrived': { audiences: ['office'], permission: 'shipping.manage', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/forward': { audiences: ['office'], permission: 'shipping.manage', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/customer-label': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /portal/sales-orders/:orderId/shipments/:shipmentId/label': { audiences: ['partner'], permission: 'portal.upload', scope: 'party' },
})
