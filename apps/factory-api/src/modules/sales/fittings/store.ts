import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { SALES_MEASUREMENTS_VIEW } from '@nexus/factory-domain/sales/measure-link/permissions'
import { notStartedProblem } from '@nexus/factory-domain/sales/mtm/rules'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
import { SALES_FITTINGS_MANAGE } from '@nexus/factory-domain/sales/fittings/permissions'
import { bookedRefusal, nextStepOf, type AppointmentKind, type AppointmentStatus, type FittingVerdict } from '@nexus/factory-domain/sales/fittings/rules'
import { APPOINTMENT_MAILS } from '@nexus/factory-domain/fittings/events'
import { actorOf, type OfficeContext } from '../../../core/context'
import { namesOf, type Reader } from '../mtm/store'
import { dayOrNull } from '../orders/store'
// B-W2b-F38: the fitting reminder switch of an appointment's company.
import { reminderOnFor } from '../quotes/reminder-switches'

/**
 * Fittings, alterations and remakes: the reads (B-W2b-360). An appointment and a fitting result each have a company and a
 * customer: the office reads them with sales.measurements.view over both (the rider's appointments and the changes asked to their
 * measures are personal data, as the profile), writes them with sales.fittings.manage. One that the caller may not read is not
 * found. Every read names its columns and runs one query at a time (a transaction client runs one at a time).
 *
 * Made-to-measure is switched off per template (GATE-MTM, Owner 11-10): an appointment is of a garment type (its profile's, else
 * the one it was booked for: kept in the booking's audit row, `fittings.book` → after.garmentType, as the table has no column),
 * a fitting result of its profile's, a remade unit of its style's template; nothing is booked, recorded, mailed or remade while
 * that template's made-to-measure rules are off.
 */

export type { Reader }
export const APPOINTMENT_RECORD = 'Appointment'
export const RESULT_RECORD = 'FittingResult'
export const BOOK_ACTION = 'fittings.book'
export const MAIL_TEMPLATES: Readonly<Record<(typeof APPOINTMENT_MAILS)[number], string>> = Object.freeze({ INVITE: 'fittings.invite', UPDATE: 'fittings.update', REMINDER: 'fittings.reminder', CANCEL: 'fittings.cancel' })

