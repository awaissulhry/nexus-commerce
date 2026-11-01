'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Download, MoreHorizontal, PackageCheck, Search, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, MetricStrip } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../../list-frame/model'
import { formatDate, formatDateTime, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayAt, money, quantity } from '../../../../_shared/buying/model'
import type { ExpectedLine, ReceiptRow } from '../../api'
import { DAILY_VIEWS, RECEIPT_TILES, RECEIPT_TONE, RECEIPT_VIEWS, receiveSelection, type ReceiptsListActions, type ReceiptsListModel, type ReceiptView } from '../../model'
import { NAMESPACE as DAILY } from '../../daily-model'
import { HideListImport, HideListTotals } from './HideList'
import '../../../../_shared/buying/buying.css'

export type { ReceiptsListActions, ReceiptsListModel } from '../../model'

/**
 * SCR-063 — Receipts (Warehouse › Inbound; design warehouse.receipts, 00 §2.1 list frame): the tiles (expected order
 * lines, posted today, posted with a lot still in quarantine, reversed — each a saved view), and on the shared list
 * frame either the order lines still to receive (Expected: open quantity, tolerance, ≈ hides, Cr VI, due date; Receive
 * opens the receiving page with that order, a selection receives several lines of one order) or the receipts (number,
 * supplier, PO, the supplier's DDT, lots released of all, hides and quantities, value with the cost grain). `/`
 * searches a receipt or DDT number; `c` receives goods.
 */
export function ReceiptsListView({ model, actions }: { model: ReceiptsListModel; actions?: ReceiptsListActions }) {
  return (
    <WithMessages namespaces={['buying', 'lists', DAILY]}>
      <ReceiptsList model={model} actions={actions} />
    </WithMessages>
  )
}

