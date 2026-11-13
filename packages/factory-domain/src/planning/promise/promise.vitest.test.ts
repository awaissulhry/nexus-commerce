import { describe, expect, it } from 'vitest'
import { Dec } from '../../tax/decimal'
import { atpRow, atpTotal, atpWeeks, stockDateFor } from './atp'
import { bridgeOf, copyFree, freeAfterLoad, freeWhenEmpty, walkSteps, type CtpLane } from './ctp'
import { PLANNING_PROMISE_ADDS, PLANNING_PROMISE_DEFINITIONS } from './permissions'
import { arrivalsOf, bridgeWords, currentPromiseOf, materialDateOf, promiseAskProblems, promisePlanOf, sizeGroupsOf, type MaterialNeed, type StoredPromise } from './rules'
// B-W2b-F44: the rule's two parts, on THE calendars service's days and minutes.
import { localInstant, plusDays } from '../../calendars/dates'
import { publicHolidays } from '../../calendars/holidays'
import { businessDayStart } from '../../core/time'
import { dayOf, nextWorkingDay, workingCalendar, workingMinutesBetween, type DayException } from '../../calendars/working-time'
import { makeDayOf, minutesLeftToday } from './ctp'

/** B-W2b-301: available to promise, the capacity walk and its bridge, material arrivals, sizes apart, the promise rows. */

const TODAY = '2026-11-12' // a Thursday

describe('available to promise (PLN-168)', () => {
  const weeks = atpWeeks(TODAY, 4)

  it('buckets from this Monday; on hand + receipts − committed with the look-ahead', () => {
    expect(weeks.map((week) => week.from)).toEqual(['2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30'])
    const row = atpRow(
      {
        onHand: 5,
        receipts: [{ date: '2026-11-20', pieces: 10 }],
        // A past-due and an undated commitment count this week; one after the grid is "later".
        commitments: [{ date: '2026-11-01', pieces: 2 }, { date: null, pieces: 1 }, { date: '2026-11-25', pieces: 9 }, { date: '2027-03-01', pieces: 4 }],
      },
      weeks,
    )
    expect(row.cells.map((cell) => [cell.receipts, cell.committed, cell.cumulative, cell.available])).toEqual([
      [0, 3, 2, 2],
      [10, 0, 12, 3],
      [0, 9, 3, 3],
      [0, 0, 3, 3],
    ])
    expect(row.availableNow).toBe(2)
    expect(row.later).toEqual({ receipts: 0, committed: 4 })
    // 2 now; 3 from the week the receipt arrives (its day); 4 never within the grid.
    expect(stockDateFor(row, 2, TODAY)).toBe(TODAY)
    expect(stockDateFor(row, 3, TODAY)).toBe('2026-11-20')
    expect(stockDateFor(row, 4, TODAY)).toBeNull()
  })

  it('a week short shows by how much; the look-ahead never promises a later commitment away', () => {
    const row = atpRow({ onHand: 4, receipts: [], commitments: [{ date: '2026-11-24', pieces: 6 }] }, weeks)
    expect(row.cells.map((cell) => cell.available)).toEqual([0, 0, 0, 0])
    expect(row.cells.map((cell) => cell.short)).toEqual([0, 0, 2, 2])
    const total = atpTotal([row, atpRow({ onHand: 1, receipts: [], commitments: [] }, weeks)], weeks)
    expect(total.onHand).toBe(5)
    expect(total.cells[0]!.available).toBe(1)
  })
})

const lane = (key: string, available: number[], booked: number[] = [], backlog = 0): CtpLane => ({
  key,
  kind: 'LINE',
  id: key,
  code: key,
  name: key,
  days: available.map((minutes, index) => ({ date: `2026-11-${String(12 + index).padStart(2, '0')}`, available: new Dec(minutes), booked: new Dec(booked[index] ?? 0) })),
  backlog: new Dec(backlog),
})

