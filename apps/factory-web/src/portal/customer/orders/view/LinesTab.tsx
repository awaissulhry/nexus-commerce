'use client'

import { useMemo, useRef } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { Card, Disclosure, Menu, SummaryTable, type MenuItemDef } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { OrderLine, OrderRecord } from '../api'
import { linePromise, pieceCount, totalsOf, unitPriceText } from '../model'
import { useOrderWords } from '../words'
import { PricesNote, SizeRunTable } from './parts'
import type { OrderRecordActions, OrderRecordViewModel } from './OrderRecordView'

/**
 * Order › Lines (design rec "Order" tab lines: "What you ordered", "Totals"): every line in the shared list frame (read-only:
 * no action applies to several lines; cards on a phone) with its pieces ordered / shipped / open, its price and amount (price
 * grain), its own promise when it differs; a made-to-measure line names the rider and the measurement revision. Each
 * line's size run below (opened from the row's ⋯ or the address's `line=`), then the totals as agreed.
 */
export function LinesTab({ model, record, actions }: { model: OrderRecordViewModel; record: OrderRecord; actions?: OrderRecordActions }) {
  const words = useOrderWords()
  const { t, locale, day } = words
  const latest = useRef({ model, actions, record })
  latest.current = { model, actions, record }
  const seesPrices = record.seesPrices
  const currency = record.order.currency

  const columns = useMemo((): ColDef<OrderLine>[] => {
    const LineCell = ({ data }: ICellRendererParams<OrderLine>) => (data ? <span className="fw-pord-num">{data.seq}</span> : null)
    const StyleCell = ({ data }: ICellRendererParams<OrderLine>) => {
      if (!data) return null
      return (
        <span className="fw-pord-stack">
          <span className="fw-pord-strong">{data.style ? `${data.style.code} · ${data.style.name}` : (data.description ?? '—')}</span>
          {data.measurement ? <span className="fw-pord-sub">{t('lines.mtm', { rider: data.measurement.riderName, revision: data.measurement.revision })}</span> : null}
        </span>
      )
    }
    const ColourCell = ({ data }: ICellRendererParams<OrderLine>) => (data ? <span>{data.colourway ? `${data.colourway.name} (${data.colourway.code})` : '—'}</span> : null)
    const PiecesCell = ({ data }: ICellRendererParams<OrderLine>) =>
      data ? (
        <span className="fw-pord-stack">
          <span>{t('lines.pieces', { shipped: data.pieces.shipped, ordered: data.pieces.ordered })}</span>
          {data.closedShort ? <span className="fw-pord-sub">{t('lines.closedShort', { count: data.closedShort.quantity })}</span> : null}
        </span>
      ) : null
    const OpenCell = ({ data }: ICellRendererParams<OrderLine>) => (data ? <span className={data.pieces.open === 0 ? 'fw-pord-sub' : undefined}>{data.pieces.open}</span> : null)
    const PriceCell = ({ data }: ICellRendererParams<OrderLine>) => (data ? <span className="fw-pord-num">{unitPriceText(data.unitPrice, currency, locale) ?? '—'}</span> : null)
    const AmountCell = ({ data }: ICellRendererParams<OrderLine>) => (data ? <span className="fw-pord-num">{words.money(data.netAmount, currency)}</span> : null)
    const PromiseCell = ({ data }: ICellRendererParams<OrderLine>) => {
      if (!data) return null
      const own = linePromise(data, latest.current.record.order)
      return <span className={own ? undefined : 'fw-pord-sub'}>{own ? day(own) : t('lines.asOrder')}</span>
    }
    const MoreCell = ({ data }: ICellRendererParams<OrderLine>) => {
      if (!data) return null
      const now = latest.current
      const items: MenuItemDef[] = [
        { id: 'sizes', label: t('lines.showSizes'), onSelect: () => now.actions?.onLine?.(data.id) },
        { id: 'change', label: t('lines.askChange'), disabled: now.model.changeHeld !== null, description: now.model.changeHeld ?? undefined, onSelect: () => now.actions?.onChangeLine?.(data.id) },
        // B-W2b-194: Reorder this line (a size-grid line; New order copies it at today's prices).
        ...(now.model.reorderHref && data.style && !data.measurement ? [{ id: 'reorder', label: t('lines.reorder'), href: `${now.model.reorderHref}&line=${encodeURIComponent(data.id)}` }] : []),
      ]
      return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('lines.menu', { seq: data.seq }) }} items={items} />
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<OrderLine>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number; maxWidth?: number }): ColDef<OrderLine> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    return [
      { ...column('style', t('lines.col.style'), StyleCell, { flex: 1.6, minWidth: 220 }), valueGetter: ({ data }) => (data?.style ? `${data.style.code} · ${data.style.name}` : (data?.description ?? '')) },
      { ...column('seq', t('lines.col.line'), LineCell, { width: 80, minWidth: 70 }), valueGetter: ({ data }) => (data ? String(data.seq) : '') },
      { ...column('colour', t('lines.col.colour'), ColourCell, { flex: 1, minWidth: 150 }), valueGetter: ({ data }) => data?.colourway?.name ?? '' },
      { ...column('pieces', t('lines.col.pieces'), PiecesCell, { flex: 1, minWidth: 150 }), valueGetter: ({ data }) => (data ? t('lines.pieces', { shipped: data.pieces.shipped, ordered: data.pieces.ordered }) : '') },
      { ...column('open', t('lines.col.open'), OpenCell, { flex: 0.5, minWidth: 90 }), valueGetter: ({ data }) => (data ? String(data.pieces.open) : '') },
      ...(seesPrices
        ? [
            { ...column('price', t('lines.col.price'), PriceCell, { flex: 0.7, minWidth: 110 }), valueGetter: ({ data }: { data?: OrderLine }) => (data ? (unitPriceText(data.unitPrice, currency, locale) ?? '') : '') },
            { ...column('amount', t('lines.col.amount'), AmountCell, { flex: 0.8, minWidth: 120 }), valueGetter: ({ data }: { data?: OrderLine }) => (data ? words.money(data.netAmount, currency) : '') },
          ]
        : []),
      { ...column('promise', t('lines.col.promise'), PromiseCell, { flex: 0.8, minWidth: 130 }), valueGetter: ({ data }) => (data && linePromise(data, latest.current.record.order) ? day(linePromise(data, latest.current.record.order)!) : '') },
      { ...column('actions', t('col.actions'), MoreCell, { width: 72, minWidth: 72, maxWidth: 72 }), pinned: 'right', suppressHeaderMenuButton: true },
    ]
  }, [t, locale, day, words, seesPrices, currency])

  const totals = seesPrices ? totalsOf(record) : null
  return (
    <div className="fw-pord-tab">
      <h2 className="fw-pord-h2">{t('lines.title')}</h2>
      {!seesPrices ? <PricesNote /> : null}
      <ListFrame<OrderLine> label={t('lines.label')} title={t('lines.title')} listKey={null} rows={record.lines} rowId={(line) => line.id} columns={columns} count={t('lines.count', { count: record.lines.length, pieces: pieceCount(record.pieces.ordered, locale) })} onOpen={(line) => actions?.onLine?.(line.id)} />
      <section className="fw-pord-section" aria-labelledby="fw-pord-sizes">
        <h2 id="fw-pord-sizes" className="fw-pord-h2">
          {t('lines.sizesTitle')}
        </h2>
        {record.lines.map((line) => (
          <Disclosure key={line.id} id={`line-${line.id}`} open={model.openLine === line.id ? true : undefined} summary={t('lines.sizesOf', { seq: line.seq, style: line.style?.code ?? line.description ?? '—', colour: line.colourway?.name ?? '' })}>
            {line.kind === 'MADE_TO_MEASURE' ? (
              <p className="fw-pord-hint">{line.measurement ? t('lines.mtmUnit', { rider: line.measurement.riderName, revision: line.measurement.revision, size: line.baseSize ?? '—' }) : t('lines.mtmUnitNone')}</p>
            ) : (
              <SizeRunTable
                label={t('lines.sizesOf', { seq: line.seq, style: line.style?.code ?? '—', colour: line.colourway?.name ?? '' })}
                run={{
                  heads: [t('sizes.ordered'), t('sizes.shipped'), t('sizes.open'), ...(line.sizes.some((size) => size.closedShort > 0) ? [t('sizes.closedShort')] : []), ...(seesPrices && line.sizes.some((size) => size.unitPrice && size.unitPrice !== line.unitPrice) ? [t('sizes.price')] : [])],
                  rows: line.sizes.map((size) => ({
                    size: size.size ?? '—',
                    cells: [
                      size.ordered,
                      size.shipped,
                      size.open,
                      ...(line.sizes.some((entry) => entry.closedShort > 0) ? [size.closedShort] : []),
                      ...(seesPrices && line.sizes.some((entry) => entry.unitPrice && entry.unitPrice !== line.unitPrice) ? [unitPriceText(size.unitPrice ?? line.unitPrice, currency, locale) ?? '—'] : []),
                    ],
                  })),
                }}
              />
            )}
          </Disclosure>
        ))}
      </section>
      {totals ? (
        <Card header={t('totals.title')} headingLevel={2}>
          <SummaryTable
            label={t('totals.title')}
            columns={[t('totals.what'), t('totals.amount')]}
            rows={[
              { id: 'net', cells: [t('totals.net'), words.money(totals.net, currency)] },
              { id: 'vat', cells: [t('totals.vat'), words.money(totals.vat, currency)] },
              { id: 'gross', cells: [t('totals.gross'), words.money(totals.gross, currency)] },
              ...(record.deposits.length > 0 ? [{ id: 'deposit', cells: [t('totals.depositPaid'), words.money(totals.depositPaid, currency)] }, { id: 'toPay', cells: [t('totals.toPay'), words.money(totals.toPay, currency)] }] : []),
            ]}
          />
        </Card>
      ) : null}
    </div>
  )
}
