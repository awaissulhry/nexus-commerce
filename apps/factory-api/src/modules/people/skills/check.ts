import type { FactoryClient } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PEOPLE_SKILLS_VIEW } from '@nexus/factory-domain/people/skills/permissions'
import {
  assignmentOutcome,
  lineSkillsOf,
  qualificationOf,
  type HeldLevel,
  type MachineNeed,
  type OperationNeed,
  type QualificationFinding,
  type QualificationResult,
  type SkillNeed,
} from '@nexus/factory-domain/people/skills/qualification'
import type { SkillLevel } from '@nexus/factory-domain/people/skills/rules'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf, type FloorContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { assertMay, dayOf, dayOrNull, officeOf } from '../employees/access'
import { qualificationRuleFor, type QualificationRule } from './rule'

/**
 * qualificationCheck(employee, operation, machine) (B-W2b-39; MES-024, MES-246; design floor.operation "Checks before it
 * counts" and production.dispatch "assign"): THE check dispatch and the tablet call. It reads, in the caller's own scope
 * (an office client, a floor client: the floor reads its site's levels and authorisations, never who decided), what one
 * person holds against what one operation on one machine (or at one station) needs, and the site's rule (./rule.ts), and
 * answers with factory-domain people/skills/qualification's decision: ALLOW, WARN or HOLD, with the words.
 *
 * For the other modules (import from here; nothing else of this folder):
 *   qualificationCheck(db, input, options?)   the check (db: a scoped client or a command's transaction)
 *   assertAssignable(check, overrideReason)    dispatch (B-W2b-49) inside its assign command: the override to keep on
 *                                              DispatchAssignment (overrideReason / overrideById), or 409
 *                                              `refusal/NOT_QUALIFIED` | `NOT_AUTHORISED` | `OVERRIDE_REASON_NEEDED`
 *   qualificationGuard(check)                  the tablet (B-W2b-46's scan guards / B-W2b-69): null, or the finding to
 *                                              add as a guard of kind QUALIFICATION (mode WARN | STRICT, overridable by
 *                                              the team leader's PIN and a reason only when every holding finding is a
 *                                              skill; an authorisation never)
 *   machineSignInCheck(db, workerId, stationId) floor sign-in at a station (MES-246 "accept sign-in only from authorised
 *                                              people"): the check of the station's machines alone
 *
 * Routes (./routes.ts): GET /people/skills/check (office), GET /people/skills/floor/check (floor), GET
 * /people/skills/line-check (the loan dialog's "Can do 3 of 5 operations on Line B").
 *
 * A class of machine is KEPT under authorisation at a site once the site keeps one for it: at least one authorisation of
 * that class for a person of the site (in force, ended or revoked). There is no column saying which classes need one yet
 * (gap: MachineClass.authorisationRequired); the first authorisation of a class at a site is the office's act that keeps
 * it. Nothing here is a figure about one person's work.
 */

type Client = FactoryClient | CommandTx
type Reader = Pick<
  CommandTx,
  'employee' | 'worker' | 'skill' | 'employeeSkill' | 'machineAuthorisation' | 'machine' | 'machineClass' | 'operation' | 'workOrderOperation' | 'station' | 'workCentre' | 'line' | 'device'
>

export interface QualificationInput {
  readonly employeeId?: string | null | undefined
  readonly workerId?: string | null | undefined
  /** The library operation, or a work order's operation (its routing step's library operation). */
  readonly operationId?: string | null | undefined
  readonly workOrderOperationId?: string | null | undefined
  /** One machine, or every machine of a station (not retired). */
  readonly machineId?: string | null | undefined
  readonly stationId?: string | null | undefined
}

export interface QualificationCheck extends QualificationResult {
  readonly person: { readonly employeeId: string | null; readonly workerId: string | null; readonly name: string; readonly companyId: string; readonly siteId: string }
  readonly operation: { readonly id: string; readonly code: string; readonly name: string; readonly workOrderOperationId: string | null } | null
  readonly machines: readonly { readonly id: string; readonly assetNumber: string; readonly machineClass: { readonly id: string; readonly code: string; readonly label: string } }[]
  readonly rule: QualificationRule
  readonly today: BusinessDate
}

export interface CheckOptions {
  readonly now?: Date | undefined
  /** FULL (the office: first and last name) or DISPLAY (the floor: the floor name, the only name it reads). */
  readonly names?: 'FULL' | 'DISPLAY' | undefined
}

const ACTIVE_MACHINE = { status: { not: 'RETIRED' } } as const

