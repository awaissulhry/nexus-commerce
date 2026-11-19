import { defineManifest } from '../../../core/manifest'

/**
 * Portal ordering (B-W2b-190; SAL-071, SAL-072, SAL-073, SAL-074, SAL-079). The customer's routes: partner sessions only,
 * inside their party (row-level security; the handlers keep to the portal's company). The office's: like the sales
 * orders, each request checked with can() over its company and customer (`record`).
 */
export const manifest = defineManifest({
  // The catalogue (SAL-071).
  'GET /portal/catalogue': { audiences: ['partner'], permission: 'portal.catalogue.view', scope: 'party' },
  'GET /portal/catalogue/:styleId': { audiences: ['partner'], permission: 'portal.catalogue.view', scope: 'party' },
  // Order requests (SAL-074) and their lines. B-CP-070 (D11): a draft is kept with portal.orderDrafts.edit (the Buyer and the
  // Designer; the Admin follows): read, start, fill, discard (the handler: one who may order, or the one who started it). Send and
  // Withdraw stay portal.orderRequests.manage (the Buyer, the Admin). No price for a role without the price grain (the filter).
  'GET /portal/order-requests': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'POST /portal/order-requests': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'GET /portal/order-requests/:requestId': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'PATCH /portal/order-requests/:requestId': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'DELETE /portal/order-requests/:requestId': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'POST /portal/order-requests/:requestId/lines': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'PUT /portal/order-requests/:requestId/lines/:lineId': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'DELETE /portal/order-requests/:requestId/lines/:lineId': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'POST /portal/order-requests/:requestId/prices': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  // B-CP-072: the draft's files (logos, references, measurement sheets); the handler also asks portal.upload.
  'POST /portal/order-requests/:requestId/files': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'POST /portal/order-requests/:requestId/files/:fileId/complete': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'DELETE /portal/order-requests/:requestId/files/:fileId': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  // B-CP-075: described and made-to-measure lines, and the people of a by-person line (a draft's: portal.orderDrafts.edit).
  'POST /portal/order-requests/:requestId/custom-lines': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'PUT /portal/order-requests/:requestId/custom-lines/:lineId': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'POST /portal/order-requests/:requestId/lines/:lineId/people': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'PUT /portal/order-requests/:requestId/lines/:lineId/people/:personId': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'DELETE /portal/order-requests/:requestId/lines/:lineId/people/:personId': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'POST /portal/order-requests/:requestId/send': { audiences: ['partner'], permission: 'portal.orderRequests.manage', scope: 'party' },
  'POST /portal/order-requests/:requestId/withdraw': { audiences: ['partner'], permission: 'portal.orderRequests.manage', scope: 'party' },
  // Reorder (SAL-072): a past order is the orders' business — kept with portal.orderRequests.manage (a Designer reads no order).
  'GET /portal/reorder/orders': { audiences: ['partner'], permission: 'portal.orderRequests.manage', scope: 'party' },
  'GET /portal/reorder/orders/:orderId': { audiences: ['partner'], permission: 'portal.orderRequests.manage', scope: 'party' },
  'POST /portal/order-requests/:requestId/reorder': { audiences: ['partner'], permission: 'portal.orderRequests.manage', scope: 'party' },
  // Upload (SAL-073): filling a draft from a sheet (B-CP-070: portal.orderDrafts.edit).
  'GET /portal/order-template': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'POST /portal/order-requests/:requestId/upload': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  // Delivery addresses (SAL-079).
  'GET /portal/addresses': { audiences: ['partner'], permission: 'portal.addresses.view', scope: 'party' },
  'POST /portal/addresses': { audiences: ['partner'], permission: 'portal.addresses.manage', scope: 'party' },
  'POST /portal/addresses/:addressId/archive': { audiences: ['partner'], permission: 'portal.addresses.manage', scope: 'party' },
  'POST /portal/addresses/:addressId/default': { audiences: ['partner'], permission: 'portal.addresses.manage', scope: 'party' },
  // The office decides (home.approvals; the sales orders' permissions).
  'GET /sales/order-requests': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  'GET /sales/order-requests/:requestId': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  'POST /sales/order-requests/:requestId/accept': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /sales/order-requests/:requestId/refuse': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  // B-W2b-F13b: the delivery addresses customers add wait for the office's check (whoever takes the customer's orders).
  'GET /sales/delivery-addresses': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  'POST /sales/delivery-addresses/:addressId/approve': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /sales/delivery-addresses/:addressId/refuse': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  // B-W2b-374 (XF3:04): an option's artwork in the portal (the office shows it; the customer opens it, logged).
  'PUT /sales/orders/:orderId/lines/:lineId/artwork/:fileId/portal': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'GET /portal/sales-orders/:orderId/options': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
  'POST /portal/sales-orders/:orderId/artwork/:fileId/open': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
})
