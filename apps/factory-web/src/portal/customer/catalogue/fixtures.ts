import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { Locale } from '../../../lib/i18n/locales'
import { at, catalogueRead, orderingWords, PREFIX, shellOf, STYLES, styleDetail } from '../neworder/design-data'
import { newOrderHref } from '../neworder/model'
import { OrderingCase, type OrderingCaseBuilder } from '../neworder/view/OrderingCase'
import { catalogueBandOf } from './band'
import { NO_FILTERS } from './model'
import type { CatalogueViewModel } from './view/CatalogueView'

/**
 * SCR-226 › Catalogue (design portal.customer.catalogue: sec:filters, sec:styles, pop:style-detail, tab:size-chart and
 * tab:public-doc held with the reason; B-W2b-194), MADE-UP data only: the styles as cards and as the list (select-all,
 * "Add N to the order"), filters with counts, nothing matching, nothing open yet, loading, a failed read, a role without
 * prices, a colleague who may not order, no connection, "Catalogue updated · Show", the style detail (J / K) and its states,
 * the phone's Filters (n), and the page for a person without it.
 */

type Over = Partial<CatalogueViewModel>

function page(build: (locale: Locale) => Over = () => ({}), startHeld: string | null = null): OrderingCaseBuilder {
  return (locale) => {
    const words = orderingWords(locale)
    const over = build(locale)
    const read = over.read === undefined ? catalogueRead() : over.read
    const view: CatalogueViewModel = {
      state: 'ready',
      read,
      filters: NO_FILTERS,
      view: 'cards',
      prefix: PREFIX,
      filtersOpen: false,
      selected: [],
      addHeld: startHeld,
      offlineSince: null,
      updated: false,
      detail: null,
      ...over,
    }
    const band = catalogueBandOf({ words, asOf: read?.asOf ?? null, start: newOrderHref(PREFIX), startHeld: view.addHeld ? words.t(view.addHeld) : null })
    return { shell: shellOf(locale, band, '/catalogue'), body: { kind: 'catalogue', model: view } }
  }
}

const IDS = STYLES.map((style) => style.id)
const detail = (over: Partial<NonNullable<CatalogueViewModel['detail']>> = {}): NonNullable<CatalogueViewModel['detail']> => ({
  state: 'ready',
  id: IDS[0]!,
  detail: styleDetail(),
  ids: IDS,
  addHeld: null,
  sheetHref: `${PREFIX}/catalogue/${IDS[0]}/sheet`,
  ...over,
})

export const designScreen = defineDesignScreen<OrderingCaseBuilder>({
  screen: 'SCR-226',
  title: 'Catalogue (portal.customer.catalogue)',
  view: OrderingCase,
  cases: [
    { id: 'cards', label: 'Styles you can buy, as cards', model: page(), note: 'Name, code, your label or open range, the certificate class, type and season, colours, size range, “from” price (price grain), Add to order.' },
    { id: 'list', label: 'The same fields as a list', model: page(() => ({ view: 'list' })), note: 'The shared list frame; keys in the footer’s info icon.' },
    { id: 'list-selected', label: 'Two styles selected', model: page(() => ({ view: 'list', selected: [IDS[0]!, IDS[1]!] })), note: 'The bulk action takes the search’s place: Add 2 to the order (opens the draft with them).' },
    { id: 'filtered', label: 'Filters on', model: page(() => ({ filters: { ...NO_FILTERS, category: 'JACKET', range: 'OWN_LABEL' }, read: catalogueRead({ styles: [STYLES[0]!] }) })), note: 'Chips with counts; Clear all.' },
    { id: 'filters-phone', label: 'The phone’s Filters (n) open', model: page(() => ({ filters: { ...NO_FILTERS, season: 'FW27' }, filtersOpen: true, read: catalogueRead({ styles: [STYLES[0]!, STYLES[1]!] }) })), note: 'On a phone the chips sit behind “Filters (1)”.' },
    { id: 'no-match', label: 'Nothing matches', model: page(() => ({ filters: { ...NO_FILTERS, q: 'XYZ-999' }, read: catalogueRead({ styles: [] }) })) },
    { id: 'empty', label: 'No styles open yet', model: page(() => ({ read: { ...catalogueRead({ styles: [] }), total: 0, facets: { categories: [], seasons: [], ppe: [], ownLabel: 0, openRange: 0 } } })), note: '“No styles are open to you yet. Ask us.”' },
    { id: 'loading', label: 'Loading', model: page(() => ({ state: 'loading', read: null })) },
    { id: 'error', label: 'The catalogue could not be read', model: page(() => ({ state: 'error', read: null })), note: 'Never drawn as an empty catalogue.' },
    { id: 'no-prices', label: 'A colleague without prices', model: page(() => ({ read: catalogueRead({}, false) })), note: 'No price anywhere and one quiet line.' },
    { id: 'may-not-order', label: 'A colleague who may not order (designer)', model: page(() => ({ read: catalogueRead({}, false) }), 'held.mayNotOrder'), note: '“Add to order” and “Start an order” held with the reason.' },
    { id: 'offline', label: 'No connection', model: page(() => ({ offlineSince: at(-1) }), 'held.offline') },
    { id: 'updated', label: 'Catalogue updated · Show', model: page(() => ({ updated: true })), note: 'Prices or styles changed since the page was read: nothing moves until Show.' },
    { id: 'detail', label: 'pop:style-detail', model: page(() => ({ detail: detail() })), note: 'Colours with the sizes each offers and its price; the certificate; size chart and public declaration held with the reason; the style sheet in a new tab; J / K; Enter adds.' },
    { id: 'detail-no-prices', label: 'The detail without prices', model: page(() => ({ read: catalogueRead({}, false), detail: detail({ detail: styleDetail(false) }) })) },
    { id: 'detail-loading', label: 'The detail loading', model: page(() => ({ detail: detail({ state: 'loading', detail: null }) })) },
    { id: 'detail-error', label: 'The detail could not be read', model: page(() => ({ detail: detail({ state: 'error', detail: null }) })) },
    { id: 'keys', label: 'The keys in the footer’s info icon', model: page(() => ({ view: 'list', keysOpen: true })) },
    {
      id: 'no-access',
      label: 'Not part of the person’s access',
      model: (locale) => ({ shell: shellOf(locale, { title: orderingWords(locale).t('catalogue.title') }, '/catalogue'), body: { kind: 'noAccess', admins: ['Paolo Esempio'] } }),
      note: 'A typed or old address (a supplier, a role without the catalogue): who to ask, and Home.',
    },
  ],
})
