import { describe, expect, it } from 'vitest'
import { CONFIRMED_ROW, DRAFT_ROW, HELD_ROW, PRODUCTION_ROW, SENT_ROW, TEXT_ROW, readLine } from './fixtures'
import { commitRouteOf, confirmPlanOf, deletePlanOf, orderKeyOf, patchRow, restrictPlanOf, rowOfKey, sizesFromText } from './map'
import { changedKeysOf, sheetTouches } from './use-office-sheet'
import { stagedHistoryOf } from './windows/ReviewChangeWindow'
import { pictureChoicesOf } from './windows/SheetPictureWindow'

const lineOf = (row: typeof DRAFT_ROW, seq: number) => row.lines.find((line) => line.seq === seq) ?? null

describe('owb-of3 step 3 — L2: where a typed cell goes, per row kind', () => {
  it('a Draft saves in place: the subject and the wanted day through the draft header', () => {
    expect(commitRouteOf(DRAFT_ROW, null, 'what', ' Winter suits ')).toEqual({ kind: 'header', requestId: 'req-draft', body: { subject: 'Winter suits' } })
    expect(commitRouteOf(DRAFT_ROW, null, 'wanted', '2027-01-31')).toEqual({ kind: 'header', requestId: 'req-draft', body: { requestedDate: '2027-01-31' } })
    expect(commitRouteOf(DRAFT_ROW, null, 'wanted', '')).toEqual({ kind: 'header', requestId: 'req-draft', body: { requestedDate: null } })
  })

  it('a Draft’s catalogue line takes its sizes; its colour, pieces and product are the order page’s', () => {
    const line = lineOf(DRAFT_ROW, 1)
    expect(commitRouteOf(DRAFT_ROW, line, 'sizes', '48 × 2 · 50 × 3')).toEqual({ kind: 'line', requestId: 'req-draft', lineId: 'line-1', body: { sizes: [{ size: '48', quantity: 2 }, { size: '50', quantity: 3 }] } })
    expect(commitRouteOf(DRAFT_ROW, line, 'material', 'Kangaroo')).toEqual({ kind: 'refused', why: 'catalogueMaterial' })
    expect(commitRouteOf(DRAFT_ROW, line, 'pieces', '9')).toEqual({ kind: 'refused', why: 'cataloguePieces' })
    expect(commitRouteOf(DRAFT_ROW, line, 'sizes', 'big ones')).toEqual({ kind: 'refused', why: 'sizes' })
  })

  it('a Draft’s described line takes its words, material, pieces and sizes as a custom line', () => {
    const line = lineOf(DRAFT_ROW, 2)
    expect(commitRouteOf(DRAFT_ROW, line, 'what', 'A rain jacket, hood')).toEqual({ kind: 'customLine', requestId: 'req-draft', lineId: 'line-2', body: { description: 'A rain jacket, hood' } })
    expect(commitRouteOf(DRAFT_ROW, line, 'material', 'Nylon')).toEqual({ kind: 'customLine', requestId: 'req-draft', lineId: 'line-2', body: { colourText: 'Nylon' } })
    expect(commitRouteOf(DRAFT_ROW, line, 'pieces', '6')).toEqual({ kind: 'customLine', requestId: 'req-draft', lineId: 'line-2', body: { quantity: 6 } })
    expect(commitRouteOf(DRAFT_ROW, line, 'sizes', 'M:2 L:4')).toMatchObject({ kind: 'customLine', body: { sizes: [{ size: 'M', quantity: 2 }, { size: 'L', quantity: 4 }] } })
  })

  it('a Sent order reads only: "Confirm it first", whatever the cell', () => {
    expect(commitRouteOf(SENT_ROW, null, 'what', 'x')).toEqual({ kind: 'refused', why: 'confirmFirst' })
    expect(commitRouteOf(SENT_ROW, lineOf(SENT_ROW, 1), 'sizes', '48:1')).toEqual({ kind: 'refused', why: 'confirmFirst' })
  })

  it('a Confirmed order stages ONE change of a line’s sizes for Review and save — never a silent write', () => {
    expect(commitRouteOf(CONFIRMED_ROW, lineOf(CONFIRMED_ROW, 1), 'sizes', '48:2 50:4')).toEqual({ kind: 'review', orderId: 'order-1', lineId: 'line-1', sizes: { '48': 2, '50': 4 } })
    expect(commitRouteOf(CONFIRMED_ROW, lineOf(CONFIRMED_ROW, 1), 'pieces', '7')).toEqual({ kind: 'refused', why: 'readOnly' })
    expect(commitRouteOf(CONFIRMED_ROW, null, 'what', 'New subject')).toEqual({ kind: 'refused', why: 'readOnly' })
    expect(commitRouteOf(CONFIRMED_ROW, lineOf(CONFIRMED_ROW, 1), 'sizes', '')).toEqual({ kind: 'refused', why: 'sizes' })
  })

  it('in production and later every cell reads only', () => {
    expect(commitRouteOf(PRODUCTION_ROW, lineOf(PRODUCTION_ROW, 1), 'sizes', '48:9')).toEqual({ kind: 'refused', why: 'readOnly' })
  })

  it('the staged change keeps every other size of the line as it is and zeroes a size not typed', () => {
    const order = { lines: [{ id: 'line-1', seq: 1, kind: 'SIZE_GRID', quantity: 5, closedShort: null, sizes: [{ size: '48', quantity: 2 }, { size: '50', quantity: 3 }], description: null, note: null, unitPrice: undefined }] }
    const history = stagedHistoryOf(order as never, 'line-1', { '48': 4 })
    expect(history.draft.lines['line-1']?.sizes).toEqual({ '48': 4, '50': 0 })
  })

  it('a saved draft cell stands in place on the row (the version moves; pieces follow sizes)', () => {
    const saved = patchRow(DRAFT_ROW, 'line-1', 'sizes', '48:4 50:4', 7)
    expect(saved.version).toBe(7)
    expect(saved.lines[0]).toMatchObject({ sizes: '48:4 50:4', pieces: 8 })
    expect(saved.pieces).toBe(8 + 3)
    expect(patchRow(DRAFT_ROW, null, 'what', 'Renamed', 8)).toMatchObject({ subject: 'Renamed', version: 8 })
  })

  it('the part’s keys find the row and the line', () => {
    expect(rowOfKey([DRAFT_ROW], 'REQUEST:req-draft', 'REQUEST:req-draft/line-2')?.line?.id).toBe('line-2')
    expect(rowOfKey([DRAFT_ROW], 'REQUEST:req-draft', null)?.line).toBeNull()
    expect(rowOfKey([DRAFT_ROW], 'ORDER:nope', null)).toBeNull()
  })

  it('sizes in words read three ways; anything else does not read', () => {
    expect(sizesFromText('48:2 50:3')).toEqual([{ size: '48', quantity: 2 }, { size: '50', quantity: 3 }])
    expect(sizesFromText('XL x 1, XXL x 2')).toEqual([{ size: 'XL', quantity: 1 }, { size: 'XXL', quantity: 2 }])
    expect(sizesFromText('')).toEqual([])
    expect(sizesFromText('large')).toBeNull()
  })
})