interface Person {
  readonly employeeId: string | null
  readonly workerId: string | null
  readonly companyId: string
  readonly siteId: string
  readonly name: string
  readonly active: boolean
}

async function personOf(db: Reader, input: QualificationInput, names: 'FULL' | 'DISPLAY'): Promise<Person> {
  const employeeSelect = { id: true, companyId: true, siteId: true, displayName: true, status: true } as const
  if (input.employeeId) {
    const employee = isUuid(input.employeeId) ? await db.employee.findUnique({ where: { id: input.employeeId }, select: employeeSelect }) : null
    if (!employee) throw new NotFoundError('Employee not found.')
    const name = names === 'FULL' ? await fullName(db, employee.id, employee.displayName) : employee.displayName
    return { employeeId: employee.id, workerId: null, companyId: employee.companyId, siteId: employee.siteId, name, active: employee.status === 'ACTIVE' }
  }
  const worker = input.workerId && isUuid(input.workerId) ? await db.worker.findUnique({ where: { id: input.workerId }, select: { id: true, companyId: true, siteId: true, displayName: true, employeeId: true, status: true } }) : null
  if (!worker) throw new NotFoundError('Worker not found.')
  const employee = worker.employeeId ? await db.employee.findUnique({ where: { id: worker.employeeId }, select: employeeSelect }) : null
  const name = employee && names === 'FULL' ? await fullName(db, employee.id, employee.displayName) : (employee?.displayName ?? worker.displayName)
  return { employeeId: employee?.id ?? null, workerId: worker.id, companyId: worker.companyId, siteId: worker.siteId, name, active: worker.status === 'ACTIVE' && (employee === null || employee.status === 'ACTIVE') }
}

/** First and last name (office only: the floor role may not read them). */
async function fullName(db: Reader, employeeId: string, fallback: string): Promise<string> {
  const row = await db.employee.findUnique({ where: { id: employeeId }, select: { firstName: true, lastName: true } })
  return row ? `${row.firstName} ${row.lastName}` : fallback
}

async function operationOf(db: Reader, input: QualificationInput): Promise<{ id: string; code: string; name: string; workOrderOperationId: string | null; siteId: string | null } | null> {
  if (input.workOrderOperationId) {
    const step = isUuid(input.workOrderOperationId)
      ? await db.workOrderOperation.findUnique({ where: { id: input.workOrderOperationId }, select: { id: true, siteId: true, routingOperation: { select: { operation: { select: { id: true, code: true, name: true } } } } } })
      : null
    if (!step) throw new NotFoundError('Work order operation not found.')
    const operation = step.routingOperation.operation
    return { id: operation.id, code: operation.code, name: operation.name, workOrderOperationId: step.id, siteId: step.siteId }
  }
  if (input.operationId) {
    const operation = isUuid(input.operationId) ? await db.operation.findUnique({ where: { id: input.operationId }, select: { id: true, code: true, name: true } }) : null
    if (!operation) throw new NotFoundError('Operation not found.')
    return { ...operation, workOrderOperationId: null, siteId: null }
  }
  return null
}

async function machinesOf(db: Reader, input: QualificationInput) {
  const select = { id: true, assetNumber: true, siteId: true, classId: true } as const
  if (input.machineId) {
    const machine = isUuid(input.machineId) ? await db.machine.findUnique({ where: { id: input.machineId }, select }) : null
    if (!machine) throw new NotFoundError('Machine not found.')
    return [machine]
  }
  if (input.stationId) {
    const station = isUuid(input.stationId) ? await db.station.findUnique({ where: { id: input.stationId }, select: { id: true } }) : null
    if (!station) throw new NotFoundError('Station not found.')
    return db.machine.findMany({ where: { stationId: station.id, ...ACTIVE_MACHINE }, orderBy: [{ assetNumber: 'asc' }], select })
  }
  return []
}

const heldOf = (row: { id: string; level: string; since: Date; traineeUntil: Date | null; signedOffOn: Date | null }): HeldLevel => ({
  levelId: row.id,
  level: row.level as SkillLevel,
  since: dayOf(row.since),
  traineeUntil: dayOrNull(row.traineeUntil),
  signedOffOn: dayOrNull(row.signedOffOn),
})

/** The person's levels in force in these skills, by skill. */
async function levelsOf(db: Reader, employeeId: string | null, skillIds: readonly string[]): Promise<Map<string, HeldLevel>> {
  if (!employeeId || skillIds.length === 0) return new Map()
  const rows = await db.employeeSkill.findMany({ where: { employeeId, skillId: { in: [...skillIds] }, removedAt: null }, select: { id: true, skillId: true, level: true, since: true, traineeUntil: true, signedOffOn: true } })
  return new Map(rows.map((row) => [row.skillId, heldOf(row)]))
}

