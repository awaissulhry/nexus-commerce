import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { allocationProblems, mainPiecesOf, moveAllocation, type Allocation } from './allocation'
import { scheduleWorkOrder, trayOrder, type ScheduleOperation } from './backward'
import { dispatchOrder, dispatchState } from './dispatch'
import { PLANNING_SCHEDULE_PERMISSIONS } from './permissions'
import { diffWords, laneOfSlot, planDiff, slotInputProblems, type DiffSlot } from './slots'
import { after, before, endBy, minutesBetween, startFrom, whenWords, workingMinutesFor, type Span } from './time'

// Two working days, 08:00-12:00 and 13:00-17:00 UTC (480 min each): 16 and 17 Nov 2026; the 18th 08:00-12:00.
const at = (day: number, hour: number, minute = 0) => Date.UTC(2026, 10, day, hour, minute)
const SPANS: Span[] = [
  { start: at(16, 8), end: at(16, 12) },
  { start: at(16, 13), end: at(16, 17) },
  { start: at(17, 8), end: at(17, 12) },
  { start: at(17, 13), end: at(17, 17) },
  { start: at(18, 8), end: at(18, 12) },
]
const TZ = 'UTC'

describe('working time walks (PLN-129)', () => {
  it('walks back and forward over the working stretches, skipping breaks and nights', () => {
    expect(before(SPANS, at(17, 17), 480)).toBe(at(17, 8))
    expect(before(SPANS, at(17, 10), 180)).toBe(at(16, 16))
    expect(after(SPANS, at(16, 11), 120)).toBe(at(16, 14))
    expect(after(SPANS, at(16, 18), 30)).toBe(at(17, 8, 30))
    // Out of the loaded stretches: null.
    expect(before(SPANS, at(16, 9), 120)).toBeNull()
    expect(after(SPANS, at(18, 11), 120)).toBeNull()
    expect([endBy(SPANS, at(17, 0)), endBy(SPANS, at(16, 10)), startFrom(SPANS, at(16, 12, 30)), startFrom(SPANS, at(18, 13))]).toEqual([at(16, 17), at(16, 10), at(16, 13), null])
    expect(minutesBetween(SPANS, at(16, 11), at(17, 9))).toBe(60 + 240 + 60)
  })

  it('counts what standard minutes take on a lane: ÷ (people × efficiency), whole minutes up', () => {
    expect(workingMinutesFor('5040', { people: 8, efficiencyPct: '85.00' })).toBe(742)
    expect(workingMinutesFor('100', { people: 0, efficiencyPct: '0' })).toBe(100)
    expect(whenWords(at(17, 8), 'Europe/Rome')).toBe('17 Nov 09:00')
  })
})

