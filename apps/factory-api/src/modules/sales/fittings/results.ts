import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { SALES_MEASUREMENTS_VIEW } from '@nexus/factory-domain/sales/measure-link/permissions'
import { promiseStateProblem, type SalesOrderStatus } from '@nexus/factory-domain/sales/orders/orders'
import { ORDERS_MANAGE } from '@nexus/factory-domain/sales/orders/permissions'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
import { SALES_REPAIRS_MANAGE } from '@nexus/factory-domain/sales/repairs/permissions'
import { REPAIR_LIMITS } from '@nexus/factory-domain/sales/repairs/rules'
import type { AlterationBody, ResultBody, RevisionBody } from '@nexus/factory-domain/sales/fittings/contracts'
import { SALES_FITTINGS_MANAGE } from '@nexus/factory-domain/sales/fittings/permissions'
import { alterationWords, CLOCK_SLACK_MS, pointChangesOf, verdictProblems, type AppointmentKind, type FittingVerdict } from '@nexus/factory-domain/sales/fittings/rules'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { assertMayProfile, chainOf, measurementsOf, nextFittingOf, officeOf, profileNotFound, profileOf, type ProfileRow } from '../mtm/store'
import { changePromiseInCommand } from '../orders/moves'
import { dayOrNull } from '../orders/store'
import { createRepairInCommand } from '../repairs/create'
import { appointmentRows, APPOINTMENT_SELECT, bookedGarmentsOf, garmentRefusal, mayOn, RESULT_RECORD, RESULT_SELECT, resultNotFound, resultOf, resultViews, sees, type Reader, type ResultRow } from './store'

/**
 * What a fitting found and the alteration loop (B-W2b-360; SAL-297 "Alteration loop after fitting"; design sales.mtm › Fittings
 * "Outcome: fits / alteration needed · Alteration sent back, with the date moved by its time", "Record outcome"):
 *
 *   POST /sales/fittings/results                    a fitting's result: of a FITTING appointment and/or a made-to-measure order
 *                                                   line, the revision fitted, per point the change asked, OK | ALTER | REMAKE;
 *                                                   a BOOKED fitting that has started is closed DONE in the same command
 *   GET  /sales/fittings/results/:id                the result as the office reads it (points named, the alteration, the new
 *                                                   revision, the unit's promise and the date its alteration moves it to)
 *   POST /sales/fittings/results/:id/alteration     ALTER: the alteration it opens — W2a's repair command (createRepairInCommand,
 *                                                   kind ALTERATION, the work wanted in words; a protective garment keeps its
 *                                                   safety check, B-W2b-342) and the result naming it, in ONE command; with an
 *                                                   order line and its days, the line's promise moved by them (W1's typed
 *                                                   promise change with its history, B-W2b-317) when the caller holds
 *                                                   orders.manage and the order may still change its lines
 *   POST /sales/fittings/results/:id/revision       ALTER or REMAKE: names the new revision it led to (recorded first through
 *                                                   B-W2b-358's POST /sales/mtm/profiles/:id/revisions), once
 *   GET  /sales/mtm/profiles/:profileId/fittings    the rider profile's Fittings tab: the appointments of the rider's garment
 *                                                   type (every revision, and the rider's — by contact or name — not yet tied to
 *                                                   one, booked for that garment type) and the fittings' results
 *
 * Who: sales.fittings.manage over the result's company and customer (reading: sales.measurements.view); the alteration also
 * sales.repairs.manage. Made-to-measure switched off for the profile's template (GATE-MTM): nothing is recorded or opened. Every
 * database rule (FittingResult_guard) is said in words first.
 */

const invalid = (issues: Issue[]): ValidationError => new ValidationError(issues.length === 1 ? issues[0]!.message : 'The fitting result cannot be recorded like this.', issues)
const blank = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

async function viewOf(caller: CommandCaller, context: OfficeContext, id: string) {
  return caller.withClient(async (db) => (await resultViews(db, context, [(await resultOf(db, id))!]))[0]!)
}

async function assertStarted(db: Reader, garmentType: string): Promise<void> {
  const refusal = await garmentRefusal(db, garmentType)
  if (refusal) throw new ConflictError(refusal)
}

// ---- record a result -------------------------------------------------------------------------------------------------------

