import { describe, expect, it } from 'vitest'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { eachDay } from '@nexus/factory-domain/calendars/dates'
import { OVERTIME_ACTIONS, OVERTIME_STATUSES } from '@nexus/factory-domain/people/shifts/rules'
import { LIMIT_KINDS } from '@nexus/factory-domain/people/shifts/limits'
import { createApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES, recordAddress } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { approveRequest, applyAssign, askRequest, createRequest, readRoster, writeCells, type LimitWarning } from './api'
import { designScreen } from './fixtures'
import { AFTERNOON, CHOICES, DEMO_ROSTER, DEMO_ROWS, MORNING, PREVIEW, RANGE, REQUESTS, REST_WARNING, WEEK_WARNING, CAP_WARNING } from './demo/fixtures'
import {
  bulkOfRequests,
  cellHeld,
  cellsOfRange,
  checksWords,
  choiceText,
  clockFull,
  clockShort,
  copyWeeks,
  datesOf,
  draftsOf,
  echoOf,
  filterOptions,
  heldCells,
  holds,
  hoursWords,
  minuteOfClock,
  movedRange,
  optionOf,
  optionOfCell,
  overtimeHeld,
  overtimeOfCell,
  ownWriteOf,
  paperCell,
  paperLines,
  pickOf,
  piecesOf,
  planOf,
  plannedOfPreview,
  problemOf,
  rangeOf,
  refusalOf,
  replayOf,
  requestSelectable,
  rosterCsvRows,
  setOfCell,
  setOfEdit,
  setOfKey,
  setOfOption,
  setOfValue,
  sheetIndex,
  sheetRowsOf,
  shiftLetter,
  shiftsAddressOf,
  shiftsAddressText,
  shiftsCan,
  SHIFT_REFUSALS,
  toneOf,
  warningWords,
  windowClock,
  writesOf,
} from './model'

const params = (text: string) => new URLSearchParams(text)
const rows = sheetRowsOf(DEMO_ROSTER)
const index = sheetIndex(rows)
const giulia = DEMO_ROWS[0]!
const paolo = DEMO_ROWS[1]!
const marta = DEMO_ROWS[5]!

describe('the address and its range', () => {
  it('reads and writes the terms, defaults left out, other terms kept', () => {
    const address = shiftsAddressOf(params('span=month&from=2026-11-10&line=l1&team=t1&open=r1&print=1'))
    expect(address).toEqual({ span: 'month', from: '2026-11-10', to: null, lineId: 'l1', teamId: 't1', open: 'r1', isNew: false })
    expect(shiftsAddressText(address, params('print=1'))).toBe('?print=1&span=month&from=2026-11-10&line=l1&team=t1&open=r1')
    expect(shiftsAddressText(shiftsAddressOf(params('')))).toBe('')
    expect(shiftsAddressOf(params('from=not-a-day')).from).toBeNull()
  })

  it('a week runs from its Monday, a month from the first to the last, a picked range keeps to 42 days', () => {
    expect(rangeOf({ span: 'week', from: '2026-11-05', to: null }, '2026-11-02')).toEqual({ from: '2026-11-02', to: '2026-11-08', custom: false })
    expect(rangeOf({ span: 'week', from: null, to: null }, '2026-11-08')).toEqual({ from: '2026-11-02', to: '2026-11-08', custom: false })
    expect(rangeOf({ span: 'month', from: '2026-02-14', to: null }, '2026-11-02')).toEqual({ from: '2026-02-01', to: '2026-02-28', custom: false })
    expect(rangeOf({ span: 'week', from: '2026-11-01', to: '2027-03-01' }, '2026-11-02')).toEqual({ from: '2026-11-01', to: '2026-12-12', custom: true })
  })

  it('[ and ] move a week, a month, or a picked range by its own length', () => {
    const week = rangeOf({ span: 'week', from: '2026-11-02', to: null }, '2026-11-02')
    expect(movedRange({ span: 'week' }, week, 1)).toEqual({ from: '2026-11-09', to: null })
    const january = rangeOf({ span: 'month', from: '2026-01-10', to: null }, '2026-11-02')
    expect(movedRange({ span: 'month' }, january, -1)).toEqual({ from: '2025-12-01', to: null })
    expect(movedRange({ span: 'week' }, { from: '2026-11-02', to: '2026-11-11', custom: true }, 1)).toEqual({ from: '2026-11-12', to: '2026-11-21' })
  })

  it('Copy last week fills the week in view, or the first whole week of a month', () => {
    expect(copyWeeks({ from: '2026-11-02' })).toEqual({ week: '2026-11-02', source: { from: '2026-10-26', to: '2026-11-01' }, target: { from: '2026-11-02', to: '2026-11-08' } })
    expect(copyWeeks({ from: '2026-11-01' }).week).toBe('2026-11-02')
  })
})

