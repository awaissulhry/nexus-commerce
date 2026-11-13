import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { ARCHIVED_DETAIL, BASE_DETAIL, DETAIL, DETAIL_IN_FORCE_ONLY, GROUP_DETAIL, inShell, recordModel, STYLE_DETAIL, V1, V1_ENTRIES, V2, v1Prices, type PriceListRole } from '../_demo/fixtures'
// B-W2b-343: Breaks & surcharges, Valid from–to.
import { breaksModel, MINIMUMS, RULES, RULES_V1, V2_DATED } from '../_demo/fixtures'
import { emptyBreak, emptyMinimum, emptySurcharge } from '../depth/model'
import type { PriceListRecordModel } from './record-model'
import { PriceListRecordView } from './view/PriceListRecordView'

/**
 * SCR-106 — a price list record (design sales.pricelists "Record: Price list"; B-W2a-49) with made-up data only: a
 * customer list whose version 1 is in force (it ends on 20 November) with version 2 as a draft (+4 % on the jackets, a
 * glove added). Every tab — Prices (autosave per cell on the draft; standard cost with the cost grain, margin % with the
 * margin grain, under the floor toned; Raise by % reviewed before it is written), Customers, Versions (changed rows,
 * activate, compare), Activity — every dialog, the read-only reasons, and the states. Roles: Owner (cost and margin),
 * Sales (margin %, no cost: Owner S2), Finance (reads), Read-only (no money), Planner (no access).
 */

interface RecordCase {
  role: PriceListRole
  record: PriceListRecordModel
}

const recordCase = (role: PriceListRole, over: Partial<PriceListRecordModel> = {}): RecordCase => ({ role, record: recordModel(role, over) })

function PriceListDesign({ model }: { model: RecordCase }) {
  const list = model.record.list.status === 'ready' ? model.record.list.value : DETAIL
  return inShell(`/sales/price-lists/${list.id}`, createElement(PriceListRecordView, { model: model.record }), model.role)
}

