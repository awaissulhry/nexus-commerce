'use client'

import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Building2, Eye } from 'lucide-react' // F-OP-203: the segments' icons
import { Button, Skeleton } from '@nexus/ui/primitives'
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
import type { RowView } from '../../../orders/model'
import { ORDERS_LIST_KEY, sheetAddress, useOrdersSheet, type OrdersSheetHost } from '../../../orders/list/use-orders-sheet'
import { OrdersListView, WAITING_US_VIEW } from '../../../orders/list/view/OrdersListView'
import type { OrdersListModel } from '../../../orders/list/list-model'
import { WORK_DEFAULT_ROWS, workEntry, type useCustomerWork, type WorkCan } from '../use-customer-work'
// ---- F-SA-279: the dock follows the row; All of <customer> in the dock ----
import type { useCustomerDock } from '../use-customer-work'
import { useRecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { pendingAskOf, sameRecord } from '../../../../_shared/record-frame/model' // F-OP-212: the dock follows an ask's record
import type { useAllOfCustomer } from '../../../../_shared/record-thread/all-of-customer/use-all-of-customer'
import { ALL_OF_CUSTOMER_NS, AllOfCustomerDock } from '../../../../_shared/record-thread/all-of-customer/view/AllOfCustomerFeed'
// ---- end F-SA-279
import { WaitingStrip, type StripDoors } from './WaitingStrip'
import './customer-work.css'

/**
 * F-SA-276 (sales page plan N5, N7, N3; picks R5, R9, P10, P17; 11-customer-page §3; 17-review R-1; picture 21) — the customer's
 * Work tab, no tabs inside the tab: the waiting strip on top, then the ONE Orders sheet (useOrdersSheet) locked to the customer —
 * embedded (the customer's band is the page's), its terms in the page's address beside the page's own `tab` and `dock`, list key
 * 'sales.orders' (one export source, one set of saved views: a view saved here keeps the lock). Its built-in views: In production
 * (the default, written into the address on entry) · Waiting on us · Late · All orders. A row click switches the page's dock to that
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

/** The Work tab's built-in views, in their order (R5). */
export const WORK_VIEWS: readonly string[] = Object.freeze([WORK_DEFAULT_ROWS, WAITING_US_VIEW, 'late', 'all'])

/**
 * The columns a view shows at first (11-customer-page §3.5; a person's Customise wins): In production — no Status (every row is in
 * production); All orders — Status, Waiting on from 1800 px; the other views — Status and Waiting on. Customer and Brand never (the
 * customer is the page's).
 */
export function workPreset(rows: RowView, waiting: 'us' | null): NonNullable<OrdersListModel['preset']> {
  if (rows === 'all' && !waiting) return { shown: ['picture', 'number', 'status', 'whereItIs', 'promised', 'newMessages'], wide: ['waitingOn', 'priority', 'deposit', 'balance'] }
  if (rows === WORK_DEFAULT_ROWS && !waiting) return { shown: ['picture', 'number', 'whereItIs', 'promised', 'waitingOn', 'newMessages'], wide: ['priority', 'deposit', 'balance', 'supervisor'] }
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

function WorkSheet({ party, prefix, work, can, picked, onPick, onFocus, onWindow }: WorkTabProps) {
  const t = useT('parties')
  const o = useT('orders')
  const params = useSearchParams()
  const frame = useRecordFrame() // F-SA-279: a phone card's door shows the conversation (the full-width view)
  const basePath = `/sales/customers/${encodeURIComponent(party.id)}`
  const host: OrdersSheetHost = {
    basePath,
    locked: { party: party.id },
    embedded: true,
    keep: ['tab', 'dock'],
    listKey: ORDERS_LIST_KEY,
    // A row click docks the order's conversation; ⌘ / Ctrl opens the order in a new tab.
    onRowClick: (row, newTab) => (newTab ? window.open(`${prefix}/sales/orders/${encodeURIComponent(row.id)}`, '_blank', 'noopener') : onPick(pickOfRow(row))),
  }
  const sheet = useOrdersSheet(host)
  // The review window on this page (the four-door window): the customer's requests that wait on us, a batch as one entry.
  const requests = work.reads.requests.status === 'ready' ? work.reads.requests.value : null
  const list = useMemo(() => doorListOf((requests?.items ?? []).filter((request) => request.waitingOn === 'US')), [requests])
  const door = useRequestReviewDoor({ ids: list.ids, batches: list.batches, onChanged: work.reload })
  const rows = sheet.model.rows
  const waiting = sheet.model.waiting ?? null
  const all = `${prefix}${sheetAddress(basePath, host, params, { rows: 'all', q: '', layout: 'list', party: party.id })}`
  const model: OrdersListModel = {
    ...sheet.model,
    views: WORK_VIEWS,
    defaultRows: WORK_DEFAULT_ROWS,
    preset: workPreset(rows, waiting),
    marks: work.marks,
    doorHref: door.hrefOf,
    toolbarLink: can.workorders ? { href: `${prefix}/production/work-orders?party=${encodeURIComponent(party.id)}`, label: t('customers.band.workOrders', { customer: party.name }) } : null,
    empty: rows === WORK_DEFAULT_ROWS && !waiting ? { title: t('customers.work.empty', { customer: party.name }), link: { href: all, label: t('customers.work.showAll') } } : (sheet.model.empty ?? null),
    // F-SA-279: the row the dock shows is marked; the keys' row is reported (the dock follows after its rest); a phone card's door.
    active: can.threads ? { id: picked && picked.type === 'SalesOrder' ? picked.id : null, cardDoor: t('customers.work.dock.cardDoor') } : null,
  }
  const actions = {
    ...sheet.actions,
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
    onView: (view) => (view === 'waitingUs' ? sheet.actions.onWaiting?.('us', 'open') : waiting ? sheet.actions.onWaiting?.(null, view) : sheet.actions.onRows?.(view)),
    repliesHref: `${prefix}/sales/incoming?tile=CUSTOMER_REPLIES&party=${encodeURIComponent(party.id)}`,
    onWindow,
    onRetry: work.retry,
  }
  // The picked order left the view (it moved on, live): the dock keeps its conversation; one line says so, with the way back.
  const items = sheet.model.list.items
  const gone = picked && picked.type === 'SalesOrder' && items && sheet.model.updates === 0 && !items.some((row) => row.id === picked.id) && !(rows === 'all' && !waiting)
  const viewName = waiting ? t('customers.work.view.waitingUs') : o(`rows.${rows}`)
  return (
    <CustomerOverrideProvider onDone={door.refresh}>
      <div className="fw-cw">
        <RequestDoorNoticeBanner door={door} />
        <WaitingStrip customer={party.name} reads={work.reads} can={can} doors={doors} />
        {gone && (
          <p className="fw-cw-line" role="status">
            <span>{t('customers.work.gone', { record: picked?.label ?? '', view: viewName })}</span>
            <Button size="sm" variant="quiet" onClick={() => (waiting ? sheet.actions.onWaiting?.(null, 'all') : sheet.actions.onRows?.('all'))}>
              {t('customers.work.showAll')}
            </Button>
          </p>
        )}
        <OrdersListView model={model} actions={actions /* F-SA-279 */} />
      </div>
      <RequestDoorWindow door={door} />
    </CustomerOverrideProvider>
  )
}

type CustomerFeed = ReturnType<typeof useAllOfCustomer>
type DockProps = { customer: { id: string; name: string }; general: ReactNode; dock: ReturnType<typeof useCustomerDock>; feed: CustomerFeed; prefix: string }

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
const CUSTOMER_DOCK_NS = [...ALL_OF_CUSTOMER_NS, 'orders'] as const

export function CustomerDock(props: DockProps) {
  return (
    <WithMessages namespaces={CUSTOMER_DOCK_NS}>
      <Dock {...props} />
    </WithMessages>
  )
}

function Dock({ customer, general, dock, feed, prefix }: DockProps) {
  const t = useT('parties')
  const o = useT('orders') // F-OP-203
  const rt = useT('record-thread') // F-OP-203
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
    { value: 'all', label: t('customers.work.dock.all', { customer: customer.name }), short: rt('allOfCustomer.view.all'), title: t('customers.work.dock.readOnly'), icon: <Eye size={14} aria-hidden />, line: rt('allOfCustomer.line', { customer: customer.name }) },
  ]
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
  return (
    <ThreadPick label={t('customers.work.dock.label')} choices={choices} value={dock.scope} onPick={dock.onScope} note={dock.draftKept ? t('customers.work.dock.draftKept', { record: dock.draftKept }) : null}>
      {dock.scope === 'record' && pick ? (
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
        />
      ) : dock.scope === 'all' ? (
        // F-OP-203: All of <customer> in the dock's ONE card (DockColumn): the pick band on top, the read-only feed that scrolls.
        // F-OP-204: its Head row (FeedHead); this page IS the customer's, so its ⋯ has no "Open <customer>".
        <AllOfCustomerDock label={`${t('customers.work.dock.all', { customer: customer.name })} · ${t('customers.work.dock.readOnly')}`} model={feed.model} actions={{ ...feed.actions, onAnswer, writeFirst, canAnswer, ...(frame?.compose ? { onCompose: frame.compose } : {}) }} foot={allFoot} />
      ) : (
        general
      )}
    </ThreadPick>
  )
}
