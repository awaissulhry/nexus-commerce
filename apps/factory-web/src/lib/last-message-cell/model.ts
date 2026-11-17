/**
 * B-TH-230 — LastMessageCell, built in the factory web first (threads plan §2: one of the 8 new parts, the Owner's yes on decision 2,
 * 2026-11-17; it moves into packages/ui only on his word). The pure part: ONE read of a page of rows (POST /threads/unread, B-TH-027:
 * at most 200 records, one grouped count on the server), and the cell of each row — "2 new · 10:42", "99+ new", or empty.
 *
 * Brand wall (W08, W27, W37): the API counts only what the reader may open — a record the person may not read, or of another
 * customer for a portal person, counts 0 like a record without a thread (never "it exists"); a portal person counts only messages
 * shared with their party, never an office note; each person's count is their own (no "seen by"). The list asks only for the
 * rows it shows.
 */

/** The most records one read counts (the API's UNREAD_MAX: a page of a list). */
export const UNREAD_PAGE = 200

/** One record's new messages for the reader, and when the newest came (null: nothing new). */
export interface Unread {
  readonly newCount: number
  readonly lastAt: string | null
}

/** By record id. */
export type UnreadMap = Readonly<Record<string, Unread>>

export interface UnreadAsk {
  readonly recordType: string
  readonly recordId: string
}

/** What one page asks: each record once, in the list's order, at most UNREAD_PAGE (the first ones: what the page shows first). */
export function unreadAsk(rows: ReadonlyArray<{ readonly recordType: string; readonly id: string }>): UnreadAsk[] {
  const seen = new Set<string>()
  const asked: UnreadAsk[] = []
  for (const row of rows) {
    const key = `${row.recordType}:${row.id}`
    if (seen.has(key)) continue
    seen.add(key)
    asked.push({ recordType: row.recordType, recordId: row.id })
    if (asked.length === UNREAD_PAGE) break
  }
  return asked
}

/** The answer as the cells read it, by record id. */
export function unreadMapOf(counts: ReadonlyArray<{ readonly recordId: string; readonly newCount: number; readonly lastAt: string | null }>): UnreadMap {
  const map: Record<string, Unread> = {}
  for (const count of counts) map[count.recordId] = { newCount: count.newCount, lastAt: count.lastAt }
  return map
}

/** The cell: empty with nothing new (or not counted), else the count ("99+" above 99) and when the newest came. */
export type Cell = { readonly kind: 'empty' } | { readonly kind: 'new'; readonly count: number; readonly key: 'cell.count' | 'cell.many'; readonly lastAt: string | null }

export function cellOf(unread: Unread | undefined): Cell {
  if (!unread || unread.newCount <= 0) return { kind: 'empty' }
  return unread.newCount > 99 ? { kind: 'new', count: 99, key: 'cell.many', lastAt: unread.lastAt } : { kind: 'new', count: unread.newCount, key: 'cell.count', lastAt: unread.lastAt }
}

/** Sorting a column by its new messages: the count (0 for nothing new). */
export const unreadValue = (unread: Unread | undefined): number => unread?.newCount ?? 0
