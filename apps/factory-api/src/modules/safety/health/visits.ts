import type { Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { SAFETY_HEALTH_MANAGE, SAFETY_HEALTH_VIEW } from '@nexus/factory-domain/safety/health/permissions'
import { HEALTH_LIMITS, healthRefusalOf, visitProblems, type VisitCancelReason, type VisitStatus, type VisitType } from '@nexus/factory-domain/safety/health/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { askedPeople, assertMay, assertMayWrite, assertVersion, bodyIssue, dateOf, HealthRefusedError, MANAGE_WORDS, may, officeOf, peopleScope, refuse, todayOf } from './access'
import { healthFactsOf, proposalsOf } from './facts'
import { recordViews } from './protected'
import { OPEN_STATUSES, personOut, plansOfRoles, planVisitInCommand, readPerson, visitChanged } from './store'

/**
 * The visits (B-W2b-135; QHS-253 "Visit scheduling and due list"; design plant.health "Plan visits", "Mark booked", the due list's
 * row; D.Lgs. 81/2008 art. 41 c.2). Office only; safety.health.view reads, safety.health.manage writes, each checked with can()
 * against the person's company and site. Every write is one command with an Idempotency-Key whose answer is ids, versions and
 * states only; its audit rows name the visit and the change, never a type, an absence or a person.
 *
 *   POST  /safety/health/visits/proposals          the visits nobody planned yet (names: recorded HEALTH_VISIT_LIST LIST)
 *   POST  /safety/health/visits/plan               "Plan 6 visits": DUE visits for chosen people (from the proposals or by hand:
 *                                                  on request, a return with the absence's length only)
 *   POST  /safety/health/visits/book               "Mark 6 booked for 14 Nov": day and place, DUE or BOOKED → BOOKED
 *   POST  /safety/health/visits/:visitId/unbook    BOOKED → DUE (the booking cleared)
 *   PATCH /safety/health/visits/:visitId           move the due day
 *   POST  /safety/health/visits/:visitId/cancel    with a reason from the list (no free text on a health record)
 *   POST  /safety/health/visits/:visitId/done      took place (its judgement may come later, from the doctor's paper)
 */

/** POST /safety/health/visits/proposals. */
export async function proposeVisits(caller: CommandCaller, body: { readonly companyId?: string | undefined; readonly siteId?: string | undefined; readonly employeeIds?: readonly string[] | undefined; readonly horizonDays?: number | undefined }, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  const where: Prisma.EmployeeWhereInput = { AND: [peopleScope(context, SAFETY_HEALTH_VIEW), askedPeople(body), body.employeeIds ? { id: { in: [...body.employeeIds] } } : {}] }
  const computed = await caller.withClient(async (client) => {
    const facts = await healthFactsOf(client, where)
    const proposals = proposalsOf(facts, today, body.horizonDays ?? HEALTH_LIMITS.horizonDays)
    const sheets = await client.roleSheet.findMany({ where: { id: { in: [...new Set(proposals.map((row) => row.roleSheetId))] } }, select: { id: true, code: true, name: true } })
    return { facts, proposals, sheets }
  })
  const people = new Map(computed.facts.people.map((row) => [row.id, row]))
  // Names beside "needs a visit" are protected: the view first (one per company), then the answer.
  await recordViews(caller, context, 'safety.proposeHealthVisits', [...new Set(computed.proposals.map((row) => people.get(row.employeeId)!.companyId))].map((companyId) => ({ recordType: 'HEALTH_VISIT_LIST', recordId: null, employeeId: null, companyId, what: 'LIST' })))
  return {
    today,
    proposals: computed.proposals.map((row) => ({ employee: personOut(people.get(row.employeeId)!), role: computed.sheets.find((sheet) => sheet.id === row.roleSheetId)!, planId: row.planId, type: row.type, dueOn: row.dueOn, why: row.why, doctorSet: row.doctorSet })),
    recorded: computed.proposals.length > 0,
  }
}

export interface PlanItem {
  readonly employeeId: string
  readonly type: VisitType
  readonly dueOn: BusinessDate
  readonly roleSheetId?: string | undefined
  readonly absenceDays?: number | undefined
}

/** A refusal at one item of the request (409 `refusal/<CODE>` + `body/items/<i>/<field>`). */
const refuseAt = (code: Parameters<typeof healthRefusalOf>[0], index: number, field: string): never => {
  throw new HealthRefusedError(healthRefusalOf(code, `items/${index}/${field}`))
}

/** Checks one item in the command and writes its visit: the person in reach and not left, the role of their site, the plan. */
async function planItemInCommand(tools: CommandTools, context: OfficeContext, item: PlanItem, index: number, planned: Set<string>) {
  const { tx } = tools
  const person = await readPerson(tx, item.employeeId)
  if (!person || !may(context, SAFETY_HEALTH_VIEW, person)) throw new NotFoundError('Employee not found.')
  assertMayWrite(context, SAFETY_HEALTH_MANAGE, person, MANAGE_WORDS)
  if (person.status === 'LEFT') refuseAt('PERSON_LEFT', index, 'employeeId')
  const roleSheetId = item.roleSheetId ?? person.roleSheetId
  if (item.type === 'CHANGE_OF_TASK' && !roleSheetId) refuseAt('NO_ROLE', index, 'roleSheetId')
  if (item.roleSheetId) {
    const sheet = await tx.roleSheet.findUnique({ where: { id: item.roleSheetId }, select: { siteId: true } })
    if (!sheet || sheet.siteId !== person.siteId) refuseAt('ROLE_OTHER_SITE', index, 'roleSheetId')
  }
  const plan = roleSheetId ? ((await plansOfRoles(tx, [roleSheetId])).get(roleSheetId) ?? null) : null
  // The visits a plan asks need a plan that asks visits; on request and a return visit stand on their own (the plan when it asks).
  const fromPlan = item.type === 'PREVENTIVE' || item.type === 'PERIODIC' || item.type === 'CHANGE_OF_TASK' || item.type === 'END_OF_EMPLOYMENT'
  if (fromPlan && !plan?.needed) refuseAt('PLAN_NOT_NEEDED', index, 'type')
  const key = `${person.id}|${item.type}`
  const open = await tx.healthVisit.findFirst({ where: { employeeId: person.id, type: item.type, status: { in: [...OPEN_STATUSES] } }, select: { id: true } })
  if (open || planned.has(key)) refuseAt('OPEN_VISIT_EXISTS', index, 'type')
  planned.add(key)
  return planVisitInCommand(tools, { companyId: person.companyId, siteId: person.siteId, employeeId: person.id, type: item.type, dueOn: item.dueOn, planId: plan?.needed ? plan.id : null, roleSheetId: item.type === 'CHANGE_OF_TASK' || fromPlan ? roleSheetId : (item.roleSheetId ?? null), absenceDays: item.absenceDays ?? null }, 'OFFICE')
}

/** POST /safety/health/visits/plan: one command for every item, all or none. */
export async function planVisits(caller: CommandCaller, body: { readonly items: readonly PlanItem[] }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const problems: Issue[] = body.items.flatMap((item, index) => visitProblems(item, `items/${index}`))
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'Some visits are not as a visit is.', problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))
  const { result, replayed } = await command(caller, { name: 'safety.planHealthVisits', idempotencyKey, input: body }, async (tools) => {
    const planned = new Set<string>()
    const visits = []
    for (const [index, item] of body.items.entries()) visits.push((await planItemInCommand(tools, context, item, index, planned))!)
    return { visits }
  })
  return { ...result, replayed }
}

