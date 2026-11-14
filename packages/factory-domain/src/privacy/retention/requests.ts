import type { Issue } from '../../core/errors'

/**
 * A person's data request (B-W2b-405; PLT-202, PLT-203; GDPR arts. 12, 15, 16, 17, 20; design admin.privacy "Data requests":
 * person, kind, received, due with a countdown, state). The lists below are the factory-db enums, value for value (the API's
 * PG test holds it). The clock counts exact hours, as the database does: due 720 hours (30 days) after it came in; extended
 * once, within that first month (art. 12(3): the person is told within one month), by one or two more months of 720 hours,
 * at most 2160 hours (90 days) after it came in.
 */

export const DATA_SUBJECT_KINDS = ['WORKER', 'USER', 'CONTACT', 'PROSPECT', 'REPORTER'] as const
export type DataSubjectKind = (typeof DATA_SUBJECT_KINDS)[number]

export const DATA_REQUEST_KINDS = ['ACCESS', 'ERASURE', 'CORRECTION'] as const
export type DataRequestKind = (typeof DATA_REQUEST_KINDS)[number]

export const DATA_REQUEST_STATUSES = ['RECEIVED', 'IN_PROGRESS', 'DONE', 'REFUSED', 'WITHDRAWN'] as const
export type DataRequestStatus = (typeof DATA_REQUEST_STATUSES)[number]

export const OPEN_REQUEST_STATUSES = ['RECEIVED', 'IN_PROGRESS'] as const satisfies readonly DataRequestStatus[]
export const isOpenRequest = (status: string): boolean => (OPEN_REQUEST_STATUSES as readonly string[]).includes(status)

/** The record that names the person, per kind (the database refuses another). */
export const PERSON_RECORD_TYPES: Readonly<Record<DataSubjectKind, readonly string[]>> = Object.freeze({
  WORKER: ['Employee', 'Worker'],
  USER: ['User'],
  CONTACT: ['PartyContact'],
  PROSPECT: ['Inquiry'],
  REPORTER: ['ProductSafetyReport'],
})

export const personRecordFits = (kind: DataSubjectKind, recordType: string): boolean => PERSON_RECORD_TYPES[kind].includes(recordType)

const HOUR = 60 * 60 * 1000
/** Art. 12(3): one month, counted as 30 days of 24 hours. */
export const DUE_HOURS = 720
/** Art. 12(3): extended by up to two further months: 90 days after it came in at most. */
export const LONGEST_HOURS = 2160

export const REQUEST_LIMITS = Object.freeze({ note: 2000, extensionReason: 1000, refusalReason: 2000, reason: 1000 })

/** When a request is due: 720 hours after it came in. */
export const dueAtOf = (receivedAt: Date): Date => new Date(receivedAt.getTime() + DUE_HOURS * HOUR)

/** The due time once extended by one or two further months. */
export const extendedDueOf = (dueAt: Date, months: 1 | 2): Date => new Date(dueAt.getTime() + months * DUE_HOURS * HOUR)

export interface RequestClockFacts {
  readonly receivedAt: Date
  readonly dueAt: Date
  readonly extendedDueAt: Date | null
  readonly status: string
}

/** The due time in force, whether it passed while the request is open, and the whole hours left (negative when late). */
export function clockOf(request: RequestClockFacts, now: Date): { readonly dueAt: Date; readonly extended: boolean; readonly overdue: boolean; readonly hoursLeft: number } {
  const dueAt = request.extendedDueAt ?? request.dueAt
  const open = isOpenRequest(request.status)
  const left = dueAt.getTime() - now.getTime()
  return { dueAt, extended: request.extendedDueAt !== null, overdue: open && left < 0, hoursLeft: Math.trunc(left / HOUR) }
}

const words = (value: string | null | undefined): string => (value ?? '').trim()
const oneOrMoreLines = (value: string, max: number): boolean => value.length >= 1 && value.length <= max

/** A new request: when it came in (not in the future: a few minutes' grace, as the database), a note of up to 2000 characters. */
export function requestProblems(input: { readonly receivedAt: Date; readonly note?: string | null | undefined }, now: Date): Issue[] {
  const problems: Issue[] = []
  if (input.receivedAt.getTime() > now.getTime() + 5 * 60_000) problems.push({ path: 'receivedAt', message: 'A request is recorded when it came in: now or before, not in the future.' })
  const note = words(input.note)
  if (input.note !== undefined && input.note !== null && note.length > REQUEST_LIMITS.note) problems.push({ path: 'note', message: `The note is at most ${REQUEST_LIMITS.note} characters.` })
  return problems
}

