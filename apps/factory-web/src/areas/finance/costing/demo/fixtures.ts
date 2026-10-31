import { createElement, type ReactNode } from 'react'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import type { CostTiles, LedgerEntry, MethodView, StandardCost, WorkOrderCost, WorkOrderCostRow } from '../api'
import { costingCanOf, type CostingCan } from '../model'

/**
 * Made-up costs for the design cases of SCR-154 (Finance › Costing › Standard vs actual, its cost DetailModal, the reverse
 * dialog and the print page) and of the work order's Labour & cost tab: an invented company ("Officina Demo S.r.l."), one
 * site ("STAB-N"), styles, work orders and materials; every figure worked out by hand (the sums are in the comments).
 * Nothing here is a real company, supplier, article or number. Design-only (only fixtures and tests import it).
 */

export const PREFIX = '/w/DEMO'
export const TODAY = '2026-10-30'
export const NOW = Date.parse('2026-10-30T08:40:00.000Z')
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const COMPANY = DEMO_COMPANIES[0].id
export const SITE = { id: uid('2222', 1), code: 'STAB-N' }
export const SITES = [SITE, { id: uid('2222', 2), code: 'STAB-S' }]

// ---- roles -------------------------------------------------------------------------------------------------------------------

const BASE = ['home.view', 'threads.read', 'threads.post', 'files.read']
export const ROLES = {
  owner: [...OWNER_PERMISSIONS, 'costing.view', 'costing.ledger.manage', 'workorders.view', 'product.styles.view', 'inventory.stock.view', 'money.price', 'money.cost', 'money.margin'],
  /** Finance: every figure (cost, price, margin) and Reverse entry. */
  finance: [...BASE, 'costing.view', 'costing.ledger.manage', 'costing.standards.manage', 'inventory.stock.view', 'product.styles.view', 'invoices.view', 'money.price', 'money.cost', 'money.margin'],
  /** Production manager: costing.view without a money grain (minutes and quantities only), work orders. */
  manager: [...BASE, 'costing.view', 'workorders.view', 'inventory.stock.view', 'product.styles.view'],
  /** Sales: costing.view with price and margin, no cost grain: no amount here. */
  sales: [...BASE, 'costing.view', 'orders.view', 'quotes.view', 'workorders.view', 'money.price', 'money.margin'],
  /** Warehouse: no costing.view at all. */
  warehouse: [...BASE, 'inventory.stock.view', 'workorders.view'],
} as const
export type Role = keyof typeof ROLES
export const canAs = (role: Role): CostingCan => costingCanOf(ROLES[role])

/** The Office shell around a page at this address (the role's navigation). */
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

// ---- the work orders --------------------------------------------------------------------------------------------------------

const STYLE_JKT = { id: uid('3333', 1), code: 'DEMO-JKT-01', name: 'Giacca pelle demo' }
const STYLE_PNT = { id: uid('3333', 2), code: 'DEMO-PNT-02', name: 'Pantalone pelle demo' }
const LEATHER = { id: uid('5555', 1), code: 'DEMO-LTH-01', name: 'Pelle bovina demo', baseUom: 'FT2' }
const LINING = { id: uid('5555', 2), code: 'DEMO-LIN-02', name: 'Fodera rete demo', baseUom: 'M' }
export const WO_221 = uid('7777', 221)
const WO_225 = uid('7777', 225)
const WO_198 = uid('7777', 198)
const WO_230 = uid('7777', 230)

const row = (over: Partial<WorkOrderCostRow> & { workOrder: WorkOrderCostRow['workOrder'] }): WorkOrderCostRow => ({
  currency: 'EUR',
  method: 'UNDECIDED',
  provisional: true,
  basis: 'STANDARD',
  standardTotal: null,
  estimateTotal: null,
  estimateComplete: true,
  actualTotal: 0,
  movedToStock: 0,
  variance: null,
  variancePct: null,
  biggestReason: null,
  over: false,
  final: false,
  entries: 0,
  ...over,
})
const wo = (id: string, number: string, status: string, style: typeof STYLE_JKT, pieces: number, completedAt: string | null = null) => ({ id, number, status, companyId: COMPANY, siteId: SITE.id, style, pieces, releasedAt: '2026-10-08T07:00:00.000Z', completedAt })

