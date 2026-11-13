import type { Prisma } from '@nexus/factory-db'
import type { FastifyRequest } from 'fastify'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayStart, toUtcIso } from '@nexus/factory-domain/core/time'
import { SALES_MEASUREMENTS_VIEW } from '@nexus/factory-domain/sales/measure-link/permissions'
import type { AppointmentsQuery, BookBody, CancelBody, CloseBody, InviteBody, LedToBody, MoveBody } from '@nexus/factory-domain/sales/fittings/contracts'
import { SALES_FITTINGS_MANAGE } from '@nexus/factory-domain/sales/fittings/permissions'
import { appointmentProblems, bookedRefusal, closeRefusal, FITTING_LIMITS, overlaps, type AppointmentKind, type AppointmentMail, type AppointmentStatus, type MailLanguage } from '@nexus/factory-domain/sales/fittings/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { processEmail } from '../../../platform/email-out/service'
import { systemCallerOf } from '../../../platform/files/files'
import { chainOf, officeOf, profileOf } from '../mtm/store'
import { deliverAppointmentMail, queueAppointmentMail, riderTargetOf, type MailTarget, type QueuedMail } from './mail'
import { APPOINTMENT_RECORD, appointmentNotFound, appointmentOf, appointmentRecord, appointmentRows, APPOINTMENT_SELECT, garmentOfAppointment, garmentRefusal, mayOn, sees, type AppointmentRow, type Reader } from './store'

/**
 * Fitting and showroom appointments (B-W2b-360; SAL-054 "Fitting and showroom appointments"; design sales.mtm › Fittings "Book a
 * fitting" — date and time, place (showroom, track, dealer), fitter, invite (.ics) to the rider — and the "Fittings this week"
 * tile, B-W2b-358's list):
 *
 *   GET   /sales/fittings/appointments              the appointments the caller reads, from today (or `from`) on, by kind, state,
 *                                                   customer or a rider profile's revisions; pages
 *   POST  /sales/fittings/appointments              book one (a FITTING of a profile revision; a showroom visit or a measuring
 *                                                   session of a garment type), the invite mailed to the rider (FAKE locally)
 *   GET   /sales/fittings/appointments/:id          its record (its mails to the rider, its fitting results, what the caller may do)
 *   PATCH /sales/fittings/appointments/:id          move a booked one (time, place, who, rider, revision; the update mailed when an
 *                                                   invite went before and the time, place or who changed; the reminder asked
 *                                                   again for a new time), or only its notes once closed
 *   POST  …/close                                   DONE (who was there) or MISSED, once it has started
 *   POST  …/cancel                                  CANCELLED with why (the office's words); the rider told when invited
 *   POST  …/invite                                  the invite mailed again
 *   POST  …/led-to                                  a done showroom visit or measuring session names the revision it led to, once
 *
 * Each write is ONE command on the appointment (its version checked, record Appointment): the row, its audit row, the mail's
 * EmailOutbound row and its time on the appointment, the events; the mail goes after the commit. Every database rule
 * (…_mtm_office_w2b_guards Appointment_guard) is said in words first. Made-to-measure switched off for the appointment's garment
 * type (GATE-MTM): nothing is booked, moved, closed or mailed (a booked one may still be cancelled). An office person of ours
 * already booked at the same time is a warning, never a refusal (the database has no overlap rule).
 */

const invalid = (issues: Issue[]): ValidationError => new ValidationError(issues.length === 1 ? issues[0]!.message : 'The appointment cannot be written like this.', issues)
const blank = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

interface Sender {
  readonly userId: string
  readonly name: string
  readonly email: string | null
}

async function senderOf(db: Reader, context: OfficeContext): Promise<Sender | null> {
  const user = await db.user.findUnique({ where: { id: context.actorId }, select: { id: true, displayName: true, email: true } })
  return user ? { userId: user.id, name: user.displayName, email: user.email } : null
}

/** An active office person of ours (the fitter), or the problem at its field. */
async function fitterProblem(db: Reader, userId: string | null | undefined): Promise<Issue | null> {
  if (!userId) return null
  const user = isUuid(userId) ? await db.user.findUnique({ where: { id: userId }, select: { audience: true, status: true } }) : null
  return !user || user.audience !== 'OFFICE' || user.status !== 'ACTIVE' ? { path: 'body/withUserId', message: 'An active office person of ours (someone outside is named by withName).' } : null
}