/** A reason a person gives (an extension, a refusal, an erasure): 3 characters or more, at most `max`. */
export function reasonProblem(path: string, value: string | null | undefined, max: number, what: string): Issue | null {
  const text = words(value)
  if (text.length < 3) return { path, message: `Say ${what} (3 characters or more).` }
  if (!oneOrMoreLines(text, max)) return { path, message: `${what[0]!.toUpperCase()}${what.slice(1)} is at most ${max} characters.` }
  return null
}

/** Why a request cannot move on now: a code each, with its words (REQUEST_HELD_WORDS). */
export const REQUEST_HELD = ['CLOSED', 'NOT_STARTED', 'IDENTITY_NOT_CHECKED', 'IDENTITY_CHECKED', 'EXTENDED', 'TOO_LATE_TO_EXTEND', 'NOT_ACCESS', 'NOT_ERASURE', 'NO_PACKAGE', 'NOT_ERASED', 'ERASED'] as const
export type RequestHeld = (typeof REQUEST_HELD)[number]

export const REQUEST_HELD_WORDS: Readonly<Record<RequestHeld, string>> = Object.freeze({
  CLOSED: 'The request is closed: it changes no more.',
  NOT_STARTED: "Check the person's identity first: the work on a request starts with it (GDPR art. 12(6)).",
  IDENTITY_NOT_CHECKED: "The person's identity is not checked yet (GDPR art. 12(6)): check it before the request is done.",
  IDENTITY_CHECKED: "The person's identity was checked already: the check is recorded once.",
  EXTENDED: 'The request was extended once already: the extension never changes (GDPR art. 12(3)).',
  TOO_LATE_TO_EXTEND: 'An extension is decided and told within the first month (GDPR art. 12(3)): that month has passed.',
  NOT_ACCESS: 'Only an access request has a data package.',
  NOT_ERASURE: 'Only an erasure request erases or anonymises the person.',
  NO_PACKAGE: "Collect the person's data package first: an access request is done once it is handed over.",
  NOT_ERASED: 'Erase or anonymise the person first (what the law keeps stays, with why): an erasure request is done once that is recorded.',
  ERASED: 'The person was erased on this request already: what was erased and kept is recorded.',
})

export interface RequestFacts {
  readonly kind: DataRequestKind
  readonly status: DataRequestStatus
  readonly dueAt: Date
  readonly extendedDueAt: Date | null
  readonly identityCheckedAt: Date | null
  readonly packageFileId: string | null
  /** How many erasure records the request has. */
  readonly erasures: number
}

export interface RequestAction {
  readonly allowed: boolean
  readonly held: RequestHeld | null
}

const may = (held: RequestHeld | null): RequestAction => ({ allowed: held === null, held })

/** What a person may do on the request now (each held with a code); permissions are the API's. */
export function requestActions(request: RequestFacts, now: Date) {
  const open = isOpenRequest(request.status)
  const closed = open ? null : ('CLOSED' as const)
  const started = request.status === 'IN_PROGRESS' ? null : ('NOT_STARTED' as const)
  return {
    checkIdentity: may(closed ?? (request.identityCheckedAt !== null ? 'IDENTITY_CHECKED' : null)),
    extend: may(closed ?? (request.extendedDueAt !== null ? 'EXTENDED' : now.getTime() >= request.dueAt.getTime() ? 'TOO_LATE_TO_EXTEND' : null)),
    collect: may(closed ?? (request.kind !== 'ACCESS' ? 'NOT_ACCESS' : started)),
    openPackage: may(request.kind !== 'ACCESS' ? 'NOT_ACCESS' : request.packageFileId === null ? 'NO_PACKAGE' : null),
    erase: may(closed ?? (request.kind !== 'ERASURE' ? 'NOT_ERASURE' : started ?? (request.erasures > 0 ? 'ERASED' : null))),
    close: may(
      closed ??
        started ??
        (request.identityCheckedAt === null ? 'IDENTITY_NOT_CHECKED' : request.kind === 'ACCESS' && request.packageFileId === null ? 'NO_PACKAGE' : request.kind === 'ERASURE' && request.erasures === 0 ? 'NOT_ERASED' : null),
    ),
    refuse: may(closed),
    withdraw: may(closed),
  }
}
export type RequestActions = ReturnType<typeof requestActions>

/** The person's name as shown once erased (the records keep the business data; the name is replaced). */
export const ERASED_PERSON_WORDS = Object.freeze({ it: 'Persona cancellata', en: 'Erased person' })
