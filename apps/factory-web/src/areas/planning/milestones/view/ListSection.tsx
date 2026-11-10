'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { CheckCheck, MoreHorizontal } from 'lucide-react'
import { CellAction, EmptyState, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import { usePageKeys } from '../../../_shared/buying/hooks'
import { dayText, heldOf, lateWords, milestoneName, rowsOf, selectableHeld, stateTone, stateWords, visibleRows, type MilestoneRow, type Words } from '../model'
import type { MilestonesActions, MilestonesModel } from '../view-model'

const focusedRowId = (): string | null => (typeof document === 'undefined' ? null : ((document.activeElement as HTMLElement | null)?.closest('.ag-row')?.getAttribute('row-id') ?? null))

/**
 * Milestones as a list (design planning.milestones sec:calendar "List"; the shared list frame): order, milestone, customer,
 * planner (a gate's, named inside it — never a filter, a group or a total), target, actual, state, late. Enter opens the
 * milestone's dialog; d marks the focused gate done; ticked gates: Mark done N (a gate that may not be marked done now cannot
 * be ticked, the reason on its box). ⌘-click on the order opens the sales order in a new tab.
 */
export function ListSection({ model, actions, words }: { model: MilestonesModel; actions?: MilestonesActions; words: Words }) {
  const { t, locale } = words
  const world = model.world.status === 'ready' ? model.world.value : null
  const rows = useMemo(() => (world ? visibleRows(rowsOf(world), model.controls) : null), [world, model.controls])
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const rowsKey = rows?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const quiet = model.dialog !== null || model.controls.open !== null || model.controls.add !== null

  usePageKeys((event) => {
    if (quiet || event.metaKey || event.ctrlKey || event.altKey || event.key !== 'd') return
    const row = (rows ?? []).find((entry) => entry.id === focusedRowId())
    if (!row?.gate || heldOf(row.gate.actions.pass, t) !== null) return
    event.preventDefault()
    actions?.onPass?.([row.gate.id])
  })

  const keys: ListKey[] = [
    { keys: ['Enter'], does: t('keys.open') },
    { keys: ['d'], does: t('keys.done') },
    { keys: ['1', '2', '3'], does: t('keys.views') },
    { keys: ['n'], does: t('keys.add') },
  ]

  const OrderCell = ({ data }: ICellRendererParams<MilestoneRow>) =>
    data ? (
      <span className="fw-tna-cell">
        <a
          className="fw-tna-link fw-tna-ellipsis"
          href={`${model.prefix}/sales/orders/${data.order.id}`}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey) return
            event.preventDefault()
            actions?.onOpen?.(data.id)
          }}
        >
          {data.order.number}
        </a>
        <span className="fw-tna-sub fw-tna-ellipsis">{data.order.customer.name}</span>
      </span>
    ) : null
  const NameCell = ({ data }: ICellRendererParams<MilestoneRow>) =>
    data ? (
      <span className="fw-tna-cell">
        <span className="fw-tna-ellipsis">{milestoneName(data, t)}</span>
        <span className="fw-tna-sub fw-tna-ellipsis">{data.gate?.sampleRound ? t('row.round', { round: data.gate.sampleRound.number }) : t(`milestoneKind.${data.kind}`)}</span>
      </span>
    ) : null
  const StateCell = ({ data }: ICellRendererParams<MilestoneRow>) =>
    data ? (
      <span className="fw-tna-inline">
        <Pill tone={stateTone(data)}>{stateWords(data, t)}</Pill>
        <CellAction label={t('row.openNamed', { name: milestoneName(data, t), order: data.order.number })} description={t('row.openHint')} onActivate={() => actions?.onOpen?.(data.id)} />
      </span>
    ) : null
  const MoreCell = ({ data }: ICellRendererParams<MilestoneRow>) =>
    data ? (
      <Menu
        label={<MoreHorizontal size={16} aria-hidden />}
        align="right"
        triggerProps={{ 'aria-label': t('row.menu', { name: milestoneName(data, t), order: data.order.number }) }}
        items={[
          { id: 'open', label: t('row.open'), onSelect: () => actions?.onOpen?.(data.id) },
          ...(data.gate ? [{ id: 'done', label: t('row.done'), disabled: heldOf(data.gate.actions.pass, t) !== null, onSelect: () => actions?.onPass?.([data.gate!.id]) }] : []),
          ...(data.gate ? [{ id: 'start', label: t('row.startBefore'), disabled: heldOf(data.gate.actions.startBefore, t) !== null, onSelect: () => actions?.onStartBefore?.([data.gate!.id]) }] : []),
          { id: 'order', label: t('row.orderNewTabShort'), onSelect: () => actions?.onOpenOrder?.(data.order.id, true) },
        ]}
      />
    ) : null

  const columns: ColDef<MilestoneRow>[] = [
    { colId: 'order', headerName: t('col.order'), minWidth: 160, flex: 1, cellRenderer: OrderCell },
    { colId: 'milestone', headerName: t('col.milestone'), minWidth: 200, flex: 1.4, cellRenderer: NameCell },
    { colId: 'owner', headerName: t('col.owner'), minWidth: 140, flex: 0.9, valueGetter: ({ data }) => data?.owner?.name ?? '—' },
    { colId: 'target', headerName: t('col.target'), minWidth: 120, flex: 0.7, valueGetter: ({ data }) => (data ? dayText(data.target, locale) : '') },
    { colId: 'actual', headerName: t('col.actual'), minWidth: 120, flex: 0.7, valueGetter: ({ data }) => (data ? dayText(data.actual, locale) : '') },
    { colId: 'state', headerName: t('col.state'), minWidth: 190, flex: 1, cellRenderer: StateCell },
    { colId: 'late', headerName: t('col.late'), minWidth: 130, flex: 0.7, valueGetter: ({ data }) => (data ? lateWords(data, t) : '') },
    { colId: 'more', headerName: t('col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
  ]

  let state: ReactNode = undefined
  if (rows && rows.length === 0) {
    const filtered = model.controls.q.trim() !== '' || model.controls.tile !== null
    state = filtered ? (
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
      <EmptyState title={t('calendar.empty')} description={t('empty.body')} />
    )
  }
  const picked = (rows ?? []).filter((row) => selected.includes(row.id) && row.gate)

  return (
    <ListFrame<MilestoneRow>
      label={t('calendar.title')}
      rows={state ? [] : rows}
      rowId={(row) => row.id}
      columns={columns}
      count={rows ? t('list.count', { count: rows.length }) : '—'}
      selection={{
        selected,
        onChange: setSelected,
        actions: (
          <Button size="sm" variant="primary" aria-label={t('bulk.done', { count: picked.length })} onClick={() => actions?.onPass?.(picked.map((row) => row.gate!.id))}>
            <CheckCheck size={13} aria-hidden /> <SelectionLabel>{t('bulk.done', { count: picked.length })}</SelectionLabel>
          </Button>
        ),
      }}
      isRowSelectable={(row) => selectableHeld(row, t)}
      keys={keys}
      onHelp={() => actions?.onKeys?.()}
      onOpen={(row) => actions?.onOpen?.(row.id)}
      state={state}
      focusRow={model.focusRow}
      keysOpen={model.keysOpen}
    />
  )
}