/** The active skills of the person's company (or the group) about these operations or classes. */
async function skillsAbout(db: Reader, companyId: string, about: { operationIds?: readonly string[]; classIds?: readonly string[] }) {
  const or = [
    ...(about.operationIds && about.operationIds.length > 0 ? [{ kind: 'OPERATION' as const, operationId: { in: [...about.operationIds] } }] : []),
    ...(about.classIds && about.classIds.length > 0 ? [{ kind: 'MACHINE' as const, machineClassId: { in: [...about.classIds] } }] : []),
  ]
  if (or.length === 0) return []
  return db.skill.findMany({
    where: { status: 'ACTIVE', OR: or, AND: [{ OR: [{ companyId: null }, { companyId }] }] },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    select: { id: true, code: true, name: true, operationId: true, machineClassId: true },
  })
}

/** The classes kept under authorisation at a site (see above). */
export async function keptClassesAt(db: Pick<CommandTx, 'machineAuthorisation'>, siteId: string, classIds: readonly string[]): Promise<Set<string>> {
  if (classIds.length === 0) return new Set()
  const rows = await db.machineAuthorisation.findMany({ where: { siteId, machineClassId: { in: [...classIds] } }, distinct: ['machineClassId'], select: { machineClassId: true } })
  return new Set(rows.map((row) => row.machineClassId))
}

const needOf = (skill: { id: string; code: string; name: string }, levels: Map<string, HeldLevel>): SkillNeed => ({ skillId: skill.id, code: skill.code, name: skill.name, held: levels.get(skill.id) ?? null })

/** The check of one person for one operation on one machine or at one station (either part may be left out). */
export async function qualificationCheck(db: Reader, input: QualificationInput, options: CheckOptions = {}): Promise<QualificationCheck> {
  const now = options.now ?? serverClock.now()
  const today = businessDate(now)
  const person = await personOf(db, input, options.names ?? 'FULL')
  const operation = await operationOf(db, input)
  const machines = await machinesOf(db, input)
  const classIds = [...new Set(machines.map((machine) => machine.classId))]
  const classes = classIds.length === 0 ? [] : await db.machineClass.findMany({ where: { id: { in: classIds } }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], select: { id: true, code: true, labelEn: true } })
  const skills = await skillsAbout(db, person.companyId, { operationIds: operation ? [operation.id] : [], classIds })
  const levels = await levelsOf(db, person.employeeId, skills.map((skill) => skill.id))
  const workSite = machines[0]?.siteId ?? operation?.siteId ?? person.siteId
  const kept = await keptClassesAt(db, workSite, classIds)
  const authorisations = person.employeeId && classIds.length > 0
    ? await db.machineAuthorisation.findMany({ where: { employeeId: person.employeeId, machineClassId: { in: classIds }, revokedAt: null }, select: { id: true, machineClassId: true, authorisedOn: true, validUntil: true } })
    : []
  const rule = await qualificationRuleFor(db, workSite)

  const operationNeed: OperationNeed | null = operation
    ? { operationId: operation.id, code: operation.code, name: operation.name, skills: skills.filter((skill) => skill.operationId === operation.id).map((skill) => needOf(skill, levels)) }
    : null
  const machineNeeds: MachineNeed[] = classes.map((machineClass) => {
    const row = authorisations.find((candidate) => candidate.machineClassId === machineClass.id) ?? null
    return {
      machineClassId: machineClass.id,
      code: machineClass.code,
      label: machineClass.labelEn,
      assetNumbers: machines.filter((machine) => machine.classId === machineClass.id).map((machine) => machine.assetNumber),
      kept: kept.has(machineClass.id),
      authorisation: row ? { authorisationId: row.id, authorisedOn: dayOf(row.authorisedOn), validUntil: dayOrNull(row.validUntil) } : null,
      skills: skills.filter((skill) => skill.machineClassId === machineClass.id).map((skill) => needOf(skill, levels)),
    }
  })
  const result = qualificationOf({ today, mode: rule.mode, person: { name: person.name, active: person.active, hasRecord: person.employeeId !== null }, operation: operationNeed, machines: machineNeeds })
  const labelOf = new Map(classes.map((machineClass) => [machineClass.id, machineClass]))
  return {
    ...result,
    person: { employeeId: person.employeeId, workerId: person.workerId, name: person.name, companyId: person.companyId, siteId: person.siteId },
    operation: operation ? { id: operation.id, code: operation.code, name: operation.name, workOrderOperationId: operation.workOrderOperationId } : null,
    machines: machines.map((machine) => {
      const machineClass = labelOf.get(machine.classId)
      return { id: machine.id, assetNumber: machine.assetNumber, machineClass: { id: machine.classId, code: machineClass?.code ?? '', label: machineClass?.labelEn ?? '' } }
    }),
    rule,
    today,
  }
}

