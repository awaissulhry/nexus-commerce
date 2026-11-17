import { z } from 'zod'
import { daysFrom, plusDays } from '../../calendars/dates'
import { businessDate as businessDateField, id, input, instant, output } from '../../core/contracts'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import { isoWeekKey, weekStart } from '../../planning/settings/buckets'
// B-PR-24: the one reading of planning's answer that leaves planning — a date only, never a load (shared with the customer's ask).
import { dateOnly, type DatedLine } from '../../planning/promise/date-only'

/**
 * B-TH-094 (threads plan TH-9, N17, X-G04; features O-SAL-INQ-LIST.list-F10 "a 'Production' column with his answer",
 * O-SAL-INQ-LIST.pane-head-F07 "Production answer chip"): production's answer on a customer's request, pure. The production
 * manager (who records promise dates: planning.promise.manage, and reads requests: sales.inquiries.view) types it on the
 * request: OK ("we can make it"), or NOT_BEFORE with the ISO week it can be ready at the earliest ("not before week 14"),
 * stored as that week's Monday (factory-db Inquiry.productionNotBefore, a date only, never a load). Planning's promise read
 * (ATP / capable to promise, modules/planning/promise) OFFERS a suggestion; the person types the answer. The newest answer is
 * shown; the history is the request's Changes (the audit). Office only: never on a portal or link answer (the partner role
 * cannot read the four columns, ownership/sales-intake.json); a closed request keeps the answer it had.
 */

export const PRODUCTION_ANSWERS = ['OK', 'NOT_BEFORE'] as const
export type ProductionAnswer = (typeof PRODUCTION_ANSWERS)[number]

export interface Words {
  readonly it: string
  readonly en: string
}

// ---- weeks ------------------------------------------------------------------------------------------------------------

/** An ISO week as the body names it: `2026-W14` (the week of the year's first Thursday is week 1). */
export const WEEK_KEY = /^(\d{4})-W(\d{2})$/

/** The Monday of an ISO week key, or null when the key names no week of that year (`2026-W54`, `2026-W00`). */
export function mondayOfWeek(key: string): BusinessDate | null {
  const match = WEEK_KEY.exec(key)
  if (!match) return null
  const year = Number.parseInt(match[1]!, 10)
  const week = Number.parseInt(match[2]!, 10)
  if (week < 1 || week > 53) return null
  // Week 1 holds 4 January.
  const monday = plusDays(weekStart(`${match[1]}-01-04`), (week - 1) * 7)
  return isoWeekKey(monday) === `${String(year).padStart(4, '0')}-W${match[2]}` ? monday : null
}

/** The week key and its number of a Monday (any day: its week). */
export function weekOf(day: BusinessDate): { readonly key: string; readonly year: number; readonly week: number; readonly monday: BusinessDate } {
  const key = isoWeekKey(day)
  const match = WEEK_KEY.exec(key)!
  return { key, year: Number.parseInt(match[1]!, 10), week: Number.parseInt(match[2]!, 10), monday: weekStart(day) }
}

// ---- words ------------------------------------------------------------------------------------------------------------

/** The week in words: "week 14", or "week 2 of 2027" when its ISO year is not today's. */
function weekWords(monday: BusinessDate, today: BusinessDate): Words {
  const week = weekOf(monday)
  if (week.year === weekOf(today).year) return { it: `settimana ${week.week}`, en: `week ${week.week}` }
  return { it: `settimana ${week.week} del ${week.year}`, en: `week ${week.week} of ${week.year}` }
}

/** The chip's words ("Production: OK", "Production: not before week 14"). */
export function productionWords(answer: ProductionAnswer, notBefore: BusinessDate | null, today: BusinessDate): Words {
  if (answer === 'OK' || notBefore === null) return { it: 'Produzione: OK', en: 'Production: OK' }
  const week = weekWords(notBefore, today)
  return { it: `Produzione: non prima della ${week.it}`, en: `Production: not before ${week.en}` }
}

/** The tone of the chip: OK green, NOT_BEFORE amber (the web maps it to its design-system tone). */
export const productionTone = (answer: ProductionAnswer): 'POSITIVE' | 'WARNING' => (answer === 'OK' ? 'POSITIVE' : 'WARNING')

// ---- the body and its problems ----------------------------------------------------------------------------------------

/** What the body names, before it is checked: the answer (null: take the answer back) and, for NOT_BEFORE, the week. */
export interface ProductionAnswerAsked {
  readonly answer: ProductionAnswer | null
  readonly week?: string | undefined
}

