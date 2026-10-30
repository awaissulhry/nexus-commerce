import { describe, expect, it } from 'vitest'
import { Dec } from '../../tax/decimal'
import { uniformBuckets } from '../settings/buckets'
import { actualWeek, earnedByLine, type EarnedScan } from './actual'
import { availableOf, capacityCells, minutesWords, type CapacityDay } from './available'
import { loadOf, loadParts, spreadPart, type LoadSlot, type LoadWorkOrder, type TimedBucket } from './load'

const day = (date: string, minutes: number, reason: CapacityDay['reason'] = 'WEEK', name: string | null = null): CapacityDay => ({ date, working: minutes > 0, reason, name, minutes, issue: null })

describe('available capacity (PLN-014, PLN-115)', () => {
  const week = [day('2026-11-16', 450), day('2026-11-17', 450), day('2026-11-18', 450), day('2026-11-19', 450), day('2026-11-20', 450), day('2026-11-21', 0, 'DAY_OFF'), day('2026-11-22', 0, 'DAY_OFF')]

  it('is people × working minutes × efficiency, said as the design says it', () => {
    const [cell] = capacityCells({ people: 8, unit: 'people', efficiencyPct: '85.00' }, week, uniformBuckets('2026-11-16', '2026-11-22', 'WEEK'))
    expect(cell).toMatchObject({ key: '2026-W47', workingDays: 5, workingMinutes: '2250.0', minutesPerDay: '450.0', availableMinutes: '15300.0', closedDays: [], noShiftDays: [] })
    expect(cell!.words).toBe('8 people × 450 min × 85% efficiency × 5 days = 15,300 min.')
  })

  it('lists the closed days, and says the sum when the days differ', () => {
    const days = [day('2026-12-07', 450), { ...day('2026-12-08', 0, 'HOLIDAY', 'Immacolata Concezione') }, day('2026-12-09', 240, 'WORKING', 'Short day'), { ...day('2026-12-10', 0), issue: 'NO_SHIFTS' as const }]
    const [cell] = capacityCells({ people: 2, unit: 'stations', efficiencyPct: '92.50' }, days, uniformBuckets('2026-12-07', '2026-12-10', 'WEEK'))
    expect(cell).toMatchObject({ workingDays: 2, workingMinutes: '690.0', minutesPerDay: null, availableMinutes: '1276.5', closedDays: [{ date: '2026-12-08', reason: 'HOLIDAY', name: 'Immacolata Concezione' }], noShiftDays: ['2026-12-10'] })
    expect(cell!.words).toBe('2 stations × 690 min over 2 days × 92.5% efficiency = 1,276.5 min. Closed: 2026-12-08 (Immacolata Concezione).')
    expect(capacityCells({ people: 0, unit: 'people', efficiencyPct: '100.00' }, week, uniformBuckets('2026-11-16', '2026-11-16', 'DAY'))[0]!.words).toMatch(/^No people to plan with/)
    expect(availableOf({ people: 3, unit: 'people', efficiencyPct: '100.00' }, []).availableMinutes.toFixed(1)).toBe('0.0')
    expect([minutesWords('1234567.25'), minutesWords('15300.0'), minutesWords(new Dec('0.04'))]).toEqual(['1,234,567.3', '15,300', '0'])
  })
})

