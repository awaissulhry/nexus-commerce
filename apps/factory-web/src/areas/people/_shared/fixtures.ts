import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { permissionCheck } from '../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER } from '../../../shell/design-data'
import { officeNavFor } from '../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../shell/office/view/OfficeShellView'
import { NO_SCOPE, scopeOf, type OfficeScope } from '../../../shell/scope/scope-model'
import type { Employee, EmployeeCounts, EmployeeRecord, Leaver, LeaverStep, Ref, Sight, SiteLine, Team, UnlinkedWorker } from './api'
import { peopleCan, type PeopleCan } from './model'
import type { SightState } from './parts'

/**
 * Made-up data for the People pages' design cases (SCR-084 Employees, SCR-085 the employee record, the badge sheet and the
 * staff list print): an invented company ("Officina Demo"), two sites ("STAB-N", "STAB-S"), lines, teams and invented
 * people ("Giulia Esempio", "Paolo Prova", an agency worker "Ion Campione" …) with invented employee codes ("D-0001" …).
 * Nothing here is a real company, person or number. Design-only (only fixtures and tests import it); it exports no
 * `designScreen`.
 */

export const PREFIX = '/w/DEMO'
export const ORIGIN = 'https://factory.example'
export const COMPANY = DEMO_COMPANIES[0].id
export const TODAY = '2026-11-02'
export const NOW = '2026-11-02T09:42:00.000Z'
const uid = (block: string, n: number) => `0190f0e2-${block.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`

// ---- roles -------------------------------------------------------------------------------------------------------------------

const template = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']

/**
 * The role cases the design names: HR (the administrator template keeps the HR register until an HR template comes:
 * people.employees/teams/loans/leavers.manage), the production manager (teams and loans), the floor supervisor (loans), a
 * lead with My team only (people.team.view: "Showing your team (8)"), read-only (sees, changes nothing), sales (no People).
 */
export const PEOPLE_ROLES = {
  hr: [...template('admin'), 'people.skills.view', 'parties.view'],
  production: template('production_manager'),
  supervisor: template('floor_supervisor'),
  lead: template('quality_inspector'),
  readOnly: [...(templateOf('read_only')?.permissions ?? []), 'home.view'],
  sales: template('sales'),
} as const
export type PeopleRole = keyof typeof PEOPLE_ROLES
export const canAs = (role: PeopleRole): PeopleCan => peopleCan(PEOPLE_ROLES[role])

/** The Office shell around a page (the role's navigation, this page's place), as the page sees it. */
export function inShell(path: string, page: ReactNode, role: PeopleRole = 'hr'): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck([...PEOPLE_ROLES[role]])),
    path,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: SITES.map((site) => ({ id: site.id, name: site.name, code: site.code })), site: SITE_N.id, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

// ---- places ------------------------------------------------------------------------------------------------------------------

export const SITE_N: Ref = { id: uid('3101', 1), code: 'STAB-N', name: 'Stabilimento Nord' }
export const SITE_S: Ref = { id: uid('3101', 2), code: 'STAB-S', name: 'Stabilimento Sud' }
export const SITES: Ref[] = [SITE_N, SITE_S]
export const SCOPE_ONE: OfficeScope = scopeOf({ company: DEMO_COMPANIES[0], sites: SITES, chosen: SITE_N.id })
export const SCOPE_ALL: OfficeScope = scopeOf({ company: DEMO_COMPANIES[0], sites: SITES, chosen: null })
export { NO_SCOPE }

export const LINE_A: SiteLine = { id: uid('3202', 1), code: 'L-A', name: 'Linea giacche', siteId: SITE_N.id, teams: [] }
export const LINE_B: SiteLine = { id: uid('3202', 2), code: 'L-B', name: 'Linea pantaloni', siteId: SITE_N.id, teams: [] }
export const LINE_S: SiteLine = { id: uid('3202', 3), code: 'L-S1', name: 'Linea guanti', siteId: SITE_S.id, teams: [] }
export const LINES: SiteLine[] = [LINE_A, LINE_B, LINE_S]
const lineRef = (line: SiteLine): Ref => ({ id: line.id, code: line.code, name: line.name })

