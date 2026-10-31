import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PEOPLE_OVERTIME_APPROVE, PEOPLE_OVERTIME_MANAGE, PEOPLE_SHIFTS_VIEW } from '@nexus/factory-domain/people/shifts/permissions'
import { overtimeActionRefusal, overtimePlanProblems, overtimeStageOf, type OvertimeAction, type OvertimeStatus } from '@nexus/factory-domain/people/shifts/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { actorIdOf, assertMay, assertMayWrite, assertVersion, dateOf, dayOf, may, officeOf, problemsError, refuse, scopeOf, todayOf } from '../employees/access'
import { userNames } from '../employees/employees'
import { blocking, overtimeChecks, type OvertimePlan, type WarningOut } from './checks'
import { employmentIssue, fullName, peopleFacts, type PlannedPerson } from './planner'

/**
 * Planned overtime requests (B-W2b-32; MES-222; design people.shifts "Overtime requests", "Request overtime"; D.Lgs.
 * 66/2003 art. 5: overtime by agreement, within the yearly cap), office only. people.shifts.view reads,
 * people.overtime.manage asks (and records an answer a person told the lead), people.overtime.approve approves; each
 * checked with can() against the request's company and site.
 *
 *   GET   /people/overtime-requests                              the requests (date, line, minutes, reason, asked, agreed n
 *                                                                of m, the stage, how many people a limit warns or holds)
 *   GET   /people/overtime-requests/:id                          one request with each person asked, their answer and checks
 *   POST  /people/overtime-requests/check                        the checks of people for a planned overtime (the picker)
 *   POST  /people/overtime-requests                              a request (DRAFT, or asked at once: "Ask 6 people")
 *   PATCH /people/overtime-requests/:id                          change what a DRAFT asks
 *   POST  /people/overtime-requests/:id/people                   add people (asked at once once the request is asked) or take
 *                                                                off people who have not answered
 *   POST  /people/overtime-requests/:id/ask                      DRAFT → ASKED: each person answers on the tablet's My day
 *   POST  /people/overtime-requests/:id/answers/:agreementId     record what a person told the lead (OFFICE)
 *   POST  /people/overtime-requests/:id/approve                  approve once somebody agreed (only they work it)
 *   POST  /people/overtime-requests/:id/cancel                   cancel with the reason
 *
 * Never automatic: nobody is planned onto overtime without their own yes (on their tablet, or told to the lead and
 * recorded with who recorded it); the stored status stays ASKED while answers come (AGREED is shown), so a yes can be
 * taken back until the approval; the approval moves ASKED → AGREED → APPROVED in one command. A new limit warning whose
 * rule blocks (People settings) holds the ask, an added person or the approval. DONE comes with the overtime entries
 * worked (B-W2b-42). Each write: one command, an Idempotency-Key, an audit row on the request, the events.
 */

type Client = FactoryClient | CommandTx

const REQUEST_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  lineId: true,
  date: true,
  startMinute: true,
  minutes: true,
  reason: true,
  status: true,
  askedAt: true,
  askedById: true,
  approvedAt: true,
  approvedById: true,
  doneAt: true,
  cancelledAt: true,
  cancelReason: true,
  createdById: true,
  version: true,
  site: { select: { id: true, code: true, name: true } },
  line: { select: { id: true, code: true, name: true } },
} as const satisfies Prisma.OvertimeRequestSelect
type RequestRow = Prisma.OvertimeRequestGetPayload<{ select: typeof REQUEST_SELECT }>

const AGREEMENT_SELECT = { id: true, employeeId: true, answer: true, answeredAt: true, answeredVia: true, answeredById: true, version: true } as const satisfies Prisma.OvertimeAgreementSelect

const readRequest = (client: Client, id: string): Promise<RequestRow | null> => client.overtimeRequest.findUnique({ where: { id }, select: REQUEST_SELECT })

interface Counts {
  readonly asked: number
  readonly agreed: number
  readonly declined: number
  readonly pending: number
}

