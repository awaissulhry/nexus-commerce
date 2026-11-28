import { describe, expect, it } from 'vitest'
import { CALL_REFUSALS } from '../calls/rules'
import {
  askTo,
  callFileKindOf,
  DESIGNER_ASK_CODES,
  escalationDue,
  floorGroupOf,
  floorTypesFor,
  isCallSpot,
  isLateDays,
  lateWarningsOf,
  minutesOpen,
  noStationRefusal,
  PHONE_CALL_REFUSALS,
  rowEventIds,
  suggestionProblem,
} from './signals'

/** owb-fl3 (S5 server B): the floor's signals on a basket — problems and asks as help calls, escalation, flags, late, suggestions. */

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 28, 8, minutes, 0))

describe('problems and asks are help-call types by code (settle 5)', () => {
  it('who answers an ask is fixed by its code; a problem has no fixed answerer', () => {
    expect(askTo('ASK_LOGO')).toBe('DESIGNER')
    expect(askTo('ASK_PATCH')).toBe('DESIGNER')
    expect(askTo('ASK_UNCLEAR')).toBe('DESIGNER')
    expect(askTo('ASK_TO_PATCH')).toBe('TEAM_LEADER')
    expect(askTo('ASK_OTHER')).toBe('TEAM_LEADER')
    expect(askTo('MATERIAL')).toBeNull()
    expect(askTo('TEAM_LEADER')).toBeNull()
    expect(DESIGNER_ASK_CODES).toEqual(['ASK_LOGO', 'ASK_PATCH', 'ASK_UNCLEAR'])
  })

  it('each code belongs to one window; other call types belong to none', () => {
    expect(['MATERIAL', 'DAMAGED', 'UNCLEAR', 'MACHINE', 'PAPER'].map(floorGroupOf)).toEqual(['PROBLEM', 'PROBLEM', 'PROBLEM', 'PROBLEM', 'PROBLEM'])
    expect(['ASK_LOGO', 'ASK_OTHER'].map(floorGroupOf)).toEqual(['ASK', 'ASK'])
    expect(floorGroupOf('MAINTENANCE')).toBeNull()
  })

  it('a window lists the site’s ACTIVE types of its codes in the site’s order; a code the site lacks is not shown', () => {
    const types = [
      { code: 'MAINTENANCE', active: true },
      { code: 'PAPER', active: true },
      { code: 'MATERIAL', active: true },
      { code: 'MACHINE', active: false },
      { code: 'ASK_LOGO', active: true },
    ]
    expect(floorTypesFor(types, 'PROBLEM').map((type) => type.code)).toEqual(['PAPER', 'MATERIAL'])
    expect(floorTypesFor(types, 'ASK').map((type) => type.code)).toEqual(['ASK_LOGO'])
    expect(floorTypesFor([], 'ASK')).toEqual([])
  })

  it('a phone with no department pick, or a department with no station, gets the phone’s words (code NO_STATION); a tablet keeps today’s', () => {
    expect(noStationRefusal({ phone: true, departmentId: null }, CALL_REFUSALS.NO_STATION)).toBe(PHONE_CALL_REFUSALS.NO_DEPARTMENT)
    expect(noStationRefusal({ phone: true, departmentId: 'dept-4' }, CALL_REFUSALS.NO_STATION)).toBe(PHONE_CALL_REFUSALS.NO_DEPARTMENT_STATION)
    expect(noStationRefusal({ phone: false, departmentId: null }, CALL_REFUSALS.NO_STATION)).toBe(CALL_REFUSALS.NO_STATION)
    expect(PHONE_CALL_REFUSALS.NO_DEPARTMENT.code).toBe('NO_STATION')
    expect(PHONE_CALL_REFUSALS.NO_DEPARTMENT.message).toBe('Pick your department first.')
  })
})

describe('photo and voice on a call', () => {
  it('a picture is a PHOTO, a sound an AUDIO voice note, anything else none', () => {
    expect(callFileKindOf('image/jpeg')).toBe('PHOTO')
    expect(callFileKindOf('Audio/WebM')).toBe('AUDIO')
    expect(callFileKindOf('video/mp4')).toBeNull()
    expect(callFileKindOf('application/pdf')).toBeNull()
  })
  it('a spot is 0 to 8', () => {
    expect([0, 4, 8].every(isCallSpot)).toBe(true)
    expect([9, -1, 1.5, '3'].some(isCallSpot)).toBe(false)
  })
})

describe('escalation after the type’s minutes (R53)', () => {
  const sent = { status: 'SENT', sentAt: at(0), escalatedAt: null }
  it('a SENT or SEEN call escalates once its minutes passed', () => {
    expect(escalationDue(sent, 10, at(9))).toBeNull()
    expect(escalationDue(sent, 10, at(10))).toEqual(at(10))
    expect(escalationDue({ ...sent, status: 'SEEN' }, 10, at(30))).toEqual(at(10))
  })
  it('never twice, never ON_THE_WAY, SOLVED or CANCELLED, never without minutes', () => {
    expect(escalationDue({ ...sent, escalatedAt: at(10) }, 10, at(30))).toBeNull()
    for (const status of ['ON_THE_WAY', 'SOLVED', 'CANCELLED']) expect(escalationDue({ ...sent, status }, 10, at(30))).toBeNull()
    expect(escalationDue(sent, null, at(30))).toBeNull()
  })
  it('counts whole minutes open', () => {
    expect(minutesOpen(at(0), new Date(at(12).getTime() + 59_000))).toBe(12)
    expect(minutesOpen(at(5), at(0))).toBe(0)
  })
})

describe('Do this first and Will be late', () => {
  it('late by 1, 2, 3 or 5 days only', () => {
    expect([1, 2, 3, 5].every(isLateDays)).toBe(true)
    expect([0, 4, 6, '2'].some(isLateDays)).toBe(false)
  })
  it('one warning per work order: it names the basket when it is one, else the whole work order', () => {
    const rows = lateWarningsOf([
      { id: 'b1', workOrderId: 'wo-1' },
      { id: 'b2', workOrderId: 'wo-2' },
      { id: 'b3', workOrderId: 'wo-2' },
      { id: 'b3', workOrderId: 'wo-2' },
    ])
    expect(rows).toEqual([
      { workOrderId: 'wo-1', bundleId: 'b1', bundleIds: ['b1'] },
      { workOrderId: 'wo-2', bundleId: null, bundleIds: ['b2', 'b3'] },
    ])
  })
  it('the rows of one act take the act’s id, numbered when there are several', () => {
    expect(rowEventIds('evt-1', 1)).toEqual(['evt-1'])
    expect(rowEventIds('evt-1', 3)).toEqual(['evt-1.1', 'evt-1.2', 'evt-1.3'])
  })
})

describe('Tell the office', () => {
  it('words, a voice note or the kind alone; words never blank, at most 1000 letters', () => {
    expect(suggestionProblem({ words: null })).toBeNull()
    expect(suggestionProblem({ words: 'The glue pot leaks.' })).toBeNull()
    expect(suggestionProblem({ words: '   ' })).toBe('Write a few words, or send it without words.')
    expect(suggestionProblem({ words: 'x'.repeat(1001) })).toMatch(/1000/)
  })
})
