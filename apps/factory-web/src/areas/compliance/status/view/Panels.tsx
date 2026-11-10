'use client'

import Link from 'next/link'
import { useMemo, useRef, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Clock, Download, MoreHorizontal, Search, XCircle } from 'lucide-react'
import { Card, EmptyState, HoverCard, Menu, MetricStrip, type MenuItemDef, type Metric } from '@nexus/ui/components'
import { GateExplainer, type GateCheck } from '@nexus/ui/components/GateExplainer/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { useValidityWords, ValidityBar } from '../../_shared/validity/ValidityBar'
import { GATES, type ActionLine, type Board, type BoardRow, type Cell, type CellState, type ExpiryItem, type GateEvent } from '../api'
import {
  boardCsvRows,
  CELL_TONE,
  crViHref,
  FEED_FILTERS,
  FEED_TONE,
  feedCsvRows,
  feedShown,
  firstCellOf,
  fixHeld,
  fixHref,
  marketName,
  overrideHeld,
  recordHref,
  rowsShown,
  styleHref,
  subjectHref,
  TILE_KEYS,
  tileAct,
  tileActive,
  tileToggle,
  type FeedFilter,
  type TileKey,
} from '../model'
import type { Read, StatusActions, StatusModel } from './types'

type Props = { model: StatusModel; actions?: StatusActions | undefined }
type T = ReturnType<typeof useT>

const dayText = (date: string, locale: 'it' | 'en') => formatDate(`${date}T12:00:00Z`, { locale })

/** The panel's head: its title, what it says, and its own controls. */
export function Head({ id, title, hint, children }: { id: string; title: string; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="fw-cs-head">
      <div className="fw-cs-head-text">
        <h2 className="fw-cs-h2" id={id}>
          {title}
        </h2>
        {hint ? <p className="fw-cs-hint">{hint}</p> : null}
      </div>
      {children ? <div className="fw-cs-head-controls">{children}</div> : null}
    </div>
  )
}

/** Loading: the panel's shape in skeletons (design: "Skeleton of the panel's shape"). */
function Shape({ kind }: { kind: 'tiles' | 'lines' | 'months' }) {
  const t = useT('compliance-status')
  return (
    <div className={`fw-cs-shape fw-cs-shape-${kind}`} role="status" aria-label={t('common.loading')}>
      {kind === 'tiles'
        ? Array.from({ length: 6 }, (_, index) => <Skeleton key={index} height={72} radius={8} />)
        : kind === 'months'
          ? Array.from({ length: 12 }, (_, index) => <Skeleton key={index} height={64} radius={8} />)
          : Array.from({ length: 5 }, (_, index) => <Skeleton key={index} height={22} />)}
    </div>
  )
}

