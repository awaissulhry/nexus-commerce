import { defineManifest } from '../../../core/manifest'

/**
 * The customer's own columns (owb- order workflow, S1 po1.4; design § 5zi C). The portal's: the customer's people who keep drafts
 * (portal.orderDrafts.edit: the Buyer, the Designer, the Admin) inside their party; an ORDER's columns and values also need
 * portal.salesOrders.view (the handler: never the Designer). The office's twins: orders.manage (orders.view to read) over the
 * company and THAT customer, checked by the handler with can() (`record`: out of reach is 404).
 */
export const manifest = defineManifest({
  'GET /portal/own-columns': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'POST /portal/own-columns': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'POST /portal/own-columns/:columnId/close': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'PUT /portal/order-requests/:requestId/own-columns': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'PUT /portal/sales-orders/:orderId/own-columns': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'PUT /portal/own-values': { audiences: ['partner'], permission: 'portal.orderDrafts.edit', scope: 'party' },
  'GET /sales/own-columns': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  'POST /sales/own-columns': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /sales/own-columns/:columnId/close': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'PUT /sales/order-requests/:requestId/own-columns': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'PUT /sales/orders/:orderId/own-columns': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'PUT /sales/own-values': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
})
