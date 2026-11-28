import { defineManifest } from '../../../core/manifest'

/**
 * Customer orders in the portal (B-W2b-175; SAL-075, SAL-076, SAL-080, SAL-081). Partner sessions only, inside their party
 * (row-level security); the order must be of the portal's company (the handler: else 404). Reads only (pg-s2: one read POST, the pictures).
 */
export const manifest = defineManifest({
  'GET /portal/sales-orders': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
  // ---- B-TH-061: the customer's own sheet and its "Download all" (written here in the partner scope, never the export job).
  'GET /portal/sales-orders/sheet': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
  'GET /portal/sales-orders/sheet/download': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
  // pg-s2 S2.1 (portal grid D4, Z12): the small pictures of the party's own orders (a read POST; product/images portalLinePictureFiles).
  'POST /portal/sales-orders/pictures': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
  'GET /portal/sales-orders/:orderId': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
  'GET /portal/sales-orders/:orderId/progress': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
  'GET /portal/sales-orders/:orderId/shipments': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
  // B-SA-037 (Sales page plan N9, P14): the order's files shared with the customer, in the office's groups (the content wall).
  'GET /portal/sales-orders/:orderId/files': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
  // B-CP-019 (customer page plan C3, D2, D3; Owner O4): the customer's own price check (and the price grain: the handler), and its
  // own line prices given by the Buyer or the Admin (portal.salesOrders.ask; the price grain: the grain filter and the handler).
  'GET /portal/sales-orders/:orderId/price-check': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
  'PUT /portal/sales-orders/:orderId/brand-prices': { audiences: ['partner'], permission: 'portal.salesOrders.ask', scope: 'party' },
  // owb- (order workflow, b3.1; S1 ask 23:36): the ONE order log in the customer's face — of its order (portal.salesOrders.view) and of
  // its Draft or Sent order (portal.orderDrafts.edit, like the request's own read); ONE record's rows read in the tenant's scope
  // after the partner read found it; the ALLOW-list only; every factory person "The factory".
  'GET /portal/sales-orders/:orderId/log': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
  'GET /portal/order-requests/:requestId/log': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  // owb- (b3.2; S1 ask 23:36): the order's picture, ONE right before and after Send (a look, not a commercial act). The order's is
  // written in the tenant's office scope as the person after the party check (the partner holds SELECT only on SalesOrder).
  'POST /portal/order-requests/:requestId/picture': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'POST /portal/sales-orders/:orderId/picture': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  // owb- po2.2 (order workflow): the Money tab (who reads orders; the price grain: the handler, 403 without) and "I paid" (the Buyer,
  // the Admin: portal.payments.notify; the price grain too).
  'GET /portal/sales-orders/:orderId/money': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
  'POST /portal/sales-orders/:orderId/payment-notices': { audiences: ['partner'], permission: 'portal.payments.notify', scope: 'party' },
  // owb- po2.4 (order workflow): factory people for your brand (Your people: every customer person who sees its colleagues).
  'GET /portal/factory-people': { audiences: ['partner'], permission: 'portal.colleagues.view', scope: 'party' },
})
