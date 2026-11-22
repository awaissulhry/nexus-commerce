import { describe, expect, it } from 'vitest'
import { garmentsLeft, groupsByPromise, movableOf, moveProblems, reasonProblems, type DeliveryChoice } from './split'
import { groupMoveProblems, mergedAsks } from './split' // B-OS-010

// Made-up lines and days.
const line = (id: string, quantity: number, packed = 0, serials = 0) => ({ id, quantity, packed, serials })

describe('split one order into several shipments (LOG-005)', () => {
  it('moves only garments not in a carton and without a serial', () => {
    expect(movableOf(line('a', 3))).toBe(3)
    expect(movableOf(line('a', 3, 1, 2))).toBe(1)
    expect(movableOf(line('a', 2, 2))).toBe(0)
  })

  it('checks each line, what may move of it, and that something stays', () => {
    const lines = [line('a', 3, 1), line('b', 2, 0, 2)]
    expect(moveProblems(lines, [{ lineId: 'a', quantity: 2 }])).toEqual([])
    expect(moveProblems(lines, [{ lineId: 'a', quantity: 3 }])[0]!.message).toBe('From 1 to 2 garment(s) of this line can move.')
    expect(moveProblems(lines, [{ lineId: 'b', quantity: 1 }])[0]!.path).toBe('lines/0/quantity')
    expect(moveProblems(lines, [{ lineId: 'x', quantity: 1 }])[0]!.path).toBe('lines/0/lineId')
    expect(moveProblems(lines, [])[0]!.path).toBe('lines')
    expect(garmentsLeft([line('a', 2)], [{ lineId: 'a', quantity: 2 }])).toBe(0)
  })

  it('a split by carrier, service or delivery address changes it', () => {
    const from: DeliveryChoice = { transportBy: 'CARRIER', carrierCode: 'test-express', serviceCode: 'std', shipToAddressId: 'addr-1' }
    expect(reasonProblems('CARRIER', from, from)[0]!.path).toBe('carrierCode')
    expect(reasonProblems('CARRIER', from, { ...from, transportBy: 'SENDER', carrierCode: null })).toEqual([])
    expect(reasonProblems('SERVICE', from, { ...from, serviceCode: 'express' })).toEqual([])
    expect(reasonProblems('SHIP_TO', from, from)[0]!.path).toBe('shipToAddressId')
    expect(reasonProblems('CUSTOMER_REQUEST', from, from)).toEqual([])
  })

  it('by promise date: the earliest day stays, each later day becomes a shipment of what may move', () => {
    const groups = groupsByPromise([
      { ...line('a', 2), shipBy: '2026-11-20' },
      { ...line('b', 3, 1), shipBy: '2026-11-27' },
      { ...line('c', 1), shipBy: '2026-12-04' },
      { ...line('d', 1), shipBy: null },
    ])
    expect(groups.stays).toBe('2026-11-20')
    expect(groups.groups).toEqual([
      { shipBy: '2026-11-27', moves: [{ lineId: 'b', quantity: 2 }], garments: 2 },
      { shipBy: '2026-12-04', moves: [{ lineId: 'c', quantity: 1 }], garments: 1 },
    ])
    expect(groups.kept).toEqual([{ lineId: 'b', garments: 1 }])
    expect(groupsByPromise([{ ...line('a', 1), shipBy: '2026-11-20' }]).groups).toEqual([])
  })
})

// ---- B-OS-010 (order shipments tab; X1 S1): split into several shipments in one go ----
describe('split into several shipments at once (B-OS-010)', () => {
  const lines = [line('a', 4, 1), line('b', 2), line('c', 1, 0, 1)]

  it('each new shipment names its garments, each line once in it; a line may give to several, never more than may move in all', () => {
    expect(groupMoveProblems(lines, [{ moves: [{ lineId: 'a', quantity: 2 }] }, { moves: [{ lineId: 'a', quantity: 1 }, { lineId: 'b', quantity: 2 }] }])).toEqual([])
    // a: 3 may move (1 in a carton); 2 + 2 asked over two shipments.
    const over = groupMoveProblems(lines, [{ moves: [{ lineId: 'a', quantity: 2 }] }, { moves: [{ lineId: 'a', quantity: 2 }] }])
    expect(over.map((issue) => issue.path)).toEqual(['groups/0/lines/0/quantity', 'groups/1/lines/0/quantity'])
    expect(over[0]!.message).toBe('From 1 to 3 garment(s) of this line can move, over every new shipment.')
    expect(groupMoveProblems(lines, [{ moves: [{ lineId: 'b', quantity: 1 }, { lineId: 'b', quantity: 1 }] }])[0]!.path).toBe('groups/0/lines/1/lineId')
    expect(groupMoveProblems(lines, [{ moves: [{ lineId: 'c', quantity: 1 }] }])[0]!.message).toMatch(/^None of this line can move/)
    expect(groupMoveProblems(lines, [{ moves: [] }])[0]!.path).toBe('groups/0/lines')
    expect(groupMoveProblems(lines, [{ moves: [{ lineId: 'x', quantity: 1 }] }])[0]!.path).toBe('groups/0/lines/0/lineId')
  })

  it('1 to 20 new shipments; the asks of one line add up (what the split re-checks under its lock), and something stays', () => {
    expect(groupMoveProblems(lines, [])[0]!.path).toBe('groups')
    expect(groupMoveProblems(lines, Array.from({ length: 21 }, () => ({ moves: [{ lineId: 'b', quantity: 1 }] })))[0]!.message).toBe('At most 20 new shipments at a time.')
    const groups = [{ moves: [{ lineId: 'a', quantity: 2 }] }, { moves: [{ lineId: 'a', quantity: 1 }, { lineId: 'b', quantity: 2 }] }]
    expect(mergedAsks(groups)).toEqual([{ lineId: 'a', quantity: 3 }, { lineId: 'b', quantity: 2 }])
    expect(garmentsLeft(lines, mergedAsks(groups))).toBe(2)
  })
})
// ---- end B-OS-010