describe('a shift in words', () => {
  it('clocks, a night shift past midnight, hours', () => {
    expect(clockFull(360)).toBe('06:00')
    expect(clockFull(1800)).toBe('06:00')
    expect(clockShort(390)).toBe('06:30')
    expect(windowClock({ startMinute: 1320, endMinute: 1800 })).toBe('22–06')
    expect(hoursWords(45)).toBe('45 min')
    expect(hoursWords(120)).toBe('2 h')
    expect(hoursWords(570)).toBe('9 h 30 min')
    expect(choiceText(MORNING)).toBe('Morning 06–14')
  })

  it('a letter: the choice\'s key, else the first letter of its name', () => {
    expect(shiftLetter(MORNING, CHOICES)).toBe('M')
    expect(shiftLetter({ label: 'Notte', startMinute: 1320, endMinute: 1800 }, CHOICES)).toBe('N')
    expect(shiftLetter({ label: null, startMinute: 1, endMinute: 2 }, CHOICES)).toBe('•')
  })
})

describe('the sheet', () => {
  it('groups line › team › person with a foot row closing each line, in the API\'s order', () => {
    expect(rows.map((row) => row.kind)).toEqual(['line', 'team', 'person', 'person', 'person', 'foot', 'line', 'team', 'person', 'person', 'person', 'foot', 'line', 'person', 'foot'])
    const foot = rows.find((row) => row.kind === 'foot')
    expect(foot?.kind === 'foot' && foot.days['2026-11-02']?.shifts[0]).toEqual({ label: 'Morning', startMinute: 360, endMinute: 840, people: 3 })
  })

  it('keeps the filter\'s lines and teams when a read is narrowed', () => {
    const all = filterOptions(DEMO_ROWS, { lines: [], teams: [] })
    expect(filterOptions(DEMO_ROWS.slice(0, 1), all).lines).toHaveLength(2)
    expect(all.teams.map((team) => team.code)).toEqual(['T-A1', 'T-B1'])
  })

  it('a range covers people only: group and foot rows are left out', () => {
    const cells = cellsOfRange(rows, { startRow: 1, endRow: 5, dates: ['2026-11-02', '2026-11-03'] })
    expect(cells).toHaveLength(6)
    expect(pickOf(cells)).toEqual({ employeeIds: [DEMO_ROWS[0]!.employeeId, DEMO_ROWS[1]!.employeeId, DEMO_ROWS[2]!.employeeId], from: '2026-11-02', to: '2026-11-03' })
  })
})

