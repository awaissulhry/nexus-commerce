import { REVIEW_LIMITS } from '@nexus/factory-domain/purchasing/questionnaire/rules'
import { QUESTION_SECTIONS, type QuestionSection } from '@nexus/factory-domain/purchasing/questionnaire/questions'
import type { QuestionData } from '@nexus/factory-domain/purchasing/questionnaire/schema'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { AnswerView, LinkSent, ReviewBody, SendBody, SupplierQuestionnaire } from './api'

/**
 * The supplier's Questionnaire tab (B-W2b-172; design purchasing.suppliers "Links › Supplier questionnaire —
 * Onboarding", "answers reviewed, versioned"): its model and the rules of its dialogs, pure. The tab shows the company's
 * questionnaire (the version a link asks), Send the questionnaire, the links sent and the answers newest first (each with
 * its version, what the supplier answered, its documents, the PDF kept and the review); Review: accepted, or questions
 * back on the supplier's thread.
 */

export type Dialog = { kind: 'send' } | { kind: 'answer'; id: string } | { kind: 'review'; id: string } | null

export interface SendForm {
  /** A contact's id, OTHER for an address typed, or '' (none chosen). */
  to: string
  email: string
  mode: 'mail' | 'link'
  language: 'it' | 'en'
  days: number
  note: string
}

export interface ReviewForm {
  decision: 'ACCEPTED' | 'QUESTIONS' | null
  questions: string
  note: string
}

export interface Notice {
  key: string
  tone: 'success' | 'warning' | 'danger' | 'info'
  params?: Record<string, string | number>
}

export interface QuestionnaireViewModel {
  data: SupplierQuestionnaire | null
  /** The tab's read failed (never drawn as empty). */
  problem: string | null
  dialog: Dialog
  send: { form: SendForm; busy: boolean; problem: string | null; field: string | null; result: LinkSent | null }
  review: { form: ReviewForm; busy: boolean; problem: string | null; field: string | null }
  publishing: boolean
  notice: Notice | null
  /** The file being opened (the answer's PDF, a document), or one that failed. */
  opening: { fileId: string; failed: boolean } | null
  timeZone?: string
}

export interface QuestionnaireActions {
  onRetry?: () => void
  onSend?: () => void
  onSendForm?: (edit: Partial<SendForm>) => void
  onSendConfirm?: () => void
  onCopy?: (url: string) => void
  onAnswer?: (id: string) => void
  onReview?: (id: string) => void
  onReviewForm?: (edit: Partial<ReviewForm>) => void
  onReviewConfirm?: () => void
  onClose?: () => void
  onPublishStarter?: () => void
  onOpenFile?: (fileId: string, name: string, contentType: string) => void
  onDismissNotice?: () => void
}

export const OTHER = 'OTHER'
export const DEFAULT_DAYS = 30
export const MAX_DAYS = 60

export const EMPTY_REVIEW: ReviewForm = { decision: null, questions: '', note: '' }

/** The send dialog's start: the first contact with an e-mail, by e-mail, in the supplier's language. */
export function sendFormOf(data: SupplierQuestionnaire): SendForm {
  const first = data.contacts[0]
  return { to: first?.id ?? OTHER, email: '', mode: first ? 'mail' : 'link', language: data.party.language === 'en' ? 'en' : 'it', days: DEFAULT_DAYS, note: '' }
}

/** Why Send the questionnaire is held now (a words key), or null. */
export function sendHeld(data: SupplierQuestionnaire): string | null {
  if (!data.may.send) return 'held.send'
  if (!data.current) return 'held.noVersion'
  return null
}

