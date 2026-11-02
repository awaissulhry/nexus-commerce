import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { inShell, PEOPLE, PEOPLE_ROLES, PREFIX, SCOPE_ALL, SCOPE_ONE, SIGHT_OFF, TODAY, type PeopleRole } from '../_shared/fixtures'
import { cellId, datesOf, draftsOf, optionOf, personRows, shiftsCan, sheetRowsOf, type ShiftsAddress } from './model'
import { AFTERNOON, DEMO_ROSTER, DEMO_ROWS, LINE_A_REF, LINE_B_REF, LINE_S_REF, MONTH, MONTH_ROSTER, PREVIEW, RANGE, recordOf, REQUESTS, rosterOf, rosterRows, SOUTH_ROW, TEAM_A, TEAM_B, CAP_WARNING, REST_WARNING } from './demo/fixtures'
import type { AssignDraft, OvertimeDraft, ShiftsModel } from './view-model'
import { ShiftsView } from './view/ShiftsView'

/**
 * SCR-263 — Shifts (People › Main) with made-up data only: the week and the month, All sites, every kind of cell (default,
 * exception, draft, off, closed day, absence, overtime, limits warn and block, after the last day, no shift), saving and
 * refused cells, "Why this warning", the pop-ups (Assign → review → done, Default shift, Copy last week with conflicts,
 * Publish, Request overtime with its checks, a request at each stage), the overtime list, and the page's states. Roles: HR
 * (every roster), the production manager, the floor supervisor (their team; overtime asked, not approved), read-only.
 */

const ADDRESS: ShiftsAddress = { span: 'week', from: null, to: null, lineId: null, teamId: null, open: null, isNew: false }
const LINES = [LINE_A_REF, LINE_B_REF]
const TEAMS = [TEAM_A, TEAM_B]

const mine = (role: PeopleRole) => shiftsCan(PEOPLE_ROLES[role])

interface ShiftsCase {
  role: PeopleRole
  model: ShiftsModel
}

function shifts(role: PeopleRole = 'hr', over: Partial<ShiftsModel> = {}): ShiftsCase {
  const roster = over.roster ?? { status: 'ready' as const, value: DEMO_ROSTER }
  const value = roster.status === 'ready' ? roster.value : null
  const rows = value ? sheetRowsOf(value) : []
  const range = over.range ?? RANGE
  const summary = draftsOf(value?.rows ?? [])
  return {
    role,
    model: {
      prefix: PREFIX,
      can: mine(role),
      address: ADDRESS,
      range,
      today: TODAY,
      scope: SCOPE_ONE,
      sight: SIGHT_OFF,
      roster,
      rows,
      dates: datesOf(range),
      choices: value?.choices ?? [],
      lines: LINES,
      teams: TEAMS,
      marks: {},
      save: { kind: 'idle' },
      canRetry: false,
      canUndo: false,
      canRedo: false,
      drafts: { ...summary, people: summary.drafts > 0 ? 2 : 0 },
      elsewhere: null,
      notice: null,
      asOf: '2026-11-02T09:42:00.000Z',
      live: 'live',
      picked: [],
      requests: { items: REQUESTS, problem: null },
      selectedRequests: [],
      request: null,
      dialog: null,
      help: false,
      ...over,
    },
  }
}

