import { describe, expect, it } from 'vitest'
import { reversalProblems } from '../../inventory/ledger/moves'
import { repairCellWords } from './backorder'
import { chargeBasisOf, freightCostProblems } from './freight'
import { carrierReturnNote, carrierReturnProblems, carrierReturnState, splitTakeByLines } from './stock'
import { INTRASTAT_TRANSPORT_CODES, isTransportMode, TRANSPORT_MODES, transportModeProblems } from './transport'

/** The W2a shipping follow-ups (B-W2b-19): pure rules. Every number and name is made up. */

describe('SHIPMENT moves name their shipment line (Z3:01)', () => {
  it('splits a cell\'s take over its lines, places in order, never more for a line than its garments', () => {
    const lines = [
      { lineId: 'l1', garments: 3 },
      { lineId: 'l2', garments: 2 },
    ]
    expect(
      splitTakeByLines(
        [
          { locationId: 'p1', quantity: 2 },
          { locationId: 'p2', quantity: 2 },
        ],
        lines,
      ),
    ).toEqual([
      { lineId: 'l1', locationId: 'p1', quantity: 2 },
      { lineId: 'l1', locationId: 'p2', quantity: 1 },
      { lineId: 'l2', locationId: 'p2', quantity: 1 },
    ])
    // One place, one line: one move; nothing taken: no move (the garments leave from the release).
    expect(splitTakeByLines([{ locationId: 'p1', quantity: 1 }], [{ lineId: 'l1', garments: 1 }])).toEqual([{ lineId: 'l1', locationId: 'p1', quantity: 1 }])
    expect(splitTakeByLines([], lines)).toEqual([])
    // A take never passes the lines' garments.
    expect(splitTakeByLines([{ locationId: 'p1', quantity: 9 }], [{ lineId: 'l1', garments: 2 }])).toEqual([{ lineId: 'l1', locationId: 'p1', quantity: 2 }])
  })

  it('a SHIPMENT move is never reversed on its own (a carrier return brings the garments back)', () => {
    expect(reversalProblems({ id: 'm1', reason: 'SHIPMENT', reversalOfId: null }, null)).toEqual([
      "A shipment's move out of finished goods is not reversed: the garments left with the shipment (a carrier return brings them back into finished goods).",
    ])
    expect(reversalProblems({ id: 'm1', reason: 'ADJUSTMENT', reversalOfId: null }, null)).toEqual([])
  })
})

describe('the freight basis and the freight cost (Z3:02)', () => {
  it('a basis only with a charge: typed MANUAL, the rule\'s RULE', () => {
    expect(chargeBasisOf(null, true)).toBeNull()
    expect(chargeBasisOf(900, true)).toBe('MANUAL')
    expect(chargeBasisOf(0, false)).toBe('RULE')
  })

  it('the carrier\'s cost: whole minor units with its currency, until the shipment is cancelled', () => {
    expect(freightCostProblems('SHIPPED', 1850, 'EUR')).toEqual([])
    expect(freightCostProblems('DELIVERED', null, null)).toEqual([])
    expect(freightCostProblems('CANCELLED', 1850, 'EUR')).toEqual([{ path: 'state', message: 'The shipment is CANCELLED: its freight cost no longer changes.' }])
    expect(freightCostProblems('PACKED', -1, 'EUR').map((issue) => issue.path)).toEqual(['body/freightCost'])
    expect(freightCostProblems('PACKED', 100, 'eur').map((issue) => issue.path)).toEqual(['body/currency'])
  })
})

describe('a carrier-returned shipment back into finished goods (Z3:06)', () => {
  it('once, and only after the carrier brought it back', () => {
    expect(carrierReturnState('SHIPPED', false)).toBe('NOT_RETURNED')
    expect(carrierReturnState('RETURNED', false)).toBe('AWAITED')
    expect(carrierReturnState('RETURNED', true)).toBe('RECEIVED')
    expect(carrierReturnProblems({ number: 'SH-00009', status: 'RETURNED', received: false, garments: 2 })).toEqual([])
    expect(carrierReturnProblems({ number: 'SH-00009', status: 'DELIVERED', received: false, garments: 2 })[0]).toMatch(/^SH-00009 is DELIVERED: its garments go back into finished goods once the carrier brought it back/)
    expect(carrierReturnProblems({ number: 'SH-00009', status: 'RETURNED', received: true, garments: 2 })).toEqual(["SH-00009's garments are back in finished goods already."])
    expect(carrierReturnNote('SH-00009', 'WO-0001 BLK 52', 'Box dented')).toBe('Carrier return of SH-00009: WO-0001 BLK 52 back into finished goods. Box dented')
  })
})

describe('a repair cell never ships on an order\'s shipment (Z3:07)', () => {
  it('says why in words', () => {
    expect(repairCellWords('WO-0042')).toBe("WO-0042 is a repair work order: its garment goes back with the repair's DDT, never on a shipment of the order.")
  })
})

describe('the mode of transport for Intrastat (Z3:08)', () => {
  it('eight modes with their codes (no 6); changed until the shipment is cancelled', () => {
    expect(TRANSPORT_MODES.map((mode) => INTRASTAT_TRANSPORT_CODES[mode])).toEqual([1, 2, 3, 4, 5, 7, 8, 9])
    expect(isTransportMode('ROAD')).toBe(true)
    expect(isTransportMode('TRUCK')).toBe(false)
    expect(transportModeProblems('DELIVERED')).toEqual([])
    expect(transportModeProblems('CANCELLED')).toEqual(['The shipment is CANCELLED: its mode of transport no longer changes.'])
  })
})
