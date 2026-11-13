import { describe, expect, it } from 'vitest'
import { localInstant } from '@nexus/factory-domain/calendars/dates'
import { publicHolidays } from '@nexus/factory-domain/calendars/holidays'
import { nextWorkingDay, OutsideWindowError, workingCalendar, workingMinutesBetween, workingTimeOf, type DayException } from '@nexus/factory-domain/calendars/working-time'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { LoadPart } from '@nexus/factory-domain/planning/capacity/load'
import { bridgeOf, copyFree, freeAfterLoad, freeWhenEmpty, makeDayOf, walkSteps } from '@nexus/factory-domain/planning/promise/ctp'
import { bridgeWords } from '@nexus/factory-domain/planning/promise/rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CapacityWorld, LaneState } from '../capacity/service'
import { lanesOf } from './engine'

/**
 * B-W2b-F44 (Owner 2026-11-13, option A), the pure part of the promise engine on a fixed clock: the lanes' minutes today are
 * only those left from now (lanesOf, on THE calendars service's working days and minutes), and a garment still to make is
 * promised for the next working day at the earliest (makeDayOf with the calendar's next working day), the bridge adding up.
 * One cutting centre with one station at 100 %, the planning default's shift (08:00-17:00, lunch 12:00-13:00: 480 minutes),
 * Monday to Friday, Italy's national holidays; Rome's time. The routes, the seed's lanes and the site's calendar:
 * promise.pg.vitest.test.ts.
 */

const ROME = 'Europe/Rome'
const WINDOW = { from: '2026-11-01', to: '2026-12-31' }
const holidays = new Map<string, DayException>(publicHolidays('IT', 2026).map((day) => [day.date, { date: day.date, kind: 'HOLIDAY', name: day.name, shiftPatternId: null }]))
const calendar = workingCalendar({ layers: [{ id: 'company', scope: 'COMPANY', name: 'Company', workingWeekdays: [1, 2, 3, 4, 5], shiftPatternId: null, days: holidays }], patterns: new Map(), timeZone: ROME, window: WINDOW })
const at = (date: BusinessDate, time: string) => localInstant(date, Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)), ROME)

const LANE = 'lane-cut'
function worldOn(today: BusinessDate, bookedToday = 0): CapacityWorld {
  const state = {
    lane: { kind: 'WORK_CENTRE', id: LANE, companyId: 'company', siteId: 'site', code: 'CUT', name: 'Cutting', workCentreKind: 'CUTTING', status: 'ACTIVE', stations: 1, workCentreIds: [], row: null },
    people: 1,
    peopleSource: 'STATIONS',
    efficiencyPct: '100.00',
    efficiencySource: 'DEFAULT',
    calendar,
    days: workingTimeOf(calendar, WINDOW.from, WINDOW.to).days,
    working: (from: Date, to: Date) => {
      try {
        return workingMinutesBetween(calendar, from, to)
      } catch (error) {
        if (error instanceof OutsideWindowError) return null
        throw error
      }
    },
  } as unknown as LaneState
  // Released work due today books the lane today (placed by its due date, as the capacity world places it off the board).
  const parts: LoadPart[] = bookedToday > 0 ? [{ laneKind: 'WORK_CENTRE', laneId: LANE, workOrderId: 'wo', operationId: 'op', pieces: 1, minutes: new Dec(bookedToday), placement: { placedBy: 'DUE_DATE', date: today } }] : []
  return { site: { id: 'site', companyId: 'company', code: 'A1', name: 'Plant', kind: 'PLANT', status: 'ACTIVE', timezone: ROME }, settings: null, today, lanes: [state], workOrders: [], held: [], slots: [], parts, window: WINDOW } as unknown as CapacityWorld
}

/** What the engine does with one group (engine.ts, step 4): the real and the empty walk from today's material, both never before the first make day. */
function promiseOn(today: BusinessDate, now: Date, minutes: number, bookedToday = 0) {
  const lanes = lanesOf(worldOn(today, bookedToday), today, now)
  const steps = [{ seq: 10, name: 'Cut', outside: false, transitDays: null, laneKeys: [`WORK_CENTRE:${LANE}`], minutes: new Dec(minutes) }]
  const real = walkSteps(steps, freeAfterLoad(lanes.lanes), today, lanes.names)
  const empty = walkSteps(steps, copyFree(freeWhenEmpty(lanes.lanes)), today, lanes.names)
  const firstMakeDay = nextWorkingDay(calendar, today).date!
  const finish = makeDayOf(real.finish!, firstMakeDay)
  const bridge = bridgeOf(today, today, makeDayOf(empty.finish!, firstMakeDay), finish)
  return { availableToday: Number(lanes.lanes[0]!.days[0]!.available), walked: real.finish, start: real.steps[0]!.start, finish, bridge, words: bridgeWords(bridge, null, today) }
}

