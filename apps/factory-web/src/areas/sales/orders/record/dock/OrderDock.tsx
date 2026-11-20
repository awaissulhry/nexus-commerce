'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Building2, Eye, FolderKanban, Lock, ShoppingBag } from 'lucide-react' // F-OP-203: the segments' icons
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
import type { OrderFilesHost } from '../../../../_shared/record-thread/use-order-files' // F-OP-215
import { ThreadPick, type ThreadChoice } from '../../../../_shared/record-thread/ThreadPick'
import { useAllOfCustomer } from '../../../../_shared/record-thread/all-of-customer/use-all-of-customer'
import { ALL_OF_CUSTOMER_NS, AllOfCustomerDock } from '../../../../_shared/record-thread/all-of-customer/view/AllOfCustomerFeed'
import { messageHrefOf } from '../../../../_shared/record-thread/all-of-customer/model'
import { useInProject } from '../../../../products/projects/record/linked/use-in-project'
import { choiceOfScope, choicesOffered, ORDER_SCOPE, SCOPE_PARAM, scopeOfChoice, scopeOfParam, scopeShown, workOrderGroups, type DockWorkOrder, type OrderScope, type ScopeChoice, type ScopeOffer } from './model'
import { scopeValueOf } from './model' // F-OP-209
import { sameScope, scopeOfRecord, scopeParamOf } from './model' // F-OP-212
import { offerOf } from './model' // F-OP-213
import { pendingAskOf } from '../../../../_shared/record-frame/model' // F-OP-212
import { viewOpenOf } from '../../../../_shared/record-frame/model' // F-OP-212

/**
 * F-SA-262 (sales page plan N4; picks P9, P9', R4, R9; 10-order-page §6.1, §6.2; review C-13) — the order page's dock: ONE
 * conversation at a time, picked with the shared ThreadPick (the customer page's and the work order's look): This order (the default
 * on every arrival) · <Customer> (general) · Projects ▾ (each project linking the order) · Work orders ▾ (office only; per style ×
 * colourway; "For the floor" reaches the tablets) · All of <Customer> (read only; "Write in: This order · General"), each with its
 * "N new" (POST /threads/unread: the reader's own; a conversation the reader may not read gives no count). Under the pick ONE line
 * says who reads what is written there. The scope lives in the address (`?thread=…`, a replace: Back keeps it); each conversation
 * keeps its own draft (each is its own thread: its server draft and this device's); the box starts on Office note (rule 34).
 * A party-limited person sees only this order's customer (the page's own wall: they reach the order, so its customer).
 * F-OP-203 (order page plan N4; 11-dock §0.1): every scope sits in the dock's ONE card — the pick band first inside it (ThreadPick
 * hands it down), the Head, the body that scrolls, the foot; All of <customer> is that card too (PickedDockColumn).
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
  /** F-OP-215: the page's ONE order-files container — the files line of This order counts the order's set; All files → the Files tab. */
  readonly orderFiles?: OrderFilesHost
  /** F-OO-133: This order's conversation got another owner here — the page reads People again (the owner change emits no event). */
  readonly onOwnerChanged?: () => void
}

export function OrderDock(props: OrderDockProps) {
  return (
    <WithMessages namespaces={ALL_OF_CUSTOMER_NS}>
      <Dock {...props} />
    </WithMessages>
  )
}

