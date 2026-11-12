import { describe, expect, it } from 'vitest'
import type { MaterialReadiness } from '../readiness/readiness'
import type { Duration } from '../schedule/backward'
import type { Span } from '../schedule/time'
import { firstFit, leftInThePast, planChains, runOrder, type ChainOperation } from './forward'
import { materialStartOf, shortDay, startInTime } from './material'
import { deltaWords, hoursWords, mergeMoves, moveKey, touchedLanes, type WhatIfMove } from './whatif'

/**
 * Scheduling in depth (B-W2b-312), pure: the earliest start with material (PLN-134), forward scheduling on the lanes' free
 * time and the backlog reschedule around pins (PLN-130, PLN-141, PLN-139), the what-if's moves and words. Every name,
 * number and time is made up. Instants are UTC; the lane works 08:00-12:00 and 13:00-17:00 UTC on 16-20 Nov 2026.
 */

const at = (day: number, hour: number, minute = 0) => Date.UTC(2026, 10, day, hour, minute)
const SPANS: Span[] = [16, 17, 18, 19, 20].flatMap((day) => [
  { start: at(day, 8), end: at(day, 12) },
  { start: at(day, 13), end: at(day, 17) },
])
const working = (minutes: number): Duration => ({ kind: 'WORKING', minutes, spans: SPANS })

const material = (over: Partial<MaterialReadiness>): MaterialReadiness => ({
  itemId: 'item-leather',
  itemColourId: 'colour-blk',
  label: 'LEA-100 BLK',
  uom: 'M2',
  word: 'RECEIVED',
  date: null,
  needed: '10.0000',
  issued: '0.0000',
  reserved: '10.0000',
  inStock: '0.0000',
  onOrder: '0.0000',
  firm: '0.0000',
  short: '0.0000',
  purchaseOrderLineIds: [],
  reason: '',
  neededOn: '2026-11-16',
  arrivals: [],
  ...over,
})
const arrival = (date: string, number = 'PO-0003', state: 'IN_TIME' | 'LATE' | 'OVERDUE' = 'IN_TIME') => ({ kind: 'PURCHASE_ORDER' as const, purchaseOrderLineId: `line-${number}`, purchaseOrderNumber: number, draft: false, date, quantity: '10.0000', state })

describe('the earliest start with material (PLN-134)', () => {
  const today = '2026-11-12'
  it('starts the day after the latest arrival, later by the delay days, and says so in words', () => {
    const start = materialStartOf({ word: 'EXPECTED', materials: [material({ word: 'EXPECTED', date: '2026-11-14', arrivals: [arrival('2026-11-14')] }), material({ itemId: 'item-zip', itemColourId: null, label: 'ZIP-1', word: 'RECEIVED' })] }, today)
    expect(start).toMatchObject({ state: 'ARRIVES', arrives: '2026-11-14', startDay: '2026-11-15', setBy: { label: 'LEA-100 BLK', purchaseOrderNumber: 'PO-0003' } })
    expect(start.words).toBe('LEA-100 BLK arrives 14 Nov (PO-0003). Earliest start with material: 15 Nov.')
    const inspected = materialStartOf({ word: 'EXPECTED', materials: [material({ word: 'EXPECTED', date: '2026-11-14', arrivals: [arrival('2026-11-14')] })] }, today, new Map([['item-leather|colour-blk', 3]]))
    expect(inspected.startDay).toBe('2026-11-17')
  })
  it('nothing holds a work order whose materials are in hand, or that the plan has no need for', () => {
    expect(materialStartOf({ word: 'RECEIVED', materials: [material({}), material({ word: 'NOT_BOOKED' })] }, today)).toMatchObject({ state: 'IN_HAND', startDay: null })
    expect(materialStartOf({ word: 'NOT_PLANNED', materials: [] }, today)).toMatchObject({ state: 'NOT_PLANNED', startDay: null })
    expect(materialStartOf(null, today).state).toBe('NOT_PLANNED')
  })
  it('a late or overdue supply sets its day (overdue: from today); short with nothing ordered has no day', () => {
    const overdue = materialStartOf({ word: 'DELAYED', materials: [material({ word: 'DELAYED', date: '2026-11-10', arrivals: [arrival('2026-11-10', 'PO-0001', 'OVERDUE')] })] }, today)
    expect(overdue).toMatchObject({ state: 'ARRIVES', arrives: today, startDay: '2026-11-13', setBy: { overdue: true } })
    expect(overdue.words).toMatch(/^LEA-100 BLK \(PO-0001\) was due before today and is not received yet\. Earliest start with material: 13 Nov\.$/)
    const late = materialStartOf({ word: 'DELAYED', materials: [material({ word: 'DELAYED', date: '2026-11-20', short: '4.0000', arrivals: [arrival('2026-11-14'), arrival('2026-11-20', 'PO-0009', 'LATE')] })] }, today)
    expect(late).toMatchObject({ startDay: '2026-11-21', setBy: { purchaseOrderNumber: 'PO-0009' } })
    const short = materialStartOf({ word: 'NOT_ENOUGH', materials: [material({ word: 'NOT_ENOUGH', short: '3.0000' }), material({ itemId: 'item-zip', itemColourId: null, label: 'ZIP-1', word: 'EXPECTED', date: '2026-11-13', arrivals: [arrival('2026-11-13', 'PO-0004')] })] }, today)
    expect(short).toMatchObject({ state: 'NOT_COVERED', startDay: '2026-11-14', notCovered: [{ label: 'LEA-100 BLK' }] })
    expect(short.words).toBe('LEA-100 BLK is short and nothing is ordered for it yet: no day with material is known.')
  })
  it('a start is in time on or after the earliest start with material; never when a material is not covered', () => {
    expect(startInTime('ARRIVES', at(15, 8), at(15, 8))).toBe(true)
    expect(startInTime('ARRIVES', at(14, 16), at(15, 8))).toBe(false)
    expect(startInTime('IN_HAND', at(1, 0), null)).toBe(true)
    expect(startInTime('NOT_COVERED', at(30, 8), at(15, 8))).toBe(false)
    expect(shortDay('2026-01-05')).toBe('5 Jan')
  })
})

