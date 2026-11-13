'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Download, ExternalLink, MoreHorizontal, Search, X } from 'lucide-react'
import { DetailPopover, EmptyState, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Tag } from '@nexus/ui/primitives'
import { RISK_STATES } from '@nexus/factory-domain/planning/promise-keep/risk'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { usePageKeys } from '../../../_shared/buying/hooks'
import type { PromiseLine } from '../api'
import { certificateTone, certificateWords, changesWords, dayWords, isRisk, openPieces, orderHref, OWN_KEYS, riskKey, riskTone, rowVerbOf, sizesWords, slackShort, slackWords, type Words } from '../model'
import type { PromiseActions, PromiseModel } from '../view-model'
import { HistoryPanel } from './HistoryPanel'

const focusedRowId = (): string | null => (typeof document === 'undefined' ? null : ((document.activeElement as HTMLElement | null)?.closest('.ag-row')?.getAttribute('row-id') ?? null))

/**
 * Open order lines (design planning.promise sec:lines): every promise with the planned finish next to it, on the shared list
 * frame — customer and order (the order a real link to its record: ⌘-click or ↗ is the design's new tab), style and sizes,
 * First promise (kept forever), Current promise (and a re-promise that waits for sales), Planned finish (from the board,
 * or where it comes from), slack days, risk, certificate cover through the promised day, changes (the history popover).
 * The row verb Re-promise (`p` on the focused line; Review when a proposal waits), `h` the history, Enter the order. Its
 * filters: a risk, the search (order, style or customer; the API's), the tile pressed above. Ticked lines: Export N.
 */
