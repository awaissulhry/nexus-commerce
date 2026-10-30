import type { Issue } from '../../core/errors'
import type { ExceptionCondition, ExceptionKind } from './detect'

/**
 * An exception's life (B-W2a-22; PLN-193; design planning.exceptions "an inbox you clear: acknowledge, snooze, resolve";
 * "planning.run.finished → Queue replaced; acknowledged items stay acknowledged"; factory-db PlanningException), pure.
 *
 * One row per condition while it is unresolved, across runs:
 *   found again      the unresolved row of its key takes the run's facts (last run, last seen, impact, requirement); a
 *                    snooze "until the next run" ends (its three columns are cleared); an acknowledgement stays
 *   found first      a NEW row, occurrence = one more than the key's earlier ones (1 the first time)
 *   not found again  RESOLVED by the run: CLEARED (no person, no note) — only for the kinds the run evaluates
 *
 *   acknowledge  NEW → ACKNOWLEDGED, once (who and when); the person becomes its owner when it has none ("Mine")
 *   snooze       an unresolved row, until a later moment or until the next run; snoozing again replaces the snooze
 *   resolve      NEW or ACKNOWLEDGED → RESOLVED, HANDLED by a person with a note (3 to 1000 characters); a later run that
 *                finds the condition again opens a new occurrence
 */

export const EXCEPTION_STATUSES = ['NEW', 'ACKNOWLEDGED', 'RESOLVED'] as const
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number]
export const EXCEPTION_RESOLUTIONS = ['HANDLED', 'CLEARED'] as const
export type ExceptionResolution = (typeof EXCEPTION_RESOLUTIONS)[number]

export const RESOLVE_NOTE = Object.freeze({ min: 3, max: 1000 })
/** At most this many exceptions in one acknowledgement. */
export const MAX_EXCEPTIONS_PER_ACTION = 200

/** An unresolved row as the run reads it. */
export interface OpenException {
  readonly id: string
  readonly kind: ExceptionKind
  readonly dedupeKey: string
  readonly status: ExceptionStatus
  readonly snoozedAt: Date | null
  readonly snoozedUntil: Date | null
}

export interface RunRefresh<Row extends OpenException> {
  readonly found: readonly { readonly row: Row; readonly condition: ExceptionCondition; readonly endSnooze: boolean }[]
  readonly raised: readonly ExceptionCondition[]
  readonly cleared: readonly Row[]
}

/** What a run does to the site's unresolved exceptions, given what it found. */
export function refreshOf<Row extends OpenException>(open: readonly Row[], conditions: readonly ExceptionCondition[], evaluated: readonly ExceptionKind[]): RunRefresh<Row> {
  const byKey = new Map(open.map((row) => [row.dedupeKey, row]))
  const seen = new Set<string>()
  const found: { row: Row; condition: ExceptionCondition; endSnooze: boolean }[] = []
  const raised: ExceptionCondition[] = []
  for (const condition of conditions) {
    seen.add(condition.key)
    const row = byKey.get(condition.key)
    if (row) found.push({ row, condition, endSnooze: row.snoozedAt !== null && row.snoozedUntil === null })
    else raised.push(condition)
  }
  const cleared = open.filter((row) => !seen.has(row.dedupeKey) && evaluated.includes(row.kind))
  return { found, raised, cleared }
}

/** Snoozed now: snoozed, and until a moment still ahead or until the next run. */
export const isSnoozed = (row: { readonly snoozedAt: Date | null; readonly snoozedUntil: Date | null }, now: Date): boolean =>
  row.snoozedAt !== null && (row.snoozedUntil === null || row.snoozedUntil.getTime() > now.getTime())

/** Why an exception cannot be acknowledged now (a 409), or null. */
export function acknowledgeProblem(row: { readonly status: ExceptionStatus }): string | null {
  if (row.status === 'RESOLVED') return 'The exception is resolved already.'
  if (row.status === 'ACKNOWLEDGED') return 'The exception is acknowledged already.'
  return null
}

/** Why an exception cannot be snoozed until then (a 409 or 400), or null. */
export function snoozeProblems(row: { readonly status: ExceptionStatus }, until: Date | null, now: Date): { conflict: string | null; issues: Issue[] } {
  if (row.status === 'RESOLVED') return { conflict: 'A resolved exception is not snoozed.', issues: [] }
  if (until !== null && until.getTime() <= now.getTime()) return { conflict: null, issues: [{ path: 'body/until', message: 'Snooze until a later moment, or until the next run.' }] }
  return { conflict: null, issues: [] }
}

/** Why an exception cannot be resolved with this note, or null. */
export function resolveProblems(row: { readonly status: ExceptionStatus }, note: string | null | undefined): { conflict: string | null; issues: Issue[] } {
  if (row.status === 'RESOLVED') return { conflict: 'The exception is resolved already.', issues: [] }
  const text = note?.trim() ?? ''
  if (text.length < RESOLVE_NOTE.min) return { conflict: null, issues: [{ path: 'body/note', message: 'Say in a few words how it was handled.' }] }
  if (text.length > RESOLVE_NOTE.max) return { conflict: null, issues: [{ path: 'body/note', message: `At most ${RESOLVE_NOTE.max} characters.` }] }
  return { conflict: null, issues: [] }
}