const PEOPLE_PICKED = personRows(sheetRowsOf(DEMO_ROSTER)).slice(0, 3).map((row) => ({ id: row.row.employeeId, name: row.row.name, defaultPattern: row.row.defaultPattern }))
const assign = (over: Partial<AssignDraft> = {}): AssignDraft => ({ people: PEOPLE_PICKED, leftOut: 0, from: RANGE.from, to: RANGE.to, mode: 'days', option: optionOf(AFTERNOON), weekdays: [1, 2, 3, 4, 5, 6, 7], closedToo: false, busy: false, problem: null, ...over })
const overtime = (over: Partial<OvertimeDraft> = {}): OvertimeDraft => ({
  siteId: SCOPE_ONE.siteId,
  date: '2026-11-05',
  lineId: LINE_A_REF.id,
  start: '14:00',
  hours: '2',
  reason: 'Consegna giacche invernali (esempio)',
  picked: [PEOPLE.giulia.id, PEOPLE.paolo.id, PEOPLE.ion.id],
  checks: {
    [PEOPLE.giulia.id]: { employeeId: PEOPLE.giulia.id, name: PEOPLE.giulia.name, displayName: PEOPLE.giulia.displayName, checks: [] },
    [PEOPLE.paolo.id]: { employeeId: PEOPLE.paolo.id, name: PEOPLE.paolo.name, displayName: PEOPLE.paolo.displayName, checks: [REST_WARNING] },
    [PEOPLE.ion.id]: { employeeId: PEOPLE.ion.id, name: PEOPLE.ion.name, displayName: PEOPLE.ion.displayName, checks: [CAP_WARNING] },
  },
  checking: false,
  busy: false,
  problem: null,
  tried: false,
  ...over,
})
const toned = cellId(DEMO_ROWS[0]!.employeeId, '2026-11-04')
const blocked = cellId(DEMO_ROWS[3]!.employeeId, '2026-11-05')
const ready = (record: ReturnType<typeof recordOf>, over: Partial<Extract<NonNullable<ShiftsModel['request']>, { status: 'ready' }>> = {}): ShiftsModel['request'] => ({ status: 'ready', record, busy: false, problem: null, cancelling: null, picking: null, ...over })
const copyWeeks = { week: '2026-11-02', source: { from: '2026-10-26', to: '2026-11-01' }, target: { from: '2026-11-02', to: '2026-11-08' } }
const allSites = rosterOf(RANGE, [...DEMO_ROWS, SOUTH_ROW])
const readOnly = rosterOf(RANGE, DEMO_ROWS.map((row) => ({ ...row, canEdit: false })), { canEdit: 'NONE' })
const leadOnly = rosterOf(RANGE, DEMO_ROWS.map((row, index) => ({ ...row, canEdit: index < 3 })), { canEdit: 'TEAM' })
const noAbsences = { ...DEMO_ROSTER, sites: DEMO_ROSTER.sites.map((site) => ({ ...site, absences: { shown: false } })), rows: DEMO_ROWS.map((row) => ({ ...row, cells: row.cells.map((cell) => ({ ...cell, absence: null })) })) }

function ShiftsDesign({ model: { role, model } }: { model: ShiftsCase }) {
  return inShell('/people/shifts', createElement(ShiftsView, { model }), role)
}

