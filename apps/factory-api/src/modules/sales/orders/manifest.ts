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
  // B-W2a-30 (orders every day): manual entry, amendments, close and reopen lines, the cancel's impact check, the payment
  // schedule, an order copied as a new quote (orders.view on it; quotes.manage for the customer it is for).
  'GET /sales/order-numbers/next': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /sales/orders/manual/preview': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /sales/orders/manual': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'GET /sales/orders/:orderId/amendments': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  'POST /sales/orders/:orderId/amendments/preview': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /sales/orders/:orderId/amendments': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /sales/orders/:orderId/close-lines': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /sales/orders/:orderId/reopen-lines': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'GET /sales/orders/:orderId/cancel-check': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'GET /sales/orders/:orderId/schedule': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  // B-W2a-F2: a before-shipping step's deposit request (an advance invoiced with a TD02 when paid before the goods leave).
  'POST /sales/orders/:orderId/schedule/:milestoneId/request': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /sales/orders/:orderId/copy-as-quote': { audiences: ['office'], permission: 'quotes.manage', scope: 'record' },
})