/** The check of a station's machines alone: floor sign-in at a station (MES-246). */
export const machineSignInCheck = (db: Reader, workerId: string, stationId: string, options: CheckOptions = {}): Promise<QualificationCheck> =>
  qualificationCheck(db, { workerId, stationId }, { names: 'DISPLAY', ...options })

export class QualificationRefusedError extends ConflictError {
  override name = 'QualificationRefusedError'
  override readonly issues: readonly Issue[]
  constructor(
    readonly refusal: string,
    message: string,
  ) {
    super(message)
    this.issues = [{ path: `refusal/${refusal}`, message }]
  }
}

/**
 * Dispatch's assignment (B-W2b-49), inside its command: ALLOW → null; WARN → the override to keep (the reason and the
 * findings' codes; who = the deciding person); HOLD, or WARN without a reason → 409 `refusal/<CODE>` in words.
 */
export function assertAssignable(check: QualificationCheck, overrideReason: string | null | undefined): { readonly reason: string; readonly codes: readonly string[] } | null {
  const outcome = assignmentOutcome(check, overrideReason)
  if (!outcome.assignable) throw new QualificationRefusedError(outcome.refusal, outcome.message)
  return outcome.override
}

/** The tablet's guard (B-W2b-46 / -69): null when the work goes on silently, else what to show and how it holds. */
export function qualificationGuard(check: QualificationCheck): { readonly mode: 'WARN' | 'STRICT'; readonly overridable: boolean; readonly message: string; readonly fix: string; readonly findings: readonly QualificationFinding[] } | null {
  if (check.decision === 'ALLOW') return null
  const holding = check.findings.filter((finding) => finding.mode === 'STRICT')
  const shown = check.decision === 'HOLD' ? holding : check.findings
  return {
    mode: check.decision === 'HOLD' ? 'STRICT' : 'WARN',
    overridable: check.overridable,
    message: check.message,
    fix: [...new Set(shown.map((finding) => finding.fix))].join(' '),
    findings: [...check.findings],
  }
}

// ---- routes -------------------------------------------------------------------------------------------------------------

export interface OfficeCheckQuery {
  readonly employeeId?: string | undefined
  readonly workerId?: string | undefined
  readonly operationId?: string | undefined
  readonly workOrderOperationId?: string | undefined
  readonly machineId?: string | undefined
  readonly stationId?: string | undefined
}

function askedOnce(query: OfficeCheckQuery): void {
  const issues: Issue[] = []
  if ((query.employeeId ? 1 : 0) + (query.workerId ? 1 : 0) !== 1) issues.push({ path: 'querystring/employeeId', message: 'Name one person: employeeId or workerId.' })
  if (query.operationId && query.workOrderOperationId) issues.push({ path: 'querystring/operationId', message: 'Name the operation once: operationId or workOrderOperationId.' })
  if (query.machineId && query.stationId) issues.push({ path: 'querystring/machineId', message: 'Name one machine or one station.' })
  if (!query.operationId && !query.workOrderOperationId && !query.machineId && !query.stationId) issues.push({ path: 'querystring/operationId', message: 'Name the work: an operation, a machine or a station.' })
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
}

/** GET /people/skills/check (office, people.skills.view over the person's company and site): dispatch's pre-check. */
export async function officeCheck(caller: CommandCaller, query: OfficeCheckQuery) {
  const context = officeOf(caller)
  askedOnce(query)
  return caller.withClient(async (db) => {
    const check = await qualificationCheck(db, query, { names: 'FULL' })
    assertMay(context, PEOPLE_SKILLS_VIEW, check.person, 'Employee')
    return { check: checkView(check) }
  })
}

function floorOf(caller: CommandCaller): FloorContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'floor') throw new ForbiddenError()
  return context
}

/**
 * GET /people/skills/floor/check (floor.work at the device's site): the tablet's pre-check before work starts — the
 * signed-in worker (another worker: a team leader, floor.lead), the operation of a work order (or of the library), and the
 * device's station's machines (or one machine). Names: the floor name only.
 */
