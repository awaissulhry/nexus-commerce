import {
  countsOf,
  MAX_DAYS_AHEAD,
  outcomeOf,
  planAnswer,
  type AnswerCounts,
  type AnswerOutcome,
  type AnsweredLine,
  type DeclineReason,
  type LineAnswerKind,
} from '@nexus/factory-domain/purchasing/confirm/answer'
import { MAX_TEXT, type PurchaseOrderStatus } from '@nexus/factory-domain/purchasing/orders'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { Locale } from '../../lib/i18n/locales'
import type { LinkState } from '../../shell/links/link-state'
import type { ConfirmBody, LineAnswerBody, LinkOrder, LinkOrderLine } from './api'

/**
 * SCR-100 — the supplier's confirm link (design links.po; B-W1-31/33; Owner answers P2 "the buyer always accepts or
 * refuses a supplier's proposals" and C2 "no prices on supplier screens"), pure: the page's state, its answer line by
 * line, the checks of a line's answer IN THIS PAGE'S WORDS (the same rules as factory-domain purchasing/confirm/answer:
 * the API's planAnswer, whose sentences are English), what the answer comes to (confirmed, a proposal the buyer decides,
 * a decline), and the supplier's PDF. The container (PoConfirm.tsx) keeps the state with `reduce`; the view draws it.
 */

/** The largest confirmation PDF (the files platform takes 25 MB for a DOCUMENT; the page asks a little less). */
export const MAX_PDF_BYTES = 20 * 1024 * 1024
export const PDF_TYPE = 'application/pdf'

export interface DeliveryDraft {
  readonly quantity: string
  readonly date: string
}

/** One line's answer as the supplier types it (quantities as typed, in the page's language; dates ISO). */
export interface LineDraft {
  readonly kind: LineAnswerKind
  readonly quantity: string
  readonly date: string
  readonly deliveries: readonly [DeliveryDraft, DeliveryDraft]
  readonly reason: string
}

export type UploadState =
  | { readonly state: 'none' }
  | { readonly state: 'uploading'; readonly name: string; readonly size: number }
  | { readonly state: 'done'; readonly id: string; readonly name: string; readonly size: number }
  /** The store holds something other than what was announced: choose the file again. */
  | { readonly state: 'quarantined'; readonly name: string }
  | { readonly state: 'failed'; readonly name: string }
  | { readonly state: 'rejected'; readonly name: string; readonly problem: 'notPdf' | 'tooBig' | 'empty' }

/** A refused answer in this page's words (`po-confirm-link` problem.*). */
export const PROBLEMS = ['changed', 'notAnswerable', 'invalid', 'rateLimited', 'unavailableNow', 'internal', 'upload'] as const
export type Problem = (typeof PROBLEMS)[number]

export interface Done {
  readonly outcome: AnswerOutcome
  /** What the answer held (null: a decline of the whole order). */
  readonly counts: AnswerCounts | null
  readonly fileName: string | null
  readonly supplierRef: string | null
}

export interface PoConfirmViewModel {
  /** The link itself: `valid` once the order was read. */
  link: LinkState
  page: LinkOrder | null
  /** The supplier's today (Europe/Rome), as the API checks dates. */
  today: string
  /** The lines answered other than "as asked", by line id. */
  answers: Readonly<Record<string, LineDraft>>
  /** The line whose answer is being changed (the sheet), with its draft; `tried` once Save was pressed. */
  sheet: { readonly lineId: string; readonly draft: LineDraft; readonly tried: boolean } | null
  supplierRef: string
  typedName: string
  note: string
  upload: UploadState
  declineOpen: boolean
  decline: { readonly reason: DeclineReason; readonly note: string; readonly tried: boolean }
  send: 'idle' | 'busy'
  problem: Problem | null
  /** The end state right after this page's own answer. */
  done: Done | null
  /** A dead link's "Ask for a new link" was pressed. */
  newLinkAsked: boolean
  /** The read failed: Try again. */
  readFailed: boolean
  /** The site's zone (dates and times). */
  timeZone?: string
}

