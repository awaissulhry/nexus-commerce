'use client'

import { useMemo, useRef } from 'react'
import { ArrowLeft, History, Plus } from 'lucide-react'
import { Card, EmptyState } from '@nexus/ui/components'
import { RefPair } from '@nexus/ui/components/RefPair/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Select } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { PastLine, PastOrder, PastOrderRow } from '../api'
import { droppedOf, noticeTone, noticeWords, reorderLineHeld } from '../model'
import { useOrderingWords } from '../words'
import { Loading, ReadFailed } from './parts'

/**
 * sec:reorder (design portal.customer.neworder "Copy a past order at today's prices with every difference spelled out",
 * SAL-072): the past orders (their PO first, date, lines, pieces) in the shared list frame; one order's lines as they would
 * be copied today, each with its differences in our words ("Price now 410,00 € (was 400,00 €)", "Brown is discontinued —
 * choose another colour", "Sizes no longer offered, left out: 62"), chosen with the frame's select-all, shift range and
 * x / Space; "Add N lines to the draft" is the bulk action. A line that cannot go is not selectable, with the reason.
 */

export interface ReorderModel {
  q: string
  /** The draft's currency (a past order's prices are today's, in it). */
  currency: string
  orders: { state: 'loading' | 'error' | 'ready'; rows: readonly PastOrderRow[] }
  /** One past order open (null: the list). */
  order: { id: string; state: 'loading' | 'error' | 'ready'; read: PastOrder | null } | null
  selected: readonly string[]
  /** A discontinued colour's choice, by order line. */
  colours: Readonly<Record<string, string>>
  busy: boolean
  /** Why nothing can be written now (words), or null. */
  writeHeld: string | null
}

export interface ReorderActions {
  onSearch?: (q: string) => void
  onOpenOrder?: (orderId: string) => void
  onBack?: () => void
  onSelect?: (ids: string[]) => void
  onColour?: (orderLineId: string, colourwayId: string) => void
  onAdd?: () => void
  onRetryOrders?: () => void
  onRetryOrder?: () => void
}

export function ReorderPanel({ model, actions }: { model: ReorderModel; actions?: ReorderActions }) {
  const words = useOrderingWords()
  const { t } = words
  return (
    <Card padded>
      <section className="fw-pno-section" id="reorder" aria-labelledby="reorder-title">
        <div className="fw-pno-headrow">
          <h2 id="reorder-title" className="fw-pno-h2">
            {t('reorder.title')}
          </h2>
        </div>
        <p className="fw-pno-quiet">{t('reorder.intro')}</p>
        {model.order ? <OrderLines model={model} actions={actions} /> : <PastOrders model={model} actions={actions} />}
      </section>
    </Card>
  )
}

