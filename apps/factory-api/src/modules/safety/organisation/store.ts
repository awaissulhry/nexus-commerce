import type { FactoryClient, Prisma } from '@nexus/factory-db'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { SAFETY_ORGANISATION_MANAGE } from '@nexus/factory-domain/safety/organisation/permissions'
import { courseTypeOf, inForce, ROLE_LAW, trainingStateOf, type AppointmentSignMethod, type RlsNoticeStatus, type SafetyRole } from '@nexus/factory-domain/safety/organisation/rules'
import type { CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { userNames } from '../../people/employees/employees'
import { dayOf, dayOrNull, mayAt } from './access'

/**
 * The safety organisation's rows as the screens read them (B-W2b-120): an appointment with its company, site, appointee
 * (a person of the company by name; an outside contact with its party contact's e-mail and phone, for the notice board),
 * shift, signature, letter (the newest AVAILABLE file of the row) and the training of the role from People › Skills; an
 * RLS notice with its appointment and INAIL's receipt. Shared by the reads, the writes (their answers) and the calendar's
 * sources.
 */

type Client = FactoryClient | CommandTx

export const APPOINTMENT_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  role: true,
  employeeId: true,
  outsideName: true,
  outsidePartyId: true,
  outsideContactId: true,
  shiftPatternId: true,
  fromDate: true,
  untilDate: true,
  endReason: true,
  signedAt: true,
  signMethod: true,
  signedName: true,
  signedById: true,
  note: true,
  version: true,
  company: { select: { code: true, legalName: true } },
  site: { select: { code: true, name: true } },
  employee: { select: { firstName: true, lastName: true, status: true } },
  outsideParty: { select: { legalName: true } },
  outsideContact: { select: { name: true, email: true, phone: true } },
  shiftPattern: { select: { id: true, code: true, name: true } },
} as const satisfies Prisma.SafetyAppointmentSelect
export type AppointmentRow = Prisma.SafetyAppointmentGetPayload<{ select: typeof APPOINTMENT_SELECT }>

export const appointeeName = (row: Pick<AppointmentRow, 'employee' | 'outsideName'>): string => (row.employee ? `${row.employee.firstName} ${row.employee.lastName}` : (row.outsideName ?? ''))

/** The newest AVAILABLE file of each record of a type (a letter, a receipt), by record id. */
export async function newestFiles(client: Client, recordType: string, ids: readonly string[]): Promise<Map<string, { fileId: string; name: string }>> {
  if (ids.length === 0) return new Map()
  const files = await client.storedFile.findMany({
    where: { recordType, recordId: { in: [...ids] }, status: 'AVAILABLE' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, recordId: true, originalName: true },
  })
  const newest = new Map<string, { fileId: string; name: string }>()
  for (const file of files) if (!newest.has(file.recordId)) newest.set(file.recordId, { fileId: file.id, name: file.originalName })
  return newest
}

/**
 * "Training valid (from Skills)": for each person, the newest PASSED record of each course type that stands (not corrected
 * away: a correction replaces it, a VOID correction removes it), by `<employee>:<course type>`.
 */
