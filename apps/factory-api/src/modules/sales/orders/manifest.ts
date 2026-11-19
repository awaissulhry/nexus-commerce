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
  // B-OP-013 (order page plan N2): the close's preview — what each work order will do (can() on the order, as the close).
  'POST /sales/orders/:orderId/close-lines/preview': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /sales/orders/:orderId/reopen-lines': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'GET /sales/orders/:orderId/cancel-check': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'GET /sales/orders/:orderId/schedule': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  // B-W2a-F2: a before-shipping step's deposit request (an advance invoiced with a TD02 when paid before the goods leave).
  'POST /sales/orders/:orderId/schedule/:milestoneId/request': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  // B-W2b-16: the owner waives a deposit or a step before shipping (a reason and a fresh step-up).
  'POST /sales/orders/:orderId/schedule/:milestoneId/waive': { audiences: ['office'], permission: 'orders.waive', scope: 'record' },
  'POST /sales/orders/:orderId/deposit-requests/:requestId/waive': { audiences: ['office'], permission: 'orders.waive', scope: 'record' },
  'POST /sales/orders/:orderId/copy-as-quote': { audiences: ['office'], permission: 'quotes.manage', scope: 'record' },
  // B-W2b-398 (LOG-067): the order's deliveries (each shipment's arrival and proof, the terms from delivery).
  'GET /sales/orders/:orderId/deliveries': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  // B-TH-019: the Customer switcher's numbers (the customers with orders the reader may see; scopeWhere like the list).
  'GET /sales/orders/customers': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  // B-SA-011: the small pictures of a page of orders (scopeWhere like the list in one query; each file with files.read).
  'POST /sales/orders/pictures': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  // B-TH-058: the overall view's totals (scopeWhere like the list: a customer-limited person reads only its customers' figures).
  'GET /sales/orders/summary': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  // B-TH-077: what points at the order (can() on the order; complaints, returns and the gates' events each by their own right).
  'GET /sales/orders/:orderId/links': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  // B-SA-031 / B-SA-032 (Sales page plan P2, P16): one order's production as the office reads it (can() on the order; each part by
  // its own right, named in `withheld` without it), and its dates alone (gates, milestones, the published plan; no action).
  'GET /sales/orders/:orderId/production': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  'GET /sales/orders/:orderId/milestones': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  // B-SA-036 (Sales page plan N9, P14): every file of the order by source group (can() on the order; files.read over each file's
  // record, its group's right, body data with sales.measurements.view), and the walled opening of one (body data recorded).
  'GET /sales/orders/:orderId/files': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  'POST /sales/orders/:orderId/files/:fileId/open': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  // B-OP-050 (order page plan N7): the small previews and PDF links of the order's file cards (can() on the order; the files read's
  // wall per file, body data never an address).
  'POST /sales/orders/:orderId/files/previews': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  // B-OP-025 (order page plan N1; review R-12): Done on one of the order's production tasks — reached with orders.view, decided by the
  // TASK's own right (tasks.manage over its work order, or its assignee; else 403 "Production does this").
  'POST /sales/orders/:orderId/still-to-do/tasks/:taskId/done': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  // B-SA-056 (Sales page plan P8, R2, R8): who was told about one change (can() on the order, threads.read on its conversation;
  // office people by name, the floor and the workshops by when and which work order — never who read anything).
  'GET /sales/orders/:orderId/told': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  // F-SA-244: the told lines of all the order's changes in one read (counts and times; the same wall as above).
  'GET /sales/orders/:orderId/told/changes': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
})
