import type { Board, BoardRow, Cell, CellDetail } from '../api'
import type { StatusModel } from '../view/types'

/**
 * SCR-119 › Not sold there (B-W2b-288, FU2:02): the design cases `w2b-288-not-sold-*`, spread into SCR-119's own cases
 * (status/fixtures.ts) on its made-up board. DEMO-JKT-01 is sold in Italia only: Germania, Francia and Spagna say "Not sold
 * there" (—), never a gap; its row counts as ready when Italia is.
 */

const notSold = (marketCode: string): Cell => ({ marketCode, state: 'NOT_SOLD', words: 'Not sold there', missing: 0, blocking: 0, expiring: 0, manual: 0, blockedGates: [], first: null })

/** The board with its first style sold in its first market only. */
export function soldInFirstMarket(board: Board): Board {
  const [first, ...rest] = board.rows
  if (!first) return board
  const code = first.cells[0]!.marketCode
  const row: BoardRow = { ...first, style: { ...first.style, marketCodes: [code] }, cells: first.cells.map((cell, index) => (index === 0 ? cell : notSold(cell.marketCode))), ready: first.cells[0]!.state === 'READY', blocked: first.cells[0]!.state === 'BLOCKED' }
  return { ...board, rows: [row, ...rest], needsAction: { lines: board.needsAction.lines.filter((line) => line.styleId !== first.style.id), count: board.needsAction.lines.filter((line) => line.styleId !== first.style.id).length } }
}

type Model = (over?: Partial<StatusModel>) => StatusModel

/** The Not sold there cases, on SCR-119's own base model, board and cell. */
export function notSoldCases(model: Model, board: Board, cell: CellDetail) {
  const sold = soldInFirstMarket(board)
  const row = sold.rows[0]!
  const at = { styleId: row.style.id, market: row.cells[1]!.marketCode }
  const detail: CellDetail = { ...cell, style: { ...cell.style, marketCodes: row.style.marketCodes }, market: board.markets[1]!, standing: 'NOT_SOLD_THERE', cell: row.cells[1]!, items: [] }
  return [
    { id: 'w2b-288-not-sold', label: 'A style sold in Italia only: the other markets say “Not sold there” (—), not a gap', model: model({ board: { status: 'ready', value: sold } }), note: 'The legend names the state; Needs action leaves those markets out.' },
    { id: 'w2b-288-not-sold-cell', label: 'The cell of a market it is not sold in: nothing asked, where its markets are picked', model: model({ board: { status: 'ready', value: sold }, cell: { at, read: { status: 'ready', value: detail } } }) },
    { id: 'w2b-288-not-sold-every-market', label: 'A style that names no market: every market is checked (the cell says so)', model: model({ cell: { at: { styleId: cell.style.id, market: cell.market.code }, read: { status: 'ready', value: cell } } }) },
  ]
}
