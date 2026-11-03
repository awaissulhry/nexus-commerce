import type { BusinessDate } from '../../core/time'

/**
 * The safety organisation (B-W2b-120; QHS-224 "who holds each safety role, per company and site", QHS-226 "the RLS notice
 * to INAIL"; design plant.calendar sections Safety organisation and RLS notice to INAIL, pop-ups Appointment and Record RLS
 * notice), pure. The tables are factory-db safety.prisma's SafetyAppointment and RlsNotice (B-W2b-87); its guards hold the
 * same shape for every login (one appointee, an RLS of the company, an RLST outside, shifts only for the teams, a
 * signature written once, a notice PENDING → FILED | CANCELLED). The law is named in words only where the plan names it
 * (SCOPE QHS-224: D.Lgs. 81/2008 art. 18 c.1 b, art. 28 c.2 e; QHS-226: art. 18 c.1 aa; the roles' articles as the schema
 * step wrote them). Nothing here measures a person: an appointment names its appointee inside the organisation register,
 * which the roles that keep it read (W2b plan §10 "Worker names in safety registers").
 */

/** The roles, as factory-db's SafetyRole enum (the design's order: employer first, the teams last). */
export const SAFETY_ROLES = ['EMPLOYER', 'RSPP', 'ASPP', 'DOCTOR', 'RLS', 'RLST', 'SUPERVISOR', 'MANAGER', 'FIRST_AID', 'FIRE_EMERGENCY'] as const
export type SafetyRole = (typeof SAFETY_ROLES)[number]

/** How the appointee signed (factory-db SafetySignMethod; an appointment has no floor signature). */
export const APPOINTMENT_SIGN_METHODS = ['OFFICE', 'PAPER'] as const
export type AppointmentSignMethod = (typeof APPOINTMENT_SIGN_METHODS)[number]

export const RLS_NOTICE_STATUSES = ['PENDING', 'FILED', 'CANCELLED'] as const
export type RlsNoticeStatus = (typeof RLS_NOTICE_STATUSES)[number]

/** The law of each role, in words (D.Lgs. 81/2008), as the schema step names it; the screens show it as a LawRef. */
export const ROLE_LAW: Readonly<Record<SafetyRole, string>> = Object.freeze({
  EMPLOYER: 'D.Lgs. 81/2008 art. 2 c.1 b',
  RSPP: 'D.Lgs. 81/2008 artt. 17, 31-32',
  ASPP: 'D.Lgs. 81/2008 art. 31',
  DOCTOR: 'D.Lgs. 81/2008 artt. 18 c.1 a, 38-39',
  RLS: 'D.Lgs. 81/2008 art. 47',
  RLST: 'D.Lgs. 81/2008 art. 48',
  SUPERVISOR: 'D.Lgs. 81/2008 artt. 2 c.1 e, 19',
  MANAGER: 'D.Lgs. 81/2008 artt. 2 c.1 d, 18',
  FIRST_AID: 'D.Lgs. 81/2008 artt. 18 c.1 b, 45',
  FIRE_EMERGENCY: 'D.Lgs. 81/2008 artt. 18 c.1 b, 46',
})
/** The organisation chart and the notice (SCOPE QHS-224, QHS-226). */
export const ORGANISATION_LAW = 'D.Lgs. 81/2008 art. 18 c.1 b; art. 28 c.2 e'
export const RLS_NOTICE_LAW = 'D.Lgs. 81/2008 art. 18 c.1 aa'

/** The representative of the workers: of the company (RLS) or territorial (RLST, an outside contact). */
export const RLS_ROLES: readonly SafetyRole[] = Object.freeze(['RLS', 'RLST'])
/** Only these are appointed per shift (a team per shift; the schema's rule). */
export const TEAM_ROLES: readonly SafetyRole[] = Object.freeze(['FIRST_AID', 'FIRE_EMERGENCY'])

/**
 * "Safety roles without a person" (the tile; design empty state "Name your RSPP and occupational doctor first"): the roles
 * every company holds — the employer, the RSPP, the occupational doctor, a workers' representative (RLS, or a territorial
 * RLST) — and the two teams every site holds (first aid, fire and emergency). ASPP, supervisors and managers are named when
 * the company has them, so none is counted missing.
 */
export const COMPANY_ROLES: readonly SafetyRole[] = Object.freeze(['EMPLOYER', 'RSPP', 'DOCTOR', 'RLS'])
export const SITE_ROLES: readonly SafetyRole[] = Object.freeze(['FIRST_AID', 'FIRE_EMERGENCY'])

