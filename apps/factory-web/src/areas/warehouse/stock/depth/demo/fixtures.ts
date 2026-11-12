import type { PrinterOption, StockRow } from '../../../../_shared/stock/api'
import { at, COLOURS, COMPANY, ITEMS, LOCATIONS, LOTS, named, SITE, stockRow, uid } from '../../../../_shared/stock/fixtures'
import type { BlockView, DefaultView, PartyChoice, PlaceLabel, PlaceView } from '../../../locations/depth/api'
import type { LowRow, PostingCheck, WaitingAdjustment, WarehouseRules, Why } from '../api'

/**
 * Made-up data of B-W2b-327's design cases (Stock SCR-060, Movements SCR-064, Locations SCR-065 and a location): the demo
 * site's places with their kinds, label codes and blocks (bin A1 counted, the quarantine shelf damaged, a transit place
 * towards the south site), lining on its way there, the materials below their minimum, why a figure is what it is, the
 * warehouse rules' approval value and an adjustment waiting for a yes. Nothing here is a real company, person or number.
 * Design-only (fixtures and tests import it); it exports no `designScreen`.
 */

export const COUNT_BLOCK: BlockView = { reason: 'COUNT', note: 'Count CNT-D-0007 is running here.', until: null, at: at(30, 7, 30), byId: null, holds: true, countNumber: 'CNT-D-0007' }
export const DAMAGE_BLOCK: BlockView = { reason: 'DAMAGE', note: 'Perdita dal tetto: ripiano da asciugare', until: '2026-11-02', at: at(29, 15, 10), byId: uid('5151', 1), holds: true, countNumber: null }

export const TRANSIT: PlaceView = {
  id: uid('2323', 20),
  companyId: COMPANY,
  siteId: SITE.id,
  parentId: null,
  code: 'N-TRANSIT',
  name: 'In transito verso MAG-S',
  kind: 'TRANSIT',
  status: 'ACTIVE',
  depth: 0,
  path: ['N-TRANSIT'],
  version: 1,
  createdAt: at(20, 8),
  updatedAt: at(20, 8),
  labelCode: null,
  block: null,
}
export const PICK_FACE: PlaceView = { ...TRANSIT, id: uid('2323', 21), code: 'N-PF-01', name: 'Faccia di prelievo taglio', kind: 'PICK_FACE', path: ['N-PF-01'], labelCode: 'STAB-N-N-PF-01' }

/** The site's places as the W1 list answers them since B-W2b-289: label codes, two blocks, a transit place. */
export const PLACES: PlaceView[] = [
  { ...LOCATIONS.store, labelCode: 'STAB-N-N-MAG', block: null },
  { ...LOCATIONS.rackA, labelCode: 'STAB-N-N-MAG-A', block: null },
  { ...LOCATIONS.binA1, labelCode: 'STAB-N-N-MAG-A-01', block: COUNT_BLOCK },
  { ...LOCATIONS.binA2, labelCode: null, block: null },
  { ...LOCATIONS.receiving, labelCode: 'STAB-N-N-RCV', block: null },
  { ...LOCATIONS.quarantine, labelCode: 'STAB-N-N-QUA', block: DAMAGE_BLOCK },
  { ...LOCATIONS.cutting, labelCode: 'STAB-N-N-TAG', block: null },
  { ...LOCATIONS.old, labelCode: null, block: null },
  PICK_FACE,
  TRANSIT,
]
export const ACTIVE_PLACES = PLACES.filter((place) => place.status === 'ACTIVE')

/** 25 m of the lining lot shipped to the south site: on the transit place until it is received there. */
export const TRANSIT_ROW: StockRow = stockRow({ item: ITEMS.lining, location: named(TRANSIT), colour: COLOURS.black, lot: { id: LOTS.lining.id, code: LOTS.lining.code, qualityStatus: 'RELEASED' }, onHand: '25.0000', held: '0.0000', available: '25.0000', unitCost: '3.100000', value: 7_750 })

