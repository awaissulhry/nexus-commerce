import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { SAFETY_ORGANISATION_MANAGE, SAFETY_VIEW } from '@nexus/factory-domain/safety/organisation/permissions'
import { appointeeRefusal, endRefusal, filingRefusal, normalName, RLS_ROLES, signRefusal, type AppointmentSignMethod, type OrganisationRefusal, type SafetyRole } from '@nexus/factory-domain/safety/organisation/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { actorIdOf, assertMayAt, assertMayWriteAt, assertVersion, bodyIssue, dateOf, dayOf, dayOrNull, officeOf, refuse, todayOf } from './access'
import { APPOINTMENT_SELECT, appointeeName, appointmentViews, NOTICE_SELECT, noticeViews, type AppointmentRow } from './store'

/**
 * The safety organisation's writes (B-W2b-120; QHS-224, QHS-226; design plant.calendar pop-up Appointment), office only,
 * safety.organisation.manage over the appointment's company (and site), each one command with an Idempotency-Key:
 *
 *   POST  /safety/appointments              appoint a person of the company or an outside contact to a role; an RLS or an
 *                                           RLST opens its notice to INAIL in the same command (PENDING with its due day,
 *                                           or FILED when it was filed before it was recorded here)
 *   PATCH /safety/appointments/:id          its note
 *   POST  /safety/appointments/:id/sign     the appointee's signature: OFFICE (the appointee types their own name) or PAPER
 *                                           (the signed letter's scan is on file first), written once
 *   POST  /safety/appointments/:id/end      the last day and why (a new term is a new appointment)
 *
 * The letter is a file of the appointment (the generic files routes, record type SafetyAppointment). factory-db's guards
 * hold the same rules for every login (…_safety_w2b_guards); these answer first, in words.
 */

const MANAGE_WORDS = 'The safety organisation of this company is kept by a role that keeps it (safety.organisation.manage).'

const refuseWith = (refusal: OrganisationRefusal | null): void => {
  if (refusal) refuse(refusal.code, refusal.message, refusal.field)
}

async function viewOf(tx: CommandTx, context: OfficeContext, id: string, today: BusinessDate) {
  const row = (await tx.safetyAppointment.findUnique({ where: { id }, select: APPOINTMENT_SELECT })) as AppointmentRow
  return (await appointmentViews(tx, context, [row], today))[0]!
}

export interface AppointBody {
  readonly companyId: string
  readonly siteId?: string | null | undefined
  readonly role: SafetyRole
  readonly employeeId?: string | undefined
  readonly outsideName?: string | undefined
  readonly outsidePartyId?: string | undefined
  readonly outsideContactId?: string | undefined
  readonly shiftPatternId?: string | undefined
  readonly fromDate: BusinessDate
  readonly untilDate?: BusinessDate | undefined
  readonly note?: string | undefined
  readonly noticeDueOn?: BusinessDate | undefined
  readonly noticeFiled?: { readonly filedOn: BusinessDate; readonly reference: string } | undefined
}

