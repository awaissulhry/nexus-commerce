import { createElement, type ReactNode } from 'react'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import type { Margins, OrderMargin, OrderMarginRow } from '../api'
import { marginsCanOf, type MarginsCan } from '../model'

/**
 * Made-up orders for the design cases of SCR-155 (Finance › Costing › Margins and its profitability DetailModal) and of
 * the sales order's Margin tab and Margin % column: an invented company ("Officina Demo S.r.l."), invented customers
 * ("Moto Demo S.r.l.", "Pista Demo S.p.A.", "Club Demo"), styles and orders; every figure worked out by hand (the sums are
 * in the comments). Nothing here is a real company, customer, article or number. Design-only.
 */

export const PREFIX = '/w/DEMO'
export const TODAY = '2026-10-30'
export const NOW = Date.parse('2026-10-30T08:40:00.000Z')
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const COMPANY = DEMO_COMPANIES[0].id

const BASE = ['home.view', 'threads.read', 'threads.post', 'files.read']
export const ROLES = {
  owner: [...OWNER_PERMISSIONS, 'costing.view', 'orders.view', 'workorders.view', 'money.price', 'money.cost', 'money.margin'],
  /** Finance: price, cost and margin. */
  finance: [...BASE, 'costing.view', 'orders.view', 'invoices.view', 'money.price', 'money.cost', 'money.margin'],
  /** Sales: price and margin %: never a cost amount (Owner answer S2). */
  sales: [...BASE, 'costing.view', 'orders.view', 'quotes.view', 'money.price', 'money.margin'],
  /** Buyer: costs only (no price, no margin). */
  buyer: [...BASE, 'costing.view', 'purchasing.view', 'money.cost'],
  /** Warehouse: no costing.view. */
  warehouse: [...BASE, 'inventory.stock.view', 'orders.view'],
} as const
export type Role = keyof typeof ROLES
export const canAs = (role: Role): MarginsCan => marginsCanOf(ROLES[role])

export function inShell(path: string, page: ReactNode, role: Role = 'finance'): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck(ROLES[role])),
    path,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

const MOTO = { id: uid('1212', 1), name: 'Moto Demo S.r.l.' }
const PISTA = { id: uid('1212', 2), name: 'Pista Demo S.p.A.' }
const CLUB = { id: uid('1212', 3), name: 'Club Demo' }
export const SO_1043 = uid('1313', 1043)
const SO_1044 = uid('1313', 1044)
const SO_1031 = uid('1313', 1031)
const SO_1050 = uid('1313', 1050)

const row = (over: Partial<OrderMarginRow> & { order: OrderMarginRow['order'] }): OrderMarginRow => ({
  currency: 'EUR',
  quotedValue: 0,
  value: 0,
  quotedCost: null,
  quotedMargin: null,
  quotedMarginPct: null,
  estimateCost: null,
  estimateMargin: null,
  estimateMarginPct: null,
  actualCost: 0,
  actualMargin: null,
  actualMarginPct: null,
  marginChange: null,
  final: false,
  started: false,
  workOrders: 0,
  belowFloor: null,
  method: 'UNDECIDED',
  provisional: true,
  ...over,
})
const order = (id: string, number: string, status: OrderMarginRow['order']['status'], party: typeof MOTO, orderDate: string, customerRef: string | null = null) => ({ id, number, status, orderDate, companyId: COMPANY, party, customerRef })

/**
 * SO-2026-1043 (Moto Demo, 12,000.00): quoted cost 6,840.00 → 5,160.00 (43.0 %); estimated now 7,180.00 → 4,820.00
 * (40.2 %): −340.00 since the quote (material −200.00, subcontract −60.00, overhead −80.00); so far 3,950.00.
 * SO-2026-1044 (Pista Demo, 8,500.00): 5,100.00 → 3,400.00 (40.0 %) quoted and now; nothing costed yet.
 * SO-2026-1031 (Moto Demo, 6,400.00, shipped): 3,840.00 → 2,560.00 (40.0 %) quoted; final 4,000.00 → 2,400.00 (37.5 %): −160.00.
 * SO-2026-1050 (Club Demo, 3,000.00): a line without a cost at quote, so its margin cannot be told.
 */
