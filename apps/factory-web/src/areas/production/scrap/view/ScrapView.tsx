'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { BarChart3, Check, Download, MoreHorizontal, Search, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, MetricStrip, PerformanceGraph } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, SegmentedControl, Select, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { LiveState } from '../../_shared/hooks'
import type { Replacement } from '../../cutting/api'
import type { ScrapKind, ScrapRow, ScrapTiles } from '../api'
import {
  approvable,
  DIMENSIONS,
  filterRows,
  KIND_TONE,
  materialsText,
  moneyText,
  pareto,
  PERIODS,
  reasonWord,
  REPLACEMENT_TONE,
  SCRAP_NAMESPACE,
  SCRAP_VIEWS,
  TILES,
  tileValue,
  type Dimension,
  type Period,
  type Phrase,
  type ScrapAddress,
  type ScrapCan,
  type ScrapView as SavedView,
} from '../model'
import { ReplaceDialog, ScrapItemDialog, say, type ReplaceDraftModel } from './ScrapDialogs'
import '../scrap.css'

export interface ScrapModel {
  readonly prefix: string
  readonly can: ScrapCan
  /** The signed-in person (a lower quantity is never decided by the one who asked). */
  readonly me: string
  readonly address: ScrapAddress
  readonly timeZone: string
  /** The start of today in the site's zone (the "today" view). */
  readonly todayStart: number
  readonly rows: { readonly items: readonly ScrapRow[] | null; readonly problem: string | null }
  readonly tiles: ScrapTiles | null
  /** The open lower-quantity requests (their version and who asked). */
  readonly reductions: readonly Replacement[]
  readonly asOf: string | null
  readonly live: LiveState
  readonly updates: number
  readonly slow: boolean
  /** Rows shown (pages of 50 over the rows read). */
  readonly shown: number
  readonly chartOpen: boolean
  readonly busy: boolean
  /** A refused decision or replacement, in words (shown in its dialog). */
  readonly problem: Phrase | null
  readonly notice: { readonly tone: 'success' | 'danger' | 'info'; readonly words: Phrase } | null
  readonly replace: ReplaceDraftModel | null
  /** Design cases. */
  readonly selected?: readonly string[]
  readonly focusRow?: number
  readonly helpOpen?: boolean
  readonly refusing?: boolean
}

export interface ScrapActions {
  onAddress?: (next: Partial<ScrapAddress>) => void
  onMore?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onChart?: (open: boolean) => void
  onApprove?: (reductions: readonly Replacement[]) => void
  onRefuse?: (reduction: Replacement, note: string) => void
  onReplace?: (rowId: string | null) => void
  onReplaceDraft?: (draft: ReplaceDraftModel['draft']) => void
  onAsk?: () => void
  onExport?: (ids: string[]) => void
  onDismissNotice?: () => void
}

/**
 * SCR-140 — Scrap & rework (Production › Floor control; design production.scrap, workspace-list): the head (as of,
 * live, Pareto by reason, Approve N as the selection-aware primary, ⋯ Export / keys), the tiles (scrap today in pieces,
 * rework open, lower quantities waiting for approval, recuts to cut — each a saved filter; downgraded to second quality
 * is W2b), By reason (the pareto of scrap and rework by reason, operation or style: bars and the cumulative line; a bar
 * filters the list), and the shared list frame of every scrap and rework row with its reason and what replaces it:
 * date, work order, bundle, operation, size, part, pieces, kind, reason, lot / hide and area, replacement, approval,
 * station, value (cost grain only). A row opens its detail (`?open=`; A approve, R refuse, J / K next); Replace scrapped
 * quantity asks a recut or a lower order quantity. Never a person: work orders, bundles, operations and stations.
 */
export function ScrapView({ model, actions }: { model: ScrapModel; actions?: ScrapActions }) {
  return (
    <WithMessages namespaces={[SCRAP_NAMESPACE, 'lists']}>
      <Page model={model} actions={actions} />
    </WithMessages>
  )
}

