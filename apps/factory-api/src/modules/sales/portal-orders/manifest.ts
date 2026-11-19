import { defineManifest } from '../../../core/manifest'

/**
 * Customer orders in the portal (B-W2b-175; SAL-075, SAL-076, SAL-080, SAL-081). Partner sessions only, inside their party
 * (row-level security); the order must be of the portal's company (the handler: else 404). Reads only.
 */
export const manifest = defineManifest({
  'GET /portal/sales-orders': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
  'GET /portal/sales-orders/in-transit': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
  // ---- B-TH-061: the customer's own sheet and its "Download all" (written here in the partner scope, never the export job).
  'GET /portal/sales-orders/sheet': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
  'GET /portal/sales-orders/sheet/download': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
  'GET /portal/sales-orders/:orderId': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
  'GET /portal/sales-orders/:orderId/progress': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
  'GET /portal/sales-orders/:orderId/shipments': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
  // B-SA-037 (Sales page plan N9, P14): the order's files shared with the customer, in the office's groups (the content wall).
  'GET /portal/sales-orders/:orderId/files': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
  // B-CP-019 (customer page plan C3, D2, D3; Owner O4): the customer's own price check (and the price grain: the handler), and its
  // own line prices given by the Buyer or the Admin (portal.salesOrders.ask; the price grain: the grain filter and the handler).
  'GET /portal/sales-orders/:orderId/price-check': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
  'PUT /portal/sales-orders/:orderId/brand-prices': { audiences: ['partner'], permission: 'portal.salesOrders.ask', scope: 'party' },
})
