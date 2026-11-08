'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Download, MoreHorizontal, Plus, Printer, Search, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, MetricStrip } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { LiveState } from '../../_shared/hooks'
import { CUT_VIEWS, type CutTiles, type CutView, type YieldFigures } from '../api'
import { CUTTING_NAMESPACE, lotLine, materialLine, percent, STATE_TONE, TILES, tileValue, ticketsHeld, usedText, varianceTone, type CutAddress, type CuttingCan, type Phrase } from '../model'
import type { CutOrderTiles } from '../orders/api'
import { fabricTiles, ORDER_TONE, orderDate, orderHref, orderMaterial, ORDERS_NAMESPACE, planPhrase, sheetHref, type ListRow, type OrdersCan } from '../orders/model'
import { NewCutOrderDialog, type NewOrderActions, type NewOrderModel } from '../orders/view/NewCutOrderDialog'
import { AllocateHidesDialog, say, type AllocModel } from './CutDialogs'
import '../cutting.css'

export interface CuttingModel {
  readonly prefix: string
  readonly can: CuttingCan
  /** B-W2b-129: what the person may do with cut orders. */
  readonly orders: OrdersCan
  readonly address: CutAddress
  /** The cut orders (W2b) and the work orders' leather cuts (W2a) of the saved filter, in one list. */
  readonly rows: { readonly items: readonly ListRow[] | null; readonly more: boolean; readonly problem: string | null }
  /** The cut orders' read failed while the cuts were read (a message key): said above the list. */
  readonly ordersProblem: string | null
  readonly tiles: CutTiles | null
  /** The fabric cut orders per status (Waiting to cut and Cutting now add them). */
  readonly fabric: CutOrderTiles | null
  readonly yieldToday: YieldFigures | null
  readonly asOf: string | null
  readonly live: LiveState
  readonly updates: number
  /** The first read takes longer than about a second. */
  readonly slow: boolean
  readonly timeZone: string
  readonly notice: { readonly tone: 'success' | 'danger' | 'info'; readonly words: Phrase } | null
  /** New cut order (`?new=1`). */
  readonly newOrder: NewOrderModel | null
  /** Allocate hides (`?alloc=<work order>`). */
  readonly alloc: AllocModel | null
  /** Design cases: the selection, the focused row, the keys panel. */
  readonly selected?: readonly string[]
  readonly focusRow?: number
  readonly helpOpen?: boolean
}

export interface CuttingActions extends NewOrderActions {
  onView?: (view: CutView) => void
  onSearch?: (q: string) => void
  onMore?: () => void
  onRetry?: () => void
  onOpen?: (row: ListRow) => void
  onShowUpdates?: () => void
  onNew?: (open: boolean) => void
  onAllocate?: (workOrderId: string | null) => void
  onReserve?: (hideIds: string[], material: { itemId: string; itemColourId: string | null }) => void
  onMaterial?: (material: { itemId: string; itemColourId: string | null }) => void
  onExport?: (keys: string[]) => void
  onTickets?: (row: ListRow) => void
  onDismissNotice?: () => void
}

/**
 * SCR-238 — Cutting (Production › Cutting room; design production.cutting, workspace-list): the head (as of, live, Print tickets
 * for the cut selected, New cut order `c` as the primary, ⋯ Export / keys), the tiles (waiting to cut and cutting now — each a
 * saved filter, the fabric cut orders added —, pieces cut today, hides and m² used today, yield today against the plan), and the
 * shared list frame of the cuts across work orders — "leather by hide, fabric by lay": the cut orders of several work orders
 * (B-W2b-129: fabric by lay, a leather group) and each work order's leather cut (W2a) —: the cut (a real link to its record, its
 * work orders under it), kind, material and colour, shade lot, status, pieces or garments, hides or plies, yield against plan,
 * the table, the date; Rows ▾ the saved filters; select-all, shift range, x, Export N while rows are selected; live changes
 * behind "N updates · Show". Never who cut: tables, hides, lays and lots only.
 */
