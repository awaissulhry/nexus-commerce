import type { Order } from '../api'
import { amendHeld, closableLines, closeLinesHeld, reopenHeld } from '../daily-model'
import { isFinal, linePromisesAllowed, promiseHeld, splitHeld, splitLinesOf, type OrderAbilities, type Phrase } from '../model'
import type { ProductionLine } from './overview/api'
import { makeHeldOf } from './production'

/**
 * F-OL-01 (c) (Order LINES lane, plan v2 §1; 11-design-dialogs §1.1–§1.3 as settled by 18-lead-settles F6, F29) — ONE line-⋯ list,
 * moved here from overview/progress.ts (F-OO-122) so the Lines table and Overview › Progress by line call the same function with the
 * same target (a parity test pins it). This round's items, in their groups:
 *   change   Options and artwork… · Ready-by date…
 *   pieces   Close with fewer pieces… / Reopen this line… · Move to a new order… · Make work orders…
 *   talk     Discuss this line
 *   danger   Remove line (into the draft: Put back undoes it)
 * Each opens TODAY's window with today's rules (only the reason became optional). Hidden by right (F6): the change and pieces acts need
 * orders.manage; Make work orders shows for who holds workorders.manage and stays held for Sales in words (held.noWorkOrders, F-OO-122);
 * Finance reads Discuss only; Read-only and Warehouse get no ⋯ at all. Held by the order's or the line's state, always with words.
 */

export type LineMoveId = 'options' | 'readyBy' | 'close' | 'reopen' | 'split' | 'make' | 'discuss' | 'remove' | 'putBack'
export type LineMoveGroup = 'change' | 'pieces' | 'talk' | 'danger'

export interface LineMove {
  readonly id: LineMoveId
  readonly group: LineMoveGroup
  /** The lines the act names (a made-to-measure group on Overview: every unit; on Lines: one line). */
  readonly lineIds: readonly string[]
  /** The line a one-line act opens with (the first unit still open of a group). */
  readonly lineId: string
  readonly held: Phrase | null
}

/** What a row of either door stands for: its lines, and whether it is a made-to-measure unit (or group). */
export interface LineTarget {
  readonly lineIds: readonly string[]
  readonly mtm: boolean
}

/** The target of a row: its line ids as the order read holds them (a made-to-measure unit keeps its kind). */
export function lineTargetOf(lineIds: readonly string[], order: Pick<Order, 'lines'>): LineTarget {
  const own = order.lines.filter((line) => lineIds.includes(line.id))
  return { lineIds: [...lineIds], mtm: own.length > 0 && own.every((line) => line.kind === 'MADE_TO_MEASURE') }
}

/** Work orders are made while the order is confirmed or in production (the band's Make work orders…; other states offer none). */
export const MAKE_STATUSES: readonly Order['status'][] = ['CONFIRMED', 'IN_PRODUCTION']

/** Who sees the row ⋯ at all (F6): who changes lines, who makes work orders, Finance (Discuss). Read-only and Warehouse: nobody. */
export const lineMovesShown = (can: Pick<OrderAbilities, 'manage' | 'makeWorkOrders' | 'close'>): boolean => can.manage || can.makeWorkOrders || can.close

const said = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

export interface LineMovesInput {
  /** The production read's lines (what work orders make of each); empty: not read yet. */
  readonly lines: readonly ProductionLine[]
  /** The page has the order's conversation (Discuss). */
  readonly thread: boolean
  /** The Lines table's draft of this row: removed (only Put back and Discuss), a new row (only Remove). Overview: none. */
  readonly draft?: { readonly removed?: boolean; readonly isNew?: boolean }
  /** A save is running: every act but Discuss waits. */
  readonly busy?: boolean
}

/** The moves of a row, in the menu's order (an empty list: no ⋯). */
export function lineMovesOf(target: LineTarget, order: Order, can: OrderAbilities, input: LineMovesInput): LineMove[] {
  if (!lineMovesShown(can)) return []
  const own = order.lines.filter((line) => target.lineIds.includes(line.id))
  const first = target.lineIds[0] ?? ''
  const busy = input.busy ? said('held.busy') : null
  const moves: LineMove[] = []
  const push = (id: LineMoveId, group: LineMoveGroup, held: Phrase | null, lineIds: readonly string[] = target.lineIds, lineId: string = first) => moves.push({ id, group, lineIds, lineId, held: held ?? (id === 'discuss' ? null : busy) })
  const discuss = () => {
    if (input.thread) push('discuss', 'talk', null)
  }
  // A new row of the draft: only Remove (it is not on the order yet).
  if (input.draft?.isNew) {
    if (can.manage) push('remove', 'danger', null)
    return moves
  }
  // A removed row of the draft: Put back first, then Discuss.
  if (input.draft?.removed) {
    if (can.manage) push('putBack', 'danger', null)
    discuss()
    return moves
  }
  const open = own.filter((line) => !line.closedShort)
  const closed = own.filter((line) => line.closedShort)
  const state = isFinal(order) ? said('held.final') : null
  if (can.manage) {
    push('options', 'change', state)
    // Ready-by of a line: the promise's own rule, then the lines' (fixed once anything shipped).
    push('readyBy', 'change', promiseHeld(order, can) ?? (linePromisesAllowed(order) ? null : said('lineMenu.held.readyByShipped')))
    if (open.length > 0 || closed.length === 0) {
      const closable = new Set(closableLines(order).map((entry) => entry.line.id))
      const lineIds = open.filter((line) => closable.has(line.id)).map((line) => line.id)
      push('close', 'pieces', closeLinesHeld(order, can) ?? (lineIds.length === 0 ? said('progress.held.nothingLeft') : null), lineIds, lineIds[0] ?? first)
    }
    if (closed.length > 0) push('reopen', 'pieces', reopenHeld(order, can), closed.map((line) => line.id), closed[0]!.id)
    if (!target.mtm) {
      const movable = splitLinesOf(order).some((line) => target.lineIds.includes(line.lineId))
      push('split', 'pieces', splitHeld(order, can) ?? (closed.length > 0 && open.length === 0 ? said('lineMenu.held.splitClosed') : movable ? null : said('lineMenu.held.splitInWork')))
    }
  }
  if (MAKE_STATUSES.includes(order.status) && (can.manage || can.makeWorkOrders)) {
    // The line (a made-to-measure group: one unit, still open, not yet in work orders in full) the dialog opens with.
    const members = input.lines.filter((line) => open.some((entry) => entry.id === line.lineId))
    const short = members.find((line) => line.inWorkOrders < line.ordered) ?? null
    const held = !can.makeWorkOrders ? said('held.noWorkOrders') : open.length === 0 ? said('progress.held.closedLine') : !short ? said('progress.held.allInWork') : makeHeldOf(order, can)
    push('make', 'pieces', held, target.lineIds, short?.lineId ?? open[0]?.id ?? first)
  }
  discuss()
  if (can.manage && !target.mtm) {
    const changeHeld = amendHeld(order, can)
    push('remove', 'danger', changeHeld ?? (closed.length > 0 ? said('lineMenu.held.removeClosed') : null))
  }
  return moves
}