/** POST /safety/appointments. */
export async function appoint(caller: CommandCaller, body: AppointBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const place = { companyId: body.companyId, siteId: body.siteId ?? null }
  assertMayWriteAt(context, SAFETY_ORGANISATION_MANAGE, place, MANAGE_WORDS)
  if ((body.employeeId === undefined) === (body.outsideName === undefined)) throw bodyIssue(body.employeeId === undefined ? 'employeeId' : 'outsideName', 'Name a person of the company or an outside contact, one of the two.')
  if (body.employeeId !== undefined && (body.outsidePartyId !== undefined || body.outsideContactId !== undefined)) throw bodyIssue('outsidePartyId', 'A person of the company has no outside party or contact.')
  if (body.outsideContactId !== undefined && body.outsidePartyId === undefined) throw bodyIssue('outsidePartyId', 'An outside contact is named with its party.')
  const isRls = RLS_ROLES.includes(body.role)
  if (!isRls && (body.noticeDueOn !== undefined || body.noticeFiled !== undefined)) throw bodyIssue('noticeDueOn', 'Only an RLS or a territorial RLS has a notice to INAIL.')
  if (body.noticeDueOn !== undefined && body.noticeFiled !== undefined) throw bodyIssue('noticeDueOn', 'A notice is due, or it was filed already: one of the two.')
  refuseWith(appointeeRefusal(body))

  const id = newId()
  const noticeId = isRls ? newId() : null
  const { result, replayed } = await command(caller, { name: 'safety.appoint', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const today = todayOf(now)
    const actorId = actorIdOf(tools.context)
    if (place.siteId) {
      const site = await tx.site.findUnique({ where: { id: place.siteId }, select: { companyId: true } })
      if (!site || site.companyId !== body.companyId) refuse('SITE_OTHER_COMPANY', 'The site is one of the company’s sites (or the whole company).', 'siteId')
    }
    if (body.employeeId) {
      const person = isUuid(body.employeeId) ? await tx.employee.findUnique({ where: { id: body.employeeId }, select: { companyId: true, status: true } }) : null
      if (!person || person.companyId !== body.companyId) refuse('PERSON_OTHER_COMPANY', 'The person works for another company: appoint a person of this company.', 'employeeId')
      if (person!.status !== 'ACTIVE') refuse('PERSON_NOT_ACTIVE', 'This person does not work for the company now.', 'employeeId')
    }
    if (body.outsidePartyId) {
      const party = await tx.party.findUnique({ where: { id: body.outsidePartyId }, select: { companyId: true, contacts: body.outsideContactId ? { where: { id: body.outsideContactId }, select: { id: true } } : false } })
      if (!party || (party.companyId !== null && party.companyId !== body.companyId)) refuse('CONTACT_OTHER_PARTY', 'The outside party is one of this company’s or the group’s.', 'outsidePartyId')
      if (body.outsideContactId && (party!.contacts as { id: string }[]).length === 0) refuse('CONTACT_OTHER_PARTY', 'The contact is one of that party’s contacts.', 'outsideContactId')
    }
    if (body.shiftPatternId) {
      const shift = await tx.shiftPattern.findUnique({ where: { id: body.shiftPatternId }, select: { companyId: true } })
      if (!shift || (shift.companyId !== null && shift.companyId !== body.companyId)) refuse('SHIFT_OTHER_COMPANY', 'The shift is one of this company’s or the group’s.', 'shiftPatternId')
    }
    // The same person (or contact) in the same role and place, for days that overlap a term already recorded.
    const overlapping = await tx.safetyAppointment.findMany({
      where: {
        companyId: body.companyId,
        siteId: place.siteId,
        role: body.role,
        ...(body.employeeId ? { employeeId: body.employeeId } : { outsideName: { not: null } }),
        OR: [{ untilDate: null }, { untilDate: { gte: dateOf(body.fromDate) } }],
        ...(body.untilDate ? { fromDate: { lte: dateOf(body.untilDate) } } : {}),
      },
      select: { outsideName: true, shiftPatternId: true },
    })
    if (overlapping.some((other) => (body.employeeId || normalName(other.outsideName ?? '') === normalName(body.outsideName ?? '')) && other.shiftPatternId === (body.shiftPatternId ?? null))) {
      refuse('ALREADY_APPOINTED', 'This person holds this role here already for those days: end that term first, or change its days.', body.employeeId ? 'employeeId' : 'outsideName')
    }
    await tx.safetyAppointment.create({
      data: {
        id,
        companyId: body.companyId,
        siteId: place.siteId,
        role: body.role,
        employeeId: body.employeeId ?? null,
        outsideName: body.outsideName?.trim() ?? null,
        outsidePartyId: body.outsidePartyId ?? null,
        outsideContactId: body.outsideContactId ?? null,
        shiftPatternId: body.shiftPatternId ?? null,
        fromDate: dateOf(body.fromDate),
        untilDate: body.untilDate ? dateOf(body.untilDate) : null,
        note: body.note?.trim() || null,
        createdAt: now,
        updatedAt: now,
        createdById: actorId,
      },
      select: { id: true },
    })
    tools.audit({ action: 'safety.appoint', recordType: 'SafetyAppointment', recordId: id, companyId: body.companyId, siteId: place.siteId, after: { role: body.role, employeeId: body.employeeId ?? null, outside: body.outsideName !== undefined, shiftPatternId: body.shiftPatternId ?? null, fromDate: body.fromDate, untilDate: body.untilDate ?? null } })
    let notice = null
    if (noticeId) {
      if (body.noticeFiled) refuseWith(filingRefusal({ status: 'PENDING', filedOn: body.noticeFiled.filedOn, appointedFrom: body.fromDate, today }))
      await tx.rlsNotice.create({
        data: {
          id: noticeId,
          companyId: body.companyId,
          appointmentId: id,
          // The plan gives no number of days for the notice: due from the first day unless the person set the day they confirmed.
          dueOn: dateOf(body.noticeDueOn ?? body.fromDate),
          ...(body.noticeFiled ? { status: 'FILED' as const, filedOn: dateOf(body.noticeFiled.filedOn), reference: body.noticeFiled.reference.trim(), filedById: actorId } : {}),
          createdAt: now,
          updatedAt: now,
          createdById: actorId,
        },
        select: { id: true },
      })
      tools.audit({ action: 'safety.rlsNoticeOpened', recordType: 'RlsNotice', recordId: noticeId, companyId: body.companyId, siteId: place.siteId, after: { appointmentId: id, dueOn: body.noticeDueOn ?? body.fromDate, status: body.noticeFiled ? 'FILED' : 'PENDING', reference: body.noticeFiled?.reference ?? null } })
      tools.emit({ type: 'rls_notice.changed', subject: noticeId, companyId: body.companyId, siteId: place.siteId, payload: { noticeId, appointmentId: id, change: body.noticeFiled ? 'FILED' : 'CREATED' } })
      const row = await tx.rlsNotice.findUnique({ where: { id: noticeId }, select: NOTICE_SELECT })
      notice = (await noticeViews(tx, tools.context as OfficeContext, [row!]))[0]!
    }
    tools.emit({ type: 'safety_appointment.changed', subject: id, companyId: body.companyId, siteId: place.siteId, payload: { appointmentId: id, role: body.role, change: 'MADE', noticeId } })
    return { appointment: await viewOf(tx, tools.context as OfficeContext, id, today), notice }
  })
  return { ...result, replayed }
}

