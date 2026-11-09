'use client'

import { useMemo, useRef, type ReactNode } from 'react'
import { Download, ExternalLink, MoreHorizontal, PackageSearch, WifiOff } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, PressableRow, type MenuItemDef } from '@nexus/ui/components'
import { MilestoneTracker } from '@nexus/ui/components/MilestoneTracker/index'
import { RefPair } from '@nexus/ui/components/RefPair/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Pill } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import type { InTransitRead, InTransitRow, OrderChip, OrderRow, OrdersRead } from '../api'
import { opens, recordHref, shipmentTone, statusTone, transitSteps } from '../model'
import { useOrderWords } from '../words'
import { Loading, PricesNote, ReadFailed } from './parts'
import '../orders.css'

/**
 * SCR-184 › Orders & tracking (design portal.customer.orders: sec:chips "Which orders", sec:orders-grid "Your orders",
 * sec:in-transit "On the way"): saved filters with counts in customer words, the orders in the shared list frame (select-all,
 * shift range, x / Space, Export N while rows are selected, keys only in the footer's info icon, cards on a phone), their
 * PO first, sorted by the promise date; the parcels on their way across all orders. Prices only with the price grain.
 */

export interface OrdersListViewModel {
  state: 'loading' | 'error' | 'ready'
  read: OrdersRead | null
  /** Every row read so far (pages of 50). */
  rows: readonly OrderRow[]
  /** The chip asked in the address (null: the API's default, Open). */
  chip: OrderChip | null
  q: string
  prefix: string
  selected: readonly string[]
  /** Live: the list changed since it was read. */
  updates: number
  /** No connection: what was loaded and when. */
  offlineSince: string | null
  /** More rows than shown: the footer's "Show more". */
  more: { loading: boolean } | null
  transit: { state: 'loading' | 'error' | 'ready'; read: InTransitRead | null }
  /** Design cases: the keys panel open. */
  keysOpen?: boolean
}

export interface OrdersListActions {
  onChip?: (chip: OrderChip) => void
  onSearch?: (q: string) => void
  onClear?: () => void
  onSelect?: (ids: string[]) => void
  onOpen?: (row: OrderRow) => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onMore?: () => void
  onExport?: (ids: readonly string[] | null) => void
  onHelp?: () => void
  onRetryTransit?: () => void
  onOpenShipment?: (row: InTransitRow) => void
}

