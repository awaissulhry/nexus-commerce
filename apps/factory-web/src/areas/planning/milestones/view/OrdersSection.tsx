'use client'

import { useMemo, type ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { EmptyState, Menu } from '@nexus/ui/components'
import { MilestoneTracker } from '@nexus/ui/components/MilestoneTracker/index'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import type { Order } from '../api'
import { dayText, gateName, milestoneName, trackerSteps, visibleOrders, type Words } from '../model'
import type { MilestonesActions, MilestonesModel } from '../view-model'

/**
 * One row per order (design planning.milestones sec:calendar "Per order (dots per milestone, target vs actual)"; the shared
 * list frame, read-only: no action applies to many orders at once): the order and its customer, the ship date, its
 * milestones as dots (DS MilestoneTracker, compact: done, started before, the next one, to come — each named for a screen
 * reader with its date or its target), the gates it waits on, how many milestones are late, the next one. Enter opens the
 * next milestone; ⋯ Add a gate to it, open the order in a new tab.
 */
export function OrdersSection({ model, actions, words }: { model: MilestonesModel; actions?: MilestonesActions; words: Words }) {
  const { t, locale } = words
  const ds = useDsWords()
  const world = model.world.status === 'ready' ? model.world.value : null
  const orders = useMemo(() => (world ? visibleOrders(world, model.controls) : null), [world, model.controls])
  const labels = useMemo(() => ({ ...ds.milestoneTracker, usually: (date: string) => t('tracker.target', { date }), states: { ...ds.milestoneTracker.states, skipped: t('state.STARTED_BEFORE') } }), [ds, t])
  const day = (iso: string) => dayText(iso, locale)

  const keys: ListKey[] = [
    { keys: ['Enter'], does: t('keys.openNext') },
    { keys: ['1', '2', '3'], does: t('keys.views') },
    { keys: ['n'], does: t('keys.add') },
  ]
  const nextOf = (order: Order) => order.milestones.find((row) => row.id === order.next) ?? null

  const OrderCell = ({ data }: ICellRendererParams<Order>) =>
    data ? (
      <span className="fw-tna-cell">
        <a
          className="fw-tna-link fw-tna-ellipsis"
          href={`${model.prefix}/sales/orders/${data.id}`}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey) return
            event.preventDefault()
            const next = nextOf(data)
            if (next) actions?.onOpen?.(next.id)
            else actions?.onOpenOrder?.(data.id, false)
          }}
        >
          {data.number}
        </a>
        <span className="fw-tna-sub fw-tna-ellipsis">{data.customer.name}</span>
      </span>
    ) : null
  const DotsCell = ({ data }: ICellRendererParams<Order>) =>
    data ? (
      <span className="fw-tna-dots">
        <MilestoneTracker steps={trackerSteps(data, t, day)} layout="compact" label={t('orders.steps', { order: data.number })} labels={labels} />
      </span>
    ) : null
  const WaitingCell = ({ data }: ICellRendererParams<Order>) =>
    data ? (
      data.waiting.length === 0 ? (
        <span className="fw-tna-sub">{t('orders.noneWaiting')}</span>
      ) : (
        <span className="fw-tna-one-line" title={data.gates.filter((gate) => gate.state === 'WAITING').map((gate) => gateName(gate.kind, gate.label, t)).join(' · ')}>
          {data.gates
            .filter((gate) => gate.state === 'WAITING')
            .slice(0, 1)
            .map((gate) => (
              <Pill key={gate.id} tone="warning">
                {gateName(gate.kind, gate.label, t)}
              </Pill>
            ))}
          {data.waiting.length > 1 && <span className="fw-tna-sub">{t('orders.more', { count: data.waiting.length - 1 })}</span>}
        </span>
      )
    ) : null
  const NextCell = ({ data }: ICellRendererParams<Order>) => {
    const next = data ? nextOf(data) : null
    return next ? (
      <span className="fw-tna-cell">
        <span className="fw-tna-ellipsis">{milestoneName(next, t)}</span>
        <span className="fw-tna-sub">{next.target ? t('row.target', { day: day(next.target) }) : t('row.noTarget')}</span>
      </span>
    ) : (
      <span className="fw-tna-sub">{t('orders.allDone')}</span>
    )
  }
  const MoreCell = ({ data }: ICellRendererParams<Order>) =>
    data ? (
      <Menu
        label={<MoreHorizontal size={16} aria-hidden />}
        align="right"
        triggerProps={{ 'aria-label': t('orders.menu', { order: data.number }) }}
        items={[
          { id: 'add', label: t('orders.add'), disabled: !data.mayAddGate.allowed, onSelect: () => actions?.onAdd?.(data.id) },
          { id: 'order', label: t('row.orderNewTabShort'), onSelect: () => actions?.onOpenOrder?.(data.id, true) },
        ]}
      />
    ) : null

  const columns: ColDef<Order>[] = [
    { colId: 'order', headerName: t('col.order'), minWidth: 170, flex: 1, cellRenderer: OrderCell },
    { colId: 'ship', headerName: t('col.ship'), minWidth: 120, flex: 0.6, valueGetter: ({ data }) => (data ? dayText(data.promiseDate, locale) : '') },
    { colId: 'dots', headerName: t('col.milestones'), minWidth: 260, flex: 1.6, cellRenderer: DotsCell, sortable: false },
    { colId: 'waiting', headerName: t('col.waiting'), minWidth: 200, flex: 1.2, cellRenderer: WaitingCell, sortable: false },
    { colId: 'late', headerName: t('col.lateCount'), minWidth: 110, flex: 0.5, valueGetter: ({ data }) => (data ? (data.late === 0 ? '—' : t('orders.late', { count: data.late })) : '') },
    { colId: 'next', headerName: t('col.next'), minWidth: 190, flex: 1, cellRenderer: NextCell, sortable: false },
    { colId: 'more', headerName: t('col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
  ]

  let state: ReactNode = undefined
  if (orders && orders.length === 0) {
    state =
      model.controls.q.trim() !== '' || model.controls.tile !== null ? (
        <EmptyState
          title={t('empty.noMatch.title')}
          description={t('empty.noMatch.body')}
          action={
            <Button
              size="sm"
              onClick={() => {
                actions?.onSearch?.('')
                actions?.onTile?.(null)
              }}
            >
              {t('common.clearFilters')}
            </Button>
          }
        />
      ) : (
        <EmptyState title={t('orders.empty')} description={t('empty.body')} />
      )
  }

  return (
    <ListFrame<Order>
      label={t('orders.label')}
      listKey="planning.milestones.orders"
      rows={state ? [] : orders}
      rowId={(row) => row.id}
      columns={columns}
      count={orders ? t('orders.count', { count: orders.length }) : '—'}
      keys={keys}
      onHelp={() => actions?.onKeys?.()}
      onOpen={(row) => {
        const next = nextOf(row)
        if (next) actions?.onOpen?.(next.id)
        else actions?.onOpenOrder?.(row.id, false)
      }}
      state={state}
      focusRow={model.focusRow}
      keysOpen={model.keysOpen}
    />
  )
}
