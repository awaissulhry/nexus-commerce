import type { Issue } from '../../core/errors'
import { businessDate, type BusinessDate } from '../../core/time'

/**
 * Recall, withdrawal and authority (B-W2b-260; PRD-387, PRD-388, PRD-390), pure. What happens after a garment left, on the
 * PPE register entry of W1 (B-W1-43) and the tables of B-W2b-222 (recall.prisma):
 *
 *   Authority notice   the non-conformity decision (NOT_CONFORMING, or RISK when the entry's risk is YES) told to the
 *                      market surveillance authority of one market (Reg. (EU) 2016/425 art. 8(8)): drafted from the entry
 *                      per language, marked as sent by a person (the date, the authority's reference, the copy sent).
 *                      Nothing goes to an authority by itself.
 *   Recall/withdrawal  its scope from the trace (the whole style, or batches, serials, work orders, shipments), started by
 *                      a person; holds on what is still here (quality/holds); the public notice per language (Reg. (EU)
 *                      2023/988 art. 35-36), first on the public DoC page; progress per customer (sent = returned +
 *                      repaired + destroyed + still out); closed with how it ended.
 *   Distributors told  one notice per recipient (the customers that got the garments): drafted in their language, sent by a
 *                      person (e-mail through the outbox, or a call or a portal message recorded), answered or failed.
 *                      When every recipient was told, W1's entry has its "distributors informed" date (art. 8(4)).
 *   Authority request  what an authority asks (Reg. (EU) 2019/1020 art. 4(3); PPE art. 8(9)), by when, and the evidence
 *                      pack sent (B-W2b-251) when it is answered.
 *
 * W1 keeps the dates typed by hand on the entry; these rules fill them only when they are empty. No price, no cost, no
 * person's figure.
 */

export const AUTHORITY_CHANNELS = ['SAFETY_BUSINESS_GATEWAY', 'AUTHORITY_SITE', 'PEC', 'EMAIL', 'POST', 'INSPECTION', 'OTHER'] as const
export type AuthorityChannel = (typeof AUTHORITY_CHANNELS)[number]

export const NOTICE_DECISIONS = ['NOT_CONFORMING', 'RISK'] as const
export type NoticeDecision = (typeof NOTICE_DECISIONS)[number]

export const NOTICE_STATUSES = ['DRAFT', 'SENT', 'CANCELLED'] as const
export type NoticeStatus = (typeof NOTICE_STATUSES)[number]

export const RECALL_KINDS = ['RECALL', 'WITHDRAWAL'] as const
export type RecallKind = (typeof RECALL_KINDS)[number]

export const RECALL_STATUSES = ['DRAFT', 'ACTIVE', 'CLOSED', 'CANCELLED'] as const
export type RecallStatus = (typeof RECALL_STATUSES)[number]

/** The ways the database knows (recall.prisma DistributorNoticeChannel). */
export const DISTRIBUTOR_CHANNELS = ['EMAIL', 'PORTAL', 'LINK', 'PHONE'] as const
export type DistributorChannel = (typeof DISTRIBUTOR_CHANNELS)[number]
/** The ways a notice is drafted here: by e-mail (the outbox sends it), a portal message or a call recorded by the person. A link is later. */
export const DRAFTED_CHANNELS = ['EMAIL', 'PORTAL', 'PHONE'] as const satisfies readonly DistributorChannel[]
export type DraftedChannel = (typeof DRAFTED_CHANNELS)[number]

export const DISTRIBUTOR_STATUSES = ['DRAFT', 'SENT', 'ANSWERED', 'FAILED', 'CANCELLED'] as const
export type DistributorStatus = (typeof DISTRIBUTOR_STATUSES)[number]
/** A recipient counts as told once a notice to them left (and still when they answered). */
export const TOLD_STATUSES: readonly DistributorStatus[] = Object.freeze(['SENT', 'ANSWERED'])

