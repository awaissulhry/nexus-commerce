import type { BusinessDate } from '../core/time'
import type { WorkOrderStatus } from '../production/work-orders/machine' // of-fx5s (W-04)

/**
 * "Ask for a file" (order files tab B-OF-031 … B-OF-034; design order-files-2026-11-22 13-backend §2; Owner D2, D3): the pure rules
 * of an ask for a file on one sales order. apps/factory-api's modules/sales/file-asks applies them; factory-db's FileAsk and its
 * guard (…_order_files_guards) are the last word.
 *
 *   who      an office person, an office role, a floor role, a floor team, or whoever works a step of a work order (D2); a floor
 *            ask always lands on a work order and never asks for a file with prices or body data; never one named floor worker
 *   closes   only by files sent "for this ask", then Accept or Ask again (D3); a file held by the virus scan is never accepted; a
 *            Task ticked by hand moves nothing
 *   late     derived from the due day against the company's day, never stored
 *
 * Words it + en: the web's catalogue (`file-asks.json`) carries the screen words; these are the server's refusals and the words it
 * writes itself (Task titles, the chase note).
 */

export const FILE_ASK_TARGETS = ['SALES_ORDER', 'SALES_ORDER_LINE', 'WORK_ORDER'] as const
export type FileAskTarget = (typeof FILE_ASK_TARGETS)[number]

export const FILE_ASK_ADDRESSEES = ['PERSON', 'OFFICE_ROLE', 'FLOOR_ROLE', 'FLOOR_TEAM', 'STEP'] as const
export type FileAskAddressee = (typeof FILE_ASK_ADDRESSEES)[number]

/** The addressees that are the floor (no Task: the tablets of that team, role or step read the ask). */
export const FLOOR_ADDRESSEES = ['FLOOR_ROLE', 'FLOOR_TEAM', 'STEP'] as const satisfies readonly FileAskAddressee[]
export const isFloorAddressee = (kind: string): boolean => (FLOOR_ADDRESSEES as readonly string[]).includes(kind)

export const FILE_ASK_STATUSES = ['OPEN', 'ARRIVED', 'ACCEPTED', 'CANCELLED'] as const
export type FileAskStatus = (typeof FILE_ASK_STATUSES)[number]
/** The asks still in the "Waiting for files" band (an accepted one leaves it: its file says it). */
export const WAITING_ASK_STATUSES = ['OPEN', 'ARRIVED'] as const satisfies readonly FileAskStatus[]

/** The kinds of file an ask asks for (the upload's kinds; never a fiscal paper, a certificate or a voice note). */
export const FILE_ASK_KINDS = ['DOCUMENT', 'PHOTO', 'ATTACHMENT'] as const
export type FileAskKind = (typeof FILE_ASK_KINDS)[number]

export const FILE_ASK_DECISIONS = ['ACCEPTED', 'ASKED_AGAIN'] as const
export type FileAskDecision = (typeof FILE_ASK_DECISIONS)[number]
export const FILE_ASK_CHANGES = ['WORDS', 'DUE', 'ADDRESSEE', 'CHASED', 'CANCELLED'] as const
export type FileAskChange = (typeof FILE_ASK_CHANGES)[number]

export const FILE_ASK_LIMITS = Object.freeze({
  /** What is needed: one line of 1 to 500 characters. */
  words: 500,
  /** Why it is asked again or cancelled: 3 to 500 characters. */
  reasonMin: 3,
  reasonMax: 500,
  /** Files sent for one round. */
  files: 10,
  /** An office role reaches at most this many people (more: pick one person). */
  people: 20,
  /** A Task's title (platform tasks' TITLE_MAX). */
  title: 200,
})

/** One language's words, and both. */
export type AskLocale = 'it' | 'en'
export interface AskWords {
  readonly it: string
  readonly en: string
}

// ---- refusals ---------------------------------------------------------------------------------------------------------------
export const FILE_ASK_REFUSALS = [
  'NOT_OPEN',
  'NOT_ARRIVED',
  'FILES_HELD',
  'FILE_INFECTED',
  'FILE_NOT_OF_TARGET',
  'ORDER_CLOSED',
  'NOBODY_WITH_ROLE',
  'TOO_MANY_PEOPLE',
  'PERSON_CANNOT_SEE',
  'PERSON_NO_PRICES',
  'PERSON_NO_MEASUREMENTS',
  'FLOOR_NEEDS_WORK_ORDER',
  'FLOOR_NO_PRICES',
  'FLOOR_NO_BODY_DATA',
  'STEP_NEEDS_STEP',
  'WORK_ORDER_NOT_ON_FLOOR', // of-fx5s (W-04)
] as const
export type FileAskRefusal = (typeof FILE_ASK_REFUSALS)[number]