/**
 * WO-2026-0221 (40 jackets, in progress): standard 4,600.00 (material 3,600.00 = 900 ft² × 3.90 + 30 m × 3.00; labour
 * 1,000.00 = 4,000 min × 0.25); actual so far 5,028.00 (leather 980 ft² × 4.10 = 4,018.00 + lining 90.00; labour 3,680
 * min earned × 0.25 = 920.00); variance +428.00 = +9.3 % (price +196.00, usage +312.00, labour −80.00): over standard.
 */
export const ROWS: WorkOrderCostRow[] = [
  row({ workOrder: wo(WO_221, 'WO-2026-0221', 'IN_PROGRESS', STYLE_JKT, 40), standardTotal: 460000, estimateTotal: 455000, actualTotal: 502800, variance: 42800, variancePct: '9.3043', biggestReason: 'MATERIAL_USAGE', over: true, entries: 7 }),
  row({ workOrder: wo(WO_225, 'WO-2026-0225', 'IN_PROGRESS', STYLE_PNT, 20), basis: 'ESTIMATE', estimateTotal: 185000, actualTotal: 112040, variance: -72960, variancePct: '-39.4378', biggestReason: 'LABOUR', entries: 4 }),
  row({ workOrder: wo(WO_198, 'WO-2026-0198', 'COMPLETED', STYLE_JKT, 20, '2026-10-24T15:10:00.000Z'), standardTotal: 240000, estimateTotal: 238000, actualTotal: 235200, movedToStock: 230000, variance: -4800, variancePct: '-2.0000', biggestReason: 'MATERIAL_USAGE', final: true, entries: 12 }),
  row({ workOrder: wo(WO_230, 'WO-2026-0230', 'RELEASED', STYLE_PNT, 12), basis: null, estimateTotal: 90000, estimateComplete: false }),
]

/** Over standard: WO-0221 only; variance this month: WO-0198 completed in October, −48.00; stock 18,450.30 with 2 moves unvalued. */
export const TILES: CostTiles = { overStandard: 1, varianceThisMonth: -4800, stockValue: 1845030, unvaluedMoves: 2, wipValue: null, currency: 'EUR', month: '2026-10', words: null }

export const DETAIL_221: WorkOrderCost = {
  ...ROWS[0]!,
  standard: { material: 360000, labour: 100000, subcontract: 0, overhead: 0, total: 460000 },
  standardMissing: [],
  estimate: { material: 355000, labour: 100000, subcontract: 0, overhead: 0, total: 455000, complete: true, missing: [] },
  actual: { material: 410800, labour: 92000, subcontract: 0, overhead: 0, adjustment: 0, total: 502800, movedToStock: 0, onWorkOrder: 502800, scrapLost: 0, scrapFromStock: 0 },
  bridge: [
    { reason: 'MATERIAL_PRICE', amount: 19600 },
    { reason: 'MATERIAL_USAGE', amount: 31200 },
    { reason: 'SCRAP', amount: 0 },
    { reason: 'LABOUR', amount: -8000 },
    { reason: 'SUBCONTRACT', amount: 0 },
    { reason: 'OVERHEAD', amount: 0 },
    { reason: 'ADJUSTMENT', amount: 0 },
  ],
  parts: [
    { part: 'MATERIAL', planned: 360000, actual: 410800, variance: 50800, perGarment: 10270 },
    { part: 'LABOUR', planned: 100000, actual: 92000, variance: -8000, perGarment: 2300 },
    { part: 'SUBCONTRACT', planned: 0, actual: 0, variance: 0, perGarment: 0 },
    { part: 'OVERHEAD', planned: 0, actual: 0, variance: 0, perGarment: 0 },
  ],
  perGarment: { planned: 11500, actual: 12570 },
  materials: [
    {
      item: LEATHER,
      plannedQuantity: '900.0000',
      issuedQuantity: '980.0000',
      unitCost: '4.100000',
      standardUnitCost: '3.900000',
      amount: 401800,
      lots: [
        { lotId: uid('8888', 101), lotCode: 'LOT-2026-0101', hideId: uid('9999', 1), hideCode: 'H-0101-01', quantity: '500.0000', amount: 205000 },
        { lotId: uid('8888', 101), lotCode: 'LOT-2026-0101', hideId: uid('9999', 2), hideCode: 'H-0101-02', quantity: '480.0000', amount: 196800 },
      ],
    },
    { item: LINING, plannedQuantity: '30.0000', issuedQuantity: '30.0000', unitCost: '3.000000', standardUnitCost: '3.000000', amount: 9000, lots: [{ lotId: uid('8888', 88), lotCode: 'LOT-2026-0088', hideId: null, hideCode: null, quantity: '30.0000', amount: 9000 }] },
  ],
  labour: [
    { operation: { id: uid('aaaa', 10), seq: 10, code: 'CUT', name: 'Taglio', workCentreKind: 'CUTTING' }, plannedMinutes: '800.0000', earnedMinutes: '800.0000', perMinute: '0.250000', amount: 20000 },
    { operation: { id: uid('aaaa', 20), seq: 20, code: 'SEW', name: 'Cucitura', workCentreKind: 'SEWING' }, plannedMinutes: '2400.0000', earnedMinutes: '2280.0000', perMinute: '0.250000', amount: 57000 },
    { operation: { id: uid('aaaa', 30), seq: 30, code: 'FIN', name: 'Rifinitura', workCentreKind: 'FINISHING' }, plannedMinutes: '800.0000', earnedMinutes: '600.0000', perMinute: '0.250000', amount: 15000 },
  ],
  scrap: [],
  waitingItems: [{ code: 'NOT_VALUED', sourceType: 'StockMove', sourceId: uid('4444', 9), words: 'A move has no value yet.' }],
  words: 'Provisional.',
}

