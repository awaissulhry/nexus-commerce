import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_COMPANIES } from '../../../../shell/design-data'
import type { PartyRow, QuoteListRow } from '../api'
import { NO_FILTERS, type QuoteTile, type TileCount } from '../model'
import { CAN, GRAINS, PARTY, PEOPLE, PREFIX } from '../record/fixtures'
import type { NewQuoteModel, QuotesListViewModel } from './list-model'
import { QuotesListView } from './view/QuotesListView'

/**
 * SCR-034 Quotes — made-up data only (PLAN §3.1): invented customers and numbers. Each case is one state the Owner
 * reviews: the list per role (the Owner and Finance see every money column; Sales sees prices and margin %), a tile
 * pressed, filters that match nothing, the New quote dialog, loading, an error, empty, and a role without quotes.
 */

const at = (day: number, hour: number) => new Date(Date.UTC(2026, 9, day, hour)).toISOString()
const id = (n: number) => `0190f0e2-9999-7000-8000-0000000001${String(n).padStart(2, '0')}`
const CUSTOMERS = ['Squadra Corse Fittizia S.r.l.', 'Moto Club Esempio', 'Negozio Demo Due S.n.c.', 'Mario Esempio', 'Concessionaria Fittizia Tre S.p.A.']

function row(n: number, extra: Partial<QuoteListRow>): QuoteListRow {
  return {
    id: id(n),
    number: `Q-2026-01${String(n).padStart(2, '0')}`,
    companyId: DEMO_COMPANIES[0].id,
    partyId: `0190f0e2-6666-7000-8000-00000000000${n % 5}`,
    partyName: CUSTOMERS[n % 5]!,
    customerRef: n % 2 === 0 ? `RFQ-00${n}` : null,
    status: 'DRAFT',
    revision: 1,
    lineCount: 2,
    units: 14,
    currency: 'EUR',
    netAmount: 624000,
    grossAmount: 761280,
    marginPct: '34.5357',
    marginFloorBreached: false,
    approval: null,
    validUntil: '2026-11-28',
    promiseDate: '2027-02-15',
    createdById: PEOPLE.sales,
    updatedAt: at(29 - (n % 5), 9 + n),
    version: 3,
    ...extra,
  }
}

export const ROWS: QuoteListRow[] = [
  row(42, {}),
  row(41, { status: 'PENDING_APPROVAL', approval: 'PENDING', marginPct: '18.9490', marginFloorBreached: true, netAmount: 504000, grossAmount: 614880 }),
  row(40, { status: 'SENT', revision: 2, approval: 'APPROVED', validUntil: '2026-11-03', units: 40, lineCount: 4, netAmount: 1824000, grossAmount: 2225280 }),
  row(39, { status: 'SENT', validUntil: '2026-11-25', createdById: PEOPLE.owner }),
  row(38, { status: 'ACCEPTED', units: 120, lineCount: 6, netAmount: 5400000, grossAmount: 6588000, marginPct: '29.1000' }),
  row(37, { status: 'DECLINED', marginPct: '31.0000' }),
  row(36, { status: 'APPROVED', approval: 'APPROVED', marginPct: '17.5000', marginFloorBreached: true }),
  row(35, { status: 'CANCELLED' }),
]

const priceOnly = (rows: QuoteListRow[]) => rows.map(({ marginPct: _m, marginFloorBreached: _b, ...rest }) => rest as QuoteListRow)

const TILES: Record<QuoteTile, TileCount> = {
  myDrafts: { count: 3, more: false },
  waiting: { count: 1, more: false },
  sent: { count: 2, more: false },
  expiring: { count: 1, more: false },
  accepted: { count: 4, more: false, value: 9120000 },
}
const UNKNOWN: Record<QuoteTile, TileCount> = { myDrafts: { count: null, more: false }, waiting: { count: null, more: false }, sent: { count: null, more: false }, expiring: { count: null, more: false }, accepted: { count: null, more: false } }

const RESULTS: PartyRow[] = [
  { id: PARTY.id, code: PARTY.code, legalName: PARTY.legalName, tradeName: PARTY.tradeName, status: 'ACTIVE', country: 'IT', taxMode: 'IT_B2B', vatNumber: 'IT00000000000', city: 'Milano', vies: { state: 'NOT_APPLICABLE' } },
  { id: '0190f0e2-6666-7000-8000-000000000002', code: 'C-DEMO-02', legalName: 'Rennteam Beispiel GmbH', tradeName: null, status: 'ACTIVE', country: 'DE', taxMode: 'EU_B2B', vatNumber: 'DE000000000', city: 'München', vies: { state: 'EXPIRED' } },
  { id: '0190f0e2-6666-7000-8000-000000000003', code: 'C-DEMO-03', legalName: 'Negozio Bloccato Demo', tradeName: null, status: 'BLOCKED', country: 'IT', taxMode: 'IT_B2B', vatNumber: 'IT00000000001', city: 'Torino', vies: { state: 'NOT_APPLICABLE' } },
]

