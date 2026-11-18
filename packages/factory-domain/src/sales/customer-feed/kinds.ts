/**
 * B-SA-060 (sales page plan R4, P9'; 13-backend B8; 11-customer-page §9.2; review C-1, BW-4, F-6) — "All of <Customer>", the words
 * the API's merged customer feed (`GET /sales/customers/:partyId/feed`) and the office's read-only view share: WHICH conversations
 * the feed merges, and how its Kind ▾ filter groups them. Pure.
 *
 * Only the CUSTOMER-SIDE record types: the conversations the office has with the customer (shared messages and the office's own
 * notes on them). Never a work order, a quality hold or an NCR (NOT_SHAREABLE: office only, and their walls can mix customers —
 * their notes stay reachable through the order dock's picker), never a supplier's record of a party that is also a supplier, and
 * never a customer's change request (OrderChangeRequest): its talk lives in its order's conversation (B-SA-048, review F-6), so
 * the order's thread is listed and the request's is not. A type that is not named here is not in the feed (fails closed): a module
 * that gives another customer record a conversation adds it here, one line.
 */

/** The Kind ▾ filter: orders (and their shipments, DDTs, invoices, reminders), quotes, requests, the general conversation, projects, after-sales. */
export const CUSTOMER_FEED_KINDS = ['ORDERS', 'QUOTES', 'REQUESTS', 'GENERAL', 'PROJECTS', 'AFTER_SALES'] as const
export type CustomerFeedKind = (typeof CUSTOMER_FEED_KINDS)[number]

/** Every record type the feed reads, and its kind. */
export const CUSTOMER_FEED_TYPES: Readonly<Record<string, CustomerFeedKind>> = Object.freeze({
  // The customer's general conversation (the Party thread), and a rider's measurements (only behind their gate:
  // platform/threads/records.ts THREAD_GATES, sales.measurements.view).
  Party: 'GENERAL',
  MeasurementProfile: 'GENERAL',
  SalesOrder: 'ORDERS',
  Shipment: 'ORDERS',
  Ddt: 'ORDERS',
  Invoice: 'ORDERS',
  // A payment reminder's own mail and the customer's answer to it (receivables).
  PaymentReminder: 'ORDERS',
  Quote: 'QUOTES',
  Inquiry: 'REQUESTS',
  // A catalogue order the customer sent from the portal (B-TH-040), before it becomes an order.
  PortalOrderRequest: 'REQUESTS',
  Project: 'PROJECTS',
  SampleRound: 'PROJECTS',
  ReturnAuthorisation: 'AFTER_SALES',
  RepairOrder: 'AFTER_SALES',
  Complaint: 'AFTER_SALES',
  ServiceCase: 'AFTER_SALES',
})

/** Record types that are never in the feed, whatever their party (the test holds it): office-only, mixed, supplier-side, or talked about elsewhere. */
export const NEVER_IN_CUSTOMER_FEED: readonly string[] = Object.freeze([
  'WorkOrder',
  'QualityHold',
  'Nonconformance',
  'OrderChangeRequest',
  'PurchaseOrder',
  'SubcontractOrder',
  'SupplierClaim',
  'SupplierInvoice',
  'GoodsReceipt',
  'Lot',
])

/** A page of the feed (cursor pages, newest first). */
export const CUSTOMER_FEED_PAGE = 30

/** The feed merges the most recently active conversations of the customer, at most this many; older ones are opened on their record. */
export const CUSTOMER_FEED_THREADS = 500

/** The conversations read together in one query of the merge (B8: "read messages of the first 50 threads"). */
export const CUSTOMER_FEED_BATCH = 50

/** The kind of a record type in the feed, or null when the type is not in it. */
export function customerFeedKindOf(recordType: string): CustomerFeedKind | null {
  return Object.hasOwn(CUSTOMER_FEED_TYPES, recordType) ? CUSTOMER_FEED_TYPES[recordType]! : null
}

/** The record types of these kinds (every kind: empty or absent), in the list's order. */
export function customerFeedTypesOf(kinds: readonly CustomerFeedKind[] | null | undefined): string[] {
  const asked = kinds && kinds.length > 0 ? new Set(kinds) : null
  return Object.entries(CUSTOMER_FEED_TYPES)
    .filter(([, kind]) => asked === null || asked.has(kind))
    .map(([type]) => type)
}