describe('load in standard minutes (PLN-116)', () => {
  const cut = 'wc-cut'
  const sew = 'wc-sew'
  const workOrder = (patch: Partial<LoadWorkOrder> = {}): LoadWorkOrder => ({
    id: 'wo1',
    dueDate: '2026-11-20',
    lineId: null,
    pieces: 7,
    operations: [
      { id: 'op-cut', seq: 10, code: 'CUT', name: 'Cutting', standardMinutes: '12.500', workCentreId: cut, done: 0 },
      { id: 'op-sew', seq: 20, code: 'SEW', name: 'Sewing', standardMinutes: '60.000', workCentreId: sew, done: 2 },
    ],
    ...patch,
  })
  const slot = (patch: Partial<LoadSlot>): LoadSlot => ({ id: 's', workOrderId: 'wo1', operationId: null, lineId: null, workCentreId: null, startAt: new Date('2026-11-17T08:00:00Z'), endAt: new Date('2026-11-17T16:00:00Z'), minutes: '0', ...patch })
  const lines = [{ lineId: 'L1', workCentreIds: [sew] }]

  it('books the garments still to do × the frozen standard minutes, on the due date when the board has no slot', () => {
    const parts = loadParts([workOrder()], [], lines)
    expect(parts.map((part) => [part.laneKind, part.laneId, part.pieces, part.minutes.toFixed(1), part.placement.placedBy])).toEqual([
      ['WORK_CENTRE', cut, 7, '87.5', 'DUE_DATE'],
      ['WORK_CENTRE', sew, 5, '300.0', 'DUE_DATE'],
    ])
    // Allocated to L1: the line does sewing only (its stations' work centre).
    const allocated = loadParts([workOrder({ lineId: 'L1' })], [], lines)
    expect(allocated.filter((part) => part.laneKind === 'LINE').map((part) => [part.laneId, part.operationId, part.minutes.toFixed(1)])).toEqual([['L1', 'op-sew', '300.0']])
    // A line without stations does every operation; an operation done everywhere books nothing.
    expect(loadParts([workOrder({ lineId: 'L1' })], [], [{ lineId: 'L1', workCentreIds: null }]).filter((part) => part.laneKind === 'LINE')).toHaveLength(2)
    expect(loadParts([workOrder({ pieces: 2, operations: [{ ...workOrder().operations[1]! }] })], [], lines)).toEqual([])
    expect(loadParts([workOrder({ dueDate: null })], [], lines)[0]!.placement).toEqual({ placedBy: 'NO_DATE' })
  })

  it("follows the board: an operation's slots give its time and, on a line, its line, by their booked share", () => {
    const slots = [
      slot({ id: 'a', operationId: 'op-sew', lineId: 'L1', minutes: '300' }),
      slot({ id: 'b', operationId: 'op-sew', lineId: 'L2', minutes: '100', startAt: new Date('2026-11-18T08:00:00Z'), endAt: new Date('2026-11-18T12:00:00Z') }),
      slot({ id: 'c', operationId: null, workCentreId: cut }),
    ]
    const parts = loadParts([workOrder({ lineId: 'L9' })], slots, [...lines, { lineId: 'L9', workCentreIds: null }])
    expect(parts.map((part) => [part.laneKind, part.laneId, part.operationId, part.minutes.toFixed(2), part.placement.placedBy === 'SLOT' ? part.placement.slotId : part.placement.placedBy])).toEqual([
      ['WORK_CENTRE', cut, 'op-cut', '87.50', 'c'],
      ['LINE', 'L9', 'op-cut', '87.50', 'c'],
      ['WORK_CENTRE', sew, 'op-sew', '225.00', 'a'],
      ['WORK_CENTRE', sew, 'op-sew', '75.00', 'b'],
      ['LINE', 'L1', 'op-sew', '225.00', 'a'],
      ['LINE', 'L2', 'op-sew', '75.00', 'b'],
    ])
  })

  it('spreads a slot over the buckets by the working minutes, else by the clock', () => {
    const buckets: TimedBucket[] = [
      { key: 'd17', from: '2026-11-17', to: '2026-11-17', start: new Date('2026-11-16T23:00:00Z'), end: new Date('2026-11-17T23:00:00Z') },
      { key: 'd18', from: '2026-11-18', to: '2026-11-18', start: new Date('2026-11-17T23:00:00Z'), end: new Date('2026-11-18T23:00:00Z') },
    ]
    const part = loadParts([workOrder({ operations: [workOrder().operations[0]!] })], [slot({ id: 'x', operationId: 'op-cut', startAt: new Date('2026-11-17T12:00:00Z'), endAt: new Date('2026-11-18T12:00:00Z') })], lines)[0]!
    // Working time: 4 h on the 17th (12-16), 4 h on the 18th (8-12): half each.
    const working = (from: Date, to: Date): number => {
      let minutes = 0
      for (const [a, b] of [['2026-11-17T12:00:00Z', '2026-11-17T16:00:00Z'], ['2026-11-18T08:00:00Z', '2026-11-18T12:00:00Z']] as const) {
        minutes += Math.max(0, (Math.min(to.getTime(), new Date(b).getTime()) - Math.max(from.getTime(), new Date(a).getTime())) / 60_000)
      }
      return minutes
    }
    expect([...spreadPart(part, buckets, working)].map(([key, value]) => [key, value.toFixed(2)])).toEqual([['d17', '43.75'], ['d18', '43.75']])
    // No calendar that far: by the clock (11 h of 24 on the 17th).
    expect([...spreadPart(part, buckets, () => null)].map(([key, value]) => [key, value.toFixed(4)])).toEqual([['d17', '40.1042'], ['d18', '47.3958']])
    // On the due date's bucket, or nowhere.
    expect([...spreadPart({ ...part, placement: { placedBy: 'DUE_DATE', date: '2026-11-18' } }, buckets, working).keys()]).toEqual(['d18'])
    expect(spreadPart({ ...part, placement: { placedBy: 'DUE_DATE', date: '2026-11-30' } }, buckets, working).size).toBe(0)
  })

  it('says the load as a percent and the minutes over', () => {
    expect(loadOf(new Dec('2340'), new Dec('2880'))).toEqual({ loadPct: '81.3', overMinutes: '0.0' })
    expect(loadOf(new Dec('3520'), new Dec('2880'))).toEqual({ loadPct: '122.2', overMinutes: '640.0' })
    expect(loadOf(new Dec('10'), new Dec('0'))).toEqual({ loadPct: null, overMinutes: '10.0' })
  })
})