export const DEFAULTS: DefaultView[] = [
  { id: uid('5252', 1), itemKind: null, purpose: 'RECEIVING', location: { id: LOCATIONS.receiving.id, code: LOCATIONS.receiving.code, name: LOCATIONS.receiving.name, kind: 'RECEIVING', status: 'ACTIVE' }, version: 1, updatedAt: at(10, 9), updatedById: null },
  { id: uid('5252', 2), itemKind: null, purpose: 'QUALITY', location: { id: LOCATIONS.quarantine.id, code: LOCATIONS.quarantine.code, name: LOCATIONS.quarantine.name, kind: 'QUARANTINE', status: 'ACTIVE' }, version: 1, updatedAt: at(10, 9), updatedById: null },
  { id: uid('5252', 3), itemKind: 'LEATHER', purpose: 'PUT_AWAY', location: { id: LOCATIONS.binA1.id, code: LOCATIONS.binA1.code, name: LOCATIONS.binA1.name, kind: 'BIN', status: 'ACTIVE' }, version: 2, updatedAt: at(12, 9), updatedById: null },
  { id: uid('5252', 4), itemKind: null, purpose: 'ISSUE', location: { id: LOCATIONS.cutting.id, code: LOCATIONS.cutting.code, name: LOCATIONS.cutting.name, kind: 'PRODUCTION', status: 'ACTIVE' }, version: 1, updatedAt: at(10, 9), updatedById: null },
]

const site = { id: SITE.id, code: SITE.code, name: SITE.name }
const lowRow = (n: number, item: (typeof ITEMS)[keyof typeof ITEMS], over: Partial<LowRow>): LowRow => ({
  site,
  item: { id: item.id, code: item.code, name: item.name, kind: 'TRIM', baseUom: item.baseUom },
  colour: null,
  itemPlanningId: uid('5353', n),
  basis: 'MIN_MAX',
  minimum: '0.0000',
  onHand: '0.0000',
  onOrder: '0.0000',
  reserved: '0.0000',
  position: '0.0000',
  below: true,
  short: '0.0000',
  ...over,
})
/** Below their minimum: protectors (on hand 40, 24 reserved, none on order), zips (all reserved), a lining colour with no stock. */
export const LOW_ROWS: LowRow[] = [
  lowRow(1, ITEMS.protector, { basis: 'MIN_MAX', minimum: '60.0000', onHand: '40.0000', reserved: '24.0000', position: '16.0000', short: '44.0000' }),
  lowRow(2, ITEMS.zip, { basis: 'REORDER_POINT', minimum: '250.0000', onHand: '300.0000', onOrder: '0.0000', reserved: '120.0000', position: '180.0000', short: '70.0000' }),
  lowRow(3, ITEMS.lining, { colour: COLOURS.red, basis: 'SAFETY_STOCK', minimum: '40.0000', onHand: '0.0000', onOrder: '30.0000', position: '30.0000', short: '10.0000' }),
]

