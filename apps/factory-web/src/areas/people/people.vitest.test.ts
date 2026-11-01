import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EMPLOYEE_KINDS, EMPLOYEE_TILES, LIFECYCLES, NEXT_STEPS } from '@nexus/factory-domain/people/employees/rules'
import { LEAVER_STEP_KINDS } from '@nexus/factory-domain/people/leavers/rules'
import { MOVE_CONFLICTS } from '@nexus/factory-domain/people/teams/rules'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { createApiClient, type ApiClient } from '../../lib/api/client'
import { ApiError } from '../../lib/api/errors'
import type { DesignScreen } from '../../lib/design/design-screen'
import { LOCALES } from '../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../lib/i18n/messages'
import { I18nProvider } from '../../lib/i18n/provider'
import { LIST_PAGES, recordAddress } from '../../lib/records/record-links'
import { permissionCheck } from '../../lib/session/session'
import { builtRowsOnly, OFFICE_NAV, OFFICE_PAGES, officeNavFor } from '../../shell/nav/office-nav'
import { applyMoves, createEmployee, createLoan, listEmployees, startLeaving, updateEmployee, whatYouSee } from './_shared/api'
import { EMPLOYEE_LIST, LEAVER, PEOPLE } from './_shared/fixtures'
import {
  activityAction,
  activityChanges,
  ACTIVITY_ACTIONS,
  ACTIVITY_FIELDS,
  csvRowOf,
  csvText,
  currentNotice,
  daysUntil,
  employeesAddressOf,
  employeesAddressText,
  employeesQuery,
  fieldOf,
  hoursText,
  isFiltered,
  minutesOfHours,
  noticeKey,
  peopleCan,
  PEOPLE_REFUSALS,
  problemOf,
  refusalOf,
  ROW_CHOICES,
  stepHref,
  zonedInstant,
} from './_shared/model'
import { LANGUAGES } from './_shared/parts'
import { badgeLayout, badgeSheetHref } from './employees/badges/badge'
import { designScreen as sheetScreen } from './employees/badges/fixtures'
import { designScreen as employeesScreen } from './employees/fixtures'
import { designScreen as printScreen } from './employees/print/fixtures'
import { designScreen as recordScreen } from './employees/record/fixtures'
import { editHeld } from './employees/record/view/EmployeeRecordView'
import { loanHeld, newDraftHeld } from './employees/view/EmployeeDialogs'
import { memberRows } from './employees/view/TeamsPanel'
import { blankNewDraft } from './employees/use-dialogs'
import { officeArea } from './nav'

/**
 * People › Employees (SCR-084, SCR-085 and the badge sheet and staff list prints; B-W2b-55 on the API of B-W2b-26 and
 * B-W2b-27): the People area's navigation (every People page declared once, a row shown only once its page is built),
 * the rights, the address ⇄ the API's own filters, the data notice one at a time, a refusal read from an API error, the
 * small text rules (hours, days, a zoned time, CSV with no pay column), the badge face (never a sign-in code), the calls
 * as the API takes them (Idempotency-Key and the version read on every write), and every design case drawn in Italian
 * and English with no message key or placeholder left on screen.
 */

const template = (key: string) => [...(templateOf(key)?.permissions ?? [])]

