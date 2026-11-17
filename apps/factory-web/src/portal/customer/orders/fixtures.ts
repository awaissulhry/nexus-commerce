import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { Locale } from '../../../lib/i18n/locales'
import type { OrderChip } from './api'
import type { OrdersRead, PortalColumn } from './api' // B-TH-246
import { listBandOf } from './band'
import { at, inTransitRead, orderWords, ordersRead, PREFIX, ROWS, shellOf, words } from './design-data'
// B-TH-223: Orders & requests read by Brand Beta (brand B), the made-up reader of every wall scan.
import { betaShellOf, PREFIX as BETA, REQUESTS } from '../requests/design-data'
import { CLOSED_REQUESTS, listRows, type ListChip } from './model'
// B-TH-238: the tiles above the list.
import { listTiles, NEEDS_YOU, OPEN_ORDERS, OPEN_REQUESTS, type TileChip } from './model'
import type { RequestRow } from '../requests/api'
import { CustomerCase, type CustomerCaseBuilder } from './view/CustomerCase'
import type { OrdersListViewModel } from './view/OrdersListView'

/**
 * SCR-184 › Orders & tracking (design portal.customer.orders: sec:chips, sec:orders-grid, sec:in-transit, tab:print;
 * B-W2b-191), MADE-UP data only: the open orders (the default chip) with "On the way", every order, rows selected for
 * Export N, the "Date moved" chip, a role without prices, nothing yet, nothing matching, a chip with nothing, loading, the
 * list or the parcels unread, changes waiting, no connection, more than one page, the print view, and the page for a
 * person without it (a typed address).
 */

function listModel(over: Partial<OrdersListViewModel> = {}): OrdersListViewModel {
  const read = over.read === undefined ? ordersRead() : over.read
  return {
    state: 'ready',
    read,
    rows: read?.items ?? [],
    requests: { state: 'ready', rows: [], complete: true },
    chip: null,
    q: '',
    prefix: PREFIX,
    selected: [],
    updates: 0,
    offlineSince: null,
    more: null,
    transit: { state: 'ready', read: inTransitRead() },
    ...over,
  }
}

function listCase(build: (locale: Locale) => Partial<OrdersListViewModel> = () => ({})): CustomerCaseBuilder {
  return (locale) => {
    const model = listModel(build(locale))
    return {
      shell: shellOf(locale, listBandOf({ words: orderWords(locale), asOf: model.read?.asOf ?? null, rows: model.rows.length, chip: model.chip, q: model.q, prefix: PREFIX })),
      body: { kind: 'list', model },
    }
  }
}

const chipCase = (chip: OrderChip) => listCase(() => ({ chip, read: ordersRead(chip) }))

// ── B-TH-223: Orders & requests, read by Brand Beta ─────────────────────────────────────────────────────────────────
function betaCase(build: (locale: Locale) => Partial<OrdersListViewModel> = () => ({})): CustomerCaseBuilder {
  return (locale) => {
    const base = listModel({ prefix: BETA, requests: { state: 'ready', rows: REQUESTS, complete: true }, newOrderHref: `${BETA}/orders/new`, ...build(locale) })
    // B-TH-238: the tiles from Beta's own reads (the requests' counts as the API counts them, the orders' Open chip).
    const model: OrdersListViewModel = { ...base, tiles: base.tiles !== undefined ? base.tiles : listTiles(base.requests.state === 'ready' ? { counts: requestCountsOf(base.requests.rows) } : null, base.read) }
    const shown = model.read ? listRows(model.chip ?? model.read.chip, model.q, model.requests.state === 'ready' ? model.requests.rows : [], model.rows, locale).length : 0
    return {
      shell: betaShellOf(locale, listBandOf({ words: orderWords(locale), asOf: model.read?.asOf ?? null, rows: shown, chip: model.chip, q: model.q, prefix: BETA, newOrder: `${BETA}/orders/new`, onDownloadAll: () => undefined /* B-TH-246 */ }), '/orders'),
      body: { kind: 'list', model },
    }
  }
}
/** B-TH-238: the requests' counts as GET /portal/inquiries says them (what needs the customer, the open ones). */
export const requestCountsOf = (rows: readonly RequestRow[]) => ({ needsYou: rows.filter((row) => row.state.needsYou).length, open: rows.filter((row) => row.state.open).length })
/** B-TH-238: a tile's own rows (the two request tiles read no order; "Open orders" reads the API's Open). */
const betaTile = (chip: TileChip) => betaCase(() => (chip === OPEN_ORDERS ? { chip, read: ordersRead('OPEN'), rows: ordersRead('OPEN').items } : { chip, read: { ...ordersRead('OPEN'), items: [], count: 0 }, rows: [] }))
const betaChip = (chip: ListChip) => betaCase(() => ({ chip, read: chip === CLOSED_REQUESTS ? { ...ordersRead('OPEN'), items: [], count: 0 } : ordersRead(chip), rows: chip === CLOSED_REQUESTS ? [] : ordersRead(chip).items }))
const all = ordersRead('ALL')

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
const betaSheet = (failed = false) => betaCase(() => ({ read: sheetRead(ordersRead('OPEN')), rows: sheetRead(ordersRead('OPEN')).items, ...(failed ? { downloadFailed: true } : {}) }))
// ── end B-TH-246 ──