export async function floorCheck(caller: CommandCaller, query: { readonly workerId?: string | undefined; readonly operationId?: string | undefined; readonly workOrderOperationId?: string | undefined; readonly machineId?: string | undefined }) {
  const context = floorOf(caller)
  const workerId = query.workerId ?? context.actorId
  if (workerId !== context.actorId && !can(actorOf(context), 'floor.lead', { siteId: context.siteId })) throw new ForbiddenError("Only a team leader checks another worker's skills on the floor.")
  if (query.operationId && query.workOrderOperationId) throw new ValidationError('Name the operation once.', [{ path: 'querystring/operationId', message: 'Name the operation once: operationId or workOrderOperationId.' }])
  return caller.withClient(async (db) => {
    const device = isUuid(context.deviceId) ? await db.device.findUnique({ where: { id: context.deviceId }, select: { stationId: true } }) : null
    if (!device) throw new NotFoundError('Device not found.')
    const stationId = query.machineId ? null : device.stationId
    const check = await qualificationCheck(db, { workerId, operationId: query.operationId, workOrderOperationId: query.workOrderOperationId, machineId: query.machineId, stationId }, { names: 'DISPLAY' })
    if (check.person.siteId !== context.siteId) throw new NotFoundError('Worker not found.')
    const guard = qualificationGuard(check)
    return { check: checkView(check), guard: guard ? { ...guard, findings: [...guard.findings] } : null, stationId }
  })
}

/** GET /people/skills/line-check (office, people.skills.view over the person): "Can do 3 of 5 operations on Line B". */
export async function lineCheck(caller: CommandCaller, query: { readonly employeeId: string; readonly lineId: string }) {
  const context = officeOf(caller)
  const now = serverClock.now()
  const today = businessDate(now)
  return caller.withClient(async (db) => {
    const employee = isUuid(query.employeeId) ? await db.employee.findUnique({ where: { id: query.employeeId }, select: { id: true, companyId: true, siteId: true, firstName: true, lastName: true } }) : null
    if (!employee) throw new NotFoundError('Employee not found.')
    assertMay(context, PEOPLE_SKILLS_VIEW, employee, 'Employee')
    const line = isUuid(query.lineId) ? await db.line.findUnique({ where: { id: query.lineId }, select: { id: true, code: true, name: true, companyId: true, siteId: true } }) : null
    if (!line || line.companyId !== employee.companyId) throw new NotFoundError('Line not found.')
    const operations = await lineOperations(db, line)
    const skills = await skillsAbout(db, employee.companyId, { operationIds: operations.map((operation) => operation.id) })
    const levels = await levelsOf(db, employee.id, skills.map((skill) => skill.id))
    const needs: OperationNeed[] = operations.map((operation) => ({ operationId: operation.id, code: operation.code, name: operation.name, skills: skills.filter((skill) => skill.operationId === operation.id).map((skill) => needOf(skill, levels)) }))
    const result = lineSkillsOf(line.code, needs, today)
    return { employee: { id: employee.id, name: `${employee.firstName} ${employee.lastName}` }, line: { id: line.id, code: line.code, name: line.name }, ...result, operations: [...result.operations], today }
  })
}

/**
 * What a line does: the active library operations (the group's or the line's company's) of the kinds of work centre its
 * active stations belong to. A capability, not today's plan (the plan's lists are dispatch's).
 */
async function lineOperations(db: Client, line: { id: string; companyId: string; siteId: string }) {
  const stations = await db.station.findMany({ where: { lineId: line.id, status: 'ACTIVE' }, select: { workCentreId: true } })
  const centres = stations.length === 0 ? [] : await db.workCentre.findMany({ where: { id: { in: [...new Set(stations.map((station) => station.workCentreId))] } }, select: { kind: true } })
  const kinds = [...new Set(centres.map((centre) => centre.kind))]
  if (kinds.length === 0) return []
  return db.operation.findMany({
    where: { status: 'ACTIVE', workCentreKind: { in: kinds }, OR: [{ companyId: null }, { companyId: line.companyId }] },
    orderBy: [{ code: 'asc' }],
    select: { id: true, code: true, name: true },
  })
}

/** The check as the routes answer it. */
export function checkView(check: QualificationCheck) {
  return {
    person: check.person,
    operation: check.operation,
    machines: [...check.machines],
    outcome: check.outcome,
    decision: check.decision,
    overridable: check.overridable,
    trainee: check.trainee,
    mode: check.mode,
    rule: { mode: check.rule.mode, isDefault: check.rule.isDefault, words: check.rule.words },
    requirements: [...check.requirements],
    findings: [...check.findings],
    message: check.message,
    today: check.today,
  }
}
