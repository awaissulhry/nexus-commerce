import { ROLES, SITE, at, type Role } from '../../demo/fixtures'
import type { CutOrderRecord, CutOrderSummary, CutTicket, LayRoll, LayView, LineView, Printer, Reconciliation, RollCandidate, RollCandidates, Station, WaitingGroup } from '../api'
import { ordersCanOf, type OrdersCan } from '../model'

/**
 * Made-up data for the design cases of the cut orders (B-W2b-129: SCR-238's list rows and New cut order, SCR-238-order, a cut
 * order's record, SCR-238-sheet, its lay sheet): an invented site, styles ("DEMO-JKT-01"), a lining ("DEMO-LIN-200 · GRI"), rolls,
 * markers, tables and printers; the figures worked out by hand (the sums are in the comments). Nothing here is a real company,
 * person or number. Design-only (only fixtures and tests import it); it exports no `designScreen`.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const COMPANY = uid('1010', 1)

export const ordersCanAs = (role: Role): OrdersCan => ordersCanOf(ROLES[role])

const JKT = { id: uid('7777', 1), code: 'DEMO-JKT-01', name: 'Giacca pelle demo' }
const PNT = { id: uid('7777', 2), code: 'DEMO-PNT-02', name: 'Pantalone pelle demo' }
const LINING = { id: uid('8888', 5), code: 'DEMO-LIN-200', name: 'Fodera grigia demo' }
const GRI = { id: uid('8899', 5), code: 'GRI', name: 'Grigio' }
const LEATHER = { id: uid('8888', 1), code: 'DEMO-LEA-100', name: 'Pelle bovina 1,2 mm demo' }
const NER = { id: uid('8899', 1), code: 'NER', name: 'Nero' }
const TABLE = { id: uid('6666', 1), code: 'TAV-01', name: 'Tavolo di taglio 1' }
const NERO = { id: uid('9292', 1), code: 'NER', name: 'Nero' }

const WO_40 = { id: uid('3333', 40), number: 'WO-26-0040' }
const WO_41 = { id: uid('3333', 41), number: 'WO-26-0041' }

const summary = (n: number, over: Partial<CutOrderSummary> = {}): CutOrderSummary => ({
  id: uid('5050', n),
  number: `CO-2026-${String(n).padStart(4, '0')}`,
  kind: 'FABRIC',
  status: 'IN_PROGRESS',
  companyId: COMPANY,
  siteId: SITE.id,
  material: { item: LINING, colour: GRI },
  workOrders: [WO_40, WO_41],
  styles: [JKT],
  garments: 120,
  plies: 30,
  lays: { count: 2, cut: 1, open: 1 },
  tickets: { open: 1, started: 0, done: 1 },
  station: TABLE,
  dueDate: '2026-11-20',
  releasedAt: at(29, 10),
  cutAt: null,
  createdAt: at(28, 16),
  version: 5,
  words: { it: '2 materassi · 30 strati · 120 capi', en: '2 lays · 30 plies · 120 garments' },
  ...over,
})

// The list: one fabric order cutting, one planned, one cut (to reconcile), one leather group.
export const ORDER_CUTTING = summary(7)
export const ORDER_PLANNED = summary(8, { status: 'PLANNED', workOrders: [WO_41], garments: 48, plies: 12, lays: { count: 1, cut: 0, open: 1 }, tickets: { open: 0, started: 0, done: 0 }, station: null, releasedAt: null, createdAt: at(30, 8) })
export const ORDER_CUT = summary(6, { status: 'CUT', lays: { count: 2, cut: 2, open: 0 }, tickets: { open: 0, started: 0, done: 2 }, cutAt: at(30, 7, 40), releasedAt: at(27, 9) })
export const ORDER_LEATHER = summary(9, { kind: 'LEATHER', status: 'RELEASED', material: { item: LEATHER, colour: NER }, styles: [JKT, PNT], garments: 18, plies: null, lays: { count: 0, cut: 0, open: 0 }, tickets: { open: 1, started: 0, done: 0 }, words: { it: '18 capi', en: '18 garments' } })
export const ORDER_ROWS: CutOrderSummary[] = [ORDER_PLANNED, ORDER_CUTTING, ORDER_LEATHER]
// The fabric cut orders per status (the tiles): 1 planned, 0 released, 1 cutting.
export const FABRIC_TILES = { planned: 1, released: 0, cutting: 1, cut: 1, cancelled: 0 }

// ---- the record of CO-2026-0007 -------------------------------------------------------------------------------------------------

// Marker DEMO-MK-3S: 48 ×1, 50 ×2 (WO-26-0040), 52 ×1 (WO-26-0041) = 4 garments a ply; 30 plies → 30 + 60 + 30 = 120 garments.
const line = (n: number, workOrder: { id: string; number: string }, size: string, ratio: number): LineView => ({
  id: uid('5151', n),
  seq: n * 10,
  workOrder: { ...workOrder, batchNumber: null, status: 'IN_PROGRESS', holdReason: null, dueDate: '2026-11-20' },
  style: JKT,
  colourway: NERO,
  workOrderSizeId: uid('9191', 40 + n),
  size,
  cellQuantity: ratio * 30 + 4,
  quantity: ratio * 30,
  ratio,
  plies: 30,
  version: 1,
})
const LINES = [line(1, WO_40, '48', 1), line(2, WO_40, '50', 2), line(3, WO_41, '52', 1)]

const roll = (n: number, plies: number, over: Partial<LayRoll> = {}): LayRoll => ({
  id: uid('5252', n),
  seq: n,
  rollId: uid('5353', n),
  code: `DEMO-RL-${String(n).padStart(4, '0')}`,
  lotCode: 'DEMO-LOT-LIN-07',
  plies,
  splices: 0,
  endLoss: '0.0000',
  endReturned: '0.0000',
  state: 'FULL',
  lengthLeft: '42.5000',
  uom: 'M',
  widthCm: '148.00',
  shade: 'A',
  shadeGroupId: uid('5454', 1),
  shrinkageGroup: 'S1',
  version: 1,
  ...over,
})

const ticket = (n: number, layId: string | null, laySeq: number | null, over: Partial<CutTicket> = {}): CutTicket => ({
  id: uid('5555', n),
  number: `CTA-2026-${String(n).padStart(5, '0')}`,
  code: `CTA-2026-${String(n).padStart(5, '0')}`,
  status: 'OPEN',
  cutOrderId: ORDER_CUTTING.id,
  layId,
  laySeq,
  printedAt: at(29, 10, 5),
  startedAt: null,
  doneAt: null,
  voidedAt: null,
  voidReason: null,
  version: 1,
  ...over,
})

// Lay 1: 15 plies from DEMO-RL-0001 (9) and DEMO-RL-0002 (6), counted 15, cut. Lay 2: 15 plies, 6 allocated from DEMO-RL-0003.
const LAY_1_ID = uid('5656', 1)
const LAY_2_ID = uid('5656', 2)
const TICKET_1 = ticket(11, LAY_1_ID, 1, { status: 'DONE', startedAt: at(30, 6, 30), doneAt: at(30, 7, 10) })
const TICKET_2 = ticket(12, LAY_2_ID, 2)
const lay = (id: string, seq: number, over: Partial<LayView>): LayView => ({
  id,
  seq,
  plies: 15,
  status: 'PLANNED',
  layLength: null,
  lengthUom: null,
  counted: null,
  checkedAt: null,
  cutAt: null,
  cancelledAt: null,
  cancelReason: null,
  note: null,
  version: 3,
  allocated: 0,
  shade: null,
  shrinkageGroup: null,
  rolls: [],
  ticket: null,
  plyRuns: [],
  ...over,
})
const LAY_1 = lay(LAY_1_ID, 1, { status: 'CUT', layLength: '2.45', lengthUom: 'M', counted: 15, checkedAt: at(30, 7), cutAt: at(30, 7, 10), allocated: 15, shade: 'A', shrinkageGroup: 'S1', rolls: [roll(1, 9, { state: 'PARTIAL', lengthLeft: '20.0500' }), roll(2, 6)], ticket: TICKET_1 })
const LAY_2 = lay(LAY_2_ID, 2, { allocated: 6, shade: 'A', shrinkageGroup: 'S1', rolls: [roll(3, 6)], ticket: TICKET_2 })

export const RECORD: CutOrderRecord = {
  cutOrder: {
    ...ORDER_CUTTING,
    marker: { name: 'DEMO-MK-3S', length: '2.4000', uom: 'M', widthCm: '145.00', fileId: null, ratio: '48:1 · 50:2 · 52:1', garmentsPerPly: 4 },
    markerName: 'DEMO-MK-3S',
    note: null,
    cancelReason: null,
    cancelledAt: null,
    reconciledAt: null,
  },
  lines: LINES,
  lays: [LAY_1, LAY_2],
  tickets: [TICKET_1, TICKET_2],
  warnings: [],
  can: { edit: false, release: false, backToPlanning: false, cancel: false, allocate: true },
}

/** The same cut order as the supervisor (no production.cutorders.manage) reads it: `can` all false. */
export const RECORD_READ_ONLY: CutOrderRecord = { ...RECORD, can: { edit: false, release: false, backToPlanning: false, cancel: false, allocate: false } }