export const APPOINTMENT_SELECT = {
  id: true,
  companyId: true,
  partyId: true,
  contactId: true,
  riderName: true,
  measurementProfileId: true,
  kind: true,
  startsAt: true,
  endsAt: true,
  place: true,
  withUserId: true,
  withName: true,
  status: true,
  closedAt: true,
  closedById: true,
  cancelReason: true,
  notes: true,
  inviteSentAt: true,
  reminderSentAt: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.AppointmentSelect
export type AppointmentRow = Prisma.AppointmentGetPayload<{ select: typeof APPOINTMENT_SELECT }>

export const RESULT_SELECT = {
  id: true,
  companyId: true,
  partyId: true,
  appointmentId: true,
  salesOrderLineId: true,
  measurementProfileId: true,
  fittedAt: true,
  verdict: true,
  pointChanges: true,
  notes: true,
  alterationDays: true,
  alterationRepairId: true,
  newProfileId: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.FittingResultSelect
export type ResultRow = Prisma.FittingResultGetPayload<{ select: typeof RESULT_SELECT }>

export const appointmentNotFound = (): NotFoundError => new NotFoundError('Appointment not found.')
export const resultNotFound = (): NotFoundError => new NotFoundError('Fitting result not found.')

const scope = (row: { readonly companyId: string; readonly partyId: string }) => ({ companyId: row.companyId, partyId: row.partyId })
export const mayOn = (context: OfficeContext, permission: Permission, row: { readonly companyId: string; readonly partyId: string }): boolean => can(actorOf(context), permission, scope(row))
/** The caller reads the record (sales.measurements.view over its company and customer), else it is not found. */
export const sees = (context: OfficeContext, row: { readonly companyId: string; readonly partyId: string }): boolean => mayOn(context, SALES_MEASUREMENTS_VIEW, row)

export async function appointmentOf(db: Reader, id: string): Promise<AppointmentRow | null> {
  return isUuid(id) ? db.appointment.findUnique({ where: { id }, select: APPOINTMENT_SELECT }) : null
}

export async function resultOf(db: Reader, id: string): Promise<ResultRow | null> {
  return isUuid(id) ? db.fittingResult.findUnique({ where: { id }, select: RESULT_SELECT }) : null
}

// ---- made-to-measure started (GATE-MTM) ------------------------------------------------------------------------------------

/** Why nothing is done for a garment type now (its template missing, or its made-to-measure rules off), in words; null: started. */
export async function garmentRefusal(db: Reader, garmentType: string): Promise<string | null> {
  const template = await db.measurementTemplate.findFirst({ where: { code: garmentType }, select: { code: true, rulesOn: true, status: true } })
  if (!template) return `${garmentType} has no measurement template: a measurement template names the points to measure (Products › Sizes & measurements).`
  if (!template.rulesOn) return `Made-to-measure has not started for measurement template ${template.code}: its rules stay off until the Owner starts them (GATE-MTM).`
  if (template.status !== 'ACTIVE') return `Measurement template ${template.code} is archived: restore it first.`
  return null
}

/** Why a unit of the style cannot be made now (B-W2b-358's words: flagged, its template, its rules on), or null. */
export async function styleRefusal(db: Reader, styleId: string, garmentType?: string | null): Promise<string | null> {
  const style = await db.style.findUnique({ where: { id: styleId }, select: { code: true, mtmAllowed: true, measurementTemplateId: true } })
  if (!style) return 'The style of the unit is gone.'
  const template = style.measurementTemplateId ? await db.measurementTemplate.findUnique({ where: { id: style.measurementTemplateId }, select: { code: true, rulesOn: true } }) : null
  return notStartedProblem({ style: { code: style.code, mtmAllowed: style.mtmAllowed }, template, garmentType: garmentType ?? null })
}

/** The garment type each profile-less appointment was booked for (its booking's audit row). */
export async function bookedGarmentsOf(db: Reader, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await db.auditLog.findMany({ where: { recordType: APPOINTMENT_RECORD, recordId: { in: [...ids] }, action: BOOK_ACTION }, select: { recordId: true, after: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }] })
  const out = new Map<string, string>()
  for (const row of rows) {
    const value = (row.after as { garmentType?: unknown } | null)?.garmentType
    if (typeof value === 'string' && !out.has(row.recordId)) out.set(row.recordId, value)
  }
  return out
}

/** The garment type of one appointment (its profile's, else the one it was booked for), or null. */
export async function garmentOfAppointment(db: Reader, row: Pick<AppointmentRow, 'id' | 'measurementProfileId'>): Promise<string | null> {
  if (row.measurementProfileId) return (await db.measurementProfile.findUnique({ where: { id: row.measurementProfileId }, select: { garmentType: true } }))?.garmentType ?? null
  return (await bookedGarmentsOf(db, [row.id])).get(row.id) ?? null
}

// ---- appointments as the office reads them -----------------------------------------------------------------------------------

/** The list rows of these appointments, in their order. */
export async function appointmentRows(db: Reader, rows: readonly AppointmentRow[]) {
  if (rows.length === 0) return []
  const parties = new Map((await db.party.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.partyId))] } }, select: { id: true, code: true, legalName: true } })).map((row) => [row.id, row]))
  const profileIds = [...new Set(rows.flatMap((row) => (row.measurementProfileId ? [row.measurementProfileId] : [])))]
  const profiles = new Map((profileIds.length === 0 ? [] : await db.measurementProfile.findMany({ where: { id: { in: profileIds } }, select: { id: true, revision: true, garmentType: true } })).map((row) => [row.id, row]))
  const names = await namesOf(db, rows.map((row) => row.withUserId))
  const booked = await bookedGarmentsOf(db, rows.filter((row) => row.measurementProfileId === null).map((row) => row.id))
  const counts = await db.fittingResult.groupBy({ by: ['appointmentId'], where: { appointmentId: { in: rows.map((row) => row.id) } }, _count: { _all: true } })
  return rows.map((row) => {
    const party = parties.get(row.partyId)
    const profile = row.measurementProfileId ? profiles.get(row.measurementProfileId) : undefined
    return {
      id: row.id,
      companyId: row.companyId,
      partyId: row.partyId,
      customer: { code: party?.code ?? '', name: party?.legalName ?? '' },
      kind: row.kind as AppointmentKind,
      status: row.status as AppointmentStatus,
      rider: { contactId: row.contactId, name: row.riderName },
      profile: profile ? { id: profile.id, revision: profile.revision, garmentType: profile.garmentType } : null,
      garmentType: profile?.garmentType ?? booked.get(row.id) ?? null,
      startsAt: toUtcIso(row.startsAt),
      endsAt: toUtcIso(row.endsAt),
      place: row.place,
      with: { userId: row.withUserId, name: row.withName ?? (row.withUserId ? (names.get(row.withUserId) ?? null) : null) },
      inviteSentAt: row.inviteSentAt ? toUtcIso(row.inviteSentAt) : null,
      reminderSentAt: row.reminderSentAt ? toUtcIso(row.reminderSentAt) : null,
      results: counts.find((count) => count.appointmentId === row.id)?._count._all ?? 0,
      version: row.version,
    }
  })
}