/** POST /sales/fittings/results */
export async function recordResult(caller: CommandCaller, body: ResultBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const now = serverClock.now()
  if (!body.appointmentId && !body.salesOrderLineId) throw invalid([{ path: 'body/appointmentId', message: 'A result is of a fitting appointment, of a made-to-measure order line, or of both.' }])
  const plan = await caller.withClient(async (db) => {
    const issues: Issue[] = []
    const appointment = body.appointmentId ? (isUuid(body.appointmentId) ? await db.appointment.findUnique({ where: { id: body.appointmentId }, select: APPOINTMENT_SELECT }) : null) : null
    if (body.appointmentId && (!appointment || !sees(context, appointment))) throw new NotFoundError('Appointment not found.')
    const line = body.salesOrderLineId
      ? isUuid(body.salesOrderLineId)
        ? await db.salesOrderLine.findUnique({ where: { id: body.salesOrderLineId }, select: { id: true, kind: true, companyId: true, partyId: true, measurementProfileId: true, seq: true } })
        : null
      : null
    if (body.salesOrderLineId && (!line || !can(actor, SALES_MEASUREMENTS_VIEW, { companyId: line.companyId, partyId: line.partyId }))) throw new NotFoundError('Order line not found.')
    const companyId = appointment?.companyId ?? line!.companyId
    const partyId = appointment?.partyId ?? line!.partyId
    if (!can(actor, SALES_FITTINGS_MANAGE, { companyId, partyId })) throw new ForbiddenError('Your roles do not book or record fittings (sales.fittings.manage).')
    if (appointment) {
      if (appointment.kind !== 'FITTING') issues.push({ path: 'body/appointmentId', message: 'A result is of a fitting (not of a showroom visit or a measuring session).' })
      if (appointment.status === 'MISSED' || appointment.status === 'CANCELLED') issues.push({ path: 'body/appointmentId', message: `The fitting was ${appointment.status.toLowerCase()}: nothing was fitted.` })
      if (appointment.status === 'BOOKED' && appointment.startsAt.getTime() > now.getTime()) issues.push({ path: 'body/appointmentId', message: 'The fitting has not started yet.' })
      if (appointment.status === 'BOOKED' && appointment.withUserId === null && appointment.withName === null) issues.push({ path: 'body/appointmentId', message: 'Say who was at the fitting first: close it as done with the fitter (POST …/close).' })
    }
    if (line) {
      if (line.kind !== 'MADE_TO_MEASURE') issues.push({ path: 'body/salesOrderLineId', message: `Line ${line.seq} is not a made-to-measure unit.` })
      if (appointment && (line.companyId !== appointment.companyId || line.partyId !== appointment.partyId)) issues.push({ path: 'body/salesOrderLineId', message: 'The order line is of another company or customer than the fitting.' })
    }
    const profileId = body.measurementProfileId ?? line?.measurementProfileId ?? appointment?.measurementProfileId ?? null
    if (line?.measurementProfileId && profileId !== line.measurementProfileId) issues.push({ path: 'body/measurementProfileId', message: 'The revision fitted is the one the unit was made to.' })
    const profile = profileId ? await profileOf(db, profileId) : null
    if (!profile || profile.partyId !== partyId) issues.push({ path: 'body/measurementProfileId', message: "Name the rider's measurement profile revision the unit was made to." })
    if (issues.length > 0) throw invalid(issues)
    await assertStarted(db, profile!.garmentType)
    const fittedAt = body.fittedAt ? new Date(body.fittedAt) : now
    const changes = pointChangesOf(body.pointChanges, measurementsOf(profile!.measurements))
    const notes = blank(body.notes)
    issues.push(...changes.problems, ...verdictProblems({ verdict: body.verdict as FittingVerdict, points: Object.keys(changes.changes).length, notes, alterationDays: body.alterationDays ?? null }))
    if (fittedAt.getTime() > now.getTime() + CLOCK_SLACK_MS) issues.push({ path: 'body/fittedAt', message: 'The fitting took place: now or earlier.' })
    if (fittedAt.getTime() < profile!.takenAt.getTime()) issues.push({ path: 'body/fittedAt', message: `The fitting is after the rider was measured (revision ${profile!.revision}).` })
    if (appointment && fittedAt.getTime() < appointment.startsAt.getTime()) issues.push({ path: 'body/fittedAt', message: 'The fitting is not before its appointment started.' })
    if (issues.length > 0) throw invalid(issues)
    if (appointment) {
      const twice = await db.fittingResult.findFirst({ where: { appointmentId: appointment.id, salesOrderLineId: line?.id ?? null }, select: { id: true } })
      if (twice) throw new ConflictError(line ? 'This fitting has a result for this unit already.' : 'This fitting has a result already: record another unit with its order line.')
    }
    return { appointment, line, companyId, partyId, profile: profile!, fittedAt, changes: changes.changes, notes }
  })
  const { result } = await command(caller, { name: 'fittings.recordResult', idempotencyKey, input: body }, async (tools) => {
    let closed = false
    const appointment = plan.appointment
    if (appointment && appointment.status === 'BOOKED') {
      await tools.tx.$queryRaw`SELECT 1 FROM "Appointment" WHERE id = ${appointment.id}::uuid FOR UPDATE`
      const fresh = await tools.tx.appointment.findUnique({ where: { id: appointment.id }, select: { status: true, version: true } })
      if (fresh?.status === 'BOOKED') {
        await tools.tx.appointment.update({ where: { id: appointment.id }, data: { status: 'DONE', closedAt: tools.now, closedById: context.actorId, version: { increment: 1 }, updatedAt: tools.now, updatedById: context.actorId }, select: { id: true } })
        tools.audit({ action: 'fittings.close', recordType: 'Appointment', recordId: appointment.id, companyId: appointment.companyId, before: { status: 'BOOKED' }, after: { status: 'DONE', closedAt: toUtcIso(tools.now), by: 'fitting result' } })
        tools.emit({ type: 'appointment.closed', subject: appointment.id, companyId: appointment.companyId, payload: { appointmentId: appointment.id, partyId: appointment.partyId, kind: appointment.kind as AppointmentKind, status: 'DONE' } })
        closed = true
      }
    }
    const id = newId()
    await tools.tx.fittingResult.create({
      data: {
        id,
        companyId: plan.companyId,
        partyId: plan.partyId,
        appointmentId: appointment?.id ?? null,
        salesOrderLineId: plan.line?.id ?? null,
        measurementProfileId: plan.profile.id,
        fittedAt: plan.fittedAt,
        verdict: body.verdict,
        pointChanges: plan.changes as unknown as Prisma.InputJsonValue,
        notes: plan.notes,
        alterationDays: body.alterationDays ?? null,
        createdAt: tools.now,
        updatedAt: tools.now,
        createdById: context.actorId,
      },
      select: { id: true },
    })
    // The audit names the points changed and how many, never a value (body data).
    tools.audit({ recordType: RESULT_RECORD, recordId: id, companyId: plan.companyId, after: { verdict: body.verdict, appointmentId: appointment?.id ?? null, salesOrderLineId: plan.line?.id ?? null, profileId: plan.profile.id, points: Object.keys(plan.changes), alterationDays: body.alterationDays ?? null, fittedAt: toUtcIso(plan.fittedAt) } })
    tools.emit({ type: 'fitting_result.recorded', subject: id, companyId: plan.companyId, payload: { resultId: id, partyId: plan.partyId, profileId: plan.profile.id, verdict: body.verdict as FittingVerdict, appointmentId: appointment?.id ?? null, salesOrderLineId: plan.line?.id ?? null } })
    return { id, closed }
  })
  return { result: await viewOf(caller, context, result.id), appointmentClosed: result.closed }
}