export const REQUEST_STATUSES = ['OPEN', 'ANSWERED', 'CANCELLED'] as const
export type RequestStatus = (typeof REQUEST_STATUSES)[number]

/** Where an authority request stands against its due day (the Countdown). */
export const REQUEST_DUE_STATES = ['OVERDUE', 'DUE_TODAY', 'DUE_SOON', 'OPEN', 'ANSWERED', 'CANCELLED'] as const
export type RequestDueState = (typeof REQUEST_DUE_STATES)[number]
/** "Due soon": this many days or fewer left. */
export const DUE_SOON_DAYS = 7

/** The law each part rests on, for the screens' LawRef chips. */
export const RECALL_LAW = Object.freeze({
  authorityNotice: 'Reg. (EU) 2016/425 art. 8(8)',
  correctiveAction: 'Reg. (EU) 2016/425 art. 8(8)',
  distributors: 'Reg. (EU) 2016/425 art. 8(4)',
  publicNotice: 'Reg. (EU) 2023/988 art. 35-36',
  authorityRequest: 'Reg. (EU) 2016/425 art. 8(9); Reg. (EU) 2019/1020 art. 4(3)',
})

/** The limits the database holds (…_recall_claims_w2b_guards), said here first in words. */
export const RECALL_LIMITS = Object.freeze({
  authorityName: 300,
  noticeWords: 20000,
  note: 2000,
  reference: 200,
  reason: 500,
  closeNote: 2000,
  code: 100,
  batchNumbers: 1000,
  serials: 10000,
  workOrderIds: 1000,
  shipmentIds: 1000,
  title: 200,
  problem: 2000,
  action: 2000,
  contact: 1000,
  contactName: 200,
  contactLine: 200,
  subject: 300,
  message: 20000,
  answer: 4000,
  answeredByName: 200,
  requestText: 4000,
  answerSummary: 4000,
  languages: 20,
  recipients: 200,
})

const blank = (value: string | null | undefined): boolean => value === null || value === undefined || value.trim() === ''
const hasControl = (value: string, lines: boolean): boolean => (lines ? /[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) : /[\x00-\x1f\x7f]/.test(value))

/** BCP 47 as the database reads a words key: "it", "en", "pt-BR". */
export const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/
/** ISO 639 as a distributor notice names its language. */
export const LANGUAGE_CODE = /^[a-z]{2,3}$/
/** A market's code ("IT", "DE", "US-CA"), as Rules & markets keeps it. */
export const MARKET_CODE = /^[A-Z]{2}(-[A-Za-z0-9]{1,8})*$/
/** The database's e-mail and phone shapes (DistributorNotice contact). */
export const EMAIL_SHAPE = /^[^@\s\p{Cc}]+@[^@\s\p{Cc}]+\.[^@\s\p{Cc}]+$/u
export const PHONE_SHAPE = /^\+?[0-9][0-9 ()./-]{4,39}$/

