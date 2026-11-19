'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session' // F-SA-220
import { findCustomers, getParty } from '../../quotes/api'
import { getBoard, listOrderCustomers, listOrders, nextOrderNumber, type OrderBoard, type OrderCustomer } from '../api'
import type { OrderRow } from '../api' // B-TH-245
import { useCoalesced, useLive } from '../hooks'
import { boardRereadOf } from '../model' // F-SA-214
import type { BoardLane } from '../api' // F-SA-214
import { kindFromAddress } from '../model' // F-SA-221
import { profileFromAddress } from '../model' // F-SA-222
import { getProfile } from '../../mtm/api' // F-SA-222: the rider chip's name
import { abilitiesOf, boardLanes, brandFromAddress, cfFromAddress, companyFromAddress, laneQuery, sortFromAddress, layoutFromAddress, listAddress, listTouches, partyFromAddress, readProblem, romeToday, rowsFromAddress, rowsQuery, type Lane, type Layout, type Narrowing, type RowView } from '../model'
import type { OrderSort } from '../api' // B-TH-057
import { newOrderAddress } from '../new/new-model'
import type { NewOrderDialogModel, OrdersListActions, OrdersListModel } from './list-model'
import { useListMargins } from './margin/use-list-margins'
// ---- B-W2b-323 (orders in depth on screen) ----
import { useListDepth } from '../list-depth/use-list-depth'
import { usePromiseWeek } from '../week/use-promise-week'
import { useOrdersImport } from '../import/use-orders-import'
// ---- B-TH-225 / B-TH-226 (TH-1a: the Orders sheet and the Customer switcher) ----
import { brandName } from './sheet/model'
import { pictureReader } from '../../../../lib/record-picture/api' // F-SA-212
// ---- B-TH-244 (TH-4: the overall view grouped by customer, honest totals, the later columns, Invoice shipped goods) ----
import { fromDdtsCandidates, getOrderSummary, type OrderSummary } from '../api'
import { boardNarrowOf, extraFromAddress, groupFromAddress, noExtra, withoutExtra, type ExtraTerms } from '../model'
import { initiallyCollapsed, toggleGroup } from '../../../../list-frame/groups/model'
import { groupedItems, groupsToRead, type GroupRows } from './sheet/overall'
import type { InvoiceDraftsState } from './sheet/overall-parts'
import { isApiError } from '../../../../lib/api/errors'
// B-TH-230: the New messages column — one read of the page's rows, again on a live message.
import { useLiveBus } from '../../../../shell/live/use-live'
import { readUnreadWith } from '../../../../lib/last-message-cell/api'
import { useUnread } from '../../../../lib/last-message-cell/use-unread'
import { PIECES_COLUMNS, PRODUCTION_COLUMNS } from './sheet/model' // F-SA-275
import { orderIdsOfChange, valueTouches, waitingFromAddress } from '../model' // F-SA-276
// ---- F-SA-280: production's ONE assign dialog and ONE note dialog, reused in place over the sheet's ticked orders ----
import { useAssignSupervisor } from '../../../_shared/production-supervisor/use-assign-supervisor'
import { useNoteDialog } from '../../../production/_shared/notes/use-note-dialog'
import { noteTargetsOf, supervisorTargetsOf } from './sheet/model'
// ---- end F-SA-280
// ---- F-SA-281: Add task… on one order and Add task to N… (one batch: POST /tasks/batch) ----
import { newIdempotencyKey } from '../../../../lib/api/client'
import { createTask, createTasks, listAssignees, taskReadProblem } from '../../../../record-panels/tasks/api'
import { addTaskHeld, batchBody, createBody, type Assignable, type BatchAnswer, type BatchAssignee, type BatchRecord, type TaskDraft } from '../../../../record-panels/tasks/model'
import type { PanelRead } from '../../../../record-panels/model'
// ---- end F-SA-281
import { useReplyMany } from './use-reply-many' // F-SA-282

/**
 * F-SA-220 (sales page plan N7 / N5, picks R9, P10, P12, P18; 17-review C-2; 12-lists-board §4.5): the ONE Orders sheet, for every
 * page that shows it — Sales › Orders, Sales › Made-to-measure › Orders, the customer page's Work tab. The body of the Orders page's
 * container moved here as it was (SCR-038: the orders of the saved rows view and the search from the address — the API's own
 * filters `?late=true`, `?deposit=OPEN`, `?status=…`, `?rows=all`, `?q=`; `?view=board` the board, `?view=week` By promise week —
 * 50 a page with "Show more", the tiles' and lanes' counts, live behind "N updates · Show", the switcher, the grouped view, the
 * pictures, priority and season, Import orders, New order `?new=1`). The host says:
 *
 *   basePath   its own path under /w/<company> (the address the sheet writes: '/sales/orders', '/sales/made-to-measure', …); the
 *              company prefix is the session's, never parsed from the path
 *   locked     terms held for EVERY read and written into the address on entry, never cleared (Clear all keeps them): `party`
 *              (one customer's sheet: no switcher, no customer chip) and `kind` (made-to-measure orders). In the address,
 *              because Export ▾, saved views and Pin to Today take the address's terms (the SHEET-G02 lesson: a lock held only in
 *              memory would mail a file of every order); a view applied without it gets it back
 *   embedded   no own band (title, layout, New order, Import) and no tiles: the host draws them (OrdersBand, OrdersTiles)
 *   keep       the host's own address terms the sheet keeps when it writes (the MTM page's `segment`, the customer page's `tab`)
 *   listKey    the list frame's key: 'sales.orders' on every host (one export source, one set of saved views, one Pin to Today)
 *   onRowClick a row's click (default: the order opens; ⌘ / Ctrl: a new tab); the customer page docks the order instead
 *   clearTo    F-CP-102: the host's default rows view — where Clear all (and a view chip's ✕) goes back to, and what the "Showing: …"
 *              line compares with (default 'open': Sales › Orders; the customer page passes 'all')
 *
 * A host's default view is written into the address by the host on entry (not an option here); the column preset is the built-in
 * view's columns.
 */

/** F-SA-220: the Orders sheet's one list key (its export source, its saved views), on every host. */
export const ORDERS_LIST_KEY = 'sales.orders' as const

