import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { asSeenBy, canAs, DETAIL_1043, inShell, MARGINS, NOW, PREFIX, ROWS, SO_1043, TODAY, type Role } from './demo/fixtures'
import { addressOf } from './model'
import { MarginsView, type MarginsModel } from './view/MarginsView'

/**
 * SCR-155 — Finance › Costing › Margins (design finance.margins) with made-up data only: the tiles (average margin %,
 * orders below the floor — W2b —, margin lost since the quote), each order's margin quoted → now and so far, By customer
 * and style (BarList; a bar filters the orders), the profitability DetailModal (bridge from price to margin, where the
 * margin went, by line, the work orders behind it; loading, failed), the rows chosen for Export N, and the states
 * (loading with "Still loading…", error, empty, nothing matching, offline) and roles: Finance and Owner (every figure),
 * Sales (price and margin %, never a cost amount: Owner answer S2), Buyer (costs, no price or margin), Warehouse (no
 * costing.view).
 */

interface Case {
  role: Role
  page: MarginsModel
}

const ADDRESS = addressOf(null)

const base = (role: Role, over: Partial<MarginsModel> = {}): Case => {
  const can = canAs(role)
  const margins = asSeenBy(MARGINS, can)
  return {
    role,
    page: {
      prefix: PREFIX,
      can,
      today: TODAY,
      address: ADDRESS,
      margins: { value: margins, problem: null, slow: false },
      rows: margins.rows,
      more: false,
      readAt: NOW - 60_000,
      live: 'live',
      updates: 0,
      detail: null,
      notice: null,
      ...over,
    },
  }
}

function MarginsDesign({ model }: { model: Case }) {
  return inShell('/finance/margins', createElement(MarginsView, { model: model.page }), model.role)
}

const detail = (role: Role) => ({ address: { ...ADDRESS, open: SO_1043 }, detail: { id: SO_1043, value: asSeenBy(DETAIL_1043, canAs(role)), problem: null } })
const moto = MARGINS.byCustomer[0]!.party.id

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-155',
  title: 'Margins: order margin from the quote to the actual, by customer and style',
  view: MarginsDesign,
  cases: [
    { id: 'finance', label: 'Finance · every order with its margin quoted → now and so far', model: base('finance'), note: 'Average 39.5 % = 10,620.00 ÷ 26,900.00 over the three orders whose cost is known; margin lost since the quote 500.00 = 340.00 (SO-1043) + 160.00 (SO-1031).' },
    { id: 'owner', label: 'Owner · the same page', model: base('owner') },
    { id: 'detail', label: 'SO-2026-1043 — profitability: from price to margin, where it went, J / K', model: base('finance', detail('finance')), note: 'Price 12,000.00 − material 4,100.00 − labour 2,300.00 − subcontract 600.00 − overhead 180.00 = 4,820.00 (40.2 %). Quoted 5,160.00 → material −200.00 → subcontract −60.00 → overhead −80.00 → now 4,820.00.' },
    { id: 'detail-loading', label: 'The profitability DetailModal reading', model: base('finance', { address: { ...ADDRESS, open: SO_1043 }, detail: { id: SO_1043, value: null, problem: null } }) },
    { id: 'detail-error', label: "The profitability DetailModal couldn't load: Try again", model: base('finance', { address: { ...ADDRESS, open: SO_1043 }, detail: { id: SO_1043, value: null, problem: 'problem.unavailable' } }) },
    { id: 'detail-sales', label: 'Sales · the profitability: margin % only, no cost amount, no bridge or waterfall', model: base('sales', detail('sales')) },
    { id: 'customer', label: 'A bar picked: only Moto Demo S.r.l.\'s orders', model: base('finance', { address: { ...ADDRESS, party: moto }, rows: ROWS.filter((row) => row.order.party.id === moto) }) },
    { id: 'period', label: 'Orders of October only', model: base('finance', { address: { ...ADDRESS, from: '2026-10-01', to: '2026-10-31' }, rows: ROWS.filter((row) => row.order.orderDate >= '2026-10-01') }) },
    { id: 'selected', label: 'Two orders chosen · Export 2 (CSV)', model: base('finance', { selected: [ROWS[1]!.order.id, ROWS[2]!.order.id] }) },
    { id: 'updates', label: 'Live · 2 cost events since the read', model: base('finance', { updates: 2 }) },
    { id: 'keys', label: 'Keys in the footer info icon', model: base('finance', { keysOpen: true, focusRow: 0 }) },
    { id: 'sales', label: 'Sales · the value and margin %, never a cost amount (Owner answer S2)', model: base('sales') },
    { id: 'buyer', label: 'Buyer · costs, no price and no margin: the margin tiles and bars say why', model: base('buyer') },
    { id: 'empty', label: 'No orders in this period', model: base('finance', { address: { ...ADDRESS, from: '2026-01-01', to: '2026-01-31' }, margins: { value: { ...MARGINS, rows: [], tiles: { ...MARGINS.tiles, orders: 0, unknown: 0, averageMarginPct: null, marginLostSinceQuote: null }, byCustomer: [], byStyle: [] }, problem: null, slow: false }, rows: [] }) },
    { id: 'no-match', label: 'Nothing matches the search', model: base('finance', { address: { ...ADDRESS, q: 'ZZZ' }, rows: [] }) },
    { id: 'loading', label: 'Loading · "Still loading…" after a second', model: base('finance', { margins: { value: null, problem: null, slow: true }, rows: null, readAt: null }) },
    { id: 'error', label: "Error · couldn't load, Try again (never drawn as empty)", model: base('finance', { margins: { value: null, problem: 'problem.unavailable', slow: false }, rows: null, readAt: null }) },
    { id: 'offline', label: 'Offline · reading again when back', model: base('finance', { live: 'offline' }) },
    { id: 'no-permission', label: 'Warehouse · no costing.view', model: base('warehouse', { margins: { value: null, problem: null, slow: false }, rows: null, readAt: null }) },
  ],
})