async function countsOf(client: Client, ids: readonly string[]): Promise<Map<string, Counts>> {
  const out = new Map<string, { asked: number; agreed: number; declined: number; pending: number }>(ids.map((id) => [id, { asked: 0, agreed: 0, declined: 0, pending: 0 }]))
  if (ids.length === 0) return out
  const rows = await client.overtimeAgreement.groupBy({ by: ['requestId', 'answer'], where: { requestId: { in: [...ids] } }, _count: { _all: true } })
  for (const row of rows) {
    const counts = out.get(row.requestId)!
    counts.asked += row._count._all
    if (row.answer === 'AGREED') counts.agreed += row._count._all
    else if (row.answer === 'DECLINED') counts.declined += row._count._all
    else counts.pending += row._count._all
  }
  return out
}

function requestView(row: RequestRow, counts: Counts, names: ReadonlyMap<string, string>) {
  const name = (id: string | null) => (id ? (names.get(id) ?? null) : null)
  return {
    id: row.id,
    companyId: row.companyId,
    site: row.site,
    line: row.line,
    date: dayOf(row.date),
    startMinute: row.startMinute,
    minutes: row.minutes,
    reason: row.reason,
    status: row.status,
    stage: overtimeStageOf(row.status, counts.agreed),
    counts,
    askedAt: row.askedAt ? toUtcIso(row.askedAt) : null,
    askedBy: name(row.askedById),
    approvedAt: row.approvedAt ? toUtcIso(row.approvedAt) : null,
    approvedBy: name(row.approvedById),
    doneAt: row.doneAt ? toUtcIso(row.doneAt) : null,
    cancelledAt: row.cancelledAt ? toUtcIso(row.cancelledAt) : null,
    cancelReason: row.cancelReason,
    createdBy: name(row.createdById),
    version: row.version,
  }
}

const placedOf = (row: Pick<RequestRow, 'companyId' | 'siteId'>) => ({ companyId: row.companyId, siteId: row.siteId })
const planOf = (row: RequestRow): OvertimePlan => ({ date: dayOf(row.date), startMinute: row.startMinute, minutes: row.minutes, requestId: row.id })
const warningView = (warning: WarningOut) => ({ ...warning, values: { ...warning.values } })