/**
 * The course type of the training a role's holder keeps (factory-db SafetyCourseType), read from People › Skills (the
 * training records): "training valid (from Skills)". The RSPP's, the ASPP's and the doctor's qualifications are outside
 * the course catalogue, the employer's and the RLST's are not kept here: null (the chart says "not tracked here").
 */
export function courseTypeOf(role: SafetyRole): string | null {
  switch (role) {
    case 'RLS':
      return 'RLS'
    case 'FIRST_AID':
      return 'FIRST_AID'
    case 'FIRE_EMERGENCY':
      return 'FIRE'
    case 'SUPERVISOR':
      return 'SUPERVISOR'
    case 'MANAGER':
      return 'MANAGER'
    default:
      return null
  }
}

export const ORGANISATION_LIMITS = Object.freeze({ name: 200, reason: 500, note: 1000, reference: 100, list: 500 })

export const ORGANISATION_REFUSALS = [
  'PERSON_NOT_ACTIVE',
  'PERSON_OTHER_COMPANY',
  'RLS_IS_EMPLOYEE',
  'RLST_IS_OUTSIDE',
  'SHIFT_ONLY_TEAMS',
  'SHIFT_OTHER_COMPANY',
  'SITE_OTHER_COMPANY',
  'CONTACT_OTHER_PARTY',
  'ENDS_BEFORE_START',
  'ALREADY_APPOINTED',
  'ENDED',
  'SIGNED_ALREADY',
  'NAME_MISMATCH',
  'LETTER_MISSING',
  'NOTICE_NOT_PENDING',
  'FILED_IN_FUTURE',
  'FILED_BEFORE_APPOINTMENT',
] as const
export type OrganisationRefusalCode = (typeof ORGANISATION_REFUSALS)[number]
export interface OrganisationRefusal {
  readonly code: OrganisationRefusalCode
  readonly message: string
  readonly field?: string
}

/** The appointee as typed: a person of the company, or an outside contact by name (with its party and contact). */
export interface AppointeeInput {
  readonly role: SafetyRole
  readonly employeeId?: string | null | undefined
  readonly outsideName?: string | null | undefined
  readonly shiftPatternId?: string | null | undefined
  readonly fromDate: BusinessDate
  readonly untilDate?: BusinessDate | null | undefined
}

/** The shape every appointment holds (the guard's rules in words; null: it may be saved). */
export function appointeeRefusal(input: AppointeeInput): OrganisationRefusal | null {
  const outside = (input.outsideName ?? '').trim() !== ''
  if (input.role === 'RLS' && (!input.employeeId || outside)) return { code: 'RLS_IS_EMPLOYEE', message: 'An RLS is a person of the company, elected or designated among the workers; a territorial RLS is an RLST.', field: 'employeeId' }
  if (input.role === 'RLST' && (input.employeeId || !outside)) return { code: 'RLST_IS_OUTSIDE', message: 'A territorial RLS (RLST) is an outside contact, not a person of the company.', field: 'outsideName' }
  if (input.shiftPatternId && !TEAM_ROLES.includes(input.role)) return { code: 'SHIFT_ONLY_TEAMS', message: 'Only a first-aid or a fire and emergency team is appointed per shift.', field: 'shiftPatternId' }
  if (input.untilDate && input.untilDate < input.fromDate) return { code: 'ENDS_BEFORE_START', message: 'A term ends on or after its first day.', field: 'untilDate' }
  return null
}

/** In force on a day: begun and not ended (the last day still counts). */
export function inForce(appointment: { readonly fromDate: BusinessDate; readonly untilDate: BusinessDate | null }, today: BusinessDate): boolean {
  return appointment.fromDate <= today && (appointment.untilDate === null || appointment.untilDate >= today)
}

/** Ending a term (null: it may end on that day). */
export function endRefusal(appointment: { readonly fromDate: BusinessDate; readonly untilDate: BusinessDate | null }, untilDate: BusinessDate, today: BusinessDate): OrganisationRefusal | null {
  if (appointment.untilDate !== null && appointment.untilDate < today) return { code: 'ENDED', message: 'This term has ended already: a new term is a new appointment.' }
  if (untilDate < appointment.fromDate) return { code: 'ENDS_BEFORE_START', message: 'A term ends on or after its first day.', field: 'untilDate' }
  return null
}

