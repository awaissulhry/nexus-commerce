import type { BusinessDate } from '../../core/time'

/**
 * B-PR-24 (production plan Appendix B "Promise dates", review fix R-32): the ONE reading of planning's promise answer that
 * leaves planning towards a customer or a request — a date only, never a load. Shared by the customer's ask (the impact's
 * earliest date before Send: sales/change-requests/impact) and production's answer on a request (threads B-TH-094:
 * sales/inquiries/production-answer suggestedAnswer).
 *
 * Planning's answer per line (modules/planning/promise engine AskAnswer) carries much more: the steps and their lanes, the
 * size groups, the bridge of the date, the minutes booked, warnings. None of it may reach a customer: it names lines, lanes,
 * workers' capacity and, through shared capacity, the load other customers' orders put on the plant. This helper reads only
 * three fields of each line and builds a NEW object of three fields, so nothing else can travel on by a spread:
 *
 *   date         the latest line's date (every line asked ready); null when no line could be dated
 *   partial      some line is not dated, not every size of it is promised, or a line was left out of the question
 *                (asked in words, no colourway, no sizes); also when nothing was asked at all
 *   meetsWanted  false when some line misses the wanted date; true when every line meets it; null when no wanted date was
 *                given (or a line could not say)
 */

/** One line as planning's promise engine answered it (its date: every size asked ready; null: none promised). */
export interface DatedLine {
  readonly date: BusinessDate | null
  readonly complete: boolean
  readonly meetsWanted: boolean | null
}

/** A date only: what may leave planning about when something can be ready. */
export interface DateOnly {
  readonly date: BusinessDate | null
  readonly partial: boolean
  readonly meetsWanted: boolean | null
}

/** The date only of planning's answer (`leftOut`: lines not asked of planning at all). */
export function dateOnly(lines: readonly DatedLine[], leftOut = 0): DateOnly {
  let date: BusinessDate | null = null
  for (const line of lines) if (line.date !== null && (date === null || line.date > date)) date = line.date
  const partial = leftOut > 0 || lines.length === 0 || lines.some((line) => !line.complete || line.date === null)
  const meetsWanted = lines.some((line) => line.meetsWanted === false) ? false : lines.length > 0 && lines.every((line) => line.meetsWanted === true) ? true : null
  return Object.freeze({ date, partial, meetsWanted })
}

/** The keys a date only holds, and nothing else (the wall test reads them). */
export const DATE_ONLY_KEYS = Object.freeze(['date', 'partial', 'meetsWanted'] as const)