/** The refusals' words; `{name}` a person's name, `{n}` a count. */
export const FILE_ASK_REFUSAL_WORDS: Readonly<Record<FileAskRefusal, AskWords>> = Object.freeze({
  NOT_OPEN: { it: 'Questa richiesta non è più aperta: rileggila.', en: 'This ask is no longer open: read it again.' },
  NOT_ARRIVED: { it: 'Per questa richiesta non è arrivato nulla da controllare.', en: 'Nothing arrived for this ask to check.' },
  FILES_HELD: { it: '{n} {file} ancora in verifica antivirus: accetta quando la verifica è finita.', en: '{n} {file} still being checked by the virus scan: accept once the check is done.' },
  FILE_INFECTED: { it: "L'antivirus ha trovato qualcosa in un file inviato: chiedi di nuovo.", en: 'The virus scan found something in a file sent: ask again.' },
  FILE_NOT_OF_TARGET: { it: 'Per questa richiesta si inviano file della destinazione che indica.', en: 'Send files of the place this ask lands on.' },
  ORDER_CLOSED: { it: "Quest'ordine è chiuso: niente nuove richieste.", en: 'This order is closed: no new asks.' },
  NOBODY_WITH_ROLE: { it: "Nessuno con questo ruolo può vedere quest'ordine.", en: 'Nobody with this role can see this order.' },
  TOO_MANY_PEOPLE: { it: '{n} persone hanno questo ruolo: scegline una.', en: '{n} people have this role: pick one person.' },
  PERSON_CANNOT_SEE: { it: "{name} non può vedere quest'ordine.", en: '{name} cannot see this order.' },
  PERSON_NO_PRICES: { it: '{name} non vede i prezzi: scegli chi li vede.', en: '{name} does not see prices: pick someone who does.' },
  PERSON_NO_MEASUREMENTS: { it: '{name} non vede le misure: scegli chi le vede.', en: '{name} does not see measurements: pick someone who does.' },
  FLOOR_NEEDS_WORK_ORDER: { it: "Al reparto si chiede su un ordine di lavoro: scegli l'ordine di lavoro.", en: 'The floor is asked on a work order: pick the work order.' },
  FLOOR_NO_PRICES: { it: 'Il reparto non vede mai i prezzi: chiedi a qualcuno in ufficio.', en: 'The floor never sees prices: ask someone in the office.' },
  FLOOR_NO_BODY_DATA: { it: 'Il reparto non riceve mai le misure: chiedi a qualcuno in ufficio.', en: 'The floor never gets measurements: ask someone in the office.' },
  STEP_NEEDS_STEP: { it: 'Scegli la fase di cui chiedi a chi la lavora.', en: 'Pick the step whose worker is asked.' },
  // of-fx5s (W-04)
  WORK_ORDER_NOT_ON_FLOOR: {
    it: "Quest'ordine di lavoro non è in reparto: una richiesta al reparto vuole un ordine di lavoro rilasciato e ancora in corso.",
    en: 'This work order is not on the floor: a floor ask needs a released work order that is still running.',
  },
})

/** A refusal's words with its name or count filled in. */
export function refusalWords(code: FileAskRefusal, values: { readonly name?: string; readonly n?: number } = {}): AskWords {
  const many = (values.n ?? 1) !== 1
  const fill = (text: string, file: string): string => text.replace('{name}', values.name ?? '').replace('{n}', values.n === undefined ? '' : String(values.n)).replace('{file}', file)
  const words = FILE_ASK_REFUSAL_WORDS[code]
  return { it: fill(words.it, many ? 'file sono' : 'file è'), en: fill(words.en, many ? 'files are' : 'file is') }
}

/** What is wrong with where an ask lands and whom it asks (null: nothing): the floor only on a work order, never prices or body data. */
export function askShapeProblem(input: { readonly target: FileAskTarget; readonly addressee: FileAskAddressee; readonly priced: boolean; readonly bodyData: boolean; readonly hasStep: boolean }): FileAskRefusal | null {
  if (input.addressee === 'STEP' && input.target === 'WORK_ORDER' && !input.hasStep) return 'STEP_NEEDS_STEP'
  if (!isFloorAddressee(input.addressee)) return null
  if (input.target !== 'WORK_ORDER') return 'FLOOR_NEEDS_WORK_ORDER'
  if (input.priced) return 'FLOOR_NO_PRICES'
  if (input.bodyData) return 'FLOOR_NO_BODY_DATA'
  return null
}

// ---- of-fx5s (W-04, the look-only walk): the floor is asked only on a work order that is on the floor --------------------------
/** A work order on the floor: released and not finished (never DRAFT, COMPLETED, CLOSED or CANCELLED). */
export const ON_FLOOR_WORK_ORDER_STATUSES = ['RELEASED', 'IN_PROGRESS'] as const satisfies readonly WorkOrderStatus[]

