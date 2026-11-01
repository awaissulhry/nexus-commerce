'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Download, MoreHorizontal, PackagePlus, Printer, Search, Timer, Truck } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, MetricStrip } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Tag } from '@nexus/ui/primitives'
import { Countdown, Modal } from '../../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { ShipmentRow } from '../../api'
import { money, printDdtsHeld, printDdtsPlan } from '../../daily-model'
import { carrierWords, kilos, placeOf, ROW_VIEWS, STATUS_TONE, TILES, waitsForHandOver, needsLabels, type CutOffCard, type RowView } from '../../model'
import type { ShipmentsListActions, ShipmentsListModel } from '../list-model'
import { NewShipmentDialog } from './NewShipmentDialog'
import { PrintDdtsDialog } from './PrintDdtsDialog'
import '../../shipments.css'

export type { ShipmentsListActions, ShipmentsListModel } from '../list-model'

/**
 * SCR-066 — Shipments (Warehouse › Outbound; design warehouse.shipments, 00 §2.1 list frame): the carrier cut-offs of
 * today (a card per carrier: the time left to its cut-off, the parcels ready and what is still to pack; a card filters
 * the queue to that carrier), the tiles (each a saved rows view), and the shared list frame — the ship-today queue first
 * (what has not left yet), then every shipment by state; search by number, order, customer PO, customer or tracking
 * number; select-all, shift range, x; Export N (CSV) while rows are selected (no API acts on many shipments: printing
 * many DDTs is W2a); live changes behind "N updates · Show". New shipment (c) plans one from what quality released.
 * B-W2a-71: the Freight charged column (a price: only with the price grain; the label's cost stays the carrier's
 * invoice), Print N DDTs in the selection row, the EU transport proof still to file (`?rows=evidence`, and a line in the
 * Status cell).
 */
export function ShipmentsListView({ model, actions }: { model: ShipmentsListModel; actions?: ShipmentsListActions }) {
  return (
    <WithMessages namespaces={['shipments', 'lists']}>
      <ShipmentsList model={model} actions={actions} />
    </WithMessages>
  )
}

