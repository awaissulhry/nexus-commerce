'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { BarChart3, Check, CheckCheck, MoreHorizontal, Search, Settings2, ShieldOff, Users } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, MetricStrip, Modal, PerformanceGraph, SummaryTable } from '@nexus/ui/components'
import { BarList } from '@nexus/ui/charts/bar-list/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Kbd, SegmentedControl, Select, Skeleton, SWATCHES } from '@nexus/ui/primitives'
import { chart } from '@nexus/ui/tokens'
import { CALL_KINDS, CALL_VIEWS, type CallKind, type CallView } from '@nexus/factory-domain/production/calls/rules'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { LiveState } from '../../_shared/hooks'
import type { Call, CallCounts, CallRecordAnswer, CallsByHour, CallTypes, StationMachine } from '../api'
import {
  ackTargets,
  CALLS_NAMESPACES,
  CHART_BY,
  chartParts,
  chartRows,
  durationPhrase,
  personPhrase,
  responseRows,
  routingRows,
  rowHeld,
  searchRows,
  solveTargets,
  TILES,
  tileAddress,
  tileValue,
  totalCalls,
  typeLabel,
  type CallsAddress,
  type CallsCan,
  type ChartBy,
  type JobDraft,
  type Phrase,
  type SolveDraft,
} from '../model'
import { CallDetail } from './CallDetail'
import { CallDialogs } from './CallDialogs'
import { Duration, kindColour, OpenFor, say, StatusPill, TypeCell, useCallsT, WaitingTag } from './parts'
import '../calls.css'

export type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

/** A dialog over the page: Solve N (one code for each), Cancel one call, Open a maintenance job, the keys. */
export type CallDialog =
  | { kind: 'solve'; ids: readonly string[]; draft: SolveDraft; problem: Phrase | null }
  | { kind: 'cancel'; id: string; reason: string; problem: Phrase | null }
  | { kind: 'job'; id: string; machines: Loaded<readonly StationMachine[]>; draft: JobDraft; problem: Phrase | null }
  | { kind: 'keys' }

export interface CallsModel {
  prefix: string
  can: CallsCan
  address: CallsAddress
  timeZone: string
  rows: { items: readonly Call[] | null; problem: string | null }
  /** More calls behind "Show more" (the API's cursor). */
  hasMore: boolean
  loadingMore: boolean
  counts: CallCounts | null
  /** The site the chart and "Who is called" show (one site: the top bar's, else the first of the person's). */
  site: { id: string; name: string } | null
  day: Loaded<CallsByHour> | null
  types: Loaded<CallTypes> | null
  asOf: string | null
  live: LiveState
  /** The polite announcement of a call just raised ("New help call: Machine"). */
  announcement: string | null
  chartOpen: boolean
  chartBy: ChartBy
  busy: boolean
  notice: { tone: 'success' | 'danger' | 'info'; words: Phrase; link?: { href: string; words: Phrase } } | null
  /** The call open in its DetailModal (`?open=`). */
  detail: { id: string; loaded: Loaded<CallRecordAnswer> | { status: 'notFound' } } | null
  dialog: CallDialog | null
  /** The moment the elapsed times count from (design cases); live: the clock. */
  now?: number
  /** Design cases: rows selected, the focused row. */
  selected?: readonly string[]
  focusRow?: number
}

export interface CallsActions {
  onAddress?: (next: Partial<CallsAddress>) => void
  onMore?: () => void
  onRetry?: () => void
  onChart?: (open: boolean) => void
  onChartBy?: (by: ChartBy) => void
  onAcknowledge?: (ids: readonly string[]) => void
  onComing?: (id: string) => void
  onDialog?: (dialog: CallDialog | null) => void
  onSolveOpen?: (ids: readonly string[]) => void
  onJobOpen?: (id: string) => void
  onSolve?: () => void
  onCancel?: () => void
  onJob?: () => void
  onRetryDetail?: () => void
  onDismissNotice?: () => void
}

