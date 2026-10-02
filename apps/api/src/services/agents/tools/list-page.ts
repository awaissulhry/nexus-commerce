/**
 * MCP full control P5 — one way to page a platform read (lib/pagination/cursor.ts underneath).
 *
 * Two shapes of list:
 *   · a SMALL list read whole (a business's attributes, families, markets, mapping rules — hundreds at most): sorted in
 *     memory on a text key that ends with the row id, and paged after the cursor's key (`pageInMemory`);
 *   · a GROWING list (job history, saved views) read from the database newest first, after the cursor's row
 *     (`newestFirstAfter` builds the `where`, `newestFirstPosition` the cursor).
 *
 * Either way the cursor is bound to the tool, the business and the filters (`listScope`): a cursor from another list,
 * other filters or another business is refused (InvalidCursorError → "called wrongly"), never a page of something
 * else. A page that is not the last says how to go on.
 */
import { workspaceIdForQuery } from '../../../lib/workspace-context.js'
import {
  InvalidCursorError,
  cursorScope,
  decodeCursor,
  encodeCursor,
  fitPage,
  pageSize,
  type CursorPosition,
} from '../../../lib/pagination/cursor.js'
import type { ToolResult } from '../tool-types.js'

/** The cursor scope of one list: the tool, the business and every argument except the page size and the cursor. */
export function listScope(tool: string, args: Record<string, unknown>): string {
  const { limit: _limit, cursor: _cursor, ...filters } = args
  return cursorScope(tool, { business: workspaceIdForQuery(), ...filters })
}

export interface ListPage<T> {
  items: T[]
  nextCursor: string | null
  total: number
  hint?: string
}

/** Said on a page that is not the last. */
const goOn = (shown: number, total: number) =>
  `${total} match; this page has ${shown}. To go on, call again with cursor set to nextCursor (same arguments).`

/**
 * One page of a list read whole. `keyOf` must give every row its own key, in the order the list is read (ending with
 * the row's id makes it so); the next page starts strictly after the cursor's key.
 */
export function pageInMemory<T>(rows: readonly T[], keyOf: (row: T) => string, args: Record<string, unknown>, scope: string): ListPage<T> {
  const size = pageSize(args.limit as number | undefined)
  const sorted = [...rows].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))
  const position = decodeCursor(scope, args.cursor as string | undefined)
  const after = position ? sorted.filter((row) => keyOf(row) > position.id) : sorted
  const positionOf = (row: T): CursorPosition => ({ values: [], id: keyOf(row) })
  const page = fitPage(
    { items: after.slice(0, size), nextCursor: after.length > size ? encodeCursor(scope, positionOf(after[size - 1])) : null },
    scope,
    positionOf,
  )
  return {
    items: page.items,
    nextCursor: page.nextCursor,
    total: rows.length,
    ...(page.nextCursor ? { hint: goOn(page.items.length, rows.length) } : {}),
  }
}

/** The rows strictly older than the cursor's row, newest first by (createdAt, id). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a `where` fragment every model's AND accepts
export function newestFirstAfter(scope: string, cursor: unknown): Record<string, any> {
  const position = decodeCursor(scope, cursor as string | undefined)
  if (!position) return {}
  const [at] = position.values
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) throw new InvalidCursorError()
  const createdAt = new Date(at)
  return { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: position.id } }] }
}

/** The cursor of a row in a newest-first list. */
export const newestFirstPosition = (row: { id: string; createdAt: Date }): CursorPosition =>
  ({ values: [row.createdAt.toISOString()], id: row.id })

/** One newest-first page from rows read with `take: size + 1` (the extra row only says another page exists). */
export function newestFirstPage<T extends { id: string; createdAt: Date }, U>(
  rows: readonly T[],
  size: number,
  scope: string,
  view: (row: T) => U,
): { items: U[]; nextCursor: string | null; hint?: string } {
  const kept = rows.slice(0, size)
  const nextCursor = rows.length > size && kept.length ? encodeCursor(scope, newestFirstPosition(kept[kept.length - 1])) : null
  return {
    items: kept.map(view),
    nextCursor,
    ...(nextCursor ? { hint: 'More rows match. To go on, call again with cursor set to nextCursor (same arguments).' } : {}),
  }
}

/** A bad cursor is a wrongly made call, said the way call-tool.ts says one; anything else is a real failure. */
export async function listTool(name: string, work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof InvalidCursorError) return { ok: false, error: `${name} was called wrongly — cursor: ${error.message}` }
    throw error
  }
}

export { pageSize }