describe('what a key, the fill handle or Set shift writes', () => {
  it('a letter is a choice\'s key, O a day off, any other letter nothing', () => {
    expect(setOfKey('a', CHOICES)).toEqual({ kind: 'WORK', patternId: AFTERNOON.patternId, label: 'Afternoon', startMinute: 840 })
    expect(setOfKey('o', CHOICES)).toEqual({ kind: 'OFF' })
    expect(setOfKey('z', CHOICES)).toBeUndefined()
  })

  it('the cell\'s list, the fill handle\'s source cell, a paste', () => {
    expect(setOfOption('default', CHOICES)).toBeNull()
    expect(setOfOption('off', CHOICES)).toEqual({ kind: 'OFF' })
    expect(setOfOption(optionOf(AFTERNOON), CHOICES)).toMatchObject({ label: 'Afternoon' })
    // A faint default filled across days writes that shift.
    expect(setOfEdit(giulia.cells[0], CHOICES)).toMatchObject({ kind: 'WORK', label: 'Morning' })
    expect(setOfEdit('A', CHOICES)).toMatchObject({ label: 'Afternoon' })
    expect(setOfEdit('Afternoon 14–22', CHOICES)).toMatchObject({ label: 'Afternoon' })
    expect(setOfEdit('nonsense', CHOICES)).toBeUndefined()
    expect(setOfEdit(12, CHOICES)).toBeUndefined()
  })

  it('a typed window is copied as typed', () => {
    const value = { kind: 'WORK' as const, patternId: null, shift: { label: 'Extra', startMinute: 600, endMinute: 900, breakMinutes: 15 } }
    expect(setOfValue(value)).toEqual({ kind: 'WORK', patternId: null, label: 'Extra', startMinute: 600, endMinute: 900, breakMinutes: 15 })
    expect(holds({ source: 'ROSTER', value }, setOfValue(value))).toBe(true)
    expect(holds({ source: 'ROSTER', value }, { kind: 'WORK', patternId: null, label: 'Extra', startMinute: 600, endMinute: 960, breakMinutes: 15 })).toBe(false)
  })

  it('a cell that already says it is not written; going back to the default on a default cell neither', () => {
    const cell = paolo.cells[0]!
    expect(holds(cell, null)).toBe(true)
    expect(holds(cell, setOfKey('M', CHOICES)!)).toBe(false) // A default never "holds" a roster value: pinning it writes a row.
    expect(setOfCell(cell)).toBeNull()
  })

  it('plans the cells that change, each once, and says why the others stay', () => {
    const date = '2026-11-03'
    const cells = [{ employeeId: paolo.employeeId, date }, { employeeId: paolo.employeeId, date }, { employeeId: giulia.employeeId, date }]
    const plan = planOf(index, cells, setOfKey('A', CHOICES)!)
    // Giulia's Tuesday already says Afternoon.
    expect(plan.changes).toHaveLength(1)
    expect(plan.changes[0]).toMatchObject({ employeeId: paolo.employeeId, before: null })
    expect(writesOf(plan.changes, index)).toEqual([{ employeeId: paolo.employeeId, date, version: null, set: setOfKey('A', CHOICES) }])
  })

  it('holds a person you do not plan, and a shift after the last working day; clearing it stays allowed', () => {
    expect(cellHeld({ canEdit: false }, { issue: null }, { kind: 'OFF' })).toBe('held.noEdit')
    const after = { employeeId: marta.employeeId, date: '2026-11-06' }
    expect(planOf(index, [after], setOfKey('M', CHOICES)!).held).toEqual([{ ...after, why: 'held.afterLastDay' }])
    expect(cellHeld(marta, { issue: 'AFTER_LAST_DAY' }, null)).toBeNull()
    expect(cellHeld(marta, { issue: 'AFTER_LAST_DAY' }, { kind: 'OFF' })).toBeNull()
  })

  it('sends a roster row\'s version, and many cells in pieces of the API\'s limit', () => {
    const date = '2026-11-03'
    const plan = planOf(index, [{ employeeId: giulia.employeeId, date }], null)
    expect(writesOf(plan.changes, index)[0]).toMatchObject({ version: 1, set: null })
    expect(piecesOf(Array.from({ length: 450 }, (_, at) => at)).map((piece) => piece.length)).toEqual([200, 200, 50])
  })

  it('undo puts a cell back only while it still holds what our edit wrote; a colleague\'s change stays', () => {
    const date = '2026-11-03'
    const batch = [
      { employeeId: giulia.employeeId, date, before: null, after: setOfKey('A', CHOICES)! },
      { employeeId: paolo.employeeId, date, before: null, after: setOfKey('A', CHOICES)! },
    ]
    const undone = replayOf(batch, 'undo', index)
    expect(undone.kept).toBe(1) // Paolo's cell no longer says Afternoon.
    expect(undone.changes).toEqual([{ employeeId: giulia.employeeId, date, before: setOfKey('A', CHOICES), after: null }])
    const redone = replayOf(batch, 'redo', index)
    expect(redone.changes).toHaveLength(1)
    expect(redone.changes[0]?.employeeId).toBe(paolo.employeeId)
  })

  it('an assignment\'s preview is an edit too, so ⌘Z takes it back', () => {
    const batch = plannedOfPreview(PREVIEW)
    expect(batch).toHaveLength(3)
    expect(batch[0]).toMatchObject({ before: null, after: { label: 'Afternoon' } })
  })

  it('a phone\'s select shows the cell\'s option', () => {
    expect(optionOfCell(paolo.cells[0]!)).toBe('default')
    expect(optionOfCell({ source: 'ROSTER', value: { kind: 'OFF', shift: null, patternId: null } })).toBe('off')
    expect(optionOfCell(giulia.cells[1]!)).toBe(optionOf(AFTERNOON))
  })
})

