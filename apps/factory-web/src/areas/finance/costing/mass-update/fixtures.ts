import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { MassApplyView, MassPreviewView, MaterialRow } from './api'
import { massAbilitiesOf, type PriceRow } from './model'
import { MassUpdateDialog, type MassUpdateModel } from './view/MassUpdateDialog'

/**
 * SCR-505 — Finance › Costing › Mass cost update (B-W2b-430), made-up data only: the invented leather DEMO-LEA-01 from 3.20 to
 * 3.45 a ft² (+7.81 %) and lining DEMO-LIN-01 from 4.50 to 4.80 a m; two cost sheet series, one revision without a sheet, two
 * price list entries and two open order lines of invented customers.
 */

const as = <T,>(value: unknown): T => value as T
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const owner = massAbilitiesOf(['costing.view', 'costing.massUpdate.apply', 'product.materials.view', 'money.cost', 'money.price', 'money.margin'])
const costOnly = massAbilitiesOf(['costing.view', 'product.materials.view', 'money.cost'])
const noGrain = massAbilitiesOf(['costing.view'])

const material = (n: number, code: string, name: string, uom: string, price: string): MaterialRow =>
  as<MaterialRow>({ id: uid('4400', n), companyId: null, code, name, nameI18n: null, kind: 'LEATHER', sourcing: 'BUY', tracking: 'LOT', baseUom: uom, purchaseUom: uom, consumptionUom: uom, defaultSupplier: null, supplierArticleCode: null, isPpeComponent: false, requiresCrViTest: false, crViLimitMgKg: null, standardCost: price, currency: 'EUR', colourCount: 1, status: 'ACTIVE', version: 3, updatedAt: '2026-11-01T08:00:00.000Z' })
const RESULTS = [material(1, 'DEMO-LEA-01', 'Vacchetta esempio 1,2 mm', 'FT2', '3.200000'), material(2, 'DEMO-LEA-02', 'Vacchetta esempio 1,4 mm', 'FT2', '3.600000')]
const ROWS: PriceRow[] = [
  { itemId: uid('4400', 1), code: 'DEMO-LEA-01', name: 'Vacchetta esempio 1,2 mm', baseUom: 'FT2', currency: 'EUR', priceNow: '3.200000', newPrice: '3,45' },
  { itemId: uid('4400', 3), code: 'DEMO-LIN-01', name: 'Fodera rete', baseUom: 'M', currency: 'EUR', priceNow: '4.500000', newPrice: '4.80' },
]

const sizeMove = (size: string, before: string, after: string) => ({ size, before, after, move: (Number(after) - Number(before)).toFixed(6) })
const PREVIEW = as<MassPreviewView>({
  on: '2026-11-14',
  materials: [
    { itemId: uid('4400', 1), code: 'DEMO-LEA-01', name: 'Vacchetta esempio 1,2 mm', baseUom: 'FT2', currency: 'EUR', priceNow: '3.200000', newPrice: '3.450000', changePct: '7.81', version: 3 },
    { itemId: uid('4400', 3), code: 'DEMO-LIN-01', name: 'Fodera rete', baseUom: 'M', currency: 'EUR', priceNow: '4.500000', newPrice: '4.800000', changePct: '6.67', version: 2 },
  ],
  series: [
    { key: 'COST_SHEET:A:JKT01:none', style: { id: uid('7777', 101), code: 'DEMO-JKT-01', name: 'Giacca Esempio Touring' }, companyId: uid('1111', 1), seasonId: null, sheet: { id: uid('8800', 3), sheetVersion: 3, state: 'DRAFT', revisionId: uid('7777', 22), baseSize: '52', version: 2 }, state: 'RECOMPUTED', words: 'x', stored: '155.350000', sizes: [sizeMove('52', '155.350000', '158.055000')], baseSize: sizeMove('52', '155.350000', '158.055000'), weighted: { before: '157.948000', after: '160.690000' }, missing: [] },
    { key: 'COST_SHEET:A:JKT02:AI27', style: { id: uid('7777', 102), code: 'DEMO-JKT-02', name: 'Giacca Esempio Estate' }, companyId: uid('1111', 1), seasonId: uid('5500', 1), sheet: { id: uid('8800', 12), sheetVersion: 2, state: 'APPROVED', revisionId: uid('7777', 42), baseSize: '50', version: 4 }, state: 'INCOMPLETE', words: 'x', stored: '121.400000', sizes: [sizeMove('50', '121.400000', '123.100000')], baseSize: sizeMove('50', '121.400000', '123.100000'), weighted: { before: null, after: null }, missing: ['CARTON_PIECES'] },
  ],
  withoutSheet: [{ styleId: uid('7777', 103), code: 'DEMO-PNT-01', revisionId: uid('7777', 51), revision: 1 }],
  priceLists: [
    { listId: uid('6600', 1), code: 'DEMO-PL-BASE', name: 'Listino base', versionId: uid('6610', 1), revision: 3, currency: 'EUR', styleId: uid('7777', 101), styleCode: 'DEMO-JKT-01', colourwayId: null, price: '260.000000', costBefore: '157.948000', costAfter: '160.690000', marginBefore: '39.25', marginAfter: '38.20', marginMove: '-1.05', comparable: true },
    { listId: uid('6600', 2), code: 'DEMO-PL-USD', name: 'Listino export', versionId: uid('6610', 2), revision: 1, currency: 'USD', styleId: uid('7777', 101), styleCode: 'DEMO-JKT-01', colourwayId: null, price: '290.000000', costBefore: null, costAfter: null, marginBefore: null, marginAfter: null, marginMove: null, comparable: false },
  ],
  orders: [
    { orderId: uid('7100', 1), number: 'DEMO-SO-0007', status: 'CONFIRMED', customer: 'Moto Club Esempio', lineId: uid('7110', 1), seq: 10, styleId: uid('7777', 101), styleCode: 'DEMO-JKT-01', pieces: 40, currency: 'EUR', net: 1040000, costBefore: 621400, costAfter: 632220, marginBefore: '40.25', marginAfter: '39.21', marginMove: '-1.04' },
    { orderId: uid('7100', 2), number: 'DEMO-SO-0011', status: 'IN_PRODUCTION', customer: 'Squadra Corse Prova', lineId: uid('7110', 2), seq: 20, styleId: uid('7777', 101), styleCode: 'DEMO-JKT-01', pieces: 12, currency: 'EUR', net: 312000, costBefore: 186420, costAfter: 189666, marginBefore: '40.25', marginAfter: '39.21', marginMove: '-1.04' },
  ],
  counts: { series: 2, recomputed: 1, incomplete: 1, seasonClosed: 0, listEntries: 2, orderLines: 2 },
  truncated: false,
  previewHash: '0'.repeat(64),
  words: 'x',
  computedAt: '2026-11-14T09:00:00.000Z',
})
const APPLIED = as<MassApplyView>({
  materials: [{ itemId: uid('4400', 1), code: 'DEMO-LEA-01', version: 4 }, { itemId: uid('4400', 3), code: 'DEMO-LIN-01', version: 3 }],
  created: [{ sheetId: uid('8800', 5), key: 'COST_SHEET:A:JKT01:none', sheetVersion: 5, basedOnId: uid('8800', 3), leftOut: 0 }, { sheetId: uid('8800', 13), key: 'COST_SHEET:A:JKT02:AI27', sheetVersion: 3, basedOnId: uid('8800', 12), leftOut: 1 }],
  skipped: [],
  words: 'x',
})