describe('people: the area and who may do what', () => {
  it('declares every People page of the tree once, in its groups and order; only built rows show', () => {
    expect(officeArea.order).toBe(11)
    const rows = (officeArea.area.sections ?? []).flatMap((section) => section.items.map((item) => item.href))
    expect(rows).toEqual(['/people/employees', '/people/attendance', '/people/shifts', '/people/skills', '/people/piecerates', '/people/payroll', '/people/efficiency', '/people/reports', '/people/settings'])
    const people = OFFICE_NAV.areas.find((area) => area.id === 'people')!
    expect((people.sections ?? []).flatMap((section) => section.items.map((item) => item.href))).toEqual(['/people/employees'])
    // A page step that adds its address to OFFICE_PAGES makes its row appear by itself.
    const later = builtRowsOnly({ view: 'office', areas: [officeArea.area] }, new Set([...OFFICE_PAGES, '/people/shifts']))
    expect((later.areas[0]!.sections ?? []).flatMap((section) => section.items.map((item) => item.href))).toEqual(['/people/employees', '/people/shifts'])
  })

  it('People sits after Finance and before Plant; HR and the production manager see Employees, sales and a lead-only role do not', () => {
    expect(OFFICE_NAV.areas.map((area) => area.id).slice(-3)).toEqual(['people', 'plant', 'admin'])
    const sees = (key: string) => officeNavFor(permissionCheck(template(key))).areas.some((area) => area.id === 'people')
    expect(sees('admin')).toBe(true)
    expect(sees('production_manager')).toBe(true)
    expect(sees('floor_supervisor')).toBe(true)
    expect(sees('sales')).toBe(false)
    expect(sees('quality_inspector')).toBe(false)
  })

  it('reads the rights by name: the HR register, My team, each manage, imports, the lines and the audit', () => {
    const hr = peopleCan(template('admin'))
    expect([hr.view, hr.manageEmployees, hr.manageTeams, hr.manageLoans, hr.manageLeavers, hr.manageWorkers, hr.audit, hr.sites]).toEqual([true, true, true, true, true, true, true, true])
    const supervisor = peopleCan(template('floor_supervisor'))
    expect([supervisor.view, supervisor.team, supervisor.manageEmployees, supervisor.manageLoans, supervisor.skills, supervisor.floorLines]).toEqual([true, true, false, true, true, true])
    const lead = peopleCan(template('quality_inspector'))
    expect([lead.view, lead.team]).toEqual([false, true])
  })

  it('an employee opens its own page; the register is a built list page', () => {
    expect(recordAddress({ type: 'Employee', id: 'e1' }, OFFICE_PAGES)).toBe('/people/employees/e1')
    expect(recordAddress({ type: 'Team', id: 't1' }, OFFICE_PAGES)).toBe('/people/employees?view=teams&team=t1')
    expect(LIST_PAGES['/people/employees']).toBe('/people/employees')
    for (const page of ['/people/employees', '/people/employees/[id]', '/people/employees/badges', '/people/employees/print']) expect(OFFICE_PAGES.has(page), page).toBe(true)
  })
})

describe('people: the address and the API\'s own filters', () => {
  it('reads the address and writes it back without defaults (other terms kept)', () => {
    const address = employeesAddressOf(new URLSearchParams('tile=LEAVING&q=ross&view=teams&new=1&mode=cards'))
    expect(address).toEqual({ tile: 'LEAVING', rows: 'ACTIVE', q: 'ross', view: 'teams', isNew: true, isImport: false, lineId: null })
    expect(employeesAddressText({ ...address, isNew: false }, new URLSearchParams('mode=cards&tile=X'))).toBe('?mode=cards&view=teams&tile=LEAVING&q=ross')
    expect(employeesAddressOf(new URLSearchParams('tile=NOPE&rows=NOPE&view=NOPE'))).toMatchObject({ tile: null, rows: 'ACTIVE', view: 'people' })
  })

  it('a tile wins over Rows ▾; My team asks for the team; the default reads everyone active', () => {
    expect(employeesQuery({ tile: 'AGENCY_ENDING', rows: 'LEFT', q: ' x ' }, null)).toEqual({ tile: 'AGENCY_ENDING', q: 'x' })
    expect(employeesQuery({ tile: null, rows: 'MY_TEAM', q: '' }, 't1')).toEqual({ teamId: 't1' })
    expect(employeesQuery({ tile: null, rows: 'ACTIVE', q: '' }, null)).toEqual({})
    expect(employeesQuery({ tile: null, rows: 'MISSING_DATA', q: '' }, null)).toEqual({ rows: 'MISSING_DATA' })
    expect(isFiltered({ tile: null, rows: 'ACTIVE', q: '' })).toBe(false)
    expect(isFiltered({ tile: null, rows: 'ACTIVE', q: 'a' })).toBe(true)
    expect(ROW_CHOICES).toContain('MY_TEAM')
  })

  it('the data notice: the most serious open problem, one at a time; a dismissal is kept by value', () => {
    const problems = [
      { code: 'NOTICE_NOT_ACKNOWLEDGED' as const, count: 3 },
      { code: 'NO_EMPLOYEE_CODE' as const, count: 4 },
      { code: 'UNLINKED_WORKERS' as const, count: 0 },
    ]
    expect(currentNotice(problems, [])).toEqual({ problem: problems[0], more: 1 })
    expect(currentNotice(problems, [], 1)).toEqual({ problem: problems[1], more: 1 })
    expect(currentNotice(problems, [noticeKey(problems[0]!)])).toEqual({ problem: problems[1], more: 0 })
    // The same problem with another count comes back.
    expect(currentNotice([{ code: 'NOTICE_NOT_ACKNOWLEDGED', count: 4 }], ['NOTICE_NOT_ACKNOWLEDGED:3'])?.problem.count).toBe(4)
    expect(currentNotice([], [])).toBeNull()
  })
})

