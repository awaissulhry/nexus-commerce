import { describe, expect, it } from 'vitest'
import { employeesImporter, hoursOfMinutes, minutesOfHours, planEmployeeRow } from './importer'
import { addDays, defaultDisplayName, employeeProblems, lifecycleOf, namesFromDisplayName, nextStepsOf, tilesOf, type EmployeeDraft } from './rules'

/** Made-up people only (the repo is public). */
const draft = (over: Partial<EmployeeDraft> = {}): EmployeeDraft => ({
  firstName: 'Made',
  lastName: 'Up',
  displayName: 'Made U.',
  employeeCode: 'T-001',
  kind: 'EMPLOYEE',
  agencyPartyId: null,
  locale: 'it',
  startDate: '2026-01-05',
  endDate: null,
  department: null,
  jobRole: null,
  contract: 'FULL_TIME',
  weeklyMinutes: 2400,
  ...over,
})
const paths = (value: EmployeeDraft) => employeeProblems(value).map((problem) => problem.path)

describe('the employee record (MES-208, MES-211)', () => {
  it('keeps a valid record and names each broken field', () => {
    expect(employeeProblems(draft())).toEqual([])
    expect(paths(draft({ firstName: ' ', displayName: '' }))).toEqual(['firstName', 'displayName'])
    expect(paths(draft({ employeeCode: 'A 1' }))).toEqual(['employeeCode'])
    expect(paths(draft({ locale: 'ITA1' }))).toEqual(['locale'])
    expect(paths(draft({ endDate: '2025-12-31' }))).toEqual(['endDate'])
    expect(paths(draft({ weeklyMinutes: 0 }))).toEqual(['weeklyMinutes'])
    expect(paths(draft({ weeklyMinutes: 4801 }))).toEqual(['weeklyMinutes'])
  })

  it('an agency worker names the agency and the contract end; nobody else names an agency', () => {
    expect(paths(draft({ kind: 'AGENCY' }))).toEqual(['agencyPartyId', 'endDate'])
    expect(employeeProblems(draft({ kind: 'AGENCY', agencyPartyId: '00000000-0000-7000-8000-000000000001', endDate: '2026-12-31' }))).toEqual([])
    expect(paths(draft({ kind: 'EXTERNAL', agencyPartyId: '00000000-0000-7000-8000-000000000001' }))).toEqual(['agencyPartyId'])
  })

  it('reads names from a floor name, and makes the floor name from the names', () => {
    expect(namesFromDisplayName('  Seed   Worker A1-1 ')).toEqual({ firstName: 'Seed', lastName: 'Worker A1-1' })
    expect(namesFromDisplayName('Mono')).toBeNull()
    expect(defaultDisplayName('Anna Maria', 'Rossi')).toBe('Anna Maria R.')
  })

  it('the lifecycle pill and the tiles (starting in 14 days, agency ending in 30, leaving)', () => {
    const today = '2026-10-31'
    expect(lifecycleOf({ status: 'ACTIVE', startDate: '2026-11-03', leaving: false }, today)).toBe('STARTING')
    expect(lifecycleOf({ status: 'ACTIVE', startDate: '2026-01-01', leaving: true }, today)).toBe('LEAVING')
    expect(lifecycleOf({ status: 'LEFT', startDate: '2026-01-01', leaving: false }, today)).toBe('LEFT')
    expect(tilesOf({ status: 'ACTIVE', startDate: '2026-11-10', leaving: false, kind: 'EMPLOYEE', endDate: null }, today)).toEqual(['STARTING'])
    expect(tilesOf({ status: 'ACTIVE', startDate: '2026-12-01', leaving: false, kind: 'EMPLOYEE', endDate: null }, today)).toEqual([])
    expect(tilesOf({ status: 'ACTIVE', startDate: '2026-09-01', leaving: true, kind: 'AGENCY', endDate: '2026-11-30' }, today)).toEqual(['ACTIVE', 'LEAVING', 'AGENCY_ENDING'])
    expect(tilesOf({ status: 'ACTIVE', startDate: '2026-09-01', leaving: false, kind: 'AGENCY', endDate: '2026-12-31' }, today)).toEqual(['ACTIVE'])
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('says the next steps, most urgent first', () => {
    const steps = nextStepsOf({ status: 'ACTIVE', startDate: '2026-09-01', leaving: true, kind: 'AGENCY', endDate: '2026-11-10', employeeCode: null, noticeMissing: 1, lastWorkingDay: '2026-11-10' }, '2026-10-31')
    expect(steps).toEqual([
      { code: 'NOTICE_NOT_ACKNOWLEDGED', days: null },
      { code: 'AGENCY_ENDING', days: 10 },
      { code: 'LEAVING', days: 10 },
    ])
    expect(nextStepsOf({ status: 'ACTIVE', startDate: '2026-11-02', leaving: false, kind: 'EMPLOYEE', endDate: null, employeeCode: null, noticeMissing: 0, lastWorkingDay: null }, '2026-10-31').map((step) => step.code)).toEqual(['NO_EMPLOYEE_CODE', 'STARTING'])
  })
})

describe('the employees import (MES-209)', () => {
  it('is keyed by the employee code, has no money column, and reads Italian headers', () => {
    expect(employeesImporter.keyColumns).toEqual(['employeeCode'])
    expect(Object.values(employeesImporter.columns).some((column) => 'grain' in column && column.grain)).toBe(false)
    expect(employeesImporter.columns.employeeCode.aliases).toContain('matricola')
    expect(employeesImporter.columns.startDate.aliases).toContain('data assunzione')
  })

  it('a new code needs both names, the site and the start date; a known one is compared cell by cell', () => {
    expect(planEmployeeRow({ employeeCode: 'T-9', firstName: 'Made' }, null)).toEqual({
      action: 'ERROR',
      errors: [
        { column: 'lastName', message: 'A new employee needs it.' },
        { column: 'site', message: 'A new employee needs it.' },
        { column: 'startDate', message: 'A new employee needs it.' },
      ],
    })
    expect(planEmployeeRow({ employeeCode: 'T-9', firstName: 'Made', lastName: 'Up', site: 'A1', startDate: '2026-01-05' }, null).action).toBe('CREATE')
    const existing = { id: 'x', values: { employeeCode: 'T-9', firstName: 'Made', weeklyHours: '40' } }
    expect(planEmployeeRow({ employeeCode: 'T-9', weeklyHours: '40.00' }, existing)).toEqual({ action: 'UNCHANGED' })
    expect(planEmployeeRow({ employeeCode: 'T-9', firstName: 'Other' }, existing)).toEqual({ action: 'UPDATE', before: { firstName: 'Made' }, after: { firstName: 'Other' } })
  })

  it('weekly hours are whole minutes', () => {
    expect(minutesOfHours('37.5')).toBe(2250)
    expect(minutesOfHours('38.33')).toBeNull()
    expect(hoursOfMinutes(2250)).toBe('37.5')
    expect(hoursOfMinutes(null)).toBeNull()
  })
})
