import { z } from 'zod'
import { businessDate, defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { EMPLOYEE_CONTRACTS, EMPLOYEE_KINDS, EMPLOYEE_LIMITS, EMPLOYEE_ROWS, EMPLOYEE_STATUSES, EMPLOYEE_TILES, LIFECYCLES, NEXT_STEPS } from '@nexus/factory-domain/people/employees/rules'
import { LEAVER_CASE_STATUSES, LEAVER_STEP_KINDS, LEAVER_STEP_STATUSES, STEP_PLACES } from '@nexus/factory-domain/people/leavers/rules'

/**
 * The employee routes (B-W2b-26; MES-208, MES-209, MES-211; design people.employees SCR-084 list, SCR-085 record).
 * People: the HR register shows names; nothing here is a figure about one person's work, pay, attendance or health
 * (Statuto dei Lavoratori art. 4; GDPR art. 5(1)(c)). Dates are calendar days (YYYY-MM-DD), instants UTC.
 */

const version = () => z.number().int().min(1)
const name = () => z.string().trim().min(1).max(EMPLOYEE_LIMITS.name)
const text = () => z.string().trim().max(EMPLOYEE_LIMITS.text)
const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((value) => value.split(',').map((part) => part.trim()).filter((part) => part.length > 0))
    .pipe(z.array(z.enum(values)))

export const refOut = output({ id: id(), code: z.string(), name: z.string() })

export const employeeOut = output({
  id: id(),
  companyId: id(),
  companyCode: z.string(),
  site: refOut,
  employeeCode: z.string().nullable(),
  firstName: z.string(),
  lastName: z.string(),
  name: z.string(),
  displayName: z.string(),
  kind: z.enum(EMPLOYEE_KINDS),
  agency: refOut.nullable(),
  locale: z.string(),
  startDate: z.string(),
  endDate: z.string().nullable(),
  department: z.string().nullable(),
  jobRole: z.string().nullable(),
  homeLine: refOut.nullable(),
  team: output({ id: id(), code: z.string(), name: z.string(), since: z.string() }).nullable(),
  isLead: z.boolean(),
  lead: output({ employeeId: id(), name: z.string() }).nullable(),
  contract: z.enum(EMPLOYEE_CONTRACTS).nullable(),
  weeklyMinutes: z.number().int().nullable(),
  defaultShift: refOut.nullable(),
  floor: output({ signIns: z.number().int(), badge: z.enum(['ACTIVE', 'NONE']), notice: z.enum(['ACKNOWLEDGED', 'MISSING', 'NONE_IN_FORCE']).nullable() }),
  officeAccount: z.boolean(),
  status: z.enum(EMPLOYEE_STATUSES),
  lifecycle: z.enum(LIFECYCLES),
  leaving: output({ caseId: id(), lastWorkingDay: z.string(), openSteps: z.number().int() }).nullable(),
  version: z.number().int(),
  updatedAt: z.string(),
})

const tileCounts = output(Object.fromEntries(EMPLOYEE_TILES.map((tile) => [tile, z.number().int()])) as Record<(typeof EMPLOYEE_TILES)[number], z.ZodNumber>)

export const listEmployeesContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    companyId: id().optional(),
    /** A tile's saved filter (UNLINKED_WORKERS is GET /people/employees/unlinked-workers). */
    tile: z.enum(EMPLOYEE_TILES.filter((tile) => tile !== 'UNLINKED_WORKERS') as unknown as ['ACTIVE', 'STARTING', 'LEAVING', 'AGENCY_ENDING']).optional(),
    /** The toolbar's rows: AGENCY, LEAVING, MISSING_DATA (no employee code), LEFT, ALL (default: everyone not LEFT). */
    rows: z.enum(EMPLOYEE_ROWS).optional(),
    kind: csv(EMPLOYEE_KINDS).optional(),
    teamId: id().optional(),
    lineId: id().optional(),
    /** The name, the floor name or the employee code contains it. */
    q: z.string().trim().min(1).max(80).optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }),
  response: { 200: output({ employees: z.array(employeeOut), nextCursor: id().nullable(), today: z.string() }) },
})

export const employeeCountsContract = defineContract({
  querystring: input({ siteId: id().optional(), companyId: id().optional() }),
  response: {
    200: output({
      tiles: tileCounts,
      /** The data problems for the notice banner, most serious first (design "Notice"). */
      problems: z.array(output({ code: z.enum(['NOTICE_NOT_ACKNOWLEDGED', 'NO_EMPLOYEE_CODE', 'UNLINKED_WORKERS']), count: z.number().int() })),
    }),
  },
})

