import { Reply } from 'lucide-react'
import { groupOf } from '@nexus/factory-domain/sales/portal-orders/status'
import type { Locale } from '../../../lib/i18n/locales'
import { customerStateChipOf, type Door, type MarkChipModel, type PromiseCellModel, type ShippedCellModel, type StateChipModel } from '../../../lib/order-cells/model'
import { CUSTOMER_GROUP_ICON, CUSTOMER_GROUPS, isCustomerGroup, type CustomerGroup } from '../../../lib/order-groups/groups'
import type { GroupCount } from '../../../lib/order-groups/view/GroupsBand'
import type { RequestRow } from '../requests/api'
import { matchesSearch, requestHref, requestOrder, stateTone } from '../requests/model'
import type { OrderRow, OrdersRead } from './api'
import { kindKey, recordHref, threadHref, yoursOf, type ListRow } from './model'

/**
 * pg-w2 (portal grid plan § 3, § 5 pg-3.1; 18-lead-settles Z3–Z8, Z16; 10-design § 1) — Orders & requests on the shared parts, pure:
 * the customer's rows turned into the view models of the shared cells (lib/order-cells) and the groups band (lib/order-groups,
 * face customer). The band's numbers are ONLY the server's (the sheet answer's `groups`, `open`, `needsYou`: counted over the party's
 * own rows, before the search) — "—" while read or when the answer has none, never a count made here. Every cell is a door (the
 * order's page, its Shipments tab, its conversation; a request's page); a catalogue request has no page, its cells stay plain (Z7).
 * No office series anywhere (a parcel is named by its order, D6). No call, no React.
 */

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

/** The words a row is said in: `portal-orders` (the host's), `order-list` (the shared parts' customer face), days and money. */
export interface ListWords {
  readonly t: Translate
  readonly list: Translate
  readonly locale: Locale
  readonly day: (iso: string) => string
  readonly money: (minor: number | null | undefined, currency: string | null | undefined) => string
}

// ── the groups and the address ──────────────────────────────────────────────────────────────────────────────────────────

/** The group the address names (`?chip=<GROUP>`); anything else (an older address's chip) is everything open. */
export const groupOfAddress = (value: string | null | undefined): CustomerGroup | null => (isCustomerGroup(value) ? value : null)

/** The list's address: the group shown (none: everything open, the default) and the search. */
export function groupQuery(group: CustomerGroup | null, q: string): string {
  const params = new URLSearchParams()
  if (group) params.set('chip', group)
  if (q.trim()) params.set('q', q.trim())
  const text = params.toString()
  return text ? `?${text}` : ''
}

/** Whether a group holds orders (Closed requests holds the customer's ended requests only). */
export const holdsOrders = (group: CustomerGroup | null): boolean => group !== 'CLOSED_REQUESTS'

/**
 * The chip of the orders' read for a group (the server's own chips): everything open = Open, Requests = Requested (the orders and
 * catalogue requests that wait for our yes), Shipped holds partly shipped; Closed requests reads Open only for the band's numbers.
 */
export function sheetChipOf(group: CustomerGroup | null): string {
  if (group === null || group === 'CLOSED_REQUESTS') return 'OPEN'
  if (group === 'REQUESTS') return 'REQUESTED'
  return group
}

/**
 * The customer's requests (inquiries) a group shows, by the domain's ONE rule (the server counts them by it): under everything open
 * and Requests the open ones, except those whose order waits for our yes (their order row carries them: never twice); under Closed
 * requests the declined, closed and withdrawn ones (never vanished); none in the order groups.
 */
export function requestsOf(group: CustomerGroup | null, rows: readonly RequestRow[]): RequestRow[] {
  const shown: CustomerGroup | null = group === null || group === 'REQUESTS' ? 'REQUESTS' : group === 'CLOSED_REQUESTS' ? 'CLOSED_REQUESTS' : null
  return shown ? rows.filter((row) => groupOf({ kind: 'INQUIRY', state: row.state.code }) === shown) : []
}

/** The rows of the list: the group's requests that match the search (the one that needs you on top), then the orders read. */
export function listRowsOf(group: CustomerGroup | null, q: string, requests: readonly RequestRow[], orders: readonly OrderRow[], locale: Locale): ListRow[] {
  const asked = requestOrder(requestsOf(group, requests).filter((row) => matchesSearch(row, q, locale)))
  return [...asked.map((request): ListRow => ({ kind: 'request', id: request.id, request })), ...(holdsOrders(group) ? orders.map((order): ListRow => ({ kind: 'order', id: order.id, order })) : [])]
}

// ── the band: the server's numbers only (Z3) ────────────────────────────────────────────────────────────────────────────