/** The office people of ours already booked at that time (a warning). */
async function overlapWarnings(db: Reader, row: { readonly id?: string; readonly withUserId: string | null; readonly startsAt: Date; readonly endsAt: Date }): Promise<Issue[]> {
  if (!row.withUserId) return []
  const others = await db.appointment.findMany({
    where: { withUserId: row.withUserId, status: 'BOOKED', startsAt: { lt: row.endsAt }, endsAt: { gt: row.startsAt }, ...(row.id ? { id: { not: row.id } } : {}) },
    select: { startsAt: true, endsAt: true, place: true },
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    take: 5,
  })
  return others.filter((other) => overlaps(other, row)).map((other) => ({ path: 'body/withUserId', message: `The fitter has another appointment then (${toUtcIso(other.startsAt)}, ${other.place}).` }))
}

/** The rider's profile revision named for an appointment of this customer (and contact), or the problem. */
async function profileProblem(db: Reader, partyId: string, profileId: string, contactId: string | null): Promise<{ profile: Awaited<ReturnType<typeof profileOf>>; issue: Issue | null }> {
  const profile = await profileOf(db, profileId)
  if (!profile || profile.partyId !== partyId) return { profile: null, issue: { path: 'body/measurementProfileId', message: "A measurement profile revision of this customer's rider." } }
  if (contactId && profile.contactId && profile.contactId !== contactId) return { profile, issue: { path: 'body/contactId', message: 'The rider is the contact the measurement profile names.' } }
  return { profile, issue: null }
}

async function contactProblem(db: Reader, partyId: string, contactId: string): Promise<{ name: string | null; issue: Issue | null }> {
  const contact = isUuid(contactId) ? await db.partyContact.findFirst({ where: { id: contactId, partyId, status: 'ACTIVE' }, select: { name: true } }) : null
  return contact ? { name: contact.name, issue: null } : { name: null, issue: { path: 'body/contactId', message: 'An active contact of this customer.' } }
}

/** After the commit: the queued mail sent at once ('SENT' | 'FAILED' | 'QUEUED'), or null when none was queued or the answer is a repeat. */
async function deliver(caller: FastifyRequest, context: OfficeContext, queued: QueuedMail | null, replayed: boolean): Promise<string | null> {
  if (!queued || replayed) return null
  return deliverAppointmentMail(processEmail(), systemCallerOf(caller)(context.tenantId), queued, serverClock)
}

async function recordOf(caller: CommandCaller, context: OfficeContext, id: string) {
  return caller.withClient(async (db) => {
    const row = (await appointmentOf(db, id))!
    return appointmentRecord(db, context, row, { mailTo: (await riderTargetOf(db, row)) !== null, now: serverClock.now() })
  })
}

function emitMailed(tools: Pick<CommandTools, 'emit'>, row: { readonly id: string; readonly companyId: string; readonly partyId: string }, queued: QueuedMail | null): void {
  if (queued) tools.emit({ type: 'appointment.mailed', subject: row.id, companyId: row.companyId, payload: { appointmentId: row.id, partyId: row.partyId, mail: queued.mail, outboundId: queued.outboundId } })
}

/** The record the caller reads and may write (else not found / forbidden), with its garment's made-to-measure state. */
async function writable(caller: CommandCaller, id: string): Promise<{ context: OfficeContext; row: AppointmentRow; garmentType: string | null }> {
  const context = officeOf(caller)
  const found = await caller.withClient(async (db) => {
    const row = await appointmentOf(db, id)
    return row ? { row, garmentType: await garmentOfAppointment(db, row) } : null
  })
  if (!found || !sees(context, found.row)) throw appointmentNotFound()
  if (!mayOn(context, SALES_FITTINGS_MANAGE, found.row)) throw new ForbiddenError('Your roles do not book or record fittings (sales.fittings.manage).')
  return { context, ...found }
}

async function assertStarted(db: Reader, garmentType: string | null): Promise<void> {
  const refusal = garmentType ? await garmentRefusal(db, garmentType) : 'No garment type is known for this appointment.'
  if (refusal) throw new ConflictError(refusal)
}

// ---- the list and the record -------------------------------------------------------------------------------------------------