/** Planned: no ticket yet, the lays without rolls. */
export const RECORD_PLANNED: CutOrderRecord = {
  ...RECORD,
  cutOrder: { ...RECORD.cutOrder, status: 'PLANNED', releasedAt: null, tickets: { open: 0, started: 0, done: 0 }, lays: { count: 2, cut: 0, open: 2 } },
  lays: [lay(LAY_1_ID, 1, {}), lay(LAY_2_ID, 2, {})],
  tickets: [],
  can: { edit: true, release: true, backToPlanning: false, cancel: true, allocate: false },
}

/** Released: tickets made and printed, nothing started; may go back to planning. */
export const RECORD_RELEASED: CutOrderRecord = {
  ...RECORD,
  cutOrder: { ...RECORD.cutOrder, status: 'RELEASED' },
  lays: [lay(LAY_1_ID, 1, { allocated: 15, shade: 'A', shrinkageGroup: 'S1', rolls: [roll(1, 9), roll(2, 6)], ticket: ticket(11, LAY_1_ID, 1) }), lay(LAY_2_ID, 2, { ticket: TICKET_2 })],
  tickets: [ticket(11, LAY_1_ID, 1), TICKET_2],
  can: { edit: false, release: false, backToPlanning: true, cancel: true, allocate: true },
}

