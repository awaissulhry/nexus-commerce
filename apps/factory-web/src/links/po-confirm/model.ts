import { lineDraftHasProblems, lineDraftProblems, lineResponseOutcome, lineResponseSummary, lineResponseSummaryParts, type LineDraft, type LineRequest, type LineSummaryKey } from '@nexus/ui/patterns/LineResponseList/index'
import type { AnswerOutcome, DeclineReason } from '@nexus/factory-domain/purchasing/confirm/answer'
import { MAX_TEXT, type PurchaseOrderStatus } from '@nexus/factory-domain/purchasing/orders'
import type { Locale } from '../../lib/i18n/locales'
import type { LinkState } from '../../shell/links/link-state'
import { lineBodyOf, parseQuantityIn } from '../../lib/po-answer/lines'
import type { ConfirmBody, LinkOrder, LinkOrderLine } from './api'

export { addDaysIso, dayIn, plainQuantity, quantityShown, quantityTyped } from '../../lib/po-answer/quantities'
export type { LineDraft } from '@nexus/ui/patterns/LineResponseList/index'

/**
 * SCR-100 — the supplier's confirm link (design links.po; B-W1-31/33; Owner answers P2 "the buyer always accepts or
 * refuses a supplier's proposals" and C2 "no prices on supplier screens"), pure: the page's state, what the answer comes to
 * (confirmed, a proposal the buyer decides, a decline), the request the API takes, and the supplier's PDF. Since B-W2b-179
 * the lines are answered with the DS LineResponseList (the supplier portal's same part and rules, "Propose a change": a split,
 * a substitute or another change when the link offers them); its drafts are kept here by line. The container
 * (PoConfirm.tsx) keeps the state with `reduce`; the view draws it.
 */

/** The largest confirmation PDF (the files platform takes 25 MB for a DOCUMENT; the page asks a little less). */
export const MAX_PDF_BYTES = 20 * 1024 * 1024
export const PDF_TYPE = 'application/pdf'

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
  /** What the answer held, as the review line's parts (null: a decline of the whole order). */
  readonly summary: readonly { readonly key: LineSummaryKey; readonly count: number }[] | null
  readonly fileName: string | null
  readonly supplierRef: string | null
}

export interface PoConfirmViewModel {
  /** The link itself: `valid` once the order was read. */
  link: LinkState
  page: LinkOrder | null
  /** The supplier's today (Europe/Rome), as the API checks dates. */
  today: string
  /** The lines answered other than "as asked", by line id (the DS part's drafts). */
  answers: Readonly<Record<string, LineDraft>>
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

/** A line as the answer's rules read it (the asked values; the words are the view's). */
export const askedOf = (line: LinkOrderLine): LineRequest => ({ id: line.id, seq: line.seq, title: '', asked: { quantity: line.quantity, plain: line.quantity, unit: '', date: line.needDate, dateText: line.needDate } })

// ---- the whole answer ------------------------------------------------------------------------------------------------------

export interface AnswerPreview {
  readonly mode: 'ALL_AS_ASKED' | 'BY_LINE'
  /** What it comes to (as the DS part and the API say it: all as asked, all cannot, else a proposal). */
  readonly outcome: AnswerOutcome
  /** The review line's parts ("2 lines as asked · 1 later date"). */
  readonly summary: readonly { readonly key: LineSummaryKey; readonly count: number }[]
  /** Every line in the API's terms. */
  readonly lines: ReturnType<typeof lineBodyOf>[]
}

/**
 * The answer as it stands: every line as asked is "confirm all as asked"; anything else goes line by line. Null when a
 * line's answer is not complete (the part's own rules: the sheet holds it, so this is a guard).
 */
export function answerPreview(page: LinkOrder, answers: Readonly<Record<string, LineDraft>>, today: string, locale: Locale): AnswerPreview | null {
  const requests = page.lines.map(askedOf)
  const rules = { today, parseQuantity: parseQuantityIn(locale) }
  if (requests.some((line) => answers[line.id] && lineDraftHasProblems(lineDraftProblems(line, answers[line.id]!, rules)))) return null
  const changed = page.lines.some((line) => answers[line.id] && answers[line.id]!.kind !== 'AS_ASKED')
  return {
    mode: changed ? 'BY_LINE' : 'ALL_AS_ASKED',
    outcome: lineResponseOutcome(requests, answers),
    summary: lineResponseSummaryParts(lineResponseSummary(requests, answers, rules)),
    lines: page.lines.map((line) => lineBodyOf(line.id, answers[line.id], locale)),
  }
}

export const clean = (value: string): string | null => {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** The confirm request for the answer as it stands. */
export function confirmBody(model: PoConfirmViewModel, preview: AnswerPreview): ConfirmBody {
  const page = model.page!
  return {
    version: page.order.version,
    mode: preview.mode,
    ...(preview.mode === 'BY_LINE' ? { lines: preview.lines } : {}),
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

/** The first and last day the goods are expected by when everything is confirmed as asked (the end state's sentence). */
export function expectedSpan(lines: readonly Pick<LinkOrderLine, 'needDate'>[]): { first: string; last: string } | null {
  const days = lines.map((line) => line.needDate).sort()
  return days.length === 0 ? null : { first: days[0]!, last: days[days.length - 1]! }
}

// ---- the page's state ---------------------------------------------------------------------------------------------------------

export type PoConfirmEvent =
  | { type: 'read'; page: LinkOrder }
  | { type: 'readFailed'; link: LinkState }
  | { type: 'field'; field: 'supplierRef' | 'typedName' | 'note'; value: string }
  /** A line's answer saved in the part's sheet (null: as asked again). */
  | { type: 'answer'; lineId: string; draft: LineDraft | null }
  | { type: 'allAsAsked' }
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
      }
    case 'readFailed':
      return { ...model, link: event.link, readFailed: event.link === 'error' }
    case 'field':
      return { ...model, [event.field]: event.value, problem: null }
    case 'answer': {
      const answers = { ...model.answers }
      if (event.draft && event.draft.kind !== 'AS_ASKED') answers[event.lineId] = event.draft
      else delete answers[event.lineId]
      return { ...model, answers, problem: null }
    }
    case 'allAsAsked':
      return { ...model, answers: {}, problem: null }
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
      return { ...model, page: event.page, done: event.done, send: 'idle', declineOpen: false, problem: null }
    case 'refused':
      return { ...model, send: 'idle', problem: event.problem, ...(event.link ? { link: event.link, declineOpen: false } : {}) }
    case 'expired':
      return model.done ? model : { ...model, link: 'expired', declineOpen: false }
    case 'newLinkAsked':
      return { ...model, newLinkAsked: true }
  }
}
