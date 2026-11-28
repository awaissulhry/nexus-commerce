/**
 * Teams own the work (owb-ss5 step 5.1; design order-workflow-2026-11-25 § 5za "Teams own the work", prototype teams.js teamModal,
 * teamFacts, suggestTeam; _owb-ss-common L3; PL-schema § 5A row 10 `OrderTeam`, guard G4). Pure: the API (apps/factory-api
 * modules/production/order-teams) reads the facts in its command and writes the rows; the G4 trigger is the last word.
 *
 *   NONE      no team has the order yet ("No team yet" on the board)
 *   ONE       one team, in charge
 *   TOGETHER  several teams, one in charge, no shares: they make the order together
 *   SPLIT     each team makes its share of the order's baskets (at least 1 each; the shares add up to the order's baskets);
 *             one of them is still in charge. At the FIRST print the baskets are shared out, so from then on the shares stay:
 *             only TOGETHER rows (no share) may still be added or taken off.
 *
 * Marks on the board (codes; the web has the words): over its limit (more baskets in work than its most), takes no new order,
 * missing today (a number of its people), late (a number of its orders). A figure of a team smaller than its company's
 * `minimumGroupSize` is never shown (null): the marks read null as nothing to say.
 */

export const ORDER_TEAM_MODES = ['NONE', 'ONE', 'TOGETHER', 'SPLIT'] as const
export type OrderTeamMode = (typeof ORDER_TEAM_MODES)[number]

export const TEAM_MARKS = ['OVER_LIMIT', 'TAKES_NO_NEW_ORDER', 'MISSING_TODAY', 'LATE'] as const
export type TeamMark = (typeof TEAM_MARKS)[number]

/** The refusals of a PUT of an order's teams, each with its words (EN; the web shows its own words by code). */
export const ORDER_TEAM_REFUSALS = {
  TEAM_TWICE: 'A team is on the order once.',
  ONE_IN_CHARGE: 'One team is in charge of the order: pick exactly one.',
  SHARE_TOO_SMALL: 'A team makes at least 1 basket of the order.',
  SHARE_MISSING: 'When the baskets are split, every team says how many it makes.',
  SHARES_DO_NOT_ADD_UP: 'The shares add up to the order’s baskets.',
  SHARES_FIXED: 'The baskets were shared out at the first print: only teams that work together (no share) may still be added or taken off.',
  TOO_MANY_TEAMS: 'At most 20 teams on one order.',
} as const
export type OrderTeamRefusal = keyof typeof ORDER_TEAM_REFUSALS

/** The most teams one order takes. */
export const MAX_ORDER_TEAMS = 20

export interface TeamRowIn {
  readonly teamId: string
  readonly inCharge: boolean
  readonly basketShare: number | null
}

/** The mode of a set of rows. */
export function orderTeamMode(rows: readonly { readonly basketShare: number | null }[]): OrderTeamMode {
  if (rows.length === 0) return 'NONE'
  if (rows.some((row) => row.basketShare !== null)) return 'SPLIT'
  return rows.length === 1 ? 'ONE' : 'TOGETHER'
}

/** The same team, charge and share (an unchanged row is kept, never ended and written again). */
export const sameRow = (a: TeamRowIn, b: TeamRowIn): boolean => a.teamId === b.teamId && a.inCharge === b.inCharge && a.basketShare === b.basketShare

/**
 * What is wrong with the rows a PUT asks for (empty: nothing). `plannedBaskets` is the order's baskets (the shares of a split add
 * up to it when it is above 0); `printed` the order's first print happened; `current` its open rows now.
 */
