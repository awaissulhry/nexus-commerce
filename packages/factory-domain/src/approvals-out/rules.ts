import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Issue } from '../core/errors'
import { isMarkupShape, MARKUP_MAX_BYTES, MARKUP_MAX_SHAPES, MARKUP_NOTE_MAX, type MarkupShape } from '../files/markup/rules'
import { isAnswered, KIND_RULES, type ApprovalDecision, type ApprovalKind, type ApprovalLocale, type ApprovalStatus, type Words } from './kinds'

/**
 * The rules of an approval request (B-W2b-184), pure: what the office may ask, what a partner may answer and when, and the
 * words a person reads. The database's guard (…_links_depth_w2b_guards factory_approval_request_guard) holds the same shape
 * for every login; these say it first, in words, at the field.
 *
 *   ask       a kind for the record type; the question in words (1..4000); due 1 hour .. the kind's most days ahead;
 *             files of the record (0..20, at least one for a sample, a colour, a leather, an artwork, a proof)
 *   answer    OPEN and not past due (an expired request answers nothing); APPROVED, APPROVED_WITH_CHANGES where the kind
 *             allows it, REFUSED; words for a change or a refusal (≤ 4000); a typed full name (2..200); an optional photo
 *             markup on one of the request's files (1..200 arrows and circles, a note ≤ 2000, a page on a PDF)
 *   withdraw  OPEN only; a reason ≤ 500
 *   expire    OPEN and past due (the expiry job; the database refuses it earlier)
 */

export const APPROVAL_LIMITS = Object.freeze({ question: 4000, answer: 4000, typedName: 200, typedNameMin: 2, files: 20, reason: 500, minDueMs: 60 * 60 * 1000 })
const DAY_MS = 86_400_000

const clean = (value: string | null | undefined): string => (value ?? '').trim()

export interface AskDraft {
  readonly kind: ApprovalKind
  readonly recordType: string
  readonly question: string
  readonly dueAt: Date
  readonly fileCount: number
}

/** The due time asked, or the kind's default from now. */
export const dueAtFor = (kind: ApprovalKind, asked: Date | null | undefined, now: Date): Date => asked ?? new Date(now.getTime() + KIND_RULES[kind].dueDays.default * DAY_MS)

export function askProblems(draft: AskDraft, now: Date): Issue[] {
  const rule = KIND_RULES[draft.kind]
  const issues: Issue[] = []
  if (!rule.recordTypes.includes(draft.recordType)) issues.push({ path: 'body/recordType', message: `A ${rule.name.en.toLowerCase()} is asked on ${rule.recordTypes.join(', ')}, not on a ${draft.recordType}.` })
  const question = clean(draft.question)
  if (question === '') issues.push({ path: 'body/question', message: 'Say what you ask them to approve, in words.' })
  else if (question.length > APPROVAL_LIMITS.question) issues.push({ path: 'body/question', message: `At most ${APPROVAL_LIMITS.question} characters.` })
  const ahead = draft.dueAt.getTime() - now.getTime()
  if (!Number.isFinite(ahead) || ahead < APPROVAL_LIMITS.minDueMs) issues.push({ path: 'body/dueAt', message: 'The answer is due at least an hour from now.' })
  else if (ahead > rule.dueDays.max * DAY_MS) issues.push({ path: 'body/dueAt', message: `The answer is due within ${rule.dueDays.max} days.` })
  if (draft.fileCount > APPROVAL_LIMITS.files) issues.push({ path: 'body/fileIds', message: `At most ${APPROVAL_LIMITS.files} files.` })
  if (rule.needsFiles && draft.fileCount === 0) issues.push({ path: 'body/fileIds', message: `A ${rule.name.en.toLowerCase()} is approved on its photos or file: add at least one.` })
  return issues
}

export interface MarkupDraft {
  readonly fileId: string
  /** The page of a PDF; null on a picture. */
  readonly page: number | null
  readonly shapes: readonly unknown[]
  readonly note: string | null
}

export interface AnswerDraft {
  readonly kind: ApprovalKind
  readonly decision: ApprovalDecision
  readonly answer: string | null | undefined
  readonly typedName: string | null | undefined
  readonly markup?: MarkupDraft | null | undefined
}

/**
 * The partner's markup on a photo of the request (design links.approve "Mark the photo": arrows and circles, a note, "Add to
 * my comment"): kept as an overlay on the request's own file (FileMarkup, no new version), a page on a PDF.
 */