// ---- people ------------------------------------------------------------------------------------------------------------------

const TEAM_A1 = { id: uid('3303', 1), code: 'A1', name: 'Cucitura A', since: '2026-03-02' }
const TEAM_B1 = { id: uid('3303', 2), code: 'B1', name: 'Pantaloni B', since: '2026-04-01' }
const TEAM_S1 = { id: uid('3303', 3), code: 'S1', name: 'Guanti Sud', since: '2026-05-04' }

let seq = 0
function person(over: Partial<Employee> & Pick<Employee, 'firstName' | 'lastName'>): Employee {
  seq += 1
  const name = `${over.firstName} ${over.lastName}`
  return {
    id: uid('3404', seq),
    companyId: COMPANY,
    companyCode: 'DEMO',
    site: SITE_N,
    employeeCode: `D-${String(seq).padStart(4, '0')}`,
    name,
    displayName: `${over.firstName} ${over.lastName.charAt(0)}.`,
    kind: 'EMPLOYEE',
    agency: null,
    locale: 'it',
    startDate: '2024-02-05',
    endDate: null,
    department: 'Produzione',
    jobRole: 'Cucitrice',
    homeLine: lineRef(LINE_A),
    team: TEAM_A1,
    isLead: false,
    lead: { employeeId: uid('3404', 1), name: 'Giulia Esempio' },
    contract: 'FULL_TIME',
    weeklyMinutes: 2400,
    defaultShift: { id: uid('3505', 1), code: 'T1', name: 'Mattino 6–14' },
    floor: { signIns: 1, badge: 'ACTIVE', notice: 'ACKNOWLEDGED' },
    officeAccount: false,
    status: 'ACTIVE',
    lifecycle: 'ACTIVE',
    leaving: null,
    version: 3,
    updatedAt: '2026-10-28T08:12:00.000Z',
    ...over,
  } as Employee
}

export const PEOPLE = {
  giulia: person({ firstName: 'Giulia', lastName: 'Esempio', isLead: true, lead: null, jobRole: 'Capo squadra', department: 'Produzione', officeAccount: true }),
  paolo: person({ firstName: 'Paolo', lastName: 'Prova', jobRole: 'Tagliatore', team: TEAM_A1 }),
  sara: person({ firstName: 'Sara', lastName: 'Demo', homeLine: lineRef(LINE_B), team: TEAM_B1, lead: { employeeId: uid('3404', 9), name: 'Davide Modello' }, contract: 'PART_TIME', weeklyMinutes: 1500, floor: { signIns: 1, badge: 'ACTIVE', notice: 'MISSING' } }),
  ion: person({ firstName: 'Ion', lastName: 'Campione', kind: 'AGENCY', agency: { id: uid('3606', 1), code: 'AG-DEMO', name: 'Agenzia Lavoro Demo' }, endDate: '2026-11-20', locale: 'ro', startDate: '2026-09-01', homeLine: lineRef(LINE_B), team: TEAM_B1, lead: { employeeId: uid('3404', 9), name: 'Davide Modello' } }),
  elena: person({ firstName: 'Elena', lastName: 'Fittizia', employeeCode: null, department: 'Ufficio', jobRole: 'Impiegata', homeLine: null, team: null, lead: null, floor: { signIns: 0, badge: 'NONE', notice: null }, officeAccount: true }),
  marta: person({ firstName: 'Marta', lastName: 'Saggio', lifecycle: 'LEAVING', leaving: { caseId: uid('3707', 1), lastWorkingDay: '2026-11-30', openSteps: 5 } }),
  luca: person({ firstName: 'Luca', lastName: 'Bozza', lifecycle: 'STARTING', startDate: '2026-11-09', floor: { signIns: 0, badge: 'NONE', notice: null } }),
  davide: person({ firstName: 'Davide', lastName: 'Modello', isLead: true, lead: null, homeLine: lineRef(LINE_B), team: TEAM_B1, jobRole: 'Capo squadra' }),
  chiara: person({ firstName: 'Chiara', lastName: 'Copia', site: SITE_S, homeLine: lineRef(LINE_S), team: TEAM_S1, lead: null, locale: 'sq' }),
  rita: person({ firstName: 'Rita', lastName: 'Passata', status: 'LEFT', lifecycle: 'LEFT', endDate: '2026-09-30', team: null, lead: null, floor: { signIns: 1, badge: 'NONE', notice: 'ACKNOWLEDGED' } }),
}
export const EMPLOYEE_LIST: Employee[] = [PEOPLE.giulia, PEOPLE.paolo, PEOPLE.sara, PEOPLE.ion, PEOPLE.elena, PEOPLE.marta, PEOPLE.luca, PEOPLE.davide]