export function teamRowsProblems(rows: readonly TeamRowIn[], facts: { readonly plannedBaskets: number; readonly printed: boolean; readonly current: readonly TeamRowIn[] }): OrderTeamRefusal[] {
  const problems: OrderTeamRefusal[] = []
  if (rows.length > MAX_ORDER_TEAMS) problems.push('TOO_MANY_TEAMS')
  if (new Set(rows.map((row) => row.teamId)).size !== rows.length) problems.push('TEAM_TWICE')
  if (rows.length > 0 && rows.filter((row) => row.inCharge).length !== 1) problems.push('ONE_IN_CHARGE')
  if (rows.some((row) => row.basketShare !== null && (!Number.isInteger(row.basketShare) || row.basketShare < 1))) problems.push('SHARE_TOO_SMALL')
  const split = rows.some((row) => row.basketShare !== null)
  if (split && rows.some((row) => row.basketShare === null)) problems.push('SHARE_MISSING')
  if (split && facts.plannedBaskets > 0 && rows.every((row) => row.basketShare !== null)) {
    const sum = rows.reduce((total, row) => total + (row.basketShare ?? 0), 0)
    if (sum !== facts.plannedBaskets) problems.push('SHARES_DO_NOT_ADD_UP')
  }
  if (facts.printed) {
    // Every row with a share stays exactly as it was (team and share); no row with a share is added.
    const sharedNow = facts.current.filter((row) => row.basketShare !== null)
    const sharedNext = rows.filter((row) => row.basketShare !== null)
    const kept = sharedNow.every((row) => sharedNext.some((next) => next.teamId === row.teamId && next.basketShare === row.basketShare))
    const added = sharedNext.some((next) => !sharedNow.some((row) => row.teamId === next.teamId && row.basketShare === next.basketShare))
    if (!kept || added) problems.push('SHARES_FIXED')
  }
  return problems
}

/** An even split of `baskets` between `teams` teams, the first teams taking one more ("12 between 5" → 3, 3, 2, 2, 2). */
export function evenShares(baskets: number, teams: number): number[] {
  if (teams <= 0) return []
  const whole = Math.max(0, Math.floor(baskets))
  const base = Math.floor(whole / teams)
  const extra = whole % teams
  return Array.from({ length: teams }, (_, index) => base + (index < extra ? 1 : 0))
}

/** What the board knows of a team (null: not shown — a team smaller than its company's smallest group). */
export interface TeamMarkFacts {
  readonly inWork: number | null
  readonly maxBaskets: number | null
  readonly takesNewOrders: boolean
  readonly missingToday: number | null
  readonly late: number | null
}

/** Over its limit: more baskets in work than its most (never when either is unknown). */
export const isOverLimit = (facts: Pick<TeamMarkFacts, 'inWork' | 'maxBaskets'>): boolean => facts.inWork !== null && facts.maxBaskets !== null && facts.inWork > facts.maxBaskets

/** The marks of a team on the board, in a fixed order. */
export function teamMarks(facts: TeamMarkFacts): TeamMark[] {
  const marks: TeamMark[] = []
  if (isOverLimit(facts)) marks.push('OVER_LIMIT')
  if (!facts.takesNewOrders) marks.push('TAKES_NO_NEW_ORDER')
  if (facts.missingToday !== null && facts.missingToday > 0) marks.push('MISSING_TODAY')
  if (facts.late !== null && facts.late > 0) marks.push('LATE')
  return marks
}

/** One past order of the customer and the team that worked on it. */
export interface TeamHistoryRow {
  readonly teamId: string
  /** When the team got that order (its OrderTeam row's creation), ISO. */
  readonly at: string
  /** The team takes new orders now and is open. */
  readonly takesNewOrders: boolean
}

/**
 * The team to suggest for a customer's order: the team that worked for this customer most recently (the most orders breaks a
 * tie), never one that takes no new order; null when none did.
 */
export function suggestTeam(history: readonly TeamHistoryRow[]): string | null {
  const byTeam = new Map<string, { last: string; count: number }>()
  for (const row of history) {
    if (!row.takesNewOrders) continue
    const seen = byTeam.get(row.teamId)
    byTeam.set(row.teamId, { last: seen && seen.last > row.at ? seen.last : row.at, count: (seen?.count ?? 0) + 1 })
  }
  let best: string | null = null
  let bestFacts: { last: string; count: number } | null = null
  for (const [teamId, facts] of byTeam) {
    if (!bestFacts || facts.last > bestFacts.last || (facts.last === bestFacts.last && (facts.count > bestFacts.count || (facts.count === bestFacts.count && teamId < best!)))) {
      best = teamId
      bestFacts = facts
    }
  }
  return best
}
