'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Button, Select } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { readUnreadWith } from '../../../../../lib/last-message-cell/api'
import { useUnread } from '../../../../../lib/last-message-cell/use-unread'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { WithMessages } from '../../../../../record-panels/i18n'
import { useLiveBus } from '../../../../../shell/live/use-live'
import { useRecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { OfficeRecordThread } from '../../../../_shared/record-thread/OfficeRecordThread'
import type { DockedHost } from '../../../../_shared/record-thread/DockedOfficeThread' // F-SA-244
import { ThreadPick, type ThreadChoice } from '../../../../_shared/record-thread/ThreadPick'
import { useAllOfCustomer } from '../../../../_shared/record-thread/all-of-customer/use-all-of-customer'
import { ALL_OF_CUSTOMER_NS, AllOfCustomerFeed } from '../../../../_shared/record-thread/all-of-customer/view/AllOfCustomerFeed'
import { messageHrefOf } from '../../../../_shared/record-thread/all-of-customer/model'
import { useInProject } from '../../../../products/projects/record/linked/use-in-project'
import { choiceOfScope, choicesOffered, ORDER_SCOPE, SCOPE_PARAM, scopeAddress, scopeOfChoice, scopeOfParam, scopeShown, workOrderGroups, type DockWorkOrder, type OrderScope, type ScopeChoice, type ScopeOffer } from './model'

/**
 * F-SA-262 (sales page plan N4; picks P9, P9', R4, R9; 10-order-page §6.1, §6.2; review C-13) — the order page's dock: ONE
 * conversation at a time, picked with the shared ThreadPick (the customer page's and the work order's look): This order (the default
 * on every arrival) · <Customer> (general) · Projects ▾ (each project linking the order) · Work orders ▾ (office only; per style ×
 * colourway; "For the floor" reaches the tablets) · All of <Customer> (read only; "Write in: This order · General"), each with its
 * "N new" (POST /threads/unread: the reader's own; a conversation the reader may not read gives no count). Under the pick ONE line
 * says who reads what is written there. The scope lives in the address (`?thread=…`, a replace: Back keeps it); each conversation
 * keeps its own draft (each is its own thread: its server draft and this device's); the box starts on Office note (rule 34).
 * A party-limited person sees only this order's customer (the page's own wall: they reach the order, so its customer).
 */
export interface OrderDockProps {
  readonly order: { readonly id: string; readonly number: string; readonly companyId: string; readonly partyId: string; readonly partyName: string; readonly partyCode: string | null }
  /** The work orders the production read gives this reader (its wall), with their sites from the order's chain; null: not read. */
  readonly workOrders: readonly (DockWorkOrder & { readonly siteId: string | null })[] | null
  readonly prefix: string
  /** The order's print view (the Head's Print line, this order's own conversation only). */
  readonly printHref?: string
  /** F-SA-265: a message about a part of the order jumps back to its row ("Show on the page"). */
  readonly showOnPage?: (about: { kind: string; id: string }) => void
  /** F-SA-244: the conversation side of a change on THIS order's conversation (the asks' chips, the change lines, their doors). */
  readonly changeSide?: DockedHost['changeSide']
}

export function OrderDock(props: OrderDockProps) {
  return (
    <WithMessages namespaces={ALL_OF_CUSTOMER_NS}>
      <Dock {...props} />
    </WithMessages>
  )
}

function Dock({ order, workOrders, prefix, printHref, showOnPage, changeSide /* F-SA-244 */ }: OrderDockProps) {
  const t = useT('orders')
  const api = useOfficeApi()
  const session = useOfficeSession()
  const frame = useRecordFrame()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const held = session.permissions
  const narrow = frame?.mode === 'stacked'
  const customer = order.partyName

  // ── what the reader may pick ──
  const projects = useInProject(api, { type: 'SalesOrder', id: order.id }, held.includes('threads.read'), prefix)
  const seesWork = held.includes('workorders.view')
  const ownWork = useMemo(() => (seesWork ? (workOrders ?? []) : []), [seesWork, workOrders])
  const offer: ScopeOffer = { general: true, all: true, projects: projects.map((project) => project.id), workOrders: ownWork.map((row) => row.id) }
  const asked = scopeOfParam(params?.get(SCOPE_PARAM))
  const scope = scopeShown(asked, offer)
  const last = useRef<{ project: string | null; wo: string | null }>({ project: null, wo: null })
  if (scope.kind === 'project') last.current.project = scope.id
  if (scope.kind === 'wo') last.current.wo = scope.id

  // A replace: Back keeps the scope; the narrow view stays open while the person picks.
  const go = (next: OrderScope, messageId: string | null = null) => {
    const address = scopeAddress(pathname, window.location.search, next, narrow, messageId)
    if (address !== `${pathname}${window.location.search}`) router.replace(address, { scroll: false })
  }

  // ── F-SA-265: Discuss and Show in thread are about THIS order: the pick goes to its own conversation first (which reads the ask) ──
  const asking = frame?.discussAsk?.record.id === order.id || frame?.showAsk?.record.id === order.id
  const goRef = useRef(go)
  goRef.current = go
  useEffect(() => {
    if (asking && scope.kind !== 'order') goRef.current(ORDER_SCOPE)
  }, [asking, scope.kind])

  // ── "N new" of each conversation (the reader's own; again on a live message) ──
  const [tick, setTick] = useState(0)
  useLiveBus({ onChange: (change) => change.type.startsWith('thread.') && setTick((value) => value + 1), onReconnect: () => setTick((value) => value + 1) }, held.includes('threads.read'))
  const unreadRows = useMemo(
    () => [
      { recordType: 'SalesOrder', id: order.id },
      { recordType: 'Party', id: order.partyId },
      ...projects.map((project) => ({ recordType: 'Project', id: project.id })),
      ...ownWork.map((row) => ({ recordType: 'WorkOrder', id: row.id })),
    ],
    [order.id, order.partyId, projects, ownWork],
  )
  const readUnread = useMemo(() => (held.includes('threads.read') ? readUnreadWith(api) : null), [api, held])
  const unread = useUnread(readUnread, unreadRows, tick)
  const fresh = (id: string) => unread[id]?.newCount ?? 0
  const freshOf = (ids: readonly string[]) => ids.reduce((sum, id) => sum + fresh(id), 0)
  const withNew = (label: string, count: number) => (count > 0 ? t('record.dock.withNew', { label, count }) : label)

  // ── All of <customer> (read only; read only while it shows) ──
  const feed = useAllOfCustomer(api, { partyId: order.partyId, customerName: customer, enabled: scope.kind === 'all', prefix, canReadFiles: held.includes('files.read') })
  const onAnswer = (record: { readonly type: string; readonly id: string }, messageId: string) => {
    // This order's, the general one, a linked project: the dock moves to it at that message; any other record: its own page.
    if (record.type === 'SalesOrder' && record.id === order.id) return go(ORDER_SCOPE, messageId)
    if (record.type === 'Party' && record.id === order.partyId) return go({ kind: 'general' }, messageId)
    if (record.type === 'Project' && offer.projects.includes(record.id)) return go({ kind: 'project', id: record.id }, messageId)
    const entry = feed.state.entries.find((one) => one.record.type === record.type && one.record.id === record.id && one.message.id === messageId)
    if (entry) router.push(messageHrefOf(entry, prefix))
  }

  // ── the pick ──
  const segments = choicesOffered(offer)
  const project = scope.kind === 'project' ? projects.find((one) => one.id === scope.id) : undefined
  const workOrder = scope.kind === 'wo' ? ownWork.find((one) => one.id === scope.id) : undefined
  const choices: ThreadChoice<ScopeChoice>[] = segments.map((segment) => {
    if (segment === 'order') return { value: 'order', label: withNew(t('record.dock.order'), fresh(order.id)), line: t('record.dock.orderLine', { customer }) }
    if (segment === 'general') return { value: 'general', label: withNew(t('record.dock.general', { customer }), fresh(order.partyId)), line: t('record.dock.generalLine', { customer }) }
    if (segment === 'projects') {
      const label = projects.length === 1 ? projects[0]!.number : t('record.dock.projects')
      return { value: 'projects', label: withNew(label, freshOf(offer.projects)), line: t('record.dock.projectLine', { project: project?.number ?? projects[0]?.number ?? '', customer }) }
    }
    if (segment === 'workOrders') return { value: 'workOrders', label: withNew(t('record.dock.workOrders'), freshOf(offer.workOrders)), line: t('record.dock.workOrderLine', { wo: workOrder?.number ?? ownWork[0]?.number ?? '' }) }
    // The feed says itself that it is read only and how to write (its own line).
    return { value: 'all', label: t('record.dock.all', { customer }), title: t('record.dock.readOnly'), line: null }
  })
  const extra =
    scope.kind === 'project' && projects.length > 1 ? (
      <Select size="sm" aria-label={t('record.dock.projectPick')} value={scope.id} onChange={(event) => go({ kind: 'project', id: event.target.value })}>
        {projects.map((one) => (
          <option key={one.id} value={one.id}>
            {withNew(one.number, fresh(one.id))}
          </option>
        ))}
      </Select>
    ) : scope.kind === 'wo' ? (
      <Select size="sm" aria-label={t('record.dock.workOrderPick')} value={scope.id} onChange={(event) => go({ kind: 'wo', id: event.target.value })}>
        {workOrderGroups(ownWork).map((group) => (
          <optgroup key={group.key} label={group.label || (group.items[0]?.mtm ? t('record.madeToMeasure') : t('record.dock.workOrders'))}>
            {group.items.map((one) => (
              <option key={one.id} value={one.id}>
                {withNew(one.number, fresh(one.id))}
              </option>
            ))}
          </optgroup>
        ))}
      </Select>
    ) : null

  let shown: ReactNode
  if (scope.kind === 'general') {
    shown = <OfficeRecordThread key="general" docked record={{ type: 'Party', id: order.partyId, companyId: null, siteId: null }} title={`${customer}${order.partyCode ? ` · ${order.partyCode}` : ''}`} recordLabel={order.partyCode ?? customer} party={{ id: order.partyId, name: customer }} partyRole="customer" recordHref={`${prefix}/sales/customers/${encodeURIComponent(order.partyId)}`} />
  } else if (scope.kind === 'project' && project) {
    shown = <OfficeRecordThread key={`project-${project.id}`} docked record={{ type: 'Project', id: project.id, companyId: null, siteId: null }} title={`${project.number} · ${customer}`} recordLabel={project.number} party={{ id: order.partyId, name: customer }} partyRole="customer" recordHref={project.href} />
  } else if (scope.kind === 'wo' && workOrder) {
    // Office only: no party (never shared with a customer); a note may go to the floor with its tick.
    shown = <OfficeRecordThread key={`wo-${workOrder.id}`} docked record={{ type: 'WorkOrder', id: workOrder.id, companyId: order.companyId, siteId: workOrder.siteId }} title={`${workOrder.number}${workOrder.style ? ` · ${workOrder.style}` : ''}`} recordLabel={workOrder.number} party={null} recordHref={`${prefix}/production/work-orders/${encodeURIComponent(workOrder.id)}`} />
  } else if (scope.kind === 'all') {
    shown = (
      <div className="fw-so-dock-all">
        <AllOfCustomerFeed model={feed.model} actions={{ ...feed.actions, onAnswer }} />
        {/* Writing always goes into ONE conversation: the two the person may pick here. */}
        <p className="fw-so-dock-write">
          <span>{t('record.dock.writeIn')}</span>
          <Button size="sm" variant="secondary" onClick={() => go(ORDER_SCOPE)}>
            {t('record.dock.order')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => go({ kind: 'general' })}>
            {t('record.dock.writeGeneral')}
          </Button>
        </p>
      </div>
    )
  } else {
    shown = <OfficeRecordThread key="order" docked record={{ type: 'SalesOrder', id: order.id, companyId: order.companyId, siteId: null }} title={`${order.number} · ${customer}`} recordLabel={order.number} party={{ id: order.partyId, name: customer }} partyRole="customer" {...(printHref ? { printHref } : {})} {...(showOnPage ? { showOnPage } : {}) /* F-SA-265 */} {...(changeSide ? { changeSide } : {}) /* F-SA-244 */} />
  }

  return (
    <ThreadPick label={t('record.dock.label')} choices={choices} value={choiceOfScope(scope)} onPick={(choice) => go(scopeOfChoice(choice, offer, last.current))} extra={extra}>
      {shown}
    </ThreadPick>
  )
}
