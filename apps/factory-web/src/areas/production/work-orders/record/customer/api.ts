import { z } from 'zod'
import { APPROVAL_KINDS, APPROVAL_STATUSES } from '@nexus/factory-domain/approvals-out/kinds'
import { ISSUE_RECORD_TYPES, ISSUE_SOURCES, ISSUE_STATUSES } from '@nexus/factory-domain/production-brand/issues'
import { SUPERVISOR_MARKS } from '@nexus/factory-domain/production-brand/supervisor'
import { BRAND_URGENCIES, URGENCY_ACTORS, URGENCY_OUTCOMES } from '@nexus/factory-domain/production-brand/urgency'
import { ORDER_REQUEST_KINDS, REQUEST_STATUSES } from '@nexus/factory-domain/sales/change-requests/rules'
import { TASK_STATUSES } from '@nexus/factory-domain/tasks/rules'
import type { ApiClient } from '../../../../../lib/api/client'

/**
 * F-PR-05b — the work order record's Customer card, its reads and writes (production plan §5 "Work order record … Customer card (its
 * requests, customer urgency with Set to regular / Lock, supervisor)"; 06-tree A.4 O-WO-brand; 17-web-r2 §1.7). Each answer's shape
 * is checked (unknown fields dropped). The card asks ONLY for the work order's own customer(s) and own orders (PW-07): another
 * customer's id is never sent, and the API answers one the reader does not reach as unknown (the brand wall is the API's).
 *
 *   requests    GET /production/brand-requests?orderId= (B-PR-26; workorders.view or orders.view): what the customer asked on the order
 *   approvals   GET /approvals-out?recordType=SalesOrder&recordId= (partners.approvals.view): what we asked the customer to approve
 *   urgency     GET /production/brands/:partyId/urgency (B-PR-22b; workorders.view): its switch, quota and open orders' marks;
 *               POST /production/brand-orders/urgency/regular {orderIds, reason, lock} and …/unlock {orderIds}
 *               (production.brand.override, a fresh code, no second person: it is our own plan)
 *   issues      GET /production/issues?partyId= (B-PR-45; workorders.view or orders.view): the open problems, "No reply sent yet"
 *   limits      GET /partners/:partyId/production (B-PR-14; partners.view): areas/admin/users/partners/api getProductionLimits
 */

const words = z.object({ it: z.string(), en: z.string() })
const person = z.object({ id: z.string(), name: z.string() })

// ---- what the customer asked (B-PR-26) ------------------------------------------------------------------------------------------

export const customerRequestSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  orderNumber: z.string(),
  customerRef: z.string().nullable(),
  kind: z.enum(ORDER_REQUEST_KINDS),
  kindWords: words,
  status: z.enum(REQUEST_STATUSES),
  askedAt: z.string(),
  answer: z.string().nullable(),
  answeredAt: z.string().nullable(),
  party: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  askedBy: z.string().nullable(),
  answeredBy: z.string().nullable(),
  /** Who it waits on now: US (we answer, in Home › Approvals), CUSTOMER (our counter-offer); null: answered or withdrawn. */
  waitingOn: z.enum(['US', 'CUSTOMER']).nullable(),
  standing: words,
  batch: z.object({ id: z.string(), count: z.number(), waiting: z.number() }).nullable(),
  version: z.number(),
})
export type CustomerRequest = z.infer<typeof customerRequestSchema>

const requestsSchema = z.object({ asOf: z.string(), items: z.array(customerRequestSchema), count: z.number() })

