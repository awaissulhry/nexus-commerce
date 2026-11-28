import type { SheetFilter, SheetRowRead, SheetTiles } from '../../../sales/orders/list/office-sheet/api'
import { TILES } from '../../../sales/orders/list/office-sheet/map'
import { departmentNoOf } from '../../../../lib/orders-sheet/rows'

/**
 * owb-of4 step 2 — Today re-faced (design § 5zk, § 5zl: "the same counter tile as Orders and Today"), pure: the six tiles of the
 * orders sheet (Incoming · Waiting for the print · In production · Problems · Late · Ready to ship), each a door to the sheet's own
 * filter; "The factory now" — the pieces of the orders in production, department by department (their stage); "Last changes" — the
 * orders changed last (the sheet read is newest change first). Every number is a read's own; a read that did not answer is one quiet
 * line, never a made-up number.
 */

export const TODAY_NS = 'today'

/** The sheet's address with its filter (`/sales/orders?life=…`; All is the sheet itself). */
export const sheetHrefOf = (prefix: string, filter: SheetFilter): string => `${prefix}/sales/orders${filter === 'all' ? '' : `?life=${filter}`}`

/** The six tiles as Today draws them: the sheet's own tiles and doors (one map, `office-sheet/map.ts` TILES). */
export function todayTilesOf(tiles: SheetTiles, prefix: string): Array<{ readonly id: keyof SheetTiles; readonly count: number; readonly tone: (typeof TILES)[number]['tone']; readonly href: string; readonly filter: SheetFilter }> {
  return TILES.map((tile) => ({ id: tile.id, count: tiles[tile.id], tone: tile.tone, filter: tile.filter, href: sheetHrefOf(prefix, tile.filter) }))
}

/** "The factory now": the pieces of the orders in production in each fixed department (by the order's stage); null: none in production. */
export function piecesByDepartmentOf(rows: readonly SheetRowRead[]): ReadonlyMap<number, number> | null {
  const out = new Map<number, number>()
  for (const row of rows) {
    const no = departmentNoOf(row)
    if (no === null) continue
    out.set(no, (out.get(no) ?? 0) + row.pieces)
  }
  return out.size > 0 ? out : null
}

/** "Last changes": the orders changed last, newest first (the read's own order), at most `count`. */
export const lastChangedOf = (rows: readonly SheetRowRead[], count = 5): readonly SheetRowRead[] => rows.slice(0, count)

/** The page of a row: an order's own page; a draft or a sent order today's office page (L3). */
export const rowHrefOf = (prefix: string, row: Pick<SheetRowRead, 'kind' | 'id'>): string => (row.kind === 'REQUEST' ? `${prefix}/sales/orders/new?draft=${encodeURIComponent(row.id)}` : `${prefix}/sales/orders/${encodeURIComponent(row.id)}`)
