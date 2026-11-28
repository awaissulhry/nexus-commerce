import type { Board, BoardCard, DepartmentRow, RouteStep } from './api'

/**
 * owb-fl9 — made-up data for the Baskets board's tests (the demo site's departments; customers and codes invented, example names
 * only). Complete as fl4's board and fl1's route answer for what the page reads.
 */

export const dept = (number: number, name: string, tone: string, icon: string): DepartmentRow => ({ id: `dept-${number}`, number, name, shortName: name, nameI18n: null, tone, icon, status: 'ACTIVE' })

export const PATTERN = dept(1, 'Pattern', 'blue', 'ruler')
export const CUTTING = dept(2, 'Cutting', 'orange', 'scissors')
export const MOLDING = dept(8, 'Molding', 'slate', 'cylinder')

export const card = (extra: Partial<BoardCard> = {}): BoardCard => ({
  bundleId: 'bundle-0431',
  code: 'B-0431',
  picture: { src: 'https://example.com/b-0431.png' },
  customerCode: 'SEED',
  customer: { code: 'SEED', name: 'Seed Racing Example' },
  step: { operationId: 'op-cut', department: CUTTING },
  state: 'WORKING',
  flags: { first: false, late: false, problem: null },
  team: { id: 'team-blue', name: 'Team Blue' },
  worker: null,
  progress: { done: 1, total: 6 },
  late: null,
  salesOrderId: 'order-100',
  ...extra,
})

export const board: Board = {
  columns: [
    { department: PATTERN, baskets: [] },
    { department: CUTTING, baskets: [card()] },
    { department: MOLDING, baskets: [card({ bundleId: 'bundle-0385', code: 'B-0385', customer: { code: 'SEED', name: null }, step: { operationId: 'op-mold', department: MOLDING }, team: null, salesOrderId: 'order-101' })] },
  ],
  readyToShip: [card({ bundleId: 'bundle-0402', code: 'B-0402', state: 'WAITING', step: { operationId: null, department: null } })],
  people: null,
}

export const step = (operationId: string, seq: number, state: string, department: DepartmentRow | null = null): RouteStep => ({ operationId, seq, name: operationId, department, state, added: false })

/** A suit's route: Pattern done, Cutting here, Patch & print skipped, Stitching, Quality, Packing to do. */
export const route: RouteStep[] = [step('op-pattern', 10, 'DONE', PATTERN), step('op-cut', 20, 'HERE', CUTTING), step('op-patch', 30, 'SKIPPED'), step('op-stitch', 40, 'NEXT'), step('op-quality', 50, 'TODO'), step('op-pack', 60, 'TODO')]