describe('backward scheduling and the latest safe start (PLN-129)', () => {
  const op = (id: string, seq: number, minutes: number, planned: { start: number; end: number }[] = []): ScheduleOperation => ({ id, seq, name: `Op ${seq}`, duration: { kind: 'WORKING', minutes, spans: SPANS }, planned })
  const due = { number: 'WO-1', dueDate: '2026-11-17', dueBy: at(18, 0) }

  it('schedules back from the end of work on the due date, finish to start', () => {
    const schedule = scheduleWorkOrder({ ...due, operations: [op('cut', 10, 120), op('sew', 20, 480)] }, { now: at(16, 7), soon: at(17, 0), timeZone: TZ })
    expect(schedule.operations.map((entry) => [entry.id, entry.latestStart, entry.latestFinish])).toEqual([
      ['cut', at(16, 15), at(16, 17)],
      ['sew', at(17, 8), at(17, 17)],
    ])
    expect(schedule.latestSafeStart).toBe(at(16, 15))
    expect(schedule.earliestFinish).toBe(at(17, 10))
    // Its latest safe start falls before the end of the next working day and nothing is on the board: at risk.
    expect([schedule.status, schedule.placed, schedule.reasons[0]!.code]).toEqual(['AT_RISK', 'NONE', 'START_SOON'])
    expect(schedule.words).toBe('WO-1 must start by 16 Nov 15:00 (its latest safe start) and 2 operations are not on the board.')
  })

  it('says why a work order is late: past due, cannot finish in time, or the plan finishes it after', () => {
    const late = scheduleWorkOrder({ ...due, operations: [op('cut', 10, 120), op('sew', 20, 480)] }, { now: at(17, 9), soon: at(18, 0), timeZone: TZ })
    expect([late.status, late.reasons[0]!.code]).toEqual(['LATE', 'CANNOT_FINISH_IN_TIME'])
    expect(late.words).toBe('Even started now, WO-1 finishes on 18 Nov 11:00, after its due date 17 Nov 2026.')
    expect(scheduleWorkOrder({ ...due, operations: [op('sew', 20, 60)] }, { now: at(18, 9), soon: at(19, 0), timeZone: TZ }).reasons[0]!.code).toBe('PAST_DUE')
    const planned = scheduleWorkOrder({ ...due, operations: [op('cut', 10, 120, [{ start: at(16, 8), end: at(16, 10) }]), op('sew', 20, 240, [{ start: at(17, 13), end: at(18, 10) }])] }, { now: at(16, 7), soon: at(17, 0), timeZone: TZ })
    expect([planned.status, planned.placed, planned.reasons.map((reason) => reason.code)]).toEqual(['LATE', 'ALL', ['PLAN_FINISHES_LATE']])
    // A bar that starts after its latest start: at risk; the whole plan in time and in order: on time.
    const squeezed = scheduleWorkOrder({ ...due, operations: [op('cut', 10, 60, [{ start: at(17, 14, 30), end: at(17, 15, 30) }]), op('sew', 20, 120, [{ start: at(17, 15, 30), end: at(17, 17, 30) }])] }, { now: at(16, 7), soon: at(16, 12), timeZone: TZ })
    expect([squeezed.status, squeezed.reasons[0]!.code]).toEqual(['AT_RISK', 'STARTS_AFTER_LATEST_START'])
    const fine = scheduleWorkOrder({ ...due, operations: [op('cut', 10, 60, [{ start: at(16, 8), end: at(16, 9) }]), op('sew', 20, 120, [{ start: at(16, 13), end: at(16, 15) }])] }, { now: at(16, 7), soon: at(16, 12), timeZone: TZ })
    expect([fine.status, fine.plannedFinish]).toEqual(['ON_TIME', at(16, 15)])
    expect(fine.words).toMatch(/^WO-1 can start as late as 17 Nov 14:00 and still finish by 17 Nov 2026; the plan finishes it on 16 Nov 15:00\.$/)
  })

  it('handles outside work on the clock, no due date, nothing left, and a chain longer than the calendar', () => {
    const outside = scheduleWorkOrder({ ...due, operations: [{ id: 'out', seq: 30, name: 'Op 30', duration: { kind: 'CLOCK', minutes: 24 * 60 }, planned: [] }] }, { now: at(15, 0), soon: at(15, 1), timeZone: TZ })
    expect([outside.latestSafeStart, outside.status]).toEqual([at(17, 0), 'ON_TIME'])
    expect(scheduleWorkOrder({ ...due, dueDate: null, dueBy: null, operations: [op('a', 10, 60)] }, { now: at(16, 7), soon: at(17, 0), timeZone: TZ }).status).toBe('NO_DUE_DATE')
    expect(scheduleWorkOrder({ ...due, operations: [] }, { now: at(16, 7), soon: at(17, 0), timeZone: TZ }).status).toBe('DONE')
    const long = scheduleWorkOrder({ ...due, operations: [op('a', 10, 5000)] }, { now: at(16, 7), soon: at(17, 0), timeZone: TZ })
    expect([long.status, long.latestSafeStart, long.reasons[0]!.code]).toEqual(['LATE', null, 'CANNOT_FINISH_IN_TIME'])
    expect([{ latestSafeStart: 5, dueDate: null, number: 'B' }, { latestSafeStart: null, dueDate: '2026-01-01', number: 'A' }, { latestSafeStart: 2, dueDate: null, number: 'C' }].sort(trayOrder).map((entry) => entry.number)).toEqual(['C', 'B', 'A'])
  })
})

