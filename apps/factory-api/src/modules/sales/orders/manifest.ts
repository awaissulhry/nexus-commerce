import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * owb-of1a (plan.md § 5 D R20): the reads the Factory designer uses take orders.view OR orders.view.own (the designer sees only the
 * orders it is on). A manifest names ONE permission, so these say signed-in: routes.ts refuses (403) a caller who holds neither
 * (access.ts assertOrdersReader), and each handler checks the order with access.ts assertSees (on-the-order.ts, the ONE rule) and
 * filters a list with the orders the designer is on, in SQL. The only signed-in entries of this manifest are these reads.
 */
const ORDER_READ = { audiences: ['office'], permission: SIGNED_IN, scope: 'record' } as const

/**
 * The office's sales orders (B-W1-25; A2 SCR-038, SCR-039): office only (a floor, portal or link session is refused by
 * audience). An order belongs to a company and a party, so the handlers check each record with can() and filter the
 * list with scopeWhere() (`record`). The close route needs only orders.view to be reached: its handler asks orders.manage
 * or orders.close for a settled order, and orders.close (with a reason) for one that is not settled.
 */
export const manifest = defineManifest({
  'GET /sales/orders': ORDER_READ, // owb-of1a
  'GET /sales/orders/board': ORDER_READ, // owb-of1a
  'GET /sales/orders/:orderId': ORDER_READ, // owb-of1a
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
  'GET /sales/orders/:orderId/amendments': ORDER_READ, // owb-of1a
  'POST /sales/orders/:orderId/amendments/preview': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /sales/orders/:orderId/amendments': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /sales/orders/:orderId/close-lines': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  // B-OP-013 (order page plan N2): the close's preview — what each work order will do (can() on the order, as the close).
  'POST /sales/orders/:orderId/close-lines/preview': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /sales/orders/:orderId/reopen-lines': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'GET /sales/orders/:orderId/cancel-check': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'GET /sales/orders/:orderId/schedule': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  // B-W2a-F2: a before-shipping step's deposit request (an advance invoiced with a TD02 when paid before the goods leave).
  // B-OM-018 (order money tab L9): "Open for payment" is the money plan's right (Owner, Finance), no longer orders.manage
  // (Sales sees no amount: it would ask money it cannot see).
  'POST /sales/orders/:orderId/schedule/:milestoneId/request': { audiences: ['office'], permission: 'orders.moneyPlan', scope: 'record' },
  // B-OM-011 … 016 (order money tab): the money plan changed by hand, and its preview (nothing written).
  'POST /sales/orders/:orderId/money-plan': { audiences: ['office'], permission: 'orders.moneyPlan', scope: 'record' },
  'POST /sales/orders/:orderId/money-plan/preview': { audiences: ['office'], permission: 'orders.moneyPlan', scope: 'record' },
  // B-W2b-16: the owner waives a deposit or a step before shipping (a reason and a fresh step-up).
  'POST /sales/orders/:orderId/schedule/:milestoneId/waive': { audiences: ['office'], permission: 'orders.waive', scope: 'record' },
  'POST /sales/orders/:orderId/deposit-requests/:requestId/waive': { audiences: ['office'], permission: 'orders.waive', scope: 'record' },
  'POST /sales/orders/:orderId/copy-as-quote': { audiences: ['office'], permission: 'quotes.manage', scope: 'record' },
  // B-W2b-398 (LOG-067): the order's deliveries (each shipment's arrival and proof, the terms from delivery).
  'GET /sales/orders/:orderId/deliveries': ORDER_READ, // owb-of1a
  // B-TH-019: the Customer switcher's numbers (the customers with orders the reader may see; scopeWhere like the list).
  'GET /sales/orders/customers': ORDER_READ, // owb-of1a
  // B-CL-003 (customers list): where each customer's work stands, for a page of customers (scopeWhere like the list; an id the
  // reader's parties or orders do not reach is absent; replies with threads.read).
  'GET /sales/orders/customers/work': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  // B-SA-011: the small pictures of a page of orders (scopeWhere like the list in one query; each file with files.read).
  'POST /sales/orders/pictures': ORDER_READ, // owb-of1a
  // B-TH-058: the overall view's totals (scopeWhere like the list: a customer-limited person reads only its customers' figures).
  'GET /sales/orders/summary': ORDER_READ, // owb-of1a
  // B-TH-077: what points at the order (can() on the order; complaints, returns and the gates' events each by their own right).
  'GET /sales/orders/:orderId/links': ORDER_READ, // owb-of1a
  // B-SA-031 / B-SA-032 (Sales page plan P2, P16): one order's production as the office reads it (can() on the order; each part by
  // its own right, named in `withheld` without it), and its dates alone (gates, milestones, the published plan; no action).
  'GET /sales/orders/:orderId/production': ORDER_READ, // owb-of1a
  'GET /sales/orders/:orderId/milestones': ORDER_READ, // owb-of1a
  // B-SA-036 (Sales page plan N9, P14): every file of the order by source group (can() on the order; files.read over each file's
  // record, its group's right, body data with sales.measurements.view), and the walled opening of one (body data recorded).
  'GET /sales/orders/:orderId/files': ORDER_READ, // owb-of1a
  'POST /sales/orders/:orderId/files/:fileId/open': ORDER_READ, // owb-of1a
  // B-OP-050 (order page plan N7): the small previews and PDF links of the order's file cards (can() on the order; the files read's
  // wall per file, body data never an address).
  'POST /sales/orders/:orderId/files/previews': ORDER_READ, // owb-of1a
  // B-OP-025 (order page plan N1; review R-12): Done on one of the order's production tasks — reached with orders.view, decided by the
  // TASK's own right (B-OC-005: workorders.manage over its work order, or its assignee; else 403 "Production does this").
  'POST /sales/orders/:orderId/still-to-do/tasks/:taskId/done': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  // B-SA-056 (Sales page plan P8, R2, R8): who was told about one change (can() on the order, threads.read on its conversation;
  // office people by name, the floor and the workshops by when and which work order — never who read anything).
  'GET /sales/orders/:orderId/told': ORDER_READ, // owb-of1a
  // F-SA-244: the told lines of all the order's changes in one read (counts and times; the same wall as above).
  'GET /sales/orders/:orderId/told/changes': ORDER_READ, // owb-of1a
  // owb- (order workflow, b3.1): the ONE order log — of a confirmed order, and of a Draft or Sent order (its request); can() on the
  // record's company AND customer (out of reach: 404), names in the office's face (a worker only behind the site's open gate).
  'GET /sales/orders/:orderId/log': ORDER_READ, // owb-of1a
  'GET /sales/order-requests/:requestId/log': ORDER_READ, // owb-of1a
  // owb- (b3.2): the order's picture (orders.picture.set) — the order's own, the request's through the od- writer.
  'POST /sales/orders/:orderId/picture': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /sales/order-requests/:requestId/picture': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  // owb-of1 (order workflow): the office's ONE orders sheet over Draft/Sent requests and orders, and the band of a Draft or Sent
  // order (orders.view or orders.view.own on it, ids in SQL); Restrict on the floor (orders.manage, settle L6); the customer's
  // "I paid" notices (read: orders.view, the amount only with the price grain; answer: payments.record over the order); Download
  // all (the Files tab's walled set as ONE zip); and "Give to the designer" for many orders at once (orders.manage over each).
  'GET /sales/orders/sheet': ORDER_READ,
  'GET /sales/orders/requests/:requestId/band': ORDER_READ,
  'POST /sales/orders/:orderId/restrict': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'GET /sales/orders/:orderId/payment-notices': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  'POST /sales/orders/:orderId/payment-notices/:noticeId/answer': { audiences: ['office'], permission: 'payments.record', scope: 'record' },
  'POST /sales/orders/:orderId/files/zip': ORDER_READ,
  'POST /sales/orders/designer': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
})
