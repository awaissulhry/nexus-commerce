import { createElement, type ReactNode } from 'react'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import type { Layers, Valuation, ValuationRow } from '../api'
import { reportsCanOf, type ReportsCan } from '../model'

/**
 * Made-up stock for the design cases of SCR-239 (Finance reports › Stock valuation, its "How this lot is valued" panel
 * and its print page): an invented company ("Officina Demo S.r.l."), two sites ("STAB-N", "STAB-S"), articles, lots and
 * work orders; every figure worked out by hand (the sums are in the comments). Nothing here is a real company, supplier,
 * article or number. Design-only (only fixtures and tests import it); it exports no `designScreen`.
 */

export const PREFIX = '/w/DEMO'
export const TODAY = '2026-10-30'
export const NOW = Date.parse('2026-10-30T08:40:00.000Z')
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
export const COMPANY = DEMO_COMPANIES[0].id
const NORD = { id: uid('2222', 1), code: 'STAB-N' }
const SUD = { id: uid('2222', 2), code: 'STAB-S' }
export const SITES = [NORD, SUD]

// ---- roles -------------------------------------------------------------------------------------------------------------------

const BASE = ['home.view', 'threads.read', 'threads.post', 'files.read']
export const ROLES = {
  owner: [...OWNER_PERMISSIONS, 'inventory.stock.view', 'workorders.view', 'money.price', 'money.cost', 'money.margin', 'accounting.view'],
  /** Finance: the stock and its values (the cost grain). */
  finance: [...BASE, 'inventory.stock.view', 'invoices.view', 'payments.view', 'accounting.view', 'accounting.export', 'accounting.lock', 'money.price', 'money.cost', 'money.margin'],
  /** Warehouse (and the planner): quantities, areas and hides, no value (no cost grain). */
  warehouse: [...BASE, 'inventory.stock.view', 'inventory.locations.view', 'workorders.view'],
  /** Sales: no stock permission here. */
  sales: [...BASE, 'orders.view', 'quotes.view', 'money.price', 'money.margin'],
} as const
export type Role = keyof typeof ROLES
export const canAs = (role: Role): ReportsCan => reportsCanOf(ROLES[role])

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

// ---- the stock on 30 October 2026 ----------------------------------------------------------------------------------------------

const item = (n: number, code: string, name: string, kind: string, baseUom: string, tracking: string) => ({ id: uid('5555', n), code, name, kind, baseUom, tracking })
const LEATHER = item(1, 'DEMO-LTH-01', 'Pelle bovina demo', 'LEATHER', 'FT2', 'HIDE')
const LINING = item(2, 'DEMO-LIN-02', 'Fodera rete demo', 'LINING', 'M', 'LOT')
const ZIP = item(3, 'DEMO-ZIP-03', 'Cerniera demo', 'TRIM', 'PCS', 'NONE')
const PROTECTOR = item(4, 'DEMO-PRT-04', 'Protezione spalla demo', 'PROTECTOR', 'PCS', 'LOT')
const BOX = item(5, 'DEMO-BOX-05', 'Scatola demo', 'PACKAGING', 'PCS', 'NONE')
const JACKET = item(6, 'DEMO-JKT-01', 'Giacca pelle demo', 'FINISHED', 'PCS', 'SERIAL')
const NERO = { id: uid('6666', 1), code: 'NERO', name: 'Nero' }
const MARRONE = { id: uid('6666', 2), code: 'MARRONE', name: 'Marrone' }
const LOT_101 = { id: uid('8888', 101), code: 'LOT-2026-0101' }
const LOT_102 = { id: uid('8888', 102), code: 'LOT-2026-0102' }
const LOT_088 = { id: uid('8888', 88), code: 'LOT-2026-0088' }
const LOT_090 = { id: uid('8888', 90), code: 'LOT-2026-0090' }

const stock = (over: Partial<ValuationRow> & Pick<ValuationRow, 'category' | 'site' | 'item' | 'quantity' | 'uom'>): ValuationRow => ({
  companyId: COMPANY,
  colour: null,
  lot: null,
  workOrder: null,
  hides: 0,
  areaM2: null,
  value: 0,
  unitCost: null,
  currency: 'EUR',
  methods: [],
  valued: 'FULL',
  unvaluedMoves: 0,
  dependsOnMethod: true,
  ...over,
})