export interface ListBand {
  readonly groups: readonly GroupCount[]
  /** Every open order and request (the server's `open`); null: not read, or not in the answer. */
  readonly total: number | null
  /** How many need the customer's answer (the server's `needsYou`); null: not read, or not in the answer. */
  readonly needsYou: number | null
  readonly shown: CustomerGroup | null
  readonly state: 'ready' | 'reading' | 'failed'
}

/**
 * The band of the groups from the sheet answer: each group's count as the server counted it (null — "—" — while the first read
 * runs, or when an older answer has no `groups`: then no group is a door, since nothing says what it holds). Never summed here.
 */
export function bandOf(read: Pick<OrdersRead, 'groups' | 'open' | 'needsYou'> | null, state: 'loading' | 'error' | 'ready', shown: CustomerGroup | null): ListBand {
  const counted = read?.groups ?? null
  const groups = CUSTOMER_GROUPS.map((group): GroupCount => ({ group, count: counted?.find((entry) => entry.group === group)?.count ?? null, door: counted !== null }))
  return {
    groups,
    total: read?.open ?? null,
    needsYou: read?.needsYou ?? null,
    shown,
    state: read ? 'ready' : state === 'error' ? 'failed' : 'reading',
  }
}

/** The toolbar's count: the orders the read counts for the group (none under Closed requests) and the group's requests shown. */
export function countOf(read: Pick<OrdersRead, 'count'> | null, group: CustomerGroup | null, requestsShown: number): number | null {
  if (!read) return null
  return (holdsOrders(group) ? read.count : 0) + requestsShown
}

// ── the room: no sideways scroll, no dead space (D8; Z16 P1, P2; 10-design § 1.4) ──────────────────────────────────────────

/** The columns' widths (px) at 1440: 58 + 170 + 280 + 120 + 108 + 44 + 116 + 2 × 120 = 1136 of the grid's 1138. */
export const LIST_WIDTHS = Object.freeze({ picture: 58, number: 170, whereItIs: 280, promised: 120, ordered: 116, shipped: 108, newMessages: 44, value: 116, portal: 120 })
/** "Ordered" joins from this room (the Work tab's room rule, Z16 P1). */
export const ORDERED_FROM = 1600
/** What stands beside the grid in the room the list measures: the card's two edges. */
export const LIST_CARD_EDGES = 2

/**
 * What the grid's room holds beyond the fixed cells: "Ordered" from 1600 px, then the columns the office ticked for this customer,
 * ONE at a time while the room holds each (D8: 2 at 1440, up to 5 at 1920; the rest are in the Excel file and on the order page).
 */
export function roomColumnsOf(room: number, input: { readonly seesPrices: boolean; readonly messages: boolean; readonly portal: number }): { readonly ordered: boolean; readonly portal: number } {
  const ordered = room >= ORDERED_FROM
  const fixed = LIST_WIDTHS.picture + LIST_WIDTHS.number + LIST_WIDTHS.whereItIs + LIST_WIDTHS.promised + LIST_WIDTHS.shipped + (input.messages ? LIST_WIDTHS.newMessages : 0) + (input.seesPrices ? LIST_WIDTHS.value : 0) + (ordered ? LIST_WIDTHS.ordered : 0)
  return { ordered, portal: Math.max(0, Math.min(input.portal, Math.floor((room - fixed) / LIST_WIDTHS.portal))) }
}

// ── one row's cells ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ListRowView {
  readonly id: string
  readonly kind: 'order' | 'request' | 'catalogue'
  /** The row's page (its order, its request); a catalogue request has none: its cells stay plain (Z7). */
  readonly href: string | null
  /** Number: the strong door ("Your order 12", "Your request 7") and its quiet line (the PO; a request's subject, H1). */
  readonly number: { readonly text: string; readonly sub: string | null; readonly door: Door }
  /** An order's picture is read (D4); a request has none (P5). */
  readonly picture: boolean
  /** Where it is: the status chip and at most ONE mark ("Needs your answer", orders only: Z16 P3); the cell opens the row's page. */
  readonly state: StateChipModel
  readonly mark: MarkChipModel | null
  readonly door: Door
  readonly promise: PromiseCellModel
  /** Ordered (from 1600 px): the day it was ordered, a request's day received. */
  readonly ordered: { readonly day: string | null; readonly door: Door }
  /** Shipped: an order's bar (its door the Shipments tab, the next parcel its tip); a request's pieces asked. */
  readonly shipped: { readonly bar: ShippedCellModel } | { readonly asked: string }
  /** New messages: the bubble's door (the request's page; the order with its conversation shown) and the record's name. */
  readonly messages: { readonly href: string | null; readonly record: string }
  /** Net value (only with the price grain; a request: none). */
  readonly value: { readonly text: string; readonly door: Door } | null
}