/** The part failed: what failed in words, and Try again; the rest of the page stays usable. */
export function Failed({ title, problem, onRetry }: { title: string; problem: string; onRetry?: (() => void) | undefined }) {
  const t = useT('compliance-status')
  const quality = useT('quality')
  return (
    <EmptyState
      title={title}
      description={quality(problem)}
      action={
        <Button size="sm" onClick={() => onRetry?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  )
}

function stateOf<V>(read: Read<V>, failedTitle: string, shape: 'tiles' | 'lines' | 'months', onRetry?: () => void): ReactNode | null {
  if (read.status === 'loading' || read.status === 'idle') return <Shape kind={shape} />
  if (read.status === 'error') return <Failed title={failedTitle} problem={read.problem} onRetry={onRetry} />
  return null
}

/** The cell's state with its icon and word (never a colour alone): Ready ✓ · Missing 2 · Blocked ✕ · Expiring !. */
export function CellMark({ cell }: { cell: Pick<Cell, 'state' | 'missing'> }) {
  const t = useT('compliance-status')
  const Icon = cell.state === 'READY' ? CheckCircle2 : cell.state === 'BLOCKED' ? XCircle : cell.state === 'EXPIRING' ? Clock : AlertTriangle
  return (
    <Tag tone={CELL_TONE[cell.state]}>
      <Icon size={13} aria-hidden /> {cellWord(t, cell.state, cell.missing)}
    </Tag>
  )
}

export const cellWord = (t: T, state: CellState, missing: number): string => (state === 'MISSING' ? t('cell.missingCount', { count: missing }) : t(`cell.${state}`))

// ---- Readiness tiles (cs-kpi) ----------------------------------------------------------------------------------------------------

export function KpiPanel({ model, actions }: Props) {
  const t = useT('compliance-status')
  const locale = useLocale()
  const read = model.board
  const state = stateOf(read, t('kpi.failed'), 'tiles', () => actions?.onRetry?.('board'))
  const value = read.status === 'ready' ? read.value : null
  const empty = value !== null && value.rows.length === 0 && !model.address.gap && !model.address.q && !model.address.brandId
  const number = (count: number | null) => (count === null || empty ? '—' : new Intl.NumberFormat(INTL_LOCALE[locale]).format(count))
  const metrics: Metric[] = value
    ? TILE_KEYS.map((key: TileKey) => {
        const act = tileAct(key, model.prefix, model.can)
        const count = value.tiles[key]
        const hint = (
          <span className="fw-cs-tile-hint">
            <span>{count === null ? t('tile.notInRole') : t(`tile.hint.${key}`)}</span>
            {act.kind === 'none' && count !== null ? <span className="fw-cs-muted">{t(act.held)}</span> : null}
          </span>
        )
        const base = { label: t(`tile.${key}`), value: number(count), hint }
        if (act.kind === 'link') return { ...base, href: act.href }
        if (act.kind === 'filter') return { ...base, onClick: () => actions?.onAddress?.(tileToggle(key, model.address, act)), active: tileActive(key, model.address) }
        return base
      })
    : []
  return (
    <Card padded>
      <section aria-labelledby="cs-kpi-title" className="fw-cs-panel" id="cs-kpi">
        <Head id="cs-kpi-title" title={t('section.kpi')} hint={empty ? t('kpi.empty') : t('kpi.hint')} />
        {state ?? <MetricStrip metrics={metrics} minTileWidth={170} />}
      </section>
    </Card>
  )
}

// ---- Needs action (cs-actions) ------------------------------------------------------------------------------------------------

/** "JK-100 cannot ship to Germany" — our words for a line's head (the gate it blocks last, as the API orders them). */
export function lineHead(t: T, line: Pick<ActionLine, 'styleCode' | 'marketCode' | 'severity'>, cell: Pick<Cell, 'blockedGates'> | null, market: string): string {
  const gate = cell?.blockedGates.at(-1)
  if (line.severity === 'BLOCKED' && gate) return t(`actions.head.${gate}`, { style: line.styleCode, market })
  return t('actions.head.other', { style: line.styleCode, market })
}

/** A line's cell on the board (its first missing requirement: the API's sentence, the fix, the law). */
export const cellOfLine = (board: Board | null, line: Pick<ActionLine, 'styleId' | 'marketCode'>): Cell | null =>
  board?.rows.find((row) => row.style.id === line.styleId)?.cells.find((cell) => cell.marketCode === line.marketCode) ?? null

/** The lines as the DS GateExplainer's checks (list form: only what blocks, each with who can clear it and the button). */
export function lineChecks(t: T, lines: readonly ActionLine[], board: Board | null, model: Pick<StatusModel, 'prefix' | 'can'>, locale?: string): GateCheck[] {
  const markets = board?.markets ?? []
  return lines.map((line) => {
    const cell = cellOfLine(board, line)
    const href = fixHref(line.fixPlace, model.prefix, model.can)
    const held = href ? null : fixHeld(line.fixPlace, model.can)
    const message = cell?.first?.code === line.requirementCode ? cell.first.message : null
    return {
      id: `${line.styleId}|${line.marketCode}`,
      state: 'fail',
      stateLabel: t(`severity.${line.severity}`),
      label: [lineHead(t, line, cell, marketName(line.marketCode, markets, locale)), message ? `${line.requirementCode} · ${message}` : line.requirementCode].join(': '),
      who: t(`who.${line.who}`),
      ...(cell?.first?.fix ? { how: cell.first.fix } : {}),
      fix: { label: t(`fixPlace.${line.fixPlace}`), ...(href ? { href } : { heldReason: t(held ?? 'fix.held.settings') }) },
    }
  })
}

export function ActionsPanel({ model, actions }: Props) {
  const t = useT('compliance-status')
  const locale = useLocale()
  const ds = useDsWords()
  const read = model.board
  const state = stateOf(read, t('actions.failed'), 'lines', () => actions?.onRetry?.('board'))
  const value = read.status === 'ready' ? read.value : null
  const count = value?.needsAction.count ?? 0
  return (
    <Card padded>
      <section aria-labelledby="cs-actions-title" className="fw-cs-panel" id="cs-actions">
        <Head id="cs-actions-title" title={t('section.actions')} hint={model.address.gap ? t('actions.hintGap', { gap: t(`gap.${model.address.gap}`) }) : t('actions.hint')}>
          {count > 5 ? (
            <Button size="sm" onClick={() => actions?.onAllActions?.(true)}>
              {t('actions.seeAll', { count })}
            </Button>
          ) : null}
        </Head>
        {state ??
          (value && value.needsAction.lines.length === 0 ? (
            <EmptyState title={t('actions.empty')} description={t('actions.emptyBody')} />
          ) : value ? (
            <GateExplainer form="list" checks={lineChecks(t, value.needsAction.lines, value, model, locale)} labels={{ ...ds.gateExplainer, list: t('actions.listLabel') }} lawLabels={ds.lawRef} />
          ) : null)}
      </section>
    </Card>
  )
}

// ---- Style × market (cs-matrix) ------------------------------------------------------------------------------------------------

export function MatrixPanel({ model, actions }: Props) {
  const t = useT('compliance-status')
  const locale = useLocale()
  const read = model.board
  const value = read.status === 'ready' ? read.value : null
  const markets = useMemo(() => value?.markets ?? [], [value])
  const rows = value ? rowsShown(value.rows, model.address.status) : null
  const latest = useRef({ model, actions })
  latest.current = { model, actions }

  const columns = useMemo((): ColDef<BoardRow>[] => {
    const StyleCell = ({ data }: ICellRendererParams<BoardRow>) => {
      if (!data) return null
      const href = styleHref(data.style.id, latest.current.model.prefix, latest.current.model.can)
      return (
        <span className="fw-cs-style">
          <span className="fw-cs-style-code">
            {href ? (
              <Link className="fw-cs-link" href={href}>
                {data.style.code}
              </Link>
            ) : (
              data.style.code
            )}{' '}
            · {data.style.name}
          </span>
          <span className="fw-cs-muted">{data.style.brand ? t('matrix.brand', { brand: `${data.style.brand.code} · ${data.style.brand.name}` }) : t('matrix.ownName')}</span>
        </span>
      )
    }
    const marketColumn = (code: string, name: string): ColDef<BoardRow> => ({
      colId: `market-${code}`,
      headerName: code,
      headerTooltip: name,
      sortable: false,
      flex: 0.8,
      minWidth: 128,
      valueGetter: (params) => {
        const cell = params.data?.cells.find((entry) => entry.marketCode === code)
        return cell ? cellWord(t, cell.state, cell.missing) : ''
      },
      cellRenderer: ({ data }: ICellRendererParams<BoardRow>) => {
        const cell = data?.cells.find((entry) => entry.marketCode === code)
        if (!data || !cell) return <span className="fw-cs-muted">—</span>
        return (
          <button
            type="button"
            className="fw-cs-cell"
            aria-label={t('matrix.cellLabel', { style: data.style.code, market: name, state: cellWord(t, cell.state, cell.missing) })}
            onClick={() => latest.current.actions?.onCell?.({ styleId: data.style.id, market: code })}
          >
            <CellMark cell={cell} />
          </button>
        )
      },
    })
    return [{ colId: 'style', headerName: t('matrix.col.style'), sortable: false, flex: 2, minWidth: 220, cellRenderer: StyleCell, valueGetter: (params) => (params.data ? `${params.data.style.code} · ${params.data.style.name}` : '') }, ...markets.map((market) => marketColumn(market.code, marketName(market.code, markets, locale)))]
  }, [t, markets, locale])

  const filtered = model.address.status !== null || model.address.q.trim() !== '' || model.address.gap !== null || model.address.brandId !== null
  const state =
    read.status === 'error' ? (
      <Failed title={t('matrix.failed')} problem={read.problem} onRetry={() => actions?.onRetry?.('board')} />
    ) : rows && rows.length === 0 ? (
      filtered ? (
        <EmptyState
          title={t('matrix.noMatch')}
          action={
            <Button size="sm" onClick={() => actions?.onAddress?.({ status: null, q: '', gap: null, brandId: null })}>
              {t('matrix.clear')}
            </Button>
          }
        />
      ) : (
        <EmptyState title={t('matrix.empty.title')} description={t('matrix.empty.body')} />
      )
    ) : undefined

  const selected = model.selectedStyles
  const exportSelected = () => {
    if (!value) return
    const chosen = value.rows.filter((row) => selected.includes(row.style.id))
    actions?.onExport?.('board', [t('csv.style'), t('csv.name'), t('csv.brand'), ...markets.map((market) => market.code)], boardCsvRows(chosen, markets.map((market) => market.code), (cellState, missing) => cellWord(t, cellState, missing)))
  }

  return (
    <Card padded>
      <section aria-labelledby="cs-matrix-title" className="fw-cs-panel" id="cs-matrix">
        <Head id="cs-matrix-title" title={t('section.matrix')} hint={t('matrix.hint')}>
          <span className="fw-cs-legend" aria-label={t('matrix.legend')}>
            {(['READY', 'MISSING', 'BLOCKED', 'EXPIRING'] as const).map((cellState) => (
              <CellMark key={cellState} cell={{ state: cellState, missing: 2 }} />
            ))}
            <span className="fw-cs-muted">{t('matrix.notSold')}</span>
          </span>
        </Head>
        {model.address.gap === 'crVi' ? <CrViNote model={model} /> : null}
        {value?.more ? <p className="fw-cs-hint">{t('matrix.more', { count: value.rows.length })}</p> : null}
        <ListFrame<BoardRow>
          label={t('section.matrix')}
          listKey={null}
          rows={read.status === 'error' ? [] : rows}
          rowId={(row) => row.style.id}
          columns={columns}
          count={rows && value ? (rows.length === value.rows.length ? t('matrix.count', { count: rows.length }) : t('matrix.countOf', { count: rows.length, total: value.rows.length })) : '—'}
          search={<Input size="sm" type="search" leadingIcon={<Search size={14} aria-hidden />} aria-label={t('matrix.search')} placeholder={t('matrix.search')} value={model.address.q} onChange={(event) => actions?.onAddress?.({ q: event.target.value })} />}
          tools={
            <Select size="sm" aria-label={t('matrix.statusFilter')} value={model.address.status ?? ''} onChange={(event) => actions?.onAddress?.({ status: (event.target.value || null) as StatusModel['address']['status'] })}>
              <option value="">{t('matrix.statusAll')}</option>
              {(['ready', 'missing', 'blocked', 'expiring'] as const).map((status) => (
                <option key={status} value={status}>
                  {t(`matrix.status.${status}`)}
                </option>
              ))}
            </Select>
          }
          selection={{
            selected,
            onChange: (ids) => actions?.onSelectStyles?.(ids),
            actions: (
              <Button size="sm" onClick={exportSelected} aria-label={t('matrix.export', { count: selected.length })}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('matrix.export', { count: selected.length })}</SelectionLabel>
              </Button>
            ),
          }}
          onOpen={(row) => {
            const at = firstCellOf(row)
            if (at) actions?.onCell?.(at)
          }}
          state={state}
        />
      </section>
    </Card>
  )
}

/** Cr VI evidence is per lot (a style × market cell never says it): the gap opens the lots waiting for evidence. */
function CrViNote({ model }: { model: StatusModel }) {
  const t = useT('compliance-status')
  const href = crViHref(model.prefix, model.can)
  return (
    <p className="fw-cs-note" role="note">
      {t('gap.crViNote')}{' '}
      {href ? (
        <Link className="fw-cs-link" href={href}>
          {t('gap.crViOpen')}
        </Link>
      ) : (
        <span className="fw-cs-muted">{t('tile.held.role')}</span>
      )}
    </p>
  )
}

// ---- Gate refusals (cs-gates) ---------------------------------------------------------------------------------------------------

export function GatesPanel({ model, actions }: Props) {
  const t = useT('compliance-status')
  const locale = useLocale()
  const read = model.feed
  const value = read.status === 'ready' ? read.value : null
  const rows = value ? feedShown(value.events, model.address.feed) : null
  // The board's market names (the columns are drawn again once they are read).
  const board = model.board.status === 'ready' ? model.board.value : null
  const markets = useMemo(() => board?.markets ?? [], [board])
  const offline = model.live === 'offline'
  const latest = useRef({ model, actions, offline })
  latest.current = { model, actions, offline }

  const columns = useMemo((): ColDef<GateEvent>[] => {
    const WhenCell = ({ data }: ICellRendererParams<GateEvent>) => (data ? <span>{formatDateTime(data.at, { locale })}</span> : null)
    const WhereCell = ({ data }: ICellRendererParams<GateEvent>) => {
      if (!data) return null
      const href = subjectHref(data, latest.current.model.prefix, latest.current.model.can)
      const number = data.subject.number ?? t('feed.subjectNoNumber')
      return (
        <span className="fw-cs-style">
          <span>{t(`gate.${data.gate}`)}</span>
          <span className="fw-cs-muted">
            {t(`subject.${data.subject.type === 'Shipment' ? 'Shipment' : 'WorkOrder'}`)}{' '}
            {href ? (
              <Link className="fw-cs-link" href={href}>
                {number}
              </Link>
            ) : (
              number
            )}
            {data.site?.code ? ` · ${data.site.code}` : ''}
          </span>
        </span>
      )
    }
    const WhatCell = ({ data }: ICellRendererParams<GateEvent>) => {
      if (!data) return null
      const parts = [data.style?.code, data.colourway, data.size].filter(Boolean).join(' · ')
      return (
        <span className="fw-cs-style">
          <span>{parts || '—'}</span>
          <span className="fw-cs-muted">{data.marketCode ? marketName(data.marketCode, markets, locale) : t('feed.noMarket')}</span>
        </span>
      )
    }
    const ReasonCell = ({ data }: ICellRendererParams<GateEvent>) => {
      if (!data) return null
      const reason = data.outcome === 'OVERRIDDEN' ? t('feed.overrideReason', { reason: data.reason }) : data.reason
      // One line in the row (the whole sentence on hover, in the file, on the phone card and in the print window).
      return (
        <span className="fw-cs-style" title={reason}>
          <span className="fw-cs-code">{data.requirement.code}</span>
          <span className="fw-cs-muted fw-cs-line">{reason}</span>
        </span>
      )
    }
    const StateCell = ({ data }: ICellRendererParams<GateEvent>) => {
      if (!data) return null
      const inForce = data.overrides.find((entry) => entry.inForce) ?? null
      return (
        <span className="fw-cs-style">
          <Tag tone={FEED_TONE[data.state]}>{t(`feed.state.${data.state}`)}</Tag>
          {inForce ? <span className="fw-cs-muted fw-cs-line">{t('feed.overriddenBy', { who: inForce.by?.name ?? t('feed.someone'), until: inForce.until ? formatDateTime(inForce.until, { locale }) : '—' })}</span> : null}
          {data.outcome === 'OVERRIDDEN' && data.overrideUntil ? <span className="fw-cs-muted fw-cs-line">{t('feed.overrideUntil', { who: data.by?.name ?? t('feed.someone'), until: formatDateTime(data.overrideUntil, { locale }) })}</span> : null}
        </span>
      )
    }
    const ActionsCell = ({ data }: ICellRendererParams<GateEvent>) => {
      if (!data) return null
      const now = latest.current
      const href = subjectHref(data, now.model.prefix, now.model.can)
      const held = overrideHeld(data, now.model.can, now.offline)
      const items: MenuItemDef[] = [
        ...(href ? [{ id: 'open', label: t('feed.open', { number: data.subject.number ?? '' }), href }] : []),
        ...(data.outcome === 'REFUSED' ? [{ id: 'override', label: t('feed.override'), onSelect: () => now.actions?.onOverride?.(data), ...(held ? { disabled: true, description: t(held) } : {}) }] : []),
      ]
      if (items.length === 0) items.push({ id: 'none', label: t('feed.nothing'), disabled: true })
      return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('feed.menu', { number: data.subject.number ?? data.requirement.code }) }} items={items} />
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<GateEvent>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number }, text?: (row: GateEvent) => string): ColDef<GateEvent> => ({
      colId,
      headerName: header,
      cellRenderer,
      sortable: false,
      ...size,
      ...(text ? { valueGetter: (params: { data?: GateEvent }) => (params.data ? text(params.data) : '') } : {}),
    })
    return [
      column('when', t('feed.col.when'), WhenCell, { flex: 0.9, minWidth: 150 }, (row) => formatDateTime(row.at, { locale })),
      column('where', t('feed.col.where'), WhereCell, { flex: 1.2, minWidth: 180 }, (row) => `${t(`gate.${row.gate}`)} · ${row.subject.number ?? ''}`),
      column('what', t('feed.col.what'), WhatCell, { flex: 1, minWidth: 150 }, (row) => [row.style?.code, row.colourway, row.size, row.marketCode].filter(Boolean).join(' · ')),
      column('reason', t('feed.col.reason'), ReasonCell, { flex: 2.2, minWidth: 260 }, (row) => `${row.requirement.code} · ${row.reason}`),
      column('state', t('feed.col.state'), StateCell, { flex: 1.6, minWidth: 230 }, (row) => t(`feed.state.${row.state}`)),
      { ...column('actions', t('feed.col.actions'), ActionsCell, { width: 72, minWidth: 72 }), suppressHeaderMenuButton: true, pinned: 'right' },
    ]
  }, [t, locale, markets])

  const filtered = model.address.feed !== 'all' || model.address.gate !== null
  const state =
    read.status === 'error' ? (
      <Failed title={t('feed.failed')} problem={read.problem} onRetry={() => actions?.onRetry?.('feed')} />
    ) : rows && rows.length === 0 ? (
      filtered && (value?.events.length ?? 0) > 0 ? (
        <EmptyState title={t('feed.noMatch')} action={<Button size="sm" onClick={() => actions?.onAddress?.({ feed: 'all', gate: null, days: 7 })}>{t('matrix.clear')}</Button>} />
      ) : (
        <EmptyState title={t('feed.empty', { count: model.address.days })} />
      )
    ) : undefined

  const selected = model.selectedEvents
  const exportSelected = () => {
    if (!value) return
    const chosen = value.events.filter((event) => selected.includes(event.id))
    actions?.onExport?.(
      'refusals',
      [t('csv.at'), t('csv.gate'), t('csv.subject'), t('csv.style'), t('csv.colourway'), t('csv.size'), t('csv.market'), t('csv.requirement'), t('csv.state'), t('csv.reason')],
      feedCsvRows(chosen, { gate: (gate) => t(`gate.${gate}`), state: (feedState) => t(`feed.state.${feedState}`) }),
    )
  }

  return (
    <Card padded>
      <section aria-labelledby="cs-gates-title" className="fw-cs-panel" id="cs-gates">
        <Head id="cs-gates-title" title={t('section.gates')} hint={t('feed.hint', { count: model.address.days })} />
        <ListFrame<GateEvent>
          label={t('section.gates')}
          listKey={null}
          rows={read.status === 'error' ? [] : rows}
          rowId={(row) => row.id}
          columns={columns}
          count={rows && value ? (rows.length === value.events.length ? t('feed.count', { count: rows.length }) : t('feed.countOf', { count: rows.length, total: value.events.length })) : '—'}
          tools={
            <>
              <Select size="sm" aria-label={t('feed.gateFilter')} value={model.address.gate ?? ''} onChange={(event) => actions?.onAddress?.({ gate: (event.target.value || null) as StatusModel['address']['gate'] })}>
                <option value="">{t('feed.gateAll')}</option>
                {GATES.map((gate) => (
                  <option key={gate} value={gate}>
                    {t(`gate.${gate}`)}
                  </option>
                ))}
              </Select>
              <Select size="sm" aria-label={t('feed.stateFilter')} value={model.address.feed} onChange={(event) => actions?.onAddress?.({ feed: event.target.value as FeedFilter })}>
                {FEED_FILTERS.map((filter) => (
                  <option key={filter} value={filter}>
                    {t(`feed.filter.${filter}`)}
                  </option>
                ))}
              </Select>
              <Select size="sm" aria-label={t('feed.daysFilter')} value={String(model.address.days)} onChange={(event) => actions?.onAddress?.({ days: Number(event.target.value) === 30 ? 30 : 7 })}>
                <option value="7">{t('feed.days', { count: 7 })}</option>
                <option value="30">{t('feed.days', { count: 30 })}</option>
              </Select>
            </>
          }
          selection={{
            selected,
            onChange: (ids) => actions?.onSelectEvents?.(ids),
            actions: (
              <Button size="sm" onClick={exportSelected} aria-label={t('feed.export', { count: selected.length })}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('feed.export', { count: selected.length })}</SelectionLabel>
              </Button>
            ),
          }}
          onOpen={(row) => {
            // Design cs-gates "Row → the blocked record".
            const href = subjectHref(row, model.prefix, model.can)
            if (href) actions?.onGo?.(href)
          }}
          state={state}
        />
      </section>
    </Card>
  )
}