/** GET /sales/fittings/appointments */
export async function listAppointments(caller: CommandCaller, query: AppointmentsQuery) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const now = serverClock.now()
  if (query.partyId !== undefined && !can(actor, SALES_MEASUREMENTS_VIEW, { partyId: query.partyId })) throw new NotFoundError('Customer not found.')
  return caller.withClient(async (db) => {
    let profileIds: string[] | null = null
    if (query.profileId) {
      const profile = await profileOf(db, query.profileId)
      if (!profile || !can(actor, SALES_MEASUREMENTS_VIEW, { partyId: profile.partyId })) throw new NotFoundError('Measurement profile not found.')
      profileIds = (await chainOf(db, profile)).map((revision) => revision.id)
    }
    const from = query.from ? new Date(query.from) : businessDayStart(businessDate(now))
    const where: Prisma.AppointmentWhereInput = {
      AND: [
        scopeWhere(actor, SALES_MEASUREMENTS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.AppointmentWhereInput,
        { startsAt: { gte: from, ...(query.to ? { lt: new Date(query.to) } : {}) } },
        query.kind ? { kind: query.kind } : {},
        query.status ? { status: query.status } : {},
        query.partyId ? { partyId: query.partyId } : {},
        profileIds ? { measurementProfileId: { in: profileIds } } : {},
      ],
    }
    const matching = await db.appointment.count({ where })
    const rows = await db.appointment.findMany({ where, select: APPOINTMENT_SELECT, orderBy: [{ startsAt: 'asc' }, { id: 'asc' }], skip: query.offset, take: Math.min(query.limit, FITTING_LIMITS.list) })
    return { rows: await appointmentRows(db, rows), matching, asOf: toUtcIso(now) }
  })
}

/** GET /sales/fittings/appointments/:id */
export async function getAppointment(caller: CommandCaller, id: string) {
  const context = officeOf(caller)
  const row = await caller.withClient((db) => appointmentOf(db, id))
  if (!row || !sees(context, row)) throw appointmentNotFound()
  return { appointment: await recordOf(caller, context, row.id) }
}

// ---- book -------------------------------------------------------------------------------------------------------------------

