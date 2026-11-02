'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Download, MoreHorizontal, Printer, Search } from 'lucide-react'
import { Banner, EmptyState, Menu, MetricStrip } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { formatDateTime, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useScopedT, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys } from '../../../../list-frame/model'
import { WithMessages } from '../../../../record-panels/i18n'
import { siteColumn, useOfficeScope } from '../../../../shell/scope/scope-context'
import type { TrackedBundle } from '../api'
import type { BundlesActions, BundlesModel } from '../list-model'
import { BUNDLE_TILES, BUNDLE_VIEWS, BUNDLES_NAMESPACE, BUNDLES_NAMESPACES, reprintHeld, rowsOfView, stuckTile, type BundleView } from '../model'
import { ReprintDialog } from './BundleDialogs'
import { PlaceCell } from './parts'
import { FindingsDialog, ScanPatterns } from './ScanPatterns'
import '../../_shared/production.css'
import '../bundles.css'

export type { BundlesActions, BundlesModel } from '../list-model'

/**
 * SCR-259 — Bundles (Production › Cutting room; design production.bundles, MES-074, MES-075): the tiles (each a view of
 * Rows ▾), the scan-pattern checks, and every bundle with where it is now: search or scan a ticket (one hit opens it),
 * select-all and shift range, Reprint N tickets, live changes behind "N updates · Show". A row opens the Bundle record.
 * Places, operations and lines only: no person's output anywhere (Statuto dei Lavoratori art. 4).
 */
export function BundlesView({ model, actions }: { model: BundlesModel; actions?: BundlesActions }) {
  return (
    <WithMessages namespaces={BUNDLES_NAMESPACES}>
      <Bundles model={model} actions={actions} />
    </WithMessages>
  )
}