const dayOf = (value: string | null | undefined, words: ListWords): string | null => (value ? words.day(value.slice(0, 10)) : null)

/** The next parcel in words, named by the order (D6: never the office's shipment series); null without its order's own number, its place or a day. */
export function nextParcelOf(order: Pick<OrderRow, 'yourNumber' | 'nextShipment'>, words: ListWords): string | null {
  const next = order.nextShipment
  const seq = order.yourNumber?.seq
  const day = next ? (next.expectedDeliveryAt ?? next.date) : null
  if (!next || seq === undefined || typeof next.parcel !== 'number' || !day) return null
  return words.list('customer.shipped.tip', { name: words.list('customer.shipped.parcel', { order: seq, n: next.parcel }), date: words.day(day.slice(0, 10)) })
}

/** One row as the shared cells draw it (the customer's own words; every number from the read). */
export function rowViewOf(row: ListRow, input: { readonly prefix: string; readonly seesPrices: boolean; readonly words: ListWords }): ListRowView {
  const { prefix, words } = input
  const { t, list, locale } = words
  const yours = yoursOf(row, locale)
  const name = yours ?? t(kindKey(row))
  if (row.kind === 'request') {
    const request = row.request
    const href = requestHref(prefix, request.id)
    const door: Door = { href, tip: { key: 'row.openRequest' } }
    const open = request.state.open
    return {
      id: row.id,
      kind: 'request',
      href,
      number: { text: name, sub: request.subject || null, door },
      picture: false,
      state: { words: request.state.words[locale], tone: open ? stateTone(request.state.code) : 'neutral', mark: open ? CUSTOMER_GROUP_ICON.REQUESTS : CUSTOMER_GROUP_ICON.CLOSED_REQUESTS, ...(open ? {} : { line: true }) },
      mark: null, // a request's own chip already says "We need something from you" (one fact once, Z16 P3)
      door,
      promise: { face: 'customer', of: 'wanted', day: dayOf(request.wantedDate, words), door },
      ordered: { day: dayOf(request.receivedAt, words), door },
      shipped: { asked: request.pieces > 0 ? list('customer.shipped.asked', { count: request.pieces }) : '—' },
      messages: { href: threadHref(prefix, row), record: name },
      value: null,
    }
  }
  const order = row.order
  const po = order.customerRef ? t('list.yourPo', { ref: order.customerRef }) : null
  const state = customerStateChipOf(order.status, order.words[locale])
  const promise = (door: Door): PromiseCellModel =>
    order.promiseDate
      ? { face: 'customer', of: 'promise', day: dayOf(order.promiseDate, words), was: order.promiseMoved && order.originalPromiseDate ? dayOf(order.originalPromiseDate, words) : null, door }
      : order.requestedDate
        ? { face: 'customer', of: 'asked', day: dayOf(order.requestedDate, words), door }
        : { face: 'customer', of: 'promise', day: null, door }
  if (order.kind === 'REQUEST') {
    // Z7: a catalogue request (not decided yet) has no page and no own number: its Number is the PO, else the kind's words; plain cells.
    return {
      id: row.id,
      kind: 'catalogue',
      href: null,
      number: { text: po ?? t(kindKey(row)), sub: po ? t(kindKey(row)) : null, door: null },
      picture: false,
      state,
      mark: null,
      door: null,
      promise: promise(null),
      ordered: { day: dayOf(order.orderedOn, words), door: null },
      shipped: { asked: list('customer.shipped.asked', { count: order.pieces.ordered }) },
      messages: { href: null, record: name },
      value: null,
    }
  }
  const href = recordHref(prefix, order.id)
  const door: Door = { href, tip: { key: 'row.open' } }
  return {
    id: row.id,
    kind: 'order',
    href,
    number: { text: yours ?? po ?? t(kindKey(row)), sub: yours ? po : null, door },
    picture: true,
    state,
    // Z4, Z16 P3: the row's ONE mark — a re-confirm asked of the customer (the server's `needsYou`).
    mark: order.needsYou ? { tone: 'warning', mark: Reply, head: list('customer.mark.needsYou') } : null,
    door,
    promise: promise(door),
    ordered: { day: dayOf(order.orderedOn, words), door },
    shipped: { bar: { shipped: order.pieces.shipped, units: order.pieces.ordered, record: name, door: { href: recordHref(prefix, order.id, 'shipments'), tip: { key: 'row.shipments' } }, tip: nextParcelOf(order, words) } },
    messages: { href: threadHref(prefix, row), record: name },
    value: input.seesPrices ? { text: words.money(order.netAmount, order.currency), door } : null,
  }
}
