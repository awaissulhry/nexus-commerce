import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'

/**
 * A line's hourly targets (B-W2b-50; MES-084; design production.floor "Hour by hour": "targets are line targets, never
 * per person (Civil Code art. 2100 pacing note in the InfoTip)"; andon.prisma LineTarget), pure. A target is the pieces a
 * LINE should put out of its last operation in one hour of one day (0-23 in the site's time zone). The office sets them
 * for today or a later day; a day already past is history (its short hours and their reasons rest on the targets it had).
 *
 * MES-084 says "per line and operator": the operator part is never built (Owner answer F2; Statuto dei Lavoratori art. 4):
 * a pace per person would be a per-person figure. My day (B-W2b-68) shows the worker alone the line's hourly target.
 *
 * Refusals are words with the one thing to do (`refusal/<CODE>` and `fix` on a 409), as the floor screens read them.
 */

export const TARGET_LIMITS = Object.freeze({
  /** The pieces of one hour, at most (a typing slip, not a target). */
  maxPieces: 100_000,
  /** The hours of one day. */
  hours: 24,
  /** A short hour's words. */
  note: 500,
})

export interface BoardRefusal {
  readonly code: string
  readonly message: string
  readonly fix: string
}

const refusal = (code: string, message: string, fix: string): BoardRefusal => Object.freeze({ code, message, fix })

export const BOARD_REFUSALS = Object.freeze({
  PAST_DAY: refusal('PAST_DAY', "A past day's targets are history: its short hours and their reasons rest on them.", 'Set the targets of today or a later day.'),
  REASON_GIVEN: refusal('REASON_GIVEN', 'The team leader gave the reason for this short hour: removing its target would drop it.', 'Change the pieces instead, or keep the target.'),
  NOT_LINE_OF_SITE: refusal('NOT_LINE_OF_SITE', 'This line is not an active line of the site.', 'Pick an active line of the site.'),
  HOUR_NOT_OVER: refusal('HOUR_NOT_OVER', 'This hour is not over yet.', 'Give the reason once the hour has ended.'),
  NOT_SHORT: refusal('NOT_SHORT', 'This hour reached its target: there is nothing to explain.', 'Pick an hour that ended below its target.'),
  CODE_NOT_LISTED: refusal('CODE_NOT_LISTED', 'This reason is not an active code of the downtime reason list.', 'Pick a reason from the list, or ask the office to add it (Floor rules & codes).'),
  NOTE_NEEDED: refusal('NOTE_NEEDED', 'This reason needs a few words.', 'Say in a few words what happened.'),
  NO_LINE: refusal('NO_LINE', 'This device shows no line.', 'An administrator names the line of this device (Admin › Devices & printers).'),
  NOT_A_BOARD: refusal('NOT_A_BOARD', 'Only a line board (a DISPLAY device) shows the board with nobody signed in.', 'Sign in on this device, or make it a line board (Admin › Devices & printers).'),
})

export type BoardRefusalCode = keyof typeof BOARD_REFUSALS

/** One hour asked for in a change of a day's targets: its pieces, or null to remove it; the version the caller read. */
export interface TargetDraft {
  readonly hour: number
  readonly targetPieces: number | null
  readonly version?: number | undefined
}

/** Problems with a day's target changes (paths `hours/<i>/hour`, `hours/<i>/targetPieces`). */
export function targetDraftProblems(drafts: readonly TargetDraft[]): Issue[] {
  const issues: Issue[] = []
  if (drafts.length === 0) issues.push({ path: 'hours', message: 'Name at least one hour.' })
  const seen = new Set<number>()
  drafts.forEach((draft, index) => {
    if (!Number.isInteger(draft.hour) || draft.hour < 0 || draft.hour >= TARGET_LIMITS.hours) issues.push({ path: `hours/${index}/hour`, message: 'An hour of the day: 0 to 23.' })
    else if (seen.has(draft.hour)) issues.push({ path: `hours/${index}/hour`, message: `${hourLabel(draft.hour)} is named twice.` })
    seen.add(draft.hour)
    if (draft.targetPieces !== null && (!Number.isInteger(draft.targetPieces) || draft.targetPieces < 0 || draft.targetPieces > TARGET_LIMITS.maxPieces)) {
      issues.push({ path: `hours/${index}/targetPieces`, message: `Whole pieces from 0 to ${TARGET_LIMITS.maxPieces}, or empty to remove the hour's target.` })
    }
  })
  return issues
}