// ---- What expires next (cs-expiry) ---------------------------------------------------------------------------------------------

function ExpiryChip({ item, model }: { item: ExpiryItem; model: StatusModel }) {
  const t = useT('compliance-status')
  const locale = useLocale()
  const words = useValidityWords()
  const { left } = words({ from: item.validFrom, to: item.validTo, today: model.today })
  const kind = item.recordType === 'Certificate' ? t('expiry.kindCertificate') : item.recordType === 'SupplierDeclarationRequest' ? t('expiry.kindDeclaration') : t('expiry.kindOther')
  const what = item.recordType === 'Certificate' ? [item.label, item.detail].filter(Boolean).join(' · ') : [item.label, item.party].filter(Boolean).join(' · ')
  const rows: [string, string][] = [
    [t('expiry.what'), `${kind} · ${what}`],
    ...(item.validFrom ? [[t('expiry.validFrom'), dayText(item.validFrom, locale)] as [string, string]] : []),
    [t('expiry.validTo'), dayText(item.validTo, locale)],
    [t('expiry.left'), left],
    ...(item.status === 'SUSPENDED' ? [[t('expiry.status'), t('expiry.suspended')] as [string, string]] : []),
    ...(item.endsWithBase ? [[t('expiry.status'), t('expiry.endsWithBase')] as [string, string]] : []),
  ]
  return (
    <li className="fw-cs-chip-item">
      <HoverCard rows={rows}>
        <Link className="fw-cs-chip" href={recordHref(item, model.prefix)} aria-label={t('expiry.chipLabel', { kind, what, date: dayText(item.validTo, locale), left })}>
          <span className="fw-cs-chip-head">
            <Tag tone={item.status === 'SUSPENDED' || item.endsWithBase ? 'warning' : item.recordType === 'Certificate' ? 'info' : 'neutral'}>{kind}</Tag>
            <span className="fw-cs-chip-label">{item.label}</span>
          </span>
          <ValidityBar mini from={item.validFrom} to={item.validTo} today={model.today} />
        </Link>
      </HoverCard>
    </li>
  )
}