describe('capable to promise, lite (PLN-169)', () => {
  it('walks the steps on the free minutes; the load and its backlog queue first; overbooked days spill back', () => {
    // L1: 100 a day; 150 booked on the 14th spills 50 back onto the 13th; 30 past due waits first from today.
    const lanes = [lane('L1', [100, 100, 100, 100, 100, 100, 100], [0, 0, 150, 0, 0, 0, 0], 30)]
    const free = freeAfterLoad(lanes)
    expect([...free.get('L1')!.values()].map((value) => Number(value))).toEqual([70, 50, 0, 100, 100, 100, 100])
    const names = new Map([['L1', { code: 'L1', name: 'Line 1' }]])
    const steps = [
      { seq: 10, name: 'Cut', outside: false, transitDays: null, laneKeys: ['L1'], minutes: new Dec(100) },
      { seq: 20, name: 'Embroidery', outside: true, transitDays: 2, laneKeys: [], minutes: new Dec(0) },
      { seq: 30, name: 'Sew', outside: false, transitDays: null, laneKeys: ['L1'], minutes: new Dec(150) },
    ]
    const real = walkSteps(steps, free, '2026-11-12', names)
    // Cut 70 + 30 → the 13th; the workshop 2 days → the 15th; sew 100 + 50 → the 16th.
    expect(real.steps.map((step) => [step.seq, step.start, step.finish])).toEqual([
      [10, '2026-11-12', '2026-11-13'],
      [20, '2026-11-13', '2026-11-15'],
      [30, '2026-11-15', '2026-11-16'],
    ])
    expect(real.finish).toBe('2026-11-16')
    // The same walk on an empty plant: the base lead time (cut the 12th, the workshop to the 14th, sew by the 15th).
    const base = walkSteps(steps, copyFree(freeWhenEmpty(lanes)), '2026-11-12', names)
    expect(base.finish).toBe('2026-11-15')
    const bridge = bridgeOf('2026-11-12', '2026-11-12', base.finish!, real.finish!)
    expect(bridge).toMatchObject({ materialDays: 0, baseDays: 3, queueDays: 1, spanDays: 4 })
    // A later group queues behind what the first one booked.
    const again = walkSteps(steps.slice(0, 1), free, '2026-11-12', names)
    expect(again.finish).toBe('2026-11-17')
  })

  it('no lane, no capacity, beyond the horizon: said in words', () => {
    const names = new Map<string, { code: string; name: string }>()
    const noLane = walkSteps([{ seq: 10, name: 'Sew', outside: false, transitDays: null, laneKeys: ['X'], minutes: new Dec(10) }], new Map(), TODAY, names)
    expect(noLane.problems[0]!.code).toBe('NO_LANE')
    const free = freeAfterLoad([lane('L1', [10])])
    const beyond = walkSteps([{ seq: 10, name: 'Sew', outside: false, transitDays: null, laneKeys: ['L1'], minutes: new Dec(50) }], free, TODAY, names)
    expect(beyond).toMatchObject({ finish: null, problems: [{ code: 'BEYOND_HORIZON' }] })
    const closed = walkSteps([{ seq: 10, name: 'Sew', outside: false, transitDays: null, laneKeys: ['L2'], minutes: new Dec(5) }], freeAfterLoad([lane('L2', [])]), TODAY, names)
    expect(closed.problems[0]!.code).toBe('NO_CAPACITY')
  })

  it('the bridge in words: base + queue + material = total → the date', () => {
    const bridge = bridgeOf('2026-11-01', '2026-11-15', '2026-11-30', '2026-12-04')
    expect(bridge).toMatchObject({ materialDays: 14, baseDays: 15, queueDays: 4, spanDays: 33 })
    expect(bridgeWords(bridge, { label: 'Leather BLK', source: 'BUY' }, '2026-11-01')).toBe("base lead time 15 days + queue at today's load 4 days + Leather BLK to buy 14 days = 33 days → 4 Dec")
  })
})

describe('material arrivals', () => {
  const need = (over: Partial<MaterialNeed>): MaterialNeed => ({ itemId: 'i', itemColourId: null, label: 'LTH', action: 'BUY', supplies: [], uncovered: '0.0000', leadTimeDays: 14, delayDays: null, ...over })

  it('stock today, a purchase order on its day (overdue from today), the rest after the lead time and the delay', () => {
    const found = arrivalsOf(need({ supplies: [{ kind: 'STOCK', quantity: '1.0000' }, { kind: 'PURCHASE_ORDER', quantity: '2.0000', date: '2026-11-01', purchaseOrderLineId: 'p' }], uncovered: '3.0000', delayDays: 1, purchaseOf: () => 'PO-1 line 10' }), TODAY)
    expect(found.arrivals.map((arrival) => [arrival.source, arrival.date])).toEqual([
      ['STOCK', TODAY],
      ['PURCHASE_ORDER', '2026-11-13'],
      ['BUY', '2026-11-27'],
    ])
    expect(found.warnings.map((warning) => warning.code)).toEqual(['PURCHASE_OVERDUE'])
    const day = materialDateOf([need({ uncovered: '1.0000', leadTimeDays: null })], TODAY)
    expect(day).toMatchObject({ date: TODAY, setBy: null })
    expect(day.warnings[0]!.code).toBe('NO_LEAD_TIME')
  })
})