/** POST /sales/fittings/appointments */
export async function bookAppointment(caller: FastifyRequest, body: BookBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const scope = { companyId: body.companyId, partyId: body.partyId }
  if (!can(actor, SALES_MEASUREMENTS_VIEW, scope)) throw new NotFoundError('Customer not found.')
  if (!can(actor, SALES_FITTINGS_MANAGE, scope)) throw new ForbiddenError('Your roles do not book or record fittings (sales.fittings.manage).')
  const now = serverClock.now()
  const plan = await caller.withClient(async (db) => {
    const company = isUuid(body.companyId) ? await db.company.findUnique({ where: { id: body.companyId }, select: { id: true } }) : null
    if (!company) throw new NotFoundError('Company not found.')
    const party = await db.party.findUnique({ where: { id: body.partyId }, select: { id: true, companyId: true, status: true, legalName: true } })
    if (!party || (party.companyId !== null && party.companyId !== company.id)) throw new NotFoundError('Customer not found.')
    const issues: Issue[] = []
    if (party.status === 'ARCHIVED' || party.status === 'BLOCKED') issues.push({ path: 'body/partyId', message: `${party.legalName} is ${party.status.toLowerCase()}.` })
    const contactId = body.contactId ?? null
    const contact = contactId ? await contactProblem(db, party.id, contactId) : null
    if (contact?.issue) issues.push(contact.issue)
    const named = body.measurementProfileId ? await profileProblem(db, party.id, body.measurementProfileId, contactId) : null
    if (named?.issue) issues.push(named.issue)
    const profile = named?.profile ?? null
    const garmentType = profile?.garmentType ?? blank(body.garmentType)
    if (profile && body.garmentType && body.garmentType !== profile.garmentType) issues.push({ path: 'body/garmentType', message: `The revision named is of ${profile.garmentType}.` })
    if (!body.measurementProfileId && !garmentType && body.kind !== 'FITTING') issues.push({ path: 'body/garmentType', message: 'Name the garment type it is for (a measurement template), or the rider profile revision.' })
    const fitter = await fitterProblem(db, body.withUserId)
    if (fitter) issues.push(fitter)
    const draft = { kind: body.kind as AppointmentKind, startsAt: new Date(body.startsAt), endsAt: new Date(body.endsAt), place: body.place, riderName: blank(body.riderName) ?? profile?.riderName ?? contact?.name ?? null, withName: blank(body.withName), notes: blank(body.notes), hasProfile: body.measurementProfileId != null }
    issues.push(...appointmentProblems(draft, now))
    if (issues.length > 0) throw invalid(issues)
    const refusal = await garmentRefusal(db, garmentType!)
    if (refusal) throw new ConflictError(refusal)
    const row = { partyId: party.id, contactId: contactId ?? profile?.contactId ?? null, measurementProfileId: profile?.id ?? null }
    const target = body.invite ? await riderTargetOf(db, row) : null
    return { ...draft, ...row, garmentType: garmentType!, target, sender: await senderOf(db, context), warnings: await overlapWarnings(db, { withUserId: body.withUserId ?? null, startsAt: draft.startsAt, endsAt: draft.endsAt }) }
  })
  const language: MailLanguage = body.language ?? plan.target?.language ?? 'it'
  const warnings = [...plan.warnings]
  if (body.invite && !plan.target) warnings.push({ path: 'body/invite', message: 'The rider has no address to mail the invite to: add one to the contact, then send it.' })
  const { result, replayed } = await command(caller, { name: 'fittings.book', idempotencyKey, input: body }, async (tools) => {
    const id = newId()
    const appointment = { id, kind: plan.kind, riderName: plan.riderName, startsAt: plan.startsAt, endsAt: plan.endsAt, place: plan.place, withUserId: body.withUserId ?? null, withName: plan.withName }
    const queued = body.invite && plan.target && plan.startsAt.getTime() > tools.now.getTime() ? await queueAppointmentMail(tools, { mail: 'INVITE', companyId: body.companyId, appointment, sequence: 1, garmentType: plan.garmentType, to: plan.target, language, sender: plan.sender }) : null
    await tools.tx.appointment.create({
      data: {
        ...appointment,
        companyId: body.companyId,
        partyId: plan.partyId,
        contactId: plan.contactId,
        measurementProfileId: plan.measurementProfileId,
        notes: plan.notes,
        inviteSentAt: queued ? tools.now : null,
        createdAt: tools.now,
        updatedAt: tools.now,
        createdById: context.actorId,
        updatedById: context.actorId,
      },
      select: { id: true },
    })
    tools.audit({
      recordType: APPOINTMENT_RECORD,
      recordId: id,
      companyId: body.companyId,
      after: { kind: plan.kind, garmentType: plan.garmentType, profileId: plan.measurementProfileId, contactId: plan.contactId, startsAt: toUtcIso(plan.startsAt), endsAt: toUtcIso(plan.endsAt), place: plan.place, withUserId: body.withUserId ?? null, withName: plan.withName, invited: queued !== null },
    })
    tools.emit({ type: 'appointment.booked', subject: id, companyId: body.companyId, payload: { appointmentId: id, partyId: plan.partyId, kind: plan.kind, profileId: plan.measurementProfileId, startsAt: toUtcIso(plan.startsAt) } })
    emitMailed(tools, { id, companyId: body.companyId, partyId: plan.partyId }, queued)
    return { id, queued }
  })
  const delivery = await deliver(caller, context, result.queued, replayed)
  return { appointment: await recordOf(caller, context, result.id), mailed: result.queued !== null, delivery, warnings }
}

// ---- move, or the notes of a closed one ------------------------------------------------------------------------------------------

const MOVES = ['startsAt', 'endsAt', 'place', 'measurementProfileId', 'contactId', 'riderName', 'withUserId', 'withName'] as const