describe('B-W2b-F44: the promise engine on a fixed clock', () => {
  it('a Wednesday: at 09:00 the rest of the day counts, at 17:30 nothing; a small job is promised tomorrow, never today', () => {
    expect(promiseOn('2026-11-18', at('2026-11-18', '07:00'), 60).availableToday).toBe(480)
    const morning = promiseOn('2026-11-18', at('2026-11-18', '09:00'), 60)
    expect(morning).toMatchObject({ availableToday: 420, walked: '2026-11-18', start: '2026-11-18', finish: '2026-11-19' })
    expect(morning.words).toBe("base lead time 1 day + queue at today's load 0 days + material ready 0 days = 1 day → 19 Nov")
    const evening = promiseOn('2026-11-18', at('2026-11-18', '17:30'), 60)
    expect(evening).toMatchObject({ availableToday: 0, walked: '2026-11-19', start: '2026-11-19', finish: '2026-11-19' })
    // 600 minutes: 420 today + 180 tomorrow at 09:00; at 17:30 all of tomorrow (480) and 120 the day after.
    expect(promiseOn('2026-11-18', at('2026-11-18', '09:00'), 600)).toMatchObject({ start: '2026-11-18', finish: '2026-11-19' })
    expect(promiseOn('2026-11-18', at('2026-11-18', '17:30'), 600)).toMatchObject({ start: '2026-11-19', finish: '2026-11-20' })
  })

  it('the last working day before a weekend: never Friday for a garment to make, Monday at the earliest', () => {
    const morning = promiseOn('2026-11-13', at('2026-11-13', '09:00'), 60)
    expect(morning).toMatchObject({ availableToday: 420, walked: '2026-11-13', finish: '2026-11-16' })
    expect(morning.words).toBe("base lead time 3 days + queue at today's load 0 days + material ready 0 days = 3 days → 16 Nov")
    expect(promiseOn('2026-11-13', at('2026-11-13', '17:30'), 60)).toMatchObject({ availableToday: 0, start: '2026-11-16', finish: '2026-11-16' })
    expect(promiseOn('2026-11-13', at('2026-11-13', '09:00'), 600)).toMatchObject({ start: '2026-11-13', finish: '2026-11-16' })
    expect(promiseOn('2026-11-13', at('2026-11-13', '17:30'), 600)).toMatchObject({ start: '2026-11-16', finish: '2026-11-17' })
  })

  it('the day before an Italian holiday (Immacolata, 8 Dec): the next working day is the 9th', () => {
    expect(promiseOn('2026-12-07', at('2026-12-07', '09:00'), 60)).toMatchObject({ availableToday: 420, walked: '2026-12-07', finish: '2026-12-09' })
    expect(promiseOn('2026-12-07', at('2026-12-07', '17:30'), 60)).toMatchObject({ availableToday: 0, start: '2026-12-09', finish: '2026-12-09' })
    expect(promiseOn('2026-12-07', at('2026-12-07', '09:00'), 600)).toMatchObject({ start: '2026-12-07', finish: '2026-12-09' })
    expect(promiseOn('2026-12-07', at('2026-12-07', '17:30'), 600)).toMatchObject({ start: '2026-12-09', finish: '2026-12-10' })
  })

  it('work booked today that no longer fits waits first from the next working day: the queue says so, the bridge adds up', () => {
    // 300 minutes due today. At 09:00 120 minutes are free today; at 17:30 none, so the 300 take Monday's first minutes.
    const morning = promiseOn('2026-11-13', at('2026-11-13', '09:00'), 240, 300)
    expect(morning).toMatchObject({ availableToday: 420, start: '2026-11-13', walked: '2026-11-16', finish: '2026-11-16' })
    expect(morning.bridge).toMatchObject({ materialDays: 0, baseDays: 3, queueDays: 0, spanDays: 3 })
    const evening = promiseOn('2026-11-13', at('2026-11-13', '17:30'), 240, 300)
    expect(evening).toMatchObject({ availableToday: 0, start: '2026-11-16', walked: '2026-11-17', finish: '2026-11-17' })
    expect(evening.bridge).toMatchObject({ materialDays: 0, baseDays: 3, queueDays: 1, spanDays: 4 })
    expect(evening.words).toBe("base lead time 3 days + queue at today's load 1 day + material ready 0 days = 4 days → 17 Nov")
  })
})
