import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../lib/api/errors'
import { postProblemOf, type OrderLine, type OrderToReceive } from './api'
import {
  addHide,
  addLot,
  DDT_DAYS,
  ddtDays,
  ddtDigits,
  ddtFromPad,
  ddtNumberOf,
  deliverySummary,
  differenceOf,
  emptyDelivery,
  entered,
  entryOf,
  firstHideForm,
  formAfter,
  hideOfCode,
  hideTotals,
  hideUnitOf,
  lineIdAtBodyIndex,
  nextHideForm,
  quantityBounds,
  receiveBody,
  receives,
  setOver,
  setQuantity,
  tagCounts,
  tagState,
  tagsPending,
  undoHide,
  undoLot,
  type HideForm,
} from './model'

/** SCR-092's rules: the delivery as the tablet holds it, the totals against the order line, the body the API takes. */

const leather: OrderLine = {
  id: 'l10',
  seq: 10,
  item: {
    id: 'i1',
    code: 'PEL',
    name: 'Leather',
    tracking: 'HIDE',
    baseUom: 'M2',
    isPpeComponent: false,
  },
  colour: { code: 'NERO', name: 'Nero' },
  quantity: '100.0000',
  uom: 'FT2',
  expected: '100.0000',
  received: '20.0000',
  open: '80.0000',
  tolerancePct: '5',
  upTo: '85.0000',
  needDate: '2026-11-03',
  confirmedDate: null,
  estimatedHides: 20,
  hidesReceived: 4,
  grade: 'A',
  thicknessMinMm: null,
  thicknessMaxMm: null,
  oneDyeBatch: false,
  holds: ['CR_VI_TEST'],
  areaUnits: ['FT2', 'M2'],
}
const lots: OrderLine = {
  ...leather,
  id: 'l20',
  seq: 20,
  item: {
    ...leather.item,
    id: 'i2',
    code: 'PRT',
    tracking: 'LOT',
    baseUom: 'PAIR',
    isPpeComponent: true,
  },
  uom: 'PAIR',
  quantity: '10.0000',
  expected: '10.0000',
  received: '0.0000',
  open: '10.0000',
  tolerancePct: null,
  upTo: '10.0000',
  estimatedHides: null,
  hidesReceived: 0,
  holds: ['PPE_CERTIFICATE'],
  areaUnits: [],
}
const plain: OrderLine = {
  ...lots,
  id: 'l30',
  seq: 30,
  item: {
    ...lots.item,
    id: 'i3',
    code: 'FIL',
    tracking: 'NONE',
    baseUom: 'CONE',
    isPpeComponent: false,
  },
  holds: [],
}
const order: OrderToReceive = {
  serverTime: '2026-10-30T08:00:00.000Z',
  order: {
    id: 'po',
    number: 'PO-1',
    status: 'CONFIRMED',
    version: 3,
    supplier: { id: 's', name: 'Supplier' },
    requestedDate: null,
  },
  refusal: null,
  lines: [leather, lots, plain],
  dock: null,
  hold: null,
  printer: { id: 'p', code: 'LBL', name: 'Labels' },
}
const hideForm = (extra: Partial<HideForm> = {}): HideForm => ({
  ...firstHideForm(leather),
  area: 10,
  dyeBatch: 'DB1',
  ...extra,
})