export function markupDraftProblems(markup: MarkupDraft, target: 'picture' | 'pdf' | null): Issue[] {
  const issues: Issue[] = []
  if (target === null) issues.push({ path: 'body/markup/fileId', message: 'Only a picture or a PDF of this request can be marked.' })
  if (markup.shapes.length === 0) issues.push({ path: 'body/markup/shapes', message: 'Draw at least one arrow or circle.' })
  if (markup.shapes.length > MARKUP_MAX_SHAPES) issues.push({ path: 'body/markup/shapes', message: `At most ${MARKUP_MAX_SHAPES} marks.` })
  const bad = markup.shapes.findIndex((shape) => !isMarkupShape(shape))
  if (bad >= 0) issues.push({ path: `body/markup/shapes/${bad}`, message: 'A mark is an arrow (from, to) or a circle (center, radius), in 0..1 of the picture.' })
  if (JSON.stringify(markup.shapes).length > MARKUP_MAX_BYTES) issues.push({ path: 'body/markup/shapes', message: 'The marks are too large to keep.' })
  if (clean(markup.note).length > MARKUP_NOTE_MAX) issues.push({ path: 'body/markup/note', message: `A note of at most ${MARKUP_NOTE_MAX} characters.` })
  if (target === 'pdf' && (markup.page === null || !Number.isInteger(markup.page) || markup.page < 1)) issues.push({ path: 'body/markup/page', message: 'A PDF is marked on one page: its number.' })
  if (target === 'picture' && markup.page !== null) issues.push({ path: 'body/markup/page', message: 'A picture has no pages.' })
  return issues
}

export const markupShapesOf = (markup: MarkupDraft): MarkupShape[] => markup.shapes as MarkupShape[]

export function answerProblems(draft: AnswerDraft): Issue[] {
  const rule = KIND_RULES[draft.kind]
  const issues: Issue[] = []
  if (draft.decision === 'APPROVED_WITH_CHANGES' && !rule.withChanges) issues.push({ path: 'body/decision', message: `A ${rule.name.en.toLowerCase()} is approved as it stands or refused.` })
  const words = clean(draft.answer)
  if (draft.decision !== 'APPROVED' && words === '') issues.push({ path: 'body/answer', message: draft.decision === 'REFUSED' ? 'Say why you refuse.' : 'Say what you want changed.' })
  if (words.length > APPROVAL_LIMITS.answer) issues.push({ path: 'body/answer', message: `At most ${APPROVAL_LIMITS.answer} characters.` })
  const name = clean(draft.typedName)
  if (name.length < APPROVAL_LIMITS.typedNameMin) issues.push({ path: 'body/typedName', message: 'Type your full name to sign the answer.' })
  else if (name.length > APPROVAL_LIMITS.typedName) issues.push({ path: 'body/typedName', message: `At most ${APPROVAL_LIMITS.typedName} characters.` })
  return issues
}

export const answerWords = (draft: { readonly answer?: string | null | undefined }): string | null => (clean(draft.answer) === '' ? null : clean(draft.answer))
export const typedNameOf = (draft: { readonly typedName?: string | null | undefined }): string => clean(draft.typedName)

export interface RequestFacts {
  readonly status: ApprovalStatus
  readonly dueAt: Date
  readonly answeredAt: Date | null
  readonly withdrawnAt: Date | null
}

/** Why a request takes no answer now (null: it does), in the partner's words. */
export function answerHeld(request: RequestFacts, now: Date, locale: ApprovalLocale = 'en'): string | null {
  const it = locale === 'it'
  if (isAnswered(request.status)) return it ? 'Questa richiesta ha già una risposta.' : 'This request is answered already.'
  if (request.status === 'WITHDRAWN') return it ? 'Questa richiesta è stata ritirata: non serve più una risposta.' : 'This request was withdrawn: no answer is needed any more.'
  if (request.status === 'EXPIRED' || request.dueAt.getTime() <= now.getTime()) {
    return it ? 'Il tempo per rispondere è scaduto: chiedete una nuova richiesta al mittente.' : 'The time to answer has passed: ask the sender for a new request.'
  }
  return null
}

/** Why the office may not withdraw it (null: it may). */
export function withdrawProblem(status: ApprovalStatus): string | null {
  if (status === 'OPEN') return null
  return status === 'WITHDRAWN' ? 'This request was withdrawn already.' : `This request is ${status.toLowerCase().replaceAll('_', ' ')}; only an open request is withdrawn.`
}

export const reasonProblems = (reason: string | null | undefined): Issue[] => (clean(reason).length > APPROVAL_LIMITS.reason ? [{ path: 'body/reason', message: `At most ${APPROVAL_LIMITS.reason} characters.` }] : [])

/** An OPEN request past its due time: the expiry job marks it EXPIRED. */
export const expiryDue = (request: Pick<RequestFacts, 'status' | 'dueAt'>, now: Date): boolean => request.status === 'OPEN' && request.dueAt.getTime() <= now.getTime()

