'use client'

import { useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { Download, ExternalLink, MoreHorizontal, PackageSearch, WifiOff } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, PressableRow, type MenuItemDef } from '@nexus/ui/components'
import { MilestoneTracker } from '@nexus/ui/components/MilestoneTracker/index'
import { RefPair } from '@nexus/ui/components/RefPair/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Pill, Tag } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import type { RequestRow } from '../../requests/api'
import type { InTransitRead, InTransitRow, OrderRow, OrdersRead } from '../api'
import { kindKey, listChips, listRows, ownRef, recordHref, rowHref, rowState, shipmentTone, transitSteps, yoursOf, type ListChip, type ListRow } from '../model'
import { useOrderWords } from '../words'
import { Loading, PricesNote, ReadFailed } from './parts'
import '../orders.css'

/**
 * SCR-184 › Orders & requests (B-W2b-191; B-TH-223, B-TH-303 — picture 21 drawn to the approved look: design
 * portal.customer.orders sec:chips, sec:orders-grid, sec:in-transit; threads plan P-CUS-ORD-LIST.list): saved filters with
 * counts in customer words (the requests counted in, and "Closed requests" so nothing vanishes), the customer's requests and
 * orders in ONE list in the shared list frame (select-all, shift range, x / Space, Export N while rows are selected, keys only in
 * the footer's info icon, cards on a phone): their PO first and the customer's OWN number ("Your request 7", "Your order 12" —
 * never the office's series), the kind, the subject of a request, the true state, wanted or promised, pieces, the value with the
 * price grain, the next shipment; requests first, then the orders by the promise date; the parcels on their way.
 */

export interface OrdersListViewModel {
  state: 'loading' | 'error' | 'ready'
  read: OrdersRead | null
  /** Every order row read so far (pages of 50). */
  rows: readonly OrderRow[]
  // B-TH-223: the customer's requests (GET /portal/inquiries, every state; `none`: not part of the reader's access).
  requests: { state: 'loading' | 'error' | 'ready' | 'none'; rows: readonly RequestRow[]; complete: boolean }
  /** The chip asked in the address (null: the API's default, Open). */
  chip: ListChip | null
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
  /** B-W2b-194: New order's address for a person who may order (the empty state's action), else null. */
  newOrderHref?: string | null
  /** Design cases: the keys panel open. */
  keysOpen?: boolean
}

export interface OrdersListActions {
  onChip?: (chip: ListChip) => void
  onSearch?: (q: string) => void
  onClear?: () => void
  onSelect?: (ids: string[]) => void
  onOpen?: (row: ListRow) => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onMore?: () => void
  onExport?: (ids: readonly string[] | null) => void
  onHelp?: () => void
  onRetryTransit?: () => void
  onRetryRequests?: () => void
  onOpenShipment?: (row: InTransitRow) => void
}

// B-TH-223: "Next shipment" shows from 1600 px (a 1920 screen): below, "On the way" names the parcels and the other columns
// keep their words whole without the grid scrolling sideways. Server and first render: the wide layout's absence.
const WIDE = '(min-width: 1600px)'
const subscribeWide = (onChange: () => void) => {
  const query = window.matchMedia(WIDE)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
const useWide = (): boolean => useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches, () => false)