describe('hides one by one', () => {
  it("measures a hide in the line's area unit and keeps grade, thickness, dye batch and shade for the next", () => {
    expect(hideUnitOf(leather)).toBe('FT2')
    expect(hideUnitOf({ ...leather, areaUnits: [], uom: 'PCS' })).toBe('M2')
    const form = hideForm({
      supplierCode: 'T1',
      thicknessMm: 1.2,
      shade: 'N2',
      defects: ['scar'],
    })
    const next = nextHideForm(form)
    expect(next).toMatchObject({
      supplierCode: null,
      area: null,
      defects: [],
      grade: 'A',
      thicknessMm: 1.2,
      dyeBatch: 'DB1',
      shade: 'N2',
    })
  })

  it('puts hides of one dye batch in one lot, a new dye batch in a new lot, and Undo takes the last hide back', () => {
    let delivery = emptyDelivery(order)
    delivery = addHide(delivery, leather, hideForm({ area: 10 }))
    delivery = addHide(delivery, leather, hideForm({ area: 11 }))
    delivery = addHide(delivery, leather, hideForm({ area: 12, dyeBatch: 'DB2' }))
    const entry = entryOf(delivery, leather.id)
    expect(entry.lots.map((lot) => [lot.dyeBatch, lot.hides.length])).toEqual([
      ['DB1', 2],
      ['DB2', 1],
    ])
    const undone = entryOf(undoHide(delivery, leather.id), leather.id)
    expect(undone.lots.map((lot) => lot.dyeBatch)).toEqual(['DB1'])
    expect(formAfter(leather, entryOf(undoHide(delivery, leather.id), leather.id)).dyeBatch).toBe('DB1')
    expect(addHide(delivery, leather, hideForm({ area: null }))).toBe(delivery)
  })

  it('totals in the hide unit against what is open (the base figures converted)', () => {
    // 10 ft² = 0.92903 m²; open 80 m² ≈ 861.11 ft².
    const delivery = addHide(emptyDelivery(order), leather, hideForm({ area: 10 }))
    const totals = hideTotals(leather, entryOf(delivery, leather.id))
    expect(totals).toMatchObject({
      hides: 1,
      expectedHides: 16,
      area: 10,
      unit: 'FT2',
    })
    expect(totals.open).toBeCloseTo(861.1128, 3)
    expect(differenceOf(leather, entryOf(delivery, leather.id)).kind).toBe('SHORT')
  })
})

describe('lots, quantities and the difference', () => {
  it('adds lots and a quantity in the base unit; over the tolerance asks a reason', () => {
    let delivery = addLot(emptyDelivery(order), lots.id, {
      quantity: 6,
      supplierLotRef: 'B1',
      hold: 'damaged',
    })
    delivery = addLot(delivery, lots.id, {
      quantity: 6,
      supplierLotRef: 'B2',
      hold: null,
    })
    expect(differenceOf(lots, entryOf(delivery, lots.id)).kind).toBe('OVER')
    delivery = setQuantity(delivery, plain.id, 10)
    expect(entered(delivery.entries[plain.id])).toBe(true)
    const summary = deliverySummary(order, delivery)
    expect(summary).toMatchObject({
      over: 1,
      short: 0,
      lots: 2,
      held: 2,
      needReason: [lots.id],
    })
    expect(deliverySummary(order, setOver(delivery, lots.id, 'supplierSent')).needReason).toEqual([])
    expect(entryOf(undoLot(delivery, lots.id), lots.id).lots.map((lot) => lot.supplierLotRef)).toEqual(['B1'])
  })

  it('defaults the pad to what is open, whole pieces for a count unit', () => {
    expect(quantityBounds(lots)).toMatchObject({
      min: 1,
      decimals: 0,
      suggested: 10,
    })
    expect(
      quantityBounds({
        ...plain,
        item: { ...plain.item, baseUom: 'M' },
        open: '12.5000',
      }),
    ).toMatchObject({ min: 0.01, decimals: 2, suggested: 12.5 })
  })
})

