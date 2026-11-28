import type { FloorBoard, FloorBoardCard } from './api'

/**
 * owb-fl9 step 2 — the phone's Board, pure (design § 5zf C, § 5zg C; P/floor.js floorBoard; P/fsteps.js lbRow): ONLY a team leader has
 * the tab (a worker has none); My team · Whole floor; one chip per department in use and Ready to ship, each with its count; the list of
 * the picked chip (the "Do this first" baskets on top, then a problem, then the rest by number); a tap opens the basket. The floor card
 * names the customer's CODE, never the name.
 */

/** The Board tab is the team leader's (floor.lead): a worker's phone has none. */
export const boardTabShown = (permissions: readonly string[]): boolean => permissions.includes('floor.lead')

export const READY_CHIP = 'READY'

export interface BoardChip {
  /** A department's id, or READY. */
  readonly key: string
  readonly department: FloorBoard['columns'][number]['department'] | null
  readonly count: number
}

/** One chip per department in use (the server's order), then Ready to ship. */
export function chipsOf(board: FloorBoard): BoardChip[] {
  return [...board.columns.map((column) => ({ key: column.department.id, department: column.department, count: column.baskets.length })), { key: READY_CHIP, department: null, count: board.readyToShip.length }]
}

/** The chip a board opens on: the phone's department when it has baskets there, else the first chip with baskets, else the first. */
export function firstChip(chips: readonly BoardChip[], departmentId: string | null): string {
  const mine = chips.find((chip) => chip.key === departmentId && chip.count > 0)
  return (mine ?? chips.find((chip) => chip.count > 0) ?? chips[0])?.key ?? READY_CHIP
}

/** The picked chip's baskets: Do this first on top, then a problem, then by number. */
export function listOf(board: FloorBoard, chip: string): FloorBoardCard[] {
  const cards = chip === READY_CHIP ? board.readyToShip : (board.columns.find((column) => column.department.id === chip)?.baskets ?? [])
  const rank = (card: FloorBoardCard) => (card.flags?.first ? 0 : card.flags?.problem ? 1 : 2)
  return [...cards].sort((a, b) => rank(a) - rank(b) || a.code.localeCompare(b.code))
}

/** The floor names the customer's code, never the name. */
export const customerCodeOf = (card: FloorBoardCard): string => card.customer?.code ?? card.customerCode ?? ''

/** The basket's page on the phone. */
export const basketPath = (code: string): string => `/floor/basket/${encodeURIComponent(code)}`
