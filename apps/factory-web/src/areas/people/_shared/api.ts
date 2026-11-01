import { z } from 'zod'
import { EMPLOYEE_CONTRACTS, EMPLOYEE_KINDS, EMPLOYEE_ROWS, EMPLOYEE_STATUSES, EMPLOYEE_TILES, LIFECYCLES, NEXT_STEPS } from '@nexus/factory-domain/people/employees/rules'
import { LEAVER_CASE_STATUSES, LEAVER_STEP_KINDS, LEAVER_STEP_STATUSES, STEP_PLACES } from '@nexus/factory-domain/people/leavers/rules'
import { LOAN_STATES, MOVE_CONFLICTS } from '@nexus/factory-domain/people/teams/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * Every call of People › Employees (B-W2b-55 on the API of B-W2b-26 employees, teams, loans, leavers and B-W2b-27 the
 * privacy note), with the answer's shape checked (zod; unknown fields are dropped). The HR register holds names, job,
 * team and contract: no pay, attendance, health or per-person work figure exists in any answer read here (Statuto dei
 * Lavoratori art. 4; GDPR art. 5(1)(c)). Every write is one command with its own Idempotency-Key and the version the
 * screen read. The API's English is never drawn: the screens say their own words from codes (`refusal/<CODE>`).
 */

export type EmployeeKind = (typeof EMPLOYEE_KINDS)[number]
export type EmployeeContract = (typeof EMPLOYEE_CONTRACTS)[number]
export type Lifecycle = (typeof LIFECYCLES)[number]
export type EmployeeTile = (typeof EMPLOYEE_TILES)[number]
export type EmployeeRows = (typeof EMPLOYEE_ROWS)[number]
export type NextStep = (typeof NEXT_STEPS)[number]
export type LeaverStepKind = (typeof LEAVER_STEP_KINDS)[number]
export type LeaverStepStatus = (typeof LEAVER_STEP_STATUSES)[number]
export type StepPlace = (typeof STEP_PLACES)[number]
export type LoanState = (typeof LOAN_STATES)[number]
export type MoveConflict = (typeof MOVE_CONFLICTS)[number]

export { EMPLOYEE_CONTRACTS, EMPLOYEE_KINDS, EMPLOYEE_ROWS, EMPLOYEE_TILES, LEAVER_STEP_KINDS, LIFECYCLES, NEXT_STEPS }

type Query = Record<string, string | number | boolean | null | undefined>
const seg = (value: string) => encodeURIComponent(value)
const clean = (query: Query): Query => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ''))

const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
export type Ref = z.infer<typeof ref>

// ---- employees -------------------------------------------------------------------------------------------------------------

const employeeSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  companyCode: z.string(),
  site: ref,
  employeeCode: z.string().nullable(),
  firstName: z.string(),
  lastName: z.string(),
  name: z.string(),
  displayName: z.string(),
  kind: z.enum(EMPLOYEE_KINDS),
  agency: ref.nullable(),
  locale: z.string(),
  startDate: z.string(),
  endDate: z.string().nullable(),
  department: z.string().nullable(),
  jobRole: z.string().nullable(),
  homeLine: ref.nullable(),
  team: z.object({ id: z.string(), code: z.string(), name: z.string(), since: z.string() }).nullable(),
  isLead: z.boolean(),
  lead: z.object({ employeeId: z.string(), name: z.string() }).nullable(),
  contract: z.enum(EMPLOYEE_CONTRACTS).nullable(),
  weeklyMinutes: z.number().nullable(),
  defaultShift: ref.nullable(),
  floor: z.object({ signIns: z.number(), badge: z.enum(['ACTIVE', 'NONE']), notice: z.enum(['ACKNOWLEDGED', 'MISSING', 'NONE_IN_FORCE']).nullable() }),
  officeAccount: z.boolean(),
  status: z.enum(EMPLOYEE_STATUSES),
  lifecycle: z.enum(LIFECYCLES),
  leaving: z.object({ caseId: z.string(), lastWorkingDay: z.string(), openSteps: z.number() }).nullable(),
  version: z.number(),
  updatedAt: z.string(),
})
export type Employee = z.infer<typeof employeeSchema>