describe('live', () => {
  it('knows the echo of our own write from a colleague\'s, however late the relay is', () => {
    const write = ownWriteOf([{ employeeId: 'e', date: '2026-11-04' }, { employeeId: 'e', date: '2026-11-02' }], 1000)!
    expect(write).toEqual({ from: '2026-11-02', to: '2026-11-04', at: 1000 })
    const echo = echoOf([write], '2026-11-02', '2026-11-04', 21_000, 60_000)
    expect(echo).toEqual({ own: [], mine: true })
    // The same days again: this one is somebody else's.
    expect(echoOf(echo.own, '2026-11-02', '2026-11-04', 22_000, 60_000).mine).toBe(false)
    expect(echoOf([write], '2026-11-03', '2026-11-03', 2000, 60_000)).toEqual({ own: [write], mine: false })
    expect(echoOf([write], '2026-11-02', '2026-11-04', 90_000, 60_000)).toEqual({ own: [], mine: false })
    expect(ownWriteOf([], 1)).toBeNull()
  })
})

describe('publish', () => {
  it('counts the drafts this person may publish, and those a limit holds', () => {
    expect(draftsOf(DEMO_ROSTER.rows)).toEqual({ drafts: 2, blocked: 1 })
    expect(draftsOf(DEMO_ROSTER.rows.map((row) => ({ ...row, canEdit: false })))).toEqual({ drafts: 0, blocked: 0 })
  })
})

describe('warnings in our words', () => {
  const words = (warning: LimitWarning, locale: 'it' | 'en') => {
    const said = warningWords(warning, locale)
    return createTranslator(locale, messagesFor(locale, ['shifts']).shifts ?? {})(said.key, said.params)
  }

  it('says each rule from its figures, in both languages, the law apart', () => {
    expect(words(REST_WARNING, 'en')).toBe('Rest 8 h between 22:00 (3 Nov) and 06:00 — minimum 11 h')
    expect(words(REST_WARNING, 'it')).toBe('Riposo di 8 h tra le 22:00 (3 nov) e le 06:00 — minimo 11 h')
    expect(words(WEEK_WARNING, 'en')).toContain('53 h planned in the week of 2 Nov; 49 h a week on average over 4 weeks')
    expect(words(CAP_WARNING, 'it')).toContain('252 h')
    expect(words({ ...REST_WARNING, values: { spanMinutes: 840, limitMinutes: 660, from: '06:00', to: '20:00' } }, 'en')).toContain('A working day of 14 h (06:00–20:00)')
    expect(words({ ...REST_WARNING, rule: 'BREAK_AFTER', values: { workMinutes: 420, breakMinutes: 0, neededMinutes: 10, limitMinutes: 360, from: '06:00', to: '13:00' } }, 'en')).toContain('7 h of work')
  })

  it('the tone is the worst one', () => {
    expect(toneOf([])).toBe('none')
    expect(toneOf([{ level: 'WARN' }])).toBe('warn')
    expect(toneOf([{ level: 'WARN' }, { level: 'BLOCK' }])).toBe('block')
  })

  it('has a plain sentence for each rule\'s law', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['shifts']).shifts ?? {})
      for (const rule of LIMIT_KINDS) expect(t(`law.${rule}`)).not.toBe(`law.${rule}`)
    }
  })
})