/** The appointment the caller may change (404 when it may not read it, 403 when it may not change it). */
async function writable(caller: CommandCaller, appointmentId: string): Promise<AppointmentRow> {
  const context = officeOf(caller)
  const row = isUuid(appointmentId) ? ((await caller.withClient((client) => client.safetyAppointment.findUnique({ where: { id: appointmentId }, select: APPOINTMENT_SELECT }))) as AppointmentRow | null) : null
  if (!row) throw new NotFoundError('Appointment not found.')
  assertMayAt(context, SAFETY_VIEW, row, 'Appointment')
  assertMayWriteAt(context, SAFETY_ORGANISATION_MANAGE, row, MANAGE_WORDS)
  return row
}

async function locked(tools: CommandTools, appointmentId: string, version: number): Promise<AppointmentRow> {
  await tools.tx.$queryRaw`SELECT "id" FROM "SafetyAppointment" WHERE "id" = ${appointmentId}::uuid FOR UPDATE`
  const row = (await tools.tx.safetyAppointment.findUnique({ where: { id: appointmentId }, select: APPOINTMENT_SELECT })) as AppointmentRow
  assertVersion('appointment', row.version, version)
  return row
}

/** PATCH /safety/appointments/:appointmentId: its note. */
export async function editAppointment(caller: CommandCaller, appointmentId: string, body: { readonly version: number; readonly note: string | null }, idempotencyKey?: string) {
  await writable(caller, appointmentId)
  const { result } = await command(caller, { name: 'safety.editAppointment', idempotencyKey, input: { appointmentId, ...body } }, async (tools) => {
    const row = await locked(tools, appointmentId, body.version)
    const note = body.note?.trim() || null
    await tools.tx.safetyAppointment.update({ where: { id: appointmentId }, data: { note, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'safety.editAppointment', recordType: 'SafetyAppointment', recordId: appointmentId, companyId: row.companyId, siteId: row.siteId, before: { note: row.note }, after: { note } })
    tools.emit({ type: 'safety_appointment.changed', subject: appointmentId, companyId: row.companyId, siteId: row.siteId, payload: { appointmentId, role: row.role as SafetyRole, change: 'EDITED', noticeId: null } })
    return { appointment: await viewOf(tools.tx, tools.context as OfficeContext, appointmentId, todayOf(tools.now)) }
  })
  return result
}

/** POST /safety/appointments/:appointmentId/sign: the appointee's signature, written once. */
export async function signAppointment(caller: CommandCaller, appointmentId: string, body: { readonly version: number; readonly method: AppointmentSignMethod; readonly signedName: string }, idempotencyKey?: string) {
  await writable(caller, appointmentId)
  const { result } = await command(caller, { name: 'safety.signAppointment', idempotencyKey, input: { appointmentId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await locked(tools, appointmentId, body.version)
    const today = todayOf(now)
    const untilDate = dayOrNull(row.untilDate)
    const letterOnFile = (await tx.storedFile.count({ where: { recordType: 'SafetyAppointment', recordId: appointmentId, status: 'AVAILABLE' } })) > 0
    refuseWith(signRefusal({ signed: row.signedAt !== null, ended: untilDate !== null && untilDate < today, method: body.method, signedName: body.signedName, appointeeName: appointeeName(row), letterOnFile }))
    const signedById = actorIdOf(tools.context)
    await tx.safetyAppointment.update({ where: { id: appointmentId }, data: { signedAt: now, signMethod: body.method, signedName: body.signedName.trim(), signedById, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'safety.signAppointment', recordType: 'SafetyAppointment', recordId: appointmentId, companyId: row.companyId, siteId: row.siteId, after: { method: body.method, signedName: body.signedName.trim(), letterOnFile } })
    tools.emit({ type: 'safety_appointment.changed', subject: appointmentId, companyId: row.companyId, siteId: row.siteId, payload: { appointmentId, role: row.role as SafetyRole, change: 'SIGNED', noticeId: null } })
    return { appointment: await viewOf(tx, tools.context as OfficeContext, appointmentId, today) }
  })
  return result
}

/** POST /safety/appointments/:appointmentId/end: the last day and the reason. */
export async function endAppointment(caller: CommandCaller, appointmentId: string, body: { readonly version: number; readonly untilDate: BusinessDate; readonly endReason: string }, idempotencyKey?: string) {
  await writable(caller, appointmentId)
  const { result } = await command(caller, { name: 'safety.endAppointment', idempotencyKey, input: { appointmentId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await locked(tools, appointmentId, body.version)
    const today = todayOf(now)
    refuseWith(endRefusal({ fromDate: dayOf(row.fromDate), untilDate: dayOrNull(row.untilDate) }, body.untilDate, today))
    await tx.safetyAppointment.update({ where: { id: appointmentId }, data: { untilDate: dateOf(body.untilDate), endReason: body.endReason.trim(), version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'safety.endAppointment', recordType: 'SafetyAppointment', recordId: appointmentId, companyId: row.companyId, siteId: row.siteId, before: { untilDate: dayOrNull(row.untilDate) }, after: { untilDate: body.untilDate }, reason: body.endReason })
    tools.emit({ type: 'safety_appointment.changed', subject: appointmentId, companyId: row.companyId, siteId: row.siteId, payload: { appointmentId, role: row.role as SafetyRole, change: 'ENDED', noticeId: null } })
    return { appointment: await viewOf(tx, tools.context as OfficeContext, appointmentId, today) }
  })
  return result
}
