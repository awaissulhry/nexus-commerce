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
import { useCardList } from '@nexus/ui/grid/card-list/index' // F-CP-107 (cp-fx16): the phone card keeps a preset's table-wide columns
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
import { columnSort, SORT_COLUMNS, sortOfColumn } from '../../model'
import { sortChoicesOf, urgentRuleOf } from '../../model' // F-CW-201
import { ArrowUpDown } from 'lucide-react' // F-CW-201: the Sort ▾ trigger's mark
import type { OrderSort } from '../../api'
import type { OrdersListActions, OrdersListModel } from '../list-model'
import { NewOrderDialog } from './NewOrderDialog'
import { marginColumn } from '../margin/MarginColumn'
import { OrdersBoard } from './OrdersBoard'
// ---- B-W2b-323 (orders in depth on screen) ----
import { depthColumns, printVerb, SetPriorityDialog } from '../../list-depth/view/ListDepth'
import { WeekBoard } from '../../week/view/WeekBoard'
import { OrdersImportView } from '../../import/view/OrdersImportView'
import { NAMESPACE as DEPTH } from '../../depth/model'
import { depthEditHeld } from '../../depth/model' // F-CW-204: a closed order's priority never changes (the row's Set priority…)
import '../../orders.css'
// ---- B-TH-225 / B-TH-226 (TH-1a: the Orders sheet, every cell a door; the Customer switcher) ----
import { brandCell, customerDoor, depositDoor, exportAbout, invoicedCell, invoicedDoor, linesDoor, NAMESPACE as SHEET, orderDoor, orderHref, quoteDoor, shippedDoor, type Door } from '../sheet/model'
import { DoorCell, FunnelButton, PeekCard, PeekLink, SheetChips, type SheetChip } from '../sheet/parts'
import { CustomerSwitcher } from '../../../_shared/customer-switcher/view/CustomerSwitcher' // F-SA-224: the one customer filter
// F-SA-212: the ONE picture part (the cell, the phone card's aside and the picture large).
import { RecordPicture } from '../../../../../lib/record-picture/view/RecordPicture'
import { PictureViewer } from '../../../../../lib/record-picture/view/PictureViewer'
// B-TH-230: the New messages column (LastMessageCell).
import { LAST_MESSAGE_NS } from '../../../../../lib/last-message-cell/view/LastMessageCell'
import { unreadValue } from '../../../../../lib/last-message-cell/model'
// ---- B-TH-244 (TH-4: the overall view grouped by customer, the later columns, Invoice shipped goods for N) ----
import { Receipt } from 'lucide-react'
import type { ListGroups } from '../../../../../list-frame/groups/model'
import { figureDoors, groupHref, timingKey, totalNameKey } from '../sheet/overall'
import { FiguresLine, InvoiceDraftsDialog } from '../sheet/overall-parts'
import type { ExtraTerms } from '../../model'
import type { ListEdit } from '../../../../../list-frame/w2b/model' // B-TH-245
// ---- F-SA-275 (the API's B-SA-070): Where it is, Waiting on, Supervisor (opt-in here, shown by the customer page's views), ⋯ Add task… / Answer request… ----
import { SupervisorCell, WaitingOnCell, WhereItIsCell } from '../sheet/parts'
import { answerHrefOf, waitingItemsOf, whereTextOf } from '../sheet/model' // F-MS-104: whereTextOf (the line's words)
import { phasePhrase } from '../sheet/model' // F-CW-101: a phase door's chip
// ---- F-CW-102: the row's chips — Customer urgency (read-only) and the New messages bubble; Where it is draws its own ----
import { CustomerUrgencyCell, MessagesHeader, NewMessagesBubble } from '../sheet/parts'
import { priorityChipOf, urgencyChipOf } from '../sheet/model'
// ---- end F-CW-102
import { SUPERVISOR_NS } from '../../../../_shared/production-supervisor/model'
import { productionWordsFor } from '../../../../../lib/production/words'
// ---- end F-SA-275
// ---- F-SA-280 (bulk on the sheet's own bar): production's assign and note dialogs, reused in place; one customer only ----
import { MessageSquareLock, UserCog } from 'lucide-react'
import { AssignSupervisorDialog } from '../../../../_shared/production-supervisor/view/AssignSupervisorDialog'
import { NoteDialog } from '../../../../production/_shared/notes/view/NoteDialog'
import { NOTES_NS } from '../../../../production/_shared/notes/model'
// ---- end F-SA-280
// ---- F-SA-281: the one New task window (one order, or N in one batch) ----
import { ListPlus } from 'lucide-react'
import { TaskNewDialog } from '../../../../../record-panels/tasks/view/TaskNewDialog'
// ---- end F-SA-281
// ---- F-SA-282: Reply to <customer> on N… (one customer, ≤ 50, one batchId; each order's own conversation, the portal only) ----
import { Globe } from 'lucide-react'
import { replyManyLabel } from '../reply-many'
import { ReplyManyDialog } from './ReplyManyDialog'
// ---- end F-SA-282
// ---- F-CP-140: the price check columns (ONE spec: ../price-check-columns.ts) and their cells ----
import { PRICE_CHECK_IDS, priceCheckColDefs, priceCheckText, type PriceCheckId } from '../price-check-columns'
import { PriceDiffCell, PriceMatchCell } from './PriceMatchCell'
// ---- end F-CP-140
import { PriceCheckDialog } from '../../price-check/PriceCheckDialog' // F-CP-114: the ONE customer's-price window
import '../../price-check/price-check.css' // F-CP-114: the Customer's price cell's door
// ---- F-CP-108: the row ⋯ "Next steps" — the order page's own commands (A14's map) in ONE window, its own dialogs ----
import { useToast, type MenuItemDef } from '@nexus/ui/components'
import { rowStepsOf, wordsText, type RowStep, type Words } from '../commands/model'
import { OrderCommandWindow } from '../commands/view/OrderCommandWindow'
import '../commands/commands.css'
// ---- end F-CP-108
// ---- F-CP-109: Mark N ready… · Close N… · Confirm N… on the bar (≤ 50; Cancel stays one at a time) ----
import { Archive, CheckCheck, PackageCheck } from 'lucide-react'
import { manyLabel, type ManyCommand } from '../commands/model'
// ---- F-CW-202: the bar — three acts with words + More ▾ (the pure rule: sheet/bar.ts) ----
import { ChevronDown, Factory, Flag, MessageCircleQuestion } from 'lucide-react'
import { MessageSquare } from 'lucide-react' // cw fx5 (walk W-13): the phone card's Thread door
import { barOf, type AskEntryId, type BarAct, type BarActId, type BarWords } from '../sheet/bar'
import { promotedFit } from '../sheet/bar' // cw fx5 (walk W-9, W-4, W-14): the bar keeps words on every button
// ---- F-CW-301: Ship N together… / Create shipment… — Warehouse's own New shipment window, mounted here ----
import { Truck } from 'lucide-react'
import { shipRowHeld, shipRowOffered } from '../sheet/ship'
import { ShipNoticeBanner, ShipWindow } from './ShipTogether'
// ---- end F-CW-301
// ---- F-CW-302: the customer's urgency as we steer it — the shared window, mounted here; the acts a row offers ----
import { Undo2, Unlock } from 'lucide-react'
import { askedHrefOf, rowUrgencyActs } from '../sheet/urgency'
import { UrgencyNotice, UrgencyWindow } from './UrgencyWindow'
// ---- end F-CW-302
// ---- end F-CW-202
import { OrderCommandManyDialog } from '../commands/view/OrderCommandManyDialog'
// ---- end F-CP-109

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
    <WithMessages namespaces={['orders', 'lists', DEPTH /* B-W2b-323 */, SHEET /* B-TH-225 */, LAST_MESSAGE_NS /* B-TH-230 */, SUPERVISOR_NS /* F-SA-275: the supervisor marks */, NOTES_NS /* F-SA-280: the note dialog's held words */]}>
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
  const locale = useLocale()
  const wide = useWide(model.wide) // B-TH-225: Ordered, Margin %, Priority, Season and From quote at 1920
  // F-CP-107 (cp-fx16): is the Status column on screen (the frame tells; a person's Customise wins)? Until it tells: the preset's.
  // F-CP-107 (cp-fx17): the setter is setShowsStatus — commands.vitest F-CP-108 guards this view against any status-editor name.
  const [statusShown, setShowsStatus] = useState(() => statusShownOf(model.preset ?? null))
  // F-CW-102: the same rule for two more facts a row never says twice — our Priority (its own column, or the chip in Customer
  // urgency) and the lateness (chip 2 of Where it is, or the tag beside the promise date).
  const [priorityShown, setShowsPriority] = useState(false)
  const [whereShown, setShowsWhere] = useState(() => !!model.preset?.shown.includes('whereItIs'))
  // cw fx5 (walk W-29): and for what waits — the Waiting on column on screen says it, so chip 3 of Where it is does not repeat it.
  const [waitingShown, setShowsWaiting] = useState(() => !!model.preset?.shown.includes('waitingOn'))
  const phone = useCardList() // the list frame's own rule (cards below 720 px)
  // ---- end F-CP-107 (cp-fx16)
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
  // ---- F-CP-108: a command done from a row's ⋯ says so in a DS toast ("SO-0142 marked ready"); the row already shows it in place.
  const { toast } = useToast()
  const receipt = model.commands?.receipt ?? null
  useEffect(() => {
    if (receipt) toast(wordsText(receipt.words, t, s, locale), 'success')
  }, [receipt?.at]) // eslint-disable-line react-hooks/exhaustive-deps -- once per command done
  // ---- end F-CP-108

  // v: List ⇄ Board (the design's view key); c: New order — never while typing or inside a dialog. The list frame keeps
  // / j k x Enter ?.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      // B-TH-225 (grid-F28, F29): o opens the focused cell's door; ⌘ / Ctrl + Enter opens it (or the row's order) in a new tab.
      const cell = target?.closest('.ag-cell')
      if (cell && !help && !model.newOrder && !target?.closest('input, textarea, select')) {
        const door = cell.querySelector<HTMLElement>('a[data-door], button[data-door], button.fw-sheet-funnel, button[data-picture]') // F-SA-212: the picture part; F-CP-114: a window's door
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
      if (event.key === 'v' && model.layoutSwitch !== false /* F-CW-202 (S36): only where the switch is drawn */) {
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

  // cw fx5 (walk W-8): one customer, one name — on a page of ONE customer the host's own name of it (the record's, the band's) in
  // every word that names the customer (the bar, the held words, the windows); the other hosts keep each row's name.
  const lockedName = model.locked?.party ? (model.customer?.name ?? null) : null
  const named = <R extends { partyName: string }>(row: R): R => (lockedName ? { ...row, partyName: lockedName } : row)
  const picked = (items ?? []).filter((row) => selected.includes(row.id)).map(named)
  // cw fx5: the room the bar has — the sheet's own width, measured (null before the first measure and on the server: every act shown).
  const sheetRef = useRef<HTMLDivElement | null>(null)
  const [barRoom, setBarRoom] = useState<number | null>(null)
  useEffect(() => {
    const element = sheetRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    // A few px of change (a scroll bar, a dock that slides) redraw nothing: the room is kept until it moves by 4 px or more.
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? element.clientWidth)
      setBarRoom((was) => (was !== null && Math.abs(was - next) < 4 ? was : next))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  // ---- F-CW-202 (10-design §4; lead settles S8, S9): the bar of ticked orders — at most three acts with their words, the rest in ONE
  // More ▾, in one fixed order (sheet/bar.ts: barOf). An act the reader has no right for is not drawn (each act reads its OWN right);
  // an act the ticked orders cannot take now is held with words; when a promoted act is not there the next one moves up. The same on
  // every host of the sheet. Each act opens its own existing window (F-SA-280, F-SA-281, F-SA-282, F-CP-109, B-TH-244, B-W2b-323).
  const pickedIds = picked.map((row) => row.id)
  const replyPhrase = replyManyLabel(picked)
  const barRun: Record<Exclude<BarActId, 'ask'>, () => void> = {
    ship: () => actions?.onShipTogether?.(pickedIds), // F-CW-301
    priority: () => actions?.depth?.onSetPriority?.(pickedIds),
    reply: () => actions?.onReplyMany?.(pickedIds),
    assign: () => actions?.onAssignSupervisor?.(pickedIds),
    task: () => actions?.onAddTask?.(pickedIds, 'selection'),
    note: () => actions?.onNote?.(pickedIds),
    ready: () => actions?.onCommandMany?.(pickedIds, 'ready'),
    close: () => actions?.onCommandMany?.(pickedIds, 'close'),
    confirm: () => actions?.onCommandMany?.(pickedIds, 'confirm'),
    urgencyRegular: () => actions?.onUrgency?.('regular', pickedIds), // F-CW-302: the window names the ticked orders it runs on
    urgencyUnlock: () => actions?.onUrgency?.('unlock', pickedIds),
    invoice: () => actions?.onInvoiceShipped?.(pickedIds),
  }
  const barLabel: Record<Exclude<BarActId, 'ask'>, string> = {
    ship: s('bar.ship', { count: picked.length }), // F-CW-301
    priority: d('list.setPriority', { count: picked.length }),
    reply: s(replyPhrase.key, replyPhrase.params),
    assign: s('bulk.assign'),
    task: s('bulk.addTask', { count: picked.length }),
    note: s('bulk.note', { count: picked.length }),
    ready: wordsText(manyLabel('ready', picked.length), t, s, locale),
    close: wordsText(manyLabel('close', picked.length), t, s, locale),
    confirm: wordsText(manyLabel('confirm', picked.length), t, s, locale),
    urgencyRegular: s('bar.urgencyRegular'), // F-CW-302
    urgencyUnlock: s('bar.urgencyUnlock'),
    invoice: s('invoiceShipped.action', { count: picked.length }),
  }
  // cw fx5 (walk W-9, W-4, W-14): the bar keeps WORDS on every button, on one line — the acts the room holds beside the frame's own
  // Edit N, Export N and Clear selection stay promoted; the last one that does not fit moves to the front of More ▾ (sheet/bar.ts).
  const barArgs = [
    { ship: !!model.ship?.can.manage /* F-CW-301 */, urgency: !!model.urgency?.can /* F-CW-302 */, manage: model.can.manage, close: model.can.close, decide: !!model.commands?.decide, post: !!model.bulkCan?.note, supervisor: !!model.bulkCan?.supervisor, task: model.bulkCan?.task === null, todo: !!model.bulkCan?.todo /* F-CW-203 */, invoices: model.can.manageInvoices },
    picked,
    { locked: model.locked?.party ? (model.customer?.id ?? null) : null, urgencyOff: model.urgencyOff === true /* F-CW-302: the Work tab's own read */ },
  ] as const
  const barAll = barOf(...barArgs)
  const barRest = [
    ...(model.can.manage ? [{ label: lists('bulk.edit', { count: picked.length }) }] : []), // the frame's own Edit N (orderEditOf: only with the right)
    { label: lists('exportSelected.label', { count: picked.length }) },
    ...(barAll.promoted.length + barAll.more.length > 1 ? [{ label: s('bar.more'), menu: true }] : []),
    { label: lists('clear') },
  ]
  const barFit = promotedFit(barRoom, lists('selected', { count: picked.length }), barAll.promoted.map((act) => (act.id === 'ask' ? { label: s('bar.ask'), menu: true } : { label: barLabel[act.id] })), barRest, phone)
  const bar = barOf(...barArgs, barFit)
  /** A hold's words, from the catalogue that already says them. */
  const sayBar = (words: BarWords | null): string | null => {
    if (!words) return null
    if (words.ns === 'notes') return n(words.key, words.params)
    if (words.ns === 'supervisor') return m(words.key, words.params)
    if (words.ns === 'depth') return d(words.key, words.params)
    return oneStop(wordsText({ key: words.key, ...(words.params ? { params: words.params } : {}), ...(words.ns === 'sheet' ? { sheet: true as const } : {}), ...(words.states ? { states: words.states } : {}) }, t, s, locale))
  }
  /** Ask ▾: each entry says who reads it in a quiet line; held, it says why instead. */
  // F-CW-203: + "Ask <customer> about N…" — Reply to N with the to-do tick ON (the customer named when the ticked orders are of one).
  const askRun: Record<AskEntryId, () => void> = {
    // Production's own Note window as an ask: its title here, its Send word the notes' own ("Write on 3").
    askProduction: () => actions?.onAskProduction?.(pickedIds, { title: s('bar.askProductionTitle', { count: picked.length }), send: n('send', { count: picked.length }), hint: s('bar.askProductionThen') /* F-CW-303 */ }),
    askCustomer: () => actions?.onReplyMany?.(pickedIds, { todo: true }),
  }
  const askLabel: Record<AskEntryId, string> = {
    askProduction: s('bar.askProduction', { count: picked.length }),
    askCustomer: replyPhrase.key === 'bulk.reply' ? s('bar.askCustomer', { customer: picked[0]?.partyName ?? '', count: picked.length }) : s('bar.askCustomerAny', { count: picked.length }),
  }
  const askItems = (act: BarAct): MenuItemDef[] =>
    (act.entries ?? []).map((entry) => {
      const held = sayBar(entry.held)
      return { id: entry.id, label: askLabel[entry.id], icon: entry.id === 'askProduction' ? <Factory size={14} aria-hidden /> : <Globe size={14} aria-hidden />, description: held ?? s(`bar.${entry.id}Who`), ...(held ? { disabled: true } : { onSelect: askRun[entry.id] }) }
    })
  const barActs = (
    <>
      {bar.promoted.map((act) =>
        act.id === 'ask' ? (
          <Menu
            key={act.id}
            label={
              <>
                <MessageCircleQuestion size={13} aria-hidden /> {s('bar.ask')} <ChevronDown size={13} aria-hidden />
              </>
            }
            triggerProps={{ className: 'nds-btn sm' }}
            items={askItems(act)}
          />
        ) : (
          // The words stay on the button at every width (no DS SelectionLabel): the frame's own Edit N, Export N and Clear give way first.
          <Button key={act.id} size="sm" variant={act.id === 'ship' ? 'primary' : undefined /* F-CW-301: the leading act */} heldReason={sayBar(act.held)} onClick={barRun[act.id]}>
            <BarIcon id={act.id} /> {barLabel[act.id]}
          </Button>
        ),
      )}
      {bar.none && <span className="fw-sheet-bar-none">{s('bar.none')}</span>}
    </>
  )
  const barMoreItems: MenuItemDef[] = bar.more.flatMap((act, index): MenuItemDef[] => {
    const rule: MenuItemDef[] = index > 0 && bar.more[index - 1]!.group !== act.group ? [{ id: `sep-${act.id}`, separator: true }] : []
    if (act.id === 'ask') return [...rule, ...askItems(act)]
    const id = act.id
    const held = sayBar(act.held)
    return [...rule, { id, label: barLabel[id], icon: <BarIcon id={id} />, ...(held ? { disabled: true, description: held } : { onSelect: barRun[id] }) }]
  })
  const barMore =
    barMoreItems.length > 0 ? (
      <Menu
        // cw fx5 (walk W-3): on the phone More ▾ stands at the LEFT of its own line — the menu hangs from the side that has room
        // (it opened from the button's right edge: 117 px wide, partly off the screen, each item on three lines).
        align={phone ? 'left' : 'right'}
        label={
          <>
            {s('bar.more')} <ChevronDown size={13} aria-hidden />
          </>
        }
        triggerProps={{ className: 'nds-btn sm' }}
        items={barMoreItems}
      />
    ) : null
  // ---- end F-CW-202
  const ownKeys: ListKey[] = [
    // F-CW-202 (S36; review A1-B4): List ⇄ Board has its key only where the switch is drawn (not on the customer's Work tab).
    ...(model.layoutSwitch === false ? [] : [{ keys: ['v'], does: t('list.keyView') }]),
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
      aria-label={model.searchLabel ?? t('list.search') /* F-CW-104: the host's own shorter words */}
      // cw fx5 (walk W-23): in a room below 480 px the long words were cut ("Search number, PO or"): the short ones there; the
      // field's name stays whole.
      placeholder={barRoom !== null && barRoom < SEARCH_SHORT_BELOW ? s('searchShort') : (model.searchLabel ?? t('list.search'))}
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
  // F-CW-201 (lead settles S5, S34): a menu button like Views ▾ (the DS Menu the sheet already uses) on every host — its trigger says
  // the order shown, the choice shown is ticked, and "Most urgent first" carries its rule as a quiet second line. On a sheet of ONE
  // customer "Customer A–Z / Z–A" are not offered (they order nothing there).
  const sortChoices = sortChoicesOf(!!model.locked?.party)
  const sortNow = sortChoices.find((choice) => choice.value === (model.sort ?? '')) ?? null
  const urgentRule = urgentRuleOf(model.locked?.party ? (model.customer?.name ?? null) : null, model.urgencyOff === true /* F-CW-302: no middle part while the customer's switch is off */)
  const sortWords = sortNow ? s(`sort.${sortNow.word}`) : s('sort.label')
  const sortMenu = (
    <Menu
      label={
        <>
          <ArrowUpDown size={13} aria-hidden /> <span className="fw-lt-trigger">{sortWords}</span> <ChevronDown size={13} aria-hidden /> {/* cw fx5 (walk W-20) */}
        </>
      }
      triggerProps={{ className: 'nds-btn sm', 'aria-label': sortNow ? s('sort.now', { sort: sortWords }) : s('sort.label'), title: s('sort.label') }}
      items={sortChoices.map((choice) => ({
        id: `sort-${choice.word}`,
        label: s(`sort.${choice.word}`),
        checked: choice.value === (model.sort ?? ''),
        ...(choice.value === 'urgent' ? { description: s(urgentRule.key, urgentRule.params) } : {}),
        onSelect: () => actions?.onSort?.((choice.value || null) as OrderSort | null),
      }))}
    />
  )
  // ── end B-TH-057 ──

  // F-SA-212: the phone card's aside is the picture part at its phone size (the DS card's draw override).
  // cw fx5 (walk W-13): on a page of ONE customer (the Work tab) the phone card stands as its picture drew it, with the DS card's own
  // parts — the PO under the number, the chips without a label column, the customer's urgency and our priority, "Promised" beside
  // the pieces line (it wraps, never cut) and the Thread door at the card's foot. The other hosts keep their card.
  const workCard = !!model.locked?.party && !!model.preset
  const cardDoorLabel = workCard && model.active?.cardDoor && actions?.onCardThread ? model.active.cardDoor : null
  const cardFields = useMemo(
    () => {
      const urgency = (row: OrderRow) => (urgencyChipOf(row) || priorityChipOf(row) ? <CustomerUrgencyCell row={row} s={s} d={d} bare askedHref={askedHrefOf(model.prefix, row, model.doorHref) /* F-CW-302 */} /> : null)
      const base = cardFieldsOf(
        (row) => <RecordPicture source="order" recordId={row.id} number={row.number} picture={row.picture} styleCount={row.styleCount} size="phone" read={latest.current.actions?.readPictures} demo={latest.current.model.demoPictures?.[row.id]} onOpen={() => setViewer(row.id)} />,
        // F-CW-102: the customer's urgency on the card says whose it is ("Urgent (customer) 2"); nothing to say: no line.
        urgency,
      )
      if (!workCard) return base
      const where = (row: OrderRow, half: 'chips' | 'pieces') => <WhereItIsCell row={row} t={t} s={s} half={half} mark={latest.current.model.marks?.[row.id]} prefix={model.prefix} doorHref={latest.current.model.doorHref} today={model.today} />
      return {
        ...base,
        whereItIs: {
          role: 'subtitle' as const,
          draw: (row: OrderRow) => (
            <span className="fw-sheet-card-lines">
              <span className="fw-sheet-sub fw-sheet-wraps">{row.customerRef ? t('list.customerRef', { ref: row.customerRef }) : t('list.noCustomerRef')}</span>
              {where(row, 'chips')}
              {urgency(row)}
            </span>
          ),
        },
        customerUrgency: { role: 'hidden' as const },
        promised: {
          role: 'subtitle' as const,
          draw: (row: OrderRow) => (
            <span className="fw-sheet-card-promise">
              {row.promiseDate ? (
                <span>
                  {t('col.promised')} <b>{formatDate(dayInstant(row.promiseDate), { locale })}</b>
                </span>
              ) : (
                <span>{t('list.noPromise')}</span>
              )}
              {where(row, 'pieces')}
            </span>
          ),
        },
        ...(cardDoorLabel
          ? {
              newMessages: {
                role: 'subtitle' as const,
                draw: (row: OrderRow) => (
                  <span className="fw-sheet-card-door">
                    <Button size="sm" variant="quiet" onClick={() => latest.current.actions?.onCardThread?.(row)}>
                      <MessageSquare size={13} aria-hidden /> {cardDoorLabel}
                    </Button>
                  </span>
                ),
              },
            }
          : {}),
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the draws read the latest model and actions through `latest`
    [s, d, t, locale, workCard, cardDoorLabel, model.prefix, model.today, model.doorHref],
  )
  const columns = useMemo<ColDef<OrderRow>[]>(
    () => sheetColumns({ t, s, d, l, m, locale, model, wide, latest, onViewer: setViewer, statusShown, phone /* F-CP-107 (cp-fx16) */, priorityShown, whereShown /* F-CW-102 */, waitingShown /* cw fx5 (W-29) */ }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the cells read the latest model and actions through `latest`
    [t, s, d, l, m, locale, wide, model.prefix, model.today, model.can, model.margins, model.depth, model.companies, model.demoPictures, actions?.depth, model.sort /* B-TH-057 */, model.unread /* B-TH-230 */, model.kind /* F-SA-221 */, model.marks /* F-SA-275 */, model.doorHref /* F-SA-275 */, !!actions?.onAddTask /* F-SA-275 */, model.preset /* F-SA-276 */, model.bulkCan?.task /* F-SA-281 */, statusShown /* F-CP-107 (cp-fx16): Where it is redraws when Status comes or goes */, phone /* F-CP-107 (cp-fx16) */, priorityShown, whereShown /* F-CW-102 */, waitingShown /* cw fx5 (W-29) */, model.locked?.party /* F-CW-102 */, model.customer?.name /* cw fx5 (W-8) */],
  )

  // F-SA-276: the host's default view is not a narrowing; the waiting term is.
  // F-CP-102: compared with the host's default (`home`: Open orders on Sales › Orders, All orders on the customer page); the rows
  // view apart from every other narrowing, so a host's words for that one view (model.empty.view) still show.
  const home = homeOf(model)
  const viewNarrowed = model.rows !== home && model.rows !== 'all'
  // F-CW-102 (P0 item 9): a customer the HOST locks is the page's own, not a narrowing — its empty sheet says "<customer> has no
  // order yet.", never "No orders match … Clear filters".
  const othersNarrowed = model.q.trim() !== '' || !!model.waiting || (!!model.customer && !model.locked?.party) || !!model.brand || !!model.company || !!model.cf || extraChips(model.extra ?? null, t, s, d).length > 0 || (!!model.kind && !model.locked?.kind) || !!model.profile // B-TH-201, B-TH-225, B-TH-057, B-TH-244, F-SA-221, F-SA-222
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
    // F-CW-101: a phase's chip says in quiet words what it holds (the host's whys of "Not sent to the factory", else the sheet's own line).
    ...extraChips(model.extra ?? null, t, s, d /* F-CW-105 */).map((chip) => ({ id: `x-${chip.key}`, label: chip.label, onClear: () => actions?.onClearExtra?.(chip.key), ...(chip.key === 'phase' ? { note: model.phaseNote ?? chip.note ?? null } : {}) })),
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
  // F-CP-141 (money wall): a price view opened by a reader without the price grain — ONE line, no rows, the way back.
  const priceHeld = model.priceHeld ? <PriceHeldLine t={t} onAll={() => actions?.onRows?.('all')} /> : null
  const state = priceHeld ?? (model.list.problem ? (
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
        // F-CP-104: the customer page's All orders, none yet — New order in place. F-CW-102 (S9, S20): not drawn without
        // orders.manage (an act the reader has no right for is not there); the host's link beside it (the customer's drafts).
        (hostEmpty.newOrder && model.can.manage) || hostEmpty.link ? (
          <span className="fw-so-inline">
            {hostEmpty.newOrder && model.can.manage && (
              <Button size="sm" variant="primary" onClick={() => actions?.onNewOrder?.(true)}>
                {t('list.new')}
              </Button>
            )}
            {hostEmpty.link && (
              <Button size="sm" asChild>
                <Link href={hostEmpty.link.href}>{hostEmpty.link.label}</Link>
              </Button>
            )}
          </span>
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
  ) : undefined) // F-CP-141

  // ── B-TH-245 (threads plan TH-4, SHEET-G09; SHEET.brand-fields-F03, -F08): the sheet's cells that edit ──
  const cellHeld = (row: OrderRow): string | null => heldCell(row, t, s)
  const orderEdit = orderEditOf(model, s, cellHeld, (id, after, version) => actions?.onCellSaved?.(id, after, version))
  // ── end B-TH-245 ──
  const groups = useOverallGroups(model, actions, t, s, locale) // B-TH-244

  return (
    <div className="fw-so" ref={sheetRef /* cw fx5: the bar's room */}>
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

      {/* F-CW-301: the ONE notice after a shipment is made here — the draft, its orders (each a door to its thread), the way to Warehouse. */}
      {/* F-CW-302: what the last set-back, lock or unlock did (the shared outcome). */}
      {model.urgency && <UrgencyNotice model={model.urgency} actions={actions?.urgency} />}
      {model.ship?.notice && <ShipNoticeBanner notice={model.ship.notice} prefix={model.prefix} onOrder={(id) => actions?.onOpenRow?.(id, false)} onDismiss={actions?.onDismissShip} />}

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

      {priceHeld && model.layout !== 'list' ? (
        priceHeld /* F-CP-141: the board and By promise week hold it the same way */
      ) : model.layout === 'week' && model.week ? (
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
          count={items ? countWords(items.length, count, !!model.list.more, model.countOf, t, s) /* F-CW-104 */ : '—'}
          search={searchField}
          tools={
            <>
              {/* F-CP-105: "Columns: Work · Money" at the toolbar's start — the host gives it only with the price grain. */}
              {model.columnSet && <ColumnSetSwitch value={model.columnSet.value} s={s} onPick={(set) => actions?.onColumnSet?.(set)} />}
              {switcher /* B-TH-226 */}
              {/* B-TH-243 (ORD-G10): the rows views are the built-in views on top of Views ▾ — no second Rows ▾ beside it. */}
              {sortMenu /* B-TH-057; F-CW-201: Sort ▾ as a menu */}
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
          onShownColumns={(ids) => {
            setShowsStatus(ids.includes('status')) // F-CP-107 (cp-fx16)
            setShowsPriority(ids.includes('priority')) // F-CW-102
            setShowsWhere(ids.includes('whereItIs')) // F-CW-102
            setShowsWaiting(ids.includes('waitingOn')) // cw fx5 (W-29)
            actions?.onShownColumns?.(ids) // B-TH-244: Progress reads the floor only while shown
          }}
          builtInViews={{ items: builtInViewsOf(model, t, s, (value) => formatNumber(value, locale) /* F-CP-103 */, builtInActive(model) /* cw fx5: the view shown is always named */), active: builtInActive(model), onPick: (id) => pickBuiltIn(id, model, actions) /* F-SA-221, F-SA-276 */ }}
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
            actions: barActs, // F-CW-202: at most three acts with words
            trailing: barMore, // F-CW-202: More ▾ — after the frame's own Edit N and Export N, last before Clear (as the Customers list's)
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
                  // cw fx5 (walk W-13): on the customer's own page the door stands at the card's foot (the card's own line above), not in its top row.
                  cardDoor: !workCard && model.active.cardDoor && actions?.onCardThread ? { column: 'newMessages', label: model.active.cardDoor, onOpen: (row) => actions?.onCardThread?.(row) } : null,
                }
              : null
          }
        />
      )}
      {showing /* F-SA-276; F-CP-102: compared with the host's default — rows=open on the customer page says it */ && <p className="fw-so-hint">{t('list.viewing', { view: model.waiting === 'us' && model.rows === 'open' ? s('views.waitingUs') /* cw fx5 (walk W-29): the view really shown */ : t(`rows.${showing}`) })}</p>}

      {viewerRow && <PictureViewerFor row={viewerRow} model={model} actions={actions} onClose={() => setViewer(null)} /> /* B-TH-225; F-SA-212: the one viewer */}
      {model.ship && <ShipWindow model={model.ship} actions={actions?.ship} rows={(items ?? []).map(named) /* cw fx5 (W-8) */} prefix={model.prefix} /> /* F-CW-301: Warehouse's own window */}
      {model.urgency && <UrgencyWindow model={model.urgency} actions={actions?.urgency} /> /* F-CW-302: the shared urgency window + this page's code dialog */}
      {model.newOrder && <NewOrderDialog model={model.newOrder} actions={actions} />}
      {model.invoiceDrafts && <InvoiceDraftsDialog state={model.invoiceDrafts} prefix={model.prefix} t={s} onClose={() => actions?.onCloseInvoiceDrafts?.()} onRetry={actions?.onInvoiceShippedRetry} /> /* B-TH-244 */}
      {/* B-W2b-323: Set priority, Import orders. */}
      {model.depth && <SetPriorityDialog model={model.depth} actions={actions?.depth} />}
      {/* F-SA-280: production's one assign dialog and one note dialog (their results: changed / unchanged / skipped with why). */}
      {model.assign && <AssignSupervisorDialog model={model.assign} actions={actions?.supervisor} />}
      {model.note && <NoteDialog model={model.note} actions={actions?.note} />}
      {/* F-SA-282: Reply to <customer> on N… (one line per order after Send: posted, or not with why). */}
      {model.replyMany && <ReplyManyDialog model={model.replyMany} actions={actions?.replyMany} />}
      {/* F-CP-114: the ONE customer's-price window (the order page's Money tab mounts the same one, F-CP-142). */}
      {model.priceCheck && <PriceCheckDialog model={model.priceCheck} actions={actions?.priceCheck} />}
      {/* F-CP-108: the row ⋯ "Next steps" window — the order page's own dialogs on the order as read. */}
      {model.commands?.window && <OrderCommandWindow model={model.commands.window} actions={actions?.command} />}
      {/* F-CP-109: Mark N ready… · Close N… · Confirm N… — the preview, the run one order at a time, the result. */}
      {model.commands?.many && <OrderCommandManyDialog model={model.commands.many} actions={actions?.commandMany} />}
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
// F-CW-102 (lead settle S20): `always` — the host's words are for exactly what is on screen now (a door of the customer page's
// band, its views): they show whatever narrows the sheet (the host gives them only then).
export function hostEmptyOf(model: Pick<OrdersListModel, 'empty' | 'rows'>, narrowed: boolean, othersNarrowed: boolean): NonNullable<OrdersListModel['empty']> | null {
  const empty = model.empty
  if (!empty) return null
  if (empty.always) return empty
  return (empty.view ? empty.view === model.rows && !othersNarrowed : !narrowed) ? empty : null
}
// ── end F-CP-102 ──

// ── B-TH-243 (threads plan TH-4, ORD-G10; SHEET.brand-view-F01): the Orders' built-in views, on top of Views ▾ ──
/** The rows views as built-in views (the address terms each stands for), the open orders first; a customer's sheet names them so. */
// F-SA-221: + "Made-to-measure" after them (`kind=mtm` with the open orders).
/**
 * F-CW-104 (10-design §3.1): the toolbar's count in words — "14 orders"; "50 of 120 loaded" while rows wait to load; and on a host
 * that names its whole (`countOf`: every order of the customer) "2 of 14 orders" while the sheet shows fewer (a door, a view, a search).
 */
export function countWords(loaded: number, count: number | null, more: boolean, whole: number | null | undefined, t: Translate, s: Translate): string {
  if (count !== null && loaded < count) return s('loadedOf', { loaded, total: count })
  if (!more && typeof whole === 'number' && loaded < whole) return s('countOf', { shown: loaded, count: whole })
  return t(more ? 'list.countMore' : 'list.count', { count: loaded })
}

// F-SA-276: + "Waiting on us" (`waiting=us` with the open orders); a host's `views` names which it offers, in its order.
// F-CP-102: + the host's own views (model.hostViews: Drafts of <customer>, Not equal), each where `views` names its id.
// F-CP-103 (review A4): + each view's count from the host's one count read (model.viewCounts; `number` writes it in the person's
// language); on a page locked to one customer no "Orders of <customer>" line under each (the page names the customer: picture 20).
export function builtInViewsOf(model: Pick<OrdersListModel, 'customer' | 'views' | 'hostViews' | 'viewCounts' | 'locked'>, t: Translate, s: Translate, number: (value: number) => string = String, active: string | null = null): Array<{ id: string; label: string; hint?: string; count?: string }> {
  const name = model.locked?.party ? null : (model.customer?.name ?? null)
  const hint = name ? { hint: s('views.ofCustomer', { customer: name }) } : {}
  const all = [...ROW_VIEWS.map((view) => ({ id: view, label: t(`rows.${view}`), ...hint })), { id: MTM_VIEW, label: s('views.mtm') /* cw fx5 (walk W-27): the menu showed the raw key "view.mtm" */, ...hint }, { id: WAITING_US_VIEW, label: s('views.waitingUs'), ...hint }, ...(model.hostViews ?? []).map((view) => ({ id: view.id, label: view.label }))]
  const counted = (view: { id: string; label: string; hint?: string }) => {
    const count = model.viewCounts?.[view.id]
    return count === undefined ? view : { ...view, count: number(count) }
  }
  if (!model.views) return all.filter((view) => view.id !== WAITING_US_VIEW && !model.hostViews?.some((own) => own.id === view.id)).map(counted)
  // cw fx5 (walk W-11, W-17): the view the address shows is ALWAYS one of the items — a door may land on a view the host does not
  // offer (`rows=open`, `rows=deposit` on the customer's tab): the button then names it ("Open", "Waiting for deposit"), never the
  // menu's own word ("Columns"). It stands last; picking another view leaves it.
  const offered = model.views.flatMap((id) => all.filter((view) => view.id === id))
  const shown = active && !offered.some((view) => view.id === active) ? all.filter((view) => view.id === active) : []
  return [...offered, ...shown].map(counted)
}

/**
 * cw fx5 (walk W-8): a sentence that ends with a name ending in a full stop ("… for Seed Customer One S.r.l.") adds no second one.
 * An ellipsis ("…", "...") is left as it is.
 */
export const oneStop = (text: string): string => (/[^.]\.\.$/.test(text) ? text.slice(0, -1) : text)

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
// F-CW-102: + the customer's urgency as a line of the card when the column is shown (`urgency`: its own draw; nothing to say: no line).
const cardFieldsOf = (picture: (row: OrderRow) => ReactNode, urgency: (row: OrderRow) => ReactNode) => ({
  number: { role: 'title' as const },
  customer: { role: 'subtitle' as const },
  picture: { role: 'aside' as const, draw: picture },
  brand: { role: 'field' as const },
  status: { role: 'field' as const },
  promised: { role: 'field' as const },
  madeToMeasure: { role: 'field' as const }, // F-SA-221: the mark on the phone card (never a rider's name)
  whereItIs: { role: 'field' as const }, // F-SA-275: the stage and the health on the phone card
  customerUrgency: { role: 'field' as const, draw: urgency }, // F-CW-102
  ...Object.fromEntries(['deposit', 'units', 'orderDate', 'shipped', 'invoiced', 'net', 'gross', 'margin', 'priority', 'season', 'quote', 'company', /* B-TH-244 */ 'openUnits', 'progress', 'paid', 'balance', 'site', 'note', 'atRisk', /* F-SA-221 */ 'riders', /* F-SA-275 */ 'waitingOn', 'supervisor', /* F-CP-140 */ ...PRICE_CHECK_IDS].map((id) => [id, { role: 'hidden' as const }])),
})

interface ColumnsInput {
  t: Translate
  s: Translate
  d: Translate
  /** B-TH-230: the New messages column's words. */
  l?: Translate
  /** F-SA-275: the supervisor marks' words (production-supervisor). */
  m?: Translate
  locale: Locale
  model: OrdersListModel
  wide: boolean
  latest: { current: { model: OrdersListModel; actions?: OrdersListActions } }
  onViewer: (id: string) => void
  /** F-CP-107 (cp-fx16): the Status column is on screen — Where it is then never repeats the status of a row with no stage. */
  statusShown?: boolean
  /** F-CP-107 (cp-fx16): the phone card list (below 720 px) — a preset's table-wide columns show on the cards. */
  phone?: boolean
  /** F-CW-102: the Priority column is on screen (Customer urgency then leaves our level to it), and Where it is (the lateness is its chip 2). */
  priorityShown?: boolean
  whereShown?: boolean
  /** cw fx5 (walk W-29): the Waiting on column is on screen — chip 3 of Where it is then never repeats what it says. */
  waitingShown?: boolean
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
      readStyles={actions?.readStyles /* F-CP-110: every style of the order */}
      onClose={onClose}
    />
  )
}

/**
 * The sheet's columns in the picture's order. Every value that names a thing is its door (a real link: ⌘-click opens a new
 * tab); Brand, Status and Company narrow the sheet (the funnel mark); a cell the reader may not open says why on hover; the
 * rest of the row opens the order. Money columns are absent without their grain, never zero.
 */
function sheetColumns({ t, s, d, l, m, locale, model, wide, latest, onViewer, statusShown = false, phone = false, priorityShown = false, whereShown = false, waitingShown = false }: ColumnsInput): ColDef<OrderRow>[] {
  const input: ColumnsInput = { t, s, d, l, m, locale, model, wide, latest, onViewer, statusShown, phone, priorityShown, whereShown, waitingShown }
  const { prefix, can } = model
  const day = (value: string | null) => (value ? formatDate(dayInstant(value), { locale }) : '—')
  const act = () => latest.current.actions
  // cw fx5 (walk W-8): on a page of one customer, the host's own name of it (the record's), else null: each row's own name.
  const lockedNameNow = (): string | null => (latest.current.model.locked?.party ? (latest.current.model.customer?.name ?? null) : null)
  const door = (value: Door, children: ReactNode, strong?: boolean) => (
    <DoorCell door={value} t={s} strong={strong}>
      {children}
    </DoorCell>
  )

  const PictureColumn = ({ data }: ICellRendererParams<OrderRow>) => (data ? <PictureCell row={data} input={input} /> : null)
  // B-TH-230 (grid-F15): the reader's own new messages; the cell is a door to the order's thread at the first new message.
  // F-CP-110: on a page with a dock (the customer page: model.active) the cell shows the order's conversation in that dock; ⌘ / Ctrl
  // keeps the order page's thread in a new tab; Sales › Orders keeps the link.
  // F-CW-102 (S33): the cell is a count bubble (the shared cell's own words and doors); a narrow column's header is the message mark.
  const NewMessagesCell = ({ data }: ICellRendererParams<OrderRow>) =>
    data && l ? <NewMessagesBubble unread={latest.current.model.unread?.[data.id]} href={`${orderHref(prefix, data)}?thread=new`} record={data.number} onOpen={latest.current.model.active ? () => latest.current.actions?.onOpenRow?.(data.id, false) : null} l={l} /> : null
  const narrowMessages = (model.preset?.max?.newMessages ?? Number.POSITIVE_INFINITY) <= 64
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
            <span className="fw-sheet-sub fw-sheet-wraps">{data.customerRef ? t('list.customerRef', { ref: data.customerRef }) : t('list.noCustomerRef')}</span>
            <MtmMark row={data} s={s} onNarrow={latest.current.model.kind ? undefined : () => act()?.onKind?.('mtm')} />
          </span>
        ) : (
          // cw fx5 (walk W-14): the PO line wraps inside the cell (two lines at the most), never cut ("Senza ordine del clie…").
          <span className="fw-sheet-sub fw-sheet-wraps">{data.customerRef ? t('list.customerRef', { ref: data.customerRef }) : t('list.noCustomerRef')}</span>
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
    // cw fx5 (walk W-12, W-7, W-33; the API's B-CW-012): an EXTRA deposit still open on an order whose own deposit is not open — the
    // PILL says so ("Extra deposit open", the row's chip 3's own words; danger once its day passed) with its day as the open
    // deposit's own line ("due 23/11/2026"). It read "Not needed" over a cut second line.
    const extra = depositExtraOf(data.deposit, model.today)
    if (extra)
      return (
        <span className="fw-sheet-cell fw-sheet-wraps">
          {door(depositDoor(prefix, data, can), <Pill tone={extra.overdue ? 'danger' : 'warning'} className="fw-sheet-dep-extra">{s('stop.depositExtra')}</Pill>)}
          <span className={extra.overdue ? 'fw-sheet-late' : 'fw-sheet-sub'} title={state === 'PAID' ? t('moneyTab.totals.fact.paidExtraWords') : t('moneyTab.totals.fact.notNeededExtraWords', { date: day(extra.due) })}>
            {t(extra.overdue ? 'list.depositOverdue' : 'list.depositDue', { date: day(extra.due) })}
          </span>
        </span>
      )
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
        <span className="fw-sheet-sub fw-sheet-wraps">{data.requestedDate ? t('list.requested', { date: day(data.requestedDate) }) : t('list.noRequested') /* cw fx5 (W-7): wraps, never cut */}</span>
      </span>
    ) : null
  // F-CW-102: the lateness is chip 2 of Where it is ("Late · 3 d") — the tag beside the date only while that column is not on
  // screen (the same fact never twice in one row; Sales › Orders' own default view keeps the tag).
  const PromiseCell = ({ data }: ICellRendererParams<OrderRow>) =>
    data ? (
      data.promiseDate ? (
        <span className="fw-so-inline">
          {door(linesDoor(prefix, data, true), day(data.promiseDate))}
          {!whereShown && data.daysLate !== null && data.daysLate > 0 && <Tag tone="danger">{t('list.daysLate', { count: data.daysLate })}</Tag>}
        </span>
      ) : (
        // cw fx5 (walk W-14): "No promise" / "Nessuna data promessa" wraps inside the cell (quieter, two lines), never cut.
        <span className="fw-sheet-wraps is-quiet">{door(linesDoor(prefix, data, true), t('list.noPromise'))}</span>
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
  // ---- F-CP-108 (customer page plan C2b, D8, K2): the row ⋯ "Next steps" — the order page's own commands by the row's state (A14's map:
  // Confirm or refuse… · Make work orders · Mark ready… · Close order…; Cancel order… last, in the danger tone), each held with its words
  // from the row's facts; never a system move, no free status. A pick opens the ONE window on this page (the order read, its own dialog).
  const heldWords = (words: Words): string => wordsText(words.params?.date ? { ...words, params: { ...words.params, date: day(String(words.params.date)) } } : words, t, s, locale)
  const STEP_LABEL: Record<Exclude<RowStep['command'], 'make'>, () => string> = { confirm: () => s('commands.confirmOrRefuse'), ready: () => t('action.ready'), close: () => t('step.close'), cancel: () => t('action.cancel') }
  const stepItem = (step: RowStep, row: OrderRow): MenuItemDef => {
    const held = step.held ? heldWords(step.held) : null
    // Make work orders: today's door (Production's New work order with this order chosen), held with its words.
    if (step.command === 'make') return { id: 'make', label: t('step.makeWorkOrders'), ...(held ? { disabled: true, description: held } : { href: `${prefix}/production/work-orders?new=1&order=${encodeURIComponent(row.number)}` }) }
    const command = step.command
    return { id: command, label: STEP_LABEL[command](), ...(command === 'cancel' ? { tone: 'danger' as const } : {}), ...(held ? { disabled: true, description: held } : { onSelect: () => act()?.onCommand?.(row.id, command) }) }
  }
  // ---- end F-CP-108
  // ---- F-CW-204 (customer Work tab plan §5; 10-design §5; lead settle S9): the row ⋯ on every host of the sheet —
  //   Open · Open in a new tab ‖ Next steps ‖ Set priority… ‖ Go to: Production › · Shipments › · Files › · Money › ‖ Set customer's
  //   price… · Print confirmation · Add task… · Answer request… ‖ Cancel order…
  // An act the reader has no right for is NOT drawn (the steps by rowStepsOf; Set priority… with orders.manage; Add task… with the
  // tasks' right; Set customer's price… with the price grain); a state holds with words (the deposit; a closed order's priority).
  // The doors are real links (⌘-click opens a new tab); every reader of the order reads each of its tabs.
  const priorityItem = (row: OrderRow): MenuItemDef[] => {
    if (!can.manage || !model.depth) return []
    const held = depthEditHeld(row.status, { manage: true })
    return [{ id: 'priority', label: d('action.priority'), ...(held ? { disabled: true, description: d(held.key, held.params) } : { onSelect: () => act()?.depth?.onSetPriority?.([row.id]) }) }]
  }
  const goToItems = (row: OrderRow): MenuItemDef[] => [
    { id: 'head-go', heading: true, label: t('menu.group.goTo') },
    ...(['production', 'shipments', 'files'] as const).map((tab) => ({ id: `go-${tab}`, label: `${t(`tab.${tab}`)} ›`, href: orderHref(prefix, row, tab) })),
    { id: 'deposit', label: `${t('tab.money')} ›`, href: orderHref(prefix, row, 'money') },
  ]
  const MoreCell = ({ data }: ICellRendererParams<OrderRow>) => {
    if (!data) return null
    // F-CP-108: the host gives the door (both hosts of the ONE sheet); without it, today's items.
    const steps = act()?.onCommand ? rowStepsOf(data, can, !!latest.current.model.commands?.decide /* cw fx5 (W-21): a decision needs its right */) : []
    // F-CW-301 (10-design §5): Create shipment… among the Next steps, before Close order… — only with shipping.manage, only in a
    // state where garments can wait to ship; held with the order page's own words when the row knows nothing is ready now.
    const shipStep: MenuItemDef[] =
      can.createShipment && act()?.onCreateShipment && shipRowOffered(data)
        ? [{ id: 'ship', label: t('step.createShipment'), ...(shipRowHeld(data) ? { disabled: true, description: t('ship.create.held.nothing') } : { onSelect: () => act()?.onCreateShipment?.(data.id) }) }]
        : []
    const before = steps.filter((step) => step.command !== 'cancel' && step.command !== 'close').map((step) => stepItem(step, data))
    const closing = steps.filter((step) => step.command === 'close').map((step) => stepItem(step, data))
    const next = [...before, ...shipStep, ...closing]
    const cancel = steps.find((step) => step.command === 'cancel')
    // F-CW-302 (10-design §5; S7): Customer urgency — Set to regular… · Lock… · Unlock… (the Customer card's own words and window),
    // only with production.brand.override; "Answer request…" for an order whose "Urgent – asked" waits on us (its own request).
    const askedHref = askedHrefOf(prefix, data, latest.current.model.doorHref)
    const urgencyActs = latest.current.model.urgency?.can && act()?.onUrgency ? rowUrgencyActs(data) : []
    const urgencyItems: MenuItemDef[] =
      urgencyActs.length > 0
        ? [
            { id: 'head-urgency', heading: true, label: s('col.customerUrgency') },
            ...urgencyActs.map((kind) => ({ id: `urgency-${kind}`, label: pw(`customerCard.urgency.act.${kind}`), ...(latest.current.model.urgencyOff ? { disabled: true, description: oneStop(s('urgency.held.off', { customer: lockedNameNow() ?? data.partyName })) } : { onSelect: () => act()?.onUrgency?.(kind, [data.id]) }) })),
            ...(askedHref ? [{ id: 'urgency-answer', label: s('row.answer'), href: askedHref }] : []),
          ]
        : []
    const priority = priorityItem(data)
    const rest: MenuItemDef[] = [
      // F-CP-114: Set customer's price… — the ONE window, here (a price holder only: the host gives the door with the price grain).
      ...(can.price && act()?.onPriceCheck ? [{ id: 'priceCheck', label: t('priceCheck.edit'), onSelect: () => act()?.onPriceCheck?.(data.id) }] : []),
      // F-CP-108: Make work orders is a Next step now (held with its words); a host without the door keeps today's item.
      ...(steps.length === 0 && data.status === 'CONFIRMED' && can.makeWorkOrders ? [{ id: 'make', label: t('step.makeWorkOrders'), href: `${prefix}/production/work-orders?new=1&order=${encodeURIComponent(data.number)}` }] : []),
      // B-W2b-323: Print confirmation (the confirmation PDF in a new tab; held while it waits for a yes or was cancelled).
      ...(model.depth ? [printVerb(data, prefix, d)] : []),
      // ---- F-SA-275: Add task… on this order (the one New task window, F-SA-281) and Answer request… while one waits on us.
      // F-CW-204 (S9): not drawn without the tasks' right (it was drawn greyed with the right's words).
      ...(act()?.onAddTask && !latest.current.model.bulkCan?.task ? [{ id: 'task', label: s('row.addTask'), onSelect: () => act()?.onAddTask?.([data.id], 'row') }] : []),
      ...answerItem(data).filter((item) => !(urgencyItems.length > 0 && item.href === askedHref)), // F-CW-302: said once (the urgency group holds it)
      // ---- end F-SA-275
    ]
    return (
      <Menu
        label={<MoreHorizontal size={16} aria-hidden />}
        align="right"
        triggerProps={{ 'aria-label': t('list.rowMenu', { number: data.number }) }}
        items={[
          { id: 'open', label: t('list.open'), href: orderHref(prefix, data) },
          { id: 'tab', label: t('list.openNewTab'), href: orderHref(prefix, data), target: '_blank' },
          // F-CP-108: Next steps (the order page's own heading), after a rule.
          ...(next.length > 0 ? [{ id: 'sep-next', separator: true }, { id: 'head-next', heading: true, label: t('menu.group.next') }, ...next] : []),
          ...(urgencyItems.length > 0 ? [{ id: 'sep-urgency', separator: true }, ...urgencyItems] : []), // F-CW-302
          ...(priority.length > 0 ? [{ id: 'sep-priority', separator: true }, ...priority] : []),
          { id: 'sep-go', separator: true },
          ...goToItems(data),
          ...(rest.length > 0 ? [{ id: 'sep-rest', separator: true }, ...rest] : []),
          // F-CP-108: Cancel order… last, after a rule (each cancel shows what it stops: one order at a time).
          ...(cancel ? [{ id: 'sep-danger', separator: true }, stepItem(cancel, data)] : []),
        ]}
      />
    )
  }
  // ---- end F-CW-204
  // ---- F-SA-275: the production columns (opt-in on Sales › Orders, shown by the customer page's views; their reads only while shown) ----
  const now = Date.now()
  const pw = productionWordsFor(locale)
  const answerItem = (row: OrderRow) => {
    const request = waitingItemsOf(row, latest.current.model.marks?.[row.id]).find((item) => item.kind === 'request')
    return request && request.kind === 'request' ? [{ id: 'answer', label: s('row.answer'), href: answerHrefOf(prefix, row, request, latest.current.model.doorHref) }] : []
  }
  // F-MS-104: the rule moved to the sheet's model (whereTextOf): "Sewing (by hand) · At risk" while a stage set by hand stands.
  const whereText = (row: OrderRow): string =>
    whereTextOf(row, { status: (status) => t(`status.${status}`), stage: (stage) => pw(`parts.stage.${stage}`), health: (chip) => pw(`parts.health.${chip}`), byHand: (stage) => t('list.byHand.phone', { stage }) })
  // F-CW-102: the chips cell — the host's marks and review door (chip 3), today (a deposit overdue), a dense cell beside the dock.
  const WhereCell = ({ data }: ICellRendererParams<OrderRow>) =>
    data ? <WhereItIsCell row={data} t={t} s={s} statusShown={statusShown /* F-CP-107 (cp-fx16) */} waitingShown={waitingShown && !phone /* cw fx5 (W-29) */} mark={latest.current.model.marks?.[data.id]} prefix={prefix} doorHref={latest.current.model.doorHref} today={model.today} now={now} dense={!!model.preset?.dense} /> : null
  const WaitingCell = ({ data }: ICellRendererParams<OrderRow>) => (data ? <WaitingOnCell row={lockedNameNow() ? { ...data, partyName: lockedNameNow()! } : data /* cw fx5 (W-8) */} mark={latest.current.model.marks?.[data.id]} prefix={prefix} doorHref={latest.current.model.doorHref} s={s} now={now} /> : null)
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
  // F-CW-102 (S6, S7): the customer's urgency as its chip says it, READ ONLY (no funnel: the address term and saved views still
  // narrow by it); our own Priority beside it when it is not Normal and its own column is not on screen.
  const UrgencyCell = ({ data }: ICellRendererParams<OrderRow>) => (data ? <CustomerUrgencyCell row={data} s={s} d={d} bare={phone} priorityShown={priorityShown} askedHref={askedHrefOf(prefix, data, latest.current.model.doorHref) /* F-CW-302 (S7): "Urgent – asked" is a door */} /> : null)
  const urgencyText = (row: OrderRow): string => {
    const chip = urgencyChipOf(row)
    const level = priorityChipOf(row)
    const customer = !chip ? null : chip.state === 'URGENT' ? (chip.rank !== null ? s('urgency.bareRank', { rank: chip.rank }) : s('urgency.bare')) : s(`urgency.${chip.state}`)
    return [customer, level ? s('urgency.priority', { level: d(`priority.level.${level}`) }) : null].filter(Boolean).join(' · ')
  }
  // ── F-CP-140 (customer page plan C2d; design 11-money §3.1; review F6, G1): the price check — the ONE spec's four columns, opt-in in
  // Customise under "Price check" (none shown by default until the Owner's sheet), each the export's own id; only with the price
  // grain (priceCheckColumnsFor: none without it — no column, no Customise entry, no chip, no export column). Our price = the Net. ──
  // F-CP-114: the Customer's price cell is the window's door for a price holder (a click, or o on the focused cell).
  const BrandPriceColumn = ({ data }: ICellRendererParams<OrderRow>) => {
    if (!data || data.brandPrice === undefined) return null
    const amount = money(data.brandPrice, data.currency, locale)
    const open = act()?.onPriceCheck
    if (!open) return <span>{amount}</span>
    const label = t('priceCheck.door', { number: data.number })
    return (
      <button type="button" className="fw-pc-door" data-door="" title={label} aria-label={`${label}: ${amount}`} onClick={() => open(data.id)}>
        {amount}
      </button>
    )
  }
  const PriceMatchColumn = ({ data }: ICellRendererParams<OrderRow>) => {
    if (!data) return null
    const match = data.priceMatch
    const narrow = act()?.onPriceMatch
    return <PriceMatchCell row={data} t={t} onNarrow={narrow && match ? () => narrow(match) : undefined} />
  }
  const PriceDiffColumn = ({ data }: ICellRendererParams<OrderRow>) => (data ? <PriceDiffCell row={data} t={t} locale={locale} /> : null)
  const priceCells: Record<PriceCheckId, (params: ICellRendererParams<OrderRow>) => ReactNode> = { ourPrice: NetCell, brandPrice: BrandPriceColumn, priceMatch: PriceMatchColumn, priceDiff: PriceDiffColumn }
  const priceColumns: ColDef<OrderRow>[] = priceCheckColDefs(can, s, priceCells, (id, row) => priceCheckText(id, row, t, locale)).map(later)
  // ── end F-CP-140 ──
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
    later({ colId: 'customerUrgency', headerName: s('col.customerUrgency'), headerTooltip: s('col.customerUrgencyHint'), minWidth: 120, flex: 0.8, cellRenderer: UrgencyCell, valueGetter: ({ data }: { data?: OrderRow }) => (data ? urgencyText(data) : '') }),
    // F-SA-221: made to measure and its riders (the riders only for a reader of measurements: the API names them to no one else) —
    // opt-in, shown at once when the sheet shows made-to-measure orders only (the built-in view, the Made-to-measure page).
    { ...later({ colId: 'madeToMeasure', headerName: s('mtm.mark'), minWidth: 150, flex: 0.9, valueGetter: ({ data }: { data?: OrderRow }) => (data ? mtmText(data, s) : '') }), hide: !model.kind },
    ...(can.measurements ? [{ ...later({ colId: 'riders', headerName: s('col.riders'), minWidth: 140, flex: 1, valueGetter: ({ data }: { data?: OrderRow }) => (data ? ridersText(data) : '') }), hide: !model.kind }] : []),
    ...priceColumns, // F-CP-140
  ]
  // ── end B-TH-244 ──
  const columns = serverSorted(model.sort ?? null, [
    { colId: 'picture', headerName: s('col.picture'), minWidth: 76, maxWidth: 76, sortable: false, suppressHeaderMenuButton: true, cellRenderer: PictureColumn },
    { colId: 'number', headerName: t('col.number'), field: 'number', minWidth: 128, flex: 1, cellRenderer: NumberCell, context: also('customerRef', s('col.customerRef')) },
    // F-CW-102 (A1-B8): on a page the host locks to ONE customer the page names it — no Customer column, no card subtitle, no entry in Customise.
    ...(model.locked?.party ? [] : [{ colId: 'customer', headerName: t('col.customer'), field: 'partyName', minWidth: 112, flex: 1.2, cellRenderer: CustomerCell }]),
    { colId: 'brand', headerName: s('col.brand'), headerTooltip: s('col.brandHint'), minWidth: 100, flex: 1, sortable: false, cellRenderer: BrandCell },
    { colId: 'status', headerName: t('col.status'), field: 'status', minWidth: 112, flex: 0.9, cellRenderer: StatusCell },
    // F-SA-275: Where it is — the plain stage + health, this order's own pieces (reads `production` and `progress` while shown).
    later({ colId: 'whereItIs', headerName: s('col.whereItIs'), headerTooltip: s('col.whereItIsHint'), minWidth: 150, flex: 1, cellRenderer: WhereCell, valueGetter: ({ data }: { data?: OrderRow }) => (data ? whereText(data) : '') }),
    // B-TH-230: only for a reader of threads (the API counts only what the reader may open).
    ...(model.unread && l ? [{ colId: 'newMessages', headerName: l('column'), headerTooltip: l('columnHint'), minWidth: 136, flex: 0.8, sortable: false, valueGetter: ({ data }: { data?: OrderRow }) => unreadValue(data ? latest.current.model.unread?.[data.id] : undefined), cellRenderer: NewMessagesCell, ...(narrowMessages ? { headerComponentParams: { innerHeaderComponent: MessagesHeader }, suppressHeaderMenuButton: true, cellClass: 'fw-sheet-tight', headerClass: 'fw-sheet-tight' } : {}) /* F-CW-102 (S33) */ } as ColDef<OrderRow>] : []),
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
    // cw fx5 (walk W-16): the ⋯ column fits its button whole (it was cut by 8 px in a 64 px column with the grid's padding) and draws
    // no header word — "More" stays the column's name (a screen reader, Customise). On every host of the sheet.
    { colId: 'more', headerName: t('col.more'), minWidth: 48, maxWidth: 48, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellClass: 'fw-sheet-more', headerClass: 'fw-sheet-more', cellRenderer: MoreCell },
  ] as ColDef<OrderRow>[])
    // F-SA-276; F-CP-107 (cp-fx16): + the phone card; F-CW-103: + what Customise says of a column that waits for a wider sheet
    .map((column) => withPreset(column, model.preset ?? null, wide, (name, room) => s(`customise.${room}`, { column: name })))
    .map((column) => withMovedMark(column, () => latest.current.model.commands?.moved ?? [])) // F-CP-108
  // F-OP-315 (order page walk #24): Sales › Orders itself fits its screen (a host's preset and the phone card keep their own rules).
  // F-CW-102: a host's set in the host's own order.
  return model.preset ? orderedByPreset(columns, model.preset) : phone ? columns : fitToScreen(columns, wide)
}

/** F-CW-102: the host's own order of its set, left to right; the sheet's other columns follow in their own order; ⋯ stays last. */
export function orderedByPreset(columns: readonly ColDef<OrderRow>[], preset: OrdersListModel['preset'] | null): ColDef<OrderRow>[] {
  const order = preset?.order
  if (!order || order.length === 0) return [...columns]
  const place = (column: ColDef<OrderRow>): number => {
    const at = order.indexOf(column.colId ?? '')
    return at < 0 ? order.length : at
  }
  const body = columns.filter((column) => column.colId !== 'more')
  const sorted = body.map((column, index) => ({ column, index })).sort((a, b) => place(a.column) - place(b.column) || a.index - b.index)
  return [...sorted.map((entry) => entry.column), ...columns.filter((column) => column.colId === 'more')]
}

// ---- F-OP-315 (order page walk #24, follow-up 10): Sales › Orders reads at 1440 and 1920 ----------------------------------------------
/**
 * The grid's width on the narrowest screen of each class (the rail and the page's padding taken off; measured by cp-fx16): 1312 px at
 * 1440 for the table below 1800 px, 1672 at 1800 for the wide one (1792 at 1920: flex fills the rest, no dead space). The select column
 * takes 43 px of it.
 */
export const LIST_WIDTH = { narrow: 1312, wide: 1672 } as const
export const SELECT_WIDTH = 43
/**
 * What a column of Sales › Orders needs to show its words whole, in Italian and English: its header beside its menu ("Pieces", "Nuovi
 * messaggi", "Fatturato"), the longest status of the open view and "Waiting for a yes", "Not needed" / "Non chiesto", a seed number
 * (SEED-SO-W39-01) and name. Applied over the sheet's own minimums, so a host's preset (the customer's Work tab) keeps those.
 */
export const LIST_MIN: Readonly<Record<string, number>> = { number: 144, customer: 160, brand: 128, status: 152, newMessages: 152, deposit: 112, units: 96, promised: 112, shipped: 104, invoiced: 116, company: 104, orderDate: 110, quote: 128 }
/**
 * The columns that wait for a wider screen, the first first, while the row is wider than the screen (each stays in Customise; a
 * person's Customise wins). Picture, Number, Customer, Brand, Status, Deposit, Pieces, Promised, Shipped and Net never wait; Invoiced
 * (TH-1a's own column) waits last. At 1440 the walk saw every column squeezed to its minimum, so most words were cut. So at 1440
 * Company and New messages wait (and, for a price holder, Invoiced); at 1920 the wide ones join as far as they fit (Margin %, then
 * Ordered, then Priority), From quote and Season first wait.
 */
export const WAIT_FIRST = ['quote', 'season', 'company', 'priority', 'orderDate', 'margin', 'newMessages', 'invoiced'] as const

/** The sum of the shown columns' minimums with the select column: what the row needs. */
// cw fx5 (walk W-16): the ⋯ column is counted at what it took before — the 16 px it gave back go to the row's words (flex), never to
// one more column (Sales › Orders keeps its own ten columns).
export const rowWidthOf = (columns: readonly ColDef<OrderRow>[]): number =>
  SELECT_WIDTH + columns.filter((column) => !column.hide).reduce((sum, column) => sum + (column.colId === 'more' ? Math.max(column.minWidth ?? 0, MORE_WAS) : (column.minWidth ?? 0)), 0)

/** Sales › Orders on its screen: each column at what its words need, then WAIT_FIRST hidden in turn until the row fits. */
export function fitToScreen(columns: readonly ColDef<OrderRow>[], wide: boolean): ColDef<OrderRow>[] {
  let out = columns.map((column) => {
    const need = LIST_MIN[column.colId ?? '']
    return need && need > (column.minWidth ?? 0) ? { ...column, minWidth: need } : column
  })
  for (const id of WAIT_FIRST) {
    if (rowWidthOf(out) <= LIST_WIDTH[wide ? 'wide' : 'narrow']) break
    out = out.map((column) => (column.colId === id && !column.hide ? { ...column, hide: true } : column))
  }
  return out
}
// ---- end F-OP-315

/** F-CP-109: the bar's bulk commands' marks (lucide, as the bar's other buttons). */
const MANY_ICON: Readonly<Record<ManyCommand, typeof PackageCheck>> = { ready: PackageCheck, close: Archive, confirm: CheckCheck }

/** F-CW-202: each act's mark — the same on its button and in More ▾ (never told apart by colour). */
function BarIcon({ id }: { id: BarActId }) {
  const Icon = id === 'urgencyRegular' ? Undo2 : id === 'urgencyUnlock' ? Unlock : id === 'ship' ? Truck : id === 'ask' ? MessageCircleQuestion : id === 'priority' ? Flag : id === 'reply' ? Globe : id === 'assign' ? UserCog : id === 'task' ? ListPlus : id === 'note' ? MessageSquareLock : id === 'invoice' ? Receipt : MANY_ICON[id]
  return <Icon size={13} aria-hidden />
}

/** F-CP-108: a row a command moved out of the view stays where it is, every cell greyed, until "N updates · Show" (rows never jump). */
export function withMovedMark(column: ColDef<OrderRow>, moved: () => readonly string[]): ColDef<OrderRow> {
  return { ...column, cellClassRules: { ...(column.cellClassRules ?? {}), 'fw-cmd-left': (params: { data?: OrderRow }) => !!params.data && moved().includes(params.data.id) } }
}

/** F-CP-107 (cp-fx16): the Status column at first — a host's preset shows it only when it names it; without a preset it shows. */
export const statusShownOf = (preset: OrdersListModel['preset'] | null): boolean => !preset || preset.shown.includes('status')

/** F-SA-276: the host's first columns (its view's preset; from 1800 px its wide ones too); ⋯ always; a person's Customise wins. */
// F-CW-103 (lead settle S12; review A1-B1): Customise tells the truth for a host's set. The list frame reads a column's place in
// Customise from its `context.optIn` alone (list-frame/tools/model: no change there), and a preset hid built-in columns and showed
// opt-in ones behind its back — the dialog listed the Orders page's columns: Where it is unticked while on screen, Customer ticked
// while never shown. So the preset now says each column's truth: on screen → ticked; of the host's set but waiting for a wider
// sheet (`later`) → ticked and named so (`label`: "Waiting on · from a wider sheet"), shown when the room allows, never cut to fit;
// any other column → offered unticked (opt-in: it shows when the person ticks it). Only a host that gives a preset is touched.
export function withPreset(column: ColDef<OrderRow>, preset: OrdersListModel['preset'] | null, wide: boolean, label?: (column: string, room: 'wider' | 'widest') => string): ColDef<OrderRow> {
  if (!preset || column.colId === 'more') return column
  const id = column.colId ?? ''
  // F-CP-107 (cp-fx16): the host's own min width. F-CW-304: the table-wide set no host gives any more (the rooms decide: `later`) is gone.
  const first = preset.shown.includes(id)
  const min = preset.min?.[id]
  const max = preset.max?.[id] // F-CW-102: a column of the host's set at its own fixed width (the rest goes to Where it is)
  const shown = first || (wide && !!preset.wide?.includes(id))
  const waits = shown ? null : (preset.later?.[id] ?? null)
  const name = typeof column.headerName === 'string' ? column.headerName : ''
  const context = { ...((column.context as object | undefined) ?? {}), optIn: !shown && !waits, ...(waits && label && name ? { toolLabel: label(name, waits) } : {}) }
  // cw fx5 (walk W-5, W-6): the host's own cell padding for a column (`pad`), a header without its menu button (`plainHeads`: the
  // narrow fixed columns — the menu stays on the header's right click and in Customise) and headers that may stand on two lines.
  const pad = preset.pad?.[id]
  const padClass = pad ? `fw-sheet-${pad}` : null
  const wrapClass = preset.wrapHeads ? 'fw-sheet-hwrap' : null
  const looks: ColDef<OrderRow> = {
    ...(padClass ? { cellClass: joined(column.cellClass, padClass) } : {}),
    ...(padClass || wrapClass ? { headerClass: joined(column.headerClass, padClass, wrapClass) } : {}),
    ...(preset.wrapHeads ? { wrapHeaderText: true } : {}),
    ...(preset.plainHeads?.includes(id) ? { suppressHeaderMenuButton: true } : {}),
  }
  return { ...column, hide: !shown, context, ...(min ? { minWidth: min } : {}), ...(max ? { maxWidth: max } : {}), ...looks }
}

/** A column's class beside the ones it has (the sheet's columns state theirs as one string). */
function joined(own: unknown, ...more: Array<string | null>): string {
  return [typeof own === 'string' ? own : null, ...more].filter((name): name is string => !!name).join(' ')
}

/** cw fx5 (walk W-23): below this room the search field says its short words ("Search orders"). */
export const SEARCH_SHORT_BELOW = 480

/** cw fx5 (walk W-16): what the ⋯ column took before (64; now 48: a 44 px button with 2 px each side). Sales › Orders' fit rule keeps counting it at this, so the same columns wait there as before. */
const MORE_WAS = 64

/**
 * cw fx5 (walk W-12): an EXTRA deposit still open on an order whose own deposit is not open (not needed, paid, waived) — its day
 * and whether it passed; null: none (an OPEN deposit shows its own pill and day).
 */
export function depositExtraOf(deposit: Pick<OrderRow['deposit'], 'state' | 'extraOpenDue'>, today: string): { readonly due: string; readonly overdue: boolean } | null {
  const due = deposit.state === 'OPEN' ? null : (deposit.extraOpenDue ?? null)
  return due ? { due, overdue: due < today } : null
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
// F-CW-105 (S40): + our priority level's chip — "Priority: Top" in the level's own words (`d`: the depth catalogue's
// `priority.level.*`, which the sheet always hands; without it the level's code).
export function extraChips(extra: ExtraTerms | null, t: Translate, s: Translate, d?: Translate): Array<{ key: keyof ExtraTerms; label: string; note?: string }> {
  if (!extra) return []
  const out: Array<{ key: keyof ExtraTerms; label: string; note?: string }> = []
  if (extra.status) out.push({ key: 'status', label: s('chips.status', { status: t(`status.${extra.status}`) }) })
  if (extra.late) out.push({ key: 'late', label: s('chips.late') })
  if (extra.deposit) out.push({ key: 'deposit', label: s('chips.deposit') })
  if (extra.reaccept) out.push({ key: 'reaccept', label: s('chips.reaccept') })
  if (extra.shippedNotInvoiced) out.push({ key: 'shippedNotInvoiced', label: s('chips.uninvoiced') })
  if (extra.invoiced) out.push({ key: 'invoiced', label: s('chips.invoiced', { state: s(`invoiced.${extra.invoiced}`) }) })
  if (extra.atRisk) out.push({ key: 'atRisk', label: s('chips.atRisk') })
  if (extra.currency) out.push({ key: 'currency', label: s('chips.currency', { currency: extra.currency }) })
  if (extra.customerUrgency) out.push({ key: 'customerUrgency', label: s('chips.urgency', { urgency: s(`urgency.${extra.customerUrgency}`) }) })
  if (extra.priceMatch) out.push({ key: 'priceMatch', label: t(`priceCheck.chip.${extra.priceMatch}`) }) // F-CP-141 (a price holder's only: the sheet drops it otherwise)
  // F-CW-101: a phase's door — the group's own words (one word for one thing: phasePhrase); "Production not started" says what it holds.
  if (extra.phase) {
    const words = phasePhrase(extra.phase)
    out.push({ key: 'phase', label: words.orders ? t(words.key) : s(words.key), ...(extra.phase === 'NOT_STARTED' ? { note: s('phase.note.NOT_STARTED') } : {}) })
  }
  if (extra.priority) out.push({ key: 'priority', label: s('urgency.priority', { level: d ? d(`priority.level.${extra.priority}`) : extra.priority }) }) // F-CW-105
  return out
}

/**
 * F-CP-105 (customer page plan C2d; 10 §5): "Columns: Work · Money" — a DS SegmentedControl sm with its visible label; it swaps the
 * view's columns for the money columns (the host's preset; a person's own Customise wins). Drawn only when the host gives it (the
 * price grain): never a dead control for anyone else.
 */
export function ColumnSetSwitch({ value, s, onPick }: { value: 'work' | 'money'; s: Translate; onPick: (set: 'work' | 'money') => void }) {
  return (
    <span className="fw-pc-cols">
      <span className="fw-pc-cols-label" aria-hidden="true">
        {s('cols.label')}
      </span>
      <SegmentedControl
        size="sm"
        ariaLabel={s('cols.label')}
        value={value}
        onChange={(next) => onPick(next === 'money' ? 'money' : 'work')}
        options={(['work', 'money'] as const).map((set) => ({ value: set, label: s(`cols.${set}`) }))}
      />
    </span>
  )
}

/** F-CP-141 (money wall; 10 §5): the one line a price view says to a reader without the price grain, with the way back to every order. */
export function PriceHeldLine({ t, onAll }: { t: Translate; onAll: () => void }) {
  return (
    <EmptyState
      title={t('held.noPrice')}
      action={
        <Button size="sm" onClick={onAll}>
          {t('priceCheck.showAll')}
        </Button>
      }
    />
  )
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
    // F-CW-202 (S9): Edit N is drawn only for a person who may change orders (an act without its right is not in the bar); the
    // cells themselves stay readable, held in words.
    ...(model.can.manage ? { bulk: { noun: { one: s('cells.nounOne'), other: s('cells.nounOther') } } } : {}),
    held: model.can.manage ? null : s('cells.noManage'),
  }
}
// ── end B-TH-245 ──
