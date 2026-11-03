import { MATERIAL_REASON_TILES } from '@nexus/factory-domain/production/calls/rules'
import { isApiError, issuePath } from '../api/errors'
import { formatNumber } from '../i18n/format'
import type { Locale } from '../i18n/locales'
import type { BoardHour, BoardOperation, BoardReason, LineBoard } from './schema'

/**
 * The line TV's rules (SCR-173, design floor.display; MES-147, MES-166, ANA-007), pure: the three views and their turn
 * every 20 seconds, the read every 10 seconds, the amber band after 60 seconds without a good read, the hour bars, and
 * what a refused read means. Shared by the Floor (a DISPLAY device) and the Office's preview tab.
 */

export const POLL_MS = 10_000
export const ROTATE_MS = 20_000
export const STALE_MS = 60_000

/** The board's views, in the order they turn ("View 1 of 3"). */
export const BOARD_VIEWS = ['output', 'stations', 'wip'] as const
export type BoardView = (typeof BOARD_VIEWS)[number]

/** The view after a step, round and round. */
export function stepView(view: number, step: 1 | -1, count: number = BOARD_VIEWS.length): number {
  return (view + step + count) % count
}

/** A board that has had no good read for a minute says so (a first read that never came has nothing to call stale). */
export const isStale = (lastGoodAt: number | null, now: number): boolean => lastGoodAt !== null && now - lastGoodAt >= STALE_MS

/** Why a board cannot be drawn. */
export type BoardProblem =
  /** This device is no line board (409 NOT_A_BOARD). */
  | 'notABoard'
  /** The board has no line set (409 NO_LINE). */
  | 'noLine'
  /** Read refused to this person (403, 404: the preview). */
  | 'noAccess'
  /** The device's token is gone (401): the floor app goes back to enrolment. */
  | 'signedOut'
  /** No answer: it keeps trying by itself. */
  | 'offline'

export function boardProblemOf(error: unknown): BoardProblem {
  if (!isApiError(error)) return 'offline'
  if (error.kind === 'signed_out') return 'signedOut'
  if (error.kind === 'forbidden' || error.kind === 'not_found') return 'noAccess'
  const refusal = error.issues.map(issuePath).find((path) => path.startsWith('refusal/'))
  if (refusal === 'refusal/NOT_A_BOARD') return 'notABoard'
  if (refusal === 'refusal/NO_LINE') return 'noLine'
  return 'offline'
}

export interface HourBar {
  readonly hour: number
  readonly label: string
  /** The hour's start alone, for the axis ("10"). */
  readonly tick: string
  readonly state: BoardHour['state']
  readonly done: number
  readonly target: number | null
  readonly short: boolean
  /** The bar's height and the target line's, as a percentage of the tallest (0–100). */
  readonly donePct: number
  readonly targetPct: number | null
  readonly reason: BoardReason | null
}

/** The hours as bars on one scale, the hourly target as a line on the same scale. */
export function hourBars(hours: readonly BoardHour[]): HourBar[] {
  const top = Math.max(1, ...hours.flatMap((hour) => [hour.done, hour.targetPieces ?? 0]))
  const share = (value: number) => Math.round((value / top) * 1000) / 10
  return hours.map((hour) => ({
    hour: hour.hour,
    label: hour.label,
    tick: hour.label.slice(0, 2),
    state: hour.state,
    done: hour.done,
    target: hour.targetPieces,
    short: hour.short,
    donePct: share(hour.done),
    targetPct: hour.targetPieces === null ? null : share(hour.targetPieces),
    reason: hour.reason,
  }))
}

/** A reason code's words in the screen's language; the code when it has none. */
export function reasonWords(reason: Pick<BoardReason, 'code' | 'labelIt' | 'labelEn' | 'labelI18n'>, locale: Locale): string {
  return reason.labelI18n[locale] ?? (locale === 'it' ? reason.labelIt : reason.labelEn) ?? reason.code
}

/** What a material call asks in the screen's language ("Ran out · 4"), or null: the tablet, Help calls and the line view (B-W2b-81; MES-137). */
export function callAskWords(call: { readonly reasonCode: string | null; readonly requestedQuantity: string | null }, locale: Locale): string | null {
  const tile = MATERIAL_REASON_TILES.find((entry) => entry.code === call.reasonCode)
  const reason = tile ? reasonWords({ ...tile, labelI18n: {} }, locale) : call.reasonCode
  const quantity = call.requestedQuantity === null ? null : formatNumber(Number(call.requestedQuantity), locale, { maximumFractionDigits: 4 })
  return [reason, quantity].filter((part) => part !== null).join(' · ') || null
}

/** The operations with bundles waiting, most first; the rest of the line's map says nothing on a wall. */
export function waitingOperations(operations: readonly BoardOperation[]): BoardOperation[] {
  return operations.filter((operation) => operation.bundles > 0).sort((a, b) => b.bundles - a.bundles || (a.code < b.code ? -1 : 1))
}

/** A handover note's topics (the schema's HandoverTopic); the board says each in words. */
export const NOTE_TOPICS = ['PROBLEMS', 'HALF_DONE_BUNDLES', 'MACHINES', 'MATERIAL', 'QUALITY', 'OTHER'] as const

/** A note's words on the wall: the topics it names and the text as written, only what was said. */
export function boardNoteLines(note: NonNullable<LineBoard['note']>): { readonly topics: readonly string[]; readonly text: string | null } {
  const text = note.text?.trim() ?? ''
  return { topics: note.topics.filter((topic) => (NOTE_TOPICS as readonly string[]).includes(topic)), text: text === '' ? null : text }
}
