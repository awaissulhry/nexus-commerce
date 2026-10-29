import { defineManifest } from '../../../core/manifest'

/**
 * The office's sales orders (B-W1-25; A2 SCR-038, SCR-039): office only (a floor, portal or link session is refused by
 * audience). An order belongs to a company and a party, so the handlers check each record with can() and filter the
 * list with scopeWhere() (`record`). The close route needs only orders.view to be reached: its handler asks orders.manage
 * or orders.close for a settled order, and orders.close (with a reason) for one that is not settled.
 */
export const manifest = defineManifest({
  'GET /sales/orders': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  'GET /sales/orders/board': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  'GET /sales/orders/:orderId': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  'POST /sales/orders': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'PUT /sales/orders/:orderId/promise': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /sales/orders/:orderId/ready': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /sales/orders/:orderId/cancel': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /sales/orders/:orderId/close': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
})