describe('forward scheduling on free time (PLN-130), pins (PLN-139) and the backlog (PLN-141)', () => {
  it('puts a bar at the first stretch where its working minutes run without meeting another bar', () => {
    expect(firstFit(working(120), at(16, 8), [])).toEqual({ start: at(16, 8), end: at(16, 10) })
    // A bar 09:00-11:00 is in the way: 180 minutes from 11:00 run over the lunch break to 15:00.
    expect(firstFit(working(180), at(16, 8), [{ start: at(16, 9), end: at(16, 11), id: 'x' }])).toEqual({ start: at(16, 11), end: at(16, 15) })
    // From the evening: the next morning.
    expect(firstFit(working(60), at(16, 18), [])).toEqual({ start: at(17, 8), end: at(17, 9) })
    // Outside work takes its clock days from the moment it may start.
    expect(firstFit({ kind: 'CLOCK', minutes: 24 * 60 }, at(16, 18), [])).toEqual({ start: at(16, 18), end: at(17, 18) })
    // Beyond the loaded calendar.
    expect(firstFit(working(60), at(21, 8), [])).toBeNull()
  })

  const op = (id: string, seq: number, minutes: number, mode: ChainOperation['mode'], current: ChainOperation['current'] = null, why: ChainOperation['why'] = 'FORWARD'): ChainOperation => ({ id, seq, label: `Op ${seq}`, laneKey: 'LINE:L1', duration: working(minutes), current, mode, why })

  it('plans each order finish to start, the more urgent first, the next one in the free time left', () => {
    const result = planChains(
      [
        { workOrderId: 'wo-1', number: 'WO-1', from: at(16, 10), operations: [op('a1', 10, 120, 'REPLAN'), op('a2', 20, 60, 'REPLAN')] },
        { workOrderId: 'wo-2', number: 'WO-2', from: at(16, 8), operations: [op('b1', 10, 60, 'REPLAN')] },
      ],
      new Map(),
      'UTC',
    )
    expect(result.moves.map((move) => [move.operationId, move.to.start, move.to.end, move.why])).toEqual([
      ['a1', at(16, 10), at(16, 12), 'PLACED'],
      ['a2', at(16, 13), at(16, 14), 'PLACED'],
      ['b1', at(16, 8), at(16, 9), 'PLACED'],
    ])
    expect(result.finishes.get('wo-1')).toBe(at(16, 14))
  })

  it('keeps a pinned bar where it is; what follows starts after it; a pinned bar before the one before it is named', () => {
    const result = planChains(
      [
        {
          workOrderId: 'wo-1',
          number: 'WO-1',
          from: at(16, 8),
          operations: [op('a1', 10, 240, 'REPLAN', { slotId: 's1', start: at(18, 8), end: at(18, 12), pinned: false }), op('a2', 20, 60, 'FIXED', { slotId: 's2', start: at(16, 9), end: at(16, 10), pinned: true }), op('a3', 30, 60, 'REPLAN', { slotId: 's3', start: at(19, 8), end: at(19, 9), pinned: false })],
        },
      ],
      new Map([['LINE:L1', [{ start: at(16, 9), end: at(16, 10), id: 's2' }]]]),
      'UTC',
    )
    // Op 10 cannot fit before the pinned 09:00 bar: it goes after it (10:00 to 15:00 over lunch).
    expect(result.moves.find((move) => move.operationId === 'a1')).toMatchObject({ slotId: 's1', to: { start: at(16, 10), end: at(16, 15) }, why: 'FORWARD' })
    expect(result.kept).toEqual([expect.objectContaining({ operationId: 'a2', code: 'PINNED_BEFORE_PREVIOUS' })])
    expect(result.kept[0]!.words).toMatch(/^WO-1 Op 20 is pinned to start 16 Nov 09:00, before Op 10 can finish \(16 Nov 15:00\)/)
    expect(result.moves.find((move) => move.operationId === 'a3')).toMatchObject({ to: { start: at(16, 15), end: at(16, 16) } })
    expect(result.moves.some((move) => move.operationId === 'a2')).toBe(false)
  })

  it('the backlog: a bar left in the past moves to the first free time, a later bar moves on only as far as it must', () => {
    const now = at(17, 8)
    expect(leftInThePast({ end: at(16, 12) }, 5, now)).toBe(true)
    expect(leftInThePast({ end: at(16, 12) }, 0, now)).toBe(false)
    const busy = new Map([['LINE:L1', [{ start: at(16, 8), end: at(16, 12), id: 's1' }, { start: at(17, 9), end: at(17, 10), id: 's2' }, { start: at(18, 8), end: at(18, 9), id: 'other' }]]])
    const result = planChains(
      [
        {
          workOrderId: 'wo-1',
          number: 'WO-1',
          from: now,
          operations: [op('a1', 10, 120, 'REPLAN', { slotId: 's1', start: at(16, 8), end: at(16, 12), pinned: false }, 'PAST'), op('a2', 20, 60, 'KEEP_IF_FITS', { slotId: 's2', start: at(17, 9), end: at(17, 10), pinned: false }, 'PUSHED'), op('a3', 30, 60, 'UNPLACED')],
        },
        { workOrderId: 'wo-2', number: 'WO-2', from: now, operations: [op('c1', 10, 60, 'KEEP_IF_FITS', { slotId: 'other', start: at(18, 8), end: at(18, 9), pinned: false }, 'PUSHED')] },
      ],
      busy,
      'UTC',
    )
    // Op 10 from 08:00 meets Op 20's own bar at 09:00: it goes to 10:00-12:00; Op 20 is pushed after it (after lunch).
    expect(result.moves.map((move) => [move.operationId, move.to.start, move.to.end, move.why])).toEqual([
      ['a1', at(17, 10), at(17, 12), 'PAST'],
      ['a2', at(17, 13), at(17, 14), 'PUSHED'],
    ])
    // A bar that still fits stays; the tray is left alone.
    expect(result.moves.some((move) => move.operationId === 'c1' || move.operationId === 'a3')).toBe(false)
  })

  it('the run order: rush first, then priority, the earliest latest safe start, the due date, the number', () => {
    const base = { rush: false, priority: 0, latestSafeStart: 5, dueDate: '2026-12-01', number: 'WO-2' }
    expect([base, { ...base, rush: true, number: 'WO-9' }, { ...base, priority: 2, number: 'WO-5' }, { ...base, latestSafeStart: 1, number: 'WO-7' }].sort(runOrder).map((entry) => entry.number)).toEqual(['WO-9', 'WO-5', 'WO-7', 'WO-2'])
  })
})

