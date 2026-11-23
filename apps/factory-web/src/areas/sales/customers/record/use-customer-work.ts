'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useLiveBus } from '../../../../shell/live/use-live'
import { brandRequestSchema, REQUEST_READ_LIMIT, type BrandRequest } from '../../../home/approvals/requests/api'
import { listRequests as listPartnerRequests, type PartnerRequest } from '../../../admin/users/partners/api'
import { listCustomerReplies, type WaitingRow } from '../../inquiries/api'
import { listTasks } from '../../../../record-panels/tasks/api'
import type { TaskItem } from '../../../../record-panels/tasks/model'
import { getBoard, listOrders, type OrderBoard, type OrderRow } from '../../orders/api'
import type { OrderPhase } from '../../orders/api' // F-CW-101: the band's groups and their doors
import type { DockPick } from './view/WorkTab' // F-SA-278
import { useCoalesced } from '../../orders/hooks'
import type { WaitingMarks } from '../../orders/list/sheet/model'
import { MERGED_TERMS } from '../../../parties/_shared/model'
// ---- F-SA-279: the dock follows the row (the address term `dock=`, the summary read that checks a docked record) ----
import { usePathname, useSearchParams } from 'next/navigation'
import { CUSTOMER_FEED_TYPES } from '@nexus/factory-domain/sales/customer-feed/kinds'
import { readRecordSummary } from '../../../_shared/record-summary/api'
// ---- end F-SA-279
import { writeSearch } from '../../../_shared/record-frame/address' // F-OP-211: the record pages' ONE history writer
// ---- F-CP-111: the dock's files line on this page = the picked order's file set (the order lane's container, F-OP-215's host prop) ----
import { useRouter } from 'next/navigation'
import { useOrderFiles, type OrderFilesHost } from '../../../_shared/record-thread/use-order-files'
import { orderFileHrefOf } from '../../../_shared/record-thread/order-file-href' // F-OF-101: a block's door "Open on … ›"
// ---- F-OF-301 (T; lead 11-22 "one body, exactly the same in every place"): the docked order's Versions… — the page's ONE depth
import { useFileDepth } from '../../../../record-panels/files/use-file-depth'
import { previewLink } from '../../../../record-panels/files/api'
import { storeUrl } from '../../../../record-panels/store'
import { orderFilesOf } from '../../../../lib/record-thread/files-view/model'
// ---- end F-OF-301
// ---- end F-CP-111

/**
 * F-SA-276 (sales page plan N5, picks R5, R9, P10, P17; 11-customer-page §3.2, §3.4, §3.10, §3.11): the customer's Work tab beside
 * its Orders sheet — the reads of the waiting strip (one per source, each with its own right, each a walled API read narrowed to
 * this customer by the API: never a filter in the browser), the marks the sheet's Waiting on column joins by order id, and the
 * address the tab writes on entry (its default view and its lock). No React state outside the hook below; the pure parts carry
 * the rules so the tests hold them without a DOM.
 *
 *   requests to answer      GET /production/brand-requests?partyId&status=WAITING  (counts.OPEN; orders.view or workorders.view)
 *   replies waiting on us   GET /threads/waiting?side=CUSTOMER&partyId           (count, "100+" when not complete; threads.read)
 *   late · waiting for deposit · a change waiting for their new yes   GET /sales/orders/board?partyId  (orders.view)
 *   waiting for <customer>  our asks (GET /partners/:partyId/tasks, partners.view) + counter-offers (counts.COUNTERED) + the board's
 *                           waitingForCustomer
 *   open tasks              GET /tasks?scope=PARTY&partyId (B-SA-072: only tasks on records the reader may read; 200 at most)
 *
 * Live (rule 37): each source is read again on its own events, coalesced (800 ms, the lists' and the strip's time). The events'
 * fields carry no party id here (review BW-7): the server only sends the reader's customers' events, and a read again of this
 * customer's counts is always right.
 */

// ---- the address (the tab, its lock, its default view) ------------------------------------------------------------------

/**
 * The Work tab's default view, written into the address on entry. F-CP-101 (customer page plan C1, D7, K1): All orders (`rows=all`) —
 * never `status=all`: that term reads as Open orders and, being a view term, would stop every later write (a silent wrong view).
 * The customer page only: Sales › Orders keeps Open orders as its default.
 */
export const WORK_DEFAULT_ROWS = 'all' as const

/**
 * The terms that name a view of the sheet (any of them: the address already shows a view, the default is not written).
 * F-CP-101 (review E6: this step is their ONE owner): + `priceMatch` (the Not equal view, F-CP-141) and the page term `list` (Drafts of
 * <customer>, F-CP-107) — an address on either view gets no default written beside it. `cols` (F-CP-105) names no view.
 * F-CW-101 (lead settles S16, S26): + `phase` (a door of the band, of the Overview and of the Customers list: `?tab=work&phase=<PHASE>`).
 */
const VIEW_TERMS: readonly string[] = Object.freeze(['rows', 'status', 'late', 'deposit', 'reaccept', 'shippedNotInvoiced', 'waiting', 'priceMatch' /* F-CP-101 */, 'list' /* F-CP-101 */, 'phase' /* F-CW-101 */])

