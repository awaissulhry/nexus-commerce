import { describe, expect, it } from 'vitest'
import { binWalkOrder, compareBinCodes, placesOf, takeInWalkOrder, walkOrder, type BinPlace, type WalkSortable } from './walk'

const place = (id: string, code: string, parentId: string | null = null, extra: Partial<BinPlace> = {}): BinPlace => ({ id, parentId, code, name: code, kind: 'BIN', labelCode: null, blocked: false, ...extra })

describe('the bin path (B-W2b-298; SCM-212)', () => {
  it('orders codes naturally: digits as numbers, then text', () => {
    expect(['A1-10', 'A1-2', 'A1-1', 'A1-02', 'B', 'A1'].sort(compareBinCodes)).toEqual(['A1', 'A1-1', 'A1-2', 'A1-02', 'A1-10', 'B'])
    expect(compareBinCodes('R2-S10', 'R2-S9')).toBe(1)
    expect(compareBinCodes('X', 'X')).toBe(0)
  })

  it('walks the tree depth first, the places inside one place in natural order', () => {
    const order = binWalkOrder([
      place('store', 'A1-STORE'),
      place('b10', 'A1-STORE-10', 'store'),
      place('b2', 'A1-STORE-2', 'store'),
      place('b2-top', 'A1-STORE-2-TOP', 'b2'),
      place('dock', 'A1-RCV'),
      place('orphan', 'ZZ', 'gone'),
    ])
    expect([...order.values()].map((bin) => [bin.code, bin.rank, bin.path.join('/')])).toEqual([
      ['A1-RCV', 0, 'A1-RCV'],
      ['A1-STORE', 1, 'A1-STORE'],
      ['A1-STORE-2', 2, 'A1-STORE/A1-STORE-2'],
      ['A1-STORE-2-TOP', 3, 'A1-STORE/A1-STORE-2/A1-STORE-2-TOP'],
      ['A1-STORE-10', 4, 'A1-STORE/A1-STORE-10'],
      ['ZZ', 5, 'ZZ'],
    ])
  })

  it('keeps every place once, even in a loop', () => {
    const order = binWalkOrder([place('a', 'A', 'b'), place('b', 'B', 'a'), place('c', 'C')])
    expect([...order.values()].map((bin) => bin.code).sort()).toEqual(['A', 'B', 'C'])
    expect(order.get('c')!.rank).toBe(0)
  })
})

describe('the walk', () => {
  const order = binWalkOrder([place('p1', 'A-1'), place('p2', 'A-2'), place('p10', 'A-10')])

  it('takes a quantity place by place in walking order; a hide whole wherever it lies', () => {
    expect(takeInWalkOrder('7', [{ locationId: 'p10', onHand: '5' }, { locationId: 'p2', onHand: '4' }], order)).toEqual([
      { locationId: 'p2', quantity: '4.0000' },
      { locationId: 'p10', quantity: '3.0000' },
    ])
    expect(takeInWalkOrder('7', [{ locationId: 'p10', onHand: '40.5' }], order, true)).toEqual([{ locationId: 'p10', quantity: '40.5000' }])
    expect(takeInWalkOrder('7', [{ locationId: 'p1', onHand: '0' }], order)).toEqual([])
    // A place the walk does not know comes last.
    expect(takeInWalkOrder('9', [{ locationId: 'elsewhere', onHand: '5' }, { locationId: 'p1', onHand: '5' }], order).map((take) => take.locationId)).toEqual(['p1', 'elsewhere'])
  })

  it('sorts stops by place, then work order, material and lot; reserved before a proposal; places in order', () => {
    const stop = (locationId: string, workOrderNumber: string, itemCode: string, source: WalkSortable['source'], lotCode: string | null = null): WalkSortable & { id: string } => ({
      id: `${locationId}-${workOrderNumber}-${itemCode}-${source}`,
      locationId,
      workOrderNumber,
      itemCode,
      colourCode: null,
      lotCode,
      hideCode: null,
      source,
    })
    const walked = walkOrder([stop('p10', 'WO-2', 'LIN', 'PROPOSED'), stop('p2', 'WO-10', 'LIN', 'RESERVED'), stop('p2', 'WO-2', 'PRO', 'PROPOSED'), stop('p2', 'WO-2', 'PRO', 'RESERVED'), stop('p1', 'WO-2', 'LIN', 'SUBSTITUTE')], order)
    expect(walked.map((entry) => entry.id)).toEqual(['p1-WO-2-LIN-SUBSTITUTE', 'p2-WO-2-PRO-RESERVED', 'p2-WO-2-PRO-PROPOSED', 'p2-WO-10-LIN-RESERVED', 'p10-WO-2-LIN-PROPOSED'])
    expect(placesOf(walked)).toEqual([
      { locationId: 'p1', stops: 1 },
      { locationId: 'p2', stops: 3 },
      { locationId: 'p10', stops: 1 },
    ])
  })
})