/** PATCH /sales/fittings/appointments/:id */
export async function moveAppointment(caller: FastifyRequest, id: string, body: MoveBody, idempotencyKey?: string) {
  const { context, row, garmentType } = await writable(caller, id)
  const now = serverClock.now()
  const asked = MOVES.filter((field) => body[field] !== undefined)
  if (row.status !== 'BOOKED' && asked.length > 0) throw new ConflictError(bookedRefusal(row.status as AppointmentStatus, 'moved')!)
  const plan = await caller.withClient(async (db) => {
    const issues: Issue[] = []
    const next = {
      startsAt: body.startsAt ? new Date(body.startsAt) : row.startsAt,
      endsAt: body.endsAt ? new Date(body.endsAt) : row.endsAt,
      place: body.place ?? row.place,
      measurementProfileId: body.measurementProfileId === undefined ? row.measurementProfileId : body.measurementProfileId,
      contactId: body.contactId === undefined ? row.contactId : body.contactId,
      riderName: body.riderName === undefined ? row.riderName : blank(body.riderName),
      withUserId: body.withUserId === undefined ? row.withUserId : body.withUserId,
      withName: body.withName === undefined ? row.withName : blank(body.withName),
      notes: body.notes === undefined ? row.notes : blank(body.notes),
    }
    let garment = garmentType
    if (body.contactId) {
      const contact = await contactProblem(db, row.partyId, body.contactId)
      if (contact.issue) issues.push(contact.issue)
    }
    if (next.measurementProfileId && (body.measurementProfileId !== undefined || body.contactId !== undefined)) {
      const named = await profileProblem(db, row.partyId, next.measurementProfileId, next.contactId)
      if (named.issue) issues.push(named.issue)
      if (named.profile) garment = named.profile.garmentType
    }
    if (body.withUserId) {
      const fitter = await fitterProblem(db, body.withUserId)
      if (fitter) issues.push(fitter)
    }
    const timesChanged = next.startsAt.getTime() !== row.startsAt.getTime() || next.endsAt.getTime() !== row.endsAt.getTime()
    if (row.status === 'BOOKED') issues.push(...appointmentProblems({ kind: row.kind as AppointmentKind, startsAt: next.startsAt, endsAt: next.endsAt, place: next.place, riderName: next.riderName, withName: next.withName, notes: next.notes, hasProfile: next.measurementProfileId !== null }, now, timesChanged))
    else if (next.notes !== null && next.notes.length > FITTING_LIMITS.notes) issues.push({ path: 'body/notes', message: `Notes: 1 to ${FITTING_LIMITS.notes} characters.` })
    if (issues.length > 0) throw invalid(issues)
    await assertStarted(db, garment)
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((field) => {
      const before = row[field]
      const after = next[field]
      return before instanceof Date && after instanceof Date ? before.getTime() !== after.getTime() : before !== after
    })
    const told = changed.some((field) => ['startsAt', 'endsAt', 'place', 'withUserId', 'withName'].includes(field))
    const target = told && body.invite && row.inviteSentAt !== null && next.startsAt.getTime() > now.getTime() ? await riderTargetOf(db, { partyId: row.partyId, contactId: next.contactId, measurementProfileId: next.measurementProfileId }) : null
    const warnings = changed.some((field) => ['startsAt', 'endsAt', 'withUserId'].includes(field)) ? await overlapWarnings(db, { id: row.id, withUserId: next.withUserId, startsAt: next.startsAt, endsAt: next.endsAt }) : []
    return { next, changed, timesChanged, garment, target, sender: await senderOf(db, context), warnings }
  })
  if (plan.changed.length === 0) return { appointment: await recordOf(caller, context, row.id), mailed: false, delivery: null, warnings: [] }
  const language: MailLanguage = body.language ?? plan.target?.language ?? 'it'
  const { result, replayed } = await command(caller, { name: 'fittings.move', idempotencyKey, input: { id, ...body }, record: { type: 'Appointment', id: row.id, expectedVersion: body.version } }, async (tools) => {
    const sequence = tools.record!.version
    const appointment = { id: row.id, kind: row.kind, riderName: plan.next.riderName, startsAt: plan.next.startsAt, endsAt: plan.next.endsAt, place: plan.next.place, withUserId: plan.next.withUserId, withName: plan.next.withName }
    const queued = plan.target ? await queueAppointmentMail(tools, { mail: 'UPDATE', companyId: row.companyId, appointment, sequence, garmentType: plan.garment, to: plan.target, language, sender: plan.sender }) : null
    await tools.tx.appointment.update({
      where: { id: row.id },
      data: {
        ...Object.fromEntries(plan.changed.map((field) => [field, plan.next[field]])),
        // A new time asks the reminder again.
        ...(plan.timesChanged ? { reminderSentAt: null } : {}),
        ...(queued ? { inviteSentAt: tools.now } : {}),
        updatedAt: tools.now,
        updatedById: context.actorId,
      },
      select: { id: true },
    })
    const view = (value: unknown) => (value instanceof Date ? toUtcIso(value) : value)
    tools.audit({
      recordType: APPOINTMENT_RECORD,
      recordId: row.id,
      companyId: row.companyId,
      before: Object.fromEntries(plan.changed.map((field) => [field, view(row[field])])),
      after: { ...Object.fromEntries(plan.changed.map((field) => [field, view(plan.next[field])])), mailed: queued !== null },
    })
    tools.emit({ type: 'appointment.changed', subject: row.id, companyId: row.companyId, payload: { appointmentId: row.id, partyId: row.partyId, fields: plan.changed } })
    emitMailed(tools, row, queued)
    return { queued }
  })
  const delivery = await deliver(caller, context, result.queued, replayed)
  return { appointment: await recordOf(caller, context, row.id), mailed: result.queued !== null, delivery, warnings: plan.warnings }
}

