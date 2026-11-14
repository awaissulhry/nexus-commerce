import type { Prisma } from '@nexus/factory-db'
import { DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { RECEIVABLES_REMINDERS_MANAGE, RECEIVABLES_VIEW } from '@nexus/factory-domain/receivables/permissions'
import type { AddStopBody, ChangeStopBody, LiftStopBody } from '@nexus/factory-domain/receivables/stops/contracts'
import { STOP_REASON_WORDS, STOP_REFUSALS, stopProblems, stopState, type StopReason, type StopRefusal, type StopState } from '@nexus/factory-domain/receivables/stops/stops'
import type { CommandCaller, CommandTools, CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { assertMay, lockCustomer, mayOn, officeContextOf, peopleOf, receivablesCommand, tenantIdOf, today, type Reader } from '../store'

/**
 * Reminder stops (B-W2b-402; FIN-112; design finance.receivables "Held (W2b stop rules)"; factory-db bank.prisma
 * ReminderStop). A person stops an invoice's reminders for a reason — a payment on its way, a dispute open, a promise to pay
 * by a day, a credit note coming — until a day or until lifted. While it holds, the reminders covering the invoice show it
 * as held and are not approved or sent (the database refuses it too: 409 receivables/REMINDER_STOPPED). Every move is ONE
 * command under the customer's advisory lock (the reminders' own), the stop FOR UPDATE at the version read:
 *
 *   GET  /receivables/stops                  receivables.view: the stops (in force by default), with the reminders they hold
 *   POST /receivables/stops                  reminders.manage: a stop on an issued TD01/TD24 (one in force per reason)
 *   PATCH /receivables/stops/:stopId         reminders.manage: its last day or note while in force
 *   POST /receivables/stops/:stopId/lift     reminders.manage: lifted early (why, when given); the reminders may go again
 */

const STOP_COLUMNS = { id: true, companyId: true, partyId: true, invoiceId: true, reason: true, until: true, note: true, liftedAt: true, liftedById: true, liftReason: true, version: true, createdAt: true, createdById: true } as const satisfies Prisma.ReminderStopSelect
type StopRow = Prisma.ReminderStopGetPayload<{ select: typeof STOP_COLUMNS }>

const day = (value: Date | null): BusinessDate | null => (value ? businessDate(value, 'UTC') : null)
const refusedStop = (code: StopRefusal, path = `stop/${code}`): DomainError => new DomainError('conflict', STOP_REFUSALS[code], [{ path, message: STOP_REFUSALS[code] }])

async function stopViews(db: Reader, context: RequestContext, rows: readonly StopRow[]) {
  if (rows.length === 0) return []
  const onDay = today()
  const companies = new Map((await db.company.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.companyId))] } }, select: { id: true, code: true, legalName: true } })).map((row) => [row.id, row]))
  const parties = new Map((await db.party.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.partyId))] } }, select: { id: true, code: true, legalName: true } })).map((row) => [row.id, row]))
  const invoices = new Map((await db.invoice.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.invoiceId))] } }, select: { id: true, number: true } })).map((row) => [row.id, row]))
  const reminders = await db.paymentReminder.findMany({ where: { status: { in: ['PREPARED', 'APPROVED'] }, invoiceIds: { hasSome: [...new Set(rows.map((row) => row.invoiceId))] } }, select: { id: true, invoiceIds: true } })
  const people = await peopleOf(db, rows.flatMap((row) => [row.createdById, row.liftedById]))
  const person = (id: string | null) => (id ? { id, name: people.get(id) ?? null } : null)
  return rows.map((row) => {
    const until = day(row.until)
    const state = stopState({ liftedAt: row.liftedAt, until }, onDay)
    const manage = context.audience === 'office' && mayOn(context, RECEIVABLES_REMINDERS_MANAGE, row)
    return {
      id: row.id,
      company: { id: row.companyId, code: companies.get(row.companyId)?.code ?? '', name: companies.get(row.companyId)?.legalName ?? '' },
      customer: { id: row.partyId, code: parties.get(row.partyId)?.code ?? '', name: parties.get(row.partyId)?.legalName ?? '' },
      invoice: { id: row.invoiceId, number: invoices.get(row.invoiceId)?.number ?? null },
      reason: row.reason as StopReason,
      reasonWords: STOP_REASON_WORDS[row.reason as StopReason],
      until,
      note: row.note,
      state,
      holdsReminders: state === 'holding' ? reminders.filter((reminder) => reminder.invoiceIds.includes(row.invoiceId)).map((reminder) => reminder.id) : [],
      createdAt: toUtcIso(row.createdAt),
      createdBy: person(row.createdById),
      liftedAt: row.liftedAt ? toUtcIso(row.liftedAt) : null,
      liftedBy: person(row.liftedById),
      liftReason: row.liftReason,
      can: { change: manage && state === 'holding', lift: manage && state === 'holding' },
      version: row.version,
    }
  })
}

