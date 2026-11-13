'use client'

import { useMemo, useRef, type MouseEvent, type ReactNode } from 'react'
import { CalendarClock, Euro, Grid3x3, Percent, Trash2 } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../../list-frame/model'
import { money, percent, unitPrice, type Grains } from '../../../model'
import type { TableRow, Words } from '../model'
import { useDepthWords } from '../words'

export type BulkKind = 'price' | 'discount' | 'sizes' | 'delivery' | 'remove'

export interface LinesTableModel {
  /** null while the lines are read. */
  rows: TableRow[] | null
  currency: string
  priceBasis: 'NET' | 'GROSS'
  grains: Grains
  /** Why nothing may change (W1's `sales` read-only words), or null on a draft the person edits. */
  readOnly: Words | null
  selected: readonly string[]
  busy: boolean
}

export interface LinesTableActions {
  onSelect?: (ids: string[]) => void
  onOpen?: (lineId: string) => void
  onBulk?: (kind: BulkKind, ids: readonly string[]) => void
}

/**
 * Lines › Table view (design quote.lines.table, SAL-160): the same lines flat in the ONE list frame, for long quotes and
 * changes to many lines at once — Seq, style, colourway, kind, sizes, pieces, unit price, discount, net, VAT, unit cost
 * (cost grain), margin % (margin grain), the delivery schedule, warnings. Selected: Set price · Set discount · Change sizes
 * · Set delivery date · Remove, each through a review (old → new) before it writes. Enter opens the line drawer.
 */