describe('slots and the published diff (PLN-131, PLN-147)', () => {
  it('checks a place or move in words', () => {
    expect(slotInputProblems({ startAt: 2, endAt: 1 }, { whole: false, garments: 5 }).map((issue) => issue.path)).toEqual(['body/endAt'])
    expect(slotInputProblems({ startAt: 1, endAt: 2, pieces: 3 }, { whole: false, garments: 5 })[0]!.message).toMatch(/books its whole operation/)
    expect(slotInputProblems({ startAt: 1, endAt: 2, pieces: 6, overloadReason: ' x ' }, { whole: true, garments: 5 }).map((issue) => issue.path)).toEqual(['body/pieces', 'body/overloadReason'])
    expect(slotInputProblems({ startAt: 1, endAt: 2, pieces: 5, overloadReason: 'Rush for the fair' }, { whole: true, garments: 5 })).toEqual([])
    expect(laneOfSlot({ lineId: null, workCentreId: null, partyId: 'p' })).toEqual({ kind: 'WORKSHOP', id: 'p' })
  })

  it('compares the working plan with the last version: moved, added, removed, per lane', () => {
    const slot = (workOrderId: string, operationId: string | null, laneId: string, startAt: number, pieces: number | null = null): DiffSlot => ({ workOrderId, operationId, lane: { kind: 'LINE', id: laneId }, startAt, endAt: startAt + 1, pieces })
    const published = [slot('w1', 'cut', 'L1', 1), slot('w1', 'sew', 'L1', 2), slot('w2', 'sew', 'L1', 3), slot('w3', null, 'L2', 4, 10)]
    const working = [slot('w1', 'cut', 'L1', 1), slot('w1', 'sew', 'L2', 2), slot('w4', 'sew', 'L1', 5), slot('w3', null, 'L2', 4, 10)]
    const diff = planDiff(working, published)
    expect([diff.moved, diff.added, diff.removed]).toEqual([1, 1, 1])
    expect(diff.byLane).toEqual([
      { lane: { kind: 'LINE', id: 'L1' }, moved: 0, added: 1, removed: 1 },
      { lane: { kind: 'LINE', id: 'L2' }, moved: 1, added: 0, removed: 0 },
    ])
    expect([diffWords(diff), diffWords(planDiff(published, published))]).toEqual(['1 moved, 1 added, 1 removed', 'no change'])
  })
})

describe('allocation to lines and workshops (PLN-160)', () => {
  const none: Allocation = { lineId: null, parts: [] }
  const L1 = { kind: 'LINE' as const, id: 'L1' }
  const L2 = { kind: 'LINE' as const, id: 'L2' }
  const W = { kind: 'WORKSHOP' as const, id: 'W' }
  const ok = (result: ReturnType<typeof moveAllocation>) => {
    if ('refusal' in result) throw new Error(result.refusal)
    return result.allocation
  }

  it('moves an order, or part of it, between not allocated, lines and workshops', () => {
    const onL1 = ok(moveAllocation(none, { from: null, to: L1 }, 100))
    expect(onL1).toEqual({ lineId: 'L1', parts: [] })
    const split = ok(moveAllocation(onL1, { from: L1, to: L2, pieces: 40 }, 100))
    expect([split, mainPiecesOf(split, 100)]).toEqual([{ lineId: 'L1', parts: [{ lane: L2, pieces: 40 }] }, 60])
    const out = ok(moveAllocation(split, { from: L2, to: W, pieces: 10 }, 100))
    expect(out.parts).toEqual([{ lane: L2, pieces: 30 }, { lane: W, pieces: 10 }])
    expect(ok(moveAllocation(out, { from: W, to: L1 }, 100)).parts).toEqual([{ lane: L2, pieces: 30 }])
    // The line part whole to another line: that line makes the order; the only part whole onto a line: the same.
    expect(ok(moveAllocation(onL1, { from: L1, to: L2 }, 100))).toEqual({ lineId: 'L2', parts: [] })
    const atWorkshop = ok(moveAllocation(none, { from: null, to: W }, 100))
    expect(atWorkshop).toEqual({ lineId: null, parts: [{ lane: W, pieces: 100 }] })
    expect(ok(moveAllocation(atWorkshop, { from: W, to: L1 }, 100))).toEqual({ lineId: 'L1', parts: [] })
  })

  it('refuses what cannot be, in words', () => {
    expect(moveAllocation(none, { from: L1, to: L2 }, 10)).toEqual({ refusal: 'The card is not in that column any more: reload the board.' })
    expect(moveAllocation({ lineId: 'L1', parts: [] }, { from: L1, to: null, pieces: 3 }, 10)).toMatchObject({ refusal: expect.stringMatching(/cannot wait unallocated/) })
    expect(moveAllocation({ lineId: 'L1', parts: [] }, { from: L1, to: L2, pieces: 11 }, 10)).toEqual({ refusal: 'The card holds 10 garments.' })
    expect(allocationProblems({ lineId: 'L1', parts: [{ lane: L1, pieces: 2 }, { lane: W, pieces: 5 }, { lane: W, pieces: 5 }] }, 10).map((issue) => issue.path)).toEqual(['body/parts/0/lane', 'body/parts/2/lane'])
    expect(allocationProblems({ lineId: null, parts: [{ lane: W, pieces: 8 }, { lane: L2, pieces: 3 }] }, 10)[0]!.message).toBe('The parts name 11 garments; the work order has 10.')
  })
})

