'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ExternalLink, Lock, Search, X } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Tag } from '@nexus/ui/primitives'
import { DEMAND_LAYERS } from '@nexus/factory-domain/planning/demand/rules'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import type { SourceRow } from '../api'
import { bucketLabel, documentWords, isLayer, kindWords, listOnCell, pieces, piecesWords, recordHref, sourcesWords, sizeWords, statusWords, whenWords, type Words } from '../model'
import type { DemandActions, DemandModel } from '../view-model'

const layerTone = (layer: SourceRow['layer']) => (layer === 'QUOTES' ? 'neutral' : layer === 'REMAKES' ? 'warning' : layer === 'SAMPLES' ? 'info' : 'success')

/**
 * Demand rows (design planning.demand sec:list): the same demand as a list with its source, on the shared list frame (listKey
 * `planning.demand.2`, its export source on the API: Export ▾ and Export N of the ticked rows): source, document (a real link to
 * the record, ⌘-click or ↗ for a new tab; held when the person may not open it), what it came from, style, size, pieces, the
 * day (late days), status, whether the material plan buys for it. Its own filters: a layer, a search over styles and document
 * numbers, and one cell of the grid ("Show all in Demand rows" from a popover). Pages of 100: Show more.
 */
export function RowsSection({ model, actions, words }: { model: DemandModel; actions?: DemandActions; words: Words }) {
  const { t, locale } = words
  const list = model.list.status === 'ready' ? model.list.value : null
  const horizon = model.demand.status === 'ready' ? model.demand.value.horizon : null
  const [selected, setSelected] = useState<readonly string[]>(model.selectedRows ?? [])
  const rowsKey = list?.rows.map((row) => row.key).join('\n') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const [query, setQuery] = useState(model.controls.rq)
  useEffect(() => setQuery(model.controls.rq), [model.controls.rq])
  const typed = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onList?.({ rq: query.trim() }), 300)
    return () => clearTimeout(timer)
  }, [query])

  const keys: ListKey[] = [{ keys: ['Enter'], does: t('keys.openSource') }]

  const SourceCell = ({ data: row }: ICellRendererParams<SourceRow>) =>
    row ? (
      <span className="fw-dm-cell">
        <span className="fw-dm-ellipsis">{kindWords(row, t)}</span>
        <span className="fw-dm-sub">
          <Pill tone={layerTone(row.layer)}>{t(`layer.${row.layer}`)}</Pill>
        </span>
      </span>
    ) : null
  const DocumentCell = ({ data: row }: ICellRendererParams<SourceRow>) => {
    if (!row) return null
    const doc = documentWords(row, t)
    const href = recordHref(model.prefix, model.built, row.source)
    return (
      <span className="fw-dm-cell">
        {row.source.mayOpen ? (
          <span className="fw-dm-inline">
            <Link className="fw-dm-link fw-dm-ellipsis" href={href}>
              {doc}
            </Link>
            <a className="fw-dm-newtab" href={href} target="_blank" rel="noreferrer" aria-label={t('popover.openNewTab', { doc })} title={t('popover.openNewTab', { doc })}>
              <ExternalLink size={12} aria-hidden />
            </a>
          </span>
        ) : (
          <span className="fw-dm-held fw-dm-ellipsis" title={t('rows.mayNotOpen')} aria-label={`${doc} — ${t('rows.mayNotOpen')}`}>
            <Lock size={11} aria-hidden /> {doc}
          </span>
        )}
        <span className="fw-dm-sub fw-dm-ellipsis">
          {[row.party?.name, row.origin ? t('rows.from', { origin: row.origin.number }) : null, row.workOrder && row.workOrder.number !== row.source.number ? row.workOrder.number : null].filter(Boolean).join(' · ') || '—'}
        </span>
      </span>
    )
  }
  const StyleCell = ({ data: row }: ICellRendererParams<SourceRow>) =>
    row ? (
      <span className="fw-dm-cell">
        <span className="fw-dm-ellipsis">
          {row.style.code} · {row.colourway ? row.colourway.name : t('grid.anyColour')}
        </span>
        <span className="fw-dm-sub fw-dm-ellipsis">{row.style.name}</span>
      </span>
    ) : null
  const WhenCell = ({ data: row }: ICellRendererParams<SourceRow>) => {
    if (!row) return null
    const when = whenWords(row, words)
    return (
      <span className="fw-dm-cell">
        <span>{when.day}</span>
        <span className={when.late ? 'fw-dm-sub late' : 'fw-dm-sub'}>{when.late ?? (horizon ? bucketLabel(row.bucket, horizon, words) : '—')}</span>
      </span>
    )
  }
  const StatusCell = ({ data: row }: ICellRendererParams<SourceRow>) =>
    row ? (
      <span className="fw-dm-cell">
        <span className="fw-dm-ellipsis">{statusWords(row.status, t)}</span>
        <span className="fw-dm-sub fw-dm-ellipsis">{row.kind === 'QUOTE_LINE' && row.validUntil ? t('rows.validUntil', { day: whenWords({ date: row.validUntil, daysLate: 0 }, words).day }) : row.planned ? t('rows.planned') : t('rows.notPlanned')}</span>
      </span>
    ) : null

  const plain = { sortable: false, suppressHeaderMenuButton: true } as const
  const columns: ColDef<SourceRow>[] = [
    { ...plain, colId: 'source', headerName: t('rows.col.source'), minWidth: 170, flex: 1, cellRenderer: SourceCell },
    { ...plain, colId: 'document', headerName: t('rows.col.document'), minWidth: 200, flex: 1.2, cellRenderer: DocumentCell },
    { ...plain, colId: 'style', headerName: t('rows.col.style'), minWidth: 200, flex: 1.2, cellRenderer: StyleCell },
    { ...plain, colId: 'size', headerName: t('rows.col.size'), minWidth: 90, flex: 0.5, valueGetter: (params) => (params.data ? sizeWords(params.data, t) : '') },
    { ...plain, colId: 'pieces', headerName: t('rows.col.pieces'), minWidth: 90, flex: 0.5, type: 'numericColumn', valueGetter: (params) => (params.data ? pieces(params.data.pieces, locale) : '') },
    { ...plain, colId: 'date', headerName: t('rows.col.date'), minWidth: 140, flex: 0.8, cellRenderer: WhenCell },
    { ...plain, colId: 'status', headerName: t('rows.col.status'), minWidth: 170, flex: 1, cellRenderer: StatusCell },
  ]

  const filtered = !!(model.controls.layer || model.controls.rq || listOnCell(model.controls))
  let state: ReactNode = undefined
  if (model.list.status === 'error') {
    state = (
      <EmptyState
        title={t('rows.error')}
        description={t(model.list.problem)}
        action={
          <Button size="sm" onClick={() => actions?.onRetry?.('list')}>
            {t('common.retry')}
          </Button>
        }
      />
    )
  } else if (list && list.rows.length === 0) {
    state = filtered ? (
      <EmptyState
        title={t('rows.noMatch')}
        description={t('rows.noMatchBody')}
        action={
          <Button size="sm" onClick={() => actions?.onClearList?.()}>
            {t('common.clearFilters')}
          </Button>
        }
      />
    ) : (
      <EmptyState title={t('rows.empty')} description={t('rows.emptyBody')} />
    )
  }

  const onCellChip = listOnCell(model.controls) ? (
    <Tag tone="info">
      <span className="fw-dm-inline">
        {t('rows.onCell', { cell: model.controls.cell && horizon ? bucketLabel(model.controls.cell, horizon, words) : t('grid.wholeHorizon') })}
        <Button size="xs" variant="quiet" aria-label={t('rows.clearCell')} onClick={() => actions?.onList?.({ style: null, colour: null, size: null, mtm: false, cell: null })}>
          <X size={12} aria-hidden />
        </Button>
      </span>
    </Tag>
  ) : null

  return (
    <ListFrame<SourceRow>
      label={t('rows.title')}
      listKey="planning.demand.2"
      title={t('rows.title')}
      rows={state ? [] : (list?.rows ?? null)}
      rowId={(row) => row.key}
      columns={columns}
      count={list ? t('rows.count', { count: list.rows.length, sources: sourcesWords(list.sources, words), pieces: piecesWords(list.pieces, words) }) : '—'}
      search={
        <Input
          size="sm"
          type="search"
          leadingIcon={<Search size={13} aria-hidden />}
          aria-label={t('rows.search')}
          placeholder={t('rows.search')}
          value={query}
          onChange={(event) => {
            typed.current = true
            setQuery(event.target.value)
          }}
        />
      }
      tools={
        <>
          <Select size="sm" aria-label={t('rows.layer')} value={model.controls.layer ?? ''} onChange={(event) => actions?.onList?.({ layer: isLayer(event.target.value) ? event.target.value : null })}>
            <option value="">{t('rows.allLayers')}</option>
            {DEMAND_LAYERS.map((layer) => (
              <option key={layer} value={layer}>
                {t(`layer.${layer}`)}
              </option>
            ))}
          </Select>
          {onCellChip}
        </>
      }
      selection={{ selected, onChange: setSelected, actions: null, exportSelected: true }}
      more={list && list.nextCursor ? { label: t(list.more === 'failed' ? 'rows.moreFailed' : 'rows.more'), onMore: () => actions?.onMore?.(), held: list.more === 'loading' ? t('rows.moreLoading') : null } : null}
      keys={keys}
      onHelp={() => actions?.onKeys?.()}
      onOpen={(row) => {
        if (row.source.mayOpen) actions?.onOpenSource?.(recordHref(model.prefix, model.built, row.source))
      }}
      state={state}
      focusRow={model.focusRow}
    />
  )
}