describe('the body the API takes', () => {
  it("sends each entered line in its tracking's shape, with the reasons in plain words, never a price", () => {
    let delivery = emptyDelivery(order, 'DDT 7')
    delivery = addHide(
      delivery,
      leather,
      hideForm({
        area: 52.4,
        supplierCode: 'T1',
        thicknessMm: 1.2,
        defects: ['hole', 'scar'],
      }),
    )
    delivery = addLot(delivery, lots.id, {
      quantity: 12,
      supplierLotRef: 'B1',
      hold: null,
    })
    delivery = setOver(delivery, lots.id, 'keepForNext')
    const body = receiveBody(order, delivery, {
      printerId: 'p',
      language: 'it',
    })
    expect(body).toEqual({
      version: 3,
      supplierDdtNumber: 'DDT 7',
      printerId: 'p',
      language: 'it',
      lines: [
        {
          purchaseOrderLineId: 'l10',
          lots: [
            {
              dyeBatch: 'DB1',
              hides: [
                {
                  area: '52.40',
                  areaUom: 'FT2',
                  supplierCode: 'T1',
                  grade: 'A',
                  thicknessMm: '1.20',
                  defects: 'hole, scar',
                },
              ],
            },
          ],
        },
        {
          purchaseOrderLineId: 'l20',
          uom: 'PAIR',
          lots: [{ quantity: '12', supplierLotRef: 'B1' }],
          differenceReason: 'Kept for the next order',
        },
      ],
    })
    expect(JSON.stringify(body)).not.toMatch(/price|cost|amount/i)
    expect(lineIdAtBodyIndex(order, delivery, 1)).toBe('l20')
    expect(receiveBody(order, delivery, { printerId: null, language: 'en' })).not.toHaveProperty('printerId')
    // B-W2a-75: the delivery note's date goes with the number (none given: not sent).
    expect(body).not.toHaveProperty('supplierDdtDate')
    expect(receiveBody(order, { ...delivery, ddtDate: '2026-10-29' }, { printerId: null, language: 'it' })).toMatchObject({ supplierDdtNumber: 'DDT 7', supplierDdtDate: '2026-10-29' })
  })

  it('B-W2a-75: the delivery note step — date tiles count back from the site\'s day; the pad types digits only', () => {
    expect(ddtDays('2026-11-02', 4)).toEqual(['2026-11-02', '2026-11-01', '2026-10-31', '2026-10-30'])
    expect(ddtDays('2026-03-01')).toHaveLength(DDT_DAYS)
    expect(ddtDays('2026-03-01')[1]).toBe('2026-02-28')
    expect(ddtDigits('4512')).toBe(4512)
    expect(ddtDigits('4512/26')).toBeNull()
    expect(ddtDigits(null)).toBeNull()
    expect(ddtFromPad(88123)).toBe('88123')
    expect(ddtFromPad(null)).toBeNull()
    expect(ddtNumberOf('  DDT 7  ')).toBe('DDT 7')
    expect(ddtNumberOf('   ')).toBeNull()
    expect(ddtNumberOf('x'.repeat(80))).toHaveLength(60)
  })

  it('reads which lines a refusal names: a difference reason, or another line problem', () => {
    const over = new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/lines/1/differenceReason', message: 'Give the reason.' }])
    expect(postProblemOf(over)).toEqual({ kind: 'over', lines: [1] })
    const invalid = new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/lines/0/lots/0/hides/2/area', message: 'Above 0.' }])
    expect(postProblemOf(invalid)).toMatchObject({
      kind: 'task',
      lineIndex: 0,
      problem: { kind: 'invalid' },
    })
    expect(postProblemOf(new ApiError('conflict', 409, 'conflict', 'x', null, []))).toMatchObject({ kind: 'task', problem: { kind: 'conflict' } })
    expect(receives('CONFIRMED')).toBe(true)
    expect(receives('CHANGES_PROPOSED')).toBe(false)
  })
})

describe('the tags after the post', () => {
  const receipt = {
    hides: [
      { id: 'h1', code: 'HD-AA-000001-X' },
      { id: 'h2', code: 'HD-AA-000002-Y' },
      { id: 'h3', code: 'HD-AA-000003-Z' },
    ],
    tags: {
      printer: null,
      jobs: [
        {
          hideId: 'h1',
          code: 'HD-AA-000001-X',
          jobId: 'j1',
          status: 'PRINTED' as const,
          version: 2,
          problem: null,
        },
        {
          hideId: 'h2',
          code: 'HD-AA-000002-Y',
          jobId: 'j2',
          status: 'QUEUED' as const,
          version: 1,
          problem: null,
        },
        {
          hideId: 'h3',
          code: 'HD-AA-000003-Z',
          jobId: null,
          status: null,
          version: null,
          problem: 'No printer.',
        },
      ],
    },
  }
  it("says each tag's print state and reads again while one is on its way", () => {
    expect(tagState(receipt.tags.jobs[0])).toBe('printed')
    expect(tagState(receipt.tags.jobs[2])).toBe('notPrinted')
    expect(tagCounts(receipt as never)).toEqual({
      queued: 1,
      sent: 0,
      printed: 1,
      failed: 0,
      notPrinted: 1,
    })
    expect(tagsPending(receipt as never)).toBe(true)
    expect(hideOfCode(receipt as never, ' hd-aa-000002-y ')).toBe('h2')
    expect(hideOfCode(receipt as never, 'XX')).toBeNull()
  })
})
