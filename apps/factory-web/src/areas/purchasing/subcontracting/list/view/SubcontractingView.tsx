'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Download, MoreHorizontal, Plus, Search, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, MetricStrip, Modal } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, SegmentedControl, Select } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayAt, money } from '../../../../_shared/buying/model'
import type { OrderRow } from '../../api'
import { KIT_TONE, ORDER_VIEWS, piecesLine, say, STATUS_TONE, TILES, type OrderView } from '../../model'
import type { SubcontractingActions, SubcontractingModel } from '../list-model'
import { NewOrderDialog } from './NewOrderDialog'
import { StockSection } from './StockSection'
import '../../../../_shared/buying/buying.css'
import '../../subcontracting.css'

export type { SubcontractingActions, SubcontractingModel } from '../list-model'

/**
 * SCR-128 — Subcontract orders (Purchasing › Outside work; design purchasing.subcontracting, workspace-list): the band
 * (as of, live, New subcontract order `c`, ⋯ Stock at subcontractors / Export / keys), the tiles "Outside work" (kit to
 * send, at workshops, due back this week, late — each a saved filter; balance open is W2b and draws '—'), and the shared
 * list frame of every job at a terzista: number (a real link), workshop, services, work order, pieces sent / back, kit,
 * expected back (red when late), the fee (cost grain only: the column is not drawn without it), status; Rows ▾ the saved
 * views; select-all, shift range, x, Export N (CSV) while rows are selected; live changes behind "N updates · Show".
 * `show: 'stock'` draws SCR-129 (Stock at subcontractors) under the same band and tiles.
 */
export function SubcontractingView({ model, actions }: { model: SubcontractingModel; actions?: SubcontractingActions }) {
  return (
    <WithMessages namespaces={['subcontracting', 'lists']}>
      <Page model={model} actions={actions} />
    </WithMessages>
  )
}

function Page({ model, actions }: { model: SubcontractingModel; actions?: SubcontractingActions }) {
  const t = useT('subcontracting')
  const lists = useT('lists')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const [help, setHelp] = useState(!!model.helpOpen)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.newOrder || help) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      if (event.key === 'c' && model.can.manage) {
        event.preventDefault()
        actions?.onNew?.(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!model.can.view) {
    return (
      <div className="fw-by">
        <Card padded>
          <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('page.noAccess.title')} description={t('page.noAccess.body')} />
        </Card>
      </div>
    )
  }

  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('page.keyNew') }]
  const newHeld = model.can.manage ? null : t('held.permission', { permission: 'purchasing.subcontract.manage' })
  const tileView = TILES.find((tile) => tile.view === model.view)?.view ?? null
  const more = [
    model.show === 'orders'
      ? { id: 'stock', label: t('page.showStock'), onSelect: () => actions?.onShow?.('stock') }
      : { id: 'orders', label: t('page.showOrders'), onSelect: () => actions?.onShow?.('orders') },
    ...(model.show === 'orders' && (model.rows.items?.length ?? 0) > 0 ? [{ id: 'export', label: t('page.export'), onSelect: () => actions?.onExport?.((model.rows.items ?? []).map((row) => row.id)) }] : []),
    { id: 'keys', label: t('page.shortcuts'), onSelect: () => setHelp(true) },
  ]

  return (
    <div className="fw-by">
      <div className="fw-by-head">
        <span className="fw-sc-switch">
          <SegmentedControl
            size="sm"
            ariaLabel={t('page.switch')}
            value={model.show}
            onChange={(value) => actions?.onShow?.(value === 'stock' ? 'stock' : 'orders')}
            options={[
              { value: 'orders', label: t('page.showOrders') },
              { value: 'stock', label: t('page.showStock') },
            ]}
          />
          <span className="fw-by-status" role="status">
            {model.asOf ? t('common.updated', { time: formatTime(model.asOf, place) }) : t('common.notYet')}
            {' · '}
            {t(`live.${model.live}`)}
          </span>
        </span>
        <span className="fw-by-actions">
          <Button size="sm" variant="primary" heldReason={newHeld} onClick={() => actions?.onNew?.(true)} aria-keyshortcuts="c">
            <Plus size={14} aria-hidden /> {t('page.new')}
          </Button>
          <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('page.more') }} items={more} />
        </span>
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={say(t, model.notice.words)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}

      <section aria-label={t('tiles.label')}>
        {model.countsProblem ? (
          <Banner tone="danger" title={t('list.failed')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>}>
            {t(model.countsProblem)}
          </Banner>
        ) : (
          <MetricStrip
            metrics={TILES.map((tile) => {
              const value = model.counts ? tile.count(model.counts) : null
              const shown = value === null ? '—' : String(value)
              if (tile.view === null) return { label: t(`tile.${tile.id}`), value: shown, hint: t('tile.balanceLater') }
              const view = tile.view
              return {
                label: t(`tile.${tile.id}`),
                value: shown,
                onClick: () => {
                  actions?.onShow?.('orders')
                  actions?.onView?.(model.view === view && model.show === 'orders' ? 'open' : view)
                },
                active: model.show === 'orders' && tileView === view,
                ...(tile.id === 'late' && value ? { accent: 'var(--nds-danger)' } : {}),
              }
            })}
          />
        )}
      </section>

      {model.show === 'orders' ? <OrdersSection model={model} actions={actions} ownKeys={ownKeys} onHelp={() => setHelp(true)} /> : <StockSection model={model} actions={actions} onHelp={() => setHelp(true)} />}

      {model.newOrder && <NewOrderDialog model={model} actions={actions} />}
      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('common.shortcuts')} size="sm">
          <ul className="fw-by-list">
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

