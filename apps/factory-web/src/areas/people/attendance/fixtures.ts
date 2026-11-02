import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { inShell, PEOPLE_ROLES, PREFIX, SCOPE_ALL, SCOPE_ONE, TODAY, type PeopleRole } from '../_shared/fixtures'
import type { DayRecord } from './api'
import { attendanceCan, fixDraftOf, heldByReason, type AttendanceAddress, type FixDraft } from './model'
import { CODES, CORRECTIONS, DAY_ABSENT, DAY_APPROVED, DAY_CLEAN, DAY_CLOSED, DAY_RECORD, DAY_ROWS, ENTRY_BLOCKED, ENTRY_DECIDED, ENTRY_HELD, ENTRY_RECORD, ENTRY_ROWS, LINES, MONTH, PANEL_CLOSED, PANEL_LATE, PANEL_NOT_OVER, PANEL_OPEN, PANEL_READY, PANEL_UNSEALED, TEAMS, TIMESHEET_ROWS, WHO } from './demo/fixtures'
import type { DayState } from './use-day'
import type { AttendanceModel, EntryState, PageDialog } from './view-model'
import { AttendanceView } from './view/AttendanceView'

/**
 * SCR-157 — Attendance & timesheets (People › Main) with made-up data only: the gate shut, no site chosen and the rules unread (the
 * reason in words, nothing of a person), the tiles and their filters, too few people, Days with every state, the Day detail
 * with an anomaly, clean, approved, an absence and a closed month, Fix a day, Manual entry, Overtime to approve with a limit
 * near, over and blocking, Reject and the reason a block stands, Timesheets, the Month close held, ready, typed, closed and
 * sealed, and unsealed, Who is in now live and offline. Roles: HR, the production manager, the floor supervisor (who is in, the
 * roll call, timesheets as a lead; no days), read-only, sales (no access).
 */

const ADDRESS: AttendanceAddress = { month: MONTH, teamId: null, lineId: null, tile: null, status: null, anomaly: null, manual: false, open: null, entry: null, isNew: false, isClose: false }

interface AttendanceCase {
  role: PeopleRole
  model: AttendanceModel
}

function attendance(role: PeopleRole = 'hr', over: Partial<AttendanceModel> = {}): AttendanceCase {
  return {
    role,
    model: {
      prefix: PREFIX,
      can: attendanceCan(PEOPLE_ROLES[role]),
      address: ADDRESS,
      month: MONTH,
      today: TODAY,
      now: Date.parse('2026-11-02T09:42:00.000Z'),
      scope: SCOPE_ONE,
      gate: 'open',
      lines: LINES,
      teams: TEAMS,
      codes: CODES,
      tiles: { days: { people: 24, tooFew: false, tiles: { openAnomalies: 3, daysToApprove: 49, cleanDaysToApprove: 46, absencesWithoutCode: 2, manualDays: 1, clockedInNow: 18 } }, entries: { tooFew: false, tiles: { waitingEntries: 3, waitingMinutes: 390, notPlanned: 2 } }, problem: null },
      days: { items: DAY_ROWS, more: true, problem: null },
      selected: [],
      updates: 0,
      cells: {},
      approving: false,
      overtime: { items: ENTRY_ROWS, more: false, problem: null, all: false, selected: [], busy: false },
      timesheets: { items: TIMESHEET_ROWS, more: false, problem: null, canPrepare: true, selected: [], busy: false },
      panel: { status: 'ready', value: PANEL_OPEN },
      panelBusy: false,
      who: { value: WHO, problem: null, stale: false },
      day: null,
      entry: null,
      dialog: null,
      notice: null,
      asOf: '2026-11-02T09:42:00.000Z',
      live: 'live',
      help: false,
      ...over,
    },
  }
}