const VISIT_LOCKED = { id: true, companyId: true, employeeId: true, status: true, version: true, employee: { select: { companyId: true, siteId: true } } } as const satisfies Prisma.HealthVisitSelect

/** The visit, readable and writable by the caller (404 / 403), read before the command. */
async function writableVisit(caller: CommandCaller, context: OfficeContext, visitId: string) {
  const row = isUuid(visitId) ? await caller.withClient((client) => client.healthVisit.findUnique({ where: { id: visitId }, select: VISIT_LOCKED })) : null
  if (!row) throw new NotFoundError('Visit not found.')
  assertMay(context, SAFETY_HEALTH_VIEW, row.employee, 'Visit')
  assertMayWrite(context, SAFETY_HEALTH_MANAGE, row.employee, MANAGE_WORDS)
  return row
}

/** The visit locked in the command at the version the caller read. */
async function lockVisit(tools: CommandTools, visitId: string, version: number) {
  await tools.tx.$queryRaw`SELECT "id" FROM "HealthVisit" WHERE "id" = ${visitId}::uuid FOR UPDATE`
  const row = (await tools.tx.healthVisit.findUnique({ where: { id: visitId }, select: { ...VISIT_LOCKED, bookedOn: true } }))!
  assertVersion('visit', row.version, version)
  return row
}