/** GET /sales/fittings/results/:id */
export async function getResult(caller: CommandCaller, id: string) {
  const context = officeOf(caller)
  const row = await caller.withClient((db) => resultOf(db, id))
  if (!row || !sees(context, row)) throw resultNotFound()
  return { result: await viewOf(caller, context, row.id) }
}

/** The result the caller reads and writes (else not found / forbidden), its profile, and made-to-measure started for it. */
async function writableResult(caller: CommandCaller, id: string): Promise<{ context: OfficeContext; row: ResultRow; profile: ProfileRow }> {
  const context = officeOf(caller)
  const found = await caller.withClient(async (db) => {
    const row = await resultOf(db, id)
    return row ? { row, profile: (await profileOf(db, row.measurementProfileId))! } : null
  })
  if (!found || !sees(context, found.row)) throw resultNotFound()
  if (!mayOn(context, SALES_FITTINGS_MANAGE, found.row)) throw new ForbiddenError('Your roles do not book or record fittings (sales.fittings.manage).')
  await caller.withClient((db) => assertStarted(db, found.profile.garmentType))
  return { context, ...found }
}

// ---- the alteration --------------------------------------------------------------------------------------------------------

interface PromiseMove {
  readonly moved: boolean
  readonly from: BusinessDate | null
  readonly to: BusinessDate | null
  readonly why: string | null
}