export interface OrdersSheetHost {
  /** The host's path under /w/<company>: where the sheet writes its address. */
  readonly basePath: string
  /** Held for every read and written into the address, never cleared. */
  readonly locked?: { readonly kind?: 'mtm'; readonly party?: string } | null
  /** No own band and no tiles (the host draws them). */
  readonly embedded?: boolean
  /** The host's own address terms kept when the sheet writes. */
  readonly keep?: readonly string[]
  /** Always 'sales.orders' (named so a host cannot drift to its page's key: the MTM page's is the riders' export). */
  readonly listKey?: typeof ORDERS_LIST_KEY
  /** A row's click; default: open the order. */
  readonly onRowClick?: (row: OrderRow, newTab: boolean) => void
  /** F-CP-102: the host's default rows view (Clear all goes back to it; the "Showing: …" line compares with it); default 'open'. */
  readonly clearTo?: RowView
}

/** F-CP-102: the page terms Clear all drops even when the host keeps them (the Work · Money columns, F-CP-105). */
export const CLEAR_DROPS: readonly string[] = Object.freeze(['cols'])

type Params = { get(name: string): string | null; getAll?(name: string): string[]; toString(): string } | null

/** The customer every read narrows to: the host's lock, else the address's `?party=`. */
export function sheetPartyOf(host: Pick<OrdersSheetHost, 'locked'>, params: Params): string | null {
  return host.locked?.party ?? partyFromAddress(params)
}

/** The host's own terms of the address (each value, in the address's order), kept by every address the sheet writes. */
function keptTerms(host: Pick<OrdersSheetHost, 'keep'>, params: Params, drop: readonly string[] = []): Array<[string, string]> {
  if (!params || !host.keep?.length) return []
  const all = new URLSearchParams(params.toString())
  return host.keep.filter((name) => !drop.includes(name)).flatMap((name) => all.getAll(name).map((value): [string, string] => [name, value]))
}

/**
 * The address the sheet writes: its own terms (listAddress), the host's locks over them, the host's own terms after them.
 * F-CP-102: `drop` — kept terms this write leaves out (Clear all drops CLEAR_DROPS; the locks never drop).
 */
export function sheetAddress(base: string, host: Pick<OrdersSheetHost, 'locked' | 'keep'>, params: Params, next: Parameters<typeof listAddress>[1], drop: readonly string[] = []): string {
  const written = listAddress(base, { ...next, ...(host.locked?.party ? { party: host.locked.party } : {}), ...(host.locked?.kind ? { kind: host.locked.kind } : {}) })
  const [path, qs = ''] = written.split('?')
  const query = new URLSearchParams(qs)
  for (const [name, value] of keptTerms(host, params, drop)) query.append(name, value)
  const text = query.toString()
  return `${path}${text ? `?${text}` : ''}`
}

/** On entry: the address with the host's locks written in when it lacks one (or names another value), else null (nothing to write). */
export function lockedEntry(base: string, host: Pick<OrdersSheetHost, 'locked'>, params: Params): string | null {
  const locked = host.locked
  if (!locked) return null
  const query = new URLSearchParams(params?.toString() ?? '')
  let changed = false
  for (const [name, value] of [['party', locked.party], ['kind', locked.kind]] as const) {
    if (!value || query.get(name) === value) continue
    query.set(name, value)
    changed = true
  }
  return changed ? `${base}?${query.toString()}` : null
}

