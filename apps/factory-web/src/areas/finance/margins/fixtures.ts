import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { asSeenBy, canAs, DETAIL_1043, inShell, MARGINS, NOW, PREFIX, ROLES, ROWS, SO_1043, TODAY, type Role } from './demo/fixtures'
// B-W2b-416: the order's documents (FIN-053) and the floor (FIN-050) in the design cases.
import { DOCUMENTS_1043, DOCUMENTS_NONE, documentsAsSeenBy } from './documents/demo'
import { addressOf } from './model'
import { MarginsView, type MarginsModel } from './view/MarginsView'
import type { OrderMargin } from './api'

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
      documents: null,
      notice: null,
      ...over,
    },
  }
}

function MarginsDesign({ model }: { model: Case }) {
  return inShell('/finance/margins', createElement(MarginsView, { model: model.page }), model.role)
}

const detail = (role: Role) => ({ address: { ...ADDRESS, open: SO_1043 }, detail: { id: SO_1043, value: asSeenBy(DETAIL_1043, canAs(role)), problem: null }, documents: { orderId: SO_1043, value: documentsAsSeenBy(DOCUMENTS_1043, ROLES[role]), problem: null } })
const below = ROWS.filter((row) => row.belowFloor === true)
const SO_1050 = ROWS[0]!
const SO_1031 = ROWS[3]!
const none = { cost: null, parts: null, margin: null, marginPct: null }
/** SO-2026-1050: no cost at quote, nothing made: every stage unknown. */
const DETAIL_1050: OrderMargin = { ...DETAIL_1043, ...SO_1050, quoted: { value: 300000, ...none }, estimate: { value: 300000, ...none }, actual: { value: 300000, ...none, cost: 0 }, waterfall: null, leather: { quoted: null, actual: 0 }, lines: [], workOrderShares: [] }
/** SO-2026-1031: quoted 3,840.00 (material 2,300.00, labour 1,200.00, subcontract 240.00, overhead 100.00); final 4,000.00 (material 2,400.00, subcontract 300.00): −160.00. */
const DETAIL_1031: OrderMargin = {
  ...DETAIL_1043,
  ...SO_1031,
  floor: { ...SO_1031.floor!, quotedBelow: true },
  quoted: { value: 640000, cost: 384000, parts: { material: 230000, labour: 120000, subcontract: 24000, overhead: 10000, adjustment: 0 }, margin: 256000, marginPct: '40.0000' },
  estimate: { value: 640000, cost: 400000, parts: { material: 240000, labour: 120000, subcontract: 30000, overhead: 10000, adjustment: 0 }, margin: 240000, marginPct: '37.5000' },
  actual: { value: 640000, cost: 400000, parts: { material: 240000, labour: 120000, subcontract: 30000, overhead: 10000, adjustment: 0 }, margin: 240000, marginPct: '37.5000' },
  waterfall: [
    { reason: 'PRICE', amount: 0 },
    { reason: 'MATERIAL', amount: -10000 },
    { reason: 'LABOUR', amount: 0 },
    { reason: 'SUBCONTRACT', amount: -6000 },
    { reason: 'OVERHEAD', amount: 0 },
    { reason: 'ADJUSTMENT', amount: 0 },
  ],
  leather: { quoted: 180000, actual: 186000 },
  lines: [],
  workOrderShares: [],
}
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
    { id: 'empty', label: 'No orders in this period', model: base('finance', { address: { ...ADDRESS, from: '2026-01-01', to: '2026-01-31' }, margins: { value: { ...MARGINS, rows: [], tiles: { ...MARGINS.tiles, orders: 0, unknown: 0, averageMarginPct: null, belowFloor: 0, marginLostSinceQuote: null }, byCustomer: [], byStyle: [] }, problem: null, slow: false }, rows: [] }) },
    { id: 'no-match', label: 'Nothing matches the search', model: base('finance', { address: { ...ADDRESS, q: 'ZZZ' }, rows: [] }) },
    { id: 'loading', label: 'Loading · "Still loading…" after a second', model: base('finance', { margins: { value: null, problem: null, slow: true }, rows: null, readAt: null }) },
    { id: 'error', label: "Error · couldn't load, Try again (never drawn as empty)", model: base('finance', { margins: { value: null, problem: 'problem.unavailable', slow: false }, rows: null, readAt: null }) },
    { id: 'offline', label: 'Offline · reading again when back', model: base('finance', { live: 'offline' }) },
    { id: 'no-permission', label: 'Warehouse · no costing.view', model: base('warehouse', { margins: { value: null, problem: null, slow: false }, rows: null, readAt: null }) },
    // B-W2b-416 (FIN-050, FIN-053, KA3:01): the floor and the documents.
    { id: 'w2b-floor-below', label: 'Orders below the floor · the tile pressed: only those, a chip clears it', model: base('finance', { address: { ...ADDRESS, floor: 'below' }, rows: below }), note: 'SO-2026-1043: 40.2 % estimated now against the Sales role\'s 42 %; SO-2026-1031: final 37.5 % against the company\'s 40 %.' },
    { id: 'w2b-floor-sales', label: 'Sales · the floor flag and the tile (the margin grain), no cost', model: base('sales') },
    { id: 'w2b-documents', label: 'SO-2026-1043 — every document: invoices, credit note, costs, freight, payments, each a link', model: base('finance', detail('finance')), note: 'Net 5,700.00 = 6,000.00 of FT-2026-0488 (it also bills SO-2026-1044) − 300.00; paid 5,600.00; freight charged 75.00, the carrier 38.50 (the second shipment not yet).' },
    { id: 'w2b-documents-owner', label: 'Owner · the same documents', model: base('owner', detail('owner')) },
    { id: 'w2b-documents-sales', label: 'Sales · documents with prices, no cost amount', model: base('sales', detail('sales')) },
    { id: 'w2b-documents-held', label: 'Buyer · costs only: invoices, freight and payments held with the permission they need', model: base('buyer', detail('buyer')) },
    { id: 'w2b-documents-loading', label: 'The documents reading', model: base('finance', { ...detail('finance'), documents: { orderId: SO_1043, value: null, problem: null } }) },
    { id: 'w2b-documents-error', label: "The documents couldn't load: Try again (never drawn as empty)", model: base('finance', { ...detail('finance'), documents: { orderId: SO_1043, value: null, problem: 'problem.unavailable' } }) },
    {
      id: 'w2b-documents-none',
      label: 'SO-2026-1050 — no document yet; the floor not known (no cost yet)',
      model: base('finance', {
        address: { ...ADDRESS, open: SO_1050.order.id },
        detail: { id: SO_1050.order.id, value: DETAIL_1050, problem: null },
        documents: { orderId: SO_1050.order.id, value: DOCUMENTS_NONE(SO_1050.order.id, SO_1050.order.number), problem: null },
      }),
    },
    {
      id: 'w2b-floor-final-quoted',
      label: 'SO-2026-1031 — final margin under the floor; its quote was approved under it',
      model: base('finance', {
        address: { ...ADDRESS, open: SO_1031.order.id },
        detail: { id: SO_1031.order.id, value: DETAIL_1031, problem: null },
        documents: { orderId: SO_1031.order.id, value: DOCUMENTS_NONE(SO_1031.order.id, SO_1031.order.number), problem: null },
      }),
    },
  ],
})