describe('overtime', () => {
  const fact = (status: (typeof OVERTIME_STATUSES)[number], agreed = 0, asked = 2) => ({ status, stage: status, counts: { asked, agreed, declined: 0, pending: asked - agreed } })

  it('never approves without a yes (D.Lgs. 66/2003 art. 5), and says why', () => {
    expect(overtimeHeld('APPROVE', fact('ASKED', 0))).toBe('held.nobodyAgreed')
    expect(overtimeHeld('APPROVE', fact('ASKED', 1))).toBeNull()
    expect(overtimeHeld('APPROVE', fact('DRAFT'))).toBe('held.notAsked')
    expect(overtimeHeld('APPROVE', fact('APPROVED', 1))).toBe('held.alreadyApproved')
    expect(overtimeHeld('ASK', fact('DRAFT', 0, 0))).toBe('held.noPeople')
    expect(overtimeHeld('ASK', fact('DRAFT'))).toBeNull()
    expect(overtimeHeld('ANSWER', fact('APPROVED', 1))).toBe('held.requestApproved')
    expect(overtimeHeld('ADD_PEOPLE', fact('CANCELLED'))).toBe('held.requestCancelled')
  })

  it('has words for every verb held at every status', () => {
    const t = createTranslator('en', messagesFor('en', ['shifts']).shifts ?? {})
    for (const status of OVERTIME_STATUSES) {
      for (const action of OVERTIME_ACTIONS) {
        const key = overtimeHeld(action, fact(status))
        if (key) expect(t(key)).not.toBe(key)
      }
    }
  })

  it('bulk verbs: Ask the drafts, Approve what somebody agreed to, by right', () => {
    expect(bulkOfRequests(REQUESTS, { overtime: true, approve: true }).ask.map((row) => row.status)).toEqual(['DRAFT'])
    expect(bulkOfRequests(REQUESTS, { overtime: true, approve: true }).approve.map((row) => row.stage)).toEqual(['AGREED'])
    expect(bulkOfRequests(REQUESTS, { overtime: true, approve: false }).approve).toEqual([])
    expect(requestSelectable(REQUESTS[4]!)).toBe(false)
    expect(requestSelectable(REQUESTS[3]!)).toBe(true)
  })

  it('a cell shows what is asked or agreed, a declined answer left out', () => {
    const item = { requestId: 'r', agreementId: 'a', startMinute: null, minutes: 120, stage: 'ASKED' as const, answer: 'PENDING' as const }
    expect(overtimeOfCell([])).toBeNull()
    expect(overtimeOfCell([item, { ...item, minutes: 60, answer: 'DECLINED' }])).toEqual({ minutes: 120, approved: false })
    expect(overtimeOfCell([{ ...item, stage: 'APPROVED', answer: 'AGREED' }])).toEqual({ minutes: 120, approved: true })
    expect(overtimeOfCell([{ ...item, stage: 'CANCELLED' }])).toBeNull()
  })

  it('the list counts people a limit touches, never names them', () => {
    expect(checksWords({ warn: 0, block: 0 })).toBeNull()
    expect(checksWords({ warn: 2, block: 0 })).toEqual({ key: 'ot.checks.warn', params: { count: 2 } })
    expect(checksWords({ warn: 2, block: 1 })).toEqual({ key: 'ot.checks.block', params: { count: 1 } })
  })

  it('reads a typed start', () => {
    expect(minuteOfClock('')).toBeNull()
    expect(minuteOfClock('18:30')).toBe(1110)
    expect(minuteOfClock('25:00')).toBeUndefined()
    expect(minuteOfClock('18')).toBeUndefined()
  })
})

describe('refusals', () => {
  const refused = (code: string, more: Array<{ path: string }> = []) => new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: `refusal/${code}` }, ...more])

  it('says every refusal of the API by its code', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['shifts']).shifts ?? {})
      for (const code of SHIFT_REFUSALS) expect(t(`refusal.${code}`)).not.toBe(`refusal.${code}`)
    }
    expect(refusalOf(refused('MONTH_CLOSED'))).toBe('MONTH_CLOSED')
    expect(problemOf(refused('LAST_YES'))).toEqual({ key: 'refusal.LAST_YES' })
    expect(problemOf(new ApiError('conflict', 409, 'conflict', 'x'))).toEqual({ key: 'problem.conflict' })
    expect(problemOf(new Error('x'))).toEqual({ key: 'problem.unavailable' })
  })

  it('finds the cells a blocking limit held', () => {
    const error = refused('LIMIT_BLOCKED', [{ path: 'limits/e1/2026-11-03' }])
    expect(heldCells(error)).toEqual([{ employeeId: 'e1', date: '2026-11-03' }])
  })
})

describe('paper and CSV: a shift and the day off, nothing else', () => {
  it('a page per line, no overtime, absence or warning', () => {
    const lines = paperLines(rows)
    expect(lines).toHaveLength(3)
    expect(lines[0]?.people).toHaveLength(3)
    expect(lines[0]?.line?.code).toBe('L-A')
    const sara = DEMO_ROWS[2]!
    const absent = sara.cells.find((cell) => cell.absence?.kind === 'ABSENT')!
    expect(paperCell(absent, 'Off')).toBe('Morning 06–14')
    expect(paperCell(undefined, 'Off')).toBe('')
  })

  it('the CSV has a column per day', () => {
    const dates = datesOf(RANGE)
    const csv = rosterCsvRows(rows, dates, 'Off')
    expect(csv[0]).toHaveLength(4 + dates.length)
    expect(csv[0]?.slice(0, 4)).toEqual(['STAB-N', 'L-A', 'T-A1', giulia.name])
    expect(csv[0]?.[10]).toBe('Off')
  })
})

