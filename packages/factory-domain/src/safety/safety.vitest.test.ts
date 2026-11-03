import { describe, expect, it } from 'vitest'
import { EVENT_CATALOGUE } from '../events/catalogue'
import { FACTORY_PERMISSIONS } from '../auth/permissions/catalogue'
import { templateOf } from '../auth/roles/templates'
import { calendarTiles, deadlineProblems, doneRefusal, itemStateOf, nextDueOf, openRefusal, windowProblems } from './calendar/rules'
import { appointeeRefusal, courseTypeOf, endRefusal, filingRefusal, inForce, missingRoles, ROLE_LAW, SAFETY_ROLES, sameName, signRefusal, trainingStateOf } from './organisation/rules'

/** B-W2b-120: the safety organisation, the RLS notice and the safety calendar, pure. */

const TODAY = '2026-11-03'

describe('the safety organisation (QHS-224, QHS-226)', () => {
  it('holds the shape the schema holds: an RLS of the company, an RLST outside, shifts only for the teams', () => {
    expect(appointeeRefusal({ role: 'RLS', outsideName: 'Somebody', fromDate: TODAY })?.code).toBe('RLS_IS_EMPLOYEE')
    expect(appointeeRefusal({ role: 'RLST', employeeId: 'e', fromDate: TODAY })?.code).toBe('RLST_IS_OUTSIDE')
    expect(appointeeRefusal({ role: 'RSPP', outsideName: 'Consultant', shiftPatternId: 's', fromDate: TODAY })?.code).toBe('SHIFT_ONLY_TEAMS')
    expect(appointeeRefusal({ role: 'FIRST_AID', employeeId: 'e', shiftPatternId: 's', fromDate: TODAY, untilDate: '2026-11-02' })?.code).toBe('ENDS_BEFORE_START')
    expect(appointeeRefusal({ role: 'FIRE_EMERGENCY', employeeId: 'e', shiftPatternId: 's', fromDate: TODAY, untilDate: TODAY })).toBeNull()
  })

  it('names the roles nobody holds today: the company’s four, each site’s two teams (a whole-company team covers every site)', () => {
    const places = [{ companyId: 'A', siteIds: ['A1', 'A2'] }]
    const held = (role: (typeof SAFETY_ROLES)[number], siteId: string | null = null, fromDate = '2020-01-01', untilDate: string | null = null) => ({ companyId: 'A', siteId, role, fromDate, untilDate })
    const missing = missingRoles(places, [held('EMPLOYER'), held('RSPP'), held('RLST'), held('FIRST_AID', 'A1'), held('FIRE_EMERGENCY'), held('DOCTOR', null, '2020-01-01', '2026-11-02')], TODAY)
    expect(missing).toEqual([
      { companyId: 'A', siteId: null, role: 'DOCTOR' },
      { companyId: 'A', siteId: 'A2', role: 'FIRST_AID' },
    ])
    // A term that starts tomorrow does not hold the role today.
    expect(missingRoles(places, [held('EMPLOYER', null, '2026-11-04')], TODAY)).toContainEqual({ companyId: 'A', siteId: null, role: 'EMPLOYER' })
    expect(inForce({ fromDate: TODAY, untilDate: TODAY }, TODAY)).toBe(true)
  })

  it('signs once with the appointee’s own name (loosely), paper only with the letter on file, and ends a term after its start', () => {
    const facts = { signed: false, ended: false, method: 'OFFICE' as const, signedName: '  ànna  ESEMPIO ', appointeeName: 'Anna Esempio', letterOnFile: false }
    expect(signRefusal(facts)).toBeNull()
    expect(sameName('Anna', '')).toBe(false)
    expect(signRefusal({ ...facts, signedName: 'Marco Prova' })?.code).toBe('NAME_MISMATCH')
    expect(signRefusal({ ...facts, method: 'PAPER' })?.code).toBe('LETTER_MISSING')
    expect(signRefusal({ ...facts, method: 'PAPER', letterOnFile: true })).toBeNull()
    expect(signRefusal({ ...facts, signed: true })?.code).toBe('SIGNED_ALREADY')
    expect(endRefusal({ fromDate: TODAY, untilDate: null }, '2026-11-02', TODAY)?.code).toBe('ENDS_BEFORE_START')
    expect(endRefusal({ fromDate: '2026-01-01', untilDate: '2026-11-02' }, TODAY, TODAY)?.code).toBe('ENDED')
  })

  it('records a filing only while pending, on a day between the RLS’s first day and today', () => {
    expect(filingRefusal({ status: 'PENDING', filedOn: TODAY, appointedFrom: '2026-10-01', today: TODAY })).toBeNull()
    expect(filingRefusal({ status: 'PENDING', filedOn: '2026-11-04', appointedFrom: '2026-10-01', today: TODAY })?.code).toBe('FILED_IN_FUTURE')
    expect(filingRefusal({ status: 'PENDING', filedOn: '2026-09-30', appointedFrom: '2026-10-01', today: TODAY })?.code).toBe('FILED_BEFORE_APPOINTMENT')
    expect(filingRefusal({ status: 'FILED', filedOn: TODAY, appointedFrom: '2026-10-01', today: TODAY })?.code).toBe('NOTICE_NOT_PENDING')
  })

  it('reads the training of the roles that keep a course, and names the law of every role', () => {
    expect(['RLS', 'FIRST_AID', 'FIRE_EMERGENCY', 'SUPERVISOR', 'MANAGER'].map((role) => courseTypeOf(role as never))).toEqual(['RLS', 'FIRST_AID', 'FIRE', 'SUPERVISOR', 'MANAGER'])
    expect(courseTypeOf('RSPP')).toBeNull()
    expect(trainingStateOf(null, null, false, TODAY)).toBe('NOT_TRACKED')
    expect(trainingStateOf('RLS', null, false, TODAY)).toBe('NONE')
    expect(trainingStateOf('RLS', '2026-11-02', true, TODAY)).toBe('EXPIRED')
    expect(trainingStateOf('RLS', null, true, TODAY)).toBe('VALID')
    for (const role of SAFETY_ROLES) expect(ROLE_LAW[role]).toMatch(/^D\.Lgs\. 81\/2008 /)
  })
})