const placeOfVisit = (row: { id: string; companyId: string; employee: { siteId: string } }) => ({ id: row.id, companyId: row.companyId, siteId: row.employee.siteId })
const isOpen = (status: string): boolean => status === 'DUE' || status === 'BOOKED'

/** POST /safety/health/visits/book. */
export async function bookVisits(caller: CommandCaller, body: { readonly visits: readonly { readonly id: string; readonly version: number }[]; readonly bookedOn: BusinessDate; readonly bookedPlace?: string | undefined }, idempotencyKey?: string, now: Date = new Date()) {
  const context = officeOf(caller)
  if (body.bookedOn < todayOf(now)) refuse(healthRefusalOf('BOOKED_IN_PAST', 'bookedOn'))
  for (const visit of body.visits) await writableVisit(caller, context, visit.id)
  const { result, replayed } = await command(caller, { name: 'safety.bookHealthVisits', idempotencyKey, input: body }, async (tools) => {
    const visits = []
    for (const asked of body.visits) {
      const row = await lockVisit(tools, asked.id, asked.version)
      if (!isOpen(row.status)) refuse(healthRefusalOf('VISIT_CLOSED'))
      await tools.tx.healthVisit.update({ where: { id: row.id }, data: { status: 'BOOKED', bookedOn: dateOf(body.bookedOn), bookedPlace: body.bookedPlace?.trim() ?? null, bookedAt: tools.now, bookedById: context.actorId, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
      visitChanged(tools, placeOfVisit(row), 'BOOKED', 'BOOKED', 'OFFICE', 'safety.bookHealthVisit')
      visits.push({ id: row.id, version: row.version + 1, status: 'BOOKED' as VisitStatus })
    }
    return { visits }
  })
  return { ...result, replayed }
}

type Move = { readonly kind: 'unbook' } | { readonly kind: 'move'; readonly dueOn: BusinessDate } | { readonly kind: 'cancel'; readonly reason: VisitCancelReason } | { readonly kind: 'done'; readonly doneOn: BusinessDate }

const MOVE_NAME = { unbook: 'safety.unbookHealthVisit', move: 'safety.moveHealthVisit', cancel: 'safety.cancelHealthVisit', done: 'safety.doneHealthVisit' } as const

/** POST …/unbook, PATCH …, POST …/cancel, POST …/done. */
export async function moveVisit(caller: CommandCaller, visitId: string, body: { readonly version: number }, move: Move, idempotencyKey?: string, now: Date = new Date()) {
  const context = officeOf(caller)
  if (move.kind === 'done' && move.doneOn > todayOf(now)) throw bodyIssue('doneOn', 'The visit took place today at the latest.')
  await writableVisit(caller, context, visitId)
  const name = MOVE_NAME[move.kind]
  const { result, replayed } = await command(caller, { name, idempotencyKey, input: { visitId, ...body, ...move } }, async (tools) => {
    const row = await lockVisit(tools, visitId, body.version)
    if (!isOpen(row.status)) refuse(healthRefusalOf('VISIT_CLOSED'))
    let data: Prisma.HealthVisitUncheckedUpdateInput
    let status: VisitStatus = row.status as VisitStatus
    let change: 'UNBOOKED' | 'MOVED' | 'CANCELLED' | 'DONE'
    if (move.kind === 'unbook') {
      if (row.status !== 'BOOKED') refuse(healthRefusalOf('VISIT_NOT_BOOKED'))
      data = { status: 'DUE', bookedOn: null, bookedPlace: null, bookedAt: null, bookedById: null }
      status = 'DUE'
      change = 'UNBOOKED'
    } else if (move.kind === 'move') {
      data = { dueOn: dateOf(move.dueOn) }
      change = 'MOVED'
    } else if (move.kind === 'cancel') {
      data = { status: 'CANCELLED', cancelledAt: tools.now, cancelledById: context.actorId, cancelReason: move.reason }
      status = 'CANCELLED'
      change = 'CANCELLED'
    } else {
      data = { status: 'DONE', doneOn: dateOf(move.doneOn) }
      status = 'DONE'
      change = 'DONE'
    }
    await tools.tx.healthVisit.update({ where: { id: row.id }, data: { ...data, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    visitChanged(tools, placeOfVisit(row), change, status, 'OFFICE', name)
    return { visits: [{ id: row.id, version: row.version + 1, status }] }
  })
  return { ...result, replayed }
}

