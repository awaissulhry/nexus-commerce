import { at, COLOURS, MATERIALS, SITE, SUPPLIERS, uid } from '../../../_shared/buying/fixtures'
import type { ExpectedLine, LotWithHides, Receipt, ReceiptCounts, ReceiptHide, ReceiptLine, ReceiptLot, ReceiptRow } from '../api'
import { blankHide, receiveDraft, type HideDraft, type ReceiveDraft } from '../model'

/**
 * Made-up receipts for SCR-061 … SCR-063: the order lines still to receive (leather by area with its tolerance, lining
 * by lot, protectors by quantity), receipts "GR-2026-00NN" with lots "LA-0000NN" and hides "HD-DEMO-…", each figure
 * worked out by hand. Design-only; it exports no `designScreen`.
 */

const PO = { id: uid('5801', 3), number: 'PO-2026-0003' }

export const expected = (over: Partial<ExpectedLine> = {}): ExpectedLine => ({
  purchaseOrderId: PO.id,
  number: PO.number,
  status: 'PARTLY_RECEIVED',
  version: 6,
  siteId: SITE.id,
  supplier: { id: SUPPLIERS.tannery.id, name: SUPPLIERS.tannery.legalName },
  purchaseOrderLineId: uid('5803', 31),
  seq: 10,
  item: { id: MATERIALS.leather.id, code: MATERIALS.leather.code, name: MATERIALS.leather.name, tracking: 'HIDE', baseUom: 'FT2' },
  colour: COLOURS.black,
  quantity: '420.0000',
  uom: 'FT2',
  baseQuantity: '420.0000',
  expected: '420.0000',
  received: '212.4000',
  open: '207.6000',
  tolerancePct: '5',
  estimatedHides: 8,
  oneDyeBatch: true,
  requiresCrViTest: true,
  needDate: '2026-11-20',
  ...over,
})

export const EXPECTED: ExpectedLine[] = [
  expected(),
  expected({ purchaseOrderLineId: uid('5803', 33), seq: 30, item: { id: MATERIALS.lining.id, code: MATERIALS.lining.code, name: MATERIALS.lining.name, tracking: 'LOT', baseUom: 'M' }, colour: COLOURS.grey, quantity: '60.0000', uom: 'M', baseQuantity: '60.0000', expected: '60.0000', received: '0.0000', open: '60.0000', tolerancePct: null, estimatedHides: null, oneDyeBatch: false, requiresCrViTest: false }),
  expected({ purchaseOrderId: uid('5801', 4), number: 'PO-2026-0004', status: 'CONFIRMED', supplier: { id: SUPPLIERS.protector.id, name: SUPPLIERS.protector.legalName }, purchaseOrderLineId: uid('5803', 41), seq: 10, item: { id: MATERIALS.protector.id, code: MATERIALS.protector.code, name: MATERIALS.protector.name, tracking: 'NONE', baseUom: 'PCS' }, colour: null, quantity: '48.0000', uom: 'PCS', baseQuantity: '48.0000', expected: '48.0000', received: '0.0000', open: '48.0000', tolerancePct: null, estimatedHides: null, oneDyeBatch: false, requiresCrViTest: false, needDate: '2026-11-13' }),
  expected({ purchaseOrderId: uid('5801', 7), number: 'PO-2026-0007', status: 'SENT', supplier: { id: SUPPLIERS.fabric.id, name: SUPPLIERS.fabric.legalName }, purchaseOrderLineId: uid('5803', 71), seq: 10, item: { id: MATERIALS.lining.id, code: MATERIALS.lining.code, name: MATERIALS.lining.name, tracking: 'LOT', baseUom: 'M' }, colour: COLOURS.black, quantity: '15.0000', uom: 'M', baseQuantity: '15.0000', expected: '15.0000', received: '0.0000', open: '15.0000', tolerancePct: null, estimatedHides: null, oneDyeBatch: false, requiresCrViTest: false, needDate: '2026-11-18' }),
]

export const COUNTS: ReceiptCounts = { posted: 21, reversed: 1, waiting: 3, postedSince: 2 }

const rowOf = (n: number, over: Partial<ReceiptRow> = {}): ReceiptRow => ({
  id: uid('6301', n),
  number: `GR-2026-${String(n).padStart(4, '0')}`,
  status: 'POSTED',
  companyId: SITE.companyId,
  siteId: SITE.id,
  supplier: { id: SUPPLIERS.tannery.id, name: SUPPLIERS.tannery.legalName },
  purchaseOrder: PO,
  supplierDdtNumber: `DDT-DEMO-${540 + n}`,
  supplierDdtDate: '2026-10-29',
  receivedAt: at(29, 8, 15),
  lines: 1,
  lots: 1,
  lotsReleased: 0,
  hides: 9,
  quantities: [{ uom: 'FT2', baseQuantity: '212.4000' }],
  postedAt: at(29, 8, 20),
  value: { currency: 'EUR', valueAmount: 89_208 },
  ...over,
})

