/**
 * MCP.9 — opaque keyset cursors for list reads (the agent tools first).
 *
 * A list is read in a fixed order that ends with the row id, so every row has exactly one place in it. A cursor names
 * the last row of a page — its sort values and its id — and the next page starts strictly after that row: no row comes
 * twice and none is skipped, however many rows share a sort value. (An offset does both whenever a row is added or
 * removed between two pages.) The same shape as the listing-issues view's cursor
 * (services/cx/listing-issues-view.service.ts), made reusable.
 *
 * A cursor is base64url JSON with a check made from the list it belongs to: the caller's `scope` names the list, the
 * business and the filters. A cursor that was altered, or that comes from another list, other filters or another
 * business, fails the check and is refused with InvalidCursorError — never a crash, never a page of a different list.
 * The check is not a secret: at most a caller moves within a list it may already read.
 *
 * Every list returns `{ items, nextCursor, total? }`; `nextCursor` is null on the last page. A page is also held under
 * MAX_RESULT_BYTES of JSON (fitPage): above it the page is cut, and the list says so and asks for a filter.
 */
import { createHash } from 'node:crypto'

export const DEFAULT_PAGE_SIZE = 25
export const MAX_PAGE_SIZE = 100
/** The most JSON one list result may hold. A page above it is cut, and the rest follows on the next page. */
export const MAX_RESULT_BYTES = 50_000
/** Longer than any cursor this file writes; a longer one was not written here. */
export const MAX_CURSOR_LENGTH = 2048

const VERSION = 1
const MAX_SORT_VALUES = 8
const MAX_TEXT = 512

export type SortValue = string | number | boolean | null

/** The last row of a page: its sort values, in the list's order, and its id (the final tie-break). */
export interface CursorPosition {
  values: SortValue[]
  id: string
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
  total?: number
}

export class InvalidCursorError extends Error {
  readonly code = 'invalid_arguments' as const
  constructor() {
    super('this cursor is not valid for this list: it was changed, or it came from a call with other filters or '
      + 'from another business. Call again without cursor to start from the first page.')
    this.name = 'InvalidCursorError'
  }
}

/** Rows per page: the default when absent or not a number, otherwise clamped to 1…MAX_PAGE_SIZE. */
export function pageSize(limit?: number | null): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_PAGE_SIZE
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(limit)))
}

/** JSON with sorted keys and no undefined values, so the same filters always give the same scope. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

/** What a cursor is bound to: the list's name and everything that decides which rows it holds (business, filters). */
export function cursorScope(list: string, parts: Record<string, unknown>): string {
  return JSON.stringify([list, canonical(parts)])
}

function check(scope: string, position: CursorPosition): string {
  return createHash('sha256').update(JSON.stringify([VERSION, scope, position.values, position.id])).digest('base64url').slice(0, 22)
}

const sortValue = (value: unknown): value is SortValue =>
  value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
  || (typeof value === 'string' && value.length <= MAX_TEXT)

export function encodeCursor(scope: string, position: CursorPosition): string {
  return Buffer.from(JSON.stringify({ v: VERSION, k: position.values, id: position.id, s: check(scope, position) })).toString('base64url')
}

/** The position a cursor names, or null when there is none (the first page). Throws InvalidCursorError. */
export function decodeCursor(scope: string, cursor: string | null | undefined): CursorPosition | null {
  if (cursor == null || cursor === '') return null
  if (typeof cursor !== 'string' || cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidCursorError()
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new InvalidCursorError()
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new InvalidCursorError()
  const { v, k, id, s } = payload as Record<string, unknown>
  if (v !== VERSION || !Array.isArray(k) || k.length > MAX_SORT_VALUES || !k.every(sortValue)
    || typeof id !== 'string' || id.length === 0 || id.length > MAX_TEXT || typeof s !== 'string') throw new InvalidCursorError()
  const position: CursorPosition = { values: k, id }
  if (s !== check(scope, position)) throw new InvalidCursorError()
  return position
}

/**
 * One page from rows read in the list's order with `take: size + 1`: the extra row only says that another page exists,
 * and the cursor names the last row the caller gets.
 */
export function pageOf<T>(rows: T[], size: number, scope: string, positionOf: (row: NoInfer<T>) => CursorPosition): Page<T> {
  const items = rows.slice(0, size)
  const last = items.at(-1)
  return { items, nextCursor: rows.length > size && last !== undefined ? encodeCursor(scope, positionOf(last)) : null }
}

/**
 * A page cut to fit `maxBytes` of JSON. Items are kept from the front while they fit, and always at least one, so a
 * caller that follows nextCursor always moves on; when any is cut, the cursor names the last item kept and the next
 * page starts right after it. `cut` = how many items this page left for the next one.
 */
export function fitPage<T>(page: Page<T>, scope: string, positionOf: (item: NoInfer<T>) => CursorPosition, maxBytes = MAX_RESULT_BYTES): Page<T> & { cut: number } {
  let bytes = 2
  let kept = 0
  for (const item of page.items) {
    const size = Buffer.byteLength(JSON.stringify(item) ?? 'null') + 1
    if (kept > 0 && bytes + size > maxBytes) break
    bytes += size
    kept++
  }
  if (kept === page.items.length) return { ...page, cut: 0 }
  const items = page.items.slice(0, kept)
  return { ...page, items, nextCursor: encodeCursor(scope, positionOf(items[kept - 1])), cut: page.items.length - kept }
}
