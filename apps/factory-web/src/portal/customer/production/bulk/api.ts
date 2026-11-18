import { z } from 'zod'
import { BULK_ASK_KINDS as ASK_KINDS, WITHDRAW_OUTCOMES } from '@nexus/factory-domain/production-brand/bulk'
import { APPROVAL_KINDS, APPROVAL_STATUSES } from '@nexus/factory-domain/approvals-out/kinds' // F-PR-23b
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * F-PR-23a — the calls of the bulk bar on My production beside the urgency marks (production/api.ts: POST /portal/production/urgency,
 * PUT …/urgent-order, POST …/urgency/undo), each answer checked against the API's contracts (modules/production/brand-portal):
 *
 *   POST /portal/production/asks/:batchId/withdraw   Undo of what a Mark urgent asked of us ("Urgent – asked", B-PR-46a): each
 *                                                     request of the batch that still waits is withdrawn; the others are left
 *                                                     with why. Another customer's batch or none: 404 (never named)
 *   POST /portal/production/files/zip                 Download files of N (B-PR-46b): one zip of what we shared on those orders
 *                                                     (their confirmations only for a role that sees prices), or 409 in words at
 *                                                     `problem/<CODE>`
 *
 * Every write carries an Idempotency-Key. Only the customer's own orders are ever named in an answer: an id that is not its own is
 * only counted (`notFound`).
 */

const words = z.object({ it: z.string(), en: z.string() })

export const withdrawAnswerSchema = z.object({
  batchId: z.string(),
  results: z.array(
    z.object({
      requestId: z.string(),
      orderId: z.string(),
      number: z.string(),
      customerRef: z.string().nullable(),
      kind: z.string(),
      /** Withdrawn now. */
      done: z.boolean(),
      outcome: z.enum(WITHDRAW_OUTCOMES),
      words,
    }),
  ),
  replayed: z.boolean(),
})
export type WithdrawAnswer = z.infer<typeof withdrawAnswerSchema>

/** Undo of an asked batch: what still waits for our answer is withdrawn. */
export const withdrawAskBatch = (api: ApiClient, batchId: string, idempotencyKey: string = newIdempotencyKey()): Promise<WithdrawAnswer> =>
  api.post(`/portal/production/asks/${encodeURIComponent(batchId)}/withdraw`, { body: {}, schema: withdrawAnswerSchema, idempotencyKey })

/** Download files of N: the zip's bytes (a read: no key; each file zipped is logged as a download). */
export const downloadFilesZip = (api: ApiClient, orderIds: readonly string[]): Promise<Uint8Array> =>
  api.bytes('/portal/production/files/zip', { method: 'POST', body: { orderIds } })

// ---- F-PR-23b: Approve N and Ask N on My production ----------------------------------------------------------------------------
//
//   GET  /portal/production/approvals?orderIds=a,b   the approvals waiting on the picked orders (B-PR-46b), each once with its photo
//                                                     or PDF, and whether THIS person may tick it (`may.held`: a price — your buyer;
//                                                     a named approver — Waiting for <name>; "Open it to answer")
//   POST /portal/production/approvals/answer          Approve N: one typed name signs every ticked approval; one result per request;
//                                                     nothing approved 409 at `body/items/<i>/<code>`; NO Undo (said before Send)
//   POST /portal/production/asks                      Ask N (B-PR-46a): one request per order, one kind, one batch; each answered
//                                                     by us; nothing asked 409 at `body/orderIds/<i>/<code>`; Undo = …/withdraw above
export { BULK_ASK_KINDS, BULK_REASON_MAX, type BulkAskKind } from '@nexus/factory-domain/production-brand/bulk'

/** Why a request was not approved (B-PR-46b APPROVE_ROW_CODES; that module is server-only). */
export const APPROVE_ROW_CODES = ['OWN_ANSWER', 'NOT_YOURS', 'HELD', 'CHANGED', 'NOT_DONE'] as const
export type ApproveRowCode = (typeof APPROVE_ROW_CODES)[number]

const orderNamed = z.object({ orderId: z.string(), number: z.string(), customerRef: z.string().nullable() })

export const approvalsToReviewSchema = z.object({
  /** The picked own orders, each with how many of the listed approvals wait on it. */
  orders: z.array(orderNamed.extend({ waiting: z.number() })),
  items: z.array(
    z.object({
      requestId: z.string(),
      version: z.number(),
      kind: z.enum(APPROVAL_KINDS),
      /** What it is about, in both languages ("Sample · PP · BX-200"). */
      words,
      question: z.string(),
      dueAt: z.string(),
      /** The picked orders it waits on (the office's number is read, never drawn: their own names come from the list). */
      orders: z.array(orderNamed),
      facts: z.array(z.object({ label: z.string(), value: z.string() })),
      files: z.array(z.object({ id: z.string(), originalName: z.string(), contentType: z.string(), sizeBytes: z.number() })),
      may: z.object({ approve: z.boolean(), held: z.string().nullable() }),
    }),
  ),
  /** More approvals wait on these orders than the list holds: the rest in Waiting for you. */
  more: z.boolean(),
  notFound: z.number(),
  /** Said before Send: Approve N cannot be undone. */
  undo: words,
})
export type ApprovalsToReview = z.infer<typeof approvalsToReviewSchema>
export type ReviewApproval = ApprovalsToReview['items'][number]

export const fetchApprovalsToReview = (api: ApiClient, orderIds: readonly string[], signal?: AbortSignal): Promise<ApprovalsToReview> =>
  api.get('/portal/production/approvals', { query: { orderIds: orderIds.join(',') }, schema: approvalsToReviewSchema, ...(signal ? { signal } : {}) })

export const approveManyAnswerSchema = z.object({
  results: z.array(
    z.object({
      requestId: z.string(),
      kind: z.enum(APPROVAL_KINDS),
      done: z.boolean(),
      status: z.enum(APPROVAL_STATUSES),
      code: z.enum(APPROVE_ROW_CODES).catch('NOT_DONE').nullable(),
      words,
    }),
  ),
  notFound: z.number(),
  replayed: z.boolean(),
})
export type ApproveManyAnswer = z.infer<typeof approveManyAnswerSchema>

/** Approve N: every ticked approval with its version, one typed name. */
export const approveMany = (api: ApiClient, body: { items: readonly { requestId: string; version: number }[]; typedName: string }, idempotencyKey: string = newIdempotencyKey()): Promise<ApproveManyAnswer> =>
  api.post('/portal/production/approvals/answer', { body, schema: approveManyAnswerSchema, idempotencyKey })

export const askManyAnswerSchema = z.object({
  batchId: z.string(),
  kind: z.enum(ASK_KINDS),
  results: z.array(
    z.object({
      orderId: z.string(),
      number: z.string(),
      customerRef: z.string().nullable(),
      done: z.boolean(),
      requestId: z.string().nullable(),
      /** Why not, as a code (WAITING, NOT_OPEN, PAUSED, NOT_PAUSED, READY, NOT_ASKABLE …); null: asked, or no code. */
      code: z.string().nullable(),
      words,
    }),
  ),
  notFound: z.number(),
  replayed: z.boolean(),
})
export type AskManyAnswer = z.infer<typeof askManyAnswerSchema>

/** Ask N: one kind for every order (a pause says why; a cancel names one of the reasons offered). */
export const askMany = (
  api: ApiClient,
  body: { orderIds: readonly string[]; kind: (typeof ASK_KINDS)[number]; reasonCode?: string; reason?: string },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<AskManyAnswer> => api.post('/portal/production/asks', { body, schema: askManyAnswerSchema, idempotencyKey })
// ---- end F-PR-23b
