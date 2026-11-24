import { CUSTOMER_FEED_KINDS, customerFeedKindOf, type CustomerFeedKind } from '@nexus/factory-domain/sales/customer-feed/kinds'
import { cardDepth, messageLink, type CardContext, type CardMessage } from '../../../../lib/record-thread/card/model'
import { runPlace, type RunPlace } from '../../../../lib/record-thread/feed/runs' // tw- W2.5: the thread's own run rule
import { cardOf } from '../../../../lib/record-thread/model'
import { recordAddress } from '../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import type { FeedAnswer, FeedEntry, FeedQuery, FeedRecord } from './api'

/**
 * F-SA-261 (sales page plan R4, P9, N4, N5; 10-order-page §6.2, 11-customer-page §9.2; review C-1, C-13, BW-4) — "All of <Customer>",
 * the rules of the read-only merged view, pure: what a page of `GET /sales/customers/:partyId/feed` becomes on screen.
 *
 *   each message the thread's own bubble, READ ONLY (tw- W2.5: MessageCard `readOnly` — its words, files, foot; its menu Answer in
 *                its thread · Copy text · Copy link), oldest at the top; a record chip — "SO-0142 · Your order 12", "<Customer>
 *                (general)", "QT-0031 · Your quote 3", "PRJ-0004 …" — on top of each record's run; a "New" mark when it is new
 *   doors        "Answer" (F-OP-216; the host switches the dock to that record's ONE thread, at that message) and the chip,
 *                a real link to the record's page (⌘-click: a new tab); nothing is written from here
 *   never jumps  a live hint reads the newest page again in the background; what is newer than the top waits behind "N new · Show"
 *                (the list moves only when the person asks), Show older adds the next page at the top (tw- W2.5), without a gap or a repeat
 *   filters      View ▾ All · With the customer · Office notes (the API's audience) and Kind ▾ (one kind, or every kind)
 *   read marks   seeing a line here marks nothing read ("Open a conversation to mark it read")
 */

// ── View ▾ and Kind ▾ ───────────────────────────────────────────────────────────────────────────────────────────────────

/** View ▾: every message, the ones with the customer, the office notes. */
export const FEED_VIEWS = ['all', 'shared', 'notes'] as const
export type FeedView = (typeof FEED_VIEWS)[number]

/** The API's audience of a view. */
export const audienceOfView = (view: FeedView): FeedQuery['audience'] => (view === 'shared' ? 'PARTNER' : view === 'notes' ? 'OFFICE' : 'ALL')

/** Kind ▾: every kind, or one of the feed's kinds. */
export type FeedKindChoice = 'every' | CustomerFeedKind
export const FEED_KIND_CHOICES: readonly FeedKindChoice[] = ['every', ...CUSTOMER_FEED_KINDS]
export const kindsOfChoice = (choice: FeedKindChoice): CustomerFeedKind[] => (choice === 'every' ? [] : [choice])

// ── the state of the feed ───────────────────────────────────────────────────────────────────────────────────────────────

export interface FeedState {
  /** idle: not asked yet · loading: the first page · ready · failed: the read failed (Try again) · gone: not this reader's customer. */
  readonly status: 'idle' | 'loading' | 'ready' | 'failed' | 'gone'
  /** What the list shows, newest first. */
  readonly entries: readonly FeedEntry[]
  /** Where Show older continues (null: nothing older). */
  readonly cursor: string | null
  readonly older: 'idle' | 'loading' | 'failed'
  /** The newest page read again on a live hint: what of it is newer than the top waits behind "N new · Show". */
  readonly fresh: FeedAnswer | null
  readonly customer: FeedAnswer['customer'] | null
  readonly threadsNotShown: number
  readonly olderThreads: number
}

export const EMPTY_FEED: FeedState = Object.freeze({ status: 'idle', entries: [], cursor: null, older: 'idle', fresh: null, customer: null, threadsNotShown: 0, olderThreads: 0 })

const time = (entry: FeedEntry): number => Date.parse(entry.message.at)

/** Newest first: the later time, then the larger id (the API's own order). */
export function compareEntries(a: FeedEntry, b: FeedEntry): number {
  const diff = time(b) - time(a)
  if (diff !== 0) return diff
  return a.message.id < b.message.id ? 1 : a.message.id > b.message.id ? -1 : 0
}