function ShipmentsList({ model, actions }: { model: ShipmentsListModel; actions?: ShipmentsListActions }) {
  const t = useT('shipments')
  const lists = useT('lists')
  const locale = useLocale()
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
  const items = model.list.items
  const rowsKey = items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])

  // c: New shipment (design keyboard) — never while typing or inside a dialog. The list frame keeps / j k x Enter ?.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || help || model.create) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || target.isContentEditable)) return
      if (event.key === 'c' && model.can.manage) {
        event.preventDefault()
        actions?.onNew?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const picked = (items ?? []).filter((row) => selected.includes(row.id))
  const printPlan = printDdtsPlan(picked)
  const printable = printPlan.printable.length
  const printHeld = printDdtsHeld(printPlan, model.can)
  const ownKeys: ListKey[] = model.can.manage ? [{ keys: ['c'], does: t('list.keyNew') }] : []
  const searchField = (
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
  )
  const rowsSelect = (
    <Select size="sm" aria-label={t('list.rowsLabel')} value={model.rows} onChange={(event) => actions?.onRows?.(event.target.value as RowView)}>
      {ROW_VIEWS.map((view) => (
        <option key={view} value={view}>
          {t(`rows.${view}`)}
        </option>
      ))}
    </Select>
  )

  const columns = useMemo<ColDef<ShipmentRow>[]>(() => {
    const href = (row: ShipmentRow) => `${model.prefix}/warehouse/shipments/${row.id}`
    const words = (row: ShipmentRow) => {
      const carrier = carrierWords(row)
      return t(carrier.key, carrier.params)
    }
    const NumberCell = ({ data }: ICellRendererParams<ShipmentRow>) =>
      data ? (
        <span className="fw-sh-cell">
          <Link className="fw-sh-link" href={href(data)}>
            {data.number}
          </Link>
          <span className="fw-sh-cell-sub">{t('list.created', { date: formatDate(data.createdAt, { locale }) })}</span>
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<ShipmentRow>) =>
      data ? (
        <span className="fw-sh-cell">
          <Pill tone={STATUS_TONE[data.status]}>{t(`status.${data.status}`)}</Pill>
          {needsLabels(data) ? (
            <span className="fw-sh-cell-sub">{t('list.needsLabels', { count: data.parcels - data.labelled })}</span>
          ) : waitsForHandOver(data) ? (
            <span className="fw-sh-cell-sub">{t('list.waitsHandOver')}</span>
          ) : data.transportEvidence === 'AWAITED' || data.transportEvidence === 'PARTIAL' ? (
            <span className="fw-sh-cell-sub">{t(`list.evidence.${data.transportEvidence}`)}</span>
          ) : null}
        </span>
      ) : null
    const CustomerCell = ({ data }: ICellRendererParams<ShipmentRow>) =>
      data ? (
        <span className="fw-sh-cell">
          <span className="fw-sh-ellipsis">{data.partyName || '—'}</span>
          {model.can.viewOrders ? (
            <Link className="fw-sh-link fw-sh-cell-sub" href={`${model.prefix}/sales/orders/${data.salesOrderId}`}>
              {data.salesOrderNumber}
            </Link>
          ) : (
            <span className="fw-sh-cell-sub">{data.salesOrderNumber}</span>
          )}
        </span>
      ) : null
    const ShipToCell = ({ data }: ICellRendererParams<ShipmentRow>) => (data ? <span className="fw-sh-ellipsis">{placeOf(data.shipTo) ?? '—'}</span> : null)
    const CarrierCell = ({ data }: ICellRendererParams<ShipmentRow>) =>
      data ? (
        <span className="fw-sh-cell">
          <span className="fw-sh-ellipsis">{words(data)}</span>
          {data.serviceCode && <span className="fw-sh-cell-sub">{data.serviceCode}</span>}
        </span>
      ) : null
    const ParcelsCell = ({ data }: ICellRendererParams<ShipmentRow>) =>
      data ? (
        <span className="fw-sh-cell">
          <span>{t('list.parcels', { count: data.parcels })}</span>
          <span className="fw-sh-cell-sub">{t('list.garments', { count: data.garments })}</span>
        </span>
      ) : null
    const WeightCell = ({ data }: ICellRendererParams<ShipmentRow>) => {
      if (!data) return null
      const value = kilos(data.grossWeightKg, locale)
      return <span>{value === null ? '—' : t('list.kg', { value })}</span>
    }
    const DdtCell = ({ data }: ICellRendererParams<ShipmentRow>) =>
      data ? (
        data.ddt ? (
          <Link className="fw-sh-link fw-sh-mono" href={`${href(data)}?tab=documents`}>
            {data.ddt.number}
          </Link>
        ) : (
          <span className="fw-sh-muted">{data.status === 'CANCELLED' ? '—' : t('list.noDdt')}</span>
        )
      ) : null
    const TrackingCell = ({ data }: ICellRendererParams<ShipmentRow>) => {
      if (!data) return null
      const [first, ...rest] = data.trackingNumbers
      if (!first) return <span className="fw-sh-muted">—</span>
      return (
        <Link className="fw-sh-link fw-sh-mono" href={`${href(data)}?tab=tracking`}>
          {first}
          {rest.length > 0 || data.labelled > data.trackingNumbers.length ? ` +${Math.max(rest.length, data.labelled - 1)}` : ''}
        </Link>
      )
    }
    const WhenCell = ({ data }: ICellRendererParams<ShipmentRow>) => {
      if (!data) return null
      if (data.shippedAt) return <span className="fw-sh-cell-sub">{t('list.shippedAt', { date: formatDate(data.shippedAt, { locale }) })}</span>
      if (data.cancelledAt) return <span className="fw-sh-cell-sub">{t('list.cancelledAt', { date: formatDate(data.cancelledAt, { locale }) })}</span>
      const card = model.cards?.find((entry) => entry.shipments > 0 && entry.cutOff && entry.key === (data.transportBy === 'CARRIER' ? (data.carrierCode ?? 'none') : data.transportBy))
      return card?.cutOff ? <Countdown to={card.cutOff.at} label={(left) => t('cutoff.left', { left, time: card.cutOff!.time })} doneLabel={t('cutoff.passed', { time: card.cutOff.time })} /> : <span className="fw-sh-muted">{t('list.noCutOff')}</span>
    }
    // B-W2a-71 (design sh-grid "Freight charged (price, W2a)"): the API sends no amount without the price grain.
    const FreightCell = ({ data }: ICellRendererParams<ShipmentRow>) => {
      if (!data) return null
      if (data.freightCharge === undefined) return <span className="fw-sh-muted">—</span>
      if (data.freightCharge === null) return <span className="fw-sh-muted">{data.status === 'CANCELLED' ? '—' : t('list.freightOpen')}</span>
      return <span>{money(data.freightCharge, data.currency, locale)}</span>
    }
    const MoreCell = ({ data }: ICellRendererParams<ShipmentRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { number: data.number }) }}
          items={[
            { id: 'open', label: t('list.open'), href: href(data) },
            { id: 'tab', label: t('list.openNewTab'), href: href(data), target: '_blank' },
            { id: 'documents', label: t('tab.documents'), href: `${href(data)}?tab=documents` },
            ...(data.transportBy === 'CARRIER' ? [{ id: 'carrier', label: t('tab.carrier'), href: `${href(data)}?tab=carrier` }] : []),
            ...(data.labelled > 0 ? [{ id: 'track', label: t('tab.tracking'), href: `${href(data)}?tab=tracking` }] : []),
          ]}
        />
      ) : null
    return [
      { colId: 'number', headerName: t('col.number'), field: 'number', minWidth: 130, flex: 0.9, cellRenderer: NumberCell },
      { colId: 'status', headerName: t('col.status'), field: 'status', minWidth: 140, flex: 0.9, cellRenderer: StatusCell },
      { colId: 'customer', headerName: t('col.customer'), field: 'partyName', minWidth: 160, flex: 1.3, cellRenderer: CustomerCell },
      { colId: 'shipTo', headerName: t('col.shipTo'), minWidth: 120, flex: 0.9, cellRenderer: ShipToCell },
      { colId: 'carrier', headerName: t('col.carrier'), minWidth: 130, flex: 1, cellRenderer: CarrierCell },
      { colId: 'parcels', headerName: t('col.parcels'), field: 'parcels', minWidth: 100, flex: 0.6, cellRenderer: ParcelsCell },
      { colId: 'weight', headerName: t('col.weight'), field: 'grossWeightKg', minWidth: 90, flex: 0.5, type: 'rightAligned', cellRenderer: WeightCell },
      { colId: 'ddt', headerName: t('col.ddt'), minWidth: 110, flex: 0.7, cellRenderer: DdtCell },
      { colId: 'tracking', headerName: t('col.tracking'), minWidth: 130, flex: 0.9, cellRenderer: TrackingCell },
      { colId: 'when', headerName: t('col.when'), minWidth: 150, flex: 0.9, cellRenderer: WhenCell },
      ...(model.can.price ? [{ colId: 'freight', headerName: t('col.freight'), field: 'freightCharge' as const, minWidth: 150, flex: 0.8, type: 'rightAligned', cellRenderer: FreightCell }] : []),
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, model.prefix, model.cards, model.can.viewOrders, model.can.price])

  const narrowed = model.q.trim() !== '' || model.carrier !== null || (model.rows !== 'today' && model.rows !== 'all')
  const clearFilters = () => {
    setQuery('')
    actions?.onSearch?.('')
    actions?.onRows?.('all')
  }
  const state = model.list.problem ? (
    <EmptyState title={t('list.failed')} description={t(model.list.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : items && items.length === 0 ? (
    narrowed ? (
      <EmptyState title={t('list.noMatch.title')} description={t('list.noMatch.body')} action={<Button size="sm" onClick={clearFilters}>{t('list.clearFilters')}</Button>} />
    ) : model.rows === 'today' ? (
      <EmptyState icon={<Truck size={24} aria-hidden />} title={t('list.today.title')} description={t('list.today.body')} action={model.can.manage ? <Button size="sm" onClick={() => actions?.onNew?.()}>{t('list.new')}</Button> : undefined} />
    ) : (
      <EmptyState title={t('list.empty.title')} description={t('list.empty.body')} action={model.can.manage ? <Button size="sm" onClick={() => actions?.onNew?.()}>{t('list.new')}</Button> : undefined} />
    )
  ) : undefined

  const pressedTile = model.rows === 'DRAFT' ? 'toPack' : model.rows === 'SHIPPED' ? 'inTransit' : null

  return (
    <div className="fw-sh">
      <div className="fw-sh-head">
        <span className="fw-sh-status" role="status">
          {model.asOf ? t('list.updated', { time: formatTime(model.asOf, { locale }) }) : t('list.notYet')}
          {' · '}
          {t(`live.${model.live}`)}
        </span>
        {model.can.manage ? (
          <Button size="sm" variant="primary" onClick={() => actions?.onNew?.()} aria-keyshortcuts="c">
            <PackagePlus size={14} aria-hidden /> {t('list.new')}
          </Button>
        ) : null}
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.words.key, model.notice.words.params)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('common.dismiss')}
              </Button>
            ) : undefined
          }
        >
          {model.notice.detail}
        </Banner>
      )}

      <CutOffStrip model={model} actions={actions} />

      <MetricStrip
        metrics={TILES.map((tile) => {
          const count = model.tiles?.[tile.key] ?? null
          return {
            label: t(`tile.${tile.key}`),
            value: count === null ? '—' : String(count),
            hint: count === null && model.asOf !== null ? t('tile.unknown') : undefined,
            onClick: () => actions?.onRows?.(model.rows === tile.rows && pressedTile === tile.key ? 'today' : tile.rows),
            active: pressedTile === tile.key,
          }
        })}
      />

      <ListFrame<ShipmentRow>
        label={t('list.tableLabel')}
        rows={state ? [] : items}
        rowId={(row) => row.id}
        columns={columns}
        count={items ? t(model.list.more ? 'list.countMore' : 'list.count', { count: items.length }) : '—'}
        search={searchField}
        tools={
          <span className="fw-sh-inline">
            {rowsSelect}
            {model.carrier && (
              <>
                <Tag tone="info">{t('cutoff.filtered', { carrier: cardName(t, model.cards?.find((card) => card.key === model.carrier) ?? null, model.carrier) })}</Tag>
                <Button size="sm" variant="quiet" onClick={() => actions?.onCarrier?.(null)}>
                  {t('cutoff.clear')}
                </Button>
              </>
            )}
          </span>
        }
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <>
              <Button size="sm" variant="primary" aria-label={t('bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count: picked.length })}</SelectionLabel>
              </Button>
              {/* B-W2a-71 (design sh-grid selection row "Print 4 DDTs"). */}
              <Button size="sm" aria-label={t('bulk.printDdts', { count: printable })} heldReason={printHeld ? t(printHeld.key, printHeld.params) : null} onClick={() => actions?.onPrintDdts?.(picked.map((row) => row.id))}>
                <Printer size={13} aria-hidden /> <SelectionLabel>{t('bulk.printDdts', { count: printable })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.list.more && items && items.length > 0 ? (model.rows === 'today' ? { label: t('list.moreToday'), onMore: () => actions?.onRows?.('all'), held: null } : { label: t('list.more'), onMore: () => actions?.onMore?.() }) : null}
        keys={ownKeys}
        onHelp={() => setHelp(true)}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
        focusRow={model.focusRow}
      />
      {model.rows !== 'today' && <p className="fw-sh-hint">{t('list.viewing', { view: t(`rows.${model.rows}`) })}</p>}

      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('list.keysTitle')} size="sm">
          <ul className="fw-sh-list">
            {listKeys(ownKeys, true).map((entry) => (
              <li key={entry.does}>
                <b>{entry.keys.join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
              </li>
            ))}
          </ul>
        </Modal>
      )}

      {model.create && <NewShipmentDialog model={model.create} can={model.can} actions={actions} />}
      {model.printDdts && <PrintDdtsDialog model={model.printDdts} rows={items ?? []} can={model.can} actions={actions} />}
    </div>
  )
}

