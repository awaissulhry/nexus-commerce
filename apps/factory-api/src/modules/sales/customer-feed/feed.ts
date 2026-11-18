import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { scopeWhere, type Actor, type ScopeColumns } from '@nexus/factory-domain/core/permissions'
import {
  CUSTOMER_FEED_BATCH,
  CUSTOMER_FEED_PAGE,
  CUSTOMER_FEED_THREADS,
  customerFeedKindOf,
  customerFeedTypesOf,
  type CustomerFeedKind,
} from '@nexus/factory-domain/sales/customer-feed/kinds'
import { compareNewestFirst, encodeCursor, type FeedAudience, type Positioned, type TimelineCursor } from '@nexus/factory-domain/threads/timeline'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { erasedAmong, feedAudienceWhere, skippedPartsOf } from '../../../platform/threads/feed-depth'
import { recordLabelOf } from '../../../platform/threads/labels'
import { mayOnThread, wallScopesOf } from '../../../platform/threads/records'
import { afterCursor, cursorOf, messageViewOf, NO_LINKS, visibleAttachments } from '../../../platform/threads/threads'
import { officeContextOf } from '../orders/access'
import type { CustomerFeedAnswer, CustomerFeedEntry } from './contract'

/**
 * B-SA-060 (sales page plan R4, P9'; 13-backend B8; 11-customer-page §9.2; 10-order-page §6.2; review C-1, BW-4, F-6) — "All of
 * <Customer>": ONE read-only feed of the messages of the customer's conversations, newest first, in cursor pages of 30.
 *
 *   GET /sales/customers/:partyId/feed?cursor&limit≤30&audience=ALL|PARTNER|OFFICE&kinds=ORDERS,QUOTES,…
 *
 * WHICH CONVERSATIONS. Every thread whose party IS this customer (Thread.partyId, the threads' [tenantId, partyId] index), of the
 * customer-side record types only (factory-domain sales/customer-feed/kinds: the general conversation, orders, shipments, DDTs,
 * invoices, reminders, quotes, requests, projects, sample rounds, after-sales; a rider's measurements behind their gate). Never a
 * work order's, a hold's or an NCR's notes (office only, and a mixed work order's wall is every customer's: they stay in the order
 * dock's picker), no `include=work`, never a supplier record, never a change request's own thread (its talk is its order's
 * conversation, B-SA-048). Each thread is checked as its own read checks it (platform/threads/records.ts mayOnThread over its own
 * scope, with its gate); a thread the reader may not open is counted in `threadsNotShown`, never shown.
 *
 * THE WALL. The customer first: it must exist, be a customer (CUSTOMER or BRAND) and its own conversation must be one the reader may
 * read (mayOnThread on the Party record), else 404 "Customer not found." — the words an unknown customer gets, so a person limited to
 * Brand Beta asking for Brand Alpha learns nothing. Every source is a thread of THIS customer (partyId equality, read on the server):
 * a conversation of another customer is never a source, even when it links this customer's records (a project of Brand Beta that
 * links Brand Alpha's order is Brand Beta's thread). A floor worker's message never names its writer here ("From the floor").
 *
 * THE MERGE. The customer's 500 most recently active conversations the reader may open (Thread.lastMessageAt, which every write moves
 * forward) are merged; older ones are counted (`olderThreads`: "Older conversations: open their record"). A page is a top-k merge
 * (`topK`): the threads by the newest a message after the cursor can be, read 50 at a time in ONE message query each (the
 * [tenantId, threadId, at] index, limit + 1 rows), stopping as soon as no unread thread can still beat the page's last place — usually
 * one or two queries. Cursor = the last entry's (at, id), as the threads' own feeds (factory-domain threads/timeline).
 *
 * WHAT A MESSAGE SHOWS. The thread read's own office message (messageView): its words, its files as the reader's file rules let them
 * see them, an office note's amount only with the price grain, erased after a privacy request, an inbound mail's skipped files. A mail
 * still in its 10 seconds to take it back, or taken back (`held`), never reached the customer: it is left out (its thread shows it).
 * `new`: after the reader's own read mark on that conversation and not written by them — the feed never moves a mark (opening the
 * conversation does). Nothing is written here.
 */

