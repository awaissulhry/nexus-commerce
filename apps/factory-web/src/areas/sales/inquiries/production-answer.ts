import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { isoWeekKey, weekStart } from '@nexus/factory-domain/planning/settings/buckets'
import { mondayOfWeek, weekOf, type ProductionAnswer, type ProductionAnswerBody } from '@nexus/factory-domain/sales/inquiries/production-answer'
import type { InquiryRow, InquiryView, ProductionSuggestion } from './api'
import { refusalPhrase, type Loaded, type Notice, type Phrase, type Tone } from './model'

/**
 * B-TH-290 (threads plan TH-9, on the API's B-TH-094; N17, X-G04; features O-SAL-INQ-LIST.list-F10 "a 'Production' column with his
 * answer", .pane-head-F07 "Production answer chip", .pane-facts "typed by the production manager in Details, offered from planning's
 * promise read"): production's answer on a request — "OK" (we can make it) or "not before week N" — as Incoming shows it and as the
 * production manager types it. Pure: the words and tone of the chip and the cell, who may type it (held with why), the weeks offered,
 * the draft, its problems and the body, the suggestion's lines in our words, a refusal in our words. The API keeps the newest answer;
 * the history is the request's Changes. Office only (wall W37): the portal's request read has no such field and the customer's
 * pages never draw it. Words: `sales-inquiries` `production.*`.
 */

export type ProductionView = NonNullable<InquiryRow['production']>
export type { ProductionAnswer }

// ---- the chip and the cell ------------------------------------------------------------------------------------------------