const workerOut = output({
  id: id(),
  site: refOut,
  displayName: z.string(),
  employeeCode: z.string().nullable(),
  locale: z.string(),
  status: z.enum(['ACTIVE', 'INACTIVE']),
  createdAt: z.string(),
})

export const unlinkedWorkersContract = defineContract({
  querystring: input({ siteId: id().optional(), companyId: id().optional() }),
  response: { 200: output({ workers: z.array(workerOut), complete: z.boolean() }) },
})

const stepOut = output({
  id: id(),
  kind: z.enum(LEAVER_STEP_KINDS),
  seq: z.number().int(),
  automatic: z.boolean(),
  dueOn: z.string().nullable(),
  status: z.enum(LEAVER_STEP_STATUSES),
  doneAt: z.string().nullable(),
  doneBy: output({ kind: z.enum(['USER', 'SYSTEM']), name: z.string().nullable() }).nullable(),
  skipReason: z.string().nullable(),
  place: z.enum(STEP_PLACES),
  recordType: z.string().nullable(),
  recordId: id().nullable(),
  version: z.number().int(),
})

export const leaverCaseOut = output({
  id: id(),
  employeeId: id(),
  lastWorkingDay: z.string(),
  status: z.enum(LEAVER_CASE_STATUSES),
  startedAt: z.string(),
  startedBy: z.string().nullable(),
  closedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  steps: z.array(stepOut),
  version: z.number().int(),
})

export const employeeRecordContract = defineContract({
  params: input({ employeeId: id() }),
  response: {
    200: output({
      employee: employeeOut,
      /** The floor identity, read only here (one edit path: Admin › Users). */
      floorSignIns: z.array(
        output({
          workerId: id(),
          site: refOut,
          displayName: z.string(),
          status: z.enum(['ACTIVE', 'INACTIVE']),
          badge: output({ state: z.enum(['ACTIVE', 'NONE']), since: z.string().nullable(), hint: z.string().nullable() }),
          pin: z.enum(['SET', 'MUST_CHANGE', 'LOCKED', 'NONE']),
          lockedUntil: z.string().nullable(),
          notice: output({ state: z.enum(['ACKNOWLEDGED', 'MISSING', 'NONE_IN_FORCE']), label: z.string().nullable() }),
          floorRoles: z.array(output({ key: z.string(), name: z.string() })),
        }),
      ),
      officeAccount: output({ userId: id(), status: z.string() }).nullable(),
      /** The side panel's next steps, most urgent first (words in the web). */
      nextSteps: z.array(output({ code: z.enum(NEXT_STEPS), days: z.number().int().nullable() })),
      loans: z.array(
        output({ id: id(), fromLine: refOut.nullable(), toLine: refOut, toTeam: refOut.nullable(), startsAt: z.string(), endsAt: z.string(), state: z.enum(['PLANNED', 'RUNNING', 'ENDED']), reason: z.string(), decidedBy: z.string().nullable(), version: z.number().int() }),
      ),
      teamHistory: z.array(output({ team: refOut, isLead: z.boolean(), since: z.string(), until: z.string().nullable() })),
      leaving: leaverCaseOut.nullable(),
      /** What Nexus never keeps of a person (design "What we do not keep"); the words are the web's. */
      notKept: z.array(z.enum(['ADDRESS', 'TAX_CODE', 'IBAN', 'DATE_OF_BIRTH', 'PHOTO', 'HEALTH_DATA', 'BIOMETRICS'])),
      lastChange: output({ at: z.string(), by: z.string().nullable() }).nullable(),
      canManage: z.boolean(),
      canLeave: z.boolean(),
      today: z.string(),
    }),
  },
})

const fields = {
  firstName: name(),
  lastName: name(),
  displayName: z.string().trim().min(1).max(EMPLOYEE_LIMITS.displayName),
  employeeCode: z.string().trim().max(EMPLOYEE_LIMITS.code).nullable(),
  kind: z.enum(EMPLOYEE_KINDS),
  agencyPartyId: id().nullable(),
  locale: z.string().trim().min(2).max(3),
  startDate: businessDate(),
  endDate: businessDate().nullable(),
  department: text().nullable(),
  jobRole: text().nullable(),
  homeLineId: id().nullable(),
  contract: z.enum(EMPLOYEE_CONTRACTS).nullable(),
  weeklyMinutes: z.number().int().nullable(),
  defaultShiftPatternId: id().nullable(),
}

const answer = { 200: output({ employee: employeeOut }), 201: output({ employee: employeeOut }) }