export interface EmployeesQuery {
  siteId?: string | null
  tile?: Exclude<EmployeeTile, 'UNLINKED_WORKERS'> | null
  rows?: EmployeeRows | null
  teamId?: string | null
  lineId?: string | null
  q?: string | null
  cursor?: string | null
  limit?: number
}

const employeePage = z.object({ employees: z.array(employeeSchema), nextCursor: z.string().nullable(), today: z.string() })
export type EmployeePage = z.infer<typeof employeePage>

export const listEmployees = (api: ApiClient, query: EmployeesQuery) =>
  api.get('/people/employees', { query: clean({ siteId: query.siteId, tile: query.tile, rows: query.rows, teamId: query.teamId, lineId: query.lineId, q: query.q?.trim(), cursor: query.cursor, limit: query.limit }), schema: employeePage })

const countsSchema = z.object({
  tiles: z.object(Object.fromEntries(EMPLOYEE_TILES.map((tile) => [tile, z.number()])) as Record<EmployeeTile, z.ZodNumber>),
  problems: z.array(z.object({ code: z.enum(['NOTICE_NOT_ACKNOWLEDGED', 'NO_EMPLOYEE_CODE', 'UNLINKED_WORKERS']), count: z.number() })),
})
export type EmployeeCounts = z.infer<typeof countsSchema>
export type DataProblem = EmployeeCounts['problems'][number]

export const employeeCounts = (api: ApiClient, siteId: string | null) => api.get('/people/employees/counts', { query: clean({ siteId }), schema: countsSchema })

const workerSchema = z.object({ id: z.string(), site: ref, displayName: z.string(), employeeCode: z.string().nullable(), locale: z.string(), status: z.enum(['ACTIVE', 'INACTIVE']), createdAt: z.string() })
export type UnlinkedWorker = z.infer<typeof workerSchema>

export const unlinkedWorkers = (api: ApiClient, siteId: string | null) =>
  api.get('/people/employees/unlinked-workers', { query: clean({ siteId }), schema: z.object({ workers: z.array(workerSchema), complete: z.boolean() }) })

const stepSchema = z.object({
  id: z.string(),
  kind: z.enum(LEAVER_STEP_KINDS),
  seq: z.number(),
  automatic: z.boolean(),
  dueOn: z.string().nullable(),
  status: z.enum(LEAVER_STEP_STATUSES),
  doneAt: z.string().nullable(),
  doneBy: z.object({ kind: z.enum(['USER', 'SYSTEM']), name: z.string().nullable() }).nullable(),
  skipReason: z.string().nullable(),
  place: z.enum(STEP_PLACES),
  recordType: z.string().nullable(),
  recordId: z.string().nullable(),
  version: z.number(),
})
export type LeaverStep = z.infer<typeof stepSchema>

const caseSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  lastWorkingDay: z.string(),
  status: z.enum(LEAVER_CASE_STATUSES),
  startedAt: z.string(),
  startedBy: z.string().nullable(),
  closedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  steps: z.array(stepSchema),
  version: z.number(),
})
export type LeaverCase = z.infer<typeof caseSchema>

const loanSchema = z.object({
  id: z.string(),
  fromLine: ref.nullable(),
  toLine: ref,
  toTeam: ref.nullable(),
  startsAt: z.string(),
  endsAt: z.string(),
  state: z.enum(LOAN_STATES),
  reason: z.string(),
  decidedBy: z.string().nullable(),
  version: z.number(),
})
export type EmployeeLoan = z.infer<typeof loanSchema>