export function OrdersListView({ model, actions }: { model: OrdersListViewModel; actions?: OrdersListActions }) {
  const words = useOrderWords()
  const { t, locale, day, time } = words
  const ds = useDsWords()
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  const read = model.read
  const seesPrices = read?.seesPrices ?? true
  const rows = model.state === 'loading' && !read ? null : model.rows
  const chip = read?.chip ?? model.chip ?? 'OPEN'

  const columns = useMemo((): ColDef<OrderRow>[] => {
    const OrderCell = ({ data }: ICellRendererParams<OrderRow>) => {
      if (!data) return null
      const pair = <RefPair theirs={data.customerRef} ours={data.number} theirsLabel={t('ref.yours')} oursLabel={t('ref.ours')} layout="stacked" size="sm" copy={false} match={latest.current.model.q || null} labels={ds.refPair} />
      if (!opens(data)) return <span className="fw-pord-cell">{pair}</span>
      return (
        <a
          className="fw-pord-rowlink"
          href={recordHref(latest.current.model.prefix, data.id)}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
            event.preventDefault()
            latest.current.actions?.onOpen?.(data)
          }}
        >
          {pair}
        </a>
      )
    }
    const OrderedCell = ({ data }: ICellRendererParams<OrderRow>) => (data ? <span>{data.orderedOn ? day(data.orderedOn) : '—'}</span> : null)
    const StatusCell = ({ data }: ICellRendererParams<OrderRow>) =>
      data ? (
        <span className="fw-pord-stack">
          <Pill tone={statusTone(data.status)} truncate>
            {data.words[locale]}
          </Pill>
          {data.kind === 'REQUEST' ? <span className="fw-pord-sub fw-pord-clip">{t('list.requestWaits')}</span> : null}
        </span>
      ) : null
    const PromiseCell = ({ data }: ICellRendererParams<OrderRow>) => {
      if (!data) return null
      if (!data.promiseDate)
        return data.requestedDate ? (
          <span className="fw-pord-stack">
            <span>{day(data.requestedDate)}</span>
            <span className="fw-pord-sub fw-pord-clip">{t('list.asked')}</span>
          </span>
        ) : (
          <span className="fw-pord-sub">—</span>
        )
      return (
        <span className="fw-pord-stack">
          <span>{day(data.promiseDate)}</span>
          {data.promiseMoved && data.originalPromiseDate ? <span className="fw-pord-moved fw-pord-clip">{t('list.moved', { date: day(data.originalPromiseDate) })}</span> : null}
        </span>
      )
    }
    const PiecesCell = ({ data }: ICellRendererParams<OrderRow>) =>
      data ? (
        <span className="fw-pord-stack">
          <span className="fw-pord-clip">{t('list.piecesShipped', { shipped: data.pieces.shipped, ordered: data.pieces.ordered })}</span>
          {data.pieces.open > 0 ? <span className="fw-pord-sub fw-pord-clip">{t('list.piecesOpen', { count: data.pieces.open })}</span> : null}
        </span>
      ) : null
    const ValueCell = ({ data }: ICellRendererParams<OrderRow>) => (data ? <span className="fw-pord-num">{words.money(data.netAmount, data.currency)}</span> : null)
    const NextCell = ({ data }: ICellRendererParams<OrderRow>) => {
      if (!data) return null
      const next = data.nextShipment
      if (!next) return <span className="fw-pord-sub">{data.pieces.open === 0 && data.pieces.shipped > 0 ? t('list.allShipped') : '—'}</span>
      return (
        <span className="fw-pord-stack">
          <span className="fw-pord-clip">{[next.date ? day(next.date) : null, next.carrierName].filter(Boolean).join(' · ') || next.number}</span>
          <span className="fw-pord-sub fw-pord-clip">
            {next.words[locale]}
            {next.expectedDeliveryAt ? ` · ${t('list.eta', { date: day(next.expectedDeliveryAt) })}` : ''}
          </span>
        </span>
      )
    }
    const MoreCell = ({ data }: ICellRendererParams<OrderRow>) => {
      if (!data || !opens(data)) return null
      const prefix = latest.current.model.prefix
      const items: MenuItemDef[] = [
        { id: 'open', label: t('row.open'), href: recordHref(prefix, data.id) },
        { id: 'lines', label: t('row.lines'), href: recordHref(prefix, data.id, 'lines') },
        { id: 'shipments', label: t('row.shipments'), href: recordHref(prefix, data.id, 'shipments') },
        { id: 'messages', label: t('row.messages'), href: recordHref(prefix, data.id, 'messages') },
      ]
      return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('row.menu', { number: data.number ?? '' }) }} items={items} />
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<OrderRow>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number; maxWidth?: number }): ColDef<OrderRow> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    return [
      // The phone card's title is the column's text: their PO first, our order.
      { ...column('order', t('col.order'), OrderCell, { flex: 1.3, minWidth: 214 }), valueGetter: ({ data }) => (data ? [data.customerRef, data.number].filter(Boolean).join(' · ') : '') },
      { ...column('ordered', t('col.orderedOn'), OrderedCell, { flex: 0.6, minWidth: 110 }), valueGetter: ({ data }) => (data?.orderedOn ? day(data.orderedOn) : '') },
      { ...column('status', t('col.status'), StatusCell, { flex: 0.9, minWidth: 136 }), valueGetter: ({ data }) => data?.words[locale] ?? '' },
      { ...column('promise', t('col.promise'), PromiseCell, { flex: 0.7, minWidth: 122 }), valueGetter: ({ data }) => (data?.promiseDate ? day(data.promiseDate) : '') },
      { ...column('pieces', t('col.pieces'), PiecesCell, { flex: 0.8, minWidth: 122 }), valueGetter: ({ data }) => (data ? [t('list.piecesShipped', { shipped: data.pieces.shipped, ordered: data.pieces.ordered }), data.pieces.open > 0 ? t('list.piecesOpen', { count: data.pieces.open }) : null].filter(Boolean).join(' · ') : '') },
      ...(seesPrices ? [{ ...column('value', t('col.value'), ValueCell, { flex: 0.7, minWidth: 124 }), valueGetter: ({ data }: { data?: OrderRow }) => (data ? words.money(data.netAmount, data.currency) : '') }] : []),
      { ...column('next', t('col.nextShipment'), NextCell, { flex: 1.1, minWidth: 160 }), valueGetter: ({ data }) => (data?.nextShipment ? [data.nextShipment.date ? day(data.nextShipment.date) : null, data.nextShipment.carrierName].filter(Boolean).join(' · ') : '') },
      { ...column('actions', t('col.actions'), MoreCell, { width: 72, minWidth: 72, maxWidth: 72 }), pinned: 'right', suppressHeaderMenuButton: true },
    ]
  }, [t, locale, day, words, ds.refPair, seesPrices])

  const count = model.selected.length
  const bulk = (
    <Button size="sm" onClick={() => actions?.onExport?.(model.selected)} aria-label={t('bulk.export', { count })}>
      <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count })}</SelectionLabel>
    </Button>
  )

  const searching = model.q.trim() !== ''
  const filtered = searching || (model.chip !== null && model.chip !== 'OPEN')
  const state: ReactNode =
    model.state === 'error' ? (
      <EmptyState title={t('list.failed')} description={t('list.failedBody')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('state.retry')}</Button>} />
    ) : rows !== null && rows.length === 0 ? (
      filtered ? (
        <EmptyState title={t('list.noMatch')} description={searching ? t('list.noMatchSearch', { q: model.q.trim() }) : t('list.noMatchChip')} action={<Button size="sm" onClick={() => actions?.onClear?.()}>{t('list.clear')}</Button>} />
      ) : (
        <EmptyState icon={<PackageSearch size={24} aria-hidden />} title={t('list.empty')} description={t('list.emptyBody')} />
      )
    ) : undefined

  const ownKeys: ListKey[] = []
  const shownCount = read ? (rows && rows.length < read.count ? t('list.countOf', { shown: rows.length, count: read.count }) : t('list.count', { count: read.count })) : ''

  return (
    <div className="fw-pord">
      {model.offlineSince ? <Banner tone="warning" icon={<WifiOff size={16} aria-hidden />} title={t('offline.title', { time: time(model.offlineSince) })} /> : null}
      <div className="fw-pord-chiprow">
        <div className="fw-pord-chips" role="group" aria-label={t('chips.label')}>
          {read
            ? read.chips.map((entry) => (
                <FilterChip key={entry.chip} pressed={entry.chip === chip} onClick={() => actions?.onChip?.(entry.chip)} aria-label={t('chips.chip', { name: entry.words[locale], count: entry.count })}>
                  {entry.words[locale]} <span className="fw-pord-chip-count">{entry.count}</span>
                </FilterChip>
              ))
            : null}
        </div>
        {filtered ? (
          <Button size="sm" variant="quiet" onClick={() => actions?.onClear?.()}>
            {t('chips.clear')}
          </Button>
        ) : null}
      </div>
      {read && !read.seesPrices ? <PricesNote /> : null}
      <ListFrame<OrderRow>
        label={t('list.label')}
        title={t('list.title')}
        listKey={null}
        rows={model.state === 'error' ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={shownCount}
        search={
          <Input
            type="search"
            aria-label={t('list.search')}
            placeholder={t('list.searchHint')}
            defaultValue={model.q}
            onKeyDown={(event) => {
              if (event.key === 'Enter') actions?.onSearch?.((event.target as HTMLInputElement).value)
              if (event.key === 'Escape' && (event.target as HTMLInputElement).value === '') (event.target as HTMLInputElement).blur()
            }}
            onBlur={(event) => {
              if (event.target.value.trim() !== model.q.trim()) actions?.onSearch?.(event.target.value)
            }}
          />
        }
        selection={{ selected: model.selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulk }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.more ? { label: t('list.more'), onMore: () => actions?.onMore?.(), held: model.more.loading ? t('held.busy') : model.offlineSince ? t('held.offline') : null } : null}
        keys={ownKeys}
        onHelp={actions?.onHelp}
        onOpen={(row) => (opens(row) ? actions?.onOpen?.(row) : undefined)}
        state={state}
        cards={{ hrefOf: (row) => (opens(row) ? recordHref(model.prefix, row.id) : null) }}
        keysOpen={model.keysOpen}
      />
      <InTransit model={model} actions={actions} />
    </div>
  )
}

