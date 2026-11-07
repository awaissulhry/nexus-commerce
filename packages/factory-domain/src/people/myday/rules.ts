import { monthAfter, type PayWindow } from '../earnings/rules'
import { dayTotals, hourRows, paceOf, type HourFacts, type HourRow, type HourTarget, type Pace } from '../../production/boards/hourly'

/**
 * My day (B-W2b-68; MES-111, MES-112, MES-205, MES-206, MES-261; c.c. art. 2101; GDPR art. 15; design floor.myday), pure. The
 * worker's OWN day on a tablet other people can see, so the rules are about what may be on the screen:
 *
 *   PIN        the screen always starts on the PIN pad (Owner answer F1), even after a PIN sign-in: the API's window of two
 *              minutes stands for "still me" at the moment of a read, and someone else may stand at the tablet by then
 *   close      nothing touched for MYDAY_CLOSE_AFTER_MS, shorter than a station's idle time: the figures leave the screen
 *   stored     nothing of it is kept on the tablet: no cache, no queue, no as-of memory. Offline it is held with that reason
 *   pieces     their own records: always shown (GDPR art. 15)
 *   minutes    earned minutes, efficiency and pace are one person's work figures: only with the site's PERFORMANCE legal gate
 *              on (Statuto dei Lavoratori art. 4 c.1). Off, the worker is told why; nothing is computed
 *   pace       the worker's own pieces against the LINE's target, nothing else: no line output, no average, no other person
 *              (Owner answer F2); there is no target per person (B-W2b-50)
 *   money      only for a month the site's piece-pay switch covers, own entries only (GATE-PIECE-PAY); `pay` grain
 */

/** The figures leave the screen after this long without a touch (design: 60 s, shorter than the station's idle time). */
export const MYDAY_CLOSE_AFTER_MS = 60_000

/** The months a worker can step back to from this one (a statement is theirs to read). */
export const MYDAY_MONTHS_BACK = 12

/** How long an answered dispute keeps the tile's badge, days. */
export const MYDAY_ANSWER_DAYS = 14

/** The most answers the tile reads. */
export const MYDAY_ANSWER_ROWS = 50

export interface MyDayRefusal {
  readonly code: string
  readonly message: string
  readonly fix: string
}

/** Refusals in words (409 `refusal/<CODE>` + `fix`). */
export const MYDAY_REFUSALS = Object.freeze({
  NOT_APPROVED: { code: 'NOT_APPROVED', message: 'This statement is not approved yet: it may still change.', fix: 'It can be printed once HR has approved it.' },
  PHONE_ONLY: { code: 'PHONE_ONLY', message: 'A shared tablet keeps no statement.', fix: 'Print it at the office, or open it on your own phone.' },
  NO_PRINTER: { code: 'NO_PRINTER', message: 'The tablet does not know which printer is the office one.', fix: 'Ask the office to print your statement.' },
}) satisfies Readonly<Record<string, MyDayRefusal>>

// ---- pace -----------------------------------------------------------------------------------------------------------

export interface MyPace {
  /** The worker's own good pieces on the line today (solo reports). */
  readonly done: number
  /** The line's target for the whole day; null: none set. */
  readonly target: number | null
  /** The line's target for the hours since the worker's first report; null: no target counts yet. */
  readonly targetSoFar: number | null
  /** The running hour's target. */
  readonly hourTarget: number | null
  /** done ÷ targetSoFar in whole percent, for the ring; null: no target counts yet. */
  readonly percent: number | null
  readonly pace: Pace
}

export interface MyPaceFacts {
  /** The line's hours with their targets. The line's output is never an input. */
  readonly hours: readonly HourRow[]
  readonly done: number
  /** The worker's first report on the line today: someone who started later is not held to the hours before it. */
  readonly since: Date | null
  readonly now: Date
}

/** The line's target hours as hour rows, with no output in them (the pace must not be able to see it). */
export const targetHours = <Target extends HourTarget>(facts: Pick<HourFacts<Target>, 'day' | 'timeZone' | 'now' | 'targets'>): HourRow<Target>[] => hourRows({ ...facts, done: new Map(), workingMinutes: new Map() })

/** The worker's pace (MES-112). Nothing about anyone else goes in, so nothing about anyone else can come out. */
export function myPaceOf(facts: MyPaceFacts): MyPace {
  const { done, since, now } = facts
  const target = dayTotals(facts.hours, now).target
  const hourTarget = facts.hours.find((hour) => hour.state === 'RUNNING')?.target?.targetPieces ?? null
  if (since === null) return { done, target, targetSoFar: null, hourTarget, percent: null, pace: 'NO_TARGET' }
  const { targetSoFar } = dayTotals(facts.hours.filter((hour) => hour.end.getTime() > since.getTime()), now)
  const counted = targetSoFar !== null && targetSoFar > 0 ? targetSoFar : null
  return { done, target, targetSoFar: counted, hourTarget, percent: counted === null ? null : Math.round((done * 100) / counted), pace: paceOf(done, counted) }
}

// ---- money ----------------------------------------------------------------------------------------------------------

/** The site's piece-pay switch covers some day of the month: a window starts before the month ends and ends after it starts. */
export function monthPays(windows: readonly PayWindow[], month: string): boolean {
  const first = `${month}-01`
  const next = `${monthAfter(month)}-01`
  return windows.some((window) => window.from < next && (window.to === null || window.to > first))
}

// ---- the office printer ---------------------------------------------------------------------------------------------

/**
 * Without a printer named in People settings: the site's ONE active A4 printer. With several the tablet cannot know which one
 * stands in the office, and one person's pay must not come out at the dock: held, in words, until the office names one.
 */
export function officePrinterOf<Printer>(printers: readonly Printer[]): Printer | null {
  return printers.length === 1 ? printers[0]! : null
}

/** A printer as the statement's choice reads it. */
export interface StatementPrinterFacts {
  readonly kind: string
  readonly status: string
}

/**
 * The printer a statement goes to "in your name" (design floor.myday; B-W2b-89 PeopleSettings.statementPrinterId): the one the
 * office named for the company's statements, wherever it stands, while it is an ACTIVE A4 printer. Named and archived (or
 * gone): held, never another printer in its place, because the office chose where pay comes out. Named nothing: the site's
 * only active A4 printer (`officePrinterOf`).
 */
export function statementPrinterOf<Printer extends StatementPrinterFacts>(named: { readonly id: string | null; readonly printer: Printer | null }, sitePrinters: readonly Printer[]): Printer | null {
  if (named.id === null) return officePrinterOf(sitePrinters)
  return named.printer && named.printer.kind === 'A4_PDF' && named.printer.status === 'ACTIVE' ? named.printer : null
}