const model = (overrides: Partial<MassUpdateModel> = {}): MassUpdateModel => ({
  prefix: '/w/DEMO',
  can: owner,
  open: true,
  step: 'prices',
  rows: ROWS,
  search: { text: 'vacchetta', results: RESULTS, busy: false, problem: null },
  preview: null,
  applied: null,
  leaveOut: false,
  note: '',
  busy: false,
  problem: null,
  stale: false,
  stepUp: { open: false, busy: false, problem: null },
  ...overrides,
})

export const designScreen = defineDesignScreen<MassUpdateModel>({
  screen: 'SCR-505',
  title: 'Finance › Costing: mass cost update',
  view: MassUpdateDialog,
  cases: [
    { id: 'button', label: 'The band\'s button (closed)', model: model({ open: false }) },
    { id: 'prices', label: 'Step 1: two new prices', model: model(), note: 'Find a material, type its new standard price; a wrong figure is said under the field.' },
    { id: 'prices-empty', label: 'Step 1: nothing added yet', model: model({ rows: [], search: { text: '', results: null, busy: false, problem: null } }) },
    { id: 'effect', label: 'Step 2: the effect', model: model({ step: 'effect', preview: PREVIEW }), note: 'One series gets a new draft, one misses an input: Approve update is held until the person ticks to leave it out.' },
    { id: 'effect-ready', label: 'Step 2: ready to approve', model: model({ step: 'effect', preview: PREVIEW, leaveOut: true, note: 'Listino pelli novembre' }) },
    { id: 'stale', label: 'Something moved: the effect read again', model: model({ step: 'effect', preview: PREVIEW, leaveOut: true, problem: 'massRefusal.STALE', stale: true }) },
    { id: 'step-up', label: 'Approve update asks for a fresh code', model: model({ step: 'effect', preview: PREVIEW, leaveOut: true, busy: true, stepUp: { open: true, busy: false, problem: null } }) },
    { id: 'done', label: 'Step 3: done, two new drafts', model: model({ step: 'done', preview: PREVIEW, applied: APPLIED }) },
    { id: 'cost-only', label: 'Costs only: no margin, no apply right', model: model({ can: costOnly, step: 'effect', preview: PREVIEW }), note: 'Margins are not drawn; Approve update held with the missing right.' },
    { id: 'no-grain', label: 'Without the cost grain: held with why', model: model({ can: noGrain, open: false }) },
    { id: 'refused', label: 'Refused: no right over a company', model: model({ step: 'effect', preview: PREVIEW, leaveOut: true, problem: 'massRefusal.NO_RIGHT' }) },
  ],
})
