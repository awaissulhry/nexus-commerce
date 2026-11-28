'use client'

import { useMemo, useRef, type ReactNode } from 'react'
import Link from 'next/link'
import { PackageSearch, Search } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import type { ListCards } from '../../../../list-frame/w2b/model'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
// pg-w2 (portal grid plan § 2): the SAME parts the office's Work tab draws — the groups band, the order cells, the phone card, the
// bubble, the picture — each with its customer face; the portal fills them from its own read only.
import { isCustomerGroup, type CustomerGroup } from '../../../../lib/order-groups/groups'
import { GroupsBand } from '../../../../lib/order-groups/view/GroupsBand'
import { DoorCell } from '../../../../lib/order-cells/view/DoorCell'
import { StateChip } from '../../../../lib/order-cells/view/StateChip'
import { MarkChip } from '../../../../lib/order-cells/view/MarkChip'
import { PromiseCell } from '../../../../lib/order-cells/view/PromiseCell'
import { ShippedCell } from '../../../../lib/order-cells/view/ShippedCell'
import { OrderCard } from '../../../../lib/order-cells/view/OrderCard'
import { useRoomWidth } from '../../../../lib/order-cells/use-room-width'
import { useCellWords } from '../../../../lib/order-cells/words'
import { RecordPicture } from '../../../../lib/record-picture/view/RecordPicture'
// owb-po7.3: the picture as a button, the life word, Waits · news and Details (the customer's own columns as chips).
import type { OrderRow } from '../api'
import { detailsOf, lifeOf, pictureDoorOf, waitChipsOf, type WaitChip } from '../sheet/model'
import { PictureButton, SHEET_NS, WaitsChips } from '../sheet/view/SheetParts'
import { OwnChips } from '../../../../lib/order-lines/own-columns/OwnChips'
import type { ReadPictures } from '../../../../lib/record-picture/cache'
import { LAST_MESSAGE_NS } from '../../../../lib/last-message-cell/view/LastMessageCell'
import { MessagesHeader, NewMessagesBubble } from '../../../../lib/last-message-cell/view/NewMessagesBubble'
import { unreadValue, type UnreadMap } from '../../../../lib/last-message-cell/model'
import type { RequestRow } from '../../requests/api'
import type { OrderRow, OrdersRead } from '../api'
import { portalCellText, portalColumnLabel, portalColumnsOf, type ListRow } from '../model'
import { bandOf, countOf, LIST_CARD_EDGES, LIST_WIDTHS, listRowsOf, roomColumnsOf, rowViewOf, type ListRowView, type ListWords } from '../list-view-model'
import { useOrderWords } from '../words'
import { PricesNote, ReadFailed } from './parts'
import '../orders.css'
import '../list.css'

/**
 * SCR-184 › Orders & requests (B-W2b-191; B-TH-223; pg-w2 — portal grid plan § 3, 10-design § 1): the customer's orders and requests
 * with the face of the office's customer page › Work tab, drawn by the SAME shared parts. Top to bottom: ONE band of groups (Requests ·
 * Confirmed · In production · Ready to ship · Shipped · Delivered; Cancelled and Closed requests apart; the server's numbers), the list
 * frame's toolbar (the count, the search, "N updates · Show"; no selection: no bulk act stays), then a grid that FITS its card —
 * Picture · Number ("Your order 12" / your PO; a request's subject) · Where it is (the status chip + at most one mark) · Promised (+
 * "was …") · Ordered (from 1600 px of room) · Shipped · New messages (the bubble) · Net value (price grain only) · the columns the
 * office ticked for this customer, one at a time while the room holds them. Every cell is a door; a catalogue request is plain. On a
 * phone the shared Work card. No Kind, Subject, Date, ⋯, no "On the way" (D7), no export but the band's Download (Excel).
 */