export const initialModel = (today: string): PoConfirmViewModel => ({
  link: 'loading',
  page: null,
  today,
  answers: {},
  sheet: null,
  supplierRef: '',
  typedName: '',
  note: '',
  upload: { state: 'none' },
  declineOpen: false,
  decline: { reason: 'NO_CAPACITY', note: '', tried: false },
  send: 'idle',
  problem: null,
  done: null,
  newLinkAsked: false,
  readFailed: false,
})

// ---- quantities and dates ----------------------------------------------------------------------------------------------

/**
 * A quantity as the API takes it ("1200.5"), from what a person typed in the page's language: "1.200,5" or "1200,5"
 * in Italian, "1,200.5" or "1200.5" in English; spaces ignored. Null when it is no number.
 */
export function plainQuantity(typed: string, locale: Locale): string | null {
  let text = typed.replace(/[\s  ']/g, '')
  if (text === '') return null
  if (locale === 'it') {
    if (text.includes(',')) text = text.replace(/\./g, '').replace(',', '.')
    else if (/^\d{1,3}(\.\d{3})+$/.test(text)) text = text.replace(/\./g, '')
  } else {
    text = text.replace(/,/g, '')
  }
  if (!/^\d+(\.\d+)?$/.test(text)) return null
  return new Dec(text).toString()
}

/** A quantity of the API ("1200.0000") as the page shows it in the reader's language. */
export function quantityShown(value: string, locale: Locale): string {
  const decimal = new Dec(value)
  const places = Math.min(4, Math.max(0, decimal.decimalPlaces()))
  return new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { minimumFractionDigits: 0, maximumFractionDigits: places }).format(decimal.toNumber())
}

/** The same quantity in the form a person types it in the page's language (a draft starts from it). */
export function quantityTyped(value: string, locale: Locale): string {
  const plain = new Dec(value).toDecimalPlaces(4).toString()
  return locale === 'it' ? plain.replace('.', ',') : plain
}

/** `today` + days, ISO. */
export function addDaysIso(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** The day in a zone (the supplier's today as the API counts it). */
export function dayIn(now: Date, timeZone = 'Europe/Rome'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

// ---- one line's answer ---------------------------------------------------------------------------------------------------

/** A fresh draft of a line: what was asked, so "other" starts from it. */
export function draftOf(line: LinkOrderLine, kind: LineAnswerKind, locale: Locale, previous?: LineDraft): LineDraft {
  if (previous && previous.kind === kind) return previous
  const asked = quantityTyped(line.quantity, locale)
  return {
    kind,
    quantity: previous?.quantity ?? (kind === 'OTHER' ? asked : ''),
    date: previous?.date ?? (kind === 'OTHER' ? line.needDate : ''),
    deliveries: previous?.deliveries ?? [
      { quantity: '', date: line.needDate },
      { quantity: '', date: '' },
    ],
    reason: previous?.reason ?? '',
  }
}

export type QuantityProblem = 'number' | 'positive'
export type DateProblem = 'missing' | 'past' | 'far'
export type ReasonProblem = 'missing' | 'long'

/** Every problem of a line's answer, by field (empty: it can be saved). The words are this page's. */
export interface DraftProblems {
  quantity?: QuantityProblem
  date?: DateProblem
  reason?: ReasonProblem
  deliveries?: readonly [{ quantity?: QuantityProblem; date?: DateProblem }, { quantity?: QuantityProblem; date?: DateProblem }]
  /** The answer as a whole: OTHER gives neither; OTHER gives what was asked; a SPLIT on one day. */
  whole?: 'nothing' | 'same' | 'sameDay'
}

const quantityProblem = (typed: string, locale: Locale): QuantityProblem | undefined => {
  const plain = plainQuantity(typed, locale)
  if (plain === null || new Dec(plain).decimalPlaces() > 4 || plain.replace('.', '').replace(/^0+/, '').length > 14) return 'number'
  if (new Dec(plain).lte(0)) return 'positive'
  return undefined
}

const dateProblem = (value: string, today: string): DateProblem | undefined => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'missing'
  if (value < today) return 'past'
  if (value > addDaysIso(today, MAX_DAYS_AHEAD)) return 'far'
  return undefined
}

const reasonProblem = (value: string): ReasonProblem | undefined => {
  const trimmed = value.trim()
  if (trimmed === '') return 'missing'
  if (trimmed.length > MAX_TEXT.reason) return 'long'
  return undefined
}

export function draftProblems(line: LinkOrderLine, draft: LineDraft, today: string, locale: Locale): DraftProblems {
  const problems: DraftProblems = {}
  switch (draft.kind) {
    case 'AS_ASKED':
      return problems
    case 'CANNOT_DELIVER': {
      const reason = reasonProblem(draft.reason)
      return reason ? { reason } : problems
    }
    case 'OTHER': {
      const quantityGiven = draft.quantity.trim() !== ''
      const dateGiven = draft.date.trim() !== ''
      const out: DraftProblems = {}
      if (!quantityGiven && !dateGiven) out.whole = 'nothing'
      const quantity = quantityGiven ? quantityProblem(draft.quantity, locale) : undefined
      const date = dateGiven ? dateProblem(draft.date, today) : undefined
      if (quantity) out.quantity = quantity
      if (date) out.date = date
      const reason = reasonProblem(draft.reason)
      if (reason) out.reason = reason
      if (!out.whole && !quantity && !date) {
        const sameQuantity = !quantityGiven || new Dec(plainQuantity(draft.quantity, locale)!).eq(new Dec(line.quantity))
        const sameDate = !dateGiven || draft.date === line.needDate
        if (sameQuantity && sameDate) out.whole = 'same'
      }
      return out
    }
    case 'SPLIT': {
      const parts = draft.deliveries.map((part) => {
        const out: { quantity?: QuantityProblem; date?: DateProblem } = {}
        const quantity = quantityProblem(part.quantity, locale)
        const date = dateProblem(part.date, today)
        if (quantity) out.quantity = quantity
        if (date) out.date = date
        return out
      }) as unknown as [{ quantity?: QuantityProblem; date?: DateProblem }, { quantity?: QuantityProblem; date?: DateProblem }]
      const out: DraftProblems = {}
      if (parts.some((part) => part.quantity || part.date)) out.deliveries = parts
      else if (draft.deliveries[0].date === draft.deliveries[1].date) out.whole = 'sameDay'
      const reason = reasonProblem(draft.reason)
      if (reason) out.reason = reason
      return out
    }
  }
}

export const hasProblems = (problems: DraftProblems): boolean =>
  Boolean(problems.quantity || problems.date || problems.reason || problems.whole || problems.deliveries?.some((part) => part.quantity || part.date))

/** The first problem as a key of `po-confirm-link` (the Save button is held with it). */
export function firstProblemKey(problems: DraftProblems): string | null {
  if (problems.whole) return `sheet.problem.whole.${problems.whole}`
  if (problems.quantity) return `sheet.problem.quantity.${problems.quantity}`
  if (problems.date) return `sheet.problem.date.${problems.date}`
  const part = problems.deliveries?.find((entry) => entry.quantity || entry.date)
  if (part?.quantity) return `sheet.problem.quantity.${part.quantity}`
  if (part?.date) return `sheet.problem.date.${part.date}`
  if (problems.reason) return `sheet.problem.reason.${problems.reason}`
  return null
}

/** A line's answer as the API takes it. */
export function lineBody(line: LinkOrderLine, draft: LineDraft | undefined, locale: Locale): LineAnswerBody {
  if (!draft || draft.kind === 'AS_ASKED') return { lineId: line.id, answer: 'AS_ASKED' }
  const reason = draft.reason.trim()
  switch (draft.kind) {
    case 'CANNOT_DELIVER':
      return { lineId: line.id, answer: 'CANNOT_DELIVER', reason }
    case 'OTHER':
      return {
        lineId: line.id,
        answer: 'OTHER',
        quantity: draft.quantity.trim() === '' ? null : plainQuantity(draft.quantity, locale),
        date: draft.date.trim() === '' ? null : draft.date,
        reason,
      }
    case 'SPLIT':
      return { lineId: line.id, answer: 'SPLIT', deliveries: draft.deliveries.map((part) => ({ quantity: plainQuantity(part.quantity, locale) ?? part.quantity, date: part.date })), reason }
  }
}

// ---- the whole answer ------------------------------------------------------------------------------------------------------

export interface AnswerPreview {
  readonly mode: 'ALL_AS_ASKED' | 'BY_LINE'
  /** What it comes to (the domain's outcomeOf). */
  readonly outcome: AnswerOutcome
  /** The domain's counts of the answered lines (the review line's numbers). */
  readonly counts: AnswerCounts
  /** The lines in the API's terms, each checked (by the domain's own planAnswer). */
  readonly lines: readonly AnsweredLine[]
}

/**
 * The answer as it stands, checked with the API's own rule (planAnswer): every line as asked is "confirm all as asked";
 * anything else goes line by line. Null when a line's answer is not complete (the sheet holds it, so this is a guard).
 */
export function answerPreview(page: LinkOrder, answers: Readonly<Record<string, LineDraft>>, today: string, locale: Locale): AnswerPreview | null {
  const asked = page.lines.map((line) => ({ id: line.id, seq: line.seq, quantity: line.quantity, uom: line.uom, needDate: line.needDate }))
  const changed = page.lines.some((line) => answers[line.id] && answers[line.id]!.kind !== 'AS_ASKED')
  try {
    const plan = changed
      ? planAnswer(asked, { mode: 'BY_LINE', lines: page.lines.map((line) => lineBody(line, answers[line.id], locale)) }, today)
      : planAnswer(asked, { mode: 'ALL_AS_ASKED' }, today)
    return { mode: changed ? 'BY_LINE' : 'ALL_AS_ASKED', outcome: plan.outcome, counts: plan.counts, lines: plan.lines }
  } catch {
    return null
  }
}

export const clean = (value: string): string | null => {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** The confirm request for the answer as it stands. */
export function confirmBody(model: PoConfirmViewModel, preview: AnswerPreview, locale: Locale): ConfirmBody {
  const page = model.page!
  return {
    version: page.order.version,
    mode: preview.mode,
    ...(preview.mode === 'BY_LINE' ? { lines: page.lines.map((line) => lineBody(line, model.answers[line.id], locale)) } : {}),
    supplierRef: clean(model.supplierRef),
    note: clean(model.note),
    typedName: clean(model.typedName),
    confirmationFileId: model.upload.state === 'done' ? model.upload.id : null,
  }
}

/** How the page asks for a name before each answer ("required", "optional", or not at all). */
export function nameAsked(page: LinkOrder | null, action: 'confirm' | 'decline'): 'required' | 'optional' | 'none' {
  return page?.answers.find((answer) => answer.action === action)?.typedName ?? 'none'
}

/** Why the main button waits (a key of `po-confirm-link`), or null when it may send. */
export function sendHeld(model: PoConfirmViewModel, preview: AnswerPreview | null): string | null {
  if (model.send === 'busy') return 'answer.held.busy'
  if (!preview) return 'answer.held.incomplete'
  if (model.upload.state === 'uploading') return 'answer.held.uploading'
  if (model.upload.state === 'quarantined' || model.upload.state === 'failed' || model.upload.state === 'rejected') return 'answer.held.file'
  if (nameAsked(model.page, 'confirm') === 'required' && model.typedName.trim().length < 2) return 'answer.held.name'
  if (model.supplierRef.trim().length > MAX_TEXT.code) return 'answer.held.ref'
  if (model.note.trim().length > MAX_TEXT.note) return 'answer.held.note'
  return null
}

/** Why the decline waits, or null. */
export function declineHeld(model: PoConfirmViewModel): string | null {
  if (model.send === 'busy') return 'answer.held.busy'
  if (model.decline.reason === 'OTHER' && model.decline.note.trim() === '') return 'decline.held.note'
  if (model.decline.note.trim().length > MAX_TEXT.note) return 'answer.held.note'
  if (nameAsked(model.page, 'decline') === 'required' && model.typedName.trim().length < 2) return 'answer.held.name'
  return null
}

/** A chosen file the page will not send, or null. */
export function pdfProblem(file: { readonly name: string; readonly type: string; readonly size: number }): 'notPdf' | 'tooBig' | 'empty' | null {
  if (file.size === 0) return 'empty'
  const pdf = file.type === PDF_TYPE || (file.type === '' && /\.pdf$/i.test(file.name))
  if (!pdf) return 'notPdf'
  if (file.size > MAX_PDF_BYTES) return 'tooBig'
  return null
}

/** The order's state in this page's words when it takes no answer (a key of `po-confirm-link` answered.*). */
export function answeredKey(status: PurchaseOrderStatus): string {
  switch (status) {
    case 'CONFIRMED':
    case 'CHANGES_PROPOSED':
    case 'DECLINED':
    case 'PARTLY_RECEIVED':
    case 'RECEIVED':
    case 'DRAFT':
    case 'CANCELLED':
    case 'CLOSED':
      return `answered.${status}`
    default:
      return 'answered.other'
  }
}

/** The first and last day the goods are expected by (the confirmed end state's sentence). */
export function expectedSpan(lines: readonly Pick<AnsweredLine, 'date'>[]): { first: string; last: string } | null {
  const days = lines.map((line) => line.date).filter((day): day is string => typeof day === 'string').sort()
  return days.length === 0 ? null : { first: days[0]!, last: days[days.length - 1]! }
}

/** The review line's parts, each a key with its count (`summary.*`), in the domain's order. */
export function summaryParts(counts: AnswerCounts): { key: string; count: number }[] {
  const parts: { key: string; count: number }[] = []
  if (counts.asAsked > 0) parts.push({ key: counts.asAsked === counts.lines ? 'summary.allAsAsked' : 'summary.asAsked', count: counts.asAsked })
  if (counts.laterDate > 0) parts.push({ key: 'summary.later', count: counts.laterDate })
  if (counts.earlierDate > 0) parts.push({ key: 'summary.earlier', count: counts.earlierDate })
  if (counts.otherQuantity > 0) parts.push({ key: 'summary.quantity', count: counts.otherQuantity })
  if (counts.split > 0) parts.push({ key: 'summary.split', count: counts.split })
  if (counts.cannotDeliver > 0) parts.push({ key: 'summary.cannot', count: counts.cannotDeliver })
  return parts
}

/** The domain's counts of what was answered (for a fixture or the end state of a proposal). */
export const countsOfLines = countsOf
/** What a mix of line answers comes to. */
export const outcomeOfLines = outcomeOf

// ---- the page's state ---------------------------------------------------------------------------------------------------------

export type PoConfirmEvent =
  | { type: 'read'; page: LinkOrder }
  | { type: 'readFailed'; link: LinkState }
  | { type: 'field'; field: 'supplierRef' | 'typedName' | 'note'; value: string }
  | { type: 'openLine'; line: LinkOrderLine; locale: Locale }
  | { type: 'sheetDraft'; draft: LineDraft }
  | { type: 'sheetKind'; line: LinkOrderLine; kind: LineAnswerKind; locale: Locale }
  | { type: 'sheetSave'; line: LinkOrderLine; locale: Locale }
  | { type: 'sheetClose' }
  | { type: 'resetLine'; lineId: string }
  | { type: 'resetAll' }
  | { type: 'upload'; upload: UploadState }
  | { type: 'declineOpen'; open: boolean }
  | { type: 'declineDraft'; reason: DeclineReason; note: string }
  | { type: 'declineTried' }
  | { type: 'sending' }
  | { type: 'answered'; page: LinkOrder; done: Done }
  | { type: 'refused'; problem: Problem | null; link?: LinkState }
  | { type: 'expired' }
  | { type: 'newLinkAsked' }

export function reduce(model: PoConfirmViewModel, event: PoConfirmEvent): PoConfirmViewModel {
  switch (event.type) {
    case 'read':
      // A newer read (after a refusal, or "Try again") keeps what was typed for the lines that are still there.
      return {
        ...model,
        link: 'valid',
        page: event.page,
        readFailed: false,
        answers: Object.fromEntries(Object.entries(model.answers).filter(([lineId]) => event.page.lines.some((line) => line.id === lineId))),
        sheet: model.sheet && event.page.lines.some((line) => line.id === model.sheet!.lineId) ? model.sheet : null,
      }
    case 'readFailed':
      return { ...model, link: event.link, readFailed: event.link === 'error' }
    case 'field':
      return { ...model, [event.field]: event.value, problem: null }
    case 'openLine': {
      const previous = model.answers[event.line.id]
      return { ...model, sheet: { lineId: event.line.id, draft: previous ?? draftOf(event.line, 'OTHER', event.locale), tried: false }, problem: null }
    }
    case 'sheetDraft':
      return model.sheet ? { ...model, sheet: { ...model.sheet, draft: event.draft } } : model
    case 'sheetKind':
      return model.sheet ? { ...model, sheet: { ...model.sheet, draft: draftOf(event.line, event.kind, event.locale, model.sheet.draft.kind === event.kind ? model.sheet.draft : { ...model.sheet.draft, kind: event.kind }) } } : model
    case 'sheetSave': {
      if (!model.sheet) return model
      const problems = draftProblems(event.line, model.sheet.draft, model.today, event.locale)
      if (hasProblems(problems)) return { ...model, sheet: { ...model.sheet, tried: true } }
      const answers = { ...model.answers }
      if (model.sheet.draft.kind === 'AS_ASKED') delete answers[model.sheet.lineId]
      else answers[model.sheet.lineId] = model.sheet.draft
      return { ...model, answers, sheet: null }
    }
    case 'sheetClose':
      return { ...model, sheet: null }
    case 'resetLine': {
      const answers = { ...model.answers }
      delete answers[event.lineId]
      return { ...model, answers }
    }
    case 'resetAll':
      return { ...model, answers: {} }
    case 'upload':
      return { ...model, upload: event.upload, problem: null }
    case 'declineOpen':
      return { ...model, declineOpen: event.open, problem: null, decline: event.open ? model.decline : { ...model.decline, tried: false } }
    case 'declineDraft':
      return { ...model, decline: { ...model.decline, reason: event.reason, note: event.note } }
    case 'declineTried':
      return { ...model, decline: { ...model.decline, tried: true } }
    case 'sending':
      return { ...model, send: 'busy', problem: null }
    case 'answered':
      return { ...model, page: event.page, done: event.done, send: 'idle', declineOpen: false, sheet: null, problem: null }
    case 'refused':
      return { ...model, send: 'idle', problem: event.problem, ...(event.link ? { link: event.link, declineOpen: false, sheet: null } : {}) }
    case 'expired':
      return model.done ? model : { ...model, link: 'expired', declineOpen: false, sheet: null }
    case 'newLinkAsked':
      return { ...model, newLinkAsked: true }
  }
}