const recordSchema = z.object({
  employee: employeeSchema,
  floorSignIns: z.array(
    z.object({
      workerId: z.string(),
      site: ref,
      displayName: z.string(),
      status: z.enum(['ACTIVE', 'INACTIVE']),
      badge: z.object({ state: z.enum(['ACTIVE', 'NONE']), since: z.string().nullable(), hint: z.string().nullable() }),
      pin: z.enum(['SET', 'MUST_CHANGE', 'LOCKED', 'NONE']),
      lockedUntil: z.string().nullable(),
      notice: z.object({ state: z.enum(['ACKNOWLEDGED', 'MISSING', 'NONE_IN_FORCE']), label: z.string().nullable() }),
      floorRoles: z.array(z.object({ key: z.string(), name: z.string() })),
    }),
  ),
  officeAccount: z.object({ userId: z.string(), status: z.string() }).nullable(),
  nextSteps: z.array(z.object({ code: z.enum(NEXT_STEPS), days: z.number().nullable() })),
  loans: z.array(loanSchema),
  teamHistory: z.array(z.object({ team: ref, isLead: z.boolean(), since: z.string(), until: z.string().nullable() })),
  leaving: caseSchema.nullable(),
  notKept: z.array(z.enum(['ADDRESS', 'TAX_CODE', 'IBAN', 'DATE_OF_BIRTH', 'PHOTO', 'HEALTH_DATA', 'BIOMETRICS'])),
  lastChange: z.object({ at: z.string(), by: z.string().nullable() }).nullable(),
  canManage: z.boolean(),
  canLeave: z.boolean(),
  today: z.string(),
})
export type EmployeeRecord = z.infer<typeof recordSchema>
export type FloorSignIn = EmployeeRecord['floorSignIns'][number]

export const getEmployee = (api: ApiClient, id: string) => api.get(`/people/employees/${seg(id)}`, { schema: recordSchema })

const oneEmployee = z.object({ employee: employeeSchema })

/** The fields a person types (New employee, the record's edit); absent = unchanged. */
export interface EmployeeFields {
  firstName?: string
  lastName?: string
  displayName?: string
  employeeCode?: string | null
  kind?: EmployeeKind
  agencyPartyId?: string | null
  locale?: string
  startDate?: string
  endDate?: string | null
  department?: string | null
  jobRole?: string | null
  homeLineId?: string | null
  contract?: EmployeeContract | null
  weeklyMinutes?: number | null
}