type Params = { get(name: string): string | null; toString(): string } | null

/**
 * The address the Work tab writes on entry, or null (nothing to write): `tab=work` (a saved view replaces the whole query and drops
 * the transient `tab`: the tab comes back), the customer's lock (`party`), an old address's terms (`?tab=orders` → All orders), and
 * the default view when no view term is there. One write, so the sheet reads once. fx-12: its ONE writer (WorkTab); applied to its
 * own output it writes nothing. F-CP-101: the default is `rows=all`.
 * F-CW-101 (S16, S26): a phase door keeps its `phase` and gets `rows=all` beside it in the same write (a phase is defined over every
 * order: without `rows=all` the sheet would read the open ones only) — the door from anywhere is just `?tab=work&phase=<PHASE>`.
 */
export function workEntry(base: string, partyId: string, params: Params): string | null {
  const query = new URLSearchParams(params?.toString() ?? '')
  const asked = query.get('tab')
  let changed = false
  const set = (name: string, value: string) => {
    if (query.get(name) === value) return
    query.set(name, value)
    changed = true
  }
  const hasView = () => VIEW_TERMS.some((name) => query.has(name))
  const merged = asked ? MERGED_TERMS.customers[asked] : undefined
  if (merged && !hasView()) for (const [name, value] of Object.entries(merged)) set(name, value)
  set('tab', 'work')
  set('party', partyId)
  if (query.has('phase') && !query.has('rows')) set('rows', WORK_DEFAULT_ROWS) // F-CW-101 (S16): a phase is over every order
  if (!hasView()) set('rows', WORK_DEFAULT_ROWS) // F-CP-101: All orders (`rows=all`), never `status=all`
  return changed ? `${base}?${query.toString()}` : null
}

// ---- F-CP-104 (customer page plan C2a; fx-12, review G4): New order and Import orders in place ------------------------------------

/** What the band (New order) or its ⋯ (Import orders for <customer>…) asks of the Work sheet; held in the page's memory, never in the address. */
export type WorkAsk = 'new' | 'import'

/**
 * The one address the band writes for an ask, or null: on the Work tab nothing (the sheet opens its window in place); on any other tab
 * `?tab=work` — then the Work tab's entry writes its lock and view once, and nothing more (two replaces at most, then none). No term
 * of the ask is written: nothing to loop on, and a reload does not open the window again.
 */
export const workAskAddress = (recordHref: string, tab: string): string | null => (tab === 'work' ? null : `${recordHref}?tab=work`)
// ---- end F-CP-104

// ---- F-CP-103 (customer page plan C1; review A4): the Overview's tiles open their own view; Views ▾ counts each view ------------------

/** The Work view each Overview tile counts (its door shows exactly those rows): Open orders, In production, Late. */
// F-CW-101 (lead settle S3): "In production" means ONE thing on the customer page — the started orders (the phase IN_PRODUCTION).
export const WORK_DOORS = Object.freeze({ open: 'rows=open', inProduction: 'phase=IN_PRODUCTION', late: 'late=true' } as const)

/** A tile's door: the record's Work tab on the view the tile counts (the entry then adds the lock, once). */
export const workDoor = (recordHref: string, door: keyof typeof WORK_DOORS): string => `${recordHref}?tab=work&${WORK_DOORS[door]}`

// ---- F-CW-101 (lead settles S3, S16, S19): the phase doors ----
/** A phase's door from anywhere (the band, the Overview, the Customers list): the entry completes it (`party`, `rows=all`), once. */
export const phaseDoor = (recordHref: string, phase: OrderPhase): string => `${recordHref}?tab=work&phase=${phase}`
/** The Views ▾ item "In production" on the Work tab: the door of the started orders (`phase=IN_PRODUCTION`), a view of the host. */
export const IN_PRODUCTION_VIEW = 'phase:IN_PRODUCTION'
/** A phase's count from the board (null: an older answer without `byPhase` — never a guess from the states). */
export const phaseCountOf = (board: OrderBoard, phase: OrderPhase): number | null => (board.byPhase ? (board.byPhase.find((entry) => entry.phase === phase)?.count ?? 0) : null)
// ---- end F-CW-101

/**
 * The count beside each Views ▾ item, from the ONE count read the strip already makes (the board of this customer: the API walls it
 * to the customer, never a filter in the browser): All orders (every state), In production, Late. A view the read does not count
 * (Waiting on us) gets no number — never a guess. Nothing while the read is not ready.
 * F-CW-101 (S3): In production counts the started orders (the board's `byPhase`), the number its door opens; no number without it.
 */
export function workViewCounts(board: Read<OrderBoard>): Readonly<Record<string, number>> | null {
  if (board.status !== 'ready') return null
  const value = board.value
  const started = phaseCountOf(value, 'IN_PRODUCTION')
  return {
    all: value.byStatus.reduce((sum, entry) => sum + entry.count, 0),
    ...(started !== null ? { [IN_PRODUCTION_VIEW]: started } : {}),
    late: value.tiles.find((tile) => tile.key === 'late')?.count ?? 0,
  }
}
// ---- end F-CP-103

// ---- the strip's tiles ------------------------------------------------------------------------------------------------