const mailOf = (templateKey: string): (typeof APPOINTMENT_MAILS)[number] => (Object.entries(MAIL_TEMPLATES).find(([, key]) => key === templateKey)?.[0] ?? 'INVITE') as (typeof APPOINTMENT_MAILS)[number]

/** One appointment's record: its row, who closed and made it, its mails to the rider, its results, what the caller may do. */
export async function appointmentRecord(db: Reader, context: OfficeContext, row: AppointmentRow, facts: { readonly mailTo: boolean; readonly now: Date }) {
  const [base] = await appointmentRows(db, [row])
  const names = await namesOf(db, [row.closedById, row.createdById])
  const mails = await db.emailOutbound.findMany({ where: { recordType: APPOINTMENT_RECORD, recordId: row.id }, select: { id: true, templateKey: true, status: true, queuedAt: true, sentAt: true }, orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }] })
  const results = await db.fittingResult.findMany({ where: { appointmentId: row.id }, select: { id: true, verdict: true, fittedAt: true, salesOrderLineId: true }, orderBy: [{ fittedAt: 'asc' }, { id: 'asc' }] })
  const garment = base!.garmentType
  const off = garment ? await garmentRefusal(db, garment) : 'No garment type is known for this appointment.'
  const manage = mayOn(context, SALES_FITTINGS_MANAGE, row)
  const booked = row.status === 'BOOKED'
  const started = row.startsAt.getTime() <= facts.now.getTime()
  const why = !manage ? 'Your roles do not book or record fittings (sales.fittings.manage).' : !booked ? bookedRefusal(row.status as AppointmentStatus, 'moved') : off
  return {
    ...base!,
    closedAt: row.closedAt ? toUtcIso(row.closedAt) : null,
    closedBy: row.closedById ? { id: row.closedById, name: names.get(row.closedById) ?? '' } : null,
    cancelReason: row.cancelReason,
    notes: row.notes,
    mailTo: facts.mailTo,
    mails: mails.map((mail) => ({ id: mail.id, mail: mailOf(mail.templateKey ?? ''), status: mail.status as string, queuedAt: toUtcIso(mail.queuedAt), sentAt: mail.sentAt ? toUtcIso(mail.sentAt) : null })),
    resultList: results.map((result) => ({ id: result.id, verdict: result.verdict as FittingVerdict, fittedAt: toUtcIso(result.fittedAt), salesOrderLineId: result.salesOrderLineId })),
    createdAt: toUtcIso(row.createdAt),
    createdBy: row.createdById ? { id: row.createdById, name: names.get(row.createdById) ?? '' } : null,
    may: {
      move: manage && booked && off === null,
      close: manage && booked && started,
      cancel: manage && booked,
      invite: manage && booked && off === null && facts.mailTo && row.startsAt.getTime() > facts.now.getTime(),
      ledTo: manage && row.status === 'DONE' && row.measurementProfileId === null,
      result: manage && row.kind === 'FITTING' && (row.status === 'DONE' || (booked && started)) && off === null,
      notes: manage,
    },
    why,
    // B-W2b-F38: the company's fitting reminder switch (off: the hourly job sends no reminder for it).
    reminderEnabled: await reminderOnFor(db, row.companyId, 'FITTING'),
  }
}

// ---- fitting results as the office reads them ---------------------------------------------------------------------------------

/** The order line's promise now: its own date, else its order's. */
export async function linePromiseOf(db: Reader, salesOrderLineId: string): Promise<BusinessDate | null> {
  const line = await db.salesOrderLine.findUnique({ where: { id: salesOrderLineId }, select: { promiseDate: true, order: { select: { promiseDate: true } } } })
  return dayOrNull(line?.promiseDate ?? line?.order.promiseDate ?? null)
}

