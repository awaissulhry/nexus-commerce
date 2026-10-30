import { createElement, type ReactNode } from 'react'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import type { CutLog, TicketPrinters, WorkOrder, WorkOrderBundles } from '../../_shared/api'
import type { Availability } from '../../work-orders/daily/api'
import type { Allocation, CutRow, CutTiles, Replacement, WorkOrderYield, YieldFigures } from '../api'
import { cuttingCanOf, type CuttingCan } from '../model'

/**
 * Made-up data for the design cases of SCR-238 (Cutting, New cut order, Allocate hides) and SCR-238-record (a cut and
 * its tabs): an invented site ("Stabilimento Demo Nord"), styles ("DEMO-JKT-01"), leathers ("DEMO-LEA-100 · NER"),
 * lots, hides, tables and people; the figures worked out by hand (the sums are in the comments). Nothing here is a real
 * company, person or number. Design-only (only fixtures and tests import it); it exports no `designScreen`.
 */

export const PREFIX = '/w/DEMO'
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
export const SITE = { id: uid('2222', 1), code: 'STAB-N', name: 'Stabilimento Demo Nord' }
const COMPANY = uid('1010', 1)
export const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()

// ---- roles -------------------------------------------------------------------------------------------------------------------

const BASE = ['home.view', 'threads.read', 'threads.post', 'files.read']
export const ROLES = {
  owner: [...OWNER_PERMISSIONS, 'workorders.view', 'production.cutting.view', 'production.scrap.view', 'production.scrap', 'production.scrap.approve', 'inventory.reserve', 'inventory.stock.view', 'production.bundles', 'print.view', 'money.cost'],
  manager: [...BASE, 'workorders.view', 'workorders.manage', 'production.cutting.view', 'production.scrap.view', 'production.scrap', 'production.scrap.approve', 'production.cut', 'production.cut.correct', 'production.bundles', 'inventory.reserve', 'inventory.stock.view', 'print.view'],
  supervisor: [...BASE, 'workorders.view', 'production.cutting.view', 'production.scrap.view', 'production.rework', 'inventory.stock.view'],
  buyer: [...BASE, 'purchasing.view', 'production.cutting.view'],
  sales: [...BASE, 'orders.view', 'workorders.view'],
} as const
export type Role = keyof typeof ROLES
export const canAs = (role: Role): CuttingCan => cuttingCanOf(ROLES[role])