/** "dic 2026" of a YYYY-MM key. */
export function monthLabel(month: string, locale: 'it' | 'en'): string {
  const [year, number] = month.split('-').map(Number) as [number, number]
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, number - 1, 1)))
}

export function ExpiryPanel({ model, actions }: Props) {
  const t = useT('compliance-status')
  const locale = useLocale()
  const read = model.expiries
  const value = read.status === 'ready' ? read.value : null
  const state = stateOf(read, t('expiry.failed'), 'months', () => actions?.onRetry?.('expiry'))
  return (
    <Card padded>
      <section aria-labelledby="cs-expiry-title" className="fw-cs-panel" id="cs-expiry">
        <Head id="cs-expiry-title" title={t('section.expiry')} hint={value ? t('expiry.hintRange', { from: dayText(value.from, locale), to: dayText(value.to, locale) }) : t('expiry.hint')} />
        {state ??
          (value && value.count === 0 ? (
            <EmptyState title={t('expiry.empty')} description={t('expiry.emptyBody')} />
          ) : value ? (
            <>
              <ol className="fw-cs-months" aria-label={t('expiry.monthsLabel')}>
                {value.months.map((month) => (
                  <li key={month.month} className="fw-cs-month">
                    <p className="fw-cs-month-head">
                      <span className="fw-cs-month-name">{monthLabel(month.month, locale)}</span>
                      <span className="fw-cs-muted">{month.count === 0 ? '—' : t('expiry.count', { count: month.count })}</span>
                    </p>
                    {month.items.length > 0 ? (
                      <ul className="fw-cs-chips">
                        {month.items.map((item) => (
                          <ExpiryChip key={`${item.recordType}-${item.recordId}`} item={item} model={model} />
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ol>
              <p className="fw-cs-hint">{t('expiry.later')}</p>
            </>
          ) : null)}
      </section>
    </Card>
  )
}