const NEW: NewQuoteModel = { companies: DEMO_COMPANIES, companyId: DEMO_COMPANIES[0].id, results: RESULTS, searchProblem: null, party: null, partyProblem: null, contactId: '', customerRef: '', number: 'Q-2026-0143', busy: false, problem: null }

function model(overrides: Partial<QuotesListViewModel> = {}): QuotesListViewModel {
  return {
    prefix: PREFIX,
    me: PEOPLE.sales,
    grains: GRAINS.owner,
    can: { ...CAN.owner },
    filters: NO_FILTERS,
    rows: { items: ROWS, more: true, problem: null },
    tiles: TILES,
    asOf: at(29, 10),
    today: '2026-10-29',
    updates: 0,
    newQuote: null,
    notice: null,
    ...overrides,
  }
}

export const designScreen = defineDesignScreen<QuotesListViewModel>({
  screen: 'SCR-034',
  title: 'Quotes: the list, tiles, filters and New quote',
  view: QuotesListView,
  cases: [
    { id: 'owner', label: 'Owner · every quote, every money column', model: model(), note: 'Tiles are saved filters; the number is a real link; ⋯ opens, opens in a new tab or previews the PDF; "Show more" reads the next page.' },
    { id: 'sales', label: 'Sales · prices and margin %', model: model({ grains: GRAINS.sales, can: CAN.sales }), note: 'S2: margin % and "under the floor", never a cost.' },
    { id: 'finance', label: 'Finance · approves, does not make quotes', model: model({ grains: GRAINS.finance, can: CAN.finance }), note: 'New quote is held with the reason.' },
    { id: 'price-only', label: 'A role with prices only', model: model({ grains: GRAINS.priceOnly, can: CAN.viewer, rows: { items: priceOnly(ROWS), more: false, problem: null } }) },
    { id: 'selected', label: 'Rows selected: bulk actions in the toolbar', model: model({ selected: [id(42), id(39)], focusRow: 0 }), note: 'The header box is mixed; the toolbar swaps to Export 2 (CSV) and Cancel 2 quotes; x ticks the focused row, shift-click a range.' },
    { id: 'selected-held', label: 'Selected rows that cannot all be cancelled', model: model({ selected: [id(42), id(38)] }), note: 'An accepted quote is selected: Cancel is held with the reason before the click.' },
    { id: 'tile-waiting', label: 'Tile pressed: Waiting for approval', model: model({ filters: { ...NO_FILTERS, status: 'PENDING_APPROVAL' }, rows: { items: ROWS.filter((item) => item.status === 'PENDING_APPROVAL'), more: false, problem: null } }), note: 'The tile is pressed and its chip is in the filter row (one filter model); Clear all.' },
    { id: 'expiring', label: 'Tile pressed: Expiring in 7 days', model: model({ filters: { ...NO_FILTERS, status: 'SENT', expiring: true }, rows: { items: ROWS.filter((item) => item.status === 'SENT'), more: false, problem: null } }) },
    { id: 'updates', label: 'Live: 3 updates waiting', model: model({ updates: 3 }), note: 'Rows never move under the cursor: "3 updates · Show" reads them.' },
    { id: 'no-match', label: 'Filters match nothing', model: model({ filters: { ...NO_FILTERS, q: 'RFQ-9999', mine: true }, rows: { items: [], more: false, problem: null } }) },
    { id: 'empty', label: 'No quotes yet', model: model({ rows: { items: [], more: false, problem: null }, tiles: { ...TILES, myDrafts: { count: 0, more: false }, waiting: { count: 0, more: false }, sent: { count: 0, more: false }, expiring: { count: 0, more: false }, accepted: { count: 0, more: false, value: 0 } } }) },
    { id: 'new-quote', label: 'New quote: customer search', model: model({ grains: GRAINS.sales, can: CAN.sales, newQuote: NEW }), note: 'Customers by name, code or VAT; blocked and VIES warnings shown; the number it will get, before Create.' },
    { id: 'new-quote-picked', label: 'New quote: customer picked', model: model({ grains: GRAINS.sales, can: CAN.sales, newQuote: { ...NEW, party: PARTY, contactId: PARTY.contacts[0]!.id, customerRef: 'RFQ-0042' } }), note: 'The orders contact is pre-picked; ⌘↵ creates the draft and opens its Lines tab.' },
    { id: 'new-quote-blocked', label: 'New quote: a blocked customer (held)', model: model({ newQuote: { ...NEW, party: { ...PARTY, status: 'BLOCKED', legalName: 'Negozio Bloccato Demo', tradeName: null } } }) },
    { id: 'loading', label: 'Loading', model: model({ rows: { items: null, more: false, problem: null }, tiles: UNKNOWN, asOf: null }), note: 'Unknown counts show "—", never 0.' },
    { id: 'error', label: 'Error', model: model({ rows: { items: null, more: false, problem: 'problem.read.unavailable' }, tiles: UNKNOWN }) },
    { id: 'no-permission', label: 'No permission (direct address)', model: model({ rows: { items: null, more: false, problem: 'problem.read.forbidden' }, tiles: UNKNOWN, can: CAN.viewer }), note: 'The page is absent from the navigation; a direct address says the role does not allow it.' },
  ],
})
