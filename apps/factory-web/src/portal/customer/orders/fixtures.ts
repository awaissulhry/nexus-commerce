import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { Locale } from '../../../lib/i18n/locales'
import type { OrdersRead, OrderRow, PortalColumn } from './api' // B-TH-246
import { listBandOf } from './band'
import { at, orderWords, ordersRead, PREFIX, ROWS, shellOf, words } from './design-data'
// B-TH-223 (fix-portal-1): Brand Beta's cases list Brand Beta's own rows, never the rows above (BA-PO-…).
import { BETA_ROWS, betaOrdersRead } from './design-data'
// B-TH-223: Orders & requests read by Brand Beta (brand B), the made-up reader of every wall scan.
import { betaShellOf, PREFIX as BETA, REQUESTS } from '../requests/design-data'
import type { RequestRow } from '../requests/api'
// pg-w2: the groups of the band and what each holds (the server's rule, imitated by the made-up reads below).
import { CUSTOMER_GROUPS, type CustomerGroup } from '../../../lib/order-groups/groups'
import { customerGroupOf } from '../../../lib/order-cells/model'
import { CLOSED_REQUEST_STATES, holdsOrders, sheetChipOf } from './list-view-model'
import { customerNumberOf } from '@nexus/factory-domain/sales/customer-numbers'
import { CustomerCase, type CustomerCaseBuilder } from './view/CustomerCase'
import type { OrdersListViewModel } from './view/OrdersListView'

/**
 * SCR-184 › Orders & requests (design portal.customer.orders; B-W2b-191; pg-w2 — the list on the shared parts, picture
 * `design/portal-grid-2026-11-24/20-preview-portal-grid.html`), MADE-UP data only: everything open (the default), a group pressed,
 * New messages, the customer's own sheet, a role without prices, nothing yet (for who may order and who may not), nothing in a group,
 * nothing found, loading, failed, changes waiting, no connection, more than one page, the band's window, the keys, and the page for a
 * person without it. Brand Beta's cases list Brand Beta's own rows only.
 */

/**
 * The made-up answer's band (pg-server § Shapes): each group's count over ONE customer's rows, before the search — the server's own
 * rule imitated for the design cases (the live page never counts: it draws the numbers the server sends).
 */
function bandRead(read: OrdersRead, world: readonly OrderRow[], requests: readonly RequestRow[]): OrdersRead {
  const counts = new Map<CustomerGroup, number>(CUSTOMER_GROUPS.map((group) => [group, 0]))
  const add = (group: CustomerGroup) => counts.set(group, (counts.get(group) ?? 0) + 1)
  for (const row of world) add(customerGroupOf(row.status))
  for (const request of requests) {
    if (request.state.open && request.state.code !== 'ORDER_WAITING') add('REQUESTS')
    else if (CLOSED_REQUEST_STATES.includes(request.state.code)) add('CLOSED_REQUESTS')
  }
  const open = (['REQUESTS', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'SHIPPED'] as const).reduce((sum, group) => sum + (counts.get(group) ?? 0), 0)
  const needsYou = requests.filter((request) => request.state.needsYou).length + world.filter((row) => row.needsYou).length
  return { ...read, groups: CUSTOMER_GROUPS.map((group) => ({ group, count: counts.get(group) ?? 0 })), open, needsYou }
}