/** The first page (a first read, a new View or Kind, Try again): the list starts again. */
export function afterFirst(state: FeedState, answer: FeedAnswer): FeedState {
  return { ...state, status: 'ready', entries: answer.entries, cursor: answer.nextCursor, older: 'idle', fresh: null, customer: answer.customer, threadsNotShown: answer.threadsNotShown, olderThreads: answer.olderThreads }
}

/** Show older: the next page at the foot (a message already shown is never shown twice). */
export function afterOlder(state: FeedState, answer: FeedAnswer): FeedState {
  const shown = new Set(state.entries.map((entry) => entry.message.id))
  return { ...state, entries: [...state.entries, ...answer.entries.filter((entry) => !shown.has(entry.message.id))], cursor: answer.nextCursor, older: 'idle' }
}

/** The entries of the newest page that are newer than the top of the list and not shown yet: "N new · Show". */
export function pendingOf(state: FeedState): FeedEntry[] {
  if (!state.fresh) return []
  const top = state.entries[0]
  const shown = new Set(state.entries.map((entry) => entry.message.id))
  return state.fresh.entries.filter((entry) => !shown.has(entry.message.id) && (top === undefined || compareEntries(entry, top) < 0))
}

/**
 * The newest page read again on a live hint. Nothing shown yet: it is the list (nothing can jump). Otherwise the list stays as it
 * is and the page waits; the counts follow at once.
 */
export function afterFresh(state: FeedState, answer: FeedAnswer): FeedState {
  if (state.status !== 'ready' || state.entries.length === 0) return afterFirst(state, answer)
  return { ...state, fresh: answer, customer: answer.customer, threadsNotShown: answer.threadsNotShown, olderThreads: answer.olderThreads }
}

/**
 * "N new · Show": the waiting ones on top. When the newest page does not reach the top of the list any more (more came than a page),
 * the list starts again from that page, so no message is ever skipped between the two.
 */
export function showFresh(state: FeedState): FeedState {
  if (!state.fresh) return state
  const shown = new Set(state.entries.map((entry) => entry.message.id))
  const meets = state.fresh.entries.some((entry) => shown.has(entry.message.id)) || state.fresh.nextCursor === null
  if (!meets) return afterFirst(state, state.fresh)
  return { ...state, entries: [...pendingOf(state), ...state.entries].sort(compareEntries), fresh: null }
}

/**
 * A live hint that may concern the feed: a message posted on a conversation of a customer-side record type (the hint names no party).
 * F-OP-208 (R-1: party ids never reach the browser, so the hint cannot say whose customer it is): a message on a record the list
 * holds (`held`: its `Type:id` keys) always reads again; any other keeps the rule above (a customer-side type — a new thread of this
 * customer may begin; the server sends a thread's event only to readers who reach its customer).
 */
export function liveTouches(change: { readonly type: string; readonly fields: Readonly<Record<string, unknown>> }, held: ReadonlySet<string> = new Set()): boolean {
  if (change.type !== 'thread.message_posted') return false
  const type = change.fields.recordType
  const id = change.fields.recordId
  if (typeof type === 'string' && typeof id === 'string' && held.has(`${type}:${id}`)) return true
  return typeof type === 'string' && customerFeedKindOf(type) !== null
}

// ---- F-OP-208 (order page plan N4; 11-dock §3.6, D8): a revisit keeps the list. The container stays mounted with the dock: leaving
// All of <customer> keeps its lines, its View and Kind and where the list was scrolled; coming back draws them at once and reads the
// newest page in the background (what is newer waits behind "N new · Show"); the skeleton only on the first visit or a new View / Kind.

/** The records the list holds, as `Type:id` (what a live hint is matched against). */
export const heldRecordsOf = (state: Pick<FeedState, 'entries'>): ReadonlySet<string> => new Set(state.entries.map((entry) => `${entry.record.type}:${entry.record.id}`))

/** The key of a list: its customer, its View and its Kind (another key starts the list again). */
export const listKeyOf = (partyId: string | null, view: FeedView, kind: FeedKindChoice): string => `${partyId ?? ''}|${view}|${kind}`