export interface OrdersListViewModel {
  state: 'loading' | 'error' | 'ready'
  /** The sheet's read: the group's rows, the band's numbers, the portal columns, the price grain. */
  read: OrdersRead | null
  /** Every order row read so far (pages of 50). */
  rows: readonly OrderRow[]
  // B-TH-223: the customer's requests (GET /portal/inquiries, every state; `none`: not part of the reader's access).
  requests: { state: 'loading' | 'error' | 'ready' | 'none'; rows: readonly RequestRow[]; complete: boolean }
  /** The group shown (the address's `?chip=`); null: everything open. */
  group: CustomerGroup | null
  q: string
  prefix: string
  /** Live: the list changed since it was read. */
  updates: number
  /** No connection: what was loaded and when. */
  offlineSince: string | null
  /** More rows than shown: the footer's "Show more". */
  more: { loading: boolean } | null
  /** B-W2b-194: New order's address for a person who may order (the empty state's action), else null. */
  newOrderHref?: string | null
  /** Design cases: the keys panel open; the groups' window open. */
  keysOpen?: boolean
  windowOpen?: boolean
  /** B-TH-230: the person's own new messages per row (one read of the rows shown); null/absent: no column. */
  unread?: UnreadMap | null
  /** B-TH-246: "Download (Excel)" could not be made (said with Try again). */
  downloadFailed?: boolean
  /** D4: the walled picture read of the customer's own orders (the page's own client); none: the quiet "no picture". */
  pictures?: ReadPictures | null
  /** Design cases: the picture to draw per order. */
  demoPictures?: Readonly<Record<string, string>>
}

export interface OrdersListActions {
  /** owb-po7.3: the picture of a row was pressed (a reader who may change it): the window "The picture of the order" opens here. */
  onPicture?: (row: OrderRow) => void
  /** owb-po7.3: a "Waits · news" chip was pressed: the chat, the design window or the order. */
  onWait?: (row: OrderRow, chip: WaitChip) => void
  /** A group's door (pressed again: everything open); null: everything open. */
  onGroup?: (group: CustomerGroup | null) => void
  onSearch?: (q: string) => void
  /** "Clear the search": the box empties too (G1-B10). */
  onClearSearch?: () => void
  onOpen?: (row: ListRow) => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onMore?: () => void
  onHelp?: () => void
  onRetryRequests?: () => void
  /** B-TH-246: "Download (Excel)" again after it failed. */
  onDownloadAll?: () => void
}

export function OrdersListView({ model, actions, above }: { model: OrdersListViewModel; actions?: OrdersListActions; above?: ReactNode }) {
  return (
    <WithMessages namespaces={[LAST_MESSAGE_NS, SHEET_NS]}>
      <List model={model} actions={actions} above={above} />
    </WithMessages>
  )
}

/** owb-po7 (owb-po1): a sent or draft order (a request) asks its picture under requestIds; a confirmed order under orderIds. */
const pictureSourceOf = (row: ListRow | undefined): 'customerOrder' | 'customerRequest' => (row?.kind === 'order' && row.order.kind !== 'ORDER' ? 'customerRequest' : 'customerOrder')

/** One column's part on the phone card (the list frame's card list). */
type CardField = NonNullable<ListCards<ListRow>['fields']>[string]

/** The grid's room: the list's own width less the card's edges (never the window: the room rule of the Work tab). */
const roomOf = (width: number): number => Math.max(0, Math.floor(width) - LIST_CARD_EDGES)

