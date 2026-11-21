import type { Order } from '../api'
import { knownIds } from '../model'

/**
 * F-SA-239 (sales page plan N2, N3, picks P17, R9; 10-order-page §2 "Live"; review C-18, C-21) — the order page live, part by part,
 * without a screen:
 *
 *   which events   the order read's own watch list (`live.events`, the server's: B-SA-034) — each type with the parts of the page it
 *                  re-reads (LIVE_PREFIXES went: a new event joins on the server, never here); an event counts only when its fields
 *                  name the order or one of its own records (`live.ids`, the chain): a message is a hint, the page reads again.
 *   one table      every live step of the plan coalesces the same way (C-18): the page's parts 700 ms after the first event of a burst;
 *                  the piece counts (the floor's scans, cuts, bundles, releases) 3 s after the LAST event, and at most one read in 10 s
 *                  (the server keeps them a minute: "Pieces as of …" says so). A burst never drops its last event.
 *   stale tabs     Money, Shipments and Files read again only while they show; else they are marked stale and read when opened.
 *   typed work     while a dialog with typed work or the amend draft is open, the order is NOT read again under it: the page says
 *                  "Changed by <name> at hh:mm · Reload" (the order read's own `lastChange`; the draft is kept). The rest reads on.
 */

/** The parts of the order page an event re-reads (the API's ORDER_PAGE_PARTS). */
// F-PT-303 (B-PT-017): + 'materials' — the customer's goods received or used, what we buy reserved or issued (Production › Materials).
export const ORDER_PAGE_PARTS = ['order', 'headline', 'lines', 'work', 'dates', 'quality', 'people', 'changes', 'money', 'shipments', 'files', 'materials'] as const
export type OrderPagePart = (typeof ORDER_PAGE_PARTS)[number]

/** The ONE coalesce table of the plan (C-18). */
export const COALESCE = Object.freeze({ partsMs: 700, piecesTrailingMs: 3_000, piecesAtMostEveryMs: 10_000 })

/** The floor's events: their re-read is the piece counts' lane (3 s trailing, ≤ 1 read / 10 s). */
export const PIECE_EVENTS: ReadonlySet<string> = new Set(['production.cut_logged', 'production.cut_reversed', 'production.bundle_created', 'production.bundle_voided', 'production.bundle_split', 'production.scan_recorded', 'quality.garments_released', 'quality.release_reversed'])

/** The parts that read again only while their tab shows (else marked stale). */
export const TAB_PARTS: Readonly<Partial<Record<OrderPagePart, string>>> = Object.freeze({ money: 'money', shipments: 'shipments', files: 'files' })

export interface LiveWatch {
  readonly events: readonly { readonly type: string; readonly parts: readonly string[] }[]
  readonly ids: Readonly<Record<string, readonly string[]>>
}

/** Every id a live event's fields name (a string, or a list of strings). */
function idsOf(fields: Readonly<Record<string, unknown>>): string[] {
  return Object.values(fields).flatMap((value) => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []))
}

/** The ids the page's events may name: the order, its chain, and the read's own watch ids. */
export function watchedIds(order: Order, live: LiveWatch | null | undefined): Set<string> {
  const ids = knownIds(order)
  for (const list of Object.values(live?.ids ?? {})) for (const id of list) ids.add(id)
  return ids
}

/**
 * The parts one event re-reads: none when the type is not in the read's watch list or its fields name none of the order's records;
 * with no watch list (an older answer) only the order itself, on an event that names it.
 */
export function partsOf(change: { readonly type: string; readonly fields: Readonly<Record<string, unknown>> }, live: LiveWatch | null | undefined, ids: ReadonlySet<string>): OrderPagePart[] {
  if (!idsOf(change.fields).some((id) => ids.has(id))) return []
  if (!live) return ['order']
  const entry = live.events.find((event) => event.type === change.type)
  if (!entry) return []
  return entry.parts.filter((part): part is OrderPagePart => (ORDER_PAGE_PARTS as readonly string[]).includes(part))
}

// ---- the queue: what to read and when (pure, so a test steps the clock) -----------------------------------------------------------

