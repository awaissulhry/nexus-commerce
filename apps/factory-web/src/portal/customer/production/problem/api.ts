import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { fetchThread, type PartnerMessageRead } from '../../../shell/api'
import { fetchDocuments, type DocumentsRead } from '../../orders/api'

/**
 * F-PR-24 — "Report a problem" (production plan §1, §3 "Issues"; lead picks L24, L25; review fixes R-41, R-42, R-43; the API is
 * B-PR-45, apps/factory-api modules/production/brand-portal/problems.ts):
 *
 *   POST /portal/production/problems              {orderIds 1–50, body}: one message in each of its own orders' threads and our
 *                                                 one task for the batch; one result per OWN order (sent, or why not in words);
 *                                                 an id that is not one of its own orders is only counted (`notFound`), never
 *                                                 named; nothing sent at all: 409; a retry with the same Idempotency-Key sends no
 *                                                 second message
 *   GET  /portal/customer-documents?orderId=      what the message may point to (one order only): the files we shared on the
 *                                                 order and its lines (B-PR-44; confirmations only for roles that see prices)
 *   GET  /portal/threads/SalesOrder/:id           … or a message of the order's conversation (its shared messages only)
 *
 * The answer names no person (R-41): the customer reads "Waiting on us since 16 Nov", then "Answered 17 Nov" once we write in the
 * order's thread — whoever answers signs with their name there, as today.
 */

const words = z.object({ it: z.string(), en: z.string() })

export const problemResultSchema = z.object({
  orderId: z.string(),
  /** The office's own number: read, never drawn (B-TH-303). */
  number: z.string(),
  customerRef: z.string().nullable(),
  done: z.boolean(),
  /** Why it was not sent, in the API's words (null: sent). */
  words: words.nullable(),
  problem: z.object({ state: z.literal('WAITING_ON_US'), since: z.string(), words }).nullable(),
})
export type ProblemResult = z.infer<typeof problemResultSchema>

export const problemAnswerSchema = z.object({ batchId: z.string(), results: z.array(problemResultSchema), notFound: z.number(), replayed: z.boolean() })
export type ProblemAnswer = z.infer<typeof problemAnswerSchema>

/** One report: the same text in each named order's thread (1 to 50 of its own orders, each once). */
export const reportProblem = (api: ApiClient, body: { readonly orderIds: readonly string[]; readonly body: string }, idempotencyKey: string = newIdempotencyKey()): Promise<ProblemAnswer> =>
  api.post('/portal/production/problems', { body: { orderIds: [...body.orderIds], body: body.body }, schema: problemAnswerSchema, idempotencyKey })

/** What one order's message may point to: the files we shared on it, and the messages of its conversation (newest first). */
export interface PointerSources {
  readonly files: DocumentsRead | null
  readonly messages: readonly PartnerMessageRead[]
}

/**
 * Read for ONE order only (many orders: the pointer field is absent). Each source on its own: one the person may not read (no
 * documents right, no conversation) is simply not offered; both failing is said with Try again.
 */
export async function fetchPointerSources(api: ApiClient, orderId: string, can: { readonly files: boolean; readonly messages: boolean }, signal?: AbortSignal): Promise<PointerSources> {
  const [files, thread] = await Promise.allSettled([
    can.files ? fetchDocuments(api, orderId, signal) : Promise.resolve(null),
    can.messages ? fetchThread(api, 'SalesOrder', orderId, null, signal) : Promise.resolve(null),
  ])
  const anyAsked = can.files || can.messages
  if (anyAsked && (!can.files || files.status === 'rejected') && (!can.messages || thread.status === 'rejected')) throw new Error('the pointers could not be read')
  return {
    files: files.status === 'fulfilled' ? files.value : null,
    // The API pages them newest first.
    messages: thread.status === 'fulfilled' && thread.value ? thread.value.messages : [],
  }
}