function ReceiptsList({ model, actions }: { model: ReceiptsListModel; actions?: ReceiptsListActions }) {
  const t = useT('buying')
  const td = useT(DAILY)
  // B-W2a-63: the W2a view's words are this step's catalogue's.
  const viewWord = (view: ReceiptView) => (DAILY_VIEWS.includes(view) ? td(`view.${view}`) : t(`rc.view.${view}`))
  const lists = useT('lists')
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
  const [help, setHelp] = useState(!!model.helpOpen)
  const expectedView = model.view === 'expected'
  const rowsKey = (expectedView ? model.expected.items?.map((line) => line.purchaseOrderLineId) : model.rows.items?.map((row) => row.id))?.join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  useEffect(() => setSelected(model.selected ?? []), [model.selected, model.view])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || help) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      if (event.key === 'c' && model.can.receive) {
        event.preventDefault()
        actions?.onReceive?.(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('rc.list.keyReceive') }]

  const receiptColumns = useMemo<ColDef<ReceiptRow>[]>(() => {
    const href = (row: ReceiptRow) => `${model.prefix}/warehouse/receipts/${row.id}`
    const NumberCell = ({ data }: ICellRendererParams<ReceiptRow>) =>
      data ? (
        <span className="fw-by-cell">
          <Link className="fw-by-link" href={href(data)}>
            {data.number}
          </Link>
          <span className="fw-by-cell-sub">{formatDateTime(data.receivedAt, place)}</span>
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<ReceiptRow>) => (data ? <Pill tone={RECEIPT_TONE[data.status]}>{t(`rcStatus.${data.status}`)}</Pill> : null)
    const OrderCell = ({ data }: ICellRendererParams<ReceiptRow>) =>
      data ? (
        <span className="fw-by-cell">
          <span className="fw-by-ellipsis">{data.supplier.name}</span>
          {data.purchaseOrder ? (
            <Link className="fw-by-link fw-by-cell-sub" href={`${model.prefix}/purchasing/orders/${data.purchaseOrder.id}`}>
              {data.purchaseOrder.number}
            </Link>
          ) : (
            <span className="fw-by-cell-sub">{t('rc.noOrder')}</span>
          )}
        </span>
      ) : null
    const DdtCell = ({ data }: ICellRendererParams<ReceiptRow>) =>
      data ? data.supplierDdtNumber ? <span className="fw-by-ellipsis">{t('rc.ddt', { number: data.supplierDdtNumber, date: data.supplierDdtDate ? formatDate(dayAt(data.supplierDdtDate), place) : '—' })}</span> : <span className="fw-by-warning">{t('rc.noDdt')}</span> : null
    const LotsCell = ({ data }: ICellRendererParams<ReceiptRow>) =>
      data ? (
        <span className="fw-by-cell">
          <span className={data.lots > data.lotsReleased && data.status === 'POSTED' ? 'fw-by-warning' : undefined}>{data.lots === 0 ? t('rc.noLots') : t('rc.lotsReleased', { released: data.lotsReleased, count: data.lots })}</span>
          <span className="fw-by-cell-sub">{data.hides > 0 ? t('rc.hides', { count: data.hides }) : ''}</span>
        </span>
      ) : null
    // B-W2a-63 (design rc-grid "Discrepancies (W2a)"): not closed yet (warning), else how many were recorded.
    const DiscrepanciesCell = ({ data }: ICellRendererParams<ReceiptRow>) => {
      const counts = data?.discrepancies
      if (!data || !counts || counts.count === 0) return data ? <span className="fw-by-cell-sub">—</span> : null
      return (
        <Link className={counts.open > 0 ? 'fw-by-link fw-by-warning' : 'fw-by-link'} href={`${href(data)}?tab=discrepancies`}>
          {counts.open > 0 ? td('list.discOpen', { count: counts.open, unsent: counts.unsent }) : td('list.discClosed', { count: counts.count })}
        </Link>
      )
    }
    const QuantityCell = ({ data }: ICellRendererParams<ReceiptRow>) => (data ? <span className="fw-by-num">{data.quantities.map((entry) => `${quantity(entry.baseQuantity, locale)} ${t(`uom.${entry.uom}`)}`).join(' · ') || '—'}</span> : null)
    const ValueCell = ({ data }: ICellRendererParams<ReceiptRow>) => (data ? <span className="fw-by-num">{data.value ? money(data.value.valueAmount, data.value.currency, locale) : '—'}</span> : null)
    const MoreCell = ({ data }: ICellRendererParams<ReceiptRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('rc.list.rowMenu', { number: data.number }) }}
          items={[
            { id: 'open', label: t('common.open'), href: href(data) },
            { id: 'tab', label: t('common.openNewTab'), href: href(data), target: '_blank' },
            { id: 'lots', label: t('rc.tab.lots'), href: `${href(data)}?tab=lots` },
            { id: 'discrepancies', label: td('tab.discrepancies'), href: `${href(data)}?tab=discrepancies` },
            ...(data.purchaseOrder ? [{ id: 'po', label: t('rc.openOrder', { number: data.purchaseOrder.number }), href: `${model.prefix}/purchasing/orders/${data.purchaseOrder.id}` }] : []),
          ]}
        />
      ) : null
    return [
      { colId: 'number', headerName: t('rc.col.number'), minWidth: 160, flex: 1.1, cellRenderer: NumberCell },
      { colId: 'status', headerName: t('rc.col.status'), minWidth: 110, flex: 0.7, cellRenderer: StatusCell },
      { colId: 'order', headerName: t('rc.col.supplier'), minWidth: 190, flex: 1.5, cellRenderer: OrderCell },
      { colId: 'ddt', headerName: t('rc.col.ddt'), minWidth: 170, flex: 1.1, cellRenderer: DdtCell },
      { colId: 'lines', headerName: t('rc.col.lines'), field: 'lines', minWidth: 70, flex: 0.4, type: 'rightAligned' },
      { colId: 'lots', headerName: t('rc.col.lots'), minWidth: 150, flex: 1, cellRenderer: LotsCell },
      { colId: 'discrepancies', headerName: td('col.discrepancies'), minWidth: 140, flex: 0.8, cellRenderer: DiscrepanciesCell },
      { colId: 'quantity', headerName: t('rc.col.quantity'), minWidth: 150, flex: 1, cellRenderer: QuantityCell },
      ...(model.can.cost ? [{ colId: 'value', headerName: t('rc.col.value'), minWidth: 110, flex: 0.7, type: 'rightAligned', cellRenderer: ValueCell } satisfies ColDef<ReceiptRow>] : []),
      { colId: 'more', headerName: t('rc.col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, td, locale, model.prefix, model.can.cost])

  const expectedColumns = useMemo<ColDef<ExpectedLine>[]>(() => {
    const OrderCell = ({ data }: ICellRendererParams<ExpectedLine>) =>
      data ? (
        <span className="fw-by-cell">
          <Link className="fw-by-link" href={`${model.prefix}/purchasing/orders/${data.purchaseOrderId}`}>
            {data.number} · {t('rc.lineSeq', { seq: data.seq })}
          </Link>
          <span className="fw-by-cell-sub">{data.supplier.name}</span>
        </span>
      ) : null
    const MaterialCell = ({ data }: ICellRendererParams<ExpectedLine>) =>
      data ? (
        <span className="fw-by-cell">
          <span className="fw-by-ellipsis">
            {data.item.code} · {data.item.name}
          </span>
          <span className="fw-by-cell-sub">{[data.colour ? `${data.colour.code} ${data.colour.name}` : null, t(`rc.tracking.${data.item.tracking}`), data.requiresCrViTest ? t('plan.crVi') : null].filter(Boolean).join(' · ')}</span>
        </span>
      ) : null
    const OpenCell = ({ data }: ICellRendererParams<ExpectedLine>) =>
      data ? (
        <span className="fw-by-cell">
          <span className="fw-by-num">
            {quantity(data.open, locale)} {t(`uom.${data.item.baseUom}`)}
          </span>
          <span className="fw-by-cell-sub">{t('rc.ofExpected', { received: quantity(data.received, locale), expected: quantity(data.expected, locale) })}</span>
        </span>
      ) : null
    const ToleranceCell = ({ data }: ICellRendererParams<ExpectedLine>) =>
      data ? (
        <span className="fw-by-cell">
          <span>{data.tolerancePct ? t('rc.tolerance', { pct: data.tolerancePct }) : t('rc.noTolerance')}</span>
          <span className="fw-by-cell-sub">{data.estimatedHides !== null ? t('plan.hides', { count: data.estimatedHides }) : ''}</span>
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<ExpectedLine>) => (data ? <Tag tone={data.status === 'CONFIRMED' ? 'success' : data.status === 'PARTLY_RECEIVED' ? 'info' : 'neutral'}>{t(`poStatus.${data.status}`)}</Tag> : null)
    const ReceiveCell = ({ data }: ICellRendererParams<ExpectedLine>) =>
      data ? (
        <Button size="sm" heldReason={model.can.receive ? null : t('held.noReceive')} onClick={() => actions?.onReceive?.(data.purchaseOrderId, [data.purchaseOrderLineId])} aria-label={t('rc.receiveLine', { number: data.number, seq: data.seq })}>
          <PackageCheck size={13} aria-hidden /> {t('rc.receiveShort')}
        </Button>
      ) : null
    return [
      { colId: 'order', headerName: t('rc.col.order'), minWidth: 180, flex: 1.2, cellRenderer: OrderCell },
      { colId: 'material', headerName: t('rc.col.material'), minWidth: 210, flex: 1.6, cellRenderer: MaterialCell },
      { colId: 'open', headerName: t('rc.col.open'), minWidth: 150, flex: 1, cellRenderer: OpenCell },
      { colId: 'tolerance', headerName: t('rc.col.tolerance'), minWidth: 130, flex: 0.8, cellRenderer: ToleranceCell },
      { colId: 'due', headerName: t('rc.col.due'), minWidth: 110, flex: 0.7, valueGetter: (params) => (params.data ? formatDate(dayAt(params.data.needDate), place) : '') },
      { colId: 'status', headerName: t('rc.col.orderStatus'), minWidth: 130, flex: 0.8, cellRenderer: StatusCell },
      { colId: 'receive', headerName: t('rc.col.receive'), minWidth: 120, maxWidth: 130, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, cellRenderer: ReceiveCell },
    ]
  }, [t, locale, model.prefix, model.can.receive])

  if (!model.can.stockView) {
    return (
      <div className="fw-by">
        <Card padded>
          <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('rc.noAccess.title')} description={t('rc.noAccess.body')} />
        </Card>
      </div>
    )
  }

  const tiles = RECEIPT_TILES.filter((tile) => !tile.needs || model.can[tile.needs])
  const tileView = tiles.find((tile) => tile.view === model.view)?.view ?? null
  const expectedCount = model.expected.items ? model.expected.items.length : null
  const pickedLines = (model.expected.items ?? []).filter((line) => selected.includes(line.purchaseOrderLineId))
  const pickedReceipts = (model.rows.items ?? []).filter((row) => selected.includes(row.id))
  const selection = receiveSelection(pickedLines)

  const filtered = model.q.trim() !== '' || (model.view !== 'all' && model.view !== 'expected')
  const clearFilters = (
    <Button
      size="sm"
      onClick={() => {
        setQuery('')
        actions?.onSearch?.('')
        actions?.onView?.('all')
      }}
    >
      {t('common.clearFilters')}
    </Button>
  )
  const receiptState = model.rows.problem ? (
    <EmptyState title={t('rc.list.failed')} description={t(model.rows.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : model.rows.items && model.rows.items.length === 0 ? (
    filtered ? (
      <EmptyState title={t('rc.list.noMatch.title')} description={t('rc.list.noMatch.body')} action={clearFilters} />
    ) : (
      <EmptyState
        title={t('rc.list.empty.title')}
        description={t('rc.list.empty.body')}
        action={
          model.can.receive ? (
            <Button size="sm" variant="primary" onClick={() => actions?.onReceive?.(null)}>
              <PackageCheck size={14} aria-hidden /> {t('rc.list.receive')}
            </Button>
          ) : undefined
        }
      />
    )
  ) : undefined
  const expectedState = model.expected.problem ? (
    <EmptyState title={t('rc.expected.failed')} description={t(model.expected.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : model.expected.items && model.expected.items.length === 0 ? (
    <EmptyState title={t('rc.expected.empty.title')} description={t('rc.expected.empty.body')} />
  ) : undefined

  const search = (
    <Input
      size="sm"
      type="search"
      leadingIcon={<Search size={13} aria-hidden />}
      aria-label={t('rc.list.search')}
      placeholder={t(expectedView ? 'rc.list.searchExpected' : 'rc.list.search')}
      value={query}
      onChange={(event) => {
        typed.current = true
        setQuery(event.target.value)
      }}
    />
  )
  const tools = (
    <Select size="sm" aria-label={t('rc.list.viewLabel')} value={model.view} onChange={(event) => actions?.onView?.(event.target.value as ReceiptView)}>
      {RECEIPT_VIEWS.filter((view) => view !== 'expected' || model.can.receive).map((view) => (
        <option key={view} value={view}>
          {viewWord(view)}
        </option>
      ))}
    </Select>
  )
  const expectedRows = (model.expected.items ?? []).filter((line) => {
    const needle = model.q.trim().toLowerCase()
    return !needle || [line.number, line.supplier.name, line.item.code, line.item.name, line.colour?.name].filter(Boolean).some((text) => text!.toLowerCase().includes(needle))
  })

  return (
    <div className="fw-by">
      <div className="fw-by-head">
        <span className="fw-by-status" role="status">
          {model.asOf ? t('common.updated', { time: formatTime(model.asOf, place) }) : t('common.notYet')}
          {' · '}
          {t(`live.${model.live}`)}
        </span>
        <span className="fw-by-actions">
          {model.hideList && <HideListImport model={model.hideList} actions={actions?.hideList} />}
          <Button size="sm" variant="primary" heldReason={model.can.receive ? null : t('held.noReceive')} onClick={() => actions?.onReceive?.(null)} aria-keyshortcuts="c">
            <PackageCheck size={14} aria-hidden /> {t('rc.list.receive')}
          </Button>
        </span>
      </div>
      {model.hideList?.summary && <HideListTotals model={model.hideList} actions={actions?.hideList} prefix={model.prefix} />}

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.words.key, model.notice.words.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}

      <MetricStrip
        metrics={tiles.map((tile) => {
          const count = tile.count(model.counts, expectedCount)
          return {
            label: tile.daily ? td(`tile.${tile.id}`) : t(`rc.tile.${tile.id}`),
            value: count === null ? '—' : String(count),
            onClick: () => actions?.onView?.(model.view === tile.view ? 'all' : tile.view),
            active: tileView === tile.view,
          }
        })}
      />

      {expectedView ? (
        <ListFrame<ExpectedLine>
          key="expected"
          label={t('rc.expected.tableLabel')}
          rows={expectedState ? [] : model.expected.items === null ? null : expectedRows}
          rowId={(line) => line.purchaseOrderLineId}
          columns={expectedColumns}
          count={model.expected.items ? t('rc.expected.count', { count: expectedRows.length }) : '—'}
          search={search}
          tools={tools}
          selection={{
            selected,
            onChange: setSelected,
            actions: (
              <Button
                size="sm"
                variant="primary"
                aria-label={t('rc.bulk.receive', { count: pickedLines.length })}
                heldReason={!model.can.receive ? t('held.noReceive') : selection.held === 'several' ? t('rc.bulk.oneOrder') : null}
                onClick={() => selection.orderId && actions?.onReceive?.(selection.orderId, pickedLines.map((line) => line.purchaseOrderLineId))}
              >
                <PackageCheck size={13} aria-hidden /> <SelectionLabel>{t('rc.bulk.receive', { count: pickedLines.length })}</SelectionLabel>
              </Button>
            ),
          }}
          keys={ownKeys}
          onHelp={() => setHelp(true)}
          onOpen={(line) => actions?.onReceive?.(line.purchaseOrderId, [line.purchaseOrderLineId])}
          state={expectedState ?? (expectedRows.length === 0 && model.expected.items ? <EmptyState title={t('rc.list.noMatch.title')} description={t('rc.list.noMatch.body')} action={clearFilters} /> : undefined)}
          focusRow={model.focusRow}
        />
      ) : (
        <ListFrame<ReceiptRow>
          key="receipts"
          label={t('rc.list.tableLabel')}
          rows={receiptState ? [] : model.rows.items}
          rowId={(row) => row.id}
          columns={receiptColumns}
          count={model.rows.items ? t(model.rows.more ? 'common.countMore' : 'common.count', { count: model.rows.items.length }) : '—'}
          search={search}
          tools={tools}
          selection={{
            selected,
            onChange: setSelected,
            actions: (
              <Button size="sm" aria-label={t('rc.bulk.export', { count: pickedReceipts.length })} onClick={() => actions?.onExport?.(pickedReceipts.map((row) => row.id))}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('rc.bulk.export', { count: pickedReceipts.length })}</SelectionLabel>
              </Button>
            ),
          }}
          updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
          more={model.rows.more && model.rows.items && model.rows.items.length > 0 ? { label: t('common.more'), onMore: () => actions?.onMore?.() } : null}
          keys={ownKeys}
          onHelp={() => setHelp(true)}
          onOpen={(row) => actions?.onOpen?.(row.id)}
          state={receiptState}
          focusRow={model.focusRow}
        />
      )}
      {model.view !== (model.can.receive ? 'expected' : 'all') && <p className="fw-by-hint">{t('rc.list.viewing', { view: viewWord(model.view) })}</p>}

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