/**
 * SCR-142 — Help calls (Production › Floor control; design production.calls, inbox): the head (as of, live, Calls by
 * hour, Acknowledge as the selection-aware primary, ⋯ "Edit who is called" in Floor rules & codes), the tiles (open
 * calls, waiting over 5 minutes, answered today — each a saved filter of the API — and today's median response time),
 * Calls by hour (stacked bars by kind or line, the calls so far today as a line; the response times by kind beside it),
 * Who is called (type · group · members count, read here), and ONE list frame of the calls: type (icon + word), line,
 * station, work order / bundle, opened (open for … while open), team called, status, acknowledged by, response time,
 * resolve time; "Waiting time not counted" on the row (MES-148). A row opens the call's DetailModal (`?open=`; A
 * acknowledge, D done, J / K). Response times per call, kind and line only: never a person's (Owner F2).
 */
export function CallsView({ model, actions }: { model: CallsModel; actions?: CallsActions }) {
  return (
    <WithMessages namespaces={CALLS_NAMESPACES}>
      <Page model={model} actions={actions} />
    </WithMessages>
  )
}

function Page({ model, actions }: { model: CallsModel; actions?: CallsActions }) {
  const t = useCallsT()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  const all = model.rows.items
  const filtered = useMemo(() => (all ? searchRows(all, model.address.q, locale) : null), [all, model.address.q, locale])
  const shownKey = filtered?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => shownKey.includes(id))), [shownKey])
  const picked = (filtered ?? []).filter((row) => selected.includes(row.id))
  const acks = ackTargets(picked)
  const solves = solveTargets(picked)
  const ackHeld = !model.can.answer ? t('held.noAnswer') : model.busy ? t('held.busy') : acks.length === 0 ? t(picked.length === 0 ? 'held.ackNone' : 'held.ackNothing') : null

  if (!model.can.view) {
    return (
      <div className="fw-cl">
        <Card padded>
          <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('page.noAccess.title')} description={t('page.noAccess.body')} />
        </Card>
      </div>
    )
  }

  const settingsHref = `${model.prefix}/production/settings?tab=calls${model.site ? `&site=${encodeURIComponent(model.site.id)}` : ''}`
  const more = [
    model.can.settings
      ? { id: 'routing', label: t('page.editRouting'), href: settingsHref }
      : { id: 'routing', label: t('page.editRouting'), disabled: true, description: t('held.noSettings') },
  ]

  return (
    <div className="fw-cl">
      <div className="fw-cl-head">
        <span className="fw-cl-status" role="status">
          {model.asOf ? t('common.updated', { time: formatTime(model.asOf, place) }) : t('common.notYet')}
          {' · '}
          {t(`live.${model.live}`)}
        </span>
        <span className="fw-cl-actions">
          <Button size="sm" aria-pressed={model.chartOpen} onClick={() => actions?.onChart?.(!model.chartOpen)}>
            <BarChart3 size={14} aria-hidden /> {t('page.chart')}
          </Button>
          <Button size="sm" variant="primary" heldReason={ackHeld} onClick={() => actions?.onAcknowledge?.(acks.map((row) => row.id))}>
            <Check size={14} aria-hidden /> {acks.length > 0 ? t('page.ackN', { count: acks.length }) : t('page.ack')}
          </Button>
          <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('page.more') }} items={more} />
        </span>
      </div>
      <p className="fw-cl-visually-hidden" aria-live="polite">
        {model.announcement ?? ''}
      </p>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={say(t, model.notice.words)}
          action={
            <span className="fw-cl-inline">
              {model.notice.link && (
                <Link className="fw-cl-link" href={model.notice.link.href}>
                  {say(t, model.notice.link.words)}
                </Link>
              )}
              <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
                {t('common.dismiss')}
              </Button>
            </span>
          }
        />
      )}

      <section aria-label={t('tiles.label')}>
        <MetricStrip
          metrics={TILES.map((tile) => {
            const value = tileValue(tile.id, model.counts)
            if (tile.tile === null) return { label: t('tile.MEDIAN'), value: value === null ? '—' : say(t, durationPhrase(value)), hint: t('tile.medianHint') }
            const named = tile.tile
            return {
              label: tile.id === 'WAITING' ? t('tile.WAITING', { minutes: model.counts?.waitingMinutes ?? 5 }) : t(`tile.${tile.id}`),
              value: value ?? '—',
              onClick: () => actions?.onAddress?.({ ...tileAddress(model.address, named), open: null }),
              active: model.address.tile === named,
              ...(tile.id === 'WAITING' && (model.counts?.tiles.WAITING ?? 0) > 0 ? { accent: 'var(--nds-danger)' } : tile.id === 'OPEN' && (model.counts?.tiles.OPEN ?? 0) > 0 ? { accent: 'var(--nds-warning)' } : {}),
            }
          })}
        />
      </section>

      <div className={model.chartOpen ? 'fw-cl-grid' : 'fw-cl-grid solo'}>
        {model.chartOpen && <ChartCard model={model} actions={actions} />}
        <RoutingCard model={model} settingsHref={settingsHref} />
      </div>

      <CallsList model={model} actions={actions} filtered={filtered} selected={selected} onSelected={setSelected} acks={acks} solves={solves} />

      {model.detail && <CallDetail model={model} actions={actions} ids={(filtered ?? []).map((row) => row.id)} />}
      <CallDialogs model={model} actions={actions} />
    </div>
  )
}