// Cut: lay 2 counted 13 plies (short of 15): 28 plies → 48: 28, 50: 56, 52: 28 = 112 of 120 garments.
const LAY_2_CUT = lay(LAY_2_ID, 2, { status: 'CUT', layLength: '2.45', lengthUom: 'M', counted: 13, checkedAt: at(30, 7, 35), cutAt: at(30, 7, 40), allocated: 13, shade: 'A', shrinkageGroup: 'S1', rolls: [roll(3, 6), roll(4, 7)], ticket: ticket(12, LAY_2_ID, 2, { status: 'DONE', startedAt: at(30, 7, 15), doneAt: at(30, 7, 40) }) })
export const RECORD_CUT: CutOrderRecord = {
  ...RECORD,
  cutOrder: { ...RECORD.cutOrder, id: ORDER_CUT.id, number: ORDER_CUT.number, status: 'CUT', cutAt: ORDER_CUT.cutAt, lays: { count: 2, cut: 2, open: 0 }, tickets: { open: 0, started: 0, done: 2 } },
  lays: [LAY_1, LAY_2_CUT],
  tickets: [TICKET_1, LAY_2_CUT.ticket!],
  can: { edit: false, release: false, backToPlanning: false, cancel: false, allocate: false },
}
export const RECORD_RECONCILED: CutOrderRecord = { ...RECORD_CUT, cutOrder: { ...RECORD_CUT.cutOrder, status: 'RECONCILED', reconciledAt: at(30, 9) } }
export const RECORD_CANCELLED: CutOrderRecord = {
  ...RECORD_PLANNED,
  cutOrder: { ...RECORD_PLANNED.cutOrder, status: 'CANCELLED', cancelReason: 'Marker changed: a new cut order replaces it', cancelledAt: at(30, 9) },
  lays: [lay(LAY_1_ID, 1, { status: 'CANCELLED', cancelledAt: at(30, 9), cancelReason: 'Cancelled with the cut order' }), lay(LAY_2_ID, 2, { status: 'CANCELLED', cancelledAt: at(30, 9), cancelReason: 'Cancelled with the cut order' })],
  can: { edit: false, release: false, backToPlanning: false, cancel: false, allocate: false },
}

/** Two shade groups across the lays: the API's warning, said in our words. */
export const RECORD_SHADES: CutOrderRecord = {
  ...RECORD_RELEASED,
  lays: [RECORD_RELEASED.lays[0]!, lay(LAY_2_ID, 2, { allocated: 6, shade: 'B', shrinkageGroup: 'S1', rolls: [roll(5, 6, { shade: 'B', shadeGroupId: uid('5454', 2) })], ticket: TICKET_2 })],
  warnings: [{ code: 'SHADES_ACROSS_LAYS', message: 'The lays are cut from different shade groups.' }],
}