describe('promise per size (PLN-171)', () => {
  it('sizes that finish together, in the style order', () => {
    const groups = sizeGroupsOf(
      [
        { size: '52', date: '2026-12-04' },
        { size: '48', date: '2026-12-04' },
        { size: '50', date: '2026-12-04' },
        { size: '54', date: '2026-12-11' },
        { size: '56', date: null },
      ],
      ['48', '50', '52', '54', '56'],
      TODAY,
    )
    expect(groups.map((group) => group.words)).toEqual(['48–52 4 Dec', '54 11 Dec', '56 not promised'])
  })

  const row = (over: Partial<StoredPromise>): StoredPromise => ({ id: 'r1', size: null, promisedDate: '2026-12-18', kind: 'FIRST', promisedAt: new Date('2026-11-01T10:00:00Z'), ...over })

  it('a line never promised: one FIRST for every size, or one per size when they differ', () => {
    expect(promisePlanOf({ asks: [{ size: '50', date: '2026-12-04' }, { size: '52', date: '2026-12-04' }], sizes: ['50', '52'], rows: [], typed: null, reasonCode: null, reason: null }).rows).toEqual([
      { size: null, promisedDate: '2026-12-04', kind: 'FIRST', reasonCode: null, reason: null, backfill: false },
    ])
    expect(promisePlanOf({ asks: [{ size: '50', date: '2026-12-04' }, { size: '52', date: '2026-12-11' }], sizes: ['50', '52'], rows: [], typed: null, reasonCode: null, reason: null }).rows.map((entry) => [entry.size, entry.kind])).toEqual([
      ['50', 'FIRST'],
      ['52', 'FIRST'],
    ])
  })

  it('a typed date becomes the FIRST; a size apart is a RE_PROMISE with its reason; the same date writes nothing', () => {
    const plan = promisePlanOf({ asks: [{ size: '50', date: '2026-12-18' }, { size: '54', date: '2026-12-22' }], sizes: ['50', '54'], rows: [], typed: '2026-12-18', reasonCode: null, reason: null })
    expect(plan.rows.map((entry) => [entry.size, entry.promisedDate, entry.kind, entry.reasonCode, entry.backfill])).toEqual([
      [null, '2026-12-18', 'FIRST', null, true],
      ['54', '2026-12-22', 'RE_PROMISE', 'SIZES_FINISH_APART', false],
    ])
    expect(plan.unchanged).toEqual(['50'])
    // With rows: the size's own newest row is its promise; a size with no FIRST of its own or of every size gets one.
    const rows = [row({ id: 'a', size: '50', promisedDate: '2026-12-04' })]
    const next = promisePlanOf({ asks: [{ size: '50', date: '2026-12-09' }, { size: '52', date: '2026-12-09' }], sizes: ['50', '52'], rows, typed: '2026-12-18', reasonCode: 'MATERIAL_LATE', reason: null })
    expect(next.rows.map((entry) => [entry.size, entry.kind, entry.reasonCode])).toEqual([
      ['50', 'RE_PROMISE', 'MATERIAL_LATE'],
      ['52', 'FIRST', null],
    ])
    expect(currentPromiseOf('52', rows, '2026-12-18')).toMatchObject({ date: '2026-12-18', source: 'TYPED' })
    expect(currentPromiseOf('50', [...rows, row({ id: 'b', promisedDate: '2026-12-30', promisedAt: new Date('2026-11-02T10:00:00Z') })], null)).toMatchObject({ date: '2026-12-04', ownSize: true })
  })

  it('every problem of the dates at once', () => {
    const problems = promiseAskProblems({
      asks: [{ size: '50', date: '2026-11-01' }, { size: '50', date: '2026-12-01' }, { size: '58', date: '2026-12-01' }, { size: '52', date: '2026-12-01' }],
      sizes: ['50', '52'],
      openOf: (size) => (size === '52' ? 0 : 2),
      madeToMeasure: false,
      today: TODAY,
      orderDate: '2026-11-05',
    })
    expect(problems.map((problem) => problem.path)).toEqual(['body/sizes/0/date', 'body/sizes/0/date', 'body/sizes/1/size', 'body/sizes/2/size', 'body/sizes/3/size'])
  })
})

