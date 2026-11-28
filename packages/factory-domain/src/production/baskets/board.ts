import { standingKey } from '../scans/rules'

/**
 * The Baskets board, the leader's team home and the chains (owb- order workflow, S5 fl4; `_owb-fl-common.md` § 3 "fl2 / fl4";
 * design § 2 "Boards: a column for each department in use", § 4.8, § 6), pure. apps/factory-api modules/production/baskets
 * (board.ts, team.ts) and modules/production/chains read the facts (each basket's place from basketPlace, its department from
 * departmentOfStep) and these put them in order:
 *
 *   boardColumns    one column per department IN USE — the departments on the floor today (floorReady: the six) and any other
 *                   on the route of a basket listed — in the departments' order, each with the baskets whose step is there;
 *                   Ready to ship apart (every scanned step done)
 *   teamNumbers     Working · Waiting · Late · Problem of the TEAM's baskets (never one person's count; Statuto art. 4)
 *   slowestStep     the step of a chain where the most garments wait (ties: the earlier step); null when nothing waits
 *   nextToReport    "+12" on a chain (settle 10): the cell's next ACTIVE bundle not reported yet at the step, one that reached it
 *                   first (the step before it is reported, or it is the first step), oldest first
 */

export interface ColumnDepartment {
  readonly id: string
  readonly number: number
  readonly seq: number
  readonly floorReady: boolean
  readonly status: string
}

export interface BoardItem {
  /** The department of the basket's step; null: its step is in no department (outside) or it is Ready to ship. */
  readonly departmentId: string | null
  /** Ready to ship: every scanned step of its route is done. */
  readonly ready: boolean
  /** The departments of every scanned step of its route (the columns in use). */
  readonly routeDepartmentIds: readonly string[]
}

export interface BoardColumns<Department extends ColumnDepartment, Item extends BoardItem> {
  readonly columns: { readonly department: Department; readonly baskets: Item[] }[]
  readonly readyToShip: Item[]
  /** Baskets whose step has no department (an outside step): counted, never lost. */
  readonly elsewhere: Item[]
}

/** The board's columns (see the file's head). A closed department shows only while a basket stands in it. */
export function boardColumns<Department extends ColumnDepartment, Item extends BoardItem>(departments: readonly Department[], items: readonly Item[]): BoardColumns<Department, Item> {
  const inUse = new Set<string>()
  for (const item of items) for (const id of item.routeDepartmentIds) inUse.add(id)
  for (const item of items) if (item.departmentId) inUse.add(item.departmentId)
  const shown = departments
    .filter((department) => (department.status === 'ACTIVE' && department.floorReady) || inUse.has(department.id))
    .sort((a, b) => a.seq - b.seq || a.number - b.number)
  const known = new Set(shown.map((department) => department.id))
  return {
    columns: shown.map((department) => ({ department, baskets: items.filter((item) => !item.ready && item.departmentId === department.id) })),
    readyToShip: items.filter((item) => item.ready),
    elsewhere: items.filter((item) => !item.ready && (item.departmentId === null || !known.has(item.departmentId))),
  }
}

export interface TeamItem {
  readonly state: 'WAITING' | 'WORKING' | 'PAUSED'
  readonly late: boolean
  readonly problem: boolean
  readonly ready: boolean
}

/** The team's four numbers: baskets being worked, waiting (paused counts as waiting), late, with an open problem. */
export function teamNumbers(items: readonly TeamItem[]): { readonly working: number; readonly waiting: number; readonly late: number; readonly problem: number } {
  const live = items.filter((item) => !item.ready)
  return {
    working: live.filter((item) => item.state === 'WORKING').length,
    waiting: live.filter((item) => item.state !== 'WORKING').length,
    late: live.filter((item) => item.late).length,
    problem: live.filter((item) => item.problem).length,
  }
}

/** The step of a chain where the most garments wait (the bottleneck, red on the office matrix); ties: the earlier step. */
export function slowestStep(steps: readonly { readonly operationId: string; readonly waiting: number }[]): string | null {
  let slowest: { readonly operationId: string; readonly waiting: number } | null = null
  for (const step of steps) if (step.waiting > 0 && (slowest === null || step.waiting > slowest.waiting)) slowest = step
  return slowest?.operationId ?? null
}

export interface ChainBundle {
  readonly id: string
  readonly workOrderSizeId: string
  readonly status: string
  readonly createdAt: Date
}

/**
 * The bundle "+12" reports (settle 10): of the cell, ACTIVE, not reported at the step (`standing` keys, scans/rules
 * standingKey); one whose step before is reported first (it reached the step), else the oldest left; null: every bundle of the
 * cell is done here.
 */
export function nextToReport<Bundle extends ChainBundle>(bundles: readonly Bundle[], input: { readonly workOrderSizeId: string; readonly operationId: string; readonly previousOperationIds: readonly string[]; readonly standing: ReadonlySet<string> }): Bundle | null {
  const left = bundles
    .filter((bundle) => bundle.workOrderSizeId === input.workOrderSizeId && bundle.status === 'ACTIVE' && !input.standing.has(standingKey(bundle.id, input.operationId)))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const arrived = left.find((bundle) => input.previousOperationIds.every((operationId) => input.standing.has(standingKey(bundle.id, operationId))))
  return arrived ?? left[0] ?? null
}

/** The words when nothing is left to report at the step (settle 10). */
export const NOTHING_LEFT = Object.freeze({ code: 'NOTHING_LEFT', message: 'Every bundle of this size is done here.', fix: 'Pick another size, or the next step.' })

/** The words of a team home before the office gives the team an order (honest-empty, never a blank page). */
export const NO_TEAM_ORDERS = 'Your team has no order yet. The office gives orders to teams when the work starts.'
/** The words when the signed-in leader leads no team. */
export const NO_TEAM = 'You lead no team at this site. Ask the office to add you to your team as its leader.'
