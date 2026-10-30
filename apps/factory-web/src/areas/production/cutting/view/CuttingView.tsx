'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Download, MoreHorizontal, Plus, Printer, Search, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, MetricStrip, Modal } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { LiveState } from '../../_shared/hooks'
import { CUT_VIEWS, type CutRow, type CutTiles, type CutView, type YieldFigures } from '../api'
import { CUTTING_NAMESPACE, lotLine, materialLine, percent, STATE_TONE, TILES, tileValue, ticketsHeld, usedText, varianceTone, type CutAddress, type CuttingCan, type Phrase } from '../model'
import { AllocateHidesDialog, NewCutDialog, say, type AllocModel, type NewCutModel } from './CutDialogs'
import '../cutting.css'

export interface CuttingModel {
  readonly prefix: string
  readonly can: CuttingCan
  readonly address: CutAddress
  readonly rows: { readonly items: readonly CutRow[] | null; readonly more: boolean; readonly problem: string | null }
  readonly tiles: CutTiles | null
  readonly yieldToday: YieldFigures | null
  readonly asOf: string | null
  readonly live: LiveState
  readonly updates: number
  /** The first read takes longer than about a second. */
  readonly slow: boolean
  readonly timeZone: string
  readonly notice: { readonly tone: 'success' | 'danger' | 'info'; readonly words: Phrase } | null
  /** New cut order (`?new=1`). */
  readonly newCut: NewCutModel | null
  /** Allocate hides (`?alloc=<work order>`). */
  readonly alloc: AllocModel | null
  /** Design cases: the selection, the focused row, the keys panel. */
  readonly selected?: readonly string[]
  readonly focusRow?: number
  readonly helpOpen?: boolean
}

export interface CuttingActions {
  onView?: (view: CutView) => void
  onSearch?: (q: string) => void
  onMore?: () => void
  onRetry?: () => void
  onOpen?: (row: CutRow) => void
  onShowUpdates?: () => void
  onNew?: (open: boolean) => void
  /** New cut order → Create cut order: its hides are allocated next. */
  onCreateCut?: (workOrderId: string) => void
  onAllocate?: (workOrderId: string | null) => void
  onReserve?: (hideIds: string[], material: { itemId: string; itemColourId: string | null }) => void
  onMaterial?: (material: { itemId: string; itemColourId: string | null }) => void
  onExport?: (ids: string[]) => void
  onTickets?: (workOrderId: string) => void
  onDismissNotice?: () => void
}

/**
 * SCR-238 — Cutting (Production › Cutting room; design production.cutting, workspace-list): the head (as of, live,
 * Print tickets for the cut selected, New cut order `c` as the primary, ⋯ Export / keys), the tiles (waiting to cut and
 * cutting now — each a saved filter —, pieces cut today, hides and m² used today, yield today against the plan), and the
 * shared list frame of the cuts across work orders (W2a: leather by hide; fabric lays are W2b): the cut (its work order,
 * a real link to its record), kind, material and colour, shade lot, state, pieces planned and cut, hides and area, yield
 * against plan, the cutting tables, the last cut; Rows ▾ the saved filters; select-all, shift range, x, Export N while
 * rows are selected; live changes behind "N updates · Show". Never who cut: tables, hides and lots only.
 */
export function CuttingView({ model, actions }: { model: CuttingModel; actions?: CuttingActions }) {
  return (
    <WithMessages namespaces={[CUTTING_NAMESPACE, 'lists']}>
      <Page model={model} actions={actions} />
    </WithMessages>
  )
}