function Page({ model, actions }: { model: ScrapModel; actions?: ScrapActions }) {
  const t = useT(SCRAP_NAMESPACE)
  const lists = useT('lists')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const [help, setHelp] = useState(!!model.helpOpen)
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const all = model.rows.items
  const filtered = useMemo(() => (all ? filterRows(all, model.address, model.todayStart, locale) : null), [all, model.address, model.todayStart, locale])
  const forChart = useMemo(() => (all ? filterRows(all, model.address, model.todayStart, locale, { withGroup: false }) : []), [all, model.address, model.todayStart, locale])
  const shown = filtered?.slice(0, model.shown) ?? null
  const shownKey = shown?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => shownKey.includes(id))), [shownKey])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  const picked = (shown ?? []).filter((row) => selected.includes(row.id))
  const reach = approvable(picked, model.reductions, model.can, model.me)
  const approveHeld = !model.can.approve ? t('held.permission', { permission: 'production.scrap.approve' }) : model.busy ? t('held.busy') : reach.length === 0 ? t(picked.length === 0 ? 'held.approve.none' : 'held.approve.nothing') : null

  if (!model.can.view) {
    return (
      <div className="fw-sc">
        <Card padded>
          <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('page.noAccess.title')} description={t('page.noAccess.body', { permission: 'production.scrap.view' })} />
        </Card>
      </div>
    )
  }

  const ownKeys: ListKey[] = []
  const open = model.address.open ? (all ?? []).find((row) => row.id === model.address.open) ?? null : null
  const more = [
    ...((filtered?.length ?? 0) > 0 ? [{ id: 'export', label: t('page.export'), onSelect: () => actions?.onExport?.((filtered ?? []).map((row) => row.id)) }] : []),
    { id: 'keys', label: t('page.shortcuts'), onSelect: () => setHelp(true) },
  ]

  return (
    <div className="fw-sc">
      <div className="fw-sc-head">
        <span className="fw-sc-status" role="status">
          {model.asOf ? t('common.updated', { time: formatTime(model.asOf, place) }) : t('common.notYet')}
          {' · '}
          {t(`live.${model.live}`)}
        </span>
        <span className="fw-sc-actions">
          <Button size="sm" aria-pressed={model.chartOpen} onClick={() => actions?.onChart?.(!model.chartOpen)}>
            <BarChart3 size={14} aria-hidden /> {t('page.pareto')}
          </Button>
          <Button size="sm" variant="primary" heldReason={approveHeld} onClick={() => actions?.onApprove?.(reach)}>
            <Check size={14} aria-hidden /> {reach.length > 0 ? t('page.approveN', { count: reach.length }) : t('page.approve')}
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
            const value = tileValue(tile.id, model.tiles)
            const view = tile.view
            if (view === null) return { label: t(`tile.${tile.id}`), value, hint: t('tile.downgradedLater') }
            return { label: t(`tile.${tile.id}`), value, onClick: () => actions?.onAddress?.({ view: model.address.view === view ? 'all' : view, group: null }), active: model.address.view === view, ...(tile.id === 'toApprove' && model.tiles && model.tiles.reductionsToApprove > 0 ? { accent: 'var(--nds-warning)' } : {}) }
          })}
        />
      </section>

      {model.chartOpen && <ParetoCard model={model} actions={actions} rows={forChart} />}

      <ScrapList model={model} actions={actions} filtered={filtered} shown={shown} selected={selected} onSelected={setSelected} picked={picked} reach={reach} ownKeys={ownKeys} onHelp={() => setHelp(true)} />

      {open && <ScrapItemDialog model={model} row={open} ids={(filtered ?? []).map((row) => row.id)} actions={actions} />}
      {model.replace && <ReplaceDialog model={model} actions={actions} />}
      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('common.shortcuts')} size="sm">
          <ul className="fw-sc-list">
            {listKeys(ownKeys, true).map((entry) => (
              <li key={entry.does}>
                <span>
                  <b>{entry.keys.join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
                </span>
              </li>
            ))}
            <li>
              <span>
                <b>A R J K</b> — {t('page.detailKeys')}
              </span>
            </li>
          </ul>
        </Modal>
      )}
    </div>
  )
}

