'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ExternalLink, Filter, MoreHorizontal, Plus, Search } from 'lucide-react'
import { Banner, EmptyState, Menu, MetricStrip, ProgressBar } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, SegmentedControl, Select, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import type { Locale } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { money } from '../../../quotes/model'
import { ORDER_STATUSES, type OrderRow, type OrderStatus } from '../../api'
import { dayInstant, depositTone, ROW_VIEWS, shippedPercent, STATUS_TONE, tileCount, TILES, viewCount, type Layout, type RowView } from '../../model'
// ---- B-TH-057 (TH-4: the server sort, the custom field filter) ----
import { columnSort, SORT_CHOICES, SORT_COLUMNS, sortOfColumn } from '../../model'
import type { OrderSort } from '../../api'
import type { OrdersListActions, OrdersListModel } from '../list-model'
import { NewOrderDialog } from './NewOrderDialog'
import { marginColumn } from '../margin/MarginColumn'
import { OrdersBoard } from './OrdersBoard'
// ---- B-W2b-323 (orders in depth on screen) ----
import { depthColumns, printVerb, SetPriorityButton, SetPriorityDialog } from '../../list-depth/view/ListDepth'
import { WeekBoard } from '../../week/view/WeekBoard'
import { OrdersImportView } from '../../import/view/OrdersImportView'
import { NAMESPACE as DEPTH } from '../../depth/model'
import '../../orders.css'
// ---- B-TH-225 / B-TH-226 (TH-1a: the Orders sheet, every cell a door; the Customer switcher) ----
import { brandCell, customerDoor, depositDoor, exportAbout, invoicedCell, invoicedDoor, linesDoor, NAMESPACE as SHEET, orderDoor, orderHref, quoteDoor, shippedDoor, type Door } from '../sheet/model'
import { CustomerSwitcher, DoorCell, FunnelButton, PeekCard, PeekLink, PictureThumb, PictureViewer, SheetChips, useSmallPicture, type SheetChip } from '../sheet/parts'
// B-TH-230: the New messages column (LastMessageCell).
import { LAST_MESSAGE_NS, LastMessageCell } from '../../../../../lib/last-message-cell/view/LastMessageCell'
import { unreadValue } from '../../../../../lib/last-message-cell/model'

export type { OrdersListActions, OrdersListModel } from '../list-model'

/**
 * SCR-038 — Orders (Sales; design sales.orders, 00 §2.1 list frame): the view switch (List · Board by state, the same
 * filters for both), the tiles (each a saved rows view: Late, Waiting for deposit, In production, Ready to ship), and
 * the shared list frame — search by number or customer PO; Rows ▾; select-all, shift range, x; Export N (CSV) while
 * rows are selected; live changes behind "N updates · Show" — each number a real link to the order studio, the deposit
 * in words, the promise with its days late, what left. B-W2a-50: New order (c; the dialog: customer, contact, customer PO,
 * the number it will get → the typed order's lines), the board in a new tab (left open on a second screen, it follows
 * live). Money only with the price grain: the columns are absent, never zero.
 * B-TH-057 (TH-4): the search reads the number, the PO, the customer, a style code and a label on the server; Sort ▾ and the
 * headers of Customer, Brand, Promised and Ordered sort every page on the server (`?sort=`); a custom field filter (`?cf=`) is a chip.
 */
export function OrdersListView({ model, actions }: { model: OrdersListModel; actions?: OrdersListActions }) {
  return (
    <WithMessages namespaces={['orders', 'lists', DEPTH /* B-W2b-323 */, SHEET /* B-TH-225 */, LAST_MESSAGE_NS /* B-TH-230 */]}>
      <OrdersList model={model} actions={actions} />
    </WithMessages>
  )
}

