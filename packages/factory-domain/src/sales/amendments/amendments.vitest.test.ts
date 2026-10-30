import { describe, expect, it } from 'vitest'
import { amendmentDiff, amendmentProblems, amendStateProblem, nextRevision, snapshotOf, type AmendableLine, type SnapshotHeader, type SnapshotLine } from './amendments'

const header: SnapshotHeader = { customerRef: 'PO-1', requestedDate: null, promiseDate: '2026-12-20', paymentTerms: 'Bonifico', currency: 'EUR', taxMode: 'IT_B2B', netAmount: 624_000, vatAmount: 137_280, grossAmount: 761_280 }
const blk: SnapshotLine = {
  id: 'L1',
  seq: 10,
  kind: 'SIZE_GRID',
  styleId: 'S',
  colourwayId: 'BLK',
  description: 'Jacket BLK',
  note: null,
  quantity: 8,
  unitPrice: '450',
  netAmount: 360_000,
  vatRatePct: '22.00',
  vatAmount: 79_200,
  closedShortQuantity: null,
  sizes: [
    { size: '50', quantity: 2, unitPrice: null },
    { size: '52', quantity: 4, unitPrice: null },
    { size: '54', quantity: 2, unitPrice: null },
  ],
}
const red: SnapshotLine = { ...blk, id: 'L2', seq: 20, colourwayId: 'RED', description: 'Jacket RED', quantity: 6, unitPrice: '440', netAmount: 264_000, vatAmount: 58_080, sizes: [{ size: '52', quantity: 6, unitPrice: null }] }

describe('the snapshot and the difference (SAL-217)', () => {
  it('lists lines added, removed and changed, sizes old → new and the money change', () => {
    const before = snapshotOf(header, [red, blk])
    expect(before.lines.map((line) => line.id)).toEqual(['L1', 'L2'])
    const changed: SnapshotLine = { ...blk, quantity: 10, netAmount: 450_000, sizes: [{ size: '50', quantity: 2, unitPrice: null }, { size: '52', quantity: 6, unitPrice: null }, { size: '54', quantity: 2, unitPrice: null }] }
    const added: SnapshotLine = { ...blk, id: 'N1', seq: 30, colourwayId: 'TAN', quantity: 2, netAmount: 90_000, sizes: [{ size: '48', quantity: 2, unitPrice: null }] }
    const after = snapshotOf({ ...header, netAmount: 540_000, grossAmount: 658_800, requestedDate: '2026-12-01' }, [changed, added])
    const diff = amendmentDiff(before, after)
    expect(diff.lines.map((line) => [line.change, line.lineId, line.piecesBefore, line.piecesAfter])).toEqual([
      ['CHANGED', 'L1', 8, 10],
      ['REMOVED', 'L2', 6, 0],
      ['ADDED', 'N1', 0, 2],
    ])
    expect(diff.lines[0]!.sizes).toEqual([{ size: '52', before: 4, after: 6 }])
    expect(diff.header).toEqual([{ field: 'requestedDate', before: null, after: '2026-12-01' }])
    expect([diff.netBefore, diff.netAfter, diff.reacceptanceNeeded, diff.empty]).toEqual([624_000, 540_000, true, false])
  })

  it('a price change alone is a change; the same order is no change and needs no new acceptance', () => {
    const before = snapshotOf(header, [blk])
    const priced = amendmentDiff(before, snapshotOf(header, [{ ...blk, unitPrice: '455' }]))
    expect(priced.lines[0]).toMatchObject({ change: 'CHANGED', unitPrice: { before: '450', after: '455' }, sizes: [] })
    expect(priced.reacceptanceNeeded).toBe(false)
    expect(amendmentDiff(before, snapshotOf(header, [blk])).empty).toBe(true)
  })
})

describe('what an amendment may do (SAL-209)', () => {
  const current: AmendableLine[] = [
    { id: 'L1', seq: 10, kind: 'SIZE_GRID', closedShort: false, sizes: blk.sizes, inWorkOrders: new Map([['52', 4]]) },
    { id: 'L2', seq: 20, kind: 'SIZE_GRID', closedShort: false, sizes: red.sizes, inWorkOrders: new Map() },
    { id: 'L3', seq: 30, kind: 'SIZE_GRID', closedShort: true, sizes: red.sizes, inWorkOrders: new Map() },
  ]

  it('only while nothing shipped', () => {
    expect(amendStateProblem('IN_PRODUCTION')).toBeNull()
    expect(amendStateProblem('PARTLY_SHIPPED')).toMatch(/its lines no longer change/)
  })

  it('a reason; never under what work orders make; no removal of a line in work orders or closed short', () => {
    const problems = amendmentProblems({
      status: 'CONFIRMED',
      reason: ' ',
      current,
      lines: [
        { id: 'L1', sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 3 }] },
        { id: 'L3', sizes: [{ size: '52', quantity: 2 }] },
        { styleId: 'S', sizes: [{ size: '50', quantity: 1 }] },
        { id: 'L9' },
      ],
    })
    expect(problems.map((issue) => issue.path)).toEqual(['body/reason', 'body/lines/0/sizes', 'body/lines/1/sizes', 'body/lines/2/colourwayId', 'body/lines/3/id'])
    expect(problems[1]!.message).toBe('Size 52: work orders already make 4 piece(s); lower the work order first (3 asked).')
    const removal = amendmentProblems({ status: 'CONFIRMED', reason: 'Customer asked.', current, lines: [{ id: 'L2' }] })
    expect(removal.map((issue) => issue.message)).toEqual([
      'Line 10 is in work orders (4 piece(s)): it cannot be removed; lower or cancel the work order first.',
      'Line 30 is closed short: reopen it before removing it.',
    ])
    expect(amendmentProblems({ status: 'CONFIRMED', reason: 'Customer asked.', current, lines: [{ id: 'L1' }, { id: 'L2', sizes: [{ size: '52', quantity: 4 }] }, { id: 'L3' }] })).toEqual([])
  })

  it('numbers amendments one after another', () => {
    expect(nextRevision([])).toBe(1)
    expect(nextRevision([1, 3, 2])).toBe(4)
  })
})