function Bundles({ model, actions }: { model: BundlesModel; actions?: BundlesActions }) {
  const t = useT(BUNDLES_NAMESPACE)
  const scoped = useScopedT(BUNDLES_NAMESPACE)
  const lists = useT('lists')
  const locale = useLocale()
  const scope = useOfficeScope()
  const [query, setQuery] = useState(model.q)
  useEffect(() => setQuery(model.q), [model.q])
  const typed = useRef(false)
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current.actions?.onSearch?.(query), 300)
    return () => clearTimeout(timer)
  }, [query])
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [help, setHelp] = useState(!!model.helpOpen)
  const items = useMemo(() => (model.rows.items ? rowsOfView(model.view, model.rows.items) : null), [model.rows.items, model.view])
  const rowsKey = items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  const picked = (items ?? []).filter((row) => selected.includes(row.id))

  const columns = useMemo<ColDef<TrackedBundle>[]>(() => {
    const href = (row: TrackedBundle) => `${model.prefix}/production/bundles/${row.id}`
    const CodeCell = ({ data }: ICellRendererParams<TrackedBundle>) =>
      data ? (
        <span className="fw-pr-cell">
          <Link className="fw-pr-link fw-pr-code" href={href(data)}>
            {data.code}
          </Link>
          {data.parentBundleId && <span className="fw-pr-cell-sub">{t('col.splitOff')}</span>}
        </span>
      ) : null
    const OrderCell = ({ data }: ICellRendererParams<TrackedBundle>) =>
      data ? (
        model.can.workOrders ? (
          <Link className="fw-pr-link" href={`${model.prefix}/production/work-orders/${data.workOrder.id}`}>
            {data.workOrder.number}
          </Link>
        ) : (
          <span>{data.workOrder.number}</span>
        )
      ) : null
    const StyleCell = ({ data }: ICellRendererParams<TrackedBundle>) =>
      data ? (
        <span className="fw-pr-cell">
          <span className="fw-pr-ellipsis">{data.style.code}</span>
          <span className="fw-pr-cell-sub">{data.style.name}</span>
        </span>
      ) : null
    const ColourCell = ({ data }: ICellRendererParams<TrackedBundle>) =>
      data ? (
        <span className="fw-pr-cell">
          <span>{data.colourwayCode}</span>
          <span className="fw-pr-cell-sub">{data.colourwayName}</span>
        </span>
      ) : null
    const WhereCell = ({ data }: ICellRendererParams<TrackedBundle>) => (data ? <PlaceCell row={data} /> : null)
    const LastCell = ({ data }: ICellRendererParams<TrackedBundle>) =>
      data ? (
        data.lastScan ? (
          <span className="fw-pr-cell">
            <span>{formatDateTime(data.lastScan.at, { locale })}</span>
            <span className="fw-pr-cell-sub">{[data.lastScan.operation ? `${data.lastScan.operation.seq} ${data.lastScan.operation.code}` : null, data.lastScan.station?.code].filter(Boolean).join(' · ')}</span>
          </span>
        ) : (
          <span>{t('col.noScan')}</span>
        )
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<TrackedBundle>) => (data ? <Pill tone={data.status === 'ACTIVE' ? 'success' : 'neutral'}>{t(`status.${data.status}`)}</Pill> : null)
    const HidesCell = ({ data }: ICellRendererParams<TrackedBundle>) => (data ? <span className="fw-pr-ellipsis">{data.hides.map((hide) => `${hide.code} (${hide.lotCode})`).join(', ') || '—'}</span> : null)
    const MoreCell = ({ data }: ICellRendererParams<TrackedBundle>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { code: data.code }) }}
          items={[
            { id: 'open', label: t('list.open'), href: href(data) },
            { id: 'tab', label: t('list.openNewTab'), href: href(data), target: '_blank' },
            ...(model.can.workOrders ? [{ id: 'order', label: t('list.openWorkOrder'), href: `${model.prefix}/production/work-orders/${data.workOrder.id}?tab=bundles` }] : []),
            { id: 'ticket', label: t('ticket.pdf'), ...(model.can.printLabels ? { href: `${href(data)}/ticket`, target: '_blank' as const } : { disabled: true, description: t('held.noPrint', { permission: 'print.labels' }) }) },
          ]}
        />
      ) : null
    const site = siteColumn<TrackedBundle>(scope, (row) => row.siteId, t('col.site'))
    return [
      { colId: 'code', headerName: t('col.bundle'), field: 'code', minWidth: 140, flex: 1, cellRenderer: CodeCell },
      { colId: 'workOrder', headerName: t('col.workOrder'), minWidth: 150, flex: 0.9, cellRenderer: OrderCell },
      { colId: 'style', headerName: t('col.style'), minWidth: 150, flex: 1.2, cellRenderer: StyleCell },
      { colId: 'colour', headerName: t('col.colour'), minWidth: 104, flex: 0.7, cellRenderer: ColourCell },
      { colId: 'size', headerName: t('col.size'), field: 'size', minWidth: 96, flex: 0.4 },
      { colId: 'part', headerName: t('col.part'), minWidth: 100, flex: 0.7, valueGetter: (params) => params.data?.part ?? t('col.whole') },
      { colId: 'pieces', headerName: t('col.pieces'), field: 'quantity', minWidth: 96, flex: 0.4, type: 'rightAligned' },
      { colId: 'place', headerName: t('col.place'), minWidth: 190, flex: 1.5, cellRenderer: WhereCell },
      { colId: 'lastScan', headerName: t('col.lastScan'), minWidth: 170, flex: 1.1, cellRenderer: LastCell },
      { colId: 'status', headerName: t('col.status'), minWidth: 104, flex: 0.5, cellRenderer: StatusCell },
      { colId: 'replaced', headerName: t('col.replaced'), minWidth: 120, flex: 0.7, valueGetter: (params) => params.data?.replacedCodes.join(', ') || '—' },
      { colId: 'hides', headerName: t('col.hides'), minWidth: 150, flex: 1, cellRenderer: HidesCell },
      ...(site ? [site] : []),
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, model.prefix, model.can, scope])

  if (!model.can.view) {
    return <EmptyState title={t('noAccess.title')} description={t('noAccess.body', { permission: 'production.bundles.view' })} />
  }

  const filtered = model.q.trim() !== '' || model.view !== 'active'
  const state = model.rows.problem ? (
    <EmptyState title={t('list.failed')} description={scoped(`production:${model.rows.problem}`)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
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
              actions?.onView?.('all')
            }}
          >
            {t('list.clearFilters')}
          </Button>
        }
      />
    ) : (
      <EmptyState title={t('list.empty.title')} description={t('list.empty.body')} />
    )
  ) : undefined

  const held = reprintHeld(picked, model.can)
  const reprintWords = picked.length > 0 ? t('list.reprint', { count: picked.length }) : t('list.reprintNone')

  return (
    <div className="fw-pr">
      <div className="fw-pr-head">
        <div className="fw-pr-head-text">
          <span className="fw-pr-status" role="status">
            {model.asOf ? t('list.updated', { time: formatTime(model.asOf, { locale }) }) : t('list.notYet')}
            {' · '}
            {t(`live.${model.live}`)}
          </span>
        </div>
        <Button size="sm" variant="primary" heldReason={held ? t(held.key, held.params) : null} onClick={() => actions?.onReprintMany?.(picked.map((row) => row.id))}>
          <Printer size={14} aria-hidden /> {reprintWords}
        </Button>
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={scoped(model.notice.words.key, model.notice.words.params)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('common.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}
      {model.tiles?.capped && <Banner tone="warning" title={t('tile.capped')} />}

      <MetricStrip
        metrics={BUNDLE_TILES.map((tile) => {
          const words = tile.id === 'stuck' ? stuckTile(model.tiles) : { key: `tile.${tile.id}` }
          const view = tile.view as BundleView | null
          return {
            label: t(words.key, 'params' in words ? words.params : undefined),
            value: model.tiles ? String(tile.count(model.tiles)) : '—',
            ...(view ? { onClick: () => actions?.onView?.(model.view === view ? 'active' : view), active: model.view === view } : {}),
          }
        })}
      />

      <ScanPatterns model={model} actions={actions} />

      <ListFrame<TrackedBundle>
        label={t('list.table')}
        rows={state ? [] : items}
        rowId={(row) => row.id}
        columns={columns}
        count={items ? t(model.rows.more ? 'list.countMore' : 'list.count', { count: items.length }) : '—'}
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
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                typed.current = false
                actions?.onScan?.(query)
              }
            }}
          />
        }
        tools={
          <Select size="sm" aria-label={t('list.viewLabel')} value={model.view} onChange={(event) => actions?.onView?.(event.target.value as BundleView)}>
            {BUNDLE_VIEWS.map((view) => (
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
            <>
              <Button size="sm" aria-label={t('list.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('list.export', { count: picked.length })}</SelectionLabel>
              </Button>
              <Button size="sm" variant="primary" aria-label={reprintWords} heldReason={held ? t(held.key, held.params) : null} onClick={() => actions?.onReprintMany?.(picked.map((row) => row.id))}>
                <Printer size={13} aria-hidden /> <SelectionLabel>{reprintWords}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.rows.more && model.rows.items?.length ? { label: t('list.more'), onMore: () => actions?.onMore?.() } : null}
        onHelp={() => setHelp(true)}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
        focusRow={model.focusRow}
        cards={{ hrefOf: (row) => `${model.prefix}/production/bundles/${row.id}` }}
      />

      {model.findings && <FindingsDialog model={model} dialog={model.findings} actions={actions} />}
      {model.reprint && (
        <ReprintDialog
          run={model.reprint}
          prefix={model.prefix}
          onRun={actions?.onRunReprint}
          onClose={() => {
            if (model.reprint?.done) setSelected([])
            actions?.onCloseReprint?.()
          }}
        />
      )}
      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('list.keysTitle')} size="sm">
          <ul className="fw-pr-list">
            {listKeys([], true).map((entry) => (
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
