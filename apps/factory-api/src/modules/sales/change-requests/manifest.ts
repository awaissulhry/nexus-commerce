import { defineManifest } from '../../../core/manifest'

/**
 * Change and cancel requests from the portal (B-W2b-183; SAL-077, SAL-078). The customer's routes are partner sessions only,
 * inside their party (row-level security; the order must be of the portal's company: the handler, else 404): reading the
 * order's requests rides on portal.salesOrders.view, asking and withdrawing need portal.salesOrders.ask (the customer
 * Buyer; the Admin follows). The office's are office only, checked per request with can() over the order's company and
 * customer (`record`): orders.view to read, orders.manage to answer (W2a's amendment and cancel permission); the cut-off
 * settings are saved with sales.settings.manage.
 */
export const manifest = defineManifest({
  'GET /portal/sales-orders/:orderId/change-requests/rules': { audiences: ['partner'], permission: 'portal.salesOrders.ask', scope: 'party' },
  'GET /portal/sales-orders/:orderId/change-requests': { audiences: ['partner'], permission: 'portal.salesOrders.view', scope: 'party' },
  'POST /portal/sales-orders/:orderId/change-requests': { audiences: ['partner'], permission: 'portal.salesOrders.ask', scope: 'party' },
  'POST /portal/sales-orders/:orderId/change-requests/:requestId/withdraw': { audiences: ['partner'], permission: 'portal.salesOrders.ask', scope: 'party' },
  'GET /sales/change-requests': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  'GET /sales/change-requests/settings': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  'PUT /sales/change-requests/settings': { audiences: ['office'], permission: 'sales.settings.manage', scope: 'record' },
  'GET /sales/change-requests/:requestId': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  'POST /sales/change-requests/:requestId/accept': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /sales/change-requests/:requestId/refuse': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
})