function OrdersList({ model, actions }: { model: OrdersListModel; actions?: OrdersListActions }) {
  const t = useT('orders')
  const lists = useT('lists')
  const d = useT(DEPTH) // B-W2b-323
  const s = useT(SHEET) // B-TH-225
  const l = useT(LAST_MESSAGE_NS) // B-TH-230
  const locale = useLocale()
  const wide = useWide(model.wide) // B-TH-225: Ordered, Margin %, Priority, Season and From quote at 1920
  const [viewer, setViewer] = useState<string | null>(model.viewerOpen ?? null)
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

  // v: List ⇄ Board (the design's view key); c: New order — never while typing or inside a dialog. The list frame keeps
  // / j k x Enter ?.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      // B-TH-225 (grid-F28, F29): o opens the focused cell's door; ⌘ / Ctrl + Enter opens it (or the row's order) in a new tab.
      const cell = target?.closest('.ag-cell')
      if (cell && !help && !model.newOrder && !target?.closest('input, textarea, select')) {
        const door = cell.querySelector<HTMLElement>('a[data-door], button.fw-sheet-funnel, button.fw-sheet-thumb')
        if (event.key === 'o' && !event.metaKey && !event.ctrlKey && !event.altKey && door) {
          event.preventDefault()
          door.click()
          return
        }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          const row = cell.closest('[row-id]')?.getAttribute('row-id')
          const href = door instanceof HTMLAnchorElement ? door.href : row ? orderHref(model.prefix, { id: row }) : null
          if (href) {
            event.preventDefault()
            window.open(href, '_blank', 'noopener')
          }
          return
        }
      }
      if (event.metaKey || event.ctrlKey || event.altKey || help || model.newOrder) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || target.isContentEditable)) return
      if (event.key === 'v') {
        event.preventDefault()
        actions?.onLayout?.(model.layout === 'list' ? 'board' : 'list')
      }
      if (event.key === 'c' && model.can.manage) {
        event.preventDefault()
        actions?.onNewOrder?.(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const picked = (items ?? []).filter((row) => selected.includes(row.id))
  const ownKeys: ListKey[] = [
    { keys: ['v'], does: t('list.keyView') },
    ...(model.can.manage ? [{ keys: ['c'], does: t('list.keyNew') }] : []),
    // B-TH-225: the doors' keys (the footer's information icon holds every key; none above the table).
    { keys: ['o'], does: s('keys.door') },
    { keys: ['⌘', 'Enter'], does: s('keys.doorTab') },
    { keys: ['Space'], does: s('keys.peek') },
  ]
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

  // ── B-TH-057 (SHEET-G15, feature SHEET.overall-F05): Sort ▾ — every choice sorts every page on the server (the address keeps it);
  // the headers of Customer, Brand, Promised and Ordered do the same. No header sorts only the loaded rows. ──
  const sortSelect = (
    <Select size="sm" aria-label={s('sort.label')} value={model.sort ?? ''} onChange={(event) => actions?.onSort?.((event.target.value || null) as OrderSort | null)}>
      {SORT_CHOICES.map((choice) => (
        <option key={choice.word} value={choice.value}>
          {s(`sort.${choice.word}`)}
        </option>
      ))}
    </Select>
  )
  // ── end B-TH-057 ──

  const columns = useMemo<ColDef<OrderRow>[]>(
    () => sheetColumns({ t, s, d, l, locale, model, wide, latest, onViewer: setViewer }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the cells read the latest model and actions through `latest`
    [t, s, d, l, locale, wide, model.prefix, model.today, model.can, model.margins, model.depth, model.companies, model.demoPictures, actions?.depth, model.sort /* B-TH-057 */, model.unread /* B-TH-230 */],
  )

  const narrowed = model.q.trim() !== '' || (model.rows !== 'open' && model.rows !== 'all') || !!model.customer || !!model.brand || !!model.company || !!model.cf // B-TH-201, B-TH-225, B-TH-057
  const clearFilters = () => {
    setQuery('')
    actions?.onClearAll?.() // B-TH-225: the search, the view, the customer, the label and the company at once
  }
  // ── B-TH-225 / B-TH-226: every narrowing is a chip (grid-F25); the switcher names the customer ──
  const statusView = (ORDER_STATUSES as readonly string[]).includes(model.rows) ? (model.rows as OrderStatus) : null
  const chips: SheetChip[] = [
    ...(model.customer ? [{ id: 'party', label: model.customer.name === null ? s('switcher.unknown') : s('chips.customer', { name: model.customer.name ?? '…' }), onClear: () => actions?.onCustomer?.(null) }] : []),
    ...(model.brand ? [{ id: 'brand', label: s('chips.brand', { name: model.brand.value === 'own' ? s('brand.own') : (model.brand.name ?? s('brand.unknown')) }), onClear: () => actions?.onBrand?.(null) }] : []),
    ...(statusView ? [{ id: 'status', label: s('chips.status', { status: t(`status.${statusView}`) }), onClear: () => actions?.onRows?.('open') }] : []),
    ...(model.company ? [{ id: 'company', label: s('chips.company', { name: model.company.name }), onClear: () => actions?.onCompany?.(null) }] : []),
    // B-TH-057 (SHEET-G05): a custom field filter of the address is a chip too (the list, its counts and its file apply it).
    ...(model.cf ? [{ id: 'cf', label: s('chips.cf', { terms: model.cf }), onClear: () => actions?.onClearCf?.() }] : []),
  ]
  const unavailable = model.customer?.name === null
  const count = viewCount(model.board, model.rows)
  const customerName = model.customer?.name ?? null
  const title = customerName ? s('titleOf', { name: customerName }) : s('title')
  const switcher = model.switcher ? (
    <CustomerSwitcher
      state={model.switcher}
      party={model.customer?.id ?? null}
      partyName={model.customer ? model.customer.name : undefined}
      t={s}
      query={model.switcher.query}
      searching={model.switcher.searching}
      onQuery={actions?.onCustomerSearch}
      onPick={(party) => actions?.onCustomer?.(party)}
      onRetry={actions?.onCustomerRetry}
      open={model.switcherOpen}
    />
  ) : null
  const about = exportAbout(s, { customer: customerName, view: t(`rows.${model.rows}`), count, price: model.can.price, formats: ['XLSX', 'CSV'], margin: !!model.margins && wide })
  const viewerRow = viewer ? (items ?? []).find((row) => row.id === viewer) ?? null : null
  // ── end B-TH-225 / B-TH-226 ──
  const state = model.list.problem ? (
    <EmptyState title={t('list.failed')} description={t(model.list.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : items && items.length === 0 ? (
    narrowed ? (
      <EmptyState title={t('list.noMatch.title')} description={t('list.noMatch.body')} action={<Button size="sm" onClick={clearFilters}>{t('list.clearFilters')}</Button>} />
    ) : (
      <EmptyState
        title={t('list.empty.title')}
        description={t('list.empty.body')}
        action={
          model.can.manage || model.can.viewQuotes ? (
            <span className="fw-so-inline">
              {model.can.manage && (
                <Button size="sm" variant="primary" onClick={() => actions?.onNewOrder?.(true)}>
                  {t('list.new')}
                </Button>
              )}
              {model.can.viewQuotes && (
                <Button size="sm" asChild>
                  <Link href={`${model.prefix}/sales/quotes`}>{t('list.empty.quotes')}</Link>
                </Button>
              )}
            </span>
          ) : undefined
        }
      />
    )
  ) : undefined

  const pressed = TILES.find((tile) => tile.rows === model.rows)?.key ?? null

  return (
    <div className="fw-so">
      <div className="fw-so-head">
        {/* B-TH-225 (band-F01, F10): the title follows the customer; the honest count of the view; as of. */}
        <div className="fw-sheet-band">
          <h2 className="fw-sheet-title">{title}</h2>
          {count !== null && <span className="fw-sheet-count">{s('count', { count })}</span>}
          <span className="fw-so-status" role="status">
            {model.asOf ? t('list.updated', { time: formatTime(model.asOf, { locale }) }) : t('list.notYet')}
            {' · '}
            {t(`live.${model.live}`)}
          </span>
        </div>
        <span className="fw-so-actions">
          <SegmentedControl
            size="sm"
            ariaLabel={t('list.layoutLabel')}
            value={model.layout}
            onChange={(value) => actions?.onLayout?.(value as Layout)}
            options={[
              { value: 'list', label: t('layout.list') },
              { value: 'board', label: t('layout.board') },
              // B-W2b-323: By promise week.
              ...(model.week !== undefined ? [{ value: 'week', label: t('layout.week') }] : []),
            ]}
          />
          <Button size="sm" variant="quiet" asChild>
            <a href={`${model.prefix}/sales/orders?view=board${model.customer ? `&party=${encodeURIComponent(model.customer.id)}` : '' /* B-TH-201 */}${model.brand ? `&brand=${encodeURIComponent(model.brand.value)}` : ''}${model.company ? `&company=${encodeURIComponent(model.company.id)}` : '' /* B-TH-225 */}`} target="_blank" rel="noopener" title={t('board.newTabHint')}>
              <ExternalLink size={14} aria-hidden /> <span>{t('board.newTab')}</span>
            </a>
          </Button>
          <Button size="sm" variant="primary" heldReason={model.can.manage ? null : t('held.noManage')} onClick={() => actions?.onNewOrder?.(true)} aria-keyshortcuts="c">
            <Plus size={14} aria-hidden /> {t('list.new')}
          </Button>
          {/* B-W2b-323: the band's ⋯ — Import orders (dry run first). */}
          {model.importer !== undefined && (
            <Menu
              label={<MoreHorizontal size={16} aria-hidden />}
              align="right"
              triggerProps={{ 'aria-label': d('list.more') }}
              items={[
                { id: 'import', label: d('import.action'), disabled: !!model.importer?.held, description: model.importer?.held ? d(model.importer.held) : d('import.hint'), onSelect: () => actions?.onImport?.() },
                // B-TH-225 (band-F08, Owner rule 2026-10-29): the keys live in the table footer's information icon only.
              ]}
            />
          )}
        </span>
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
        />
      )}

      <MetricStrip
        metrics={TILES.map((tile) => {
          const count = tileCount(model.board, tile.key)
          return {
            label: customerName ? s('tile', { label: t(`tile.${tile.key}`), name: customerName }) : t(`tile.${tile.key}`), // B-TH-226: the tiles count that customer
            value: count === null ? '—' : String(count),
            hint: count === null && model.board === null && model.asOf !== null ? t('tile.unknown') : undefined,
            onClick: () => actions?.onRows?.(model.rows === tile.rows ? 'open' : tile.rows),
            active: pressed === tile.key,
          }
        })}
      />

      {/* B-TH-225 / B-TH-226: a link to a customer the reader may not open (W27: the words name no one) */}
      {unavailable && (
        <Banner
          tone="warning"
          title={s('switcher.unavailable')}
          action={
            <Button size="sm" onClick={() => actions?.onCustomer?.(null)}>
              {s('switcher.showAll')}
            </Button>
          }
        >
          {s('switcher.unavailableBody')}
        </Banner>
      )}
      <SheetChips chips={chips} t={s} onClearAll={clearFilters} />

      {model.layout === 'week' && model.week ? (
        // B-W2b-323: By promise week (the search narrows it; the rows view does not apply: every open line).
        <WeekBoard model={model.week} prefix={model.prefix} search={searchField} onSite={actions?.onWeekSite} onRetry={actions?.onWeekRetry} />
      ) : model.layout === 'board' ? (
        <OrdersBoard model={model} actions={actions} search={searchField} rowsSelect={rowsSelect} onHelp={() => setHelp(true)} />
      ) : (
        <ListFrame<OrderRow>
          label={t('list.tableLabel')}
          rows={state ? [] : items}
          rowId={(row) => row.id}
          columns={columns}
          count={items ? (count !== null && items.length < count ? s('loadedOf', { loaded: items.length, total: count }) : t(model.list.more ? 'list.countMore' : 'list.count', { count: items.length })) : '—'}
          search={searchField}
          tools={
            <>
              {switcher /* B-TH-226 */}
              {rowsSelect}
              {sortSelect /* B-TH-057 */}
            </>
          }
          // B-TH-057: a header click sorts every page on the server (the address keeps it); the grid only shows the arrow.
          onSortChanged={(colId, direction) => actions?.onSort?.(colId ? sortOfColumn(colId, direction) : null)}
          title={customerName ? s('export.title', { customer: customerName }) : undefined /* B-TH-225: the export job names the customer */}
          exportAbout={about}
          onRowClick={(row, event) => actions?.onOpenRow?.(row.id, event.metaKey || event.ctrlKey)}
          cards={{ fields: CARD_FIELDS, hrefOf: (row) => orderHref(model.prefix, row) }}
          selection={{
            selected,
            onChange: setSelected,
            // B-TH-225 (ORD-G02): Export N goes through the export job with the picked ids (the same writer as the full list).
            exportSelected: true,
            actions: (
              <>
                {/* B-W2b-323: Set priority for N (one command over the selection). */}
                {model.depth && <SetPriorityButton count={picked.length} model={model.depth} onClick={() => actions?.depth?.onSetPriority?.(picked.map((row) => row.id))} />}
              </>
            ),
          }}
          updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
          more={model.list.more && items && items.length > 0 ? { label: t('list.more'), onMore: () => actions?.onMore?.() } : null}
          keys={ownKeys}
          onHelp={() => setHelp(true)}
          onOpen={(row) => actions?.onOpen?.(row.id)}
          state={state}
          focusRow={model.focusRow}
        />
      )}
      {model.rows !== 'open' && model.layout !== 'week' && <p className="fw-so-hint">{t('list.viewing', { view: t(`rows.${model.rows}`) })}</p>}

      {viewerRow && <PictureViewerFor row={viewerRow} model={model} actions={actions} t={s} onClose={() => setViewer(null)} /> /* B-TH-225 */}
      {model.newOrder && <NewOrderDialog model={model.newOrder} actions={actions} />}
      {/* B-W2b-323: Set priority, Import orders. */}
      {model.depth && <SetPriorityDialog model={model.depth} actions={actions?.depth} />}
      {model.importer && <OrdersImportView model={model.importer} actions={actions?.importActions} />}

      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('list.keysTitle')} size="sm">
          <ul className="fw-so-list">
            {listKeys(model.layout === 'board' ? [...ownKeys, { keys: ['j', 'k'], does: t('board.keyWalk') }] : ownKeys, true).map((entry) => (
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

// ── B-TH-225 (threads plan TH-1a, picture 23; Owner rule 2026-11-16 "every cell is a door"; features grid-F01…F30) ──────────

type Translate = (key: string, params?: Record<string, string | number>) => string

/** The wide columns (Ordered, Margin %, Priority, Season, From quote) show from 1800 px (the 1920 screen); a design case says so. */
function useWide(forced: boolean | undefined): boolean {
  const query = '(min-width: 1800px)'
  const [wide, setWide] = useState(() => forced ?? (typeof window !== 'undefined' && !!window.matchMedia?.(query).matches))
  useEffect(() => {
    if (forced !== undefined) return setWide(forced)
    const media = window.matchMedia?.(query)
    if (!media) return
    const follow = () => setWide(media.matches)
    follow()
    media.addEventListener('change', follow)
    return () => media.removeEventListener('change', follow)
  }, [forced])
  return wide
}

/** The phone card (grid-F22): the picture, the number, the customer, the brand, the status and the promise; the row's ⋯. */
const CARD_FIELDS = Object.freeze({
  number: { role: 'title' as const },
  customer: { role: 'subtitle' as const },
  picture: { role: 'aside' as const },
  brand: { role: 'field' as const },
  status: { role: 'field' as const },
  promised: { role: 'field' as const },
  ...Object.fromEntries(['deposit', 'units', 'orderDate', 'shipped', 'invoiced', 'net', 'gross', 'margin', 'priority', 'season', 'quote', 'company'].map((id) => [id, { role: 'hidden' as const }])),
})

interface ColumnsInput {
  t: Translate
  s: Translate
  d: Translate
  /** B-TH-230: the New messages column's words. */
  l?: Translate
  locale: Locale
  model: OrdersListModel
  wide: boolean
  latest: { current: { model: OrdersListModel; actions?: OrdersListActions } }
  onViewer: (id: string) => void
}

/** The Picture cell: its small preview read lazily (only the rows AG draws), cached per row until the address expires. */
function PictureCell({ row, input }: { row: OrderRow; input: ColumnsInput }) {
  const src = useSmallPicture(row, input.latest.current.actions?.loadPicture, input.model.demoPictures?.[row.id])
  return <PictureThumb row={row} src={src} t={input.s} onOpen={() => input.onViewer(row.id)} />
}

function PictureViewerFor({ row, model, actions, t, onClose }: { row: OrderRow; model: OrdersListModel; actions?: OrdersListActions; t: Translate; onClose: () => void }) {
  const src = useSmallPicture(row, actions?.loadPicture, model.demoPictures?.[row.id])
  return <PictureViewer row={row} src={src} prefix={model.prefix} t={t} onClose={onClose} />
}

/**
 * The sheet's columns in the picture's order. Every value that names a thing is its door (a real link: ⌘-click opens a new
 * tab); Brand, Status and Company narrow the sheet (the funnel mark); a cell the reader may not open says why on hover; the
 * rest of the row opens the order. Money columns are absent without their grain, never zero.
 */
function sheetColumns({ t, s, d, l, locale, model, wide, latest, onViewer }: ColumnsInput): ColDef<OrderRow>[] {
  const input: ColumnsInput = { t, s, d, l, locale, model, wide, latest, onViewer }
  const { prefix, can } = model
  const day = (value: string | null) => (value ? formatDate(dayInstant(value), { locale }) : '—')
  const act = () => latest.current.actions
  const door = (value: Door, children: ReactNode, strong?: boolean) => (
    <DoorCell door={value} t={s} strong={strong}>
      {children}
    </DoorCell>
  )

  const PictureColumn = ({ data }: ICellRendererParams<OrderRow>) => (data ? <PictureCell row={data} input={input} /> : null)
  // B-TH-230 (grid-F15): the reader's own new messages; the cell is a door to the order's thread at the first new message.
  const NewMessagesCell = ({ data }: ICellRendererParams<OrderRow>) => (data ? <LastMessageCell unread={latest.current.model.unread?.[data.id]} href={`${orderHref(prefix, data)}?thread=new`} record={data.number} /> : null)
  const NumberCell = ({ data }: ICellRendererParams<OrderRow>) => {
    if (!data) return null
    const opened = orderDoor(prefix, data) as { href: string }
    return (
      <span className="fw-sheet-cell">
        <PeekLink
          href={opened.href}
          className="fw-sheet-door strong"
          label={s('peek.order')}
          card={() => (
            <PeekCard
              title={
                <>
                  {data.number} <Pill tone={STATUS_TONE[data.status]}>{t(`status.${data.status}`)}</Pill>
                </>
              }
              rows={[
                [s('peek.who'), data.partyName || '—'],
                [s('peek.promised'), data.promiseDate ? `${day(data.promiseDate)}${data.daysLate ? ` · ${t('list.daysLate', { count: data.daysLate })}` : ''}` : s('peek.noPromise')],
                [s('peek.pieces'), String(data.units)],
              ]}
              open={{ href: opened.href, label: s('peek.openOrder') }}
            />
          )}
        >
          {data.number}
        </PeekLink>
        <span className="fw-sheet-sub">{data.customerRef ? t('list.customerRef', { ref: data.customerRef }) : t('list.noCustomerRef')}</span>
      </span>
    )
  }
  const CustomerCell = ({ data }: ICellRendererParams<OrderRow>) => {
    if (!data) return null
    const opened = customerDoor(prefix, data) as { href: string }
    return (
      <PeekLink
        href={opened.href}
        className="fw-sheet-door"
        label={s('peek.customer')}
        card={() => {
          const known = latest.current.model.switcher?.customers?.find((customer) => customer.id === data.partyId)
          return (
            <PeekCard
              title={data.partyName}
              rows={[
                [s('peek.openOrders'), known ? String(known.open) : s('peek.notCounted')],
                [s('peek.late'), known ? String(known.late) : s('peek.notCounted')],
                [s('peek.lastOrder'), known?.lastOrderDate ? day(known.lastOrderDate) : s('peek.notCounted')],
              ]}
              open={{ href: opened.href, label: s('peek.openCustomer') }}
            />
          )
        }}
      >
        {data.partyName || '—'}
      </PeekLink>
    )
  }
  const BrandCell = ({ data }: ICellRendererParams<OrderRow>) => {
    if (!data) return null
    const cell = brandCell(data)
    if (cell.kind === 'none') return <span className="fw-sheet-plain">—</span>
    if (cell.kind === 'hidden')
      return (
        <span className="fw-sheet-held" tabIndex={0} title={s('brand.hiddenWhy')}>
          {s('brand.hidden')}
        </span>
      )
    if (cell.kind === 'several') {
      const names = cell.labels.map((label) => (label.own ? s('brand.own') : (label.name ?? s('brand.hidden')))).join(' · ')
      return (
        <Menu
          label={
            <>
              <span className="fw-sheet-funnel-value">{s('brand.several', { count: cell.labels.length })}</span>
              <Filter size={12} aria-hidden />
            </>
          }
          triggerProps={{ className: 'fw-sheet-funnel', title: s('brand.pick', { names }), 'aria-label': s('brand.pick', { names }) }}
          items={[
            { id: 'h', heading: true, label: s('brand.pickTitle', { count: cell.labels.length, number: data.number }) },
            ...cell.labels.map((label, index) =>
              label.value === null
                ? { id: `b-${index}`, label: s('brand.hidden'), disabled: true, description: s('brand.hiddenWhy') }
                : { id: `b-${index}`, label: label.own ? s('brand.own') : (label.name ?? s('brand.unknown')), onSelect: () => act()?.onBrand?.(label.value) },
            ),
          ]}
        />
      )
    }
    const name = cell.own ? s('brand.own') : (cell.name ?? s('brand.unknown'))
    return (
      <FunnelButton tip={s('brand.filter', { name })} onClick={() => act()?.onBrand?.(cell.value)}>
        {cell.own ? <span className="fw-sheet-own">{name}</span> : name}
      </FunnelButton>
    )
  }
  const StatusCell = ({ data }: ICellRendererParams<OrderRow>) =>
    data ? (
      <FunnelButton tip={s('status.filter', { status: t(`status.${data.status}`) })} onClick={() => act()?.onRows?.(data.status)}>
        <Pill tone={STATUS_TONE[data.status]}>{t(`status.${data.status}`)}</Pill>
      </FunnelButton>
    ) : null
  const DepositCell = ({ data }: ICellRendererParams<OrderRow>) => {
    if (!data) return null
    const { state, dueDate } = data.deposit
    const overdue = state === 'OPEN' && dueDate !== null && dueDate < model.today
    return (
      <span className="fw-sheet-cell">
        {door(depositDoor(prefix, data, can), <Pill tone={depositTone(state, dueDate, model.today)}>{t(`deposit.${state}`)}</Pill>)}
        {state === 'OPEN' && dueDate && <span className={overdue ? 'fw-sheet-late' : 'fw-sheet-sub'}>{t(overdue ? 'list.depositOverdue' : 'list.depositDue', { date: day(dueDate) })}</span>}
      </span>
    )
  }
  const UnitsCell = ({ data }: ICellRendererParams<OrderRow>) =>
    data ? (
      <span className="fw-sheet-cell">
        {door(linesDoor(prefix, data), String(data.units))}
        <span className="fw-sheet-sub">{t('list.lines', { count: data.lineCount })}</span>
      </span>
    ) : null
  const OrderedCell = ({ data }: ICellRendererParams<OrderRow>) =>
    data ? (
      <span className="fw-sheet-cell">
        <span>{day(data.orderDate)}</span>
        <span className="fw-sheet-sub">{data.requestedDate ? t('list.requested', { date: day(data.requestedDate) }) : t('list.noRequested')}</span>
      </span>
    ) : null
  const PromiseCell = ({ data }: ICellRendererParams<OrderRow>) =>
    data ? (
      data.promiseDate ? (
        <span className="fw-so-inline">
          {door(linesDoor(prefix, data, true), day(data.promiseDate))}
          {data.daysLate !== null && data.daysLate > 0 && <Tag tone="danger">{t('list.daysLate', { count: data.daysLate })}</Tag>}
        </span>
      ) : (
        door(linesDoor(prefix, data, true), t('list.noPromise'))
      )
    ) : null
  const ShippedCell = ({ data }: ICellRendererParams<OrderRow>) =>
    data ? (
      <span className="fw-so-progress">
        <ProgressBar value={shippedPercent(data)} ariaLabel={t('list.shippedLabel', { number: data.number })} height={6} />
        {door(shippedDoor(prefix, data), s('shippedOf', { shipped: data.shippedUnits, units: data.units }))}
      </span>
    ) : null
  const InvoicedCell = ({ data }: ICellRendererParams<OrderRow>) => {
    if (!data) return null
    const cell = invoicedCell(data, can)
    const state = data.invoiced?.state ?? 'NONE'
    return (
      <span className="fw-sheet-cell">
        <span className="fw-sheet-inv">
          <span className={`fw-sheet-dot ${state}`} aria-hidden />
          {door(invoicedDoor(prefix, data, can), s(cell.word))}
        </span>
        {cell.amount !== null && <span className="fw-sheet-sub">{s('invoiced.amount', { amount: money(cell.amount, data.currency, locale) })}</span>}
      </span>
    )
  }
  const NetCell = ({ data }: ICellRendererParams<OrderRow>) => (data ? <span>{money(data.netAmount, data.currency, locale)}</span> : null)
  const GrossCell = ({ data }: ICellRendererParams<OrderRow>) => (data ? <span>{money(data.grossAmount, data.currency, locale)}</span> : null)
  const QuoteCell = ({ data }: ICellRendererParams<OrderRow>) =>
    data ? data.quote ? door(quoteDoor(prefix, data), t('list.quoteRef', { number: data.quote.number, revision: data.quote.revision })) : <span className="fw-sheet-plain">—</span> : null
  const companies = model.companies ?? []
  const CompanyCell = ({ data }: ICellRendererParams<OrderRow>) => {
    if (!data) return null
    const name = companies.find((company) => company.id === data.companyId)?.name ?? s('company.unknown')
    return (
      <FunnelButton tip={s('company.filter', { name })} onClick={() => act()?.onCompany?.(data.companyId)}>
        {name}
      </FunnelButton>
    )
  }
  const MoreCell = ({ data }: ICellRendererParams<OrderRow>) =>
    data ? (
      <Menu
        label={<MoreHorizontal size={16} aria-hidden />}
        align="right"
        triggerProps={{ 'aria-label': t('list.rowMenu', { number: data.number }) }}
        items={[
          { id: 'open', label: t('list.open'), href: orderHref(prefix, data) },
          { id: 'tab', label: t('list.openNewTab'), href: orderHref(prefix, data), target: '_blank' },
          { id: 'deposit', label: t('tab.money'), href: orderHref(prefix, data, 'money') },
          ...(data.status === 'CONFIRMED' && can.makeWorkOrders ? [{ id: 'make', label: t('step.makeWorkOrders'), href: `${prefix}/production/work-orders?new=1&order=${encodeURIComponent(data.number)}` }] : []),
          // B-W2b-323: Print confirmation (the confirmation PDF in a new tab; held while it waits for a yes or was cancelled).
          ...(model.depth ? [printVerb(data, prefix, d)] : []),
        ]}
      />
    ) : null
  const also = (key: string, label: string) => ({ exportWith: [{ key, label }] })
  return serverSorted(model.sort ?? null, [
    { colId: 'picture', headerName: s('col.picture'), minWidth: 76, maxWidth: 76, sortable: false, suppressHeaderMenuButton: true, cellRenderer: PictureColumn },
    { colId: 'number', headerName: t('col.number'), field: 'number', minWidth: 128, flex: 1, cellRenderer: NumberCell, context: also('customerRef', s('col.customerRef')) },
    { colId: 'customer', headerName: t('col.customer'), field: 'partyName', minWidth: 112, flex: 1.2, cellRenderer: CustomerCell },
    { colId: 'brand', headerName: s('col.brand'), headerTooltip: s('col.brandHint'), minWidth: 100, flex: 1, sortable: false, cellRenderer: BrandCell },
    { colId: 'status', headerName: t('col.status'), field: 'status', minWidth: 112, flex: 0.9, cellRenderer: StatusCell },
    // B-TH-230: only for a reader of threads (the API counts only what the reader may open).
    ...(model.unread && l ? [{ colId: 'newMessages', headerName: l('column'), headerTooltip: l('columnHint'), minWidth: 116, flex: 0.7, sortable: false, valueGetter: ({ data }: { data?: OrderRow }) => unreadValue(data ? latest.current.model.unread?.[data.id] : undefined), cellRenderer: NewMessagesCell } as ColDef<OrderRow>] : []),
    { colId: 'deposit', headerName: t('col.deposit'), minWidth: 96, flex: 0.8, cellRenderer: DepositCell },
    { colId: 'units', headerName: t('col.units'), field: 'units', minWidth: 72, flex: 0.5, cellRenderer: UnitsCell },
    { colId: 'orderDate', headerName: t('col.orderDate'), field: 'orderDate', minWidth: 104, flex: 0.8, hide: !wide, cellRenderer: OrderedCell, context: also('requested', s('col.requested')) },
    { colId: 'promised', headerName: t('col.promised'), field: 'promiseDate', minWidth: 108, flex: 0.9, cellRenderer: PromiseCell, context: also('daysLate', s('col.daysLate')) },
    { colId: 'shipped', headerName: t('col.shipped'), minWidth: 84, flex: 0.7, cellRenderer: ShippedCell },
    { colId: 'invoiced', headerName: s('col.invoiced'), headerTooltip: s('col.invoicedHint'), minWidth: 92, flex: 0.7, sortable: false, cellRenderer: InvoicedCell, ...(can.price ? { context: also('invoicedAmount', s('col.invoicedAmount')) } : {}) },
    ...(can.price
      ? [
          { colId: 'net', headerName: t('col.net'), field: 'netAmount' as const, minWidth: 104, flex: 0.7, type: 'rightAligned', cellRenderer: NetCell },
          { colId: 'gross', headerName: s('col.gross'), field: 'grossAmount' as const, minWidth: 106, flex: 0.7, type: 'rightAligned', hide: true, cellRenderer: GrossCell },
        ]
      : []),
    // B-W2a-72: Margin % as estimated now (costing.view + the margin grain; Owner answer S2) — a wide column.
    ...(model.margins ? [{ ...marginColumn(model.margins, t('col.margin'), t('col.marginHint'), locale), minWidth: 92, hide: !wide }] : []),
    // B-W2b-323: Priority (inline, CellSaveMark) and Season — wide columns.
    ...(model.depth ? depthColumns(model.depth, latest.current.actions?.depth, d).map((column) => ({ ...column, minWidth: column.colId === 'season' ? 76 : 108, hide: !wide })) : []),
    { colId: 'quote', headerName: t('col.quote'), minWidth: 104, flex: 0.8, hide: !wide, cellRenderer: QuoteCell },
    ...(companies.length > 1 ? [{ colId: 'company', headerName: s('col.company'), minWidth: 88, flex: 0.8, sortable: false, cellRenderer: CompanyCell }] : []),
    { colId: 'more', headerName: t('col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
  ] as ColDef<OrderRow>[])
}
// ── end B-TH-225 ──

// ── B-TH-057 (SHEET-G15; guard of SHEET.overall-F05 "No header sort that only reorders the loaded 50 rows") ──
/**
 * Only the columns the server sorts by keep a header sort (Customer, Brand, Promised, Ordered): the arrow shows the address's
 * sort and the grid never reorders the rows itself (the API sent them in that order); a click reaches the page through the
 * list frame's onSortChanged. Every other column's header sorts nothing.
 */
function serverSorted(sort: OrderSort | null, columns: ColDef<OrderRow>[]): ColDef<OrderRow>[] {
  return columns.map((column) => {
    const colId = column.colId ?? ''
    if (!Object.hasOwn(SORT_COLUMNS, colId)) return { ...column, sortable: false }
    return { ...column, sortable: true, sort: columnSort(sort, colId), comparator: () => 0, sortingOrder: ['asc', 'desc', null] }
  })
}
// ── end B-TH-057 ──