/** Why is it 120 m (the lining lot at bin A2): received 150, issued 32, a count +2 → 120 ✓. */
export const WHY_LINING: Why = {
  site,
  item: ITEMS.lining,
  colour: COLOURS.black,
  lot: LOTS.lining,
  hide: null,
  location: { id: LOCATIONS.binA2.id, code: LOCATIONS.binA2.code, name: LOCATIONS.binA2.name },
  uom: 'M',
  basis: 'POSTING',
  period: { from: null, to: '2026-10-30' },
  start: '0.0000',
  steps: [
    { reason: 'RECEIPT', sign: '+', in: '150.0000', out: '0.0000', net: '150.0000', moves: 2, before: '0.0000', after: '150.0000', moveId: null, link: { path: '/inventory/ledger', query: { siteId: SITE.id, itemId: ITEMS.lining.id, lotId: LOTS.lining.id, locationId: LOCATIONS.binA2.id, reasons: 'RECEIPT' } } },
    { reason: 'ISSUE', sign: '−', in: '0.0000', out: '32.0000', net: '-32.0000', moves: 3, before: '150.0000', after: '118.0000', moveId: null, link: { path: '/inventory/ledger', query: { siteId: SITE.id, itemId: ITEMS.lining.id, lotId: LOTS.lining.id, locationId: LOCATIONS.binA2.id, reasons: 'ISSUE' } } },
    { reason: 'COUNT', sign: '±', in: '2.0000', out: '0.0000', net: '2.0000', moves: 1, before: '118.0000', after: '120.0000', moveId: uid('8383', 5), link: { path: '/inventory/ledger', query: { siteId: SITE.id, itemId: ITEMS.lining.id, lotId: LOTS.lining.id, locationId: LOCATIONS.binA2.id, reasons: 'COUNT' } } },
  ],
  sum: '120.0000',
  end: '120.0000',
  addsUp: true,
  gap: '0.0000',
  onHandNow: '120.0000',
  moves: 6,
  last: [
    { id: uid('8383', 5), reason: 'COUNT', occurredAt: at(27, 17, 30), postingDay: '2026-10-27', backDated: false, delta: '2.0000', document: null, reference: 'Conta 27/10' },
    { id: uid('8383', 41), reason: 'ISSUE', occurredAt: at(24, 9, 10), postingDay: '2026-10-24', backDated: false, delta: '-12.0000', document: { type: 'WorkOrder', id: uid('9191', 1), number: 'WO-D-0031' }, reference: null },
    { id: uid('8383', 42), reason: 'ISSUE', occurredAt: at(22, 9, 0), postingDay: '2026-10-21', backDated: true, delta: '-10.0000', document: { type: 'WorkOrder', id: uid('9191', 2), number: 'WO-D-0032' }, reference: null },
    { id: uid('8383', 43), reason: 'RECEIPT', occurredAt: at(14, 10, 5), postingDay: '2026-10-14', backDated: false, delta: '100.0000', document: { type: 'GoodsReceipt', id: uid('9292', 1), number: 'GR-D-0012' }, reference: null },
  ],
  allMoves: { path: '/inventory/ledger', query: { siteId: SITE.id, itemId: ITEMS.lining.id, lotId: LOTS.lining.id, locationId: LOCATIONS.binA2.id } },
}
/** The same figure with a gap of 0,5 m (a fault: reported). */
export const WHY_GAP: Why = { ...WHY_LINING, end: '120.5000', onHandNow: '120.5000', addsUp: false, gap: '0.5000' }
/** Over a period (October, by posting day): the start balance before 1 Oct. */
export const WHY_PERIOD: Why = { ...WHY_LINING, period: { from: '2026-10-01', to: '2026-10-30' }, start: '20.0000', steps: WHY_LINING.steps.map((step) => (step.reason === 'RECEIPT' ? { ...step, in: '130.0000', net: '130.0000', before: '20.0000' } : step)) }

/** Adjustments worth more than € 500 wait for Finance's yes. */
export const RULES: WarehouseRules = {
  companyId: COMPANY,
  postingDates: { inForce: { days: 3 }, today: '2026-10-30', earliest: '2026-10-27' },
  adjustmentApproval: { inForce: { amount: 50_000, set: true }, currency: 'EUR', approvalRules: { active: 1 }, held: null },
}

export const POSTING_OK: PostingCheck = { day: '2026-10-28', today: '2026-10-30', earliest: '2026-10-27', backDatingDays: { days: 3 }, allowed: true, problem: null, periodLock: null }
export const POSTING_TOO_FAR: PostingCheck = { ...POSTING_OK, day: '2026-10-20', allowed: false, problem: 'Too far back.' }
export const POSTING_SOFT: PostingCheck = { ...POSTING_OK, day: '2026-09-30', allowed: true, periodLock: { level: 'SOFT', periodStart: '2026-09-01', periodEnd: '2026-09-30', needsReason: true } }
export const POSTING_HARD: PostingCheck = { ...POSTING_OK, day: '2026-09-30', allowed: false, periodLock: { level: 'HARD', periodStart: '2026-09-01', periodEnd: '2026-09-30', needsReason: false } }