export const ROWS: OrderMarginRow[] = [
  row({ order: order(SO_1050, 'SO-2026-1050', 'CONFIRMED', CLUB, '2026-10-28'), quotedValue: 300000, value: 300000 }),
  row({ order: order(SO_1044, 'SO-2026-1044', 'CONFIRMED', PISTA, '2026-10-22', 'PO-PISTA-77'), quotedValue: 850000, value: 850000, quotedCost: 510000, quotedMargin: 340000, quotedMarginPct: '40.0000', estimateCost: 510000, estimateMargin: 340000, estimateMarginPct: '40.0000', marginChange: 0, workOrders: 1 }),
  row({ order: order(SO_1043, 'SO-2026-1043', 'IN_PRODUCTION', MOTO, '2026-10-06', 'ORD-MOTO-311'), quotedValue: 1200000, value: 1200000, quotedCost: 684000, quotedMargin: 516000, quotedMarginPct: '43.0000', estimateCost: 718000, estimateMargin: 482000, estimateMarginPct: '40.1667', actualCost: 395000, actualMargin: 805000, actualMarginPct: '67.0833', marginChange: -34000, started: true, workOrders: 2 }),
  row({ order: order(SO_1031, 'SO-2026-1031', 'SHIPPED', MOTO, '2026-09-15', 'ORD-MOTO-298'), quotedValue: 640000, value: 640000, quotedCost: 384000, quotedMargin: 256000, quotedMarginPct: '40.0000', estimateCost: 400000, estimateMargin: 240000, estimateMarginPct: '37.5000', actualCost: 400000, actualMargin: 240000, actualMarginPct: '37.5000', marginChange: -16000, started: true, final: true, workOrders: 1 }),
]

/** Average 10,620.00 ÷ 26,900.00 = 39.5 % over the three known; lost since the quote 340.00 + 0 + 160.00 = 500.00. */
export const MARGINS: Margins = {
  rows: ROWS,
  nextCursor: null,
  tiles: { averageMarginPct: '39.4796', belowFloor: null, marginLostSinceQuote: 50000, orders: 4, unknown: 1, currency: 'EUR', words: null },
  byCustomer: [
    { party: MOTO, orders: 2, value: 1840000, estimateCost: 1118000, marginPct: '39.2391' },
    { party: PISTA, orders: 1, value: 850000, estimateCost: 510000, marginPct: '40.0000' },
    { party: CLUB, orders: 1, value: 300000, estimateCost: null, marginPct: null },
  ],
  byStyle: [
    { style: { id: uid('3333', 1), code: 'DEMO-JKT-01', name: 'Giacca pelle demo' }, orders: 3, value: 2040000, estimateCost: 1248000, marginPct: '38.8235' },
    { style: { id: uid('3333', 2), code: 'DEMO-PNT-02', name: 'Pantalone pelle demo' }, orders: 2, value: 650000, estimateCost: 380000, marginPct: '41.5385' },
  ],
}

