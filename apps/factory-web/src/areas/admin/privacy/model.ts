import { labelProblems, publishProblems, requiredLanguages } from '@nexus/factory-domain/privacy/notices'
import { activityProblems, cleanList, dpiaStoreProblems } from '@nexus/factory-domain/privacy/records'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { Activity, ActivityFields, AckPerson, CompanyOverview, CompanyRef, Dpia, DpiaList, DutyKey, Notice, NoticeAcks, NoticeKind } from './api'

/**
 * Admin › Privacy & notices (SCR-086; design admin.privacy; GDPR arts. 13, 28, 30, 35; L. 300/1970 art. 4 c.3), pure:
 * what this person may do, the duties in plain words with the law named and their real state (read from the records,
 * never a tick box), each site's floor gate in words, the notice versions and their languages (each named in its own
 * words), why Publish or Store is held, the register's form. Names of people appear only inside one notice (Owner answer
 * W1), and only when the API gives them (privacy.manage). Every text is a SAMPLE until the privacy consultant writes the
 * real ones: the page says so. Words are keys of the `privacy` catalogue.
 */

// ---- abilities and the address ---------------------------------------------------------------------------------------------

export interface PrivacyCan {
  view: boolean
  manage: boolean
  /** Files of a notice or the DPIA (open the signed PDF). */
  files: boolean
  /** Upload a PDF (a notice's language, the signed DPIA). */
  upload: boolean
}

export function privacyCan(permissions: readonly string[]): PrivacyCan {
  const held = new Set(permissions)
  return { view: held.has('privacy.view'), manage: held.has('privacy.manage'), files: held.has('files.read'), upload: held.has('privacy.manage') && held.has('files.upload') }
}

export const VIEWS = ['notices', 'dpia', 'register'] as const
export type PrivacyViewName = (typeof VIEWS)[number]
export const viewOf = (value: string | null | undefined): PrivacyViewName => (VIEWS.includes(value as PrivacyViewName) ? (value as PrivacyViewName) : 'notices')

/** The company the page is about: the address's, else the session's, else the first one the overview lists. */
export function companyOf(companies: readonly CompanyRef[], asked: string | null | undefined, session: string | null | undefined): string | null {
  if (asked && companies.some((company) => company.id === asked)) return asked
  if (session && companies.some((company) => company.id === session)) return session
  return companies[0]?.id ?? null
}

// ---- the duties ------------------------------------------------------------------------------------------------------------

/** The order the duties are said in (design: register, notices, DPIA, the worker notice). */
export const DUTY_ORDER: readonly DutyKey[] = ['register', 'publicNotice', 'staffNotice', 'dpia', 'workerNotice']
/** Where each duty is done on this page. */
export const DUTY_VIEW: Readonly<Record<DutyKey, PrivacyViewName>> = { register: 'register', publicNotice: 'notices', staffNotice: 'notices', dpia: 'dpia', workerNotice: 'notices' }

export interface Phrase {
  key: string
  params?: Readonly<Record<string, string | number>>
}

export interface DutyLine {
  key: DutyKey
  /** done: the record is there; needs: someone must act; review: done, with its review day passed. */
  state: 'done' | 'needs' | 'review'
  words: Phrase
  /** The law it rests on, in words. */
  law: string
  /** What it holds back while it is not done (the floor gate), or null. */
  gates: string | null
  view: PrivacyViewName
}