/** The answer to store, or the problems in words (body paths). `today`: the request's company's day (Europe/Rome). */
export function checkedProductionAnswer(asked: ProductionAnswerAsked, today: BusinessDate): { readonly ok: true; readonly answer: ProductionAnswer | null; readonly notBefore: BusinessDate | null } | { readonly ok: false; readonly path: string; readonly words: Words } {
  if (asked.answer === null) {
    if (asked.week !== undefined) return { ok: false, path: 'body/week', words: PRODUCTION_REFUSAL_WORDS.WEEK_WITHOUT_NOT_BEFORE }
    return { ok: true, answer: null, notBefore: null }
  }
  if (asked.answer === 'OK') {
    if (asked.week !== undefined) return { ok: false, path: 'body/week', words: PRODUCTION_REFUSAL_WORDS.WEEK_WITHOUT_NOT_BEFORE }
    return { ok: true, answer: 'OK', notBefore: null }
  }
  if (asked.week === undefined) return { ok: false, path: 'body/week', words: PRODUCTION_REFUSAL_WORDS.WEEK_NEEDED }
  const monday = mondayOfWeek(asked.week)
  if (monday === null) return { ok: false, path: 'body/week', words: PRODUCTION_REFUSAL_WORDS.NOT_A_WEEK }
  if (monday < weekStart(today)) return { ok: false, path: 'body/week', words: PRODUCTION_REFUSAL_WORDS.WEEK_PAST }
  return { ok: true, answer: 'NOT_BEFORE', notBefore: monday }
}

/** The refusals of an answer, in words (409 / 400 / 403; the API throws the English, the screen shows the reader's language). */
export const PRODUCTION_REFUSAL_WORDS = Object.freeze({
  WEEK_NEEDED: { it: 'Indica la settimana: "non prima della settimana N".', en: 'Name the week: "not before week N".' },
  WEEK_WITHOUT_NOT_BEFORE: { it: 'Una settimana va solo con "non prima della settimana N".', en: 'A week goes only with "not before week N".' },
  NOT_A_WEEK: { it: 'Non è una settimana dell\'anno: scrivi la settimana come 2026-W14.', en: 'Not a week of the year: write the week as 2026-W14.' },
  WEEK_PAST: { it: 'Questa settimana è già passata: indica questa settimana o una successiva.', en: 'That week is over: name this week or a later one.' },
  NO_ANSWER: { it: 'La produzione non ha ancora risposto a questa richiesta: non c\'è niente da ritirare.', en: 'Production has not answered this request yet: there is nothing to take back.' },
  NOT_PRODUCTION: {
    it: 'La risposta della produzione la scrive chi registra le date promesse (pianificazione o responsabile di produzione).',
    en: 'Production\'s answer is typed by whoever records promise dates (planning or the production manager).',
  },
} satisfies Record<string, Words>)
export type ProductionRefusalCode = keyof typeof PRODUCTION_REFUSAL_WORDS

// ---- the suggestion from planning's promise read ----------------------------------------------------------------------

/** One line as the promise engine answered it (its date: every size asked ready; null: none promised). */
// B-PR-24: declared once in planning/promise/date-only, kept exported here.
export type { DatedLine }

/**
 * What planning's answer suggests: OK when every line was dated, completely, by the wanted date (or, with no wanted date, this
 * week); NOT_BEFORE the week of the latest line's date otherwise; nothing when no line could be dated (the person answers
 * alone). A line left out (asked in words, no colour, no sizes) makes the suggestion partial: said, never OK.
 */
export function suggestedAnswer(lines: readonly DatedLine[], leftOut: number, wantedDate: BusinessDate | null, today: BusinessDate): { readonly answer: ProductionAnswer | null; readonly notBefore: BusinessDate | null; readonly readyDate: BusinessDate | null; readonly partial: boolean; readonly words: Words } {
  // B-PR-24: the shared reading — the latest line's date and whether it is partial, nothing else of planning's answer.
  const { date: readyDate, partial } = dateOnly(lines, leftOut)
  if (readyDate === null) {
    return {
      answer: null,
      notBefore: null,
      readyDate: null,
      partial: true,
      words: { it: 'La pianificazione non può datare questa richiesta (nessuna riga con modello, colore e taglie): rispondi tu.', en: 'Planning cannot date this request (no line with a style, a colour and sizes): answer it yourself.' },
    }
  }
  const inTime = wantedDate !== null ? readyDate <= wantedDate : weekStart(readyDate) <= weekStart(today)
  const said = partial ? { it: ' Solo alcune righe sono datate.', en: ' Only some lines are dated.' } : { it: '', en: '' }
  if (inTime && !partial) {
    return { answer: 'OK', notBefore: null, readyDate, partial, words: { it: `Pronto entro il ${readyDate}: la pianificazione suggerisce OK.`, en: `Ready by ${readyDate}: planning suggests OK.` } }
  }
  const monday = weekStart(readyDate)
  const week = weekWords(monday, today)
  return {
    answer: 'NOT_BEFORE',
    notBefore: monday,
    readyDate,
    partial,
    words: { it: `Pronto il ${readyDate}: la pianificazione suggerisce "non prima della ${week.it}".${said.it}`, en: `Ready on ${readyDate}: planning suggests "not before ${week.en}".${said.en}` },
  }
}