export function OrdersListView({ model, actions }: { model: OrdersListViewModel; actions?: OrdersListActions }) {
  const wide = useWide()
  const words = useOrderWords()
  const { t, locale, day, time } = words
  const ds = useDsWords()
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  const read = model.read
  const seesPrices = read?.seesPrices ?? true
  const chip: ListChip = model.chip ?? read?.chip ?? 'OPEN'
  // B-TH-223: requests first, then the orders read; null while the first read runs.
  const rows = model.state === 'loading' && !read ? null : listRows(chip, model.q, model.requests.state === 'ready' ? model.requests.rows : [], model.rows, locale)
  const chips = read ? listChips(read.chips, model.requests.state === 'ready' ? model.requests : null, locale, t('chips.closedRequests')) : []

  const columns = useMemo((): ColDef<ListRow>[] => {
    const NumberCell = ({ data }: ICellRendererParams<ListRow>) => {
      if (!data) return null
      const own = ownRef(data, locale)
      const theirs = data.kind === 'request' ? data.request.customerRef : data.order.customerRef
      const pair = theirs || own ? <RefPair theirs={theirs} ours={own?.value ?? null} theirsLabel={t('ref.yours')} oursLabel={own?.label ?? ''} layout="stacked" size="sm" copy={false} match={latest.current.model.q || null} labels={ds.refPair} /> : <span className="fw-pord-sub">—</span>
      const href = rowHref(latest.current.model.prefix, data)
      if (!href) return <span className="fw-pord-cell">{pair}</span>
      return (
        <a
          className="fw-pord-rowlink"
          href={href}
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
    const KindCell = ({ data }: ICellRendererParams<ListRow>) => (data ? <Tag tone={data.kind === 'request' ? 'info' : 'neutral'}>{t(kindKey(data))}</Tag> : null)
    const SubjectCell = ({ data }: ICellRendererParams<ListRow>) => (data ? data.kind === 'request' ? <span className="fw-pord-subject" title={data.request.subject}>{data.request.subject}</span> : <span className="fw-pord-sub">—</span> : null)
    const DateCell = ({ data }: ICellRendererParams<ListRow>) => {
      if (!data) return null
      if (data.kind === 'order') return <span>{data.order.orderedOn ? day(data.order.orderedOn) : '—'}</span>
      const received = data.request.receivedAt.slice(0, 10)
      const updated = data.request.updatedAt.slice(0, 10)
      return (
        <span className="fw-pord-stack">
          <span>{day(received)}</span>
          {updated !== received ? <span className="fw-pord-sub fw-pord-clip">{t('list.updated', { date: day(updated) })}</span> : null}
        </span>
      )
    }
    const StatusCell = ({ data }: ICellRendererParams<ListRow>) => {
      if (!data) return null
      const state = rowState(data, locale)
      return (
        <span className="fw-pord-stack">
          <Pill tone={state.tone} truncate>
            {state.words}
          </Pill>
          {data.kind === 'request' && data.request.state.needsYou ? <span className="fw-pord-sub fw-pord-clip">{t('list.needsYou')}</span> : null}
          {data.kind === 'order' && data.order.kind === 'REQUEST' ? <span className="fw-pord-sub fw-pord-clip">{t('list.requestWaits')}</span> : null}
        </span>
      )
    }
    const PromiseCell = ({ data }: ICellRendererParams<ListRow>) => {
      if (!data) return null
      if (data.kind === 'request')
        return data.request.wantedDate ? (
          <span className="fw-pord-stack">
            <span>{day(data.request.wantedDate)}</span>
            <span className="fw-pord-sub fw-pord-clip">{t('list.wanted')}</span>
          </span>
        ) : (
          <span className="fw-pord-sub">—</span>
        )
      const order = data.order
      if (!order.promiseDate)
        return order.requestedDate ? (
          <span className="fw-pord-stack">
            <span>{day(order.requestedDate)}</span>
            <span className="fw-pord-sub fw-pord-clip">{t('list.asked')}</span>
          </span>
        ) : (
          <span className="fw-pord-sub">—</span>
        )
      return (
        <span className="fw-pord-stack">
          <span>{day(order.promiseDate)}</span>
          {order.promiseMoved && order.originalPromiseDate ? <span className="fw-pord-moved fw-pord-clip">{t('list.moved', { date: day(order.originalPromiseDate) })}</span> : null}
        </span>
      )
    }
    const PiecesCell = ({ data }: ICellRendererParams<ListRow>) => {
      if (!data) return null
      if (data.kind === 'request') return data.request.pieces > 0 ? <span className="fw-pord-clip">{t('list.piecesAsked', { count: data.request.pieces })}</span> : <span className="fw-pord-sub">—</span>
      return (
        <span className="fw-pord-stack">
          <span className="fw-pord-clip">{t('list.piecesShipped', { shipped: data.order.pieces.shipped, ordered: data.order.pieces.ordered })}</span>
          {data.order.pieces.open > 0 ? <span className="fw-pord-sub fw-pord-clip">{t('list.piecesOpen', { count: data.order.pieces.open })}</span> : null}
        </span>
      )
    }
    const ValueCell = ({ data }: ICellRendererParams<ListRow>) => (data ? data.kind === 'order' ? <span className="fw-pord-num">{words.money(data.order.netAmount, data.order.currency)}</span> : <span className="fw-pord-sub">—</span> : null)
    const NextCell = ({ data }: ICellRendererParams<ListRow>) => {
      if (!data) return null
      if (data.kind === 'request') return <span className="fw-pord-sub">—</span>
      const next = data.order.nextShipment
      if (!next) return <span className="fw-pord-sub">{data.order.pieces.open === 0 && data.order.pieces.shipped > 0 ? t('list.allShipped') : '—'}</span>
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
    const MoreCell = ({ data }: ICellRendererParams<ListRow>) => {
      if (!data) return null
      const prefix = latest.current.model.prefix
      const name = yoursOf(data, locale) ?? t(kindKey(data))
      if (data.kind === 'request') {
        const href = rowHref(prefix, data)!
        return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('row.requestMenu', { name }) }} items={[{ id: 'open', label: t('row.openRequest'), href }]} />
      }
      if (!rowHref(prefix, data)) return null
      const id = data.order.id
      const items: MenuItemDef[] = [
        { id: 'open', label: t('row.open'), href: recordHref(prefix, id) },
        { id: 'lines', label: t('row.lines'), href: recordHref(prefix, id, 'lines') },
        { id: 'shipments', label: t('row.shipments'), href: recordHref(prefix, id, 'shipments') },
        { id: 'messages', label: t('row.messages'), href: recordHref(prefix, id, 'messages') },
      ]
      // B-TH-303: the menu names the customer's own number, never the office's.
      return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('row.requestMenu', { name }) }} items={items} />
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<ListRow>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number; maxWidth?: number }): ColDef<ListRow> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    const subjectOf = (row?: ListRow) => (row?.kind === 'request' ? row.request.subject : '')
    // Minimum widths fit a 1440 screen without the grid scrolling sideways (the flex shares the rest at 1920, with Next shipment).
    return [
      // The phone card's title is the column's text: their PO first, the customer's own number.
      { ...column('number', t('col.number'), NumberCell, { flex: 1.3, minWidth: 176 }), valueGetter: ({ data }) => (data ? [data.kind === 'request' ? data.request.customerRef : data.order.customerRef, yoursOf(data, locale)].filter(Boolean).join(' · ') || t(kindKey(data)) : '') },
      { ...column('kind', t('col.kind'), KindCell, { flex: 0.6, minWidth: 104 }), valueGetter: ({ data }) => (data ? t(kindKey(data)) : '') },
      { ...column('subject', t('col.subject'), SubjectCell, { flex: 1.2, minWidth: 124 }), valueGetter: ({ data }) => subjectOf(data) },
      { ...column('date', t('col.date'), DateCell, { flex: 0.6, minWidth: 104 }), valueGetter: ({ data }) => (data ? (data.kind === 'request' ? day(data.request.receivedAt.slice(0, 10)) : data.order.orderedOn ? day(data.order.orderedOn) : '') : '') },
      { ...column('status', t('col.status'), StatusCell, { flex: 0.9, minWidth: 136 }), valueGetter: ({ data }) => (data ? rowState(data, locale).words : '') },
      { ...column('promise', t('col.wanted'), PromiseCell, { flex: 0.7, minWidth: 124 }), valueGetter: ({ data }) => (data ? (data.kind === 'request' ? (data.request.wantedDate ? day(data.request.wantedDate) : '') : data.order.promiseDate ? day(data.order.promiseDate) : '') : '') },
      { ...column('pieces', t('col.pieces'), PiecesCell, { flex: 0.8, minWidth: 104 }), valueGetter: ({ data }) => (data ? (data.kind === 'request' ? (data.request.pieces > 0 ? t('list.piecesAsked', { count: data.request.pieces }) : '') : [t('list.piecesShipped', { shipped: data.order.pieces.shipped, ordered: data.order.pieces.ordered }), data.order.pieces.open > 0 ? t('list.piecesOpen', { count: data.order.pieces.open }) : null].filter(Boolean).join(' · ')) : '') },
      ...(seesPrices ? [{ ...column('value', t('col.value'), ValueCell, { flex: 0.7, minWidth: 104 }), valueGetter: ({ data }: { data?: ListRow }) => (data?.kind === 'order' ? words.money(data.order.netAmount, data.order.currency) : '') }] : []),
      ...(wide ? [{ ...column('next', t('col.nextShipment'), NextCell, { flex: 1, minWidth: 140 }), valueGetter: ({ data }) => (data?.kind === 'order' && data.order.nextShipment ? [data.order.nextShipment.date ? day(data.order.nextShipment.date) : null, data.order.nextShipment.carrierName].filter(Boolean).join(' · ') : '') } as ColDef<ListRow>] : []),
      { ...column('actions', t('col.actions'), MoreCell, { width: 72, minWidth: 72, maxWidth: 72 }), pinned: 'right', suppressHeaderMenuButton: true },
    ]
  }, [t, locale, day, words, ds.refPair, seesPrices, wide])

  const count = model.selected.length
  const bulk = (
    <Button size="sm" onClick={() => actions?.onExport?.(model.selected)} aria-label={t('bulk.export', { count })}>
      <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count })}</SelectionLabel>
    </Button>
  )

  const searching = model.q.trim() !== ''
  const filtered = searching || (model.chip !== null && model.chip !== 'OPEN')
  const requestsShown = model.requests.state === 'ready' ? listRows(chip, model.q, model.requests.rows, [], locale).length : 0
  const state: ReactNode =
    model.state === 'error' ? (
      <EmptyState title={t('list.failed')} description={t('list.failedBody')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('state.retry')}</Button>} />
    ) : rows !== null && rows.length === 0 ? (
      filtered ? (
        <EmptyState title={t('list.noMatch')} description={searching ? t('list.noMatchSearch', { q: model.q.trim() }) : t('list.noMatchChip')} action={<Button size="sm" onClick={() => actions?.onClear?.()}>{t('list.clear')}</Button>} />
      ) : (
        <EmptyState
          icon={<PackageSearch size={24} aria-hidden />}
          title={t('list.empty')}
          description={t('list.emptyBody')}
          // B-W2b-194: New order from the empty list.
          action={model.newOrderHref ? <Button size="sm" variant="primary" asChild><a href={model.newOrderHref}>{t('band.newOrder')}</a></Button> : undefined}
        />
      )
    ) : undefined

  const ownKeys: ListKey[] = []
  // The orders read so far against the chip's count, plus the chip's requests (every one is read).
  const total = read ? read.count + requestsShown : 0
  const shownCount = read && rows ? (rows.length < total ? t('list.countOf', { shown: rows.length, count: total }) : t('list.count', { count: total })) : ''

  return (
    <div className="fw-pord">
      {model.offlineSince ? <Banner tone="warning" icon={<WifiOff size={16} aria-hidden />} title={t('offline.title', { time: time(model.offlineSince) })} /> : null}
      <div className="fw-pord-chiprow">
        <div className="fw-pord-chips" role="group" aria-label={t('chips.label')}>
          {chips.map((entry) => (
            <FilterChip key={entry.chip} pressed={entry.chip === chip} onClick={() => actions?.onChip?.(entry.chip)} aria-label={t('chips.chip', { name: entry.label, count: entry.count })}>
              {entry.label} <span className="fw-pord-chip-count">{entry.count}</span>
            </FilterChip>
          ))}
        </div>
        {filtered ? (
          <Button size="sm" variant="quiet" onClick={() => actions?.onClear?.()}>
            {t('chips.clear')}
          </Button>
        ) : null}
      </div>
      {read && !read.seesPrices ? <PricesNote /> : null}
      {model.requests.state === 'error' ? <ReadFailed title={t('list.requestsFailed')} onRetry={actions?.onRetryRequests} /> : null}
      <ListFrame<ListRow>
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
        onOpen={(row) => (rowHref(model.prefix, row) ? actions?.onOpen?.(row) : undefined)}
        state={state}
        cards={{ hrefOf: (row) => rowHref(model.prefix, row) }}
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
  // B-TH-303: a parcel names its order by the customer's own number (from the orders read), never the office's series.
  const own = new Map(model.rows.map((row) => [row.id, ownRef({ kind: 'order', id: row.id, order: row }, locale)]))
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
                  <RefPair theirs={row.order.customerRef} ours={own.get(row.order.id)?.value ?? null} theirsLabel={t('ref.yours')} oursLabel={own.get(row.order.id)?.label ?? ''} size="sm" copy={false} labels={ds.refPair} />
                  <span className="fw-pord-sub">{t('transit.shipment', { number: row.number })}</span>
                </span>
              }
              onClick={() => actions?.onOpenShipment?.(row)}
              description={t('transit.open', { number: [row.order.customerRef, own.get(row.order.id) ? `${own.get(row.order.id)!.label} ${own.get(row.order.id)!.value}` : null].filter(Boolean).join(' · ') })}
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