/** One request as its record shows it: the people asked with their answers and checks. */
async function recordOf(client: Client, context: OfficeContext, id: string, now: Date) {
  const row = (await readRequest(client, id))!
  const agreements = await client.overtimeAgreement.findMany({ where: { requestId: id }, select: AGREEMENT_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const people = await peopleFacts(client, { id: { in: agreements.map((agreement) => agreement.employeeId) } })
  const byId = new Map(people.map((person) => [person.id, person]))
  const open = row.status !== 'DONE' && row.status !== 'CANCELLED'
  const checks = open ? await overtimeChecks(client, people, planOf(row)) : new Map<string, WarningOut[]>()
  const counts = (await countsOf(client, [id])).get(id)!
  const names = await userNames(client, [row.askedById, row.approvedById, row.createdById, ...agreements.map((agreement) => agreement.answeredById)])
  return {
    request: requestView(row, counts, names),
    people: agreements.map((agreement) => {
      const person = byId.get(agreement.employeeId)
      return {
        agreementId: agreement.id,
        employeeId: agreement.employeeId,
        name: person ? fullName(person) : '',
        displayName: person?.displayName ?? '',
        answer: agreement.answer,
        answeredAt: agreement.answeredAt ? toUtcIso(agreement.answeredAt) : null,
        via: agreement.answeredVia,
        recordedBy: agreement.answeredById ? (names.get(agreement.answeredById) ?? null) : null,
        version: agreement.version,
        checks: (checks.get(agreement.employeeId) ?? []).map(warningView),
      }
    }),
    canManage: open && may(context, PEOPLE_OVERTIME_MANAGE, placedOf(row)),
    canApprove: open && may(context, PEOPLE_OVERTIME_APPROVE, placedOf(row)),
    today: todayOf(now),
  }
}

// ---- reads -------------------------------------------------------------------------------------------------------------

export interface ListQuery {
  readonly siteId?: string | undefined
  readonly lineId?: string | undefined
  readonly from?: BusinessDate | undefined
  readonly to?: BusinessDate | undefined
  readonly stage?: OvertimeStatus | undefined
}

/** GET /people/overtime-requests: from a week ago to six weeks ahead unless asked. */
export async function listRequests(caller: CommandCaller, query: ListQuery, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  const from = query.from ?? plusDays(today, -7)
  const to = query.to ?? plusDays(today, 42)
  return caller.withClient(async (client) => {
    const stage = query.stage
    const rows = await client.overtimeRequest.findMany({
      where: {
        AND: [
          scopeOf(context, PEOPLE_SHIFTS_VIEW) as Prisma.OvertimeRequestWhereInput,
          { date: { gte: dateOf(from), lte: dateOf(to) } },
          query.siteId ? { siteId: query.siteId } : {},
          query.lineId ? { lineId: query.lineId } : {},
          stage === 'AGREED' ? { status: { in: ['ASKED', 'AGREED'] } } : stage ? { status: stage } : {},
        ],
      },
      select: REQUEST_SELECT,
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
      take: 200,
    })
    const counts = await countsOf(client, rows.map((row) => row.id))
    const names = await userNames(client, rows.flatMap((row) => [row.askedById, row.approvedById, row.createdById]))
    const views = []
    for (const row of rows) {
      const view = requestView(row, counts.get(row.id)!, names)
      if (stage === 'AGREED' && view.stage !== 'AGREED') continue
      if (stage === 'ASKED' && view.stage !== 'ASKED') continue
      let warn = 0
      let block = 0
      if (row.status !== 'DONE' && row.status !== 'CANCELLED' && dayOf(row.date) >= today) {
        const agreements = await client.overtimeAgreement.findMany({ where: { requestId: row.id, answer: { not: 'DECLINED' } }, select: { employeeId: true } })
        const people = await peopleFacts(client, { id: { in: agreements.map((agreement) => agreement.employeeId) } })
        for (const list of (await overtimeChecks(client, people, planOf(row))).values()) {
          if (list.some((warning) => warning.level === 'BLOCK')) block += 1
          else if (list.length > 0) warn += 1
        }
      }
      views.push({ ...view, checks: { warn, block } })
    }
    return { requests: views, today }
  })
}

async function visibleRequest(caller: CommandCaller, requestId: string): Promise<RequestRow> {
  const context = officeOf(caller)
  const row = isUuid(requestId) ? await caller.withClient((client) => readRequest(client, requestId)) : null
  if (!row) throw new NotFoundError('Overtime request not found.')
  assertMay(context, PEOPLE_SHIFTS_VIEW, placedOf(row), 'Overtime request')
  return row
}

/** GET /people/overtime-requests/:requestId. */
export async function requestRecord(caller: CommandCaller, requestId: string, now: Date = new Date()) {
  const context = officeOf(caller)
  await visibleRequest(caller, requestId)
  return caller.withClient((client) => recordOf(client, context, requestId, now))
}

// ---- the people of a request ------------------------------------------------------------------------------------------

/** The people asked: each of the site (at work that day, not past a leaver's last day), readable by the caller. */
async function peopleToAsk(client: Client, context: OfficeContext, siteId: string, date: BusinessDate, ids: readonly string[], path = 'employeeIds'): Promise<PlannedPerson[]> {
  const unique = [...new Set(ids)]
  const people = await peopleFacts(client, { AND: [scopeOf(context, PEOPLE_SHIFTS_VIEW) as Prisma.EmployeeWhereInput, { id: { in: unique } }] })
  const byId = new Map(people.map((person) => [person.id, person]))
  ids.forEach((id, index) => {
    const person = byId.get(id)
    if (!person) throw new NotFoundError('Employee not found.')
    if (person.siteId !== siteId) refuse('OTHER_SITE', `${fullName(person)} works at another site: overtime is asked of the people of its site.`, `${path}/${index}`)
    const issue = employmentIssue(person, date)
    if (issue || person.status !== 'ACTIVE') refuse(issue ?? 'NOT_EMPLOYED', issue === 'AFTER_LAST_DAY' ? `${fullName(person)} is leaving: their last working day is ${person.lastWorkingDay}.` : `${fullName(person)} does not work for the company on ${date}.`, `${path}/${index}`)
  })
  return unique.map((id) => byId.get(id)!)
}

/** The ask or approval is held when a new limit warning of a person blocks (People settings), in words. */
async function refuseBlocked(client: Client, people: readonly PlannedPerson[], plan: OvertimePlan): Promise<void> {
  if (people.length === 0) return
  const checks = await overtimeChecks(client, people, plan)
  const held = blocking(checks.values())
  if (held.length === 0) return
  const names = new Map(people.map((person) => [person.id, fullName(person)]))
  const issues = [...checks.entries()].flatMap(([employeeId, list]) => list.filter((warning) => warning.isNew && warning.level === 'BLOCK').map((warning) => ({ path: `limits/${employeeId}/${warning.date}`, message: `${names.get(employeeId)}: ${warning.words}` })))
  refuse('LIMIT_BLOCKED', `The overtime breaks a working-time limit People settings hold: ${held[0]!.words}`, undefined, issues)
}

/** POST /people/overtime-requests/check: each person's checks for a planned overtime (the Request overtime picker). */
export async function checkRequest(caller: CommandCaller, body: { readonly siteId: string; readonly date: BusinessDate; readonly startMinute?: number | null | undefined; readonly minutes: number; readonly employeeIds: readonly string[]; readonly requestId?: string | undefined }) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const site = await client.site.findUnique({ where: { id: body.siteId }, select: { companyId: true } })
    if (!site || !may(context, PEOPLE_SHIFTS_VIEW, { companyId: site.companyId, siteId: body.siteId })) throw new NotFoundError('Site not found.')
    const unique = [...new Set(body.employeeIds)]
    const people = await peopleFacts(client, { AND: [scopeOf(context, PEOPLE_SHIFTS_VIEW) as Prisma.EmployeeWhereInput, { id: { in: unique } }] })
    if (people.length !== unique.length) throw new NotFoundError('Employee not found.')
    const checks = await overtimeChecks(client, people, { date: body.date, startMinute: body.startMinute ?? null, minutes: body.minutes, ...(body.requestId ? { requestId: body.requestId } : {}) })
    return { people: people.map((person) => ({ employeeId: person.id, name: fullName(person), displayName: person.displayName, checks: (checks.get(person.id) ?? []).map(warningView) })) }
  })
}

