'use client'

import { useEffect, useMemo, type ReactNode } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { WithMessages } from '../../../../../record-panels/i18n'
import { CustomerOverrideProvider } from '../../../../_shared/customer-override/CustomerOverride'
import { OfficeRecordThread } from '../../../../_shared/record-thread/OfficeRecordThread'
import { ThreadPick, type ThreadChoice } from '../../../../_shared/record-thread/ThreadPick'
import { doorListOf } from '../../../../home/approvals/requests/model'
import { useRequestReviewDoor } from '../../../../home/approvals/requests/use-request-review-door'
import { RequestDoorNoticeBanner, RequestDoorWindow } from '../../../../home/approvals/requests/view/RequestReview'
import type { OrderRow } from '../../../orders/api'
import type { RowView } from '../../../orders/model'
import { ORDERS_LIST_KEY, sheetAddress, useOrdersSheet, type OrdersSheetHost } from '../../../orders/list/use-orders-sheet'
import { OrdersListView, WAITING_US_VIEW } from '../../../orders/list/view/OrdersListView'
import type { OrdersListModel } from '../../../orders/list/list-model'
import { WORK_DEFAULT_ROWS, workEntry, type useCustomerWork, type WorkCan } from '../use-customer-work'
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

function WorkSheet({ party, prefix, work, can, picked, onPick, onWindow }: WorkTabProps) {
  const t = useT('parties')
  const o = useT('orders')
  const params = useSearchParams()
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
        <OrdersListView model={model} actions={sheet.actions} />
      </div>
      <RequestDoorWindow door={door} />
    </CustomerOverrideProvider>
  )
}

/**
 * F-SA-276 (11-customer-page §9.1, review C-13): the customer page's dock — the customer's own thread, and beside it the record a
 * row picked (an order of the Work tab, a quote or a request of Quotes & incoming): ONE thread at a time, picked with the shared
 * ThreadPick ("<customer> (general)" · the record), ONE line under it saying who reads what is written there. Writing always goes
 * into the one thread shown. The read-only "All of <customer>" choice comes with F-SA-279.
 */
export function CustomerDock({ customer, general, pick, scope, onScope, prefix }: { customer: { id: string; name: string }; general: ReactNode; pick: DockPick | null; scope: 'general' | 'record'; onScope: (scope: 'general' | 'record') => void; prefix: string }) {
  const t = useT('parties')
  if (!pick || general === null || general === undefined) return <>{general}</>
  const choices: ThreadChoice<'general' | 'record'>[] = [
    { value: 'general', label: t('customers.work.dock.general', { customer: customer.name }), line: t('customers.work.dock.generalLine', { customer: customer.name }) },
    { value: 'record', label: pick.label, line: t('customers.work.dock.recordLine', { record: pick.label, customer: customer.name }) },
  ]
  return (
    <ThreadPick label={t('customers.work.dock.label')} choices={choices} value={scope} onPick={onScope}>
      {scope === 'record' ? (
        <OfficeRecordThread
          key={`${pick.type}:${pick.id}`}
          docked
          record={{ type: pick.type, id: pick.id, companyId: pick.companyId, siteId: null }}
          title={`${pick.label} · ${customer.name}`}
          recordLabel={pick.label}
          party={{ id: customer.id, name: customer.name }}
          partyRole="customer"
          recordHref={`${prefix}${recordAddress({ type: pick.type, id: pick.id, label: pick.label, companyId: pick.companyId }, OFFICE_PAGES)}`}
        />
      ) : (
        general
      )}
    </ThreadPick>
  )
}
