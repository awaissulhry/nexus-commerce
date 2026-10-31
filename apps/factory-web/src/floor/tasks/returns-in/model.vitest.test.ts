import { describe, expect, it } from 'vitest'
import type { DockLine, DockReturn } from './api'
import { countAll, countLine, emptyArrival, lineToGrade, matchScan, placeConfirmed, placeOf, receiptBody, receiveHeld, restockHeldOf, roomOf, suggestionOf, takes, toGrade } from './model'

/** SCR-180's rules: what a label matches, what a parcel may bring, the receipt, grading and the place (made-up data). */

const line = (seq: number, extra: Partial<DockLine> = {}): DockLine => ({
  id: `l${seq}`,
  seq,
  description: null,
  style: { code: 'S', name: 'Style' },
  colourway: { code: 'BLK', name: 'Black' },
  size: '50',
  serial: null,
  batchNumber: null,
  ppe: false,
  safety: false,
  reasonCode: 'WRONG_SIZE',
  reason: null,
  quantity: 2,
  receivedQuantity: 0,
  expected: 2,
  grade: null,
  cause: null,
  photos: 0,
  suggestedOutcome: null,
  disposition: null,
  goodsOutcome: null,
  place: null,
  version: 1,
  ...extra,
})
const dock = (lines: DockLine[]): DockReturn => ({
  id: 'r1',
  number: 'RMA-T-1',
  site: null,
  customerRef: null,
  status: 'AUTHORISED',
  goodsDueBy: null,
  receivedAt: null,
  lines,
  receipts: [],
  places: { inspection: { id: 'q', code: 'A1-QUA', name: 'Quarantine' }, quarantine: null, finishedGoods: null },
  version: 7,
})

describe('the lines a parcel brings', () => {
  const rma = dock([line(10, { serial: 'SN-1', quantity: 1, expected: 1 }), line(20, { batchNumber: 'LB-7' }), line(30, { batchNumber: 'LB-7', grade: 'NEW', receivedQuantity: 1, expected: 1 })])

  it('a serial or batch label counts on the open line it names, case and spaces aside; a full line is said, an unknown one too', () => {
    let arrival = emptyArrival()
    expect(matchScan(rma, arrival, ' sn-1 ')).toEqual({ kind: 'line', lineId: 'l10' })
    arrival = countLine(arrival, rma.lines[0]!, 1)
    expect(matchScan(rma, arrival, 'SN-1')).toEqual({ kind: 'full', seq: 10 })
    // A graded line takes no more: the same batch opens the ungraded line.
    expect(matchScan(rma, arrival, 'LB-7')).toEqual({ kind: 'line', lineId: 'l20' })
    expect(matchScan(rma, arrival, 'NOPE')).toEqual({ kind: 'none' })
  })

  it('never counts more than a line still expects, nor on a graded line; All expected fills the open lines', () => {
    let arrival = emptyArrival()
    for (let index = 0; index < 5; index++) arrival = countLine(arrival, rma.lines[1]!, 1)
    expect(arrival.counts.l20).toBe(2)
    expect(roomOf(rma.lines[1]!, arrival)).toBe(0)
    expect(countLine(arrival, rma.lines[2]!, 1)).toBe(arrival)
    expect(takes(rma.lines[2]!)).toBe(false)
    arrival = countLine(arrival, rma.lines[1]!, -1)
    expect(arrival.counts.l20).toBe(1)
    expect(countAll(emptyArrival(), rma).counts).toEqual({ l10: 1, l20: 2 })
  })

  it('Receive waits for the condition and a piece; the body names the lines counted, the version read and the note', () => {
    expect(receiveHeld(emptyArrival())).toBe('condition')
    const picked = { ...emptyArrival(), condition: 'DAMAGED' as const, ddtNumber: 'DDT-9', parcels: 120 }
    expect(receiveHeld(picked)).toBe('nothing')
    const counted = countLine(picked, rma.lines[1]!, 1)
    expect(receiveHeld(counted)).toBeNull()
    expect(receiptBody(rma, counted)).toEqual({ version: 7, parcels: 99, parcelCondition: 'DAMAGED', customerDdtNumber: 'DDT-9', lines: [{ lineId: 'l20', quantity: 1 }] })
  })
})

describe('grading and the place', () => {
  it('grades the received, ungraded, undecided lines in order; the one asked first', () => {
    const rma = dock([line(10, { receivedQuantity: 1 }), line(20, { receivedQuantity: 2, grade: 'GOOD' }), line(30, { receivedQuantity: 1 }), line(40, { receivedQuantity: 1, disposition: 'SCRAP' })])
    expect(toGrade(rma).map((entry) => entry.seq)).toEqual([10, 30])
    expect(lineToGrade(rma, 'l30')?.seq).toBe(30)
    expect(lineToGrade(rma, 'l20')?.seq).toBe(10)
  })

  it('suggests what the return policy suggests and says why restocking as new is held (protective garments)', () => {
    const ppeDefect = line(10, { ppe: true, reasonCode: 'DEFECT' })
    expect(suggestionOf(ppeDefect, 'NEW')).toEqual({ outcome: 'QUARANTINE', held: 'safety' })
    const ppeUsed = line(20, { ppe: true })
    expect(suggestionOf(ppeUsed, 'LIKE_NEW')).toEqual({ outcome: 'SECOND_QUALITY', held: 'usedPpe' })
    expect(suggestionOf(line(30), 'LIKE_NEW')).toEqual({ outcome: 'RESTOCK', held: null })
    expect(restockHeldOf(line(30), 'GOOD')).toBe('notNew')
    expect(suggestionOf(line(30), 'DAMAGED').outcome).toBe('REPAIR')
    expect(suggestionOf(line(30), 'UNUSABLE').outcome).toBe('SCRAP')
  })

  it('the goods go to the inspection place until decided; its label confirms it', () => {
    const rma = dock([line(10, { receivedQuantity: 1, place: 'A1-QUA' })])
    expect(placeOf(rma)).toEqual({ code: 'A1-QUA', name: 'Quarantine' })
    expect(placeConfirmed(placeOf(rma), ' a1-qua ')).toBe(true)
    expect(placeConfirmed(placeOf(rma), 'A1-FG')).toBe(false)
    expect(placeOf({ ...rma, places: { inspection: null, quarantine: null, finishedGoods: null }, lines: [line(10, { receivedQuantity: 1 })] })).toBeNull()
  })
})
