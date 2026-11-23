'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Building2, Eye } from 'lucide-react' // F-OP-203: the segments' icons
import { Button, Skeleton } from '@nexus/ui/primitives'
import { useToast } from '@nexus/ui/components' // F-CP-113: the made order announced
import { useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { WithMessages } from '../../../../../record-panels/i18n'
import { CustomerOverrideProvider } from '../../../../_shared/customer-override/CustomerOverride'
import { OfficeRecordThread } from '../../../../_shared/record-thread/OfficeRecordThread'
import { ThreadPick, type ThreadChoice } from '../../../../_shared/record-thread/ThreadPick'
import { RecordTypeIcon } from '../../../../search/RecordTypeIcon' // F-OP-203: the picked record's icon in its segment
import { useRequestReviewDoor } from '../../../../home/approvals/requests/use-request-review-door'
import { RequestDoorNoticeBanner, RequestDoorWindow } from '../../../../home/approvals/requests/view/RequestReview'
import type { OrderRow } from '../../../orders/api'
import type { OrderPhase } from '../../../orders/api' // F-CW-102: a door's own empty words
import type { ExtraTerms, RowView } from '../../../orders/model'
import { ORDERS_LIST_KEY, sheetAddress, useOrdersSheet, type OrdersSheetHost } from '../../../orders/list/use-orders-sheet'
import { OrdersListView, WAITING_US_VIEW } from '../../../orders/list/view/OrdersListView'
import type { OrdersListModel } from '../../../orders/list/list-model'
import { WORK_DEFAULT_ROWS, workEntry, type useCustomerWork, type WorkCan } from '../use-customer-work'
import { workViewCounts } from '../use-customer-work' // F-CP-103: the Views ▾ counts from the strip's one count read
import { requestsDoorOf, reviewNamed } from '../use-customer-work' // cw fx5 (W-1): the door of "Requests to answer N"; cw fx6: its window names the customer as the page does
import type { WorkAsk } from '../use-customer-work' // F-CP-104: the band's New order / ⋯ Import orders, served in place
import { priceDifferOf } from '../use-customer-work' // F-CP-141: the Not equal view's count (the customer's own counts)
// ---- F-CP-113: the New order page's own lines editor, in a large window on this page ----
import type { NewOrderHeader } from '../../../orders/new/new-model'
import { NewOrderEditor } from '../../../orders/new/NewOrderEditor'
// ---- F-CQ-303 (customer page › Quotes & incoming, 13-backend R14): the customer's portal drafts left the Work tab — they are "Customer
// is writing" on Quotes & incoming (the same list and window, mounted there); the line's drafts part and the empty line's way to them
// open that tab at WRITING.
import { quotesGroupDoor } from '../before-order'
// ---- end F-CQ-303
import type { DockLink } from '../quotes-tab/links' // F-CQ-305: the dock's door line
// ---- F-SA-279: the dock follows the row; All of <customer> in the dock ----
import type { useCustomerDock } from '../use-customer-work'
import { useRecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { pendingAskOf, sameRecord } from '../../../../_shared/record-frame/model' // F-OP-212: the dock follows an ask's record
import type { useAllOfCustomer } from '../../../../_shared/record-thread/all-of-customer/use-all-of-customer'
import { ALL_OF_CUSTOMER_NS, AllOfCustomerDock } from '../../../../_shared/record-thread/all-of-customer/view/AllOfCustomerFeed'
// ---- end F-SA-279
// ---- F-CP-111: the docked order's files line = its file set; a tile opens the ONE viewer here ----
import { FileViewer } from '../../../../../lib/record-thread/popups/view/FileViewer'
import { FILES_VIEW_NS } from '../../../../../lib/record-thread/files-view/view/FilesView'
// ---- end F-CP-111
// ---- F-CW-101: the band in the strip's place (the bigger picture, its notes, what waits) ----
import { NAMESPACE as SHEET_NS, phasePhrase } from '../../../orders/list/sheet/model'
import { IN_PRODUCTION_VIEW } from '../use-customer-work'
import { bandOf, chipsOf, groupShown, whysOf, type BandGroup } from '../work-band'
import { beforeLineOf, NO_BEFORE_ORDER, type BeforeOrderCounts } from '../before-order'
import { WorkBand, type WorkBandActions, type WorkBandModel } from './WorkBand'
// ---- end F-CW-101
import { WorkLayoutTools } from '../work-layout' // F-CW-103: the Work tab's own browser layout
// ---- F-CW-302 (10-design §3.6; S35): the foot line — the order the rows stand in and the customer's urgency state (host-only) ----
import { sortChoicesOf } from '../../../orders/model'
import { LIMITS_ANCHOR } from '../../portal/limits/model'
import { workFootOf, type UrgencyFoot } from '../urgency-foot'
import { WorkFoot } from './WorkFoot'
// ---- end F-CW-302
import './customer-work.css'

/**
 * F-SA-276 (sales page plan N5, N7, N3; picks R5, R9, P10, P17; 11-customer-page §3; 17-review R-1; picture 21) — the customer's
 * Work tab, no tabs inside the tab: the waiting strip on top, then the ONE Orders sheet (useOrdersSheet) locked to the customer —
 * embedded (the customer's band is the page's), its terms in the page's address beside the page's own `tab` and `dock`, list key
 * 'sales.orders' (one export source, one set of saved views: a view saved here keeps the lock). Its built-in views (F-CP-101): All
 * orders (the default, `rows=all`, written into the address on entry) · In production · Waiting on us · Late (+ Not equal with its
 * step; F-CQ-303: the drafts went to Quotes & incoming). A row click switches the page's dock to that
 * order's conversation (⌘ / Ctrl: the order in a new tab; Enter opens the order). "Requests to answer" opens the view Waiting on us,
 * a request's Answer… the review window on this page (the four-door window, `?open=`). A real link to Production › Work orders of
 * the customer. Live: values in place, rows never jump (the sheet's own rule); the strip's counts re-read on their events.
 * F-CW-101 (customer Work tab plan §1; lead settles S3, S16, S19, S24): the strip is the band (WorkBand) — the seven groups of the
 * customer's orders, each a door (`phase=<PHASE>` beside `rows=all`), the notes, and today's six facts as chips; "Requests to
 * answer" opens the review window on exactly those requests; the view In production is the door of the started orders.
 */

/** A record the dock may show beside the customer's own thread (an order, a quote, a request): its type, id, number, company. */
export interface DockPick {
  readonly type: string
  readonly id: string
  readonly label: string
  readonly companyId: string | null
  /** F-CQ-305 (customer page › Quotes & incoming, 10-design §9): where the record came from and what it became (the row's own data). */
  readonly links?: readonly DockLink[]
}

// ---- F-CP-101 (customer page plan C1, D7, K1): the views of the Work tab, All orders first ----
/** The host's own views (not rows views of the sheet): Not equal (`priceMatch`, F-CP-141). F-CQ-303: Drafts of <customer> left this tab. */
export const NOT_EQUAL_VIEW = 'price:notEqual'

/** The Work tab's views, in their order: All orders · In production · Waiting on us · Late · Not equal. */
// F-CW-101 (lead settles S3, S19): In production is the door of the STARTED orders (`phase=IN_PRODUCTION`, a view of the host) — the
// same orders as the band's group and the Overview's tile, never the state In production (which holds the not-started ones too).
// F-CQ-303: Drafts of <customer> is no view of this tab any more (Quotes & incoming's "Customer is writing").
export const WORK_VIEWS: readonly string[] = Object.freeze([WORK_DEFAULT_ROWS, IN_PRODUCTION_VIEW, WAITING_US_VIEW, 'late', NOT_EQUAL_VIEW])

/**
 * The views this person is offered, in WORK_VIEWS' order: Not equal only with the price grain (money wall: no view, no count without
 * it); a host view only once its step draws it (`offered`: Not equal by F-CP-141) — never an item that shows nothing.
 */
export function workViewsOf(can: { readonly price: boolean }, offered: { readonly priceCheck?: boolean } = {}): string[] {
  return WORK_VIEWS.filter((id) => (id === NOT_EQUAL_VIEW ? !!offered.priceCheck && can.price : true))
}

/**
 * What an empty view says, per view (11-customer-page; 10 §1): All orders — "<customer> has no order yet." (F-CP-104 adds New order
 * beside it); In production — "Nothing in production for <customer>." with Show all orders; every other view the sheet's own words.
 * F-CW-102 (lead settle S20; 10-design §3.7): a door of the band or a view with nothing behind it says so in a whole sentence, with
 * Show all orders — "No order of <customer> waits to be sent to the factory now." (seven doors), "… waits on us now.", "… is late
 * now."; these show whatever the door narrows (`always`), so the host gives them only when nothing else does (`plain`: no search, no
 * other term — then the sheet's own "No orders match" is the right answer). No order at all with drafts in the portal: one more line
 * and the way to them (drafts are never counted as orders).
 */
export function workEmptyOf(
  rows: RowView,
  waiting: 'us' | null,
  customer: string,
  t: (key: string, params?: Record<string, string | number>) => string,
  allHref: string,
  door: { readonly phase?: OrderPhase | null; readonly plain?: boolean; readonly drafts?: { readonly count: number; readonly href: string } | null; /** cw fx5 (W-11): the priority door's level, in words. */ readonly priority?: string | null } = {},
): OrdersListModel['empty'] {
  const all = { href: allHref, label: t('customers.work.showAll') }
  const plain = door.plain !== false
  // cw fx5 (walk W-11): the priority door with nothing behind it says its own sentence — "No open order of <customer> has priority
  // Top now." on the open orders (the door the Customers list opens), "No order of <customer> has priority Top." over every order.
  if (door.priority && !door.phase && !waiting) {
    if (!plain || (rows !== 'open' && rows !== 'all')) return null
    return { title: t(rows === 'open' ? 'customers.work.none.priorityOpen' : 'customers.work.none.priority', { customer, level: door.priority }), link: all, always: true }
  }
  if (door.phase) return plain && rows === 'all' && !waiting ? { title: t(`customers.work.none.${door.phase}`, { customer }), link: all, always: true } : null
  if (waiting) return plain && rows === 'open' ? { title: t('customers.work.none.waitingUs', { customer }), link: all, always: true } : null
  // F-CP-102: each keyed to its view (the sheet shows it on that view when nothing else narrows it).
  if (rows === 'all') {
    const drafts = door.drafts && door.drafts.count > 0 ? door.drafts : null
    return { title: t('customers.work.emptyAll', { customer }), view: 'all', newOrder: true /* F-CP-104: New order beside it */, ...(drafts ? { body: t('customers.work.emptyDrafts', { count: drafts.count }), link: { href: drafts.href, label: t('customers.work.showDrafts') } } : {}) }
  }
  if (rows === 'IN_PRODUCTION') return { title: t('customers.work.empty', { customer }), link: all, view: 'IN_PRODUCTION' }
  if (rows === 'late') return plain ? { title: t('customers.work.none.late', { customer }), link: all, always: true } : null
  // cw fx5 (walk W-17): the Waiting for deposit view with nothing behind it.
  if (rows === 'deposit') return plain ? { title: t('customers.work.none.deposit', { customer }), link: all, always: true } : null
  return null
}
// ---- end F-CP-101

// ---- F-CP-141 (customer page plan C2d; 11-money §3.2; review E5, E6): the Not equal view and the money columns ----
/**
 * The money columns — ONE constant: the Not equal view's, and the Work · Money columns of every view (F-CP-105). Shown: Number ·
 * Status · Our price · Customer's price · Price check · Balance (@1440 beside the dock: select 36 + 128 + 112 + 104 + 104 + 112 + 104
 * + ⋯ 64 = 764 px ≤ the body's 865); from 1800 px Picture, Promised and Paid; Difference stays in Customise. The ids are the price
 * check spec's (fixed: the Owner's sheet maps onto them). A person's own Customise wins; without the price grain the money columns
 * do not exist, so nothing of it shows.
 */
export const MONEY_PRESET: NonNullable<OrdersListModel['preset']> = Object.freeze({
  shown: Object.freeze(['number', 'status', 'ourPrice', 'brandPrice', 'priceMatch', 'balance']),
  wide: Object.freeze(['picture', 'promised', 'paid']),
  // F-CW-103: Customise says so of the three that wait for a wider sheet (ticked, "… · from a wider sheet"). F-CW-104 (10-design
  // §3.8): they return from the `wide` room (WORK_ROOMS.wide: the row fits whole), not only at the widest.
  later: Object.freeze({ picture: 'wider', promised: 'wider', paid: 'wider' } as const),
})

/** The Not equal view is the one shown: every order (`rows=all`), the price check term Not equal, no waiting term (a price holder's). */
export const notEqualShown = (rows: RowView, waiting: 'us' | null, extra: ExtraTerms | null | undefined): boolean => rows === 'all' && !waiting && extra?.priceMatch === 'NOT_EQUAL'
// ---- end F-CP-141

// ---- F-CP-105 (customer page plan C2d; 10 §5; review F3 not taken: the toggle stays): "Columns: Work · Money" on every Work view ----
/** The page term of the toggle (kept by the host on every view, dropped by Clear all: CLEAR_DROPS). It names no view. */
export const COLS_TERM = 'cols'
export type ColumnSet = 'work' | 'money'
/** A view's own columns: the Not equal view opens on Money, every other view on Work. */
export const viewColumnSet = (notEqual: boolean): ColumnSet => (notEqual ? 'money' : 'work')
/**
 * The columns shown: the person's pick (`cols=money|work`), else the view's own. Without the price grain always Work — `cols=money`
 * changes nothing (a shared saved view or link that names it shows no money: there is no money column for them).
 */
export function columnSetOf(asked: string | null | undefined, notEqual: boolean, price: boolean): ColumnSet {
  if (!price) return 'work'
  return asked === 'money' || asked === 'work' ? asked : viewColumnSet(notEqual)
}
/** The term a pick writes: none when it is the view's own (the address stays clean; the same pick again writes the same address). */
export const colsTermOf = (set: ColumnSet, notEqual: boolean): ColumnSet | null => (set === viewColumnSet(notEqual) ? null : set)
// ---- end F-CP-105

// ---- F-CW-102 (customer Work tab plan §1; 10-design §1, §3.5; lead settles S4, S31, S39): the row, by the ROOM the sheet has ----
/**
 * The rooms of the Work tab's sheet — its OWN width, never the window's (F-CW-103 measures it): `base` beside the open thread at 1440
 * (865 px), `wide` at 1920 beside the thread (1185), `wider` with the thread closed at 1440 (1314), `widest` with it closed at 1920
 * (1794). Closing the thread ADDS columns. Each set starts where its columns fit whole (the budget is pinned by a test): select 43 +
 * the set's widths + ⋯ 64 ≤ the room.
 */
export type WorkRoom = 'base' | 'wide' | 'wider' | 'widest'
// cw fx7 (third look N-1): WORK_ROOMS — where each wider room starts — is summed from the sets' own widths, below WORK_MIN.
export const workRoomOf = (width: number | null | undefined): WorkRoom =>
  typeof width !== 'number' ? 'base' : width >= WORK_ROOMS.widest ? 'widest' : width >= WORK_ROOMS.wider ? 'wider' : width >= WORK_ROOMS.wide ? 'wide' : 'base'

/** The row's own order on screen (the sheet's other columns follow in their own order; ⋯ last). */
export const WORK_ORDER: readonly string[] = Object.freeze(['picture', 'number', 'whereItIs', 'promised', 'customerUrgency', 'priority', 'waitingOn', 'deposit', 'units', 'shipped', 'orderDate', 'supervisor', 'newMessages'])
/** What each wider room adds: Waiting on · Deposit, then Shipped, then Priority · Pieces · Ordered · Supervisor. Status waits in Customise (it is chip 1). */
export const WORK_ADDS: Readonly<Record<Exclude<WorkRoom, 'base'>, readonly string[]>> = Object.freeze({ wide: Object.freeze(['waitingOn', 'deposit']), wider: Object.freeze(['shipped']), widest: Object.freeze(['priority', 'units', 'orderDate', 'supervisor']) })
const BASE_SET: readonly string[] = Object.freeze(['picture', 'number', 'whereItIs', 'promised', 'customerUrgency', 'newMessages'])
/** The columns of each room: Picture · Number · Where it is · Promised · Customer urgency · New messages, then each room's adds. */
export const WORK_SETS: Readonly<Record<WorkRoom, readonly string[]>> = Object.freeze({
  base: BASE_SET,
  wide: Object.freeze([...BASE_SET, ...WORK_ADDS.wide]),
  wider: Object.freeze([...BASE_SET, ...WORK_ADDS.wide, ...WORK_ADDS.wider]),
  widest: Object.freeze([...BASE_SET, ...WORK_ADDS.wide, ...WORK_ADDS.wider, ...WORK_ADDS.widest]),
})
/** Waiting on us and Late beside the open thread: Waiting on takes the place of Customer urgency and New messages (no sideways scroll). */
export const WAITING_SET: readonly string[] = Object.freeze(['picture', 'number', 'whereItIs', 'promised', 'waitingOn'])
/**
 * The honest room of each column of the set: the picture 36 px; a seed's "SEED-SO-W39-01"; a date and its header; "Urgente (cliente)
 * 2" beside "Priorità: Massima"; the bubble; the longest words of each wider column in Italian. Status (in Customise): "In attesa
 * di approvazione" whole. On this page's sheet only: Sales › Orders keeps the sheet's own widths.
 *
 * cw fx5 (walk W-5, W-6, W-7; 30-walk §6.2): the narrow fixed columns stand at the design's widths (Picture 58 · Promised 98 · New
 * messages 44; the ⋯ column 48 is the sheet's own) with less side padding (WORK_PAD) — the px they give back go to Where it is:
 * 275 px in the 863 px room beside the thread (it had 232), so two chips and the pieces line fit. The tick box stays 43 px (the
 * grid engine's own; the design drew 40): Customer urgency gives those 3 px (its words wrap, never cut). Pieces 96: its header
 * whole beside its menu. Shipped 104 (as on Sales › Orders). Deposit 136: "Extra deposit open" on one line in English.
 *
 * cw fx6 (re-walk R-5): Ordered 144 with the closer padding — its second line ("requested 18/12/2026", "richiesto il 18/12/2026")
 * stands on ONE line: the cell was three lines of text in a 49 px row. The 40 px come from Where it is in the widest room (it has
 * 304 px there at 1792); that room starts later for it (WORK_ROOMS below), so Where it is never falls under its 275 px.
 */
export const WORK_MIN: Readonly<Record<string, number>> = Object.freeze({ picture: 58, number: 150, whereItIs: 220, promised: 98, customerUrgency: 147, newMessages: 44, waitingOn: 178, deposit: 136, shipped: 104, priority: 112, units: 96, orderDate: 144 /* cw fx6 (re-walk R-5) */, supervisor: 130, status: 196 })
/** cw fx5: the side padding of the set's narrow columns (the grid's own is 14 px): the picture in its middle; Where it is, the date and the Deposit pill closer to their edges. */
export const WORK_PAD: Readonly<Record<string, 'tight' | 'snug'>> = Object.freeze({ picture: 'tight', whereItIs: 'snug', promised: 'snug', deposit: 'snug', orderDate: 'snug' /* cw fx6 (R-5) */ })
/** cw fx5 (walk W-5, W-14): no menu button in the header of a narrow fixed column — "Promised" / "Promesso" whole beside its sort mark (Picture, New messages and ⋯ have none already). */
export const WORK_PLAIN_HEADS: readonly string[] = Object.freeze(['picture', 'promised', 'newMessages'])

// ---- cw fx7 (third look N-1): adding columns never takes "Where it is" under the 275 px it has beside the thread ----
/** The room "Where it is" keeps in EVERY room: what it has beside the open thread at 1440 (two chips and the pieces line fit). */
export const WORK_WHERE_ROOM = 275
/** What stands beside the set in the grid: the tick box (the grid engine's own) and the sheet's ⋯ column; the card's two edges (the tab measures its own room, the grid is that much narrower). */
export const WORK_TICK = 43
export const WORK_MORE = 48
export const WORK_CARD_EDGES = 2
/** The px a set takes without "Where it is": the tick box, its columns at their own widths, ⋯. */
export const workFixedOf = (ids: readonly string[]): number => WORK_TICK + WORK_MORE + ids.filter((id) => id !== 'whereItIs').reduce((sum, id) => sum + (WORK_MIN[id] ?? 0), 0)
/**
 * Where each wider room starts: the room in which its set leaves "Where it is" the 275 px — never earlier. Summed, not typed: a
 * column that grows moves its room's start with it (Ordered 104 → 144 had left the widest room at 1700 with 214 px for the chips:
 * two rows lost their pieces line). 1179 · 1283 · 1765 px of the tab's own room (it was 1150 · 1300 · 1700); the measured rooms
 * 1185, 1314 and 1794 land in the same sets as before, and a sheet of about 1700–1764 px keeps the nine columns (306 px or more).
 */
export const WORK_ROOMS: Readonly<Record<Exclude<WorkRoom, 'base'>, number>> = Object.freeze({
  wide: workFixedOf(WORK_SETS.wide) + WORK_WHERE_ROOM + WORK_CARD_EDGES,
  wider: workFixedOf(WORK_SETS.wider) + WORK_WHERE_ROOM + WORK_CARD_EDGES,
  widest: workFixedOf(WORK_SETS.widest) + WORK_WHERE_ROOM + WORK_CARD_EDGES,
})
// ---- end cw fx7
/** Every column of the set keeps its width: the room left goes to Where it is (the chips), never to a stretched date. */
export const WORK_MAX: Readonly<Record<string, number>> = Object.freeze(Object.fromEntries(Object.entries(WORK_MIN).filter(([id]) => id !== 'whereItIs' && id !== 'status')))

type WorkPreset = NonNullable<OrdersListModel['preset']>
/**
 * F-CW-103 (S12; 10-design §3.9): the columns of the tab's set that are not on screen in this room, and from which room they show —
 * what Customise says of each ("Waiting on · from a wider sheet", "Supervisor · from the widest sheet"): ticked, never cut to fit.
 */
export function workLaterOf(shown: readonly string[]): Readonly<Record<string, 'wider' | 'widest'>> {
  const later: Record<string, 'wider' | 'widest'> = {}
  for (const id of WORK_SETS.widest) if (!shown.includes(id)) later[id] = WORK_ADDS.widest.includes(id) ? 'widest' : 'wider'
  return Object.freeze(later)
}
/** One preset per room and kind, kept (the sheet rebuilds its columns only when the preset really changes). */
const PRESETS = new Map<string, WorkPreset>()
function presetOf(room: WorkRoom, waits: boolean): WorkPreset {
  const key = `${room}:${waits ? 'waits' : 'all'}`
  let preset = PRESETS.get(key)
  if (!preset) {
    const shown = waits ? WAITING_SET : WORK_SETS[room]
    // Chip 3 keeps its head, its tail goes to its tooltip. cw fx5 (walk W-6): in EVERY room — on the widest sheet the tail ("· due
    // 23/11/2026") is what the Deposit and Waiting on columns beside it already say, and with it the chips took two lines there.
    preset = Object.freeze({ shown, order: WORK_ORDER, min: WORK_MIN, max: WORK_MAX, dense: true, later: workLaterOf(shown) /* F-CW-103 */, pad: WORK_PAD, plainHeads: WORK_PLAIN_HEADS, wrapHeads: true /* cw fx5 (W-5) */ })
    PRESETS.set(key, preset)
  }
  return preset
}

// ---- F-CW-103 (lead settle S11; 13-backend §8, review A1 (b)): wide by the ROOM ----
/**
 * The Work tab measures its OWN room — the width its root really has, with the thread docked a third, a half or hidden, at any
 * screen — and hands the sheet the set for that room: closing the thread ADDS columns, live. Never the window (the old rule: 1800 px
 * of viewport, so a closed thread at 1440 added nothing), and no change in the record frame. Until it is measured: the base set.
 */
export function useWorkRoom(): { readonly ref: RefObject<HTMLDivElement | null>; readonly room: WorkRoom } {
  const ref = useRef<HTMLDivElement>(null)
  const [room, setRoom] = useState<WorkRoom>('base')
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const measure = () => setRoom(workRoomOf(node.getBoundingClientRect().width))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return { ref, room }
}
// ---- end F-CW-103

/**
 * The columns a view shows at first (10-design §1, §3.5; a person's Customise wins): the room's set — the same on every view of
 * the tab (All orders, a door of the band, In production); Waiting on us and Late beside the open thread show Waiting on in the
 * place of Customer urgency and New messages. Customer and Brand never (the customer is the page's); Status waits (it is the first
 * chip of Where it is). F-CP-141: the money columns (MONEY_PRESET) when `money` — the Not equal view, or the Work · Money toggle
 * (review E5: money never unasked); its wide columns return from the `wide` room (F-CW-104).
 */
export function workPreset(rows: RowView, waiting: 'us' | null, money = false, room: WorkRoom = 'base'): WorkPreset {
  if (money) return MONEY_PRESET // F-CP-141
  return presetOf(room, room === 'base' && (waiting === 'us' || rows === 'late'))
}
// ---- end F-CW-102

/** The dock's pick of an order row. */
export const pickOfRow = (row: Pick<OrderRow, 'id' | 'number' | 'companyId'>): DockPick => ({ type: 'SalesOrder', id: row.id, label: row.number, companyId: row.companyId })

type CustomerWork = ReturnType<typeof useCustomerWork>

export interface WorkTabProps {
  readonly party: { readonly id: string; readonly name: string }
  /** `/w/<company>`. */
  readonly prefix: string
  readonly work: CustomerWork
  readonly can: WorkCan
  /** The record the dock shows now (the picked row); null: the customer's own thread. */
  readonly picked: DockPick | null
  readonly onPick: (pick: DockPick) => void
  /** F-SA-279: the keys moved the focus to a row (the page's dock follows after its rest). */
  readonly onFocus?: (pick: DockPick) => void
  /** F-SA-278: the strip's two windows (Waiting for <customer>, Open tasks). */
  readonly onWindow?: WorkBandActions['onWindow']
  /** F-CW-101 (S27): the band's "Before an order" line — the page's counts (before-order.ts); absent: no line. */
  readonly before?: BeforeOrderCounts
  /**
   * F-CW-302 (S35): the customer's urgency as the page read it for this tab (urgency-foot.ts; workorders.view) — the foot's "3 of at
   * most 3 urgent now" / "Customer urgency is off"; null or absent: not read (the foot then says the sort only).
   */
  readonly urgencyFoot?: UrgencyFoot | null
  /** F-CW-302: the reader may change the customer's portal settings (the switch): the foot's door is drawn only then. */
  readonly mayPortal?: boolean
  /** cw fx5 (walk W-10): the reader may open Sales › Incoming — "Replies waiting on us" is a door only then (else its count, plain). */
  readonly mayIncoming?: boolean
  /** F-CP-104: the page's ask (the band's New order, ⋯ Import orders for <customer>…), served once the sheet is here; then `onAsked`. */
  readonly ask?: WorkAsk | null
  readonly onAsked?: () => void
}

export function WorkTab(props: WorkTabProps) {
  const router = useRouter()
  const params = useSearchParams()
  const entry = workEntry(`${props.prefix}/sales/customers/${encodeURIComponent(props.party.id)}`, props.party.id, params)
  useEffect(() => {
    if (entry) router.replace(entry, { scroll: false })
  }, [router, entry])
  // One write on entry (the tab, the lock, the default view), then the sheet reads once.
  if (entry)
    return (
      <div className="fw-cw" aria-busy="true">
        <Skeleton height={72} />
        <Skeleton height={320} />
      </div>
    )
  return (
    <WithMessages namespaces={['orders', SHEET_NS /* F-CW-101: the phases' words */, 'sales-orders-depth' /* cw fx5 (W-11): the priority levels */]}>
      <WorkSheet {...props} />
    </WithMessages>
  )
}

function WorkSheet({ party, prefix, work, can, picked, onPick, onFocus, onWindow, ask, onAsked, before, urgencyFoot = null, mayPortal = false, mayIncoming = false }: WorkTabProps) {
  const t = useT('parties')
  const o = useT('orders')
  const s = useT(SHEET_NS) // F-CW-101
  const d = useT('sales-orders-depth') // cw fx5 (W-11): our priority's level words
  const params = useSearchParams()
  // ---- F-CP-113: "Add the lines" opens the ONE lines editor (the New order page's own) in a large window here: no page hop, no
  // address term. Discard and a made order close it (the new order docks, its row arrives behind "N updates · Show"); × keeps the
  // typed lines in this tab.
  const router = useRouter()
  const { toast } = useToast()
  const [lines, setLines] = useState<NewOrderHeader | null>(null)
  // ---- end F-CP-113
  const frame = useRecordFrame() // F-SA-279: a phone card's door shows the conversation (the full-width view)
  const basePath = `/sales/customers/${encodeURIComponent(party.id)}`
  const host: OrdersSheetHost = {
    basePath,
    locked: { party: party.id },
    // cw fx5 (walk W-8): one customer, one name — the record's own (the band's), in every word of the sheet that names the customer.
    customerName: party.name,
    // cw fx5 (the requests on entry): the page already reads this customer's board for the band — the sheet reads no second one
    // while nothing narrows it (undefined: the page may not read it; null: its read is on its way or failed).
    ...(work.reads.board.status === 'off' ? {} : { board: work.reads.board.status === 'ready' ? work.reads.board.value : null }),
    embedded: true,
    keep: ['tab', 'dock', COLS_TERM /* F-CP-105: Work · Money, kept on every view (Clear all drops it) */],
    listKey: ORDERS_LIST_KEY,
    clearTo: WORK_DEFAULT_ROWS, // F-CP-102: Clear all goes back to All orders (the "Showing" line compares with it)
    onAddLines: setLines, // F-CP-113: the lines window on this page
    // A row click docks the order's conversation; ⌘ / Ctrl opens the order in a new tab.
    onRowClick: (row, newTab) => (newTab ? window.open(`${prefix}/sales/orders/${encodeURIComponent(row.id)}`, '_blank', 'noopener') : onPick(pickOfRow(row))),
  }
  const sheet = useOrdersSheet(host)
  const workRoom = useWorkRoom() // F-CW-103 (S11): the tab's own room decides the columns, never the window
  // ---- F-CP-104: the band's New order (the customer picked and held: no Change) and ⋯ Import orders open here, once each ask; no
  // address term is written for them (fx-12: nothing to loop on; a reload does not reopen the window).
  const latest = useRef(sheet.actions)
  latest.current = sheet.actions
  useEffect(() => {
    if (!ask) return
    onAsked?.()
    if (ask === 'new') latest.current.onNewOrder?.(true)
    else latest.current.onImport?.()
  }, [ask]) // eslint-disable-line react-hooks/exhaustive-deps
  // ---- end F-CP-104
  // The review window on this page (the four-door window): the customer's requests that wait on us, a batch as one entry.
  const requests = work.reads.requests.status === 'ready' ? work.reads.requests.value : null
  // cw fx5 (walk W-1; S24): the door lists EVERY request the chip counts (each that waits on us), not only the reader's own to decide.
  const list = useMemo(() => requestsDoorOf(requests?.items ?? []), [requests])
  const door = useRequestReviewDoor({ ids: list.ids, batches: list.batches, onChanged: work.reload })
  const rows = sheet.model.rows
  const waiting = sheet.model.waiting ?? null
  // F-CW-201: "Show all orders" keeps the order the person reads the orders in (it filters nothing).
  const all = `${prefix}${sheetAddress(basePath, host, params, { rows: 'all', q: '', layout: 'list', party: party.id, sort: sheet.model.sort ?? null })}`
  // ---- F-CQ-303: "Drafts of <customer>" (`list=drafts`) left this tab: an old address with it opens Quotes & incoming at WRITING on
  // entry (use-customer-work.ts workEntry, the tab's one write); the sheet always draws the orders here.
  // ---- end F-CQ-303
  // ---- F-CP-141: "Not equal" (`rows=all&priceMatch=NOT_EQUAL`) — a price holder's only: the view, its count (the customer's own
  // counts, read by the page: GET /sales/brand-prices/summary) and its money columns. Without the price grain: no view, no count;
  // an address with the term is held by the sheet in one line (no read carries it).
  const price = sheet.model.can.price
  const notEqual = price && notEqualShown(rows, waiting, sheet.model.extra) // F-CQ-303: no drafts view to stand beside
  const notEqualCount = price ? priceDifferOf(work.prices) : null
  // ---- end F-CP-141
  // ---- F-CP-105: "Columns: Work · Money" — the price grain only (no toggle otherwise, and `cols=money` changes nothing); it swaps
  // the view's columns for the money columns; the Not equal view opens on Money.
  const columnSet = columnSetOf(params?.get(COLS_TERM), notEqual, price)
  // ---- end F-CP-105
  // ---- F-CW-101: the band — the bigger picture from the strip's own board read (no second read), the group the sheet shows now, the
  // two whys of "Not sent to the factory" (also the quiet words beside that door's chip).
  const phase = sheet.model.extra?.phase ?? null // F-CQ-303: no drafts view to stand beside
  const phaseWords = (which: NonNullable<typeof phase>): string => {
    const words = phasePhrase(which)
    return words.orders ? o(words.key) : s(words.key)
  }
  const picture = useMemo(() => bandOf(work.reads.board), [work.reads.board])
  const whys = useMemo(() => whysOf(work.reads.board), [work.reads.board])
  const whysWords = whys.map((entry) => t(`customers.work.band.why.${entry.why}`, { count: entry.count })).join(' · ')
  const shownGroup = picture.groups.find((group) => groupShown(group, { rows, waiting, extra: sheet.model.extra, drafts: false /* F-CQ-303: never shown here */ })) ?? null
  // The In production view = the door of the started orders (S3): ticked while that door is the one shown.
  const startedShown = phase === 'IN_PRODUCTION' && rows === 'all' && !waiting
  // ---- end F-CW-101
  const model: OrdersListModel = {
    ...sheet.model,
    views: workViewsOf(sheet.model.can, { priceCheck: true }), // F-CP-101: All orders first; F-CP-141: Not equal (price grain); F-CQ-303: no Drafts view
    viewCounts: { ...(workViewCounts(work.reads.board) ?? {}), ...(notEqualCount !== null ? { [NOT_EQUAL_VIEW]: notEqualCount } : {}) }, // F-CP-103 (no second read); F-CP-141: the Not equal count; F-CQ-303: no drafts count
    hostViews: [
      { id: IN_PRODUCTION_VIEW, label: o('rows.IN_PRODUCTION'), active: startedShown }, // F-CW-101 (S3): the started orders' door
      ...(price ? [{ id: NOT_EQUAL_VIEW, label: t('customers.work.view.notEqual'), active: notEqual }] : []), // F-CP-141
    ],
    preset: workPreset(rows, waiting, columnSet === 'money' /* F-CP-141: the Not equal view opens on the money columns; F-CP-105: the toggle on every view */, workRoom.room /* F-CW-103 */),
    // F-CW-103 (S11): by the tab's own room (the sheet then asks no window). F-CW-104 (10-design §3.8): the Money set's wide columns
    // (Picture · Promised · Paid) return as soon as the row fits whole — from the `wide` room.
    wide: columnSet === 'money' ? workRoom.room !== 'base' : workRoom.room === 'widest',
    countOf: workViewCounts(work.reads.board)?.all ?? null, // F-CW-104: "2 of 14 orders" under a door, a view or a search
    layoutSwitch: false, // F-CW-202 (S36): no List ⇄ Board switch on this tab — the key `v` is off and leaves the keys list
    urgencyOff: urgencyFoot !== null && !urgencyFoot.on, // F-CW-302 (S35): the customer's switch, as this tab read it
    searchLabel: t('customers.work.search'), // F-CW-104: the shorter words fit the toolbar beside the thread
    columnSet: price ? { value: columnSet } : null, // F-CP-105: the toggle, a price holder's only
    marks: work.marks,
    doorHref: door.hrefOf,
    // F-CW-101 (S38): "Work orders of <customer> ›" moved from the toolbar to the band's notes (it wrapped the toolbar beside the dock).
    phaseNote: phase === 'NOT_SENT' && whysWords ? whysWords : null, // F-CW-101: why the orders behind that door wait
    // F-CP-101: per view. F-CW-102 (S20): a door's or a view's own sentence when nothing else narrows the sheet; the drafts' line.
    empty:
      workEmptyOf(rows, waiting, party.name, t, all, {
        phase,
        // cw fx5 (walk W-11): a priority door's own sentence, the level in the words the Priority chip says it.
        priority: sheet.model.extra?.priority ? d(`priority.level.${sheet.model.extra.priority}`) : null,
        plain: sheet.model.q.trim() === '' && !sheet.model.brand && !sheet.model.company && !sheet.model.cf && !sheet.model.kind && Object.keys(sheet.model.extra ?? {}).every((key) => key === 'phase' || key === 'priority'),
        // F-CQ-303: the drafts' line opens Quotes & incoming at WRITING ("Customer is writing").
        drafts: typeof before?.drafts === 'number' ? { count: before.drafts, href: quotesGroupDoor(`${prefix}${basePath}`, 'WRITING') } : null,
      }) ??
      sheet.model.empty ??
      null,
    // F-SA-279: the row the dock shows is marked; the keys' row is reported (the dock follows after its rest); a phone card's door.
    active: can.threads ? { id: picked && picked.type === 'SalesOrder' ? picked.id : null, cardDoor: t('customers.work.dock.cardDoor') } : null,
  }
  // ---- F-CP-141: on the Not equal view every other pick stands alone — the price check term goes in the same write (Views ▾, the
  // strip's doors, Show all orders); the chip's ✕ goes back to All orders.
  const leave = notEqual ? (sheet.actions.onPriceMatch ?? null) : null
  const onRows = leave ? (next: RowView) => leave(null, { rows: next }) : sheet.actions.onRows
  const onWaiting = leave ? (next: 'us' | null, view?: RowView) => leave(null, { rows: view ?? rows, waiting: next }) : sheet.actions.onWaiting
  // ---- end F-CP-141
  // ---- F-CW-101 (S16): a phase door stands alone too — every other pick (Views ▾, the band's chips, Show all orders) drops the
  // phase term in the same write; a door picked sets it alone beside All orders (the sheet's onPhase).
  const offPhase = sheet.model.extra?.phase ? (sheet.actions.onPhase ?? null) : null
  const viewRows = offPhase ? (next: RowView) => offPhase(null, { rows: next }) : onRows
  const viewWaiting = offPhase ? (next: 'us' | null, view?: RowView) => offPhase(null, { rows: view ?? rows, waiting: next }) : onWaiting
  const showAll = () => (waiting ? viewWaiting?.(null, 'all') : viewRows?.('all'))
  // ---- end F-CW-101
  const actions = {
    ...sheet.actions,
    onRows: viewRows, // F-CP-141; F-CW-101
    onWaiting: viewWaiting, // F-CP-141; F-CW-101
    // F-CP-105: a pick writes `cols` through the sheet (one replace; none when it is the view's own columns: the term goes).
    ...(price ? { onColumnSet: (set: ColumnSet) => sheet.actions.onPageTerm?.(COLS_TERM, colsTermOf(set, notEqual)) } : {}),
    // F-CP-141: Not equal — `rows=all&priceMatch=NOT_EQUAL` in one write through the sheet (it drops `list`, keeps the lock).
    // F-CQ-303: no Drafts of <customer> pick here any more.
    onHostView: (id: string) => {
      if (id === NOT_EQUAL_VIEW) sheet.actions.onPriceMatch?.('NOT_EQUAL', { rows: 'all' })
      else if (id === IN_PRODUCTION_VIEW) sheet.actions.onPhase?.('IN_PRODUCTION') // F-CW-101 (S3): the started orders' door
    },
    ...(can.threads
      ? {
          onFocusRow: (row: OrderRow) => onFocus?.(pickOfRow(row)),
          onCardThread: (row: OrderRow) => {
            onPick(pickOfRow(row))
            frame?.showThread?.()
          },
        }
      : {}),
  }
  // ---- F-CW-101: the band's model and doors. A group pressed shows its orders; pressed while shown, all orders again. Late and
  // Waiting for deposit open their views (as the strip's tiles did); "Requests to answer" opens the review window on exactly the
  // requests it counts (S24: the door's own list, a real link); Replies is a real link; the two windows are the page's.
  const recordHref = `${prefix}${basePath}`
  const firstRequest = list.ids[0] ?? null
  const bandModel: WorkBandModel = {
    customer: party.name,
    picture,
    shown: shownGroup?.phase ?? null,
    whys,
    before: beforeLineOf(before ?? NO_BEFORE_ORDER, recordHref),
    chips: chipsOf(can, work.reads),
    pressed: waiting || phase ? [] : /* F-CQ-303: no drafts view */ rows === 'late' ? ['late'] : rows === 'deposit' ? ['deposit'] : [],
    workOrdersHref: can.workorders ? `${prefix}/production/work-orders?party=${encodeURIComponent(party.id)}` : null,
    failed: work.reads.board.status === 'failed', // cw fx6 (re-walk R-4): the groups' read failed — the notes line says so, with Try again
    // cw fx5 (walk W-10): a door only for a reader who may open the page it leads to; else the count stays, plain and quiet.
    repliesHref: mayIncoming ? `${prefix}/sales/incoming?tile=CUSTOMER_REPLIES&party=${encodeURIComponent(party.id)}` : null,
    requestsHref: firstRequest ? door.hrefOf(firstRequest) : null,
  }
  const bandActions: WorkBandActions = {
    onGroup: (group: BandGroup) => {
      if (!group.door) return
      if (shownGroup?.phase === group.phase) return showAll()
      if (group.door.kind === 'phase') sheet.actions.onPhase?.(group.door.phase)
      else viewRows?.(group.door.status) // an older answer: the one state's own view
    },
    onAll: showAll,
    // F-CQ-303: the drafts' part is a link to Quotes & incoming (no onDrafts).
    onView: (view) => (!waiting && !phase && rows === view ? showAll() : waiting ? viewWaiting?.(null, view) : viewRows?.(view)),
    onWindow,
    onRetry: work.retry,
  }
  // ---- end F-CW-101
  // The picked order left the view (it moved on, live): the dock keeps its conversation; one line says so, with the way back.
  const items = sheet.model.list.items
  const gone = picked && picked.type === 'SalesOrder' /* F-CQ-303: no drafts view */ && items && sheet.model.updates === 0 && !items.some((row) => row.id === picked.id) && !(rows === 'all' && !waiting && !notEqual /* F-CP-141 */ && !phase /* F-CW-101 */)
  // ---- F-CW-302: the foot line's words (the sort's own word from the sheet's choices; the door to the customer's Portal settings).
  const sortChoice = sortChoicesOf(true).find((choice) => choice.value === (sheet.model.sort ?? '')) ?? null
  const foot = workFootOf({ sort: sheet.model.sort ?? null, sortWord: sortChoice ? s(`sort.${sortChoice.word}`) : null, customer: party.name, foot: urgencyFoot, portalHref: `${prefix}${basePath}?tab=portal#${LIMITS_ANCHOR}`, mayPortal })
  // ---- end F-CW-302
  const viewName = waiting ? t('customers.work.view.waitingUs') : notEqual ? t('customers.work.view.notEqual') /* F-CP-141 */ : phase ? phaseWords(phase) /* F-CW-101 */ : o(`rows.${rows}`)
  return (
    <CustomerOverrideProvider onDone={door.refresh}>
      <div className="fw-cw" ref={workRoom.ref /* F-CW-103: the room the tab measures */}>
        <RequestDoorNoticeBanner door={door} />
        <WorkBand model={bandModel} actions={bandActions} />
        {gone && (
          <p className="fw-cw-line" role="status">
            <span>{t('customers.work.gone', { record: picked?.label ?? '', view: viewName })}</span>
            <Button size="sm" variant="quiet" onClick={showAll /* F-CP-141; F-CW-101: the phase door left too */}>
              {t('customers.work.showAll')}
            </Button>
          </p>
        )}
        {/* F-CQ-303: the drafts' list left this tab (Quotes & incoming's "Customer is writing"); the sheet always shows here.
            F-CW-103 (S12): the sheet under the Work tab's own browser layout (a layout made on Sales › Orders never moves it). */}
        <WorkLayoutTools listKey={ORDERS_LIST_KEY}>
          <OrdersListView model={model} actions={actions /* F-SA-279 */} />
        </WorkLayoutTools>
        {/* F-CW-302 (10-design §3.6): the foot — the order the rows stand in, the customer's urgency state (this tab only). */}
        <WorkFoot line={foot} />
      </div>
      <RequestDoorWindow door={{ ...door, window: { ...door.window, review: reviewNamed(door.window.review, party.name) } } /* cw fx6 (re-walk W-8) */} />
      {/* F-CQ-303: the draft's read-only window opens from Quotes & incoming now. */}
      {lines && (
        // F-CP-113: the same editor as /sales/orders/new, its customer and header set by the New order window.
        <NewOrderEditor
          frame="window"
          prefix={prefix}
          header={lines}
          onClose={() => setLines(null)}
          onDiscarded={() => setLines(null)}
          onMade={(order) => {
            setLines(null)
            toast(o('newOrder.window.made', { number: order.number }), 'success')
            if (can.threads) onPick(pickOfRow({ id: order.id, number: order.number, companyId: lines.companyId }))
          }}
          onOpen={(href) => router.push(href)}
        />
      )}
    </CustomerOverrideProvider>
  )
}

type CustomerFeed = ReturnType<typeof useAllOfCustomer>
type DockProps = { customer: { id: string; name: string }; general: ReactNode; dock: ReturnType<typeof useCustomerDock>; feed: CustomerFeed; prefix: string; /** F-OP-213: All of <customer> may be read (its General is readable). */ allOffered?: boolean }

/**
 * F-SA-276 (11-customer-page §9.1, review C-13): the customer page's dock — the customer's own thread, and beside it the record a
 * row picked (an order of the Work tab, a quote or a request of Quotes & incoming): ONE thread at a time, picked with the shared
 * ThreadPick ("<customer> (general)" · the record), ONE line under it saying who reads what is written there. Writing always goes
 * into the one thread shown.
 * F-SA-279 (sales page plan N5, N4; picks R5, R9, P9; 11-customer-page §3.7, §9.1, §9.2): the third choice "All of <customer>" — the
 * read-only merged feed (F-SA-261), whose lines open their ONE conversation at that message; the record follows the row (the page's
 * `dock=` term, useCustomerDock); "Draft kept on SO-…" under the pick when the dock left a record with a draft; the words of the pick
 * the same as the order page's (C-13). No threads.read: no dock at all. The page reads All of <customer> (useAllOfCustomer) and
 * hands the dock its feed (end check: a view fetches nothing).
 */
/** F-OP-203: the dock's catalogues — All of <customer>'s, and the orders' for the pick's short "General" (the order page's word). */
const CUSTOMER_DOCK_NS = [...ALL_OF_CUSTOMER_NS, 'orders', FILES_VIEW_NS /* F-CP-111: a file of the order's set that did not open */, 'before-order' /* F-CQ-305: the door line */] as const

export function CustomerDock(props: DockProps) {
  return (
    <WithMessages namespaces={CUSTOMER_DOCK_NS}>
      <Dock {...props} />
    </WithMessages>
  )
}

function Dock({ customer, general, dock, feed, prefix, allOffered = true }: DockProps) {
  const t = useT('parties')
  const o = useT('orders') // F-OP-203
  const rt = useT('record-thread') // F-OP-203
  const b = useT('before-order') // F-CQ-305: the door line's words
  // ---- F-CP-111: a file of the docked order's set that could not be opened (or shared) is said once, as the order page says it.
  const fv = useT(FILES_VIEW_NS)
  const { toast } = useToast()
  const filesProblem = dock.filesProblem
  useEffect(() => {
    if (filesProblem) toast(fv(filesProblem.key), 'danger')
  }, [filesProblem?.at]) // eslint-disable-line react-hooks/exhaustive-deps -- once per problem
  // ---- end F-CP-111
  // ---- F-OP-212 (11-dock §5, D5): an ask of the page (files, Followers…, a door, Answer) names its record — the customer's own when
  // the body names none: the pick goes to that record's thread first (the customer's general one; the record picked), which then
  // takes the ask; once per ask. The narrow view is the frame's term, untouched by `dock=`.
  const frame = useRecordFrame()
  const pending = pendingAskOf(frame)
  const askFor = pending?.record ?? null
  const follow = !askFor ? null : askFor.type === 'Party' ? (askFor.id === customer.id ? 'general' : null) : dock.pick && sameRecord(askFor, dock.pick) ? 'record' : null
  const latest = useRef(dock)
  latest.current = dock
  useEffect(() => {
    if (follow && latest.current.scope !== follow) latest.current.onScope(follow)
  }, [pending?.ask, follow])
  // ---- end F-OP-212
  if (general === null || general === undefined) return null
  const pick = dock.pick
  // F-OP-203: each segment with its icon and its short words for a narrow card (the order page's words, C-13).
  const choices: ThreadChoice<'general' | 'record' | 'all'>[] = [
    { value: 'general', label: t('customers.work.dock.general', { customer: customer.name }), short: o('record.dock.writeGeneral'), icon: <Building2 size={14} aria-hidden />, line: t('customers.work.dock.generalLine', { customer: customer.name }) },
    ...(pick ? [{ value: 'record' as const, label: pick.label, icon: <RecordTypeIcon type={pick.type} size={14} />, line: t('customers.work.dock.recordLine', { record: pick.label, customer: customer.name }) }] : []),
    // F-OP-204 (11-dock §2): the whose-line says it is read only and how to write (one place, one wording: the feed's own line left).
    // F-OP-213: offered only when the customer's own thread may be read (the feed's wall).
    ...(allOffered ? [{ value: 'all' as const, label: t('customers.work.dock.all', { customer: customer.name }), short: rt('allOfCustomer.view.all'), title: t('customers.work.dock.readOnly'), icon: <Eye size={14} aria-hidden />, line: rt('allOfCustomer.line', { customer: customer.name }) }] : []),
  ]
  // F-OP-213: an address that names All of a reader may not read shows the general thread (no word that it existed).
  const scope = dock.scope === 'all' && !allOffered ? 'general' : dock.scope
  const onAnswer = (record: { readonly type: string; readonly id: string }, messageId: string) => {
    const entry = feed.state.entries.find((one) => one.record.type === record.type && one.record.id === record.id)
    dock.onAnswer({ type: record.type, id: record.id, label: entry?.record.label ?? record.type, companyId: entry?.record.companyId ?? null }, messageId)
  }
  // F-OP-205: the empty feed's door — the first message goes into the customer's general thread, the box on Office note.
  const writeFirst = { thread: t('customers.work.dock.general', { customer: customer.name }), onWrite: () => (frame?.compose ? frame.compose({ record: { type: 'Party', id: customer.id }, messageId: null, mode: 'note' }) : dock.onScope('general')) }
  // ---- F-OP-207 (11-dock §3.2, §3.4; D11): Answer in place on a line of the customer's general thread or of the record picked (the
  // frame's compose ask: the pick goes there first, the box focused — Reply on the customer's line, Office note otherwise); any other
  // record's line opens its page. The foot: "Read only. Write in: [<customer> (general)]" and the record picked, when one is.
  const canAnswer = (record: { readonly type: string; readonly id: string }) => (record.type === 'Party' ? record.id === customer.id : !!pick && sameRecord(record, pick))
  const writeIn = (record: { readonly type: string; readonly id: string }, fallback: 'general' | 'record') => (frame?.compose ? frame.compose({ record, messageId: null, mode: 'note' }) : dock.onScope(fallback))
  const allFoot = (
    <>
      <span>
        {t('customers.work.dock.readOnly')}. {o('record.dock.writeIn')}
      </span>
      <Button size="sm" variant="secondary" onClick={() => writeIn({ type: 'Party', id: customer.id }, 'general')}>
        {t('customers.work.dock.general', { customer: customer.name })}
      </Button>
      {pick && (
        <Button size="sm" variant="secondary" onClick={() => writeIn({ type: pick.type, id: pick.id }, 'record')}>
          {pick.label}
        </Button>
      )}
    </>
  )
  // ---- end F-OP-207
  // F-CP-111: the ONE viewer of the docked order's files (the container's walk: ← / → over the order's files; body data only when asked).
  const viewer = scope === 'record' ? (dock.orderFiles?.model.viewer ?? null) : null
  const filesActions = dock.orderFiles?.actions
  return (
    <>
      {viewer && (
        <FileViewer
          walk="all"
          files={viewer.files}
          index={viewer.index}
          onIndex={(index) => filesActions?.onViewerIndex?.(index)}
          onClose={() => filesActions?.onViewerClose?.()}
          onOpenLocked={filesActions?.onViewerOpenLocked}
          onDownload={filesActions?.onViewerDownload}
          returnFocusTo={viewer.returnTo}
        />
      )}
      <ThreadPick
        label={t('customers.work.dock.label')}
        choices={choices}
        value={scope}
        onPick={dock.onScope}
        note={dock.draftKept ? t('customers.work.dock.draftKept', { record: dock.draftKept }) : null}
        // ---- F-CQ-305 / cq fx3 W2-3 (10-design §9): the door line in the dock's head, under the pick (inside the card, never above it on
        // the page): "Came from request … ›", "Became order … ›" — a click docks that record's own thread; none when the row carried none.
        extra={
          scope === 'record' && pick?.links && pick.links.length > 0 ? (
            <span className="fw-qt-doors" aria-label={b('dock.line')}>
              {pick.links.map((link) => (
                <Button key={`${link.kind}:${link.pick.id}`} size="sm" variant="link" onClick={() => dock.onRow(link.pick)}>
                  {b(`dock.${link.kind}`, { number: link.pick.label })}
                </Button>
              ))}
            </span>
          ) : null
        }
        // ---- end F-CQ-305 / W2-3
      >
        {scope === 'record' && pick ? (
          <OfficeRecordThread
            key={`${pick.type}:${pick.id}`}
            docked
            record={{ type: pick.type, id: pick.id, companyId: pick.companyId, siteId: null }}
            title={`${pick.label} · ${customer.name}`}
            recordLabel={pick.label}
            party={{ id: customer.id, name: customer.name }}
            partyRole="customer"
            recordHref={`${prefix}${recordAddress({ type: pick.type, id: pick.id, label: pick.label, companyId: pick.companyId }, OFFICE_PAGES)}`}
            onDraft={(kept) => dock.onDraft(pick, kept)}
            {...(dock.orderFiles && pick.type === 'SalesOrder' ? { orderFiles: dock.orderFiles } : {}) /* F-CP-111: the files line = the order's file set */}
          />
        ) : scope === 'all' ? (
          // F-OP-203: All of <customer> in the dock's ONE card (DockColumn): the pick band on top, the read-only feed that scrolls.
          // F-OP-204: its Head row (FeedHead); this page IS the customer's, so its ⋯ has no "Open <customer>".
          <AllOfCustomerDock label={`${t('customers.work.dock.all', { customer: customer.name })} · ${t('customers.work.dock.readOnly')}`} model={feed.model} actions={{ ...feed.actions, onAnswer, writeFirst, canAnswer, ...(frame?.compose ? { onCompose: frame.compose } : {}) }} foot={allFoot} />
        ) : (
          general
        )}
      </ThreadPick>
    </>
  )
}