/** A group's rows as the sheet answers them (the orders only; Closed requests holds none). */
function groupRead(world: readonly OrderRow[], read: (rows: readonly OrderRow[]) => OrdersRead, group: CustomerGroup | null): OrdersRead {
  const chip = sheetChipOf(group)
  const rows = !holdsOrders(group) ? [] : world.filter((row) => (chip === 'OPEN' ? ['REQUESTED', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED'].includes(row.status) : chip === 'REQUESTED' ? row.status === 'REQUESTED' : customerGroupOf(row.status) === group))
  return read(rows)
}

function listModel(over: Partial<OrdersListViewModel> = {}): OrdersListViewModel {
  const read = over.read === undefined ? bandRead(groupRead(ROWS, (rows) => ordersRead('OPEN', rows), null), ROWS, []) : over.read
  return {
    state: 'ready',
    read,
    rows: read?.items ?? [],
    requests: { state: 'ready', rows: [], complete: true },
    group: null,
    q: '',
    prefix: PREFIX,
    updates: 0,
    offlineSince: null,
    more: null,
    ...over,
  }
}

function listCase(build: (locale: Locale) => Partial<OrdersListViewModel> = () => ({})): CustomerCaseBuilder {
  return (locale) => {
    const model = listModel(build(locale))
    return {
      shell: shellOf(locale, listBandOf({ words: orderWords(locale), asOf: model.read?.asOf ?? null, onDownloadAll: () => undefined })),
      body: { kind: 'list', model },
    }
  }
}

// ── B-TH-223: Orders & requests, read by Brand Beta ─────────────────────────────────────────────────────────────────
const betaRead = (group: CustomerGroup | null, over: Partial<OrdersRead> = {}, requests: readonly RequestRow[] = REQUESTS) => bandRead(groupRead(BETA_ROWS, (rows) => betaOrdersRead('OPEN', rows, over), group), BETA_ROWS, requests)
function betaCase(build: (locale: Locale) => Partial<OrdersListViewModel> = () => ({}), newOrder = true): CustomerCaseBuilder {
  return (locale) => {
    const built = build(locale)
    const read = built.read === undefined ? betaRead(built.group ?? null) : built.read
    const model = listModel({ prefix: BETA, read, rows: read?.items ?? [], requests: { state: 'ready', rows: REQUESTS, complete: true }, newOrderHref: newOrder ? `${BETA}/orders/new` : null, ...built })
    return {
      shell: betaShellOf(locale, listBandOf({ words: orderWords(locale), asOf: model.read?.asOf ?? null, ...(newOrder ? { newOrder: `${BETA}/orders/new` } : {}), onDownloadAll: () => undefined /* B-TH-246 */ }), '/orders'),
      body: { kind: 'list', model },
    }
  }
}
/** A group pressed: its rows only (Brand Beta's). */
const betaGroup = (group: CustomerGroup) => betaCase(() => ({ group, read: betaRead(group) }))
/** pg-t: 200 orders of Brand Beta's own (its own ids, numbers and PO codes): the first page of 50 shown, "50 of 200 …", Show more. */
const MANY: readonly OrderRow[] = Array.from({ length: 50 }, (_, index) => {
  const like = BETA_ROWS[index % 3]!
  return { ...like, id: `b2b2b2b2-0000-4000-8000-${String(900 + index).padStart(12, '0')}`, customerRef: `BETA-PO-${String(500 + index).padStart(4, '0')}`, yourNumber: customerNumberOf('ORDER', 100 + index) }
})

// ── B-TH-246 (threads plan TH-4, picture 28): Brand Beta's own sheet — the columns the office ticked for its portal ──
/** Made-up portal columns: one for every customer (a list value the rows use), and Brand Beta's own (a day). */
export const SHEET_COLUMNS: PortalColumn[] = [
  { columnId: 'cf:box_type', code: 'box_type', type: 'SELECT', labelIt: 'Tipo di scatola', labelEn: 'Box type', unit: null, grain: null, options: [{ code: 'GIFT', labelIt: 'Scatola regalo', labelEn: 'Gift box' }] },
  { columnId: 'cf:fair_date', code: 'fair_date', type: 'DATE', labelIt: 'Data della fiera', labelEn: 'Fair date', unit: null, grain: null, options: null },
]
/** A read of the sheet: every order row carries its cells (a request has none). */
export function sheetRead(read: OrdersRead): OrdersRead {
  return { ...read, columns: SHEET_COLUMNS, items: read.items.map((row, index) => (row.kind === 'ORDER' ? { ...row, values: { 'cf:box_type': { value: 'GIFT', wordsIt: null, wordsEn: null }, ...(index % 2 === 0 ? { 'cf:fair_date': { value: '2027-02-10', wordsIt: null, wordsEn: null } } : {}) } } : row)) }
}
// ── end B-TH-246 ──

export const designScreen = defineDesignScreen<CustomerCaseBuilder>({
  screen: 'SCR-184',
  title: 'Customer Orders & tracking (portal.customer.orders)',
  view: CustomerCase,
  cases: [
    { id: 'th-223-list', label: 'Orders & requests: everything open (the band of groups, requests first)', model: betaCase(), note: 'ONE band (Requests · Confirmed · In production · Ready to ship · Shipped · Delivered; Cancelled and Closed requests apart; the server\'s numbers), then Picture · Number (“Your order 21” / your PO; a request’s subject) · Where it is · Promised (+ “was …”) · Shipped · New messages · Net value · your columns. Every cell a door; a catalogue request plain.' },
    // B-TH-230 (Z10): New messages — the bubble "2", the person's own, on their own requests and orders only.
    { id: 'th-230-new-messages', label: 'New messages: the bubble on a request and an order of this customer', model: betaCase(() => ({ unread: { [REQUESTS[0]!.id]: { newCount: 2, lastAt: '2026-11-17T09:42:00.000Z' }, [BETA_ROWS[0]!.id]: { newCount: 1, lastAt: '2026-11-16T15:10:00.000Z' } } })), note: 'One read for the rows shown; the bubble opens the request’s page or the order with its conversation shown.' },
    { id: 'th-223-requests', label: 'Group pressed: Requests (the open requests, the catalogue order and the order that wait for our yes)', model: betaGroup('REQUESTS'), note: 'The request whose order waits ("Club vests") shows once: as its order row (H4).' },
    { id: 'th-223-confirmed', label: 'Group pressed: Confirmed', model: betaGroup('CONFIRMED') },
    { id: 'th-223-in-production', label: 'Group pressed: In production (an order that needs your answer: its one mark)', model: betaGroup('IN_PRODUCTION') },
    { id: 'th-223-ready', label: 'Group pressed: Ready to ship', model: betaGroup('READY') },
    { id: 'th-223-shipped', label: 'Group pressed: Shipped (partly or fully, not all arrived; the next parcel in Shipped’s tip)', model: betaGroup('SHIPPED') },
    { id: 'th-223-delivered', label: 'Group pressed: Delivered', model: betaGroup('DELIVERED') },
    { id: 'th-223-cancelled', label: 'Group pressed: Cancelled (apart, quiet)', model: betaGroup('CANCELLED') },
    { id: 'th-223-closed', label: 'Closed requests: never vanished (apart, quiet)', model: betaGroup('CLOSED_REQUESTS') },
    { id: 'th-223-many', label: '200 orders: 50 shown, Show more', model: betaCase(() => ({ read: { ...betaRead(null), items: [...MANY], count: 200, open: 200 }, rows: MANY, more: { loading: false }, requests: { state: 'ready', rows: [], complete: true } })) },
    { id: 'th-223-window', label: 'The band’s ⓘ window: every group with what it holds', model: betaCase(() => ({ windowOpen: true })) },
    // B-TH-246: the customer's own sheet (read-only columns the office ticked, joining while the room holds them; Download (Excel) in ⋯).
    { id: 'th-246-sheet', label: 'TH-4 · Brand Beta · Its own sheet: the columns ticked for its portal, read-only; Download (Excel) in ⋯', model: betaCase(() => ({ read: bandRead(sheetRead(betaOrdersRead('OPEN')), BETA_ROWS, REQUESTS) })), note: 'Every cell opens Brand Beta\'s own order page; the file is written by the server with Brand Beta\'s rows and columns only.' },
    { id: 'th-246-download-failed', label: 'TH-4 · Brand Beta · Download (Excel) could not be prepared (Try again)', model: betaCase(() => ({ read: bandRead(sheetRead(betaOrdersRead('OPEN')), BETA_ROWS, REQUESTS), downloadFailed: true })) },
    { id: 'th-223-search', label: 'A search finds nothing: Clear the search', model: betaCase(() => ({ q: 'gloves-9999', read: betaRead(null, {}, REQUESTS), rows: [], requests: { state: 'ready', rows: [], complete: true } })) },
    { id: 'th-223-requests-failed', label: 'The requests could not be read', model: betaCase(() => ({ requests: { state: 'error', rows: [], complete: true } })), note: 'Said in words with Try again; the orders still show (never drawn as “no requests”).' },
    { id: 'th-223-empty', label: 'Nothing yet, for who may order: New order', model: betaCase(() => ({ read: bandRead(betaOrdersRead('OPEN', []), [], []), rows: [], requests: { state: 'ready', rows: [], complete: true } })) },
    { id: 'th-223-empty-viewer', label: 'Nothing yet, for who may not order (no New order)', model: betaCase(() => ({ read: bandRead(betaOrdersRead('OPEN', []), [], []), rows: [], requests: { state: 'ready', rows: [], complete: true } }), false), note: 'G1-B11: the words never name New order to a person who cannot order.' },
    { id: 'th-223-no-prices', label: 'A colleague without prices', model: betaCase(() => ({ read: betaRead(null, { seesPrices: false }) })), note: 'No Net value column at all and one quiet line: “Prices are not part of your access”.' },
    { id: 'normal', label: 'Brand Alpha: everything open (busy)', model: listCase() },
    { id: 'chip-empty', label: 'Nothing in a group', model: listCase(() => ({ group: 'READY', read: bandRead(ordersRead('OPEN', []), ROWS, []), rows: [] })) },
    { id: 'loading', label: 'Loading', model: listCase(() => ({ state: 'loading', read: null, rows: [] })) },
    { id: 'error', label: 'The list could not be read', model: listCase(() => ({ state: 'error', read: null, rows: [] })), note: 'A failed read is never drawn as an empty list; the band says so once, with Try again.' },
    { id: 'updates', label: 'Changes waiting', model: listCase(() => ({ updates: 2 })), note: 'Rows never move under the pointer: “2 updates · Show”.' },
    { id: 'offline', label: 'No connection', model: listCase(() => ({ offlineSince: at(-1) })), note: '“No connection — showing what was loaded at …”; Show more is held with the reason.' },
    { id: 'more', label: 'More than one page', model: listCase(() => ({ read: { ...bandRead(ordersRead('OPEN'), ROWS, []), count: 64 }, more: { loading: false } })), note: 'Pages of 50: “Show more” in the footer.' },
    { id: 'keys', label: 'The keys in the footer’s info icon', model: listCase(() => ({ keysOpen: true })), note: 'Key hints only in the table footer (Owner rule 2026-10-29).' },
    {
      id: 'no-access',
      label: 'Not part of the person’s access',
      model: (locale) => ({ shell: shellOf(locale, { title: words(locale)('list.title') }), body: { kind: 'noAccess', admins: ['Anna Esempio'] } }),
      note: 'A typed or old address (a designer, a supplier): who to ask, and Home. Not in the navigation (fails closed).',
    },
  ],
})
