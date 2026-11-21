import { z } from 'zod'
import type { ApiClient } from '../../../../../lib/api/client'
import { ISSUE_RECORD_TYPES, ISSUE_SOURCES, ISSUE_STATUSES } from '@nexus/factory-domain/production-brand/issues'
import { SUPERVISOR_MARKS } from '@nexus/factory-domain/production-brand/supervisor'

/**
 * F-PT-103 (order PRODUCTION tab, 15-steps W1; 13-backend R10 settled) — the order's asks and questions, read from the ONE issues list
 * the Production overview and the work order's customer card already read (B-PR-45 / B-SA-033):
 *
 *   GET /production/issues?salesOrderId=<id>&status=ALL&limit=50     orders.view (the API checks the order first: another customer's
 *                                                                      order answers "Sales order not found.", the words of an unknown id)
 *
 * Every issue of this order — on the order itself or on one of its live work orders — newest first, each state (an answered ask is
 * the "Latest update"). Office only. The API's words (`sourceWords`, the escalation's) are said in the page's language.
 *
 * B-PT-010 (the server's S2, optional until it lands): `messageId` (only for a reader of the record's thread), `askedBy` and `reply`
 * (only when the query names ONE sales order and the reader reads the thread). Absent: the screen says when it was asked and by when it
 * is answered, never who, and offers no "Show in the thread".
 */

const words = z.object({ it: z.string(), en: z.string() })
const person = z.object({ id: z.string(), name: z.string() })

export const orderIssueSchema = z.object({
  id: z.string(),
  source: z.enum(ISSUE_SOURCES),
  sourceWords: words,
  status: z.enum(ISSUE_STATUSES),
  record: z.object({ type: z.enum(ISSUE_RECORD_TYPES), id: z.string(), label: z.string() }),
  raisedAt: z.string(),
  dueOn: z.string(),
  answeredAt: z.string().nullable(),
  escalation: z.object({ step: z.number().int(), at: z.string(), words }).nullable(),
  task: z.object({ id: z.string(), assignee: z.enum(SUPERVISOR_MARKS) }).nullable(),
  /** Its batch (one note to N records: answered together) and how many issues it holds. */
  batch: z
    .object({
      id: z.string(),
      issues: z.number().int(),
      // F-PT-302 (L8, B-PT-010b; optional): the OTHER orders of the asks on the same task the reader may open, and the rest counted.
      orders: z.array(z.object({ id: z.string(), number: z.string() })).optional(),
      more: z.number().int().optional(),
    })
    .nullable()
    .optional(),
  /** The words it was raised with, only for a reader of the record's thread. */
  excerpt: z.string().nullable(),
  // ---- F-PT-103 (B-PT-010; optional until the server's S2 lands) ----
  messageId: z.string().nullable().optional(),
  askedBy: person.nullable().optional(),
  reply: z.object({ at: z.string(), messageId: z.string(), by: person.nullable(), excerpt: z.string().nullable() }).nullable().optional(),
  // ---- end F-PT-103
})
export type OrderIssue = z.infer<typeof orderIssueSchema>

const orderIssuesSchema = z.object({
  asOf: z.string(),
  issues: z.array(orderIssueSchema),
  more: z.boolean(),
})
export type OrderIssues = z.infer<typeof orderIssuesSchema>

/** GET /production/issues — this order's issues, every state, newest first (the API's wall: this order's customer only). */
export function listOrderIssues(api: ApiClient, salesOrderId: string, signal?: AbortSignal): Promise<OrderIssues> {
  return api.get('/production/issues', { query: { salesOrderId, status: 'ALL', limit: 50 }, schema: orderIssuesSchema, signal })
}

// ---- F-PT-304 (order PRODUCTION tab, 10-design §9 D3): record what the customer sent — the EXISTING command, a new face -----------
const customerReceiptSchema = z.object({
  receipt: z.object({ id: z.string(), number: z.string(), lines: z.array(z.object({ id: z.string(), itemId: z.string(), lotCode: z.string().nullable() })) }),
})
export type CustomerReceiptAnswer = z.infer<typeof customerReceiptSchema>

export interface CustomerReceiptBody {
  readonly siteId: string
  readonly partyId: string
  readonly orderId: string
  readonly locationId: string
  readonly supplierDdtNumber: string | null
  readonly supplierDdtDate: string | null
  readonly lines: readonly { readonly itemId: string; readonly itemColourId: string | null; readonly quantity: string; readonly supplierLotRef: string | null }[]
}

/** POST /inventory/receipts/customer (inventory.receive): each line one lot of the customer's own, then their materials counted again. */
export function recordCustomerReceipt(api: ApiClient, body: CustomerReceiptBody, idempotencyKey: string): Promise<CustomerReceiptAnswer> {
  return api.post('/inventory/receipts/customer', { body, schema: customerReceiptSchema, idempotencyKey })
}
// ---- end F-PT-304
