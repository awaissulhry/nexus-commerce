import { describe, expect, it } from 'vitest'
import { mapHeaders } from '../../imports/headers'
import { parseRow } from '../../imports/plan'
import { hideInputOf, packingListImporter, PORTAL_PACKING_LIST } from './importer'
import {
  checkShipNotice,
  differencesNeedNote,
  lineProblems,
  noticeStateOf,
  placeHides,
  receivedPerLine,
  sendProblems,
  termsProblems,
  type NoticeHideFacts,
  type OrderLineFacts,
} from './rules'

/** Made-up order lines: 105 ft² of black leather (grade A, 1.1–1.3 mm, one dye batch, ±5 %, about 5 hides, Cr VI) and 24 protectors. */
const leather: OrderLineFacts = {
  id: 'pol-10',
  seq: 10,
  uom: 'FT2',
  leather: true,
  expected: '105',
  received: '0',
  inTransit: '0',
  tolerancePct: '5',
  grade: 'A',
  thicknessMinMm: '1.1',
  thicknessMaxMm: '1.3',
  oneDyeBatch: true,
  estimatedHides: 5,
  requiresCrViTest: true,
  earlierDyeBatches: [],
}
const protector: OrderLineFacts = { ...leather, id: 'pol-20', seq: 20, uom: 'PCS', leather: false, expected: '24', tolerancePct: null, grade: null, thicknessMinMm: null, thicknessMaxMm: null, oneDyeBatch: false, estimatedHides: null, requiresCrViTest: false }
const line = { id: 'snl-1', seq: 10, purchaseOrderLineId: 'pol-10', quantity: '105', uom: 'FT2' as const, dyeBatch: '2231' }
const hide = (seq: number, over: Partial<NoticeHideFacts> = {}): NoticeHideFacts => ({ lineId: 'snl-1', seq, hideNumber: `2231-${String(seq).padStart(3, '0')}`, area: '21', areaUom: 'FT2', grade: 'A', thicknessMm: '1.2', dyeBatch: '2231', ...over })
const five = [1, 2, 3, 4, 5].map((seq) => hide(seq))

describe('how a notice reads (design: Announced / In transit / Received / Received with differences)', () => {
  it('is in transit once its ship date has come, received with differences when a line differs', () => {
    expect(noticeStateOf({ status: 'SENT', shipDate: '2026-11-10', lines: [] }, '2026-11-09')).toBe('ANNOUNCED')
    expect(noticeStateOf({ status: 'SENT', shipDate: '2026-11-10', lines: [] }, '2026-11-10')).toBe('IN_TRANSIT')
    expect(noticeStateOf({ status: 'RECEIVED', shipDate: '2026-11-10', lines: [{ quantity: '105', receivedQuantity: '105.0000' }] }, '2026-11-12')).toBe('RECEIVED')
    expect(noticeStateOf({ status: 'RECEIVED', shipDate: '2026-11-10', lines: [{ quantity: '105', receivedQuantity: '98.5' }] }, '2026-11-12')).toBe('RECEIVED_WITH_DIFFERENCES')
    expect(noticeStateOf({ status: 'DRAFT', shipDate: null, lines: [] }, '2026-11-12')).toBe('DRAFT')
    expect(noticeStateOf({ status: 'CANCELLED', shipDate: null, lines: [] }, '2026-11-12')).toBe('CANCELLED')
  })
})