export const createEmployee = (api: ApiClient, body: EmployeeFields & { siteId: string; firstName: string; lastName: string; startDate: string }) =>
  api.post('/people/employees', { body, schema: oneEmployee, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.employee)

export const employeeFromWorker = (api: ApiClient, body: { workerId: string }) =>
  api.post('/people/employees/from-worker', { body, schema: oneEmployee, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.employee)

export const updateEmployee = (api: ApiClient, id: string, body: EmployeeFields & { version: number; siteId?: string; reason?: string }) =>
  api.request('PATCH', `/people/employees/${seg(id)}`, { body, schema: oneEmployee, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.employee)

export const linkWorker = (api: ApiClient, id: string, body: { version: number; workerId: string }) =>
  api.post(`/people/employees/${seg(id)}/workers`, { body, schema: oneEmployee, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.employee)

/** A floor sign-in (W0 Admin › Users, workers.manage): the badge and PIN are set there, with a fresh code. */
export const createFloorWorker = (api: ApiClient, body: { siteId: string; displayName: string; locale?: string; employeeCode?: string }) =>
  api.post('/auth/floor/workers', { body, schema: z.object({ id: z.string() }).passthrough(), idempotencyKey: newIdempotencyKey() })

export const importMissing = (api: ApiClient, jobId: string) =>
  api.get(`/people/employees/import/${seg(jobId)}/missing`, { schema: z.object({ jobId: z.string(), missing: z.array(z.object({ id: z.string(), employeeCode: z.string(), name: z.string(), site: ref, leaving: z.boolean() })) }) })
export type MissingEmployee = Awaited<ReturnType<typeof importMissing>>['missing'][number]

// ---- teams and loans -------------------------------------------------------------------------------------------------------

const memberSchema = z.object({
  employeeId: z.string(),
  name: z.string(),
  displayName: z.string(),
  isLead: z.boolean(),
  since: z.string(),
  onLoan: z.object({ loanId: z.string(), toLine: ref, until: z.string() }).nullable(),
})
export type TeamMember = z.infer<typeof memberSchema>

const teamSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  site: ref,
  line: ref.nullable(),
  code: z.string(),
  name: z.string(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  lead: z.object({ employeeId: z.string(), name: z.string() }).nullable(),
  members: z.array(memberSchema),
  loansIn: z.array(z.object({ loanId: z.string(), employeeId: z.string(), name: z.string(), fromLine: ref.nullable(), startsAt: z.string(), until: z.string() })),
  version: z.number(),
})
export type Team = z.infer<typeof teamSchema>

export const listTeams = (api: ApiClient, siteId: string | null) => api.get('/people/teams', { query: clean({ siteId }), schema: z.object({ teams: z.array(teamSchema), today: z.string() }) })

export const myTeams = (api: ApiClient) =>
  api.get('/people/teams/mine', { schema: z.object({ employeeId: z.string().nullable(), teams: z.array(teamSchema.extend({ mine: z.enum(['LEAD', 'MEMBER']) })), today: z.string() }) })
export type MyTeams = Awaited<ReturnType<typeof myTeams>>

const oneTeam = z.object({ team: teamSchema })
export const createTeam = (api: ApiClient, body: { siteId: string; lineId?: string | null; code: string; name: string }) =>
  api.post('/people/teams', { body, schema: oneTeam, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.team)
export const setTeamLead = (api: ApiClient, teamId: string, body: { version: number; employeeId: string | null }) =>
  api.request('PUT', `/people/teams/${seg(teamId)}/lead`, { body, schema: oneTeam, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.team)
export const archiveTeam = (api: ApiClient, teamId: string, body: { version: number }) =>
  api.post(`/people/teams/${seg(teamId)}/archive`, { body, schema: oneTeam, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.team)

export interface Move {
  employeeId: string
  teamId: string | null
}

const moveRow = z.object({
  employeeId: z.string(),
  name: z.string().nullable(),
  from: z.object({ team: ref, lead: z.string().nullable() }).nullable(),
  to: z.object({ team: ref, lead: z.string().nullable() }).nullable(),
  change: z.enum(['NONE', 'MOVE']),
  conflict: z.enum(MOVE_CONFLICTS).nullable(),
  leavesLead: z.boolean(),
})
export type MoveRow = z.infer<typeof moveRow>

export const previewMoves = (api: ApiClient, moves: readonly Move[]) =>
  api.post('/people/teams/moves/preview', { body: { moves }, schema: z.object({ rows: z.array(moveRow), moving: z.number(), conflicts: z.number() }) })
export const applyMoves = (api: ApiClient, moves: readonly Move[], idempotencyKey: string, reason?: string) =>
  api.post('/people/teams/moves', { body: { moves, ...(reason ? { reason } : {}) }, schema: z.object({ rows: z.array(moveRow), moved: z.number(), teams: z.array(z.string()) }), idempotencyKey })

const loanOut = loanSchema.extend({ site: ref, employeeId: z.string(), name: z.string() })
export type Loan = z.infer<typeof loanOut>

export const listLoans = (api: ApiClient, query: { siteId?: string | null; employeeId?: string | null; lineId?: string | null }) =>
  api.get('/people/loans', { query: clean({ siteId: query.siteId, employeeId: query.employeeId, lineId: query.lineId }), schema: z.object({ loans: z.array(loanOut), date: z.string() }) })
export const createLoan = (api: ApiClient, body: { employeeId: string; toLineId: string; toTeamId?: string | null; startsAt: string; endsAt: string; reason: string }) =>
  api.post('/people/loans', { body, schema: z.object({ loan: loanOut }), idempotencyKey: newIdempotencyKey() }).then((answer) => answer.loan)
export const endLoan = (api: ApiClient, loanId: string, body: { version: number }) =>
  api.post(`/people/loans/${seg(loanId)}/end`, { body, schema: z.object({ loan: loanOut }), idempotencyKey: newIdempotencyKey() }).then((answer) => answer.loan)
export const removeLoan = (api: ApiClient, loanId: string, body: { version: number }) =>
  api.post(`/people/loans/${seg(loanId)}/remove`, { body, schema: z.object({ removed: z.string() }), idempotencyKey: newIdempotencyKey() })

// ---- the lines a person may be lent to -------------------------------------------------------------------------------------

/** A line of a site, with its teams (the loan dialog and the home line). */
export interface SiteLine extends Ref {
  siteId: string
  teams: Ref[]
}

const treeLine = z.object({ id: z.string(), code: z.string(), name: z.string(), status: z.string(), teams: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })) })

/** The lines of the sites in reach from the org tree (sites.view: Admin › Companies & sites keeps them). */
export async function linesFromTree(api: ApiClient, siteId: string | null): Promise<SiteLine[]> {
  const answer = await api.get('/org/tree', {
    query: clean({ siteId }),
    schema: z.object({ sites: z.array(z.object({ id: z.string(), areas: z.array(z.object({ lines: z.array(treeLine) })), linesWithoutArea: z.array(treeLine) })) }),
  })
  return answer.sites.flatMap((site) =>
    [...site.areas.flatMap((area) => area.lines), ...site.linesWithoutArea].filter((line) => line.status === 'ACTIVE').map((line) => ({ id: line.id, code: line.code, name: line.name, siteId: site.id, teams: line.teams })),
  )
}

/** The lines of the floor (workorders.view: Production reports' lines), for a person without sites.view. */
export async function linesFromFloor(api: ApiClient, siteId: string | null): Promise<SiteLine[]> {
  const answer = await api.get('/production/reports/lines', { query: clean({ siteId }), schema: z.object({ lines: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), site: z.object({ id: z.string() }) })) }) })
  return answer.lines.map((line) => ({ id: line.id, code: line.code, name: line.name, siteId: line.site.id, teams: [] }))
}