/** Today in the company's time zone (YYYY-MM-DD): the weeks offered and "week 2 of 2027" are counted from it, as the API counts them. */
export function companyToday(now: Date = new Date(), timeZone = 'Europe/Rome'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** The design-system tone of an answer: OK green, not before a week amber (the API's POSITIVE / WARNING). */
export const productionTone = (view: Pick<ProductionView, 'tone'>): Tone => (view.tone === 'POSITIVE' ? 'success' : 'warning')

/**
 * The list's Production cell (the column names it: "OK", "Not before week 14", "Not before week 2 of 2027" when the week's ISO year
 * is not this one), null when production has not answered. Screen = file: the export writes the same answer.
 */
export function productionCell(view: Pick<ProductionView, 'answer' | 'week' | 'weekNumber'> | null | undefined, today: string): Phrase | null {
  if (!view) return null
  if (view.answer === 'OK' || !view.week) return { key: 'production.cell.OK' }
  const week = weekOf(mondayOfWeek(view.week) ?? today)
  const sameYear = week.year === weekOf(today).year
  return sameYear ? { key: 'production.cell.notBefore', params: { week: view.weekNumber ?? week.week } } : { key: 'production.cell.notBeforeYear', params: { week: view.weekNumber ?? week.week, year: week.year } }
}

/** "3 weeks after the wanted date" (a NOT_BEFORE later than the date the customer wants), null when in time or not known. */
export function productionLate(view: Pick<ProductionView, 'daysAfterWanted'> | null | undefined): Phrase | null {
  const days = view?.daysAfterWanted ?? null
  if (days === null || days <= 0) return null
  return days < 7 ? { key: 'production.late', params: { count: days } } : { key: 'production.lateWeeks', params: { count: Math.ceil(days / 7) } }
}

// ---- who types it -----------------------------------------------------------------------------------------------------------

/**
 * Whether this reader types production's answer on this request at all (the API's productionAction: planning.promise.manage over the
 * request's company and customer — the planner and the production manager). A reader who does not is told who does, never offered a
 * held button; a reader who does, on a closed request, sees the button held with why.
 */
export function answersHere(view: Pick<InquiryView, 'productionAction'>): boolean {
  const action = view.productionAction
  if (!action) return false
  return action.allowed || (action.refusal !== null && action.refusal.code !== 'NOT_PRODUCTION')
}

/** Why the answer cannot be typed now (null: it can): the request's own refusal (closed), the right, offline. */
export function productionHeld(view: Pick<InquiryView, 'productionAction' | 'number'>, offline: boolean): Phrase | null {
  const action = view.productionAction
  if (!action) return { key: 'production.held.notProduction' }
  if (!action.allowed) return action.refusal?.code === 'NOT_PRODUCTION' || !action.refusal ? { key: 'production.held.notProduction' } : refusalPhrase(action.refusal.code, view.number)
  if (offline) return { key: 'held.offline' }
  return null
}

// ---- the weeks offered --------------------------------------------------------------------------------------------------

export interface WeekChoice {
  /** `2026-W14`, what the body names. */
  readonly key: string
  readonly week: number
  readonly year: number
  /** Monday and Sunday of the week (YYYY-MM-DD). */
  readonly from: string
  readonly to: string
}

/** How far ahead the week picker reaches (a year: production plans no further on a request). */
export const WEEKS_AHEAD = 53

/** This week and the next ones (the API refuses a week that is over), each with its Monday and Sunday. */
export function weekChoices(today: string, count = WEEKS_AHEAD): WeekChoice[] {
  const first = weekStart(today)
  return Array.from({ length: count }, (_, index) => {
    const monday = plusDays(first, index * 7)
    const week = weekOf(monday)
    return { key: isoWeekKey(monday), week: week.week, year: week.year, from: monday, to: plusDays(monday, 6) }
  })
}

/** A week's line in the picker: "Week 14 · 30 Mar – 5 Apr" (with its year when it is not this one). */
export function weekPhrase(choice: WeekChoice, today: string): Phrase {
  return choice.year === weekOf(today).year
    ? { key: 'production.weekOption', params: { week: choice.week, from: choice.from, to: choice.to } }
    : { key: 'production.weekOptionYear', params: { week: choice.week, year: choice.year, from: choice.from, to: choice.to } }
}

// ---- the editor ---------------------------------------------------------------------------------------------------------------

export interface ProductionDraft {
  /** null: nothing picked yet (Save is held). */
  readonly answer: ProductionAnswer | null
  /** `2026-W14` for NOT_BEFORE; '' otherwise. */
  readonly week: string
}

export interface PlantChoice {
  readonly id: string
  readonly name: string
}

export interface ProductionEditor {
  readonly draft: ProductionDraft
  readonly weeks: readonly WeekChoice[]
  /** Planning's suggestion (nothing written): not asked (null: the reader does not read promise dates), being read, read, or why not. */
  readonly suggestion: Loaded<ProductionSuggestion> | null
  /** The plants to ask at when the company has several (null: the API takes its one plant). */
  readonly plants: readonly PlantChoice[] | null
  readonly plantId: string | null
  readonly busy: boolean
  readonly notice: Notice | null
}

export interface ProductionModel {
  /** The answer as the record shows it (null: production has not answered). */
  readonly current: ProductionView | null
  /** The reader types answers here (planning or the production manager): the button, the ⋯ line and the editor show. */
  readonly answers: boolean
  /** Why typing it is held now (null: it may). */
  readonly held: Phrase | null
  /** The editor in Details, when open. */
  readonly editor: ProductionEditor | null
  /** YYYY-MM-DD in the company's time zone: the weeks and the words are counted from it. */
  readonly today: string
}

export interface ProductionActions {
  /** Open the editor (Details' button, ⋯ "Production answer…", the head's chip for who may). */
  onOpen?: () => void
  onDraft?: (patch: Partial<ProductionDraft>) => void
  /** Ask planning again (a plant picked, a retry). */
  onSuggest?: (plantId: string | null) => void
  /** Copy planning's suggestion into the draft (the person still saves it). */
  onUseSuggestion?: () => void
  onSave?: () => void
  /** Take the answer back (production answered too early, or for the wrong request). */
  onTakeBack?: () => void
  onClose?: () => void
}

/** The draft the editor starts with: the answer as it is now (a week that is over: none picked), else nothing picked. */
export function productionDraftOf(current: Pick<ProductionView, 'answer' | 'week'> | null, today: string): ProductionDraft {
  if (!current) return { answer: null, week: '' }
  if (current.answer === 'OK') return { answer: 'OK', week: '' }
  const monday = current.week ? mondayOfWeek(current.week) : null
  return { answer: 'NOT_BEFORE', week: monday !== null && monday >= weekStart(today) ? current.week! : '' }
}

/** What keeps Save from being sent, each a key of `sales-inquiries`: an answer picked; for NOT_BEFORE a week, this one or later. */
export function productionProblems(draft: ProductionDraft, today: string): string[] {
  if (draft.answer === null) return ['production.problem.pick']
  if (draft.answer === 'OK') return []
  if (!draft.week) return ['production.problem.week']
  const monday = mondayOfWeek(draft.week)
  if (monday === null) return ['production.problem.week']
  if (monday < weekStart(today)) return ['production.problem.past']
  return []
}

/** The body of PUT …/production-answer: the request's version as read, OK or NOT_BEFORE with its week (never a week with OK). */
export function productionBodyOf(view: Pick<InquiryView, 'version'>, draft: ProductionDraft): ProductionAnswerBody {
  if (draft.answer === 'NOT_BEFORE') return { version: view.version, answer: 'NOT_BEFORE', week: draft.week }
  return { version: view.version, answer: 'OK' }
}

/** The body that takes the answer back. */
export const takeBackBodyOf = (view: Pick<InquiryView, 'version'>): ProductionAnswerBody => ({ version: view.version, answer: null })

/** The draft planning's suggestion makes (null: planning could not date it — the person answers alone). */
export function draftFromSuggestion(suggestion: Pick<ProductionSuggestion, 'suggestion'>): ProductionDraft | null {
  const { answer, week } = suggestion.suggestion
  if (answer === 'OK') return { answer: 'OK', week: '' }
  if (answer === 'NOT_BEFORE' && week) return { answer: 'NOT_BEFORE', week }
  return null
}

/** One line of the suggestion in our words: ready on a day (all sizes, or only some), or no date planning can promise. */
export function suggestionLine(line: ProductionSuggestion['lines'][number]): Phrase {
  if (line.date === null) return { key: 'production.suggest.lineNone', params: { seq: line.seq } }
  return { key: line.complete ? 'production.suggest.line' : 'production.suggest.linePart', params: { seq: line.seq, date: line.date } }
}

/** The receipt of a save in the page's words. */
export function savedNotice(view: Pick<InquiryView, 'number' | 'production'>): Notice {
  const production = view.production
  if (!production) return { key: 'production.done.takenBack', params: { number: view.number }, tone: 'success' }
  return production.answer === 'OK' || !production.weekNumber
    ? { key: 'production.done.savedOk', params: { number: view.number }, tone: 'success' }
    : { key: 'production.done.savedWeek', params: { number: view.number, week: production.weekNumber }, tone: 'success' }
}

/** A refused save in our words (the API's English is never shown): its refusal code, else the kind of failure. */
export function productionProblem(code: string | null, kind: string | null, number: string): { readonly phrase: Phrase; readonly stale: boolean; readonly retry: boolean } {
  if (code === 'NO_ANSWER') return { phrase: { key: 'production.problem.noAnswer' }, stale: false, retry: false }
  if (code) return { phrase: refusalPhrase(code, number), stale: false, retry: false }
  if (kind === 'conflict') return { phrase: { key: 'production.problem.stale' }, stale: true, retry: false }
  if (kind === 'invalid') return { phrase: { key: 'production.problem.invalid' }, stale: false, retry: false }
  if (kind === 'forbidden') return { phrase: { key: 'production.held.notProduction' }, stale: false, retry: false }
  if (kind === 'not_found') return { phrase: { key: 'problem.notFound' }, stale: false, retry: false }
  // A network failure or the API away: the same attempt (its Idempotency-Key) may go again.
  return { phrase: { key: 'production.problem.unavailable' }, stale: false, retry: true }
}

/** Why planning's suggestion could not be read, in our words (the plant: several to pick from, or none). */
export function suggestionProblem(kind: string | null, paths: readonly string[], plants: number): string {
  if (kind === 'invalid' && paths.some((path) => path.includes('siteId'))) return plants > 1 ? 'production.suggest.several' : 'production.suggest.noPlant'
  if (kind === 'forbidden') return 'production.suggest.forbidden'
  if (kind === 'not_found') return 'problem.notFound'
  return 'production.suggest.failed'
}
