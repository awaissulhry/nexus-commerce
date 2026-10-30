import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { BRANDS, CAN, COMPANY_ID, DEMO_PRICES, demoDuplicated, demoOffer, GRAINS, PREFIX, ROWS, SCALES, SIZES } from '../demo/fixtures'
import { blankDraft, draftFor, type DuplicateModel } from '../duplicate/duplicate-model'
import { pricesByStyle, type ListPrices, type NewStyleDraft, type StylesListViewModel } from './list-model'
import { StylesListView } from './view/StylesListView'

/**
 * SCR-040 Styles — made-up data only (PLAN §3.1): an invented factory's nine styles (jackets, trousers, gloves, a suit,
 * a vest; one archived, two drafts). Cases per role: the Owner and the product office (create, archive), the production
 * manager (makes BOM and routing; the list is the same), sales (reads; New style held with its reason).
 */

const open = ROWS.filter((row) => row.status !== 'ARCHIVED')
const PRICES: ListPrices = { state: 'ready', list: DEMO_PRICES.list, byStyle: pricesByStyle(DEMO_PRICES.entries) }
const base: StylesListViewModel = {
  prefix: PREFIX,
  can: CAN.owner,
  grains: GRAINS.owner,
  prices: PRICES,
  duplicate: null,
  filters: { view: 'open', q: '', type: '', ppe: '' },
  rows: { items: open, more: false, count: open.length, problem: null },
  tiles: { drafts: 2, waiting: 2, active: 6, archived: 1 },
  asOf: '2026-10-29T08:42:00.000Z',
  updates: 0,
  newStyle: null,
  busy: false,
  notice: null,
}

const draft: NewStyleDraft = {
  companyId: COMPANY_ID,
  code: '',
  name: '',
  productType: 'JACKET',
  season: '',
  brandPartyId: null,
  range: { sizeScaleId: SCALES[0]!.id, sizes: [], baseSize: null },
  ppe: { ppeCategory: 'CATEGORY_II', ppeStandard: null, ppeClass: null },
  mtmAllowed: false,
}
const filled: NewStyleDraft = {
  ...draft,
  code: 'DEMO-JKT-04',
  name: 'Giacca Adventure Demo',
  season: 'SS28',
  brandPartyId: BRANDS[0]!.id,
  range: { sizeScaleId: SCALES[0]!.id, sizes: SIZES.slice(0, 6), baseSize: '52' },
  ppe: { ppeCategory: 'CATEGORY_II', ppeStandard: 'EN 17092-3:2020', ppeClass: 'AA' },
}
const newStyle = (value: NewStyleDraft, extra: Partial<NonNullable<StylesListViewModel['newStyle']>> = {}): StylesListViewModel['newStyle'] => ({
  draft: value,
  companies: [
    { id: COMPANY_ID, name: 'Officina Demo S.r.l.' },
    { id: '0190f0e2-1111-7000-8000-000000000002', name: 'Pelletteria Esempio S.p.A.' },
  ],
  scales: SCALES,
  brands: BRANDS,
  busy: false,
  problem: null,
  refused: [],
  ...extra,
})

const SOURCE = { id: ROWS[0]!.id, code: 'DEMO-JKT-01', name: 'Giacca Touring Demo' }
const offer = demoOffer()
const duplicate = (extra: Partial<DuplicateModel> = {}): DuplicateModel => ({
  source: SOURCE,
  pick: null,
  offer: { status: 'ready', value: offer },
  draft: { ...draftFor(offer), code: 'DEMO-JKT-01-SS', name: 'Giacca Touring Demo Estiva', season: 'SS28' },
  busy: false,
  problem: null,
  refused: [],
  done: null,
  ...extra,
})
const heldOffer = demoOffer({ held: true, dropped: ['58'] })