const dayState = (value: DayRecord, over: Partial<DayState> = {}): DayState => ({ id: value.id, loaded: { status: 'ready', value }, corrections: null, busy: false, problem: null, dialog: null, ...over })
const fixOf = (patch: Partial<FixDraft> = {}, value: DayRecord = DAY_RECORD): DayState => dayState(value, { dialog: { kind: 'fix', draft: { ...fixDraftOf(value), ...patch }, busy: false, problem: null } })
const entryState = (value: typeof ENTRY_RECORD, over: Partial<EntryState> = {}): EntryState => ({ id: value.id, loaded: { status: 'ready', value }, busy: false, problem: null, dialog: null, ...over })
const manual = (over: Partial<Extract<PageDialog, { kind: 'manual' }>['draft']> = {}, people: Extract<PageDialog, { kind: 'manual' }>['people'] = null): PageDialog => ({ kind: 'manual', draft: { choice: 'TIMES', employeeId: '', employeeName: '', date: TODAY, in: '', out: '', offSite: false, codeId: '', hours: '', documentRef: '', reasonCode: '', reason: '', ...over }, people, busy: false, problem: null })
const NOTHING: Partial<AttendanceModel> = { days: { items: null, more: false, problem: null }, overtime: { items: null, more: false, problem: null, all: false, selected: [], busy: false }, timesheets: { items: null, more: false, problem: null, canPrepare: false, selected: [], busy: false }, tiles: { days: null, entries: null, problem: null }, panel: { status: 'hidden' }, who: { value: null, problem: null, stale: false }, asOf: null }
const SHUT: Partial<AttendanceModel> = { ...NOTHING, gate: 'closed' }
const EMPTY: Partial<AttendanceModel> = { days: { items: [], more: false, problem: null }, overtime: { items: [], more: false, problem: null, all: false, selected: [], busy: false }, timesheets: { items: [], more: false, problem: null, canPrepare: true, selected: [], busy: false } }
const LOADING: Partial<AttendanceModel> = { days: { items: null, more: false, problem: null }, overtime: { items: null, more: false, problem: null, all: false, selected: [], busy: false }, timesheets: { items: null, more: false, problem: null, canPrepare: false, selected: [], busy: false }, tiles: { days: null, entries: null, problem: null }, panel: { status: 'loading' }, who: { value: null, problem: null, stale: false } }
const ready = (value: typeof PANEL_OPEN): Partial<AttendanceModel> => ({ panel: { status: 'ready', value } })
const TOO_FEW = { days: { people: null, tooFew: true, tiles: { openAnomalies: null, daysToApprove: null, cleanDaysToApprove: null, absencesWithoutCode: null, manualDays: null, clockedInNow: null } }, entries: { tooFew: true, tiles: { waitingEntries: null, waitingMinutes: null, notPlanned: null } }, problem: null }