/** POST /sales/fittings/results/:id/alteration */
export async function openAlteration(caller: CommandCaller, id: string, body: AlterationBody, idempotencyKey?: string) {
  const { context, row } = await writableResult(caller, id)
  if (row.verdict !== 'ALTER') throw new ConflictError(`The fitting found ${row.verdict === 'OK' ? 'that it fits' : 'that the unit is remade'}: there is nothing to alter.`)
  if (row.alterationRepairId) throw new ConflictError('This fitting opened its alteration already.')
  if (!mayOn(context, SALES_REPAIRS_MANAGE, row)) throw new ForbiddenError('Opening the alteration needs sales.repairs.manage over the customer (the alteration is a repair order of kind ALTERATION).')
  const now = serverClock.now()
  const facts = await caller.withClient(async (db) => {
    const line = row.salesOrderLineId ? await db.salesOrderLine.findUnique({ where: { id: row.salesOrderLineId }, select: { id: true, styleId: true, colourwayId: true, baseSize: true, promiseDate: true, order: { select: { id: true, number: true, companyId: true, partyId: true, status: true, promiseDate: true } } } }) : null
    const [view] = await resultViews(db, context, [row])
    const names = Object.fromEntries(view!.pointChanges.map((point) => [point.code, point.name]))
    const changes = (row.pointChanges ?? {}) as Record<string, { change: string; unit: 'cm' | 'mm'; note?: string }>
    return { line, work: blank(body.workWanted) ?? alterationWords(changes, names, row.notes, REPAIR_LIMITS.problem) }
  })
  // The unit's date moved by the alteration's days (W1's typed promise change, B-W2b-317's history), or why not.
  const line = facts.line
  const from = line ? dayOrNull(line.promiseDate ?? line.order.promiseDate) : null
  const to = from && row.alterationDays ? addDays(from, row.alterationDays) : null
  let promise: PromiseMove = { moved: false, from, to, why: null }
  if (!body.movePromise) promise = { ...promise, why: 'Not asked.' }
  else if (!line) promise = { ...promise, why: 'The fitting names no order line: no date to move.' }
  else if (!row.alterationDays) promise = { ...promise, why: 'The fitting gave no days for the alteration.' }
  else if (!from) promise = { ...promise, why: `${line.order.number} has no promise date to move.` }
  else if (!can(actorOf(context), ORDERS_MANAGE, { companyId: line.order.companyId, partyId: line.order.partyId })) promise = { ...promise, why: `Moving ${line.order.number}'s promise needs orders.manage: sales moves it to ${to}.` }
  else {
    const held = promiseStateProblem(line.order.status as SalesOrderStatus, true) ?? (to! < businessDate(now) ? `Moved by ${row.alterationDays} days the promise would still be past (${to}): sales sets a new date.` : null)
    promise = held ? { ...promise, why: held } : { ...promise, moved: true }
  }
  const { result } = await command(caller, { name: 'fittings.openAlteration', idempotencyKey, input: { id, ...body }, record: { type: 'FittingResult', id: row.id, expectedVersion: body.version } }, async (tools) => {
    const made = await createRepairInCommand(tools, context, {
      companyId: row.companyId,
      partyId: row.partyId,
      kind: 'ALTERATION',
      ...(line ? { styleId: line.styleId, colourwayId: line.colourwayId, size: line.baseSize } : {}),
      problem: facts.work,
      workWanted: facts.work,
      ...(body.siteId ? { siteId: body.siteId } : {}),
      ...(body.received ? { received: { ...(body.received.at ? { at: body.received.at } : {}) } } : {}),
      internalNote: body.internalNote ?? `Alteration after the fitting of ${toUtcIso(row.fittedAt)}.`,
    })
    await tools.tx.fittingResult.update({ where: { id: row.id }, data: { alterationRepairId: made.repairId, updatedAt: tools.now }, select: { id: true } })
    if (promise.moved && line) await changePromiseInCommand(tools, line.order, { promiseDate: promise.to!, reason: `Alteration after the fitting: ${row.alterationDays} days (${made.number}).`, lineIds: [line.id] })
    tools.audit({ recordType: RESULT_RECORD, recordId: row.id, companyId: row.companyId, before: { alterationRepairId: null }, after: { alterationRepairId: made.repairId, number: made.number, promiseMoved: promise.moved ? { from: promise.from, to: promise.to } : null } })
    tools.emit({ type: 'fitting_result.linked', subject: row.id, companyId: row.companyId, payload: { resultId: row.id, partyId: row.partyId, alterationRepairId: made.repairId, newProfileId: null } })
    return { repairId: made.repairId, number: made.number, warnings: made.warnings.map((warning) => ({ path: warning.path, message: warning.message })) }
  })
  const repair = await caller.withClient((db) => db.repairOrder.findUnique({ where: { id: result.repairId }, select: { id: true, number: true, stage: true } }))
  return { result: await viewOf(caller, context, row.id), repair: { id: repair!.id, number: repair!.number, stage: repair!.stage as string }, promise, warnings: result.warnings }
}