describe('the packing list against the order (SCM-107)', () => {
  it('is OK when every hide is as ordered and the list adds up to the line', () => {
    const check = checkShipNotice({ orderLines: [leather], lines: [line], hides: five, crViEvidence: true })
    expect(check.verdict).toBe('OK')
    expect(check.lines[0]).toMatchObject({ verdict: 'OK', hides: 5, area: '105', openAfter: '0' })
    expect(check.counts).toEqual({ ok: 5, check: 0, notAsOrdered: 0 })
  })

  it('names each hide that is not as ordered: grade, thickness, another dye batch', () => {
    const hides = [hide(1, { grade: 'B' }), hide(2, { thicknessMm: '1.6' }), hide(3, { dyeBatch: '2240' }), hide(4, { grade: null, thicknessMm: null }), hide(5)]
    const check = checkShipNotice({ orderLines: [leather], lines: [line], hides, crViEvidence: true })
    expect(check.verdict).toBe('NOT_AS_ORDERED')
    const rows = Object.fromEntries(check.hides.map((row) => [row.seq, row]))
    expect(rows[1]!.reasons.map((reason) => reason.code)).toEqual(['GRADE'])
    expect(rows[1]!.reasons[0]!.words.en).toBe('Grade B: the order asks A.')
    expect(rows[2]!.reasons[0]!.words.it).toBe('1.6 mm, fuori dai 1.1–1.3 mm chiesti.')
    expect(rows[3]!.reasons.map((reason) => reason.code)).toEqual(['DYE_BATCH'])
    expect(rows[4]!).toMatchObject({ verdict: 'CHECK' })
    expect(rows[4]!.reasons.map((reason) => reason.code)).toEqual(['NO_GRADE', 'NO_THICKNESS'])
    expect(rows[5]!.verdict).toBe('OK')
    expect(check.lines[0]!.reasons.map((reason) => reason.code)).toEqual(['DYE_BATCHES'])
    expect(check.counts).toEqual({ ok: 1, check: 1, notAsOrdered: 3 })
  })

  it('reads the total area in the line’s unit, against the open quantity and its tolerance', () => {
    // 10 m² ≈ 107.64 ft²: within 5 % of 105, but the line says 105 ft² and the list adds up to more than 105 ± 5 %? No: within.
    const metric = [hide(1, { area: '5', areaUom: 'M2' }), hide(2, { area: '5', areaUom: 'M2' })]
    const ok = checkShipNotice({ orderLines: [{ ...leather, estimatedHides: null }], lines: [line], hides: metric, crViEvidence: true })
    expect(ok.lines[0]!.area).toBe('107.6391')
    expect(ok.lines[0]!.reasons).toEqual([])
    // With 40 ft² received before, 105 more is beyond the 110.25 the tolerance allows.
    const over = checkShipNotice({ orderLines: [{ ...leather, received: '40' }], lines: [line], hides: five, crViEvidence: true })
    expect(over.lines[0]!.reasons.map((reason) => reason.code)).toEqual(['OVER_ORDER'])
    expect(over.lines[0]!.reasons[0]!.words.en).toBe('105 FT2 with 40 FT2 already received or on its way: more than the 105 FT2 ordered (up to 110.25 with its 5% tolerance).')
    expect(over.verdict).toBe('NOT_AS_ORDERED')
  })

  it('asks for a look when the list and the line disagree, the hide count is off, or no Cr VI test report is on file', () => {
    const check = checkShipNotice({ orderLines: [leather], lines: [{ ...line, quantity: '80' }], hides: [hide(1, { area: '50' }), hide(2, { area: '50' })], crViEvidence: false })
    expect(check.lines[0]!.reasons.map((reason) => reason.code)).toEqual(['LIST_VS_LINE', 'HIDE_COUNT', 'CR_VI'])
    expect(check.lines[0]!.verdict).toBe('CHECK')
    expect(check.verdict).toBe('CHECK')
  })

  it('says a leather line without a packing list is measured at the dock; a protector line is checked for its quantity only', () => {
    const check = checkShipNotice({ orderLines: [leather, protector], lines: [line, { id: 'snl-2', seq: 20, purchaseOrderLineId: 'pol-20', quantity: '30', uom: 'PCS', dyeBatch: null }], hides: [], crViEvidence: true })
    expect(check.lines.map((entry) => entry.reasons.map((reason) => reason.code))).toEqual([['NO_PACKING_LIST'], ['OVER_ORDER']])
  })

  it('keeps one dye batch across deliveries', () => {
    const check = checkShipNotice({ orderLines: [{ ...leather, earlierDyeBatches: ['2199'] }], lines: [line], hides: five, crViEvidence: true })
    expect(check.lines[0]!.reasons.map((reason) => reason.code)).toEqual(['EARLIER_DYE_BATCH'])
  })

  it('lets differences go only with a note for the dock', () => {
    expect(differencesNeedNote({ verdict: 'NOT_AS_ORDERED' }, ' ')).toMatchObject({ path: 'body/note' })
    expect(differencesNeedNote({ verdict: 'NOT_AS_ORDERED' }, 'Two hides grade B, priced as agreed by phone')).toBeNull()
    expect(differencesNeedNote({ verdict: 'CHECK' }, null)).toBeNull()
  })
})