// ---- writes ------------------------------------------------------------------------------------------------------------

const MANAGE_WORDS = 'Overtime of this site is planned by a role that asks people (people.overtime.manage).'
const APPROVE_WORDS = 'Overtime of this site is approved by a role that approves it (people.overtime.approve).'

/** The request locked (the guard's own key, then the row), read again, its version compared and the action allowed. */
async function lockRequest(tools: CommandTools, requestId: string, version: number | null, action: OvertimeAction): Promise<{ row: RequestRow; counts: Counts }> {
  const { tx } = tools
  const tenantId = (tools.context as { readonly tenantId: string }).tenantId
  await tx.$executeRaw`SELECT "factory_time_lock"('factory.time.overtime-request', ${tenantId}::uuid, ${requestId}::uuid)`
  await tx.$queryRaw`SELECT "id" FROM "OvertimeRequest" WHERE "id" = ${requestId}::uuid FOR UPDATE`
  const row = (await readRequest(tx, requestId))!
  if (version !== null) assertVersion('overtime request', row.version, version)
  const counts = (await countsOf(tx, [requestId])).get(requestId)!
  const refusal = overtimeActionRefusal(action, { status: row.status, asked: counts.asked, agreed: counts.agreed })
  if (refusal) refuse(`NOT_${action}`, refusal)
  return { row, counts }
}

function lineCheck(line: { readonly siteId: string; readonly status: string; readonly code: string } | null, siteId: string): void {
  if (!line || line.siteId !== siteId) refuse('LINE_NOT_OF_SITE', 'The line is a line of the same site.', 'lineId')
  if (line!.status !== 'ACTIVE') refuse('LINE_NOT_OF_SITE', `Line ${line!.code} is archived.`, 'lineId')
}

function emitChanged(tools: CommandTools, row: RequestRow, change: 'CREATED' | 'EDITED' | 'PEOPLE_ADDED' | 'PEOPLE_REMOVED' | 'APPROVED' | 'CANCELLED', counts: Counts): void {
  tools.emit({ type: 'overtime_request.changed', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { requestId: row.id, lineId: row.lineId, date: dayOf(row.date), change, asked: counts.asked, agreed: counts.agreed } })
}

export interface CreateBody {
  readonly siteId: string
  readonly lineId?: string | null | undefined
  readonly date: BusinessDate
  readonly startMinute?: number | null | undefined
  readonly minutes: number
  readonly reason: string
  readonly employeeIds: readonly string[]
  readonly ask?: boolean | undefined
}