function cardName(t: (key: string, params?: Record<string, string | number>) => string, card: CutOffCard | null, fallback: string): string {
  if (!card) return fallback
  return t(card.carrier.key, card.carrier.params)
}

/** Design sh-cutoff: a card per carrier with today's cut-off (Countdown), what is ready and what is still to pack. */
function CutOffStrip({ model, actions }: { model: ShipmentsListModel; actions?: ShipmentsListActions }) {
  const t = useT('shipments')
  if (model.cards === null) return null
  if (model.cards.length === 0) {
    return (
      <p className="fw-sh-hint fw-sh-cutoff-none" role="status">
        <Timer size={14} aria-hidden /> {t('cutoff.none')}
      </p>
    )
  }
  return (
    <section className="fw-sh-cutoffs" aria-label={t('cutoff.label')}>
      {model.cards.map((card) => (
        <Card key={card.key} padded className="fw-sh-cutoff" onClick={() => actions?.onCarrier?.(model.carrier === card.key ? null : card.key)} pressed={model.carrier === card.key}>
          <span className="fw-sh-cutoff-name">
            <Truck size={14} aria-hidden /> {t(card.carrier.key, card.carrier.params)}
          </span>
          <span className="fw-sh-cutoff-time">
            {card.cutOff ? (
              <Countdown to={card.cutOff.at} label={(left) => t('cutoff.left', { left, time: card.cutOff!.time })} doneLabel={t('cutoff.passed', { time: card.cutOff.time })} />
            ) : (
              <span className="fw-sh-muted">{model.can.viewSettings ? t('cutoff.notSet') : t('cutoff.unknown')}</span>
            )}
          </span>
          <span className="fw-sh-cutoff-counts">
            {t('cutoff.ready', { count: card.parcelsReady })} · {card.toPack > 0 ? `${t('cutoff.toPack', { count: card.toPack })} (${t('list.garments', { count: card.garmentsToPack })})` : t('cutoff.allPacked')}
          </span>
        </Card>
      ))}
    </section>
  )
}