export function LinesSection({ model, actions, words }: { model: PromiseModel; actions?: PromiseActions; words: Words }) {
  const { t, locale } = words
  const list = model.list.status === 'ready' ? model.list.value : null
  const lines = list?.lines ?? null
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const rowsKey = lines?.map((line) => line.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const [query, setQuery] = useState(model.controls.q)
  useEffect(() => setQuery(model.controls.q), [model.controls.q])
  const typed = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onSearch?.(query.trim()), 300)
    return () => clearTimeout(timer)
  }, [query])
  const quiet = model.repromise !== null || model.calculator !== null || model.dialog !== null

  // p re-promises the focused line; h opens its history.
  usePageKeys((event) => {
    if (quiet || event.metaKey || event.ctrlKey || event.altKey || !lines) return
    const key = event.key.toLowerCase()
    if (key !== 'p' && key !== 'h') return
    const focused = lines.find((line) => line.id === focusedRowId())
    if (!focused) return
    if (key === 'p' && !rowVerbOf(focused, model.can).held) {
      event.preventDefault()
      actions?.onRepromise?.(focused.id)
    } else if (key === 'h') {
      event.preventDefault()
      actions?.onHistory?.(focused.id)
    }
  })

  const day = (value: string | null) => dayWords(value, locale)
  const OrderCell = ({ data: line }: ICellRendererParams<PromiseLine>) => {
    if (!line) return null
    const href = orderHref(model.prefix, model.built, line.order)
    const doc = t('line.order', { order: line.order.number, line: line.seq })
    return (
      <span className="fw-pdt-cell">
        <span className="fw-pdt-nowrap">
          <Link className="fw-pdt-link fw-pdt-ellipsis" href={href} title={doc}>
            {doc}
          </Link>
          <a className="fw-pdt-newtab" href={href} target="_blank" rel="noreferrer" aria-label={t('line.newTab', { order: doc })} title={t('line.newTab', { order: doc })}>
            <ExternalLink size={12} aria-hidden />
          </a>
        </span>
        <span className="fw-pdt-sub fw-pdt-ellipsis">{line.customer.name}</span>
      </span>
    )
  }
  const StyleCell = ({ data: line }: ICellRendererParams<PromiseLine>) =>
    line ? (
      <span className="fw-pdt-cell" title={`${line.style.code} · ${line.style.name}`}>
        <span className="fw-pdt-ellipsis">
          {line.style.code} · {line.colourway.name}
        </span>
        <span className="fw-pdt-sub fw-pdt-ellipsis">{t('line.sizes', { sizes: sizesWords(line, t), count: openPieces(line) })}</span>
      </span>
    ) : null
  const CurrentCell = ({ data: line }: ICellRendererParams<PromiseLine>) =>
    line ? (
      <span className="fw-pdt-cell">
        <span>{day(line.current)}</span>
        {line.waiting ? (
          <span className="fw-pdt-sub">
            <Pill tone="info">{t('line.waiting', { day: day(line.waiting.sizes[0]?.to ?? null) })}</Pill>
          </span>
        ) : line.first && line.current && line.current !== line.first ? (
          <span className="fw-pdt-sub">{t('line.wasFirst', { day: day(line.first) })}</span>
        ) : null}
      </span>
    ) : null
  const FinishCell = ({ data: line }: ICellRendererParams<PromiseLine>) =>
    line ? (
      <span className="fw-pdt-cell">
        <span className={line.risk === 'LATE' || line.risk === 'AT_RISK' ? 'fw-pdt-late' : undefined}>{line.finish ? day(line.finish) : t('finish.unknown')}</span>
        <span className="fw-pdt-sub fw-pdt-ellipsis" title={t(`finish.${line.finishSource}`)}>
          {t(`finish.${line.finishSource}`)}
        </span>
      </span>
    ) : null
  const SlackCell = ({ data: line }: ICellRendererParams<PromiseLine>) =>
    line ? (
      <span className={line.slackDays !== null && line.slackDays < 0 ? 'fw-pdt-late' : undefined} title={slackWords(line.slackDays, t)}>
        {slackShort(line.slackDays, t)}
      </span>
    ) : null
  const RiskCell = ({ data: line }: ICellRendererParams<PromiseLine>) => (line ? <Pill tone={riskTone(line.risk)}>{t(riskKey(line.risk))}</Pill> : null)
  const CertificateCell = ({ data: line }: ICellRendererParams<PromiseLine>) =>
    line ? (
      <span className="fw-pdt-cell">
        <span className={certificateTone(line.certificate) === 'danger' ? 'fw-pdt-late fw-pdt-ellipsis' : 'fw-pdt-ellipsis'} title={certificateWords(line.certificate, words)}>
          {certificateWords(line.certificate, words)}
        </span>
        {line.certificate?.certificate ? <span className="fw-pdt-sub fw-pdt-ellipsis">{line.certificate.certificate}</span> : null}
      </span>
    ) : null
  const ChangesCell = ({ data: line }: ICellRendererParams<PromiseLine>) => {
    if (!line) return null
    const open = model.history?.lineId === line.id
    const label = t('history.trigger', { order: t('line.order', { order: line.order.number, line: line.seq }), changes: changesWords(line.changes, t) })
    return (
      <DetailPopover
        trigger={
          <span className="fw-pdt-cell">
            <span className="fw-pdt-changes">{t(line.changes.count === 0 ? 'changes.none' : 'changes.count', { count: line.changes.count })}</span>
            {line.changes.slips > 0 ? <span className="fw-pdt-sub fw-pdt-late">{t('changes.slips', { count: line.changes.slips })}</span> : null}
          </span>
        }
        triggerLabel={label}
        triggerClassName="fw-pdt-trigger"
        panelClassName="nds-detailpop-scroll"
        label={t('history.title', { order: t('line.order', { order: line.order.number, line: line.seq }) })}
        hoverDelay={0}
        open={open}
        onOpenChange={(next) => actions?.onHistory?.(next ? line.id : null)}
      >
        {open && model.history ? <HistoryPanel history={model.history} actions={actions} words={words} /> : null}
      </DetailPopover>
    )
  }
  const MoreCell = ({ data: line }: ICellRendererParams<PromiseLine>) => {
    if (!line) return null
    const verb = rowVerbOf(line, model.can)
    return (
      <Menu
        label={<MoreHorizontal size={16} aria-hidden />}
        align="right"
        triggerProps={{ 'aria-label': t('row.menu', { order: t('line.order', { order: line.order.number, line: line.seq }) }) }}
        items={[
          { id: 'repromise', label: verb.held ? `${t(verb.label)} — ${t(verb.held)}` : t(verb.label), onSelect: () => actions?.onRepromise?.(line.id), disabled: verb.held !== null },
          { id: 'history', label: t('row.history'), onSelect: () => actions?.onHistory?.(line.id) },
          { id: 'order', label: t('row.order'), href: orderHref(model.prefix, model.built, line.order) },
        ]}
      />
    )
  }
  const plain = { sortable: false, suppressHeaderMenuButton: true } as const
  const columns: ColDef<PromiseLine>[] = useMemo(
    () => [
      { ...plain, colId: 'order', headerName: t('col.order'), minWidth: 190, flex: 1.2, cellRenderer: OrderCell },
      { ...plain, colId: 'style', headerName: t('col.style'), minWidth: 160, flex: 1.2, cellRenderer: StyleCell },
      { ...plain, colId: 'first', headerName: t('col.first'), headerTooltip: t('col.firstHint'), minWidth: 110, flex: 0.7, valueGetter: (params) => (params.data ? day(params.data.first) : '') },
      { ...plain, colId: 'current', headerName: t('col.current'), minWidth: 120, flex: 0.9, cellRenderer: CurrentCell },
      { ...plain, colId: 'finish', headerName: t('col.finish'), minWidth: 130, flex: 0.9, cellRenderer: FinishCell },
      { ...plain, colId: 'slack', headerName: t('col.slack'), headerTooltip: t('col.slackHint'), minWidth: 95, flex: 0.7, cellRenderer: SlackCell },
      { ...plain, colId: 'risk', headerName: t('col.risk'), minWidth: 120, flex: 0.6, cellRenderer: RiskCell },
      { ...plain, colId: 'certificate', headerName: t('col.certificate'), headerTooltip: t('col.certificateHint'), minWidth: 160, flex: 1, cellRenderer: CertificateCell },
      { ...plain, colId: 'changes', headerName: t('col.changes'), minWidth: 120, flex: 0.8, cellRenderer: ChangesCell },
      { ...plain, colId: 'more', headerName: t('col.more'), minWidth: 56, maxWidth: 56, pinned: 'right', suppressMovable: true, cellRenderer: MoreCell },
    ],
    // The renderers read the model through the closure; a new model draws them again.
    [model, words],
  )

  const filtered = !!(model.controls.tile || model.controls.risk || model.controls.q.trim())
  let state: ReactNode = undefined
  if (model.list.status === 'error') {
    state = (
      <EmptyState
        title={t('lines.error')}
        description={t(model.list.problem)}
        action={
          <Button size="sm" onClick={() => actions?.onRetry?.('list')}>
            {t('common.retry')}
          </Button>
        }
      />
    )
  } else if (lines && lines.length === 0) {
    state = filtered ? (
      <EmptyState
        title={t('lines.noMatch')}
        description={t('lines.noMatchBody')}
        action={
          <Button
            size="sm"
            onClick={() => {
              setQuery('')
              actions?.onSearch?.('')
              actions?.onTile?.(null)
            }}
          >
            {t('common.clearFilters')}
          </Button>
        }
      />
    ) : (
      <EmptyState title={t('lines.empty')} description={t('lines.emptyBody')} />
    )
  }

  const picked = (lines ?? []).filter((line) => selected.includes(line.id))
  const tileChip = model.controls.tile ? (
    <Tag tone="info">
      <span className="fw-pdt-inline">
        {t(`tile.${model.controls.tile}`)}
        <Button size="xs" variant="quiet" aria-label={t('lines.clearTile')} onClick={() => actions?.onTile?.(null)}>
          <X size={12} aria-hidden />
        </Button>
      </span>
    </Tag>
  ) : null

  return (
    <ListFrame<PromiseLine>
      label={t('lines.title')}
      title={t('lines.title')}
      rows={state ? [] : lines}
      rowId={(line) => line.id}
      columns={columns}
      count={list ? t('lines.count', { count: list.lines.length }) : '—'}
      search={
        <Input
          size="sm"
          type="search"
          leadingIcon={<Search size={13} aria-hidden />}
          aria-label={t('lines.search')}
          placeholder={t('lines.search')}
          value={query}
          onChange={(event) => {
            typed.current = true
            setQuery(event.target.value)
          }}
        />
      }
      tools={
        <>
          <Select size="sm" aria-label={t('lines.risk')} value={model.controls.risk ?? ''} onChange={(event) => actions?.onRisk?.(isRisk(event.target.value) ? event.target.value : null)}>
            <option value="">{t('lines.allRisks')}</option>
            {RISK_STATES.map((risk) => (
              <option key={risk} value={risk}>
                {t(`risk.${risk}`)}
                {list ? ` (${list.counts[risk]})` : ''}
              </option>
            ))}
          </Select>
          {tileChip}
        </>
      }
      selection={{
        selected,
        onChange: setSelected,
        actions: (
          <Button size="sm" aria-label={t('bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((line) => line.id))}>
            <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count: picked.length })}</SelectionLabel>
          </Button>
        ),
      }}
      updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
      keys={OWN_KEYS(t)}
      onHelp={() => actions?.onKeys?.()}
      onOpen={(line) => actions?.onOpenOrder?.(orderHref(model.prefix, model.built, line.order))}
      state={state}
      focusRow={model.focusRow}
      keysOpen={model.keysOpen}
    />
  )
}