/** Why Review is held for an answer (a words key), or null. */
export function reviewHeld(data: SupplierQuestionnaire, answer: AnswerView): string | null {
  if (!data.may.review) return 'held.review'
  if (answer.state !== 'WAITING') return 'held.reviewed'
  return null
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The send dialog's own check: the field and the words key, or null. */
export function sendProblem(form: SendForm): { field: string; key: string } | null {
  if (form.mode === 'mail' && form.to === '') return { field: 'to', key: 'send.check.to' }
  if (form.mode === 'mail' && form.to === OTHER && !EMAIL.test(form.email.trim())) return { field: 'email', key: 'send.check.email' }
  if (form.mode === 'link' && form.email.trim() !== '' && !EMAIL.test(form.email.trim())) return { field: 'email', key: 'send.check.email' }
  if (!Number.isInteger(form.days) || form.days < 1 || form.days > MAX_DAYS) return { field: 'days', key: 'send.check.days' }
  if (form.note.length > REVIEW_LIMITS.mailNote) return { field: 'note', key: 'send.check.note' }
  return null
}

export function sendBodyOf(form: SendForm): SendBody {
  const contact = form.to !== '' && form.to !== OTHER ? { contactId: form.to } : {}
  const email = form.to === OTHER || form.mode === 'link' ? (form.email.trim() ? { email: form.email.trim() } : {}) : {}
  return { ...(form.mode === 'mail' ? contact : {}), ...email, send: form.mode === 'mail', language: form.language, expiresInDays: form.days, ...(form.note.trim() ? { note: form.note.trim() } : {}) }
}

/** The review dialog's own check: the field and the words key, or null. */
export function reviewProblem(form: ReviewForm): { field: string; key: string } | null {
  if (form.decision === null) return { field: 'decision', key: 'review.check.decision' }
  if (form.decision === 'QUESTIONS' && form.questions.trim().length < REVIEW_LIMITS.minQuestions) return { field: 'questions', key: 'review.check.questions' }
  if (form.questions.length > REVIEW_LIMITS.questions || form.note.length > REVIEW_LIMITS.note) return { field: form.note.length > REVIEW_LIMITS.note ? 'note' : 'questions', key: 'review.check.long' }
  return null
}

export function reviewBodyOf(form: ReviewForm, version: number): ReviewBody {
  return { decision: form.decision!, note: form.note.trim() || null, questions: form.decision === 'QUESTIONS' ? form.questions.trim() : null, version }
}

/** An API refusal in our words: the key and the field it belongs to. */
export function refusalOf(error: unknown): { key: string; field: string | null; reload: boolean } {
  if (!isApiError(error)) return { key: 'problem.network', field: null, reload: false }
  if (error.kind === 'conflict') {
    const suppressed = error.issues.some((issue) => issuePath(issue) === 'refusal/SUPPRESSED')
    return suppressed ? { key: 'problem.suppressed', field: 'email', reload: false } : { key: 'problem.changed', field: null, reload: true }
  }
  if (error.kind === 'forbidden') return { key: 'problem.forbidden', field: null, reload: false }
  if (error.kind === 'not_found') return { key: 'problem.gone', field: null, reload: true }
  if (error.kind === 'invalid') {
    const path = error.issues.map(issuePath)[0] ?? ''
    const field = /email/.test(path) ? 'email' : /contactId/.test(path) ? 'to' : /questions/.test(path) ? 'questions' : null
    return { key: field === 'email' ? 'send.check.email' : 'problem.invalid', field, reload: false }
  }
  return { key: 'problem.server', field: null, reload: false }
}

/** The version an answer answered (its questions), from the tab's read. */
export function versionOf(data: SupplierQuestionnaire, answer: AnswerView) {
  return data.versions.find((version) => version.id === answer.questionnaireId) ?? (data.current?.id === answer.questionnaireId ? data.current : null)
}

/** An answer's questions grouped by section, in the version's order. */
export function sectionsOf(questions: readonly QuestionData[]): Array<{ section: QuestionSection; questions: QuestionData[] }> {
  return QUESTION_SECTIONS.map((section) => ({ section, questions: questions.filter((question) => question.section === section) })).filter((group) => group.questions.length > 0)
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** One answer in words for the office's read (the questions' own words for a choice; yes / no / signed in ours). */
export function answerWords(question: QuestionData, entry: { value?: unknown } | undefined, documents: AnswerView['documents'], locale: 'it' | 'en', t: (key: string, params?: Record<string, string | number>) => string): string {
  const value = entry?.value
  if (value === undefined || value === null || value === '') return t('answer.none')
  switch (question.kind) {
    case 'YES_NO':
      return value === 'YES' ? t('answer.yes') : t('answer.no')
    case 'CHOICE':
      return question.options?.find((option) => option.code === value)?.text[locale] ?? String(value)
    case 'SIGN':
      return t('answer.signed')
    case 'CONTACT':
      return isRecord(value) ? [value.name, value.email, value.phone].filter((part) => typeof part === 'string' && part !== '').join(' · ') : t('answer.none')
    case 'FILE': {
      const document = isRecord(value) ? documents.find((entry) => entry.fileId === value.fileId) : undefined
      return document?.name || t('answer.document')
    }
    default:
      return typeof value === 'string' ? value : t('answer.none')
  }
}

/** The pill's tone for an answer's state. */
export const answerTone = (state: AnswerView['state']): 'warning' | 'success' | 'info' => (state === 'WAITING' ? 'warning' : state === 'ACCEPTED' ? 'success' : 'info')

/** The pill's tone for a link's state. */
export const linkTone = (state: SupplierQuestionnaire['links'][number]['state']): 'info' | 'success' | 'neutral' => (state === 'OPEN' ? 'info' : state === 'ANSWERED' ? 'success' : 'neutral')