const STATE_WHERE = (state: StopState, onDay: BusinessDate): Prisma.ReminderStopWhereInput => {
  const dayValue = new Date(`${onDay}T00:00:00.000Z`)
  if (state === 'holding') return { liftedAt: null, OR: [{ until: null }, { until: { gte: dayValue } }] }
  if (state === 'lifted') return { liftedAt: { not: null } }
  if (state === 'over') return { liftedAt: null, until: { lt: dayValue } }
  return {}
}

/** GET /receivables/stops (receivables.view). */
export async function listStops(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly partyId?: string | undefined; readonly invoiceId?: string | undefined; readonly state: StopState; readonly limit: number }) {
  const context = officeContextOf(caller)
  const scope = scopeWhere(actorOf(context), RECEIVABLES_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.ReminderStopWhereInput
  return caller.withClient(async (db) => {
    const rows = await db.reminderStop.findMany({
      where: { AND: [scope, STATE_WHERE(query.state, today()), query.companyId ? { companyId: query.companyId } : {}, query.partyId ? { partyId: query.partyId } : {}, query.invoiceId ? { invoiceId: query.invoiceId } : {}] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
      select: STOP_COLUMNS,
    })
    return { stops: await stopViews(db, context, rows) }
  })
}

async function oneStop(tools: Pick<CommandTools, 'tx' | 'context'>, stopId: string) {
  const row = (await tools.tx.reminderStop.findUnique({ where: { id: stopId }, select: STOP_COLUMNS }))!
  return { stop: (await stopViews(tools.tx, tools.context, [row]))[0]! }
}

/** POST /receivables/stops (reminders.manage): a stop on an issued invoice's reminders. */
export async function addStop(caller: CommandCaller, body: AddStopBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const invoice = isUuid(body.invoiceId) ? await caller.withClient((db) => db.invoice.findUnique({ where: { id: body.invoiceId }, select: { id: true, companyId: true, buyerPartyId: true, docType: true, status: true } })) : null
  const scope = invoice ? { companyId: invoice.companyId, partyId: invoice.buyerPartyId } : null
  assertMay(context, RECEIVABLES_VIEW, RECEIVABLES_REMINDERS_MANAGE, scope, 'Invoice')
  if (invoice!.status === 'DRAFT' || (invoice!.docType !== 'TD01' && invoice!.docType !== 'TD24')) throw refusedStop('NOT_AN_INVOICE', 'body/invoiceId')
  const onDay = today()
  const problems = stopProblems({ reason: body.reason, until: body.until ?? null, note: body.note ?? null }, onDay)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const { result } = await receivablesCommand(caller, { name: 'receivables.stopAdd', idempotencyKey, input: body }, async (tools) => {
    await lockCustomer(tools.tx, tenantIdOf(tools.context), scope!)
    const same = await tools.tx.reminderStop.findFirst({ where: { invoiceId: body.invoiceId, reason: body.reason, ...STATE_WHERE('holding', onDay) }, select: { id: true } })
    if (same) throw refusedStop('SAME_STOP')
    const id = newId()
    await tools.tx.reminderStop.create({ data: { id, companyId: scope!.companyId, partyId: scope!.partyId, invoiceId: body.invoiceId, reason: body.reason, until: body.until ? new Date(`${body.until}T00:00:00.000Z`) : null, note: body.note ?? null, createdAt: tools.now, updatedAt: tools.now, createdById: context.actorId }, select: { id: true } })
    tools.audit({ action: 'receivables.stopAdd', recordType: 'ReminderStop', recordId: id, companyId: scope!.companyId, after: { invoiceId: body.invoiceId, partyId: scope!.partyId, reason: body.reason, until: body.until ?? null, note: body.note ?? null } })
    tools.emit({ type: 'reminder_stop.changed', subject: id, companyId: scope!.companyId, payload: { stopId: id, invoiceId: body.invoiceId, partyId: scope!.partyId, reason: body.reason, action: 'ADDED' } })
    return oneStop(tools, id)
  })
  return result
}

async function lockStop(tx: CommandTx, stopId: string, version: number): Promise<StopRow> {
  await tx.$queryRaw`SELECT id FROM "ReminderStop" WHERE id = ${stopId}::uuid FOR UPDATE`
  const row = await tx.reminderStop.findUnique({ where: { id: stopId }, select: STOP_COLUMNS })
  if (!row) throw new NotFoundError('Stop not found.')
  if (row.version !== version) throw new DomainError('conflict', `This stop changed since it was read (version ${version}); it is now at version ${row.version}. Reload it and try again.`, [{ path: 'body/version', message: `The current version is ${row.version}.` }])
  return row
}

async function onStop<Result>(caller: CommandCaller, stopId: string, spec: { readonly name: 'receivables.stopChange' | 'receivables.stopLift'; readonly idempotencyKey?: string | undefined; readonly input: object; readonly version: number }, work: (tools: CommandTools, row: StopRow) => Promise<Result>) {
  const context = officeContextOf(caller)
  const peek = isUuid(stopId) ? await caller.withClient((db) => db.reminderStop.findUnique({ where: { id: stopId }, select: STOP_COLUMNS })) : null
  assertMay(context, RECEIVABLES_VIEW, RECEIVABLES_REMINDERS_MANAGE, peek, 'Stop')
  const { result } = await receivablesCommand(caller, { name: spec.name, idempotencyKey: spec.idempotencyKey, input: { stopId, ...spec.input } }, async (tools) => {
    await lockCustomer(tools.tx, tenantIdOf(tools.context), peek!)
    const row = await lockStop(tools.tx, stopId, spec.version)
    const state = stopState({ liftedAt: row.liftedAt, until: day(row.until) }, today())
    if (state === 'lifted') throw refusedStop('LIFTED')
    if (state === 'over') throw refusedStop('OVER')
    return work(tools, row)
  })
  return result
}

/** PATCH /receivables/stops/:stopId (reminders.manage): its last day or note while in force. */
export async function changeStop(caller: CommandCaller, stopId: string, body: ChangeStopBody, idempotencyKey?: string) {
  return onStop(caller, stopId, { name: 'receivables.stopChange', idempotencyKey, input: body, version: body.version }, async (tools, row) => {
    const until = body.until === undefined ? day(row.until) : body.until
    const note = body.note === undefined ? row.note : body.note
    const problems = stopProblems({ reason: row.reason as StopReason, until, note }, today())
    if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
    await tools.tx.reminderStop.update({ where: { id: row.id }, data: { until: until ? new Date(`${until}T00:00:00.000Z`) : null, note, version: row.version + 1, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'receivables.stopChange', recordType: 'ReminderStop', recordId: row.id, companyId: row.companyId, before: { until: day(row.until), note: row.note }, after: { until, note } })
    tools.emit({ type: 'reminder_stop.changed', subject: row.id, companyId: row.companyId, payload: { stopId: row.id, invoiceId: row.invoiceId, partyId: row.partyId, reason: row.reason as StopReason, action: 'CHANGED' } })
    return oneStop(tools, row.id)
  })
}

/** POST /receivables/stops/:stopId/lift (reminders.manage): lifted early; the reminders may go again. */
export async function liftStop(caller: CommandCaller, stopId: string, body: LiftStopBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  return onStop(caller, stopId, { name: 'receivables.stopLift', idempotencyKey, input: body, version: body.version }, async (tools, row) => {
    await tools.tx.reminderStop.update({ where: { id: row.id }, data: { liftedAt: tools.now, liftedById: context.actorId, liftReason: body.reason ?? null, version: row.version + 1, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'receivables.stopLift', recordType: 'ReminderStop', recordId: row.id, companyId: row.companyId, before: { lifted: false }, after: { lifted: true }, ...(body.reason ? { reason: body.reason } : {}) })
    tools.emit({ type: 'reminder_stop.changed', subject: row.id, companyId: row.companyId, payload: { stopId: row.id, invoiceId: row.invoiceId, partyId: row.partyId, reason: row.reason as StopReason, action: 'LIFTED' } })
    return oneStop(tools, row.id)
  })
}