/** A tile's read: reading ("—", never 0), its count (0 is an answer; `more`: a capped read, "100+"), failed (that tile only). */
export type TileRead = { readonly status: 'reading' } | { readonly status: 'ready'; readonly count: number; readonly more: boolean } | { readonly status: 'failed' }

export const STRIP_TILES = ['requests', 'replies', 'late', 'deposit', 'customer', 'tasks'] as const
export type StripTile = (typeof STRIP_TILES)[number]

/** The two groups (the label says it, never the colour alone) and the tasks beside them. */
export const STRIP_GROUPS: Readonly<Record<'us' | 'them' | 'tasks', readonly StripTile[]>> = Object.freeze({ us: ['requests', 'replies', 'late'], them: ['deposit', 'customer'], tasks: ['tasks'] })

/** What the reader may read of each tile (a tile without its right is left out: no empty "0" tile). */
export interface WorkCan {
  readonly orders: boolean
  readonly workorders: boolean
  readonly threads: boolean
  readonly partners: boolean
  /** F-CP-141: the price grain (money.price): the Not equal view, its count and the Money tab's line; absent / false: none of them. */
  readonly price?: boolean
}

export function tilesShown(can: WorkCan): StripTile[] {
  return STRIP_TILES.filter((tile) => {
    if (tile === 'requests') return can.orders || can.workorders
    if (tile === 'replies' || tile === 'tasks') return can.threads
    if (tile === 'customer') return can.orders || can.workorders || can.partners
    return can.orders
  })
}

/** A read in its states. */
export type Read<T> = { readonly status: 'reading' } | { readonly status: 'ready'; readonly value: T } | { readonly status: 'failed' } | { readonly status: 'off' }

const ready = <T,>(read: Read<T>): T | null => (read.status === 'ready' ? read.value : null)

export interface RequestsRead {
  readonly items: readonly BrandRequest[]
  readonly open: number
  readonly countered: number
}
export interface RepliesRead {
  readonly rows: readonly WaitingRow[]
  readonly count: number
  readonly complete: boolean
}
export interface AsksRead {
  readonly items: readonly PartnerRequest[]
  readonly complete: boolean
}
export interface TasksRead {
  readonly items: readonly TaskItem[]
  readonly total: number
  readonly complete: boolean
}

export interface WorkReads {
  readonly board: Read<OrderBoard>
  readonly requests: Read<RequestsRead>
  readonly replies: Read<RepliesRead>
  readonly asks: Read<AsksRead>
  readonly tasks: Read<TasksRead>
}

const boardTile = (board: OrderBoard, key: string): number => board.tiles.find((tile) => tile.key === key)?.count ?? 0

/** One tile from the reads: "Waiting for <customer>" adds what each of its parts the reader may read says (all read, or "—"). */
export function tileOf(tile: StripTile, reads: WorkReads): TileRead {
  const single = <T,>(read: Read<T>, count: (value: T) => number, more: (value: T) => boolean = () => false): TileRead =>
    read.status === 'ready' ? { status: 'ready', count: count(read.value), more: more(read.value) } : read.status === 'failed' ? { status: 'failed' } : { status: 'reading' }
  if (tile === 'requests') return single(reads.requests, (value) => value.open)
  if (tile === 'replies') return single(reads.replies, (value) => value.count, (value) => !value.complete)
  if (tile === 'late') return single(reads.board, (value) => boardTile(value, 'late'))
  if (tile === 'deposit') return single(reads.board, (value) => boardTile(value, 'waitingForDeposit'))
  if (tile === 'tasks') return single(reads.tasks, (value) => value.total, (value) => !value.complete)
  const parts = [reads.asks, reads.requests, reads.board].filter((read) => read.status !== 'off')
  if (parts.some((read) => read.status === 'failed')) return { status: 'failed' }
  if (parts.some((read) => read.status === 'reading')) return { status: 'reading' }
  const asks = ready(reads.asks)
  const requests = ready(reads.requests)
  const board = ready(reads.board)
  return { status: 'ready', count: (asks?.items.length ?? 0) + (requests?.countered ?? 0) + (board ? boardTile(board, 'waitingForCustomer') : 0), more: asks ? !asks.complete : false }
}

/** The Work tab's count: what waits on us (requests to answer + replies waiting on us); null while one is read; the mark when > 0. */
export function workAttention(reads: WorkReads): { readonly count: number | null; readonly attention: boolean } {
  const parts = [reads.requests, reads.replies].filter((read) => read.status !== 'off')
  if (parts.length === 0) return { count: null, attention: false }
  if (parts.some((read) => read.status !== 'ready')) return { count: null, attention: false }
  const count = (ready(reads.requests)?.open ?? 0) + (ready(reads.replies)?.count ?? 0)
  return { count, attention: count > 0 }
}

/** The sheet's Waiting on marks, by order id: the requests waiting on us (oldest first) and the order conversations whose reply waits. */
export function marksOf(requests: readonly BrandRequest[] | null, replies: readonly WaitingRow[] | null): WaitingMarks {
  const marks: Record<string, { requestIds?: string[]; replySince?: string }> = {}
  for (const request of [...(requests ?? [])].filter((entry) => entry.waitingOn === 'US').sort((a, b) => a.askedAt.localeCompare(b.askedAt))) {
    const mark = (marks[request.orderId] ??= {})
    mark.requestIds = [...(mark.requestIds ?? []), request.id]
  }
  for (const row of replies ?? []) {
    if (row.recordType !== 'SalesOrder') continue
    const mark = (marks[row.recordId] ??= {})
    mark.replySince = row.waiting.since
  }
  return marks
}