/** A leather cut order: two work orders, one ticket; the hides are each work order's. */
export const RECORD_LEATHER: CutOrderRecord = {
  cutOrder: { ...ORDER_LEATHER, marker: null, markerName: null, note: null, cancelReason: null, cancelledAt: null, reconciledAt: null },
  lines: [
    { ...line(1, WO_40, '48', 1), ratio: null, plies: null, quantity: 8, cellQuantity: 8 },
    { ...line(3, WO_41, '52', 1), ratio: null, plies: null, quantity: 10, cellQuantity: 10, style: PNT },
  ],
  lays: [],
  tickets: [ticket(21, null, null, { cutOrderId: ORDER_LEATHER.id })],
  warnings: [],
  can: { edit: false, release: false, backToPlanning: true, cancel: true, allocate: false },
}

// ---- the reconciliation -----------------------------------------------------------------------------------------------------------

const recLine = (source: LineView, cut: number, recut = 0) => ({
  id: source.id,
  seq: source.seq,
  workOrder: { id: source.workOrder.id, number: source.workOrder.number },
  style: source.style,
  colourway: source.colourway,
  size: source.size,
  ratio: source.ratio,
  ordered: source.quantity,
  cut,
  recut,
  difference: cut - source.quantity,
  needsReason: cut !== source.quantity,
  reconciled: null,
})

// Fabric: lay 1 15 plies × 2.40 m = 36 m estimated, the report 36.9 m (end loss 0.9), confirmed 36.9; lay 2 13 × 2.40 = 31.2, 32.0
// recorded, confirmed 32.0 → used 68.9 m against 67.2 m estimated (+1.7 m, +2.5 %); issued 68.9 m; ends returned 3.6 m.
export const RECONCILIATION: Reconciliation = {
  cutOrder: { id: ORDER_CUT.id, number: ORDER_CUT.number, kind: 'FABRIC', status: 'CUT', version: 9, reconciledAt: null },
  lines: [recLine(LINES[0]!, 28), recLine(LINES[1]!, 56, 1), recLine(LINES[2]!, 28)],
  sizes: [
    { size: '48', ordered: 30, cut: 28, recut: 0, difference: -2 },
    { size: '50', ordered: 60, cut: 56, recut: 1, difference: -4 },
    { size: '52', ordered: 30, cut: 28, recut: 0, difference: -2 },
  ],
  material: {
    uom: 'M',
    lays: [
      { layId: LAY_1_ID, seq: 1, plies: 15, estimated: '36.0000', recorded: '36.9000', used: '36.9000', issued: '36.9000', endLoss: '0.9000', endsReturned: '2.1000', confirmed: true },
      { layId: LAY_2_ID, seq: 2, plies: 13, estimated: '31.2000', recorded: '32.0000', used: '32.0000', issued: '32.0000', endLoss: '0.8000', endsReturned: '1.5000', confirmed: true },
    ],
    sum: { estimated: '67.2000', recorded: '68.9000', used: '68.9000', issued: '68.9000', endLoss: '1.7000', endsReturned: '3.6000' },
    words: { it: '1,7 m in più della stima (+2,5%).', en: '1.7 m more than the estimate (+2.5%).' },
  },
  reasons: (['PLIES_SHORT', 'FABRIC_SHORT', 'ROLL_FAULT', 'MISCUT', 'OVERCUT', 'OTHER'] as const).map((code) => ({ code, words: { it: code, en: code } })),
  refusal: null,
  garments: { ordered: 120, cut: 112 },
  words: { it: '120 ordinati · 112 tagliati (−8)', en: '120 ordered · 112 cut (−8)' },
  can: { reconcile: true },
}

/** Lay 2's fabric not confirmed at the table yet: Reconcile is held with the reason. */
export const RECONCILIATION_UNCONFIRMED: Reconciliation = {
  ...RECONCILIATION,
  material: { ...RECONCILIATION.material!, lays: [RECONCILIATION.material!.lays[0]!, { ...RECONCILIATION.material!.lays[1]!, used: null, issued: '0.0000', confirmed: false }], sum: { ...RECONCILIATION.material!.sum, issued: '36.9000' } },
  refusal: { code: 'FABRIC_NOT_CONFIRMED', message: 'The fabric used on lay 2 is not confirmed.' },
  can: { reconcile: false },
}