describe('people: refusals, held reasons and the small text rules', () => {
  it('reads a people refusal by its code and the field it names, else the kind', () => {
    const refused = new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/CODE_TAKEN' }, { path: 'body/employeeCode' }])
    expect(refusalOf(refused)).toBe('CODE_TAKEN')
    expect(fieldOf(refused)).toBe('employeeCode')
    expect(problemOf(refused)).toEqual({ key: 'refusal.CODE_TAKEN' })
    expect(problemOf(new ApiError('invalid', 400, 'validation', 'x', null, [{ path: 'body/endDate' }]))).toEqual({ key: 'problem.field.endDate' })
    expect(problemOf(new ApiError('conflict', 409, 'conflict', 'x'))).toEqual({ key: 'problem.conflict' })
    expect(problemOf(new Error('x'))).toEqual({ key: 'problem.unavailable' })
  })

  it('New employee, the loan and the record\'s edit hold with their reason', () => {
    const draft = blankNewDraft('s1', '2026-11-02')
    expect(newDraftHeld(draft)).toBe('held.names')
    expect(newDraftHeld({ ...draft, firstName: 'A', lastName: 'B' })).toBeNull()
    expect(newDraftHeld({ ...draft, firstName: 'A', lastName: 'B', kind: 'AGENCY' })).toBe('held.agency')
    expect(newDraftHeld({ ...draft, firstName: 'A', lastName: 'B', employeeCode: 'D 1' })).toBe('problem.field.employeeCode')
    const can = peopleCan(template('admin'))
    const loan = { kind: 'loan' as const, person: { id: 'e', name: 'n', displayName: 'n', employeeCode: null, siteId: 's', siteCode: 'S', homeLine: null, team: null, version: 1 }, toLineId: 'l', toTeamId: null, startsAt: '2026-11-02T08:00:00.000Z', endsAt: '2026-11-02T17:00:00.000Z', reason: 'peak', check: null, busy: false, problem: null, field: null }
    expect(loanHeld(loan, can)).toBeNull()
    expect(loanHeld({ ...loan, endsAt: loan.startsAt }, can)).toBe('held.loanEndBeforeStart')
    expect(loanHeld(loan, peopleCan(template('quality_inspector')))).toBe('held.noManageLoans')
    expect(editHeld({ firstName: 'A', lastName: 'B', displayName: '', employeeCode: '', kind: 'EMPLOYEE', agency: null, locale: 'it', startDate: '2026-01-01', endDate: '', department: '', jobRole: '', homeLineId: null, contract: null, hours: '' }, 'identity')).toBe('held.displayName')
    expect(editHeld({ firstName: 'A', lastName: 'B', displayName: 'A B.', employeeCode: '', kind: 'EMPLOYEE', agency: null, locale: 'it', startDate: '2026-01-01', endDate: '', department: '', jobRole: '', homeLineId: null, contract: null, hours: '90' }, 'job')).toBe('problem.field.weeklyMinutes')
  })

  it('hours, days and a zoned time', () => {
    expect(hoursText(2250, 'it')).toBe('37,5')
    expect(hoursText(2250, 'en')).toBe('37.5')
    expect(hoursText(null, 'it')).toBeNull()
    expect(minutesOfHours('37,5')).toBe(2250)
    expect(minutesOfHours('')).toBeNull()
    expect(minutesOfHours('abc')).toBeUndefined()
    expect(daysUntil('2026-11-02', '2026-11-30')).toBe(28)
    // 18:00 in Rome on a winter day is 17:00 UTC; in summer 16:00 UTC.
    expect(zonedInstant('2026-11-02', '18:00')).toBe('2026-11-02T17:00:00.000Z')
    expect(zonedInstant('2026-07-02', '18:00')).toBe('2026-07-02T16:00:00.000Z')
  })

  it('the CSV and the staff list carry no pay, attendance, health or work figure (none is in the answer either)', () => {
    const row = csvRowOf(PEOPLE.paolo, { kind: 'K', contract: 'C', badge: 'B', notice: 'N', status: 'S' }, 'it')
    expect(row).toContain(PEOPLE.paolo.name)
    const text = csvText(['a', 'b'], [['x;y', 'z']])
    expect(text).toBe('a;b\r\n"x;y";z')
    for (const key of Object.keys(PEOPLE.paolo)) expect(key).not.toMatch(/pay|wage|earn|attend|efficien|health|absen|minutesWorked/i)
  })

  it('a leaver step says where it is done; the Activity says each action and field in words', () => {
    expect(stepHref('/w/D', { place: 'FLOOR_SIGN_IN' }, { userId: null, workerIds: ['w1'] })).toBe('/w/D/admin/users/floor/w1')
    expect(stepHref('/w/D', { place: 'OFFICE_ACCOUNT' }, { userId: 'u1', workerIds: [] })).toBe('/w/D/admin/users/u1')
    expect(stepHref('/w/D', { place: 'PAYROLL' }, { userId: null, workerIds: [] })).toBeNull()
    expect(activityAction('people.updateEmployee')).toBe('activity.action.updateEmployee')
    expect(activityAction('people.somethingNew')).toBe('activity.action.other')
    expect(activityChanges({ jobRole: 'A', homeLineId: 'x' }, { jobRole: 'B', homeLineId: 'y' })).toEqual([{ field: 'jobRole', before: 'A', after: 'B' }])
  })

  it('the Teams view lists every member sorted site › line › team', () => {
    const rows = memberRows([...(employeesScreen.cases[0]!.model.list.teams.items ?? [])].reverse())
    expect(rows.map((row) => row.team.code)).toEqual(['A1', 'A1', 'A1', 'A1', 'B1', 'B1', 'B1'])
  })
})