export const ROWS: ValuationRow[] = [
  // 186.5 ft² × 4.20 = 783.30; 186.5 × 0.092903 = 17.3264 m²; 4 hides.
  stock({ category: 'LEATHER', site: NORD, item: LEATHER, colour: NERO, lot: LOT_101, quantity: '186.5000', uom: 'FT2', hides: 4, areaM2: '17.3264', value: 78330, unitCost: '4.200000', methods: ['PURCHASE_PRICE', 'LOT_COST'] }),
  // 92 ft² × 4.50 = 414.00; 92 × 0.092903 = 8.5471 m²; 2 hides.
  stock({ category: 'LEATHER', site: NORD, item: LEATHER, colour: MARRONE, lot: LOT_102, quantity: '92.0000', uom: 'FT2', hides: 2, areaM2: '8.5471', value: 41400, unitCost: '4.500000', methods: ['PURCHASE_PRICE'] }),
  // 120 m × 3.10 = 372.00.
  stock({ category: 'MATERIALS', site: NORD, item: LINING, colour: NERO, lot: LOT_088, quantity: '120.0000', uom: 'M', value: 37200, unitCost: '3.100000', methods: ['PURCHASE_PRICE', 'LOT_COST'] }),
  // 40 pieces of opening stock without a standard cost: counted, no value.
  stock({ category: 'MATERIALS', site: SUD, item: PROTECTOR, lot: LOT_090, quantity: '40.0000', uom: 'PCS', value: 0, unitCost: null, methods: [], valued: 'NONE', unvaluedMoves: 1 }),
  // 300 × 0.85 = 255.00 (untracked: the item's standard cost).
  stock({ category: 'TRIMS', site: NORD, item: ZIP, quantity: '300.0000', uom: 'PCS', value: 25500, unitCost: '0.850000', methods: ['STANDARD_COST'] }),
  // 50 × 1.20 = 60.00.
  stock({ category: 'PACKAGING', site: NORD, item: BOX, quantity: '50.0000', uom: 'PCS', value: 6000, unitCost: '1.200000', methods: ['STANDARD_COST'] }),
  // 6 × 220.00 = 1,320.00 (finished garments at the standard cost).
  stock({ category: 'FINISHED_GOODS', site: NORD, item: JACKET, colour: NERO, quantity: '6.0000', uom: 'PCS', value: 132000, unitCost: '220.000000', methods: ['STANDARD_COST'] }),
  // WIP: the work orders' cost ledgers (319.94 open; 12.50 left on a completed one).
  stock({ category: 'WIP', site: NORD, item: null, workOrder: { id: uid('9191', 42), number: 'WO-2026-0042', status: 'IN_PROGRESS', done: false }, quantity: null, uom: null, value: 31994, unitCost: null, methods: [] }),
  stock({ category: 'WIP', site: NORD, item: null, workOrder: { id: uid('9191', 39), number: 'WO-2026-0039', status: 'COMPLETED', done: true }, quantity: null, uom: null, value: 1250, unitCost: null, methods: [] }),
]

/**
 * Categories: leather 783.30 + 414.00 = 1,197.30; materials 372.00 + 0 = 372.00; trims 255.00; packaging 60.00;
 * finished goods 1,320.00; WIP 319.94 + 12.50 = 332.44. Total 3,536.74.
 */
export const VALUATION: Valuation = {
  asOf: null,
  asOfDay: null,
  rows: ROWS,
  categories: [
    { category: 'LEATHER', rows: 2, value: 119730, currency: 'EUR' },
    { category: 'MATERIALS', rows: 2, value: 37200, currency: 'EUR' },
    { category: 'TRIMS', rows: 1, value: 25500, currency: 'EUR' },
    { category: 'PACKAGING', rows: 1, value: 6000, currency: 'EUR' },
    { category: 'FINISHED_GOODS', rows: 1, value: 132000, currency: 'EUR' },
    { category: 'WIP', rows: 2, value: 33244, currency: 'EUR' },
  ],
  value: 353674,
  currency: 'EUR',
  residue: 0,
  unvaluedMoves: 1,
  methods: [{ companyId: COMPANY, method: 'UNDECIDED', provisional: true }],
  truncated: false,
}