/** The live events each source is read again on (the strip's reads, coalesced). */
export function sourcesTouched(type: string): Array<keyof WorkReads> {
  const out: Array<keyof WorkReads> = []
  // F-CW-101: + a stage reached on the floor moves an order from "Production not started" to "In production" (the band's counts).
  if (type.startsWith('sales_order.') || type.startsWith('deposit_request.') || type === 'payment.deposit_paid' || type === 'quote.accepted' || type === 'brand_production.stage_reached') out.push('board')
  if (type.startsWith('order_change_request.') || type.startsWith('brand_production.')) out.push('requests')
  if (type === 'thread.message_posted' || type.startsWith('thread.waiting')) out.push('replies')
  if (type.startsWith('partner_task.')) out.push('asks')
  if (type.startsWith('task.')) out.push('tasks')
  return out
}

// ---- F-SA-278: the strip's two windows ---------------------------------------------------------------------------------

/** "Counter-offers waiting for <customer>": our counter-offers they have not answered yet, oldest first. */
export const counterOffersOf = (requests: readonly BrandRequest[]): BrandRequest[] =>
  requests.filter((request) => request.waitingOn === 'CUSTOMER').sort((a, b) => a.askedAt.localeCompare(b.askedAt))

/** The dock's pick of a task's record: the record itself; a task on the customer's own record picks the customer's thread (null). */
export function pickOfTask(task: Pick<TaskItem, 'record' | 'companyId'>): DockPick | null {
  if (!task.record || task.record.type === 'Party') return null
  return { type: task.record.type, id: task.record.id, label: task.record.label, companyId: task.companyId }
}

/** "Changes waiting for <customer>'s new yes": the orders whose change waits for them (`reaccept`), read when the window opens. */
export function useReacceptOrders(partyId: string, open: boolean, can: boolean): Read<readonly OrderRow[]> {
  const api = useOfficeApi()
  const [read, setRead] = useState<Read<readonly OrderRow[]>>(can ? READING : OFF)
  useEffect(() => {
    if (!open || !can) return
    let gone = false
    setRead(READING)
    listOrders(api, { partyId, reaccept: true, limit: 50 }).then(
      (page) => !gone && setRead({ status: 'ready', value: page.orders }),
      () => !gone && setRead({ status: 'failed' }),
    )
    return () => {
      gone = true
    }
  }, [api, partyId, open, can])
  return read
}
// ---- end F-SA-278

// ---- the reads --------------------------------------------------------------------------------------------------------

const requestListSchema = z.object({
  asOf: z.string(),
  items: z.array(brandRequestSchema),
  count: z.number(),
  counts: z.record(z.string(), z.number()),
})