export const COUNTS: EmployeeCounts = {
  tiles: { ACTIVE: 8, STARTING: 1, LEAVING: 1, AGENCY_ENDING: 1, UNLINKED_WORKERS: 2 },
  problems: [
    { code: 'NOTICE_NOT_ACKNOWLEDGED', count: 1 },
    { code: 'NO_EMPLOYEE_CODE', count: 1 },
    { code: 'UNLINKED_WORKERS', count: 2 },
  ],
}
export const NO_COUNTS: EmployeeCounts = { tiles: { ACTIVE: 0, STARTING: 0, LEAVING: 0, AGENCY_ENDING: 0, UNLINKED_WORKERS: 0 }, problems: [] }

export const UNLINKED: UnlinkedWorker[] = [
  { id: uid('3808', 1), site: SITE_N, displayName: 'Nadia T.', employeeCode: 'D-0091', locale: 'it', status: 'ACTIVE', createdAt: '2026-10-20T07:00:00.000Z' },
  { id: uid('3808', 2), site: SITE_N, displayName: 'Omar K.', employeeCode: null, locale: 'ar', status: 'ACTIVE', createdAt: '2026-10-27T07:00:00.000Z' },
]

const member = (employee: Employee, onLoan: Team['members'][number]['onLoan'] = null) => ({ employeeId: employee.id, name: employee.name, displayName: employee.displayName, isLead: employee.isLead, since: employee.team?.since ?? '2026-01-05', onLoan })
export const TEAMS: Team[] = [
  {
    id: TEAM_A1.id,
    companyId: COMPANY,
    site: SITE_N,
    line: lineRef(LINE_A),
    code: TEAM_A1.code,
    name: TEAM_A1.name,
    status: 'ACTIVE',
    lead: { employeeId: PEOPLE.giulia.id, name: PEOPLE.giulia.name },
    members: [member(PEOPLE.giulia), member(PEOPLE.paolo, { loanId: uid('3909', 1), toLine: lineRef(LINE_B), until: '2026-11-02T17:00:00.000Z' }), member(PEOPLE.marta), member(PEOPLE.luca)],
    loansIn: [],
    version: 4,
  },
  {
    id: TEAM_B1.id,
    companyId: COMPANY,
    site: SITE_N,
    line: lineRef(LINE_B),
    code: TEAM_B1.code,
    name: TEAM_B1.name,
    status: 'ACTIVE',
    lead: { employeeId: PEOPLE.davide.id, name: PEOPLE.davide.name },
    members: [member(PEOPLE.davide), member(PEOPLE.sara), member(PEOPLE.ion)],
    loansIn: [{ loanId: uid('3909', 1), employeeId: PEOPLE.paolo.id, name: PEOPLE.paolo.name, fromLine: lineRef(LINE_A), startsAt: '2026-11-02T08:00:00.000Z', until: '2026-11-02T17:00:00.000Z' }],
    version: 2,
  },
  { id: uid('3303', 4), companyId: COMPANY, site: SITE_N, line: null, code: 'M1', name: 'Magazzino', status: 'ACTIVE', lead: null, members: [], loansIn: [], version: 1 },
]