// ---- Calls by hour ---------------------------------------------------------------------------------------------------------

/** The lines' colours on the chart: DS swatches, in this order. */
const LINE_SWATCHES = ['Blue', 'Teal', 'Amber', 'Purple', 'Green', 'Rose', 'Indigo', 'Stone'].map((name) => SWATCHES.find((swatch) => swatch.name === name)?.hex ?? chart.reference)

function ChartCard({ model, actions }: { model: CallsModel; actions?: CallsActions }) {
  const t = useCallsT()
  const day = model.day
  let body: ReactNode
  if (!model.site) body = <p className="fw-cl-hint">{t('chart.noSite')}</p>
  else if (!day || day.status === 'loading') body = <Skeleton height={220} />
  else if (day.status === 'error')
    body = (
      <Banner tone="danger" title={t(day.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
    )
  else if (totalCalls(day.value) === 0) body = <EmptyState icon={<BarChart3 size={22} aria-hidden />} title={t('chart.none.title')} description={t('chart.none.body')} />
  else {
    const parts = chartParts(day.value, model.chartBy)
    const stack = parts.map((part, index) => ({
      key: part.key,
      label: part.kind ? t(`kind.${part.kind}`) : part.line ? part.line.code : t('chart.noLine'),
      color: part.kind ? kindColour(part.kind) : LINE_SWATCHES[index % LINE_SWATCHES.length]!,
    }))
    const responses = responseRows(day.value)
    body = (
      <div className="fw-cl-chart">
        <figure className="fw-cl-figure" aria-label={t('chart.label', { site: model.site.name })}>
          <PerformanceGraph
            data={chartRows(day.value, model.chartBy)}
            xKey="hour"
            left={{ key: 'calls', label: t('chart.calls'), axisLabel: t('chart.calls'), color: chart.axis, axis: 'left', shape: 'bar', stack }}
            right={{ key: 'sofar', label: t('chart.sofar'), axisLabel: t('chart.sofar'), color: chart.actual, axis: 'right' }}
            height={230}
          />
          <figcaption className="fw-cl-hint">{t('chart.caption', { count: totalCalls(day.value) })}</figcaption>
        </figure>
        <section className="fw-cl-responses" aria-label={t('chart.responses')}>
          <h3 className="fw-cl-h3">{t('chart.responses')}</h3>
          <BarList
            label={t('chart.responses')}
            format={(value) => say(t, durationPhrase(value))}
            items={responses.map((row) => ({
              id: row.kind,
              label: t(`kind.${row.kind}`),
              sub: t('chart.answeredOf', { answered: row.answered, calls: row.calls }),
              value: row.median,
              valueText: row.median === null ? t('chart.noAnswer') : say(t, durationPhrase(row.median)),
              tone: row.median !== null && row.median >= (model.counts?.waitingMinutes ?? 5) * 60 ? 'warning' : 'neutral',
            }))}
          />
          <p className="fw-cl-hint">{t('chart.responsesHint')}</p>
        </section>
      </div>
    )
  }
  return (
    <Card padded className="fw-cl-card">
      <div className="fw-cl-card-head">
        <h2 className="fw-cl-h2">{model.site ? t('chart.title', { site: model.site.name }) : t('chart.titleNoSite')}</h2>
        <SegmentedControl size="sm" ariaLabel={t('chart.byLabel')} value={model.chartBy} onChange={(value) => actions?.onChartBy?.(value as ChartBy)} options={CHART_BY.map((by) => ({ value: by, label: t(`chart.by.${by}`) }))} />
      </div>
      {body}
    </Card>
  )
}

// ---- Who is called ---------------------------------------------------------------------------------------------------------

function RoutingCard({ model, settingsHref }: { model: CallsModel; settingsHref: string }) {
  const t = useCallsT()
  const types = model.types
  let body: ReactNode
  if (!model.site) body = <p className="fw-cl-hint">{t('routing.noSite')}</p>
  else if (!types || types.status === 'loading') body = <Skeleton height={160} />
  else if (types.status === 'error') body = <p className="fw-cl-hint">{t(types.problem)}</p>
  else {
    const rows = routingRows(types.value.types)
    body =
      rows.length === 0 ? (
        <EmptyState icon={<Users size={22} aria-hidden />} title={t('routing.none.title')} description={t('routing.none.body')} />
      ) : (
        <SummaryTable
          label={t('routing.title')}
          columns={[t('routing.col.type'), t('routing.col.group'), t('routing.col.members')]}
          align={[undefined, undefined, 'right']}
          stackOnPhone
          rows={rows.map((type) => ({
            id: type.id,
            cells: [
              <TypeCell key="type" type={type} withKind={false} />,
              <span key="group" className="fw-cl-cell">
                <span>{type.responder.team ? type.responder.team.name : t('routing.leaders')}</span>
                {type.responder.team && !type.responder.team.active && <span className="fw-cl-sub">{t('routing.archived')}</span>}
                {type.escalateAfterMinutes !== null && <span className="fw-cl-sub">{t('routing.escalate', { minutes: type.escalateAfterMinutes })}</span>}
              </span>,
              <span key="members" className="fw-cl-num">
                {t('routing.members', { count: type.responder.members })}
              </span>,
            ],
          }))}
        />
      )
  }
  return (
    <Card padded className="fw-cl-card">
      <div className="fw-cl-card-head">
        <h2 className="fw-cl-h2">{t('routing.title')}</h2>
        {model.can.settings ? (
          <Link className="fw-cl-link" href={settingsHref}>
            <Settings2 size={13} aria-hidden /> {t('page.editRouting')}
          </Link>
        ) : null}
      </div>
      {body}
      <p className="fw-cl-hint">{t('routing.hint')}</p>
    </Card>
  )
}

// ---- the calls -------------------------------------------------------------------------------------------------------------

function CallsList({
  model,
  actions,
  filtered,
  selected,
  onSelected,
  acks,
  solves,
}: {
  model: CallsModel
  actions?: CallsActions
  filtered: readonly Call[] | null
  selected: readonly string[]
  onSelected: (ids: string[]) => void
  acks: readonly Call[]
  solves: readonly Call[]
}) {
  const t = useCallsT()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const [query, setQuery] = useState(model.address.q)
  useEffect(() => setQuery(model.address.q), [model.address.q])
  const typed = useRef(false)
  const latest = useRef({ actions, model })
  latest.current = { actions, model }
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current.actions?.onAddress?.({ q: query }), 300)
    return () => clearTimeout(timer)
  }, [query])

  const waitingMinutes = model.counts?.waitingMinutes ?? 5
  const columns = useMemo<ColDef<Call>[]>(() => {
    const Type = ({ data }: ICellRendererParams<Call>) => (data ? <TypeCell type={data.type} /> : null)
    const LineCell = ({ data }: ICellRendererParams<Call>) => (data ? <span className="fw-cl-ellipsis">{data.line ? data.line.code : t('list.noLine')}</span> : null)
    const StationCell = ({ data }: ICellRendererParams<Call>) =>
      data ? (
        <span className="fw-cl-cell">
          <span className="fw-cl-ellipsis">{data.station.code}</span>
          <span className="fw-cl-sub fw-cl-ellipsis">{data.station.name}</span>
        </span>
      ) : null
    const WorkCell = ({ data }: ICellRendererParams<Call>) =>
      data ? (
        data.workOrder ? (
          <span className="fw-cl-cell">
            {latest.current.model.can.workOrders ? (
              <Link className="fw-cl-link" href={`${latest.current.model.prefix}/production/work-orders/${data.workOrder.id}`}>
                {data.workOrder.number}
              </Link>
            ) : (
              <span>{data.workOrder.number}</span>
            )}
            {data.bundle && <span className="fw-cl-sub">{data.bundle.code}</span>}
          </span>
        ) : (
          <span className="fw-cl-hint">—</span>
        )
      ) : null
    const OpenedCell = ({ data }: ICellRendererParams<Call>) =>
      data ? (
        <span className="fw-cl-cell">
          <span className="fw-cl-num">{formatTime(data.sentAt, place)}</span>
          {data.open ? <OpenFor sentAt={data.sentAt} waitingMinutes={waitingMinutes} now={latest.current.model.now} /> : <span className="fw-cl-sub">{t(`status.${data.status}`)}</span>}
        </span>
      ) : null
    const TeamCell = ({ data }: ICellRendererParams<Call>) => (data ? <span className="fw-cl-ellipsis">{data.responderTeam ? data.responderTeam.name : t('routing.leaders')}</span> : null)
    const StatusCell = ({ data }: ICellRendererParams<Call>) =>
      data ? (
        <span className="fw-cl-cell">
          <span>
            <StatusPill status={data.status} />
          </span>
          {data.waitingBooked && (
            <span>
              <WaitingTag />
            </span>
          )}
        </span>
      ) : null
    const SeenCell = ({ data }: ICellRendererParams<Call>) => (data ? <span className="fw-cl-ellipsis">{data.seenBy ? say(t, personPhrase(data.seenBy, false)) : '—'}</span> : null)
    const ResponseCell = ({ data }: ICellRendererParams<Call>) => (data ? <Duration seconds={data.times.responseSeconds} empty={data.open ? t('list.notYet') : '—'} /> : null)
    const ResolveCell = ({ data }: ICellRendererParams<Call>) => (data ? <Duration seconds={data.times.resolveSeconds} empty={data.open ? t('list.notYet') : '—'} /> : null)
    const MoreCell = ({ data }: ICellRendererParams<Call>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { station: data.station.code, type: typeLabel(data.type, locale) }) }}
          items={[
            { id: 'open', label: t('common.open'), onSelect: () => latest.current.actions?.onAddress?.({ open: data.id }) },
            ...(data.status === 'SENT' && latest.current.model.can.answer ? [{ id: 'ack', label: t('detail.ack'), onSelect: () => latest.current.actions?.onAcknowledge?.([data.id]) }] : []),
            ...(data.open && latest.current.model.can.answer ? [{ id: 'solve', label: t('detail.done'), onSelect: () => latest.current.actions?.onSolveOpen?.([data.id]) }] : []),
          ]}
        />
      ) : null
    return [
      { colId: 'type', headerName: t('col.type'), minWidth: 150, flex: 1.1, cellRenderer: Type, valueGetter: (params) => (params.data ? typeLabel(params.data.type, locale) : '') },
      { colId: 'line', headerName: t('col.line'), minWidth: 80, flex: 0.5, cellRenderer: LineCell, valueGetter: (params) => params.data?.line?.code ?? '' },
      { colId: 'station', headerName: t('col.station'), minWidth: 110, flex: 0.8, cellRenderer: StationCell, valueGetter: (params) => params.data?.station.code ?? '' },
      { colId: 'work', headerName: t('col.work'), minWidth: 120, flex: 0.8, cellRenderer: WorkCell, valueGetter: (params) => params.data?.workOrder?.number ?? '' },
      { colId: 'opened', headerName: t('col.opened'), minWidth: 120, flex: 0.8, cellRenderer: OpenedCell, valueGetter: (params) => params.data?.sentAt ?? '' },
      { colId: 'team', headerName: t('col.team'), minWidth: 120, flex: 0.8, cellRenderer: TeamCell, valueGetter: (params) => params.data?.responderTeam?.name ?? '' },
      { colId: 'status', headerName: t('col.status'), minWidth: 130, flex: 0.8, cellRenderer: StatusCell, valueGetter: (params) => params.data?.status ?? '' },
      { colId: 'seenBy', headerName: t('col.seenBy'), minWidth: 120, flex: 0.8, cellRenderer: SeenCell },
      { colId: 'response', headerName: t('col.response'), minWidth: 100, flex: 0.6, type: 'rightAligned', cellRenderer: ResponseCell, valueGetter: (params) => params.data?.times.responseSeconds ?? -1 },
      { colId: 'resolve', headerName: t('col.resolve'), minWidth: 100, flex: 0.6, type: 'rightAligned', cellRenderer: ResolveCell, valueGetter: (params) => params.data?.times.resolveSeconds ?? -1 },
      { colId: 'more', headerName: t('col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, model.timeZone, waitingMinutes])

  const narrowed = model.address.q.trim() !== '' || model.address.tile !== null || model.address.kind !== null || model.address.view !== 'open'
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
              actions?.onAddress?.({ q: '', tile: null, kind: null, view: 'open' })
            }}
          >
            {t('common.clearFilters')}
          </Button>
        }
      />
    ) : (
      <EmptyState icon={<CheckCheck size={24} aria-hidden />} title={t('list.empty.title')} description={t('list.empty.body')} />
    )
  ) : undefined

  const ownKeys: ListKey[] = [
    { keys: ['A'], does: t('keys.ack') },
    { keys: ['D'], does: t('keys.done') },
    { keys: ['J', 'K'], does: t('keys.next') },
  ]

  return (
    <>
      <ListFrame<Call>
        label={t('list.label')}
        title={t('list.title')}
        rows={state ? [] : filtered}
        rowId={(row) => row.id}
        columns={columns}
        count={filtered ? t('list.count', { count: filtered.length }) : '—'}
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
          <span className="fw-cl-inline">
            <Select size="sm" aria-label={t('list.viewLabel')} value={model.address.view} onChange={(event) => actions?.onAddress?.({ view: event.target.value as CallView, tile: null })}>
              {CALL_VIEWS.map((view) => (
                <option key={view} value={view}>
                  {t(`view.${view}`)}
                </option>
              ))}
            </Select>
            <Select size="sm" aria-label={t('list.kindLabel')} value={model.address.kind ?? ''} onChange={(event) => actions?.onAddress?.({ kind: (event.target.value || null) as CallKind | null })}>
              <option value="">{t('list.kindAll')}</option>
              {CALL_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`kind.${kind}`)}
                </option>
              ))}
            </Select>
          </span>
        }
        selection={
          model.can.answer
            ? {
                selected,
                onChange: onSelected,
                actions: (
                  <>
                    <Button size="sm" variant="primary" aria-label={t('page.ackN', { count: acks.length })} heldReason={acks.length === 0 ? t('held.ackNothing') : model.busy ? t('held.busy') : null} onClick={() => actions?.onAcknowledge?.(acks.map((row) => row.id))}>
                      <Check size={13} aria-hidden /> <SelectionLabel>{t('page.ackN', { count: acks.length })}</SelectionLabel>
                    </Button>
                    <Button size="sm" aria-label={t('bulk.solve', { count: solves.length })} heldReason={solves.length === 0 ? t('held.solveNothing') : model.busy ? t('held.busy') : null} onClick={() => actions?.onSolveOpen?.(solves.map((row) => row.id))}>
                      <CheckCheck size={13} aria-hidden /> <SelectionLabel>{t('bulk.solve', { count: solves.length })}</SelectionLabel>
                    </Button>
                  </>
                ),
              }
            : undefined
        }
        isRowSelectable={(row) => {
          const held = rowHeld(row, model.can)
          return held ? t(held) : null
        }}
        more={model.hasMore ? { label: t('common.more'), onMore: () => actions?.onMore?.(), held: model.loadingMore ? t('held.busy') : null } : null}
        keys={ownKeys}
        onHelp={() => actions?.onDialog?.({ kind: 'keys' })}
        onOpen={(row) => actions?.onAddress?.({ open: row.id })}
        state={state}
        focusRow={model.focusRow}
        cards={{}}
      />
      {model.dialog?.kind === 'keys' && <KeysDialog own={ownKeys} withSelection={model.can.answer} onClose={() => actions?.onDialog?.(null)} />}
    </>
  )
}

function KeysDialog({ own, withSelection, onClose }: { own: readonly ListKey[]; withSelection: boolean; onClose: () => void }) {
  const t = useCallsT()
  const lists = useT('lists')
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <dl className="fw-cl-keys">
        {listKeys(own, withSelection).map((entry) => (
          <div key={entry.keys.join('+')}>
            <dt>
              {entry.keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </dt>
            <dd>{entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}