export function LinesTable({ model, actions }: { model: LinesTableModel; actions?: LinesTableActions }) {
  const { t, sales, say } = useDepthWords()
  const locale = useLocale()
  const latest = useRef({ actions })
  latest.current = { actions }
  const { grains, currency } = model

  const columns = useMemo<ColDef<TableRow>[]>(() => {
    const open = (event: MouseEvent, id: string) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
      event.preventDefault()
      latest.current.actions?.onOpen?.(id)
    }
    const LineCell = ({ data }: ICellRendererParams<TableRow>) =>
      data ? (
        <button type="button" className="fw-qd-rowlink" onClick={(event) => open(event, data.id)} aria-label={t('table.openLine', { line: `${data.seq} ${data.style} ${data.colourway}` })}>
          <strong>{data.style}</strong> {data.styleName}
        </button>
      ) : null
    const MarginCell = ({ data }: ICellRendererParams<TableRow>) =>
      data ? (
        <span className="fw-q-inline">
          {percent(data.marginPct, locale)}
          {data.belowFloor ? <Tag tone="warning">{sales('lines.belowFloor')}</Tag> : null}
        </span>
      ) : null
    const DeliveryCell = ({ data }: ICellRendererParams<TableRow>) =>
      data ? <span className={data.delivery ? undefined : 'fw-q-hint'}>{data.delivery ? t(data.delivery.count > 1 ? 'table.deliveryMany' : 'table.deliveryOne', { date: formatDate(`${data.delivery.first}T12:00:00Z`, { locale }), count: data.delivery.count }) : t('table.atPromise')}</span> : null
    const WarnCell = ({ data }: ICellRendererParams<TableRow>) => (data && data.warnings > 0 ? <Tag tone="warning">{t('table.warnings', { count: data.warnings })}</Tag> : null)
    return [
      { colId: 'seq', headerName: t('table.col.seq'), width: 76, minWidth: 70, type: 'rightAligned', valueGetter: (params) => params.data?.seq ?? null },
      { colId: 'style', headerName: t('table.col.style'), minWidth: 200, flex: 1.6, valueGetter: (params) => (params.data ? `${params.data.style} ${params.data.styleName}` : ''), cellRenderer: LineCell },
      { colId: 'colourway', headerName: t('table.col.colourway'), minWidth: 140, flex: 1, valueGetter: (params) => (params.data ? `${params.data.colourway} · ${params.data.colourName}` : '') },
      { colId: 'kind', headerName: t('table.col.kind'), minWidth: 130, flex: 0.8, valueGetter: (params) => (params.data ? t(`table.kind.${params.data.kind}`) : '') },
      { colId: 'sizes', headerName: t('table.col.sizes'), minWidth: 200, flex: 1.6, valueGetter: (params) => params.data?.sizes || '—', wrapText: true, autoHeight: true },
      { colId: 'quantity', headerName: t('table.col.quantity'), width: 96, type: 'rightAligned', valueGetter: (params) => params.data?.quantity ?? null },
      ...(grains.price
        ? ([
            { colId: 'unitPrice', headerName: sales(model.priceBasis === 'GROSS' ? 'lines.col.unitGross' : 'lines.col.unitNet'), minWidth: 120, type: 'rightAligned', valueGetter: (params) => (params.data ? unitPrice(params.data.unitPrice, currency, locale) : '') },
            { colId: 'discount', headerName: t('table.col.discount'), minWidth: 100, type: 'rightAligned', valueGetter: (params) => (params.data?.discountPct ? percent(params.data.discountPct, locale) : '—') },
            { colId: 'net', headerName: sales('lines.col.net'), minWidth: 120, type: 'rightAligned', valueGetter: (params) => (params.data ? money(params.data.netAmount, currency, locale) : '') },
          ] satisfies ColDef<TableRow>[])
        : []),
      { colId: 'vat', headerName: t('table.col.vat'), minWidth: 90, valueGetter: (params) => (params.data ? (params.data.vat.nature ? params.data.vat.nature : percent(params.data.vat.rate, locale)) : '') },
      ...(grains.cost ? ([{ colId: 'unitCost', headerName: sales('lines.col.unitCost'), minWidth: 120, type: 'rightAligned', valueGetter: (params) => (params.data ? (params.data.costComplete ? unitPrice(params.data.unitCost, currency, locale) : sales('lines.costMissing')) : '') }] satisfies ColDef<TableRow>[]) : []),
      ...(grains.margin ? ([{ colId: 'margin', headerName: sales('lines.col.margin'), minWidth: 130, type: 'rightAligned', cellRenderer: MarginCell, valueGetter: (params) => params.data?.marginPct ?? null }] satisfies ColDef<TableRow>[]) : []),
      { colId: 'delivery', headerName: t('table.col.delivery'), minWidth: 160, flex: 1, cellRenderer: DeliveryCell, valueGetter: (params) => params.data?.delivery?.first ?? '' },
      { colId: 'warnings', headerName: t('table.col.warnings'), minWidth: 120, cellRenderer: WarnCell, valueGetter: (params) => params.data?.warnings ?? 0 },
    ]
  }, [t, sales, locale, grains.price, grains.cost, grains.margin, currency, model.priceBasis])

  const rows = model.rows
  const chosen = (rows ?? []).filter((row) => model.selected.includes(row.id))
  const sizeRun = chosen.filter((row) => row.kind === 'SIZE_GRID')
  const held = (kind: BulkKind): string | null => {
    if (model.readOnly) return say(model.readOnly)
    if (model.busy) return sales('held.busy')
    if ((kind === 'price' || kind === 'discount') && !grains.price) return t('held.noPrice')
    if (kind !== 'remove' && sizeRun.length === 0) return t('held.sizeRunOnly')
    return null
  }
  const reach = (kind: BulkKind) => (kind === 'remove' ? chosen.length : sizeRun.length)
  const bulkButton = (kind: BulkKind, icon: ReactNode, danger = false) => (
    <Button key={kind} size="sm" variant={danger ? 'danger-outline' : undefined} heldReason={held(kind)} onClick={() => actions?.onBulk?.(kind, kind === 'remove' ? chosen.map((row) => row.id) : sizeRun.map((row) => row.id))} aria-label={t(`table.bulk.${kind}`, { count: reach(kind) })}>
      {icon} <SelectionLabel>{t(`table.bulk.${kind}`, { count: reach(kind) })}</SelectionLabel>
    </Button>
  )
  const keys: ListKey[] = [{ keys: ['t'], does: t('keys.toggleView') }]
  return (
    <ListFrame<TableRow>
      label={t('table.label')}
      title={t('table.label')}
      listKey={null}
      rows={rows}
      rowId={(row) => row.id}
      columns={columns}
      count={rows ? t('table.count', { count: rows.length }) : t('common.loading')}
      selection={{
        selected: model.selected,
        onChange: (ids) => actions?.onSelect?.(ids),
        actions: (
          <>
            {bulkButton('price', <Euro size={13} aria-hidden />)}
            {bulkButton('discount', <Percent size={13} aria-hidden />)}
            {bulkButton('sizes', <Grid3x3 size={13} aria-hidden />)}
            {bulkButton('delivery', <CalendarClock size={13} aria-hidden />)}
            {bulkButton('remove', <Trash2 size={13} aria-hidden />, true)}
          </>
        ),
      }}
      keys={keys}
      onOpen={(row) => actions?.onOpen?.(row.id)}
      state={rows && rows.length === 0 ? <EmptyState title={sales('lines.empty.title')} description={sales(model.readOnly ? 'lines.empty.bodyReadOnly' : 'lines.empty.body')} /> : undefined}
    />
  )
}