describe('people: the badge face', () => {
  it('names the person as the floor does, with the code, site and team, and a QR of the record — never a sign-in code', () => {
    const layout = badgeLayout({ id: 'e1', displayName: 'Paolo P.', name: 'Paolo Prova', employeeCode: 'D-0002', siteCode: 'STAB-N', team: 'A1' }, { name: 'Badge', company: 'Officina Demo', code: 'Code', site: 'Site', team: 'Team', none: '—' }, 'https://factory.example/w/D/people/employees/e1')
    expect([layout.widthMm, layout.heightMm]).toEqual([86, 54])
    const text = JSON.stringify(layout)
    expect(text).toContain('Paolo P.')
    expect(text).toContain('https://factory.example/w/D/people/employees/e1')
    expect(text).not.toMatch(/pin|secret|token/i)
    expect(badgeSheetHref('/w/D', ['a', 'b'])).toBe('/w/D/people/employees/badges?ids=a,b')
  })
})

function mockApi(answers: Array<{ status: number; body: unknown }>): { api: ApiClient; calls: Array<{ method: string; url: string; headers: Headers; body: unknown }> } {
  const calls: Array<{ method: string; url: string; headers: Headers; body: unknown }> = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: String(init.method), url, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined })
    const next = answers.shift() ?? { status: 500, body: { error: { code: 'internal_error', message: 'no answer left' } } }
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { api: createApiClient({ baseUrl: '/api', fetch, company: 'DEMO', csrfToken: () => 'csrf-demo' }), calls }
}