/** The ONE Orders sheet: the model OrdersListView draws and its actions, for the host's address. */
export function useOrdersSheet(host: OrdersSheetHost): { model: OrdersListModel; actions: OrdersListActions } {
  const locale = useLocale()
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const params = useSearchParams()
  // F-SA-220: the company prefix comes from the session (the host's path is not the Orders page's on every host).
  const prefix = companyPrefix(session.company?.code ?? '')
  const base = `${prefix}${host.basePath}`
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  const rows = rowsFromAddress(params)
  const layout = layoutFromAddress(params)
  const q = params?.get('q') ?? ''
  const party = sheetPartyOf(host, params) // B-TH-201: one customer's orders (Sales › Reports' drill); F-SA-220: the host's lock wins
  // B-TH-225: the label on the garment and the company narrow every read too (the address keeps them).
  const brand = brandFromAddress(params)
  const company = companyFromAddress(params)
  // F-SA-221: made-to-measure orders only (`?kind=mtm`); the host's lock wins.
  const kind = host.locked?.kind ?? kindFromAddress(params)
  // F-SA-222: a rider's orders (`?profile=`: the rider list's Open orders door).
  const profile = profileFromAddress(params)
  // F-SA-276: the orders waiting on us (`?waiting=us`: the customer's Work tab's view "Waiting on us").
  const waiting = waitingFromAddress(params)
  // B-TH-057 (TH-4): the server sort and the custom field filter are address terms too (a saved view and the file keep them).
  const sort = sortFromAddress(params)
  const cf = cfFromAddress(params)
  // B-TH-244: the grouping (`?group=party`), the door terms beside the rows view, and the Progress column's read.
  const group = groupFromAddress(params)
  const extraKey = JSON.stringify(extraFromAddress(params, rows))
  const extra = useMemo<ExtraTerms>(() => JSON.parse(extraKey) as ExtraTerms, [extraKey])
  const [progressShown, setProgressShown] = useState(false)
  // F-SA-275: the rows' production part only while a production column is shown (Where it is, Waiting on, Supervisor).
  const [productionShown, setProductionShown] = useState(false)
  const narrow = useMemo<Narrowing>(() => ({ brand, companyId: company, cf, sort, extra, progress: progressShown, kind /* F-SA-221 */, profile /* F-SA-222 */, production: productionShown /* F-SA-275 */, waiting /* F-SA-276 */ }), [brand, company, cf, sort, extra, progressShown, kind, profile, productionShown, waiting])
  const grouped = layout === 'list' && group === 'party' && !party
  const wantsSummary = layout === 'list' && (grouped || rows === 'uninvoiced' || !noExtra(extra))

  const [list, setList] = useState<OrdersListModel['list']>({ items: null, more: false, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [lanes, setLanes] = useState<Lane[]>([])
  const [board, setBoard] = useState<OrderBoard | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<OrdersListModel['notice']>(null)
  const [weekTick, setWeekTick] = useState(0) // B-W2b-323
  const readId = useRef(0)
  const companyId = session.company?.id ?? session.companies[0]?.id ?? ''
  const [newOrder, setNewOrder] = useState<NewOrderDialogModel | null>(params?.get('new') === '1' && can.manage ? emptyNew(session.companies, companyId, incomingOf(prefix, session.permissions), can.price /* F-CP-146 */, !!host.locked?.party /* F-CP-104 */) : null)
  const searchSeq = useRef(0)

  const go = useCallback(
    (next: { rows?: RowView; q?: string; layout?: Layout; party?: string | null; brand?: string | null; company?: string | null; sort?: OrderSort | null; cf?: string | null; group?: 'party' | null; extra?: ExtraTerms | null /* B-TH-244 */; kind?: 'mtm' | null /* F-SA-221 */; profile?: string | null /* F-SA-222 */; waiting?: 'us' | null /* F-SA-276 */; drop?: readonly string[] /* F-CP-102 */ }) =>
      router.replace(
        // F-SA-220: the host's locks and its own terms stay in every address the sheet writes.
        sheetAddress(
          base,
          host,
          params,
          {
            rows: next.rows ?? rows,
            q: next.q ?? q,
            layout: next.layout ?? layout,
            party: next.party === undefined ? party : next.party,
            brand: next.brand === undefined ? brand : next.brand, // B-TH-225
            company: next.company === undefined ? company : next.company, // B-TH-225
            sort: next.sort === undefined ? sort : next.sort, // B-TH-057
            cf: next.cf === undefined ? cf : next.cf, // B-TH-057
            group: next.group === undefined ? group : next.group, // B-TH-244
            extra: next.extra === undefined ? extra : next.extra, // B-TH-244
            kind: next.kind === undefined ? kind : next.kind, // F-SA-221
            profile: next.profile === undefined ? profile : next.profile, // F-SA-222
            waiting: next.waiting === undefined ? waiting : next.waiting, // F-SA-276
          },
          next.drop, // F-CP-102: Clear all drops the page terms it names
        ),
      ),
    [router, base, host, params, rows, q, layout, party, brand, company, sort, cf, group, extra, kind, profile, waiting],
  )

  // ── B-TH-244: the view's figures from the server (the grouped view's headers and grand total, the honest count of a door's view) ──
  const [summary, setSummary] = useState<{ value: OrderSummary | null; problem: string | null } | null>(null)
  const readSummary = useCallback(
    (id: number) => {
      if (!wantsSummary) {
        setSummary(null)
        return
      }
      getOrderSummary(api, rowsQuery(rows, q, null, party, narrow), grouped ? 'party' : null)
        .then((answer) => id === readId.current && setSummary({ value: answer, problem: null }))
        .catch((error: unknown) => id === readId.current && setSummary({ value: null, problem: readProblem(error) }))
    },
    [api, wantsSummary, rows, q, party, narrow, grouped],
  )
  // The grouped view: each customer's rows, read when its group is open (pages of 50), and the groups folded shut.
  const [groupRows, setGroupRows] = useState<Record<string, GroupRows>>({})
  const [collapsed, setCollapsed] = useState<string[] | null>(null)
  const readGroup = useCallback(
    async (partyId: string, cursor: string | null) => {
      const id = readId.current
      setGroupRows((current) => ({ ...current, [partyId]: { items: current[partyId]?.items ?? null, cursor: current[partyId]?.cursor ?? null, more: current[partyId]?.more ?? false, problem: null, loading: true } }))
      try {
        const page = await listOrders(api, rowsQuery(rows, q, cursor, partyId, narrow))
        if (id !== readId.current) return
        setGroupRows((current) => ({ ...current, [partyId]: { items: [...(cursor ? (current[partyId]?.items ?? []) : []), ...page.orders], cursor: page.nextCursor, more: page.nextCursor !== null, problem: null, loading: false } }))
      } catch (error) {
        if (id !== readId.current) return
        setGroupRows((current) => ({ ...current, [partyId]: { items: current[partyId]?.items ?? null, cursor: current[partyId]?.cursor ?? null, more: current[partyId]?.more ?? false, problem: readProblem(error), loading: false } }))
      }
    },
    [api, rows, q, narrow],
  )
  // ── end B-TH-244 ──

  const readBoard = useCallback(
    (id: number) => {
      getBoard(api, q, undefined, party, boardNarrowOf(narrow) /* B-TH-244 */)
        .then((answer) => id === readId.current && setBoard(answer))
        .catch(() => id === readId.current && setBoard(null))
    },
    [api, q, party, narrow],
  )

  const load = useCallback(async (silent = false) => {
    const id = ++readId.current
    readBoard(id)
    readSummary(id) // B-TH-244
    // B-TH-244: the grouped view reads its groups' rows itself (each group's own pages), after the figures name the groups.
    if (grouped) {
      if (!silent) {
        setSummary(null)
        setGroupRows({})
        setCollapsed(null)
      }
      setList({ items: null, more: false, problem: null })
      setAsOf(new Date().toISOString())
      setUpdates(0)
      return
    }
    // B-W2b-323: By promise week reads its own lines (usePromiseWeek); the page keeps the tiles.
    if (layout === 'week') {
      setAsOf(new Date().toISOString())
      setUpdates(0)
      setWeekTick((tick) => tick + 1)
      return
    }
    if (layout === 'board') {
      const shown = boardLanes(rows)
      // A live re-read keeps the cards in place (the focus stays) until the new ones arrive.
      if (!silent) setLanes(shown.map((status) => ({ status, items: null, more: false, problem: null })))
      await Promise.all(
        shown.map(async (status) => {
          try {
            const page = await listOrders(api, laneQuery(status, rows, q, party, narrow))
            if (id !== readId.current) return
            setLanes((current) => current.map((lane) => (lane.status === status ? { status, items: page.orders, more: page.nextCursor !== null, problem: null } : lane)))
          } catch (error) {
            if (id !== readId.current) return
            setLanes((current) => current.map((lane) => (lane.status === status ? { status, items: null, more: false, problem: readProblem(error) } : lane)))
          }
        }),
      )
      if (id === readId.current) {
        setAsOf(new Date().toISOString())
        setUpdates(0)
      }
      return
    }
    setList((current) => ({ ...current, problem: null }))
    try {
      const page = await listOrders(api, rowsQuery(rows, q, null, party, narrow))
      if (id !== readId.current) return
      setList({ items: page.orders, more: page.nextCursor !== null, problem: null })
      setCursor(page.nextCursor)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      setList({ items: null, more: false, problem: readProblem(error) })
    }
  }, [api, rows, q, party, narrow, layout, readBoard, readSummary, grouped])

  // ── B-TH-244: the grouped view opens with every group open up to ten (more: all folded), and reads the open groups' rows ──
  const summaryGroups = summary?.value?.groups ?? null
  useEffect(() => {
    if (!grouped || !summaryGroups || collapsed !== null) return
    setCollapsed(initiallyCollapsed(summaryGroups.map((entry) => entry.partyId)))
  }, [grouped, summaryGroups, collapsed])
  useEffect(() => {
    if (!grouped || !summaryGroups || collapsed === null) return
    for (const key of groupsToRead(summaryGroups, collapsed, groupRows)) void readGroup(key, null)
  }, [grouped, summaryGroups, collapsed, groupRows, readGroup])
  const groupedRows = useMemo(() => (grouped && summaryGroups ? groupedItems(summaryGroups, groupRows) : null), [grouped, summaryGroups, groupRows])

  // ── B-TH-244: "Invoice shipped goods for N" (finance only) — the drafts Finance's From-DDTs dialog would open, nothing made here ──
  const [invoiceDrafts, setInvoiceDrafts] = useState<InvoiceDraftsState | null>(null)
  const invoiceAsked = useRef<readonly string[]>([])
  const invoiceShipped = useCallback(
    (ids: readonly string[]) => {
      invoiceAsked.current = ids
      setInvoiceDrafts({ value: null, problem: null, count: ids.length })
      fromDdtsCandidates(api, ids)
        .then((value) => setInvoiceDrafts((current) => (current ? { ...current, value } : current)))
        .catch((error: unknown) => setInvoiceDrafts((current) => (current ? { ...current, problem: isApiError(error) && error.kind === 'forbidden' ? 'invoiceShipped.forbidden' : 'invoiceShipped.failed' } : current)))
    },
    [api],
  )
  // ── end B-TH-244 ──

  useEffect(() => {
    setList({ items: null, more: false, problem: null })
    void load()
  }, [load])

  const more = useCallback(async () => {
    if (!cursor) return
    try {
      const page = await listOrders(api, rowsQuery(rows, q, cursor, party, narrow))
      setList((current) => ({ items: [...(current.items ?? []), ...page.orders.filter((row) => !current.items?.some((seen) => seen.id === row.id))], more: page.nextCursor !== null, problem: null }))
      setCursor(page.nextCursor)
    } catch (error) {
      setNotice({ tone: 'danger', words: { key: readProblem(error) } })
    }
  }, [api, cursor, rows, q, party, narrow])

  // ── B-TH-226: the Customer switcher — the reader's customers with their open and late orders (GET /sales/orders/customers);
  // its search reads the API again (after 250 ms); the chosen customer's name comes from it first. ──
  const [customers, setCustomers] = useState<{ customers: OrderCustomer[] | null; total: number; limited: boolean; problem: string | null }>({ customers: null, total: 0, limited: false, problem: null })
  const [customerQuery, setCustomerQuery] = useState('')
  const [searched, setSearched] = useState('')
  const [customersTick, setCustomersTick] = useState(0)
  useEffect(() => {
    const timer = setTimeout(() => setSearched(customerQuery.trim()), 250)
    return () => clearTimeout(timer)
  }, [customerQuery])
  useEffect(() => {
    const abort = new AbortController()
    setCustomers((current) => ({ ...current, customers: searched ? null : current.customers, problem: null }))
    listOrderCustomers(api, { q: searched || undefined, companyId: company, kind /* F-SA-221: "3 open · 1 late" counts what the rows show */, limit: 50 }, abort.signal)
      .then((answer) => !abort.signal.aborted && setCustomers({ customers: answer.customers, total: answer.total, limited: answer.limited, problem: null }))
      .catch((error: unknown) => !abort.signal.aborted && setCustomers({ customers: [], total: 0, limited: false, problem: readProblem(error) }))
    return () => abort.abort()
  }, [api, searched, company, kind, customersTick])
  // ── end B-TH-226 (the switcher's read) ──

  // ── B-TH-201: the customer's name for the chip — from the rows read, else the customer's record (404 when the person may
  // not open it: then the chip names no one). ──
  const nameInRows = useMemo(() => {
    if (!party) return null
    const read = [...(list.items ?? []), ...lanes.flatMap((lane) => lane.items ?? [])]
    return read.find((row) => row.partyId === party)?.partyName || null
  }, [party, list.items, lanes])
  const [looked, setLooked] = useState<{ id: string; name: string | null } | null>(null)
  useEffect(() => {
    if (!party || nameInRows || looked?.id === party || customers.customers === null || customers.customers.some((entry) => entry.id === party)) return
    let gone = false
    getParty(api, party)
      .then((found) => !gone && setLooked({ id: party, name: found.legalName }))
      .catch(() => !gone && setLooked({ id: party, name: null }))
    return () => {
      gone = true
    }
  }, [api, party, nameInRows, looked?.id, customers.customers])
  // ── end B-TH-201 ──

  const nameInSwitcher = party ? (customers.customers?.find((entry) => entry.id === party)?.name ?? null) : null
  const customer = party ? { id: party, name: nameInSwitcher ?? nameInRows ?? (looked?.id === party ? looked.name : undefined) } : null
  // ── end B-TH-226 ──

  // ── B-TH-225: the label's and the company's names for their chips; the pictures' small previews; a row opens its order ──
  const brandNamed = brand ? { value: brand, name: brandName([...(list.items ?? []), ...lanes.flatMap((lane) => lane.items ?? [])], brand).name } : null
  const companyNamed = company ? { id: company, name: session.companies.find((entry) => entry.id === company)?.name ?? company } : null
  // F-SA-212: the one picture part reads a page's pictures in ONE call (lib/record-picture; #1649's browserAddress kept there).
  const readPictures = useMemo(() => pictureReader(api), [api])
  // ── end B-TH-225 ──

  // Live: an order event (a new order, a move, a deposit paid…) → "N updates · Show"; the tiles follow at once. The
  // board reads its lanes again by itself (B-W2a-50: a board left open on a second screen).
  const recount = useCoalesced(() => {
    readBoard(readId.current)
    readSummary(readId.current) // B-TH-244: the totals follow at once, like the tiles
  }, 800)
  const rereadBoard = useCoalesced(() => void load(true), 900)
  // ── F-SA-214 (12-lists-board §3.5): the board re-reads only the lanes a change touches (a state that moved: its from and to
  // lanes; a new order: the lanes it may enter; another change: the lane that holds the order) and the counts. While a card has the
  // focus or a picture is open large, the change waits behind "N updates · Show" (a card never moves under the person). ──
  const boardHeld = useRef(false)
  const onBoardHold = useCallback((held: boolean) => {
    boardHeld.current = held
  }, [])
  const lanesNow = useRef(lanes)
  lanesNow.current = lanes
  const pendingLanes = useRef(new Set<BoardLane>())
  const readLanes = useCallback(
    async (statuses: readonly BoardLane[]) => {
      const id = readId.current
      await Promise.all(
        statuses.map(async (status) => {
          try {
            const page = await listOrders(api, laneQuery(status, rows, q, party, narrow))
            if (id !== readId.current) return
            setLanes((current) => current.map((lane) => (lane.status === status ? { status, items: page.orders, more: page.nextCursor !== null, problem: null } : lane)))
          } catch (error) {
            if (id !== readId.current) return
            setLanes((current) => current.map((lane) => (lane.status === status ? { status, items: null, more: false, problem: readProblem(error) } : lane)))
          }
        }),
      )
      if (id === readId.current) setAsOf(new Date().toISOString())
    },
    [api, rows, q, party, narrow],
  )
  const rereadLanes = useCoalesced(() => {
    const statuses = [...pendingLanes.current]
    pendingLanes.current.clear()
    if (statuses.length > 0) void readLanes(statuses)
  }, 900)
  // ── end F-SA-214 ──
  // ── F-SA-276 (rule 37): values in place — a production or request event naming an order on screen reads only those rows again
  // (`ids=`, ≤ 50, coalesced 800 ms) and swaps their values where they stand: a row never moves, is never added or removed here (a row
  // that no longer fits the view stays until "N updates · Show"). ──
  const onScreen = useRef<readonly string[]>([])
  onScreen.current = (list.items ?? []).map((row) => row.id)
  const stale = useRef(new Set<string>())
  const rereadRows = useCoalesced(() => {
    const ids = [...stale.current].slice(0, 50)
    stale.current.clear()
    if (ids.length === 0) return
    const id = readId.current
    listOrders(api, { ids, production: productionShown, progress: progressShown, limit: 50 })
      .then((page) => {
        if (id !== readId.current) return
        const fresh = new Map(page.orders.map((row) => [row.id, row]))
        setList((current) => ({ ...current, items: current.items?.map((row) => fresh.get(row.id) ?? row) ?? null }))
      })
      .catch(() => undefined)
  }, 800)
  // ── end F-SA-276 ──
  const live = useLive(
    (change) => {
      // F-SA-276: the values of the rows on screen, in place (the list layout).
      if (layout === 'list' && valueTouches(change)) {
        const named = orderIdsOfChange(change.fields).filter((id) => onScreen.current.includes(id))
        for (const id of named) stale.current.add(id)
        if (named.length > 0) rereadRows()
      }
      if (!listTouches(change)) return
      // F-SA-214: the board's lanes one by one (above); the counts follow at once.
      if (layout === 'board') {
        recount()
        const touched = boardRereadOf(change, lanesNow.current)
        if (touched.length === 0) return
        if (boardHeld.current) {
          setUpdates((count) => count + 1)
          return
        }
        for (const status of touched) pendingLanes.current.add(status)
        rereadLanes()
        return
      }
      if (layout === 'week' /* B-W2b-323 */) {
        rereadBoard()
        return
      }
      setUpdates((count) => count + 1)
      recount()
    },
    () => void load(),
  )

  // ── F-SA-222: the rider chip's name (GET /sales/mtm/profiles/:id: the term needs sales.measurements.view anyway); null: unread ──
  const [rider, setRider] = useState<{ id: string; name: string | null } | null>(null)
  useEffect(() => {
    if (!profile || rider?.id === profile) return
    let gone = false
    getProfile(api, profile)
      .then((found) => !gone && setRider({ id: profile, name: found.riderName }))
      .catch(() => !gone && setRider({ id: profile, name: null }))
    return () => {
      gone = true
    }
  }, [api, profile, rider?.id])
  // ── end F-SA-222 ──

  // ── F-SA-220 (the SHEET-G02 lesson): a lock lives in the ADDRESS, so Export ▾, saved views and Pin to Today hold the same rows as
  // the screen — written on entry when the address lacks it (a view applied without it gets it back), never cleared. ──
  const entry = lockedEntry(base, host, params)
  useEffect(() => {
    if (entry) router.replace(entry, { scroll: false })
  }, [router, entry])
  // ── end F-SA-220 ──

  // ---- New order (B-W2a-50) --------------------------------------------------------------------------------------------
  const searchCustomers = useCallback(
    (query: string, company: string) => {
      const mine = ++searchSeq.current
      setNewOrder((current) => (current ? { ...current, results: null, searchProblem: null } : current))
      findCustomers(api, query, company || null)
        .then((results) => mine === searchSeq.current && setNewOrder((current) => (current ? { ...current, results } : current)))
        .catch((error: unknown) => mine === searchSeq.current && setNewOrder((current) => (current ? { ...current, searchProblem: readProblem(error) } : current)))
    },
    [api],
  )
  const readNumber = useCallback(
    (company: string) => {
      setNewOrder((current) => (current ? { ...current, number: undefined } : current))
      nextOrderNumber(api, company)
        .then((number) => setNewOrder((current) => (current && current.companyId === company ? { ...current, number } : current)))
        .catch(() => setNewOrder((current) => (current && current.companyId === company ? { ...current, number: null } : current)))
    },
    [api],
  )
  const opened = newOrder !== null
  const openedCompany = newOrder?.companyId ?? ''
  useEffect(() => {
    if (!opened) return
    searchCustomers('', openedCompany)
    readNumber(openedCompany)
  }, [opened, openedCompany, searchCustomers, readNumber])

  // B-TH-244: the rows on screen (the grouped view's are its groups' reads).
  const shownItems = grouped ? groupedRows : list.items
  // B-W2a-72: the Margin % column (margin grain): the margins of the orders on screen.
  const margins = useListMargins(api, layout === 'board' ? null : shownItems, q, session.permissions, asOf)

  // ---- B-W2b-323: priority and season, By promise week, Import orders ----
  const listDepth = useListDepth(api, layout === 'list' ? shownItems : null, session.permissions, (changes) => {
    const bump = <R extends { id: string; version: number }>(row: R): R => {
      const change = changes.find((entry) => entry.id === row.id)
      return change?.version ? { ...row, version: change.version } : row
    }
    setList((current) => ({ ...current, items: current.items?.map(bump) ?? null }))
    // B-TH-244: the grouped view's rows carry the new versions too.
    setGroupRows((current) => Object.fromEntries(Object.entries(current).map(([key, entry]) => [key, { ...entry, items: entry.items?.map(bump) ?? null }])))
  })
  // ---- F-SA-280: Assign supervisor… (≤ 100, production.brand.manage) and Note to N… / Ask the supervisor (≤ 100, one batch, threads.post)
  // over the ticked orders; a Send reads the rows again (their marks). The one-customer check is the bar's, before any window.
  const assign = useAssignSupervisor(api, () => void load(true))
  const noteCan = session.permissions.includes('threads.post')
  const note = useNoteDialog(api, { can: noteCan, onDone: () => void load(true) })
  const pickedRows = (ids: readonly string[]) => (shownItems ?? []).filter((row) => ids.includes(row.id))
  // ---- end F-SA-280
  // ---- F-SA-281: the one New task window — on one order (a row's ⋯: its people, "Me" first) or on N orders (the selection: one task
  // on each, Assign to each order's supervisor by default or one person who may read the customer's records; one batch, its receipt).
  const [task, setTask] = useState<OrdersListModel['task']>(null)
  const taskKey = useRef<string | null>(null)
  const taskHeld = addTaskHeld(new Set(session.permissions), true)
  const readTaskPeople = useCallback(
    (record: { type: string; id: string }) => {
      setTask((now) => (now ? { ...now, people: { status: 'loading' } } : now))
      listAssignees(api, record).then(
        (people) => setTask((now) => (now ? { ...now, people: { status: 'ready', data: people } } : now)),
        (error: unknown) => setTask((now) => (now ? { ...now, people: { status: 'error', problem: taskReadProblem(error) } } : now)),
      )
    },
    [api],
  )
  const openTask = (ids: readonly string[], from: 'row' | 'selection') => {
    const rows = pickedRows(ids)
    if (rows.length === 0 || taskHeld) return
    taskKey.current = newIdempotencyKey()
    const records: BatchRecord[] = rows.map((row) => ({ type: 'SalesOrder', id: row.id, label: row.number, supervisor: row.production && !row.production.withheld.includes('supervisorMark') && row.production.supervisorMark !== null ? row.production.supervisorMark !== 'NOT_SET' : null }))
    const many = from === 'selection'
    const people: PanelRead<readonly Assignable[]> = { status: 'loading' }
    setTask({ mode: many ? 'many' : 'one', records, people, busy: false })
    // N orders of one customer: the people who may read this customer's records; one order: its own.
    readTaskPeople(many ? { type: 'Party', id: rows[0]!.partyId } : { type: 'SalesOrder', id: rows[0]!.id })
  }
  const taskActions: NonNullable<OrdersListActions['task']> = {
    onCreate: async (draft: TaskDraft) => {
      const record = task?.records[0]
      if (!record) return false
      setTask((now) => (now ? { ...now, busy: true } : now))
      try {
        await createTask(api, createBody(draft, record))
        setTask(null)
        return true
      } catch {
        setTask((now) => (now ? { ...now, busy: false } : now))
        return false
      }
    },
    onSend: async (draft: TaskDraft, assignee: BatchAssignee): Promise<BatchAnswer | null> => {
      if (!task) return null
      try {
        const answer = await createTasks(api, batchBody(draft, assignee, task.records), taskKey.current ?? newIdempotencyKey())
        void load(true)
        return answer
      } catch (error) {
        setNotice({ tone: 'danger', words: { key: readProblem(error) } })
        return null
      }
    },
    onRetryPeople: () => {
      const first = task?.records[0]
      if (task && first) readTaskPeople(task.mode === 'many' ? { type: 'Party', id: pickedRows([first.id])[0]?.partyId ?? '' } : { type: first.type, id: first.id })
    },
    onClose: () => setTask(null),
  }
  // ---- end F-SA-281
  // ---- F-SA-282: Reply to <customer> on N… — the ticked orders of one customer (the bar holds it otherwise, the API checks again);
  // a Send that posted reads the rows again (their New messages).
  const replyMany = useReplyMany(api, session.permissions, () => void load(true))
  // ---- end F-SA-282
  const week = usePromiseWeek(api, session, { enabled: layout === 'week', asked: params?.get('site') ?? null, q, tick: weekTick, partyId: party /* B-TH-201 */ })
  // B-TH-293: on one customer's sheet (the switcher's customer) the import is offered that customer's remembered columns.
  const importer = useOrdersImport(api, session, locale === 'en' ? 'en' : 'it', () => void load(), customer)

  // ---- F-SA-271: the customer page's doors, once on arrival — `new=1&party=<id>` opens New order with that customer chosen (the
  // customer's band primary), `import=1` the import with that customer's remembered columns (its ⋯ "Import orders for <customer>…").
  const pickNew = (partyId: string | null) => {
    if (!partyId) {
      setNewOrder((current) => (current ? { ...current, party: null, partyProblem: null, contactId: '' } : current))
      return
    }
    getParty(api, partyId)
      .then((party) => {
        const orders = party.contacts.find((contact) => contact.status === 'ACTIVE' && contact.roles.includes('ORDERS'))
        setNewOrder((current) => (current ? { ...current, party, partyProblem: null, contactId: orders?.id ?? '' } : current))
      })
      .catch((error: unknown) => setNewOrder((current) => (current ? { ...current, partyProblem: readProblem(error) } : current)))
  }
  const arrived = useRef(false)
  useEffect(() => {
    if (arrived.current) return
    arrived.current = true
    if (params?.get('new') === '1' && party) pickNew(party)
    if (params?.get('import') === '1') importer.open()
    // Once, on arrival.
  }, [])
  // ---- end F-SA-271

  // ---- B-TH-230: the reader's own new messages per order on the page (threads.read; one POST /threads/unread of ≤ 200 rows) ----
  const readsThreads = session.permissions.includes('threads.read')
  const [unreadTick, setUnreadTick] = useState(0)
  // F-SA-213: the board's lanes too (each reads its own cards' counts).
  useLiveBus({ onChange: (change) => change.type.startsWith('thread.') && setUnreadTick((tick) => tick + 1), onReconnect: () => setUnreadTick((tick) => tick + 1) }, readsThreads && (layout === 'list' || layout === 'board'))
  const unreadRows = useMemo(() => (layout === 'list' ? (shownItems ?? []).map((row) => ({ recordType: 'SalesOrder', id: row.id })) : []), [layout, shownItems])
  const unread = useUnread(readsThreads ? readUnreadWith(api) : null, unreadRows, unreadTick)
  const readUnread = useMemo(() => readUnreadWith(api), [api]) // F-SA-213: the board's lanes
  // ---- end B-TH-230

  const model: OrdersListModel = {
    prefix, can, today: romeToday(), layout, rows, q, lanes, board, asOf, live, updates, notice, newOrder, margins,
    // B-TH-244: the grouped view's rows are its groups' own reads.
    list: grouped ? { items: groupedRows, more: false, problem: summary?.problem ?? null } : list,
    group: grouped ? 'party' : null,
    extra,
    summary,
    groupRows,
    collapsed: collapsed ?? [],
    invoiceDrafts,
    unread: readsThreads ? unread : null, // B-TH-230
    boardUnread: readsThreads && layout === 'board' ? { read: readUnread, refresh: unreadTick } : null, // F-SA-213
    customer, // B-TH-201
    // ---- B-TH-225 / B-TH-226 ----
    brand: brandNamed,
    company: companyNamed,
    sort, // B-TH-057
    cf, // B-TH-057
    companies: session.companies.map((entry) => ({ id: entry.id, name: entry.name })),
    // F-SA-220: a host that locks the customer draws no switcher (and no customer chip: `locked`).
    switcher: host.locked?.party ? null : { ...customers, query: customerQuery, searching: customerQuery.trim() !== searched || (searched !== '' && customers.customers === null) },
    depth: listDepth.model,
    week: { state: week.state, sites: week.sites, siteId: week.siteId },
    importer: { held: importer.held, sheet: importer.model, memory: importer.memory /* B-TH-293 */ },
    kind, // F-SA-221
    profile: profile ? { id: profile, name: rider?.id === profile ? rider.name : undefined } : null, // F-SA-222
    waiting, // F-SA-276
    // ---- F-SA-280 ----
    assign: assign.model,
    note: note.model,
    bulkCan: { supervisor: session.permissions.includes('production.brand.manage'), note: noteCan, task: taskHeld /* F-SA-281 */, reply: noteCan /* F-SA-282: threads.post */ },
    replyMany: replyMany.model, // F-SA-282
    task, // F-SA-281
    me: session.user.id, // F-SA-281
    // ---- F-SA-220: the host ----
    listKey: host.listKey ?? ORDERS_LIST_KEY,
    embedded: !!host.embedded,
    locked: { party: !!host.locked?.party, kind: !!host.locked?.kind },
    defaultRows: host.clearTo ?? null, // F-CP-102: the host's default view (no chip, the "Showing" line compares with it)
  }

  const actions: OrdersListActions = {
    // B-TH-244: "Shipped, not invoiced" opens grouped by customer (on All customers).
    onRows: (next) => go({ rows: next, ...(layout === 'week' ? { layout: 'list' as const } : {}) /* B-W2b-323: a tile opens the list */, ...(next === 'uninvoiced' && !party ? { group: 'party' as const } : {}) }),
    // ---- B-TH-244 ----
    onGroup: (next) => go({ group: next }),
    onToggleGroup: (key) => setCollapsed((current) => toggleGroup(current ?? [], key)),
    onGroupMore: (key) => void readGroup(key, groupRows[key]?.cursor ?? null),
    onGroupRetry: (key) => void readGroup(key, null),
    onSummaryRetry: () => readSummary(readId.current),
    onClearExtra: (key) => go({ extra: key === null ? null : withoutExtra(extra, key) }),
    onExtra: (next) => go({ extra: { ...extra, ...next } }),
    // F-SA-275: Where it is reads the pieces too; the production columns read the rows' production part.
    onShownColumns: (ids) => {
      setProgressShown(ids.some((id) => PIECES_COLUMNS.includes(id)))
      setProductionShown(ids.some((id) => PRODUCTION_COLUMNS.includes(id)))
    },
    onInvoiceShipped: invoiceShipped,
    onInvoiceShippedRetry: () => invoiceShipped(invoiceAsked.current),
    onCloseInvoiceDrafts: () => setInvoiceDrafts(null),
    // ---- end B-TH-244 ----
    // ---- B-TH-245: a saved cell's note and the row's new version, on the list and on the grouped view's rows ----
    onBoardHold, // F-SA-214
    onCellSaved: (id, after, version) => {
      const apply = <R extends OrderRow>(row: R): R => (row.id === id ? { ...row, version, ...(Object.hasOwn(after, 'note') ? { internalNote: after.note === null ? null : String(after.note) } : {}) } : row)
      setList((current) => ({ ...current, items: current.items?.map(apply) ?? null }))
      setGroupRows((current) => Object.fromEntries(Object.entries(current).map(([key, entry]) => [key, { ...entry, items: entry.items?.map(apply) ?? null }])))
    },
    onLayout: (next) => go({ layout: next }),
    onSearch: (next) => go({ q: next }),
    onClearCustomer: () => go({ party: null }), // B-TH-201
    // ---- B-TH-225 / B-TH-226 ----
    onCustomer: (next) => {
      setCustomerQuery('')
      go({ party: next })
    },
    onCustomerSearch: setCustomerQuery,
    onCustomerRetry: () => setCustomersTick((tick) => tick + 1),
    onBrand: (next) => go({ brand: next, ...(layout === 'week' ? { layout: 'list' as const } : {}) }),
    // F-SA-221: the made-to-measure mark's funnel, its chip's ✕ and the built-in view (with its rows); By promise week cannot narrow: the list.
    onKind: (next, view) => go({ kind: next, ...(view ? { rows: view } : {}), ...(layout === 'week' ? { layout: 'list' as const } : {}) }),
    onProfile: (next) => go({ profile: next }), // F-SA-222: the rider chip's ✕
    onCompany: (next) => go({ company: next, ...(layout === 'week' ? { layout: 'list' as const } : {}) }),
    // F-CP-102: back to the host's default view (Sales › Orders: Open orders; the customer page: All orders); the page terms of
    // CLEAR_DROPS (Work · Money) and the door terms (`extra`, F-CP-141's priceMatch among them) go too.
    onClearAll: () => go({ rows: host.clearTo ?? 'open', q: '', party: null, brand: null, company: null, cf: null /* B-TH-057; the sort stays: it filters nothing */, extra: null /* B-TH-244; the grouping stays: it filters nothing */, kind: null /* F-SA-221: a lock comes back */, profile: null /* F-SA-222 */, waiting: null /* F-SA-276 */, drop: CLEAR_DROPS /* F-CP-102 */ }),
    // F-SA-276: the waiting term's chip ✕ and the built-in view "Waiting on us" (with its rows: the open ones).
    // ---- F-SA-280 ----
    onAssignSupervisor: (ids) => assign.open(supervisorTargetsOf(pickedRows(ids))),
    supervisor: assign.actions,
    onNote: (ids) => note.open(noteTargetsOf(pickedRows(ids)), 'selection'),
    note: note.actions,
    onAddTask: (ids, from = 'row') => openTask(ids, from), // F-SA-281
    task: taskActions, // F-SA-281
    onReplyMany: (ids) => replyMany.open(pickedRows(ids), host.locked?.party ?? null), // F-SA-282
    replyMany: replyMany.actions, // F-SA-282
    // ---- end F-SA-280
    onWaiting: (next, view) => go({ waiting: next, ...(view ? { rows: view } : {}), ...(layout === 'week' ? { layout: 'list' as const } : {}) }),
    onSort: (next) => go({ sort: next }), // B-TH-057
    onClearCf: () => go({ cf: null }), // B-TH-057
    readPictures, // F-SA-212
    // F-SA-220: the host's row click (the customer page docks the order), else the order opens (⌘ / Ctrl: a new tab).
    onOpenRow: (id, newTab) => {
      const row = host.onRowClick ? [...(list.items ?? []), ...Object.values(groupRows).flatMap((entry) => entry.items ?? [])].find((entry) => entry.id === id) : undefined
      if (host.onRowClick && row) return host.onRowClick(row, newTab)
      const href = `${prefix}/sales/orders/${id}`
      if (newTab) window.open(href, '_blank', 'noopener')
      else router.push(href)
    },
    onMore: () => void more(),
    onRetry: () => void load(),
    onShowUpdates: () => void load(),
    onOpen: (id) => router.push(`${prefix}/sales/orders/${id}`),
    onDismissNotice: () => setNotice(null),
    // F-CP-104: on a host that holds the customer (the customer page) the window opens with it picked, and keeps it (no Change).
    onNewOrder: (open) => {
      setNewOrder(open && can.manage ? emptyNew(session.companies, companyId, incomingOf(prefix, session.permissions), can.price /* F-CP-146 */, !!host.locked?.party /* F-CP-104 */) : null)
      if (open && can.manage && host.locked?.party) pickNew(host.locked.party) // F-CP-104
    },
    onNewCompany: (company) => setNewOrder((current) => (current ? { ...current, companyId: company, party: current.partyLocked ? current.party : null /* F-CP-104 */, contactId: current.partyLocked ? current.contactId : '' } : current)),
    onNewSearch: (query) => newOrder && searchCustomers(query, newOrder.companyId),
    onNewPick: pickNew, // F-SA-271: one pick (also the customer page's New order door)
    onNewField: (field, value) => setNewOrder((current) => (current ? { ...current, [field]: value } : current)),
    // ---- B-W2b-323 ----
    depth: listDepth.actions,
    onImport: importer.open,
    importActions: importer.actions,
    onWeekSite: (siteId) => {
      const next = new URLSearchParams(params?.toString() ?? '')
      next.set('site', siteId)
      router.replace(`${base}?${next.toString()}`) // F-SA-220: the host's path
    },
    onWeekRetry: week.retry,
    onNewCreate: () => {
      if (!newOrder?.party) return
      router.push(newOrderAddress(prefix, { companyId: newOrder.companyId, partyId: newOrder.party.id, contactId: newOrder.contactId, customerRef: newOrder.customerRef }))
    },
  }
  return { model, actions }
}

function emptyNew(companies: NewOrderDialogModel['companies'], companyId: string, incomingHref: string | null, price: boolean /* F-CP-146 */, partyLocked: boolean /* F-CP-104 */): NewOrderDialogModel {
  return { companies, companyId, results: null, searchProblem: null, party: null, partyProblem: null, contactId: '', customerRef: '', number: undefined, incomingHref, price, partyLocked }
}

/** B-TH-221: New order's one pointer — a written request goes to Incoming's New request, for who may make one there. */
const incomingOf = (prefix: string, permissions: readonly string[]): string | null => (permissions.includes('sales.inquiries.manage') ? `${prefix}/sales/incoming?new=1` : null)