/** Trimmed, without empty strings and repeats, in the order given. */
export function cleanCodes(values: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values ?? []) {
    const trimmed = value.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

// ---- words per language --------------------------------------------------------------------------------------------------

/** Text per language (`{ "it": "…", "en": "…" }`): each key a language tag, each text 1 to `longest` characters. */
export function wordsProblems(words: Readonly<Record<string, string>> | null | undefined, longest: number, path: string, lines = true): Issue[] {
  const entries = Object.entries(words ?? {})
  if (entries.length === 0) return [{ path, message: 'Write the words in at least one language.' }]
  if (entries.length > RECALL_LIMITS.languages) return [{ path, message: `At most ${RECALL_LIMITS.languages} languages.` }]
  const problems: Issue[] = []
  for (const [language, text] of entries) {
    if (!LANGUAGE_TAG.test(language)) problems.push({ path: `${path}/${language}`, message: 'Name the language by its code ("it", "en").' })
    else if (blank(text) || text.length > longest || hasControl(text, lines)) problems.push({ path: `${path}/${language}`, message: `1 to ${longest} characters.` })
  }
  return problems
}

/** A recall's public notice in one language (GPSR art. 36: what is wrong, what to do, whom to contact). */
export interface PublicNoticeWords {
  readonly title: string
  readonly problem: string
  readonly action: string
  readonly contact: string
}
export type PublicNotice = Readonly<Record<string, PublicNoticeWords>>

export function publicNoticeProblems(notice: PublicNotice | null | undefined, path: string): Issue[] {
  const entries = Object.entries(notice ?? {})
  if (entries.length === 0) return [{ path, message: 'Write the notice in at least one language.' }]
  if (entries.length > RECALL_LIMITS.languages) return [{ path, message: `At most ${RECALL_LIMITS.languages} languages.` }]
  const problems: Issue[] = []
  for (const [language, words] of entries) {
    if (!LANGUAGE_TAG.test(language)) {
      problems.push({ path: `${path}/${language}`, message: 'Name the language by its code ("it", "en").' })
      continue
    }
    const fields: readonly (readonly [keyof PublicNoticeWords, number, boolean])[] = [
      ['title', RECALL_LIMITS.title, false],
      ['problem', RECALL_LIMITS.problem, true],
      ['action', RECALL_LIMITS.action, true],
      ['contact', RECALL_LIMITS.contact, true],
    ]
    for (const [field, longest, lines] of fields) {
      const text = words[field]
      if (typeof text !== 'string' || blank(text) || text.length > longest || hasControl(text, lines)) {
        problems.push({ path: `${path}/${language}/${field}`, message: field === 'title' ? `One line of 1 to ${longest} characters.` : `1 to ${longest} characters.` })
      }
    }
  }
  return problems
}

/** A published notice may gain a language, never change one it has (the database's `NEW @> OLD`). */
export function noticeOnlyGrows(before: PublicNotice, after: PublicNotice): boolean {
  return Object.entries(before).every(([language, words]) => {
    const now = after[language]
    return now !== undefined && now.title === words.title && now.problem === words.problem && now.action === words.action && now.contact === words.contact
  })
}

// ---- the scope ---------------------------------------------------------------------------------------------------------------

/** What a recall or a withdrawal calls back. */
export interface RecallScope {
  /** The whole style (the PPE guidelines: when batches cannot be told apart, the whole type). */
  readonly wholeStyle: boolean
  readonly batchNumbers: readonly string[]
  readonly serials: readonly string[]
  readonly workOrderIds: readonly string[]
  readonly shipmentIds: readonly string[]
}

export const scopeNamesSomething = (scope: RecallScope): boolean =>
  scope.wholeStyle || scope.batchNumbers.length + scope.serials.length + scope.workOrderIds.length + scope.shipmentIds.length > 0

/** The scope as written: something named, each list within its limit, each code one line of 1 to 100 characters. */
export function scopeProblems(scope: RecallScope, path = 'body'): Issue[] {
  const problems: Issue[] = []
  if (!scopeNamesSomething(scope)) problems.push({ path: `${path}/batchNumbers`, message: 'Call back the whole style, or name what is called back: batches, serials, work orders or shipments.' })
  for (const [field, limit] of [
    ['batchNumbers', RECALL_LIMITS.batchNumbers],
    ['serials', RECALL_LIMITS.serials],
    ['workOrderIds', RECALL_LIMITS.workOrderIds],
    ['shipmentIds', RECALL_LIMITS.shipmentIds],
  ] as const) {
    if (scope[field].length > limit) problems.push({ path: `${path}/${field}`, message: `At most ${limit}.` })
  }
  for (const field of ['batchNumbers', 'serials'] as const) {
    scope[field].forEach((code, index) => {
      if (code.length > RECALL_LIMITS.code || hasControl(code, false)) problems.push({ path: `${path}/${field}/${index}`, message: `One line of 1 to ${RECALL_LIMITS.code} characters.` })
    })
  }
  return problems
}

/** Once started, a scope only widens: the whole style stays, and every list keeps what it had (the database's rule). */
export function scopeWidensOnly(before: RecallScope, after: RecallScope): boolean {
  if (before.wholeStyle && !after.wholeStyle) return false
  const keeps = (old: readonly string[], now: readonly string[]) => old.every((value) => now.includes(value))
  return keeps(before.batchNumbers, after.batchNumbers) && keeps(before.serials, after.serials) && keeps(before.workOrderIds, after.workOrderIds) && keeps(before.shipmentIds, after.shipmentIds)
}

/** The union of two scopes (a widening asked as "add these"). */
export function widenScope(before: RecallScope, added: Partial<RecallScope>): RecallScope {
  return {
    wholeStyle: before.wholeStyle || added.wholeStyle === true,
    batchNumbers: cleanCodes([...before.batchNumbers, ...(added.batchNumbers ?? [])]),
    serials: cleanCodes([...before.serials, ...(added.serials ?? [])]),
    workOrderIds: [...new Set([...before.workOrderIds, ...(added.workOrderIds ?? [])])],
    shipmentIds: [...new Set([...before.shipmentIds, ...(added.shipmentIds ?? [])])],
  }
}

// ---- progress per customer ----------------------------------------------------------------------------------------------------

export interface ProgressCounts {
  readonly unitsSent: number
  readonly unitsReturned: number
  readonly unitsRepaired: number
  readonly unitsDestroyed: number
}

/** What is still out: sent less returned, repaired and destroyed; null when those are more than was sent. */
export function stillOutOf(counts: ProgressCounts): number | null {
  const left = counts.unitsSent - counts.unitsReturned - counts.unitsRepaired - counts.unitsDestroyed
  return left < 0 ? null : left
}

export function progressProblems(counts: ProgressCounts, path = 'body'): Issue[] {
  const problems: Issue[] = []
  for (const field of ['unitsSent', 'unitsReturned', 'unitsRepaired', 'unitsDestroyed'] as const) {
    if (!Number.isSafeInteger(counts[field]) || counts[field] < 0) problems.push({ path: `${path}/${field}`, message: 'A whole number, 0 or more.' })
  }
  if (problems.length === 0 && stillOutOf(counts) === null) {
    problems.push({ path: `${path}/unitsReturned`, message: `Returned, repaired and destroyed are more than the ${counts.unitsSent} sent.` })
  }
  return problems
}

export interface ProgressSummary {
  readonly customers: number
  readonly unitsSent: number
  readonly unitsReturned: number
  readonly unitsRepaired: number
  readonly unitsDestroyed: number
  readonly unitsStillOut: number
  /** Back, repaired or destroyed out of sent, in whole per cent (0 when nothing was sent). */
  readonly percentDone: number
}

/** The recall's progress over its rows (the ProgressBar). */
export function progressSummary(rows: readonly (ProgressCounts & { readonly partyId: string; readonly unitsStillOut: number })[]): ProgressSummary {
  const sum = (field: keyof ProgressCounts | 'unitsStillOut') => rows.reduce((acc, row) => acc + row[field], 0)
  const unitsSent = sum('unitsSent')
  const done = sum('unitsReturned') + sum('unitsRepaired') + sum('unitsDestroyed')
  return {
    customers: new Set(rows.map((row) => row.partyId)).size,
    unitsSent,
    unitsReturned: sum('unitsReturned'),
    unitsRepaired: sum('unitsRepaired'),
    unitsDestroyed: sum('unitsDestroyed'),
    unitsStillOut: sum('unitsStillOut'),
    percentDone: unitsSent === 0 ? 0 : Math.floor((done * 100) / unitsSent),
  }
}

/** A customer and shipment the trace found, with the garments of the scope it carried (a progress row's start). */
export interface TracedShipment {
  readonly shipmentId: string
  readonly partyId: string
  readonly garments: number
  readonly left: boolean
}

/** The progress rows a start writes: one per shipment that left with garments of the scope, everything still out. */
export function startingProgress(shipments: readonly TracedShipment[], existing: readonly { readonly partyId: string; readonly shipmentId: string | null }[]): { partyId: string; shipmentId: string; unitsSent: number }[] {
  const have = new Set(existing.map((row) => `${row.partyId}:${row.shipmentId ?? ''}`))
  const wholeCustomers = new Set(existing.filter((row) => row.shipmentId === null).map((row) => row.partyId))
  return shipments
    .filter((shipment) => shipment.left && shipment.garments > 0 && !have.has(`${shipment.partyId}:${shipment.shipmentId}`) && !wholeCustomers.has(shipment.partyId))
    .map((shipment) => ({ partyId: shipment.partyId, shipmentId: shipment.shipmentId, unitsSent: shipment.garments }))
}

// ---- distributors -----------------------------------------------------------------------------------------------------------

export interface RecipientNotice {
  readonly partyId: string
  readonly status: DistributorStatus
}

/** Who was told among the recipients ("3 of 5"): a recipient is told once a notice to them left. */
export function toldCount(recipientIds: readonly string[], notices: readonly RecipientNotice[]): { told: number; of: number; allTold: boolean } {
  const told = new Set(notices.filter((notice) => TOLD_STATUSES.includes(notice.status)).map((notice) => notice.partyId))
  const count = recipientIds.filter((id) => told.has(id)).length
  return { told: count, of: recipientIds.length, allTold: recipientIds.length > 0 && count === recipientIds.length }
}

export interface DistributorDraft {
  readonly channel: DraftedChannel
  readonly contact: string | null
  readonly contactName: string | null
  readonly language: string
  readonly subject: string | null
  readonly message: string
}

/** A notice to a distributor as drafted: the way's contact (an address for EMAIL, a number for PHONE), the language, the words. */
export function distributorDraftProblems(draft: DistributorDraft, path = 'body'): Issue[] {
  const problems: Issue[] = []
  if (draft.channel === 'EMAIL' && (draft.contact === null || draft.contact.length > 320 || !EMAIL_SHAPE.test(draft.contact))) {
    problems.push({ path: `${path}/contact`, message: 'An e-mail notice goes to an e-mail address.' })
  }
  if (draft.channel === 'PHONE' && (draft.contact === null || !PHONE_SHAPE.test(draft.contact))) problems.push({ path: `${path}/contact`, message: 'A call goes to a phone number.' })
  if (draft.channel === 'PORTAL' && draft.contact !== null && (draft.contact.length > RECALL_LIMITS.contactLine || hasControl(draft.contact, false))) {
    problems.push({ path: `${path}/contact`, message: `One line of up to ${RECALL_LIMITS.contactLine} characters.` })
  }
  if (draft.contactName !== null && (blank(draft.contactName) || draft.contactName.length > RECALL_LIMITS.contactName || hasControl(draft.contactName, false))) {
    problems.push({ path: `${path}/contactName`, message: `One line of up to ${RECALL_LIMITS.contactName} characters.` })
  }
  if (!LANGUAGE_CODE.test(draft.language)) problems.push({ path: `${path}/language`, message: 'Name the language by its code ("it", "en").' })
  if (draft.channel === 'EMAIL' && blank(draft.subject)) problems.push({ path: `${path}/subject`, message: 'An e-mail has a subject.' })
  if (draft.subject !== null && (blank(draft.subject) || draft.subject.length > RECALL_LIMITS.subject || hasControl(draft.subject, false))) {
    problems.push({ path: `${path}/subject`, message: `One line of 1 to ${RECALL_LIMITS.subject} characters.` })
  }
  if (blank(draft.message) || draft.message.length > RECALL_LIMITS.message) problems.push({ path: `${path}/message`, message: `1 to ${RECALL_LIMITS.message} characters.` })
  return problems
}

// ---- authority requests ----------------------------------------------------------------------------------------------------

const dayNumber = (day: BusinessDate): number => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 86_400_000

/** Calendar days from `from` to `to` (negative: `to` is earlier). */
export const daysBetween = (from: BusinessDate, to: BusinessDate): number => dayNumber(to) - dayNumber(from)

/** Where a request stands against its due day, and how many days are left (negative: overdue); null once it is answered or cancelled. */
export function requestDue(request: { readonly status: RequestStatus; readonly dueOn: BusinessDate }, today: BusinessDate): { state: RequestDueState; daysLeft: number | null } {
  if (request.status === 'ANSWERED') return { state: 'ANSWERED', daysLeft: null }
  if (request.status === 'CANCELLED') return { state: 'CANCELLED', daysLeft: null }
  const daysLeft = daysBetween(today, request.dueOn)
  return { state: daysLeft < 0 ? 'OVERDUE' : daysLeft === 0 ? 'DUE_TODAY' : daysLeft <= DUE_SOON_DAYS ? 'DUE_SOON' : 'OPEN', daysLeft }
}

/** The facts of a request as logged or corrected: the due day on or after the day it came, the time it came not in the future. */
export function requestProblems(request: { readonly receivedAt: Date; readonly dueOn: BusinessDate; readonly batchNumbers: readonly string[]; readonly styleId: string | null }, now: Date): Issue[] {
  const problems: Issue[] = []
  if (request.receivedAt.getTime() > now.getTime() + 5 * 60_000) problems.push({ path: 'body/receivedAt', message: 'The request came at a time in the future.' })
  if (request.dueOn < businessDate(request.receivedAt)) problems.push({ path: 'body/dueOn', message: `The due day is on or after the day the request came (${businessDate(request.receivedAt)}).` })
  if (request.batchNumbers.length > 0 && request.styleId === null) problems.push({ path: 'body/batchNumbers', message: 'Name the style the batches are of.' })
  request.batchNumbers.forEach((code, index) => {
    if (code.length > RECALL_LIMITS.code) problems.push({ path: `body/batchNumbers/${index}`, message: `One line of 1 to ${RECALL_LIMITS.code} characters.` })
  })
  return problems
}

/** A date a duty was met on (sent, answered, told): not in the future (five minutes of clock allowed), not before a day. */
export function metOnProblems(at: Date, notBefore: Date, now: Date, path: string): Issue[] {
  if (at.getTime() > now.getTime() + 5 * 60_000) return [{ path, message: 'This time is in the future.' }]
  if (businessDate(at) < businessDate(notBefore)) return [{ path, message: `This is before ${businessDate(notBefore)}.` }]
  return []
}

// ---- the authority notice ------------------------------------------------------------------------------------------------------

/** What closing the step of an authority notice asks: RISK only when the entry's risk is decided YES. */
export function noticeSendProblems(notice: { readonly status: NoticeStatus; readonly decision: NoticeDecision }, entry: { readonly status: string; readonly risk: string }): Issue[] {
  if (notice.status !== 'DRAFT') return [{ path: 'problem/NOT_DRAFT', message: notice.status === 'SENT' ? 'This notice was sent already.' : 'This notice was cancelled; draft a new one.' }]
  if (entry.status !== 'OPEN') return [{ path: 'problem/ENTRY_CLOSED', message: 'The register entry is closed: a notice is sent while it is open.' }]
  if (notice.decision === 'RISK' && entry.risk !== 'YES') return [{ path: 'problem/RISK_NOT_DECIDED', message: 'A notice of a risk is sent once the register entry says the PPE may present a risk (risk YES).' }]
  return []
}

/** The decision a notice of this entry takes by default: RISK when the entry's risk is YES, else NOT_CONFORMING. */
export const defaultDecision = (risk: string): NoticeDecision => (risk === 'YES' ? 'RISK' : 'NOT_CONFORMING')
