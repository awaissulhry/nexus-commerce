import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ConflictError, DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { BULK_MAX, BULK_WORDS, type BulkWords } from '@nexus/factory-domain/sales/portal-ordering/bulk'
import { processFiles } from '../../../platform/files/service'
import { discardDraftWithFiles } from './draft-files'
import { sendRequest } from './requests'
import { portalWriter } from './writer'

/**
 * Many drafts at once (owb- order workflow, S1 po2.1; design § 5h "a bin, bulk Delete the drafts", § 5b "Send… one or many drafts"):
 *
 *   POST /portal/order-requests/bulk-delete  { items: [{ id, version }] (1–50) }  — each the single DELETE (portal.orderDrafts.edit):
 *                                             a never-sent draft is discarded with its files; one taken back is withdrawn (G1 (e))
 *   POST /portal/order-requests/bulk-send    { items } — each the single Send (portal.orderRequests.manage)
 *   → { results: [{ id, ok, words: { en, it } | null }] }, one per item in the order asked
 *
 * ONE command per item (today's discardDraftWithFiles / sendRequest), each in its own transaction: one refused item never undoes
 * another. Another customer's id, or an unknown one, is "not found" like a wrong id — nothing of it leaks. An unexpected error
 * stops the batch (a 500, as ever): only refusals are answered per item.
 */

export interface BulkItem {
  readonly id: string
  readonly version: number
}

export interface BulkResult {
  readonly id: string
  readonly ok: boolean
  readonly words: BulkWords | null
}

/** A refusal in both languages: the fixed words of the common kinds, else the command's own words (the person's language) in both. */
function wordsOf(error: DomainError): BulkWords {
  if (error instanceof NotFoundError) return BULK_WORDS.NOT_FOUND
  if (error instanceof ForbiddenError && error.message === 'You may not do this.') return BULK_WORDS.FORBIDDEN
  if (error instanceof ConflictError && /version/i.test(error.message)) return BULK_WORDS.STALE
  return { en: error.message, it: error.message }
}

async function eachItem(items: readonly BulkItem[], idempotencyKey: string | undefined, work: (item: BulkItem, key: string | undefined) => Promise<unknown>): Promise<{ results: BulkResult[] }> {
  if (items.length === 0 || items.length > BULK_MAX) throw new ValidationError(BULK_WORDS.TOO_MANY.en, [{ path: 'body/items', message: BULK_WORDS.TOO_MANY.en }])
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new ValidationError(BULK_WORDS.TWICE.en, [{ path: 'body/items', message: BULK_WORDS.TWICE.en }])
  const results: BulkResult[] = []
  for (const item of items) {
    try {
      await work(item, idempotencyKey ? `${idempotencyKey}:${item.id}` : undefined)
      results.push({ id: item.id, ok: true, words: null })
    } catch (error) {
      if (!(error instanceof DomainError)) throw error
      results.push({ id: item.id, ok: false, words: wordsOf(error) })
    }
  }
  return { results }
}

/** POST /portal/order-requests/bulk-delete (see the file's head). */
export async function bulkDeleteDrafts(app: FastifyInstance, request: FastifyRequest, items: readonly BulkItem[], idempotencyKey?: string): Promise<{ results: BulkResult[] }> {
  const writer = portalWriter(app, request)
  return eachItem(items, idempotencyKey, (item, key) => discardDraftWithFiles(processFiles, writer, item.id, item.version, key))
}

/** POST /portal/order-requests/bulk-send (see the file's head). */
export async function bulkSendDrafts(app: FastifyInstance, request: FastifyRequest, items: readonly BulkItem[], idempotencyKey?: string): Promise<{ results: BulkResult[] }> {
  return eachItem(items, idempotencyKey, (item, key) => sendRequest(app, request, item.id, item.version, key))
}
