import { describe, expect, it } from 'vitest'
import { automaticPlan, cancelRefusal, closesNow, leaverStepsFor, startRefusal, stepRefusal } from './rules'

describe('leaver steps (MES-214)', () => {
  it('the steps follow what the person has: a floor sign-in, a badge, an office account; visit and PPE when asked', () => {
    const full = leaverStepsFor({ floorSignIns: 1, activeBadges: 1, officeAccount: true }, { exitVisit: true, ppeReturn: true }, '2026-11-30')
    expect(full.map((step) => [step.seq, step.kind, step.automatic, step.dueOn])).toEqual([
      [1, 'BADGE_OFF', true, '2026-11-30'],
      [2, 'SESSIONS_ENDED', true, '2026-11-30'],
      [3, 'BADGE_RETURNED', false, '2026-11-30'],
      [4, 'ACCESS_ENDED', true, '2026-11-30'],
      [5, 'WORK_HANDED_OVER', false, '2026-11-30'],
      [6, 'PPE_RETURNED', false, '2026-11-30'],
      [7, 'SHIFTS_CLEARED', true, '2026-12-01'],
      [8, 'PAYROLL_FLAGGED', true, null],
      [9, 'EXIT_VISIT', false, null],
    ])
    const clerk = leaverStepsFor({ floorSignIns: 0, activeBadges: 0, officeAccount: false }, { exitVisit: false, ppeReturn: false }, '2026-11-30')
    expect(clerk.map((step) => step.kind)).toEqual(['WORK_HANDED_OVER', 'SHIFTS_CLEARED', 'PAYROLL_FLAGGED'])
  })

  it('starts once per person, not before the start, at most a year ahead; a past last day is allowed', () => {
    const base = { status: 'ACTIVE', leaving: false, startDate: '2024-01-01', today: '2026-10-31' }
    expect(startRefusal({ ...base, lastWorkingDay: '2026-11-30' })).toBeNull()
    expect(startRefusal({ ...base, lastWorkingDay: '2026-09-30' })).toBeNull()
    expect(startRefusal({ ...base, leaving: true, lastWorkingDay: '2026-11-30' })?.code).toBe('ALREADY_LEAVING')
    expect(startRefusal({ ...base, status: 'LEFT', lastWorkingDay: '2026-11-30' })?.code).toBe('LEFT')
    expect(startRefusal({ ...base, lastWorkingDay: '2023-12-31' })?.code).toBe('BEFORE_START')
    expect(startRefusal({ ...base, lastWorkingDay: '2027-11-02' })?.code).toBe('TOO_FAR')
  })

  it('cancels until the last day; steps move only while the case is open; a skip says why', () => {
    expect(cancelRefusal({ status: 'OPEN', lastWorkingDay: '2026-10-31', today: '2026-10-31' })).toBeNull()
    expect(cancelRefusal({ status: 'OPEN', lastWorkingDay: '2026-10-30', today: '2026-10-31' })?.code).toBe('PAST_LAST_DAY')
    expect(cancelRefusal({ status: 'DONE', lastWorkingDay: '2026-11-30', today: '2026-10-31' })?.code).toBe('NOT_OPEN')
    expect(stepRefusal('OPEN', 'OPEN', 'DONE', null)).toBeNull()
    expect(stepRefusal('OPEN', 'OPEN', 'SKIP', ' ')?.code).toBe('NO_REASON')
    expect(stepRefusal('OPEN', 'DONE', 'DONE', null)?.code).toBe('STEP_NOT_OPEN')
    expect(stepRefusal('OPEN', 'OPEN', 'REOPEN', null)?.code).toBe('STEP_OPEN')
    expect(stepRefusal('OPEN', 'SKIPPED', 'REOPEN', null)).toBeNull()
    expect(stepRefusal('DONE', 'OPEN', 'DONE', null)?.code).toBe('NOT_OPEN')
  })

  it('automatic steps: the floor sign-in goes after the last day; access when the account ended; shifts when none remain', () => {
    const open = ['BADGE_OFF', 'SESSIONS_ENDED', 'ACCESS_ENDED', 'SHIFTS_CLEARED', 'PAYROLL_FLAGGED'] as const
    expect(automaticPlan({ today: '2026-11-30', lastWorkingDay: '2026-11-30', activeWorkers: 1, accountEnded: false, shiftsAfter: 0 }, open)).toEqual({ switchOffFloor: false, tick: [] })
    expect(automaticPlan({ today: '2026-12-01', lastWorkingDay: '2026-11-30', activeWorkers: 1, accountEnded: false, shiftsAfter: 2 }, open)).toEqual({ switchOffFloor: true, tick: ['BADGE_OFF', 'SESSIONS_ENDED'] })
    expect(automaticPlan({ today: '2026-12-01', lastWorkingDay: '2026-11-30', activeWorkers: 0, accountEnded: true, shiftsAfter: 0 }, open)).toEqual({ switchOffFloor: false, tick: ['BADGE_OFF', 'SESSIONS_ENDED', 'ACCESS_ENDED', 'SHIFTS_CLEARED'] })
    expect(automaticPlan({ today: '2026-11-01', lastWorkingDay: '2026-11-30', activeWorkers: 0, accountEnded: true, shiftsAfter: 0 }, ['ACCESS_ENDED'])).toEqual({ switchOffFloor: false, tick: ['ACCESS_ENDED'] })
  })

  it('closes when no step is open and the last day has come', () => {
    expect(closesNow([{ status: 'DONE' }, { status: 'SKIPPED' }], '2026-10-31', '2026-10-31')).toBe(true)
    expect(closesNow([{ status: 'DONE' }, { status: 'SKIPPED' }], '2026-11-01', '2026-10-31')).toBe(false)
    expect(closesNow([{ status: 'DONE' }, { status: 'OPEN' }], '2026-10-01', '2026-10-31')).toBe(false)
    expect(closesNow([], '2026-10-01', '2026-10-31')).toBe(false)
  })
})