/** What showing the list asks: a fresh read behind "N new" when it holds the same list (a revisit), else the first page again. */
export function onShowOf(state: Pick<FeedState, 'status'>, heldKey: string | null, key: string): 'fresh' | 'first' {
  return state.status === 'ready' && heldKey === key ? 'fresh' : 'first'
}

/** Live hints folded into one read: each hint waits `wait` ms, and hints meanwhile join it (one read per burst). */
export function freshFolder(read: () => void, wait: number) {
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    hint: () => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        read()
      }, wait)
    },
    cancel: () => {
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
// ---- end F-OP-208

// ── one line ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A text of the catalogue (`record-thread`), with its values. */
export interface Words {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

/** The customer's own numbers' kinds, by record type ("Your order 12"). */
const OWN_NUMBER: Readonly<Record<string, 'ORDER' | 'QUOTE' | 'REQUEST'>> = Object.freeze({ SalesOrder: 'ORDER', Quote: 'QUOTE', Inquiry: 'REQUEST' })

/** The chip of a line: the general conversation by the customer's name; any other record by its number, and the customer's own number. */
export function chipOf(record: FeedRecord, customerName: string): Words {
  if (record.type === 'Party') return { key: 'allOfCustomer.chip.general', params: { customer: customerName } }
  const own = OWN_NUMBER[record.type]
  if (record.label === null) return { key: 'allOfCustomer.chip.unnamed' }
  if (own && record.ownNumber !== null) return { key: `allOfCustomer.chip.own.${own}`, params: { number: record.label, seq: record.ownNumber } }
  return { key: 'allOfCustomer.chip.number', params: { number: record.label } }
}

// ---- F-OP-305 (order page walk #13): a record the read could not name (it is no longer there: deleted, or no longer this customer's)
// keeps its true words ("A record no longer there") and offers no door — no chip link, no Answer, no Open: nothing leads to it.
export const isGoneRecord = (record: Pick<FeedRecord, 'label'>): boolean => record.label === null
// ---- end F-OP-305

/** The record's page (its own page when built, else its panels), company-free address under the host's prefix. */
export function recordHrefOf(record: FeedRecord, prefix: string): string {
  return `${prefix}${recordAddress({ type: record.type, id: record.id, ...(record.label ? { label: record.label } : {}), companyId: record.companyId }, OFFICE_PAGES)}`
}

/** The message on its record's page (`?message=<id>`: the record opens with that message, the bell's form). */
export const messageHrefOf = (entry: FeedEntry, prefix: string): string => messageLink(recordHrefOf(entry.record, prefix), entry.message.id)

/** The card of a message: the thread's own card (no mail state, no mentions: open the thread for them); `me` puts mine on the right. */
export function cardOfEntry(entry: FeedEntry, me?: string): CardMessage {
  return { ...cardOf(entry.message, { emails: new Map(), names: new Map(), ...(me ? { me } : {}) }), ...cardDepth(entry.message), mentions: [] }
}

// ── the view model ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FeedItem {
  readonly key: string
  readonly record: FeedRecord
  readonly chip: Words
  readonly card: CardMessage
  readonly isNew: boolean
  /** The record's page (the chip; ⌘-click opens a new tab). */
  readonly href: string
  /** The message on its record's page (the door when the host has no dock to switch). */
  readonly messageHref: string
  /** F-OP-305: the record is no longer there — its chip is words only and the line has no door. */
  readonly gone: boolean
}

export interface AllOfCustomerModel {
  readonly customerName: string
  readonly status: FeedState['status']
  readonly items: readonly FeedItem[]
  /** How many newer messages wait behind "N new · Show". */
  readonly pending: number
  /** Show older is offered. */
  readonly more: boolean
  readonly older: FeedState['older']
  readonly threadsNotShown: number
  readonly olderThreads: number
  readonly view: FeedView
  readonly kind: FeedKindChoice
  /** What every card shares (the customer's name on their side; files open with files.read; no reply here). */
  readonly card: CardContext
  /** F-OP-208: where the list was scrolled when it was last shown (a revisit draws it there again); 0: its top. */
  readonly scrollTop: number
}

export function feedModel(
  state: FeedState,
  input: { readonly customerName: string; readonly prefix: string; readonly view: FeedView; readonly kind: FeedKindChoice; readonly canReadFiles: boolean; readonly scrollTop?: number; /* tw- W2.5 */ readonly me?: string },
): AllOfCustomerModel {
  const name = state.customer?.name ?? input.customerName
  return {
    customerName: name,
    status: state.status,
    items: state.entries.map((entry) => ({
      key: entry.message.id,
      record: entry.record,
      chip: chipOf(entry.record, name),
      card: cardOfEntry(entry, input.me),
      isNew: entry.new,
      href: recordHrefOf(entry.record, input.prefix),
      messageHref: messageHrefOf(entry, input.prefix),
      gone: isGoneRecord(entry.record), // F-OP-305
    })),
    pending: pendingOf(state).length,
    more: state.cursor !== null,
    older: state.older,
    threadsNotShown: state.threadsNotShown,
    olderThreads: state.olderThreads,
    view: input.view,
    kind: input.kind,
    card: { partyName: name, canReadFiles: input.canReadFiles, canReply: false },
    scrollTop: input.scrollTop ?? 0, // F-OP-208
  }
}

/** A click on a link that the browser should open itself (a new tab, a new window, a download): never taken over by the dock. */
export const opensItself = (event: { readonly metaKey: boolean; readonly ctrlKey: boolean; readonly shiftKey: boolean; readonly altKey: boolean; readonly button: number }): boolean =>
  event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0

// ---- tw- W2.5 (THE THREAD REBUILD; 10-design §9, S1 "one face"; replaces F-OP-205's compact lines): the SAME bubbles as a thread —
// oldest at the top, the newest at the bottom; a run ends where the record changes (then the thread's own rule: the sender, who reads
// it, the day), and the record's chip sits on top of the first bubble of each record's run.

export interface FeedRow {
  readonly item: FeedItem
  /** The first message of a run of one record: its chip on top. */
  readonly recordStart: boolean
  /** Its place in its run (the tile and the name on the first, the tail). */
  readonly place: RunPlace
}

const sameRecord = (a: FeedItem | undefined, b: FeedItem | undefined): boolean => Boolean(a && b && a.record.type === b.record.type && a.record.id === b.record.id)

/** The model's items (newest first, as the API pages them) as the feed draws them: oldest first, each with its place. */
export function feedRowsOf(items: readonly FeedItem[]): FeedRow[] {
  const shown = [...items].reverse()
  return shown.map((item, index) => {
    const previous = shown[index - 1]
    const next = shown[index + 1]
    return {
      item,
      recordStart: !sameRecord(previous, item),
      place: runPlace(sameRecord(previous, item) ? previous!.card : null, item.card, sameRecord(next, item) ? next!.card : null),
    }
  })
}

// ---- end tw- W2.5

// ---- F-OP-207 (order page plan N4; 11-dock §3.2, §3.4; pick P7: no merged composer): a line's door. Answer — for a line of a thread
// the dock can write in (the order page: this order, its customer's general thread, a linked project; the customer page: its general
// thread, the record picked) — opens THAT thread at the message with the box focused: Reply when the customer wrote it (the card's own
// Reply: they read the answer), Office note otherwise. Any other record's line opens its record's page at the message ("Open …").
// Answer never writes anywhere but a thread of this customer (the host says which threads it can show).

export type FeedDoor =
  | { readonly kind: 'answer'; readonly ask: { readonly record: { readonly type: string; readonly id: string }; readonly messageId: string; readonly mode: 'reply' | 'note' } }
  | { readonly kind: 'open'; readonly href: string }

export function answerOf(item: Pick<FeedItem, 'record' | 'key' | 'card' | 'messageHref' | 'gone'>, answerable: (record: { readonly type: string; readonly id: string }) => boolean): FeedDoor | null {
  if (item.gone) return null // F-OP-305: no door to a record that is no longer there
  const record = { type: item.record.type, id: item.record.id }
  if (!answerable(record)) return { kind: 'open', href: item.messageHref }
  return { kind: 'answer', ask: { record, messageId: item.key, mode: item.card.kind === 'theirs' ? 'reply' : 'note' } }
}
// ---- end F-OP-207