export const designScreen = defineDesignScreen<AttendanceCase>({
  screen: 'SCR-157',
  title: 'Attendance & timesheets',
  view: ({ model }) => inShell('/people/attendance', createElement(AttendanceView, { model: model.model }), model.role),
  cases: [
    { id: 'hr', label: 'HR: the month with everything open', model: attendance() },
    { id: 'gate-off', label: 'Gate shut: the reason, nothing of a person', model: attendance('hr', SHUT), note: 'No tile, no list, no count: the legal text and how it opens (Statuto art. 4 c.2-3).' },
    { id: 'gate-off-other', label: 'Gate shut, no right on Privacy', model: attendance('production', SHUT) },
    { id: 'pick-site', label: 'All sites: asks for a site', model: attendance('hr', { ...NOTHING, gate: 'pickSite', scope: SCOPE_ALL }), note: 'The API reads one site at a time, each with its gate.' },
    { id: 'gate-unread', label: "The site's rules can't be read", model: attendance('hr', { ...NOTHING, gate: 'failed' }) },
    { id: 'gate-reading', label: 'Reading the gate', model: attendance('hr', { ...NOTHING, gate: 'reading' }) },
    { id: 'tile-anomalies', label: 'Tile: open anomalies', model: attendance('hr', { address: { ...ADDRESS, tile: 'ANOMALIES' }, days: { items: DAY_ROWS.filter((row) => row.status === 'NEEDS_FIX'), more: false, problem: null } }) },
    { id: 'tile-no-code', label: 'Tile: absences without a code, inline code', model: attendance('hr', { address: { ...ADDRESS, tile: 'NO_CODE' }, days: { items: DAY_ROWS.filter((row) => row.absence === 'MISSING'), more: false, problem: null } }) },
    { id: 'code-saving', label: 'The inline code saving, and refused', model: attendance('hr', { address: { ...ADDRESS, tile: 'NO_CODE' }, days: { items: DAY_ROWS.filter((row) => row.absence === 'MISSING'), more: false, problem: null }, cells: { [DAY_ROWS[2]!.id]: { state: 'failed', words: { key: 'refusal.HAS_CLOCK_EVENTS' } } } }) },
    { id: 'too-few', label: 'Too few people: no figure at all', model: attendance('hr', { address: { ...ADDRESS, teamId: TEAMS[0]!.id }, tiles: TOO_FEW }), note: 'Team and line under the company\'s minimum group size (ANA-075).' },
    { id: 'selected', label: 'Days selected: Approve N clean, the rest held', model: attendance('hr', { selected: [DAY_ROWS[1]!.id, DAY_ROWS[4]!.id, DAY_ROWS[0]!.id] }) },
    { id: 'held', label: 'Approved, some held with why', model: attendance('hr', { dialog: { kind: 'held', approved: 44, groups: heldByReason([{ dayId: DAY_ROWS[0]!.id, codes: ['ANOMALIES_OPEN'] }, { dayId: DAY_ROWS[2]!.id, codes: ['NO_ABSENCE_CODE'] }, { dayId: DAY_ROWS[3]!.id, codes: ['ANOMALIES_OPEN'] }], DAY_ROWS) } }) },
    { id: 'updates', label: 'Live: N updates · Show', model: attendance('hr', { updates: 3 }) },
    { id: 'day-anomaly', label: 'Day detail: an anomaly in words', model: attendance('hr', { day: dayState(DAY_RECORD) }) },
    { id: 'day-clean', label: 'Day detail: clean, Approve', model: attendance('hr', { day: dayState(DAY_CLEAN) }) },
    { id: 'day-approved', label: 'Day detail: approved, Reopen', model: attendance('hr', { day: dayState(DAY_APPROVED) }) },
    { id: 'day-absent', label: 'Day detail: an absence', model: attendance('hr', { day: dayState(DAY_ABSENT) }) },
    { id: 'day-closed', label: 'Day detail: a closed month, Correct', model: attendance('hr', { day: dayState(DAY_CLOSED, { corrections: CORRECTIONS }) }) },
    { id: 'day-refused', label: 'Day detail: approve refused', model: attendance('hr', { day: dayState(DAY_CLEAN, { problem: { key: 'hold.day.OWN_DAY' } }) }) },
    { id: 'day-loading', label: 'Day detail: reading', model: attendance('hr', { day: { id: DAY_RECORD.id, loaded: { status: 'loading' }, corrections: null, busy: false, problem: null, dialog: null } }) },
    { id: 'day-error', label: "Day detail: couldn't read", model: attendance('hr', { day: { id: DAY_RECORD.id, loaded: { status: 'error', problem: 'problem.unavailable' }, corrections: null, busy: false, problem: null, dialog: null } }) },
    { id: 'fix-add', label: 'Fix a day: add a clock-out', model: attendance('hr', { day: fixOf() }) },
    { id: 'fix-void', label: 'Fix a day: void a duplicate', model: attendance('hr', { day: fixOf({ choice: 'VOID', reasonCode: 'DUPLICATE' }) }) },
    { id: 'fix-absence', label: 'Fix a day: set an absence code', model: attendance('hr', { day: fixOf({ choice: 'ABSENCE', codeId: CODES[1]!.id, reasonCode: 'ABSENCE' }) }) },
    { id: 'fix-offsite', label: 'Fix a day: work outside the plant', model: attendance('hr', { day: fixOf({ choice: 'OFF_SITE', reasonCode: 'OFF_SITE' }) }) },
    { id: 'fix-refused', label: 'Fix a day: refused', model: attendance('hr', { day: dayState(DAY_RECORD, { dialog: { kind: 'fix', draft: fixDraftOf(DAY_RECORD), busy: false, problem: { key: 'refusal.DAY_APPROVED' } } }) }) },
    { id: 'accept', label: 'Accept an anomaly with a note', model: attendance('hr', { day: dayState(DAY_RECORD, { dialog: { kind: 'accept', anomalyId: DAY_RECORD.anomalies[0]!.id, note: '', busy: false, problem: null } }) }) },
    { id: 'reopen', label: 'Reopen a day', model: attendance('hr', { day: dayState(DAY_APPROVED, { dialog: { kind: 'reopen', reason: '', busy: false, problem: null } }) }) },
    { id: 'correct', label: 'Correct a closed day', model: attendance('hr', { day: dayState(DAY_CLOSED, { corrections: CORRECTIONS, dialog: { kind: 'correct', record: CORRECTIONS, draft: { kind: 'ORDINARY', absenceCodeId: '', minutes: '400', reason: '' }, busy: false, problem: null } }) }) },
    { id: 'correct-changed', label: 'Correct: someone corrected it first', model: attendance('hr', { day: dayState(DAY_CLOSED, { corrections: CORRECTIONS, dialog: { kind: 'correct', record: CORRECTIONS, draft: { kind: 'ORDINARY', absenceCodeId: '', minutes: '400', reason: 'Errore' }, busy: false, problem: { key: 'refusal.CHANGED' } } }) }) },
    { id: 'manual', label: 'Manual entry', model: attendance('hr', { dialog: manual() }) },
    { id: 'manual-person', label: 'Manual entry: the person found', model: attendance('hr', { dialog: manual({ employeeId: CORRECTIONS.person.employeeId, employeeName: CORRECTIONS.person.name, reasonCode: 'FORGOT_CLOCK_IN', in: '2026-11-02T05:00:00.000Z' }, [{ id: CORRECTIONS.person.employeeId, name: CORRECTIONS.person.name, code: CORRECTIONS.person.employeeCode }]) }) },
    { id: 'manual-absence', label: 'Manual entry: an absence code', model: attendance('hr', { dialog: manual({ choice: 'ABSENCE', codeId: CODES[1]!.id }) }) },
    { id: 'entry', label: 'Overtime: the record, limits in words', model: attendance('hr', { entry: entryState(ENTRY_RECORD) }) },
    { id: 'entry-held', label: 'Overtime: held, the day first', model: attendance('hr', { entry: entryState(ENTRY_HELD) }) },
    { id: 'entry-blocked', label: 'Overtime: a limit blocks', model: attendance('hr', { entry: entryState(ENTRY_BLOCKED) }) },
    { id: 'entry-override', label: 'Overtime: why it stands', model: attendance('hr', { entry: entryState(ENTRY_BLOCKED, { dialog: { kind: 'override', rules: ['OVERTIME_YEARLY_CAP'], reason: '', busy: false, problem: null } }) }) },
    { id: 'entry-reject', label: 'Reject overtime', model: attendance('hr', { entry: entryState(ENTRY_RECORD, { dialog: { kind: 'reject', reason: '', busy: false, problem: null } }) }) },
    { id: 'entry-decided', label: 'Overtime: rejected, Take back', model: attendance('hr', { entry: entryState(ENTRY_DECIDED) }) },
    { id: 'entries-selected', label: 'Overtime selected: a block is left out', model: attendance('hr', { overtime: { items: ENTRY_ROWS, more: false, problem: null, all: false, selected: [ENTRY_ROWS[0]!.id, ENTRY_ROWS[2]!.id], busy: false } }) },
    { id: 'sheets-selected', label: 'Timesheets selected', model: attendance('hr', { timesheets: { items: TIMESHEET_ROWS, more: false, problem: null, canPrepare: true, selected: [TIMESHEET_ROWS[0]!.id, TIMESHEET_ROWS[2]!.id], busy: false } }) },
    { id: 'close-ready', label: 'Month close: ready', model: attendance('hr', ready(PANEL_READY)) },
    { id: 'close-not-over', label: 'Month close: not over', model: attendance('hr', { ...ready(PANEL_NOT_OVER), month: '2026-11', address: { ...ADDRESS, month: '2026-11' } }) },
    { id: 'close-late', label: 'Month close: LUL late', model: attendance('hr', ready(PANEL_LATE)) },
    { id: 'close-typed', label: 'Close October 2026: typed', model: attendance('hr', { ...ready(PANEL_READY), dialog: { kind: 'close', typed: 'chiudi', busy: false, problem: null } }) },
    { id: 'close-refused', label: 'Close: refused', model: attendance('hr', { ...ready(PANEL_READY), dialog: { kind: 'close', typed: '', busy: false, problem: { key: 'hold.close.PRODUCTION_DAYS' } } }) },
    { id: 'closed', label: 'Month closed and sealed', model: attendance('hr', ready(PANEL_CLOSED)) },
    { id: 'closed-unsealed', label: 'Month closed, calendar not stored', model: attendance('hr', ready(PANEL_UNSEALED)) },
    { id: 'no-reach', label: 'Not every site in reach: no panel', model: attendance('hr', { panel: { status: 'noReach' } }) },
    { id: 'close-error', label: "Month close: couldn't read", model: attendance('hr', { panel: { status: 'error', problem: 'problem.unavailable' } }) },
    { id: 'who-offline', label: 'Who is in now: the last known list', model: attendance('hr', { who: { value: WHO, problem: null, stale: true }, live: 'offline' }) },
    { id: 'who-error', label: "Who is in now: couldn't read", model: attendance('hr', { who: { value: null, problem: 'problem.unavailable', stale: false } }) },
    { id: 'production', label: 'Production manager', model: attendance('production', ready(PANEL_READY)) },
    { id: 'supervisor', label: 'Floor supervisor: who is in, roll call, timesheets', model: attendance('supervisor', { days: { items: null, more: false, problem: null }, panel: { status: 'hidden' }, timesheets: { items: TIMESHEET_ROWS.slice(0, 2), more: false, problem: null, canPrepare: false, selected: [], busy: false } }), note: 'Leads confirm days, not hours: no list of days, no tile, no close.' },
    { id: 'read-only', label: 'Read-only', model: attendance('readOnly') },
    { id: 'no-permission', label: 'Sales: no access', model: attendance('sales') },
    { id: 'keys', label: 'Keyboard shortcuts', model: attendance('hr', { help: true }) },
    { id: 'loading', label: 'Loading', model: attendance('hr', LOADING) },
    { id: 'empty', label: 'No attendance yet', model: attendance('hr', { ...EMPTY, ...ready({ ...PANEL_OPEN, checklist: PANEL_OPEN.checklist.map((entry) => ({ ...entry, left: 0, done: true })), days: 0, holds: [{ code: 'NO_DAYS' }] }) }) },
    { id: 'no-match', label: 'Filters match nothing', model: attendance('hr', { ...EMPTY, address: { ...ADDRESS, status: 'NEEDS_FIX' } }) },
    { id: 'error', label: "Days couldn't be read", model: attendance('hr', { days: { items: null, more: false, problem: 'problem.unavailable' }, overtime: { items: null, more: false, problem: 'problem.unavailable', all: false, selected: [], busy: false }, timesheets: { items: null, more: false, problem: 'problem.unavailable', canPrepare: false, selected: [], busy: false }, tiles: { days: null, entries: null, problem: 'problem.unavailable' } }) },
  ],
})