function Dock({ order, workOrders, prefix, printHref, showOnPage, changeSide /* F-SA-244 */, orderFiles /* F-OP-215 */, onOwnerChanged /* F-OO-133 */ }: OrderDockProps) {
  const t = useT('orders')
  const rt = useT('record-thread') // F-OP-203: the short "All"
  const api = useOfficeApi()
  const session = useOfficeSession()
  const frame = useRecordFrame()
  const router = useRouter() // a line of another record opens its page (a push); the scope itself is the frame's (F-OP-209)
  const params = useSearchParams()
  const held = session.permissions
  const narrow = frame?.mode === 'stacked'
  const customer = order.partyName

  // ── what the reader may pick ──
  const projects = useInProject(api, { type: 'SalesOrder', id: order.id }, held.includes('threads.read'), prefix)
  const seesWork = held.includes('workorders.view')
  const ownWork = useMemo(() => (seesWork ? (workOrders ?? []) : []), [seesWork, workOrders])

  // ── "N new" of each conversation (the reader's own; again on a live message) — F-OP-213: and whether each one may be read ──
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
  // F-OP-213 (B-OP-061 is opt-in): the dock asks whether each of its threads may be read — the few records its pick offers.
  const readUnread = useMemo(() => (held.includes('threads.read') ? readUnreadWith(api, { readable: true }) : null), [api, held])
  const unread = useUnread(readUnread, unreadRows, tick)
  const fresh = (id: string) => unread[id]?.newCount ?? 0
  const freshOf = (ids: readonly string[]) => ids.reduce((sum, id) => sum + fresh(id), 0)
  const withNew = (label: string, count: number) => (count > 0 ? t('record.dock.withNew', { label, count }) : label)

  // F-OP-213 (11-dock §5, D4): General only when the reader may read the customer's thread, All only when General is.
  const offer: ScopeOffer = offerOf({ canRead: held.includes('threads.read'), partyReadable: unread[order.partyId]?.readable, projects: projects.map((project) => project.id), workOrders: ownWork.map((row) => row.id), seesWork })
  const asked = scopeOfParam(params?.get(SCOPE_PARAM))
  const scope = scopeShown(asked, offer)
  const last = useRef<{ project: string | null; wo: string | null }>({ project: null, wo: null })
  if (scope.kind === 'project') last.current.project = scope.id
  if (scope.kind === 'wo') last.current.wo = scope.id

  // F-OP-209: the frame's ONE writer of `thread=` (a history replace, only when the address changes: Back keeps the scope, a pick
  // asks the server nothing); the narrow view stays open while the person picks. A dock is always inside its frame.
  const go = (next: OrderScope, messageId: string | null = null) => frame?.setThread?.(scopeValueOf(next, narrow), { message: messageId })

  // ── F-SA-265: Discuss and Show in thread are about THIS order: the pick goes to its own conversation first (which reads the ask) ──
  // F-OP-212 (11-dock §5, D5): every frame ask names its record (files, Followers…, the owner door, Ask, Discuss, Show, Answer): the
  // pick goes to that record's thread first — this order's, its customer's general one, a linked project, a work order — keeping the
  // view as it is (below 1280 px with the view closed: no term, so a file opened from the body never pops the full-width thread open);
  // that thread then takes the ask. Once per ask: a later pick of the person is never undone.
  const pending = pendingAskOf(frame)
  const target = pending ? scopeOfRecord(pending.record, { orderId: order.id, partyId: order.partyId }, offer) : null
  const targetValue = target ? (scopeParamOf(target) ?? 'order') : null
  const follow = useRef({ scope, closed: !viewOpenOf(params?.get(SCOPE_PARAM)), narrow, frame })
  follow.current = { scope, closed: !viewOpenOf(params?.get(SCOPE_PARAM)), narrow, frame }
  useEffect(() => {
    const now = follow.current
    if (!target || sameScope(target, now.scope)) return
    now.frame?.setThread?.(scopeValueOf(target, now.narrow, now.closed))
  }, [pending?.ask, targetValue]) // eslint-disable-line react-hooks/exhaustive-deps

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
  // F-OP-205: the empty feed's door — the first message goes into this order's thread, the box on Office note (the frame's ask).
  const writeFirst = { thread: t('record.dock.order'), onWrite: () => (frame?.compose ? frame.compose({ record: { type: 'SalesOrder', id: order.id }, messageId: null, mode: 'note' }) : go(ORDER_SCOPE)) }
  // ---- F-OP-207 (11-dock §3.2, §3.4): Answer on a line of this order's, its customer's general or a linked project's thread opens THAT
  // thread at the message with the box focused (Reply on the customer's line, Office note otherwise) — the frame's compose ask, which
  // moves the pick there first; any other record's line opens its page. The foot's Write in: the same ask, the box on Office note.
  const page = { orderId: order.id, partyId: order.partyId }
  const canAnswer = (record: { readonly type: string; readonly id: string }) => scopeOfRecord(record, page, offer) !== null
  const writeIn = (record: { readonly type: string; readonly id: string }, fallback: OrderScope) => (frame?.compose ? frame.compose({ record, messageId: null, mode: 'note' }) : go(fallback))
  // ---- end F-OP-207

  // ── the pick ──
  const segments = choicesOffered(offer)
  const project = scope.kind === 'project' ? projects.find((one) => one.id === scope.id) : undefined
  const workOrder = scope.kind === 'wo' ? ownWork.find((one) => one.id === scope.id) : undefined
  // F-OP-203: each segment with its icon, its short words for a narrow card and its "N new" as a pill (the pick's own), never in the words.
  const choices: ThreadChoice<ScopeChoice>[] = segments.map((segment) => {
    if (segment === 'order') return { value: 'order', label: t('record.dock.order'), icon: <ShoppingBag size={14} aria-hidden />, count: fresh(order.id), line: t('record.dock.orderLine', { customer }) }
    if (segment === 'general') return { value: 'general', label: t('record.dock.general', { customer }), short: t('record.dock.writeGeneral'), icon: <Building2 size={14} aria-hidden />, count: fresh(order.partyId), line: t('record.dock.generalLine', { customer }) }
    if (segment === 'projects') {
      const label = projects.length === 1 ? projects[0]!.number : t('record.dock.projects')
      return { value: 'projects', label, short: t('record.dock.projects'), icon: <FolderKanban size={14} aria-hidden />, count: freshOf(offer.projects), line: t('record.dock.projectLine', { project: project?.number ?? projects[0]?.number ?? '', customer }) }
    }
    // Office only: its line in the office tone.
    if (segment === 'workOrders') return { value: 'workOrders', label: t('record.dock.workOrders'), icon: <Lock size={14} aria-hidden />, count: freshOf(offer.workOrders), tone: 'office', line: t('record.dock.workOrderLine', { wo: workOrder?.number ?? ownWork[0]?.number ?? '' }) }
    // F-OP-204 (11-dock §2): the whose-line says it is read only and how to write (one place, one wording: the feed's own line left).
    return { value: 'all', label: t('record.dock.all', { customer }), short: rt('allOfCustomer.view.all'), title: t('record.dock.readOnly'), icon: <Eye size={14} aria-hidden />, line: rt('allOfCustomer.line', { customer }) }
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
    // F-OP-203: All of <customer> in the dock's ONE card (DockColumn): the pick band on top, the read-only feed that scrolls, the foot.
    // F-OP-204: its Head row (FeedHead: View ▾, Kind ▾, N new · Show, the width menu, ⋯ with Open <customer>).
    shown = (
      <AllOfCustomerDock
        label={`${t('record.dock.all', { customer })} · ${t('record.dock.readOnly')}`}
        model={feed.model}
        actions={{ ...feed.actions, onAnswer, writeFirst, canAnswer, ...(frame?.compose ? { onCompose: frame.compose } : {}) /* F-OP-207 */ }}
        customerHref={`${prefix}/sales/customers/${encodeURIComponent(order.partyId)}`}
        foot={
          // Writing always goes into ONE conversation: the two the person may pick here. F-OP-207: "Read only. Write in:", each door
          // opens its thread with the box focused on Office note (the frame's compose ask).
          <>
            <span>
              {t('record.dock.readOnly')}. {t('record.dock.writeIn')}
            </span>
            <Button size="sm" variant="secondary" onClick={() => writeIn({ type: 'SalesOrder', id: order.id }, ORDER_SCOPE)}>
              {t('record.dock.order')}
            </Button>
            {offer.general && (
              <Button size="sm" variant="secondary" onClick={() => writeIn({ type: 'Party', id: order.partyId }, { kind: 'general' })}>
                {t('record.dock.writeGeneral')}
              </Button>
            )}
          </>
        }
      />
    )
  } else {
    shown = <OfficeRecordThread key="order" docked record={{ type: 'SalesOrder', id: order.id, companyId: order.companyId, siteId: null }} title={`${order.number} · ${customer}`} recordLabel={order.number} party={{ id: order.partyId, name: customer }} partyRole="customer" {...(printHref ? { printHref } : {})} {...(showOnPage ? { showOnPage } : {}) /* F-SA-265 */} {...(changeSide ? { changeSide } : {}) /* F-SA-244 */} {...(orderFiles ? { orderFiles } : {}) /* F-OP-215 */} {...(onOwnerChanged ? { onOwnerChanged } : {}) /* F-OO-133: This order's own conversation only */} />
  }

  return (
    <ThreadPick label={t('record.dock.label')} choices={choices} value={choiceOfScope(scope)} onPick={(choice) => go(scopeOfChoice(choice, offer, last.current))} extra={extra}>
      {shown}
    </ThreadPick>
  )
}