export const createEmployeeContract = defineContract({
  body: input({
    siteId: id(),
    firstName: fields.firstName,
    lastName: fields.lastName,
    displayName: fields.displayName.optional(),
    employeeCode: fields.employeeCode.optional(),
    kind: fields.kind.optional(),
    agencyPartyId: fields.agencyPartyId.optional(),
    locale: fields.locale.optional(),
    startDate: fields.startDate,
    endDate: fields.endDate.optional(),
    department: fields.department.optional(),
    jobRole: fields.jobRole.optional(),
    homeLineId: fields.homeLineId.optional(),
    contract: fields.contract.optional(),
    weeklyMinutes: fields.weeklyMinutes.optional(),
    defaultShiftPatternId: fields.defaultShiftPatternId.optional(),
  }),
  response: answer,
})

export const employeeFromWorkerContract = defineContract({
  body: input({
    workerId: id(),
    /** Default: read from the worker's floor name (first word, then the rest). */
    firstName: fields.firstName.optional(),
    lastName: fields.lastName.optional(),
    /** Default: the worker's employee code. */
    employeeCode: fields.employeeCode.optional(),
    kind: fields.kind.optional(),
    agencyPartyId: fields.agencyPartyId.optional(),
    /** Default: the day the worker was added. */
    startDate: fields.startDate.optional(),
    endDate: fields.endDate.optional(),
    department: fields.department.optional(),
    jobRole: fields.jobRole.optional(),
    homeLineId: fields.homeLineId.optional(),
    contract: fields.contract.optional(),
    weeklyMinutes: fields.weeklyMinutes.optional(),
  }),
  response: answer,
})

export const employeeFromUserContract = defineContract({
  body: input({
    userId: id(),
    siteId: id(),
    /** Default: read from the user's name (first word, then the rest). */
    firstName: fields.firstName.optional(),
    lastName: fields.lastName.optional(),
    displayName: fields.displayName.optional(),
    employeeCode: fields.employeeCode.optional(),
    kind: fields.kind.optional(),
    agencyPartyId: fields.agencyPartyId.optional(),
    startDate: fields.startDate,
    endDate: fields.endDate.optional(),
    department: fields.department.optional(),
    jobRole: fields.jobRole.optional(),
    contract: fields.contract.optional(),
    weeklyMinutes: fields.weeklyMinutes.optional(),
  }),
  response: answer,
})

export const updateEmployeeContract = defineContract({
  params: input({ employeeId: id() }),
  body: input({
    version: version(),
    firstName: fields.firstName.optional(),
    lastName: fields.lastName.optional(),
    displayName: fields.displayName.optional(),
    employeeCode: fields.employeeCode.optional(),
    kind: fields.kind.optional(),
    agencyPartyId: fields.agencyPartyId.optional(),
    locale: fields.locale.optional(),
    startDate: fields.startDate.optional(),
    endDate: fields.endDate.optional(),
    department: fields.department.optional(),
    jobRole: fields.jobRole.optional(),
    /** A move to another site of the same company: the home line is cleared unless one of the new site is given, the team membership ends. */
    siteId: id().optional(),
    homeLineId: fields.homeLineId.optional(),
    contract: fields.contract.optional(),
    weeklyMinutes: fields.weeklyMinutes.optional(),
    defaultShiftPatternId: fields.defaultShiftPatternId.optional(),
    reason: z.string().trim().min(1).max(EMPLOYEE_LIMITS.reason).optional(),
  }),
  response: { 200: output({ employee: employeeOut }) },
})

export const linkWorkerContract = defineContract({
  params: input({ employeeId: id() }),
  body: input({ version: version(), workerId: id() }),
  response: { 200: output({ employee: employeeOut }) },
})

export const unlinkWorkerContract = defineContract({
  params: input({ employeeId: id(), workerId: id() }),
  body: input({ version: version(), reason: z.string().trim().min(1).max(EMPLOYEE_LIMITS.reason) }),
  response: { 200: output({ employee: employeeOut }) },
})

export const setAccountContract = defineContract({
  params: input({ employeeId: id() }),
  body: input({ version: version(), userId: id().nullable() }),
  response: { 200: output({ employee: employeeOut }) },
})

export const importMissingContract = defineContract({
  params: input({ jobId: id() }),
  response: {
    200: output({
      jobId: id(),
      /** Active records of the job's company with an employee code the file does not have ("mark as leaving?"). */
      missing: z.array(output({ id: id(), employeeCode: z.string(), name: z.string(), site: refOut, leaving: z.boolean() })),
    }),
  },
})