/** 300 m of lining found at bin A2 (worth more than € 500): waiting for Finance since 10:42. */
export const WAITING: WaitingAdjustment = {
  requestId: uid('5454', 1),
  taskId: uid('5455', 1),
  status: 'PENDING',
  requestedAt: at(30, 9, 42),
  requestedBy: { id: uid('5151', 2), name: null },
  approver: { kind: 'ROLE', id: uid('5656', 1), name: 'Amministrazione' },
  dueAt: null,
  site,
  item: { id: ITEMS.lining.id, code: ITEMS.lining.code, name: ITEMS.lining.name, baseUom: 'M' },
  colour: COLOURS.black,
  lot: LOTS.lining,
  hide: null,
  location: { id: LOCATIONS.binA2.id, code: LOCATIONS.binA2.code, name: LOCATIONS.binA2.name },
  direction: 'IN',
  quantity: '300.0000',
  uom: 'M',
  baseQuantity: '300.0000',
  onHand: { from: '120.0000', to: '420.0000' },
  note: 'Rotoli ritrovati nel soppalco',
  reasonCode: null,
  postingDate: null,
}
export const WAITING_DOWN: WaitingAdjustment = { ...WAITING, requestId: uid('5454', 2), taskId: uid('5455', 2), requestedAt: at(29, 16, 5), approver: { kind: 'PERSON', id: uid('5151', 3), name: 'Paola Esempio' }, item: { id: ITEMS.protector.id, code: ITEMS.protector.code, name: ITEMS.protector.name, baseUom: 'PCS' }, colour: null, lot: LOTS.protector, location: { id: LOCATIONS.receiving.id, code: LOCATIONS.receiving.code, name: LOCATIONS.receiving.name }, direction: 'OUT', quantity: '30.0000', uom: 'PCS', baseQuantity: '30.0000', onHand: { from: '48.0000', to: '18.0000' } }

// ---- bin labels (Locations › Labels, Print labels) ----------------------------------------------------------------------------

export const PRINTERS: PrinterOption[] = [
  { id: uid('5757', 1), siteId: SITE.id, code: 'ZPL-MAG', name: 'Etichettatrice magazzino', kind: 'LABEL_ZPL', status: 'ACTIVE' },
  { id: uid('5757', 2), siteId: SITE.id, code: 'ZPL-TAG', name: 'Etichettatrice taglio', kind: 'LABEL_ZPL', status: 'ACTIVE' },
]

/** The bin label of rack A as it prints (Italian), printed once, a reprint that failed. */
export const RACK_LABEL: PlaceLabel = {
  location: { id: LOCATIONS.rackA.id, code: LOCATIONS.rackA.code, labelCode: 'STAB-N-N-MAG-A', version: 1 },
  code: 'STAB-N-N-MAG-A',
  suggested: false,
  labelled: true,
  label: {
    language: 'it',
    heading: 'Ubicazione · Officina Demo',
    title: LOCATIONS.rackA.name,
    scanId: 'STAB-N-N-MAG-A',
    fields: [
      { label: 'Sito', value: SITE.code },
      { label: 'Percorso', value: 'N-MAG › N-MAG-A' },
      { label: 'Tipo', value: 'Zona' },
      { label: 'Codice', value: LOCATIONS.rackA.code },
    ],
  },
  jobs: [
    { jobId: uid('5858', 2), printerId: PRINTERS[0]!.id, printerCode: 'ZPL-MAG', state: 'FAILED', copies: 1, lastError: 'Paper out', at: at(29, 11, 5), printedAt: null },
    { jobId: uid('5858', 1), printerId: PRINTERS[0]!.id, printerCode: 'ZPL-MAG', state: 'PRINTED', copies: 2, lastError: null, at: at(12, 9, 30), printedAt: at(12, 9, 31) },
  ],
}
/** Bin A2 has no code yet: the label shows the one it gets. */
export const BIN_LABEL: PlaceLabel = {
  ...RACK_LABEL,
  location: { id: LOCATIONS.binA2.id, code: LOCATIONS.binA2.code, labelCode: null, version: 1 },
  code: 'STAB-N-N-MAG-A-02',
  suggested: true,
  label: { ...RACK_LABEL.label, title: LOCATIONS.binA2.name, scanId: 'STAB-N-N-MAG-A-02', fields: [{ label: 'Sito', value: SITE.code }, { label: 'Percorso', value: 'N-MAG › N-MAG-A › N-MAG-A-02' }, { label: 'Tipo', value: 'Scaffale' }, { label: 'Codice', value: LOCATIONS.binA2.code }] },
  jobs: [],
}

/** Customers a customer's place may name (made-up). */
export const CUSTOMERS: PartyChoice[] = [
  { id: uid('6161', 1), code: 'CLI-DEMO-01', name: 'Moto Esempio S.r.l.' },
  { id: uid('6161', 2), code: 'CLI-DEMO-02', name: 'Team Prova Racing' },
]