/** Names compared loosely: case, accents, extra spaces and punctuation do not count. */
export function normalName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}
export const sameName = (a: string, b: string): boolean => normalName(a) !== '' && normalName(a) === normalName(b)

/**
 * The appointee's signature (null: it may be recorded). OFFICE: the appointee types their own name at the office's screen
 * (it must be the appointee's name); PAPER: the office records a signed letter, so the letter's scan is on file first.
 */
export function signRefusal(facts: { readonly signed: boolean; readonly ended: boolean; readonly method: AppointmentSignMethod; readonly signedName: string; readonly appointeeName: string; readonly letterOnFile: boolean }): OrganisationRefusal | null {
  if (facts.signed) return { code: 'SIGNED_ALREADY', message: "The appointee's signature is recorded already; it is written once." }
  if (facts.ended) return { code: 'ENDED', message: 'This term has ended: nothing more is signed on it.' }
  if (facts.method === 'OFFICE' && !sameName(facts.signedName, facts.appointeeName)) return { code: 'NAME_MISMATCH', message: "The name typed is not the appointee's.", field: 'signedName' }
  if (facts.method === 'PAPER' && !facts.letterOnFile) return { code: 'LETTER_MISSING', message: 'Upload the signed letter first: a paper signature is recorded with its scan.' }
  return null
}

/** Recording the notice filed on the INAIL portal (null: it may be recorded). */
export function filingRefusal(facts: { readonly status: RlsNoticeStatus; readonly filedOn: BusinessDate; readonly appointedFrom: BusinessDate; readonly today: BusinessDate }): OrganisationRefusal | null {
  if (facts.status !== 'PENDING') return { code: 'NOTICE_NOT_PENDING', message: `This notice is ${facts.status === 'FILED' ? 'filed' : 'cancelled'} already.` }
  if (facts.filedOn > facts.today) return { code: 'FILED_IN_FUTURE', message: 'The day it was filed is today or before.', field: 'filedOn' }
  if (facts.filedOn < facts.appointedFrom) return { code: 'FILED_BEFORE_APPOINTMENT', message: 'A notice is filed on or after the day the RLS was elected or designated.', field: 'filedOn' }
  return null
}

/** One slot of the organisation that nobody holds today: a company's role, or a site's team. */
export interface MissingRole {
  readonly companyId: string
  readonly siteId: string | null
  readonly role: SafetyRole
}

/**
 * The roles without a person today: per company the employer, the RSPP, the doctor and a workers' representative (an RLS
 * or an RLST, at the company or at any of its sites); per site the first-aid and the fire team (a whole-company team
 * covers every site). Only appointments in force count.
 */
export function missingRoles(
  places: readonly { readonly companyId: string; readonly siteIds: readonly string[] }[],
  appointments: readonly { readonly companyId: string; readonly siteId: string | null; readonly role: SafetyRole; readonly fromDate: BusinessDate; readonly untilDate: BusinessDate | null }[],
  today: BusinessDate,
): MissingRole[] {
  const live = appointments.filter((appointment) => inForce(appointment, today))
  const missing: MissingRole[] = []
  for (const place of places) {
    const ofCompany = live.filter((appointment) => appointment.companyId === place.companyId)
    for (const role of COMPANY_ROLES) {
      const roles = role === 'RLS' ? RLS_ROLES : [role]
      if (!ofCompany.some((appointment) => roles.includes(appointment.role))) missing.push({ companyId: place.companyId, siteId: null, role })
    }
    for (const siteId of place.siteIds) {
      for (const role of SITE_ROLES) {
        if (!ofCompany.some((appointment) => appointment.role === role && (appointment.siteId === null || appointment.siteId === siteId))) missing.push({ companyId: place.companyId, siteId, role })
      }
    }
  }
  return missing
}

/** A training record's standing for a role holder: valid until a day, expired, none on record, or not kept here. */
export type TrainingState = 'VALID' | 'EXPIRED' | 'NONE' | 'NOT_TRACKED'
export function trainingStateOf(courseType: string | null, validUntil: BusinessDate | null | undefined, onRecord: boolean, today: BusinessDate): TrainingState {
  if (courseType === null) return 'NOT_TRACKED'
  if (!onRecord) return 'NONE'
  return validUntil === null || validUntil === undefined || validUntil >= today ? 'VALID' : 'EXPIRED'
}
