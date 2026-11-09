import { answerProblems, type AnswerCheck, type CheckCode } from '@nexus/factory-domain/purchasing/questionnaire/answers'
import type { Question } from '@nexus/factory-domain/purchasing/questionnaire/questions'
import type { SaveStatusState } from '@nexus/ui/components/SaveStatus/index'
import { isApiError, issuePath } from '../../lib/api/errors'
import type { LinkState } from '../../shell/links/link-state'
import type { OnboardBody, OnboardPage, OnboardSent, QuestionView, SiteBody, SiteStep, Uploaded, VatCheck } from './api'

/**
 * The supplier questionnaire's page model (SCR-269; design links.onboard): six steps — 1 · Company, 2 · Contacts, 3 · Sites
 * and sub-suppliers, 4 · Certifications and tests, 5 · Labour and social, 6 · Review and send — over the questions of
 * the version the link asks (questions as data: each step shows its section's questions, each kind its own field). The
 * checks are factory-domain's (the API's own rules); the page shows its own words for each check's code. The form lives in
 * the page and in the draft kept with us (never on the device); documents are uploaded as they are chosen.
 */

export const STEPS = ['company', 'contacts', 'sites', 'certifications', 'labour', 'sign'] as const
export type Step = (typeof STEPS)[number]

export const stepIndex = (step: Step): number => STEPS.indexOf(step)
export const nextOf = (step: Step): Step | null => STEPS[stepIndex(step) + 1] ?? null
export const previousOf = (step: Step): Step | null => STEPS[stepIndex(step) - 1] ?? null

export interface AnswerValue {
  value?: unknown
  explain?: string | null
}

export interface OnboardForm {
  answers: Record<string, AnswerValue>
  sites: SiteBody[]
  subTierSites: SiteBody[]
  signedName: string
  signedRole: string
  truthful: boolean
}

export const EMPTY_FORM: OnboardForm = { answers: {}, sites: [], subTierSites: [], signedName: '', signedRole: '', truthful: false }

export type UploadState = { kind: 'uploading'; name: string } | { kind: 'failed'; name: string; key: 'upload.failed' | 'upload.type' | 'upload.size' | 'upload.closed' }

export interface Problem {
  readonly step: Step
  readonly path: string
  readonly code: CheckCode
}

export type DraftStatus = SaveStatusState

export interface OnboardViewModel {
  link: LinkState
  page: OnboardPage | null
  problem: string | null
  form: OnboardForm
  step: Step
  /** The steps whose Continue was pressed: their problems show at the fields. */
  checked: Step[]
  /** The server's refusal at a field (its path), shown with the field. */
  issues: Problem[]
  draft: { status: DraftStatus; restoredAt: string | null; later: boolean }
  /** The VAT number's check, for the number it was made for. */
  vat: { status: 'idle' | 'checking' | 'done' | 'failed'; for: string; result: VatCheck | null }
  /** A document being uploaded or that failed, by question key. */
  uploads: Record<string, UploadState>
  /** The documents uploaded through this link (the page's list, then each new one). */
  files: Uploaded[]
  send: 'idle' | 'busy'
  done: OnboardSent | null
  /** The code of conduct being opened. */
  code: 'idle' | 'opening' | 'failed'
  /** Today in the company's zone (the documents' days are checked against it). */
  today: string
  timeZone?: string
}