/** Is the work order on the floor? ON_HOLD pauses it where it was: held from RELEASED or IN_PROGRESS it is, held from DRAFT it is not. */
export function workOrderOnFloor(workOrder: { readonly status: WorkOrderStatus; readonly heldFromStatus: WorkOrderStatus | null }): boolean {
  const at = workOrder.status === 'ON_HOLD' ? workOrder.heldFromStatus : workOrder.status
  return at !== null && (ON_FLOOR_WORK_ORDER_STATUSES as readonly string[]).includes(at)
}

/** A floor ask (FLOOR_ROLE, FLOOR_TEAM, STEP) on a work order not on the floor: WORK_ORDER_NOT_ON_FLOOR; null: fine (an office ask, or no work order: askShapeProblem's). */
export function floorAskProblem(addressee: FileAskAddressee, workOrder: { readonly status: WorkOrderStatus; readonly heldFromStatus: WorkOrderStatus | null } | null): FileAskRefusal | null {
  if (!isFloorAddressee(addressee) || workOrder === null) return null
  return workOrderOnFloor(workOrder) ? null : 'WORK_ORDER_NOT_ON_FLOOR'
}
// ---- end of-fx5s

/** Why the words of an ask or a reason are not taken (null: they are); `min` 1 for what is needed, 3 for a reason. */
export function askTextProblem(text: string, min: number, max: number = FILE_ASK_LIMITS.words): string | null {
  const trimmed = text.trim()
  if (/[\u0000-\u001f\u007f]/.test(text)) return 'One line, without line breaks.'
  if (trimmed.length < min) return min <= 1 ? 'Say what is needed.' : `At least ${min} characters.`
  if (text.length > max) return `At most ${max} characters.`
  return null
}

// ---- late, derived ----------------------------------------------------------------------------------------------------------
const DAY_MS = 24 * 60 * 60 * 1000
const dayNumber = (day: BusinessDate): number => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / DAY_MS

/** How many days late an ask due on `dueOn` is on `today` (the company's day); 0: not late. */
export function lateDaysOf(dueOn: BusinessDate, today: BusinessDate): number {
  return Math.max(0, Math.round(dayNumber(today) - dayNumber(dueOn)))
}

// ---- the words the server writes ----------------------------------------------------------------------------------------------
/** A person's language for the words written for them (their profile's; Italian by default). */
export const askLocaleOf = (locale: string | null | undefined): AskLocale => (locale?.toLowerCase().startsWith('en') ? 'en' : 'it')

const MONTHS: Readonly<Record<AskLocale, readonly string[]>> = Object.freeze({
  it: ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
})

/** A day as the asks say it: "25 Nov" / "25 nov". */
export function askDayWords(day: BusinessDate, locale: AskLocale): string {
  return `${Number(day.slice(8, 10))} ${MONTHS[locale][Number(day.slice(5, 7)) - 1] ?? ''}`
}

/** What a priced ask says instead of its words (counted, never named, for anyone who might read the line). */
export const PRICED_ASK_WORDS: AskWords = Object.freeze({ it: 'un file con prezzi', en: 'a file with prices' })

const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`)

/** The words an ask shows where a reader may not see prices: a priced ask's are never written out. */
const shownWords = (words: string, priced: boolean, locale: AskLocale): string => (priced ? PRICED_ASK_WORDS[locale] : words.trim())

/** The office addressee's Task: "Upload: {words}" / "Carica: {words}" (priced: "Upload: a file with prices"). */
export function uploadTaskTitle(words: string, priced: boolean, locale: AskLocale): string {
  const prefix = locale === 'en' ? 'Upload: ' : 'Carica: '
  return prefix + cut(shownWords(words, priced, locale), FILE_ASK_LIMITS.title - prefix.length)
}

/** The asker's Task once files arrived: "Check: {words}" / "Controlla: {words}". */
export function checkTaskTitle(words: string, priced: boolean, locale: AskLocale): string {
  const prefix = locale === 'en' ? 'Check: ' : 'Controlla: '
  return prefix + cut(shownWords(words, priced, locale), FILE_ASK_LIMITS.title - prefix.length)
}

/** The office note of "Ask for an update" (never a priced ask's words): "Ask for an update: {words}, due 28 Nov". */
export function chaseNoteText(words: string, priced: boolean, dueOn: BusinessDate, locale: AskLocale): string {
  return locale === 'en'
    ? `Ask for an update: ${shownWords(words, priced, 'en')}, due ${askDayWords(dueOn, 'en')}`
    : `Chiedi un aggiornamento: ${shownWords(words, priced, 'it')}, entro il ${askDayWords(dueOn, 'it')}`
}