/** Before the cut: cut counts the lays already cut only (lay 1: 15 plies → 15, 30, 15). */
export const RECONCILIATION_CUTTING: Reconciliation = {
  ...RECONCILIATION,
  cutOrder: { ...RECONCILIATION.cutOrder, id: ORDER_CUTTING.id, number: ORDER_CUTTING.number, status: 'IN_PROGRESS' },
  lines: [recLine(LINES[0]!, 15), recLine(LINES[1]!, 30), recLine(LINES[2]!, 15)],
  sizes: [
    { size: '48', ordered: 30, cut: 15, recut: 0, difference: -15 },
    { size: '50', ordered: 60, cut: 30, recut: 0, difference: -30 },
    { size: '52', ordered: 30, cut: 15, recut: 0, difference: -15 },
  ],
  material: { ...RECONCILIATION.material!, lays: [RECONCILIATION.material!.lays[0]!], sum: { estimated: '36.0000', recorded: '36.9000', used: '36.9000', issued: '36.9000', endLoss: '0.9000', endsReturned: '2.1000' } },
  refusal: { code: 'NOT_CUT', message: 'Cut order is in progress.' },
  garments: { ordered: 120, cut: 60 },
  can: { reconcile: false },
}

export const RECONCILIATION_DONE: Reconciliation = {
  ...RECONCILIATION,
  cutOrder: { ...RECONCILIATION.cutOrder, status: 'RECONCILED', reconciledAt: at(30, 9) },
  lines: RECONCILIATION.lines.map((entry) => ({ ...entry, reconciled: { varianceReasonCode: 'PLIES_SHORT', note: null, reconciledAt: at(30, 9) } })),
  refusal: { code: 'NOT_CUT', message: 'Reconciled already.' },
  can: { reconcile: false },
}

export const RECONCILIATION_LEATHER: Reconciliation = {
  ...RECONCILIATION,
  cutOrder: { id: ORDER_LEATHER.id, number: ORDER_LEATHER.number, kind: 'LEATHER', status: 'RELEASED', version: 3, reconciledAt: null },
  lines: [recLine(RECORD_LEATHER.lines[0]!, 3), recLine(RECORD_LEATHER.lines[1]!, 0)],
  sizes: [
    { size: '48', ordered: 8, cut: 3, recut: 0, difference: -5 },
    { size: '52', ordered: 10, cut: 0, recut: 0, difference: -10 },
  ],
  material: null,
  refusal: { code: 'NOT_CUT', message: 'Released.' },
  garments: { ordered: 18, cut: 3 },
  can: { reconcile: false },
}

// ---- Allocate rolls for lay 2 (9 plies still needed) ------------------------------------------------------------------------------

const candidate = (n: number, plies: number, over: Partial<RollCandidate> = {}): RollCandidate => ({
  id: uid('5353', n),
  code: `DEMO-RL-${String(n).padStart(4, '0')}`,
  supplierRollRef: `T-${100 + n}`,
  state: 'FULL',
  uom: 'M',
  length: '50.0000',
  lengthLeft: '42.5000',
  planned: '0.0000',
  widthCm: '148.00',
  shade: 'A',
  shadeGroup: { id: uid('5454', 1), label: 'A', outOfShade: false },
  shrinkageGroup: 'S1',
  shrinkageLengthPercent: '1.20',
  shrinkageWidthPercent: '0.80',
  lot: { id: uid('5757', 7), code: 'DEMO-LOT-LIN-07', dyeBatch: 'TB-2207', qualityStatus: 'RELEASED' },
  location: { id: uid('5858', 1), code: 'TES-A1' },
  plies,
  allocatedTo: [],
  refusal: null,
  warnings: [],
  ...over,
})