describe('owb-of3 step 3 — bulk acts skip what they cannot do and say how many', () => {
  const rows = [DRAFT_ROW, SENT_ROW, TEXT_ROW, HELD_ROW, CONFIRMED_ROW, PRODUCTION_ROW]
  const all = rows.map(orderKeyOf)

  it('bulk Confirm skips a text order, a Sent order that holds, and what is not Sent', () => {
    const plan = confirmPlanOf(rows, all)
    expect(plan.go.map((row) => row.id)).toEqual(['req-sent'])
    expect(plan.text).toBe(1)
    expect(plan.held).toBe(1)
    expect(plan.other).toBe(3)
  })

  it('a customer on hold holds Confirm too', () => {
    expect(confirmPlanOf([{ ...SENT_ROW, customerOnHold: true }], [orderKeyOf(SENT_ROW)]).held).toBe(1)
  })

  it('Delete the drafts takes drafts only; Restrict takes confirmed orders not restricted yet', () => {
    expect(deletePlanOf(rows, all)).toMatchObject({ go: [DRAFT_ROW], other: 5 })
    expect(restrictPlanOf(rows, all).go.map((row) => row.id)).toEqual(['order-1', 'order-2'])
    expect(restrictPlanOf([{ ...CONFIRMED_ROW, restricted: true }], [orderKeyOf(CONFIRMED_ROW)]).go).toEqual([])
  })
})

describe('owb-of3 step 4 — live, and the picture choices', () => {
  it('live: an order’s, a request’s or an ask’s event touches the sheet; after Show the changed rows flash', () => {
    expect(sheetTouches({ type: 'sales_order.confirmed' })).toBe(true)
    expect(sheetTouches({ type: 'portal_order_request.sent' })).toBe(true)
    expect(sheetTouches({ type: 'order_change_request.asked' })).toBe(true)
    expect(sheetTouches({ type: 'thread.message_posted' })).toBe(false)
    expect(changedKeysOf(null, [DRAFT_ROW])).toEqual([])
    expect(changedKeysOf([DRAFT_ROW, SENT_ROW], [{ ...DRAFT_ROW, version: 9 }, SENT_ROW, CONFIRMED_ROW])).toEqual(['REQUEST:req-draft', 'ORDER:order-1'])
  })

  it('a picture may be an image or a PDF the customer can open — never office only, never a size sheet', () => {
    const choices = pictureChoicesOf([
      { id: 'f1', name: 'mockup.pdf', contentType: 'application/pdf', audience: 'CUSTOMER_CAN_SEE' },
      { id: 'f2', name: 'front.png', contentType: 'image/png' },
      { id: 'f3', name: 'internal.png', contentType: 'image/png', audience: 'OFFICE_ONLY' },
      { id: 'f4', name: 'sizes.xlsx', contentType: 'application/vnd.ms-excel' },
      { id: 'f5', name: 'rider.png', contentType: 'image/png', locked: true },
    ])
    expect(choices.map((choice) => `${choice.fileId}:${choice.kind}`)).toEqual(['f1:pdf', 'f2:image'])
  })

  it('a line without a product holds bulk Confirm (A-5)', () => {
    expect(confirmPlanOf([{ ...SENT_ROW, lines: [readLine(1, { product: null })] }], [orderKeyOf(SENT_ROW)]).held).toBe(1)
  })
})
