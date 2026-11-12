'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Copy, MoreHorizontal, Plus } from 'lucide-react'
import { EmptyState, Menu, MetricStrip } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Select, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import type { LiveState } from '../../../../../shell/live/use-live'
import type { TransferList } from '../../api'
import { isFiltered, recordHref, rowLifecycle, TRANSFER_STATUSES, TRANSFER_TILES, type ListAddress, type Notice, type OptionSite, type TransferRow, type TransferStatus, type TransferTile, type TransfersCan } from '../../model'
import { Freshness, isPageKey, LifecyclePill, NoAccess, NoticeLine, PageHead, SiteText, TransfersMessages, useWords } from '../../parts'
import { NewTransferDialog, type NewTransferActions, type NewTransferModel } from './NewTransferDialog'

/** SCR-360 — Warehouse › In the warehouse › Transfers: the tiles and the transfers between sites on the shared list frame. */
export interface TransfersListModel {
  prefix: string
  can: TransfersCan
  address: ListAddress
  /** The read: null while it is read; `problem` when it failed (never drawn as an empty list). */
  list: TransferList | null
  problem: string | null
  /** The sites of the filters and New transfer (null: not read yet). */
  sites: readonly OptionSite[] | null
  asOf: string | null
  live: LiveState
  updates: number
  notice: Notice | null
  created: NewTransferModel | null
  /** Design cases: rows selected, the keys panel open. */
  selected?: readonly string[]
  keysOpen?: boolean
}

export interface TransfersListActions {
  onAddress?: (patch: Partial<ListAddress>) => void
  onClearFilters?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onOpen?: (transferId: string) => void
  onNew?: () => void
  created?: NewTransferActions
  onCopy?: (numbers: readonly string[]) => void
  onDismissNotice?: () => void
}

export function TransfersListView({ model, actions }: { model: TransfersListModel; actions?: TransfersListActions }) {
  return (
    <TransfersMessages>
      <List model={model} actions={actions} />
    </TransfersMessages>
  )
}