/** "On the way": hidden when nothing is in transit; a failed read says so (never drawn as nothing). */
function InTransit({ model, actions }: { model: OrdersListViewModel; actions?: OrdersListActions }) {
  const words = useOrderWords()
  const { t, locale, day } = words
  const ds = useDsWords()
  const transit = model.transit
  if (transit.state === 'ready' && (transit.read?.items.length ?? 0) === 0) return null
  return (
    <section className="fw-pord-section" aria-labelledby="fw-pord-transit">
      <h2 id="fw-pord-transit" className="fw-pord-h2">
        {t('transit.title')}
        {transit.read ? <span className="fw-pord-h2-count">{transit.read.items.length}</span> : null}
      </h2>
      {transit.state === 'loading' ? (
        <Loading rows={2} height={56} />
      ) : transit.state === 'error' ? (
        <ReadFailed title={t('transit.failed')} onRetry={actions?.onRetryTransit} />
      ) : (
        <Card className="fw-pord-transit">
          {transit.read!.items.map((row) => (
            <PressableRow
              key={row.shipmentId}
              stacked
              label={
                <span className="fw-pord-transit-head">
                  <RefPair theirs={row.order.customerRef} ours={row.order.number} theirsLabel={t('ref.yours')} oursLabel={t('ref.ours')} size="sm" copy={false} labels={ds.refPair} />
                  <span className="fw-pord-sub">{t('transit.shipment', { number: row.number })}</span>
                </span>
              }
              onClick={() => actions?.onOpenShipment?.(row)}
              description={t('transit.open', { number: row.order.number })}
              actions={
                row.trackingLinks && row.trackingLinks.length > 0 ? (
                  <Button asChild size="sm" variant="quiet">
                    <a href={row.trackingLinks[0]!.url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink size={13} aria-hidden /> {t('shipments.track')}
                    </a>
                  </Button>
                ) : null
              }
            >
              <span className="fw-pord-transit-body">
                <Pill tone={shipmentTone(row.status)}>{row.words[locale]}</Pill>
                {row.carrierName ? <span>{row.carrierName}</span> : null}
                {row.expectedDeliveryAt ? <span>{t('list.eta', { date: day(row.expectedDeliveryAt) })}</span> : null}
                <MilestoneTracker steps={transitSteps(row, locale)} layout="compact" label={t('transit.steps', { number: row.number })} labels={ds.milestoneTracker} />
              </span>
            </PressableRow>
          ))}
        </Card>
      )}
    </section>
  )
}