/** One customer's requests that wait (OPEN on us, COUNTERED on them), oldest first: the API's wall says whose come back (PW-H01). */
export async function readCustomerRequests(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<RequestsRead> {
  const answer = await api.get('/production/brand-requests', { query: { partyId, status: 'WAITING', limit: REQUEST_READ_LIMIT }, schema: requestListSchema, signal })
  return { items: answer.items, open: answer.counts.OPEN ?? 0, countered: answer.counts.COUNTERED ?? 0 }
}

const OFF: Read<never> = { status: 'off' }
const READING: Read<never> = { status: 'reading' }

// ---- F-CP-141 (customer page plan C2d; 11-money §3.2; money wall O1–O3): one customer's price check counts --------------------------
const priceSummarySchema = z.object({ partyId: z.string(), priceNotEqualCount: z.number(), priceMissingCount: z.number() })
/** How many of the customer's orders (every status) read Not equal, and No customer price yet. */
export type PriceSummary = z.infer<typeof priceSummarySchema>

/**
 * GET /sales/brand-prices/summary?partyId= (orders.view + the price grain over the customer; 403 in words otherwise): THIS customer's
 * counts only — the API walls them to the customer (one out of reach answers like an unknown one), never a filter in the browser.
 */
export function readPriceSummary(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<PriceSummary> {
  return api.get('/sales/brand-prices/summary', { query: { partyId }, schema: priceSummarySchema, signal })
}

/** The Not equal view's terms (the Work tab's view, the Money tab's line opens it): every order whose prices differ. */
export const NOT_EQUAL_TERMS = 'rows=all&priceMatch=NOT_EQUAL'
/** The Money tab's door to the Work tab's Not equal view (the entry then adds the lock, once; no default beside the view). */
export const notEqualDoor = (recordHref: string): string => `${recordHref}?tab=work&${NOT_EQUAL_TERMS}`

/** The Not equal count once read; null while read, after a failed read, and always for a reader without the price grain (off). */
export const priceDifferOf = (read: Read<PriceSummary>): number | null => (read.status === 'ready' ? read.value.priceNotEqualCount : null)

/** A live change that may move the counts: any order event (a customer's price saved is `sales_order.brand_price_changed`). */
export const pricesTouched = (type: string): boolean => type.startsWith('sales_order.')
// ---- end F-CP-141

/** The Work tab's reads for one customer (each only with its right), their live re-reads, and the marks of the sheet. */
export function useCustomerWork(partyId: string, can: WorkCan) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const allowed = useMemo(
    () => ({ board: can.orders, requests: can.orders || can.workorders, replies: can.threads, asks: can.partners, tasks: can.threads && held.has('home.view') }),
    [can.orders, can.workorders, can.threads, can.partners, held],
  )
  const [reads, setReads] = useState<WorkReads>(() => ({
    board: allowed.board ? READING : OFF,
    requests: allowed.requests ? READING : OFF,
    replies: allowed.replies ? READING : OFF,
    asks: allowed.asks ? READING : OFF,
    tasks: allowed.tasks ? READING : OFF,
  }))
  const turn = useRef<Record<keyof WorkReads, number>>({ board: 0, requests: 0, replies: 0, asks: 0, tasks: 0 })
  // ---- F-CP-141: the price check counts, only with orders.view and the price grain (no read at all otherwise: no number anywhere)
  const pricesAllowed = can.orders && can.price === true
  const [prices, setPrices] = useState<Read<PriceSummary>>(pricesAllowed ? READING : OFF)
  const pricesTurn = useRef(0)
  const readPrices = useCallback(() => {
    if (!pricesAllowed) return setPrices(OFF)
    const mine = ++pricesTurn.current
    readPriceSummary(api, partyId).then(
      (value) => mine === pricesTurn.current && setPrices({ status: 'ready', value }),
      () => mine === pricesTurn.current && setPrices({ status: 'failed' }),
    )
  }, [api, partyId, pricesAllowed])
  // ---- end F-CP-141

  const run = useCallback(
    <K extends keyof WorkReads>(source: K, read: () => Promise<WorkReads[K] extends Read<infer T> ? T : never>) => {
      if (!allowed[source]) {
        setReads((now) => ({ ...now, [source]: OFF }))
        return
      }
      const mine = ++turn.current[source]
      read().then(
        (value) => mine === turn.current[source] && setReads((now) => ({ ...now, [source]: { status: 'ready', value } })),
        () => mine === turn.current[source] && setReads((now) => ({ ...now, [source]: { status: 'failed' } })),
      )
    },
    [allowed],
  )
  const readers = useMemo(
    () => ({
      board: () => run('board', () => getBoard(api, '', undefined, partyId)),
      requests: () => run('requests', () => readCustomerRequests(api, partyId)),
      replies: () =>
        run('replies', async () => {
          const page = await listCustomerReplies(api, { partyId })
          return { rows: page.rows, count: page.count, complete: page.complete }
        }),
      asks: () =>
        run('asks', async () => {
          const answer = await listPartnerRequests(api, partyId)
          return { items: answer.items, complete: answer.complete }
        }),
      tasks: () =>
        run('tasks', async () => {
          const answer = await listTasks(api, { scope: 'PARTY', partyId, status: 'OPEN', limit: 200 })
          return { items: answer.items, total: answer.total, complete: answer.complete }
        }),
    }),
    [api, partyId, run],
  )
  const readAll = useCallback(() => {
    for (const read of Object.values(readers)) read()
    readPrices() // F-CP-141
  }, [readers, readPrices])
  useEffect(() => readAll(), [readAll])

  // Live: each source on its own events, coalesced; everything again after a reconnect.
  const pending = useRef(new Set<keyof WorkReads>())
  const pricesPending = useRef(false) // F-CP-141
  const flush = useCoalesced(() => {
    const sources = [...pending.current]
    pending.current.clear()
    for (const source of sources) readers[source]()
    // F-CP-141: the counts again on an order's change (coalesced with the strip's reads).
    if (pricesPending.current) {
      pricesPending.current = false
      readPrices()
    }
  }, 800)
  const live = useLiveBus({
    onChange: (change) => {
      const touched = sourcesTouched(change.type)
      const pricesMoved = pricesAllowed && pricesTouched(change.type) // F-CP-141
      if (touched.length === 0 && !pricesMoved) return
      for (const source of touched) pending.current.add(source)
      if (pricesMoved) pricesPending.current = true
      flush()
    },
    onReconnect: readAll,
  })

  const requests = ready(reads.requests)
  const replies = ready(reads.replies)
  const marks = useMemo(() => marksOf(requests?.items ?? null, replies?.rows ?? null), [requests, replies])
  const retry = (tile: StripTile) => {
    if (tile === 'requests') readers.requests()
    else if (tile === 'replies') readers.replies()
    else if (tile === 'tasks') readers.tasks()
    else if (tile === 'customer') {
      readers.asks()
      readers.requests()
      readers.board()
    } else readers.board()
  }
  return { reads, live, marks, retry, reload: readAll, attention: workAttention(reads), prices /* F-CP-141 */ }
}

// ---- F-SA-279 (sales page plan N5, N4, N6; picks R5, R9, P9, P11; 11-customer-page §3.7, §9.1; review C-13) ---------------------
// A row of Work or Quotes & incoming drives the page's dock: a click picks the row at once, the keys (↑ / ↓, j / k) after 300 ms of
// rest (a fast run of keys never reads ten conversations); the address keeps what the dock shows (`dock=<Type>.<id>`, `dock=all`)
// by a replace (no history entry per row: Back leaves the page). ONE conversation at a time; writing always into the one shown.

/** The address term of the customer page's dock. */
export const DOCK_PARAM = 'dock'
/** The keys' rest before the dock follows the focused row. */
export const DOCK_FOLLOW_MS = 300
/** The tabs whose rows drive the dock (leaving them drops a record's dock: the other tabs are about the account). */
export const DOCK_TABS: readonly string[] = Object.freeze(['work', 'quotes'])

/**
 * The records the customer page may dock beside the customer's own conversation: the customer-side conversations (the merged feed's
 * own list, B-SA-060), the general one being the page's own. NEVER a work order, a quality hold or an NCR (office notes, mixed walls:
 * Production › Work orders holds them), never a supplier's record, never a change request (its talk lives in its order's thread).
 */
export const dockable = (type: string): boolean => type !== 'Party' && Object.hasOwn(CUSTOMER_FEED_TYPES, type)

/** What the dock shows: the customer's general conversation (no term), every conversation read only, or ONE record's. */
export type DockTerm = { readonly kind: 'general' } | { readonly kind: 'all' } | { readonly kind: 'record'; readonly type: string; readonly id: string }
export const GENERAL_DOCK: DockTerm = Object.freeze({ kind: 'general' })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The term of an address (`dock=SalesOrder.<id>`, `dock=all`); anything else — a work order, a made-up type or id — is the general one. */
export function dockTermOf(value: string | null | undefined): DockTerm {
  if (!value) return GENERAL_DOCK
  if (value === 'all') return { kind: 'all' }
  const dot = value.indexOf('.')
  if (dot <= 0) return GENERAL_DOCK
  const type = value.slice(0, dot)
  const id = value.slice(dot + 1)
  return dockable(type) && UUID.test(id) ? { kind: 'record', type, id } : GENERAL_DOCK
}

/** The address value of a term (null: no term, the general conversation). */
export const dockValueOf = (term: DockTerm): string | null => (term.kind === 'all' ? 'all' : term.kind === 'record' ? `${term.type}.${term.id}` : null)

/**
 * The page's address with the dock's term set (or dropped for the general conversation) and the message a line of All of <customer>
 * opens its conversation at (`message=`, the thread's own anchor; dropped on any other move); every other term kept.
 */
export function dockAddress(pathname: string, search: string, term: DockTerm, messageId: string | null = null): string {
  const query = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const value = dockValueOf(term)
  if (value) query.set(DOCK_PARAM, value)
  else query.delete(DOCK_PARAM)
  if (messageId) query.set('message', messageId)
  else query.delete('message')
  const text = query.toString()
  return `${pathname}${text ? `?${text}` : ''}`
}

/** On a tab: a record's dock lives on Work and Quotes & incoming only; All of <customer> and the general one on every tab. */
export const dockOnTab = (tab: string, term: DockTerm): DockTerm => (term.kind === 'record' && !DOCK_TABS.includes(tab) ? GENERAL_DOCK : term)

/** One record's key (`SalesOrder.<id>`). */
export const dockKeyOf = (record: { readonly type: string; readonly id: string }): string => `${record.type}.${record.id}`

/**
 * A docked record the address names, checked against the summary read (threads.read over the record, a neutral 404 outside the
 * reader's scope): only a record of THIS customer docks; anything else falls back to the general conversation, with no word that it
 * existed.
 */
export function pickOfSummary(term: DockTerm, summary: { readonly label: string | null; readonly party?: { readonly id: string } | null | undefined } | null, partyId: string): DockPick | null {
  if (term.kind !== 'record' || !summary || summary.party?.id !== partyId) return null
  return { type: term.type, id: term.id, label: summary.label ?? term.type, companyId: null }
}

/** What the dock shows of the picks: 'record' only while a record is picked and the term names it. */
export function scopeOf(term: DockTerm, pick: DockPick | null): 'general' | 'record' | 'all' {
  if (term.kind === 'all') return 'all'
  if (term.kind === 'record' && pick && pick.type === term.type && pick.id === term.id) return 'record'
  return 'general'
}

/**
 * The follower: a click picks at once; the keys' focus picks after the rest (each new focus starts the wait again, so only the row
 * the keys stop on is read). `cancel` drops a wait (the tab left, the page gone).
 */
export function dockFollower<P>(apply: (pick: P) => void, wait: number = DOCK_FOLLOW_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null
  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  return {
    now: (pick: P) => {
      clear()
      apply(pick)
    },
    soon: (pick: P) => {
      clear()
      timer = setTimeout(() => {
        timer = null
        apply(pick)
      }, wait)
    },
    cancel: clear,
  }
}

/** "Draft kept on SO-…": the newest record left with a draft (its words kept), unless the dock shows it now. */
export function draftKeptOf(drafts: ReadonlyMap<string, string>, shown: string | null): string | null {
  const entries = [...drafts.entries()].filter(([key]) => key !== shown)
  return entries.length > 0 ? entries[entries.length - 1]![1] : null
}

/**
 * The customer page's dock (F-SA-279): the address term, the record picked (a row, a line of All of <customer>, a strip window's row),
 * the follower, the summary check of an address's record, the drafts left on records, and the message a line of All of <customer>
 * opens its conversation at. Leaving Work or Quotes & incoming drops a record's dock.
 */
export function useCustomerDock(partyId: string, tab: string, /* F-OF-303: Who can see… offers "Office and {customer}" */ customerName: string | null = null) {
  const api = useOfficeApi()
  const pathname = usePathname()
  const params = useSearchParams()
  const term = dockOnTab(tab, dockTermOf(params?.get(DOCK_PARAM)))
  const [pick, setPick] = useState<DockPick | null>(null)
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(new Map())
  const known = useRef(new Map<string, DockPick>())
  // A replace, never a push: Back leaves the page. F-OP-211 (11-dock §4): through the record pages' ONE history writer, the order
  // page's (writeSearch: only a different address — fx-12's rule — and no server round trip per row; Next 16 syncs the terms).
  const write = useCallback(
    (next: DockTerm, messageId: string | null = null) => {
      writeSearch(dockAddress(pathname, window.location.search, next, messageId))
    },
    [pathname],
  )
  // A record picked: its conversation docks; anything the page may not dock (a work order, a change request) docks nothing.
  const apply = useCallback(
    (next: DockPick, messageId: string | null = null) => {
      if (!dockable(next.type)) return
      known.current.set(dockKeyOf(next), next)
      setPick(next)
      write({ kind: 'record', type: next.type, id: next.id }, messageId)
    },
    [write],
  )
  const applyRef = useRef(apply)
  applyRef.current = apply
  const follower = useMemo(() => dockFollower<DockPick>((next) => applyRef.current(next)), [])
  useEffect(() => () => follower.cancel(), [follower])
  // Leaving the rows' tabs: the wait goes, the picked record goes, the address drops a record's term.
  const rawTerm = params?.get(DOCK_PARAM) ?? null
  useEffect(() => {
    if (DOCK_TABS.includes(tab)) return
    follower.cancel()
    setPick(null)
    if (dockTermOf(rawTerm).kind === 'record') write(GENERAL_DOCK)
  }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps
  // An address that names a record (arrival, Back, a link): known from the rows, else checked by the summary read.
  const termKey = term.kind === 'record' ? dockKeyOf(term) : null
  useEffect(() => {
    if (term.kind !== 'record' || !termKey) return
    if (pick && dockKeyOf(pick) === termKey) return
    const seen = known.current.get(termKey)
    if (seen) return setPick(seen)
    const controller = new AbortController()
    readRecordSummary(api, { type: term.type, id: term.id }, controller.signal)
      .then((summary) => {
        const checked = pickOfSummary(term, summary, partyId)
        if (!checked) return write(GENERAL_DOCK)
        known.current.set(termKey, checked)
        setPick(checked)
      })
      .catch(() => !controller.signal.aborted && write(GENERAL_DOCK))
    return () => controller.abort()
  }, [termKey, partyId]) // eslint-disable-line react-hooks/exhaustive-deps
  const scope = scopeOf(term, pick)
  const shownKey = scope === 'record' && pick ? dockKeyOf(pick) : null
  // ---- F-CP-111 (customer page plan C2c; 10-customer-page §4; review B1): while the dock shows an ORDER, its files line is the order's
  // file set — the order lane's useOrderFiles (A09, F-OP-125: GET /sales/orders/:id/files, walled by the API; a priced document is
  // counted, never named, for a reader without the price grain: B-CP-023), handed to the docked thread as `orderFiles` (F-OP-215's host
  // prop: the line's count is the order's Files tab's count). A tile opens the file in the ONE viewer here; "All files" opens the
  // order's Files tab. The general scope (the customer's own thread), All of <customer> and every other record keep their own line.
  const session = useOfficeSession()
  const router = useRouter()
  const prefix = pathname.replace(/\/sales\/customers\/.*$/, '')
  const order = orderShownOf(scope, pick)
  const readsFiles = session.permissions.includes('files.read')
  const [filesProblem, setFilesProblem] = useState<{ readonly key: string; readonly at: number } | null>(null)
  const orderFiles = useOrderFiles(api, {
    orderId: order?.id ?? null,
    enabled: !!order && readsFiles,
    partyId,
    canShare: session.permissions.includes('files.manage'),
    onProblem: (key) => setFilesProblem({ key, at: Date.now() }),
    keep: true, // one read per docked order (read again when another order docks, or on its files' news)
    // F-OF-103 / F-OF-101 (order FILES tab): the docked order's window keeps its "Add files…" (the order; no line is known here) and its
    // doors "Open on … ›" — the window draws no drop area of its own on an order any more.
    companyId: order?.companyId ?? null,
    canUpload: session.permissions.includes('files.upload'),
    canDelete: session.permissions.includes('files.delete'),
    canAsk: session.permissions.includes('tasks.manage') && session.permissions.includes('threads.post'), // F-OF-201
    canAskCustomer: session.permissions.includes('partners.tasks.manage'), // F-OF-201
    ...(order ? { hrefOf: (record: { readonly type: string; readonly id: string; readonly label: string }) => orderFileHrefOf(record, { prefix, id: order.id, companyId: order.companyId }) } : {}),
    // F-OF-301 / F-OF-303 (T): the docked order's card ⋯ opens Versions… in the page's ONE depth (below); Who can see… names this customer
    onVersions: (fileId) => depthOpen.current(fileId),
    partyName: customerName,
    canSeePrices: session.permissions.includes('money.price'), // fx5w (W-09)
  })
  // ---- F-OF-301 (T): the files in depth of the docked order — Versions… (Restore inside) of its own files and its lines', mounted ONCE
  // on this page as on the order page (OrderRecord.tsx) and drawn once by CustomerRecord; no handler copied, no documents read.
  const depthOpen = useRef<(fileId: string) => void>(() => undefined)
  const orderRead = orderFiles.model.read
  const depthFiles = useMemo(() => (orderRead ? orderFilesOf(orderRead).filter((file) => file.version !== undefined).map((file) => ({ id: file.id, originalName: file.name, contentType: file.contentType, version: file.version! })) : null), [orderRead])
  const fileDepth = useFileDepth({
    api,
    record: { type: 'SalesOrder', id: order?.id ?? '' },
    files: depthFiles,
    canUpload: orderFiles.model.may?.upload ?? false,
    canRead: false,
    prefix,
    reloadFiles: orderFiles.reload,
    // An earlier version (not in the read) opens in a new tab through its preview address; a refusal said once by the dock.
    openPdf: (fileId) =>
      void previewLink(api, fileId)
        .then(({ preview }) => window.open(storeUrl(preview.url), '_blank', 'noopener'))
        .catch(() => setFilesProblem({ key: 'order.openFailed', at: Date.now() })),
  })
  depthOpen.current = (fileId) => fileDepth.actions.onOpenVersions?.(fileId)
  // ---- end F-OF-301
  // News of a file (the reader's own live stream: `file.available`, the file's record named) reads the docked order's set again, coalesced.
  const filesAgain = useCoalesced(() => orderFiles.reload(), 800)
  useLiveBus({ onChange: (change) => change.type === 'file.available' && filesAgain(), onReconnect: filesAgain }, !!order && readsFiles)
  const orderFilesHost: OrderFilesHost | null =
    order && readsFiles
      ? {
          model: orderFiles.model,
          actions: orderFiles.actions,
          reload: orderFiles.reload,
          onAll: () => router.push(orderFilesHref(prefix, order.id)),
          onOpen: (fileId, opener) => orderFiles.actions.onOrderOpen?.(fileId, 'preview', opener),
        }
      : null
  // ---- end F-CP-111
  return {
    term,
    pick,
    scope,
    /** F-CP-111: the docked order's file set for its files line (null: no order docked, or no files.read — the record's own line). */
    orderFiles: orderFilesHost,
    /** F-CP-111: a file of that set that could not be opened or shared (a `record-thread-files-view` key), said once by the dock. */
    filesProblem,
    /** F-OF-301 (T): the docked order's Versions… — the page draws its window ONCE (`<DepthDialogs>` in CustomerRecord). */
    fileDepth,
    /** The record docked now (marked on its row); null: the general conversation or All of <customer>. */
    shown: scope === 'record' ? pick : null,
    /** "Draft kept on SO-…" under the pick. */
    draftKept: draftKeptOf(drafts, shownKey),
    /** A click (or a window's row): at once. */
    onRow: (next: DockPick) => follower.now(next),
    /** The keys' focus: after the rest. */
    onFocus: (next: DockPick) => follower.soon(next),
    /** The pick at the dock's top. */
    onScope: (next: 'general' | 'record' | 'all') => {
      follower.cancel()
      if (next === 'record' && pick) write({ kind: 'record', type: pick.type, id: pick.id })
      else write(next === 'all' ? { kind: 'all' } : GENERAL_DOCK)
    },
    /**
     * A line of All of <customer>: its ONE conversation, opened at that message (`message=`: the conversation mounts after the address
     * says so and reads it as its own link's anchor); the customer's own: the general one.
     */
    onAnswer: (record: DockPick, messageId: string) => {
      follower.cancel()
      if (record.type === 'Party') return write(GENERAL_DOCK, messageId)
      apply(record, messageId)
    },
    /** A docked conversation says whether its box holds a draft (kept on its record when the dock moves on). */
    onDraft: (record: DockPick, kept: boolean) =>
      setDrafts((now) => {
        const key = dockKeyOf(record)
        if (kept === now.has(key)) return now
        const next = new Map(now)
        if (kept) next.set(key, record.label)
        else next.delete(key)
        return next
      }),
  }
}
// ---- end F-SA-279

// ---- F-CP-111: which order's file set the dock's files line shows, and the way to its Files tab ----
/** The order the dock shows now (its own thread picked), else null: the general scope, All of <customer> and any other record. */
export function orderShownOf<P extends { readonly type: string; readonly id: string }>(scope: 'general' | 'record' | 'all', pick: P | null): P | null {
  return scope === 'record' && pick && pick.type === 'SalesOrder' ? pick : null
}
/** "All files": the order page's Files tab. */
export const orderFilesHref = (prefix: string, orderId: string): string => `${prefix}/sales/orders/${encodeURIComponent(orderId)}?tab=files`
// ---- end F-CP-111