export const designScreen = defineDesignScreen<ShiftsCase>({
  screen: 'SCR-263',
  title: 'Shifts (the roster sheet and overtime requests)',
  view: ShiftsDesign,
  cases: [
    { id: 'week', label: 'HR: a week, every kind of cell', model: shifts(), note: 'Type M / A / D / O in a cell; Delete back to the default; drag the fill handle across days; ⌘Z undoes. Tick people for Assign.' },
    { id: 'month', label: 'A month: letters in narrow columns', model: shifts('hr', { range: MONTH, roster: { status: 'ready', value: MONTH_ROSTER }, address: { ...ADDRESS, span: 'month' } }) },
    { id: 'custom', label: 'A range picked by hand (10 days)', model: shifts('hr', { range: { from: '2026-11-02', to: '2026-11-11', custom: true }, roster: { status: 'ready', value: rosterOf({ from: '2026-11-02', to: '2026-11-11', custom: true }, rosterRows(datesOf({ from: '2026-11-02', to: '2026-11-11' }))) } }) },
    { id: 'line', label: 'Filtered to one line', model: shifts('hr', { address: { ...ADDRESS, lineId: LINE_A_REF.id }, roster: { status: 'ready', value: rosterOf(RANGE, DEMO_ROWS.slice(0, 3)) } }) },
    { id: 'all-sites', label: 'All sites: Site column and chip', model: shifts('hr', { scope: SCOPE_ALL, sight: { status: 'allSites' }, roster: { status: 'ready', value: allSites }, lines: [...LINES, LINE_S_REF] }) },
    { id: 'why', label: 'Why this warning (toned cell)', model: shifts('hr', { whyOpen: toned }) },
    { id: 'why-block', label: 'Why this warning: a limit that holds', model: shifts('hr', { whyOpen: blocked }) },
    { id: 'saving', label: 'A cell saving, a cell saved', model: shifts('hr', { marks: { [cellId(DEMO_ROWS[1]!.employeeId, '2026-11-03')]: { state: 'saving' }, [cellId(DEMO_ROWS[1]!.employeeId, '2026-11-04')]: { state: 'saved' } }, save: { kind: 'saving' } }) },
    { id: 'refused', label: 'A cell refused, the reason in the notice', model: shifts('hr', { marks: { [cellId(DEMO_ROWS[2]!.employeeId, '2026-11-03')]: { state: 'refused', reason: 'Attendance of this month is closed.' } }, save: { kind: 'failed', count: 1 }, notice: { tone: 'danger', words: { key: 'refusal.MONTH_CLOSED' } } }) },
    { id: 'unsent', label: 'A write that never arrived: Retry', model: shifts('hr', { marks: { [cellId(DEMO_ROWS[2]!.employeeId, '2026-11-03')]: { state: 'unknown', reason: 'No answer.' } }, save: { kind: 'failed', count: 1 }, canRetry: true }) },
    { id: 'undo', label: 'Saved, undo and redo ready', model: shifts('hr', { save: { kind: 'saved', at: '2026-11-02T09:42:00.000Z' }, canUndo: true, canRedo: true }) },
    { id: 'elsewhere', label: 'A colleague changed cells', model: shifts('hr', { elsewhere: { cells: 3, at: '2026-11-02T09:40:00.000Z' } }) },
    { id: 'people', label: 'People ticked: Assign to N, Overtime for N', model: shifts('hr', { picked: PEOPLE_PICKED.map((person) => person.id) }) },
    { id: 'assign', label: 'Assign shifts: only these days', model: shifts('hr', { dialog: { kind: 'assign', draft: assign() } }) },
    { id: 'assign-empty', label: 'Assign shifts: held until a shift is chosen', model: shifts('hr', { dialog: { kind: 'assign', draft: assign({ option: '', leftOut: 2 }) } }) },
    { id: 'assign-default', label: 'Assign shifts: the default shift', model: shifts('hr', { dialog: { kind: 'assign', draft: assign({ mode: 'default', option: AFTERNOON.patternId }) } }) },
    { id: 'assign-review', label: 'Assign: the cells that change, conflicts, a warning', model: shifts('hr', { dialog: { kind: 'assign-review', draft: assign(), preview: PREVIEW, review: { phase: 'ready' } } }) },
    { id: 'assign-blocked', label: 'Assign: a limit holds it', model: shifts('hr', { dialog: { kind: 'assign-review', draft: assign(), preview: { ...PREVIEW, blocked: 1 }, review: { phase: 'ready' } } }) },
    { id: 'assign-done', label: 'Assign: done, with Undo', model: shifts('hr', { dialog: { kind: 'assign-review', draft: assign(), preview: PREVIEW, review: { phase: 'done', changed: 3, skipped: 2 } } }) },
    { id: 'default-review', label: 'Default shift: the review', model: shifts('hr', { dialog: { kind: 'default-review', draft: assign({ mode: 'default', option: AFTERNOON.patternId }), review: { phase: 'ready' }, refused: [] } }) },
    { id: 'copy', label: 'Copy last week: cells and conflicts', model: shifts('hr', { dialog: { kind: 'copy', ...copyWeeks, preview: PREVIEW, review: { phase: 'ready' } } }) },
    { id: 'copy-reading', label: 'Copy last week: reading', model: shifts('hr', { dialog: { kind: 'copy', ...copyWeeks, preview: null, review: { phase: 'reading' } } }) },
    { id: 'copy-nothing', label: 'Copy last week: nothing to copy', model: shifts('hr', { dialog: { kind: 'copy', ...copyWeeks, preview: { ...PREVIEW, changes: [], skipped: [], warnings: [] }, review: { phase: 'ready' } } }) },
    { id: 'publish', label: 'Publish the drafts', model: shifts('hr', { dialog: { kind: 'publish', drafts: 2, people: 2, busy: false, problem: null } }) },
    { id: 'overtime', label: 'Request overtime: each person checked', model: shifts('hr', { dialog: { kind: 'overtime', draft: overtime() } }) },
    { id: 'overtime-empty', label: 'Request overtime: what is missing', model: shifts('hr', { dialog: { kind: 'overtime', draft: overtime({ reason: '', hours: '', picked: [], checks: null, tried: true }) } }) },
    { id: 'overtime-block', label: 'Request overtime: a limit holds', model: shifts('hr', { dialog: { kind: 'overtime', draft: overtime({ tried: true, checks: { [PEOPLE.giulia.id]: { employeeId: PEOPLE.giulia.id, name: PEOPLE.giulia.name, displayName: PEOPLE.giulia.displayName, checks: [{ ...REST_WARNING, level: 'BLOCK' }] } } }) } }) },
    { id: 'overtime-sites', label: 'Request overtime: All sites asks for a site', model: shifts('hr', { scope: SCOPE_ALL, dialog: { kind: 'overtime', draft: overtime({ siteId: null, checks: null }) } }) },
    { id: 'request-agreed', label: 'A request somebody agreed to: Approve', model: shifts('hr', { request: ready(recordOf(REQUESTS[1]!)) }) },
    { id: 'request-asked', label: 'A request nobody answered: Approve held', model: shifts('hr', { request: ready(recordOf(REQUESTS[2]!, { people: recordOf(REQUESTS[2]!).people.map((person) => ({ ...person, answer: 'PENDING', answeredAt: null, via: null })) })) }) },
    { id: 'request-draft', label: 'A draft: Ask 2 people', model: shifts('hr', { request: ready(recordOf(REQUESTS[3]!)) }) },
    { id: 'request-approved', label: 'Approved: the note for Attendance', model: shifts('hr', { request: ready(recordOf(REQUESTS[0]!)) }) },
    { id: 'request-cancelled', label: 'Cancelled, with the reason', model: shifts('hr', { request: ready(recordOf(REQUESTS[4]!)) }) },
    { id: 'request-cancelling', label: 'Cancel: the reason', model: shifts('hr', { request: ready(recordOf(REQUESTS[1]!), { cancelling: { reason: '' } }) }) },
    { id: 'request-adding', label: 'Add people', model: shifts('hr', { request: ready(recordOf(REQUESTS[1]!), { picking: { ids: [] } }) }) },
    { id: 'request-refused', label: 'A refusal in words', model: shifts('hr', { request: ready(recordOf(REQUESTS[1]!), { problem: 'refusal.NOT_APPROVE' }) }) },
    { id: 'request-loading', label: 'A request: reading', model: shifts('hr', { request: { status: 'loading', id: 'x' } }) },
    { id: 'request-error', label: "A request: couldn't be read", model: shifts('hr', { request: { status: 'error', id: 'x', problem: 'problem.notFound' } }) },
    { id: 'requests-selected', label: 'Requests ticked: Approve N, Ask N', model: shifts('hr', { selectedRequests: [REQUESTS[1]!.id, REQUESTS[3]!.id] }) },
    { id: 'requests-empty', label: 'No overtime requested', model: shifts('hr', { requests: { items: [], problem: null } }) },
    { id: 'requests-error', label: "Requests couldn't be read", model: shifts('hr', { requests: { items: null, problem: 'problem.unavailable' } }) },
    { id: 'production', label: 'Production manager: every roster, approves', model: shifts('production') },
    { id: 'supervisor', label: 'Floor supervisor: edits their team, asks, no Approve', model: shifts('supervisor', { roster: { status: 'ready', value: leadOnly }, request: ready(recordOf(REQUESTS[1]!, { canApprove: false })) }) },
    { id: 'read-only', label: 'Read-only: the sheet as text, no verbs', model: shifts('readOnly', { roster: { status: 'ready', value: readOnly } }) },
    { id: 'no-absences', label: 'Absences not shown: the gate is closed', model: shifts('hr', { roster: { status: 'ready', value: noAbsences } }) },
    { id: 'keys', label: 'Keyboard shortcuts', model: shifts('hr', { help: true }) },
    { id: 'loading', label: 'Loading', model: shifts('hr', { roster: { status: 'loading' }, requests: { items: null, problem: null } }) },
    { id: 'error', label: "The roster couldn't be read", model: shifts('hr', { roster: { status: 'error', problem: 'problem.unavailable' } }) },
    { id: 'too-many', label: 'Too many people: narrow it', model: shifts('hr', { roster: { status: 'error', problem: 'problem.tooMany' } }) },
    { id: 'no-patterns', label: 'No shift patterns yet', model: shifts('hr', { roster: { status: 'ready', value: { ...DEMO_ROSTER, choices: [] } } }) },
    { id: 'nobody', label: 'Nobody in this view', model: shifts('hr', { roster: { status: 'ready', value: rosterOf(RANGE, []) } }) },
    { id: 'no-permission', label: 'No permission', model: shifts('sales', { roster: { status: 'loading' }, requests: { items: null, problem: null } }) },
  ],
})