/** A day before today (both in the site's zone) is past. */
export const isPastDay = (day: BusinessDate, today: BusinessDate): boolean => day < today

/** An hour's label: `10:00–11:00`. */
export function hourLabel(hour: number): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(hour)}:00–${pad((hour + 1) % 24)}:00`
}

export interface StoredTarget {
  readonly id: string
  readonly hour: number
  readonly targetPieces: number
  readonly version: number
  /** The team leader gave the reason for its short hour. */
  readonly reasonGiven: boolean
}

export interface TargetPlan {
  /** Hours with no target yet. */
  readonly create: readonly { readonly hour: number; readonly targetPieces: number }[]
  /** Targets whose pieces change. */
  readonly change: readonly { readonly target: StoredTarget; readonly targetPieces: number }[]
  readonly remove: readonly StoredTarget[]
  /** Asked with the pieces it has (or removed with none there): nothing to do. */
  readonly unchanged: readonly number[]
  /** The first refusal, when the change cannot be made at all. */
  readonly refusal: { readonly refusal: BoardRefusal; readonly hour: number } | null
  /** An hour whose version the caller read is no longer the stored one (a 409: read again). */
  readonly stale: { readonly hour: number; readonly stored: number; readonly sent: number } | null
}

/** What a change of a day's targets does to the stored ones (pure: the API writes it in one command). */
export function targetPlan(stored: readonly StoredTarget[], drafts: readonly TargetDraft[]): TargetPlan {
  const byHour = new Map(stored.map((target) => [target.hour, target]))
  const create: { hour: number; targetPieces: number }[] = []
  const change: { target: StoredTarget; targetPieces: number }[] = []
  const remove: StoredTarget[] = []
  const unchanged: number[] = []
  let refused: TargetPlan['refusal'] = null
  let stale: TargetPlan['stale'] = null
  for (const draft of [...drafts].sort((a, b) => a.hour - b.hour)) {
    const target = byHour.get(draft.hour)
    if (target && draft.version !== undefined && draft.version !== target.version) {
      stale ??= { hour: draft.hour, stored: target.version, sent: draft.version }
      continue
    }
    if (draft.targetPieces === null) {
      if (!target) unchanged.push(draft.hour)
      else if (target.reasonGiven) refused ??= { refusal: BOARD_REFUSALS.REASON_GIVEN, hour: draft.hour }
      else remove.push(target)
      continue
    }
    if (!target) create.push({ hour: draft.hour, targetPieces: draft.targetPieces })
    else if (target.targetPieces === draft.targetPieces) unchanged.push(draft.hour)
    else change.push({ target, targetPieces: draft.targetPieces })
  }
  return { create, change, remove, unchanged, refusal: refused, stale }
}

export interface ShortReasonFacts {
  /** The hour has ended (now ≥ its end). */
  readonly over: boolean
  readonly done: number
  readonly targetPieces: number
  /** The code asked for, as the downtime list has it (null: not in the list). */
  readonly code: { readonly active: boolean; readonly needsDetail: boolean } | null
  readonly note: string | null
}

/**
 * Whether the team leader (or the office) may give this reason now: the hour is over, it ended below its target, the code
 * is an active code of the DOWNTIME list, and an "Other" code (needsDetail) comes with words. A reason already given is
 * replaced (the audit row keeps the earlier one).
 */
export function shortReasonRefusal(facts: ShortReasonFacts): BoardRefusal | null {
  if (!facts.over) return BOARD_REFUSALS.HOUR_NOT_OVER
  if (facts.done >= facts.targetPieces) return BOARD_REFUSALS.NOT_SHORT
  if (!facts.code || !facts.code.active) return BOARD_REFUSALS.CODE_NOT_LISTED
  if (facts.code.needsDetail && (facts.note ?? '').trim() === '') return BOARD_REFUSALS.NOTE_NEEDED
  return null
}

/** The reason list a short hour's reason comes from (factory-domain reasons/lists). */
export const SHORT_REASON_LIST = 'DOWNTIME' as const
