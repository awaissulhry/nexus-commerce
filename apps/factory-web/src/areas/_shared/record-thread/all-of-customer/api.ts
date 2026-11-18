import { z } from 'zod'
import { CUSTOMER_FEED_KINDS, CUSTOMER_FEED_PAGE, type CustomerFeedKind } from '@nexus/factory-domain/sales/customer-feed/kinds'
import type { ApiClient } from '../../../../lib/api/client'
import { officeMessageSchema } from '../api'

/**
 * F-SA-261 (sales page plan R4, P9; on B-SA-060) — the ONE call of "All of <Customer>": `GET /sales/customers/:partyId/feed`, a page
 * of the customer's conversations merged newest first (30 a page, cursor), each message the thread read's own office message with
 * its record chip. The answer is checked against the shape the view reads. Read only: nothing here writes.
 */

export const feedRecordSchema = z.object({
  type: z.string(),
  id: z.string(),
  label: z.string().nullable(),
  ownNumber: z.number().int().nullable(),
  companyId: z.string().nullable(),
  kind: z.enum(CUSTOMER_FEED_KINDS),
})
export type FeedRecord = z.infer<typeof feedRecordSchema>

export const feedEntrySchema = z.object({ record: feedRecordSchema, new: z.boolean(), message: officeMessageSchema })
export type FeedEntry = z.infer<typeof feedEntrySchema>

export const feedAnswerSchema = z.object({
  customer: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  entries: z.array(feedEntrySchema),
  nextCursor: z.string().nullable(),
  threadsNotShown: z.number().int(),
  olderThreads: z.number().int(),
})
export type FeedAnswer = z.infer<typeof feedAnswerSchema>

/** What a page is asked with: View ▾ (the audience), Kind ▾ (none: every kind), after a cursor. */
export interface FeedQuery {
  readonly audience: 'ALL' | 'PARTNER' | 'OFFICE'
  readonly kinds: readonly CustomerFeedKind[]
  readonly cursor?: string | null
}

export function readCustomerFeed(api: ApiClient, partyId: string, query: FeedQuery, signal?: AbortSignal): Promise<FeedAnswer> {
  return api.get(`/sales/customers/${encodeURIComponent(partyId)}/feed`, {
    query: { limit: CUSTOMER_FEED_PAGE, audience: query.audience, kinds: query.kinds.length > 0 ? query.kinds.join(',') : undefined, cursor: query.cursor ?? undefined },
    schema: feedAnswerSchema,
    signal,
  })
}