/** SO-1043's profitability: lines 9,600.00 + 2,400.00; costs at quote 5,472.00 + 1,368.00, now 5,744.00 + 1,436.00, so far 3,160.00 + 790.00. */
export const DETAIL_1043: OrderMargin = {
  ...ROWS[2]!,
  quoted: { value: 1200000, cost: 684000, parts: { material: 390000, labour: 230000, subcontract: 54000, overhead: 10000, adjustment: 0 }, margin: 516000, marginPct: '43.0000' },
  estimate: { value: 1200000, cost: 718000, parts: { material: 410000, labour: 230000, subcontract: 60000, overhead: 18000, adjustment: 0 }, margin: 482000, marginPct: '40.1667' },
  actual: { value: 1200000, cost: 395000, parts: { material: 260000, labour: 120000, subcontract: 0, overhead: 15000, adjustment: 0 }, margin: 805000, marginPct: '67.0833' },
  waterfall: [
    { reason: 'PRICE', amount: 0 },
    { reason: 'MATERIAL', amount: -20000 },
    { reason: 'LABOUR', amount: 0 },
    { reason: 'SUBCONTRACT', amount: -6000 },
    { reason: 'OVERHEAD', amount: -8000 },
    { reason: 'ADJUSTMENT', amount: 0 },
  ],
  leather: { quoted: 300000, actual: 205000 },
  freight: { cost: null, words: 'No freight cost is recorded on an order yet.' },
  lines: [
    { id: uid('1414', 1), seq: 1, style: { id: uid('3333', 1), code: 'DEMO-JKT-01', name: 'Giacca pelle demo' }, colourway: { id: uid('6666', 1), code: 'NERO' }, quantity: 40, closedShort: 0, inWorkOrders: 40, quotedValue: 960000, value: 960000, quotedCost: 547200, estimateCost: 574400, actualCost: 316000, quotedMarginPct: '43.0000', estimateMarginPct: '40.1667', actualMarginPct: '67.0833' },
    { id: uid('1414', 2), seq: 2, style: { id: uid('3333', 2), code: 'DEMO-PNT-02', name: 'Pantalone pelle demo' }, colourway: { id: uid('6666', 1), code: 'NERO' }, quantity: 12, closedShort: 2, inWorkOrders: 10, quotedValue: 240000, value: 240000, quotedCost: 136800, estimateCost: 143600, actualCost: 79000, quotedMarginPct: '43.0000', estimateMarginPct: '40.1667', actualMarginPct: '67.0833' },
  ],
  workOrderShares: [
    { workOrder: { id: uid('7777', 221), number: 'WO-2026-0221', kind: 'SIZE_GRID', status: 'IN_PROGRESS' }, pieces: 40, ofPieces: 40, done: false, plan: 'STANDARD', estimateCost: 574400, actualCost: 316000, method: 'UNDECIDED', provisional: true },
    { workOrder: { id: uid('7777', 225), number: 'WO-2026-0225', kind: 'SIZE_GRID', status: 'IN_PROGRESS' }, pieces: 10, ofPieces: 20, done: false, plan: 'ESTIMATE', estimateCost: 143600, actualCost: 79000, method: 'UNDECIDED', provisional: true },
  ],
  words: 'Provisional.',
}

const PRICE = new Set(['quotedValue', 'value'])
const COST = new Set(['quotedCost', 'estimateCost', 'actualCost', 'cost', 'material', 'labour', 'subcontract', 'overhead', 'adjustment'])
const MARGIN_PCT = new Set(['quotedMarginPct', 'estimateMarginPct', 'actualMarginPct', 'marginPct', 'averageMarginPct'])
const MARGIN_AMOUNT = new Set(['quotedMargin', 'estimateMargin', 'actualMargin', 'marginChange', 'margin', 'marginLostSinceQuote'])

/** What the API sends a person with these grains (each figure dropped without its grain; a margin amount also needs the cost grain). */
export function asSeenBy<T extends object>(value: T, can: Pick<MarginsCan, 'price' | 'cost' | 'margin'>): T {
  const drop = (key: string, inner: unknown, parent: string | null) => {
    if (typeof inner === 'object' && inner !== null) return false
    if (parent === 'leather' && (key === 'quoted' || key === 'actual')) return !can.cost
    if (parent === 'freight' && key === 'cost') return !can.cost
    if (PRICE.has(key)) return !can.price
    if (COST.has(key)) return !can.cost
    if (MARGIN_PCT.has(key)) return !can.margin
    if (MARGIN_AMOUNT.has(key)) return !(can.margin && can.cost)
    return false
  }
  const strip = (entry: unknown, parent: string | null): unknown => {
    if (Array.isArray(entry)) return entry.map((inner) => strip(inner, parent))
    if (entry === null || typeof entry !== 'object') return entry
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>)
        .filter(([key, inner]) => !drop(key, inner, parent))
        .map(([key, inner]) => [key, key === 'waterfall' && !(can.margin && can.cost) ? null : strip(inner, key)]),
    )
  }
  return strip(value, null) as T
}