describe('people: the calls as the API takes them', () => {
  it('reads the register with the API\'s own filters, and the privacy note for a site and the PERFORMANCE gate', async () => {
    const { api, calls } = mockApi([
      { status: 200, body: { employees: EMPLOYEE_LIST, nextCursor: 'c1', today: '2026-11-02' } },
      { status: 200, body: { siteId: 's1', purpose: 'PERFORMANCE', open: false, level: 'GROUPS_ONLY', minimumGroupSize: 3, leadsSeeFigures: false, words: ['English words are never drawn'] } },
    ])
    const page = await listEmployees(api, { ...employeesQuery({ tile: 'STARTING', rows: 'ACTIVE', q: '' }, null), siteId: 's1', limit: 100 })
    expect(calls[0]!.url).toBe('/api/people/employees?siteId=s1&tile=STARTING&limit=100')
    expect(page.nextCursor).toBe('c1')
    const sight = await whatYouSee(api, 's1')
    expect(calls[1]!.url).toBe('/api/people/privacy/what-you-see?siteId=s1&purpose=PERFORMANCE')
    expect(sight).not.toHaveProperty('words')
  })

  it('every write carries an Idempotency-Key, the version read where there is one, and the CSRF token', async () => {
    const one = { employee: PEOPLE.paolo }
    const { api, calls } = mockApi([
      { status: 201, body: one },
      { status: 200, body: one },
      { status: 200, body: { rows: [], moved: 1, teams: [] } },
      { status: 201, body: { loan: { id: 'l1', site: { id: 's', code: 'S', name: 'S' }, employeeId: 'e', name: 'n', fromLine: null, toLine: { id: 'l', code: 'L', name: 'L' }, toTeam: null, startsAt: 'a', endsAt: 'b', state: 'PLANNED', reason: 'r', decidedBy: null, version: 1 } } },
      { status: 201, body: { leaver: LEAVER } },
    ])
    await createEmployee(api, { siteId: 's1', firstName: 'A', lastName: 'B', startDate: '2026-11-02' })
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/people/employees', body: { siteId: 's1', firstName: 'A' } })
    await updateEmployee(api, 'e1', { version: 3, homeLineId: null })
    expect(calls[1]).toMatchObject({ method: 'PATCH', url: '/api/people/employees/e1', body: { version: 3, homeLineId: null } })
    await applyMoves(api, [{ employeeId: 'e1', teamId: 't1' }], 'key-1')
    expect(calls[2]!.headers.get('idempotency-key')).toBe('key-1')
    await createLoan(api, { employeeId: 'e1', toLineId: 'l1', startsAt: '2026-11-02T08:00:00.000Z', endsAt: '2026-11-02T17:00:00.000Z', reason: 'peak' })
    await startLeaving(api, 'e1', { lastWorkingDay: '2026-11-30' })
    expect(calls[4]).toMatchObject({ method: 'POST', url: '/api/people/employees/e1/leaving', body: { lastWorkingDay: '2026-11-30' } })
    for (const call of calls) {
      expect(call.headers.get('idempotency-key'), call.url).toBeTruthy()
      expect(call.headers.get('x-csrf-token'), call.url).toBe('csrf-demo')
    }
  })
})

const LEFT_KEY =
  /\b(?:common|list|live|privacy|lifecycle|kind|contract|badgeState|badge|noticeState|pin|loanState|caseStatus|language|tile|tileHint|rows|view|col|csv|dataProblem|cell|line|team|status|keys|held|problem|refusal|conflict|next|notKept|record|tab|profile|edit|field|floor|side|job|loans|documents|activity|leavers|step|stepStatus|new|loan|leaver|badges|teamChange|addTeam|skip|cancelLeaving|link|unlinked|teams|teamOnly|missing|notice|print|staff|sheet)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose ("needs people.employees.manage"); addresses and domains are not keys. */
const SAID = /\b(?:people\.[a-zA-Z.]+|workers\.(?:manage|view)|users\.view|imports\.run|parties\.view|audit\.read|factory\.example|example\.com|art\.\s?\d+)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records', 'people', 'ds-words']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [employeesScreen, recordScreen, sheetScreen, printScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(SAID, '')
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('the dynamic words exist in both languages (types, lifecycles, tiles, steps, refusals, conflicts, next steps, activity)', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['people']).people!)
      const has = (key: string, params?: Record<string, number>) => expect(t(key, params), `${locale}: ${key}`).not.toBe(key)
      for (const kind of EMPLOYEE_KINDS) has(`kind.${kind}`)
      for (const lifecycle of LIFECYCLES) has(`lifecycle.${lifecycle}`)
      for (const tile of EMPLOYEE_TILES) {
        has(`tile.${tile}`)
        has(`tileHint.${tile}`)
      }
      for (const choice of ROW_CHOICES) has(`rows.${choice}`)
      for (const kind of LEAVER_STEP_KINDS) has(`step.${kind}`)
      for (const code of PEOPLE_REFUSALS) has(`refusal.${code}`)
      for (const conflict of MOVE_CONFLICTS) has(`conflict.${conflict}`)
      for (const step of NEXT_STEPS) has(`next.${step}`, { count: 2 })
      for (const action of [...ACTIVITY_ACTIONS, 'other']) has(`activity.action.${action}`)
      for (const field of ACTIVITY_FIELDS) has(`field.${field}`)
      for (const code of LANGUAGES) has(`language.${code}`)
      for (const code of ['NOTICE_NOT_ACKNOWLEDGED', 'NO_EMPLOYEE_CODE', 'UNLINKED_WORKERS']) has(`dataProblem.${code}`, { count: 2 })
    }
  })
})