/** The same work order as a person without the cost grain reads it (minutes and quantities, no amount). */
export function withoutCost<T extends object>(value: T): T {
  const MONEY = new Set(['standardTotal', 'estimateTotal', 'actualTotal', 'movedToStock', 'variance', 'variancePct', 'material', 'labour', 'subcontract', 'overhead', 'adjustment', 'total', 'onWorkOrder', 'scrapLost', 'scrapFromStock', 'amount', 'planned', 'actual', 'perGarment', 'unitCost', 'standardUnitCost', 'perMinute', 'value', 'varianceThisMonth', 'stockValue', 'wipValue', 'materialCost', 'labourCost', 'subcontractCost', 'overheadCost'])
  const strip = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(strip)
    if (entry === null || typeof entry !== 'object') return entry
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>)
        .filter(([key, inner]) => !(MONEY.has(key) && (inner === null || typeof inner === 'number' || typeof inner === 'string')))
        .map(([key, inner]) => [key, strip(inner)]),
    )
  }
  return strip(value) as T
}

// ---- standards ----------------------------------------------------------------------------------------------------------------

const standard = (n: number, item: StandardCost['item'], source: StandardCost['source'], parts: { material: string; labour: string; total: string; minutes: string | null }): StandardCost => ({
  id: uid('bbbb', n),
  companyId: COMPANY,
  item,
  validFrom: '2026-10-01',
  validTo: null,
  status: 'FROZEN',
  source,
  currency: 'EUR',
  materialCost: parts.material,
  labourCost: parts.labour,
  subcontractCost: '0.000000',
  overheadCost: '0.000000',
  unitCost: parts.total,
  labourMinutes: parts.minutes,
  note: null,
  inForce: true,
  frozenAt: '2026-09-30T16:00:00.000Z',
  version: 2,
})

/** A jacket in size 50 and 52: material 90.00 (≈ 22.5 ft² × 3.90 + 0.75 m × 3.00) + labour 25.00 (100 min × 0.25) = 115.00. */
export const STANDARDS: StandardCost[] = [
  standard(1, { id: uid('cccc', 1), code: 'DEMO-JKT-01-NERO-50', name: 'Giacca pelle demo · Nero 50', kind: 'FINISHED', baseUom: 'PCS' }, 'ROLLUP', { material: '90.000000', labour: '25.000000', total: '115.000000', minutes: '100.0000' }),
  standard(2, { id: uid('cccc', 2), code: 'DEMO-JKT-01-NERO-52', name: 'Giacca pelle demo · Nero 52', kind: 'FINISHED', baseUom: 'PCS' }, 'ROLLUP', { material: '92.500000', labour: '25.000000', total: '117.500000', minutes: '100.0000' }),
  standard(3, { id: LEATHER.id, code: LEATHER.code, name: LEATHER.name, kind: 'LEATHER', baseUom: 'FT2' }, 'PURCHASE', { material: '3.900000', labour: '0.000000', total: '3.900000', minutes: null }),
  standard(4, { id: LINING.id, code: LINING.code, name: LINING.name, kind: 'LINING', baseUom: 'M' }, 'PURCHASE', { material: '3.000000', labour: '0.000000', total: '3.000000', minutes: null }),
]