// Per ply 2.40 m: a 42.5 m roll gives 17 plies; 22 m gives 9.
export const CANDIDATES: RollCandidates = {
  marker: { name: 'DEMO-MK-3S', length: '2.4000', uom: 'M', widthCm: '145.00' },
  allowanceCm: 0,
  perPlyMetres: '2.4000',
  rolls: [
    candidate(4, 9, { lengthLeft: '22.0000' }),
    candidate(6, 17),
    candidate(3, 2, { lengthLeft: '20.0000', planned: '14.4000', allocatedTo: [{ cutOrderNumber: ORDER_CUTTING.number, laySeq: 2, plies: 6 }] }),
    candidate(5, 17, { shade: 'B', shadeGroup: { id: uid('5454', 2), label: 'B', outOfShade: false }, lot: { id: uid('5757', 8), code: 'DEMO-LOT-LIN-08', dyeBatch: 'TB-2231', qualityStatus: 'RELEASED' } }),
    candidate(7, 17, { shrinkageGroup: 'S2' }),
    candidate(8, 0, { widthCm: '130.00', refusal: { code: 'ROLL_TOO_NARROW', message: 'Narrower than the marker.' } }),
    candidate(9, 0, { lot: { id: uid('5757', 9), code: 'DEMO-LOT-LIN-09', dyeBatch: 'TB-2240', qualityStatus: 'RELEASED' }, refusal: { code: 'LOT_HELD', message: 'Lot on hold.' } }),
  ],
  groups: [
    { shade: 'A', shadeGroupId: uid('5454', 1), shrinkageGroup: 'S1', rolls: 2, plies: 26 },
    { shade: 'B', shadeGroupId: uid('5454', 2), shrinkageGroup: 'S1', rolls: 1, plies: 17 },
  ],
  lays: [{ id: LAY_2_ID, seq: 2, plies: 15, allocated: 6, proposable: true }],
  proposal: [{ layId: LAY_2_ID, seq: 2, need: 9, rolls: [{ rollId: uid('5353', 4), code: 'DEMO-RL-0004', plies: 9 }], short: 0 }],
  words: { it: 'Materasso 2: DEMO-RL-0004 9 strati', en: 'Lay 2: DEMO-RL-0004 9 plies' },
  warnings: [],
}

export const PRINTERS: Printer[] = [
  { id: uid('2020', 1), siteId: SITE.id, code: 'LBL-01', name: 'Stampante etichette taglio', kind: 'LABEL_ZPL', status: 'ACTIVE' },
  { id: uid('2020', 2), siteId: SITE.id, code: 'LBL-02', name: 'Stampante etichette magazzino', kind: 'LABEL_ZPL', status: 'ACTIVE' },
]

// ---- New cut order --------------------------------------------------------------------------------------------------------------

const waiting = (n: number, workOrder: { id: string; number: string }, size: string, quantity: number, onCutOrders = 0) => ({
  workOrderSizeId: uid('9191', 60 + n),
  workOrder: { ...workOrder, status: 'RELEASED', dueDate: '2026-11-27' },
  style: JKT,
  colourway: NERO,
  size,
  quantity,
  onCutOrders,
  left: Math.max(0, quantity - onCutOrders),
})
const WO_44 = { id: uid('3333', 44), number: 'WO-26-0044' }
const WO_45 = { id: uid('3333', 45), number: 'WO-26-0045' }

// Lining GRI: WO-26-0044 48 (20), 50 (40), WO-26-0045 52 (20), 54 (12 of which 12 are on another cut order) → 80 left.
export const GROUPS: WaitingGroup[] = [
  {
    kind: 'FABRIC',
    siteId: SITE.id,
    item: LINING,
    colour: GRI,
    garmentsLeft: 80,
    cells: [waiting(1, WO_44, '48', 20), waiting(2, WO_44, '50', 40), waiting(3, WO_45, '52', 20), waiting(4, WO_45, '54', 12, 12)],
  },
  { kind: 'LEATHER', siteId: SITE.id, item: LEATHER, colour: NER, garmentsLeft: 26, cells: [waiting(5, WO_44, '48', 20), waiting(6, WO_45, '52', 6)] },
]

export const STATIONS: Station[] = [
  { id: TABLE.id, siteId: SITE.id, code: 'TAV-01', name: 'Tavolo di taglio 1', status: 'ACTIVE' },
  { id: uid('6666', 2), siteId: SITE.id, code: 'TAV-02', name: 'Tavolo di taglio 2', status: 'ACTIVE' },
]

/** Lining for WO-26-0044 and WO-26-0045: ratio 48:1 · 50:2 · 52:1 on 20 plies in 2 lays = 80 garments. */
export const FABRIC_KEY = `FABRIC|${SITE.id}|${LINING.id}|${GRI.id}`
export const LEATHER_KEY = `LEATHER|${SITE.id}|${LEATHER.id}|${NER.id}`
export const CELL_IDS = GROUPS[0]!.cells.map((cell) => cell.workOrderSizeId)
export const LEATHER_CELL_IDS = GROUPS[1]!.cells.map((cell) => cell.workOrderSizeId)
