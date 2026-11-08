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
  // Order requests (SAL-074) and their lines.
  'GET /portal/order-requests': { audiences: ['partner'], permission: 'portal.orderRequests.manage', scope: 'party' },
  'POST /portal/order-requests': { audiences: ['partner'], permission: 'portal.orderRequests.manage', scope: 'party' },
  'GET /portal/order-requests/:requestId': { audiences: ['partner'], permission: 'portal.orderRequests.manage', scope: 'party' },
  'PATCH /portal/order-requests/:requestId': { audiences: ['partner'], permission: 'portal.orderRequests.manage', scope: 'party' },
  'DELETE /portal/order-requests/:requestId': { audiences: ['partner'], permission: 'portal.orderRequests.manage', scope: 'party' },
  'POST /portal/order-requests/:requestId/lines': { audiences: ['partner'], permission: 'portal.orderRequests.manage', scope: 'party' },
  'PUT /portal/order-requests/:requestId/lines/:lineId': { audiences: ['partner'], permission: 'portal.orderRequests.manage', scope: 'party' },
  'DELETE /portal/order-requests/:requestId/lines/:lineId': { audiences: ['partner'], permission: 'portal.orderRequests.manage', scope: 'party' },
  'POST /portal/order-requests/:requestId/prices': { audiences: ['partner'], permission: 'portal.orderRequests.manage', scope: 'party' },
  'POST /portal/order-requests/:requestId/send': { audiences: ['partner'], permission: 'portal.orderRequests.manage', scope: 'party' },
  'POST /portal/order-requests/:requestId/withdraw': { audiences: ['partner'], permission: 'portal.orderRequests.manage', scope: 'party' },
  // Reorder (SAL-072).
  'GET /portal/reorder/orders': { audiences: ['partner'], permission: 'portal.orderRequests.manage', scope: 'party' },
  'GET /portal/reorder/orders/:orderId': { audiences: ['partner'], permission: 'portal.orderRequests.manage', scope: 'party' },
  'POST /portal/order-requests/:requestId/reorder': { audiences: ['partner'], permission: 'portal.orderRequests.manage', scope: 'party' },
  // Upload (SAL-073).
  'GET /portal/order-template': { audiences: ['partner'], permission: 'portal.orderRequests.manage', scope: 'party' },
  'POST /portal/order-requests/:requestId/upload': { audiences: ['partner'], permission: 'portal.orderRequests.manage', scope: 'party' },
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
})
