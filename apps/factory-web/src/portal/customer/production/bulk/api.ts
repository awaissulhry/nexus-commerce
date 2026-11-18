import { z } from 'zod'
import { WITHDRAW_OUTCOMES } from '@nexus/factory-domain/production-brand/bulk'
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