describe('the safety calendar (QHS-227)', () => {
  it('says each item’s state: late, within 30 days, later, done, cancelled; a deadline with no fixed day is never late', () => {
    expect(itemStateOf({ dueOn: '2026-11-02' }, TODAY)).toBe('OVERDUE')
    expect(itemStateOf({ dueOn: '2026-12-03' }, TODAY)).toBe('DUE_SOON')
    expect(itemStateOf({ dueOn: '2026-12-04' }, TODAY)).toBe('PLANNED')
    expect(itemStateOf({ dueOn: '2026-01-01', toConfirm: true }, TODAY)).toBe('TO_CONFIRM')
    expect(itemStateOf({ dueOn: '2026-01-01', done: true }, TODAY)).toBe('DONE')
    expect(itemStateOf({ dueOn: '2026-01-01', cancelled: true }, TODAY)).toBe('CANCELLED')
    expect(calendarTiles([{ state: 'OVERDUE' }, { state: 'DUE_SOON' }, { state: 'DUE_SOON' }, { state: 'TO_CONFIRM' }])).toEqual({ overdue: 1, dueSoon: 2 })
  })

  it('repeats from the due day, the month’s last day when the day does not exist there', () => {
    expect(nextDueOf('2026-01-31', 1, 'MONTH')).toBe('2026-02-28')
    expect(nextDueOf('2028-02-29', 1, 'YEAR')).toBe('2029-02-28')
    expect(nextDueOf('2026-11-03', 2, 'WEEK')).toBe('2026-11-17')
  })

  it('checks a deadline’s shape, done only with its evidence when asked, changes only while open', () => {
    expect(deadlineProblems({ title: ' ', repeatEvery: 1, repeatUnit: null }).map((problem) => problem.path)).toEqual(['title', 'repeatUnit'])
    expect(deadlineProblems({ repeatEvery: 121, repeatUnit: 'MONTH' }).map((problem) => problem.path)).toEqual(['repeatEvery'])
    expect(deadlineProblems({ title: 'Drill', repeatEvery: null, repeatUnit: null })).toEqual([])
    expect(doneRefusal({ status: 'OPEN', evidenceRequired: true, evidenceOnFile: false })?.code).toBe('EVIDENCE_MISSING')
    expect(doneRefusal({ status: 'OPEN', evidenceRequired: true, evidenceOnFile: true })).toBeNull()
    expect(doneRefusal({ status: 'DONE', evidenceRequired: false, evidenceOnFile: false })?.code).toBe('NOT_OPEN')
    expect(openRefusal('CANCELLED')?.code).toBe('NOT_OPEN')
    expect(windowProblems(TODAY, '2027-12-09')).toHaveLength(1)
    expect(windowProblems(TODAY, '2027-12-08')).toEqual([])
  })
})

describe('permissions, templates and events', () => {
  it('declares the safety permissions and gives them to the safety roles', () => {
    for (const name of ['safety.view', 'safety.organisation.manage', 'safety.calendar.manage']) expect(FACTORY_PERMISSIONS.isDeclared(name), name).toBe(true)
    expect(templateOf('safety_officer')?.permissions).toEqual(expect.arrayContaining(['safety.view', 'safety.organisation.manage', 'safety.calendar.manage', 'plant.view']))
    expect(templateOf('company_doctor')).toMatchObject({ requireMfa: true, grains: [] })
    expect(templateOf('company_doctor')?.permissions).not.toContain('safety.organisation.manage')
    expect(templateOf('hr')).toMatchObject({ requireMfa: true, grains: ['pay'] })
    expect(templateOf('hr')?.permissions).toEqual(expect.arrayContaining(['people.view', 'people.employees.manage', 'people.figures.view', 'safety.view', 'safety.organisation.manage']))
    for (const key of ['production_manager', 'maintenance', 'floor_supervisor']) expect(templateOf(key)?.permissions, key).toContain('safety.view')
    // The administrator keeps its People permissions (the Owner moves them to HR when he says so).
    expect(templateOf('admin')?.permissions).toContain('people.employees.manage')
  })

  it('declares its events with no person and no health value', () => {
    for (const type of ['safety_appointment.changed', 'rls_notice.changed', 'safety_deadline.changed']) {
      const event = EVENT_CATALOGUE.find(type, 1)
      expect(event, type).toBeDefined()
      expect(event?.live?.permission).toBe('safety.view')
      expect(event?.live?.floor).toBeNull()
    }
  })
})
