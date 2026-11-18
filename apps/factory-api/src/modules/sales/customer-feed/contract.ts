import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { CUSTOMER_FEED_KINDS, CUSTOMER_FEED_PAGE, type CustomerFeedKind } from '@nexus/factory-domain/sales/customer-feed/kinds'
import { FEED_AUDIENCES } from '@nexus/factory-domain/threads/timeline'
import { messageView } from '../../../platform/threads/contract'

/**
 * GET /sales/customers/:partyId/feed (B-SA-060; sales page plan R4, P9'; 13-backend B8; review C-1, BW-4, F-6): "All of <Customer>",
 * the messages of the customer's conversations merged in one read-only feed, newest first, in cursor pages of 30 (./feed.ts).
 * Each entry is the conversation's own message (the thread read's `messageView`, office face) with its record chip: the record's
 * type, id, label (its number), the customer's own number of an order, quote or request ("Your order 12") and its kind. Nothing is
 * written here: a reply always opens ONE conversation.
 */

export const customerFeedKinds = z
  .string()
  .max(120)
  .optional()
  .transform((value, context) => {
    if (value === undefined || value.trim() === '') return [] as CustomerFeedKind[]
    const kinds = [...new Set(value.split(',').map((kind) => kind.trim()))]
    const unknown = kinds.filter((kind) => !(CUSTOMER_FEED_KINDS as readonly string[]).includes(kind))
    if (unknown.length > 0) context.addIssue({ code: 'custom', message: `Expected ${CUSTOMER_FEED_KINDS.join(', ')}.` })
    return kinds as CustomerFeedKind[]
  })

const feedRecord = output({
  type: z.string(),
  id: id(),
  /** Its number or code as the office reads it ("SO-2026-0142"); null: the record is no longer there for the reader. */
  label: z.string().nullable(),
  /** The customer's own running number of an order, quote or request ("Your order 12"); null: none (or another record type). */
  ownNumber: z.number().int().nullable(),
  /** The record's company (where its page opens); null: tenant-wide. */
  companyId: id().nullable(),
  kind: z.enum(CUSTOMER_FEED_KINDS),
})

export const customerFeedEntry = output({
  record: feedRecord,
  /** New to the reader: after their own read mark on that conversation, and not written by them (a mark is never moved here). */
  new: z.boolean(),
  message: messageView,
})

export const customerFeedContract = defineContract({
  params: input({ partyId: id() }),
  querystring: input({
    /** `nextCursor` of the previous page. */
    cursor: z.string().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(CUSTOMER_FEED_PAGE).default(CUSTOMER_FEED_PAGE),
    /** View ▾: ALL, PARTNER ("With the customer") or OFFICE ("Office notes"). */
    audience: z.enum(FEED_AUDIENCES).default('ALL'),
    /** Kind ▾: a comma-separated list of ORDERS, QUOTES, REQUESTS, GENERAL, PROJECTS, AFTER_SALES. Default every kind. */
    kinds: customerFeedKinds,
  }),
  response: {
    200: output({
      customer: output({ id: id(), code: z.string(), name: z.string() }),
      entries: z.array(customerFeedEntry),
      nextCursor: z.string().nullable(),
      /** Conversations of this customer (of the kinds asked) the reader may not open: counted, never shown ("2 conversations you cannot open"). */
      threadsNotShown: z.number().int(),
      /** Conversations the reader may open beyond the most recently active 500 the feed merges: "Older conversations: open their record". */
      olderThreads: z.number().int(),
    }),
  },
})
export type CustomerFeedAnswer = z.infer<(typeof customerFeedContract)['response'][200]>
export type CustomerFeedEntry = z.infer<typeof customerFeedEntry>