/** "Can do 3 of 5 operations on line B" (people.skills.view; B-W2b-39): never a figure about work, only what is signed off. */
export const lineCheck = (api: ApiClient, employeeId: string, lineId: string) =>
  api.get('/people/skills/line-check', { query: { employeeId, lineId }, schema: z.object({ line: ref, canDo: z.number(), asTrainee: z.number(), kept: z.number(), notKept: z.number() }) })
export type LineCheck = Awaited<ReturnType<typeof lineCheck>>

// ---- leavers ---------------------------------------------------------------------------------------------------------------

const leaverSchema = caseSchema.extend({
  employee: z.object({ id: z.string(), name: z.string(), displayName: z.string(), employeeCode: z.string().nullable(), kind: z.enum(EMPLOYEE_KINDS), site: ref, companyId: z.string() }),
  openSteps: z.number(),
})
export type Leaver = z.infer<typeof leaverSchema>

export const listLeavers = (api: ApiClient, siteId: string | null) => api.get('/people/leavers', { query: clean({ view: 'open', siteId }), schema: z.object({ leavers: z.array(leaverSchema), today: z.string() }) })

const previewSchema = z.object({
  steps: z.array(z.object({ kind: z.enum(LEAVER_STEP_KINDS), seq: z.number(), automatic: z.boolean(), dueOn: z.string().nullable() })),
  consequences: z.object({ floorSignIns: z.number(), activeBadges: z.number(), officeAccount: z.boolean(), openTasks: z.number(), openMaintenanceJobs: z.number(), shiftsAfter: z.number(), loansAfter: z.number() }),
  refusal: z.object({ code: z.string(), message: z.string() }).nullable(),
})
export type LeavingPreview = z.infer<typeof previewSchema>