export function CuttingView({ model, actions }: { model: CuttingModel; actions?: CuttingActions }) {
  return (
    <WithMessages namespaces={[CUTTING_NAMESPACE, ORDERS_NAMESPACE, 'lists']}>
      <Page model={model} actions={actions} />
    </WithMessages>
  )
}

function Page({ model, actions }: { model: CuttingModel; actions?: CuttingActions }) {
  const t = useT(CUTTING_NAMESPACE)
  const o = useT(ORDERS_NAMESPACE)
  const lists = useT('lists')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const [help, setHelp] = useState(!!model.helpOpen)
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const items = model.rows.items
  const rowsKey = items?.map((row) => row.key).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((key) => rowsKey.split(',').includes(key))), [rowsKey])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  const picked = (items ?? []).filter((row) => selected.includes(row.key))

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.newOrder || model.alloc || help) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      if (event.key === 'c' && model.can.view) {
        event.preventDefault()
        actions?.onNew?.(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!model.can.view) {
    return (
      <div className="fw-ct">
        <Card padded>
          <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('page.noAccess.title')} description={t('page.noAccess.body', { permission: 'production.cutting.view' })} />
        </Card>
      </div>
    )
  }

  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('page.keyNew') }]
  const ticketsWhy = say(t, ticketsHeld(picked.length, model.can))
  const more = [
    ...((items?.length ?? 0) > 0 ? [{ id: 'export', label: t('page.export'), onSelect: () => actions?.onExport?.((items ?? []).map((row) => row.key)) }] : []),
    { id: 'keys', label: t('page.shortcuts'), onSelect: () => setHelp(true) },
  ]
  const fabric = fabricTiles(model.fabric)

  return (
    <div className="fw-ct">
      <div className="fw-ct-head">
        <span className="fw-ct-status" role="status">
          {model.asOf ? t('common.updated', { time: formatTime(model.asOf, place) }) : t('common.notYet')}
          {' · '}
          {t(`live.${model.live}`)}
        </span>
        <span className="fw-ct-actions">
          <Button size="sm" heldReason={ticketsWhy} onClick={() => picked[0] && actions?.onTickets?.(picked[0])}>
            <Printer size={14} aria-hidden /> {t('page.tickets')}
          </Button>
          <Button size="sm" variant="primary" onClick={() => actions?.onNew?.(true)} aria-keyshortcuts="c">
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
        <MetricStrip
          metrics={TILES.map((tile) => {
            const value = tileValue(tile.id, model.tiles, model.yieldToday, locale, fabric)
            const view = tile.view
            if (view === null) {
              const hint = tile.id === 'yieldToday' ? t('tile.yieldHint') : tile.id === 'areaToday' ? t('tile.areaHint') : t('tile.todayHint')
              return { label: t(`tile.${tile.id}`), value, hint, ...(tile.id === 'yieldToday' && model.yieldToday ? { accent: varianceTone(model.yieldToday.variancePct) === 'warning' ? 'var(--nds-warning)' : undefined } : {}) }
            }
            const orders = fabric ? (tile.id === 'waiting' ? fabric.waiting : fabric.cutting) : 0
            return { label: t(`tile.${tile.id}`), value, hint: orders > 0 ? o('tile.withFabric', { count: orders }) : undefined, onClick: () => actions?.onView?.(model.address.view === view ? 'open' : view), active: model.address.view === view }
          })}
        />
      </section>

      {model.ordersProblem && <Banner tone="warning" title={o('list.ordersFailed')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>}>{o(model.ordersProblem)}</Banner>}

      <CutsList model={model} actions={actions} selected={selected} onSelected={setSelected} picked={picked} ownKeys={ownKeys} onHelp={() => setHelp(true)} />

      {model.newOrder && <NewCutOrderDialog model={model.newOrder} can={model.orders} actions={{ ...actions, onClose: () => actions?.onNew?.(false) }} />}
      {model.alloc && <AllocateHidesDialog model={model.alloc} can={model.can} actions={actions} />}
      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('common.shortcuts')} size="sm">
          <ul className="fw-ct-list">
            {listKeys(ownKeys, true).map((entry) => (
              <li key={entry.does}>
                <span>
                  <b>{entry.keys.join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
                </span>
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  )
}

function CutsList({
  model,
  actions,
  selected,
  onSelected,
  picked,
  ownKeys,
  onHelp,
}: {
  model: CuttingModel
  actions?: CuttingActions
  selected: readonly string[]
  onSelected: (ids: string[]) => void
  picked: readonly ListRow[]
  ownKeys: ListKey[]
  onHelp: () => void
}) {
  const t = useT(CUTTING_NAMESPACE)
  const o = useT(ORDERS_NAMESPACE)
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const [query, setQuery] = useState(model.address.q)
  useEffect(() => setQuery(model.address.q), [model.address.q])
  const typed = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onSearch?.(query), 300)
    return () => clearTimeout(timer)
  }, [query])
  const items = model.rows.items

  const columns = useMemo<ColDef<ListRow>[]>(() => {
    const cutHref = (workOrderId: string) => `${model.prefix}/production/cutting/${workOrderId}`
    const CutCell = ({ data }: ICellRendererParams<ListRow>) => {
      if (!data) return null
      if (data.order) {
        const order = data.order
        return (
          <span className="fw-ct-cell">
            <Link className="fw-ct-link" href={orderHref(model.prefix, order.id)}>
              {order.number}
            </Link>
            <span className="fw-ct-sub" title={order.workOrders.map((workOrder) => workOrder.number).join(', ')}>
              {order.workOrders.map((workOrder) => workOrder.number).join(', ')}
            </span>
          </span>
        )
      }
      const cut = data.cut
      return (
        <span className="fw-ct-cell">
          {model.can.workOrders ? (
            <Link className="fw-ct-link" href={cutHref(cut.workOrder.id)}>
              {cut.workOrder.number}
            </Link>
          ) : (
            <span>{cut.workOrder.number}</span>
          )}
          <span className="fw-ct-sub" title={cut.style.name}>
            {cut.style.code}
            {cut.workOrder.dueDate ? ` · ${t('list.due', { date: formatDate(`${cut.workOrder.dueDate}T12:00:00Z`, place) })}` : ''}
          </span>
        </span>
      )
    }
    const MaterialCell = ({ data }: ICellRendererParams<ListRow>) => {
      if (!data) return null
      const [line, sub] = data.order ? [orderMaterial(data.order), data.order.material.item.name] : [materialLine(data.cut), data.cut.materials.map((material) => material.name).join(', ')]
      return (
        <span className="fw-ct-cell" title={sub}>
          <span className="fw-ct-ellipsis">{line}</span>
          <span className="fw-ct-sub">{sub}</span>
        </span>
      )
    }
    const StateCell = ({ data }: ICellRendererParams<ListRow>) => {
      if (!data) return null
      if (data.order) {
        const order = data.order
        return (
          <span className="fw-ct-cell">
            <span>
              <Pill tone={ORDER_TONE[order.status]}>{o(`status.${order.status}`)}</Pill>
            </span>
            <span className="fw-ct-sub">{order.kind === 'FABRIC' && order.lays.count > 0 ? o('list.laysCut', { cut: order.lays.cut, count: order.lays.count }) : o('list.tickets', { done: order.tickets.done, count: order.tickets.open + order.tickets.started + order.tickets.done })}</span>
          </span>
        )
      }
      const cut = data.cut
      return (
        <span className="fw-ct-cell">
          <span>
            <Pill tone={STATE_TONE[cut.state]}>{t(`state.${cut.state}`)}</Pill>
          </span>
          {cut.state === 'HELD' && cut.workOrder.holdReason ? (
            <span className="fw-ct-sub" title={cut.workOrder.holdReason}>
              {cut.workOrder.holdReason}
            </span>
          ) : cut.allocated > 0 ? (
            <span className="fw-ct-sub">{t('list.allocated', { count: cut.allocated })}</span>
          ) : cut.recutsOpen > 0 ? (
            <span className="fw-ct-sub">{t('list.recuts', { count: cut.recutsOpen })}</span>
          ) : null}
        </span>
      )
    }
    const PiecesCell = ({ data }: ICellRendererParams<ListRow>) => {
      if (!data) return null
      if (data.order) return <span className="fw-ct-num">{o('list.garments', { count: data.order.garments })}</span>
      return (
        <span className="fw-ct-cell">
          <span className="fw-ct-num">{t('list.piecesOf', { cut: data.cut.pieces.cut, planned: data.cut.pieces.planned })}</span>
          <span className="fw-ct-sub">{t('list.garments', { cut: data.cut.garments.cut, planned: data.cut.garments.planned })}</span>
        </span>
      )
    }
    const HidesCell = ({ data }: ICellRendererParams<ListRow>) => {
      if (!data) return null
      if (data.order) {
        const plan = planPhrase(data.order)
        return data.order.kind === 'FABRIC' ? <span className="fw-ct-num">{o(plan.key, plan.params)}</span> : <span className="fw-ct-hint">{o('list.byHide')}</span>
      }
      return (
        <span className="fw-ct-cell">
          <span className="fw-ct-num">{data.cut.hides.count === 0 ? '—' : t('list.hides', { count: data.cut.hides.count })}</span>
          <span className="fw-ct-sub">{usedText(data.cut.hides.used, locale)}</span>
        </span>
      )
    }
    const YieldCell = ({ data }: ICellRendererParams<ListRow>) => {
      if (!data) return null
      if (data.order) return <span className="fw-ct-hint">{o('list.yieldOnRecord')}</span>
      const cut = data.cut
      return cut.yield.yieldPct === null ? (
        <span className="fw-ct-hint">{cut.hides.count === 0 ? '—' : t('list.yieldUnknown')}</span>
      ) : (
        <span className="fw-ct-cell">
          <span>
            <Tag tone={varianceTone(cut.yield.variancePct)}>{percent(cut.yield.yieldPct, locale)}</Tag>
          </span>
          <span className="fw-ct-sub">{cut.yield.plannedPct === null ? t('list.noPlan') : t('list.plan', { pct: percent(cut.yield.plannedPct, locale) })}</span>
        </span>
      )
    }
    const WhenCell = ({ data }: ICellRendererParams<ListRow>) => {
      if (!data) return null
      const when = data.order ? orderDate(data.order) : data.cut.lastCutAt
      return when ? (
        <span className="fw-ct-cell">
          <span className="fw-ct-num">{formatDate(when, place)}</span>
          <span className="fw-ct-sub">{formatTime(when, place)}</span>
        </span>
      ) : (
        <span className="fw-ct-hint">—</span>
      )
    }
    const MoreCell = ({ data }: ICellRendererParams<ListRow>) => {
      if (!data) return null
      if (data.order) {
        const order = data.order
        return (
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('list.rowMenu', { number: order.number }) }}
            items={[
              { id: 'open', label: t('common.open'), href: orderHref(model.prefix, order.id) },
              { id: 'tab', label: t('common.openNewTab'), href: orderHref(model.prefix, order.id), target: '_blank' as const },
              { id: 'sheet', label: o('record.sheet'), href: sheetHref(model.prefix, order.id), target: '_blank' as const },
              { id: 'tickets', label: o('tab.tickets'), href: orderHref(model.prefix, order.id, 'tickets') },
            ]}
          />
        )
      }
      const cut = data.cut
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { number: cut.workOrder.number }) }}
          items={[
            ...(model.can.workOrders
              ? [
                  { id: 'open', label: t('common.open'), href: cutHref(cut.workOrder.id) },
                  { id: 'tab', label: t('common.openNewTab'), href: cutHref(cut.workOrder.id), target: '_blank' as const },
                  { id: 'tickets', label: t('tab.tickets'), href: `${cutHref(cut.workOrder.id)}?tab=tickets` },
                  { id: 'workOrder', label: t('list.workOrder'), href: `${model.prefix}/production/work-orders/${cut.workOrder.id}?tab=cutting` },
                ]
              : []),
            { id: 'alloc', label: t('alloc.open'), onSelect: () => actions?.onAllocate?.(cut.workOrder.id) },
          ]}
        />
      )
    }
    return [
      { colId: 'cut', headerName: t('col.cut'), minWidth: 135, flex: 1.1, cellRenderer: CutCell, valueGetter: (params) => (params.data ? (params.data.order?.number ?? params.data.cut?.workOrder.number ?? '') : '') },
      { colId: 'kind', headerName: t('col.kind'), minWidth: 84, flex: 0.45, valueGetter: (params) => (params.data ? t(`kind.${params.data.order?.kind ?? 'LEATHER'}`) : '') },
      { colId: 'material', headerName: t('col.material'), minWidth: 150, flex: 1.1, cellRenderer: MaterialCell },
      { colId: 'lot', headerName: t('col.lot'), minWidth: 110, flex: 0.8, valueGetter: (params) => (params.data?.cut ? lotLine(params.data.cut) : '—') },
      { colId: 'state', headerName: t('col.state'), minWidth: 120, flex: 0.9, cellRenderer: StateCell },
      { colId: 'pieces', headerName: t('col.pieces'), minWidth: 110, flex: 0.7, cellRenderer: PiecesCell },
      { colId: 'hides', headerName: o('col.hidesOrPlies'), minWidth: 120, flex: 0.8, cellRenderer: HidesCell },
      { colId: 'yield', headerName: t('col.yield'), minWidth: 100, flex: 0.7, cellRenderer: YieldCell },
      { colId: 'table', headerName: t('col.table'), minWidth: 75, flex: 0.5, valueGetter: (params) => (params.data ? (params.data.order ? (params.data.order.station?.code ?? '—') : params.data.cut!.stations.map((station) => station.code).join(', ') || '—') : '') },
      { colId: 'date', headerName: o('col.date'), minWidth: 105, flex: 0.7, cellRenderer: WhenCell },
      { colId: 'more', headerName: t('col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, o, locale, model.prefix, model.can.workOrders, model.timeZone, actions])

  const filtered = model.address.q.trim() !== '' || model.address.view !== 'open'
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
          <Button size="sm" variant="primary" onClick={() => actions?.onNew?.(true)}>
            <Plus size={14} aria-hidden /> {t('page.new')}
          </Button>
        }
      />
    )
  ) : undefined

  return (
    <>
      <ListFrame<ListRow>
        label={t('list.tableLabel')}
        rows={state ? [] : items}
        rowId={(row) => row.key}
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
          <Select size="sm" aria-label={t('list.viewLabel')} value={model.address.view} onChange={(event) => actions?.onView?.(event.target.value as CutView)}>
            {CUT_VIEWS.map((view) => (
              <option key={view} value={view}>
                {t(`view.${view}`)}
              </option>
            ))}
          </Select>
        }
        selection={{
          selected,
          onChange: onSelected,
          actions: (
            <>
              <Button size="sm" heldReason={say(t, ticketsHeld(picked.length, model.can))} onClick={() => picked[0] && actions?.onTickets?.(picked[0])}>
                <Printer size={13} aria-hidden /> <SelectionLabel>{t('page.tickets')}</SelectionLabel>
              </Button>
              <Button size="sm" aria-label={t('bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.key))}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count: picked.length })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.rows.more && items && items.length > 0 ? { label: t('common.more'), onMore: () => actions?.onMore?.() } : null}
        keys={ownKeys}
        onHelp={onHelp}
        onOpen={(row) => actions?.onOpen?.(row)}
        state={state}
        focusRow={model.focusRow}
      />
      {model.slow && items === null && !model.rows.problem && (
        <p className="fw-ct-hint" role="status">
          {t('list.loadingSlow')}
        </p>
      )}
      <p className="fw-ct-hint">{t('list.hint')}</p>
    </>
  )
}