function PastOrders({ model, actions }: { model: ReorderModel; actions?: ReorderActions }) {
  const words = useOrderingWords()
  const { t } = words
  const ds = useDsWords()
  const latest = useRef(actions)
  latest.current = actions
  const columns = useMemo((): ColDef<PastOrderRow>[] => {
    const OrderCell = ({ data }: ICellRendererParams<PastOrderRow>) =>
      data ? (
        <button type="button" className="fw-pcat-name" onClick={() => latest.current?.onOpenOrder?.(data.id)}>
          <RefPair theirs={data.customerRef} ours={data.number} theirsLabel={t('ref.yours')} oursLabel={t('ref.ours')} size="sm" copy={false} labels={ds.refPair} />
        </button>
      ) : null
    return [
      { colId: 'order', headerName: t('reorder.col.order'), cellRenderer: OrderCell, flex: 1.6, minWidth: 220, sortable: false, valueGetter: ({ data }) => (data ? `${data.customerRef ?? ''} ${data.number}` : '') },
      { colId: 'date', headerName: t('reorder.col.date'), flex: 0.8, minWidth: 120, sortable: false, valueGetter: ({ data }) => (data?.orderDate ? words.day(data.orderDate) : '—') },
      { colId: 'lines', headerName: t('reorder.col.lines'), flex: 0.5, minWidth: 90, sortable: false, valueGetter: ({ data }) => (data ? String(data.lines) : '') },
      { colId: 'pieces', headerName: t('reorder.col.pieces'), flex: 0.5, minWidth: 90, sortable: false, valueGetter: ({ data }) => (data ? words.pieces(data.pieces) : '') },
    ]
  }, [t, words, ds.refPair])
  return (
    <>
      <Input
        type="search"
        aria-label={t('reorder.search')}
        placeholder={t('reorder.searchHint')}
        defaultValue={model.q}
        onKeyDown={(event) => {
          if (event.key === 'Enter') actions?.onSearch?.((event.target as HTMLInputElement).value)
        }}
        onBlur={(event) => {
          if (event.target.value.trim() !== model.q.trim()) actions?.onSearch?.(event.target.value)
        }}
      />
      {model.orders.state === 'loading' ? (
        <Loading rows={3} height={44} />
      ) : model.orders.state === 'error' ? (
        <ReadFailed title={t('reorder.ordersFailed')} onRetry={actions?.onRetryOrders} />
      ) : (
        <ListFrame<PastOrderRow>
          label={t('reorder.ordersLabel')}
          listKey={null}
          rows={model.orders.rows}
          rowId={(row) => row.id}
          columns={columns}
          count={t('reorder.ordersCount', { count: model.orders.rows.length })}
          onOpen={(row) => actions?.onOpenOrder?.(row.id)}
          state={model.orders.rows.length === 0 ? <EmptyState icon={<History size={24} aria-hidden />} title={model.q.trim() ? t('reorder.noMatch', { q: model.q.trim() }) : t('reorder.empty')} /> : undefined}
          cards={{ hrefOf: () => null }}
        />
      )}
    </>
  )
}