// ---- the new revision -----------------------------------------------------------------------------------------------------------

/** POST /sales/fittings/results/:id/revision */
export async function nameRevision(caller: CommandCaller, id: string, body: RevisionBody, idempotencyKey?: string) {
  const { context, row, profile } = await writableResult(caller, id)
  if (row.verdict === 'OK') throw new ConflictError('It fits: no new revision follows from this fitting.')
  if (row.newProfileId) throw new ConflictError('This fitting names its new revision already.')
  const newer = await caller.withClient((db) => profileOf(db, body.profileId))
  if (!newer || newer.partyId !== row.partyId || newer.riderName !== profile.riderName || newer.garmentType !== profile.garmentType || newer.revision <= profile.revision) {
    throw invalid([{ path: 'body/profileId', message: `A later revision of ${profile.riderName}'s ${profile.garmentType} measures than the one fitted (${profile.revision}): record it first (POST /sales/mtm/profiles/${profile.id}/revisions).` }])
  }
  await command(caller, { name: 'fittings.nameRevision', idempotencyKey, input: { id, ...body }, record: { type: 'FittingResult', id: row.id, expectedVersion: body.version } }, async (tools) => {
    await tools.tx.fittingResult.update({ where: { id: row.id }, data: { newProfileId: newer.id, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ recordType: RESULT_RECORD, recordId: row.id, companyId: row.companyId, before: { newProfileId: null }, after: { newProfileId: newer.id, revision: newer.revision } })
    tools.emit({ type: 'fitting_result.linked', subject: row.id, companyId: row.companyId, payload: { resultId: row.id, partyId: row.partyId, alterationRepairId: null, newProfileId: newer.id } })
    return null
  })
  return { result: await viewOf(caller, context, row.id) }
}

// ---- the rider profile's Fittings tab -------------------------------------------------------------------------------------------

/** GET /sales/mtm/profiles/:profileId/fittings */
export async function profileFittings(caller: CommandCaller, profileId: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const now = serverClock.now()
  const row = await caller.withClient((db) => profileOf(db, profileId))
  if (!row) throw profileNotFound()
  assertMayProfile(context, row.partyId)
  return caller.withClient(async (db) => {
    const chain = await chainOf(db, row)
    const ids = chain.map((revision) => revision.id)
    // The chain's appointments, and the rider's not yet tied to a revision (by its contact or its name) booked for this garment type.
    const contactIds = [...new Set(chain.flatMap((revision) => (revision.contactId ? [revision.contactId] : [])))]
    const appointments = await db.appointment.findMany({
      where: { partyId: row.partyId, OR: [{ measurementProfileId: { in: ids } }, { measurementProfileId: null, riderName: row.riderName }, ...(contactIds.length > 0 ? [{ measurementProfileId: null, contactId: { in: contactIds } }] : [])] },
      select: APPOINTMENT_SELECT,
      orderBy: [{ startsAt: 'desc' }, { id: 'asc' }],
    })
    const booked = await bookedGarmentsOf(db, appointments.filter((appointment) => appointment.measurementProfileId === null).map((appointment) => appointment.id))
    const seen = appointments.filter((appointment) => sees(context, appointment) && (appointment.measurementProfileId !== null || booked.get(appointment.id) === row.garmentType))
    const results = (await db.fittingResult.findMany({ where: { measurementProfileId: { in: ids } }, select: RESULT_SELECT, orderBy: [{ fittedAt: 'desc' }, { id: 'asc' }] })).filter((result) => sees(context, result))
    const next = await nextFittingOf(db, ids, now)
    const started = (await garmentRefusal(db, row.garmentType)) === null
    const manage = can(actor, SALES_FITTINGS_MANAGE, { partyId: row.partyId })
    return {
      profileId: row.id,
      riderName: row.riderName,
      garmentType: row.garmentType,
      appointments: await appointmentRows(db, seen),
      results: await resultViews(db, context, results),
      nextFittingAt: next ? toUtcIso(next) : null,
      started,
      may: { book: manage && started, record: manage && started },
    }
  })
}