function List({ model, actions, above }: { model: OrdersListViewModel; actions?: OrdersListActions; above?: ReactNode }) {
  const ts = useT(SHEET_NS) // owb-po7
  const l = useT(LAST_MESSAGE_NS) // B-TH-230: the shared message cell's words (the portal's "voi" in outside-words)
  const words = useOrderWords()
  const cells = useCellWords()
  const { t, locale } = words
  const read = model.read
  const seesPrices = read?.seesPrices ?? true
  const room = useRoomWidth(roomOf, 0)
  const listWords = useMemo((): ListWords => ({ t, list: cells.list, locale, day: words.day, money: words.money }), [t, cells.list, locale, words])
  // Requests first (the one that needs you on top), then the orders read; null while the first read runs.
  const rows = model.state === 'loading' && !read ? null : listRowsOf(model.group, model.q, model.requests.state === 'ready' ? model.requests.rows : [], model.rows, locale)
  const views = useMemo(() => new Map((rows ?? []).map((row) => [row.id, rowViewOf(row, { prefix: model.prefix, seesPrices, words: listWords })])), [rows, model.prefix, seesPrices, listWords])
  const latest = useRef({ model, actions, views })
  latest.current = { model, actions, views }
  const portal = portalColumnsOf(read)
  const fit = roomColumnsOf(room.value, { seesPrices, messages: !!model.unread, portal: portal.length })

  const columns = useMemo((): ColDef<ListRow>[] => {
    const viewOf = (data: ListRow | undefined): ListRowView | null => (data ? (latest.current.views.get(data.id) ?? null) : null)
    const fixed = (width: number) => ({ width, minWidth: width, maxWidth: width })
    const door = (view: ListRowView, children: ReactNode, strong?: boolean) => (
      <DoorCell door={view.door} t={t} strong={strong}>
        {children}
      </DoorCell>
    )
    const PictureCell = ({ data }: ICellRendererParams<ListRow>) => {
      const view = viewOf(data)
      if (!view?.picture) return null
      const picture = <RecordPicture source={pictureSourceOf(data)} recordId={view.id} number={view.number.text} size="cell" read={latest.current.model.pictures ?? null} {...(latest.current.model.demoPictures?.[view.id] ? { demo: latest.current.model.demoPictures[view.id] } : {})} />
      // owb-po7.3 (§ 5zj A): for a reader who may change it, the picture is a button (a camera on hover): the window opens here.
      const order = data?.kind === 'order' ? data.order : null
      const onPicture = latest.current.actions?.onPicture
      if (order && onPicture && pictureDoorOf(order)) return <PictureButton picture={picture} label={ts('ordersSheet.picture')} onPress={() => onPicture(order)} />
      return view.href ? (
        <Link className="fw-pgl-pic" href={view.href} title={t('row.open')} data-door="">
          {picture}
        </Link>
      ) : (
        picture
      )
    }
    const NumberCell = ({ data }: ICellRendererParams<ListRow>) => {
      const view = viewOf(data)
      if (!view) return null
      return (
        <span className="fw-ocl-stack">
          {view.kind === 'catalogue' ? (
            // pg-fx4 (Z5, Z7): an order request's name (its subject, else your PO, else the kind's words): no page, so plain — strong,
            // one line, the whole of it in its tip.
            <span className="fw-sheet-plain fw-pgl-strong" title={view.number.text}>
              {view.number.text}
            </span>
          ) : (
            <DoorCell door={view.number.door} t={t} strong>
              {view.number.text}
            </DoorCell>
          )}
          {view.number.sub ? (
            <span className="fw-ocl-sub" title={view.number.sub}>
              {view.number.sub}
            </span>
          ) : null}
        </span>
      )
    }
    const WhereCell = ({ data }: ICellRendererParams<ListRow>) => {
      const view = viewOf(data)
      if (!view) return null
      const life = data?.kind === 'order' ? lifeOf(data.order) : null
      const note = data?.kind === 'order' ? (data.order.lifeNote ?? null) : null
      const chips = (
        <span className="fw-sheet-wi">
          {life ? <StateChip life={life} note={note} /> : <StateChip chip={view.state} />}
          {view.mark ? <MarkChip chip={view.mark} /> : null}
        </span>
      )
      // Every cell a door (the row's page); a catalogue request stays plain (Z7).
      return view.door && 'href' in view.door ? (
        <Link className="fw-pgl-where" href={view.door.href} title={t(view.door.tip.key)} data-door="">
          {chips}
        </Link>
      ) : (
        chips
      )
    }
    const WaitsCell = ({ data }: ICellRendererParams<ListRow>) => {
      if (data?.kind !== 'order') return null
      const order = data.order
      return <WaitsChips chips={waitChipsOf(order.waits)} onChip={(chip) => latest.current.actions?.onWait?.(order, chip)} />
    }
    const DetailsCell = ({ data }: ICellRendererParams<ListRow>) => {
      if (data?.kind !== 'order') return null
      const details = detailsOf(data.order, latest.current.model.read?.ownColumns ?? [])
      return details.columns.length > 0 ? <OwnChips columns={details.columns} lines={details.lines} /> : <span className="fw-ocl-sub">—</span>
    }
    const PromisedCell = ({ data }: ICellRendererParams<ListRow>) => {
      const view = viewOf(data)
      return view ? <PromiseCell cell={view.promise} t={t} /> : null
    }
    const OrderedCell = ({ data }: ICellRendererParams<ListRow>) => {
      const view = viewOf(data)
      return view ? (
        <DoorCell door={view.ordered.door} t={t}>
          {view.ordered.day ?? '—'}
        </DoorCell>
      ) : null
    }
    const ShippedColumn = ({ data }: ICellRendererParams<ListRow>) => {
      const view = viewOf(data)
      if (!view) return null
      return 'bar' in view.shipped ? <ShippedCell cell={view.shipped.bar} t={t} /> : <span className="fw-sheet-plain">{view.shipped.asked}</span>
    }
    const MessagesCell = ({ data }: ICellRendererParams<ListRow>) => {
      const view = viewOf(data)
      return view ? <NewMessagesBubble unread={latest.current.model.unread?.[view.id]} href={view.messages.href} record={view.messages.record} l={l} /> : null
    }
    const ValueCell = ({ data }: ICellRendererParams<ListRow>) => {
      const view = viewOf(data)
      if (!view) return null
      return view.value ? door(view, <span className="fw-pgl-num">{view.value.text}</span>) : <span className="fw-ocl-sub">—</span>
    }
    const column = (colId: string, headerName: string, cellRenderer: ColDef<ListRow>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number; maxWidth?: number }, valueGetter?: (view: ListRowView) => string, more: Partial<ColDef<ListRow>> = {}): ColDef<ListRow> => ({
      colId,
      headerName,
      cellRenderer,
      sortable: false,
      ...size,
      ...(valueGetter ? { valueGetter: ({ data }: { data?: ListRow }) => { const view = viewOf(data); return view ? valueGetter(view) : '' } } : {}),
      ...more,
    })
    const plainHead = { suppressHeaderMenuButton: true }
    const tight = { cellClass: 'fw-pgl-tight', headerClass: 'fw-pgl-tight' }
    const snug = { cellClass: 'fw-pgl-snug', headerClass: 'fw-pgl-snug' }
    return [
      column('picture', t('col.picture'), PictureCell, fixed(LIST_WIDTHS.picture), undefined, { ...tight, ...plainHead }),
      // The phone card's title is the column's text: the customer's own number, else their PO, else the kind.
      column('number', t('col.number'), NumberCell, { minWidth: LIST_WIDTHS.number, flex: 0.8 }, (view) => view.number.text),
      column('whereItIs', t('col.whereItIs'), WhereCell, { minWidth: LIST_WIDTHS.whereItIs, flex: 1.4 }, (view) => view.state.words, snug),
      // owb-po7.3: Waits · news (each chip a door) and Details (the customer's own columns: two chips, then "+ n"); no price column.
      column('waits', ts('ordersSheet.col.waits'), WaitsCell, { minWidth: 180, flex: 1 }),
      ...((read?.ownColumns ?? []).length > 0 ? [column('details', ts('ordersSheet.col.details'), DetailsCell, { minWidth: 160, flex: 0.9 })] : []),
      column('promised', t('col.promised'), PromisedCell, fixed(LIST_WIDTHS.promised), (view) => view.promise.day ?? '', { ...snug, ...plainHead }),
      ...(fit.ordered ? [column('ordered', t('col.orderedOn'), OrderedCell, fixed(LIST_WIDTHS.ordered), (view) => view.ordered.day ?? '', { ...snug, ...plainHead })] : []),
      column('shipped', t('col.shipped'), ShippedColumn, fixed(LIST_WIDTHS.shipped), (view) => ('bar' in view.shipped ? cells.sheet('shippedOf', { shipped: view.shipped.bar.shipped, units: view.shipped.bar.units }) : view.shipped.asked)),
      // B-TH-230 (Z10): New messages as the bubble "2" — the person's own; its door the record's conversation. The header: the mark.
      ...(model.unread
        ? [
            column('newMessages', l('column'), MessagesCell, fixed(LIST_WIDTHS.newMessages), undefined, {
              ...tight,
              ...plainHead,
              headerTooltip: l('columnHint'),
              headerComponentParams: { innerHeaderComponent: MessagesHeader },
              valueGetter: ({ data }: { data?: ListRow }) => unreadValue(data ? latest.current.model.unread?.[data.id] : undefined),
            }),
          ]
        : []),
      ...(seesPrices ? [column('value', t('col.value'), ValueCell, fixed(LIST_WIDTHS.value), (view) => view.value?.text ?? '', { cellClass: 'fw-pgl-right', headerClass: 'fw-pgl-right' })] : []),
      // B-TH-246 (Owner decision 13, D8): the columns the office ticked for this customer, read-only, each a door to the order; they join
      // one at a time while the room holds them (the rest are in Download (Excel) and on the order page).
      ...portal.slice(0, fit.portal).map((entry): ColDef<ListRow> => {
        const text = (data?: ListRow) => (data?.kind === 'order' ? portalCellText(entry, data.order.values?.[entry.columnId], locale, { yes: t('sheet.yes'), no: t('sheet.no'), day: words.day }) : null)
        const Cell = ({ data }: ICellRendererParams<ListRow>) => {
          const view = viewOf(data)
          if (!view) return null
          const said = text(data)
          return said === null ? <span className="fw-ocl-sub">—</span> : door(view, said)
        }
        // pg-fx3 (walk W-04): its head wraps to two lines (the Work tab's wrapHeads), never cut; its tip names the column, then the hint.
        const label = portalColumnLabel(entry, locale)
        return { ...column(entry.columnId, label, Cell, fixed(LIST_WIDTHS.portal)), wrapHeaderText: true, headerClass: 'fw-pgl-hwrap', headerTooltip: `${label} · ${t('sheet.columnHint')}`, valueGetter: ({ data }: { data?: ListRow }) => text(data) ?? '' }
      }),
    ]
  }, [t, l, ts, cells, locale, words, seesPrices, model.unread ? 1 : 0, read?.columns, read?.ownColumns, fit.ordered, fit.portal])

  // The phone (D3): the shared Work card — the number (a door) and the bubble on top; the picture at the left (orders only); the PO or
  // the request's subject; the chips; Promised (+ "was …") and the pieces.
  const cardFields = useMemo(() => {
    const viewOf = (row: ListRow): ListRowView | null => latest.current.views.get(row.id) ?? null
    const promiseLine = (view: ListRowView): ReactNode => {
      const { promise } = view
      if (!promise.day) return <span>{promise.of === 'wanted' ? '' : cells.orders('list.noPromise')}</span>
      const head = promise.of === 'asked' ? cells.list('customer.promise.asked') : promise.of === 'wanted' ? cells.list('customer.promise.wanted') : t('col.promised')
      return (
        <span>
          {head} <b>{promise.day}</b>
          {promise.was ? (
            <>
              {' '}
              <span className="fw-ocl-sub is-warn">{cells.list('customer.promise.was', { date: promise.was })}</span>
            </>
          ) : null}
        </span>
      )
    }
    // owb-po7.4: on a phone the picture is its OWN button (the camera always shows); the card's title stays the order's link.
    const cardPicture = (row: ListRow, view: ListRowView): ReactNode => {
      const picture = <RecordPicture source={pictureSourceOf(row)} recordId={view.id} number={view.number.text} size="phone" read={latest.current.model.pictures ?? null} {...(latest.current.model.demoPictures?.[view.id] ? { demo: latest.current.model.demoPictures[view.id] } : {})} />
      const onPicture = latest.current.actions?.onPicture
      return row.kind === 'order' && onPicture && pictureDoorOf(row.order) ? <PictureButton picture={picture} label={ts('ordersSheet.picture')} onPress={() => onPicture(row.order)} /> : picture
    }
    const block = (row: ListRow): ReactNode => {
      const view = viewOf(row)
      if (!view) return null
      return (
        <OrderCard
          {...(view.picture ? { picture: cardPicture(row, view) } : {})}
          sub={view.number.sub ? <span className="fw-ocl-sub fw-pgl-wrap">{view.number.sub}</span> : null}
          chips={
            <>
              {row.kind === 'order' && lifeOf(row.order) ? <StateChip life={lifeOf(row.order)!} note={row.order.lifeNote ?? null} /> : <StateChip chip={view.state} />}
              {view.mark ? <MarkChip chip={view.mark} /> : null}
              {row.kind === 'order' ? <WaitsChips chips={waitChipsOf(row.order.waits)} onChip={(chip) => latest.current.actions?.onWait?.(row.order, chip)} /> : null}
            </>
          }
          promise={
            <>
              {promiseLine(view)}
              <span>{'bar' in view.shipped ? t('list.piecesShipped', { shipped: view.shipped.bar.shipped, ordered: view.shipped.bar.units }) : view.shipped.asked}</span>
            </>
          }
        />
      )
    }
    const fields: Record<string, CardField> = {}
    for (const column of columns) if (column.colId) fields[column.colId] = { role: 'hidden' }
    // pg-fx4: the title wraps (an order request's subject is never cut on a phone: no tip there).
    fields.number = { role: 'title', draw: (row) => <span className="fw-sheet-plain fw-pgl-wrap">{viewOf(row)?.number.text ?? ''}</span> }
    fields.whereItIs = { role: 'subtitle', draw: block }
    fields.newMessages = { role: 'aside', draw: (row) => <NewMessagesBubble unread={latest.current.model.unread?.[row.id]} href={viewOf(row)?.messages.href ?? null} record={viewOf(row)?.messages.record ?? ''} l={l} /> }
    return fields
  }, [columns, cells, t, l, ts])

  const band = bandOf(read, model.state, model.group)
  const searching = model.q.trim() !== ''
  const state: ReactNode =
    model.state === 'error' ? (
      <EmptyState title={t('list.failed')} description={t('list.failedBody')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('state.retry')}</Button>} />
    ) : rows !== null && rows.length === 0 ? (
      searching ? (
        // pg-fx3 (walk W-07; 10-design § 2): the empty states draw the picture's mark — the magnifier.
        <EmptyState icon={<Search size={24} aria-hidden />} title={t('list.noMatchSearch', { q: model.q.trim() })} action={<Button size="sm" onClick={() => actions?.onClearSearch?.()}>{t('list.clearSearch')}</Button>} />
      ) : model.group !== null ? (
        <EmptyState icon={<Search size={24} aria-hidden />} title={t('list.noMatch')} description={t('list.noMatchChip')} action={<Button size="sm" onClick={() => actions?.onGroup?.(null)}>{t('list.clear')}</Button>} />
      ) : (
        <EmptyState
          icon={<PackageSearch size={24} aria-hidden />}
          title={t('list.empty')}
          // G1-B11: who may not order is never told to press New order.
          description={model.newOrderHref ? t('list.emptyBody') : t('list.emptyBodyView')}
          action={model.newOrderHref ? <Button size="sm" variant="primary" asChild><a href={model.newOrderHref}>{t('band.newOrder')}</a></Button> : undefined}
        />
      )
    ) : undefined

  const ownKeys: ListKey[] = []
  const requestsShown = rows ? rows.filter((row) => row.kind === 'request').length : 0
  const total = countOf(read, model.group, requestsShown)
  const shownCount = total !== null && rows && model.state !== 'error' ? (rows.length < total ? t('list.countOf', { shown: rows.length, count: total }) : t('list.count', { count: total })) : ''

  return (
    <div className="fw-pord fw-pgl" ref={room.ref}>
      {/* pg-fx3 (walk W-03): no connection is said ONCE — by the portal shell's own banner; the list keeps its rows and holds Show more. */}
      <GroupsBand
        model={{ face: 'customer', groups: band.groups, total: band.total, needsYou: band.needsYou, shown: band.shown, state: band.state, ...(model.windowOpen ? { windowOpen: true } : {}) }}
        actions={{
          onGroup: (group) => actions?.onGroup?.(isCustomerGroup(group) && group !== model.group ? group : null),
          onEverything: () => actions?.onGroup?.(null),
          ...(actions?.onRetry ? { onRetry: actions.onRetry } : {}),
        }}
      />
      {/* owb-po7.2: the drafts bar, the line after Send, the Withdrawn chip (the host's). */}
      {above ? <div className="fw-pos-top">{above}</div> : null}
      {read && !read.seesPrices ? <PricesNote /> : null}
      {/* B-TH-246: the file could not be made — in words, with Try again. */}
      {model.downloadFailed ? <Banner tone="danger" title={t('sheet.downloadFailed')} action={actions?.onDownloadAll ? <Button size="sm" onClick={actions.onDownloadAll}>{t('state.retry')}</Button> : undefined} /> : null}
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
            // G1-B10: the box follows the address — "Clear the search" empties it too.
            key={model.q}
            type="search"
            fieldClassName="fw-pgl-search"
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
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.more ? { label: t('list.more'), onMore: () => actions?.onMore?.(), held: model.more.loading ? t('held.busy') : model.offlineSince ? t('held.offline') : null } : null}
        keys={ownKeys}
        onHelp={actions?.onHelp}
        onOpen={(row) => (latest.current.views.get(row.id)?.href ? actions?.onOpen?.(row) : undefined)}
        state={state}
        cards={{ fields: cardFields, hrefOf: (row) => latest.current.views.get(row.id)?.href ?? null }}
        keysOpen={model.keysOpen}
      />
    </div>
  )
}
