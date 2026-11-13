import { defineManifest } from '../../../core/manifest'

/**
 * Customer-supplied materials of an order (B-W2b-309; SAL-306). Office only; each handler checks the order with can() over its
 * company and customer (`record`). The receipt from the customer and the return to it are inventory's
 * (POST /inventory/receipts/customer, …/returns: inventory.receive).
 */
export const manifest = defineManifest({
  'GET /sales/orders/:orderId/customer-materials': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  'POST /sales/orders/:orderId/customer-materials/plan': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /sales/orders/:orderId/customer-materials/recount': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
})