/** Why a request's line is not asked of planning (the suggestion names each line left out). */
export const LEFT_OUT_WORDS = Object.freeze({
  NO_STYLE: { it: 'Chiesta a parole: nessun modello da pianificare (crea la bozza del modello, poi sceglilo sulla riga).', en: 'Asked in words: no style to plan (make the style draft, then pick it on the line).' },
  STYLE_UNKNOWN: { it: 'Il modello della riga non si legge qui.', en: "The line's style cannot be read here." },
  NO_COLOUR: { it: 'Nessun colore del modello scelto: la pianificazione data un modello in un colore.', en: "No colourway of the style picked: planning dates a style in one colourway." },
  NO_SIZES: { it: 'Nessun pezzo per taglia.', en: 'No pieces by size.' },
} satisfies Record<string, Words>)

/** A line whose sizes are not all in its style's range. */
export const sizesOutsideWords = (sizes: readonly string[], range: readonly string[]): Words => ({
  it: `Taglie fuori dalla gamma del modello (${range.join(', ')}): ${sizes.join(', ')}.`,
  en: `Sizes outside the style's range (${range.join(', ')}): ${sizes.join(', ')}.`,
})

/** The export's words of the Production column (`production.OK`, `production.NOT_BEFORE` + the week key). */
export const PRODUCTION_EXPORT_WORDS = Object.freeze({
  OK: { it: 'OK', en: 'OK' },
  NOT_BEFORE: { it: 'Non prima della settimana', en: 'Not before week' },
} satisfies Record<ProductionAnswer, Words>)

/** Days a NOT_BEFORE answer lies after the wanted date (null: no wanted date, or OK). For the screen's "3 weeks late". */
export const daysAfterWanted = (notBefore: BusinessDate | null, wantedDate: BusinessDate | null): number | null => (notBefore !== null && wantedDate !== null && isBusinessDate(wantedDate) ? Math.max(0, daysFrom(wantedDate, notBefore)) : null)

// ---- contracts --------------------------------------------------------------------------------------------------------

const words = output({ it: z.string(), en: z.string() })

/**
 * PUT /sales/inquiries/:inquiryId/production-answer: `answer` OK | NOT_BEFORE (with `week`, `2026-W14`, this week or later), or
 * null to take the answer back; `version`: the request's, as read.
 */
export const productionAnswerBody = input({
  version: z.number().int().min(1),
  answer: z.enum(PRODUCTION_ANSWERS).nullable(),
  week: z.string().trim().regex(WEEK_KEY, 'Write the week as 2026-W14.').optional(),
})
export type ProductionAnswerBody = z.output<typeof productionAnswerBody>

/** The answer on a request's row and record (null: production has not answered). */
export const productionView = output({
  answer: z.enum(PRODUCTION_ANSWERS),
  /** NOT_BEFORE: the Monday of the week (null for OK). */
  notBefore: businessDateField().nullable(),
  /** NOT_BEFORE: `2026-W14` and its number (null for OK). */
  week: z.string().nullable(),
  weekNumber: z.number().int().nullable(),
  words,
  tone: z.enum(['POSITIVE', 'WARNING']),
  /** NOT_BEFORE after the wanted date: by how many days (null: no wanted date, or OK). */
  daysAfterWanted: z.number().int().nullable(),
  answeredAt: instant(),
  /** Who answered, by name: in the record only (a row names nobody). */
  answeredBy: output({ id: id(), name: z.string() }).nullable().optional(),
})

/** The record's "Production answer" action for this reader: allowed, or held with why (code + words). */
export const productionActionView = output({
  allowed: z.boolean(),
  refusal: output({ code: z.string(), message: z.string(), words: words.optional() }).nullable(),
})

export const productionSuggestionQuery = input({ siteId: id().optional() })

/** GET /sales/inquiries/:inquiryId/production-answer/suggestion: what planning's promise read suggests (nothing is written). */
export const productionSuggestionView = output({
  inquiry: output({ id: id(), number: z.string(), version: z.number().int(), wantedDate: businessDateField().nullable() }),
  site: output({ id: id(), code: z.string(), name: z.string() }),
  today: businessDateField(),
  suggestion: output({
    answer: z.enum(PRODUCTION_ANSWERS).nullable(),
    notBefore: businessDateField().nullable(),
    week: z.string().nullable(),
    readyDate: businessDateField().nullable(),
    partial: z.boolean(),
    words,
  }),
  lines: z.array(output({ lineId: id(), seq: z.number().int(), date: businessDateField().nullable(), complete: z.boolean(), meetsWanted: z.boolean().nullable(), words: z.string(), warnings: z.array(z.string()) })),
  leftOut: z.array(output({ lineId: id(), seq: z.number().int(), why: words })),
  /** The answer production gave so far (null: none). */
  current: productionView.nullable(),
})