// ---- close, cancel, invite, led to ------------------------------------------------------------------------------------------------

/** POST /sales/fittings/appointments/:id/close */
export async function closeAppointment(caller: CommandCaller, id: string, body: CloseBody, idempotencyKey?: string) {
  const { context, row, garmentType } = await writable(caller, id)
  const now = serverClock.now()
  const closedAt = body.closedAt ? new Date(body.closedAt) : now
  const who = { withUserId: body.withUserId === undefined ? row.withUserId : body.withUserId, withName: body.withName === undefined ? row.withName : blank(body.withName) }
  const refusal = closeRefusal({ status: row.status as AppointmentStatus, kind: row.kind as AppointmentKind, startsAt: row.startsAt }, body.status, closedAt, now, who)
  if (refusal) throw new ConflictError(refusal)
  await caller.withClient(async (db) => {
    const fitter = await fitterProblem(db, body.withUserId)
    if (fitter) throw invalid([fitter])
    await assertStarted(db, garmentType)
  })
  await command(caller, { name: 'fittings.close', idempotencyKey, input: { id, ...body }, record: { type: 'Appointment', id: row.id, expectedVersion: body.version } }, async (tools) => {
    await tools.tx.appointment.update({
      where: { id: row.id },
      data: { status: body.status, closedAt, closedById: context.actorId, withUserId: who.withUserId, withName: who.withName, ...(body.notes !== undefined ? { notes: blank(body.notes) } : {}), updatedAt: tools.now, updatedById: context.actorId },
      select: { id: true },
    })
    tools.audit({ recordType: APPOINTMENT_RECORD, recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status: body.status, closedAt: toUtcIso(closedAt), withUserId: who.withUserId, withName: who.withName } })
    tools.emit({ type: 'appointment.closed', subject: row.id, companyId: row.companyId, payload: { appointmentId: row.id, partyId: row.partyId, kind: row.kind as AppointmentKind, status: body.status } })
    return null
  })
  return { appointment: await recordOf(caller, context, row.id) }
}

/** POST /sales/fittings/appointments/:id/cancel (allowed while made-to-measure is off: a way out of what was booked). */
export async function cancelAppointment(caller: FastifyRequest, id: string, body: CancelBody, idempotencyKey?: string) {
  const { context, row, garmentType } = await writable(caller, id)
  const refusal = bookedRefusal(row.status as AppointmentStatus, 'cancelled')
  if (refusal) throw new ConflictError(refusal)
  const facts = await caller.withClient(async (db) => ({ target: body.notify && row.inviteSentAt !== null ? await riderTargetOf(db, row) : null, sender: await senderOf(db, context) }))
  const language: MailLanguage = body.language ?? facts.target?.language ?? 'it'
  const { result, replayed } = await command(caller, { name: 'fittings.cancel', idempotencyKey, input: { id, ...body }, record: { type: 'Appointment', id: row.id, expectedVersion: body.version } }, async (tools) => {
    const queued = facts.target ? await queueAppointmentMail(tools, { mail: 'CANCEL', companyId: row.companyId, appointment: row, sequence: tools.record!.version, garmentType, to: facts.target, language, sender: facts.sender }) : null
    await tools.tx.appointment.update({ where: { id: row.id }, data: { status: 'CANCELLED', closedAt: tools.now, closedById: context.actorId, cancelReason: body.reason.trim(), updatedAt: tools.now, updatedById: context.actorId }, select: { id: true } })
    tools.audit({ recordType: APPOINTMENT_RECORD, recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status: 'CANCELLED', mailed: queued !== null }, reason: body.reason.trim() })
    tools.emit({ type: 'appointment.closed', subject: row.id, companyId: row.companyId, payload: { appointmentId: row.id, partyId: row.partyId, kind: row.kind as AppointmentKind, status: 'CANCELLED' } })
    emitMailed(tools, row, queued)
    return { queued }
  })
  const delivery = await deliver(caller, context, result.queued, replayed)
  return { appointment: await recordOf(caller, context, row.id), mailed: result.queued !== null, delivery, warnings: [] }
}

