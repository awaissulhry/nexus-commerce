'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ExternalLink, Filter, MoreHorizontal, Plus, Search } from 'lucide-react'
import { Ruler } from 'lucide-react' // F-SA-221: the made-to-measure mark
import { Banner, EmptyState, Menu, MetricStrip, ProgressBar } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, SegmentedControl, Select, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { useListSearch } from '../../../../../list-frame/search/use-list-search' // F-SA-223
import { listKeys, type ListKey } from '../../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { formatNumber } from '../../../../../lib/i18n/format' // F-CP-103: the Views ▾ counts
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
import { DoorCell, FunnelButton, PeekCard, PeekLink, SheetChips, type SheetChip } from '../sheet/parts'
import { CustomerSwitcher } from '../../../_shared/customer-switcher/view/CustomerSwitcher' // F-SA-224: the one customer filter
// F-SA-212: the ONE picture part (the cell, the phone card's aside and the picture large).
import { RecordPicture } from '../../../../../lib/record-picture/view/RecordPicture'
import { PictureViewer } from '../../../../../lib/record-picture/view/PictureViewer'
// B-TH-230: the New messages column (LastMessageCell).
import { LAST_MESSAGE_NS, LastMessageCell } from '../../../../../lib/last-message-cell/view/LastMessageCell'
import { unreadValue } from '../../../../../lib/last-message-cell/model'
// ---- B-TH-244 (TH-4: the overall view grouped by customer, the later columns, Invoice shipped goods for N) ----
import { Receipt } from 'lucide-react'
import { SelectionLabel } from '@nexus/ui/grid'
import type { ListGroups } from '../../../../../list-frame/groups/model'
import { figureDoors, groupHref, invoiceShippedHeld, timingKey, totalNameKey } from '../sheet/overall'
import { FiguresLine, InvoiceDraftsDialog } from '../sheet/overall-parts'
import type { ExtraTerms } from '../../model'
import type { ListEdit } from '../../../../../list-frame/w2b/model' // B-TH-245
// ---- F-SA-275 (the API's B-SA-070): Where it is, Waiting on, Supervisor (opt-in here, shown by the customer page's views), ⋯ Add task… / Answer request… ----
import { SupervisorCell, WaitingOnCell, WhereItIsCell } from '../sheet/parts'
import { answerHrefOf, HEALTH_CHIP, waitingItemsOf, whereLineOf } from '../sheet/model'
import { SUPERVISOR_NS } from '../../../../_shared/production-supervisor/model'
import { productionWordsFor } from '../../../../../lib/production/words'
// ---- end F-SA-275
// ---- F-SA-280 (bulk on the sheet's own bar): production's assign and note dialogs, reused in place; one customer only ----
import { MessageSquareLock, UserCog } from 'lucide-react'
import { AssignSupervisorDialog } from '../../../../_shared/production-supervisor/view/AssignSupervisorDialog'
import { assignHeld } from '../../../../_shared/production-supervisor/model'
import { NoteDialog } from '../../../../production/_shared/notes/view/NoteDialog'
import { NOTES_NS, openHeld } from '../../../../production/_shared/notes/model'
import { oneCustomerHeld, supervisorTargetsOf } from '../sheet/model'
// ---- end F-SA-280
// ---- F-SA-281: the one New task window (one order, or N in one batch) ----
import { ListPlus } from 'lucide-react'
import { TaskNewDialog } from '../../../../../record-panels/tasks/view/TaskNewDialog'
import { BATCH_MAX } from '../../../../../record-panels/tasks/model'
// ---- end F-SA-281
// ---- F-SA-282: Reply to <customer> on N… (one customer, ≤ 50, one batchId; each order's own conversation, the portal only) ----
import { Globe } from 'lucide-react'
import { replyManyHeld, replyManyLabel } from '../reply-many'
import { ReplyManyDialog } from './ReplyManyDialog'
// ---- end F-SA-282

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
    <WithMessages namespaces={['orders', 'lists', DEPTH /* B-W2b-323 */, SHEET /* B-TH-225 */, LAST_MESSAGE_NS /* B-TH-230 */, SUPERVISOR_NS /* F-SA-275: the supervisor marks */, NOTES_NS /* F-SA-280: the note dialog's held words */, 'records' /* F-SA-281: the tasks' held words */]}>
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
  const m = useT(SUPERVISOR_NS) // F-SA-275
  const n = useT(NOTES_NS) // F-SA-280
  const r = useT('records') // F-SA-281
  const locale = useLocale()
  const wide = useWide(model.wide) // B-TH-225: Ordered, Margin %, Priority, Season and From quote at 1920
  const [viewer, setViewer] = useState<string | null>(model.viewerOpen ?? null)
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  // F-SA-223: the one search rule of every list (300 ms after the last key, Enter at once, Esc clears, 100 at most, follows the address).
  const search = useListSearch(model.q, (q) => latest.current.actions?.onSearch?.(q))
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
        const door = cell.querySelector<HTMLElement>('a[data-door], button.fw-sheet-funnel, button[data-picture]') // F-SA-212: the picture part
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
      if (event.key === 'c' && model.can.manage && !model.embedded /* F-SA-220: New order is the Orders page's band */) {
        event.preventDefault()
        actions?.onNewOrder?.(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const picked = (items ?? []).filter((row) => selected.includes(row.id))
  // ---- F-SA-280: the one-customer check before any window (the server checks each record again), then each window's own holds.
  const oneCustomer = oneCustomerHeld(picked, model.locked?.party ? (model.customer?.id ?? null) : null)
  const oneCustomerWords = oneCustomer ? s(oneCustomer.key, oneCustomer.params) : null
  const assignWait = assignHeld({ manage: !!model.bulkCan?.supervisor }, { targets: supervisorTargetsOf(picked), leftOut: 0 })
  const noteWait = openHeld(!!model.bulkCan?.note, picked.length)
  const assignWords = oneCustomerWords ?? (assignWait ? m(assignWait.key, assignWait.params) : null)
  const noteWords = oneCustomerWords ?? (noteWait ? n(noteWait.key, noteWait.params) : null)
  // ---- end F-SA-280
  // F-SA-281: Add task to N… — one customer, the tasks' right, at most BATCH_MAX (the dialog and the API check again).
  const taskWords = oneCustomerWords ?? (model.bulkCan?.task ? r(model.bulkCan.task) : picked.length > BATCH_MAX ? s('bulk.tooMany', { max: BATCH_MAX }) : null)
  // F-SA-282: Reply to <customer> on N… — held in words before the click: another customer's order on this customer's page, orders of
  // more than one customer (one message never reaches two customers), no right, more than 50 (the window and the API check again).
  const replyHold = replyManyHeld(picked, model.locked?.party ? (model.customer?.id ?? null) : null, !!model.bulkCan?.reply)
  const replyWords = replyHold ? s(replyHold.key, replyHold.params) : null
  const replyPhrase = replyManyLabel(picked)
  const replyLabel = s(replyPhrase.key, replyPhrase.params)
  const ownKeys: ListKey[] = [
    { keys: ['v'], does: t('list.keyView') },
    ...(model.can.manage && !model.embedded ? [{ keys: ['c'], does: t('list.keyNew') }] : []),
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
      {...search.field /* F-SA-223 */}
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

  // F-SA-212: the phone card's aside is the picture part at its phone size (the DS card's draw override).
  const cardFields = useMemo(() => cardFieldsOf((row) => <RecordPicture source="order" recordId={row.id} number={row.number} picture={row.picture} styleCount={row.styleCount} size="phone" read={latest.current.actions?.readPictures} demo={latest.current.model.demoPictures?.[row.id]} onOpen={() => setViewer(row.id)} />), [])
  const columns = useMemo<ColDef<OrderRow>[]>(
    () => sheetColumns({ t, s, d, l, m, r, locale, model, wide, latest, onViewer: setViewer }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the cells read the latest model and actions through `latest`
    [t, s, d, l, m, locale, wide, model.prefix, model.today, model.can, model.margins, model.depth, model.companies, model.demoPictures, actions?.depth, model.sort /* B-TH-057 */, model.unread /* B-TH-230 */, model.kind /* F-SA-221 */, model.marks /* F-SA-275 */, model.doorHref /* F-SA-275 */, !!actions?.onAddTask /* F-SA-275 */, model.preset /* F-SA-276 */, r /* F-SA-281 */, model.bulkCan?.task /* F-SA-281 */],
  )

  // F-SA-276: the host's default view is not a narrowing; the waiting term is.
  // F-CP-102: compared with the host's default (`home`: Open orders on Sales › Orders, All orders on the customer page); the rows
  // view apart from every other narrowing, so a host's words for that one view (model.empty.view) still show.
  const home = homeOf(model)
  const viewNarrowed = model.rows !== home && model.rows !== 'all'
  const othersNarrowed = model.q.trim() !== '' || !!model.waiting || !!model.customer || !!model.brand || !!model.company || !!model.cf || extraChips(model.extra ?? null, t, s).length > 0 || (!!model.kind && !model.locked?.kind) || !!model.profile // B-TH-201, B-TH-225, B-TH-057, B-TH-244, F-SA-221, F-SA-222
  const narrowed = viewNarrowed || othersNarrowed
  const hostEmpty = hostEmptyOf(model, narrowed, othersNarrowed)
  const showing = showingOf(model)
  const clearFilters = () => {
    search.reset('') // F-SA-223
    actions?.onClearAll?.() // B-TH-225: the search, the view, the customer, the label and the company at once
  }
  // ── B-TH-225 / B-TH-226: every narrowing is a chip (grid-F25); the switcher names the customer ──
  const statusView = (ORDER_STATUSES as readonly string[]).includes(model.rows) ? (model.rows as OrderStatus) : null
  const chips: SheetChip[] = [
    // F-SA-220: a customer the host locks is the page's own (no chip: the page names it).
    ...(model.customer && !model.locked?.party ? [{ id: 'party', label: model.customer.name === null ? s('switcher.unknown') : s('chips.customer', { name: model.customer.name ?? '…' }), onClear: () => actions?.onCustomer?.(null) }] : []),
    ...(model.brand ? [{ id: 'brand', label: s('chips.brand', { name: model.brand.value === 'own' ? s('brand.own') : (model.brand.name ?? s('brand.unknown')) }), onClear: () => actions?.onBrand?.(null) }] : []),
    ...(statusView && statusView !== model.defaultRows /* F-SA-276: the host's own view is no chip */ ? [{ id: 'status', label: s('chips.status', { status: t(`status.${statusView}`) }), onClear: () => actions?.onRows?.(home) /* F-CP-102: back to the host's default */ }] : []),
    // F-SA-276: the orders waiting on us (the customer page's view "Waiting on us").
    ...(model.waiting ? [{ id: 'waiting', label: s('chips.waitingUs'), onClear: () => actions?.onWaiting?.(null) }] : []),
    ...(model.company ? [{ id: 'company', label: s('chips.company', { name: model.company.name }), onClear: () => actions?.onCompany?.(null) }] : []),
    // F-SA-221: made-to-measure orders only — removable here, fixed where the page holds it (the Made-to-measure page).
    ...(model.kind ? [{ id: 'kind', label: s('mtm.mark'), onClear: model.locked?.kind ? null : () => actions?.onKind?.(null) }] : []),
    // F-SA-222: a rider's orders (the rider list's Open orders door); the name once read, else "One rider".
    ...(model.profile ? [{ id: 'profile', label: model.profile.name ? s('chips.rider', { name: model.profile.name }) : s('chips.riderUnnamed'), onClear: () => actions?.onProfile?.(null) }] : []),
    // B-TH-057 (SHEET-G05): a custom field filter of the address is a chip too (the list, its counts and its file apply it).
    ...(model.cf ? [{ id: 'cf', label: s('chips.cf', { terms: model.cf }), onClear: () => actions?.onClearCf?.() }] : []),
    // B-TH-244: the terms a total's door added (never a hidden filter).
    ...extraChips(model.extra ?? null, t, s).map((chip) => ({ id: `x-${chip.key}`, label: chip.label, onClear: () => actions?.onClearExtra?.(chip.key) })),
  ]
  const unavailable = model.customer?.name === null
  // B-TH-244: the honest count — the server's figure for the whole view when it was read (a door's view, the grouped view).
  const count = model.summary?.value ? model.summary.value.all.orders.count : viewCount(model.board, model.rows)
  const customerName = model.customer?.name ?? null
  const title = customerName ? s('titleOf', { name: customerName }) : s('title')
  const switcher = model.switcher ? (
    <CustomerSwitcher
      state={model.switcher}
      party={model.customer?.id ?? null}
      partyName={model.customer ? model.customer.name : undefined}
      query={model.switcher.query}
      searching={model.switcher.searching}
      onQuery={actions?.onCustomerSearch}
      onPick={(party) => actions?.onCustomer?.(party)}
      onRetry={actions?.onCustomerRetry}
      open={model.switcherOpen}
      // F-SA-224: only Orders counts per customer (GET /sales/orders/customers): "3 open · 1 late".
      trailing={(customer) => (
        <>
          {s('switcher.open', { count: customer.open ?? 0 })}
          {(customer.late ?? 0) > 0 && (
            <>
              {' · '}
              <span className="fw-sheet-late">{s('switcher.late', { count: customer.late ?? 0 })}</span>
            </>
          )}
        </>
      )}
    />
  ) : null
  const about = exportAbout(s, { customer: customerName, view: t(`rows.${model.rows}`), count, price: model.can.price, formats: ['XLSX', 'CSV'], margin: !!model.margins && wide })
  const viewerRow = viewer ? (items ?? []).find((row) => row.id === viewer) ?? null : null
  // ── end B-TH-225 / B-TH-226 ──
  // B-TH-244: the grouped view draws its customers' headers even before their rows are read; with no group: the empty states.
  const groupsShown = !!model.group && (model.summary?.value?.groups?.length ?? 0) > 0
  const state = model.list.problem ? (
    <EmptyState title={t('list.failed')} description={t(model.list.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : items && items.length === 0 && model.rows === 'uninvoiced' && !groupsShown ? (
    // B-TH-244 (SHEET.overall-F06): nothing shipped waits to be invoiced.
    <EmptyState title={s('uninvoiced.none')} description={s('uninvoiced.noneBody')} />
  ) : items && items.length === 0 && !groupsShown && hostEmpty ? (
    // F-SA-222 (GATE-MTM): the host says why its view is empty (made-to-measure not started, or no order yet) — never a bare 0.
    // F-CP-102: words keyed to a view show on that view (hostEmpty).
    <EmptyState
      title={hostEmpty.title}
      description={hostEmpty.body ?? undefined}
      action={
        hostEmpty.link ? (
          <Button size="sm" asChild>
            <Link href={hostEmpty.link.href}>{hostEmpty.link.label}</Link>
          </Button>
        ) : undefined
      }
    />
  ) : items && items.length === 0 && !groupsShown && model.kind && !model.can.measurements ? (
    // F-SA-221 (GATE-MTM): made-to-measure orders for a reader without the riders' right: the view's words, no gate detail.
    <EmptyState title={s('empty.mtmNoRight')} />
  ) : items && items.length === 0 && !groupsShown ? (
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

  // ── B-TH-245 (threads plan TH-4, SHEET-G09; SHEET.brand-fields-F03, -F08): the sheet's cells that edit ──
  const cellHeld = (row: OrderRow): string | null => heldCell(row, t, s)
  const orderEdit = orderEditOf(model, s, cellHeld, (id, after, version) => actions?.onCellSaved?.(id, after, version))
  // ── end B-TH-245 ──
  const groups = useOverallGroups(model, actions, t, s, locale) // B-TH-244

  return (
    <div className="fw-so">
      {/* F-SA-220: an embedding host draws its own band and the tiles (OrdersLayoutSwitch, OrdersTiles). */}
      {!model.embedded && (
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
            <LayoutSwitchFor model={model} actions={actions} held={null} /* F-SA-220: the one layout switch (a host's band draws it too) */ />
            <Button size="sm" variant="quiet" asChild>
              <a href={`${model.prefix}/sales/orders?view=board${model.customer ? `&party=${encodeURIComponent(model.customer.id)}` : '' /* B-TH-201 */}${model.brand ? `&brand=${encodeURIComponent(model.brand.value)}` : ''}${model.company ? `&company=${encodeURIComponent(model.company.id)}` : '' /* B-TH-225 */}${model.kind ? `&kind=${model.kind}` : '' /* F-SA-221 */}`} target="_blank" rel="noopener" title={t('board.newTabHint')}>
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
      )}

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

      {!model.embedded && <TilesStrip model={model} actions={actions} t={t} s={s} />}

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
        <WeekBoard model={model.week} prefix={model.prefix} search={searchField} onSite={actions?.onWeekSite} onRetry={actions?.onWeekRetry} pictures={{ read: actions?.readPictures, demo: model.demoPictures } /* F-SA-215 */} />
      ) : model.layout === 'board' ? (
        <OrdersBoard model={model} actions={actions} search={searchField} rowsSelect={rowsSelect} onHelp={() => setHelp(true)} />
      ) : (
        <ListFrame<OrderRow>
          listKey={model.listKey /* F-SA-220: 'sales.orders' on every host (its export, its saved views) */}
          label={t('list.tableLabel')}
          rows={state ? [] : items}
          rowId={(row) => row.id}
          columns={columns}
          count={items ? (count !== null && items.length < count ? s('loadedOf', { loaded: items.length, total: count }) : t(model.list.more ? 'list.countMore' : 'list.count', { count: items.length })) : '—'}
          search={searchField}
          right={
            model.toolbarLink ? (
              // F-SA-276: a real link beside the list ("Work orders of <customer> ›": its own page, its own list).
              <Link className="fw-sheet-door" href={model.toolbarLink.href}>
                {model.toolbarLink.label}
              </Link>
            ) : undefined
          }
          tools={
            <>
              {switcher /* B-TH-226 */}
              {/* B-TH-243 (ORD-G10): the rows views are the built-in views on top of Views ▾ — no second Rows ▾ beside it. */}
              {sortSelect /* B-TH-057 */}
              {/* B-TH-244 (SHEET.overall-F02): Group by customer — on All customers only (a customer's sheet is one group). */}
              {!model.customer && (
                <Select size="sm" aria-label={s('group.label')} value={model.group ?? ''} onChange={(event) => actions?.onGroup?.(event.target.value === 'party' ? 'party' : null)}>
                  <option value="">{s('group.none')}</option>
                  <option value="party">{s('group.party')}</option>
                </Select>
              )}
            </>
          }
          groups={groups /* B-TH-244 */}
          custom={{ recordType: 'ORDER', companyId: model.company?.id ?? null, partyId: model.customer?.id ?? null, partyOf: (row) => row.partyId, partyFieldsOnPartySheet: true, edit: { held: cellHeld } } /* B-TH-241 / B-TH-242 / B-TH-245: a customer's own columns on its sheet only, edited in their cells */}
          edit={orderEdit /* B-TH-245: the order note and the custom values in their cells; Edit N with the preview; lines never */}
          onShownColumns={actions?.onShownColumns /* B-TH-244: Progress reads the floor only while shown */}
          builtInViews={{ items: builtInViewsOf(model, t, s, (value) => formatNumber(value, locale) /* F-CP-103 */), active: builtInActive(model), onPick: (id) => pickBuiltIn(id, model, actions) /* F-SA-221, F-SA-276 */ }}
          viewName={customerName ? s('views.suggest', { customer: customerName }) : null /* B-TH-243: a customer's sheet saved under its name */}
          // B-TH-057: a header click sorts every page on the server (the address keeps it); the grid only shows the arrow.
          onSortChanged={(colId, direction) => actions?.onSort?.(colId ? sortOfColumn(colId, direction) : null)}
          title={customerName ? s('export.title', { customer: customerName }) : undefined /* B-TH-225: the export job names the customer */}
          exportAbout={about}
          onRowClick={(row, event) => actions?.onOpenRow?.(row.id, event.metaKey || event.ctrlKey)}
          cards={{ fields: cardFields, hrefOf: (row) => orderHref(model.prefix, row) }}
          selection={{
            selected,
            onChange: setSelected,
            // B-TH-225 (ORD-G02): Export N goes through the export job with the picked ids (the same writer as the full list).
            exportSelected: true,
            actions: (
              <>
                {/* B-W2b-323: Set priority for N (one command over the selection). */}
                {model.depth && <SetPriorityButton count={picked.length} model={model.depth} held={oneCustomerWords /* F-SA-280 */} onClick={() => actions?.depth?.onSetPriority?.(picked.map((row) => row.id))} />}
                {/* F-SA-280: Assign supervisor… (≤ 100; the customer is never told who) and Note to N… / Ask the supervisor (≤ 100, one batch). */}
                {actions?.onAssignSupervisor && (
                  <Button size="sm" aria-label={s('bulk.assign')} heldReason={assignWords} onClick={() => actions.onAssignSupervisor?.(picked.map((row) => row.id))}>
                    <UserCog size={13} aria-hidden /> <SelectionLabel>{s('bulk.assign')}</SelectionLabel>
                  </Button>
                )}
                {/* F-SA-281: Add task to N… (Assign to each order's supervisor by default; one batch, its receipt). */}
                {actions?.onAddTask && (
                  <Button size="sm" aria-label={s('bulk.addTask', { count: picked.length })} heldReason={taskWords} onClick={() => actions.onAddTask?.(picked.map((row) => row.id), 'selection')}>
                    <ListPlus size={13} aria-hidden /> <SelectionLabel>{s('bulk.addTask', { count: picked.length })}</SelectionLabel>
                  </Button>
                )}
                {actions?.onNote && (
                  <Button size="sm" aria-label={s('bulk.note', { count: picked.length })} heldReason={noteWords} onClick={() => actions.onNote?.(picked.map((row) => row.id))}>
                    <MessageSquareLock size={13} aria-hidden /> <SelectionLabel>{s('bulk.note', { count: picked.length })}</SelectionLabel>
                  </Button>
                )}
                {/* F-SA-282: Reply to <customer> on N… — the same words in each order's own conversation, in the portal (never one message to two customers). */}
                {actions?.onReplyMany && (
                  <Button size="sm" aria-label={replyLabel} heldReason={replyWords} onClick={() => actions.onReplyMany?.(picked.map((row) => row.id))}>
                    <Globe size={13} aria-hidden /> <SelectionLabel>{replyLabel}</SelectionLabel>
                  </Button>
                )}
                {/* B-TH-244 (SHEET.overall-F07, ORD-G06): finance only — Finance's From-DDTs dialog with their DDTs chosen, never an invoice from here. */}
                {model.can.manageInvoices && (
                  <Button size="sm" heldReason={invoiceShippedHeld(picked.length) ? s(invoiceShippedHeld(picked.length)!) : null} aria-label={s('invoiceShipped.action', { count: picked.length })} onClick={() => actions?.onInvoiceShipped?.(picked.map((row) => row.id))}>
                    <Receipt size={13} aria-hidden /> <SelectionLabel>{s('invoiceShipped.action', { count: picked.length })}</SelectionLabel>
                  </Button>
                )}
              </>
            ),
          }}
          updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
          more={!model.group && model.list.more && items && items.length > 0 ? { label: t('list.more'), onMore: () => actions?.onMore?.() } : null}
          keys={ownKeys}
          onHelp={() => setHelp(true)}
          onOpen={(row) => actions?.onOpen?.(row.id)}
          state={state}
          focusRow={model.focusRow}
          // F-SA-279: on the customer page the row drives the dock (marked; the keys' row reported; ⌘↵ a new tab; a phone card's door).
          active={
            model.active
              ? {
                  id: model.active.id,
                  onFocusRow: (row) => actions?.onFocusRow?.(row),
                  onOpenNewTab: (row) => actions?.onOpenRow?.(row.id, true),
                  cardDoor: model.active.cardDoor && actions?.onCardThread ? { column: 'newMessages', label: model.active.cardDoor, onOpen: (row) => actions?.onCardThread?.(row) } : null,
                }
              : null
          }
        />
      )}
      {showing /* F-SA-276; F-CP-102: compared with the host's default — rows=open on the customer page says it */ && <p className="fw-so-hint">{t('list.viewing', { view: t(`rows.${showing}`) })}</p>}

      {viewerRow && <PictureViewerFor row={viewerRow} model={model} actions={actions} onClose={() => setViewer(null)} /> /* B-TH-225; F-SA-212: the one viewer */}
      {model.newOrder && <NewOrderDialog model={model.newOrder} actions={actions} />}
      {model.invoiceDrafts && <InvoiceDraftsDialog state={model.invoiceDrafts} prefix={model.prefix} t={s} onClose={() => actions?.onCloseInvoiceDrafts?.()} onRetry={actions?.onInvoiceShippedRetry} /> /* B-TH-244 */}
      {/* B-W2b-323: Set priority, Import orders. */}
      {model.depth && <SetPriorityDialog model={model.depth} actions={actions?.depth} />}
      {/* F-SA-280: production's one assign dialog and one note dialog (their results: changed / unchanged / skipped with why). */}
      {model.assign && <AssignSupervisorDialog model={model.assign} actions={actions?.supervisor} />}
      {model.note && <NoteDialog model={model.note} actions={actions?.note} />}
      {/* F-SA-282: Reply to <customer> on N… (one line per order after Send: posted, or not with why). */}
      {model.replyMany && <ReplyManyDialog model={model.replyMany} actions={actions?.replyMany} />}
      {/* F-SA-281: the one New task window — on one order (a row's ⋯), or on N orders in one batch (the selection). */}
      {model.task && (
        <TaskNewDialog
          recordLabel={model.task.mode === 'one' ? (model.task.records[0]?.label ?? null) : null}
          people={model.task.people}
          me={model.me ?? null}
          busy={model.task.busy}
          onRetryPeople={actions?.task?.onRetryPeople}
          onCreate={actions?.task?.onCreate}
          onClose={() => actions?.task?.onClose()}
          batch={model.task.mode === 'many' && actions?.task ? { records: model.task.records, today: model.today, onSend: actions.task.onSend } : null}
        />
      )}
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

// ── F-SA-221 (sales page plan N7, pick P12; 12-lists-board §4.3): the made-to-measure mark ──
/** "Made to measure · 3 units" (and "· 1 waiting for review") — the units and the review, never a rider's name; "" without units. */
export function mtmText(row: Pick<OrderRow, 'madeToMeasure'>, s: Translate): string {
  const mark = row.madeToMeasure
  if (!mark) return ''
  return `${s('mtm.units', { count: mark.units })}${mark.waitingReview > 0 ? ` ${s('mtm.waitingReview', { count: mark.waitingReview })}` : ''}`
}

/** The Riders cell: the names the API gave (only to a reader of measurements) and how many more ("Rider A, Rider B +1"); "" else. */
export function ridersText(row: Pick<OrderRow, 'madeToMeasure'>): string {
  const riders = row.madeToMeasure?.riders
  if (!riders || riders.names.length === 0) return ''
  const more = riders.count - riders.names.length
  return `${riders.names.join(', ')}${more > 0 ? ` +${more}` : ''}`
}

/** The mark under the order number: a funnel door to the made-to-measure orders (plain where the sheet shows only them). */
function MtmMark({ row, s, onNarrow }: { row: OrderRow; s: Translate; onNarrow?: () => void }) {
  const mark = row.madeToMeasure
  if (!mark) return null
  const units = (
    <>
      <Ruler size={12} aria-hidden /> {s('mtm.units', { count: mark.units })}
    </>
  )
  return (
    <>
      {onNarrow ? (
        <FunnelButton tip={s('mtm.filter')} onClick={onNarrow}>
          {units}
        </FunnelButton>
      ) : (
        <span className="fw-sheet-sub">{units}</span>
      )}
      {mark.waitingReview > 0 && <Tag tone="warning">{s('mtm.waitingReview', { count: mark.waitingReview })}</Tag>}
    </>
  )
}
// ── end F-SA-221 ──

// ── F-SA-220: the parts of the band an embedding host draws itself (the sheet draws none of them then) ──
/** The tiles (each a saved rows view, its count the board's under the same narrowing); a customer's sheet names the customer. */
function TilesStrip({ model, actions, t, s }: { model: OrdersListModel; actions?: OrdersListActions; t: Translate; s: Translate }) {
  const customerName = model.customer?.name ?? null
  const pressed = TILES.find((tile) => tile.rows === model.rows)?.key ?? null
  return (
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
  )
}

/** The sheet's tiles, for a host that embeds the sheet (its own band above them). */
export function OrdersTiles({ model, actions }: { model: OrdersListModel; actions?: OrdersListActions }) {
  return (
    <WithMessages namespaces={['orders', SHEET]}>
      <TilesFor model={model} actions={actions} />
    </WithMessages>
  )
}
function TilesFor({ model, actions }: { model: OrdersListModel; actions?: OrdersListActions }) {
  return <TilesStrip model={model} actions={actions} t={useT('orders')} s={useT(SHEET)} />
}

/** List · Board (· By promise week) for a host's band; `held` names a layout the host cannot show, with why (held, not hidden). */
export function OrdersLayoutSwitch({ model, actions, held }: { model: OrdersListModel; actions?: OrdersListActions; held?: { readonly layout: Layout; readonly why: string } | null }) {
  return (
    <WithMessages namespaces={['orders']}>
      <LayoutSwitchFor model={model} actions={actions} held={held ?? null} />
    </WithMessages>
  )
}
function LayoutSwitchFor({ model, actions, held }: { model: OrdersListModel; actions?: OrdersListActions; held: { readonly layout: Layout; readonly why: string } | null }) {
  const t = useT('orders')
  return (
    <>
      <SegmentedControl
        size="sm"
        ariaLabel={t('list.layoutLabel')}
        value={model.layout}
        onChange={(value) => actions?.onLayout?.(value as Layout)}
        options={[
          { value: 'list', label: t('layout.list') },
          { value: 'board', label: t('layout.board') },
          // B-W2b-323: By promise week (F-SA-220: held with why where the host cannot show it).
          ...(model.week !== undefined && held?.layout !== 'week' ? [{ value: 'week', label: t('layout.week') }] : []),
        ]}
      />
      {held && (
        <Button size="sm" variant="quiet" heldReason={held.why}>
          {t(`layout.${held.layout}`)}
        </Button>
      )}
    </>
  )
}
// ── end F-SA-220 ──

// ── F-CP-102 (customer page plan C1): the host's default view — Clear all, a view chip's ✕ and the "Showing: …" line compare with it ──
/** The host's default rows view (Sales › Orders and the Made-to-measure page: Open orders; the customer page: All orders). */
export const homeOf = (model: Pick<OrdersListModel, 'defaultRows'>): RowView => model.defaultRows ?? 'open'
/** The view the "Showing: …" line names: any but the host's default (null there, and on By promise week). */
export const showingOf = (model: Pick<OrdersListModel, 'rows' | 'defaultRows' | 'layout'>): RowView | null => (model.rows !== homeOf(model) && model.layout !== 'week' ? model.rows : null)
/** The host's empty words that apply now: words keyed to this view when nothing else narrows it; unkeyed words when nothing narrows. */
export function hostEmptyOf(model: Pick<OrdersListModel, 'empty' | 'rows'>, narrowed: boolean, othersNarrowed: boolean): NonNullable<OrdersListModel['empty']> | null {
  const empty = model.empty
  if (!empty) return null
  return (empty.view ? empty.view === model.rows && !othersNarrowed : !narrowed) ? empty : null
}
// ── end F-CP-102 ──

// ── B-TH-243 (threads plan TH-4, ORD-G10; SHEET.brand-view-F01): the Orders' built-in views, on top of Views ▾ ──
/** The rows views as built-in views (the address terms each stands for), the open orders first; a customer's sheet names them so. */
// F-SA-221: + "Made-to-measure" after them (`kind=mtm` with the open orders).
// F-SA-276: + "Waiting on us" (`waiting=us` with the open orders); a host's `views` names which it offers, in its order.
// F-CP-102: + the host's own views (model.hostViews: Drafts of <customer>, Not equal), each where `views` names its id.
// F-CP-103 (review A4): + each view's count from the host's one count read (model.viewCounts; `number` writes it in the person's
// language); on a page locked to one customer no "Orders of <customer>" line under each (the page names the customer: picture 20).
export function builtInViewsOf(model: Pick<OrdersListModel, 'customer' | 'views' | 'hostViews' | 'viewCounts' | 'locked'>, t: Translate, s: Translate, number: (value: number) => string = String): Array<{ id: string; label: string; hint?: string; count?: string }> {
  const name = model.locked?.party ? null : (model.customer?.name ?? null)
  const hint = name ? { hint: s('views.ofCustomer', { customer: name }) } : {}
  const all = [...ROW_VIEWS.map((view) => ({ id: view, label: t(`rows.${view}`), ...hint })), { id: MTM_VIEW, label: s('view.mtm'), ...hint }, { id: WAITING_US_VIEW, label: s('views.waitingUs'), ...hint }, ...(model.hostViews ?? []).map((view) => ({ id: view.id, label: view.label }))]
  const counted = (view: { id: string; label: string; hint?: string }) => {
    const count = model.viewCounts?.[view.id]
    return count === undefined ? view : { ...view, count: number(count) }
  }
  if (!model.views) return all.filter((view) => view.id !== WAITING_US_VIEW && !model.hostViews?.some((own) => own.id === view.id)).map(counted)
  return model.views.flatMap((id) => all.filter((view) => view.id === id)).map(counted)
}

/** F-SA-221: the built-in view "Made-to-measure" (`kind=mtm` + the open orders). */
export const MTM_VIEW = 'kind:mtm'
/** F-SA-276: the built-in view "Waiting on us" (`waiting=us` + the open orders: the customer's Work tab). */
export const WAITING_US_VIEW = 'waiting:us'

/** F-SA-221: the built-in view the address shows: "Made-to-measure" for the open made-to-measure orders, else the rows view. */
// F-SA-276: "Waiting on us" for the open orders waiting on us; another view with the waiting term is none of them.
// F-CP-102: a host's own view the address shows wins (its `active`).
export const builtInActive = (model: Pick<OrdersListModel, 'rows' | 'kind' | 'waiting' | 'hostViews'>): string | null =>
  model.hostViews?.find((view) => view.active)?.id ??
  (model.waiting === 'us' ? (model.rows === 'open' && !model.kind ? WAITING_US_VIEW : null) : model.kind === 'mtm' && model.rows === 'open' ? MTM_VIEW : model.rows)

/** F-SA-276: a built-in view picked — each stands alone (picking Late drops the waiting term; Waiting on us drops nothing else). */
// F-CP-102: a host's own view goes to the host (actions.onHostView).
export function pickBuiltIn(id: string, model: Pick<OrdersListModel, 'waiting' | 'hostViews'>, actions?: Pick<OrdersListActions, 'onKind' | 'onRows' | 'onWaiting' | 'onHostView'>): void {
  if (model.hostViews?.some((view) => view.id === id)) return actions?.onHostView?.(id)
  if (id === MTM_VIEW) return actions?.onKind?.('mtm', 'open')
  if (id === WAITING_US_VIEW) return actions?.onWaiting?.('us', 'open')
  if (model.waiting) return actions?.onWaiting?.(null, id as RowView)
  actions?.onRows?.(id as RowView)
}
// ── end B-TH-243 ──

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
// F-SA-212: the picture is drawn by the one picture part at its phone size (`picture`: the card's own draw).
const cardFieldsOf = (picture: (row: OrderRow) => ReactNode) => ({
  number: { role: 'title' as const },
  customer: { role: 'subtitle' as const },
  picture: { role: 'aside' as const, draw: picture },
  brand: { role: 'field' as const },
  status: { role: 'field' as const },
  promised: { role: 'field' as const },
  madeToMeasure: { role: 'field' as const }, // F-SA-221: the mark on the phone card (never a rider's name)
  whereItIs: { role: 'field' as const }, // F-SA-275: the stage and the health on the phone card
  ...Object.fromEntries(['deposit', 'units', 'orderDate', 'shipped', 'invoiced', 'net', 'gross', 'margin', 'priority', 'season', 'quote', 'company', /* B-TH-244 */ 'openUnits', 'progress', 'paid', 'balance', 'site', 'note', 'atRisk', 'customerUrgency', /* F-SA-221 */ 'riders', /* F-SA-275 */ 'waitingOn', 'supervisor'].map((id) => [id, { role: 'hidden' as const }])),
})

interface ColumnsInput {
  t: Translate
  s: Translate
  d: Translate
  /** B-TH-230: the New messages column's words. */
  l?: Translate
  /** F-SA-275: the supervisor marks' words (production-supervisor). */
  m?: Translate
  /** F-SA-281: the tasks' words (records). */
  r?: Translate
  locale: Locale
  model: OrdersListModel
  wide: boolean
  latest: { current: { model: OrdersListModel; actions?: OrdersListActions } }
  onViewer: (id: string) => void
}

/**
 * The Picture cell (F-SA-212): the ONE picture part at its cell size — the rows AG draws ask their pictures, ONE batch read per
 * page (lib/record-picture), cached by file id until the address expires.
 */
function PictureCell({ row, input }: { row: OrderRow; input: ColumnsInput }) {
  return <RecordPicture source="order" recordId={row.id} number={row.number} picture={row.picture} styleCount={row.styleCount} size="cell" read={input.latest.current.actions?.readPictures} demo={input.model.demoPictures?.[row.id]} onOpen={() => input.onViewer(row.id)} />
}

/** The picture large (F-SA-212: the one viewer): Open style, the order, and its lines for its other styles. */
function PictureViewerFor({ row, model, actions, onClose }: { row: OrderRow; model: OrdersListModel; actions?: OrdersListActions; onClose: () => void }) {
  return (
    <PictureViewer
      source="order"
      recordId={row.id}
      number={row.number}
      picture={row.picture}
      styleCount={row.styleCount}
      read={actions?.readPictures}
      demo={model.demoPictures?.[row.id]}
      prefix={model.prefix}
      recordHref={orderHref(model.prefix, row)}
      linesHref={`${model.prefix}/sales/orders/${encodeURIComponent(row.id)}?tab=lines`}
      onClose={onClose}
    />
  )
}

/**
 * The sheet's columns in the picture's order. Every value that names a thing is its door (a real link: ⌘-click opens a new
 * tab); Brand, Status and Company narrow the sheet (the funnel mark); a cell the reader may not open says why on hover; the
 * rest of the row opens the order. Money columns are absent without their grain, never zero.
 */
function sheetColumns({ t, s, d, l, m, r, locale, model, wide, latest, onViewer }: ColumnsInput): ColDef<OrderRow>[] {
  const input: ColumnsInput = { t, s, d, l, m, r, locale, model, wide, latest, onViewer }
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
        {data.madeToMeasure ? (
          // F-SA-221: the made-to-measure mark under the number — a funnel door to the made-to-measure orders (never a rider's name).
          <span className="fw-so-inline">
            <span className="fw-sheet-sub">{data.customerRef ? t('list.customerRef', { ref: data.customerRef }) : t('list.noCustomerRef')}</span>
            <MtmMark row={data} s={s} onNarrow={latest.current.model.kind ? undefined : () => act()?.onKind?.('mtm')} />
          </span>
        ) : (
          <span className="fw-sheet-sub">{data.customerRef ? t('list.customerRef', { ref: data.customerRef }) : t('list.noCustomerRef')}</span>
        )}
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
          // ---- F-SA-275: Add task… on this order (the one New task window, F-SA-281) and Answer request… while one waits on us.
          ...(act()?.onAddTask ? [{ id: 'task', label: s('row.addTask'), onSelect: () => act()?.onAddTask?.([data.id], 'row'), disabled: !!latest.current.model.bulkCan?.task, ...(latest.current.model.bulkCan?.task && r ? { description: r(latest.current.model.bulkCan.task) } : {}) }] : []),
          ...answerItem(data),
          // ---- end F-SA-275
        ]}
      />
    ) : null
  // ---- F-SA-275: the production columns (opt-in on Sales › Orders, shown by the customer page's views; their reads only while shown) ----
  const now = Date.now()
  const pw = productionWordsFor(locale)
  const answerItem = (row: OrderRow) => {
    const request = waitingItemsOf(row, latest.current.model.marks?.[row.id]).find((item) => item.kind === 'request')
    return request && request.kind === 'request' ? [{ id: 'answer', label: s('row.answer'), href: answerHrefOf(prefix, row, request, latest.current.model.doorHref) }] : []
  }
  const whereText = (row: OrderRow): string => {
    const line = whereLineOf(row)
    if (line.kind === 'unread') return ''
    if (line.kind === 'status') return t(`status.${row.status}`)
    return [pw(`parts.stage.${line.stage}`), line.health ? pw(`parts.health.${HEALTH_CHIP[line.health]}`) : null].filter(Boolean).join(' · ')
  }
  const WhereCell = ({ data }: ICellRendererParams<OrderRow>) => (data ? <WhereItIsCell row={data} t={t} s={s} /> : null)
  const WaitingCell = ({ data }: ICellRendererParams<OrderRow>) => (data ? <WaitingOnCell row={data} mark={latest.current.model.marks?.[data.id]} prefix={prefix} doorHref={latest.current.model.doorHref} s={s} now={now} /> : null)
  const SupervisorColumn = ({ data }: ICellRendererParams<OrderRow>) => (data && m ? <SupervisorCell row={data} s={s} marks={m} /> : null)
  // ---- end F-SA-275
  const also = (key: string, label: string) => ({ exportWith: [{ key, label }] })
  // ── B-TH-244 (N23, ORD-G08): the later columns — opt-in (hidden until Customise or a view shows them), each the export's own key ──
  const later = (column: ColDef<OrderRow>): ColDef<OrderRow> => ({ ...column, hide: true, sortable: false, context: { ...((column.context as object | undefined) ?? {}), optIn: true } })
  const ProgressCell = ({ data }: ICellRendererParams<OrderRow>) => (data ? <span className="fw-sheet-progress">{progressWords(data, s)}</span> : null)
  const MoneyOf = (key: 'paid' | 'balance') => ({ data }: ICellRendererParams<OrderRow>) => (data && typeof data[key] === 'number' ? <span>{money(data[key] as number, data.currency, locale)}</span> : null)
  const AtRiskCell = ({ data }: ICellRendererParams<OrderRow>) =>
    data?.atRisk ? (
      <FunnelButton tip={s('atRisk.filter')} onClick={() => act()?.onExtra?.({ atRisk: true })}>
        <Tag tone="warning">{s('atRisk.days', { count: data.atRisk.daysLeft })}</Tag>
      </FunnelButton>
    ) : null
  const UrgencyCell = ({ data }: ICellRendererParams<OrderRow>) =>
    data?.customerUrgency ? (
      <FunnelButton tip={s('urgency.filter', { urgency: s(`urgency.${data.customerUrgency}`) })} onClick={() => act()?.onExtra?.({ customerUrgency: data.customerUrgency })}>
        {s(`urgency.${data.customerUrgency}`)}
      </FunnelButton>
    ) : null
  const laterColumns: ColDef<OrderRow>[] = [
    later({ colId: 'openUnits', headerName: s('col.openUnits'), headerTooltip: s('col.openUnitsHint'), minWidth: 88, flex: 0.5, type: 'rightAligned', valueGetter: ({ data }: { data?: OrderRow }) => data?.openUnits ?? null }),
    later({ colId: 'progress', headerName: s('col.progress'), headerTooltip: s('col.progressHint'), minWidth: 150, flex: 1, cellRenderer: ProgressCell, valueGetter: ({ data }: { data?: OrderRow }) => (data ? progressWords(data, s) : '') }),
    ...(can.price
      ? [
          later({ colId: 'paid', headerName: s('col.paid'), minWidth: 104, flex: 0.7, type: 'rightAligned', cellRenderer: MoneyOf('paid') }),
          later({ colId: 'balance', headerName: s('col.balance'), headerTooltip: s('col.balanceHint'), minWidth: 104, flex: 0.7, type: 'rightAligned', cellRenderer: MoneyOf('balance') }),
        ]
      : []),
    later({ colId: 'site', headerName: s('col.site'), minWidth: 110, flex: 0.8, valueGetter: ({ data }: { data?: OrderRow }) => (data ? (data.sites ?? []).map((site) => site.name).join(', ') : '') }),
    later({ colId: 'note', headerName: s('col.note'), headerTooltip: s('col.noteHint'), minWidth: 160, flex: 1.2, valueGetter: ({ data }: { data?: OrderRow }) => data?.internalNote ?? '' }),
    later({ colId: 'atRisk', headerName: s('col.atRisk'), headerTooltip: s('col.atRiskHint'), minWidth: 120, flex: 0.8, cellRenderer: AtRiskCell }),
    later({ colId: 'customerUrgency', headerName: s('col.customerUrgency'), headerTooltip: s('col.customerUrgencyHint'), minWidth: 120, flex: 0.8, cellRenderer: UrgencyCell }),
    // F-SA-221: made to measure and its riders (the riders only for a reader of measurements: the API names them to no one else) —
    // opt-in, shown at once when the sheet shows made-to-measure orders only (the built-in view, the Made-to-measure page).
    { ...later({ colId: 'madeToMeasure', headerName: s('mtm.mark'), minWidth: 150, flex: 0.9, valueGetter: ({ data }: { data?: OrderRow }) => (data ? mtmText(data, s) : '') }), hide: !model.kind },
    ...(can.measurements ? [{ ...later({ colId: 'riders', headerName: s('col.riders'), minWidth: 140, flex: 1, valueGetter: ({ data }: { data?: OrderRow }) => (data ? ridersText(data) : '') }), hide: !model.kind }] : []),
  ]
  // ── end B-TH-244 ──
  return serverSorted(model.sort ?? null, [
    { colId: 'picture', headerName: s('col.picture'), minWidth: 76, maxWidth: 76, sortable: false, suppressHeaderMenuButton: true, cellRenderer: PictureColumn },
    { colId: 'number', headerName: t('col.number'), field: 'number', minWidth: 128, flex: 1, cellRenderer: NumberCell, context: also('customerRef', s('col.customerRef')) },
    { colId: 'customer', headerName: t('col.customer'), field: 'partyName', minWidth: 112, flex: 1.2, cellRenderer: CustomerCell },
    { colId: 'brand', headerName: s('col.brand'), headerTooltip: s('col.brandHint'), minWidth: 100, flex: 1, sortable: false, cellRenderer: BrandCell },
    { colId: 'status', headerName: t('col.status'), field: 'status', minWidth: 112, flex: 0.9, cellRenderer: StatusCell },
    // F-SA-275: Where it is — the plain stage + health, this order's own pieces (reads `production` and `progress` while shown).
    later({ colId: 'whereItIs', headerName: s('col.whereItIs'), headerTooltip: s('col.whereItIsHint'), minWidth: 150, flex: 1, cellRenderer: WhereCell, valueGetter: ({ data }: { data?: OrderRow }) => (data ? whereText(data) : '') }),
    // B-TH-230: only for a reader of threads (the API counts only what the reader may open).
    ...(model.unread && l ? [{ colId: 'newMessages', headerName: l('column'), headerTooltip: l('columnHint'), minWidth: 136, flex: 0.8, sortable: false, valueGetter: ({ data }: { data?: OrderRow }) => unreadValue(data ? latest.current.model.unread?.[data.id] : undefined), cellRenderer: NewMessagesCell } as ColDef<OrderRow>] : []),
    { colId: 'deposit', headerName: t('col.deposit'), minWidth: 96, flex: 0.8, cellRenderer: DepositCell },
    { colId: 'units', headerName: t('col.units'), field: 'units', minWidth: 72, flex: 0.5, cellRenderer: UnitsCell },
    { colId: 'orderDate', headerName: t('col.orderDate'), field: 'orderDate', minWidth: 104, flex: 0.8, hide: !wide, cellRenderer: OrderedCell, context: also('requested', s('col.requested')) },
    { colId: 'promised', headerName: t('col.promised'), field: 'promiseDate', minWidth: 108, flex: 0.9, cellRenderer: PromiseCell, context: also('daysLate', s('col.daysLate')) },
    // F-SA-275: Waiting on — the most urgent of a request to answer, a reply that waits, who acts next ("+1 more").
    later({ colId: 'waitingOn', headerName: s('col.waitingOn'), headerTooltip: s('col.waitingOnHint'), minWidth: 136, flex: 0.9, cellRenderer: WaitingCell, valueGetter: ({ data }: { data?: OrderRow }) => (data ? (waitingItemsOf(data, latest.current.model.marks?.[data.id])[0]?.kind ?? '') : '') }),
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
    // F-SA-275: Supervisor — Me / Someone else / Not set, never a name on a list (the work orders' right; held in words without it).
    later({ colId: 'supervisor', headerName: s('col.supervisor'), headerTooltip: s('col.supervisorHint'), minWidth: 104, flex: 0.6, cellRenderer: SupervisorColumn, valueGetter: ({ data }: { data?: OrderRow }) => data?.production?.supervisorMark ?? '' }),
    ...laterColumns, // B-TH-244
    { colId: 'more', headerName: t('col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
  ] as ColDef<OrderRow>[]).map((column) => withPreset(column, model.preset ?? null, wide)) // F-SA-276
}

/** F-SA-276: the host's first columns (its view's preset; from 1800 px its wide ones too); ⋯ always; a person's Customise wins. */
export function withPreset(column: ColDef<OrderRow>, preset: OrdersListModel['preset'] | null, wide: boolean): ColDef<OrderRow> {
  if (!preset || column.colId === 'more') return column
  const id = column.colId ?? ''
  return { ...column, hide: !(preset.shown.includes(id) || (wide && !!preset.wide?.includes(id))) }
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

// ── B-TH-244 (threads plan TH-4, picture 26; features SHEET.overall-F02 … F11) ──────────────────────────────────────────────────
/** The door terms as chips (each with ✕): what a total's door added beside the rows view. */
export function extraChips(extra: ExtraTerms | null, t: Translate, s: Translate): Array<{ key: keyof ExtraTerms; label: string }> {
  if (!extra) return []
  const out: Array<{ key: keyof ExtraTerms; label: string }> = []
  if (extra.status) out.push({ key: 'status', label: s('chips.status', { status: t(`status.${extra.status}`) }) })
  if (extra.late) out.push({ key: 'late', label: s('chips.late') })
  if (extra.deposit) out.push({ key: 'deposit', label: s('chips.deposit') })
  if (extra.reaccept) out.push({ key: 'reaccept', label: s('chips.reaccept') })
  if (extra.shippedNotInvoiced) out.push({ key: 'shippedNotInvoiced', label: s('chips.uninvoiced') })
  if (extra.invoiced) out.push({ key: 'invoiced', label: s('chips.invoiced', { state: s(`invoiced.${extra.invoiced}`) }) })
  if (extra.atRisk) out.push({ key: 'atRisk', label: s('chips.atRisk') })
  if (extra.currency) out.push({ key: 'currency', label: s('chips.currency', { currency: extra.currency }) })
  if (extra.customerUrgency) out.push({ key: 'customerUrgency', label: s('chips.urgency', { urgency: s(`urgency.${extra.customerUrgency}`) }) })
  return out
}

/**
 * The grouped view's groups for the list frame: one header per customer of the view (the server's figures for ALL its orders, each a
 * door; its name opens that customer's sheet), its rows as its own reads bring them ("Show more of …"), and the grand total pinned
 * under the grid ("All customers", or "All my customers" for a person limited to some). Null: not grouped, or the figures not read yet.
 */
function useOverallGroups(model: OrdersListModel, actions: OrdersListActions | undefined, t: Translate, s: Translate, locale: Locale): ListGroups<OrderRow> | null {
  const value = model.summary?.value ?? null
  const path = `${model.prefix}/sales/orders`
  const latest = useRef(actions)
  latest.current = actions
  return useMemo(() => {
    if (model.group !== 'party' || !value?.groups) return null
    const rowsOf = model.groupRows ?? {}
    return {
      keyOf: (row: OrderRow) => row.partyId,
      groups: value.groups.map((group) => {
        const own = rowsOf[group.partyId]
        return {
          key: group.partyId,
          name: group.name,
          label: (
            <Link href={groupHref(path, group)} className="fw-sheet-door strong" data-door="" title={s('totals.openSheet', { name: group.name })}>
              {group.name}
            </Link>
          ),
          summary: (
            <>
              <FiguresLine doors={figureDoors(group.figures, { path, t: s, locale })} label={s('totals.of', { name: group.name })} />
              <span className="fw-sheet-sub">{s(timingKey(group))}</span>
            </>
          ),
          state: own?.loading && !own.items ? { kind: 'reading' as const } : own?.problem ? { kind: 'failed' as const, words: t(own.problem), onRetry: () => latest.current?.onGroupRetry?.(group.partyId) } : null,
          more: own?.more && !own.loading ? { label: s('groups.more', { name: group.name }), onMore: () => latest.current?.onGroupMore?.(group.partyId) } : null,
        }
      }),
      collapsed: model.collapsed ?? [],
      onToggle: (key: string) => latest.current?.onToggleGroup?.(key),
      total: (
        <>
          <span className="fw-sheet-total-name">{s(totalNameKey(value))}</span>
          <FiguresLine doors={figureDoors(value.all, { path, t: s, locale })} label={s(totalNameKey(value))} />
        </>
      ),
    }
  }, [model.group, value, model.groupRows, model.collapsed, path, t, s, locale])
}

/** The Progress cell: cut, sewn and finished of the pieces in work orders ("—" for a step nothing counts); none yet: words. */
export function progressWords(row: Pick<OrderRow, 'progress'>, s: Translate): string {
  const progress = row.progress
  if (progress === undefined) return '—'
  if (progress === null) return s('progress.none')
  const figure = (value: number | null) => (value === null ? '—' : String(value))
  return s('progress.text', { cut: figure(progress.cut), sewn: figure(progress.sewn), finished: figure(progress.finished), inWork: progress.inWork })
}
// ── end B-TH-244 ──

// ── B-TH-245 (threads plan TH-4, SHEET-G09; features SHEET.brand-fields-F03 edit in a cell, -F08 Edit N; O-SAL-ORD-LIST.grid-F26) ──
/** Why an order keeps its cells: a closed or cancelled order never changes (the database freezes it), in words; else null. */
export function heldCell(row: Pick<OrderRow, 'status'>, t: Translate, s: Translate): string | null {
  return row.status === 'CLOSED' || row.status === 'CANCELLED' ? s('cells.final', { status: t(`status.${row.status}`) }) : null
}

/**
 * The sheet's own edit fields: the order note (the office's; the customer never sees it). The custom values join them in the list
 * frame (`custom.edit`); the order's lines never edit here (an amendment changes them). A person without orders.manage reads every
 * cell (held, in words); Edit N reviews old → new before it saves; a row changed by someone else meanwhile is refused as "changed
 * since", never overwritten.
 */
export function orderEditOf(model: Pick<OrdersListModel, 'can'>, s: Translate, held: (row: OrderRow) => string | null, onSaved: (id: string, after: Readonly<Record<string, string | number | null>>, version: number) => void): ListEdit<OrderRow> {
  return {
    fields: { note: { kind: 'text', nullable: true, maxLength: 2000, label: s('col.note'), valueOf: (row) => row.internalNote ?? null, held } },
    versionOf: (row) => row.version,
    labelOf: (row) => row.number,
    onSaved,
    bulk: { noun: { one: s('cells.nounOne'), other: s('cells.nounOther') } },
    held: model.can.manage ? null : s('cells.noManage'),
  }
}
// ── end B-TH-245 ──