/** A day as "YYYY-MM-DD" in the factory's zone (the DPIA's review day is a calendar day). */
export function todayIn(timeZone = 'Europe/Rome', now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** The duties of one company in words, from its overview (the API's English words are never drawn). */
export function dutyLines(overview: CompanyOverview, today: string): DutyLine[] {
  const done = new Map(overview.duties.map((duty) => [duty.key, duty.done]))
  return DUTY_ORDER.filter((key) => done.has(key)).map((key): DutyLine => {
    const isDone = done.get(key) === true
    const base = { key, law: `pv.duty.${key}.law`, view: DUTY_VIEW[key] }
    switch (key) {
      case 'register':
        return { ...base, state: isDone ? 'done' : 'needs', words: isDone ? { key: 'pv.duty.register.done', params: { count: overview.activities } } : { key: 'pv.duty.register.needs' }, gates: null }
      case 'publicNotice':
        return { ...base, state: isDone ? 'done' : 'needs', words: isDone ? { key: 'pv.duty.publicNotice.done', params: { label: overview.notices.PRIVACY_PUBLIC?.label ?? '' } } : { key: 'pv.duty.publicNotice.needs' }, gates: null }
      case 'staffNotice':
        return { ...base, state: isDone ? 'done' : 'needs', words: isDone ? { key: 'pv.duty.staffNotice.done', params: { label: overview.notices.OFFICE_STAFF?.label ?? '' } } : { key: 'pv.duty.staffNotice.needs' }, gates: null }
      case 'workerNotice':
        return { ...base, state: isDone ? 'done' : 'needs', words: isDone ? { key: 'pv.duty.workerNotice.done', params: { label: overview.notices.WORKER_FLOOR?.label ?? '' } } : { key: 'pv.duty.workerNotice.needs' }, gates: isDone ? null : 'pv.duty.workerNotice.gates' }
      default: {
        const review = overview.dpia?.reviewDueOn ?? null
        if (!isDone) return { ...base, state: 'needs', words: { key: 'pv.duty.dpia.needs' }, gates: 'pv.duty.dpia.gates' }
        if (review !== null && review <= today) return { ...base, state: 'review', words: { key: 'pv.duty.dpia.review', params: { version: overview.dpia?.versionNo ?? 0, date: review } }, gates: null }
        return { ...base, state: 'done', words: { key: 'pv.duty.dpia.done', params: { version: overview.dpia?.versionNo ?? 0 } }, gates: null }
      }
    }
  })
}

/** "4 of 5 duties done" (a review that is due still counts as done: the DPIA is stored). */
export const dutiesDone = (lines: readonly DutyLine[]): { done: number; total: number } => ({ done: lines.filter((line) => line.state !== 'needs').length, total: lines.length })

/**
 * Whether each site's floor may start real work, in words: the privacy gate first (the DPIA, the worker notice), else
 * the floor rules (a site that names workers needs its legal basis: Production › Floor rules & codes).
 */
export function siteWords(site: CompanyOverview['sites'][number], overview: CompanyOverview): Phrase[] {
  if (site.readyForFloor) return [{ key: 'pv.site.ready' }]
  const out: Phrase[] = []
  if (!overview.dpia) out.push({ key: 'pv.site.noDpia' })
  if (!overview.notices.WORKER_FLOOR) out.push({ key: 'pv.site.noNotice' })
  if (out.length === 0) out.push({ key: 'pv.site.noBasis' })
  return out
}

// ---- notices -----------------------------------------------------------------------------------------------------------------

export const KIND_ORDER: readonly NoticeKind[] = ['WORKER_FLOOR', 'OFFICE_STAFF', 'PRIVACY_PUBLIC']

/** A company's versions of one notice, newest first. */
export const versionsOf = (notices: readonly Notice[], kind: NoticeKind): Notice[] => notices.filter((notice) => notice.kind === kind).sort((a, b) => b.versionNo - a.versionNo)
export const draftOf = (notices: readonly Notice[], kind: NoticeKind): Notice | null => notices.find((notice) => notice.kind === kind && notice.status === 'DRAFT') ?? null
export const inForceOf = (notices: readonly Notice[], kind: NoticeKind): Notice | null => notices.find((notice) => notice.kind === kind && notice.status === 'PUBLISHED') ?? null

/** A language named in its own words ("Italiano", "English", "Română"); its code when the browser does not know it. */
export function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code)
    if (!name || name.toLowerCase() === code.toLowerCase()) return code.toUpperCase()
    return name.charAt(0).toLocaleUpperCase(code) + name.slice(1)
  } catch {
    return code.toUpperCase()
  }
}