function ParetoCard({ model, actions, rows }: { model: ScrapModel; actions?: ScrapActions; rows: readonly ScrapRow[] }) {
  const t = useT(SCRAP_NAMESPACE)
  const locale = useLocale()
  const bars = pareto(rows, model.address.by, locale)
  const label = (key: string, text: string) => (key === '' ? t('pareto.other') : text)
  return (
    <Card padded className="fw-sc-card">
      <div className="fw-sc-card-head">
        <h2 className="fw-sc-h2">{t('pareto.title')}</h2>
        <SegmentedControl
          size="sm"
          ariaLabel={t('pareto.dimension')}
          value={model.address.by}
          onChange={(value) => actions?.onAddress?.({ by: value as Dimension, group: null })}
          options={DIMENSIONS.map((dimension) => ({ value: dimension, label: t(`pareto.by.${dimension}`) }))}
        />
      </div>
      {bars.length === 0 ? (
        <p className="fw-sc-hint">{t('pareto.none')}</p>
      ) : (
        <div className="fw-sc-pareto">
          <PerformanceGraph
            data={bars.map((bar) => ({ group: label(bar.key, bar.label), pieces: bar.pieces, cumulative: bar.cumulative }))}
            xKey="group"
            left={{ key: 'pieces', label: t('pareto.pieces'), color: 'var(--nds-danger)', axis: 'left', shape: 'bar', axisLabel: t('pareto.pieces') }}
            right={{ key: 'cumulative', label: t('pareto.cumulative'), color: 'var(--nds-info)', axis: 'right', domain: [0, 100], format: (value) => `${value} %`, axisLabel: t('pareto.cumulative') }}
            height={220}
          />
          <ul className="fw-sc-bars" aria-label={t('pareto.filter')}>
            {bars.map((bar) => (
              <li key={bar.key || 'other'}>
                <Button size="sm" variant={model.address.group === bar.key ? 'primary' : 'quiet'} aria-pressed={model.address.group === bar.key} heldReason={bar.key === '' ? t('pareto.otherHeld') : null} onClick={() => actions?.onAddress?.({ group: model.address.group === bar.key ? null : bar.key })}>
                  <span className="fw-sc-bar-label">{label(bar.key, bar.label)}</span>
                  <span className="fw-sc-num">{t('pareto.barValue', { pieces: bar.pieces, cumulative: bar.cumulative })}</span>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="fw-sc-hint">{t('pareto.hint')}</p>
    </Card>
  )
}

function ScrapList({
  model,
  actions,
  filtered,
  shown,
  selected,
  onSelected,
  picked,
  reach,
  ownKeys,
  onHelp,
}: {
  model: ScrapModel
  actions?: ScrapActions
  filtered: readonly ScrapRow[] | null
  shown: readonly ScrapRow[] | null
  selected: readonly string[]
  onSelected: (ids: string[]) => void
  picked: readonly ScrapRow[]
  reach: readonly Replacement[]
  ownKeys: ListKey[]
  onHelp: () => void
}) {
  const t = useT(SCRAP_NAMESPACE)
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const [query, setQuery] = useState(model.address.q)
  useEffect(() => setQuery(model.address.q), [model.address.q])
  const typed = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onAddress?.({ q: query }), 300)
    return () => clearTimeout(timer)
  }, [query])

  const columns = useMemo<ColDef<ScrapRow>[]>(() => {
    const WhenCell = ({ data }: ICellRendererParams<ScrapRow>) =>
      data ? (
        <span className="fw-sc-cell">
          <span className="fw-sc-num">{formatDate(data.at, place)}</span>
          <span className="fw-sc-sub">{formatTime(data.at, place)}</span>
        </span>
      ) : null
    const BundleCell = ({ data }: ICellRendererParams<ScrapRow>) =>
      data ? (
        <span className="fw-sc-cell">
          <span className="fw-sc-ellipsis">{data.bundle?.code ?? '—'}</span>
          <span className="fw-sc-sub">{t('list.sizePart', { size: `${data.cell.colourwayCode} ${data.cell.size}`, part: data.part ?? t('list.whole') })}</span>
        </span>
      ) : null
    const WorkOrderCell = ({ data }: ICellRendererParams<ScrapRow>) =>
      data ? (
        <span className="fw-sc-cell">
          {model.can.workOrders ? (
            <Link className="fw-sc-link" href={`${model.prefix}/production/work-orders/${data.workOrder.id}`}>
              {data.workOrder.number}
            </Link>
          ) : (
            <span>{data.workOrder.number}</span>
          )}
          <span className="fw-sc-sub">{data.workOrder.style?.code ?? ''}</span>
        </span>
      ) : null
    const KindCell = ({ data }: ICellRendererParams<ScrapRow>) =>
      data ? (
        <span className="fw-sc-cell">
          <span>
            <Pill tone={KIND_TONE[data.kind]}>{t(`kind.${data.kind}`)}</Pill>
          </span>
          {data.kind === 'REWORK' && data.status && <span className="fw-sc-sub">{t(`rework.${data.status}`)}</span>}
        </span>
      ) : null
    const ReasonCell = ({ data }: ICellRendererParams<ScrapRow>) => (data ? <span className="fw-sc-ellipsis" title={data.reasonCode}>{reasonWord(data, locale)}</span> : null)
    const ReplacementCell = ({ data }: ICellRendererParams<ScrapRow>) =>
      data ? (
        data.replacements.length === 0 ? (
          <span className="fw-sc-hint">—</span>
        ) : (
          <span className="fw-sc-inline">
            {data.replacements.map((replacement) => (
              <Tag key={replacement.id} tone={REPLACEMENT_TONE[replacement.status] ?? 'neutral'}>
                {t('replacement.chip', { kind: t(`replacement.kind.${replacement.kind}`), quantity: replacement.quantity, status: t(`replacement.status.${replacement.status}`) })}
              </Tag>
            ))}
          </span>
        )
      ) : null
    const ApprovalCell = ({ data }: ICellRendererParams<ScrapRow>) => {
      if (!data) return null
      const reduce = data.replacements.find((replacement) => replacement.kind === 'REDUCE')
      return reduce ? <Pill tone={REPLACEMENT_TONE[reduce.status] ?? 'neutral'}>{t(`approval.${reduce.status}`)}</Pill> : <span className="fw-sc-hint">—</span>
    }
    const MoreCell = ({ data }: ICellRendererParams<ScrapRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { number: data.workOrder.number }) }}
          items={[
            { id: 'open', label: t('common.open'), onSelect: () => actions?.onAddress?.({ open: data.id }) },
            ...(data.kind === 'SCRAP' ? [{ id: 'replace', label: t('replace.open'), onSelect: () => actions?.onReplace?.(data.id) }] : []),
            ...(model.can.workOrders ? [{ id: 'workOrder', label: t('list.workOrder'), href: `${model.prefix}/production/work-orders/${data.workOrder.id}` }] : []),
          ]}
        />
      ) : null
    return [
      { colId: 'at', headerName: t('col.date'), minWidth: 110, flex: 0.6, cellRenderer: WhenCell, valueGetter: (params) => params.data?.at ?? '' },
      { colId: 'workOrder', headerName: t('col.workOrder'), minWidth: 120, flex: 0.8, cellRenderer: WorkOrderCell, valueGetter: (params) => params.data?.workOrder.number ?? '' },
      { colId: 'bundle', headerName: t('col.bundle'), minWidth: 125, flex: 0.9, cellRenderer: BundleCell, valueGetter: (params) => params.data?.bundle?.code ?? '' },
      { colId: 'operation', headerName: t('col.operation'), minWidth: 115, flex: 0.9, valueGetter: (params) => (params.data?.operation ? `${params.data.operation.seq} · ${params.data.operation.name}` : '—') },
      { colId: 'pieces', headerName: t('col.pieces'), minWidth: 72, flex: 0.35, type: 'rightAligned', valueGetter: (params) => params.data?.pieces ?? 0 },
      { colId: 'kind', headerName: t('col.kind'), minWidth: 100, flex: 0.6, cellRenderer: KindCell },
      { colId: 'reason', headerName: t('col.reason'), minWidth: 115, flex: 0.9, cellRenderer: ReasonCell },
      { colId: 'lot', headerName: t('col.lot'), minWidth: 140, flex: 1.2, valueGetter: (params) => (params.data ? materialsText(params.data, locale) : '') },
      { colId: 'replacement', headerName: t('col.replacement'), minWidth: 135, flex: 1.1, cellRenderer: ReplacementCell },
      { colId: 'approval', headerName: t('col.approval'), minWidth: 90, flex: 0.55, cellRenderer: ApprovalCell },
      { colId: 'station', headerName: t('col.station'), minWidth: 75, flex: 0.45, valueGetter: (params) => params.data?.station?.code ?? '—' },
      ...(model.can.cost ? [{ colId: 'value', headerName: t('col.value'), minWidth: 100, flex: 0.7, type: 'rightAligned', valueGetter: (params) => (params.data ? moneyText(params.data.value, params.data.currency, locale) : '') } satisfies ColDef<ScrapRow>] : []),
      { colId: 'more', headerName: t('col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, model.prefix, model.can.workOrders, model.can.cost, model.timeZone, actions])

  const items = model.rows.items
  const narrowed = model.address.q.trim() !== '' || model.address.view !== 'all' || model.address.kind !== null || model.address.group !== null
  const state = model.rows.problem ? (
    <EmptyState title={t('list.failed')} description={t(model.rows.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : filtered && filtered.length === 0 ? (
    narrowed ? (
      <EmptyState
        title={t('list.noMatch.title')}
        description={t('list.noMatch.body')}
        action={
          <Button
            size="sm"
            onClick={() => {
              setQuery('')
              actions?.onAddress?.({ q: '', view: 'all', kind: null, group: null })
            }}
          >
            {t('common.clearFilters')}
          </Button>
        }
      />
    ) : (
      <EmptyState title={t('list.empty.title')} description={t('list.empty.body')} />
    )
  ) : undefined

  return (
    <>
      <ListFrame<ScrapRow>
        label={t('list.tableLabel')}
        rows={state ? [] : shown}
        rowId={(row) => row.id}
        columns={columns}
        count={filtered ? t('common.countOf', { count: shown?.length ?? 0, total: filtered.length }) : '—'}
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
          <span className="fw-sc-inline">
            <Select size="sm" aria-label={t('list.viewLabel')} value={model.address.view} onChange={(event) => actions?.onAddress?.({ view: event.target.value as SavedView, group: null })}>
              {SCRAP_VIEWS.map((view) => (
                <option key={view} value={view}>
                  {t(`view.${view}`)}
                </option>
              ))}
            </Select>
            <Select size="sm" aria-label={t('list.kindLabel')} value={model.address.kind ?? ''} onChange={(event) => actions?.onAddress?.({ kind: (event.target.value || null) as ScrapKind | null })}>
              <option value="">{t('list.kindAll')}</option>
              <option value="SCRAP">{t('kind.SCRAP')}</option>
              <option value="REWORK">{t('kind.REWORK')}</option>
            </Select>
            <Select size="sm" aria-label={t('list.periodLabel')} value={model.address.period} onChange={(event) => actions?.onAddress?.({ period: event.target.value as Period })}>
              {PERIODS.map((period) => (
                <option key={period} value={period}>
                  {t(`period.${period}`)}
                </option>
              ))}
            </Select>
          </span>
        }
        selection={{
          selected,
          onChange: onSelected,
          actions: (
            <>
              <Button size="sm" variant="primary" heldReason={!model.can.approve ? t('held.permission', { permission: 'production.scrap.approve' }) : reach.length === 0 ? t('held.approve.nothing') : model.busy ? t('held.busy') : null} onClick={() => actions?.onApprove?.(reach)}>
                <Check size={13} aria-hidden /> <SelectionLabel>{t('page.approveN', { count: reach.length })}</SelectionLabel>
              </Button>
              <Button size="sm" aria-label={t('bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count: picked.length })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={filtered && shown && filtered.length > shown.length ? { label: t('common.more'), onMore: () => actions?.onMore?.() } : null}
        keys={ownKeys}
        onHelp={onHelp}
        onOpen={(row) => actions?.onAddress?.({ open: row.id })}
        state={state}
        focusRow={model.focusRow}
      />
      {model.slow && items === null && !model.rows.problem && (
        <p className="fw-sc-hint" role="status">
          {t('list.loadingSlow')}
        </p>
      )}
      <p className="fw-sc-hint">{t('list.hint', { period: t(`period.${model.address.period}`) })}</p>
    </>
  )
}