const STATE_WORDS: Readonly<Record<ApprovalStatus, Words>> = Object.freeze({
  OPEN: { it: 'In attesa di risposta', en: 'Waiting for the answer' },
  APPROVED: { it: 'Approvato', en: 'Approved' },
  APPROVED_WITH_CHANGES: { it: 'Approvato con modifiche', en: 'Approved with changes' },
  REFUSED: { it: 'Rifiutato', en: 'Refused' },
  WITHDRAWN: { it: 'Ritirato', en: 'Withdrawn' },
  EXPIRED: { it: 'Scaduto senza risposta', en: 'Expired without an answer' },
})
export const stateWords = (status: ApprovalStatus, locale: ApprovalLocale): string => STATE_WORDS[status][locale]

/** "10:42" in Europe/Rome. */
const timeOf = (at: Date): string => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false }).format(at)
/** "4 Nov" / "4 nov". */
export const shortDayOf = (at: Date, locale: ApprovalLocale): string =>
  new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { timeZone: 'Europe/Rome', day: 'numeric', month: 'short' }).format(at).replace('.', '')

/** What happens next, per kind and answer (the design's EndState: "We start cutting on 4 Nov."). */
function nextWords(kind: ApprovalKind, approved: boolean, locale: ApprovalLocale): string {
  const it = locale === 'it'
  if (!approved) return it ? 'Vi ricontattiamo per decidere insieme come procedere.' : 'We will be in touch to agree on what comes next.'
  switch (kind) {
    case 'REVISED_ORDER':
      return it ? "L'ordine modificato è confermato: procediamo così." : 'The revised order is confirmed: we go ahead with it.'
    case 'PROOF':
      return it ? 'Possiamo passare al taglio.' : 'We can go ahead with cutting.'
    case 'CONCESSION':
      return it ? 'Spediamo la merce come concordato nella concessione.' : 'We ship the goods as the concession says.'
    case 'SIGNATURE':
      return it ? 'La vostra firma è registrata sul documento.' : 'Your signature is recorded on the document.'
    default:
      return it ? 'Procediamo con quanto approvato.' : 'We go ahead with what you approved.'
  }
}

/** The answer as the partner reads it afterwards: "Approved — signed by Anna Rossi at 10:42 on 3 Nov. We can go ahead with cutting." */
export function decidedWords(kind: ApprovalKind, status: ApprovalStatus, typedName: string | null, answeredAt: Date | null, locale: ApprovalLocale): string {
  if (!isAnswered(status) || answeredAt === null) return stateWords(status, locale)
  const approved = status !== 'REFUSED'
  const signed = locale === 'it' ? `firmato da ${typedName ?? ''} alle ${timeOf(answeredAt)} del ${shortDayOf(answeredAt, locale)}` : `signed by ${typedName ?? ''} at ${timeOf(answeredAt)} on ${shortDayOf(answeredAt, locale)}`
  return `${stateWords(status, locale)} — ${signed}. ${nextWords(kind, approved, locale)}`
}

// ---- PLT-089: an office approval opened from its e-mail --------------------------------------------------------------

/**
 * The key of an office approval mailed to a person (PLT-089: "office approvals mail a link that opens the approval in the link
 * frame after a quick office sign-in"): `am1.<tenant>.<person>.<notification>.<HMAC>`. It names ONE notification of ONE
 * person and grants nothing: the page asks for the office sign-in (two-factor for a role that asks it) and only that person,
 * signed in, opens it; the decision then runs on the office's own routes behind the office's grains (margin never travels in
 * the mail). No expiry: the notification itself says whether the request still waits.
 */
const KEY = /^am1\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/
const macOf = (key: Buffer, tenantId: string, userId: string, notificationId: string): string => createHmac('sha256', key).update(`am1|${tenantId}|${userId}|${notificationId}`).digest('base64url')

export function approvalMailKey(key: Buffer, tenantId: string, userId: string, notificationId: string): string {
  return `am1.${tenantId}.${userId}.${notificationId}.${macOf(key, tenantId, userId, notificationId)}`
}

export function readApprovalMailKey(key: Buffer, value: unknown): { tenantId: string; userId: string; notificationId: string } | null {
  if (typeof value !== 'string') return null
  const match = KEY.exec(value)
  if (!match) return null
  const [, tenantId, userId, notificationId, mac] = match as unknown as [string, string, string, string, string]
  const expected = Buffer.from(macOf(key, tenantId, userId, notificationId))
  const given = Buffer.from(mac)
  return expected.length === given.length && timingSafeEqual(expected, given) ? { tenantId, userId, notificationId } : null
}

/** The web page that opens it (the link frame reads the fragment, asks for the office sign-in, then opens the approval). */
export const approvalMailUrl = (webOrigin: string, key: string): string => `${webOrigin.replace(/\/+$/, '')}/l/approve#key=${encodeURIComponent(key)}`

/** The office notification keys that ask for a decision (an approval waiting, a nudge), not a decision taken. */
export const asksForDecision = (messageKey: string): boolean => messageKey.startsWith('notifications.approval.') && !messageKey.endsWith('_decided')
