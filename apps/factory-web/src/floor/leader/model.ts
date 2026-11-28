import type { BasketRow, BasketTeam, TeamOrder } from '../basket/api'
import { unseenForYou } from '../basket/home/seen'
import type { ForYouItem } from '../basket/api'

/**
 * owb-fl6 step 3 (design § 5zf C "My team today: four numbers of the TEAM … never a number of one person"; § 5zg C "the team's baskets
 * by order, the step of each basket is a button"; P/fsteps.js leaderHome, ordGroups; P/fplus.js leaderToday) — the leader's home without a
 * screen: the four team numbers and what a tap on one keeps, the orders with their baskets (Do this first on top, then a problem, then
 * late), For you. Pure, so the tests hold the rules.
 */

export const TEAM_FILTERS = ['working', 'waiting', 'late', 'problem'] as const
export type TeamFilter = (typeof TEAM_FILTERS)[number]

/** The four numbers, as the server counts them for the TEAM (never one person's). */
export const teamNumbersOf = (team: Pick<BasketTeam, 'numbers'>): Readonly<Record<TeamFilter, number>> => ({ working: team.numbers.working, waiting: team.numbers.waiting, late: team.numbers.late, problem: team.numbers.problem })

/** What a tap on a number keeps: Working · Waiting (also paused) · Late · Problem. */
export function keeps(filter: TeamFilter, row: BasketRow): boolean {
  switch (filter) {
    case 'working':
      return row.state === 'WORKING'
    case 'waiting':
      return row.state !== 'WORKING'
    case 'late':
      return row.flags.late
    case 'problem':
      return row.flags.problem
  }
}

export interface OrderGroup {
  readonly key: string
  readonly order: TeamOrder
  readonly rows: readonly BasketRow[]
}

const groupRank = (rows: readonly BasketRow[]): number => (rows.some((row) => row.flags.first) ? 0 : rows.some((row) => row.flags.problem) ? 1 : rows.some((row) => row.flags.late) ? 2 : 3)

/** The team's baskets by order (a filter keeps some; an order left empty goes): Do this first first, then a problem, then late. */
export function groupsOf(team: Pick<BasketTeam, 'orders'>, filter: TeamFilter | null): OrderGroup[] {
  return team.orders
    .map((order, index) => ({
      key: order.salesOrderId ?? `order-${index}`,
      order,
      rows: order.baskets.filter((row) => !filter || keeps(filter, row)).sort((a, b) => Number(b.flags.first) - Number(a.flags.first) || a.code.localeCompare(b.code)),
    }))
    .filter((group) => group.rows.length > 0)
    .sort((a, b) => groupRank(a.rows) - groupRank(b.rows) || a.order.customerCode.localeCompare(b.order.customerCode))
}

/** Every basket of the team (the Baskets part's count). */
export const teamBasketsOf = (team: Pick<BasketTeam, 'orders'>): number => team.orders.reduce((sum, order) => sum + order.baskets.length, 0)

/** For you of the leader: the same ONE list (news hidden once opened here; problems and asks while they wait), newest first. */
export const leaderForYouOf = (team: Pick<BasketTeam, 'forYou'>, seen: readonly string[]): ForYouItem[] => unseenForYou(team.forYou, seen).sort((a, b) => b.at.localeCompare(a.at))