/** The views of these fitting results, in their order. */
export async function resultViews(db: Reader, context: OfficeContext, rows: readonly ResultRow[]) {
  if (rows.length === 0) return []
  const profileIds = [...new Set(rows.flatMap((row) => [row.measurementProfileId, ...(row.newProfileId ? [row.newProfileId] : [])]))]
  const profiles = new Map((await db.measurementProfile.findMany({ where: { id: { in: profileIds } }, select: { id: true, revision: true, riderName: true, garmentType: true, reviewStatus: true, measurements: true } })).map((row) => [row.id, row]))
  const garments = [...new Set([...profiles.values()].map((profile) => profile.garmentType))]
  const templates = garments.length === 0 ? [] : await db.measurementTemplate.findMany({ where: { code: { in: garments } }, select: { id: true, code: true, rulesOn: true } })
  const points = templates.length === 0 ? [] : await db.measurementPoint.findMany({ where: { templateId: { in: templates.map((template) => template.id) } }, select: { templateId: true, code: true, name: true } })
  const appointmentIds = [...new Set(rows.flatMap((row) => (row.appointmentId ? [row.appointmentId] : [])))]
  const appointments = new Map((appointmentIds.length === 0 ? [] : await db.appointment.findMany({ where: { id: { in: appointmentIds } }, select: { id: true, startsAt: true, place: true, status: true } })).map((row) => [row.id, row]))
  const lineIds = [...new Set(rows.flatMap((row) => (row.salesOrderLineId ? [row.salesOrderLineId] : [])))]
  const lines = new Map((lineIds.length === 0 ? [] : await db.salesOrderLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, orderId: true, seq: true, baseSize: true, promiseDate: true, style: { select: { code: true } }, colourway: { select: { code: true } }, order: { select: { number: true, promiseDate: true } } } })).map((row) => [row.id, row]))
  const repairIds = rows.flatMap((row) => (row.alterationRepairId ? [row.alterationRepairId] : []))
  const repairs = new Map((repairIds.length === 0 ? [] : await db.repairOrder.findMany({ where: { id: { in: repairIds } }, select: { id: true, number: true, stage: true } })).map((row) => [row.id, row]))
  const names = await namesOf(db, rows.map((row) => row.createdById))
  return rows.map((row) => {
    const profile = profiles.get(row.measurementProfileId)!
    const template = templates.find((entry) => entry.code === profile?.garmentType)
    const pointName = (code: string) => points.find((point) => point.templateId === template?.id && point.code === code)?.name ?? code
    const newer = row.newProfileId ? profiles.get(row.newProfileId) : undefined
    const line = row.salesOrderLineId ? lines.get(row.salesOrderLineId) : undefined
    const appointment = row.appointmentId ? appointments.get(row.appointmentId) : undefined
    const repair = row.alterationRepairId ? repairs.get(row.alterationRepairId) : undefined
    const current = line ? dayOrNull(line.promiseDate ?? line.order.promiseDate) : null
    const changes = Object.entries((row.pointChanges ?? {}) as Record<string, { change?: string; unit?: string; note?: string }>)
    const manage = mayOn(context, SALES_FITTINGS_MANAGE, row) && template?.rulesOn === true
    return {
      id: row.id,
      companyId: row.companyId,
      partyId: row.partyId,
      appointment: appointment ? { id: appointment.id, startsAt: toUtcIso(appointment.startsAt), place: appointment.place, status: appointment.status as AppointmentStatus } : null,
      orderLine: line ? { id: line.id, orderId: line.orderId, orderNumber: line.order.number, seq: line.seq, style: line.style.code, colourway: line.colourway.code, baseSize: line.baseSize } : null,
      profile: { id: row.measurementProfileId, revision: profile?.revision ?? 0, riderName: profile?.riderName ?? '', garmentType: profile?.garmentType ?? '' },
      fittedAt: toUtcIso(row.fittedAt),
      verdict: row.verdict as FittingVerdict,
      pointChanges: changes.map(([code, change]) => ({ code, name: pointName(code), change: change.change ?? '', unit: change.unit ?? '', note: change.note ?? null })),
      notes: row.notes,
      alterationDays: row.alterationDays,
      alteration: repair ? { id: repair.id, number: repair.number, stage: repair.stage as string } : null,
      newProfile: newer ? { id: newer.id, revision: newer.revision, review: newer.reviewStatus as string } : null,
      promise: line ? { current, byAlteration: current && row.alterationDays ? addDays(current, row.alterationDays) : null } : null,
      next: nextStepOf({ verdict: row.verdict as FittingVerdict, alterationRepairId: row.alterationRepairId, newProfileId: row.newProfileId, salesOrderLineId: row.salesOrderLineId }),
      version: row.version,
      createdAt: toUtcIso(row.createdAt),
      createdBy: row.createdById ? { id: row.createdById, name: names.get(row.createdById) ?? '' } : null,
      may: { alteration: manage && row.verdict === 'ALTER' && row.alterationRepairId === null, revision: manage && row.verdict !== 'OK' && row.newProfileId === null },
    }
  })
}
