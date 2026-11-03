import { z } from 'zod'
import { businessDate, defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { APPOINTMENT_SIGN_METHODS, ORGANISATION_LIMITS, RLS_NOTICE_STATUSES, SAFETY_ROLES } from '@nexus/factory-domain/safety/organisation/rules'

/**
 * The safety organisation and the RLS notice to INAIL (B-W2b-120; QHS-224, QHS-226; design plant.calendar sections
 * Safety organisation and RLS notice to INAIL, pop-ups Appointment and Record RLS notice, the organisation chart print).
 * An appointment names its appointee (the organisation register: safety.view); an outside contact carries the e-mail and
 * phone of its party contact for the notice board, a person of the company none. Never a health value, never money.
 */

const version = () => z.number().int().min(1)
const reason = () => z.string().trim().min(1).max(ORGANISATION_LIMITS.reason)
const note = () => z.string().trim().max(ORGANISATION_LIMITS.note)

export const refOut = output({ id: id(), code: z.string(), name: z.string() })
const codeName = output({ code: z.string(), name: z.string() })

export const appointeeOut = output({
  kind: z.enum(['EMPLOYEE', 'OUTSIDE']),
  employeeId: id().nullable(),
  name: z.string(),
  partyId: id().nullable(),
  partyName: z.string().nullable(),
  contactId: id().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
})

export const appointmentOut = output({
  id: id(),
  companyId: id(),
  company: codeName,
  siteId: id().nullable(),
  site: codeName.nullable(),
  role: z.enum(SAFETY_ROLES),
  law: z.string(),
  appointee: appointeeOut,
  shift: refOut.nullable(),
  fromDate: z.string(),
  untilDate: z.string().nullable(),
  endReason: z.string().nullable(),
  inForce: z.boolean(),
  ended: z.boolean(),
  signature: output({ signedAt: z.string(), method: z.enum(APPOINTMENT_SIGN_METHODS), signedName: z.string(), signedBy: z.string().nullable() }).nullable(),
  /** The appointment letter: the newest AVAILABLE file of the row. */
  letter: output({ fileId: id(), name: z.string() }).nullable(),
  /** "Training valid (from Skills)": the newest PASSED record of the role's course type, not corrected away. */
  training: output({ state: z.enum(['VALID', 'EXPIRED', 'NONE', 'NOT_TRACKED']), validUntil: z.string().nullable(), course: z.string().nullable() }),
  note: z.string().nullable(),
  version: z.number().int(),
  canManage: z.boolean(),
})

export const noticeOut = output({
  id: id(),
  companyId: id(),
  company: codeName,
  appointmentId: id(),
  role: z.enum(SAFETY_ROLES),
  /** The RLS (a person of the company) or the territorial RLS (an outside contact), and the site of the appointment. */
  appointee: z.string(),
  site: codeName.nullable(),
  appointedFrom: z.string(),
  dueOn: z.string(),
  status: z.enum(RLS_NOTICE_STATUSES),
  filedOn: z.string().nullable(),
  reference: z.string().nullable(),
  filedBy: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  /** INAIL's receipt: the newest AVAILABLE file of the notice. */
  receipt: output({ fileId: id(), name: z.string() }).nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
  canManage: z.boolean(),
})

const missingOut = output({ companyId: id(), siteId: id().nullable(), role: z.enum(SAFETY_ROLES) })
const placesOut = output({ id: id(), code: z.string(), name: z.string(), sites: z.array(refOut) })

export const organisationContract = defineContract({
  querystring: input({
    companyId: id().optional(),
    siteId: id().optional(),
    /** Ended terms too (the history); default: the terms in force and those that start later. */
    ended: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  }),
  response: {
    200: output({
      appointments: z.array(appointmentOut),
      missing: z.array(missingOut),
      companies: z.array(placesOut),
      canManage: z.boolean(),
      canUpload: z.boolean(),
      law: z.string(),
      today: z.string(),
    }),
  },
})

export const appointmentRecordContract = defineContract({
  params: input({ appointmentId: id() }),
  response: { 200: output({ appointment: appointmentOut, notices: z.array(noticeOut), today: z.string() }) },
})

export const peopleContract = defineContract({
  querystring: input({ companyId: id(), q: z.string().trim().max(80).optional() }),
  response: { 200: output({ people: z.array(output({ id: id(), name: z.string(), employeeCode: z.string().nullable(), site: refOut })), complete: z.boolean() }) },
})

export const contactsContract = defineContract({
  querystring: input({ companyId: id(), q: z.string().trim().max(80).optional() }),
  response: {
    200: output({
      contacts: z.array(output({ partyId: id(), partyName: z.string(), contactId: id().nullable(), name: z.string(), email: z.string().nullable(), phone: z.string().nullable() })),
      complete: z.boolean(),
    }),
  },
})

export const shiftsContract = defineContract({
  querystring: input({ companyId: id() }),
  response: { 200: output({ shifts: z.array(refOut) }) },
})

export const createAppointmentContract = defineContract({
  body: input({
    companyId: id(),
    siteId: id().nullable().optional(),
    role: z.enum(SAFETY_ROLES),
    employeeId: id().optional(),
    outsideName: z.string().trim().min(1).max(ORGANISATION_LIMITS.name).optional(),
    outsidePartyId: id().optional(),
    outsideContactId: id().optional(),
    shiftPatternId: id().optional(),
    fromDate: businessDate(),
    untilDate: businessDate().optional(),
    note: note().optional(),
    /** An RLS or RLST: the day the notice to INAIL is due (default: the first day; the plan gives no number of days). */
    noticeDueOn: businessDate().optional(),
    /** An RLS or RLST already notified before it was recorded here: the filing (the notice is recorded FILED). */
    noticeFiled: input({ filedOn: businessDate(), reference: z.string().trim().min(1).max(ORGANISATION_LIMITS.reference) }).optional(),
  }),
  response: { 200: output({ appointment: appointmentOut, notice: noticeOut.nullable() }), 201: output({ appointment: appointmentOut, notice: noticeOut.nullable() }) },
})

export const editAppointmentContract = defineContract({
  params: input({ appointmentId: id() }),
  body: input({ version: version(), note: note().nullable() }),
  response: { 200: output({ appointment: appointmentOut }) },
})

export const signAppointmentContract = defineContract({
  params: input({ appointmentId: id() }),
  body: input({ version: version(), method: z.enum(APPOINTMENT_SIGN_METHODS), signedName: z.string().trim().min(1).max(ORGANISATION_LIMITS.name) }),
  response: { 200: output({ appointment: appointmentOut }) },
})

export const endAppointmentContract = defineContract({
  params: input({ appointmentId: id() }),
  body: input({ version: version(), untilDate: businessDate(), endReason: reason() }),
  response: { 200: output({ appointment: appointmentOut }) },
})

export const listNoticesContract = defineContract({
  querystring: input({ companyId: id().optional(), status: z.enum([...RLS_NOTICE_STATUSES, 'ALL']).default('ALL'), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: { 200: output({ notices: z.array(noticeOut), canManage: z.boolean(), law: z.string(), today: z.string() }) },
})

export const fileNoticeContract = defineContract({
  params: input({ noticeId: id() }),
  body: input({ version: version(), filedOn: businessDate(), reference: z.string().trim().min(1).max(ORGANISATION_LIMITS.reference), note: note().optional() }),
  response: { 200: output({ notice: noticeOut }) },
})

export const noticeDueContract = defineContract({
  params: input({ noticeId: id() }),
  body: input({ version: version(), dueOn: businessDate() }),
  response: { 200: output({ notice: noticeOut }) },
})

export const cancelNoticeContract = defineContract({
  params: input({ noticeId: id() }),
  body: input({ version: version(), reason: reason() }),
  response: { 200: output({ notice: noticeOut }) },
})