/** As at 30 September: only the first receipt of lot 0101 (240 ft² × 4.20 = 1,008.00) and the trims (255.00): 1,263.00, and 0.03 left by rounding. */
export const VALUATION_SEPTEMBER: Valuation = {
  asOf: '2026-09-30T21:59:59.999Z',
  asOfDay: '2026-09-30',
  rows: [
    stock({ category: 'LEATHER', site: NORD, item: LEATHER, colour: NERO, lot: LOT_101, quantity: '240.0000', uom: 'FT2', hides: 5, areaM2: '22.2967', value: 100800, unitCost: '4.200000', methods: ['PURCHASE_PRICE'] }),
    stock({ category: 'TRIMS', site: NORD, item: ZIP, quantity: '300.0000', uom: 'PCS', value: 25500, unitCost: '0.850000', methods: ['STANDARD_COST'] }),
  ],
  categories: [
    { category: 'LEATHER', rows: 1, value: 100800, currency: 'EUR' },
    { category: 'TRIMS', rows: 1, value: 25500, currency: 'EUR' },
  ],
  value: 126300,
  currency: 'EUR',
  residue: 3,
  unvaluedMoves: 0,
  methods: [{ companyId: COMPANY, method: 'UNDECIDED', provisional: true }],
  truncated: false,
}

export const EMPTY: Valuation = { ...VALUATION, rows: [], categories: [], value: 0, residue: 0, unvaluedMoves: 0, asOf: '2025-12-31T22:59:59.999Z', asOfDay: '2025-12-31' }

/** The API's answer for a person without the cost grain: every value field absent (never zero). */
export function withoutCost(valuation: Valuation): Valuation {
  const strip = <T extends object>(entry: T): T => Object.fromEntries(Object.entries(entry).filter(([key]) => !['value', 'unitCost', 'residue'].includes(key))) as T
  return { ...strip(valuation), rows: valuation.rows.map(strip), categories: valuation.categories.map(strip) } as Valuation
}

/** Lot 0101: received 240 ft² at PO-2026-0007's 4.20 (1,008.00); 53.5 ft² issued to WO-2026-0042 at the lot's 4.20 (224.70): 186.5 ft², 783.30. */
export const LAYERS_101: Layers = {
  asOf: null,
  site: NORD,
  item: LEATHER,
  lot: { id: LOT_101.id, code: LOT_101.code, qualityStatus: 'RELEASED' },
  quantity: '186.5000',
  value: 78330,
  unitCost: '4.200000',
  lotCost: '4.200000',
  currency: 'EUR',
  opening: { quantity: '0.0000', value: 0 },
  layers: [
    {
      moveId: uid('4444', 1),
      reason: 'RECEIPT',
      occurredAt: '2026-10-02T08:15:00.000Z',
      day: '2026-10-02',
      reference: 'GR-2026-0011',
      hide: null,
      quantity: '240.0000',
      method: 'PURCHASE_PRICE',
      unitCost: '4.200000',
      value: 100800,
      receipt: { id: uid('4545', 11), number: 'GR-2026-0011' },
      purchaseOrder: { id: uid('4646', 7), number: 'PO-2026-0007', unitPrice: '4.2000', uom: 'FT2', currency: 'EUR' },
      balanceQuantity: '240.0000',
      balanceValue: 100800,
      reversalOfId: null,
    },
    {
      moveId: uid('4444', 2),
      reason: 'ISSUE',
      occurredAt: '2026-10-09T13:40:00.000Z',
      day: '2026-10-09',
      reference: 'WO-2026-0042',
      hide: { id: uid('4747', 3), code: 'H-0003' },
      quantity: '-53.5000',
      method: 'LOT_COST',
      unitCost: '4.200000',
      value: -22470,
      receipt: null,
      purchaseOrder: null,
      balanceQuantity: '186.5000',
      balanceValue: 78330,
      reversalOfId: null,
    },
  ],
  complete: true,
  method: { companyId: COMPANY, method: 'UNDECIDED', provisional: true },
  dependsOnMethod: true,
}

export const KEY_101 = `stock|${NORD.id}|${LEATHER.id}|${NERO.id}|${LOT_101.id}`