// ---- the cost ledger (October) ----------------------------------------------------------------------------------------------

const entry = (n: number, over: Partial<LedgerEntry> & Pick<LedgerEntry, 'kind' | 'event' | 'day'>): LedgerEntry => ({
  id: uid('dddd', n),
  workOrder: { id: WO_221, number: 'WO-2026-0221' },
  occurredAt: `${over.day}T09:00:00.000Z`,
  item: null,
  quantity: null,
  minutes: null,
  unitCost: null,
  standardUnitCost: null,
  amount: 0,
  currency: 'EUR',
  method: 'UNDECIDED',
  provisional: true,
  standardId: null,
  document: null,
  reversalOfId: null,
  reversedBy: null,
  reason: null,
  createdAt: `${over.day}T09:00:01.000Z`,
  ...over,
})

/** WO-0221's entries, newest first: 2,050.00 + 1,968.00 + 90.00 + 460.00 + 460.00 + 6.00 − 6.00 = 5,028.00 (its actual). */
export const LEDGER: LedgerEntry[] = [
  entry(7, { kind: 'LABOUR', event: 'LABOUR', day: '2026-10-27', minutes: '1840.0000', unitCost: '0.250000', amount: 46000, document: { type: 'OperationScan', id: uid('eeee', 2), label: 'B-0221-004 · 20 SEW' } }),
  entry(6, { kind: 'MATERIAL', event: 'REVERSAL', day: '2026-10-23', item: LINING, quantity: '-2.0000', unitCost: '3.000000', amount: -600, reversalOfId: uid('dddd', 5), reason: 'Issued to the wrong work order', document: { type: 'WorkOrderCostEntry', id: uid('dddd', 5), label: 'ISS-2026-0144' } }),
  entry(5, { kind: 'MATERIAL', event: 'ISSUE', day: '2026-10-22', item: LINING, quantity: '2.0000', unitCost: '3.000000', standardUnitCost: '3.000000', amount: 600, reversedBy: { id: uid('dddd', 6), occurredAt: '2026-10-23T09:00:00.000Z', reason: 'Issued to the wrong work order' }, document: { type: 'StockMove', id: uid('4444', 5), label: 'ISS-2026-0144' } }),
  entry(4, { kind: 'LABOUR', event: 'LABOUR', day: '2026-10-20', minutes: '1840.0000', unitCost: '0.250000', amount: 46000, document: { type: 'OperationScan', id: uid('eeee', 1), label: 'B-0221-001 · 20 SEW' } }),
  entry(3, { kind: 'MATERIAL', event: 'ISSUE', day: '2026-10-14', item: LINING, quantity: '30.0000', unitCost: '3.000000', standardUnitCost: '3.000000', amount: 9000, document: { type: 'StockMove', id: uid('4444', 3), label: 'ISS-2026-0121' } }),
  entry(2, { kind: 'MATERIAL', event: 'ISSUE', day: '2026-10-14', item: LEATHER, quantity: '480.0000', unitCost: '4.100000', standardUnitCost: '3.900000', amount: 196800, document: { type: 'StockMove', id: uid('4444', 2), label: 'ISS-2026-0120' } }),
  entry(1, { kind: 'MATERIAL', event: 'ISSUE', day: '2026-10-12', item: LEATHER, quantity: '500.0000', unitCost: '4.100000', standardUnitCost: '3.900000', amount: 205000, document: { type: 'StockMove', id: uid('4444', 1), label: 'ISS-2026-0112' } }),
]

export const METHOD_UNDECIDED: MethodView = { companyId: COMPANY, from: 'COMPANY', method: 'UNDECIDED', provisional: true, locked: false, lockedAt: null, firstEntryAt: '2026-10-12T09:00:00.000Z', entries: 23 }
export const METHOD_STANDARD: MethodView = { ...METHOD_UNDECIDED, method: 'STANDARD', provisional: false, locked: true, lockedAt: '2026-10-12T09:00:00.000Z' }