/** A thread as the merge reads it. */
export interface FeedThread {
  readonly id: string
  readonly lastMessageAt: Date
}

/** The newest a message of the thread after the cursor can be: its newest message, no later than the cursor. */
export function mergeKey(thread: FeedThread, cursor: TimelineCursor | null): number {
  const last = thread.lastMessageAt.getTime()
  return cursor ? Math.min(last, cursor.at.getTime()) : last
}

/** The threads in the order their messages can come: the newest possible first (ties: the larger id first, as the feed's order). */
export function mergeOrder<T extends FeedThread>(threads: readonly T[], cursor: TimelineCursor | null): T[] {
  return [...threads].sort((a, b) => mergeKey(b, cursor) - mergeKey(a, cursor) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

/**
 * The page after the cursor: the first `limit` entries of all threads, newest first, and whether more follow. `read` answers the
 * entries of some threads after the cursor, newest first, at most limit + 1. The threads are read `batch` at a time in merge order;
 * the merge stops when it holds limit + 1 entries and the next thread's newest possible entry is older than the last of them
 * (a thread whose key equals that entry's time is still read: an entry of the same instant may have the larger id).
 */
export async function topK<Entry extends Positioned, T extends FeedThread>(
  threads: readonly T[],
  cursor: TimelineCursor | null,
  limit: number,
  batch: number,
  read: (threads: readonly T[]) => Promise<readonly Entry[]>,
): Promise<{ items: Entry[]; more: boolean; reads: number }> {
  const order = mergeOrder(threads, cursor)
  let kept: Entry[] = []
  let index = 0
  let reads = 0
  while (index < order.length) {
    const next = order[index]!
    const last = kept[limit]
    if (last !== undefined && mergeKey(next, cursor) < last.at.getTime()) break
    const slice = order.slice(index, index + Math.max(1, batch))
    index += slice.length
    reads += 1
    kept = [...kept, ...(await read(slice))].sort(compareNewestFirst).slice(0, limit + 1)
  }
  return { items: kept.slice(0, limit), more: kept.length > limit, reads }
}

/** Whether a message is new to the reader: after their read mark on its thread (none: every message), and not their own. */
export function isNewToReader(message: Positioned & { readonly authorId: string | null }, readerId: string, mark: Positioned | null | undefined): boolean {
  if (message.authorId !== null && message.authorId === readerId) return false
  if (!mark) return true
  return compareNewestFirst(message, mark) < 0
}

// ── the read ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A thread's scope columns (nullable: a tenant-wide record, a record of no site): the reader's reach, written as a where. */
const THREAD_SCOPE: ScopeColumns = { company: { field: 'companyId', nullable: true }, site: { field: 'siteId', nullable: true }, party: { field: 'partyId', nullable: true } }

const THREAD_ROW = { id: true, recordType: true, recordId: true, companyId: true, siteId: true, partyId: true, lastMessageAt: true } as const satisfies Prisma.ThreadSelect
type ThreadRow = Prisma.ThreadGetPayload<{ select: typeof THREAD_ROW }>
type MergedThread = ThreadRow & { readonly lastMessageAt: Date }

/** What the feed reads of a message: the thread read's office columns, less the mentions, links and the mail's HTML (open the thread for them). */
const FEED_MESSAGE = {
  id: true,
  threadId: true,
  direction: true,
  audience: true,
  channel: true,
  authorKind: true,
  authorId: true,
  authorName: true,
  bodyText: true,
  attachmentFileIds: true,
  at: true,
  forFloor: true,
  amount: true,
  amountCurrency: true,
} as const satisfies Prisma.MessageSelect
type FeedMessage = Prisma.MessageGetPayload<{ select: typeof FEED_MESSAGE }>

const CUSTOMER_NOT_FOUND = 'Customer not found.'

/** The customer, when the reader may read its own conversation (else the words of an unknown customer). */
async function customerOf(client: FactoryClient, actor: Actor, partyId: string): Promise<{ id: string; code: string; name: string }> {
  const party = await client.party.findUnique({ where: { id: partyId }, select: { id: true, code: true, legalName: true, tradeName: true, companyId: true, roles: true } })
  const customer = party !== null && party.roles.some((role) => role === 'CUSTOMER' || role === 'BRAND')
  if (!party || !customer || !mayOnThread(actor, THREADS_READ, 'Party', { companyId: party.companyId, siteId: null, partyId: party.id })) throw new NotFoundError(CUSTOMER_NOT_FOUND)
  return { id: party.id, code: party.code, name: party.tradeName ?? party.legalName }
}

/** The record chip of each thread on the page: its label, and an order's, quote's or request's own number for the customer. */
async function recordsOf(client: FactoryClient, partyId: string, threads: readonly ThreadRow[]): Promise<Map<string, CustomerFeedEntry['record']>> {
  const out = new Map<string, CustomerFeedEntry['record']>()
  const idsOf = (type: string) => [...new Set(threads.filter((thread) => thread.recordType === type).map((thread) => thread.recordId))]
  const numbered = new Map<string, { number: string | null; customerSeq: number | null }>()
  const keep = (type: string, rows: readonly { id: string; number: string | null; customerSeq: number | null }[]) => {
    for (const row of rows) numbered.set(`${type}:${row.id}`, { number: row.number, customerSeq: row.customerSeq })
  }
  const orders = idsOf('SalesOrder')
  if (orders.length > 0) keep('SalesOrder', await client.salesOrder.findMany({ where: { id: { in: orders }, partyId }, select: { id: true, number: true, customerSeq: true } }))
  const quotes = idsOf('Quote')
  if (quotes.length > 0) keep('Quote', await client.quote.findMany({ where: { id: { in: quotes }, partyId }, select: { id: true, number: true, customerSeq: true } }))
  const inquiries = idsOf('Inquiry')
  if (inquiries.length > 0) keep('Inquiry', await client.inquiry.findMany({ where: { id: { in: inquiries }, partyId }, select: { id: true, number: true, customerSeq: true } }))
  for (const thread of threads) {
    if (out.has(thread.id)) continue
    const key = `${thread.recordType}:${thread.recordId}`
    const own = numbered.get(key)
    const label = own !== undefined ? own.number : ['SalesOrder', 'Quote', 'Inquiry'].includes(thread.recordType) ? null : await recordLabelOf(client, thread.recordType, thread.recordId)
    out.set(thread.id, {
      type: thread.recordType,
      id: thread.recordId,
      label,
      ownNumber: own?.customerSeq ?? null,
      companyId: thread.companyId,
      kind: customerFeedKindOf(thread.recordType)!,
    })
  }
  return out
}

/** The reader's own read mark on each of these threads, as a position (at, id). */
async function marksOf(client: FactoryClient, readerId: string, threadIds: readonly string[]): Promise<Map<string, Positioned>> {
  if (threadIds.length === 0) return new Map()
  const marks = await client.threadRead.findMany({ where: { userId: readerId, threadId: { in: [...threadIds] } }, select: { threadId: true, lastReadMessageId: true } })
  if (marks.length === 0) return new Map()
  const at = new Map((await client.message.findMany({ where: { id: { in: marks.map((mark) => mark.lastReadMessageId) } }, select: { id: true, at: true } })).map((row) => [row.id, row.at] as const))
  const out = new Map<string, Positioned>()
  for (const mark of marks) {
    const when = at.get(mark.lastReadMessageId)
    if (when) out.set(mark.threadId, { at: when, id: mark.lastReadMessageId })
  }
  return out
}

export interface CustomerFeedQuery {
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
  readonly audience?: FeedAudience | undefined
  readonly kinds?: readonly CustomerFeedKind[] | undefined
}

/** GET /sales/customers/:partyId/feed. */
export async function readCustomerFeed(caller: CommandCaller, partyId: string, query: CustomerFeedQuery): Promise<CustomerFeedAnswer> {
  const context: OfficeContext = officeContextOf(caller)
  const actor = actorOf(context)
  const cursor = cursorOf(query.cursor)
  const limit = Math.min(Math.max(1, query.limit ?? CUSTOMER_FEED_PAGE), CUSTOMER_FEED_PAGE)
  const audience: FeedAudience = query.audience ?? 'ALL'
  const types = customerFeedTypesOf(query.kinds)

  return caller.withClient(async (client) => {
    const customer = await customerOf(client, actor, partyId)

    // The customer's conversations of the kinds asked; the 500 most recently active the reader reaches are merged.
    const base: Prisma.ThreadWhereInput = { partyId: customer.id, recordType: { in: types }, lastMessageAt: { not: null } }
    const reached: Prisma.ThreadWhereInput = { AND: [base, scopeWhere(actor, THREADS_READ, THREAD_SCOPE) as Prisma.ThreadWhereInput] }
    const [all, recent] = await Promise.all([
      client.thread.count({ where: base }),
      client.thread.findMany({ where: reached, orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }], take: CUSTOMER_FEED_THREADS + 1, select: THREAD_ROW }),
    ])
    const reachable = recent.length > CUSTOMER_FEED_THREADS ? await client.thread.count({ where: reached }) : recent.length
    const merged = recent.slice(0, CUSTOMER_FEED_THREADS) as MergedThread[]
    const scopes = await wallScopesOf(client, merged)
    // Each conversation as its own read checks it (its scope, its gate: a rider's measurements need sales.measurements.view).
    const readable = merged.filter((thread) => customerFeedKindOf(thread.recordType) !== null && mayOnThread(actor, THREADS_READ, thread.recordType, scopes(thread)))
    const byId = new Map(readable.map((thread) => [thread.id, thread] as const))

    const viewWhere = feedAudienceWhere(audience)
    const page = await topK<FeedMessage, MergedThread>(readable, cursor, limit, CUSTOMER_FEED_BATCH, (threads) =>
      client.message.findMany({
        where: { AND: [{ threadId: { in: threads.map((thread) => thread.id) } }, { held: false }, viewWhere, afterCursor(cursor, 'at') as Prisma.MessageWhereInput] },
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: FEED_MESSAGE,
      }),
    )

    const shown = page.items
    const onPage = [...new Set(shown.map((row) => row.threadId))].map((threadId) => byId.get(threadId)!)
    const [records, marks, attachments, erased, skipped] = await Promise.all([
      recordsOf(client, customer.id, onPage),
      marksOf(client, context.actorId, onPage.map((thread) => thread.id)),
      visibleAttachments(client, context, shown.flatMap((row) => row.attachmentFileIds)),
      erasedAmong(client, shown),
      skippedPartsOf(client, shown),
    ])

    const entries: CustomerFeedEntry[] = shown.map((row) => {
      // A floor worker's message never names its writer here (workerShown false): the card says "From the floor".
      const view = messageViewOf({ ...row, bodyHtml: null }, attachments, false, NO_LINKS)
      const parts = skipped.get(row.id)
      return {
        record: records.get(row.threadId)!,
        new: isNewToReader(row, context.actorId, marks.get(row.threadId)),
        message: { ...view, ...(erased.has(row.id) ? { erased: true } : {}), ...(parts ? { skippedAttachments: parts } : {}) },
      }
    })
    const last = shown.at(-1)
    return {
      customer,
      entries,
      nextCursor: page.more && last ? encodeCursor(last) : null,
      threadsNotShown: all - reachable + (merged.length - readable.length),
      olderThreads: Math.max(0, reachable - CUSTOMER_FEED_THREADS),
    }
  })
}
