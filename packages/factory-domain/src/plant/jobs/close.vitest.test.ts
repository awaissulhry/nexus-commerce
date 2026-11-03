import { describe, expect, it } from 'vitest'
import { closeFacts, FAILURE_CODE, FAILURE_CODES, handBackProblems, leadConfirmRefusal, MAX_MINUTES, minutesSpentOf, workDoneOf } from './close'

/** B-W2b-96: the one-screen close and the line lead's confirmation (QHS-190, QHS-180), pure. */

const at = (minute: number) => new Date(Date.UTC(2026, 10, 21, 8, minute))

describe('the one-screen close (QHS-190)', () => {
  it('counts the minutes from the start to the hand-back, never below 0, at most a year', () => {
    expect(minutesSpentOf(at(20), at(45))).toBe(25)
    expect(minutesSpentOf(at(45), at(20))).toBe(0)
    expect(minutesSpentOf(null, at(20))).toBe(0)
    expect(minutesSpentOf(new Date(0), at(0))).toBe(MAX_MINUTES)
  })

  it('writes what was done from the action tile and the words', () => {
    expect(workDoneOf('ADJUSTED', undefined)).toBe('Adjusted')
    expect(workDoneOf('REPLACED_PART', 'new presser foot')).toBe('Replaced a part: new presser foot')
    expect(workDoneOf('OTHER', 'reset the motor')).toBe('reset the motor')
    expect(workDoneOf(undefined, '  ')).toBeNull()
  })

  it('asks what was done (words with OTHER) and a failure code of the guard’s shape', () => {
    expect(handBackProblems({ action: 'CLEANED' })).toEqual([])
    expect(handBackProblems({}).map((problem) => problem.path)).toEqual(['workDone'])
    expect(handBackProblems({ action: 'OTHER' }).map((problem) => problem.message)).toEqual(['Say what was done.'])
    expect(handBackProblems({ workDone: 'tightened', failureCode: 'loose part' }).map((problem) => problem.path)).toEqual(['failureCode'])
    expect(FAILURE_CODES.every((tile) => FAILURE_CODE.test(tile.code))).toBe(true)
  })

  it('shows the minutes so far and holds "running" while the machine is locked', () => {
    expect(closeFacts({ status: 'IN_PROGRESS', startedAt: at(0), locked: true }, at(30))).toEqual({ minutesSoFar: 30, runningHeld: true, canHandBack: true })
    expect(closeFacts({ status: 'NEW', startedAt: null, locked: false }, at(30))).toEqual({ minutesSoFar: null, runningHeld: false, canHandBack: false })
  })
})

describe('the line lead confirms (QHS-180)', () => {
  it('once, while the job is handed back', () => {
    expect(leadConfirmRefusal({ number: 'MJ-1', status: 'HANDED_BACK', leadConfirmedAt: null })).toBeNull()
    expect(leadConfirmRefusal({ number: 'MJ-1', status: 'HANDED_BACK', leadConfirmedAt: at(1) })?.code).toBe('LEAD_CONFIRMED')
    expect(leadConfirmRefusal({ number: 'MJ-1', status: 'IN_PROGRESS', leadConfirmedAt: null })?.code).toBe('NOT_HANDED_BACK')
  })
})
