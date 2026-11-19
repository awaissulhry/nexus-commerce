'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Building2, Eye } from 'lucide-react' // F-OP-203: the segments' icons
import { Button, Skeleton } from '@nexus/ui/primitives'
import { useToast } from '@nexus/ui/components' // F-CP-113: the made order announced
import { useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { WithMessages } from '../../../../../record-panels/i18n'
import { CustomerOverrideProvider } from '../../../../_shared/customer-override/CustomerOverride'
import { OfficeRecordThread } from '../../../../_shared/record-thread/OfficeRecordThread'
import { ThreadPick, type ThreadChoice } from '../../../../_shared/record-thread/ThreadPick'
import { RecordTypeIcon } from '../../../../search/RecordTypeIcon' // F-OP-203: the picked record's icon in its segment
import { doorListOf } from '../../../../home/approvals/requests/model'
import { useRequestReviewDoor } from '../../../../home/approvals/requests/use-request-review-door'
import { RequestDoorNoticeBanner, RequestDoorWindow } from '../../../../home/approvals/requests/view/RequestReview'
import type { OrderRow } from '../../../orders/api'
import type { ExtraTerms, RowView } from '../../../orders/model'
import { ORDERS_LIST_KEY, sheetAddress, useOrdersSheet, type OrdersSheetHost } from '../../../orders/list/use-orders-sheet'
import { OrdersListView, WAITING_US_VIEW } from '../../../orders/list/view/OrdersListView'
import type { OrdersListModel } from '../../../orders/list/list-model'
import { WORK_DEFAULT_ROWS, workEntry, type useCustomerWork, type WorkCan } from '../use-customer-work'
import { workViewCounts } from '../use-customer-work' // F-CP-103: the Views ▾ counts from the strip's one count read
import type { WorkAsk } from '../use-customer-work' // F-CP-104: the band's New order / ⋯ Import orders, served in place
import { priceDifferOf } from '../use-customer-work' // F-CP-141: the Not equal view's count (the customer's own counts)
// ---- F-CP-113: the New order page's own lines editor, in a large window on this page ----
import type { NewOrderHeader } from '../../../orders/new/new-model'
import { NewOrderEditor } from '../../../orders/new/NewOrderEditor'
// ---- F-CP-107: Drafts of <customer> (the customer's portal drafts, read only) ----
import { writeSearch } from '../../../../_shared/record-frame/address'
import { useCustomerDrafts } from '../drafts/use-customer-drafts'
import { draftPick, draftsAddress, draftsNav, draftsShown, draftTitle } from '../drafts/model'
import { CustomerDraftsList } from '../drafts/view/CustomerDraftsList'
import { DraftWindow } from '../drafts/view/DraftWindow'
import type { DraftRow } from '../drafts/api'
// ---- F-SA-279: the dock follows the row; All of <customer> in the dock ----
import type { useCustomerDock } from '../use-customer-work'
import { useRecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { pendingAskOf, sameRecord } from '../../../../_shared/record-frame/model' // F-OP-212: the dock follows an ask's record
import type { useAllOfCustomer } from '../../../../_shared/record-thread/all-of-customer/use-all-of-customer'
import { ALL_OF_CUSTOMER_NS, AllOfCustomerDock } from '../../../../_shared/record-thread/all-of-customer/view/AllOfCustomerFeed'
// ---- end F-SA-279
// ---- F-CP-111: the docked order's files line = its file set; a tile opens the ONE viewer here ----
import { FileViewer } from '../../../../../lib/record-thread/popups/view/FileViewer'
import { FILES_VIEW_NS } from '../../../../../lib/record-thread/files-view/view/FilesView'
// ---- end F-CP-111
import { WaitingStrip, type StripDoors } from './WaitingStrip'
import './customer-work.css'

/**
 * F-SA-276 (sales page plan N5, N7, N3; picks R5, R9, P10, P17; 11-customer-page §3; 17-review R-1; picture 21) — the customer's
 * Work tab, no tabs inside the tab: the waiting strip on top, then the ONE Orders sheet (useOrdersSheet) locked to the customer —
 * embedded (the customer's band is the page's), its terms in the page's address beside the page's own `tab` and `dock`, list key
 * 'sales.orders' (one export source, one set of saved views: a view saved here keeps the lock). Its built-in views (F-CP-101): All
 * orders (the default, `rows=all`, written into the address on entry) · In production · Waiting on us · Late (+ Drafts of <customer>,
 * Not equal with their steps). A row click switches the page's dock to that
 * order's conversation (⌘ / Ctrl: the order in a new tab; Enter opens the order). "Requests to answer" opens the view Waiting on us,
 * a request's Answer… the review window on this page (the four-door window, `?open=`). A real link to Production › Work orders of
 * the customer. Live: values in place, rows never jump (the sheet's own rule); the strip's counts re-read on their events.
 */

/** A record the dock may show beside the customer's own thread (an order, a quote, a request): its type, id, number, company. */
export interface DockPick {
  readonly type: string
  readonly id: string
  readonly label: string
  readonly companyId: string | null
}

// ---- F-CP-101 (customer page plan C1, D7, K1): the views of the Work tab, All orders first ----
/** The host's own views (not rows views of the sheet): Drafts of <customer> (`list=drafts`, F-CP-107) and Not equal (`priceMatch`, F-CP-141). */
export const DRAFTS_VIEW = 'drafts:customer'
export const NOT_EQUAL_VIEW = 'price:notEqual'

/** The Work tab's views, in their order: All orders · In production · Waiting on us · Late · Drafts of <customer> · Not equal. */
export const WORK_VIEWS: readonly string[] = Object.freeze([WORK_DEFAULT_ROWS, 'IN_PRODUCTION', WAITING_US_VIEW, 'late', DRAFTS_VIEW, NOT_EQUAL_VIEW])

/**
 * The views this person is offered, in WORK_VIEWS' order: Not equal only with the price grain (money wall: no view, no count without
 * it); a host view only once its step draws it (`offered`: Drafts by F-CP-107, Not equal by F-CP-141) — never an item that shows nothing.
 */
export function workViewsOf(can: { readonly price: boolean }, offered: { readonly drafts?: boolean; readonly priceCheck?: boolean } = {}): string[] {
  return WORK_VIEWS.filter((id) => (id === DRAFTS_VIEW ? !!offered.drafts : id === NOT_EQUAL_VIEW ? !!offered.priceCheck && can.price : true))
}

/**
 * What an empty view says, per view (11-customer-page; 10 §1): All orders — "<customer> has no order yet." (F-CP-104 adds New order
 * beside it); In production — "Nothing in production for <customer>." with Show all orders; every other view the sheet's own words.
 */
export function workEmptyOf(rows: RowView, waiting: 'us' | null, customer: string, t: (key: string, params?: Record<string, string | number>) => string, allHref: string): OrdersListModel['empty'] {
  if (waiting) return null
  // F-CP-102: each keyed to its view (the sheet shows it on that view when nothing else narrows it).
  if (rows === 'all') return { title: t('customers.work.emptyAll', { customer }), view: 'all', newOrder: true /* F-CP-104: New order beside it */ }
  if (rows === 'IN_PRODUCTION') return { title: t('customers.work.empty', { customer }), link: { href: allHref, label: t('customers.work.showAll') }, view: 'IN_PRODUCTION' }
  return null
}
// ---- end F-CP-101

// ---- F-CP-141 (customer page plan C2d; 11-money §3.2; review E5, E6): the Not equal view and the money columns ----
/**
 * The money columns — ONE constant: the Not equal view's, and the Work · Money columns of every view (F-CP-105). Shown: Number ·
 * Status · Our price · Customer's price · Price check · Balance (@1440 beside the dock: select 36 + 128 + 112 + 104 + 104 + 112 + 104
 * + ⋯ 64 = 764 px ≤ the body's 865); from 1800 px Picture, Promised and Paid; Difference stays in Customise. The ids are the price
 * check spec's (fixed: the Owner's sheet maps onto them). A person's own Customise wins; without the price grain the money columns
 * do not exist, so nothing of it shows.
 */
export const MONEY_PRESET: NonNullable<OrdersListModel['preset']> = Object.freeze({
  shown: Object.freeze(['number', 'status', 'ourPrice', 'brandPrice', 'priceMatch', 'balance']),
  wide: Object.freeze(['picture', 'promised', 'paid']),
})

/** The Not equal view is the one shown: every order (`rows=all`), the price check term Not equal, no waiting term (a price holder's). */
export const notEqualShown = (rows: RowView, waiting: 'us' | null, extra: ExtraTerms | null | undefined): boolean => rows === 'all' && !waiting && extra?.priceMatch === 'NOT_EQUAL'
// ---- end F-CP-141

// ---- F-CP-105 (customer page plan C2d; 10 §5; review F3 not taken: the toggle stays): "Columns: Work · Money" on every Work view ----
/** The page term of the toggle (kept by the host on every view, dropped by Clear all: CLEAR_DROPS). It names no view. */
export const COLS_TERM = 'cols'
export type ColumnSet = 'work' | 'money'
/** A view's own columns: the Not equal view opens on Money, every other view on Work. */
export const viewColumnSet = (notEqual: boolean): ColumnSet => (notEqual ? 'money' : 'work')
/**
 * The columns shown: the person's pick (`cols=money|work`), else the view's own. Without the price grain always Work — `cols=money`
 * changes nothing (a shared saved view or link that names it shows no money: there is no money column for them).
 */
export function columnSetOf(asked: string | null | undefined, notEqual: boolean, price: boolean): ColumnSet {
  if (!price) return 'work'
  return asked === 'money' || asked === 'work' ? asked : viewColumnSet(notEqual)
}
/** The term a pick writes: none when it is the view's own (the address stays clean; the same pick again writes the same address). */
export const colsTermOf = (set: ColumnSet, notEqual: boolean): ColumnSet | null => (set === viewColumnSet(notEqual) ? null : set)
// ---- end F-CP-105

/**
 * The columns a view shows at first (11-customer-page §3.5; a person's Customise wins): In production — no Status (every row is in
 * production); All orders — Status, Waiting on from 1800 px; the other views — Status and Waiting on. Customer and Brand never (the
 * customer is the page's). F-CP-141: the money columns (MONEY_PRESET) when `money` — the Not equal view; All orders keeps its own
 * (review E5: money comes with the Not equal view or the Work · Money toggle, never unasked).
 */
export function workPreset(rows: RowView, waiting: 'us' | null, money = false): NonNullable<OrdersListModel['preset']> {
  if (money) return MONEY_PRESET // F-CP-141
  if (rows === 'all' && !waiting) return { shown: ['picture', 'number', 'status', 'whereItIs', 'promised', 'newMessages'], wide: ['waitingOn', 'priority', 'deposit', 'balance'] }
  if (rows === 'IN_PRODUCTION' && !waiting) return { shown: ['picture', 'number', 'whereItIs', 'promised', 'waitingOn', 'newMessages'], wide: ['priority', 'deposit', 'balance', 'supervisor'] }
  return { shown: ['picture', 'number', 'status', 'whereItIs', 'promised', 'waitingOn', 'newMessages'], wide: ['priority', 'deposit', 'balance', 'supervisor'] }
}

/** The dock's pick of an order row. */
export const pickOfRow = (row: Pick<OrderRow, 'id' | 'number' | 'companyId'>): DockPick => ({ type: 'SalesOrder', id: row.id, label: row.number, companyId: row.companyId })

type CustomerWork = ReturnType<typeof useCustomerWork>

export interface WorkTabProps {
  readonly party: { readonly id: string; readonly name: string }
  /** `/w/<company>`. */
  readonly prefix: string
  readonly work: CustomerWork
  readonly can: WorkCan
  /** The record the dock shows now (the picked row); null: the customer's own thread. */
  readonly picked: DockPick | null
  readonly onPick: (pick: DockPick) => void
  /** F-SA-279: the keys moved the focus to a row (the page's dock follows after its rest). */
  readonly onFocus?: (pick: DockPick) => void
  /** F-SA-278: the strip's two windows (Waiting for <customer>, Open tasks). */
  readonly onWindow?: StripDoors['onWindow']
  /** F-CP-104: the page's ask (the band's New order, ⋯ Import orders for <customer>…), served once the sheet is here; then `onAsked`. */
  readonly ask?: WorkAsk | null
  readonly onAsked?: () => void
}

export function WorkTab(props: WorkTabProps) {
  const router = useRouter()
  const params = useSearchParams()
  const entry = workEntry(`${props.prefix}/sales/customers/${encodeURIComponent(props.party.id)}`, props.party.id, params)
  useEffect(() => {
    if (entry) router.replace(entry, { scroll: false })
  }, [router, entry])
  // One write on entry (the tab, the lock, the default view), then the sheet reads once.
  if (entry)
    return (
      <div className="fw-cw" aria-busy="true">
        <Skeleton height={72} />
        <Skeleton height={320} />
      </div>
    )
  return (
    <WithMessages namespaces={['orders']}>
      <WorkSheet {...props} />
    </WithMessages>
  )
}

function WorkSheet({ party, prefix, work, can, picked, onPick, onFocus, onWindow, ask, onAsked }: WorkTabProps) {
  const t = useT('parties')
  const o = useT('orders')
  const params = useSearchParams()
  // ---- F-CP-113: "Add the lines" opens the ONE lines editor (the New order page's own) in a large window here: no page hop, no
  // address term. Discard and a made order close it (the new order docks, its row arrives behind "N updates · Show"); × keeps the
  // typed lines in this tab.
  const router = useRouter()
  const { toast } = useToast()
  const [lines, setLines] = useState<NewOrderHeader | null>(null)
  // ---- end F-CP-113
  const frame = useRecordFrame() // F-SA-279: a phone card's door shows the conversation (the full-width view)
  const basePath = `/sales/customers/${encodeURIComponent(party.id)}`
  const host: OrdersSheetHost = {
    basePath,
    locked: { party: party.id },
    embedded: true,
    keep: ['tab', 'dock', COLS_TERM /* F-CP-105: Work · Money, kept on every view (Clear all drops it) */],
    listKey: ORDERS_LIST_KEY,
    clearTo: WORK_DEFAULT_ROWS, // F-CP-102: Clear all goes back to All orders (the "Showing" line compares with it)
    onAddLines: setLines, // F-CP-113: the lines window on this page
    // A row click docks the order's conversation; ⌘ / Ctrl opens the order in a new tab.
    onRowClick: (row, newTab) => (newTab ? window.open(`${prefix}/sales/orders/${encodeURIComponent(row.id)}`, '_blank', 'noopener') : onPick(pickOfRow(row))),
  }
  const sheet = useOrdersSheet(host)
  // ---- F-CP-104: the band's New order (the customer picked and held: no Change) and ⋯ Import orders open here, once each ask; no
  // address term is written for them (fx-12: nothing to loop on; a reload does not reopen the window).
  const latest = useRef(sheet.actions)
  latest.current = sheet.actions
  useEffect(() => {
    if (!ask) return
    onAsked?.()
    if (ask === 'new') latest.current.onNewOrder?.(true)
    else latest.current.onImport?.()
  }, [ask]) // eslint-disable-line react-hooks/exhaustive-deps
  // ---- end F-CP-104
  // The review window on this page (the four-door window): the customer's requests that wait on us, a batch as one entry.
  const requests = work.reads.requests.status === 'ready' ? work.reads.requests.value : null
  const list = useMemo(() => doorListOf((requests?.items ?? []).filter((request) => request.waitingOn === 'US')), [requests])
  const door = useRequestReviewDoor({ ids: list.ids, batches: list.batches, onChanged: work.reload })
  const rows = sheet.model.rows
  const waiting = sheet.model.waiting ?? null
  const all = `${prefix}${sheetAddress(basePath, host, params, { rows: 'all', q: '', layout: 'list', party: party.id })}`
  // ---- F-CP-107: "Drafts of <customer>" — `list=drafts` draws the customer's portal drafts (read only) in the sheet's place; the strip
  // and the Views ▾ stay; a draft's row docks its own conversation, Enter / Open its read-only window.
  const showDrafts = draftsShown(params)
  const untitled = t('customers.drafts.untitled')
  const drafts = useCustomerDrafts(party.id, showDrafts, untitled)
  const draftRows = drafts.read.status === 'ready' ? drafts.read.rows : null
  // ---- end F-CP-107
  // ---- F-CP-141: "Not equal" (`rows=all&priceMatch=NOT_EQUAL`) — a price holder's only: the view, its count (the customer's own
  // counts, read by the page: GET /sales/brand-prices/summary) and its money columns. Without the price grain: no view, no count;
  // an address with the term is held by the sheet in one line (no read carries it).
  const price = sheet.model.can.price
  const notEqual = price && !showDrafts && notEqualShown(rows, waiting, sheet.model.extra)
  const notEqualCount = price ? priceDifferOf(work.prices) : null
  // ---- end F-CP-141
  // ---- F-CP-105: "Columns: Work · Money" — the price grain only (no toggle otherwise, and `cols=money` changes nothing); it swaps
  // the view's columns for the money columns; the Not equal view opens on Money.
  const columnSet = columnSetOf(params?.get(COLS_TERM), notEqual, price)
  // ---- end F-CP-105
  const model: OrdersListModel = {
    ...sheet.model,
    views: workViewsOf(sheet.model.can, { drafts: true, priceCheck: true }), // F-CP-101: All orders first; F-CP-107: Drafts of <customer>; F-CP-141: Not equal (price grain)
    viewCounts: { ...(workViewCounts(work.reads.board) ?? {}), ...(draftRows ? { [DRAFTS_VIEW]: draftRows.length } : {}), ...(notEqualCount !== null ? { [NOT_EQUAL_VIEW]: notEqualCount } : {}) }, // F-CP-103 (no second read); F-CP-107: the drafts once read; F-CP-141: the Not equal count
    hostViews: [
      { id: DRAFTS_VIEW, label: t('customers.work.view.drafts', { customer: party.name }), active: showDrafts }, // F-CP-107
      ...(price ? [{ id: NOT_EQUAL_VIEW, label: t('customers.work.view.notEqual'), active: notEqual }] : []), // F-CP-141
    ],
    preset: workPreset(rows, waiting, columnSet === 'money' /* F-CP-141: the Not equal view opens on the money columns; F-CP-105: the toggle on every view */),
    columnSet: price ? { value: columnSet } : null, // F-CP-105: the toggle, a price holder's only
    marks: work.marks,
    doorHref: door.hrefOf,
    toolbarLink: can.workorders ? { href: `${prefix}/production/work-orders?party=${encodeURIComponent(party.id)}`, label: t('customers.band.workOrders', { customer: party.name }) } : null,
    empty: workEmptyOf(rows, waiting, party.name, t, all) ?? sheet.model.empty ?? null, // F-CP-101: per view
    // F-SA-279: the row the dock shows is marked; the keys' row is reported (the dock follows after its rest); a phone card's door.
    active: can.threads ? { id: picked && picked.type === 'SalesOrder' ? picked.id : null, cardDoor: t('customers.work.dock.cardDoor') } : null,
  }
  // ---- F-CP-141: on the Not equal view every other pick stands alone — the price check term goes in the same write (Views ▾, the
  // strip's doors, Show all orders); the chip's ✕ goes back to All orders.
  const leave = notEqual ? (sheet.actions.onPriceMatch ?? null) : null
  const onRows = leave ? (next: RowView) => leave(null, { rows: next }) : sheet.actions.onRows
  const onWaiting = leave ? (next: 'us' | null, view?: RowView) => leave(null, { rows: view ?? rows, waiting: next }) : sheet.actions.onWaiting
  // ---- end F-CP-141
  const actions = {
    ...sheet.actions,
    onRows, // F-CP-141
    onWaiting, // F-CP-141
    // F-CP-105: a pick writes `cols` through the sheet (one replace; none when it is the view's own columns: the term goes).
    ...(price ? { onColumnSet: (set: ColumnSet) => sheet.actions.onPageTerm?.(COLS_TERM, colsTermOf(set, notEqual)) } : {}),
    // F-CP-107: Drafts of <customer> — a person's pick writes `list=drafts` once (the record pages' one history writer; a rows view
    // picked again goes through the sheet, which drops it).
    // F-CP-141: Not equal — `rows=all&priceMatch=NOT_EQUAL` in one write through the sheet (it drops `list`, keeps the lock).
    onHostView: (id: string) => {
      if (id === DRAFTS_VIEW) writeSearch(draftsAddress(`${prefix}${basePath}`, party.id, params))
      else if (id === NOT_EQUAL_VIEW) sheet.actions.onPriceMatch?.('NOT_EQUAL', { rows: 'all' })
    },
    ...(can.threads
      ? {
          onFocusRow: (row: OrderRow) => onFocus?.(pickOfRow(row)),
          onCardThread: (row: OrderRow) => {
            onPick(pickOfRow(row))
            frame?.showThread?.()
          },
        }
      : {}),
  }
  const doors: StripDoors = {
    onView: (view) => (view === 'waitingUs' ? onWaiting?.('us', 'open') : waiting ? onWaiting?.(null, view) : onRows?.(view)), // F-CP-141: they leave the Not equal view
    repliesHref: `${prefix}/sales/incoming?tile=CUSTOMER_REPLIES&party=${encodeURIComponent(party.id)}`,
    onWindow,
    onRetry: work.retry,
  }
  // The picked order left the view (it moved on, live): the dock keeps its conversation; one line says so, with the way back.
  const items = sheet.model.list.items
  const gone = !showDrafts && picked && picked.type === 'SalesOrder' && items && sheet.model.updates === 0 && !items.some((row) => row.id === picked.id) && !(rows === 'all' && !waiting && !notEqual /* F-CP-141 */)
  const viewName = waiting ? t('customers.work.view.waitingUs') : notEqual ? t('customers.work.view.notEqual') /* F-CP-141 */ : o(`rows.${rows}`)
  return (
    <CustomerOverrideProvider onDone={door.refresh}>
      <div className="fw-cw">
        <RequestDoorNoticeBanner door={door} />
        <WaitingStrip customer={party.name} reads={work.reads} can={can} doors={doors} />
        {gone && (
          <p className="fw-cw-line" role="status">
            <span>{t('customers.work.gone', { record: picked?.label ?? '', view: viewName })}</span>
            <Button size="sm" variant="quiet" onClick={() => (waiting ? onWaiting?.(null, 'all') : onRows?.('all')) /* F-CP-141 */}>
              {t('customers.work.showAll')}
            </Button>
          </p>
        )}
        {showDrafts ? (
          // F-CP-107: the customer's portal drafts, read only (the dock follows a row: the draft's own conversation).
          <CustomerDraftsList
            model={{ customer: party.name, read: drafts.read, updates: drafts.updates, activeId: picked && picked.type === 'PortalOrderRequest' ? picked.id : null, views: { model, actions } }}
            actions={{
              ...(can.threads ? { onRow: (row: DraftRow) => onPick(draftPick(row, draftTitle(row, untitled))), onFocusRow: (row: DraftRow) => onFocus?.(draftPick(row, draftTitle(row, untitled))) } : {}),
              onOpen: drafts.onOpen,
              onRetry: drafts.onRetry,
              onShowUpdates: drafts.onShowUpdates,
            }}
          />
        ) : (
          <OrdersListView model={model} actions={actions /* F-SA-279 */} />
        )}
      </div>
      <RequestDoorWindow door={door} />
      {drafts.open && drafts.window && draftRows && (
        // F-CP-107: the draft in its read-only window — Incoming's own container and pane in draft mode; J / K walk the drafts.
        <DraftWindow
          model={{ customer: party.name, title: draftTitle(drafts.open, untitled), nav: draftsNav(draftRows, drafts.open.id), pane: drafts.window.model, thread: drafts.window.thread }}
          actions={{ pane: drafts.window.actions, onGo: drafts.onGo, onClose: drafts.onClose }}
        />
      )}
      {lines && (
        // F-CP-113: the same editor as /sales/orders/new, its customer and header set by the New order window.
        <NewOrderEditor
          frame="window"
          prefix={prefix}
          header={lines}
          onClose={() => setLines(null)}
          onDiscarded={() => setLines(null)}
          onMade={(order) => {
            setLines(null)
            toast(o('newOrder.window.made', { number: order.number }), 'success')
            if (can.threads) onPick(pickOfRow({ id: order.id, number: order.number, companyId: lines.companyId }))
          }}
          onOpen={(href) => router.push(href)}
        />
      )}
    </CustomerOverrideProvider>
  )
}

type CustomerFeed = ReturnType<typeof useAllOfCustomer>
type DockProps = { customer: { id: string; name: string }; general: ReactNode; dock: ReturnType<typeof useCustomerDock>; feed: CustomerFeed; prefix: string; /** F-OP-213: All of <customer> may be read (its General is readable). */ allOffered?: boolean }

/**
 * F-SA-276 (11-customer-page §9.1, review C-13): the customer page's dock — the customer's own thread, and beside it the record a
 * row picked (an order of the Work tab, a quote or a request of Quotes & incoming): ONE thread at a time, picked with the shared
 * ThreadPick ("<customer> (general)" · the record), ONE line under it saying who reads what is written there. Writing always goes
 * into the one thread shown.
 * F-SA-279 (sales page plan N5, N4; picks R5, R9, P9; 11-customer-page §3.7, §9.1, §9.2): the third choice "All of <customer>" — the
 * read-only merged feed (F-SA-261), whose lines open their ONE conversation at that message; the record follows the row (the page's
 * `dock=` term, useCustomerDock); "Draft kept on SO-…" under the pick when the dock left a record with a draft; the words of the pick
 * the same as the order page's (C-13). No threads.read: no dock at all. The page reads All of <customer> (useAllOfCustomer) and
 * hands the dock its feed (end check: a view fetches nothing).
 */
/** F-OP-203: the dock's catalogues — All of <customer>'s, and the orders' for the pick's short "General" (the order page's word). */
const CUSTOMER_DOCK_NS = [...ALL_OF_CUSTOMER_NS, 'orders', FILES_VIEW_NS /* F-CP-111: a file of the order's set that did not open */] as const

export function CustomerDock(props: DockProps) {
  return (
    <WithMessages namespaces={CUSTOMER_DOCK_NS}>
      <Dock {...props} />
    </WithMessages>
  )
}

function Dock({ customer, general, dock, feed, prefix, allOffered = true }: DockProps) {
  const t = useT('parties')
  const o = useT('orders') // F-OP-203
  const rt = useT('record-thread') // F-OP-203
  // ---- F-CP-111: a file of the docked order's set that could not be opened (or shared) is said once, as the order page says it.
  const fv = useT(FILES_VIEW_NS)
  const { toast } = useToast()
  const filesProblem = dock.filesProblem
  useEffect(() => {
    if (filesProblem) toast(fv(filesProblem.key), 'danger')
  }, [filesProblem?.at]) // eslint-disable-line react-hooks/exhaustive-deps -- once per problem
  // ---- end F-CP-111
  // ---- F-OP-212 (11-dock §5, D5): an ask of the page (files, Followers…, a door, Answer) names its record — the customer's own when
  // the body names none: the pick goes to that record's thread first (the customer's general one; the record picked), which then
  // takes the ask; once per ask. The narrow view is the frame's term, untouched by `dock=`.
  const frame = useRecordFrame()
  const pending = pendingAskOf(frame)
  const askFor = pending?.record ?? null
  const follow = !askFor ? null : askFor.type === 'Party' ? (askFor.id === customer.id ? 'general' : null) : dock.pick && sameRecord(askFor, dock.pick) ? 'record' : null
  const latest = useRef(dock)
  latest.current = dock
  useEffect(() => {
    if (follow && latest.current.scope !== follow) latest.current.onScope(follow)
  }, [pending?.ask, follow])
  // ---- end F-OP-212
  if (general === null || general === undefined) return null
  const pick = dock.pick
  // F-OP-203: each segment with its icon and its short words for a narrow card (the order page's words, C-13).
  const choices: ThreadChoice<'general' | 'record' | 'all'>[] = [
    { value: 'general', label: t('customers.work.dock.general', { customer: customer.name }), short: o('record.dock.writeGeneral'), icon: <Building2 size={14} aria-hidden />, line: t('customers.work.dock.generalLine', { customer: customer.name }) },
    ...(pick ? [{ value: 'record' as const, label: pick.label, icon: <RecordTypeIcon type={pick.type} size={14} />, line: t('customers.work.dock.recordLine', { record: pick.label, customer: customer.name }) }] : []),
    // F-OP-204 (11-dock §2): the whose-line says it is read only and how to write (one place, one wording: the feed's own line left).
    // F-OP-213: offered only when the customer's own thread may be read (the feed's wall).
    ...(allOffered ? [{ value: 'all' as const, label: t('customers.work.dock.all', { customer: customer.name }), short: rt('allOfCustomer.view.all'), title: t('customers.work.dock.readOnly'), icon: <Eye size={14} aria-hidden />, line: rt('allOfCustomer.line', { customer: customer.name }) }] : []),
  ]
  // F-OP-213: an address that names All of a reader may not read shows the general thread (no word that it existed).
  const scope = dock.scope === 'all' && !allOffered ? 'general' : dock.scope
  const onAnswer = (record: { readonly type: string; readonly id: string }, messageId: string) => {
    const entry = feed.state.entries.find((one) => one.record.type === record.type && one.record.id === record.id)
    dock.onAnswer({ type: record.type, id: record.id, label: entry?.record.label ?? record.type, companyId: entry?.record.companyId ?? null }, messageId)
  }
  // F-OP-205: the empty feed's door — the first message goes into the customer's general thread, the box on Office note.
  const writeFirst = { thread: t('customers.work.dock.general', { customer: customer.name }), onWrite: () => (frame?.compose ? frame.compose({ record: { type: 'Party', id: customer.id }, messageId: null, mode: 'note' }) : dock.onScope('general')) }
  // ---- F-OP-207 (11-dock §3.2, §3.4; D11): Answer in place on a line of the customer's general thread or of the record picked (the
  // frame's compose ask: the pick goes there first, the box focused — Reply on the customer's line, Office note otherwise); any other
  // record's line opens its page. The foot: "Read only. Write in: [<customer> (general)]" and the record picked, when one is.
  const canAnswer = (record: { readonly type: string; readonly id: string }) => (record.type === 'Party' ? record.id === customer.id : !!pick && sameRecord(record, pick))
  const writeIn = (record: { readonly type: string; readonly id: string }, fallback: 'general' | 'record') => (frame?.compose ? frame.compose({ record, messageId: null, mode: 'note' }) : dock.onScope(fallback))
  const allFoot = (
    <>
      <span>
        {t('customers.work.dock.readOnly')}. {o('record.dock.writeIn')}
      </span>
      <Button size="sm" variant="secondary" onClick={() => writeIn({ type: 'Party', id: customer.id }, 'general')}>
        {t('customers.work.dock.general', { customer: customer.name })}
      </Button>
      {pick && (
        <Button size="sm" variant="secondary" onClick={() => writeIn({ type: pick.type, id: pick.id }, 'record')}>
          {pick.label}
        </Button>
      )}
    </>
  )
  // ---- end F-OP-207
  // F-CP-111: the ONE viewer of the docked order's files (the container's walk: ← / → over the order's files; body data only when asked).
  const viewer = scope === 'record' ? (dock.orderFiles?.model.viewer ?? null) : null
  const filesActions = dock.orderFiles?.actions
  return (
    <>
      {viewer && (
        <FileViewer
          walk="all"
          files={viewer.files}
          index={viewer.index}
          onIndex={(index) => filesActions?.onViewerIndex?.(index)}
          onClose={() => filesActions?.onViewerClose?.()}
          onOpenLocked={filesActions?.onViewerOpenLocked}
          onDownload={filesActions?.onViewerDownload}
          returnFocusTo={viewer.returnTo}
        />
      )}
      <ThreadPick label={t('customers.work.dock.label')} choices={choices} value={scope} onPick={dock.onScope} note={dock.draftKept ? t('customers.work.dock.draftKept', { record: dock.draftKept }) : null}>
        {scope === 'record' && pick ? (
          <OfficeRecordThread
            key={`${pick.type}:${pick.id}`}
            docked
            record={{ type: pick.type, id: pick.id, companyId: pick.companyId, siteId: null }}
            title={`${pick.label} · ${customer.name}`}
            recordLabel={pick.label}
            party={{ id: customer.id, name: customer.name }}
            partyRole="customer"
            recordHref={`${prefix}${recordAddress({ type: pick.type, id: pick.id, label: pick.label, companyId: pick.companyId }, OFFICE_PAGES)}`}
            onDraft={(kept) => dock.onDraft(pick, kept)}
            {...(dock.orderFiles && pick.type === 'SalesOrder' ? { orderFiles: dock.orderFiles } : {}) /* F-CP-111: the files line = the order's file set */}
          />
        ) : scope === 'all' ? (
          // F-OP-203: All of <customer> in the dock's ONE card (DockColumn): the pick band on top, the read-only feed that scrolls.
          // F-OP-204: its Head row (FeedHead); this page IS the customer's, so its ⋯ has no "Open <customer>".
          <AllOfCustomerDock label={`${t('customers.work.dock.all', { customer: customer.name })} · ${t('customers.work.dock.readOnly')}`} model={feed.model} actions={{ ...feed.actions, onAnswer, writeFirst, canAnswer, ...(frame?.compose ? { onCompose: frame.compose } : {}) }} foot={allFoot} />
        ) : (
          general
        )}
      </ThreadPick>
    </>
  )
}