export const ROWS: ReceiptRow[] = [
  rowOf(22, { lines: 2, lots: 2, lotsReleased: 1, hides: 9, quantities: [{ uom: 'FT2', baseQuantity: '212.4000' }, { uom: 'PCS', baseQuantity: '24.0000' }], value: { currency: 'EUR', valueAmount: 104_808 } }),
  rowOf(21, { supplier: { id: SUPPLIERS.protector.id, name: SUPPLIERS.protector.legalName }, purchaseOrder: { id: uid('5801', 4), number: 'PO-2026-0004' }, lines: 1, lots: 1, lotsReleased: 1, hides: 0, quantities: [{ uom: 'PCS', baseQuantity: '24.0000' }], receivedAt: at(28, 14, 5), postedAt: at(28, 14, 9), value: { currency: 'EUR', valueAmount: 15_600 } }),
  rowOf(20, { supplier: { id: SUPPLIERS.fabric.id, name: SUPPLIERS.fabric.legalName }, purchaseOrder: { id: uid('5801', 2), number: 'PO-2026-0002' }, lots: 1, lotsReleased: 1, hides: 0, quantities: [{ uom: 'M', baseQuantity: '12.0000' }], supplierDdtNumber: null, supplierDdtDate: null, receivedAt: at(27, 9, 40), postedAt: at(27, 9, 41), value: { currency: 'EUR', valueAmount: 9_480 } }),
  rowOf(19, { status: 'REVERSED', lotsReleased: 0, receivedAt: at(26, 11), postedAt: at(26, 11, 2), value: { currency: 'EUR', valueAmount: 0 } }),
]

// ---- the record and its lots ----------------------------------------------------------------------------------------------------

export const lotOf = (n: number, over: Partial<ReceiptLot> = {}): ReceiptLot => ({
  id: uid('6262', n),
  code: `LA-${String(n).padStart(6, '0')}`,
  supplierLotRef: `CD-${7700 + n}`,
  dyeBatch: `TB-${300 + n}`,
  shade: 'B',
  receivedAt: at(29, 8, 15),
  qualityStatus: 'QUARANTINE',
  requiresCrViTest: true,
  crViStatus: 'PENDING',
  crViLimitMgKg: '3.000',
  holds: ['CR_VI_TEST'],
  baseQuantity: '212.4000',
  hideCount: 9,
  ...over,
})

const LINES: ReceiptLine[] = [
  {
    id: uid('6302', 1),
    seq: 10,
    purchaseOrderLineId: uid('5803', 31),
    item: { id: MATERIALS.leather.id, code: MATERIALS.leather.code, name: MATERIALS.leather.name, tracking: 'HIDE', baseUom: 'FT2' },
    colour: COLOURS.black,
    quantity: '212.4000',
    uom: 'FT2',
    baseQuantity: '212.4000',
    hideCount: 9,
    note: null,
    orderLine: { seq: 10, quantity: '420.0000', uom: 'FT2', baseQuantity: '420.0000', expected: '420.0000', received: '212.4000', open: '207.6000', tolerancePct: '5', estimatedHides: 8, oneDyeBatch: true, requiresCrViTest: true },
    difference: { kind: 'SHORT', expected: '420.0000', receivedBefore: '0.0000', after: '212.4000', open: '207.6000', difference: '-207.6000', tolerancePct: '5', upTo: '441.0000' },
    lots: [lotOf(44)],
    value: { currency: 'EUR', valueAmount: 89_208 },
  },
  {
    id: uid('6302', 2),
    seq: 20,
    purchaseOrderLineId: uid('5803', 32),
    item: { id: MATERIALS.protector.id, code: MATERIALS.protector.code, name: MATERIALS.protector.name, tracking: 'LOT', baseUom: 'PCS' },
    colour: null,
    quantity: '24.0000',
    uom: 'PCS',
    baseQuantity: '24.0000',
    hideCount: null,
    note: null,
    orderLine: { seq: 20, quantity: '24.0000', uom: 'PCS', baseQuantity: '24.0000', expected: '24.0000', received: '24.0000', open: '0.0000', tolerancePct: null, estimatedHides: null, oneDyeBatch: false, requiresCrViTest: false },
    difference: { kind: 'EXACT', expected: '24.0000', receivedBefore: '0.0000', after: '24.0000', open: '0.0000', difference: '0.0000', tolerancePct: '0', upTo: '24.0000' },
    lots: [lotOf(45, { code: 'LA-000045', supplierLotRef: 'PP-2611', dyeBatch: null, shade: null, qualityStatus: 'RELEASED', requiresCrViTest: false, crViStatus: 'NOT_REQUIRED', crViLimitMgKg: null, holds: [], baseQuantity: '24.0000', hideCount: 0 })],
    value: { currency: 'EUR', valueAmount: 15_600 },
  },
]

