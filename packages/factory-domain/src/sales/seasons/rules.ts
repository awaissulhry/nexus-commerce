import type { Words } from '../../approvals/rules'
import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'

/**
 * Seasons per company (B-W2b-303; SAL-277 "season on every order"; design sales.collections "Seasons", planning.mps), pure:
 * a company's seasons — the code a style keeps as its season text (FW27, SS28), a name, the days it runs and the last day its
 * order book takes orders — and the words the office reads. apps/factory-api modules/sales/seasons keeps them; a quote
 * version and an order name one OPEN season of their company (the database refuses a CLOSED one: B-W2b-279's guard).
 *
 *   state      OPEN (taking orders), BOOK_CLOSED (open, but its order book closed on orderBookClosesOn: an order may still
 *              name it, the office is told), ENDED (open, past its last day), CLOSED (by a person: no new quote or order
 *              names it; reopened, it is OPEN again)
 *   problems   the database's rules said first, in words: the code one line of 1 to 20 characters (letters, digits, space
 *              . _ / -), the name one line of 1 to 100, the note up to 2000, startsOn ≤ endsOn, the order book closing on or
 *              before the end
 */

export const SEASON_STATUSES = ['OPEN', 'CLOSED'] as const
export type SeasonStatus = (typeof SEASON_STATUSES)[number]
export const SEASON_STATES = ['OPEN', 'BOOK_CLOSED', 'ENDED', 'CLOSED'] as const
export type SeasonState = (typeof SEASON_STATES)[number]

export const SEASON_LIMITS = Object.freeze({ code: 20, name: 100, note: 2000, list: 500 })
export const SEASON_CODE = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,19}$/
const ONE_LINE = /^[^\r\n]+$/

export const SEASON_CHANGES = ['MADE', 'CHANGED', 'CLOSED', 'REOPENED'] as const
export type SeasonChange = (typeof SEASON_CHANGES)[number]

export interface SeasonFacts {
  readonly code: string
  readonly name: string
  readonly startsOn: BusinessDate
  readonly endsOn: BusinessDate
  readonly orderBookClosesOn: BusinessDate | null
  readonly note: string | null
}

/** What is wrong with a season as it would be written (paths under `at`), empty when nothing is. */
export function seasonProblems(season: SeasonFacts, at = 'body'): Issue[] {
  const issues: Issue[] = []
  if (!SEASON_CODE.test(season.code) || season.code !== season.code.trim()) issues.push({ path: `${at}/code`, message: 'A code of one line, 1 to 20 characters: letters, digits, space . _ / - (FW27).' })
  if (season.name.trim() === '' || !ONE_LINE.test(season.name) || season.name.trim().length > SEASON_LIMITS.name) issues.push({ path: `${at}/name`, message: `A name of one line, 1 to ${SEASON_LIMITS.name} characters.` })
  if (season.note !== null && season.note.length > SEASON_LIMITS.note) issues.push({ path: `${at}/note`, message: `At most ${SEASON_LIMITS.note} characters.` })
  if (season.endsOn < season.startsOn) issues.push({ path: `${at}/endsOn`, message: 'The season ends on or after the day it starts.' })
  if (season.orderBookClosesOn !== null && season.orderBookClosesOn > season.endsOn) issues.push({ path: `${at}/orderBookClosesOn`, message: 'The order book closes on or before the last day of the season.' })
  return issues
}

/** The season's state on `today` (Rome business day). */
export function seasonState(season: { readonly status: SeasonStatus; readonly endsOn: BusinessDate; readonly orderBookClosesOn: BusinessDate | null }, today: BusinessDate): SeasonState {
  if (season.status === 'CLOSED') return 'CLOSED'
  if (season.endsOn < today) return 'ENDED'
  if (season.orderBookClosesOn !== null && season.orderBookClosesOn < today) return 'BOOK_CLOSED'
  return 'OPEN'
}

export const SEASON_STATE_WORDS: Readonly<Record<SeasonState, Words>> = Object.freeze({
  OPEN: { en: 'Open: takes orders', it: 'Aperta: prende ordini' },
  BOOK_CLOSED: { en: 'Order book closed: an order may still name it', it: 'Raccolta ordini chiusa: un ordine può ancora indicarla' },
  ENDED: { en: 'Ended: past its last day', it: "Finita: oltre l'ultimo giorno" },
  CLOSED: { en: 'Closed: no new quote or order names it', it: 'Chiusa: nessuna nuova offerta o ordine la indica' },
})

/** The words said beside an order or quote that names the season on `today` (null: nothing to say). */
export function seasonNotice(season: { readonly code: string; readonly status: SeasonStatus; readonly endsOn: BusinessDate; readonly orderBookClosesOn: BusinessDate | null }, today: BusinessDate): Words | null {
  const state = seasonState(season, today)
  if (state === 'BOOK_CLOSED') return { en: `The order book of ${season.code} closed on ${season.orderBookClosesOn}.`, it: `La raccolta ordini di ${season.code} si è chiusa il ${season.orderBookClosesOn}.` }
  if (state === 'ENDED') return { en: `${season.code} ended on ${season.endsOn}.`, it: `${season.code} è finita il ${season.endsOn}.` }
  return null
}

/** The refusal of a CLOSED season named on a quote or an order (the database's 23514 said in words first). */
export const closedSeasonWords = (code: string): string => `Season ${code} is closed: name an open season, or reopen it first.`