describe('what the supplier writes', () => {
  const blank = { supplierRef: null, ddtNumber: null, ddtDate: null, shipDate: null, expectedDate: null, carrier: null, trackingNumber: null, parcels: null, note: null }
  it('checks the terms: a DDT date with its number, arrival not before departure, parcels 1..9999', () => {
    expect(termsProblems({ ...blank, shipDate: '2026-11-10', expectedDate: '2026-11-12', parcels: 3 })).toEqual([])
    expect(termsProblems({ ...blank, ddtDate: '2026-11-10', shipDate: '2026-11-10', expectedDate: '2026-11-09', parcels: 0, carrier: 'x'.repeat(101) }).map((issue) => issue.path)).toEqual(['body/carrier', 'body/ddtDate', 'body/expectedDate', 'body/parcels'])
  })

  it('checks the lines against the open lines of the order', () => {
    const open = new Set(['pol-10', 'pol-20'])
    expect(lineProblems([{ purchaseOrderLineId: 'pol-10', quantity: '50' }], open)).toEqual([])
    expect(lineProblems([{ purchaseOrderLineId: 'pol-10', quantity: '0' }, { purchaseOrderLineId: 'pol-10', quantity: '1.12345' }, { purchaseOrderLineId: 'pol-99', quantity: '1' }], open).map((issue) => issue.path)).toEqual([
      'body/lines/0/quantity',
      'body/lines/1/purchaseOrderLineId',
      'body/lines/1/quantity',
      'body/lines/2/purchaseOrderLineId',
    ])
  })

  it('places the packing list on the leather lines, each hide once, in an area unit', () => {
    const lines = [{ id: 'snl-1', orderSeq: 10, uom: 'FT2' as const }]
    const placed = placeHides([{ hideNumber: '2231-001', area: '21' }, { hideNumber: '2231-002', area: '2', unit: 'M2', thicknessMm: '1.2' }], lines)
    expect(placed.issues).toEqual([])
    expect(placed.hides.map((entry) => [entry.lineId, entry.hideNumber, entry.areaUom])).toEqual([
      ['snl-1', '2231-001', 'FT2'],
      ['snl-1', '2231-002', 'M2'],
    ])
    const refused = placeHides([{ hideNumber: '2231-001', area: '21' }, { hideNumber: '2231-001 ', area: '-1' }, { line: 20, hideNumber: 'X', area: '1' }], lines)
    expect(refused.issues.map((issue) => issue.path)).toEqual(['body/rows/1/hideNumber', 'body/rows/1/area', 'body/rows/2/line'])
    expect(refused.hides).toHaveLength(1)
    expect(placeHides([{ hideNumber: 'A', area: '1' }], [...lines, { id: 'snl-2', orderSeq: 30, uom: 'M2' }]).issues[0]!.path).toBe('body/rows/0/line')
  })

  it('says why a notice cannot be sent yet', () => {
    expect(sendProblems({ lines: 0, shipDate: null, expectedDate: null }).map((issue) => issue.path)).toEqual(['body/lines', 'body/shipDate', 'body/expectedDate'])
    expect(sendProblems({ lines: 1, shipDate: '2026-11-10', expectedDate: '2026-11-11' })).toEqual([])
  })

  it('shares what a receipt took out over the notice lines of each order line', () => {
    const lines = [
      { id: 'a', seq: 10, purchaseOrderLineId: 'pol-10', quantity: '60' },
      { id: 'b', seq: 20, purchaseOrderLineId: 'pol-10', quantity: '45' },
      { id: 'c', seq: 30, purchaseOrderLineId: 'pol-20', quantity: '24' },
    ]
    expect(Object.fromEntries(receivedPerLine(lines, new Map([['pol-10', '98.5']])))).toEqual({ a: '60', b: '38.5', c: '0' })
  })
})

describe('the packing list sheet (imports registry, SCM-107)', () => {
  it('reads a tannery’s Italian sheet in the portal without the notice column', () => {
    const mapping = mapHeaders(PORTAL_PACKING_LIST.columns, ['Numero pelle', 'Superficie', 'UM', 'Scelta', 'Spessore', 'Bagno'])
    expect(mapping.issues).toEqual([])
    const parsed = parseRow(PORTAL_PACKING_LIST, mapping.columns, { rowNumber: 2, cells: ['2231-017', '12,45', 'piedi', 'A', '1,2', '2231'] }, { numberFormat: 'it' })
    expect(parsed.errors).toEqual([])
    expect(hideInputOf(parsed.values)).toEqual({ line: null, hideNumber: '2231-017', area: '12.45', unit: 'FT2', grade: 'A', thicknessMm: '1.2', dyeBatch: '2231', note: null })
    const wrong = parseRow(PORTAL_PACKING_LIST, mapping.columns, { rowNumber: 14, cells: ['2231-018', '12,4x', 'piedi', 'A', '', ''] }, { numberFormat: 'it' })
    expect(wrong.errors.map((error) => error.column)).toEqual(['area'])
  })

  it('needs the notice in the office’s import (its key with the hide number)', () => {
    expect(packingListImporter.keyColumns).toEqual(['notice', 'hideNumber'])
    expect(mapHeaders(packingListImporter.columns, ['hide number', 'area']).issues.length).toBeGreaterThan(0)
  })
})
