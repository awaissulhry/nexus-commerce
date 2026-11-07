import { defineManifest } from '../../../core/manifest'

/**
 * Customer orders in the portal (B-W2b-175; SAL-075, SAL-076, SAL-080, SAL-081). Partner sessions only, inside their party
 * (row-level security); the order must be of the portal's company (the handler: else 404). Reads only.
 */
export const manifest = defineManifest({
  'GET /portal/sales-orders': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
  'GET /portal/sales-orders/in-transit': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
  'GET /portal/sales-orders/:orderId': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
  'GET /portal/sales-orders/:orderId/progress': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
  'GET /portal/sales-orders/:orderId/shipments': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
})