export interface LiveQueue {
  /** The parts waiting in the 700 ms lane, and when that lane is due (null: nothing waits). */
  readonly parts: readonly OrderPagePart[]
  readonly partsDue: number | null
  /** The piece counts' parts waiting, when the last floor event came, and when they were last read. */
  readonly pieces: readonly OrderPagePart[]
  readonly lastPieceEvent: number | null
  readonly lastPiecesRead: number | null
  /** Parts of a tab that is not showing: read when it opens. */
  readonly stale: readonly OrderPagePart[]
}

export const EMPTY_QUEUE: LiveQueue = Object.freeze({ parts: [], partsDue: null, pieces: [], lastPieceEvent: null, lastPiecesRead: null, stale: [] })

const union = (a: readonly OrderPagePart[], b: readonly OrderPagePart[]): OrderPagePart[] => [...new Set([...a, ...b])]

/** An event's parts into the queue at `now` (the tab now showing decides what is stale). */
export function enqueue(queue: LiveQueue, type: string, parts: readonly OrderPagePart[], now: number, tab: string): LiveQueue {
  if (parts.length === 0) return queue
  const off = parts.filter((part) => TAB_PARTS[part] !== undefined && TAB_PARTS[part] !== tab)
  const on = parts.filter((part) => !off.includes(part))
  const next: LiveQueue = { ...queue, stale: union(queue.stale, off) }
  if (on.length === 0) return next
  if (PIECE_EVENTS.has(type)) return { ...next, pieces: union(next.pieces, on), lastPieceEvent: now }
  return { ...next, parts: union(next.parts, on), partsDue: next.partsDue ?? now + COALESCE.partsMs }
}

/** When the piece counts' lane is due: 3 s after the last floor event, never sooner than 10 s after the last read. */
export function piecesDue(queue: LiveQueue): number | null {
  if (queue.pieces.length === 0 || queue.lastPieceEvent === null) return null
  const trailing = queue.lastPieceEvent + COALESCE.piecesTrailingMs
  return queue.lastPiecesRead === null ? trailing : Math.max(trailing, queue.lastPiecesRead + COALESCE.piecesAtMostEveryMs)
}

/** The next moment something is due (the page sets one timer for it). */
export function nextDue(queue: LiveQueue): number | null {
  const due = [queue.partsDue, piecesDue(queue)].filter((at): at is number => at !== null)
  return due.length === 0 ? null : Math.min(...due)
}

/** What to read at `now`, and the queue after it (a lane not due keeps waiting; nothing is dropped). */
export function take(queue: LiveQueue, now: number): { readonly read: readonly OrderPagePart[]; readonly queue: LiveQueue } {
  let read: OrderPagePart[] = []
  let next = queue
  if (queue.partsDue !== null && queue.partsDue <= now) {
    read = union(read, queue.parts)
    next = { ...next, parts: [], partsDue: null }
  }
  const pieces = piecesDue(queue)
  if (pieces !== null && pieces <= now) {
    read = union(read, queue.pieces)
    next = { ...next, pieces: [], lastPieceEvent: null, lastPiecesRead: now }
  }
  return { read, queue: next }
}

/** A tab opens: its stale parts are read now (and leave the stale list). */
export function opened(queue: LiveQueue, tab: string): { readonly read: readonly OrderPagePart[]; readonly queue: LiveQueue } {
  const read = queue.stale.filter((part) => TAB_PARTS[part] === tab)
  return read.length === 0 ? { read, queue } : { read, queue: { ...queue, stale: queue.stale.filter((part) => !read.includes(part)) } }
}

/** The order is read under typed work only after Reload: these parts wait (the rest — production's — read on). */
export const ORDER_PARTS: readonly OrderPagePart[] = ['order', 'lines', 'changes', 'money', 'shipments']

/** "Changed by <name> at hh:mm": who changed the touched part last (the order read's `lastChange`), else nobody named. */
export function changedBy(lastChange: Order['lastChange'] | undefined, parts: readonly OrderPagePart[], locale: 'it' | 'en'): { readonly name: string | null; readonly at: string | null } {
  if (!lastChange) return { name: null, at: null }
  const keys: readonly (keyof NonNullable<Order['lastChange']>)[] = parts.includes('changes') ? ['changes', 'order'] : parts.includes('money') ? ['money', 'order'] : parts.includes('shipments') ? ['shipments', 'order'] : ['order']
  const found = keys.map((key) => lastChange[key]).find((entry) => !!entry) ?? null
  return found ? { name: locale === 'it' ? found.by.words.it : found.by.words.en, at: found.at } : { name: null, at: null }
}