export async function trainingOf(client: Client, employeeIds: readonly string[], courseTypes: readonly string[]): Promise<Map<string, { validUntil: BusinessDate | null; course: string }>> {
  if (employeeIds.length === 0 || courseTypes.length === 0) return new Map()
  const records = await client.trainingRecord.findMany({
    where: { employeeId: { in: [...new Set(employeeIds)] }, result: 'PASSED', corrections: { none: {} }, course: { type: { in: [...new Set(courseTypes)] as never } } },
    orderBy: [{ completedOn: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    select: { employeeId: true, validUntil: true, course: { select: { type: true, name: true } } },
  })
  const found = new Map<string, { validUntil: BusinessDate | null; course: string }>()
  for (const record of records) {
    const key = `${record.employeeId}:${record.course.type}`
    if (!found.has(key)) found.set(key, { validUntil: dayOrNull(record.validUntil), course: record.course.name })
  }
  return found
}

/** The appointments as the screens show them (one read for the letters, the signers' names and the training). */
export async function appointmentViews(client: Client, context: OfficeContext, rows: readonly AppointmentRow[], today: BusinessDate) {
  const letters = await newestFiles(client, 'SafetyAppointment', rows.map((row) => row.id))
  const signers = await userNames(client, rows.map((row) => row.signedById))
  const tracked = rows.filter((row) => row.employeeId !== null && courseTypeOf(row.role as SafetyRole) !== null)
  const training = await trainingOf(client, tracked.map((row) => row.employeeId!), tracked.map((row) => courseTypeOf(row.role as SafetyRole)!))
  return rows.map((row) => {
    const role = row.role as SafetyRole
    const fromDate = dayOf(row.fromDate)
    const untilDate = dayOrNull(row.untilDate)
    const courseType = courseTypeOf(role)
    const held = row.employeeId && courseType ? training.get(`${row.employeeId}:${courseType}`) : undefined
    return {
      id: row.id,
      companyId: row.companyId,
      company: { code: row.company.code, name: row.company.legalName },
      siteId: row.siteId,
      site: row.site ? { code: row.site.code, name: row.site.name } : null,
      role,
      law: ROLE_LAW[role],
      appointee: {
        kind: row.employeeId ? ('EMPLOYEE' as const) : ('OUTSIDE' as const),
        employeeId: row.employeeId,
        name: appointeeName(row),
        partyId: row.outsidePartyId,
        partyName: row.outsideParty?.legalName ?? null,
        contactId: row.outsideContactId,
        // An outside contact's work e-mail and phone for the notice board; a person of the company: none (personal).
        email: row.outsideContact?.email ?? null,
        phone: row.outsideContact?.phone ?? null,
      },
      shift: row.shiftPattern ? { id: row.shiftPattern.id, code: row.shiftPattern.code, name: row.shiftPattern.name } : null,
      fromDate,
      untilDate,
      endReason: row.endReason,
      inForce: inForce({ fromDate, untilDate }, today),
      ended: untilDate !== null && untilDate < today,
      signature: row.signedAt && row.signMethod && row.signedName ? { signedAt: row.signedAt.toISOString(), method: row.signMethod as AppointmentSignMethod, signedName: row.signedName, signedBy: row.signedById ? (signers.get(row.signedById) ?? null) : null } : null,
      letter: letters.get(row.id) ?? null,
      training: { state: trainingStateOf(courseType, held?.validUntil ?? null, held !== undefined, today), validUntil: held?.validUntil ?? null, course: held?.course ?? null },
      note: row.note,
      version: row.version,
      canManage: mayAt(context, SAFETY_ORGANISATION_MANAGE, { companyId: row.companyId, siteId: row.siteId }),
    }
  })
}

export const NOTICE_SELECT = {
  id: true,
  companyId: true,
  appointmentId: true,
  dueOn: true,
  status: true,
  filedOn: true,
  reference: true,
  filedById: true,
  cancelledAt: true,
  cancelReason: true,
  note: true,
  version: true,
  appointment: { select: { role: true, siteId: true, fromDate: true, outsideName: true, employee: { select: { firstName: true, lastName: true, status: true } }, company: { select: { code: true, legalName: true } }, site: { select: { code: true, name: true } } } },
} as const satisfies Prisma.RlsNoticeSelect
export type NoticeRow = Prisma.RlsNoticeGetPayload<{ select: typeof NOTICE_SELECT }>

export async function noticeViews(client: Client, context: OfficeContext, rows: readonly NoticeRow[]) {
  const receipts = await newestFiles(client, 'RlsNotice', rows.map((row) => row.id))
  const filers = await userNames(client, rows.map((row) => row.filedById))
  return rows.map((row) => ({
    id: row.id,
    companyId: row.companyId,
    company: { code: row.appointment.company.code, name: row.appointment.company.legalName },
    appointmentId: row.appointmentId,
    role: row.appointment.role as SafetyRole,
    appointee: appointeeName({ employee: row.appointment.employee as AppointmentRow['employee'], outsideName: row.appointment.outsideName }),
    site: row.appointment.site ? { code: row.appointment.site.code, name: row.appointment.site.name } : null,
    appointedFrom: dayOf(row.appointment.fromDate),
    dueOn: dayOf(row.dueOn),
    status: row.status as RlsNoticeStatus,
    filedOn: dayOrNull(row.filedOn),
    reference: row.reference,
    filedBy: row.filedById ? (filers.get(row.filedById) ?? null) : null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelReason: row.cancelReason,
    receipt: receipts.get(row.id) ?? null,
    note: row.note,
    version: row.version,
    canManage: mayAt(context, SAFETY_ORGANISATION_MANAGE, { companyId: row.companyId, siteId: row.appointment.siteId }),
  }))
}