export const designScreen = defineDesignScreen<StylesListViewModel>({
  screen: 'SCR-040',
  title: 'Styles',
  view: StylesListView,
  cases: [
    { id: 'owner', label: 'Owner: the open styles', model: base, note: 'Tiles = saved filters; the code is a real link; Revision shows "Rev 2 released · Rev 3 draft"; "Ready to make" counts what each style still lacks.' },
    { id: 'product', label: 'Product office', model: { ...base, can: CAN.product, grains: GRAINS.product, prices: { state: 'hidden' } }, note: 'The same list: creates, archives, exports. No price list right: no list price column.' },
    { id: 'production', label: 'Production manager', model: { ...base, can: CAN.production, grains: GRAINS.production, prices: { state: 'hidden' } }, note: 'No money anywhere on the list; the same columns.' },
    { id: 'sales', label: 'Sales (reads)', model: { ...base, can: CAN.sales, grains: GRAINS.sales }, note: 'New style held with its reason; Archive N held in the selection bar. List price and margin % (S2: never cost).' },
    { id: 'prices', label: 'W2a: list price and margin %', model: base, note: 'From the base price list in force (DEMO-LISTINO-27): "from" when only colourways are priced; "under the floor" below the sales margin floor; "Not priced" when the list has no row.' },
    { id: 'prices-none', label: 'W2a: no base price list in force', model: { ...base, prices: { state: 'none' } }, note: 'The columns stay; the head says no base list is in force.' },
    { id: 'prices-loading', label: 'W2a: prices being read', model: { ...base, prices: { state: 'loading' } } },
    { id: 'duplicate', label: 'W2a: Duplicate style', model: { ...base, duplicate: duplicate() }, note: 'New code and name, parts with what each holds (8 BOM lines and 9 steps of revision 2), labels from a shared label; pictures and options held (W2b); ⌘↵ duplicates.' },
    { id: 'duplicate-held', label: 'W2a: Duplicate: parts held', model: { ...base, duplicate: duplicate({ offer: { status: 'ready', value: heldOffer }, draft: { ...draftFor(heldOffer), code: 'DEMO-JKT-01-SS', name: 'Giacca Touring Demo Estiva', season: '' } }) }, note: 'Not made to measure; the label is the style\'s own (make one in Compliance); size 58 is archived in the scale: the copy leaves it out.' },
    { id: 'duplicate-loading', label: 'W2a: Duplicate: reading the offer', model: { ...base, duplicate: duplicate({ offer: { status: 'loading' }, draft: blankDraft() }) }, note: 'Duplicate held: "Reading what the copy can take".' },
    { id: 'duplicate-refused', label: 'W2a: Duplicate: code taken', model: { ...base, duplicate: duplicate({ draft: { ...draftFor(offer), code: 'DEMO-JKT-02', name: 'Giacca Touring Demo Estiva', season: '' }, problem: 'problem.write.codeTaken', refused: ['code'] }) } },
    { id: 'duplicate-done', label: 'W2a: Duplicate: the copy is made', model: { ...base, duplicate: duplicate({ done: demoDuplicated() }) }, note: 'What it took, what it left out in our words; Open the copy (a draft, revision 1 "Copied from DEMO-JKT-01 revision 2").' },
    { id: 'duplicate-pick', label: 'W2a: New style › Copy of a style', model: { ...base, duplicate: { source: null, pick: { query: 'giacca', results: ROWS.slice(0, 3), problem: null }, offer: null, draft: blankDraft(), busy: false, problem: null, refused: [], done: null } }, note: 'Start from: Copy of a style opens the picker; picking a style shows its parts.' },
    { id: 'duplicate-sales', label: 'W2a: Duplicate held (sales)', model: { ...base, can: CAN.sales, grains: GRAINS.sales, duplicate: duplicate() }, note: 'Duplicate held: "Not in your role".' },
    { id: 'phone', label: 'W2a: phone card list', model: { ...base, phone: true }, note: 'Below 720 px: a card per style (type sign, code and name, status, revision, range and SKUs, list price), Filters (n) and Select.' },
    { id: 'phone-select', label: 'W2a: phone select mode', model: { ...base, phone: true, phoneSelect: true, selected: [ROWS[1]!.id, ROWS[3]!.id] }, note: 'A box on each card, Select all (mixed), and the bulk actions: Export 2, Archive 2….' },
    { id: 'phone-filters', label: 'W2a: phone filters sheet', model: { ...base, phone: true, phoneFilters: true, filters: { view: 'waiting', q: '', type: 'JACKET', ppe: '' } }, note: 'Filters (2) opens the sheet: saved view, type, PPE; Clear all.' },
    { id: 'phone-empty', label: 'W2a: phone, nothing matches', model: { ...base, phone: true, filters: { view: 'open', q: 'zzz', type: '', ppe: '' }, rows: { items: [], more: false, count: 0, problem: null } } },
    { id: 'phone-error', label: 'W2a: phone, could not load', model: { ...base, phone: true, rows: { items: null, more: false, count: null, problem: 'problem.read.unavailable' } } },
    { id: 'selected', label: 'Two rows selected', model: { ...base, selected: [ROWS[1]!.id, ROWS[3]!.id] }, note: 'The toolbar swaps to the bulk actions: Export 2 (CSV), Archive 2…; the header box is mixed.' },
    { id: 'selected-held', label: 'Selection with an archived style', model: { ...base, filters: { ...base.filters, view: 'all' }, rows: { items: ROWS, more: false, count: ROWS.length, problem: null }, selected: [ROWS[2]!.id, ROWS[8]!.id] }, note: 'Archive is held: one of them is archived already.' },
    { id: 'tile-waiting', label: 'Tile: waiting for release', model: { ...base, filters: { ...base.filters, view: 'waiting' }, rows: { items: ROWS.filter((row) => row.draftRevision !== null && row.status !== 'ARCHIVED'), more: false, count: 3, problem: null } }, note: 'The pressed tile is the saved filter; its chip shows in the filter row.' },
    { id: 'filtered', label: 'Filtered: trousers, searched', model: { ...base, filters: { view: 'open', q: 'touring', type: 'TROUSERS', ppe: '' }, rows: { items: ROWS.filter((row) => row.code === 'DEMO-PNT-01'), more: false, count: 1, problem: null } } },
    { id: 'many', label: 'More than a page', model: { ...base, rows: { items: open, more: true, count: 134, problem: null } }, note: '"8 of 134" and Show more in the footer, beside the keys icon.' },
    { id: 'updates', label: 'Live changes waiting', model: { ...base, updates: 3 }, note: 'Rows never move under the cursor: "3 updates · Show".' },
    { id: 'notice', label: 'After archiving two', model: { ...base, notice: { key: 'notice.archivedMany', tone: 'success', params: { count: 2 } } } },
    { id: 'new-style', label: 'New style', model: { ...base, newStyle: newStyle(draft) }, note: 'Create is held until the code, name and scale are given; ⌘↵ creates.' },
    { id: 'new-style-filled', label: 'New style, filled', model: { ...base, newStyle: newStyle(filled) }, note: 'EN 17092-3 sets class AA by itself; base size 52 among the chips.' },
    { id: 'new-style-gloves', label: 'New style: gloves', model: { ...base, newStyle: newStyle({ ...filled, code: 'DEMO-GLV-02', name: 'Guanto Estivo Demo', productType: 'GLOVES', range: { sizeScaleId: SCALES[1]!.id, sizes: ['S', 'M', 'L', 'XL'], baseSize: 'L' }, ppe: { ppeCategory: 'CATEGORY_II', ppeStandard: 'EN 13594:2015', ppeClass: '1KP' } }) }, note: 'Gloves are offered EN 13594 only, with its levels.' },
    { id: 'new-style-refused', label: 'New style: code taken', model: { ...base, newStyle: newStyle({ ...filled, code: 'DEMO-JKT-01' }, { problem: 'problem.write.codeTaken', refused: ['code'] }) } },
    { id: 'no-match', label: 'Nothing matches', model: { ...base, filters: { view: 'open', q: 'zzz', type: '', ppe: '' }, rows: { items: [], more: false, count: 0, problem: null } } },
    { id: 'empty', label: 'No styles yet', model: { ...base, rows: { items: [], more: false, count: 0, problem: null }, tiles: { drafts: 0, waiting: 0, active: 0, archived: 0 } } },
    { id: 'empty-sales', label: 'No styles yet (sales)', model: { ...base, can: CAN.sales, rows: { items: [], more: false, count: 0, problem: null }, tiles: { drafts: 0, waiting: 0, active: 0, archived: 0 } } },
    { id: 'loading', label: 'Loading', model: { ...base, rows: { items: null, more: false, count: null, problem: null }, tiles: { drafts: null, waiting: null, active: null, archived: null }, asOf: null } },
    { id: 'error', label: 'Could not load', model: { ...base, rows: { items: null, more: false, count: null, problem: 'problem.read.unavailable' }, tiles: { drafts: null, waiting: null, active: null, archived: null } }, note: 'Never drawn as an empty list; the tiles say "—", not 0.' },
    { id: 'no-permission', label: 'No access', model: { ...base, can: { ...CAN.sales, view: false }, rows: { items: null, more: false, count: null, problem: 'problem.read.forbidden' }, tiles: {} } },
  ],
})