/** POST /people/overtime-requests: a DRAFT with the people to ask, or asked at once. */
export async function createRequest(caller: CommandCaller, body: CreateBody, idempotencyKey?: string, now: Date = new Date()) {
  const context = officeOf(caller)
  const site = await caller.withClient((client) => client.site.findUnique({ where: { id: body.siteId }, select: { id: true, companyId: true } }))
  if (!site) throw new NotFoundError('Site not found.')
  assertMay(context, PEOPLE_SHIFTS_VIEW, { companyId: site.companyId, siteId: site.id }, 'Site')
  assertMayWrite(context, PEOPLE_OVERTIME_MANAGE, { companyId: site.companyId, siteId: site.id }, MANAGE_WORDS)
  const problems = overtimePlanProblems({ minutes: body.minutes, startMinute: body.startMinute ?? null, reason: body.reason })
  if (problems.length > 0) throw problemsError(problems, 'The overtime request is not valid.')
  if (body.date < todayOf(now)) throw new ValidationError('Planned overtime is for today or a later day.', [{ path: 'body/date', message: 'Today or later.' }])
  const id = newId()
  const { result, replayed } = await command(caller, { name: 'people.requestOvertime', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    const actorId = actorIdOf(tools.context)
    if (body.lineId) lineCheck(await tx.line.findUnique({ where: { id: body.lineId }, select: { siteId: true, status: true, code: true } }), site.id)
    const people = await peopleToAsk(tx, context, site.id, body.date, body.employeeIds)
    await tx.overtimeRequest.create({
      data: { id, companyId: site.companyId, siteId: site.id, lineId: body.lineId ?? null, date: dateOf(body.date), startMinute: body.startMinute ?? null, minutes: body.minutes, reason: body.reason.trim(), status: 'DRAFT', createdAt: tools.now, updatedAt: tools.now, createdById: actorId },
      select: { id: true },
    })
    await tx.overtimeAgreement.createMany({ data: people.map((person) => ({ id: newId(), siteId: site.id, requestId: id, employeeId: person.id, answer: 'PENDING' as const, createdAt: tools.now, updatedAt: tools.now, createdById: actorId })) })
    if (body.ask) {
      await refuseBlocked(tx, people, { date: body.date, startMinute: body.startMinute ?? null, minutes: body.minutes, requestId: id })
      await tx.overtimeRequest.update({ where: { id }, data: { status: 'ASKED', askedAt: tools.now, askedById: actorId, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    }
    const row = (await readRequest(tx, id))!
    tools.audit({ recordType: 'OvertimeRequest', recordId: id, companyId: row.companyId, siteId: row.siteId, after: { date: body.date, startMinute: body.startMinute ?? null, minutes: body.minutes, lineId: body.lineId ?? null, reason: body.reason.trim(), employeeIds: people.map((person) => person.id), status: row.status } })
    const counts = { asked: people.length, agreed: 0, declined: 0, pending: people.length }
    emitChanged(tools, row, 'CREATED', counts)
    if (body.ask) tools.emit({ type: 'overtime.asked', subject: id, companyId: row.companyId, siteId: row.siteId, payload: { requestId: id, date: body.date, employeeIds: people.map((person) => person.id) } })
    return recordOf(tx, context, id, now)
  })
  return { ...result, replayed }
}

async function writableRequest(caller: CommandCaller, requestId: string, permission: typeof PEOPLE_OVERTIME_MANAGE | typeof PEOPLE_OVERTIME_APPROVE): Promise<RequestRow> {
  const row = await visibleRequest(caller, requestId)
  assertMayWrite(officeOf(caller), permission, placedOf(row), permission === PEOPLE_OVERTIME_MANAGE ? MANAGE_WORDS : APPROVE_WORDS)
  return row
}

export interface EditBody {
  readonly version: number
  readonly date?: BusinessDate | undefined
  readonly startMinute?: number | null | undefined
  readonly minutes?: number | undefined
  readonly lineId?: string | null | undefined
  readonly reason?: string | undefined
}

/** PATCH /people/overtime-requests/:requestId: what a DRAFT asks. */
export async function editRequest(caller: CommandCaller, requestId: string, body: EditBody, idempotencyKey?: string, now: Date = new Date()) {
  const context = officeOf(caller)
  await writableRequest(caller, requestId, PEOPLE_OVERTIME_MANAGE)
  const { result } = await command(caller, { name: 'people.editOvertimeRequest', idempotencyKey, input: { requestId, ...body } }, async (tools) => {
    const { tx } = tools
    const { row, counts } = await lockRequest(tools, requestId, body.version, 'EDIT')
    const next = { date: body.date ?? dayOf(row.date), startMinute: body.startMinute === undefined ? row.startMinute : body.startMinute, minutes: body.minutes ?? row.minutes, lineId: body.lineId === undefined ? row.lineId : body.lineId, reason: body.reason?.trim() ?? row.reason }
    const problems = overtimePlanProblems(next)
    if (problems.length > 0) throw problemsError(problems, 'The overtime request is not valid.')
    if (next.date < todayOf(now)) throw new ValidationError('Planned overtime is for today or a later day.', [{ path: 'body/date', message: 'Today or later.' }])
    if (next.lineId && next.lineId !== row.lineId) lineCheck(await tx.line.findUnique({ where: { id: next.lineId }, select: { siteId: true, status: true, code: true } }), row.siteId)
    if (next.date !== dayOf(row.date)) {
      const agreements = await tx.overtimeAgreement.findMany({ where: { requestId }, select: { employeeId: true } })
      await peopleToAsk(tx, context, row.siteId, next.date, agreements.map((agreement) => agreement.employeeId))
    }
    await tx.overtimeRequest.update({ where: { id: requestId }, data: { date: dateOf(next.date), startMinute: next.startMinute, minutes: next.minutes, lineId: next.lineId, reason: next.reason, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ recordType: 'OvertimeRequest', recordId: requestId, companyId: row.companyId, siteId: row.siteId, before: { date: dayOf(row.date), startMinute: row.startMinute, minutes: row.minutes, lineId: row.lineId, reason: row.reason }, after: next })
    emitChanged(tools, (await readRequest(tx, requestId))!, 'EDITED', counts)
    return recordOf(tx, context, requestId, now)
  })
  return result
}

/** POST /people/overtime-requests/:requestId/people: add people (asked at once on an asked request), take off people who have not answered. */
export async function changePeople(caller: CommandCaller, requestId: string, body: { readonly version: number; readonly add?: readonly string[] | undefined; readonly remove?: readonly string[] | undefined }, idempotencyKey?: string, now: Date = new Date()) {
  const context = officeOf(caller)
  await writableRequest(caller, requestId, PEOPLE_OVERTIME_MANAGE)
  const add = [...new Set(body.add ?? [])]
  const remove = [...new Set(body.remove ?? [])]
  if (add.length === 0 && remove.length === 0) throw new ValidationError('Name the people to add or to take off.', [{ path: 'body/add', message: 'Add or take off at least one person.' }])
  const { result } = await command(caller, { name: 'people.changeOvertimePeople', idempotencyKey, input: { requestId, ...body } }, async (tools) => {
    const { tx } = tools
    const actorId = actorIdOf(tools.context)
    const { row } = await lockRequest(tools, requestId, body.version, add.length > 0 ? 'ADD_PEOPLE' : 'REMOVE_PEOPLE')
    const agreements = await tx.overtimeAgreement.findMany({ where: { requestId }, select: { id: true, employeeId: true, answer: true } })
    const asked = new Set(agreements.map((agreement) => agreement.employeeId))
    const adding = add.filter((id) => !asked.has(id))
    const people = await peopleToAsk(tx, context, row.siteId, dayOf(row.date), adding, 'add')
    remove.forEach((employeeId, index) => {
      const agreement = agreements.find((entry) => entry.employeeId === employeeId)
      if (!agreement) refuse('NOT_ASKED', 'That person is not asked on this request.', `remove/${index}`)
      if (agreement!.answer !== 'PENDING') refuse('ANSWERED', 'That person answered already: their answer stays on record (cancel the request to ask again).', `remove/${index}`)
    })
    const isAsked = row.status === 'ASKED' || row.status === 'AGREED'
    if (isAsked) await refuseBlocked(tx, people, planOf(row))
    if (people.length > 0) await tx.overtimeAgreement.createMany({ data: people.map((person) => ({ id: newId(), siteId: row.siteId, requestId, employeeId: person.id, answer: 'PENDING' as const, createdAt: tools.now, updatedAt: tools.now, createdById: actorId })) })
    if (remove.length > 0) await tx.overtimeAgreement.deleteMany({ where: { requestId, employeeId: { in: remove }, answer: 'PENDING' } })
    await tx.overtimeRequest.update({ where: { id: requestId }, data: { version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ recordType: 'OvertimeRequest', recordId: requestId, companyId: row.companyId, siteId: row.siteId, after: { added: people.map((person) => person.id), removed: remove } })
    const counts = (await countsOf(tx, [requestId])).get(requestId)!
    const fresh = (await readRequest(tx, requestId))!
    if (people.length > 0) emitChanged(tools, fresh, 'PEOPLE_ADDED', counts)
    if (remove.length > 0) emitChanged(tools, fresh, 'PEOPLE_REMOVED', counts)
    if (isAsked && people.length > 0) tools.emit({ type: 'overtime.asked', subject: requestId, companyId: row.companyId, siteId: row.siteId, payload: { requestId, date: dayOf(row.date), employeeIds: people.map((person) => person.id) } })
    return recordOf(tx, context, requestId, now)
  })
  return result
}

/** POST /people/overtime-requests/:requestId/ask: DRAFT → ASKED (each person answers on their tablet, or tells the lead). */
export async function askRequest(caller: CommandCaller, requestId: string, body: { readonly version: number }, idempotencyKey?: string, now: Date = new Date()) {
  const context = officeOf(caller)
  await writableRequest(caller, requestId, PEOPLE_OVERTIME_MANAGE)
  const { result } = await command(caller, { name: 'people.askOvertime', idempotencyKey, input: { requestId, ...body } }, async (tools) => {
    const { tx } = tools
    const { row } = await lockRequest(tools, requestId, body.version, 'ASK')
    if (dayOf(row.date) < todayOf(now)) refuse('DAY_PASSED', 'The day of this overtime has passed: cancel it.')
    const agreements = await tx.overtimeAgreement.findMany({ where: { requestId }, select: { employeeId: true } })
    const people = await peopleToAsk(tx, context, row.siteId, dayOf(row.date), agreements.map((agreement) => agreement.employeeId))
    await refuseBlocked(tx, people, planOf(row))
    await tx.overtimeRequest.update({ where: { id: requestId }, data: { status: 'ASKED', askedAt: tools.now, askedById: actorIdOf(tools.context), version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ recordType: 'OvertimeRequest', recordId: requestId, companyId: row.companyId, siteId: row.siteId, before: { status: row.status }, after: { status: 'ASKED', employeeIds: people.map((person) => person.id) } })
    tools.emit({ type: 'overtime.asked', subject: requestId, companyId: row.companyId, siteId: row.siteId, payload: { requestId, date: dayOf(row.date), employeeIds: people.map((person) => person.id) } })
    return recordOf(tx, context, requestId, now)
  })
  return result
}

/** POST /people/overtime-requests/:requestId/answers/:agreementId: what a person told the lead, recorded with who recorded it. */
export async function recordAnswer(caller: CommandCaller, requestId: string, agreementId: string, body: { readonly version: number; readonly answer: 'AGREED' | 'DECLINED' }, idempotencyKey?: string, now: Date = new Date()) {
  const context = officeOf(caller)
  await writableRequest(caller, requestId, PEOPLE_OVERTIME_MANAGE)
  const { result } = await command(caller, { name: 'people.recordOvertimeAnswer', idempotencyKey, input: { requestId, agreementId, ...body } }, async (tools) => {
    const { tx } = tools
    const { row } = await lockRequest(tools, requestId, null, 'ANSWER')
    const agreement = isUuid(agreementId) ? await tx.overtimeAgreement.findFirst({ where: { id: agreementId, requestId }, select: AGREEMENT_SELECT }) : null
    if (!agreement) throw new NotFoundError('That person is not asked on this request.')
    assertVersion('answer', agreement.version, body.version)
    await settleAnswer(tools, row, agreement, body.answer, { answeredVia: 'OFFICE', answeredById: actorIdOf(tools.context), workerId: null, deviceId: null })
    return recordOf(tx, context, requestId, now)
  })
  return result
}

/**
 * One answer written (office or floor), the stored status kept right: an AGREED request (an older row) whose last yes is
 * taken back goes back to ASKED first, so a yes can always be taken back until the approval. Audit and events.
 */
export async function settleAnswer(
  tools: CommandTools,
  row: Pick<RequestRow, 'id' | 'companyId' | 'siteId' | 'status'>,
  agreement: { readonly id: string; readonly employeeId: string; readonly answer: string },
  answer: 'AGREED' | 'DECLINED',
  channel: { readonly answeredVia: 'OFFICE' | 'FLOOR'; readonly answeredById: string | null; readonly workerId: string | null; readonly deviceId: string | null },
): Promise<Counts> {
  const { tx, now } = tools
  if (row.status === 'AGREED' && agreement.answer === 'AGREED' && answer !== 'AGREED') {
    const others = await tx.overtimeAgreement.count({ where: { requestId: row.id, answer: 'AGREED', id: { not: agreement.id } } })
    if (others === 0) await tx.overtimeRequest.update({ where: { id: row.id }, data: { status: 'ASKED', version: { increment: 1 }, updatedAt: now }, select: { id: true } })
  }
  await tx.overtimeAgreement.update({
    where: { id: agreement.id },
    data: { answer, answeredAt: now, answeredVia: channel.answeredVia, ...(channel.answeredVia === 'OFFICE' ? { answeredById: channel.answeredById } : {}), workerId: channel.workerId, deviceId: channel.deviceId, version: { increment: 1 }, updatedAt: now },
    select: { id: true },
  })
  const counts = (await countsOf(tx, [row.id])).get(row.id)!
  tools.audit({ recordType: 'OvertimeRequest', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { agreementId: agreement.id, answer: agreement.answer }, after: { agreementId: agreement.id, employeeId: agreement.employeeId, answer, via: channel.answeredVia } })
  tools.emit({ type: 'overtime.answered', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { requestId: row.id, agreementId: agreement.id, employeeId: agreement.employeeId, answer, via: channel.answeredVia, agreed: counts.agreed, asked: counts.asked } })
  return counts
}

/** POST /people/overtime-requests/:requestId/approve: once somebody agreed; only the people who said yes work it. */
export async function approveRequest(caller: CommandCaller, requestId: string, body: { readonly version: number }, idempotencyKey?: string, now: Date = new Date()) {
  const context = officeOf(caller)
  await writableRequest(caller, requestId, PEOPLE_OVERTIME_APPROVE)
  const { result } = await command(caller, { name: 'people.approveOvertime', idempotencyKey, input: { requestId, ...body } }, async (tools) => {
    const { tx } = tools
    const { row, counts } = await lockRequest(tools, requestId, body.version, 'APPROVE')
    const agreed = await tx.overtimeAgreement.findMany({ where: { requestId, answer: 'AGREED' }, select: { employeeId: true } })
    const people = await peopleFacts(tx, { id: { in: agreed.map((agreement) => agreement.employeeId) } })
    await refuseBlocked(tx, people, planOf(row))
    if (row.status === 'ASKED') await tx.overtimeRequest.update({ where: { id: requestId }, data: { status: 'AGREED', version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    await tx.overtimeRequest.update({ where: { id: requestId }, data: { status: 'APPROVED', approvedAt: tools.now, approvedById: actorIdOf(tools.context), version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ recordType: 'OvertimeRequest', recordId: requestId, companyId: row.companyId, siteId: row.siteId, before: { status: row.status }, after: { status: 'APPROVED', working: people.map((person) => person.id) } })
    emitChanged(tools, (await readRequest(tx, requestId))!, 'APPROVED', counts)
    return recordOf(tx, context, requestId, now)
  })
  return result
}

/** POST /people/overtime-requests/:requestId/cancel: with the reason (the answers stay on record). */
export async function cancelRequest(caller: CommandCaller, requestId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string, now: Date = new Date()) {
  const context = officeOf(caller)
  await writableRequest(caller, requestId, PEOPLE_OVERTIME_MANAGE)
  const { result } = await command(caller, { name: 'people.cancelOvertime', idempotencyKey, input: { requestId, ...body } }, async (tools) => {
    const { tx } = tools
    const { row, counts } = await lockRequest(tools, requestId, body.version, 'CANCEL')
    await tx.overtimeRequest.update({ where: { id: requestId }, data: { status: 'CANCELLED', cancelledAt: tools.now, cancelReason: body.reason.trim(), version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ recordType: 'OvertimeRequest', recordId: requestId, companyId: row.companyId, siteId: row.siteId, before: { status: row.status }, after: { status: 'CANCELLED' }, reason: body.reason.trim() })
    emitChanged(tools, (await readRequest(tx, requestId))!, 'CANCELLED', counts)
    return recordOf(tx, context, requestId, now)
  })
  return result
}

