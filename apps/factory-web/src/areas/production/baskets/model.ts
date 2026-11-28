import { departmentOfAnswer, type Department } from '../../../lib/department/model'
import type { Board, BoardCard, DepartmentRow, RouteStep } from './api'

/**
 * owb-fl9 — the Baskets board's rules, without React or the network, so the tests hold them (design § 2 "a column for each department
 * in use", § 6; P/ui.js boardHTML, basketCard; P/office.js the page `board` and the basket window).
 *
 *   columns      one per department IN USE (the server's: the six and every other on the route of a running basket), in the server's
 *                order, then Ready to ship; an empty column says so (one dash), never vanishes (the board keeps its shape)
 *   the card     the office names the customer (only for people allowed that customer: the server leaves the name out otherwise);
 *                the floor names the CODE, never the name; no price anywhere
 *   Move it to   only a step of ITS route (a skipped step is not offered) and Ready to ship; the step it is at is not a target; back
 *                asks why; Ready to ship is held until the route's last step is done (settle 7: "Pack it first")
 */

export const BASKETS_NAMESPACE = 'production-baskets'
export const BASKETS_NAMESPACES = [BASKETS_NAMESPACE] as const

/** The Ready to ship column's key (it has no department). */
export const READY = 'READY'

export interface BoardColumn {
  readonly key: string
  /** null: Ready to ship. */
  readonly department: Department | null
  readonly cards: readonly BoardCard[]
}

/** The board's columns: each department in use (the server's order), then Ready to ship. */
export function columnsOf(board: Board, locale: string): BoardColumn[] {
  return [
    ...board.columns.map((column) => ({ key: column.department.id, department: departmentOf(column.department, locale), cards: column.baskets })),
    { key: READY, department: null, cards: board.readyToShip },
  ]
}

export const departmentOf = (row: DepartmentRow, locale: string): Department => departmentOfAnswer({ ...row, shortName: row.shortName ?? null, nameI18n: row.nameI18n ?? null, status: row.status ?? null }, locale)

/** Every basket of the board once (the phone's one-column list and the counts). */
export const allCards = (board: Board): BoardCard[] => [...board.columns.flatMap((column) => column.baskets), ...board.readyToShip]

/** Who the card names: the office the customer's name (when the server gave it), else its code; the floor ALWAYS the code. */
export function customerWords(card: BoardCard, door: 'office' | 'floor'): string {
  const code = card.customer?.code ?? card.customerCode ?? ''
  if (door === 'floor') return code
  return card.customer?.name?.trim() || code
}

export type CardState = 'WAITING' | 'WORKING' | 'PAUSED' | 'READY'

/** The card's state chip: Ready to ship in that column, else the work's state (an unknown one reads Waiting). */
export function cardStateOf(card: BoardCard, ready: boolean): CardState {
  if (ready) return 'READY'
  return card.state === 'WORKING' || card.state === 'PAUSED' ? card.state : 'WAITING'
}

export const hasProblem = (card: BoardCard): boolean => Boolean(card.flags?.problem)
export const isLate = (card: BoardCard): boolean => Boolean(card.late) || card.flags?.late === true

// ---- the filters (team · department · order), taken from what the board holds -----------------------------------------------------

export interface FilterOption {
  readonly id: string
  readonly label: string
}

/** The teams, the departments and the orders the board's baskets carry (each once, by its words). */
export function filterOptions(board: Board, locale: string): { teams: FilterOption[]; departments: FilterOption[]; orders: FilterOption[] } {
  const cards = allCards(board)
  const teams = new Map<string, string>()
  const orders = new Map<string, string>()
  for (const card of cards) {
    if (card.team) teams.set(card.team.id, card.team.name)
    if (card.salesOrderId) orders.set(card.salesOrderId, card.customer?.name?.trim() || card.customer?.code || card.customerCode || card.code)
  }
  const byLabel = (a: FilterOption, b: FilterOption) => a.label.localeCompare(b.label)
  return {
    teams: [...teams].map(([id, label]) => ({ id, label })).sort(byLabel),
    departments: board.columns.map((column) => ({ id: column.department.id, label: `${column.department.number} · ${departmentOf(column.department, locale).shortName}` })),
    orders: [...orders].map(([id, label]) => ({ id, label })).sort(byLabel),
  }
}

// ---- Move it to (the window) -----------------------------------------------------------------------------------------------

export interface MoveTarget {
  /** null: Ready to ship. */
  readonly operationId: string | null
  readonly step: RouteStep | null
  readonly kind: 'FORWARD' | 'BACK'
  /** Why it cannot be chosen now (null: it can). */
  readonly held: 'PACK_FIRST' | null
}

/**
 * The places a basket may be moved to by hand: every step of ITS route that is not skipped and not where it is, then Ready to ship.
 * Forward or back by the route's order (back asks why). Ready to ship waits until the route's last step is done (settle 7).
 */
export function moveTargets(steps: readonly RouteStep[], placeOperationId: string | null): MoveTarget[] {
  const route = steps.filter((step) => step.state !== 'SKIPPED')
  const hereIndex = placeOperationId === null ? route.length : route.findIndex((step) => step.operationId === placeOperationId)
  const targets: MoveTarget[] = route.flatMap((step, index) => (step.operationId === placeOperationId ? [] : [{ operationId: step.operationId, step, kind: hereIndex >= 0 && index < hereIndex ? ('BACK' as const) : ('FORWARD' as const), held: null }]))
  const last = route[route.length - 1]
  if (placeOperationId !== null) targets.push({ operationId: null, step: null, kind: 'FORWARD', held: last && last.state !== 'DONE' ? 'PACK_FIRST' : null })
  return targets
}

/** The window's "Move it to" offers the route's steps only: the test holds that nothing else is a target. */
export const targetIds = (targets: readonly MoveTarget[]): (string | null)[] => targets.map((target) => target.operationId)

// ---- Print its card and pages again… (S3's window, by the base's slot) ----------------------------------------------------------

/** S3's slot says it is built (`PRINT_AGAIN_READY = true` beside the filled window); a stub says nothing → the door is hidden. */
export const printAgainReady = (slot: Readonly<Record<string, unknown>>): boolean => slot.PRINT_AGAIN_READY === true

/** The order's page, at a tab (the office's address of an order). */
export const orderHref = (prefix: string, salesOrderId: string, tab?: string): string => `${prefix}/sales/orders/${encodeURIComponent(salesOrderId)}${tab ? `?tab=${encodeURIComponent(tab)}` : ''}`