describe('permissions', () => {
  it('view and manage; the planner and production manager both, sales reads', () => {
    expect(PLANNING_PROMISE_DEFINITIONS.map((definition) => [definition.name, definition.risk])).toEqual([
      ['planning.promise.view', 'read'],
      ['planning.promise.manage', 'write'],
    ])
    expect(PLANNING_PROMISE_ADDS.sales).toEqual(['planning.promise.view'])
    expect(PLANNING_PROMISE_ADDS.planner).toEqual(['planning.promise.view', 'planning.promise.manage'])
  })
})

// ---- B-W2b-F44 (begin): a garment still to make is never promised for today; today counts only the minutes left ----------------

describe('B-W2b-F44: never today for a garment to make, today only from now (Owner 2026-11-13, option A)', () => {
  // A company calendar as the seed's: Monday to Friday, the planning default's one shift (08:00-17:00, lunch 12:00-13:00:
  // 480 minutes), Italy's national holidays; Rome's time.
  const ROME = 'Europe/Rome'
  const holidays = new Map<string, DayException>(publicHolidays('IT', 2026).map((day) => [day.date, { date: day.date, kind: 'HOLIDAY', name: day.name, shiftPatternId: null }]))
  const calendar = workingCalendar({ layers: [{ id: 'company', scope: 'COMPANY', name: 'Company', workingWeekdays: [1, 2, 3, 4, 5], shiftPatternId: null, days: holidays }], patterns: new Map(), timeZone: ROME, window: { from: '2026-11-01', to: '2026-12-31' } })
  const at = (date: string, time: string) => localInstant(date, Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)), ROME)
  const leftAt = (date: string, time: string) => minutesLeftToday(dayOf(calendar, date).minutes, workingMinutesBetween(calendar, at(date, time), businessDayStart(plusDays(date, 1), ROME)))

  it('today counts only the working minutes still left from now; never more than the day, the day when unknown', () => {
    // A Wednesday, the Friday before a weekend, the Monday before the Immacolata (8 Dec).
    for (const date of ['2026-11-18', '2026-11-13', '2026-12-07']) {
      expect(dayOf(calendar, date).minutes, date).toBe(480)
      expect(leftAt(date, '07:00'), date).toBe(480)
      expect(leftAt(date, '09:00'), date).toBe(420)
      expect(leftAt(date, '12:30'), date).toBe(240)
      expect(leftAt(date, '17:30'), date).toBe(0)
    }
    expect(dayOf(calendar, '2026-12-08')).toMatchObject({ working: false, reason: 'HOLIDAY', minutes: 0 })
    expect(minutesLeftToday(480, null)).toBe(480)
    expect(minutesLeftToday(480, 600)).toBe(480)
    expect(minutesLeftToday(null, 30)).toBe(0)
  })

  it('a garment to make: the walk finished today is promised on the next working day; a later finish stays', () => {
    const first = (date: string) => nextWorkingDay(calendar, date).date!
    expect(first('2026-11-18')).toBe('2026-11-19')
    expect(first('2026-11-13')).toBe('2026-11-16') // over the weekend
    expect(first('2026-12-07')).toBe('2026-12-09') // over the Immacolata
    expect(makeDayOf('2026-11-18', first('2026-11-18'))).toBe('2026-11-19')
    expect(makeDayOf('2026-11-13', first('2026-11-13'))).toBe('2026-11-16')
    expect(makeDayOf('2026-12-07', first('2026-12-07'))).toBe('2026-12-09')
    // A finish on a closed day before the first working day moves to it; a later finish is kept as walked.
    expect(makeDayOf('2026-11-14', first('2026-11-13'))).toBe('2026-11-16')
    expect(makeDayOf('2026-11-17', first('2026-11-13'))).toBe('2026-11-17')
  })
})
// B-W2b-F44 (end)
