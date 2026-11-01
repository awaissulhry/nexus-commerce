import type { FactoryClient } from '@nexus/factory-db'
import { eachDay, plusDays } from '@nexus/factory-domain/calendars/dates'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { parseInstant, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { overtimeActionRefusal, overtimeStageOf, type OvertimeStatus } from '@nexus/factory-domain/people/shifts/rules'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import type { FloorContext } from '../../../core/context'
import { systemContext } from '../../../platform/outbox/system'
import { floorOf } from '../../../platform/privacy/access'
import { dateOf, dayOf, refuse, todayOf } from '../employees/access'
import { settleAnswer } from './overtime'
import { peopleFacts, planningFor } from './planner'
import { valueView } from './roster'

/**
 * The worker's own shifts and overtime asks on the tablet (B-W2b-32; design people.shifts "Request overtime: sends the
 * ask to each worker's My day on the floor", floor.myday, floor.clock "next break"; the screens are B-W2b-67/68), floor
 * only, floor.work at the device's site. Only the signed-in worker's own: their PUBLISHED roster and their default shift
 * for the days without one, the asks they are part of.
 *
 *   GET  /people/floor/my-shifts                               the next days (14 unless asked, at most 31) and the asks
 *   POST /people/floor/overtime-asks/:agreementId/answer       the worker's own yes or no (D.Lgs. 66/2003 art. 5: overtime
 *                                                              by agreement), signed with the PIN (requireFloorStepUp,
 *                                                              asked after every other check)
 *
 * The floor role reads its site's PUBLISHED roster rows and the asks from ASKED on, never the employee record, the
 * patterns or the calendars: the default shift of the worker's own days is read in the tenant's system scope, for that
 * one person only (nothing else is read with it). A yes can be taken back until the request is approved; an answer the
 * lead recorded in the office is changed by the lead (the tablet records the worker's own answer and nothing else).
 */

type Client = FactoryClient | CommandTx

/** Reads in the tenant's system scope for the signed-in worker's own record (the floor has no grant on it). */
async function asSystemFor<T>(caller: CommandCaller, context: FloorContext, read: (client: FactoryClient) => Promise<T>): Promise<T> {
  const system = Object.create(caller) as CommandCaller & { factoryContext: CommandCaller['factoryContext'] }
  system.factoryContext = systemContext(context.tenantId, context.requestId)
  return system.withClient(read)
}

const ASK_SELECT = {
  id: true,
  requestId: true,
  employeeId: true,
  answer: true,
  answeredAt: true,
  answeredVia: true,
  version: true,
} as const

const REQUEST_ON_FLOOR = { id: true, companyId: true, siteId: true, date: true, startMinute: true, minutes: true, reason: true, status: true, line: { select: { id: true, code: true, name: true } } } as const

async function agreedOf(client: Client, requestIds: readonly string[]): Promise<Map<string, { agreed: number; asked: number }>> {
  const out = new Map<string, { agreed: number; asked: number }>(requestIds.map((id) => [id, { agreed: 0, asked: 0 }]))
  if (requestIds.length === 0) return out
  const rows = await client.overtimeAgreement.groupBy({ by: ['requestId', 'answer'], where: { requestId: { in: [...requestIds] } }, _count: { _all: true } })
  for (const row of rows) {
    const counts = out.get(row.requestId)!
    counts.asked += row._count._all
    if (row.answer === 'AGREED') counts.agreed += row._count._all
  }
  return out
}

function askView(
  agreement: { readonly id: string; readonly answer: 'PENDING' | 'AGREED' | 'DECLINED'; readonly answeredAt: Date | null; readonly version: number },
  request: { readonly id: string; readonly date: Date; readonly startMinute: number | null; readonly minutes: number; readonly reason: string; readonly status: OvertimeStatus; readonly line: { readonly id: string; readonly code: string; readonly name: string } | null },
  agreed: number,
  today: BusinessDate,
) {
  const date = dayOf(request.date)
  return {
    agreementId: agreement.id,
    requestId: request.id,
    date,
    startMinute: request.startMinute,
    minutes: request.minutes,
    reason: request.reason,
    line: request.line,
    stage: overtimeStageOf(request.status, agreed),
    answer: agreement.answer,
    answeredAt: agreement.answeredAt ? toUtcIso(agreement.answeredAt) : null,
    canAnswer: overtimeActionRefusal('ANSWER', { status: request.status, asked: 1, agreed }) === null && date >= today,
    version: agreement.version,
  }
}

/** GET /people/floor/my-shifts. */
export async function myShifts(caller: CommandCaller, query: { readonly days?: number | undefined }, now: Date = new Date()) {
  const context = floorOf(caller)
  const today = todayOf(now)
  const to = plusDays(today, (query.days ?? 14) - 1)
  const worker = await caller.withClient((client) => client.worker.findUnique({ where: { id: context.actorId }, select: { employeeId: true } }))
  const employeeId = worker?.employeeId ?? null
  if (!employeeId) return { employeeId: null, today, days: [], asks: [] }
  const planning = await asSystemFor(caller, context, async (client) => {
    const people = await peopleFacts(client, { id: employeeId, siteId: context.siteId })
    return people.length === 0 ? null : planningFor(client, people, { from: today, to }, { publishedOnly: true })
  })
  return caller.withClient(async (client) => {
    const agreements = await client.overtimeAgreement.findMany({ where: { employeeId, request: { date: { gte: dateOf(today) } } }, select: { ...ASK_SELECT, request: { select: REQUEST_ON_FLOOR } }, orderBy: [{ createdAt: 'asc' }] })
    const counts = await agreedOf(client, agreements.map((agreement) => agreement.requestId))
    const asks = agreements.map((agreement) => askView(agreement, agreement.request, counts.get(agreement.requestId)?.agreed ?? 0, today)).sort((a, b) => a.date.localeCompare(b.date))
    const days = planning?.cells.get(employeeId)
    return {
      employeeId,
      today,
      days: days
        ? eachDay(today, to).map((date) => {
            const cell = days.get(date)!
            return {
              date,
              source: cell.source,
              value: valueView(cell.value),
              overtime: asks.filter((ask) => ask.date === date && ask.answer !== 'DECLINED').map((ask) => ({ requestId: ask.requestId, agreementId: ask.agreementId, startMinute: ask.startMinute, minutes: ask.minutes, stage: ask.stage, answer: ask.answer })),
            }
          })
        : [],
      asks,
    }
  })
}

/** POST /people/floor/overtime-asks/:agreementId/answer: the worker's own answer, signed with the PIN (`sign`). */
export async function answerOnFloor(caller: CommandCaller, agreementId: string, body: { readonly version: number; readonly answer: 'AGREED' | 'DECLINED'; readonly deviceTime?: string | undefined }, idempotencyKey: string | undefined, sign: () => void, now: Date = new Date()) {
  const context = floorOf(caller)
  const today = todayOf(now)
  const own = await caller.withClient(async (client) => {
    const worker = await client.worker.findUnique({ where: { id: context.actorId }, select: { employeeId: true } })
    const agreement = isUuid(agreementId) ? await client.overtimeAgreement.findUnique({ where: { id: agreementId }, select: { employeeId: true } }) : null
    return worker?.employeeId && agreement?.employeeId === worker.employeeId
  })
  // Another person's ask is not found (a tablet answers for the signed-in worker only).
  if (!own) throw new NotFoundError('Overtime ask not found.')
  sign()
  const deviceTime = body.deviceTime ? (parseInstant(body.deviceTime) ?? undefined) : undefined
  const { result } = await command(caller, { name: 'people.answerOvertimeAsk', idempotencyKey, input: { agreementId, ...body }, ...(deviceTime ? { deviceTime } : {}) }, async (tools) => {
    const { tx } = tools
    const first = (await tx.overtimeAgreement.findUnique({ where: { id: agreementId }, select: { requestId: true } }))!
    // The request's own key first (the guard takes it too): answers and the approval take turns.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.time.overtime-request', ${context.tenantId}::uuid, ${first.requestId}::uuid), 0))`
    const agreement = (await tx.overtimeAgreement.findUnique({ where: { id: agreementId }, select: ASK_SELECT }))!
    const request = await tx.overtimeRequest.findUnique({ where: { id: agreement.requestId }, select: REQUEST_ON_FLOOR })
    if (!request) refuse('NOT_ASKED', 'This overtime is not asked (or it was cancelled).')
    const counts = (await agreedOf(tx, [request!.id])).get(request!.id)!
    const refusal = overtimeActionRefusal('ANSWER', { status: request!.status, asked: counts.asked, agreed: counts.agreed })
    if (refusal) refuse('NOT_ANSWER', refusal)
    if (dayOf(request!.date) < today) refuse('DAY_PASSED', 'The day of this overtime has passed.')
    if (agreement.version !== body.version) refuse('STALE', 'Your answer changed since this screen was read: read it again.')
    if (agreement.answeredVia === 'OFFICE') refuse('ANSWERED_IN_OFFICE', 'Your answer was recorded by your team leader: tell them to change it.')
    if (request!.status === 'AGREED' && agreement.answer === 'AGREED' && body.answer !== 'AGREED' && counts.agreed === 1) refuse('LAST_YES', 'You are the only yes of this overtime: tell your team leader to take it back.')
    await settleAnswer(tools, request!, agreement, body.answer, { answeredVia: 'FLOOR', answeredById: null, workerId: context.actorId, deviceId: context.deviceId })
    const fresh = (await tx.overtimeAgreement.findUnique({ where: { id: agreementId }, select: ASK_SELECT }))!
    const after = (await agreedOf(tx, [request!.id])).get(request!.id)!
    return { ask: askView(fresh, request!, after.agreed, today) }
  })
  return result
}
