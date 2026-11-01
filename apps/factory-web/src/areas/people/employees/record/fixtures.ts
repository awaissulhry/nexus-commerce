import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canAs, inShell, LEAVER, LINE_A, LINE_B, LINES, ORIGIN, PEOPLE, PREFIX, recordOf, SIGHT_OFF, TEAMS, type PeopleRole } from '../../_shared/fixtures'
import { personOf, type EditDraft, type EmployeeRecordModel, type EmployeeTab } from '../view-model'
import { EmployeeRecordView } from './view/EmployeeRecordView'

/**
 * SCR-085 — an employee (People › Employees › record) with made-up data only: Profile (Identity read and in its edit,
 * the code refused at its field, What we do not keep, the floor sign-in, the side panel with the next steps and an agency
 * contract's countdown), Job & team (the job's edit, loans planned / running / ended), Documents, Activity (changes and
 * a view of protected data; held without audit.read), a person leaving with the steps in the side panel, a person who
 * left, the pop-ups from the band, and the record's states.
 */

interface RecordCase {
  role: PeopleRole
  record: EmployeeRecordModel
}

const ion = recordOf(PEOPLE.ion, { nextSteps: [{ code: 'AGENCY_ENDING', days: 18 }] })
const sara = recordOf(PEOPLE.sara, {
  nextSteps: [{ code: 'NOTICE_NOT_ACKNOWLEDGED', days: null }],
  loans: [
    { id: 'loan-1', fromLine: { id: LINE_B.id, code: LINE_B.code, name: LINE_B.name }, toLine: { id: LINE_A.id, code: LINE_A.code, name: LINE_A.name }, toTeam: { id: TEAMS[0]!.id, code: TEAMS[0]!.code, name: TEAMS[0]!.name }, startsAt: '2026-11-02T07:00:00.000Z', endsAt: '2026-11-02T17:00:00.000Z', state: 'RUNNING', reason: 'Picco sulla linea giacche', decidedBy: 'Anna Esempio', version: 1 },
    { id: 'loan-2', fromLine: { id: LINE_B.id, code: LINE_B.code, name: LINE_B.name }, toLine: { id: LINE_A.id, code: LINE_A.code, name: LINE_A.name }, toTeam: null, startsAt: '2026-11-05T07:00:00.000Z', endsAt: '2026-11-05T13:00:00.000Z', state: 'PLANNED', reason: 'Affiancamento', decidedBy: 'Anna Esempio', version: 1 },
    { id: 'loan-3', fromLine: { id: LINE_B.id, code: LINE_B.code, name: LINE_B.name }, toLine: { id: LINE_A.id, code: LINE_A.code, name: LINE_A.name }, toTeam: null, startsAt: '2026-10-12T07:00:00.000Z', endsAt: '2026-10-12T15:00:00.000Z', state: 'ENDED', reason: 'Assenze in linea', decidedBy: 'Marco Prova', version: 2 },
  ],
})
const marta = recordOf(PEOPLE.marta, { nextSteps: [{ code: 'LEAVING', days: 28 }], leaving: { ...LEAVER } })
const elena = recordOf(PEOPLE.elena, { nextSteps: [{ code: 'NO_EMPLOYEE_CODE', days: null }] })

const draftOf = (over: Partial<EditDraft> = {}): EditDraft => ({
  firstName: PEOPLE.paolo.firstName,
  lastName: PEOPLE.paolo.lastName,
  displayName: PEOPLE.paolo.displayName,
  employeeCode: PEOPLE.paolo.employeeCode ?? '',
  kind: 'EMPLOYEE',
  agency: null,
  locale: 'it',
  startDate: PEOPLE.paolo.startDate,
  endDate: '',
  department: PEOPLE.paolo.department ?? '',
  jobRole: PEOPLE.paolo.jobRole ?? '',
  homeLineId: LINE_A.id,
  contract: 'FULL_TIME',
  hours: '40',
  ...over,
})