describe('what-if (design planning.board sec:whatif)', () => {
  const lane = { kind: 'LINE' as const, id: 'l1' }
  const other = { kind: 'LINE' as const, id: 'l2' }
  const move = (slotId: string, startAt: string, version = 1, to = lane): WhatIfMove => ({ kind: 'MOVE', slotId, slotVersion: version, workOrderId: 'wo-1', operationId: 'op-1', from: { lane, startAt: '2026-11-16T08:00:00.000Z', endAt: '2026-11-16T09:00:00.000Z' }, to: { lane: to, startAt, endAt: startAt } })

  it('keeps one entry per bar: tried again with the same target it keeps its first version; a new target reads the bar again', () => {
    const first = [move('s1', '2026-11-17T08:00:00.000Z', 3), move('s3', '2026-11-17T10:00:00.000Z', 2)]
    const next = mergeMoves(first, [move('s2', '2026-11-18T08:00:00.000Z', 1), move('s1', '2026-11-19T08:00:00.000Z', 7), move('s3', '2026-11-17T10:00:00.000Z', 9)])
    expect(next.map((entry) => [entry.slotId, entry.slotVersion, entry.to!.startAt])).toEqual([
      ['s2', 1, '2026-11-18T08:00:00.000Z'],
      ['s1', 7, '2026-11-19T08:00:00.000Z'],
      ['s3', 2, '2026-11-17T10:00:00.000Z'],
    ])
    expect(moveKey({ kind: 'PLACE', slotId: null, workOrderId: 'wo-1', operationId: 'op-2' })).toBe('op:wo-1:op-2')
    expect(touchedLanes([move('s1', 'a', 1, other)]).map((entry) => entry.id)).toEqual(['l1', 'l2'])
  })

  it('says the effect as the design does', () => {
    expect(hoursWords('360')).toBe('6 h')
    expect(hoursWords('150')).toBe('2.5 h')
    expect(deltaWords({ lateOrders: { before: 4, after: 2 }, overMinutes: { before: '0', after: '360' }, lanes: [{ lane, code: 'L2', beforePct: '104.4', afterPct: '91.6' }], ordersThatMove: 7 })).toBe('late orders 4 → 2 · overtime needed 0 → 6 h · L2 load 104% → 92% · orders that move: 7')
  })
})