const ids = (n: number) => recordModel('owner').prices.answer!.entries.slice(0, n).map((entry) => entry.id)

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-106-record',
  title: 'Price list (record)',
  view: PriceListDesign,
  cases: [
    { id: 'prices-draft', label: 'Prices: the draft version 2, typed in place (Owner: cost and margin)', model: recordCase('owner'), note: 'Each price saves when its cell is left; JKT-DEMO-02 is under the margin floor.' },
    { id: 'prices-sales', label: 'Prices: Sales sees margin %, never the cost (Owner S2)', model: recordCase('sales') },
    {
      id: 'prices-in-force',
      label: 'Prices: version 1 in force — its prices stay; Make next version',
      model: recordCase('sales', { list: { status: 'ready', value: DETAIL_IN_FORCE_ONLY }, versionId: V1.id, prices: v1Prices('sales') }),
    },
    { id: 'prices-v1-with-draft', label: 'Prices: version 1 picked while a draft waits ("Go to the draft")', model: recordCase('sales', { versionId: V1.id, prices: v1Prices('sales') }) },
    { id: 'prices-saving', label: 'A price saving, another refused', model: recordCase('owner', { cells: { [ids(2)[0]!]: 'saving', [ids(2)[1]!]: 'failed' }, notice: { tone: 'warning', words: { key: 'prices.invalid', params: { style: 'JKT-DEMO-01' } } } }) },
    { id: 'prices-search', label: 'Prices: searched a style', model: recordCase('sales', { q: 'GLV' }) },
    { id: 'prices-selected', label: 'Three prices selected: Raise 3 by %, Remove 3', model: recordCase('sales', { selectedPrices: ids(3) }) },
    { id: 'raise', label: 'Raise 3 by 4 %: each price now → new, with its new margin (Owner)', model: recordCase('owner', { selectedPrices: ids(3), dialog: { kind: 'raise', pct: '4' } }) },
    { id: 'raise-invalid', label: 'Raise by %: not a percent (held with the reason)', model: recordCase('sales', { selectedPrices: ids(2), dialog: { kind: 'raise', pct: '-120' } }) },
    { id: 'remove', label: 'Remove 2 prices (they fall back to the base list)', model: recordCase('sales', { selectedPrices: ids(2), dialog: { kind: 'removePrices' } }) },
    { id: 'add-search', label: 'Add a price: search a style', model: recordCase('sales', { dialog: { kind: 'addPrice' } }) },
    {
      id: 'add-chosen',
      label: 'Add a price: a style picked, one colourway, the price typed',
      model: recordCase('sales', { dialog: { kind: 'addPrice' }, stylePick: { query: 'VST', results: [], problem: null, chosen: STYLE_DETAIL, colourwayId: STYLE_DETAIL.colourways[1]!.id, price: '189,00' } }),
    },
    { id: 'prices-no-money', label: 'Prices: a role without selling prices (Read-only)', model: recordCase('readOnly') },
    { id: 'prices-empty', label: 'Prices: a new draft with none yet', model: recordCase('sales', { prices: { answer: { version: V2, entries: [] }, problem: null, loading: false } }) },
    { id: 'prices-error', label: "Prices couldn't be read (the record stays usable)", model: recordCase('sales', { prices: { answer: null, problem: 'problem.read.unavailable', loading: false } }) },
    { id: 'customers', label: 'Customers: who gets this list', model: recordCase('sales', { tab: 'customers' }) },
    { id: 'customers-group', label: 'Customers of a group list, two selected: Remove 2', model: recordCase('sales', { tab: 'customers', list: { status: 'ready', value: GROUP_DETAIL }, selectedCustomers: GROUP_DETAIL.customers.slice(0, 2).map((customer) => customer.id) }) },
    { id: 'customers-add', label: 'Add customers: two picked', model: recordCase('sales', { tab: 'customers', dialog: { kind: 'addCustomers' }, customerPick: { ...recordModel('sales').customerPick, picked: [recordModel('sales').customerPick.results![1]!.id, recordModel('sales').customerPick.results![2]!.id] } }) },
    // B-W2b-16: the customers' "From" (the column above) and the day chosen when adding.
    { id: 'customers-add-from', label: 'Add customers from an earlier day (the "From" the history keeps)', model: recordCase('sales', { tab: 'customers', dialog: { kind: 'addCustomers' }, customerPick: { ...recordModel('sales').customerPick, from: '2026-10-15', picked: [recordModel('sales').customerPick.results![1]!.id] } }) },
    { id: 'customers-add-later', label: 'Add customers from a later day: held (today or earlier)', model: recordCase('sales', { tab: 'customers', dialog: { kind: 'addCustomers' }, customerPick: { ...recordModel('sales').customerPick, from: '2026-12-01', picked: [recordModel('sales').customerPick.results![1]!.id] } }) },
    { id: 'customers-add-same-day', label: 'Add customers refused: a customer whose list changed today already (one list per day)', model: recordCase('sales', { tab: 'customers', dialog: { kind: 'addCustomers' }, dialogProblem: { key: 'customers.refusedDay' }, customerPick: { ...recordModel('sales').customerPick, picked: [recordModel('sales').customerPick.results![1]!.id] } }) },
    { id: 'customers-base', label: 'Customers of the base list: none needed; lists falling back to it', model: recordCase('owner', { tab: 'customers', list: { status: 'ready', value: BASE_DETAIL } }) },
    { id: 'customers-finance', label: 'Customers: Finance reads (Add held with the reason)', model: recordCase('finance', { tab: 'customers' }) },
    { id: 'versions', label: 'Versions: v2 draft, v1 in force; changed rows', model: recordCase('sales', { tab: 'versions' }) },
    { id: 'activate', label: 'Activate version 2 from 21 Nov: version 1 ends on 20 Nov', model: recordCase('sales', { tab: 'versions', dialog: { kind: 'activate', validFrom: '2026-11-21', validTo: '' } }) },
    { id: 'activate-past', label: 'Activate refused before the click: back in time', model: recordCase('sales', { tab: 'versions', dialog: { kind: 'activate', validFrom: '2026-10-01', validTo: '' } }) },
    {
      id: 'activate-later',
      label: 'Activate held: a later version would be cut away',
      model: recordCase('sales', {
        tab: 'versions',
        list: { status: 'ready', value: { ...DETAIL, versions: [V2, { ...V1, validFrom: '2026-12-01', validTo: null }] } },
        dialog: { kind: 'activate', validFrom: '2026-11-21', validTo: '' },
      }),
    },
    { id: 'compare', label: 'Compare version 1 → version 2: 4 rows changed', model: recordCase('sales', { tab: 'versions', dialog: { kind: 'compare' } }) },
    { id: 'compare-loading', label: 'Compare: reading', model: recordCase('sales', { tab: 'versions', dialog: { kind: 'compare' }, compare: { beforeId: V1.id, afterId: V2.id, answer: null, problem: null, loading: true } }) },
    { id: 'activity', label: 'Activity (thread, files, history)', model: recordCase('sales', { tab: 'activity' }) },
    { id: 'archive', label: 'Archive (a list that prices nobody)', model: recordCase('owner', { list: { status: 'ready', value: { ...DETAIL, customers: [] } }, dialog: { kind: 'archive' } }) },
    { id: 'archived', label: 'Archived: read only until reactivated', model: recordCase('owner', { list: { status: 'ready', value: ARCHIVED_DETAIL }, versionId: ARCHIVED_DETAIL.versions[0]!.id, prices: { answer: { version: ARCHIVED_DETAIL.versions[0]!, entries: V1_ENTRIES }, problem: null, loading: false } }) },
    { id: 'activated', label: 'After Activate: what it ended, in words', model: recordCase('sales', { notice: { tone: 'success', words: { key: 'activate.doneEnded', params: { revision: 2, from: '21 nov 2026', ended: 1, to: '20 nov 2026' } } } }) },
    { id: 'changed', label: 'Changed by someone else while a dialog was open', model: recordCase('sales', { changedAt: '2026-10-30T08:50:00.000Z' }) },
    { id: 'finance', label: 'Finance: reads the prices and versions (no changes)', model: recordCase('finance', { versionId: V1.id, prices: v1Prices('finance') }) },
    { id: 'keys', label: 'The keys (?)', model: recordCase('sales', { dialog: { kind: 'help' } }) },
    { id: 'loading', label: 'Loading', model: recordCase('sales', { list: { status: 'loading' }, asOf: null, live: 'connecting' }) },
    { id: 'not-found', label: 'Not found', model: recordCase('sales', { list: { status: 'not_found' } }) },
    { id: 'error', label: "The list couldn't be read", model: recordCase('sales', { list: { status: 'error', problem: 'problem.read.unavailable' } }) },
    { id: 'no-permission', label: 'Planner: no pricelists.view', model: recordCase('planner', { list: { status: 'forbidden' } }) },
    // ---- B-W2b-343: Breaks & surcharges, Valid from–to ----------------------------------------------------------------
    { id: 'breaks', label: 'Breaks & surcharges: the draft version 2 (Owner)', model: recordCase('owner', { tab: 'breaks' }), note: "Quantity breaks (a price's own, or a discount on every price), size surcharges as SizeColumns (every style, one style, a style's own), the minimums, the discount on documents." },
    { id: 'breaks-sales', label: 'Breaks & surcharges: Sales changes the draft', model: recordCase('sales', { tab: 'breaks', breaks: breaksModel('sales') }) },
    { id: 'breaks-selected', label: 'Two breaks selected: Remove 2; a minimum selected: Archive 1', model: recordCase('sales', { tab: 'breaks', breaks: breaksModel('sales', { selectedBreaks: RULES.breaks.slice(0, 2).map((row) => row.id), selectedMinimums: [MINIMUMS[0]!.id] }) }) },
    { id: 'breaks-saving', label: 'A break saving, a surcharge refused (said in words)', model: recordCase('owner', { tab: 'breaks', breaks: breaksModel('owner', { cells: { [`${RULES.breaks[0]!.id}:unitPrice`]: 'saving' }, notice: { tone: 'warning', words: { key: 'breaks.held.lower', params: { price: '436,80 €' } } } }) }) },
    { id: 'breaks-in-force', label: 'Version 1 in force: its rules read only, said why', model: recordCase('sales', { tab: 'breaks', versionId: V1.id, prices: v1Prices('sales'), breaks: breaksModel('sales', { version: V1, rules: { status: 'ready', value: RULES_V1 }, held: { key: 'held.activeHasDraft', params: { revision: 1 } } }) }) },
    { id: 'breaks-no-price', label: 'A role without selling prices: the rules held with the reason', model: recordCase('readOnly', { tab: 'breaks', breaks: breaksModel('readOnly') }) },
    { id: 'breaks-empty', label: 'A new draft without breaks or surcharges', model: recordCase('sales', { tab: 'breaks', breaks: breaksModel('sales', { rules: { status: 'ready', value: { ...RULES, breaks: [], sizeSurcharges: [], styleSurcharges: [] } }, minimums: { status: 'ready', value: [] } }) }) },
    { id: 'breaks-loading', label: 'Breaks & surcharges while read', model: recordCase('sales', { tab: 'breaks', breaks: breaksModel('sales', { rules: { status: 'loading' }, minimums: { status: 'loading' } }) }) },
    { id: 'breaks-error', label: "The rules couldn't be read (the record stays usable)", model: recordCase('sales', { tab: 'breaks', breaks: breaksModel('sales', { rules: { status: 'error', problem: 'problem.read.unavailable' } }) }) },
    { id: 'add-break', label: 'Add a break: JKT-DEMO-01 from 20 pieces at 420', model: recordCase('sales', { tab: 'breaks', dialog: { kind: 'addBreak', draft: { entryId: RULES.breaks[0]!.entryId!, minQuantity: '20', kind: 'PRICE', value: '420' } } }) },
    { id: 'add-break-held', label: 'Add a break held: a break must lower the price', model: recordCase('sales', { tab: 'breaks', dialog: { kind: 'addBreak', draft: { entryId: RULES.breaks[0]!.entryId!, minQuantity: '30', kind: 'PRICE', value: '440' } } }) },
    { id: 'add-break-every', label: 'Add a break on every price (a discount)', model: recordCase('sales', { tab: 'breaks', dialog: { kind: 'addBreak', draft: { ...emptyBreak(), minQuantity: '200', value: '5' } } }) },
    { id: 'remove-breaks', label: 'Remove 2 breaks', model: recordCase('sales', { tab: 'breaks', breaks: breaksModel('sales', { selectedBreaks: RULES.breaks.slice(0, 2).map((row) => row.id) }), dialog: { kind: 'removeBreaks' } }) },
    { id: 'add-surcharge', label: 'Add a surcharge: sizes 60, 62 + 30 € for every style', model: recordCase('sales', { tab: 'breaks', dialog: { kind: 'addSurcharge', draft: { ...emptySurcharge(), sizes: '60, 62', value: '30' } } }) },
    { id: 'add-minimum', label: 'New minimum: a material, 30 pcs per colourway, warn', model: recordCase('sales', { tab: 'breaks', dialog: { kind: 'addMinimum', draft: { ...emptyMinimum(), subject: 'MATERIAL', itemId: '', minQuantity: '30', per: 'COLOURWAY' } } }) },
    { id: 'add-minimum-surcharge', label: 'New minimum: vests per order, small-run surcharge', model: recordCase('sales', { tab: 'breaks', dialog: { kind: 'addMinimum', draft: { ...emptyMinimum(), subject: 'PRODUCT_TYPE', productType: 'VEST', minQuantity: '10', per: 'ORDER', action: 'SURCHARGE', surcharge: '8' } } }) },
    { id: 'add-minimum-twin', label: 'New minimum held: an active twin exists', model: recordCase('sales', { tab: 'breaks', dialog: { kind: 'addMinimum', draft: { ...emptyMinimum(), styleId: MINIMUMS[0]!.styleId!, minQuantity: '8', per: 'LINE' } } }) },
    { id: 'prices-dated', label: 'Prices › Valid from–to: GLV-DEMO-01 priced by season', model: recordCase('owner', { prices: { answer: { version: V2, entries: V2_DATED }, problem: null, loading: false } }), note: 'A dated price is written with its days (the dated prices); the others autosave per cell as before.' },
    { id: 'days', label: "A price's days: a new first day (its own breaks go with the old row)", model: recordCase('owner', { prices: { answer: { version: V2, entries: V2_DATED }, problem: null, loading: false }, dialog: { kind: 'days', entryId: V2_DATED.find((row) => row.validTo === '2027-02-28')!.id, validFrom: '2026-12-01', validTo: '2027-02-28', price: '69,50' } }) },
    { id: 'days-overlap', label: "A price's days held: they meet the next season's price", model: recordCase('owner', { prices: { answer: { version: V2, entries: V2_DATED }, problem: null, loading: false }, dialog: { kind: 'days', entryId: V2_DATED.find((row) => row.validTo === '2027-02-28')!.id, validFrom: '2026-11-21', validTo: '2027-03-15', price: '69,50' } }) },
    { id: 'add-dated', label: 'Add a price with days of its own', model: recordCase('sales', { dialog: { kind: 'addPrice' }, stylePick: { query: 'VST', results: [], problem: null, chosen: STYLE_DETAIL, colourwayId: '', price: '189,00', validFrom: '2027-03-01', validTo: '' } }) },
  ],
})
