import { answersOf, waitingWords } from '../../../../lib/record-thread/head/model'
import type { BuyingCan, Phrase } from '../../../_shared/buying/model'
import type { OrderRow, OrderSummary, WaitingReply } from '../api'

/**
 * B-TH-240 — Purchasing › Orders "Supplier replies" (threads plan TH-3, X-PUR-ORD-LIST.grid-F01; back end B-TH-047), pure: the buying
 * side of the one office inbox. The saved view lists the purchase orders whose conversation waits on us — the supplier's message is
 * the newest SHARED one (the one waiting rule, factory-domain threads/waiting: an office note never flips it; our reply takes the
 * row off) — and each row says who wrote, when, the first words and how long it waits (working time on the order's company
 * calendar, amber past 3 working days).
 *
 * Brand wall (W19, W27, W36): the API lists only orders the reader may open (threads.read AND purchasing.view over each order); the
 * web never draws a waiting row for an order that is not on the page it was given (`repliesByOrder`), and a reply cell is built
 * from the conversation's own facts only — the supplier, its author's name, its first words, its time — never a customer or brand
 * of the order's lines (`replyCell`). A reader without threads.read sees neither the view, nor its tile, nor the New messages
 * column: the API would count 0 for them, and "0" is never said for "not known" (the design's rule).
 */

/** The view's id (model.ts ORDER_VIEWS). */
export const REPLIES_VIEW = 'supplierReplies' as const

/** The most pages of waiting rows one read brings (100 each: the API's own cap of 1000 candidates). */
export const REPLIES_PAGES = 10

/** The waiting rows read for the page's orders: loading, ready (by order id), or why not. */
export type RepliesPart =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly byOrder: Readonly<Record<string, WaitingReply>>; readonly complete: boolean }
  | { readonly status: 'error'; readonly problem: string }

/** Only a reader of conversations has the view, its tile and the New messages column. */
export const showsReplies = (can: Pick<BuyingCan, 'threads'>): boolean => can.threads

/** The saved views a reader is offered (Rows ▾): Supplier replies only for a reader of conversations. */
export const viewsFor = <View extends string>(views: readonly View[], can: Pick<BuyingCan, 'threads'>): View[] => views.filter((view) => view !== REPLIES_VIEW || showsReplies(can))

/** The tiles a reader is shown: the same rule. */
export const tilesFor = <Tile extends { readonly view: string }>(tiles: readonly Tile[], can: Pick<BuyingCan, 'threads'>): Tile[] => tiles.filter((tile) => tile.view !== REPLIES_VIEW || showsReplies(can))

/**
 * The waiting rows by order, ONLY for the orders on the page (a purchase order's conversation: recordType PurchaseOrder). A waiting
 * row of an order the list did not give is never drawn (W27): the list is the reader's own answer, the waiting read only adds words.
 */
export function repliesByOrder(rows: readonly WaitingReply[], orders: ReadonlyArray<Pick<OrderRow, 'id'>>): Record<string, WaitingReply> {
  const onPage = new Set(orders.map((order) => order.id))
  const byOrder: Record<string, WaitingReply> = {}
  for (const row of rows) if (row.recordType === 'PurchaseOrder' && onPage.has(row.recordId) && !byOrder[row.recordId]) byOrder[row.recordId] = row
  return byOrder
}

/** The order's thread, at the message that waits when one is named (`?tab=activity` opens the record's conversation). */
export function threadHref(prefix: string, orderId: string, messageId?: string | null): string {
  return `${prefix}/purchasing/orders/${encodeURIComponent(orderId)}?tab=activity${messageId ? `&message=${encodeURIComponent(messageId)}` : ''}`
}

/** How long it waits, short, by the rule's own clock (working time on the calendar; clock time when the API counted none). */
export function replyWait(reply: Pick<WaitingReply, 'waiting'>, now: number = Date.now()): Phrase {
  const words = waitingWords(answersOf({ on: 'US', ...reply.waiting })!, now)
  return { key: `replies.${words.key}`, params: { n: words.n } }
}

/** The Supplier wrote cell: who (the supplier's person, else the supplier), the first words, when — from the conversation alone. */
export interface ReplyCell {
  readonly who: string
  readonly excerpt: string
  readonly at: string
  readonly wait: Phrase
  /** Past 3 working days waiting on us (the one rule, said by the API). */
  readonly amber: boolean
  readonly tip: Phrase
  readonly href: string
}

export function replyCell(reply: WaitingReply, prefix: string, now: number = Date.now()): ReplyCell {
  const who = reply.lastMessage.authorName?.trim() || reply.party.name
  return {
    who,
    excerpt: reply.lastMessage.excerpt,
    at: reply.lastMessage.at,
    wait: replyWait(reply, now),
    amber: reply.waiting.amber,
    tip: { key: reply.waiting.calendar ? 'replies.tipWorking' : 'replies.tipClock', params: { days: reply.waiting.thresholdDays } },
    href: threadHref(prefix, reply.recordId, reply.lastMessage.id),
  }
}

/**
 * The Supplier replies tile and band count: the API's number, or "—" when it is not known (no summary yet, or a reader without
 * threads.read — the API says 0 for them, which would read as "nothing waits").
 */
export function repliesValue(summary: Pick<OrderSummary, 'supplierReplies'> | null, can: Pick<BuyingCan, 'threads'>): string {
  if (!summary || !showsReplies(can) || summary.supplierReplies === undefined) return '—'
  return String(summary.supplierReplies)
}

/** The line above the view's rows: how many wait on us, or why the cells are partial or could not be read. */
export function repliesLine(summary: Pick<OrderSummary, 'supplierReplies'> | null, part: RepliesPart | null | undefined, can: Pick<BuyingCan, 'threads'>): Phrase {
  if (!showsReplies(can)) return { key: 'replies.noThreads' }
  if (part?.status === 'error') return { key: 'replies.readFailed' }
  const value = summary?.supplierReplies
  if (value === undefined) return { key: 'replies.countUnknown' }
  if (part?.status === 'ready' && !part.complete) return { key: 'replies.countPartial', params: { count: value } }
  return { key: 'replies.count', params: { count: value } }
}

/** The view's own empty words: nothing waits (it is not an error), or the reader cannot read conversations. */
export function repliesEmpty(can: Pick<BuyingCan, 'threads'>, searched: boolean): { readonly title: Phrase; readonly body: Phrase } | null {
  if (searched) return null
  if (!showsReplies(can)) return { title: { key: 'replies.empty.noThreadsTitle' }, body: { key: 'replies.empty.noThreadsBody' } }
  return { title: { key: 'replies.empty.title' }, body: { key: 'replies.empty.body' } }
}

/** The order's thread for the New messages door (the thread opens at "New since your last visit"). */
export const newMessagesHref = (prefix: string, orderId: string): string => threadHref(prefix, orderId)