/** POST /sales/fittings/appointments/:id/invite */
export async function inviteAgain(caller: FastifyRequest, id: string, body: InviteBody, idempotencyKey?: string) {
  const { context, row, garmentType } = await writable(caller, id)
  const refusal = bookedRefusal(row.status as AppointmentStatus, 'invited')
  if (refusal) throw new ConflictError(refusal)
  if (row.startsAt.getTime() <= serverClock.now().getTime()) throw new ConflictError('It has started: no invite is sent for it any more.')
  const facts = await caller.withClient(async (db) => {
    await assertStarted(db, garmentType)
    return { target: await riderTargetOf(db, row), sender: await senderOf(db, context) }
  })
  if (!facts.target) throw new ConflictError('The rider has no address to mail the invite to: add one to the contact first.')
  const target: MailTarget = facts.target
  const language: MailLanguage = body.language ?? target.language
  const mail: AppointmentMail = 'INVITE'
  const { result, replayed } = await command(caller, { name: 'fittings.invite', idempotencyKey, input: { id, ...body }, record: { type: 'Appointment', id: row.id, expectedVersion: body.version } }, async (tools) => {
    const queued = await queueAppointmentMail(tools, { mail, companyId: row.companyId, appointment: row, sequence: tools.record!.version, garmentType, to: target, language, sender: facts.sender })
    if (!queued) throw new ConflictError('The company has no mail identity to send from: an administrator sets one up under Mail.')
    await tools.tx.appointment.update({ where: { id: row.id }, data: { inviteSentAt: tools.now, updatedAt: tools.now, updatedById: context.actorId }, select: { id: true } })
    tools.audit({ recordType: APPOINTMENT_RECORD, recordId: row.id, companyId: row.companyId, before: { inviteSentAt: row.inviteSentAt ? toUtcIso(row.inviteSentAt) : null }, after: { inviteSentAt: toUtcIso(tools.now), outboundId: queued.outboundId } })
    emitMailed(tools, row, queued)
    return { queued }
  })
  const delivery = await deliver(caller, context, result.queued, replayed)
  return { appointment: await recordOf(caller, context, row.id), mailed: true, delivery, warnings: [] }
}

/** POST /sales/fittings/appointments/:id/led-to */
export async function ledTo(caller: CommandCaller, id: string, body: LedToBody, idempotencyKey?: string) {
  const { context, row } = await writable(caller, id)
  if (row.status !== 'DONE' || row.measurementProfileId !== null) throw new ConflictError(row.status !== 'DONE' ? 'Only an appointment that took place names the revision it led to.' : 'It names its revision already.')
  await caller.withClient(async (db) => {
    const named = await profileProblem(db, row.partyId, body.profileId, row.contactId)
    if (named.issue) throw invalid([{ ...named.issue, path: 'body/profileId' }])
    await assertStarted(db, named.profile!.garmentType)
  })
  await command(caller, { name: 'fittings.ledTo', idempotencyKey, input: { id, ...body }, record: { type: 'Appointment', id: row.id, expectedVersion: body.version } }, async (tools) => {
    await tools.tx.appointment.update({ where: { id: row.id }, data: { measurementProfileId: body.profileId, updatedAt: tools.now, updatedById: context.actorId }, select: { id: true } })
    tools.audit({ recordType: APPOINTMENT_RECORD, recordId: row.id, companyId: row.companyId, before: { measurementProfileId: null }, after: { measurementProfileId: body.profileId } })
    tools.emit({ type: 'appointment.changed', subject: row.id, companyId: row.companyId, payload: { appointmentId: row.id, partyId: row.partyId, fields: ['measurementProfileId'] } })
    return null
  })
  return { appointment: await recordOf(caller, context, row.id) }
}