const step = (n: number, kind: LeaverStep['kind'], over: Partial<LeaverStep> = {}): LeaverStep => ({
  id: uid('4010', n),
  kind,
  seq: n,
  automatic: ['BADGE_OFF', 'SESSIONS_ENDED', 'ACCESS_ENDED', 'SHIFTS_CLEARED', 'PAYROLL_FLAGGED'].includes(kind),
  dueOn: kind === 'SHIFTS_CLEARED' ? '2026-12-01' : kind === 'PAYROLL_FLAGGED' ? null : '2026-11-30',
  status: 'OPEN',
  doneAt: null,
  doneBy: null,
  skipReason: null,
  place: kind === 'BADGE_OFF' || kind === 'SESSIONS_ENDED' || kind === 'BADGE_RETURNED' ? 'FLOOR_SIGN_IN' : kind === 'ACCESS_ENDED' ? 'OFFICE_ACCOUNT' : kind === 'WORK_HANDED_OVER' ? 'OPEN_WORK' : kind === 'SHIFTS_CLEARED' ? 'SHIFTS' : kind === 'PAYROLL_FLAGGED' ? 'PAYROLL' : kind === 'PPE_RETURNED' ? 'PPE' : 'HEALTH',
  recordType: null,
  recordId: null,
  version: 1,
  ...over,
})

export const LEAVER: Leaver = {
  id: uid('3707', 1),
  employeeId: PEOPLE.marta.id,
  lastWorkingDay: '2026-11-30',
  status: 'OPEN',
  startedAt: '2026-10-29T10:00:00.000Z',
  startedBy: 'Anna Esempio',
  closedAt: null,
  cancelledAt: null,
  cancelReason: null,
  steps: [
    step(1, 'BADGE_OFF'),
    step(2, 'SESSIONS_ENDED'),
    step(3, 'BADGE_RETURNED'),
    step(4, 'WORK_HANDED_OVER', { status: 'DONE', doneAt: '2026-10-31T15:10:00.000Z', doneBy: { kind: 'USER', name: 'Anna Esempio' } }),
    step(5, 'SHIFTS_CLEARED'),
    step(6, 'PAYROLL_FLAGGED'),
    step(7, 'EXIT_VISIT', { status: 'SKIPPED', skipReason: 'Non prevista dal piano sanitario (esempio)' }),
  ],
  version: 3,
  employee: { id: PEOPLE.marta.id, name: PEOPLE.marta.name, displayName: PEOPLE.marta.displayName, employeeCode: PEOPLE.marta.employeeCode, kind: 'EMPLOYEE', site: SITE_N, companyId: COMPANY },
  openSteps: 5,
}

const sight = (over: Partial<Sight> = {}): SightState => ({ status: 'ready', sight: { siteId: SITE_N.id, purpose: 'PERFORMANCE', open: false, level: 'GROUPS_ONLY', minimumGroupSize: 3, leadsSeeFigures: false, ...over } })
export const SIGHT_OFF = sight()
export const SIGHT_HR = sight({ open: true })
export const SIGHT_REQUEST = sight({ open: true, level: 'ONE_PERSON_ON_REQUEST' })

// ---- one record --------------------------------------------------------------------------------------------------------------

export function recordOf(employee: Employee, over: Partial<EmployeeRecord> = {}): EmployeeRecord {
  return {
    employee,
    floorSignIns:
      employee.floor.signIns > 0
        ? [
            {
              workerId: uid('4111', 1),
              site: employee.site,
              displayName: employee.displayName,
              status: employee.status === 'LEFT' ? 'INACTIVE' : 'ACTIVE',
              badge: employee.floor.badge === 'ACTIVE' ? { state: 'ACTIVE', since: '2026-02-03T08:00:00.000Z', hint: '4F2A' } : { state: 'NONE', since: null, hint: null },
              pin: 'SET',
              lockedUntil: null,
              notice: employee.floor.notice === 'MISSING' ? { state: 'MISSING', label: null } : { state: 'ACKNOWLEDGED', label: 'v3 · 12/01/2026' },
              floorRoles: [{ key: 'operator', name: 'Operatore' }],
            },
          ]
        : [],
    officeAccount: employee.officeAccount ? { userId: uid('4212', 1), status: 'ACTIVE' } : null,
    nextSteps: [],
    loans: [],
    teamHistory: [],
    leaving: null,
    notKept: ['ADDRESS', 'TAX_CODE', 'IBAN', 'DATE_OF_BIRTH', 'PHOTO', 'HEALTH_DATA', 'BIOMETRICS'],
    lastChange: { at: '2026-10-28T08:12:00.000Z', by: 'Anna Esempio' },
    canManage: true,
    canLeave: true,
    today: TODAY,
    ...over,
  }
}
