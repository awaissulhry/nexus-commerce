import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { APPROVAL_HOLDS, ANOMALY_KINDS, MANUAL_REASONS } from '@nexus/factory-domain/people/attendance/rules'
import { CLOCK_KINDS, CLOCK_SOURCES } from '@nexus/factory-domain/people/clock/rules'
import { LUL_TO_CONFIRM } from '@nexus/factory-domain/people/close/lul'
import { CLOSE_HOLDS, CLOSE_ITEMS, CLOSE_NOTES, CORRECTION_KINDS } from '@nexus/factory-domain/people/close/rules'
import { CHECKED_LIMITS } from '@nexus/factory-domain/people/limits/checks'
import { ENTRY_HOLDS, OVERTIME_CLASSES } from '@nexus/factory-domain/people/overtime/rules'
import { TIMESHEET_HOLDS } from '@nexus/factory-domain/people/overtime/timesheets'
import { createApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { recordAddress } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { PEOPLE, PEOPLE_ROLES } from '../_shared/fixtures'
import { approveDay, closeMonth, fixDay, readDays, readEntries, readRollCall, readSight, readTimesheets } from './api'
import { CORRECTIONS, DAY_CLEAN, DAY_RECORD, DAY_ROWS, ENTRY_RECORD, PANEL_CLOSED, PANEL_NOT_OVER, PANEL_OPEN, PANEL_READY, TIMESHEET_ROWS, WHO } from './demo/fixtures'
import { designScreen as employeeScreen } from './employee/fixtures'
import { designScreen as attendanceScreen } from './fixtures'
import { designScreen as lulScreen } from './lul/fixtures'
import {
  anomalyWords,
  attendanceAddressOf,
  attendanceAddressText,
  attendanceCan,
  ATTENDANCE_REFUSALS,
  blockingLimit,
  checkWords,
  closeHeld,
  correctionHeld,
  dayNotSelectable,
  daysCsvRows,
  daysFilterOf,
  entryNotSelectable,
  eventWords,
  figureOf,
  fixActionOf,
  fixDraftOf,
  fixHeld,
  gateOf,
  heldByReason,
  holdsOf,
  inlineCodeOffered,
  isCleanDay,
  isFiltered,
  isGateClosed,
  isLimitBlocked,
  limitsOf,
  manualBodyOf,
  manualHeld,
  minutesOfHours,
  monthRange,
  monthWords,
  movedMonth,
  phraseOf,
  plainReason,
  plannedText,
  problemOf,
  reasonHeld,
  reasonOf,
  ruleWords,
  seesThePage,
  selectionOf,
  showMeOf,
  stripOf,
  timesheetNotSelectable,
  timesheetVerb,
  toneOf,
  whoRows,
  type ManualDraft,
} from './model'
import { designScreen as rollScreen } from './rollcall/fixtures'
import { designScreen as sheetScreen } from './timesheet/fixtures'

const say = (locale: 'it' | 'en') => createTranslator(locale, messagesFor(locale, ['attendance']).attendance ?? {})
const known = (key: string) => {
  for (const locale of LOCALES) expect(say(locale)(key, { count: 2, time: '10:00', limit: '1', found: '2', taken: 1, month: 'x', year: '2026', used: '1', average: '1', weeks: 1, months: 1, rest: '1', from: 'a', to: 'b', span: '1' }), `${locale}:${key}`).not.toBe(key)
}

describe('the right to the page', () => {
  it('reads each right from the session and opens the page to a lead with the roll call only', () => {
    expect(attendanceCan(PEOPLE_ROLES.hr)).toMatchObject({ view: true, manage: true, approve: true, close: true, correct: true, lul: true, rollCall: true, reviewOvertime: true, timesheetHr: true })
    const supervisor = attendanceCan(PEOPLE_ROLES.supervisor)
    expect(supervisor).toMatchObject({ view: false, manage: false, close: false, rollCall: true, timesheetLead: true })
    expect(seesThePage(supervisor)).toBe(true)
    expect(seesThePage(attendanceCan(PEOPLE_ROLES.sales))).toBe(false)
  })
})

describe('the legal gate', () => {
  it('opens only on a read that says open, and shuts on any later refusal', () => {
    expect(gateOf({ status: 'ready', sight: { open: true } }, false)).toBe('open')
    expect(gateOf({ status: 'ready', sight: { open: false } }, false)).toBe('closed')
    expect(gateOf({ status: 'ready', sight: { open: true } }, true)).toBe('closed')
    expect(gateOf({ status: 'loading' }, false)).toBe('reading')
    expect(gateOf({ status: 'failed' }, false)).toBe('failed')
    expect(gateOf({ status: 'allSites' }, false)).toBe('pickSite')
  })
})

describe('the address', () => {
  it('goes round', () => {
    const params = new URLSearchParams('month=2026-10&team=t&line=l&tile=NO_CODE&open=d&entry=e&new=1&close=1&print=1')
    const address = attendanceAddressOf(params)
    expect(address).toMatchObject({ month: '2026-10', teamId: 't', lineId: 'l', tile: 'NO_CODE', open: 'd', entry: 'e', isNew: true, isClose: true })
    expect(attendanceAddressText(address, params)).toBe('?print=1&month=2026-10&team=t&line=l&tile=NO_CODE&open=d&entry=e&new=1&close=1')
  })

  it('takes nothing it does not know', () => {
    expect(attendanceAddressOf(new URLSearchParams('month=2026-13&tile=SOMEONE&status=x&anomaly=y'))).toMatchObject({ month: null, tile: null, status: null, anomaly: null })
    expect(attendanceAddressText(attendanceAddressOf(null))).toBe('')
  })
})

describe('the month', () => {
  it('walks across a year and knows its last day', () => {
    expect(movedMonth('2026-12', 1)).toBe('2027-01')
    expect(movedMonth('2026-01', -1)).toBe('2025-12')
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(monthRange('2028-02').to).toBe('2028-02-29')
    expect(monthWords('2026-10', 'it')).toBe('ottobre 2026')
    expect(monthWords('2026-10', 'en')).toBe('October 2026')
  })
})

describe('which days a view asks', () => {
  it('turns a tile into the API filter, and the code tile into a filter of its own', () => {
    const base = { tile: null, status: null, anomaly: null, manual: false }
    expect(daysFilterOf({ ...base, tile: 'ANOMALIES' })).toMatchObject({ status: 'NEEDS_FIX', onlyMissingCode: false })
    expect(daysFilterOf({ ...base, tile: 'TO_APPROVE' })).toMatchObject({ status: 'OPEN' })
    expect(daysFilterOf({ ...base, tile: 'NO_CODE' })).toMatchObject({ status: null, onlyMissingCode: true })
    expect(daysFilterOf({ ...base, manual: true })).toMatchObject({ manual: true })
    expect(isFiltered(base)).toBe(false)
    expect(isFiltered({ ...base, status: 'OPEN' })).toBe(true)
  })

  it('calls a day clean only when nothing holds it', () => {
    expect(isCleanDay({ status: 'OPEN', absence: 'NONE', date: '2026-10-30' }, '2026-11-02')).toBe(true)
    expect(isCleanDay({ status: 'NEEDS_FIX', absence: 'NONE', date: '2026-10-30' }, '2026-11-02')).toBe(false)
    expect(isCleanDay({ status: 'OPEN', absence: 'MISSING', date: '2026-10-30' }, '2026-11-02')).toBe(false)
    expect(isCleanDay({ status: 'OPEN', absence: 'NONE', date: '2026-11-02' }, '2026-11-02')).toBe(false)
    expect(selectionOf(DAY_ROWS.slice(0, 3), '2026-11-02')).toEqual({ clean: 1, held: 2 })
  })

  it('lets a day with an anomaly be ticked (it comes back held) but not one already decided', () => {
    expect(dayNotSelectable({ status: 'NEEDS_FIX' })).toBeNull()
    expect(dayNotSelectable({ status: 'APPROVED' })).toBe('held.dayApproved')
    expect(dayNotSelectable({ status: 'CLOSED' })).toBe('held.dayClosed')
  })

  it('offers the inline code only on a planned day nobody clocked in', () => {
    const can = { manage: true }
    expect(inlineCodeOffered({ absence: 'MISSING', presence: false, status: 'OPEN' }, can)).toBe(true)
    expect(inlineCodeOffered({ absence: 'MISSING', presence: true, status: 'OPEN' }, can)).toBe(false)
    expect(inlineCodeOffered({ absence: 'MISSING', presence: false, status: 'APPROVED' }, can)).toBe(false)
    expect(inlineCodeOffered({ absence: 'MISSING', presence: false, status: 'OPEN' }, { manage: false })).toBe(false)
  })

  it('groups what a bulk approval held by reason, with the day and team and no name', () => {
    const groups = heldByReason([{ dayId: DAY_ROWS[0]!.id, codes: ['ANOMALIES_OPEN'] }, { dayId: DAY_ROWS[3]!.id, codes: ['ANOMALIES_OPEN'] }, { dayId: 'gone', codes: [] }], DAY_ROWS)
    expect(groups.map((group) => [group.code, group.days.length])).toEqual([['ANOMALIES_OPEN', 2], ['OUT_OF_REACH', 1]])
    expect(Object.keys(groups[0]!.days[0]!).sort()).toEqual(['date', 'id', 'teamId'])
  })

  it('exports states only, as on screen', () => {
    const rows = daysCsvRows(DAY_ROWS.slice(0, 1), { status: (status) => status, team: () => 'T', line: () => 'L', absence: (state) => state, kinds: (row) => row.anomalies.kinds.join(), yes: 'y', no: 'n' })
    expect(rows[0]).toEqual(['2026-10-30', 'T', 'L', 'Mattino · 06:00–14:00', 'y', 'MISSING_CLOCK_OUT', 'n', 'NONE', 'NEEDS_FIX'])
    expect(JSON.stringify(rows)).not.toMatch(/minutes/i)
  })
})

describe('the words of the API', () => {
  it('finds the gate, the holds, a limit and a refusal in the answer', () => {
    const gate = new ApiError('conflict', 409, 'invalid_state', 'x', null, [{ path: 'gate/ATTENDANCE' }])
    expect(isGateClosed(gate)).toBe(true)
    expect(problemOf(gate)).toEqual({ key: 'gate.short' })
    const held = new ApiError('conflict', 409, 'invalid_state', 'x', null, [{ path: 'refusal/HELD' }, { path: 'holds/ANOMALIES_OPEN' }])
    expect(holdsOf(held)).toEqual(['ANOMALIES_OPEN'])
    expect(problemOf(held)).toEqual({ key: 'hold.day.ANOMALIES_OPEN' })
    expect(problemOf(new ApiError('conflict', 409, 'x', 'x', null, [{ path: 'refusal/HELD' }, { path: 'holds/PRODUCTION_DAYS' }]), 'close')).toEqual({ key: 'hold.close.PRODUCTION_DAYS' })
    const limit = new ApiError('conflict', 409, 'x', 'x', null, [{ path: 'refusal/LIMIT_BLOCKED' }, { path: 'limits/DAILY_REST' }])
    expect(isLimitBlocked(limit)).toBe(true)
    expect(limitsOf(limit)).toEqual(['DAILY_REST'])
    expect(problemOf(new ApiError('conflict', 409, 'x', 'x', null, [{ path: 'refusal/OWN_DAY' }]))).toEqual({ key: 'refusal.OWN_DAY' })
    expect(problemOf(new ApiError('invalid', 400, 'x', 'x', null, [{ path: 'body/phrase' }]))).toEqual({ key: 'problem.phrase' })
    expect(problemOf(new Error('x'))).toEqual({ key: 'problem.unavailable' })
  })

  it('says every code of the API in both languages', () => {
    for (const code of APPROVAL_HOLDS) known(`hold.day.${code}`)
    for (const code of ENTRY_HOLDS) known(`hold.entry.${code}`)
    for (const code of TIMESHEET_HOLDS) known(`hold.timesheet.${code}`)
    for (const code of CLOSE_HOLDS) known(`hold.close.${code}`)
    for (const code of CLOSE_ITEMS) known(`close.item.${code}`)
    for (const code of CLOSE_NOTES) known(`close.note.${code}`)
    for (const code of CORRECTION_KINDS) known(`correctKind.${code}`)
    for (const code of ATTENDANCE_REFUSALS) known(`refusal.${code}`)
    for (const code of MANUAL_REASONS) known(`reason.${code}`)
    for (const code of CLOCK_KINDS) known(`event.kind.${code}`)
    for (const code of CLOCK_SOURCES) {
      known(`event.source.${code}`)
      known(`event.sourceOffSite.${code}`)
    }
    for (const code of ANOMALY_KINDS) known(`anomalyKind.${code}`)
    for (const code of OVERTIME_CLASSES) known(`class.${code}`)
    for (const code of CHECKED_LIMITS) {
      known(`limit.${code}.name`)
      known(`limit.${code}.short`)
    }
  })

  it('says each thing the labour consultant confirms, none forgotten', () => {
    LUL_TO_CONFIRM.forEach((_, index) => known(`toConfirm.${index}`))
    expect(say('en')(`toConfirm.${LUL_TO_CONFIRM.length}`)).toBe(`toConfirm.${LUL_TO_CONFIRM.length}`)
  })

  it('says an anomaly from its kind, its rule and its clock event', () => {
    for (const kind of ANOMALY_KINDS) {
      const anomaly = { kind, ruleKey: 'x', clockEventId: null }
      known(anomalyWords(anomaly, DAY_RECORD, 'en').key)
      known(ruleWords(anomaly).key)
    }
    const auto = DAY_RECORD.anomalies[0]!
    expect(anomalyWords(auto, DAY_RECORD, 'en')).toEqual({ key: 'anomaly.MISSING_CLOCK_OUT.auto', params: { time: '14:15' } })
    expect(ruleWords(auto).key).toBe('rule.MISSING_CLOCK_OUT_AUTO')
    expect(anomalyWords({ kind: 'FLAGGED_EVENT', ruleKey: 'x', clockEventId: DAY_RECORD.events[1]!.id }, DAY_RECORD, 'en').key).toBe('anomaly.FLAGGED_EVENT.badge')
    expect(eventWords(DAY_RECORD.events[3]!)).toEqual({ key: 'event.source.AUTO' })
    expect(eventWords({ kind: 'VOID', source: 'MANUAL', offSite: false })).toEqual({ key: 'event.void' })
    expect(eventWords({ kind: 'IN', source: 'MANUAL', offSite: true })).toEqual({ key: 'event.sourceOffSite.MANUAL' })
  })

  it('says a limit in words, with its figures, and never by colour alone', () => {
    const [cap, rest, average] = ENTRY_RECORD.checks
    expect(checkWords(cap!, 'en')).toEqual({ key: 'limit.OVERTIME_YEARLY_CAP.words', params: { year: '2026', used: '230 h', limit: '250 h' } })
    expect(checkWords(rest!, 'en').key).toBe('limit.DAILY_REST.rest')
    expect(checkWords({ rule: 'DAILY_REST', state: 'OK', values: { limitMinutes: 660 } }, 'it')).toEqual({ key: 'limit.DAILY_REST.ok', params: { limit: '11 h' } })
    expect(checkWords({ rule: 'DAILY_REST', state: 'OVER', values: { spanMinutes: 800, limitMinutes: 660, from: '06:00', to: '20:00' } }, 'en').key).toBe('limit.DAILY_REST.span')
    expect(checkWords(average!, 'en').params).toMatchObject({ weeks: 17, months: 4 })
    expect(toneOf({ state: 'OK', level: 'BLOCK' })).toBe('success')
    expect(toneOf({ state: 'OVER', level: 'WARN' })).toBe('warning')
    expect(toneOf({ state: 'OVER', level: 'BLOCK' })).toBe('danger')
    expect(blockingLimit([{ state: 'NEAR', level: 'BLOCK' }])).toBe(false)
    expect(blockingLimit([{ state: 'OVER', level: 'BLOCK' }])).toBe(true)
  })
})

describe('the Day strip', () => {
  it('draws the shift, the work and the break, and leaves a voided event out', () => {
    const strip = stripOf(DAY_RECORD, Date.parse('2026-10-30T18:00:00Z'))
    expect(strip.segments.map((segment) => segment.kind)).toEqual(['work', 'break', 'work'])
    expect(strip.events.map((event) => event.kind)).toEqual(['in', 'forgot-badge', 'other', 'auto-out'])
    expect(strip.shift).toMatchObject({ label: 'Mattino' })
    expect(strip.from).toBeLessThanOrEqual(strip.shift!.from)
    expect(strip.to).toBeGreaterThanOrEqual(strip.shift!.to)
    const voided = stripOf({ ...DAY_RECORD, events: DAY_RECORD.events.map((event, index) => (index === 3 ? { ...event, voided: true } : event)) }, Date.parse('2026-10-30T10:00:00Z'))
    expect(voided.events).toHaveLength(3)
    expect(voided.segments.at(-1)?.to).toBe(Date.parse('2026-10-30T10:00:00Z'))
  })

  it('draws a working day even with no shift and no event', () => {
    const empty = stripOf({ date: '2026-10-30', planned: null, events: [] }, 0)
    expect(empty.to).toBeGreaterThan(empty.from)
    expect(empty.segments).toEqual([])
  })
})

describe('a fix and a manual entry', () => {
  it('starts a fix from what the day lacks', () => {
    const draft = fixDraftOf({ ...DAY_RECORD, anomalies: [{ ...DAY_RECORD.anomalies[0]!, kind: 'MISSING_CLOCK_OUT' }] })
    expect(draft).toMatchObject({ choice: 'ADD', event: 'OUT', reasonCode: 'FORGOT_CLOCK_OUT' })
    expect(draft.at).toBe('2026-10-30T13:00:00.000Z')
    expect(fixDraftOf({ ...DAY_RECORD, anomalies: [{ ...DAY_RECORD.anomalies[0]!, kind: 'MISSING_CLOCK_IN' }] })).toMatchObject({ event: 'IN', reasonCode: 'FORGOT_CLOCK_IN', at: '2026-10-30T05:00:00.000Z' })
  })

  it('holds a fix until it says what, when and why', () => {
    const draft = { ...fixDraftOf(DAY_RECORD), reasonCode: '' as const }
    expect(fixHeld(draft)).toBe('held.reason')
    expect(fixHeld({ ...draft, reason: 'ok' })).toBe('held.reason')
    expect(fixHeld({ ...draft, reason: 'forgot' })).toBeNull()
    expect(fixHeld({ ...draft, reason: 'forgot', at: '' })).toBe('held.fixTime')
    expect(fixHeld({ ...draft, reason: 'forgot', choice: 'VOID' })).toBe('held.fixEvent')
    expect(fixHeld({ ...draft, reason: 'forgot', choice: 'ABSENCE' })).toBe('held.fixCode')
    expect(fixHeld({ ...draft, reason: 'forgot', choice: 'ABSENCE', codeId: 'c', hours: 'molte' })).toBe('held.fixHours')
    expect(fixHeld({ ...draft, reason: 'forgot', choice: 'REMOVE_ABSENCE' })).toBe('held.fixAbsence')
  })

  it('takes the list alone as a reason, except Other', () => {
    expect(reasonHeld({ reasonCode: 'BADGE_PROBLEM', reason: '' })).toBeNull()
    expect(reasonHeld({ reasonCode: 'OTHER', reason: '' })).toBe('held.reason')
    expect(reasonHeld({ reasonCode: '', reason: 'x'.repeat(501) })).toBe('held.reasonLong')
    expect(reasonOf({ reasonCode: 'BADGE_PROBLEM', reason: '' }, (code) => `said ${code}`)).toBe('said BADGE_PROBLEM')
    expect(reasonOf({ reasonCode: 'BADGE_PROBLEM', reason: ' typed ' }, () => 'x')).toBe('typed')
  })

  it('sends the action the draft says', () => {
    const draft = fixDraftOf(DAY_RECORD)
    expect(fixActionOf({ ...draft, choice: 'ADD' })).toEqual({ kind: 'ADD_EVENT', event: 'OUT', at: draft.at })
    expect(fixActionOf({ ...draft, choice: 'OFF_SITE' })).toEqual({ kind: 'ADD_EVENT', event: 'OUT', at: draft.at, offSite: true })
    expect(fixActionOf({ ...draft, choice: 'VOID', clockEventId: 'e' })).toEqual({ kind: 'VOID_EVENT', clockEventId: 'e' })
    expect(fixActionOf({ ...draft, choice: 'ABSENCE', codeId: 'c', hours: '7,5', documentRef: ' P1 ' })).toEqual({ kind: 'SET_ABSENCE', codeId: 'c', minutes: 450, documentRef: 'P1' })
    expect(fixActionOf({ ...draft, choice: 'REMOVE_ABSENCE', absenceId: 'a' })).toEqual({ kind: 'REMOVE_ABSENCE', absenceId: 'a' })
    expect(minutesOfHours('8')).toBe(480)
    expect(minutesOfHours('25')).toBeNull()
    expect(minutesOfHours('0')).toBeNull()
  })

  it('holds a manual entry until it is whole, and never ahead of time', () => {
    const draft: ManualDraft = { choice: 'TIMES', employeeId: '', employeeName: '', date: '2026-11-02', in: '', out: '', offSite: false, codeId: '', hours: '', documentRef: '', reasonCode: 'FORGOT_CLOCK_IN', reason: '' }
    expect(manualHeld(draft, '2026-11-02')).toBe('held.manualPerson')
    const person = { ...draft, employeeId: 'p' }
    expect(manualHeld({ ...person, date: '2026-11-03' }, '2026-11-02')).toBe('held.manualFuture')
    expect(manualHeld(person, '2026-11-02')).toBe('held.manualTimes')
    expect(manualHeld({ ...person, in: '2026-11-02T10:00:00Z', out: '2026-11-02T09:00:00Z' }, '2026-11-02')).toBe('held.manualOrder')
    expect(manualHeld({ ...person, in: '2026-11-02T05:00:00Z' }, '2026-11-02')).toBeNull()
    expect(manualHeld({ ...person, choice: 'ABSENCE' }, '2026-11-02')).toBe('held.fixCode')
    expect(manualBodyOf({ ...person, in: 'I', offSite: true }, 'why')).toEqual({ employeeId: 'p', date: '2026-11-02', reasonCode: 'FORGOT_CLOCK_IN', reason: 'why', in: 'I', offSite: true })
    expect(manualBodyOf({ ...person, choice: 'ABSENCE', codeId: 'c', in: 'I' }, 'why')).toMatchObject({ absence: { codeId: 'c' } })
    expect(manualBodyOf({ ...person, choice: 'ABSENCE', codeId: 'c', in: 'I' }, 'why')).not.toHaveProperty('in')
  })
})

describe('a correction', () => {
  it('starts from what stands now, and holds until it changes something, with a reason', () => {
    expect(figureOf(CORRECTIONS.figuresNow, 'ORDINARY', null)).toBe(420)
    expect(figureOf(CORRECTIONS.closedFigures, 'ORDINARY', null)).toBe(450)
    expect(figureOf({ ...CORRECTIONS.figuresNow, absences: [{ codeId: 'c', code: 'FER', minutes: 60 }] }, 'ABSENCE', 'c')).toBe(60)
    const draft = { kind: 'ORDINARY' as const, absenceCodeId: '', minutes: '400', reason: 'Errore' }
    expect(correctionHeld(draft, 420)).toBeNull()
    expect(correctionHeld({ ...draft, minutes: '420' }, 420)).toBe('held.correctSame')
    expect(correctionHeld({ ...draft, minutes: 'tanti' }, 420)).toBe('held.correctMinutes')
    expect(correctionHeld({ ...draft, minutes: '1441' }, 420)).toBe('held.correctMinutes')
    expect(correctionHeld({ ...draft, reason: 'x' }, 420)).toBe('held.reason')
    expect(correctionHeld({ ...draft, kind: 'ABSENCE' }, 420)).toBe('held.fixCode')
  })
})

describe('the month close', () => {
  it('holds Close with the count of open items, or the reason', () => {
    expect(closeHeld(PANEL_OPEN, { close: true })).toEqual({ key: 'held.closeOpen', params: { count: 5 } })
    expect(closeHeld(PANEL_READY, { close: true })).toBeNull()
    expect(closeHeld(PANEL_READY, { close: false })).toEqual({ key: 'held.noClose' })
    expect(closeHeld(PANEL_CLOSED, { close: true })).toEqual({ key: 'held.closed' })
    expect(closeHeld(PANEL_NOT_OVER, { close: true })).toEqual({ key: 'hold.close.MONTH_NOT_OVER' })
  })

  it('sends each Show me where the design says', () => {
    expect(showMeOf('DAYS_APPROVED')).toEqual({ tile: 'TO_APPROVE' })
    expect(showMeOf('ANOMALIES_CLEARED')).toEqual({ tile: 'ANOMALIES' })
    expect(showMeOf('ABSENCE_CODES')).toEqual({ tile: 'NO_CODE' })
    expect(showMeOf('MANUAL_REVIEWED')).toEqual({ manual: true })
    expect(showMeOf('OVERTIME_DECIDED')).toEqual({ section: 'overtime' })
    expect(showMeOf('PRODUCTION_DAYS')).toEqual({ page: '/production/labour' })
    expect(OFFICE_PAGES.has('/production/labour')).toBe(true)
  })

  it('types the phrase in the page language', () => {
    expect(phraseOf(PANEL_READY, 'it')).toBe('chiudi ottobre 2026')
    expect(phraseOf(PANEL_READY, 'en')).toBe('close October 2026')
  })
})

describe('overtime and timesheets', () => {
  it('ticks what can still be decided, by whoever has the turn', () => {
    expect(entryNotSelectable({ status: 'PENDING' })).toBeNull()
    expect(entryNotSelectable({ status: 'APPROVED' })).toBe('held.entryDecided')
    const hr = { timesheetLead: false, timesheetHr: true }
    const lead = { timesheetLead: true, timesheetHr: false }
    expect(timesheetVerb({ stage: 'LEAD' }, lead)).toBe('lead')
    expect(timesheetVerb({ stage: 'HR' }, lead)).toBeNull()
    expect(timesheetVerb({ stage: 'HR' }, hr)).toBe('hr')
    expect(timesheetNotSelectable(TIMESHEET_ROWS[0]!, lead)).toBeNull()
    expect(timesheetNotSelectable(TIMESHEET_ROWS[1]!, lead)).toBe('held.timesheetNotReady')
    expect(timesheetNotSelectable(TIMESHEET_ROWS[2]!, lead)).toBe('held.timesheetNotYours')
    expect(timesheetNotSelectable(TIMESHEET_ROWS[3]!, lead)).toBe('held.timesheetDone')
  })
})

describe('who is in now', () => {
  it('shows a small group with no count', () => {
    const rows = whoRows(WHO)
    expect(rows.map((row) => row.people)).toEqual([10, 6, null])
    expect(rows[2]).toMatchObject({ tooFew: true })
  })
})

describe('a stored reason', () => {
  it('reads without the list code the API keeps in front', () => {
    expect(plainReason('FORGOT_CLOCK_OUT: Uscita dimenticata')).toBe('Uscita dimenticata')
    expect(plainReason('Timbrato per errore')).toBe('Timbrato per errore')
  })
})

describe('the planned shift', () => {
  it('says its window, past midnight too', () => {
    expect(plannedText({ label: null, startMinute: 1320, endMinute: 1800, minutes: 450 })).toBe('22:00–06:00')
    expect(plannedText(null)).toBeNull()
  })
})

describe('the calls', () => {
  function client(answers: Record<string, unknown>) {
    const calls: Array<{ method: string; url: string; body: unknown; key: string | null }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : null, key: new Headers(init?.headers).get('idempotency-key') })
      const hit = Object.keys(answers).find((path) => url.includes(path))
      return new Response(JSON.stringify(hit ? answers[hit] : {}), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    return { calls, api: createApiClient({ baseUrl: '/api', fetch: fetcher, company: 'DEMO', csrfToken: () => 'csrf-demo' }) }
  }

  it('asks the ATTENDANCE purpose first, and no person key in a list', async () => {
    const { calls, api } = client({ 'what-you-see': { siteId: 's', purpose: 'ATTENDANCE', open: false, level: 'GROUPS_ONLY', minimumGroupSize: 3, leadsSeeFigures: false, words: ['x'] }, '/days': { days: DAY_ROWS, nextCursor: null, today: '2026-11-02', words: ['English'] }, '/entries': { entries: [], nextCursor: null }, '/people/timesheets': { timesheets: [], nextCursor: null, canPrepare: false } })
    expect((await readSight(api, 's')).open).toBe(false)
    expect(calls[0]!.url).toContain('purpose=ATTENDANCE')
    const page = await readDays(api, { siteId: 's', from: '2026-10-01', to: '2026-10-31', manual: true, teamId: null })
    expect(page).not.toHaveProperty('words')
    await readEntries(api, { siteId: 's', from: '2026-10-01', to: '2026-10-31' })
    await readTimesheets(api, { siteId: 's', month: '2026-10' })
    for (const call of calls) expect(call.url).not.toMatch(/employeeId|workerId|personId/)
    expect(calls[1]!.url).toContain('manual=true')
    expect(calls[1]!.url).not.toContain('teamId')
  })

  it('sends the version read and one key per write; a roll call is a recorded POST', async () => {
    const record = { ...DAY_CLEAN, events: [], anomalies: [], words: [] }
    const { calls, api } = client({ '/approve': record, '/fix': record, 'month-close': PANEL_CLOSED, 'roll-call': { asOf: '2026-11-02T09:00:00.000Z', people: 0, groups: [], words: 'English' } })
    await approveDay(api, 'd', 7)
    await fixDay(api, 'd', { version: 7, action: { kind: 'VOID_EVENT', clockEventId: 'e' }, reason: 'doppia' })
    await closeMonth(api, { companyId: 'c', month: '2026-10', phrase: 'close October 2026' })
    await readRollCall(api, 's')
    expect(calls[0]).toMatchObject({ method: 'POST', body: { version: 7 } })
    expect(calls[1]!.body).toMatchObject({ version: 7, reason: 'doppia' })
    expect(calls[2]!.body).toEqual({ companyId: 'c', month: '2026-10', phrase: 'close October 2026' })
    expect(calls[3]).toMatchObject({ method: 'POST', body: { siteId: 's' } })
    const keys = calls.map((call) => call.key)
    expect(keys.every(Boolean)).toBe(true)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('where a record opens', () => {
  it('opens each of them here', () => {
    expect(recordAddress({ type: 'AttendanceDay', id: 'd' }, OFFICE_PAGES)).toBe('/people/attendance?open=d')
    expect(recordAddress({ type: 'OvertimeEntry', id: 'e' }, OFFICE_PAGES)).toBe('/people/attendance?entry=e')
    expect(recordAddress({ type: 'TimesheetApproval', id: 't' }, OFFICE_PAGES)).toBe('/people/attendance/timesheets/t')
  })
})

describe('the design cases', () => {
  const screens = [attendanceScreen, rollScreen, lulScreen, sheetScreen, employeeScreen] as unknown as DesignScreen<unknown>[]
  const render = (screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]) => {
    const messages = messagesFor(locale, ['shell', 'attendance', 'people', 'lists', 'ds-words'])
    return renderToString(createElement(I18nProvider, { locale, messages }, createElement(screen.view as ComponentType<{ model: unknown }>, { model })))
  }

  it('renders every case in both languages with no key on screen', () => {
    for (const screen of screens) {
      for (const entry of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, entry.model, locale)
          expect(html.length, `${screen.screen}/${entry.id}`).toBeGreaterThan(0)
          expect(html, `${screen.screen}/${entry.id}`).not.toMatch(/>\s*(?:[a-z]+\.)+[A-Za-z_]+\s*</)
        }
      }
    }
  }, 240_000)

  it('shows nothing of a person with the gate shut', () => {
    for (const id of ['gate-off', 'pick-site', 'gate-unread']) {
      const entry = attendanceScreen.cases.find((item) => item.id === id)!
      const html = render(attendanceScreen as unknown as DesignScreen<unknown>, entry.model, 'en')
      for (const person of [PEOPLE.paolo.name, PEOPLE.giulia.name]) expect(html, id).not.toContain(person)
      expect(html, id).not.toContain('Open anomalies')
      expect(html, id).not.toContain('Who is in now</h2>')
    }
    const closed = renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell', 'attendance', 'people', 'lists', 'ds-words']) }, createElement(employeeScreen.view as ComponentType<{ model: unknown }>, { model: employeeScreen.cases.find((item) => item.id === 'gate-off')!.model })))
    expect(closed).toContain('Attendance is off at this site')
  })

  it('names nobody in a list', () => {
    const hr = attendanceScreen.cases.find((item) => item.id === 'hr')!.model.model
    expect(JSON.stringify([hr.days.items, hr.overtime.items, hr.timesheets.items])).not.toMatch(/employeeId|displayName|presentMinutes|overtimeMinutes/i)
  })

  it('gives a lead no hours', () => {
    const lead = sheetScreen.cases.find((item) => item.id === 'lead')!.model
    expect(lead.loaded.status === 'ready' ? lead.loaded.value.summary : 'x').toBeNull()
  })

  it('has every state the brief asks', () => {
    for (const id of ['loading', 'error', 'empty', 'no-permission', 'gate-off', 'who-offline', 'close-ready', 'closed']) expect(attendanceScreen.cases.some((item) => item.id === id), id).toBe(true)
  })
})