export const leavingPreview = (api: ApiClient, employeeId: string, lastWorkingDay: string, exitVisit: boolean) =>
  api.get(`/people/employees/${seg(employeeId)}/leaving/preview`, { query: { lastWorkingDay, exitVisit: exitVisit ? 'true' : 'false' }, schema: previewSchema })
export const startLeaving = (api: ApiClient, employeeId: string, body: { lastWorkingDay: string; exitVisit?: boolean; ppeReturn?: boolean }) =>
  api.post(`/people/employees/${seg(employeeId)}/leaving`, { body, schema: z.object({ leaver: leaverSchema }), idempotencyKey: newIdempotencyKey() }).then((answer) => answer.leaver)
export const stepDone = (api: ApiClient, caseId: string, stepId: string, body: { version: number }) =>
  api.post(`/people/leavers/${seg(caseId)}/steps/${seg(stepId)}/done`, { body, schema: z.object({ leaver: leaverSchema }), idempotencyKey: newIdempotencyKey() }).then((answer) => answer.leaver)
export const stepSkip = (api: ApiClient, caseId: string, stepId: string, body: { version: number; reason: string }) =>
  api.post(`/people/leavers/${seg(caseId)}/steps/${seg(stepId)}/skip`, { body, schema: z.object({ leaver: leaverSchema }), idempotencyKey: newIdempotencyKey() }).then((answer) => answer.leaver)
export const cancelLeaving = (api: ApiClient, caseId: string, body: { version: number; reason: string }) =>
  api.post(`/people/leavers/${seg(caseId)}/cancel`, { body, schema: z.object({ leaver: leaverSchema }), idempotencyKey: newIdempotencyKey() }).then((answer) => answer.leaver)

// ---- privacy (B-W2b-27) and the record's history --------------------------------------------------------------------------

const sightSchema = z.object({ siteId: z.string(), purpose: z.enum(['ATTENDANCE', 'PERFORMANCE']), open: z.boolean(), level: z.enum(['GROUPS_ONLY', 'ONE_PERSON_ON_REQUEST']), minimumGroupSize: z.number(), leadsSeeFigures: z.boolean() })
export type Sight = z.infer<typeof sightSchema>

/** "What you see here" (any office person, a site their roles reach): read before a People page reads any person. */
export const whatYouSee = (api: ApiClient, siteId: string) => api.get('/people/privacy/what-you-see', { query: { siteId, purpose: 'PERFORMANCE' }, schema: sightSchema })

const auditEntry = z.object({ id: z.string(), at: z.string(), audience: z.string(), action: z.string(), actorName: z.string().nullable(), before: z.unknown(), after: z.unknown(), reason: z.string().nullable() })
export type AuditEntry = z.infer<typeof auditEntry>

/** The record's own audit (audit.read): every change with before → after, who, when, why. */
export const employeeAudit = (api: ApiClient, employeeId: string) =>
  api.get('/audit', { query: { recordType: 'Employee', recordId: employeeId, limit: 100 }, schema: z.object({ entries: z.array(auditEntry) }) }).then((answer) => answer.entries)

/** An agency (an organisation party: parties.view). */
export const findAgencies = (api: ApiClient, q: string) =>
  api
    .get('/parties', { query: clean({ q: q.trim(), kind: 'ORGANISATION', limit: 20 }), schema: z.object({ parties: z.array(z.object({ id: z.string(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable() })) }) })
    .then((answer) => answer.parties.map((party) => ({ id: party.id, code: party.code, name: party.tradeName ?? party.legalName })))