describe('rights', () => {
  const can = (key: string) => shiftsCan(templateOf(key)?.permissions ?? [])

  it('follow the role templates', () => {
    expect(can('admin')).toMatchObject({ view: true, manage: true, overtime: true, approve: true })
    expect(can('production_manager')).toMatchObject({ view: true, manage: true, approve: true })
    expect(can('floor_supervisor')).toMatchObject({ view: true, manage: false, team: true, overtime: true, approve: false })
    expect(can('read_only')).toMatchObject({ view: true, manage: false, team: false, overtime: false, approve: false })
    expect(can('sales').view).toBe(false)
  })
})

describe('calls', () => {
  function recorder() {
    const calls: Array<{ method: string; path: string; body: unknown; key: string | null }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ method: init?.method ?? 'GET', path: url, body: init?.body ? JSON.parse(String(init.body)) : null, key: new Headers(init?.headers).get('idempotency-key') })
      return new Response(JSON.stringify({ cells: [], warnings: 0, changed: 0, people: 0, skipped: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    return { calls, api: createApiClient({ baseUrl: '/api', fetch: fetcher, company: 'DEMO', csrfToken: () => 'csrf-demo' }) }
  }

  it('reads the roster with the filters set, and writes cells as one command', async () => {
    const { calls, api } = recorder()
    await readRoster(api, { siteId: 's1', from: '2026-11-02', to: '2026-11-08', lineId: null, teamId: 't1' }).catch(() => undefined)
    expect(calls[0]?.path).toContain('/people/shifts/roster?')
    expect(calls[0]?.path).toContain('teamId=t1')
    expect(calls[0]?.path).not.toContain('lineId')
    await writeCells(api, [{ employeeId: 'e1', date: '2026-11-03', version: null, set: { kind: 'OFF' } }], 'key-1').catch(() => undefined)
    expect(calls[1]).toMatchObject({ method: 'POST', key: 'key-1', body: { cells: [{ employeeId: 'e1', date: '2026-11-03', version: null, set: { kind: 'OFF' } }] } })
  })

  it('every other write carries its own key and the version read', async () => {
    const { calls, api } = recorder()
    await applyAssign(api, { employeeIds: ['e1'], from: '2026-11-03', to: '2026-11-04', set: null }).catch(() => undefined)
    await askRequest(api, 'r1', 3).catch(() => undefined)
    await approveRequest(api, 'r1', 4).catch(() => undefined)
    await createRequest(api, { siteId: 's1', lineId: null, date: '2026-11-05', startMinute: null, minutes: 120, reason: 'x', employeeIds: ['e1'], ask: true }).catch(() => undefined)
    expect(calls.map((call) => call.path.replace(/^.*\/people/, '/people'))).toEqual(['/people/shifts/roster/assign', '/people/overtime-requests/r1/ask', '/people/overtime-requests/r1/approve', '/people/overtime-requests'])
    expect(calls.every((call) => !!call.key)).toBe(true)
    expect(calls[1]?.body).toEqual({ version: 3 })
    expect(calls[3]?.body).toMatchObject({ ask: true })
  })
})

describe('the page in the shell', () => {
  it('is built, an overtime request opens on it', () => {
    expect(OFFICE_PAGES.has('/people/shifts')).toBe(true)
    expect(OFFICE_PAGES.has('/people/shifts/print')).toBe(true)
    expect(LIST_PAGES['/people/overtime-requests']).toBe('/people/shifts')
    expect(recordAddress({ type: 'OvertimeRequest', id: 'r1' }, OFFICE_PAGES)).toBe('/people/shifts?open=r1')
  })

  it('has every date of a range in the sheet', () => {
    expect(eachDay(RANGE.from, RANGE.to)).toHaveLength(7)
  })
})

describe('the design cases', () => {
  it('draw in both languages with no key on screen', () => {
    const screen = designScreen as DesignScreen<unknown>
    for (const locale of LOCALES) {
      const messages = messagesFor(locale, ['shifts', 'people', 'lists', 'shell', 'ds-words'])
      for (const entry of screen.cases) {
        const html = renderToString(createElement(I18nProvider, { locale, messages }, createElement(screen.view as ComponentType<{ model: unknown }>, { model: entry.model })))
        expect(html, entry.id).not.toMatch(/\b(cell|sheet|legend|held|ot|band|scope|stage|answer|assign|review|copy|publish|refusal|problem|notice|warn|why)\.[a-zA-Z]+[.A-Za-z]*\b/)
      }
    }
  })
})