function OrderLines({ model, actions }: { model: ReorderModel; actions?: ReorderActions }) {
  const words = useOrderingWords()
  const { t } = words
  const ds = useDsWords()
  const order = model.order!
  const read = order.read
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  const seesPrices = read?.seesPrices ?? false
  const currency = model.currency
  const kit = useMemo(() => ({ t, price: (value: string | null | undefined) => words.price(value, currency) }), [t, words, currency])

  const columns = useMemo((): ColDef<PastLine>[] => {
    const StyleCell = ({ data }: ICellRendererParams<PastLine>) =>
      data ? (
        <span className="fw-pno-cell">
          <span>{`${data.style.code} · ${data.style.name}`}</span>
          <span className="fw-pno-cell-sub">{t('reorder.lineNo', { seq: data.seq })}</span>
        </span>
      ) : null
    const ColourCell = ({ data }: ICellRendererParams<PastLine>) => {
      if (!data) return null
      if (!data.needsColour) return <span className="fw-pno-cell">{`${data.colourway.name} (${data.colourway.code})`}</span>
      const now = latest.current
      return (
        <Select aria-label={t('reorder.chooseColour', { seq: data.seq })} value={now.model.colours[data.orderLineId] ?? ''} onChange={(event) => now.actions?.onColour?.(data.orderLineId, event.target.value)}>
          <option value="">{t('reorder.colourGone', { colour: data.colourway.name })}</option>
          {data.colours.map((colour) => (
            <option key={colour.id} value={colour.id}>
              {colour.name} ({colour.code})
            </option>
          ))}
        </Select>
      )
    }
    const SizesCell = ({ data }: ICellRendererParams<PastLine>) =>
      data ? <span className="fw-pno-cell-sub">{data.sizes.map((row) => t('reorder.sizeRun', { size: row.size, quantity: row.quantity })).join(' · ') || '—'}</span> : null
    const DiffCell = ({ data }: ICellRendererParams<PastLine>) =>
      data ? (
        <ul className="fw-pno-notes">
          {data.notices.length === 0 ? <li className="fw-pno-note is-info">{t('reorder.same')}</li> : null}
          {data.notices.map((notice, index) => (
            <li key={index} className={`fw-pno-note is-${noticeTone(notice.code)}`}>
              {noticeWords(notice.code, { style: data.style.code, colour: data.colourway.name, priceNow: data.priceNow, priceThen: data.unitPriceThen, dropped: droppedOf(data) }, kit)}
            </li>
          ))}
        </ul>
      ) : null
    return [
      { colId: 'style', headerName: t('reorder.col.style'), cellRenderer: StyleCell, flex: 1.4, minWidth: 200, sortable: false, valueGetter: ({ data }) => (data ? `${data.style.code} · ${data.style.name}` : '') },
      { colId: 'colour', headerName: t('reorder.col.colour'), cellRenderer: ColourCell, flex: 1, minWidth: 170, sortable: false, valueGetter: ({ data }) => (data ? data.colourway.name : '') },
      { colId: 'sizes', headerName: t('reorder.col.sizes'), cellRenderer: SizesCell, flex: 1.2, minWidth: 170, sortable: false, autoHeight: true, wrapText: true, valueGetter: ({ data }) => (data ? data.sizes.map((row) => `${row.size}×${row.quantity}`).join(' ') : '') },
      { colId: 'pieces', headerName: t('reorder.col.pieces'), flex: 0.5, minWidth: 90, sortable: false, valueGetter: ({ data }) => (data ? words.pieces(data.sizes.reduce((sum, row) => sum + row.quantity, 0)) : '') },
      ...(seesPrices
        ? [{ colId: 'price', headerName: t('reorder.col.priceNow'), flex: 0.7, minWidth: 120, sortable: false, valueGetter: ({ data }: { data?: PastLine }) => (data ? (words.price(data.priceNow, currency) ?? '—') : '') }]
        : []),
      { colId: 'diff', headerName: t('reorder.col.differences'), cellRenderer: DiffCell, flex: 1.8, minWidth: 240, sortable: false, autoHeight: true, wrapText: true, valueGetter: ({ data }) => (data ? data.notices.map((notice) => notice.code).join(' ') : '') },
    ]
  }, [t, words, seesPrices, kit, currency])

  const count = model.selected.length
  const bulk = (
    <Button size="sm" variant="primary" heldReason={model.writeHeld ?? (model.busy ? t('held.busy') : null)} onClick={() => actions?.onAdd?.()} aria-label={t('reorder.addN', { count })}>
      <Plus size={13} aria-hidden /> <SelectionLabel>{t('reorder.addN', { count })}</SelectionLabel>
    </Button>
  )

  return (
    <>
      <div className="fw-pno-headrow">
        <Button size="sm" variant="quiet" onClick={() => actions?.onBack?.()}>
          <ArrowLeft size={14} aria-hidden /> {t('reorder.back')}
        </Button>
        {read ? (
          <span className="fw-pno-quiet">
            <RefPair theirs={read.order.customerRef} ours={read.order.number} theirsLabel={t('ref.yours')} oursLabel={t('ref.ours')} size="sm" copy={false} labels={ds.refPair} />
            {read.order.orderDate ? ` · ${words.day(read.order.orderDate)}` : ''}
          </span>
        ) : null}
      </div>
      {order.state === 'loading' ? (
        <Loading rows={3} height={56} />
      ) : order.state === 'error' || !read ? (
        <ReadFailed title={t('reorder.orderFailed')} onRetry={actions?.onRetryOrder} />
      ) : (
        <>
          <p className="fw-pno-quiet">{t('reorder.todayPrices')}</p>
          <ListFrame<PastLine>
            label={t('reorder.linesLabel', { order: read.order.number })}
            listKey={null}
            rows={read.lines}
            rowId={(row) => row.orderLineId}
            columns={columns}
            count={t('reorder.linesCount', { count: read.lines.length })}
            selection={{ selected: model.selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulk }}
            isRowSelectable={(row) => {
              const held = reorderLineHeld(row, model.colours[row.orderLineId])
              return held ? t(held) : null
            }}
            state={read.lines.length === 0 ? <EmptyState title={t('reorder.noLines')} /> : undefined}
            cards={{ hrefOf: () => null }}
          />
        </>
      )}
    </>
  )
}
