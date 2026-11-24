import { OPEN_STATUSES } from '@nexus/factory-domain/sales/orders/orders'
import type { OrderBoard } from '../../../orders/api'
import type { Read } from '../use-customer-work'
import { dayOf, depth, glanceOf, ov, readyOf, say, type OverviewHeadline, type OverviewInput, type Say, type StandingLine } from './model'

/**
 * F-CO-101 (customer page › Overview; 10-design §2.1; lead settles S7, S25) — ONE sentence that says where the customer stands.
 * Part 1 is the STANDING: the first true line of the ladder
 *
 *   Archived › Blocked since <date> › On hold (<reason>) › Prospect › No order yet › No open order › <n> open orders
 *   › (a reader without orders.view, or a board that could not be read) the status word alone
 *
 * then, in a fixed order and each only when true: "<n> open orders" (only after a standing word of the first four lines: a blocked
 * customer's orders still run) · "<n> late" · "<n> things wait on us" · "next promise <date>". Four parts at most, cut from the end.
 * Words, never doors: every number is a door once, in its card below.
 *
 * Every number is the customer's BOARD's (the API's own counts by state, walled to the customer), the page's count reads, or this
 * customer's row of the joined read — nothing is counted from a list. A part whose read is not in is left out; a failed read never
 * shows 0; while the board (or the hold) is still read the sentence is not said at all (a skeleton line).
 */

/** The sentence's parts at most. */
export const HEADLINE_PARTS = 4

/** The board's own numbers: every order, the open ones (the domain's open states), the late ones, those that wait for a yes. */
export interface BoardNumbers {
  readonly total: number
  readonly open: number
  readonly late: number
  readonly waitsForYes: number
}

export function boardNumbersOf(board: OrderBoard): BoardNumbers {
  const openStates: readonly string[] = OPEN_STATUSES
  let total = 0
  let open = 0
  for (const entry of board.byStatus) {
    total += entry.count
    if (openStates.includes(entry.status)) open += entry.count
  }
  return { total, open, late: board.tiles.find((tile) => tile.key === 'late')?.count ?? 0, waitsForYes: board.notSent?.waitsForYes ?? 0 }
}

/** The board for this reader: `off` without orders.view (the read is never made, its number never said). */
export const boardOf = (input: Pick<OverviewInput, 'can' | 'reads'>): Read<OrderBoard> => (input.can.orders ? input.reads.board : { status: 'off' })

/**
 * What waits on us: the two tab badges added up — requests to answer + replies waiting on us (the Work tab's) and To answer +
 * Accepted, order waits (Quotes & incoming's). null: a read is still out, or the reader may read none of them (the part is left out).
 */
export function waitsOnUsOf(input: Pick<OverviewInput, 'reads' | 'counts'>): number | null {
  const { requests, replies } = input.reads
  if (requests.status === 'reading' || replies.status === 'reading') return null
  if (input.counts.counts === null && !input.counts.failed) return null
  const parts: number[] = []
  if (requests.status === 'ready') parts.push(requests.value.open)
  if (replies.status === 'ready') parts.push(replies.value.count)
  const before = input.counts.counts?.waitsOnUs ?? null
  if (before !== null) parts.push(before)
  return parts.length > 0 ? parts.reduce((sum, part) => sum + part, 0) : null
}

/** The next promise from today on, over every company (this customer's row of the joined read); null: none ahead, or not read. */
export function nextPromiseOf(input: Pick<OverviewInput, 'standing' | 'today'>): string | null {
  const next = readyOf(input.standing)?.nextPromise ?? null
  return next !== null && next >= input.today ? next : null
}

export function headlineOf(input: OverviewInput): OverviewHeadline {
  const { party } = input
  const status = party.status
  const board = boardOf(input)
  // Not said yet: the board still reads, or (for a customer neither archived nor blocked) whether a hold is in force is not known.
  if (board.status === 'reading' || (input.glance.status === 'loading' && status !== 'ARCHIVED' && status !== 'BLOCKED')) return { sentence: null, quiet: null, line: null }
  const numbers = board.status === 'ready' ? boardNumbersOf(board.value) : null
  const glance = glanceOf(input.glance)
  const holds = glance?.hold.onHold ? glance.hold.holds : []
  const lastOrderDate = readyOf(input.standing)?.lastOrderDate ?? null
  const lastOrder: Say | null = lastOrderDate ? ov('quiet.lastOrder', { date: dayOf(lastOrderDate) }) : null

  let line: StandingLine
  let first: Say
  let quiet: Say | null = null
  if (status === 'ARCHIVED') {
    line = 'ARCHIVED'
    first = say('status.ARCHIVED')
    quiet = ov('quiet.archived')
  } else if (status === 'BLOCKED') {
    line = 'BLOCKED'
    first = party.blocked ? say('side.blockedSince', { date: dayOf(party.blocked.at) }) : say('status.BLOCKED')
    quiet = ov('quiet.blocked')
  } else if (holds.length > 0) {
    // The screen's company (the glance): a hold at another company is not said here (S7).
    line = 'ON_HOLD'
    first = holds.length === 1 ? ov('headline.onHold', { reason: depth(`reason.${holds[0]!.reason}`) }) : ov('headline.onHoldMany', { count: holds.length })
    quiet = depth('status.holdStops')
  } else if (status === 'PROSPECT') {
    line = 'PROSPECT'
    first = say('status.PROSPECT')
    quiet = ov('quiet.prospect')
  } else if (numbers && numbers.total === 0) {
    line = 'NO_ORDER'
    first = say('customers-list:work.noOrder')
  } else if (numbers && numbers.open === 0) {
    // An order that waits for a yes is not "open": when only those exist the sentence says so.
    line = 'NO_OPEN'
    first = numbers.waitsForYes > 0 ? ov('headline.waitYes', { count: numbers.waitsForYes }) : depth('promises.none')
    quiet = lastOrder
  } else if (numbers) {
    line = 'OPEN'
    first = ov('headline.openOrders', { count: numbers.open })
    quiet = lastOrder
  } else {
    // S7: no right to see orders (or the board could not be read): the status word, then only the parts whose reads are in.
    line = 'STATUS'
    first = say(`status.${status}`)
  }

  const parts: Say[] = [first]
  if (numbers) {
    const afterStandingWord = line === 'ARCHIVED' || line === 'BLOCKED' || line === 'ON_HOLD' || line === 'PROSPECT'
    if (afterStandingWord && numbers.open > 0) parts.push(ov('headline.openOrders', { count: numbers.open }))
    if (numbers.late > 0) parts.push(depth('promises.late', { count: numbers.late }))
  }
  const us = waitsOnUsOf(input)
  if (us !== null && us > 0) parts.push(say('customers.work.attention', { count: us }))
  // S25: ONE word for this date — the Customers list's "next promise" (it is the ex-factory promise).
  const next = nextPromiseOf(input)
  if (next !== null) parts.push(ov('headline.nextPromise', { date: dayOf(next) }))
  return { sentence: parts.slice(0, HEADLINE_PARTS), quiet, line }
}
