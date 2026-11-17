'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { MoreHorizontal, PauseCircle, Plus, Printer, Rocket, Search, Zap } from 'lucide-react'
import { Banner, EmptyState, Menu, MetricStrip, ProgressBar } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useScopedT, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { WorkOrderRow } from '../../_shared/api'
import { LIST_VIEWS, STATUS_TONE, type ListView } from '../../_shared/model'
import { WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'
import type { ListEdit, ListQuick } from '../../../../list-frame/w2b/model'
import type { WorkOrdersListActions, WorkOrdersListModel } from '../list-model'
import { NewWorkOrderDialog } from './NewWorkOrderDialog'
import { bulkHoldHeld, DAILY_NAMESPACE, HOLDABLE } from '../daily/model'
import { HoldDialog } from '../daily/view/DailyDialogs'
import { ReadinessPill, say } from '../daily/view/DailyParts'
import { releaseHeld, RUSH_CHOICES, SHIFT_NAMESPACE, travellersHeld, travellersHref } from '../every-shift/model'
import { ReleaseReview } from '../every-shift/view/ReleaseReview'
import '../../_shared/production.css'
// ---- F-PR-03: the list by risk (Customer with its orders and POs, Stage, Done, Health, Waiting on, Blocked by; filters, groups) ----
import { HealthPill } from '../../../../lib/production/view/HealthPill'
import { WaitingOnPill } from '../../../../lib/production/view/WaitingOnPill'
import { CustomerFilter } from '../../_shared/customer/view/CustomerFilter'
import type { ListGroups } from '../../../../list-frame/groups/model'
import type { ListSort } from '../../_shared/api'
// F-PR-21: the production supervisor — the column (Me / Someone else / Not set), "Assign supervisor…", THE assign dialog.
import { UserCog } from 'lucide-react'
import { assignHeld, markKeyOf, SUPERVISOR_NS, targetsOfRows } from '../../../_shared/production-supervisor/model'
import { AssignSupervisorDialog } from '../../../_shared/production-supervisor/view/AssignSupervisorDialog'
import {
  blockedKeyOf,
  boardMarksOf,
  cleared,
  customerCellOf,
  customerGroupsOf,
  doneOf,
  FILTER_CHOICES,
  filterChange,
  groupFigures,
  groupKeyOf,
  healthCellOf,
  listAddress,
  listTiles,
  narrowed,
  SORT_CHOICES,
  stageLineOf,
  termsOf,
  waitingInputOf,
  type ListTerms,
  // F-PR-18: the Customer urgency column (under Columns ▾) and its filter.
  customerUrgencyCellOf,
} from '../list/model'
// F-PR-22: "Note to N…" on a selection and a row's "Office note…" (THE note dialog).
import { MessageSquareLock } from 'lucide-react'
import { NOTES_NS, openHeld } from '../../_shared/notes/model'
import { NoteDialog } from '../../_shared/notes/view/NoteDialog'
// ---- end F-PR-03

export type { WorkOrdersListActions, WorkOrdersListModel } from '../list-model'

/**
 * F-PR-03 (production plan §5, 06-tree A.3): sorted by risk by default (Sort ▾ Risk first · Due date · Newest first); the columns
 * Work order · Customer (its name, each sales order as a link, the customer PO) · Style · Stage (the state and the furthest step) ·
 * Done (finished, bar and words one figure) · Due · Health (late, at risk, blocked, on track) · Waiting on · Blocked by · ⋯, with
 * Pieces, Readiness, Priority and Site under Columns ▾; the customer filter and the quick filters Waiting on, Health, Blocked by
 * (each a chip); Group ▾ By customer (each header the server's figures for that customer); the tiles At risk and Waiting on
 * customer; board cards with the customer code, the health and who the work waits on. Hold N as before. Key hints only in the
 * footer's information icon (the frame's).
 *
 * SCR-069 — Work orders (Production; design production.workorders, 00 §2.1 list frame): the tiles (each a saved view),
 * the shared list frame (search by number, batch or style; Rows ▾ views; select-all, shift range, x; Export N, Edit N
 * and Release N while rows are selected; live changes behind "N updates · Show"; B-W2b-13: Table · Board · Calendar ·
 * Cards, the due quick filter, the due date and priority edited in the grid), each number a real link to the work order
 * studio, progress from the floor (cut / bundled / sewn / finished), due dates with days late, and the New work order
 * dialog (`c`). B-W2b-59: the rush flag beside the priority (edited with Edit N, the quick filter Rush), Release N through
 * the review with each row's blockers, Print travellers (a new tab). Totals per work order only: no person's output
 * anywhere (Statuto dei Lavoratori art. 4). No money.
 */
export function WorkOrdersListView({ model, actions }: { model: WorkOrdersListModel; actions?: WorkOrdersListActions }) {
  return (
    <WithMessages namespaces={['production', DAILY_NAMESPACE, SHIFT_NAMESPACE, 'lists', /* F-PR-21 */ SUPERVISOR_NS, /* F-PR-22 */ NOTES_NS]}>
      <WorkOrdersList model={model} actions={actions} />
    </WithMessages>
  )
}

function WorkOrdersList({ model, actions }: { model: WorkOrdersListModel; actions?: WorkOrdersListActions }) {
  const t = useT('production')
  const lists = useT('lists')
  const locale = useLocale()
  const [query, setQuery] = useState(model.q)
  useEffect(() => setQuery(model.q), [model.q])
  const typed = useRef(false)
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current.actions?.onSearch?.(query), 300)
    return () => clearTimeout(timer)
  }, [query])
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [help, setHelp] = useState(!!model.helpOpen)
  const items = model.rows.items
  const rowsKey = items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])

  // c: a new work order (00 §3.17) — never while typing or inside a dialog. The list frame keeps / j k x Enter ?.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.newOrder || model.release || help) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || target.isContentEditable)) return
      if (event.key === 'c' && model.can.manage) {
        event.preventDefault()
        actions?.onNew?.(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const picked = (items ?? []).filter((row) => selected.includes(row.id))
  // B-W2b-59: Release N and Print travellers, selection-aware (design page.h "Release…", "Print travellers").
  const ts = useT(SHIFT_NAMESPACE)
  const heldWords = useScopedT('production')
  const releaseWait = releaseHeld(picked, model.can)
  const releaseWaitWords = releaseWait ? heldWords(releaseWait.key, releaseWait.params) : null
  const travellerIds = (picked.length > 0 ? picked : (items ?? [])).map((row) => row.id)
  const travellerWait = travellersHeld(travellerIds)
  const travellerWaitWords = travellerWait ? heldWords(travellerWait.key, travellerWait.params) : null
  // B-W2a-46: the readiness word column, Hold N (wo-grid "'Hold' (W2a)"), notices of either catalogue.
  const tw = useT(DAILY_NAMESPACE)
  const notices = useScopedT('production')
  const readiness = model.readiness ?? null
  const daily = model.daily ?? null
  const holdWait = daily ? say(tw, bulkHoldHeld(picked, daily.can)) : null
  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('list.keyNew') }]
  // F-PR-21: why "Assign supervisor…" waits (no right, no customer order, over 100 orders).
  const tsv = useT(SUPERVISOR_NS)
  const assignWait = assignHeld(model.supervisorCan ?? { manage: false }, targetsOfRows(picked, false))
  const assignWaitWords = assignWait ? tsv(assignWait.key, assignWait.params) : null
  // F-PR-03: a customer cell names the customer with parties.view, else its code (06-tree A.0).
  const names = model.customers?.names ?? false
  // F-PR-22: why "Note to N…" / a row's "Office note…" waits (no threads.post, over 100 work orders).
  const tn = useT(NOTES_NS)
  const noteCan = model.noteCan ?? false
  const noteWait = openHeld(noteCan, picked.length)
  const noteWaitWords = noteWait ? tn(noteWait.key, noteWait.params) : null
  const rowNoteWait = openHeld(noteCan, 1)
  const rowNoteWaitWords = rowNoteWait ? tn(rowNoteWait.key, rowNoteWait.params) : null

  const columns = useMemo<ColDef<WorkOrderRow>[]>(() => {
    const href = (row: WorkOrderRow) => `${model.prefix}/production/work-orders/${row.id}`
    const NumberCell = ({ data }: ICellRendererParams<WorkOrderRow>) =>
      data ? (
        <span className="fw-pr-cell">
          <Link className="fw-pr-link" href={href(data)}>
            {data.number}
          </Link>
          <span className="fw-pr-cell-sub">{data.batchNumber ? t('list.batch', { batch: data.batchNumber }) : t('list.noBatch')}</span>
        </span>
      ) : null
    // F-PR-03: Stage = the state and, under it, the furthest step the floor counted (the same figure as before).
    const StatusCell = ({ data }: ICellRendererParams<WorkOrderRow>) => {
      if (!data) return null
      const line = stageLineOf(data)
      return (
        <span className="fw-pr-cell">
          <span>
            <Pill tone={STATUS_TONE[data.status]}>{t(`status.${data.status}`)}</Pill>
          </span>
          <span className="fw-pr-cell-sub">{t(line.key, line.params)}</span>
        </span>
      )
    }
    const StyleCell = ({ data }: ICellRendererParams<WorkOrderRow>) =>
      data ? (
        <span className="fw-pr-cell">
          <span className="fw-pr-ellipsis">
            {data.styleCode}
            {data.revision !== null ? ` · ${t('list.rev', { revision: data.revision })}` : ''}
          </span>
          <span className="fw-pr-cell-sub">
            {data.styleName} · {data.colourways.join(', ')}
          </span>
        </span>
      ) : null
    // F-PR-03: the customer (its name with parties.view, else its code), each sales order a link (orders.view) and its customer PO.
    const CustomerCell = ({ data }: ICellRendererParams<WorkOrderRow>) => {
      if (!data) return null
      const cell = customerCellOf(data, names)
      return (
        <span className="fw-pr-cell">
          <span className="fw-pr-ellipsis">{cell.name ?? (cell.mixed ? t('customer.mixed') : t('list.noCustomer'))}</span>
          <span className="fw-pr-cell-sub">
            {cell.orders.map((order, index) => (
              <span key={order.id}>
                {index > 0 ? ' · ' : ''}
                {model.can.orders ? (
                  <Link className="fw-pr-link" href={`${model.prefix}/sales/orders/${encodeURIComponent(order.id)}`}>
                    {order.number}
                  </Link>
                ) : (
                  order.number
                )}
                {order.po ? ` · ${t('list.po', { po: order.po })}` : ''}
              </span>
            ))}
          </span>
        </span>
      )
    }
    // F-PR-03: Done = finished of the pieces; the bar and its words are ONE figure (rule R5); not counted: no bar, said in words.
    const ProgressCell = ({ data }: ICellRendererParams<WorkOrderRow>) => {
      if (!data) return null
      const figure = doneOf(data)
      const words = t(figure.words.key, figure.words.params)
      return (
        <span className="fw-pr-progress">
          <ProgressBar value={figure.percent} ariaLabel={t('list.doneLabel', { number: data.number, figure: words })} height={6} />
          <span className="fw-pr-cell-sub">{words}</span>
        </span>
      )
    }
    // F-PR-03: Health from the row's risk (the shared chip; Blocked as its own words, the Blocked by column says by what).
    const HealthCell = ({ data }: ICellRendererParams<WorkOrderRow>) => {
      if (!data) return null
      const cell = healthCellOf(data)
      if (cell.kind === 'none') return <span>—</span>
      if (cell.kind === 'unknown') return <HealthPill face="office" computed={undefined} explain={false} />
      if (cell.kind === 'blocked')
        return (
          <Pill tone="warning" icon={<PauseCircle size={12} aria-hidden />}>
            {t('risk.BLOCKED')}
          </Pill>
        )
      return <HealthPill face="office" {...cell.input} explain={false} />
    }
    const WaitingCell = ({ data }: ICellRendererParams<WorkOrderRow>) => {
      if (!data) return null
      const input = waitingInputOf(data)
      return <WaitingOnPill face="office" who={input.who} since={input.since} now={model.now} />
    }
    const BlockedCell = ({ data }: ICellRendererParams<WorkOrderRow>) => {
      if (!data) return null
      const key = blockedKeyOf(data)
      return key ? <Tag tone="warning">{t(key)}</Tag> : <span>—</span>
    }
    // F-PR-21: the supervisor for the reader — never a name on a list (names only inside one record); no customer: "—".
    const SupervisorCell = ({ data }: ICellRendererParams<WorkOrderRow>) => {
      if (!data) return null
      const key = markKeyOf(data.supervisor)
      return key ? <span>{tsv(key)}</span> : <span>—</span>
    }
    // F-PR-18: the customer's own urgency (Urgent 2 · Urgent – asked · Regular · Set to regular by us); none: "—".
    const UrgencyCell = ({ data }: ICellRendererParams<WorkOrderRow>) => {
      if (!data) return null
      const cell = customerUrgencyCellOf(data)
      return cell ? <Tag tone={cell.tone}>{tw(cell.key, cell.params)}</Tag> : <span>—</span>
    }
    const DueCell = ({ data }: ICellRendererParams<WorkOrderRow>) =>
      data ? (
        data.dueDate ? (
          <span className="fw-pr-inline">
            {formatDate(`${data.dueDate}T12:00:00Z`, { locale })}
            {data.daysLate !== null && data.daysLate > 0 && <Tag tone="danger">{t('list.daysLate', { count: data.daysLate })}</Tag>}
          </span>
        ) : (
          <span>—</span>
        )
      ) : null
    const PriorityCell = ({ data }: ICellRendererParams<WorkOrderRow>) =>
      data ? (
        <span className="fw-pr-inline">
          {data.rush && (
            <Tag tone="danger">
              <Zap size={11} aria-hidden /> {ts('rush.word')}
            </Tag>
          )}
          <span>{data.priority}</span>
        </span>
      ) : null
    const ReadinessCell = ({ data }: ICellRendererParams<WorkOrderRow>) => {
      if (!data) return null
      const row = readiness?.[data.id]
      return row ? <ReadinessPill word={row.word} date={row.date} /> : <span>—</span>
    }
    const MoreCell = ({ data }: ICellRendererParams<WorkOrderRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { number: data.number }) }}
          items={[
            { id: 'open', label: t('list.open'), href: href(data) },
            { id: 'tab', label: t('list.openNewTab'), href: href(data), target: '_blank' },
            { id: 'cutting', label: t('tab.cutting'), href: `${href(data)}?tab=cutting` },
            { id: 'traveller', label: ts('docs.openTraveller'), href: travellersHref(model.prefix, [data.id]), target: '_blank' },
            // F-PR-22: an office note on this work order (or its sales orders), with @ and its supervisor asked.
            { id: 'note', label: tn('open.row'), ...(rowNoteWaitWords ? { disabled: true, description: rowNoteWaitWords } : { onSelect: () => latest.current.actions?.onNote?.([data.id], 'row') }) },
          ]}
        />
      ) : null
    // F-PR-03: Pieces, Readiness, Priority and Site under Columns ▾ (shown when a layout asks); the ids are the export's (B-PR-34).
    const later = (column: ColDef<WorkOrderRow>): ColDef<WorkOrderRow> => ({ ...column, hide: true, context: { ...((column.context as object | undefined) ?? {}), optIn: true } })
    return [
      { colId: 'number', headerName: t('col.number'), field: 'number', minWidth: 130, flex: 0.9, cellRenderer: NumberCell },
      { colId: 'customer', headerName: t('col.customer'), minWidth: 180, flex: 1.4, cellRenderer: CustomerCell },
      { colId: 'style', headerName: t('col.style'), field: 'styleCode', minWidth: 170, flex: 1.3, cellRenderer: StyleCell },
      { colId: 'status', headerName: t('col.stage'), field: 'status', minWidth: 150, flex: 1, cellRenderer: StatusCell },
      { colId: 'progress', headerName: t('col.done'), minWidth: 150, flex: 1, cellRenderer: ProgressCell },
      { colId: 'due', headerName: t('col.due'), field: 'dueDate', minWidth: 132, flex: 0.9, cellRenderer: DueCell },
      { colId: 'risk', headerName: t('col.health'), minWidth: 120, flex: 0.8, sortable: false, cellRenderer: HealthCell },
      { colId: 'waitingOn', headerName: t('col.waitingOn'), minWidth: 150, flex: 1, sortable: false, cellRenderer: WaitingCell },
      { colId: 'blockedBy', headerName: t('col.blockedBy'), minWidth: 110, flex: 0.7, sortable: false, cellRenderer: BlockedCell },
      // F-PR-21 (the export's column id `supervisor`).
      { colId: 'supervisor', headerName: tw('supervisor.column'), minWidth: 120, flex: 0.7, sortable: false, cellRenderer: SupervisorCell },
      later({ colId: 'pieces', headerName: t('col.pieces'), field: 'pieces', minWidth: 76, flex: 0.5, type: 'rightAligned' }),
      later({ colId: 'readiness', headerName: tw('readiness.column'), minWidth: 130, flex: 0.9, cellRenderer: ReadinessCell }),
      later({ colId: 'priority', headerName: t('col.priority'), field: 'priority', minWidth: 112, flex: 0.6, type: 'rightAligned', cellRenderer: PriorityCell }),
      later({ colId: 'site', headerName: t('col.site'), field: 'siteCode', minWidth: 80, flex: 0.5 }),
      // F-PR-18 (the export's column id `customerUrgency`): under Columns ▾.
      later({ colId: 'customerUrgency', headerName: tw('urgency.column'), headerTooltip: tw('urgency.hint'), minWidth: 150, flex: 0.9, sortable: false, cellRenderer: UrgencyCell }),
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, tw, ts, tsv, locale, model.prefix, model.can.orders, model.now, names, readiness, /* F-PR-22 */ tn, rowNoteWaitWords])

  // B-W2b-13 — the W2b list frame: board by state, calendar by due date, cards, the due quick filter, inline and bulk edit.
  const final = (row: WorkOrderRow) => (row.status === 'CLOSED' || row.status === 'CANCELLED' ? t('w2b.heldFinal') : null)
  const edit: ListEdit<WorkOrderRow> = {
    fields: {
      due: { kind: 'date', nullable: true, valueOf: (row) => row.dueDate, held: final },
      priority: { kind: 'integer', min: -1000, max: 1000, valueOf: (row) => row.priority, held: final },
      // B-W2b-59 (MES-009): the rush flag in Edit N (no column of its own: it shows beside the priority).
      rush: { kind: 'choice', choices: RUSH_CHOICES, label: ts('rush.field'), choiceLabels: { RUSH: ts('rush.RUSH'), NORMAL: ts('rush.NORMAL') }, valueOf: (row) => (row.rush ? 'RUSH' : 'NORMAL'), held: final },
    },
    versionOf: (row) => row.version,
    labelOf: (row) => row.number,
    onSaved: (id, after, version) => actions?.onSaved?.(id, after, version),
    bulk: { noun: { one: t('w2b.noun_one'), other: t('w2b.noun_other') } },
    held: model.can.manage ? null : t('held.noManage'),
  }
  // F-PR-03: the computed filters Waiting on, Health and Blocked by join the quick filters (each a chip; the API's terms).
  const quick: ListQuick = {
    filters: [
      { id: 'due', kind: 'date', label: t('w2b.quickDue'), choices: ['overdue', 'today', 'this-week', 'next-week', 'next-7-days', 'this-month'] },
      { id: 'rush', kind: 'flag', label: ts('rush.word'), value: 'true' },
      { id: 'waitingOn', kind: 'choice', label: t('filter.waitingOn'), choices: FILTER_CHOICES.waitingOn.map((choice) => ({ value: choice.value, label: t(choice.key) })) },
      { id: 'risk', kind: 'choice', label: t('filter.health'), choices: FILTER_CHOICES.risk.map((choice) => ({ value: choice.value, label: t(choice.key) })) },
      { id: 'blockedBy', kind: 'choice', label: t('filter.blockedBy'), choices: FILTER_CHOICES.blockedBy.map((choice) => ({ value: choice.value, label: t(choice.key) })) },
      // F-PR-18: the Customer urgency filter (the API's computed term `customerUrgency`).
      { id: 'customerUrgency', kind: 'choice', label: tw('urgency.filter'), choices: FILTER_CHOICES.customerUrgency.map((choice) => ({ value: choice.value, label: tw(choice.key) })) },
    ],
    values: { due: model.due ?? null, rush: model.rush ? 'true' : null, waitingOn: model.waitingOn ?? null, risk: model.risk ?? null, blockedBy: model.blockedBy ?? null, /* F-PR-18 */ customerUrgency: model.customerUrgency ?? null },
    onChange: (id, value) => {
      if (id === 'rush') actions?.onRush?.(value === 'true')
      else if (id === 'due') actions?.onDue?.(value as never)
      else {
        const next = filterChange(id, value)
        if (next) actions?.onTerms?.(next)
      }
    },
  }
  const laneTotal = (status: WorkOrderRow['status']): number | null => {
    const counts = model.counts
    if (!counts) return null
    return status === 'DRAFT' ? counts.draft : status === 'RELEASED' ? counts.released : status === 'IN_PROGRESS' ? counts.inProgress : status === 'COMPLETED' ? counts.completed : status === 'ON_HOLD' ? (counts.onHold ?? null) : null
  }
  const shownStatuses = WORK_ORDER_STATUSES.filter((status) => model.view === 'all' || (items ?? []).some((row) => row.status === status) || ['DRAFT', 'RELEASED', 'IN_PROGRESS'].includes(status))

  const filtered = model.view !== 'all' || model.q.trim() !== ''
  // F-PR-03: the list's terms as the model holds them (one shape for the address, the tiles and the empty state).
  const terms: ListTerms = {
    ...termsOf(null, ['table']),
    view: model.view,
    q: model.q,
    mode: model.mode ?? 'table',
    due: model.due ?? null,
    rush: !!model.rush,
    ...(model.sort ? { sort: model.sort } : {}),
    waitingOn: model.waitingOn ?? null,
    risk: model.risk ?? null,
    blockedBy: model.blockedBy ?? null,
    party: model.customers?.party ?? null,
    group: model.group ?? null,
    supervisor: model.supervisor ?? null, // F-PR-21
    customerUrgency: model.customerUrgency ?? null, // F-PR-18
  }
  const state = model.rows.problem ? (
    <EmptyState title={t('list.failed')} description={t(model.rows.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : items && items.length === 0 ? (
    narrowed(terms) ? (
      <EmptyState
        title={t('list.noMatch.title')}
        description={t('list.noMatch.body')}
        action={
          <Button
            size="sm"
            onClick={() => {
              setQuery('')
              // F-PR-03: every filter off in one address (the sort, the mode and the grouping stay).
              const off = cleared(terms)
              actions?.onTerms?.({ view: off.view, q: off.q, due: off.due, rush: off.rush, waitingOn: null, risk: null, blockedBy: null, party: null, /* F-PR-21, F-PR-18 */ supervisor: off.supervisor, customerUrgency: off.customerUrgency })
            }}
          >
            {t('list.clearFilters')}
          </Button>
        }
      />
    ) : (
      <EmptyState
        title={t('list.empty.title')}
        description={t(model.can.manage ? 'list.empty.body' : 'list.empty.bodyView')}
        action={
          model.can.manage ? (
            <Button size="sm" variant="primary" onClick={() => actions?.onNew?.(true)}>
              {t('list.new')}
            </Button>
          ) : undefined
        }
      />
    )
  ) : undefined

  // F-PR-03: the tiles (the state views, and At risk / Waiting on customer as the API's filters).
  const tiles = listTiles(terms, model.counts)
  const groups = useCustomerGroups(model, actions, terms, names)

  return (
    <div className="fw-pr">
      <div className="fw-pr-head">
        <div className="fw-pr-head-text">
          <span className="fw-pr-status" role="status">
            {model.asOf ? t('list.updated', { time: formatTime(model.asOf, { locale }) }) : t('list.notYet')}
            {' · '}
            {t(`live.${model.live}`)}
          </span>
        </div>
        <span className="fw-pr-actions">
          <Button size="sm" heldReason={releaseWaitWords} onClick={() => actions?.onReleaseMany?.(picked.map((row) => row.id))}>
            <Rocket size={14} aria-hidden /> {picked.length > 0 ? t('bulk.release', { count: picked.length }) : ts('release.open')}
          </Button>
          <Button size="sm" variant="primary" heldReason={model.can.manage ? null : t('held.noManage')} onClick={() => actions?.onNew?.(true)} aria-keyshortcuts="c">
            <Plus size={14} aria-hidden /> {t('list.new')}
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': ts('list.more') }}
            items={[
              {
                id: 'travellers',
                label: picked.length > 0 ? ts('travellers.printSelected', { count: picked.length }) : ts('travellers.printShown', { count: travellerIds.length }),
                icon: <Printer size={14} aria-hidden />,
                ...(travellerWaitWords ? { disabled: true, description: travellerWaitWords } : { href: travellersHref(model.prefix, travellerIds), target: '_blank' as const }),
              },
            ]}
          />
        </span>
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={notices(model.notice.words.key, model.notice.words.params)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('common.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}

      <MetricStrip
        metrics={tiles.map((tile) => ({
          label: tile.id === 'mine' ? tw('supervisor.tile') : t(`tile.${tile.id}`), // F-PR-21: Mine
          value: tile.count === null ? '—' : String(tile.count),
          onClick: () => actions?.onTerms?.(tile.next),
          active: tile.active,
        }))}
      />

      <ListFrame<WorkOrderRow>
        label={t('list.tableLabel')}
        rows={state ? [] : items}
        rowId={(row) => row.id}
        columns={columns}
        count={items ? t(model.rows.more ? 'list.countMore' : 'list.count', { count: items.length }) : '—'}
        search={
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={13} aria-hidden />}
            aria-label={t('list.search')}
            placeholder={t('list.search')}
            value={query}
            onChange={(event) => {
              typed.current = true
              setQuery(event.target.value)
            }}
          />
        }
        tools={
          <>
            <Select size="sm" aria-label={t('list.viewLabel')} value={model.view} onChange={(event) => actions?.onView?.(event.target.value as ListView)}>
              {LIST_VIEWS.map((view) => (
                <option key={view} value={view}>
                  {t(`view.${view}`)}
                </option>
              ))}
            </Select>
            {/* F-PR-03: the Production pages' one customer filter (`?party=`), the sort (risk first by default), Group ▾ By customer. */}
            {model.customers && <CustomerFilter state={model.customers} onPick={(party) => actions?.onParty?.(party)} />}
            <Select size="sm" aria-label={t('sort.label')} value={terms.sort} onChange={(event) => actions?.onTerms?.({ sort: event.target.value as ListSort })}>
              {SORT_CHOICES.map((sort) => (
                <option key={sort} value={sort}>
                  {t(`sort.${sort}`)}
                </option>
              ))}
            </Select>
            <Select size="sm" aria-label={t('group.label')} value={terms.group ?? ''} onChange={(event) => actions?.onTerms?.({ group: event.target.value === 'party' ? 'party' : null })}>
              <option value="">{t('group.none')}</option>
              <option value="party">{t('group.party')}</option>
            </Select>
          </>
        }
        selection={{
          selected,
          onChange: setSelected,
          exportSelected: true,
          actions: (
            <>
              {daily && (
                <Button
                  size="sm"
                  aria-label={tw('bulk.hold', { count: picked.length })}
                  heldReason={holdWait}
                  onClick={() => {
                    const open = picked.filter((row) => HOLDABLE.includes(row.status))
                    actions?.daily?.onDialog?.({ kind: 'hold', workOrderIds: open.map((row) => row.id), numbers: open.map((row) => row.number) })
                  }}
                >
                  <PauseCircle size={13} aria-hidden /> <SelectionLabel>{tw('bulk.hold', { count: picked.length })}</SelectionLabel>
                </Button>
              )}
              {/* F-PR-21: Assign supervisor… on the selection's orders (up to 100; held in words). */}
              <Button size="sm" aria-label={tw('supervisor.assign')} heldReason={assignWaitWords} onClick={() => actions?.onAssignSupervisor?.(picked.map((row) => row.id))}>
                <UserCog size={13} aria-hidden /> <SelectionLabel>{tw('supervisor.assign')}</SelectionLabel>
              </Button>
              {/* F-PR-22: one office note on each picked work order (or their sales orders), up to 100; held in words. */}
              <Button size="sm" aria-label={tn('open.selection', { count: picked.length })} heldReason={noteWaitWords} onClick={() => actions?.onNote?.(picked.map((row) => row.id), 'selection')}>
                <MessageSquareLock size={13} aria-hidden /> <SelectionLabel>{tn('open.selection', { count: picked.length })}</SelectionLabel>
              </Button>
              {travellerWaitWords ? (
                <Button size="sm" aria-label={ts('travellers.printSelected', { count: picked.length })} heldReason={travellerWaitWords}>
                  <Printer size={13} aria-hidden /> <SelectionLabel>{ts('travellers.printSelected', { count: picked.length })}</SelectionLabel>
                </Button>
              ) : (
                <Button size="sm" asChild>
                  <Link href={travellersHref(model.prefix, travellerIds)} target="_blank" aria-label={ts('travellers.printSelected', { count: picked.length })}>
                    <Printer size={13} aria-hidden /> <SelectionLabel>{ts('travellers.printSelected', { count: picked.length })}</SelectionLabel>
                  </Link>
                </Button>
              )}
              <Button
                size="sm"
                variant="primary"
                aria-label={t('bulk.release', { count: picked.length })}
                heldReason={releaseWaitWords}
                onClick={() => actions?.onReleaseMany?.(picked.map((row) => row.id))}
              >
                <Rocket size={13} aria-hidden /> <SelectionLabel>{t('bulk.release', { count: picked.length })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.rows.more && items && items.length > 0 ? { label: t('list.more'), onMore: () => actions?.onMore?.() } : null}
        keys={ownKeys}
        onHelp={() => setHelp(true)}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
        focusRow={model.focusRow}
        modes={{
          mode: model.mode ?? 'table',
          onMode: (next) => actions?.onMode?.(next),
          board: {
            lanes: shownStatuses.map((status) => ({ id: status, label: t(`status.${status}`), total: laneTotal(status), tone: STATUS_TONE[status] === 'neutral' ? undefined : STATUS_TONE[status] })),
            laneOf: (row) => row.status,
            // F-PR-03: each card names its customer by code (a board is read across the room), its health and who it waits on.
            card: (row) => ({
              title: `${row.styleCode} · ${row.styleName}`,
              fields: [
                ...(row.customer ? [{ label: t('board.customer'), value: row.customer.code }] : row.mixedCustomers ? [{ label: t('board.customer'), value: t('customer.mixed') }] : []),
                { label: t('col.pieces'), value: String(row.pieces) },
                ...(row.dueDate ? [{ label: t('col.due'), value: formatDate(`${row.dueDate}T12:00:00Z`, { locale }) }] : []),
              ],
              marks: row.risk !== undefined ? boardMarksOf(row, model.now ?? Date.now()).map((mark) => ({ label: mark.words.map((words) => heldWords(words.key, words.params)).join(' · '), tone: mark.tone })) : row.daysLate ? [{ label: t('list.daysLate', { count: row.daysLate }), tone: 'danger' as const }] : [],
            }),
            heldReason: t('w2b.boardHeld'),
          },
          calendar: { dateOf: (row) => row.dueDate, label: t('w2b.dueDate'), field: 'due' },
        }}
        cards={{ hrefOf: (row) => `${model.prefix}/production/work-orders/${row.id}` }}
        edit={edit}
        quick={quick}
        groups={groups /* F-PR-03 */}
        onShownColumns={actions?.onShownColumns /* F-PR-03: the readiness word is read only while shown */}
        {...(model.today ? { today: model.today } : {})}
      />
      {filtered && model.view !== 'open' && <p className="fw-pr-hint">{t('list.viewing', { view: t(`view.${model.view}`) })}</p>}

      {model.newOrder && <NewWorkOrderDialog model={model.newOrder} can={model.can} actions={actions} />}
      {model.release && (
        <ReleaseReview
          model={model.release}
          onSave={() => actions?.onRunRelease?.()}
          onRetry={() => actions?.onRetryRelease?.()}
          onClose={() => {
            if (model.release?.state.phase === 'done') setSelected([])
            actions?.onCloseRelease?.()
          }}
        />
      )}
      {daily?.dialog?.kind === 'hold' && <HoldDialog numbers={daily.dialog.numbers} workOrderIds={daily.dialog.workOrderIds} daily={daily} actions={actions?.daily} />}
      {/* F-PR-21 */}
      {model.assign && <AssignSupervisorDialog model={model.assign} actions={actions?.supervisor} />}
      {/* F-PR-22 */}
      {model.note && <NoteDialog model={model.note} actions={actions?.note} />}
      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('list.keysTitle')} size="sm">
          <ul className="fw-pr-list">
            {listKeys(ownKeys, true).map((entry) => (
              <li key={entry.does}>
                <b>{entry.keys.join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  )
}

// ---- F-PR-03: grouped by customer ----------------------------------------------------------------------------------------------

/**
 * The list frame's groups when the list is grouped by customer (`?group=party`): one header per customer of the loaded rows, in the
 * list's order (the customer with the most urgent work order first), its name a link to the list narrowed to that customer, and its
 * figures the server's for that customer's whole production (never summed from the rows on screen); work orders made before the
 * one-customer rule and samples for no customer get a header of their own in words. The grand total under the grid is the tiles'
 * counts (every customer the person may see, or the one picked). Null: not grouped.
 */
function useCustomerGroups(model: WorkOrdersListModel, actions: WorkOrdersListActions | undefined, terms: ListTerms, names: boolean): ListGroups<WorkOrderRow> | null {
  const t = useT('production')
  const path = `${model.prefix}/production/work-orders`
  return useMemo(() => {
    if (model.group !== 'party' || !model.rows.items) return null
    const groups = customerGroupsOf(model.rows.items, names)
    const figures = (partyId: string) => {
      const read = model.groupCounts?.[partyId]
      if (!read || read === 'reading') return null
      if (read === 'failed')
        return (
          <span className="fw-pr-inline">
            {t('group.figuresFailed')}
            <Button size="sm" variant="quiet" onClick={() => actions?.onRetryGroup?.(partyId)}>
              {t('common.retry')}
            </Button>
          </span>
        )
      const phrase = groupFigures(read)
      return <span className="fw-pr-hint">{t(phrase.key, phrase.params)}</span>
    }
    const total = model.counts ? groupFigures(model.counts) : null
    const scope = model.customers?.everyCustomer === false ? t('customer.allMine') : t('customer.all')
    return {
      keyOf: groupKeyOf,
      groups: groups.map((group) => {
        const name = group.name ?? (group.kind === 'mixed' ? t('customer.mixed') : t('list.noCustomer'))
        return {
          key: group.key,
          name,
          label: group.partyId ? (
            <Link className="fw-pr-link" href={listAddress(path, { ...terms, party: group.partyId, group: null })} title={t('group.only', { name })}>
              {name}
            </Link>
          ) : (
            <span>{name}</span>
          ),
          summary: group.partyId ? figures(group.partyId) : <span className="fw-pr-hint">{t(group.kind === 'mixed' ? 'group.mixedNote' : 'group.noneNote')}</span>,
        }
      }),
      collapsed: model.collapsed ?? [],
      onToggle: (key) => actions?.onToggleGroup?.(key),
      total: total ? <span className="fw-pr-hint">{t('group.total', { scope, ...(total.params ?? {}) })}</span> : null,
    }
  }, [model.group, model.rows.items, model.groupCounts, model.counts, model.collapsed, model.customers?.everyCustomer, names, path, terms, t, actions])
}
