import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { Locale } from '../../../lib/i18n/locales'
import type { OrderChip } from './api'
import { listBandOf } from './band'
import { at, inTransitRead, orderWords, ordersRead, PREFIX, ROWS, shellOf, words } from './design-data'
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
const all = ordersRead('ALL')

export const designScreen = defineDesignScreen<CustomerCaseBuilder>({
  screen: 'SCR-184',
  title: 'Customer Orders & tracking (portal.customer.orders)',
  view: CustomerCase,
  cases: [
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
        body: { kind: 'print', model: { state: 'ready', rows: ordersRead('OPEN').items, count: ordersRead('OPEN').count, seesPrices: true, filters: { chip: locale === 'it' ? 'Aperti' : 'Open', q: '' }, partyName: 'Brand Alpha S.r.l.', printedBy: 'Anna Esempio', printedAt: at(0), backHref: `${PREFIX}/orders` } },
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
