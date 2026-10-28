import { GRAINS, type Grain } from '../auth/grains/grains'
import { isMarkedJson, looksLikeMoney } from '../money/marked'

/**
 * The record timeline (feature COL-002: comments, emails, changes, status moves and files in one feed, newest first,
 * with filter chips), the pure part. The timeline is not stored: the API reads its sources — the record's audit rows,
 * the messages of the record's thread, the record's files — each newest first from a cursor, and merges them here.
 * Every source orders by (time, id) and every id is a UUID unique across the tables, so (time, id) is one total order
 * and a cursor of the last entry shown continues every source exactly where the page ended.
 */

export const TIMELINE_KINDS = ['message', 'change', 'file'] as const
export type TimelineKind = (typeof TIMELINE_KINDS)[number]

export interface Positioned {
  readonly at: Date
  readonly id: string
}

/** Where a page ended: the last entry shown. */
export type TimelineCursor = Positioned

const CURSOR = /^(\d{1,15})_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

/** `<epoch milliseconds>_<id>`: opaque to the screens, readable in a log. */
export function encodeCursor(cursor: TimelineCursor): string {
  return `${cursor.at.getTime()}_${cursor.id}`
}

/** The cursor a screen sent back, or null when it is not one. */
export function decodeCursor(value: string): TimelineCursor | null {
  const match = CURSOR.exec(value)
  if (!match) return null
  const at = new Date(Number(match[1]))
  return Number.isFinite(at.getTime()) ? { at, id: match[2]! } : null
}

/** Newest first: the later time, then the larger id. */
export function compareNewestFirst(a: Positioned, b: Positioned): number {
  const time = b.at.getTime() - a.at.getTime()
  if (time !== 0) return time
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

/** True when `entry` comes after the cursor in a newest-first feed (it belongs to the next page). */
export function isAfterCursor(entry: Positioned, cursor: TimelineCursor | null): boolean {
  return cursor === null || compareNewestFirst(cursor, entry) < 0
}

/**
 * Merges sources that are each sorted newest first and each hold up to `limit + 1` entries after the cursor: the
 * first `limit` of them all, and whether more follow.
 */
export function mergeNewestFirst<T extends Positioned>(sources: readonly (readonly T[])[], limit: number): { items: T[]; more: boolean } {
  const all = sources.flat().sort(compareNewestFirst)
  return { items: all.slice(0, limit), more: all.length > limit }
}

export interface ChangeSummary {
  /** The status move the change recorded (`status` before and after, plain strings), or null. */
  readonly status: { readonly from: string | null; readonly to: string | null } | null
  /** The top-level fields that changed, sorted. Money ones only for a caller who may see them. */
  readonly fields: string[]
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * What an audit row changed, said without any value: its status move and the names of the fields that changed. A field
 * whose value is marked money (`markMoney`) is named only for a caller who holds its grain; a field whose name looks
 * like money but is not marked only for a caller who holds every grain (fail closed, as the grain filter does). The
 * values themselves travel only in the before/after of a caller with audit.read, through the grain filter.
 */
export function changeSummary(before: unknown, after: unknown, held: ReadonlySet<Grain>): ChangeSummary {
  const from = isPlainObject(before) ? before : {}
  const to = isPlainObject(after) ? after : {}
  const everyGrain = GRAINS.every((grain) => held.has(grain))
  const fields: string[] = []
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    const previous = from[key]
    const next = to[key]
    if (JSON.stringify(previous) === JSON.stringify(next)) continue
    const marked = [previous, next].find(isMarkedJson)
    if (marked ? !held.has(marked.$money) : looksLikeMoney(key) && !everyGrain) continue
    fields.push(key)
  }
  const plain = (value: unknown): string | null => (typeof value === 'string' ? value : null)
  const status =
    fields.includes('status') && (typeof from.status === 'string' || typeof to.status === 'string')
      ? { from: plain(from.status), to: plain(to.status) }
      : null
  return { status, fields: fields.sort() }
}