/** Languages a version shows, Italian and English first, then the others by code. */
export function languagesInOrder(languages: readonly { locale: string }[]): string[] {
  const rank = (code: string) => (code === 'it' ? 0 : code === 'en' ? 1 : 2)
  return [...new Set(languages.map((language) => language.locale))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

/** Languages a worker reads that a version may add as a PDF (the screens speak Italian and English only, Q15). */
export const PDF_LANGUAGES = ['ro', 'sq', 'ar', 'ur', 'bn', 'zh', 'hi', 'pa', 'uk', 'es', 'fr', 'de', 'pt', 'pl'] as const

/** The languages a DRAFT still lacks as text before it may be published (Italian; the worker notice also English). */
export function missingLanguages(notice: Pick<Notice, 'kind' | 'status' | 'languages'>): string[] {
  if (notice.status !== 'DRAFT') return []
  const problems = publishProblems({ kind: notice.kind, status: notice.status, languages: notice.languages.map((language) => ({ locale: language.locale, hasBody: language.hasText, hasPdf: language.fileId !== null })) })
  return problems.flatMap((problem) => (problem.path.startsWith('texts/') ? [problem.path.slice('texts/'.length)] : []))
}

/** The languages a 409 of Publish names (`texts/<locale>`): the page says them in its own words. */
export function missingFromRefusal(error: unknown): string[] | null {
  if (!isApiError(error) || error.kind !== 'conflict') return null
  const locales = error.issues.map(issuePath).flatMap((path) => (path.startsWith('texts/') ? [path.slice('texts/'.length)] : []))
  return locales.length > 0 ? locales : null
}

/** Why Publish is held (a message key with values), or null. */
export function publishHeld(notice: Notice, can: PrivacyCan, edited: boolean): Phrase | null {
  if (!can.manage) return { key: 'pv.held.manage' }
  if (notice.status !== 'DRAFT') return { key: 'pv.held.notDraft' }
  if (edited) return { key: 'pv.held.unsaved' }
  const missing = missingLanguages(notice)
  if (missing.length > 0) return { key: 'pv.held.missing', params: { languages: missing.map(languageName).join(', ') } }
  return null
}

/** "v3" style: a version's label as shown, with the version number when the label does not say it. */
export const versionWords = (notice: Pick<Notice, 'label' | 'versionNo'>): Phrase => ({ key: 'pv.notice.version', params: { label: notice.label, n: notice.versionNo } })

/** The label a new version suggests: this month ("2026-10"), with a suffix when that one is taken. */
export function suggestedLabel(taken: readonly string[], today: string): string {
  const month = today.slice(0, 7)
  if (!taken.includes(month)) return month
  for (let n = 2; n < 100; n += 1) if (!taken.includes(`${month}-${n}`)) return `${month}-${n}`
  return `${month}-${Date.now()}`
}

export interface NewNoticeDraft {
  kind: NoticeKind
  label: string
  copyTexts: boolean
}

/** Why a new version cannot be made yet: a draft of that notice exists (open it instead), or the label. */
export function newNoticeHeld(draft: NewNoticeDraft, notices: readonly Notice[], can: PrivacyCan): Phrase | null {
  if (!can.manage) return { key: 'pv.held.manage' }
  const open = draftOf(notices, draft.kind)
  if (open) return { key: 'pv.held.draftExists', params: { label: open.label } }
  if (labelProblems(draft.label).length > 0) return { key: 'pv.held.label' }
  if (notices.some((notice) => notice.kind === draft.kind && notice.label === draft.label.trim())) return { key: 'pv.held.labelTaken', params: { label: draft.label.trim() } }
  return null
}

/** The texts typed in a draft that differ from what is saved. */
export function editedLocales(notice: Notice, texts: Readonly<Record<string, string>>): string[] {
  return Object.entries(texts)
    .filter(([locale, text]) => (notice.languages.find((language) => language.locale === locale)?.body ?? '') !== text)
    .map(([locale]) => locale)
}

/** Every acknowledgement in words: "41 of 48 acknowledged". */
export function ackWords(counts: { active: number; acknowledged: number } | null | undefined): Phrase {
  if (!counts) return { key: 'pv.ack.none' }
  return { key: 'pv.ack.count', params: { count: counts.acknowledged, total: counts.active } }
}

/** The people who have not acknowledged the version in force (for a paper copy), by name, as the API sorted them. */
export const notYetAcknowledged = (people: readonly AckPerson[] | null | undefined): AckPerson[] => (people ?? []).filter((person) => person.acknowledgedAt === null)

/** Why a paper copy cannot be recorded, or null. */
export function paperHeld(notice: Notice, acks: NoticeAcks | null, can: PrivacyCan, pick: { workerId: string; locale: string }): Phrase | null {
  if (!can.manage) return { key: 'pv.held.manage' }
  if (notice.kind !== 'WORKER_FLOOR') return { key: 'pv.held.paperWorkerOnly' }
  if (notice.status !== 'PUBLISHED') return { key: 'pv.held.paperInForce' }
  if (!acks?.people) return { key: 'pv.held.manage' }
  if (!pick.workerId) return { key: 'pv.held.pickWorker' }
  if (!notice.languages.some((language) => language.locale === pick.locale)) return { key: 'pv.held.pickLanguage' }
  return null
}

// ---- the DPIA ------------------------------------------------------------------------------------------------------------------

export const draftDpiaOf = (list: DpiaList | null): Dpia | null => list?.versions.find((dpia) => dpia.status === 'DRAFT') ?? null

export interface DpiaForm {
  signedByName: string
  signedOn: string
  reviewDueOn: string
}

/** A year after the signing day (a common review rhythm; the person may change it). */
export function reviewDefault(signedOn: string): string {
  const [year, month, day] = signedOn.split('-').map(Number)
  if (!year || !month || !day) return ''
  return `${year + 1}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Why Store is held, from factory-domain's own rules, in this page's words (each field's). */
export function storeHeld(draft: Dpia | null, form: DpiaForm, can: PrivacyCan, today: string): Phrase | null {
  if (!can.manage) return { key: 'pv.held.manage' }
  if (!draft) return { key: 'pv.held.noDraft' }
  if (draft.fileId === null) return { key: 'pv.held.dpiaPdf' }
  if (!form.signedOn) return { key: 'pv.held.dpiaSignedOnMissing' }
  if (!form.reviewDueOn) return { key: 'pv.held.dpiaReviewMissing' }
  const first = dpiaStoreProblems({ status: draft.status, hasPdf: true, signedByName: form.signedByName, signedOn: form.signedOn, reviewDueOn: form.reviewDueOn, today })[0]
  if (!first) return null
  if (first.path === 'state') return { key: draft.fileId === null ? 'pv.held.dpiaPdf' : 'pv.held.notDraft' }
  if (first.path.endsWith('signedByName')) return { key: 'pv.held.dpiaSigner' }
  if (first.path.endsWith('signedOn')) return { key: 'pv.held.dpiaSignedOn' }
  return { key: 'pv.held.dpiaReview' }
}

// ---- the record of processing activities ------------------------------------------------------------------------------------

export interface ActivityDraft {
  code: string
  name: string
  purpose: string
  legalBasis: string
  /** One per line. */
  dataSubjects: string
  dataCategories: string
  recipients: string
  processors: string
  transfers: string
  retention: string
  security: string
}

export const LIST_FIELDS = ['dataSubjects', 'dataCategories', 'recipients', 'processors'] as const
export const TEXT_FIELDS = ['name', 'purpose', 'legalBasis', 'transfers', 'retention', 'security'] as const
export type ActivityField = 'code' | (typeof LIST_FIELDS)[number] | (typeof TEXT_FIELDS)[number]

export const emptyActivity = (): ActivityDraft => ({ code: '', name: '', purpose: '', legalBasis: '', dataSubjects: '', dataCategories: '', recipients: '', processors: '', transfers: '', retention: '', security: '' })
export const activityDraftOf = (activity: Activity): ActivityDraft => ({
  code: activity.code,
  name: activity.name,
  purpose: activity.purpose,
  legalBasis: activity.legalBasis,
  dataSubjects: activity.dataSubjects.join('\n'),
  dataCategories: activity.dataCategories.join('\n'),
  recipients: activity.recipients.join('\n'),
  processors: activity.processors.join('\n'),
  transfers: activity.transfers,
  retention: activity.retention,
  security: activity.security,
})

const lines = (text: string): string[] => cleanList(text.split(/\r?\n|;/))

/** The fields as the API takes them (lists one entry per line, trimmed, no repeats). */
export function activityFields(draft: ActivityDraft): ActivityFields {
  return {
    name: draft.name.trim(),
    purpose: draft.purpose.trim(),
    legalBasis: draft.legalBasis.trim(),
    dataSubjects: lines(draft.dataSubjects),
    dataCategories: lines(draft.dataCategories),
    recipients: lines(draft.recipients),
    processors: lines(draft.processors),
    transfers: draft.transfers.trim(),
    retention: draft.retention.trim(),
    security: draft.security.trim(),
  }
}

/** A changed activity: only the fields that differ (a PATCH), or null when nothing changed. */
export function activityPatch(activity: Activity, draft: ActivityDraft): Partial<ActivityFields> | null {
  const next = activityFields(draft)
  const changes: Partial<ActivityFields> = {}
  for (const field of TEXT_FIELDS) if (next[field] !== activity[field]) changes[field] = next[field]
  for (const field of LIST_FIELDS) if (next[field].join('\u0000') !== activity[field].join('\u0000')) changes[field] = next[field]
  return Object.keys(changes).length > 0 ? changes : null
}

/** What is wrong with each field, as keys of `privacy` (factory-domain's rules; their English is not drawn). */
export function activityErrors(draft: ActivityDraft, isNew: boolean): Partial<Record<ActivityField, string>> {
  const fields = activityFields(draft)
  const problems = activityProblems({ ...(isNew ? { code: draft.code.trim().toUpperCase() } : {}), ...fields }, !isNew)
  const errors: Partial<Record<ActivityField, string>> = {}
  for (const problem of problems) {
    const field = problem.path.split('/').pop() as ActivityField
    if (errors[field]) continue
    errors[field] = field === 'code' ? 'pv.form.codeRule' : field === 'dataSubjects' || field === 'dataCategories' ? (fields[field].length === 0 ? 'pv.form.atLeastOne' : 'pv.form.listRule') : (LIST_FIELDS as readonly string[]).includes(field) ? 'pv.form.listRule' : draft[field].trim() === '' ? 'pv.form.required' : 'pv.form.tooLong'
  }
  return errors
}

export const REGISTER_FILTERS = ['ACTIVE', 'ARCHIVED', 'all'] as const
export type RegisterFilter = (typeof REGISTER_FILTERS)[number]
export const registerRows = (activities: readonly Activity[], filter: RegisterFilter): Activity[] =>
  activities.filter((activity) => filter === 'all' || activity.status === filter).sort((a, b) => a.code.localeCompare(b.code))

// ---- problems --------------------------------------------------------------------------------------------------------------------

/** A failed read or write as a key of `privacy` (the API's English is never drawn). */
export function problemOf(error: unknown): string {
  if (!isApiError(error)) return 'pv.problem.internal'
  switch (error.kind) {
    case 'forbidden':
      return 'pv.problem.forbidden'
    case 'not_found':
      return 'pv.problem.notFound'
    case 'conflict':
      return 'pv.problem.conflict'
    case 'invalid':
      return 'pv.problem.invalid'
    case 'rate_limited':
      return 'pv.problem.rateLimited'
    case 'unavailable':
      return 'pv.problem.unavailable'
    case 'signed_out':
      return 'pv.problem.signedOut'
    default:
      return 'pv.problem.internal'
  }
}

/** A notice version opened in its dialog (a real link: ⌘-click opens it in a new tab; Back closes it). */
export function noticeHref(prefix: string, companyId: string | null, noticeId: string): string {
  const query = new URLSearchParams()
  if (companyId) query.set('company', companyId)
  query.set('open', noticeId)
  return `${prefix}/admin/privacy?${query.toString()}`
}

/** The address of a company's public privacy notice (the Links view's page; anyone may open it). */
export const publicAddress = (origin: string, companyId: string): string => `${origin.replace(/\/+$/, '')}/privacy/${encodeURIComponent(companyId)}`

/** CSV for an auditor (Excel-safe: a cell that starts like a formula is prefixed). */
export function csvOf(header: readonly string[], rows: readonly (readonly (string | number | null | undefined)[])[]): string {
  const cell = (value: string | number | null | undefined) => {
    const text = value === null || value === undefined ? '' : String(value)
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text
    return /[",;\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  return [header, ...rows].map((row) => row.map(cell).join(';')).join('\n')
}

export { requiredLanguages }

// ---- the page's one view model -----------------------------------------------------------------------------------------------

/** A read the page shows: its value, or why it failed (null both: still loading). */
export interface Read<T> {
  value: T | null
  problem: string | null
}
export const LOADING: Read<never> = Object.freeze({ value: null, problem: null })

export interface StepUpState {
  open: boolean
  busy: boolean
  /** What the code allows: a key of `privacy`. */
  sentence: string
  /** A key of `admin` (the shared step-up words). */
  problem: string | null
}
export const STEP_UP_SHUT: StepUpState = { open: false, busy: false, sentence: 'pv.stepUp.publish', problem: null }

export interface PageNotice {
  tone: 'success' | 'info' | 'warning' | 'danger'
  words: Phrase
}

/** The dialog open on the page (one at a time; `?open=<noticeId>` is the notice's). */
export type PrivacyDialog =
  | {
      kind: 'notice'
      noticeId: string
      notice: Read<Notice>
      acks: Read<NoticeAcks>
      /** A DRAFT's texts as typed, per language. */
      texts: Record<string, string>
      /** A language being added (text or PDF). */
      adding: { locale: string; as: 'text' | 'pdf' } | null
      paper: { workerId: string; locale: string }
      confirmDelete: boolean
      busy: boolean
      problem: Phrase | null
      done: Phrase | null
    }
  | { kind: 'newNotice'; draft: NewNoticeDraft; busy: boolean; problem: Phrase | null }
  | { kind: 'newDpia'; scope: string; busy: boolean; problem: Phrase | null }
  | { kind: 'activity'; activityId: string | null; draft: ActivityDraft; busy: boolean; problem: Phrase | null; showErrors: boolean }
  | { kind: 'archive'; activityId: string; busy: boolean; problem: Phrase | null }

export interface PrivacyViewModel {
  prefix: string
  can: PrivacyCan
  view: PrivacyViewName
  /** The companies the person's privacy.view reaches (from the overview). */
  overview: Read<CompanyOverview[]>
  companyId: string | null
  notices: Read<Notice[]>
  dpia: Read<DpiaList>
  register: Read<Activity[]>
  registerFilter: RegisterFilter
  selectedNotices: readonly string[]
  selectedActivities: readonly string[]
  dpiaForm: DpiaForm
  /** A PDF on its way to the store (the DPIA's or a notice language's). */
  uploading: boolean
  dpiaProblem: Phrase | null
  dialog: PrivacyDialog | null
  stepUp: StepUpState
  asOf: string | null
  live: 'connecting' | 'live' | 'offline'
  updates: number
  notice: PageNotice | null
  /** Where the public notice lives (this web's origin). */
  origin: string
  today: string
  timeZone: string
  /** Design cases: the keys panel open, a focused row. */
  keysOpen?: boolean
}