function record(role: PeopleRole, value = recordOf(PEOPLE.paolo), tab: EmployeeTab = 'profile', over: Partial<EmployeeRecordModel> = {}): RecordCase {
  return {
    role,
    record: {
      prefix: PREFIX,
      origin: ORIGIN,
      can: canAs(role),
      tab,
      loaded: { status: 'ready', value },
      sight: SIGHT_OFF,
      asOf: '2026-11-02T09:42:00.000Z',
      live: 'live',
      edit: null,
      lines: LINES,
      agencies: null,
      teams: TEAMS,
      audit: {
        items: [
          { id: 'a1', at: '2026-10-28T08:12:00.000Z', audience: 'OFFICE', action: 'people.updateEmployee', actorName: 'Anna Esempio', before: { jobRole: 'Cucitore' }, after: { jobRole: 'Tagliatore' }, reason: null },
          { id: 'a2', at: '2026-10-20T10:05:00.000Z', audience: 'OFFICE', action: 'people.openPersonFigures', actorName: 'Anna Esempio', before: null, after: { purpose: 'PERFORMANCE' }, reason: 'Il lavoratore ha chiesto un chiarimento (esempio)' },
          { id: 'a3', at: '2024-02-05T08:00:00.000Z', audience: 'OFFICE', action: 'people.createEmployee', actorName: 'Anna Esempio', before: null, after: { firstName: 'Paolo', lastName: 'Prova' }, reason: null },
        ],
        problem: null,
      },
      dialog: null,
      notice: null,
      neighbours: { prev: PEOPLE.giulia.id, next: PEOPLE.sara.id },
      timeZone: 'Europe/Rome',
      ...over,
    },
  }
}

function RecordDesign({ model }: { model: RecordCase }) {
  return inShell('/people/employees/x1', createElement(EmployeeRecordView, { model: model.record }), model.role)
}

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-085',
  title: 'Employee record & badge',
  view: RecordDesign,
  cases: [
    { id: 'profile', label: 'Profile: identity, what we do not keep, the floor sign-in, the side panel', model: record('hr'), note: 'J / K open the next / previous employee.' },
    { id: 'profile-edit', label: 'Profile: Identity in its edit (⌘S applies)', model: record('hr', undefined, 'profile', { edit: { section: 'identity', draft: draftOf({ displayName: 'Paolo P.' }), busy: false, problem: null, field: null, codeTaken: false } }) },
    { id: 'profile-code-taken', label: 'Profile: the employee code refused at its field', model: record('hr', undefined, 'profile', { edit: { section: 'identity', draft: draftOf({ employeeCode: 'D-0003' }), busy: false, problem: { key: 'refusal.CODE_TAKEN' }, field: 'employeeCode', codeTaken: true } }) },
    { id: 'agency', label: 'An agency worker: the contract end counting down', model: record('hr', ion) },
    { id: 'no-signin', label: 'No floor sign-in yet: "Create floor sign-in"; no employee code', model: record('hr', elena) },
    { id: 'notice-missing', label: 'Notice not acknowledged: scans will be refused (next step)', model: record('hr', sara) },
    { id: 'leaving', label: 'Leaving: the steps in the side panel, Cancel leaving', model: record('hr', marta) },
    { id: 'left', label: 'A person who left: nothing changes any more', model: record('hr', recordOf(PEOPLE.rita)) },
    { id: 'job', label: 'Job & team: the job, loans running, planned and ended', model: record('hr', sara, 'job') },
    { id: 'job-edit', label: 'Job & team: the job in its edit', model: record('hr', sara, 'job', { edit: { section: 'job', draft: draftOf({ homeLineId: LINE_B.id, contract: 'PART_TIME', hours: '25' }), busy: false, problem: null, field: null, codeTaken: false } }) },
    { id: 'documents', label: 'Documents: the notice acknowledged, no payslips, upload held with why', model: record('hr', undefined, 'documents') },
    { id: 'activity', label: 'Activity: changes and a view of protected data', model: record('hr', undefined, 'activity') },
    { id: 'activity-held', label: 'Activity without audit.read (production manager)', model: record('production', undefined, 'activity') },
    { id: 'loan', label: 'Loan to another line from the band', model: record('hr', undefined, 'job', { dialog: { kind: 'loan', person: personOf(PEOPLE.paolo), toLineId: null, toTeamId: null, startsAt: '2026-11-02T09:45:00.000Z', endsAt: '2026-11-02T17:00:00.000Z', reason: '', check: null, busy: false, problem: null, field: null } }) },
    { id: 'badge', label: 'Print badge: the badge face', model: record('hr', undefined, 'profile', { dialog: { kind: 'badges', people: [personOf(PEOPLE.paolo)] } }) },
    { id: 'supervisor', label: 'Floor supervisor: reads; edits held, loans allowed', model: record('supervisor') },
    { id: 'loading', label: 'Loading', model: record('hr', undefined, 'profile', { loaded: { status: 'loading' }, sight: { status: 'loading' } }) },
    { id: 'error', label: "The record couldn't be read", model: record('hr', undefined, 'profile', { loaded: { status: 'error', problem: 'problem.unavailable' } }) },
    { id: 'not-found', label: 'Not found', model: record('hr', undefined, 'profile', { loaded: { status: 'notFound' } }) },
    { id: 'forbidden', label: 'No people.view (sales)', model: record('sales', undefined, 'profile', { loaded: { status: 'forbidden' } }) },
  ],
})
