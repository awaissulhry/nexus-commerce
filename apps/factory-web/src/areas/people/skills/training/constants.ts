/**
 * The training API's lists of values (B-W2b-133, B-W2b-139), kept here because the domain's rule files reach `node:crypto`
 * (the role sheets' fingerprint) and must not enter the browser bundle. `training.vitest.test.ts` holds each one equal to
 * the domain's, so a change there fails here first.
 */

export const COURSE_TYPES = ['GENERAL', 'SPECIFIC_LOW', 'SPECIFIC_MEDIUM', 'SPECIFIC_HIGH', 'SUPERVISOR', 'MANAGER', 'RLS', 'FIRST_AID', 'FIRE', 'FORKLIFT', 'OTHER'] as const
export const COURSE_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export const COURSE_FIELDS = ['name', 'nameI18n', 'hours', 'refresherMonths', 'refresherHours', 'inPersonRequired', 'provider', 'legalBasis', 'sortOrder'] as const
export const NEED_STATES = ['MET', 'DUE', 'OVERDUE'] as const
export const DUE_STATES = ['VALID', 'DUE_SOON', 'EXPIRED', 'NEEDED'] as const
export const DUE_VIEWS = ['due', 'overdue', 'soon', 'language', 'all'] as const
export const RECORD_RESULTS = ['PASSED', 'FAILED', 'VOID'] as const
export const SESSION_STATUSES = ['OPEN', 'CLOSED', 'CANCELLED'] as const
export const SIGN_METHODS = ['OFFICE', 'FLOOR_PIN', 'PAPER'] as const
export const VALIDITY_STATES = ['VALID', 'DUE_SOON', 'EXPIRED'] as const

/** The refusals of the two APIs (`refusal/<CODE>`), said in this page's words (`refusal.<CODE>`). */
export const TRAINING_REFUSALS = ['CODE_TAKEN', 'ARCHIVED', 'NOT_ARCHIVED', 'COURSE_REQUIRED', 'IMPACT_CHANGED', 'COURSE_NOT_AVAILABLE', 'COURSE_NOT_GROUP_WIDE', 'CLASS_RETIRED'] as const
export const RECORDS_REFUSAL_CODES = [
  'COURSE_NOT_AVAILABLE',
  'TRAINER_NOT_AVAILABLE',
  'SESSION_STOPPED',
  'SESSION_NOT_HELD',
  'SIGNED_ALREADY',
  'NOT_COUNTERSIGNED',
  'NO_ATTENDANCE',
  'HAS_RECORDS',
  'ATTENDED_ALREADY',
  'PERSON_NOT_ACTIVE',
  'PERSON_OTHER_COMPANY',
  'NO_EMPLOYEE',
  'NOT_THE_TRAINER',
  'NO_TRAINER_WORKER',
  'COUNTERSIGNED_ALREADY',
  'ATTENDANCE_VOIDED',
  'NOT_OF_SESSION',
  'LANGUAGE_NOT_UNDERSTOOD',
  'CORRECTED_ALREADY',
  'NOTHING_CHANGES',
  'IN_FUTURE',
  'INSTRUCTOR_IS_PERSON',
  'MACHINE_NOT_OF_CLASS',
  'ENTRY_SIGNED',
  'ENTRY_VOIDED',
] as const

/** The database's bounds (TRAINING_LIMITS, RECORD_LIMITS): the form holds what the API would refuse. */
export const LIMITS = Object.freeze({
  code: 30,
  name: 160,
  provider: 160,
  legalBasis: 300,
  courseHours: 200,
  refresherMonths: 120,
  withinDays: 365,
  requirements: 40,
  standard: 20,
  people: 100,
  trainerName: 160,
  task: 300,
  reason: 500,
  note: 1000,
  minutes: 1440,
  soonDays: 60,
})

/** A course's code (stored in capitals; the database refuses spaces). */
export const COURSE_CODE = /^[A-Z0-9][A-Z0-9._/-]*$/
/** Hours with at most two decimals ("4", "12.5"). */
export const HOURS = /^\d{1,3}(?:\.\d{1,2})?$/
/** ISO 639-1, as the records keep a language. */
export const LANGUAGE = /^[a-z]{2}$/

/** The laws the screens cite (references only, never a number of the law). */
export const LAWS = Object.freeze({
  training: 'D.Lgs. 81/2008 art. 37',
  language: 'D.Lgs. 81/2008 art. 37 c.13',
  instruction: 'D.Lgs. 81/2008 art. 37 c.5',
  machines: 'D.Lgs. 81/2008 art. 71 c.7; art. 73',
})