function OrdersSection({ model, actions, ownKeys, onHelp }: { model: SubcontractingModel; actions?: SubcontractingActions; ownKeys: ListKey[]; onHelp: () => void }) {
  const t = useT('subcontracting')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const [query, setQuery] = useState(model.q)
  useEffect(() => setQuery(model.q), [model.q])
  const typed = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onSearch?.(query), 300)
    return () => clearTimeout(timer)
  }, [query])
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const items = model.rows.items
  const rowsKey = items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  const picked = (items ?? []).filter((row) => selected.includes(row.id))

  const columns = useMemo<ColDef<OrderRow>[]>(() => {
    const href = (row: OrderRow) => `${model.prefix}/purchasing/subcontracting/${row.id}`
    const date = (day: string) => formatDate(dayAt(day), place)
    const NumberCell = ({ data }: ICellRendererParams<OrderRow>) =>
      data ? (
        <span className="fw-by-cell">
          <Link className="fw-by-link" href={href(data)}>
            {data.number}
          </Link>
          <span className="fw-by-cell-sub">{date(data.orderDate)}</span>
        </span>
      ) : null
    const WorkshopCell = ({ data }: ICellRendererParams<OrderRow>) =>
      data ? (
        <span className="fw-by-cell" title={data.workshop.name}>
          <span className="fw-by-ellipsis">{data.workshop.name}</span>
          <span className="fw-by-cell-sub">{data.location.code}</span>
        </span>
      ) : null
    const ServiceCell = ({ data }: ICellRendererParams<OrderRow>) =>
      data ? (
        <span className="fw-by-ellipsis" title={data.services.map((service) => `${service.code} ${service.name}`).join(' · ')}>
          {data.services.map((service) => service.name).join(' · ') || '—'}
        </span>
      ) : null
    const WorkOrderCell = ({ data }: ICellRendererParams<OrderRow>) =>
      data ? (
        <span className="fw-by-cell">
          {model.can.workOrders ? (
            <Link className="fw-by-link" href={`${model.prefix}/production/work-orders/${data.workOrder.id}`}>
              {data.workOrder.number}
            </Link>
          ) : (
            <span>{data.workOrder.number}</span>
          )}
          <span className="fw-by-cell-sub" title={data.workOrder.style.name}>
            {data.workOrder.style.code}
          </span>
        </span>
      ) : null
    const PiecesCell = ({ data }: ICellRendererParams<OrderRow>) => {
      if (!data) return null
      const line = piecesLine(data)
      return (
        <span className="fw-by-cell">
          <span className="fw-by-num">{line.sent === 0 ? t('list.nothingSent') : t('list.sentBack', { sent: line.sent, back: line.back })}</span>
          <span className="fw-by-cell-sub">{line.atWorkshop > 0 ? t('list.atWorkshop', { count: line.atWorkshop }) : t('list.ordered', { count: line.ordered })}</span>
        </span>
      )
    }
    const KitCell = ({ data }: ICellRendererParams<OrderRow>) =>
      data ? (
        <span className="fw-by-cell">
          <span>
            <Pill tone={KIT_TONE[data.kit.state]}>{t(`kit.${data.kit.state}`)}</Pill>
          </span>
          {data.kit.planned + data.kit.sent > 0 && <span className="fw-by-cell-sub">{t('list.kitLines', { sent: data.kit.sent, planned: data.kit.planned + data.kit.sent })}</span>}
        </span>
      ) : null
    const BackCell = ({ data }: ICellRendererParams<OrderRow>) =>
      data ? (
        data.expectedBackDate ? (
          <span className={data.late ? 'fw-by-cell fw-sc-late' : 'fw-by-cell'}>
            <span>{date(data.expectedBackDate)}</span>
            {data.late && <span className="fw-by-cell-sub fw-sc-late">{t('list.late', { date: date(data.expectedBackDate) })}</span>}
          </span>
        ) : (
          <span className="fw-by-hint">{t('list.noDate')}</span>
        )
      ) : null
    const FeeCell = ({ data }: ICellRendererParams<OrderRow>) => (data ? <span className="fw-by-num">{money(data.netAmount ?? null, data.currency, locale)}</span> : null)
    const StatusCell = ({ data }: ICellRendererParams<OrderRow>) =>
      data ? (
        <Pill tone={STATUS_TONE[data.status]}>{t(`status.${data.status}`)}</Pill>
      ) : null
    const MoreCell = ({ data }: ICellRendererParams<OrderRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { number: data.number }) }}
          items={[
            { id: 'open', label: t('common.open'), href: href(data) },
            { id: 'tab', label: t('common.openNewTab'), href: href(data), target: '_blank' },
            { id: 'kit', label: t('list.tab.kit'), href: `${href(data)}?tab=kit` },
            { id: 'back', label: t('list.tab.back'), href: `${href(data)}?tab=back` },
            { id: 'sheet', label: t('list.jobSheet'), href: `${href(data)}/job-sheet`, target: '_blank' },
          ]}
        />
      ) : null
    return [
      { colId: 'number', headerName: t('col.number'), field: 'number', minWidth: 120, flex: 0.9, cellRenderer: NumberCell },
      { colId: 'workshop', headerName: t('col.workshop'), minWidth: 150, flex: 1.4, valueGetter: (params) => params.data?.workshop.name ?? '', cellRenderer: WorkshopCell },
      { colId: 'service', headerName: t('col.service'), minWidth: 130, flex: 1.3, cellRenderer: ServiceCell },
      { colId: 'workOrder', headerName: t('col.workOrder'), minWidth: 120, flex: 0.9, cellRenderer: WorkOrderCell },
      { colId: 'pieces', headerName: t('col.pieces'), minWidth: 140, flex: 1.1, cellRenderer: PiecesCell },
      { colId: 'kit', headerName: t('col.kit'), minWidth: 130, flex: 1, cellRenderer: KitCell },
      { colId: 'back', headerName: t('col.back'), minWidth: 120, flex: 0.9, cellRenderer: BackCell },
      ...(model.can.cost ? [{ colId: 'fee', headerName: t('col.fee'), minWidth: 100, flex: 0.7, type: 'rightAligned', cellRenderer: FeeCell } satisfies ColDef<OrderRow>] : []),
      { colId: 'status', headerName: t('col.status'), minWidth: 130, flex: 0.9, cellRenderer: StatusCell },
      { colId: 'more', headerName: t('col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, model.prefix, model.can.cost, model.can.workOrders, model.timeZone])

  const filtered = model.q.trim() !== '' || model.view !== 'open'
  const state = model.rows.problem ? (
    <EmptyState title={t('list.failed')} description={t(model.rows.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : items && items.length === 0 ? (
    filtered ? (
      <EmptyState
        title={t('list.noMatch.title')}
        description={t('list.noMatch.body')}
        action={
          <Button
            size="sm"
            onClick={() => {
              setQuery('')
              actions?.onSearch?.('')
              actions?.onView?.('open')
            }}
          >
            {t('common.clearFilters')}
          </Button>
        }
      />
    ) : (
      <EmptyState
        title={t('list.empty.title')}
        description={t('list.empty.body')}
        action={
          <Button size="sm" variant="primary" heldReason={model.can.manage ? null : t('held.permission', { permission: 'purchasing.subcontract.manage' })} onClick={() => actions?.onNew?.(true)}>
            <Plus size={14} aria-hidden /> {t('page.new')}
          </Button>
        }
      />
    )
  ) : undefined

  return (
    <>
      <ListFrame<OrderRow>
        label={t('list.tableLabel')}
        rows={state ? [] : items}
        rowId={(row) => row.id}
        columns={columns}
        count={items ? t(model.rows.more ? 'common.countMore' : 'common.count', { count: items.length }) : '—'}
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
          <Select size="sm" aria-label={t('list.viewLabel')} value={model.view} onChange={(event) => actions?.onView?.(event.target.value as OrderView)}>
            {ORDER_VIEWS.map((view) => (
              <option key={view} value={view}>
                {t(`view.${view}`)}
              </option>
            ))}
          </Select>
        }
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" aria-label={t('bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
              <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.rows.more && items && items.length > 0 ? { label: t('common.more'), onMore: () => actions?.onMore?.() } : null}
        keys={ownKeys}
        onHelp={onHelp}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
        focusRow={model.focusRow}
      />
      {model.slow && items === null && !model.rows.problem && (
        <p className="fw-by-hint" role="status">
          {t('list.loadingSlow')}
        </p>
      )}
      {model.view !== 'open' && <p className="fw-by-hint">{t('list.viewing', { view: t(`view.${model.view}`) })}</p>}
    </>
  )
}