export const receipt = (over: Partial<Receipt> = {}): Receipt => ({
  id: uid('6301', 22),
  number: 'GR-2026-0022',
  status: 'POSTED',
  companyId: SITE.companyId,
  siteId: SITE.id,
  site: { code: SITE.code, name: SITE.name },
  supplier: { id: SUPPLIERS.tannery.id, name: SUPPLIERS.tannery.legalName },
  purchaseOrder: { id: PO.id, number: PO.number, status: 'PARTLY_RECEIVED', version: 6 },
  supplierDdtNumber: 'DDT-DEMO-562',
  supplierDdtDate: '2026-10-29',
  supplierDdtCorrection: null,
  receivedAt: at(29, 8, 15),
  note: null,
  location: { id: SITE.locations[0]!.id, code: 'N-RCV', name: 'Banchina ricevimento' },
  postedAt: at(29, 8, 20),
  reversedAt: null,
  reversalReason: null,
  cancelledAt: null,
  version: 2,
  createdAt: at(29, 8, 20),
  summary: { lines: 2, lots: 2, lotsInQuarantine: 1, lotsReleased: 1, hides: 9, quantities: [{ uom: 'FT2', baseQuantity: '212.4000' }, { uom: 'PCS', baseQuantity: '24.0000' }] },
  lines: LINES,
  ddtPhotos: [],
  discrepancies: { count: 0, open: 0, unsent: 0 },
  reversal: { possible: true, location: 'N-RCV', blockers: [] },
  value: { currency: 'EUR', valueAmount: 104_808 },
  ...over,
})

const AREAS = ['23.6', '24.1', '22.8', '25.3', '23.9', '21.7', '24.6', '23.2', '23.2']
const hide = (n: number, area: string, over: Partial<ReceiptHide> = {}): ReceiptHide => ({
  id: uid('6464', n),
  code: `HD-DEMO-${String(1040 + n).padStart(6, '0')}-${n % 10}`,
  supplierCode: `T-${88100 + n}`,
  area,
  areaUom: 'FT2',
  baseArea: Number(area).toFixed(4),
  grade: n % 4 === 0 ? 'B' : 'A',
  shade: 'B',
  thicknessMm: n % 3 === 0 ? '1.30' : '1.20',
  defects: n === 3 ? 'Small scar near the neck' : null,
  state: 'FULL',
  onHand: Number(area).toFixed(4),
  locationId: SITE.locations[0]!.id,
  ...over,
})

export const LOTS: LotWithHides[] = [
  { ...lotOf(44), lineSeq: 10, itemId: MATERIALS.leather.id, itemColourId: COLOURS.black.id, hides: AREAS.map((area, index) => hide(index + 1, area)), onHand: '212.4000' },
  { ...LINES[1]!.lots[0]!, lineSeq: 20, itemId: MATERIALS.protector.id, itemColourId: null, hides: [], onHand: '24.0000' },
]

// ---- the receiving form ----------------------------------------------------------------------------------------------------------

const typedHide = (line: ExpectedLine, n: number, area: string, over: Partial<HideDraft> = {}): HideDraft => ({ ...blankHide(line), key: `h-demo-${n}`, supplierCode: `T-${88200 + n}`, area, grade: 'A', thicknessMm: '1.2', ...over })

/** The open lines of PO-2026-0003 as a form: the leather's second dye lot typed hide by hide, the lining's lot. */
export function typedDraft(kind: 'empty' | 'typed' | 'over' | 'held' = 'typed'): ReceiveDraft {
  const lines = EXPECTED.filter((line) => line.purchaseOrderId === PO.id)
  const draft = receiveDraft(PO.id, lines)
  if (kind === 'empty') return { ...draft, lines: draft.lines.map((entry) => ({ ...entry, lots: entry.lots.map((lot, index) => ({ ...lot, key: `l-demo-${entry.line.seq}-${index}`, hides: lot.hides.map((row, at) => ({ ...row, key: `h-demo-e${at}` })) })) })) }
  const leather = draft.lines[0]!
  const areas = kind === 'over' ? ['26.2', '27.1', '25.8', '26.4', '27.3', '26.6', '27.0', '26.1', '25.9'] : ['22.9', '23.4', '24.0', '22.6', '23.8', '23.1', '22.7', '24.2', '23.0']
  const hides = areas.map((area, index) => typedHide(leather.line, index + 1, area, index === 4 ? { defects: 'Tick marks on the belly' } : {}))
  if (kind === 'typed') hides.push({ ...typedHide(leather.line, 10, ''), supplierCode: 'T-88210' })
  return {
    ...draft,
    ddtNumber: 'DDT-DEMO-571',
    ddtDate: '2026-10-29',
    lines: [
      { ...leather, lots: [{ ...leather.lots[0]!, key: 'l-demo-10-0', supplierLotRef: 'CD-7745', dyeBatch: 'TB-345', shade: 'B', hold: kind === 'held', holdReason: kind === 'held' ? 'Colour looks lighter than the sample' : '', hides }], differenceReason: kind === 'over' ? '' : '' },
      { ...draft.lines[1]!, lots: [{ ...draft.lines[1]!.lots[0]!, key: 'l-demo-30-0', supplierLotRef: 'TE-2210', quantity: '60' }] },
    ],
  }
}
