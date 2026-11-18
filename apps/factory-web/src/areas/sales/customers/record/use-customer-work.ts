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
import { getBoard, type OrderBoard } from '../../orders/api'
import { useCoalesced } from '../../orders/hooks'
import type { WaitingMarks } from '../../orders/list/sheet/model'
import { MERGED_TERMS } from '../../../parties/_shared/model'

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

/** The Work tab's default view: the orders in production (`status=IN_PRODUCTION`), written into the address on entry. */
export const WORK_DEFAULT_ROWS = 'IN_PRODUCTION' as const

/** The terms that name a view of the sheet (any of them: the address already shows a view, the default is not written). */
const VIEW_TERMS: readonly string[] = Object.freeze(['rows', 'status', 'late', 'deposit', 'reaccept', 'shippedNotInvoiced', 'waiting'])

type Params = { get(name: string): string | null; toString(): string } | null

/**
 * The address the Work tab writes on entry, or null (nothing to write): `tab=work` (a saved view replaces the whole query and drops
 * the transient `tab`: the tab comes back), the customer's lock (`party`), an old address's terms (`?tab=orders` → All orders), and
 * the default view when no view term is there. One write, so the sheet reads once.
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
  if (!hasView()) set('status', WORK_DEFAULT_ROWS)
  return changed ? `${base}?${query.toString()}` : null
}

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
  if (type.startsWith('sales_order.') || type.startsWith('deposit_request.') || type === 'payment.deposit_paid' || type === 'quote.accepted') out.push('board')
  if (type.startsWith('order_change_request.') || type.startsWith('brand_production.')) out.push('requests')
  if (type === 'thread.message_posted' || type.startsWith('thread.waiting')) out.push('replies')
  if (type.startsWith('partner_task.')) out.push('asks')
  if (type.startsWith('task.')) out.push('tasks')
  return out
}

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
  }, [readers])
  useEffect(() => readAll(), [readAll])

  // Live: each source on its own events, coalesced; everything again after a reconnect.
  const pending = useRef(new Set<keyof WorkReads>())
  const flush = useCoalesced(() => {
    const sources = [...pending.current]
    pending.current.clear()
    for (const source of sources) readers[source]()
  }, 800)
  const live = useLiveBus({
    onChange: (change) => {
      const touched = sourcesTouched(change.type)
      if (touched.length === 0) return
      for (const source of touched) pending.current.add(source)
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
  return { reads, live, marks, retry, reload: readAll, attention: workAttention(reads) }
}