describe('actual efficiency per line (PLN-014)', () => {
  const weeks = uniformBuckets('2026-11-09', '2026-11-22', 'WEEK')
  const scan = (patch: Partial<EarnedScan>): EarnedScan => ({ id: 'x', kind: 'REPORT', correctsId: null, bundleId: 'whole', operationId: 'sew', good: 10, stationId: 'st-line', at: new Date('2026-11-10T09:00:00Z'), ...patch })
  const facts = (scans: EarnedScan[]) => ({
    scans,
    bundles: new Map([['whole', { part: null, status: 'ACTIVE' }], ['sleeves', { part: 'SLEEVES', status: 'ACTIVE' }], ['void', { part: null, status: 'VOID' }]]),
    standardMinutes: new Map([['sew', '96.500']]),
    lineOfStation: new Map<string, string | null>([['st-line', 'L1'], ['st-alone', null]]),
    weeks,
    timeZone: 'Europe/Rome',
  })

  it("counts the standing reports' good whole garments × the standard minutes, per line and week", () => {
    const earned = earnedByLine(
      facts([
        scan({ id: 'a' }),
        scan({ id: 'b', at: new Date('2026-11-16T10:00:00Z'), good: 4 }),
        // Undone at once: neither counts.
        scan({ id: 'c', good: 7 }),
        scan({ id: 'c-undo', kind: 'UNDO', correctsId: 'c', good: 0 }),
        // Corrected: the correction counts instead.
        scan({ id: 'd', good: 5 }),
        scan({ id: 'd-fix', kind: 'CORRECTION', correctsId: 'd', good: 3 }),
        // A part bundle, a void bundle, a station on no line, a scan outside the weeks: none counts.
        scan({ id: 'e', bundleId: 'sleeves' }),
        scan({ id: 'f', bundleId: 'void' }),
        scan({ id: 'g', stationId: 'st-alone' }),
        scan({ id: 'h', at: new Date('2026-11-23T08:00:00Z') }),
      ]),
    )
    expect([...earned].map(([key, value]) => [key, value.toFixed(1)])).toEqual([
      ['L1|2026-W46', '1254.5'],
      ['L1|2026-W47', '386.0'],
    ])
    expect(actualWeek(new Dec('1254.5'), 8, 4650)).toEqual({ earnedMinutes: '1254.5', availableMinutes: '37200.0', pct: '3.4' })
    expect(actualWeek(new Dec(0), 0, 4650).pct).toBeNull()
  })
})