/** The order's requests, every state (the card shows the waiting ones and the last answered); the newest page of at most 20. */
export async function listOrderRequests(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<CustomerRequest[]> {
  return (await api.get('/production/brand-requests', { query: { orderId, status: 'ALL', limit: 20 }, schema: requestsSchema, signal })).items
}

// ---- what we asked the customer to approve (approvals-out, B-W2b-184 / B-PR-29) -------------------------------------------------

export const askedApprovalSchema = z.object({
  id: z.string(),
  kind: z.enum(APPROVAL_KINDS),
  record: z.object({ type: z.string(), id: z.string(), words }),
  party: z.object({ id: z.string(), name: z.string() }),
  question: z.string(),
  dueAt: z.string(),
  status: z.enum(APPROVAL_STATUSES),
  /** How it was answered: by link, in the portal, or decided by us for the customer (OFFICE, B-PR-30a). */
  answer: z.object({ at: z.string(), via: z.string(), words: z.string().nullable() }).nullable(),
  createdAt: z.string(),
})
export type AskedApproval = z.infer<typeof askedApprovalSchema>

const askedSchema = z.object({ requests: z.array(askedApprovalSchema) })

/** What we asked the customer to approve on one order (samples, colours, leathers, artwork, fabric, trims asked in its thread; a new date). */
export async function listOrderApprovals(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<AskedApproval[]> {
  return (await api.get('/approvals-out', { query: { recordType: 'SalesOrder', recordId: orderId }, schema: askedSchema, signal })).requests
}

// ---- the customer's urgency as we steer it (B-PR-22b) ---------------------------------------------------------------------------

const urgencyOrderSchema = z.object({
  id: z.string(),
  number: z.string(),
  customerRef: z.string().nullable(),
  status: z.string(),
  orderDate: z.string(),
  urgency: z.enum(BRAND_URGENCIES),
  /** It counts in our plan now (Urgent while the customer's switch is on). */
  counted: z.boolean(),
  urgentRank: z.number().nullable(),
  setBy: z.enum(URGENCY_ACTORS).nullable(),
  setAt: z.string().nullable(),
  setByPerson: person.nullable(),
  locked: z.boolean(),
  lockReason: z.string().nullable(),
  lockedAt: z.string().nullable(),
  lockedBy: person.nullable(),
  words,
})
export type UrgencyOrder = z.infer<typeof urgencyOrderSchema>

export const customerUrgencySchema = z.object({
  asOf: z.string(),
  customer: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  urgency: z.object({ on: z.boolean(), max: z.number(), dormant: words.nullable() }),
  companies: z.array(
    z.object({
      company: z.object({ id: z.string(), code: z.string(), name: z.string() }),
      use: z.object({ used: z.number(), max: z.number(), agreed: z.number(), left: z.number(), over: z.boolean(), words }),
      mayOverride: z.boolean(),
      orders: z.array(urgencyOrderSchema),
    }),
  ),
})
export type CustomerUrgency = z.infer<typeof customerUrgencySchema>

export async function getCustomerUrgency(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<CustomerUrgency> {
  return api.get(`/production/brands/${encodeURIComponent(partyId)}/urgency`, { schema: customerUrgencySchema, signal })
}

export const urgencyAnswerSchema = z.object({
  results: z.array(
    z.object({
      orderId: z.string(),
      number: z.string(),
      customerRef: z.string().nullable(),
      outcome: z.enum(URGENCY_OUTCOMES),
      done: z.boolean(),
      words: words.nullable(),
      urgency: z.enum(BRAND_URGENCIES).nullable(),
    }),
  ),
  notFound: z.number(),
  replayed: z.boolean(),
})
export type UrgencyAnswer = z.infer<typeof urgencyAnswerSchema>

/** Back to Regular (and locked, with the reason the customer reads): production.brand.override, a fresh code. */
export function setBackUrgency(api: ApiClient, body: { readonly orderIds: readonly string[]; readonly reason: string; readonly lock: boolean }, idempotencyKey: string): Promise<UrgencyAnswer> {
  return api.post('/production/brand-orders/urgency/regular', { body: { orderIds: [...body.orderIds], reason: body.reason, lock: body.lock }, schema: urgencyAnswerSchema, idempotencyKey })
}

/** Unlocked (the customer may mark it Urgent again): production.brand.override, a fresh code. */
export function unlockUrgency(api: ApiClient, body: { readonly orderIds: readonly string[] }, idempotencyKey: string): Promise<UrgencyAnswer> {
  return api.post('/production/brand-orders/urgency/unlock', { body: { orderIds: [...body.orderIds] }, schema: urgencyAnswerSchema, idempotencyKey })
}

// ---- the open problems (B-PR-45) ------------------------------------------------------------------------------------------------

export const customerIssueSchema = z.object({
  id: z.string(),
  source: z.enum(ISSUE_SOURCES),
  sourceWords: words,
  status: z.enum(ISSUE_STATUSES),
  statusWords: words,
  /** "No reply sent yet": a customer's problem whose task was ticked while no reply went out (it still waits). */
  note: z.enum(['NO_REPLY_YET']).nullable(),
  noteWords: words.nullable(),
  record: z.object({ type: z.enum(ISSUE_RECORD_TYPES), id: z.string(), label: z.string() }),
  salesOrder: z.object({ id: z.string(), number: z.string() }).nullable(),
  customer: z.object({ id: z.string(), name: z.string() }),
  raisedAt: z.string(),
  dueOn: z.string(),
  answeredAt: z.string().nullable(),
  escalation: z.object({ step: z.number(), at: z.string(), words }).nullable(),
  task: z.object({ id: z.string(), status: z.enum(TASK_STATUSES), assignee: z.enum(SUPERVISOR_MARKS) }).nullable(),
  mine: z.boolean(),
  batch: z.object({ id: z.string(), issues: z.number() }).nullable(),
  excerpt: z.string().nullable(),
})
export type CustomerIssue = z.infer<typeof customerIssueSchema>

const issuesSchema = z.object({ asOf: z.string(), issues: z.array(customerIssueSchema), more: z.boolean() })
export type CustomerIssues = z.infer<typeof issuesSchema>

/** The customer's open problems the reader reaches (the card keeps those of this work order and its orders). */
export function listCustomerIssues(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<CustomerIssues> {
  return api.get('/production/issues', { query: { partyId, status: 'OPEN', limit: 200 }, schema: issuesSchema, signal })
}