export const designScreen = defineDesignScreen<CustomerCaseBuilder>({
  screen: 'SCR-184',
  title: 'Customer Orders & tracking (portal.customer.orders)',
  view: CustomerCase,
  cases: [
    { id: 'th-223-list', label: 'Orders & requests: the open ones (requests first)', model: betaCase(), note: 'One list: Number (their PO, then the customer’s own number: “Your request 7”, “Your order 11” — never INQ-, SO-, RQ-), Kind, Subject, Date, State (true states), Wanted or promised, Pieces, Value (price roles), Next shipment. The request that needs them on top. New order is the band’s primary.' },
    // B-TH-230 (TH-2): New messages — the person's own, on their own requests and orders only; a door to the conversation.
    { id: 'th-230-new-messages', label: 'New messages: "● 2 new" on a request and an order of this customer', model: betaCase(() => ({ unread: { [REQUESTS[0]!.id]: { newCount: 2, lastAt: '2026-11-17T09:42:00.000Z' }, [ROWS[0]!.id]: { newCount: 1, lastAt: '2026-11-16T15:10:00.000Z' } } })), note: 'One read for the rows shown: the count holds only messages shared with this customer (never an office note) and only its own requests and orders. The cell opens the request’s page or the order with its docked conversation shown (B-TH-275).' },
    // B-TH-238 (P-CUS-ORD-LIST.tiles): We need something from you · Open requests · Open orders — each filters the list.
    { id: 'th-238-needs-you', label: 'Tile: we need something from you (the same number as Home’s Messages card)', model: betaTile(NEEDS_YOU), note: 'Only the requests we asked something about; the tile is pressed; Clear brings the open list back.' },
    { id: 'th-238-open-requests', label: 'Tile: open requests', model: betaTile(OPEN_REQUESTS) },
    { id: 'th-238-open-orders', label: 'Tile: open orders (a catalogue order still waiting for us among them)', model: betaTile(OPEN_ORDERS) },
    { id: 'th-223-all', label: 'Everything', model: betaChip('ALL'), note: 'Every request and every order, closed ones too.' },
    // B-TH-246: the customer's own sheet (read-only columns the office ticked; Download all in the band's ⋯).
    { id: 'th-246-sheet', label: 'TH-4 · Brand Beta · Its own sheet: the columns ticked for its portal, read-only; Download all (Excel) in ⋯', model: betaSheet(), note: 'Every cell opens Brand Beta\'s own order page; the file is written by the server with Brand Beta\'s rows and columns only.' },
    { id: 'th-246-download-failed', label: 'TH-4 · Brand Beta · Download all could not be prepared (Try again)', model: betaSheet(true) },
    { id: 'th-223-requested', label: 'Requested: the requests and the catalogue order still waiting for us', model: betaChip('REQUESTED') },
    { id: 'th-223-closed', label: 'Closed requests: never vanished', model: betaChip(CLOSED_REQUESTS), note: 'Declined, closed and made-into-an-order requests stay findable under their own choice.' },
    { id: 'th-223-search', label: 'A search finds a request by its subject or its number', model: betaCase(() => ({ q: 'gloves', read: ordersRead('OPEN', []), rows: [] })), note: 'Their PO, our order or a style code on the orders; the subject, their PO and their own number on the requests.' },
    { id: 'th-223-requests-failed', label: 'The requests could not be read', model: betaCase(() => ({ requests: { state: 'error', rows: [], complete: true } })), note: 'Said in words with Try again; the orders still show (never drawn as “no requests”).' },
    {
      id: 'th-223-empty',
      label: 'Nothing yet: New order',
      model: betaCase(() => {
        const read = { ...ordersRead('OPEN', []), chips: ordersRead('OPEN', []).chips.map((chip) => ({ ...chip, count: 0 })) }
        return { read, rows: [], requests: { state: 'ready', rows: [], complete: true }, transit: { state: 'ready', read: inTransitRead({ items: [] }) } }
      }),
      note: 'What lands here and the first action.',
    },
    {
      id: 'th-223-no-prices',
      label: 'A colleague without prices',
      model: betaCase(() => {
        const read = ordersRead('OPEN', null, { seesPrices: false })
        return { read, rows: read.items }
      }),
    },
    { id: 'normal', label: 'Open orders (the default chip) and On the way', model: listCase(), note: 'Chips with counts in customer words; their PO first, ours second; sorted by the promise date with the moved mark; value (net) with the price grain; the next shipment with its ETA; a request sent waits for our confirmation (no page yet). On the way: the parcel, its status, ETA, steps and the carrier’s site.' },
    { id: 'all', label: 'Every order', model: chipCase('ALL'), note: 'Delivered and cancelled orders too.' },
    { id: 'selected', label: 'Two orders selected', model: listCase(() => ({ chip: 'ALL', read: all, rows: all.items, selected: [ROWS[0]!.id, ROWS[2]!.id] })), note: 'The bulk action takes the search’s place: Export 2 (CSV of the selected rows).' },
    { id: 'date-moved', label: 'The “Date moved” chip', model: chipCase('DATE_MOVED'), note: 'Orders whose promise date changed in the last 14 days.' },
    {
      id: 'no-prices',
      label: 'A colleague without prices (viewer, quality)',
      model: listCase(() => {
        const read = ordersRead('OPEN', null, { seesPrices: false })
        return { read, rows: read.items }
      }),
      note: 'No value column at all and one quiet line: “Prices are not part of your access”.',
    },
    {
      id: 'empty',
      label: 'A new customer: no orders yet',
      model: listCase(() => {
        const read = { ...ordersRead('OPEN', []), chips: ordersRead('OPEN', []).chips.map((chip) => ({ ...chip, count: 0 })) }
        return { read, rows: [], transit: { state: 'ready', read: inTransitRead({ items: [] }) } }
      }),
      note: 'On the way is hidden when nothing is in transit.',
    },
    { id: 'no-match', label: 'Nothing matches the search', model: listCase(() => ({ chip: 'ALL', q: 'BA-PO-9999', read: ordersRead('ALL', []), rows: [] })), note: '“No orders match these filters” + Clear filters.' },
    { id: 'chip-empty', label: 'Nothing in a chip', model: listCase(() => ({ chip: 'READY', read: ordersRead('READY', []), rows: [] })) },
    { id: 'loading', label: 'Loading', model: listCase(() => ({ state: 'loading', read: null, rows: [], transit: { state: 'loading', read: null } })) },
    { id: 'error', label: 'The list could not be read', model: listCase(() => ({ state: 'error', read: null, rows: [], transit: { state: 'error', read: null } })), note: 'A failed read is never drawn as an empty list; On the way says so too.' },
    { id: 'updates', label: 'Changes waiting', model: listCase(() => ({ updates: 2 })), note: 'Rows never move under the pointer: “2 updates · Show”.' },
    { id: 'offline', label: 'No connection', model: listCase(() => ({ offlineSince: at(-1) })), note: '“No connection — showing what was loaded at …”; Show more is held with the reason.' },
    {
      id: 'more',
      label: 'More than one page',
      model: listCase(() => {
        const read = { ...all, count: 64 }
        return { chip: 'ALL', read, rows: all.items, more: { loading: false } }
      }),
      note: 'Pages of 50: “Show more” in the footer.',
    },
    {
      id: 'print',
      label: 'tab:print — Print this list',
      model: (locale) => ({
        shell: shellOf(locale, { title: words(locale)('print.title') }),
        body: { kind: 'print', model: { state: 'ready', rows: listRows('OPEN', '', REQUESTS, ordersRead('OPEN').items, locale), count: ordersRead('OPEN').count + REQUESTS.filter((row) => row.state.open).length, seesPrices: true, filters: { chip: locale === 'it' ? 'Aperti' : 'Open', q: '' }, partyName: 'Brand Alpha S.r.l.', printedBy: 'Anna Esempio', printedAt: at(0), backHref: `${PREFIX}/orders` } },
      }),
      note: 'Its own tab: the filters written at the top, every row, who printed it and when; on paper only the sheet.',
    },
    { id: 'keys', label: 'The keys in the footer’s info icon', model: listCase(() => ({ keysOpen: true })), note: 'Key hints only in the table footer (Owner rule 2026-10-29).' },
    {
      id: 'no-access',
      label: 'Not part of the person’s access',
      model: (locale) => ({ shell: shellOf(locale, { title: words(locale)('list.title') }), body: { kind: 'noAccess', admins: ['Anna Esempio'] } }),
      note: 'A typed or old address (a designer, a supplier): who to ask, and Home. Not in the navigation (fails closed).',
    },
  ],
})
