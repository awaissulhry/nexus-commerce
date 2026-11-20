import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'
import { CREDIT_FINDINGS } from '../../../../finance/receivables/credit/api'

/**
 * F-OO-106 (order overview §1.3, §1.4; review F8, F16; B-OO-004) — the order's own credit hold, read and acted on from Overview ›
 * "Where it is now" (apps/factory-api modules/sales/credit):
 *
 *   getRecordCredit    GET  /sales/credit/records/SalesOrder/:id        sales.credit.view — the hold in force (its check, the yes asked
 *                                                                       and the last answer), what was found, what the reader may do
 *   checkCreditAgain   POST /sales/credit/records/SalesOrder/:id/check  sales.credit.checks — the order checked again now
 *   askCreditYes       POST /sales/credit/checks/:checkId/ask           sales.credit.checks — a yes asked on the hold that has none
 *
 * The check id is the lock (an accepted exception to "every write sends the version", plan F16): the API answers 409 when the order
 * was checked meanwhile. No amount is read here (the section draws none: findings in words only). Non-strict: a field the API adds
 * later — the amounts among them — is read past. `lastAnswer.reason` is Finance's own words, sent with the price grain only.
 */

const finding = z.enum(CREDIT_FINDINGS)

const heldSchema = z.object({
  checkId: z.string(),
  step: z.string(),
  checkedAt: z.string(),
  /** The yes asked on it and still open (null: none asked, or it was answered). */
  request: z.object({ taskId: z.string(), status: z.string(), approver: z.string().nullable(), requestedAt: z.string(), dueAt: z.string().nullable() }).nullable(),
  /** B-OO-004: the newest decided request for a yes on this hold — a no (REJECTED) or one taken back (WITHDRAWN); absent on an older answer. */
  lastAnswer: z
    .object({
      status: z.enum(['REJECTED', 'WITHDRAWN']),
      at: z.string(),
      by: z.string().nullable(),
      /** The words of a no — the price grain only (absent or null without it). */
      reason: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
})

const customerSchema = z.object({
  party: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  /** The customer is on hold (its account): the credit strip names it when it is the cause (plan §3, D6). */
  onHold: z.boolean(),
  findings: z.array(finding),
  held: heldSchema.nullable(),
  may: z.object({ checkAgain: z.boolean(), ask: z.boolean() }),
})
export type CreditCustomer = z.infer<typeof customerSchema>
export type CreditHeld = z.infer<typeof heldSchema>

const recordSchema = z.object({
  record: z.object({ type: z.string(), id: z.string(), label: z.string(), step: z.string() }),
  customers: z.array(customerSchema),
  readAt: z.string(),
})

const recordPath = (orderId: string) => `/sales/credit/records/SalesOrder/${encodeURIComponent(orderId)}`

/** The order's credit: its one customer's hold, findings and what the reader may do (null: the API names no customer). */
export async function getRecordCredit(api: ApiClient, orderId: string, signal?: AbortSignal): Promise<CreditCustomer | null> {
  const answer = await api.get(recordPath(orderId), { schema: recordSchema, signal })
  return answer.customers[0] ?? null
}

export const CHECK_RESULTS = ['PASS', 'WARN', 'HOLD'] as const
const checkAnswerSchema = z.object({ checkId: z.string(), result: z.enum(CHECK_RESULTS), asked: z.boolean(), orderGoesOn: z.boolean() })
export type CreditCheckAnswer = z.infer<typeof checkAnswerSchema>

/** Check the order's credit again now: PASS / WARN — the waiting order goes on; still HOLD — a new hold, a yes asked when someone may. */
export function checkCreditAgain(api: ApiClient, orderId: string, idempotencyKey = newIdempotencyKey()): Promise<CreditCheckAnswer> {
  return api.post(`${recordPath(orderId)}/check`, { body: {}, schema: checkAnswerSchema, idempotencyKey })
}

/** Ask for a yes on the hold (its check id: the lock); the note is the asker's word for who decides. */
export function askCreditYes(api: ApiClient, checkId: string, note: string, idempotencyKey = newIdempotencyKey()): Promise<{ taskId: string }> {
  const words = note.trim()
  return api.post(`/sales/credit/checks/${encodeURIComponent(checkId)}/ask`, { body: words ? { note: words } : {}, schema: z.object({ taskId: z.string() }), idempotencyKey })
}
