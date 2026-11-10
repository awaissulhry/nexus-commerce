'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Check, Copy, MoreHorizontal, Plus, X } from 'lucide-react'
import { Banner, EmptyState, Menu, MetricStrip, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, SegmentedControl, Select, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import type { LiveState } from '../../../../shell/live/use-live'
import type { ReleasedList, ReleasedRow } from '../api'
import {
  approvalsPhrase,
  CHANGE_KINDS,
  CHANGE_ROWS,
  CHANGE_TILES,
  decideHeldOfRow,
  effectivePhrase,
  isComplete,
  isFiltered,
  noticesOf,
  numberPhrase,
  operationHref,
  personPhrase,
  PRIORITY_TONE,
  raisedByPhrase,
  recordHref,
  rowsOf,
  statusOf,
  styleHref,
  stylesOf,
  tileCounts,
  type ChangeKind,
  type ChangeRow,
  type ChangeRows,
  type ChangesCan,
  type ChangesRead,
  type ChangeTile,
  type DecideChoice,
  type ListAddress,
  type Notice,
  type PageNotice,
} from '../model'
import { ChangesMessages, Freshness, isPageKey, KindTag, NoAccess, NoticeLine, PageHead, useWords } from '../parts'
import { DecideDialog, type DecideActions, type DecideModel } from './DecideDialog'
import { NewOrderDialog, type NewOrderActions, type NewOrderModel } from './NewOrderDialog'
import { NewRequestDialog, type NewRequestActions, type NewRequestModel } from './NewRequestDialog'

/** SCR-117 — Products › Development › Changes & versions: the view switch, the tiles, the notices, Changes or Released versions. */
export interface ChangesListModel {
  prefix: string
  me: string
  can: ChangesCan
  address: ListAddress
  /** The three reads (null while they are read); `problem` when the requests or the orders failed (never an empty list). */
  read: ChangesRead | null
  problem: string | null
  /** The released versions (read when that view is open). */
  released: ReleasedList | null
  releasedProblem: string | null
  asOf: string | null
  live: LiveState
  /** Changes that arrived while the list was on screen (rows never move under the cursor). */
  updates: number
  notice: Notice | null
  /** The notices put away (by id and value: a new fact shows again). */
  dismissed: readonly string[]
  newRequest: NewRequestModel | null
  newOrder: NewOrderModel | null
  decide: DecideModel | null
  /** Design cases: the rows selected, the keys panel open, every notice shown. */
  selected?: readonly string[]
  keysOpen?: boolean
  allNotices?: boolean
}

export interface ChangesListActions {
  onAddress?: (patch: Partial<ListAddress>) => void
  onClearFilters?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onOpen?: (row: ChangeRow) => void
  onNew?: () => void
  onNewOrder?: () => void
  newRequest?: NewRequestActions
  newOrder?: NewOrderActions
  /** Approve change for the row (A / R pressed later in the popup). */
  onDecide?: (row: ChangeRow, choice?: DecideChoice) => void
  decide?: DecideActions
  onCopy?: (numbers: readonly string[]) => void
  onDismissNotice?: () => void
  onDismissPageNotice?: (id: string) => void
}

export function ChangesListView({ model, actions }: { model: ChangesListModel; actions?: ChangesListActions }) {
  return (
    <ChangesMessages>
      <List model={model} actions={actions} />
    </ChangesMessages>
  )
}

/** A row's own address: a change's record, an SMV change's operation. */
const hrefOf = (prefix: string, row: ChangeRow): string => (row.kind === 'smv' ? operationHref(prefix, row.smv.operation.id) : recordHref(prefix, row.kind, row.recordId))

function List({ model, actions }: { model: ChangesListModel; actions?: ChangesListActions }) {
  const { t, say, when } = useWords()
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [search, setSearch] = useState(model.address.q)
  const [showAll, setShowAll] = useState(model.allNotices ?? false)
  useEffect(() => setSearch(model.address.q), [model.address.q])
  const offline = model.live === 'offline'
  const act = useRef(actions)
  act.current = actions
  const rows = useMemo(() => (model.read ? rowsOf(model.read, model.address) : null), [model.read, model.address])
  const rowsKey = rows?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.split(',').includes(id))), [rowsKey])
  const released = model.address.view === 'released'

  // c: New change request — never while typing or in a dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || model.newRequest || model.newOrder || model.decide) return
      if (event.key === 'c' && model.can.request) {
        event.preventDefault()
        act.current?.onNew?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model.newRequest, model.newOrder, model.decide, model.can.request])

  const columns = useMemo<ColDef<ChangeRow>[]>(() => {
    const NumberCell = ({ data }: ICellRendererParams<ChangeRow>) =>
      data ? (
        <span className="fw-chg-cell">
          <Link className="fw-chg-link fw-chg-code" href={hrefOf(model.prefix, data)}>
            {say(numberPhrase(data))}
          </Link>
        </span>
      ) : null
    const StyleCell = ({ data }: ICellRendererParams<ChangeRow>) => {
      if (!data) return null
      const style = stylesOf(data)
      return (
        <span className="fw-chg-cell">
          <span className="fw-chg-code">{style.code}</span>
          <span className="fw-chg-hint">{style.name}</span>
        </span>
      )
    }
    const KindCell = ({ data }: ICellRendererParams<ChangeRow>) => (data ? <KindTag kind={data.kind} /> : null)
    const StatusCell = ({ data }: ICellRendererParams<ChangeRow>) => {
      if (!data) return null
      const status = statusOf(data)
      return <Tag tone={status.tone}>{t(status.key)}</Tag>
    }
    const PriorityCell = ({ data }: ICellRendererParams<ChangeRow>) => {
      if (!data || data.kind === 'smv') return data ? <span className="fw-chg-hint">—</span> : null
      const priority = data.kind === 'request' ? data.request.priority : data.order.priority
      return <Tag tone={PRIORITY_TONE[priority]}>{t(`priority.${priority}`)}</Tag>
    }
    const MoreCell = ({ data }: ICellRendererParams<ChangeRow>) => {
      if (!data) return null
      const held = say(decideHeldOfRow(data, model.can, model.me, offline))
      const items: MenuItemDef[] = [
        { id: 'open', label: t('row.open'), href: hrefOf(model.prefix, data) },
        { id: 'tab', label: t('row.openNewTab'), href: hrefOf(model.prefix, data), target: '_blank' },
        { id: 'approve', label: data.kind === 'request' ? t('decide.accept') : t('decide.approve'), disabled: !!held, description: held ?? undefined, onSelect: () => act.current?.onDecide?.(data, 'APPROVED') },
        { id: 'reject', label: t('row.reject'), disabled: !!held, description: held ?? undefined, onSelect: () => act.current?.onDecide?.(data, 'REJECTED') },
        ...(data.number ? [{ id: 'copy', label: t('row.copy'), onSelect: () => act.current?.onCopy?.([data.number!]) }] : []),
      ]
      return <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('row.menu', { number: say(numberPhrase(data)) ?? '' }) }} items={items} />
    }
    return [
      { colId: 'number', headerName: t('col.number'), minWidth: 150, flex: 0.7, valueGetter: (params) => (params.data ? say(numberPhrase(params.data)) : ''), cellRenderer: NumberCell },
      { colId: 'kind', headerName: t('col.kind'), minWidth: 150, flex: 0.6, valueGetter: (params) => (params.data ? t(`kind.${params.data.kind}`) : ''), cellRenderer: KindCell },
      { colId: 'title', headerName: t('col.title'), minWidth: 200, flex: 1.4, valueGetter: (params) => params.data?.title ?? '' },
      { colId: 'styles', headerName: t('col.styles'), minWidth: 160, flex: 0.9, valueGetter: (params) => (params.data ? stylesOf(params.data).code : ''), cellRenderer: StyleCell },
      { colId: 'raisedBy', headerName: t('col.raisedBy'), minWidth: 150, flex: 0.8, valueGetter: (params) => (params.data ? (say(raisedByPhrase(params.data, model.me)) ?? '') : '') },
      { colId: 'reason', headerName: t('col.reason'), minWidth: 200, flex: 1.2, valueGetter: (params) => params.data?.reason ?? '', tooltipValueGetter: (params) => params.data?.reason ?? '' },
      { colId: 'status', headerName: t('col.status'), minWidth: 150, flex: 0.7, valueGetter: (params) => (params.data ? t(statusOf(params.data).key) : ''), cellRenderer: StatusCell },
      { colId: 'approvals', headerName: t('col.approvals'), minWidth: 110, flex: 0.5, valueGetter: (params) => (params.data ? (say(approvalsPhrase(params.data)) ?? '—') : '') },
      { colId: 'effective', headerName: t('col.effective'), minWidth: 140, flex: 0.6, valueGetter: (params) => (params.data ? (say(effectivePhrase(params.data)) ?? '—') : '') },
      { colId: 'priority', headerName: t('col.priority'), minWidth: 110, flex: 0.5, valueGetter: (params) => (params.data && params.data.kind !== 'smv' ? t(`priority.${params.data.kind === 'request' ? params.data.request.priority : params.data.order.priority}`) : ''), cellRenderer: PriorityCell },
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    // The cells read the model through these values only.
  }, [t, say, model.prefix, model.me, model.can, offline])

  const releasedColumns = useMemo<ColDef<ReleasedRow>[]>(() => {
    const StyleCell = ({ data }: ICellRendererParams<ReleasedRow>) =>
      data ? (
        <span className="fw-chg-cell">
          <Link className="fw-chg-link fw-chg-code" href={styleHref(model.prefix, data.style.id, data.revision.id)}>
            {data.style.code}
          </Link>
          <span className="fw-chg-hint">{data.style.name}</span>
        </span>
      ) : null
    const ChangeCell = ({ data }: ICellRendererParams<ReleasedRow>) =>
      data ? (
        data.changeOrder ? (
          <Link className="fw-chg-link fw-chg-code" href={recordHref(model.prefix, 'order', data.changeOrder.id)}>
            {data.changeOrder.number}
          </Link>
        ) : (
          <span className="fw-chg-hint">{t('released.noOrder')}</span>
        )
      ) : null
    return [
      { colId: 'style', headerName: t('col.style'), minWidth: 170, flex: 1, valueGetter: (params) => (params.data ? `${params.data.style.code} · ${params.data.style.name}` : ''), cellRenderer: StyleCell },
      { colId: 'revision', headerName: t('col.revision'), minWidth: 150, flex: 0.6, valueGetter: (params) => (params.data ? (params.data.previous ? t('revision.move', { from: params.data.previous.revision, to: params.data.revision.revision }) : t('revision.label', { revision: params.data.revision.revision })) : '') },
      { colId: 'released', headerName: t('col.released'), minWidth: 200, flex: 0.9, valueGetter: (params) => (params.data ? `${when(params.data.releasedAt)} · ${say(personPhrase(params.data.releasedById, model.me)) ?? ''}` : '') },
      { colId: 'changed', headerName: t('col.changed'), minWidth: 240, flex: 1.6, valueGetter: (params) => (params.data ? (params.data.changeNote ?? params.data.changeOrder?.title ?? '—') : ''), tooltipValueGetter: (params) => params.data?.changeNote ?? params.data?.changeOrder?.title ?? '' },
      { colId: 'change', headerName: t('col.change'), minWidth: 150, flex: 0.6, valueGetter: (params) => params.data?.changeOrder?.number ?? '', cellRenderer: ChangeCell },
    ]
  }, [t, say, when, model.prefix, model.me])

  if (!model.can.view) return <NoAccess />

  const picked = (rows ?? []).filter((row) => selected.includes(row.id))
  const filtered = isFiltered(model.address)
  const ownKeys: ListKey[] = [
    { keys: ['c'], does: t('keys.new') },
    { keys: ['a'], does: t('keys.approve') },
    { keys: ['r'], does: t('keys.reject') },
    { keys: ['j', 'k'], does: t('keys.walk') },
  ]
  const newButton = (
    <Button size="sm" variant="primary" heldReason={model.can.request ? (offline ? t('held.offline') : null) : t('held.noRequest')} onClick={() => actions?.onNew?.()} aria-keyshortcuts="c">
      <Plus size={14} aria-hidden /> {t('list.new')}
    </Button>
  )
  const bandMenu: MenuItemDef[] = [
    {
      id: 'newOrder',
      label: t('list.newOrder'),
      disabled: !model.can.manage || offline,
      description: !model.can.manage ? t('held.noManage') : offline ? t('held.offline') : undefined,
      onSelect: () => actions?.onNewOrder?.(),
    },
  ]
  const failed = (problem: string, title: string) => (
    <EmptyState
      title={title}
      description={t(problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  )
  const nothing = (empty: string, emptyBody: string, withNew: boolean) =>
    filtered ? (
      <EmptyState
        title={t('list.noMatch')}
        description={t('list.noMatchBody')}
        action={
          <Button size="sm" onClick={() => actions?.onClearFilters?.()}>
            {t('common.clearFilters')}
          </Button>
        }
      />
    ) : (
      <EmptyState title={t(empty)} description={t(emptyBody)} action={withNew && model.can.request ? newButton : undefined} />
    )
  const state = model.problem ? failed(model.problem, t('list.failed')) : rows !== null && rows.length === 0 ? nothing('list.empty', 'list.emptyBody', true) : undefined
  const releasedRows = model.released?.rows ?? null
  const releasedState = model.releasedProblem
    ? failed(model.releasedProblem, t('released.failed'))
    : releasedRows !== null && releasedRows.length === 0
      ? nothing('released.empty', 'released.emptyBody', false)
      : undefined

  const counts = tileCounts(model.read)
  const tile = (id: ChangeTile) => ({
    label: t(`tile.${id}`),
    value: model.problem ? '—' : counts[id] === null ? '—' : String(counts[id]),
    hint: model.problem ? t('tile.failed') : t(`tile.hint.${id}`),
    onClick: () => actions?.onAddress?.({ view: 'changes', tile: model.address.tile === id ? null : id }),
    active: model.address.tile === id && !released,
  })

  const notices: PageNotice[] = noticesOf(model.read, model.address, model.can).filter((one) => !model.dismissed.includes(one.id))
  const styleFilter = model.address.style
    ? ((rows ?? []).map((row) => (row.kind === 'request' ? row.request.style : row.kind === 'order' ? row.order.style : null)).find((style) => style?.id === model.address.style)?.code ??
      model.released?.rows.find((row) => row.style.id === model.address.style)?.style.code ??
      t('list.thisStyle'))
    : null
  const searchBox = (
    <Input
      size="sm"
      type="search"
      className="fw-chg-search"
      aria-label={t('list.search')}
      placeholder={released ? t('released.search') : t('list.search')}
      value={search}
      onChange={(event) => setSearch(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') actions?.onAddress?.({ q: search })
      }}
      onBlur={() => search !== model.address.q && actions?.onAddress?.({ q: search })}
    />
  )
  const styleChip = styleFilter && (
    <Button size="sm" variant="tonal" onClick={() => actions?.onAddress?.({ style: null })} aria-label={t('list.clearStyle', { style: styleFilter })}>
      {t('list.styleChip', { style: styleFilter })} <X size={12} aria-hidden />
    </Button>
  )
  const tools = (
    <>
      <Select size="sm" aria-label={t('list.rowsLabel')} value={model.address.tile ?? 'ALL'} onChange={(event) => actions?.onAddress?.({ tile: event.target.value === 'ALL' ? null : (event.target.value as ChangeRows) })}>
        {CHANGE_ROWS.map((one) => (
          <option key={one} value={one}>
            {t(`rows.${one}`)}
          </option>
        ))}
      </Select>
      <Select size="sm" aria-label={t('list.kindLabel')} value={model.address.kind ?? ''} onChange={(event) => actions?.onAddress?.({ kind: (event.target.value || null) as ChangeKind | null })}>
        <option value="">{t('list.allKinds')}</option>
        {CHANGE_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {t(`kind.${kind}`)}
          </option>
        ))}
      </Select>
      {styleChip}
    </>
  )
  const first = notices[0]
  const shownNotices = showAll ? notices : first ? [first] : []
  const decideOne = (choice: DecideChoice) => {
    const row = picked.length === 1 ? picked[0]! : null
    if (row && !decideHeldOfRow(row, model.can, model.me, offline)) actions?.onDecide?.(row, choice)
  }
  const oneHeld = picked.length === 1 ? say(decideHeldOfRow(picked[0]!, model.can, model.me, offline)) : t('list.pickOne')

  return (
    <div className="fw-chg">
      <PageHead
        intro={t('list.intro')}
        status={<Freshness asOf={model.asOf} live={model.live} />}
        actions={
          <>
            <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('list.more') }} items={bandMenu} />
            {newButton}
          </>
        }
      />
      <div className="fw-chg-bar">
        <SegmentedControl
          ariaLabel={t('view.label')}
          size="sm"
          value={model.address.view}
          onChange={(value) => actions?.onAddress?.({ view: value === 'released' ? 'released' : 'changes' })}
          options={[
            { value: 'changes', label: t('view.changes') },
            { value: 'released', label: t('view.released') },
          ]}
        />
      </div>
      <NoticeLine notice={model.notice} onDismiss={actions?.onDismissNotice} />
      {!released && shownNotices.length > 0 && (
        <div className="fw-chg-notices">
          {shownNotices.map((one) => (
            <Banner
              key={one.id}
              tone={one.tone}
              title={say(one)}
              action={
                <Button size="sm" variant="quiet" onClick={() => actions?.onDismissPageNotice?.(one.id)}>
                  {t('common.dismiss')}
                </Button>
              }
            />
          ))}
          {notices.length > 1 && (
            <Button size="sm" variant="link" onClick={() => setShowAll(!showAll)} aria-expanded={showAll}>
              {showAll ? t('notice.fewer') : t('notice.more', { count: notices.length - 1 })}
            </Button>
          )}
        </div>
      )}
      <MetricStrip metrics={CHANGE_TILES.map(tile)} />
      {released ? (
        <ListFrame<ReleasedRow>
          label={t('released.tableLabel')}
          rows={releasedState ? [] : releasedRows}
          rowId={(row) => row.revision.id}
          columns={releasedColumns}
          count={model.released ? (model.released.complete ? t('list.count', { count: releasedRows?.length ?? 0 }) : t('list.countMore', { count: releasedRows?.length ?? 0 })) : t('list.countReading')}
          search={searchBox}
          tools={styleChip || undefined}
          state={releasedState}
          title={t('released.tableLabel')}
          listKey="products.changes.released"
          keysOpen={model.keysOpen}
          cards={{ hrefOf: (row) => styleHref(model.prefix, row.style.id, row.revision.id) }}
        />
      ) : (
        <ListFrame<ChangeRow>
          label={t('list.tableLabel')}
          rows={state ? [] : rows}
          rowId={(row) => row.id}
          columns={columns}
          count={model.read ? (isComplete(model.read) ? t('list.count', { count: rows?.length ?? 0 }) : t('list.countMore', { count: rows?.length ?? 0 })) : t('list.countReading')}
          search={searchBox}
          tools={tools}
          selection={{
            selected,
            onChange: setSelected,
            exportSelected: true,
            actions: (
              <>
                <Button size="sm" heldReason={oneHeld} onClick={() => decideOne('APPROVED')} aria-label={t('list.approveOne')}>
                  <Check size={13} aria-hidden /> <SelectionLabel>{t('list.approveOne')}</SelectionLabel>
                </Button>
                <Button size="sm" heldReason={oneHeld} onClick={() => decideOne('REJECTED')} aria-label={t('list.rejectOne')}>
                  <X size={13} aria-hidden /> <SelectionLabel>{t('list.rejectOne')}</SelectionLabel>
                </Button>
                <Button size="sm" aria-label={t('list.copyMany', { count: picked.length })} onClick={() => actions?.onCopy?.(picked.flatMap((row) => (row.number ? [row.number] : [])))}>
                  <Copy size={13} aria-hidden /> <SelectionLabel>{t('list.copyMany', { count: picked.length })}</SelectionLabel>
                </Button>
              </>
            ),
          }}
          updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
          keys={ownKeys}
          keysOpen={model.keysOpen}
          onOpen={(row) => actions?.onOpen?.(row)}
          state={state}
          title={t('list.tableLabel')}
          cards={{ hrefOf: (row) => hrefOf(model.prefix, row) }}
        />
      )}
      <p className="fw-chg-hint">{released ? t('released.foot') : t('list.foot')}</p>
      {model.newRequest && <NewRequestDialog model={model.newRequest} can={model.can} actions={actions?.newRequest} />}
      {model.newOrder && <NewOrderDialog model={model.newOrder} can={model.can} actions={actions?.newOrder} />}
      {model.decide && <DecideDialog model={model.decide} prefix={model.prefix} canWorkOrders={model.can.workOrders} actions={actions?.decide} />}
    </div>
  )
}