function Page({ model, actions }: { model: CuttingModel; actions?: CuttingActions }) {
  const t = useT(CUTTING_NAMESPACE)
  const lists = useT('lists')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const [help, setHelp] = useState(!!model.helpOpen)
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const items = model.rows.items
  const rowsKey = items?.map((row) => row.workOrder.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  const picked = (items ?? []).filter((row) => selected.includes(row.workOrder.id))

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.newCut || model.alloc || help) return
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
    ...((items?.length ?? 0) > 0 ? [{ id: 'export', label: t('page.export'), onSelect: () => actions?.onExport?.((items ?? []).map((row) => row.workOrder.id)) }] : []),
    { id: 'keys', label: t('page.shortcuts'), onSelect: () => setHelp(true) },
  ]

  return (
    <div className="fw-ct">
      <div className="fw-ct-head">
        <span className="fw-ct-status" role="status">
          {model.asOf ? t('common.updated', { time: formatTime(model.asOf, place) }) : t('common.notYet')}
          {' · '}
          {t(`live.${model.live}`)}
        </span>
        <span className="fw-ct-actions">
          <Button size="sm" heldReason={ticketsWhy} onClick={() => picked[0] && actions?.onTickets?.(picked[0].workOrder.id)}>
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
            const value = tileValue(tile.id, model.tiles, model.yieldToday, locale)
            const view = tile.view
            if (view === null) {
              const hint = tile.id === 'yieldToday' ? t('tile.yieldHint') : tile.id === 'areaToday' ? t('tile.areaHint') : t('tile.todayHint')
              return { label: t(`tile.${tile.id}`), value, hint, ...(tile.id === 'yieldToday' && model.yieldToday ? { accent: varianceTone(model.yieldToday.variancePct) === 'warning' ? 'var(--nds-warning)' : undefined } : {}) }
            }
            return { label: t(`tile.${tile.id}`), value, onClick: () => actions?.onView?.(model.address.view === view ? 'open' : view), active: model.address.view === view }
          })}
        />
      </section>

      <CutsList model={model} actions={actions} selected={selected} onSelected={setSelected} picked={picked} ownKeys={ownKeys} onHelp={() => setHelp(true)} />

      {model.newCut && <NewCutDialog model={model.newCut} can={model.can} actions={actions} />}
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
  picked: readonly CutRow[]
  ownKeys: ListKey[]
  onHelp: () => void
}) {
  const t = useT(CUTTING_NAMESPACE)
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

  const columns = useMemo<ColDef<CutRow>[]>(() => {
    const href = (row: CutRow) => `${model.prefix}/production/cutting/${row.workOrder.id}`
    const CutCell = ({ data }: ICellRendererParams<CutRow>) =>
      data ? (
        <span className="fw-ct-cell">
          {model.can.workOrders ? (
            <Link className="fw-ct-link" href={href(data)}>
              {data.workOrder.number}
            </Link>
          ) : (
            <span>{data.workOrder.number}</span>
          )}
          <span className="fw-ct-sub" title={data.style.name}>
            {data.style.code}
            {data.workOrder.dueDate ? ` · ${t('list.due', { date: formatDate(`${data.workOrder.dueDate}T12:00:00Z`, place) })}` : ''}
          </span>
        </span>
      ) : null
    const MaterialCell = ({ data }: ICellRendererParams<CutRow>) =>
      data ? (
        <span className="fw-ct-cell" title={data.materials.map((material) => material.name).join(', ')}>
          <span className="fw-ct-ellipsis">{materialLine(data)}</span>
          <span className="fw-ct-sub">{data.materials.map((material) => material.name).join(', ')}</span>
        </span>
      ) : null
    const StateCell = ({ data }: ICellRendererParams<CutRow>) =>
      data ? (
        <span className="fw-ct-cell">
          <span>
            <Pill tone={STATE_TONE[data.state]}>{t(`state.${data.state}`)}</Pill>
          </span>
          {data.state === 'HELD' && data.workOrder.holdReason ? (
            <span className="fw-ct-sub" title={data.workOrder.holdReason}>
              {data.workOrder.holdReason}
            </span>
          ) : data.allocated > 0 ? (
            <span className="fw-ct-sub">{t('list.allocated', { count: data.allocated })}</span>
          ) : data.recutsOpen > 0 ? (
            <span className="fw-ct-sub">{t('list.recuts', { count: data.recutsOpen })}</span>
          ) : null}
        </span>
      ) : null
    const PiecesCell = ({ data }: ICellRendererParams<CutRow>) =>
      data ? (
        <span className="fw-ct-cell">
          <span className="fw-ct-num">{t('list.piecesOf', { cut: data.pieces.cut, planned: data.pieces.planned })}</span>
          <span className="fw-ct-sub">{t('list.garments', { cut: data.garments.cut, planned: data.garments.planned })}</span>
        </span>
      ) : null
    const HidesCell = ({ data }: ICellRendererParams<CutRow>) =>
      data ? (
        <span className="fw-ct-cell">
          <span className="fw-ct-num">{data.hides.count === 0 ? '—' : t('list.hides', { count: data.hides.count })}</span>
          <span className="fw-ct-sub">{usedText(data.hides.used, locale)}</span>
        </span>
      ) : null
    const YieldCell = ({ data }: ICellRendererParams<CutRow>) =>
      data ? (
        data.yield.yieldPct === null ? (
          <span className="fw-ct-hint">{data.hides.count === 0 ? '—' : t('list.yieldUnknown')}</span>
        ) : (
          <span className="fw-ct-cell">
            <span>
              <Tag tone={varianceTone(data.yield.variancePct)}>{percent(data.yield.yieldPct, locale)}</Tag>
            </span>
            <span className="fw-ct-sub">{data.yield.plannedPct === null ? t('list.noPlan') : t('list.plan', { pct: percent(data.yield.plannedPct, locale) })}</span>
          </span>
        )
      ) : null
    const WhenCell = ({ data }: ICellRendererParams<CutRow>) =>
      data ? (
        data.lastCutAt ? (
          <span className="fw-ct-cell">
            <span className="fw-ct-num">{formatDate(data.lastCutAt, place)}</span>
            <span className="fw-ct-sub">{formatTime(data.lastCutAt, place)}</span>
          </span>
        ) : (
          <span className="fw-ct-hint">—</span>
        )
      ) : null
    const MoreCell = ({ data }: ICellRendererParams<CutRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { number: data.workOrder.number }) }}
          items={[
            ...(model.can.workOrders
              ? [
                  { id: 'open', label: t('common.open'), href: href(data) },
                  { id: 'tab', label: t('common.openNewTab'), href: href(data), target: '_blank' as const },
                  { id: 'tickets', label: t('tab.tickets'), href: `${href(data)}?tab=tickets` },
                  { id: 'workOrder', label: t('list.workOrder'), href: `${model.prefix}/production/work-orders/${data.workOrder.id}?tab=cutting` },
                ]
              : []),
            { id: 'alloc', label: t('alloc.open'), onSelect: () => actions?.onAllocate?.(data.workOrder.id) },
          ]}
        />
      ) : null
    return [
      { colId: 'cut', headerName: t('col.cut'), minWidth: 135, flex: 1, cellRenderer: CutCell, valueGetter: (params) => params.data?.workOrder.number ?? '' },
      { colId: 'kind', headerName: t('col.kind'), minWidth: 70, flex: 0.4, valueGetter: (params) => (params.data ? t(`kind.${params.data.kind}`) : '') },
      { colId: 'material', headerName: t('col.material'), minWidth: 150, flex: 1.2, cellRenderer: MaterialCell },
      { colId: 'lot', headerName: t('col.lot'), minWidth: 120, flex: 0.9, valueGetter: (params) => (params.data ? lotLine(params.data) : '') },
      { colId: 'state', headerName: t('col.state'), minWidth: 120, flex: 0.9, cellRenderer: StateCell },
      { colId: 'pieces', headerName: t('col.pieces'), minWidth: 110, flex: 0.7, cellRenderer: PiecesCell },
      { colId: 'hides', headerName: t('col.hides'), minWidth: 95, flex: 0.6, cellRenderer: HidesCell },
      { colId: 'yield', headerName: t('col.yield'), minWidth: 100, flex: 0.7, cellRenderer: YieldCell },
      { colId: 'table', headerName: t('col.table'), minWidth: 75, flex: 0.5, valueGetter: (params) => params.data?.stations.map((station) => station.code).join(', ') || '—' },
      { colId: 'date', headerName: t('col.date'), minWidth: 110, flex: 0.7, cellRenderer: WhenCell },
      { colId: 'more', headerName: t('col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, model.prefix, model.can.workOrders, model.timeZone, actions])

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
      <ListFrame<CutRow>
        label={t('list.tableLabel')}
        rows={state ? [] : items}
        rowId={(row) => row.workOrder.id}
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
              <Button size="sm" heldReason={say(t, ticketsHeld(picked.length, model.can))} onClick={() => picked[0] && actions?.onTickets?.(picked[0].workOrder.id)}>
                <Printer size={13} aria-hidden /> <SelectionLabel>{t('page.tickets')}</SelectionLabel>
              </Button>
              <Button size="sm" aria-label={t('bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.workOrder.id))}>
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