export interface OnboardActions {
  onRetry?: () => void
  onStep?: (step: Step) => void
  onNext?: () => void
  onBack?: () => void
  onAnswer?: (key: string, value: AnswerValue) => void
  onSites?: (field: 'sites' | 'subTierSites', rows: SiteBody[]) => void
  onVat?: () => void
  onUpload?: (key: string, file: File) => void
  onRemoveFile?: (key: string) => void
  onCode?: () => void
  onSigner?: (field: 'signedName' | 'signedRole', value: string) => void
  onSign?: (name: string, truthful: boolean) => void
  onFinishLater?: () => void
  onSaveRetry?: () => void
  onStartAgain?: () => void
  onDismissRestored?: () => void
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export const questionsIn = (page: OnboardPage, step: Step): QuestionView[] => (step === 'sign' ? [] : page.questionnaire.questions.filter((question) => question.section === step))

/** The step a check belongs to (a question's section; the statement is the last step's). */
export function stepOfPath(page: OnboardPage, path: string): Step {
  if (path.startsWith('sites') || path.startsWith('subTierSites')) return 'sites'
  const key = /^answers\/([^/]+)/.exec(path)?.[1]
  if (!key) return 'sign'
  const section = page.questionnaire.questions.find((question) => question.key === key)?.section
  return section ?? 'sign'
}

/** The form as the send takes it (factory-domain AnswerForm). */
export function bodyOf(form: OnboardForm, page: OnboardPage): OnboardBody {
  const answers: OnboardBody['answers'] = {}
  for (const question of page.questionnaire.questions) {
    const entry = form.answers[question.key]
    if (!entry) continue
    const empty = entry.value === undefined || entry.value === null || entry.value === ''
    if (empty && !entry.explain?.trim()) continue
    answers[question.key] = { value: entry.value, ...(entry.explain?.trim() ? { explain: entry.explain } : {}) }
  }
  const site = (row: SiteBody): SiteBody => ({ name: row.name, country: row.country, town: row.town?.trim() ? row.town : null, steps: row.steps })
  return { questionnaireId: page.questionnaire.id, answers, sites: form.sites.map(site), subTierSites: form.subTierSites.map(site), signedName: form.signedName, signedRole: form.signedRole, truthful: form.truthful }
}

/** Every problem of the form, with its step (the domain's checks, as the API runs them). */
export function problemsOf(form: OnboardForm, page: OnboardPage, today: string): Problem[] {
  const checks: AnswerCheck[] = answerProblems(page.questionnaire.questions as Question[], bodyOf(form, page), today)
  return checks.map((check) => ({ step: stepOfPath(page, check.path), path: check.path, code: check.code }))
}

export const problemsIn = (problems: readonly Problem[], step: Step): Problem[] => problems.filter((problem) => problem.step === step)

/** The first step with something to fix up to `upTo` (inclusive), or null. */
export function firstBlocked(problems: readonly Problem[], upTo: Step): Step | null {
  for (const step of STEPS.slice(0, stepIndex(upTo) + 1)) if (problems.some((problem) => problem.step === step)) return step
  return null
}

/** The element id of a field, from a check's path (the page puts these ids on its fields). */
export const fieldId = (path: string): string => `fw-ob-${path.replace(/[^a-zA-Z0-9]+/g, '-')}`

/** The problem shown at a field (a checked step's, or the server's), or null. */
export function problemAt(model: Pick<OnboardViewModel, 'checked' | 'issues'>, problems: readonly Problem[], path: string): Problem | null {
  const server = model.issues.find((issue) => issue.path === path)
  if (server) return server
  return problems.find((problem) => problem.path === path && model.checked.includes(problem.step)) ?? null
}

/** The form's start: the company's questions filled from the supplier as we hold it (never over a draft). */
export function prefilled(page: OnboardPage): OnboardForm {
  const answers: Record<string, AnswerValue> = {}
  const company = page.questionnaire.questions.filter((question) => question.section === 'company')
  const firstText = company.find((question) => question.kind === 'TEXT')
  if (firstText && page.supplier.legalName) answers[firstText.key] = { value: page.supplier.legalName }
  for (const question of company) {
    if (question.kind === 'VAT' && page.supplier.vatNumber) answers[question.key] = { value: page.supplier.vatNumber }
    if (question.kind === 'ADDRESS' && page.supplier.address) answers[question.key] = { value: page.supplier.address }
    if (question.kind === 'URL' && page.supplier.website) answers[question.key] = { value: page.supplier.website }
  }
  return { ...EMPTY_FORM, answers }
}

/** Something worth keeping with us (Finish later is held until then). */
export function worthKeeping(form: OnboardForm, page: OnboardPage | null): boolean {
  const start = page ? prefilled(page) : EMPTY_FORM
  return JSON.stringify(form.answers) !== JSON.stringify(start.answers) || form.sites.length > 0 || form.subTierSites.length > 0 || form.signedRole.trim() !== ''
}

/** The draft's data: the version it answers, the step, the form (never the signature's tick: it is given at the send). */
export const draftDataOf = (form: OnboardForm, step: Step, page: OnboardPage): Record<string, unknown> => ({
  questionnaireId: page.questionnaire.id,
  step,
  answers: form.answers,
  sites: form.sites,
  subTierSites: form.subTierSites,
  signedName: form.signedName,
  signedRole: form.signedRole,
})

const isStep = (value: unknown): value is Step => typeof value === 'string' && (STEPS as readonly string[]).includes(value)
const sitesFrom = (value: unknown): SiteBody[] =>
  Array.isArray(value)
    ? value.filter(isRecord).map((row) => ({
        name: typeof row.name === 'string' ? row.name : '',
        country: typeof row.country === 'string' ? row.country : '',
        town: typeof row.town === 'string' ? row.town : null,
        steps: Array.isArray(row.steps) ? (row.steps.filter((step) => typeof step === 'string') as SiteStep[]) : [],
      }))
    : []

/**
 * A draft read back, made to fit the version the link asks now: answers to questions that are still there are kept (a
 * newer version keeps the answers whose keys it kept), a document only while it is still one this link uploaded.
 */
export function formFromDraft(data: Record<string, unknown>, page: OnboardPage): { form: OnboardForm; step: Step } | null {
  if (!isRecord(data.answers)) return null
  const keys = new Set(page.questionnaire.questions.map((question) => question.key))
  const files = new Set(page.uploaded.filter((file) => file.status !== 'DELETED').map((file) => file.id))
  const answers: Record<string, AnswerValue> = {}
  for (const [key, entry] of Object.entries(data.answers)) {
    if (!keys.has(key) || !isRecord(entry)) continue
    const question = page.questionnaire.questions.find((item) => item.key === key)!
    if (question.kind === 'FILE' && (!isRecord(entry.value) || !files.has(String(entry.value.fileId)))) continue
    answers[key] = { value: entry.value, explain: typeof entry.explain === 'string' ? entry.explain : null }
  }
  const form: OnboardForm = {
    answers,
    sites: sitesFrom(data.sites),
    subTierSites: sitesFrom(data.subTierSites),
    signedName: typeof data.signedName === 'string' ? data.signedName : '',
    signedRole: typeof data.signedRole === 'string' ? data.signedRole : '',
    truthful: false,
  }
  return { form, step: isStep(data.step) ? data.step : 'company' }
}

/** The page's read failed: which state of the link it says (404 gone, 403 not this person), else a plain error. */
export function readRefusal(error: unknown): LinkState | 'error' {
  if (isApiError(error) && error.kind === 'not_found') return 'unavailable'
  if (isApiError(error) && error.kind === 'forbidden') return 'wrong_person'
  return 'error'
}

/** What the send's refusal means for the page: a key of ours, the fields, whether to read again or keep the key. */
export function sendRefusal(error: unknown, page: OnboardPage): { key: string; issues: Problem[]; link: LinkState | null; reload: boolean; keepKey: boolean } {
  if (!isApiError(error)) return { key: 'problem.network', issues: [], link: null, reload: false, keepKey: true }
  if (error.kind === 'not_found') return { key: 'problem.gone', issues: [], link: 'unavailable', reload: false, keepKey: false }
  if (error.kind === 'conflict') return { key: 'problem.changed', issues: [], link: null, reload: true, keepKey: false }
  if (error.kind === 'invalid') {
    const issues = error.issues.map((issue) => {
      const path = issuePath(issue).replace(/^body\//, '')
      return { step: stepOfPath(page, path), path, code: codeOfServer(path) }
    })
    return { key: 'problem.fields', issues, link: null, reload: false, keepKey: false }
  }
  if (error.kind === 'rate_limited') return { key: 'problem.rateLimited', issues: [], link: null, reload: false, keepKey: true }
  return { key: 'problem.server', issues: [], link: null, reload: false, keepKey: true }
}

/** The server's refusal at a field (a document not arrived, or a check the page did not run): our words for it. */
function codeOfServer(path: string): CheckCode {
  if (/\/value$/.test(path) && path.startsWith('answers/')) return 'file'
  if (path === 'signedName') return 'signedName'
  if (path === 'signedRole') return 'signedRole'
  if (path === 'truthful') return 'truthful'
  if (path.startsWith('sites') || path.startsWith('subTierSites')) return 'sites'
  return 'required'
}

/** Files the page takes: a PDF, JPEG or PNG of at most 20 MB. */
export const DOCUMENT_ACCEPT = '.pdf,.jpg,.jpeg,.png'
export const DOCUMENT_MAX_BYTES = 20 * 1_048_576

/** The document a FILE question names now, or null. */
export function fileOfAnswer(form: OnboardForm, key: string): { fileId: string; issuer: string; number: string; issuedOn: string; expiresOn: string } | null {
  const value = form.answers[key]?.value
  if (!isRecord(value) || typeof value.fileId !== 'string') return null
  const text = (entry: unknown) => (typeof entry === 'string' ? entry : '')
  return { fileId: value.fileId, issuer: text(value.issuer), number: text(value.number), issuedOn: text(value.issuedOn), expiresOn: text(value.expiresOn) }
}

/** The VAT check's words key for the number shown now, or null (not checked for it). */
export function vatWords(model: Pick<OnboardViewModel, 'vat'>, value: string): string | null {
  const typed = value.replace(/[\s./-]/g, '').toUpperCase()
  if (model.vat.status === 'checking') return 'vat.checking'
  if (model.vat.status === 'failed') return 'vat.failed'
  if (model.vat.status !== 'done' || !model.vat.result || model.vat.for !== typed) return null
  const result = model.vat.result
  if (result.result === 'VALID') return result.nameMatches === true ? 'vat.validName' : result.nameMatches === false ? 'vat.validOtherName' : 'vat.valid'
  return `vat.${result.result}`
}

/** The question by key. */
export const questionOf = (page: OnboardPage, key: string): QuestionView | undefined => page.questionnaire.questions.find((question) => question.key === key)

/** The answer of a question in words for the review step (the page's catalogue for yes/no, signed; the files' names). */
export function answerSummary(question: QuestionView, entry: AnswerValue | undefined, files: readonly Uploaded[], locale: 'it' | 'en', t: (key: string, params?: Record<string, string | number>) => string): string {
  const value = entry?.value
  if (value === undefined || value === null || value === '') return t('review.none')
  switch (question.kind) {
    case 'YES_NO':
      return value === 'YES' ? t('answer.yes') : t('answer.no')
    case 'CHOICE':
      return question.options?.find((option) => option.code === value)?.text[locale] ?? String(value)
    case 'SIGN':
      return t('review.signed')
    case 'CONTACT':
      return isRecord(value) ? [value.name, value.email, value.phone].filter((part) => typeof part === 'string' && part.trim() !== '').join(' · ') : t('review.none')
    case 'FILE': {
      if (!isRecord(value)) return t('review.none')
      const name = files.find((file) => file.id === value.fileId)?.name ?? t('review.file')
      return [name, typeof value.expiresOn === 'string' && value.expiresOn ? t('review.expires', { day: value.expiresOn }) : null].filter(Boolean).join(' · ')
    }
    default:
      return typeof value === 'string' ? value : t('review.none')
  }
}