describe('the dispatch list (MES-021)', () => {
  const facts = { workOrderNumber: 'WO-1', workOrderStatus: 'IN_PROGRESS', holdReason: null, operation: { seq: 20, name: 'Sewing' }, previous: { seq: 10, name: 'Cutting' }, garments: 10, arrived: 0, waiting: 0, done: 0 }
  it('says where the work stands and orders rush first, then due date, then start and sequence', () => {
    expect(dispatchState(facts)).toEqual({ state: 'WAITING_FOR_PREVIOUS', words: 'Waiting for Op 10 Cutting.' })
    expect(dispatchState({ ...facts, arrived: 6, waiting: 6 }).state).toBe('READY')
    expect(dispatchState({ ...facts, previous: null }).state).toBe('READY')
    expect(dispatchState({ ...facts, done: 10 }).state).toBe('DONE')
    expect(dispatchState({ ...facts, workOrderStatus: 'ON_HOLD', holdReason: 'Leather test' })).toEqual({ state: 'ON_HOLD', words: 'WO-1 is on hold: Leather test.' })
    expect(dispatchState({ ...facts, workOrderStatus: 'DRAFT' }).state).toBe('NOT_RELEASED')
    const keys = [
      { priority: 0, dueDate: '2026-11-20', startAt: 1, seq: 10, workOrderNumber: 'A' },
      { priority: 1, dueDate: '2026-12-01', startAt: 9, seq: 10, workOrderNumber: 'B' },
      { priority: 0, dueDate: '2026-11-18', startAt: 5, seq: 20, workOrderNumber: 'C' },
      { priority: 0, dueDate: '2026-11-18', startAt: 5, seq: 10, workOrderNumber: 'D' },
      { priority: 0, dueDate: null, startAt: 0, seq: 10, workOrderNumber: 'E' },
    ]
    expect([...keys].sort(dispatchOrder).map((key) => key.workOrderNumber)).toEqual(['B', 'D', 'C', 'A', 'E'])
  })
})

describe('declared', () => {
  it('the permissions are in the catalogue and the planner holds them; the events are declared', () => {
    for (const permission of PLANNING_SCHEDULE_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(permission)).toBe(true)
    expect(templateOf('planner')!.permissions).toEqual(expect.arrayContaining([...PLANNING_SCHEDULE_PERMISSIONS]))
    // A production manager reads the board (planning.view) and changes nothing on it.
    expect(templateOf('production_manager')!.permissions).not.toContain('planning.schedule.manage')
    expect(EVENT_CATALOGUE.types()).toEqual(expect.arrayContaining(['planning.schedule_changed', 'planning.schedule_published']))
  })
})