function List({ model, actions }: { model: TransfersListModel; actions?: TransfersListActions }) {
  const { t, day } = useWords()
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [search, setSearch] = useState(model.address.q)
  useEffect(() => setSearch(model.address.q), [model.address.q])
  const rows = model.list?.rows ?? null
  const rowsKey = rows?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const offline = model.live === 'offline'
  const act = useRef(actions)
  act.current = actions
  const href = (row: Pick<TransferRow, 'id'>) => recordHref(model.prefix, row.id)

  // c: New transfer — never while typing or in a dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || model.created) return
      if (event.key === 'c' && model.can.manage && !offline) {
        event.preventDefault()
        act.current?.onNew?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model.created, model.can.manage, offline])

  const columns = useMemo<ColDef<TransferRow>[]>(() => {
    const NumberCell = ({ data }: ICellRendererParams<TransferRow>) =>
      data ? (
        <span className="fw-trf-cell">
          <Link className="fw-trf-link fw-trf-code" href={href(data)}>
            {data.number}
          </Link>
          {data.interCompany && <span className="fw-trf-hint">{t('row.interCompany')}</span>}
        </span>
      ) : null
    const FromCell = ({ data }: ICellRendererParams<TransferRow>) => (data ? <SiteText site={data.from} withCompany={data.interCompany} /> : null)
    const ToCell = ({ data }: ICellRendererParams<TransferRow>) => (data ? <SiteText site={data.to} withCompany={data.interCompany} /> : null)
    const StatusCell = ({ data }: ICellRendererParams<TransferRow>) => (data ? <LifecyclePill lifecycle={rowLifecycle(data)} /> : null)
    const ExpectedCell = ({ data }: ICellRendererParams<TransferRow>) =>
      data ? (
        data.late ? (
          <Tag tone="danger">{t('row.late', { day: day(data.expectedOn) })}</Tag>
        ) : (
          <span className="fw-trf-num">{day(data.expectedOn)}</span>
        )
      ) : null
    const DdtCell = ({ data }: ICellRendererParams<TransferRow>) =>
      data ? (
        data.ddtNumber ? (
          <Link className="fw-trf-link fw-trf-num" href={recordHref(model.prefix, data.id, 'transit')}>
            {data.ddtNumber}
          </Link>
        ) : (
          <span className="fw-trf-hint">—</span>
        )
      ) : null
    const DifferencesCell = ({ data }: ICellRendererParams<TransferRow>) => (data ? data.differences > 0 ? <Tag tone="danger">{t('row.differences', { count: data.differences })}</Tag> : <span className="fw-trf-hint">—</span> : null)
    const MoreCell = ({ data }: ICellRendererParams<TransferRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('row.menu', { number: data.number }) }}
          items={[
            { id: 'open', label: t('row.open'), href: href(data) },
            { id: 'tab', label: t('row.openNewTab'), href: href(data), target: '_blank' },
            ...(data.ddtNumber ? [{ id: 'ddt', label: t('row.openDdt'), href: recordHref(model.prefix, data.id, 'transit') }] : []),
            { id: 'copy', label: t('row.copy'), onSelect: () => act.current?.onCopy?.([data.number]) },
          ]}
        />
      ) : null
    return [
      { colId: 'number', headerName: t('col.number'), minWidth: 150, flex: 0.7, valueGetter: (params) => params.data?.number ?? '', cellRenderer: NumberCell },
      { colId: 'from', headerName: t('col.from'), minWidth: 160, flex: 0.9, valueGetter: (params) => params.data?.from.code ?? '', cellRenderer: FromCell },
      { colId: 'to', headerName: t('col.to'), minWidth: 160, flex: 0.9, valueGetter: (params) => params.data?.to.code ?? '', cellRenderer: ToCell },
      { colId: 'status', headerName: t('col.status'), minWidth: 140, flex: 0.6, valueGetter: (params) => (params.data ? t(`lifecycle.${rowLifecycle(params.data)}`) : ''), cellRenderer: StatusCell },
      { colId: 'lines', headerName: t('col.lines'), minWidth: 96, flex: 0.35, type: 'rightAligned', valueGetter: (params) => params.data?.lines ?? null },
      { colId: 'shipOn', headerName: t('col.shipOn'), minWidth: 120, flex: 0.5, valueGetter: (params) => params.data?.shipOn ?? '', valueFormatter: (params) => day(params.value as string | null) },
      { colId: 'expectedOn', headerName: t('col.expectedOn'), minWidth: 140, flex: 0.55, valueGetter: (params) => params.data?.expectedOn ?? '', cellRenderer: ExpectedCell },
      { colId: 'ddt', headerName: t('col.ddt'), minWidth: 120, flex: 0.5, valueGetter: (params) => params.data?.ddtNumber ?? '', cellRenderer: DdtCell },
      { colId: 'differences', headerName: t('col.differences'), minWidth: 130, flex: 0.5, valueGetter: (params) => params.data?.differences ?? 0, cellRenderer: DifferencesCell },
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    // The cells read the model through these values only.
  }, [t, day, model.prefix])

  if (!model.can.view) return <NoAccess />

  const picked = (rows ?? []).filter((row) => selected.includes(row.id))
  const filtered = isFiltered(model.address)
  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('keys.new') }]
  const newButton = (
    <Button size="sm" variant="primary" heldReason={model.can.manage ? (offline ? t('held.offline') : null) : t('held.noManage')} onClick={() => actions?.onNew?.()} aria-keyshortcuts="c">
      <Plus size={14} aria-hidden /> {t('list.new')}
    </Button>
  )
  const state = model.problem ? (
    <EmptyState
      title={t('list.failed')}
      description={t(model.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : rows !== null && rows.length === 0 ? (
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
      <EmptyState title={t('list.empty')} description={t('list.emptyBody')} action={model.can.manage ? newButton : undefined} />
    )
  ) : undefined

  const sites = model.sites ?? []
  const tools = (
    <>
      <Select size="sm" aria-label={t('list.statusLabel')} value={model.address.status ?? ''} onChange={(event) => actions?.onAddress?.({ status: (event.target.value || null) as TransferStatus | null })}>
        <option value="">{t('list.allStatuses')}</option>
        {TRANSFER_STATUSES.map((status) => (
          <option key={status} value={status}>
            {t(`status.${status}`)}
          </option>
        ))}
      </Select>
      <Select size="sm" aria-label={t('list.fromLabel')} value={model.address.from ?? ''} onChange={(event) => actions?.onAddress?.({ from: event.target.value || null })}>
        <option value="">{t('list.allFrom')}</option>
        {sites.map((site) => (
          <option key={site.id} value={site.id}>
            {site.code} · {site.name}
          </option>
        ))}
      </Select>
      <Select size="sm" aria-label={t('list.toLabel')} value={model.address.to ?? ''} onChange={(event) => actions?.onAddress?.({ to: event.target.value || null })}>
        <option value="">{t('list.allTo')}</option>
        {sites.map((site) => (
          <option key={site.id} value={site.id}>
            {site.code} · {site.name}
          </option>
        ))}
      </Select>
    </>
  )

  const tile = (id: TransferTile) => ({
    label: t(`tile.${id}`),
    value: model.list ? String(model.list.counts[id] ?? 0) : '—',
    hint: t(`tile.hint.${id}`),
    onClick: () => actions?.onAddress?.({ tile: model.address.tile === id ? null : id }),
    active: model.address.tile === id,
  })

  return (
    <div className="fw-trf">
      <PageHead intro={t('list.intro')} status={<Freshness asOf={model.asOf} live={model.live} />} actions={newButton} />
      <NoticeLine notice={model.notice} onDismiss={actions?.onDismissNotice} />
      <MetricStrip metrics={TRANSFER_TILES.map(tile)} />
      <ListFrame<TransferRow>
        label={t('list.tableLabel')}
        rows={state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={model.list ? (model.list.complete ? t('list.count', { count: rows?.length ?? 0 }) : t('list.countMore', { count: rows?.length ?? 0 })) : t('list.countReading')}
        search={
          <Input
            size="sm"
            type="search"
            className="fw-trf-search"
            aria-label={t('list.search')}
            placeholder={t('list.search')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') actions?.onAddress?.({ q: search })
            }}
            onBlur={() => search !== model.address.q && actions?.onAddress?.({ q: search })}
          />
        }
        tools={tools}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" aria-label={t('list.copyMany', { count: picked.length })} onClick={() => actions?.onCopy?.(picked.map((row) => row.number))}>
              <Copy size={13} aria-hidden /> <SelectionLabel>{t('list.copyMany', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        keys={ownKeys}
        keysOpen={model.keysOpen}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
        title={t('list.tableLabel')}
        cards={{ hrefOf: (row) => href(row) }}
        today={model.list?.today}
      />
      <p className="fw-trf-hint">{model.list && !model.list.complete ? t('list.footMore') : t('list.foot')}</p>
      {model.created && <NewTransferDialog model={model.created} can={model.can} actions={actions?.created} />}
    </div>
  )
}