/** The Office shell around a page at this address (the role's navigation). */
export function inShell(path: string, page: ReactNode, role: Role = 'manager'): ReactNode {
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

// ---- the cuts (Friday 30 October 2026) ------------------------------------------------------------------------------------------

const JKT = { id: uid('7777', 1), code: 'DEMO-JKT-01', name: 'Giacca pelle demo' }
const PNT = { id: uid('7777', 2), code: 'DEMO-PNT-02', name: 'Pantalone pelle demo' }
const LEA_NER = { itemId: uid('8888', 1), itemColourId: uid('8899', 1), code: 'DEMO-LEA-100', name: 'Pelle bovina 1,2 mm demo', baseUom: 'FT2', colourCode: 'NER' }
const LEA_TMO = { itemId: uid('8888', 1), itemColourId: uid('8899', 2), code: 'DEMO-LEA-100', name: 'Pelle bovina 1,2 mm demo', baseUom: 'FT2', colourCode: 'TMO' }
const LOT_A = { id: uid('5555', 1), code: 'DEMO-LOT-0101', dyeBatch: 'BG-7731' }
const LOT_B = { id: uid('5555', 2), code: 'DEMO-LOT-0102', dyeBatch: 'BG-7740' }
const TABLE_1 = { id: uid('6666', 1), code: 'TAV-01' }
const TABLE_2 = { id: uid('6666', 2), code: 'TAV-02' }

const workOrder = (n: number, number: string, over: Partial<CutRow['workOrder']> = {}): CutRow['workOrder'] => ({
  id: uid('3333', n),
  number,
  batchNumber: null,
  status: 'RELEASED',
  companyId: COMPANY,
  siteId: SITE.id,
  dueDate: '2026-11-20',
  priority: 0,
  holdReason: null,
  ...over,
})

const row = (over: Partial<CutRow> & Pick<CutRow, 'workOrder'>): CutRow => ({
  style: JKT,
  kind: 'LEATHER',
  state: 'WAITING',
  materials: [LEA_NER],
  lots: [],
  garments: { planned: 24, cut: 0, toCut: 24 },
  pieces: { planned: 72, cut: 0 },
  hides: { count: 0, used: [] },
  allocated: 0,
  yield: { yieldPct: null, plannedPct: null, variancePct: null, plannedSource: 'STYLE' },
  stations: [],
  lastCutAt: null,
  recutsOpen: 0,
  ...over,
})

// Cutting: 10 of 24 garments, 3 parts each → 30 of 72 pieces; 4 hides, 192.64 ft² used; yield 74.2 % against 75 %.
export const CUTTING = row({
  workOrder: workOrder(1, 'WO-26-0031', { status: 'IN_PROGRESS', priority: 1, dueDate: '2026-11-13' }),
  state: 'CUTTING',
  lots: [LOT_A],
  garments: { planned: 24, cut: 10, toCut: 14 },
  pieces: { planned: 72, cut: 31 },
  hides: { count: 4, used: [{ uom: 'FT2', area: '192.6400' }] },
  allocated: 2,
  yield: { yieldPct: '74.20', plannedPct: '75.00', variancePct: '-0.80', plannedSource: 'STYLE' },
  stations: [TABLE_1],
  lastCutAt: at(30, 8, 12),
  recutsOpen: 1,
})
export const WAITING = row({ workOrder: workOrder(2, 'WO-26-0034'), garments: { planned: 12, cut: 0, toCut: 12 }, pieces: { planned: 36, cut: 0 } })
export const WAITING_TMO = row({ workOrder: workOrder(3, 'WO-26-0035'), materials: [LEA_TMO], garments: { planned: 8, cut: 0, toCut: 8 }, pieces: { planned: 24, cut: 0 } })
export const WAITING_PNT = row({ workOrder: workOrder(4, 'WO-26-0036', { dueDate: '2026-11-27' }), style: PNT, garments: { planned: 6, cut: 0, toCut: 6 }, pieces: { planned: 12, cut: 0 } })
// Held: a quality hold on the work order (its reason, as the hold says it).
export const HELD = row({
  workOrder: workOrder(5, 'WO-26-0029', { status: 'ON_HOLD', holdReason: 'Shade differs from the approved sample' }),
  state: 'HELD',
  lots: [LOT_B],
  garments: { planned: 10, cut: 4, toCut: 6 },
  pieces: { planned: 30, cut: 12 },
  hides: { count: 2, used: [{ uom: 'FT2', area: '96.3200' }] },
  yield: { yieldPct: '71.10', plannedPct: '75.00', variancePct: '-3.90', plannedSource: 'STYLE' },
  stations: [TABLE_2],
  lastCutAt: at(29, 15, 40),
})
// Cut: every garment cut (20 of 20), yield above the plan.
export const DONE = row({
  workOrder: workOrder(6, 'WO-26-0027', { status: 'IN_PROGRESS', dueDate: '2026-11-06' }),
  state: 'CUT',
  lots: [LOT_A, LOT_B],
  garments: { planned: 20, cut: 20, toCut: 0 },
  pieces: { planned: 60, cut: 60 },
  hides: { count: 7, used: [{ uom: 'FT2', area: '371.0500' }] },
  yield: { yieldPct: '76.40', plannedPct: '75.00', variancePct: '1.40', plannedSource: 'STYLE' },
  stations: [TABLE_1, TABLE_2],
  lastCutAt: at(28, 11, 5),
})

export const CUTS: CutRow[] = [CUTTING, WAITING, WAITING_TMO, WAITING_PNT, HELD, DONE]
export const OPEN_CUTS: CutRow[] = [CUTTING, WAITING, WAITING_TMO, WAITING_PNT, HELD]
// Tiles: waiting 3, cutting 1, held 1; today 31 pieces from 3 hides, 144.48 ft² = 13.42 m².
export const TILES: CutTiles = { waiting: 3, cutting: 1, held: 1, piecesToday: 31, hidesToday: 3, areaTodayM2: '13.4225' }
export const YIELD_TODAY: YieldFigures = { used: '144.4800', unmatched: '0.0000', pattern: '107.2000', remnant: '6.2000', waste: '37.2800', wastePct: '25.80', yieldPct: '74.20', plannedPct: '75.00', variancePct: '-0.80' }

// ---- Allocate hides: the hides of DEMO-LEA-100 · NER at the site ---------------------------------------------------------------

const hide = (n: number, onHand: string, extra: Partial<Availability['hides'][number]> = {}): Availability['hides'][number] => ({ hide: { id: uid('4444', n), code: `DEMO-HD-${String(n).padStart(4, '0')}` }, lotId: LOT_A.id, onHand, held: false, reservedFor: null, ...extra })
export const AVAILABILITY: Availability = {
  site: { id: SITE.id, code: SITE.code },
  item: { id: LEA_NER.itemId, code: LEA_NER.code, name: LEA_NER.name, baseUom: 'FT2' },
  colour: { id: LEA_NER.itemColourId, code: 'NER' },
  hides: [
    hide(11, '52.4000'),
    hide(12, '55.1000'),
    hide(13, '49.8000'),
    hide(14, '53.0000', { reservedFor: { type: 'WorkOrder', id: CUTTING.workOrder.id } }),
    hide(15, '51.2000', { reservedFor: { type: 'WorkOrder', id: uid('3333', 9) } }),
    hide(16, '54.6000', { held: true, lotId: LOT_B.id }),
  ],
}

// ---- the record of WO-26-0031 ----------------------------------------------------------------------------------------------------

const cell = (n: number, size: string) => ({ id: uid('9191', n), colourwayCode: 'NER', size })
const CELLS = [cell(1, '48'), cell(2, '50'), cell(3, '52')]

export const WORK_ORDER = {
  id: CUTTING.workOrder.id,
  number: CUTTING.workOrder.number,
  batchNumber: null,
  kind: 'SIZE_GRID',
  status: 'IN_PROGRESS',
  version: 4,
  companyId: COMPANY,
  siteId: SITE.id,
  site: SITE,
  style: { ...JKT, ppeCategory: 'II', sizes: ['48', '50', '52'] },
  revision: { id: uid('7171', 1), revision: 2, status: 'RELEASED' },
  labelTemplate: null,
  dueDate: '2026-11-13',
  daysLate: null,
  priority: 1,
  note: null,
  release: { at: at(26, 9), byId: null, materialOverride: null },
  startedAt: at(27, 7),
  completedAt: null,
  closedAt: null,
  cancelledAt: null,
  cancelReason: null,
  createdAt: at(25, 10),
  updatedAt: at(30, 8, 12),
  nextActions: ['COMPLETED'],
  orders: [],
  cells: CELLS.map((entry, index) => ({ ...entry, version: 1, colourwayId: uid('9292', 1), colourwayName: 'Nero', quantity: [8, 10, 6][index]!, salesOrderLineId: uid('9393', 1), salesOrderId: uid('9494', 1), lineSeq: 10, progress: null })),
  pieces: 24,
  progress: { counted: true },
  hold: null,
  spec: {
    frozen: true,
    frozenAt: at(26, 9),
    operations: [],
    materials: [{ itemId: LEA_NER.itemId, itemCode: LEA_NER.code, itemName: LEA_NER.name, itemColourId: LEA_NER.itemColourId, colourCode: 'NER', baseUom: 'FT2', planned: '1155.8400', issued: '220.4000', balance: '935.4400' }],
    standardMinutes: { perGarment: '95.0', allPieces: '2280.0' },
  },
} as unknown as WorkOrder

export const HELD_WORK_ORDER = { ...WORK_ORDER, id: HELD.workOrder.id, number: HELD.workOrder.number, status: 'ON_HOLD', hold: { reason: 'Shade differs from the approved sample', at: at(29, 16), fromStatus: 'IN_PROGRESS', recordType: 'QualityHold', recordId: uid('1212', 1) } } as unknown as WorkOrder

const entry = (n: number, hideN: number, minute: number, pieces: Array<[number, string, number]>, area: string, extra: Partial<CutLog['entries'][number]> = {}): CutLog['entries'][number] => ({
  id: uid('2323', n),
  hideId: uid('4444', hideN),
  hideCode: `DEMO-HD-${String(hideN).padStart(4, '0')}`,
  lotCode: LOT_A.code,
  uom: 'FT2',
  baseAreaUsed: area,
  baseRemnantArea: '0.0000',
  reversalOfId: null,
  reversedById: null,
  live: true,
  closing: false,
  pattern: null,
  note: null,
  deviceId: uid('2424', 1),
  deviceTime: at(30, 7, minute),
  serverTime: at(30, 7, minute),
  worker: null,
  station: { id: TABLE_1.id, code: TABLE_1.code, name: 'Tavolo di taglio 1' },
  pieces: pieces.map(([cellN, part, count]) => ({ workOrderSizeId: uid('9191', cellN), part, pieces: count })),
  cells: [...new Set(pieces.map(([cellN]) => cellN))].map((cellN) => ({ workOrderSizeId: uid('9191', cellN), colourwayCode: 'NER', size: CELLS[cellN - 1]!.size })),
  ...extra,
})

// Pieces cut: size 48 3 sets (front, back, sleeve: 9 pieces) · size 50 7 sets + 1 sleeve recut (22 pieces) = 31 of 72.
export const CUT_LOG: CutLog = {
  workOrder: { id: WORK_ORDER.id, number: WORK_ORDER.number, status: 'IN_PROGRESS', siteId: SITE.id },
  entries: [
    entry(4, 4, 58, [[2, 'sleeve', 1]], '5.2000', { closing: false }),
    entry(3, 3, 40, [[2, 'front', 3], [2, 'back', 3], [2, 'sleeve', 3]], '48.1600'),
    entry(2, 2, 20, [[2, 'front', 4], [2, 'back', 4], [2, 'sleeve', 4]], '64.2200', { baseRemnantArea: '4.1000', closing: true }),
    entry(1, 1, 5, [[1, 'front', 3], [1, 'back', 3], [1, 'sleeve', 3]], '75.0600'),
  ],
  hides: [
    { hideId: uid('4444', 1), code: 'DEMO-HD-0001', lotCode: LOT_A.code, state: 'CONSUMED', issued: '55.1000', cut: '41.4000', waste: '13.7000', returned: '0.0000', left: '0.0000' },
    { hideId: uid('4444', 2), code: 'DEMO-HD-0002', lotCode: LOT_A.code, state: 'REMNANT', issued: '54.2000', cut: '37.6000', waste: '12.5000', returned: '4.1000', left: '0.0000' },
    { hideId: uid('4444', 3), code: 'DEMO-HD-0003', lotCode: LOT_A.code, state: 'PARTLY_CUT', issued: '56.0000', cut: '35.9000', waste: '12.2600', returned: '0.0000', left: '7.8400' },
    { hideId: uid('4444', 4), code: 'DEMO-HD-0004', lotCode: LOT_A.code, state: 'PARTLY_CUT', issued: '55.1000', cut: '3.9000', waste: '1.3000', returned: '0.0000', left: '49.9000' },
  ],
  cells: [
    { id: uid('9191', 1), colourwayCode: 'NER', size: '48', quantity: 8, cut: 3, toCut: 5, parts: [{ part: 'back', pieces: 3, planned: true }, { part: 'front', pieces: 3, planned: true }, { part: 'sleeve', pieces: 3, planned: true }] },
    { id: uid('9191', 2), colourwayCode: 'NER', size: '50', quantity: 10, cut: 7, toCut: 3, parts: [{ part: 'back', pieces: 7, planned: true }, { part: 'front', pieces: 7, planned: true }, { part: 'sleeve', pieces: 8, planned: true }] },
    { id: uid('9191', 3), colourwayCode: 'NER', size: '52', quantity: 6, cut: 0, toCut: 6, parts: [{ part: 'back', pieces: 0, planned: true }, { part: 'front', pieces: 0, planned: true }, { part: 'sleeve', pieces: 0, planned: true }] },
  ],
}

const yieldHide = (n: number, grade: string, shade: string, state: CutLog['hides'][number]['state'], areaIn: string, used: string, pattern: string, remnant: string, waste: string, lot = LOT_A) => ({
  hide: { id: uid('4444', n), code: `DEMO-HD-${String(n).padStart(4, '0')}`, grade, shade, state },
  lot: { id: lot.id, code: lot.code, supplierLotRef: 'CONC-26-118' },
  supplier: { id: uid('1313', 1), name: 'Conceria Demo S.r.l.' },
  item: { id: LEA_NER.itemId, code: LEA_NER.code, uom: 'FT2' },
  areaIn,
  used,
  unmatched: n === 4 ? used : '0.0000',
  pattern,
  remnant,
  waste,
  wastePct: n === 4 ? null : ((Number(waste) * 100) / Number(used)).toFixed(2),
  yieldPct: n === 4 ? null : ((Number(pattern) * 100) / Number(used)).toFixed(2),
  plannedPct: '75.00',
  variancePct: n === 4 ? null : ((Number(pattern) * 100) / Number(used) - 75).toFixed(2),
})

// Overall (hides 1–3): used 187.44, pattern 139.08 → 74.20 %; hide 4 (single parts) is left out of the yield.
export const WORK_ORDER_YIELD: WorkOrderYield = {
  workOrder: { id: WORK_ORDER.id, number: WORK_ORDER.number, status: 'IN_PROGRESS' },
  plannedSource: 'STYLE',
  overall: { used: '192.6400', unmatched: '5.2000', pattern: '139.0800', remnant: '4.1000', waste: '48.3600', wastePct: '25.80', yieldPct: '74.20', plannedPct: '75.00', variancePct: '-0.80' },
  hides: [
    yieldHide(1, 'A', 'NER-2', 'CONSUMED', '55.1000', '75.0600', '55.6200', '0.0000', '19.4400'),
    yieldHide(2, 'A', 'NER-2', 'REMNANT', '54.2000', '64.2200', '47.9000', '4.1000', '16.3200'),
    yieldHide(3, 'B', 'NER-3', 'PARTLY_CUT', '56.0000', '48.1600', '35.5600', '0.0000', '12.6000'),
    yieldHide(4, 'B', 'NER-3', 'PARTLY_CUT', '55.1000', '5.2000', '0.0000', '0.0000', '0.0000'),
  ],
}
export const EMPTY_YIELD: WorkOrderYield = { ...WORK_ORDER_YIELD, overall: { used: '0.0000', unmatched: '0.0000', pattern: '0.0000', remnant: '0.0000', waste: '0.0000', wastePct: null, yieldPct: null, plannedPct: '75.00', variancePct: null }, hides: [] }
export const EMPTY_LOG: CutLog = { ...CUT_LOG, entries: [], hides: [], cells: CUT_LOG.cells.map((entry) => ({ ...entry, cut: 0, toCut: entry.quantity, parts: entry.parts.map((part) => ({ ...part, pieces: 0 })) })) }

const replacement = (n: number, over: Partial<Replacement>): Replacement => ({
  id: uid('1414', n),
  workOrder: { id: WORK_ORDER.id, number: WORK_ORDER.number, status: 'IN_PROGRESS' },
  cell: { id: uid('9191', 2), colourwayCode: 'NER', size: '50', quantity: 10 },
  kind: 'RECUT',
  quantity: 1,
  part: 'sleeve',
  sourceScanId: uid('1515', 1),
  reworkOrderId: null,
  reason: 'Stain on the sleeve at stitching',
  status: 'OPEN',
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  cutLogId: null,
  doneAt: null,
  note: null,
  version: 1,
  createdAt: at(29, 14, 20),
  createdBy: { id: uid('1616', 1), name: 'Bea Esempio' },
  ...over,
})
export const RECUTS: Replacement[] = [
  replacement(1, {}),
  replacement(2, { cell: { id: uid('9191', 1), colourwayCode: 'NER', size: '48', quantity: 8 }, part: 'front', status: 'DONE', cutLogId: uid('2323', 1), doneAt: at(28, 9), reason: 'Cut against the grain' }),
]

export const ALLOCATED: Allocation[] = [
  { id: uid('1717', 1), status: 'ACTIVE', hide: { id: uid('4444', 14), code: 'DEMO-HD-0014' }, lot: { id: LOT_A.id, code: LOT_A.code, qualityStatus: 'RELEASED' }, item: { id: LEA_NER.itemId, code: LEA_NER.code, baseUom: 'FT2' }, quantity: '53.0000', createdAt: at(29, 9) },
  { id: uid('1717', 2), status: 'ACTIVE', hide: { id: uid('4444', 17), code: 'DEMO-HD-0017' }, lot: { id: LOT_A.id, code: LOT_A.code, qualityStatus: 'RELEASED' }, item: { id: LEA_NER.itemId, code: LEA_NER.code, baseUom: 'FT2' }, quantity: '50.6000', createdAt: at(29, 9) },
]

const bundle = (n: number, size: string, quantity: number, over: Partial<WorkOrderBundles['bundles'][number]> = {}): WorkOrderBundles['bundles'][number] => ({
  id: uid('1818', n),
  code: `DEMO-BN-${String(n).padStart(4, '0')}`,
  replacedCodes: [],
  workOrderSizeId: uid('9191', size === '48' ? 1 : 2),
  colourwayCode: 'NER',
  size,
  part: null,
  quantity,
  status: 'ACTIVE',
  voidedAt: null,
  cutLogIds: [uid('2323', 1)],
  createdAt: at(30, 7, 50),
  scans: 0,
  doneAt: [],
  lastScan: null,
  hides: [{ hideId: uid('4444', 1), code: 'DEMO-HD-0001', lotId: LOT_A.id, lotCode: LOT_A.code }],
  tickets: [{ jobId: uid('1919', n), printerId: uid('2020', 1), status: 'PRINTED', createdAt: at(30, 7, 51) }],
  reprints: [],
  ...over,
})
export const BUNDLES: WorkOrderBundles = {
  workOrder: { id: WORK_ORDER.id, number: WORK_ORDER.number, status: 'IN_PROGRESS', siteId: SITE.id },
  cells: [],
  bundles: [
    bundle(1, '48', 3, { scans: 2, lastScan: { at: at(30, 9), operation: { seq: 20, code: 'CUC' }, station: null } }),
    bundle(2, '50', 5, { replacedCodes: ['DEMO-BN-0002A'], reprints: [{ code: 'DEMO-BN-0002', replacedCode: 'DEMO-BN-0002A', reason: 'Ticket torn at the bench', printerId: uid('2020', 1), postedBy: 'OFFICE', at: at(30, 8) }] }),
    bundle(3, '50', 2, { tickets: [{ jobId: uid('1919', 3), printerId: uid('2020', 1), status: 'FAILED', createdAt: at(30, 7, 52) }] }),
    bundle(4, '50', 1, { status: 'VOID', voidedAt: at(30, 8, 5) }),
  ],
}
export const PRINTERS: TicketPrinters = { printers: [{ id: uid('2020', 1), code: 'LBL-01', name: 'Stampante etichette taglio' }], defaultPrinterId: uid('2020', 1) }
